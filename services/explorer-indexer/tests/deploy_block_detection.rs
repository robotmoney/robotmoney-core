//! Canonical: docs/architecture.md §5.4 — Explorer Indexer and API.
//!
//! End-to-end coverage for the derived start block, against a simulated
//! `anvil --load-state` chain: a Base-mainnet head with NO block history below
//! the fork point. On that chain the old `last_indexed.map(|x| x + 1)
//! .unwrap_or(0)` started at block 0 and needed ~49_000 ticks (about seven
//! days) of `eth_call`s that could never succeed.
//!
//! Six things are asserted here that no unit test can reach, because each one
//! is a property of the whole tick:
//!
//!  1. A fresh database derives its own start block and PERSISTS it.
//!  2. The second tick reuses the persisted value and issues no probes at all.
//!  3. A deploy block remembered from a destroyed chain is re-detected rather
//!     than trusted for ever.
//!  4. A stale cursor from a destroyed chain is overridden, without being
//!     mistaken for a reorg.
//!  5. A reorg walk from a cursor 48.9M blocks above genesis stops at the
//!     derived floor instead of descending to block 0 one height at a time.
//!  6. When detection cannot run, the tick degrades to exactly the behaviour
//!     the indexer had before it existed.
//!
//! The chain is simulated rather than booted because no single live backend has
//! all of these shapes, and the one that matters most — a chain with a hole
//! between genesis and its head — cannot be produced on demand.

mod common;

use alloy_primitives::Address;
use common::pg_fixture;
use explorer_indexer::{
    indexer::{run_once, IndexerConfig},
    rpc::JsonRpc,
};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Measured on the live stage host.
const HEAD: u64 = 48_898_552;
/// Lowest block the fork-state chain can serve. Everything between block 0 and
/// this is a hole: `eth_getCode` there ERRORS, it does not answer "no code".
const LOWEST_SERVABLE: u64 = 48_896_512;

const CHAIN_ID: i64 = 918_453;

fn gateway_addr() -> Address {
    Address::from([0x11u8; 20])
}
fn vault_addr() -> Address {
    Address::from([0x22u8; 20])
}

/// How the fake chain answers `eth_getCode`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CodeMode {
    /// The stage shape: the watched contracts predate the fork point, so they
    /// have code everywhere this chain can serve.
    PresentThroughoutServableRange,
    /// The RPC is up but will not answer this method — detection must degrade,
    /// not guess.
    Unavailable,
}

/// A JSON-RPC server that answers PER BLOCK, which the shared `StubRpcServer`
/// cannot do: it keys canned responses by method alone, and every assertion
/// here is about how the answer varies with the height asked for.
struct ForkStateChain {
    url: String,
    methods: Arc<Mutex<Vec<String>>>,
    /// First byte of every block hash this chain reports. Flipping it is how a
    /// restarted anvil re-mining its tip looks to the indexer: same heights,
    /// different hashes, so the stored hash at the cursor no longer matches.
    hash_byte: Arc<AtomicU8>,
    shutdown: tokio::sync::oneshot::Sender<()>,
}

fn hex_block(v: &serde_json::Value) -> Option<u64> {
    let s = v.as_str()?;
    u64::from_str_radix(s.trim_start_matches("0x"), 16).ok()
}

fn out_of_range(block: u64) -> serde_json::Value {
    // Verbatim shape of the live error.
    serde_json::json!({
        "code": -32602,
        "message": format!(
            "BlockOutOfRangeError: block height is {HEAD} but requested was {block}"
        ),
    })
}

fn block_object(number: u64, hash_byte: u8) -> serde_json::Value {
    serde_json::json!({
        "number":     format!("0x{number:x}"),
        "hash":       format!("0x{}", hex::encode([hash_byte; 32])),
        "parentHash": format!("0x{}", hex::encode([0xbbu8; 32])),
        "timestamp":  "0x65000000",
        "transactions": [],
    })
}

/// `Ok(result)` or `Err(error)` for one request.
fn answer(
    mode: CodeMode,
    hash_byte: u8,
    method: &str,
    params: &serde_json::Value,
) -> serde_json::Value {
    let p = params.as_array().cloned().unwrap_or_default();
    match method {
        "eth_blockNumber" => serde_json::json!({ "result": format!("0x{HEAD:x}") }),
        "eth_chainId" => serde_json::json!({ "result": format!("0x{CHAIN_ID:x}") }),
        "eth_getCode" => {
            if mode == CodeMode::Unavailable {
                return serde_json::json!({
                    "error": { "code": -32601, "message": "the method eth_getCode does not exist" }
                });
            }
            let block = p.get(1).and_then(hex_block).unwrap_or(0);
            if block < LOWEST_SERVABLE {
                serde_json::json!({ "error": out_of_range(block) })
            } else {
                serde_json::json!({ "result": "0x6080604052348015" })
            }
        }
        "eth_getBlockByNumber" => {
            let block = p.first().and_then(hex_block).unwrap_or(0);
            if block < LOWEST_SERVABLE {
                serde_json::json!({ "error": out_of_range(block) })
            } else {
                serde_json::json!({ "result": block_object(block, hash_byte) })
            }
        }
        "eth_getLogs" => {
            let from = p
                .first()
                .and_then(|f| f.get("fromBlock"))
                .and_then(hex_block)
                .unwrap_or(0);
            if from < LOWEST_SERVABLE {
                serde_json::json!({ "error": out_of_range(from) })
            } else {
                serde_json::json!({ "result": [] })
            }
        }
        "eth_call" => {
            let block = p.get(1).and_then(hex_block).unwrap_or(0);
            if block < LOWEST_SERVABLE {
                serde_json::json!({ "error": out_of_range(block) })
            } else {
                serde_json::json!({ "result": format!("0x{}", "00".repeat(32)) })
            }
        }
        _ => serde_json::json!({ "result": serde_json::Value::Null }),
    }
}

impl ForkStateChain {
    async fn start(mode: CodeMode) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        let url = format!("http://{addr}");
        let methods: Arc<Mutex<Vec<String>>> = Arc::default();
        let hash_byte = Arc::new(AtomicU8::new(0xaa));
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let seen = methods.clone();
        let hashes = hash_byte.clone();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accept = listener.accept() => {
                        let Ok((mut sock, _)) = accept else { break; };
                        let seen = seen.clone();
                        let hashes = hashes.clone();
                        tokio::spawn(async move {
                            let mut buf = vec![0u8; 32 * 1024];
                            let n = match sock.read(&mut buf).await { Ok(n) => n, Err(_) => return };
                            if n == 0 { return; }
                            let body_start = buf[..n].windows(4)
                                .position(|w| w == b"\r\n\r\n")
                                .map(|i| i + 4)
                                .unwrap_or(0);
                            let req: serde_json::Value =
                                match serde_json::from_slice(&buf[body_start..n]) {
                                    Ok(v) => v,
                                    Err(_) => return,
                                };
                            let method =
                                req.get("method").and_then(|m| m.as_str()).unwrap_or("").to_string();
                            seen.lock().unwrap().push(method.clone());
                            let params =
                                req.get("params").cloned().unwrap_or(serde_json::json!([]));
                            let mut resp = serde_json::json!({
                                "jsonrpc": "2.0",
                                "id": req.get("id").cloned().unwrap_or(serde_json::json!(1)),
                            });
                            let hb = hashes.load(Ordering::SeqCst);
                            for (k, v) in
                                answer(mode, hb, &method, &params).as_object().unwrap()
                            {
                                resp[k] = v.clone();
                            }
                            let body = serde_json::to_vec(&resp).unwrap();
                            let header = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                                 Content-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            );
                            let _ = sock.write_all(header.as_bytes()).await;
                            let _ = sock.write_all(&body).await;
                            let _ = sock.shutdown().await;
                        });
                    }
                }
            }
        });

        Self {
            url,
            methods,
            hash_byte,
            shutdown: shutdown_tx,
        }
    }

    fn method_counts(&self, method: &str) -> usize {
        self.methods
            .lock()
            .unwrap()
            .iter()
            .filter(|m| *m == method)
            .count()
    }

    /// Every block now hashes differently, as after an anvil restart that
    /// re-mined its tip.
    fn remine(&self) {
        self.hash_byte.store(0xcc, Ordering::SeqCst);
    }

    fn reset_methods(&self) {
        self.methods.lock().unwrap().clear();
    }

    fn shutdown(self) {
        let _ = self.shutdown.send(());
    }
}

fn cfg() -> IndexerConfig {
    IndexerConfig {
        chain_id: CHAIN_ID,
        chain_name: "devnet".into(),
        rpc_label: "fork-state-stub".into(),
        gateway: gateway_addr(),
        vault: vault_addr(),
        registry: None,
        router_governance: None,
        portfolio_router: None,
        investment_committee: None,
        consensus_receipt: None,
        // Small on purpose: one tick must advance a knowable amount, so the
        // asserted `from_block` of the NEXT tick is unambiguous.
        max_blocks_per_tick: 10,
        end_block: None,
        feature_flags: 0,
    }
}

// ── 1 + 2: derive, persist, then stop paying for it ─────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn derives_persists_and_then_reuses_the_start_block() {
    let fx = pg_fixture().await;
    let chain = ForkStateChain::start(CodeMode::PresentThroughoutServableRange).await;
    let rpc = JsonRpc::new(&chain.url);

    let first = run_once(&fx.db, &rpc, &cfg()).await.unwrap();
    assert!(first.error.is_none(), "first tick clean: {:?}", first.error);
    assert_eq!(
        first.from_block, LOWEST_SERVABLE as i64,
        "a fresh database must start where the watched contracts are visible, \
         not at block 0"
    );
    assert_eq!(first.last_indexed_block, Some(LOWEST_SERVABLE as i64 + 9));

    // Persisted, per contract, in the column the migration has always had and
    // nothing has ever written.
    for address in [gateway_addr(), vault_addr()] {
        assert_eq!(
            fx.db
                .deployed_block(CHAIN_ID, address.into_array())
                .await
                .unwrap(),
            Some(LOWEST_SERVABLE as i64),
            "contracts.deployed_block must be filled in for {address}"
        );
    }
    let probes = chain.method_counts("eth_getCode");
    assert!(
        (1..=120).contains(&probes),
        "two addresses over 48.9M blocks is ~54 probes, at most doubled on the \
         out-of-range ones because a below-history verdict is confirmed before it \
         is believed, spent {probes}"
    );

    // Second tick: the value is known, so the SEARCH must not run again — but
    // the remembered value is still re-checked, once, against the chain now
    // answering. That single probe is the whole fix for a `deployed_block`
    // recorded against a chain that has since been replaced.
    chain.reset_methods();
    let second = run_once(&fx.db, &rpc, &cfg()).await.unwrap();
    assert!(
        second.error.is_none(),
        "second tick clean: {:?}",
        second.error
    );
    assert_eq!(second.from_block, LOWEST_SERVABLE as i64 + 10);
    assert_eq!(
        chain.method_counts("eth_getCode"),
        1,
        "a steady-state tick re-checks the floor once and searches never"
    );

    chain.shutdown();
}

// ── 3: a deploy block remembered from a chain that no longer exists ─────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_deploy_block_from_a_destroyed_chain_is_re_detected_not_trusted() {
    let fx = pg_fixture().await;
    let chain = ForkStateChain::start(CodeMode::PresentThroughoutServableRange).await;
    let rpc = JsonRpc::new(&chain.url);

    // Exactly what the Geth devnet leaves behind: the contracts deployed at
    // block 4, persisted under chain id 918453 at deterministic addresses. The
    // `anvil --load-state` backend that replaces it reuses both, so nothing
    // about these rows looks wrong — and block 4 is 48.9M blocks below anything
    // this chain can serve.
    fx.db
        .upsert_chain(CHAIN_ID, "devnet", "previous-geth-run")
        .await
        .unwrap();
    for (address, kind) in [(gateway_addr(), "gateway"), (vault_addr(), "vault")] {
        fx.db
            .upsert_contract(CHAIN_ID, address.into_array(), kind, Some(4))
            .await
            .unwrap();
    }

    let out = run_once(&fx.db, &rpc, &cfg()).await.unwrap();
    assert!(out.error.is_none(), "tick clean: {:?}", out.error);
    assert_eq!(
        out.from_block, LOWEST_SERVABLE as i64,
        "a remembered deploy block the chain cannot show must be re-derived; \
         trusting it makes every tick start below the servable range for ever, \
         and the cursor override cannot save it because any cursor is above 4"
    );
    for address in [gateway_addr(), vault_addr()] {
        assert_eq!(
            fx.db
                .deployed_block(CHAIN_ID, address.into_array())
                .await
                .unwrap(),
            Some(LOWEST_SERVABLE as i64),
            "the stale value must be REPLACED, not merely ignored for one tick"
        );
    }

    chain.shutdown();
}

// ── 4: the stale cursor from a chain that no longer exists ──────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stale_cursor_from_a_destroyed_chain_is_overridden_not_replayed() {
    let fx = pg_fixture().await;
    let chain = ForkStateChain::start(CodeMode::PresentThroughoutServableRange).await;
    let rpc = JsonRpc::new(&chain.url);

    // The stage database's own state: a cursor of 5999 left by a Geth run,
    // keyed to chain id 918453 — which the Anvil backend also uses, so it reads
    // as perfectly valid. Block 5999 does not exist on the chain now answering.
    fx.db
        .upsert_chain(CHAIN_ID, "devnet", "previous-geth-run")
        .await
        .unwrap();
    let stale = fx.db.start_run(CHAIN_ID, 0).await.unwrap();
    fx.db
        .finish_run(stale, Some(5_999), Some(5_999), 0, 0, None)
        .await
        .unwrap();

    let out = run_once(&fx.db, &rpc, &cfg()).await.unwrap();
    assert!(out.error.is_none(), "tick clean: {:?}", out.error);
    assert_eq!(
        out.from_block, LOWEST_SERVABLE as i64,
        "the dead cursor must be overridden by the derived block, not resumed \
         from — 6000 is 48.9M blocks of ticks that can never succeed"
    );
    assert!(
        !out.reorg_detected,
        "raising the cursor is not a rollback: a reorg here would run \
         delete_above_block against a block this chain never had"
    );

    chain.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_healthy_cursor_above_the_deploy_block_is_left_alone() {
    let fx = pg_fixture().await;
    let chain = ForkStateChain::start(CodeMode::PresentThroughoutServableRange).await;
    let rpc = JsonRpc::new(&chain.url);

    let healthy = LOWEST_SERVABLE as i64 + 100;
    fx.db
        .upsert_chain(CHAIN_ID, "devnet", "same-chain")
        .await
        .unwrap();
    let run = fx.db.start_run(CHAIN_ID, healthy).await.unwrap();
    fx.db
        .finish_run(run, Some(healthy), Some(healthy), 0, 0, None)
        .await
        .unwrap();

    let out = run_once(&fx.db, &rpc, &cfg()).await.unwrap();
    assert!(out.error.is_none(), "tick clean: {:?}", out.error);
    assert_eq!(
        out.from_block,
        healthy + 1,
        "a cursor above the deploy block always wins — this is why deriving a \
         floor changes nothing on a healthy Geth deployment"
    );

    chain.shutdown();
}

// ── 5: the reorg walk, on a cursor 48.9M blocks above genesis ───────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reorg_walk_stops_at_the_deploy_floor_instead_of_descending_to_genesis() {
    let fx = pg_fixture().await;
    let chain = ForkStateChain::start(CodeMode::PresentThroughoutServableRange).await;
    let rpc = JsonRpc::new(&chain.url);

    let first = run_once(&fx.db, &rpc, &cfg()).await.unwrap();
    assert!(first.error.is_none(), "first tick clean: {:?}", first.error);
    assert_eq!(first.last_indexed_block, Some(LOWEST_SERVABLE as i64 + 9));

    // The chain restarts and re-mines: the stored hash at the cursor no longer
    // matches, so the next tick takes the reorg path from a cursor of ~48.9M.
    chain.remine();

    // The deadline IS the assertion. `walk_back_to_match` descends one height
    // at a time, and without the deploy floor as its stop it would issue about
    // 48.9 million `SELECT hash FROM blocks` round trips before reaching block
    // 0 — hours inside one tick, every tick. Bounded by the floor it is ten.
    let second = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        run_once(&fx.db, &rpc, &cfg()),
    )
    .await
    .expect("the reorg walk must stop at the deploy floor, not scan to genesis")
    .unwrap();

    assert!(
        second.error.is_none(),
        "second tick clean: {:?}",
        second.error
    );
    assert!(
        second.reorg_detected,
        "a re-mined tip at the cursor is exactly the mismatch the walk exists for"
    );
    assert_eq!(
        fx.db.last_indexed_block(CHAIN_ID).await.unwrap(),
        Some(LOWEST_SERVABLE as i64 + 9),
        "the walk must roll back to the floor and re-index upward from there, \
         not wipe the chain and resume below its servable range"
    );

    chain.shutdown();
}

// ── 6: detection that cannot run ────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn detection_failure_degrades_to_the_old_behaviour_and_never_to_the_head() {
    let fx = pg_fixture().await;
    let chain = ForkStateChain::start(CodeMode::Unavailable).await;
    let rpc = JsonRpc::new(&chain.url);

    let out = run_once(&fx.db, &rpc, &cfg()).await.unwrap();
    assert_eq!(
        out.from_block, 0,
        "a failed detection falls back to exactly what this indexer did before \
         it existed — slow, and visibly so, never a silent jump to the head"
    );
    // On THIS chain the old behaviour is also the broken one, and it says so
    // out loud instead of logging `rows=0` for a week: block 0 is below the
    // servable range, so the range fetch fails and the run records the error.
    assert!(
        out.error.is_some(),
        "the degraded tick must surface the chain's refusal, not report success"
    );
    assert_eq!(
        fx.db
            .deployed_block(CHAIN_ID, gateway_addr().into_array())
            .await
            .unwrap(),
        None,
        "nothing may be persisted from a detection that did not conclude"
    );

    chain.shutdown();
}
