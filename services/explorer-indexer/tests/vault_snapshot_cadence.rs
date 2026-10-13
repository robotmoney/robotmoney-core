//! Issue 1768: the indexer writes a `vault_snapshots` row only when a vault's state changed or the heartbeat
//! interval (`SNAPSHOT_HEARTBEAT_BLOCKS`) elapsed. A zero-TVL vault with unchanged state gains no row per tick.
//!
//! The tests use the shared Postgres fixture and a stub RPC. They do not skip when Docker is missing.

mod common;

use alloy_primitives::{Address, U256};
use common::{pg_fixture, StubRpcServer};
use explorer_indexer::{
    abi::IVaultReads,
    indexer::{run_once, IndexerConfig},
    rpc::JsonRpc,
    SNAPSHOT_HEARTBEAT_BLOCKS,
};
use std::sync::{Arc, Mutex};

const CHAIN: i64 = 8453;

#[derive(Clone, Copy)]
struct Chain {
    total_assets: u64,
    total_supply: u64,
    tvl_cap: Option<u64>,
    per_deposit_cap: Option<u64>,
    paused: bool,
}

fn cfg(end_block: u64) -> IndexerConfig {
    IndexerConfig {
        chain_id: CHAIN,
        chain_name: "base".into(),
        rpc_label: "stub".into(),
        gateway: Address::from([0x11u8; 20]),
        vault: Address::from([0x22u8; 20]),
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
    let stub = StubRpcServer::start().await;
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
    let (assets, supply, tvl, per, paused) = (
        sel::<IVaultReads::totalAssetsCall>(),
        sel::<IVaultReads::totalSupplyCall>(),
        sel::<IVaultReads::tvlCapCall>(),
        sel::<IVaultReads::perDepositCapCall>(),
        sel::<IVaultReads::depositsPausedCall>(),
    );
    stub.set_call_hook(Arc::new(move |_to: &str, data: &str| {
        let c = *st.lock().unwrap();
        let data = data.trim_start_matches("0x");
        let revert = || Err("execution reverted".to_string());
        if data.starts_with(&assets) {
            Ok(word(U256::from(c.total_assets)))
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

#[tokio::test]
async fn a_change_in_assets_supply_a_cap_or_the_paused_flag_writes_a_row_at_that_block() {
    let h = harness(ZERO_TVL).await;
    h.tick(12).await;
    let changes: [fn(&mut Chain); 5] = [
        |c| c.total_assets = 5,
        |c| c.total_supply = 5,
        |c| c.tvl_cap = Some(200),
        |c| c.per_deposit_cap = Some(30),
        |c| c.paused = true,
    ];
    let mut expect = vec![12];
    for (i, change) in changes.iter().enumerate() {
        change(&mut h.state.lock().unwrap());
        let end = 13 + i as u64;
        h.tick(end).await;
        expect.push(end as i64);
        assert_eq!(
            h.blocks().await,
            expect,
            "change {i} writes a row at block {end}"
        );
    }
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
