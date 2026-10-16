//! Shared helpers for the explorer-indexer integration tests.
//!
//! - `pg_fixture()` boots a Postgres testcontainer and returns a ready-to-use
//!   `Db` (with migrations applied). It **panics** when Docker or Postgres is
//!   unavailable — everywhere, not only in CI. A silent skip is a false green,
//!   and the executed-count guard cannot see the difference because a test that
//!   returns early still reports as passed. See
//!   `skills/_shared/test-coverage-policy.md` (loud-skip, never silent-skip).
//! - [`EXPLORER_INDEXER_REQUIRE_PG`] is read here (task T30b). It used to be set
//!   by three CI steps and honoured by nothing, so a maintainer reading the
//!   workflow believed a control existed that did not. It is now a real, and
//!   deliberately one-directional, control: it can only *assert* the
//!   Postgres-required mode this fixture always runs in, never relax it.
//! - `StubRpcServer` is an in-process tokio TCP listener that returns
//!   canned JSON-RPC responses keyed by method name, plus a forced-failure
//!   knob. Used to exercise the failure path without a real chain. By default
//!   `eth_getLogs` answers every request with the whole canned list; a test that
//!   depends on which addresses the indexer asks for turns on
//!   `honour_log_filter(true)` so it answers like a node (DI-1). An
//!   `eth_getTransactionReceipt` no test programmed is answered from the canned
//!   logs ([`receipt_from_logs`]), since the indexer reads one receipt per
//!   log-bearing transaction and a `null` receipt fails the tick (X6).

#![allow(dead_code)]

use explorer_indexer::Db;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use testcontainers::runners::AsyncRunner;
use testcontainers::ContainerAsync;
use testcontainers_modules::postgres::Postgres;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub struct PgFixture {
    pub db: Db,
    /// Connection URL of the testcontainer, so a test can open its own pool for
    /// raw SQL the `Db` API deliberately does not expose (catalog queries, DDL
    /// for the synthetic block-scoped table in the reorg coverage tests).
    pub url: String,
    // Container handle is held to keep the postgres process alive
    // for the test's lifetime.
    _container: ContainerAsync<Postgres>,
}

fn pg_panic(reason: &str) -> ! {
    panic!(
        "[explorer-indexer-tests] Postgres testcontainer is REQUIRED here but \
         unavailable: {reason}. This test asserts on real schema and real \
         rollback SQL; skipping it would be a silent false green. Give the \
         runner Docker."
    );
}

/// Environment variable three CI steps set to assert that these tests must have
/// a real Postgres. See [`check_require_pg`].
pub const REQUIRE_PG_ENV: &str = "EXPLORER_INDEXER_REQUIRE_PG";

/// Decide what a value of [`REQUIRE_PG_ENV`] means (task T30b).
///
/// Pure, so the meaning is covered by a test that needs no Docker.
///
/// The fixture is Postgres-required unconditionally, so the only honest reading
/// of this variable is one that cannot weaken that:
///
/// - unset, `1`, `true`, `yes` → `Ok(())`. The caller asserts what is already
///   true, which is exactly what the CI steps intend.
/// - anything else → `Err(reason)`. A value like `0` is a request for an
///   opt-out mode that does not exist and must not be invented; answering it
///   with a green run is the false green the whole fixture design forbids. The
///   caller turns it into a panic naming the variable.
pub fn check_require_pg(raw: Option<&str>) -> Result<(), String> {
    match raw.map(str::trim) {
        None | Some("") => Ok(()),
        Some(v)
            if v.eq_ignore_ascii_case("1")
                || v.eq_ignore_ascii_case("true")
                || v.eq_ignore_ascii_case("yes") =>
        {
            Ok(())
        }
        Some(v) => Err(format!(
            "{REQUIRE_PG_ENV}={v:?} asks these tests to run without a required Postgres. \
             There is no such mode: every test behind `pg_fixture()` asserts on real schema \
             and real rollback SQL, and a skip would report as a pass. Unset the variable \
             (or set it to 1) and give the runner Docker."
        )),
    }
}

/// Apply [`check_require_pg`] to the process environment, panicking on a value
/// that asks for a weaker mode.
fn enforce_require_pg() {
    if let Err(reason) = check_require_pg(std::env::var(REQUIRE_PG_ENV).ok().as_deref()) {
        panic!("[explorer-indexer-tests] {reason}");
    }
}

/// An **unmigrated** Postgres testcontainer: the database is empty, not even
/// `_sqlx_migrations` exists.
///
/// [`pg_fixture`] is this plus `Db::migrate()`. The raw form exists for the
/// migrate-only CLI tests (issue #1359), which must observe the migrator's own
/// effect on a virgin database — running them against an already-migrated
/// fixture would assert nothing, since the migrator would find every version
/// applied and no-op.
pub struct RawPg {
    /// Connection URL of the unmigrated database.
    pub url: String,
    /// Held by the caller to keep the postgres process alive.
    pub container: ContainerAsync<Postgres>,
}

/// Boots Postgres and returns it **without applying migrations**.
pub async fn raw_pg() -> RawPg {
    enforce_require_pg();
    if which::which("docker").is_err() {
        pg_panic("docker not on PATH");
    }
    let container = match Postgres::default().start().await {
        Ok(c) => c,
        Err(e) => pg_panic(&format!("postgres container failed to start: {e}")),
    };
    let host = match container.get_host().await {
        Ok(h) => h,
        Err(e) => pg_panic(&format!("container host unavailable: {e}")),
    };
    let port = match container.get_host_port_ipv4(5432).await {
        Ok(p) => p,
        Err(e) => pg_panic(&format!("container port unavailable: {e}")),
    };
    let url = format!("postgres://postgres:postgres@{host}:{port}/postgres");
    RawPg { url, container }
}

/// Returns `PgFixture` if Docker is available and Postgres came
/// up; panics otherwise.
///
/// Migrations are applied here, via `Db::migrate()` directly — the fixture has
/// never gone through the `indexer` binary's boot path, so removing the boot
/// path's automatic migrate (issue #1359) leaves every fixture-based test
/// unaffected.
pub async fn pg_fixture() -> PgFixture {
    let RawPg { url, container } = raw_pg().await;
    let db = match Db::connect(&url).await {
        Ok(d) => d,
        Err(e) => pg_panic(&format!("db connect failed: {e}")),
    };
    if let Err(e) = db.migrate().await {
        pg_panic(&format!("migrate failed: {e}"));
    }
    PgFixture {
        db,
        url,
        _container: container,
    }
}

/// Tiny in-process JSON-RPC server. Methods can be programmed with
/// canned response strings (already-encoded as JSON values), or set
/// to fail with `force_failure(true)` to simulate an RPC outage.
pub struct StubRpcServer {
    pub url: String,
    handlers: Arc<Mutex<HashMap<String, serde_json::Value>>>,
    fail: Arc<AtomicBool>,
    /// When set, `eth_getLogs` answers only with the canned logs the request's filter selects (see
    /// [`apply_log_filter`]). Off by default, so tests written against the whole-list answer keep
    /// their meaning; turning it on for every test needs each canned log checked against its filter.
    log_filter: Arc<AtomicBool>,
    /// Every JSON-RPC request body received, in arrival order. Lets tests assert
    /// what the indexer actually requested (e.g. the `eth_getLogs` address set).
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
    /// Optional per-calldata answer for `eth_call` (issue 1731): `Ok(result hex)` or `Err(message)` for a
    /// JSON-RPC error. When unset, `eth_call` answers from the fixed `handlers` table like every other method.
    call_hook: Arc<Mutex<Option<CallHookAt>>>,
    shutdown: tokio::sync::oneshot::Sender<()>,
}

/// Answers one `eth_call` from its target (`0x...` lower-case address) and calldata (`0x...`): the result hex,
/// or an error message.
pub type CallHook = Arc<dyn Fn(&str, &str) -> Result<String, String> + Send + Sync>;

/// A [`CallHook`] that also sees the block the call reads at (security round 3: a vault's
/// `exclusionLedger()` names a different ledger before and after a reinitializer). `u64::MAX`
/// stands for a block tag such as `latest`.
pub type CallHookAt = Arc<dyn Fn(&str, &str, u64) -> Result<String, String> + Send + Sync>;

impl StubRpcServer {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        let url = format!("http://{addr}");
        let handlers: Arc<Mutex<HashMap<String, serde_json::Value>>> = Arc::default();
        let fail = Arc::new(AtomicBool::new(false));
        let log_filter = Arc::new(AtomicBool::new(false));
        let requests: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
        let call_hook: Arc<Mutex<Option<CallHookAt>>> = Arc::default();
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();

        let h2 = handlers.clone();
        let f2 = fail.clone();
        let lf2 = log_filter.clone();
        let r2 = requests.clone();
        let c2 = call_hook.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accept = listener.accept() => {
                        let Ok((mut sock, _)) = accept else { break; };
                        let h = h2.clone();
                        let f = f2.clone();
                        let lf = lf2.clone();
                        let r = r2.clone();
                        let ch = c2.clone();
                        tokio::spawn(async move {
                            let mut buf = vec![0u8; 16 * 1024];
                            let n = match sock.read(&mut buf).await { Ok(n) => n, Err(_) => return };
                            if n == 0 { return; }
                            let body_start = buf[..n].windows(4)
                                .position(|w| w == b"\r\n\r\n")
                                .map(|i| i + 4)
                                .unwrap_or(0);
                            let body = &buf[body_start..n];
                            let req: serde_json::Value = match serde_json::from_slice(body) {
                                Ok(v) => v,
                                Err(_) => return,
                            };
                            r.lock().unwrap().push(req.clone());
                            let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
                            let hooked = if method == "eth_call" {
                                let data = req["params"][0]["data"].as_str().unwrap_or("").to_string();
                                let to = req["params"][0]["to"].as_str().unwrap_or("").to_lowercase();
                                let block = req["params"][1]
                                    .as_str()
                                    .and_then(|b| u64::from_str_radix(b.trim_start_matches("0x"), 16).ok())
                                    .unwrap_or(u64::MAX);
                                let hook = ch.lock().unwrap().clone();
                                hook.map(|h| h(&to, &data, block))
                            } else {
                                None
                            };
                            let resp = if let Some(answer) = hooked {
                                match answer {
                                    Ok(result) => serde_json::json!({
                                        "jsonrpc": "2.0",
                                        "id": req.get("id").cloned().unwrap_or(serde_json::json!(1)),
                                        "result": result,
                                    }),
                                    Err(message) => serde_json::json!({
                                        "jsonrpc": "2.0",
                                        "id": req.get("id").cloned().unwrap_or(serde_json::json!(1)),
                                        "error": { "code": 3, "message": message }
                                    }),
                                }
                            } else if f.load(Ordering::SeqCst) {
                                serde_json::json!({
                                    "jsonrpc": "2.0",
                                    "id": req.get("id").cloned().unwrap_or(serde_json::json!(1)),
                                    "error": { "code": -32000, "message": "stub forced failure" }
                                })
                            } else {
                                let canned = h.lock().unwrap().get(method).cloned();
                                let result = match canned {
                                    Some(v) => v,
                                    None if method == "eth_getTransactionReceipt" => {
                                        let logs = h.lock().unwrap().get("eth_getLogs").cloned();
                                        receipt_from_logs(
                                            logs.as_ref(),
                                            req["params"][0].as_str().unwrap_or(""),
                                        )
                                    }
                                    None => serde_json::Value::Null,
                                };
                                let result = if method == "eth_getLogs" && lf.load(Ordering::SeqCst) {
                                    apply_log_filter(result, &req["params"][0])
                                } else {
                                    result
                                };
                                serde_json::json!({
                                    "jsonrpc": "2.0",
                                    "id": req.get("id").cloned().unwrap_or(serde_json::json!(1)),
                                    "result": result,
                                })
                            };
                            let body = serde_json::to_vec(&resp).unwrap();
                            let header = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
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
            handlers,
            fail,
            log_filter,
            requests,
            call_hook,
            shutdown: shutdown_tx,
        }
    }

    /// All JSON-RPC requests received so far, in arrival order.
    pub fn captured_requests(&self) -> Vec<serde_json::Value> {
        self.requests.lock().unwrap().clone()
    }

    pub fn set(&self, method: &str, value: serde_json::Value) {
        self.handlers
            .lock()
            .unwrap()
            .insert(method.to_string(), value);
    }

    /// Answer every `eth_call` from its target and calldata (see [`CallHook`]).
    pub fn set_call_hook(&self, hook: CallHook) {
        *self.call_hook.lock().unwrap() =
            Some(Arc::new(move |to: &str, data: &str, _block: u64| {
                hook(to, data)
            }));
    }

    /// Answer every `eth_call` from its target, calldata and block (see [`CallHookAt`]).
    pub fn set_call_hook_at(&self, hook: CallHookAt) {
        *self.call_hook.lock().unwrap() = Some(hook);
    }

    pub fn force_failure(&self, on: bool) {
        self.fail.store(on, Ordering::SeqCst);
    }

    /// Answer `eth_getLogs` like a node: only the canned logs whose address, block and topic-0 the
    /// request's filter selects. Without it a log from an address the indexer never asked for still
    /// comes back, so no test can see a missing address in the filter (DI-1).
    pub fn honour_log_filter(&self, on: bool) {
        self.log_filter.store(on, Ordering::SeqCst);
    }

    pub fn shutdown(self) {
        let _ = self.shutdown.send(());
    }
}

/// `from` of every receipt the stub makes up (see [`receipt_from_logs`]).
pub const STUB_TX_FROM: &str = "0x00000000000000000000000000000000000000f1";

/// The receipt a node would give for `hash` when no test programmed `eth_getTransactionReceipt`
/// (QA plan X6): the indexer reads one receipt per transaction that carries a watched log, and a
/// `null` receipt now fails the tick. It is made up from the first canned `eth_getLogs` entry with
/// that `transactionHash`: its block, block hash and index, `to` = the log's address, `from` =
/// [`STUB_TX_FROM`], status 1 (a reverted transaction emits no logs). A hash no canned log carries
/// answers `null`, like a node that does not know the transaction.
pub fn receipt_from_logs(canned_logs: Option<&serde_json::Value>, hash: &str) -> serde_json::Value {
    let log = canned_logs
        .and_then(|l| l.as_array())
        .into_iter()
        .flatten()
        .find(|log| {
            log["transactionHash"]
                .as_str()
                .is_some_and(|h| h.eq_ignore_ascii_case(hash))
        });
    match log {
        None => serde_json::Value::Null,
        Some(log) => serde_json::json!({
            "transactionHash":  hash,
            "transactionIndex": log["transactionIndex"].clone(),
            "blockNumber":      log["blockNumber"].clone(),
            "blockHash":        log["blockHash"].clone(),
            "from":             STUB_TX_FROM,
            "to":               log["address"].clone(),
            "status":           "0x1",
        }),
    }
}

/// Keep the canned `eth_getLogs` entries a node would return for `filter`: block in
/// `[fromBlock, toBlock]`, address in `address` (a list or one string), and topic-0 in
/// `topics[0]`. A filter field that is absent or an empty list selects everything, as on a node.
/// Anything that is not a list of logs is returned unchanged.
pub fn apply_log_filter(
    canned: serde_json::Value,
    filter: &serde_json::Value,
) -> serde_json::Value {
    let Some(logs) = canned.as_array() else {
        return canned;
    };
    let quantity = |v: &serde_json::Value| {
        v.as_str()
            .and_then(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).ok())
    };
    let lower_list = |v: &serde_json::Value| -> Option<Vec<String>> {
        match v {
            serde_json::Value::String(s) => Some(vec![s.to_lowercase()]),
            serde_json::Value::Array(a) => Some(
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_lowercase))
                    .collect(),
            ),
            _ => None,
        }
    };
    let from = quantity(&filter["fromBlock"]).unwrap_or(0);
    let to = quantity(&filter["toBlock"]).unwrap_or(u64::MAX);
    let addresses = lower_list(&filter["address"]);
    let topic0 = lower_list(&filter["topics"][0]);
    let kept = logs
        .iter()
        .filter(|log| {
            let block = quantity(&log["blockNumber"]).unwrap_or(0);
            let address = log["address"].as_str().unwrap_or("").to_lowercase();
            let first_topic = log["topics"][0].as_str().unwrap_or("").to_lowercase();
            (from..=to).contains(&block)
                && addresses
                    .as_ref()
                    .is_none_or(|a| a.is_empty() || a.contains(&address))
                && topic0
                    .as_ref()
                    .is_none_or(|t| t.is_empty() || t.contains(&first_topic))
        })
        .cloned()
        .collect();
    serde_json::Value::Array(kept)
}
