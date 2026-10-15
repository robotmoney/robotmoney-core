//! Issue 1768: the indexer writes a `vault_snapshots` row only when a vault's state changed or the heartbeat
//! interval (`SNAPSHOT_HEARTBEAT_BLOCKS`) elapsed. A zero-TVL vault with unchanged state gains no row per tick.
//! Issue 1781 (QA plan X6): a vault that holds value and has known caps is read only in a tick where it emits
//! a watched log, so a change reaches a row through the event the vault emits for it. The vault under test is
//! a registered vault, not the configured one, so every read of it goes through `snapshot_read`.
//!
//! The tests use the shared Postgres fixture and a stub RPC. They do not skip when Docker is missing.

mod common;

use alloy_primitives::{Address, LogData, U256};
use alloy_sol_types::SolEvent;
use common::{pg_fixture, StubRpcServer};
use explorer_indexer::{
    abi::{IGatewayEvents, IRobotMoneyVaultReads, IVaultEvents, IVaultReads},
    indexer::{run_once, IndexerConfig},
    rpc::JsonRpc,
    SNAPSHOT_HEARTBEAT_BLOCKS,
};
use std::sync::{Arc, Mutex};

const CHAIN: i64 = 8453;
/// The configured (pinned) vault. The vault under test is registered beside it.
const CONFIGURED_VAULT: Address = Address::new([0x23u8; 20]);

#[derive(Clone, Copy)]
struct Chain {
    total_assets: u64,
    total_supply: u64,
    tvl_cap: Option<u64>,
    per_deposit_cap: Option<u64>,
    paused: bool,
    /// What a redeem loses to exit costs, in bps: `previewRedeem(totalSupply())` answers
    /// `total_assets * (10000 - exit_cost_bps) / 10000` (core 1795).
    exit_cost_bps: u64,
}

impl Chain {
    /// `previewRedeem(totalSupply())` as the fake vault answers it.
    fn preview_redeem_total(&self) -> u64 {
        self.total_assets * (10_000 - self.exit_cost_bps) / 10_000
    }
}

fn cfg(end_block: u64) -> IndexerConfig {
    IndexerConfig {
        chain_id: CHAIN,
        chain_name: "base".into(),
        rpc_label: "stub".into(),
        gateway: Address::from([0x11u8; 20]),
        vault: CONFIGURED_VAULT,
        registry: None,
        router_governance: None,
        portfolio_router: None,
        investment_committee: None,
        consensus_receipt: None,
        timelock: None,
        safe: None,
        max_blocks_per_tick: 100_000,
        start_block: None,
        end_block: Some(end_block),
        feature_flags: 0,
    }
}

fn word(v: U256) -> String {
    format!("0x{}", alloy_primitives::hex::encode(v.to_be_bytes::<32>()))
}

fn sel<C: alloy_sol_types::SolCall>() -> String {
    alloy_primitives::hex::encode(C::SELECTOR)
}

struct Harness {
    fx: common::PgFixture,
    stub: StubRpcServer,
    state: Arc<Mutex<Chain>>,
    vault: Address,
}

async fn harness(initial: Chain) -> Harness {
    let fx = pg_fixture().await;
    let vault = Address::from([0x22u8; 20]);
    fx.db.upsert_chain(CHAIN, "base", "stub").await.unwrap();
    fx.db
        .upsert_contract(CHAIN, vault.into_array(), "vault", None)
        .await
        .unwrap();
    fx.db
        .upsert_vault(
            CHAIN,
            vault.into_array(),
            "Robot Money Agent Tokens",
            "SPECULATIVE",
            U256::ZERO,
            0,
            1,
            1,
            [0x01; 32],
        )
        .await
        .unwrap();
    let stub = StubRpcServer::start().await;
    // Answer `eth_getLogs` like a node, so a vault event reaches the tick only when its topic is in the
    // indexer's filter (the cap and fee events are, issue 1781).
    stub.honour_log_filter(true);
    stub.set("eth_blockNumber", serde_json::json!("0x100000"));
    stub.set(
        "eth_getBlockByNumber",
        serde_json::json!({
            "number": "0xa",
            "hash": format!("0x{}", hex::encode([0xaau8; 32])),
            "parentHash": format!("0x{}", hex::encode([0x00u8; 32])),
            "timestamp": "0x65000000",
            "transactions": []
        }),
    );
    stub.set("eth_getLogs", serde_json::json!([]));
    let state = Arc::new(Mutex::new(initial));
    let st = state.clone();
    let (assets, supply, tvl, per, paused, preview) = (
        sel::<IVaultReads::totalAssetsCall>(),
        sel::<IVaultReads::totalSupplyCall>(),
        sel::<IVaultReads::tvlCapCall>(),
        sel::<IVaultReads::perDepositCapCall>(),
        sel::<IVaultReads::depositsPausedCall>(),
        sel::<IVaultReads::previewRedeemCall>(),
    );
    stub.set_call_hook(Arc::new(move |_to: &str, data: &str| {
        let c = *st.lock().unwrap();
        let data = data.trim_start_matches("0x");
        let revert = || Err("execution reverted".to_string());
        if data.starts_with(&assets) {
            Ok(word(U256::from(c.total_assets)))
        } else if data.starts_with(&preview) {
            Ok(word(U256::from(c.preview_redeem_total())))
        } else if data.starts_with(&supply) {
            Ok(word(U256::from(c.total_supply)))
        } else if data.starts_with(&paused) {
            Ok(word(U256::from(c.paused as u8)))
        } else if data.starts_with(&tvl) {
            c.tvl_cap
                .map(|v| word(U256::from(v)))
                .ok_or(())
                .or_else(|_| revert())
        } else if data.starts_with(&per) {
            c.per_deposit_cap
                .map(|v| word(U256::from(v)))
                .ok_or(())
                .or_else(|_| revert())
        } else {
            Ok(word(U256::ZERO))
        }
    }));
    Harness {
        fx,
        stub,
        state,
        vault,
    }
}

impl Harness {
    async fn tick(&self, end_block: u64) {
        let rpc = JsonRpc::new(&self.stub.url);
        let o = run_once(&self.fx.db, &rpc, &cfg(end_block)).await.unwrap();
        assert!(o.error.is_none(), "{:?}", o.error);
    }

    /// Answer the next tick's `eth_getLogs` with `logs` only.
    fn logs(&self, logs: Vec<serde_json::Value>) {
        self.stub.set("eth_getLogs", serde_json::Value::Array(logs));
    }

    /// One log emitted by the vault under test at `block`, in a transaction of its own.
    fn vault_log(&self, ld: &LogData, block: u64) -> serde_json::Value {
        serde_json::json!({
            "address":          format!("{:#x}", self.vault),
            "topics":           ld.topics().iter().map(|t| format!("{t:#x}")).collect::<Vec<_>>(),
            "data":             format!("0x{}", hex::encode(ld.data.as_ref())),
            "blockNumber":      format!("0x{block:x}"),
            "blockHash":        format!("0x{}", hex::encode([0xaau8; 32])),
            "transactionHash":  format!("0x{}", hex::encode(U256::from(block).to_be_bytes::<32>())),
            "transactionIndex": "0x0",
            "logIndex":         "0x0",
        })
    }

    /// Snapshot `eth_call`s sent to the vault under test so far. The `exclusionLedger()` read (security
    /// round 1) is not a snapshot read: the vault answers zero here, so the indexer asks again every
    /// tick, and it is left out of the count.
    fn reads_of_vault(&self) -> usize {
        let want = format!("{:#x}", self.vault);
        let ledger_getter = format!("0x{}", sel::<IRobotMoneyVaultReads::exclusionLedgerCall>());
        self.stub
            .captured_requests()
            .iter()
            .filter(|r| {
                r["method"] == "eth_call"
                    && r["params"][0]["to"].as_str().map(str::to_lowercase) == Some(want.clone())
                    && !r["params"][0]["data"]
                        .as_str()
                        .is_some_and(|d| d.starts_with(&ledger_getter))
            })
            .count()
    }

    async fn blocks(&self) -> Vec<i64> {
        let rows: Vec<(i64,)> = sqlx::query_as(
            "SELECT block_number FROM vault_snapshots WHERE chain_id = $1 AND contract = $2 ORDER BY block_number",
        )
        .bind(CHAIN)
        .bind(self.vault.as_slice())
        .fetch_all(self.fx.db.pool())
        .await
        .unwrap();
        rows.into_iter().map(|r| r.0).collect()
    }

    /// `preview_redeem_total` of every row of the vault under test, by block.
    async fn preview_redeem_totals(&self) -> Vec<Option<String>> {
        let rows: Vec<(Option<String>,)> = sqlx::query_as(
            "SELECT CAST(preview_redeem_total AS text) FROM vault_snapshots \
             WHERE chain_id = $1 AND contract = $2 ORDER BY block_number",
        )
        .bind(CHAIN)
        .bind(self.vault.as_slice())
        .fetch_all(self.fx.db.pool())
        .await
        .unwrap();
        rows.into_iter().map(|r| r.0).collect()
    }

    async fn seed(&self, block: i64, c: Chain) {
        self.fx
            .db
            .insert_vault_snapshot(
                CHAIN,
                self.vault.into_array(),
                block,
                U256::from(c.total_assets),
                U256::from(c.total_supply),
                0,
                c.tvl_cap.map(U256::from),
                c.per_deposit_cap.map(U256::from),
                c.paused,
                Some(U256::from(c.preview_redeem_total())),
            )
            .await
            .unwrap();
    }
}

const ZERO_TVL: Chain = Chain {
    total_assets: 0,
    total_supply: 0,
    tvl_cap: Some(100),
    per_deposit_cap: Some(15),
    paused: false,
    exit_cost_bps: 0,
};

#[tokio::test]
async fn a_zero_tvl_vault_with_unchanged_state_writes_no_row_on_the_second_tick() {
    let h = harness(ZERO_TVL).await;
    h.tick(12).await;
    assert_eq!(
        h.blocks().await,
        vec![12],
        "the first tick writes the vault's first row"
    );
    h.tick(14).await;
    assert_eq!(
        h.blocks().await,
        vec![12],
        "the second tick writes nothing: state is identical"
    );
}

/// Regression seeded from the rmAGENT case: many ticks on an empty vault left dozens of identical rows.
#[tokio::test]
async fn rmagent_regression_many_ticks_on_an_empty_vault_leave_one_row() {
    let h = harness(ZERO_TVL).await;
    for end in 12..32 {
        h.tick(end).await;
    }
    assert_eq!(h.blocks().await, vec![12]);
}

/// One change to the state the stub's vault reports.
type Change = fn(&mut Chain);

/// Each change comes with the log the vault emits for it, which is what makes the tick read the vault
/// once it holds value (issue 1781).
#[tokio::test]
async fn a_change_in_assets_supply_a_cap_or_the_paused_flag_writes_a_row_at_that_block() {
    let h = harness(ZERO_TVL).await;
    h.tick(12).await;
    let holder = Address::from([0x77u8; 20]);
    let deposit = |assets: u64, shares: u64| {
        IVaultEvents::Deposit {
            caller: holder,
            owner: holder,
            assets: U256::from(assets),
            shares: U256::from(shares),
        }
        .encode_log_data()
    };
    let changes: Vec<(Change, LogData)> = vec![
        (|c| c.total_assets = 5, deposit(5, 0)),
        (|c| c.total_supply = 5, deposit(0, 5)),
        (
            |c| c.tvl_cap = Some(200),
            IVaultEvents::TvlCapUpdated {
                oldCap: U256::from(100),
                newCap: U256::from(200),
            }
            .encode_log_data(),
        ),
        (
            |c| c.per_deposit_cap = Some(30),
            IVaultEvents::PerDepositCapUpdated {
                oldCap: U256::from(15),
                newCap: U256::from(30),
            }
            .encode_log_data(),
        ),
        (
            |c| c.paused = true,
            IGatewayEvents::DepositsPaused { by: holder }.encode_log_data(),
        ),
    ];
    let mut expect = vec![12];
    for (i, (change, log)) in changes.iter().enumerate() {
        change(&mut h.state.lock().unwrap());
        let end = 13 + i as u64;
        h.logs(vec![h.vault_log(log, end)]);
        h.tick(end).await;
        expect.push(end as i64);
        assert_eq!(
            h.blocks().await,
            expect,
            "change {i} writes a row at block {end}"
        );
    }
}

/// Issue 1781: a vault that holds value and has known caps costs no `eth_call` in a tick where it emits no
/// watched log, and a change that no event announced waits for the vault's next event or heartbeat.
#[tokio::test]
async fn a_vault_with_value_and_known_caps_is_not_read_in_a_quiet_tick() {
    let funded = Chain {
        total_assets: 5,
        total_supply: 5,
        ..ZERO_TVL
    };
    let h = harness(funded).await;
    h.tick(12).await;
    assert_eq!(
        h.blocks().await,
        vec![12],
        "the first tick writes the first row"
    );
    let first_sight = h.reads_of_vault();
    assert_eq!(
        first_sight, 7,
        "the first sight reads the seven snapshot fields once"
    );

    // Yield moved the assets, and no event says so: the next ticks do not read the vault.
    h.state.lock().unwrap().total_assets = 6;
    h.tick(13).await;
    h.tick(14).await;
    assert_eq!(
        h.reads_of_vault(),
        first_sight,
        "a quiet tick reads nothing"
    );
    assert_eq!(h.blocks().await, vec![12]);

    // The vault's next event reads it, and the row carries the change.
    let ld = IVaultEvents::ExitFeeUpdated {
        oldBps: U256::ZERO,
        newBps: U256::ZERO,
    }
    .encode_log_data();
    h.logs(vec![h.vault_log(&ld, 15)]);
    h.tick(15).await;
    assert_eq!(h.reads_of_vault(), first_sight + 7);
    assert_eq!(h.blocks().await, vec![12, 15]);
}

#[tokio::test]
async fn every_vault_has_a_row_at_least_once_per_heartbeat_interval() {
    let h = harness(ZERO_TVL).await;
    h.seed(12, ZERO_TVL).await;
    let before = 12 + SNAPSHOT_HEARTBEAT_BLOCKS - 1;
    h.tick(before).await;
    assert_eq!(h.blocks().await, vec![12], "heartbeat not yet due");
    let due = 12 + SNAPSHOT_HEARTBEAT_BLOCKS;
    h.tick(due).await;
    assert_eq!(
        h.blocks().await,
        vec![12, due as i64],
        "an identical row is written once the interval elapses"
    );
}

#[test]
fn the_heartbeat_interval_is_the_documented_constant() {
    assert_eq!(SNAPSHOT_HEARTBEAT_BLOCKS, 7200);
    let docs = include_str!("../src/indexer.rs");
    assert!(
        docs.contains("//!    heartbeat interval (issue 1768)")
            || docs.contains("`SNAPSHOT_HEARTBEAT_BLOCKS` (7200 blocks)")
    );
}

#[tokio::test]
async fn the_unknown_caps_retry_fills_caps_without_writing_repeated_rows() {
    let unknown = Chain {
        tvl_cap: None,
        per_deposit_cap: None,
        total_assets: 7,
        total_supply: 7,
        ..ZERO_TVL
    };
    let h = harness(unknown).await;
    h.seed(11, unknown).await;
    // Caps still unreadable: the retry reads the chain but writes nothing.
    h.tick(12).await;
    h.tick(13).await;
    assert_eq!(h.blocks().await, vec![11]);
    // Caps become readable: exactly one row fills them.
    h.state.lock().unwrap().tvl_cap = Some(100);
    h.state.lock().unwrap().per_deposit_cap = Some(15);
    h.tick(14).await;
    h.tick(15).await;
    h.tick(16).await;
    assert_eq!(h.blocks().await, vec![11, 14]);
}

/// Core 1795 (QA plan X8): each snapshot stores `previewRedeem(totalSupply())`, the USDC a redeem of the
/// whole supply pays after exit costs, which the positions API scales to a holder's shares. A row without it
/// (written before migration 0022) is read again on the next tick, quiet or not, and filled by one new row.
#[tokio::test]
async fn a_snapshot_stores_preview_redeem_of_the_supply_and_a_row_without_it_is_filled_next_tick() {
    // rmAGENT-like: a 5% slippage floor between the gross value and what a redeem pays.
    let basket = Chain {
        total_assets: 1_000_000,
        total_supply: 1_000_000,
        exit_cost_bps: 500,
        ..ZERO_TVL
    };
    let h = harness(basket).await;
    h.tick(12).await;
    assert_eq!(h.blocks().await, vec![12]);
    assert_eq!(
        h.preview_redeem_totals().await,
        vec![Some("950000".to_string())],
        "the row stores previewRedeem(totalSupply()), not totalAssets"
    );

    // A row from before migration 0022: same state, no exit value.
    h.fx.db
        .insert_vault_snapshot(
            CHAIN,
            h.vault.into_array(),
            13,
            U256::from(basket.total_assets),
            U256::from(basket.total_supply),
            0,
            basket.tvl_cap.map(U256::from),
            basket.per_deposit_cap.map(U256::from),
            basket.paused,
            None,
        )
        .await
        .unwrap();
    let before = h.reads_of_vault();
    // A quiet tick (no log, value held, caps known) still reads it, because the exit value is unknown.
    h.tick(14).await;
    assert_eq!(h.reads_of_vault(), before + 7);
    assert_eq!(h.blocks().await, vec![12, 13, 14]);
    assert_eq!(
        h.preview_redeem_totals().await,
        vec![Some("950000".to_string()), None, Some("950000".to_string())]
    );
    // Filled once: the next quiet tick reads nothing.
    h.tick(15).await;
    assert_eq!(h.reads_of_vault(), before + 7);
    assert_eq!(h.blocks().await, vec![12, 13, 14]);
}
