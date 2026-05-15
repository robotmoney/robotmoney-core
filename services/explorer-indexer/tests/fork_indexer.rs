//! Full-stack integration test: boot Postgres in a container, boot a
//! Base-mainnet fork-anvil via the Phase 2 `rmpc-fork-e2e` harness,
//! point the indexer at both, run a bounded range, and assert the
//! contract of issue #57:
//!
//! - `indexer_runs` records a successful run.
//! - All 9 minimum tables are reachable by COUNT(*) (i.e. every
//!   migration applied cleanly under load).
//! - At least one `vault_snapshots` row is produced (heartbeat or
//!   event-driven; the live vault on Base always has totalAssets
//!   readable, so the snapshot succeeds).
//! - Re-running the same range produces 0 net inserts (idempotency).
//!
//! Uses the checked-in `testing/fixtures/fork-state/CURRENT.anvil-state` snapshot
//! by default; falls back to `RMPC_FORK_RPC_URL` live fork if set.
//! Skips only when `anvil` is not on PATH.

mod common;

use alloy_primitives::Address;
use common::try_pg_fixture;
use explorer_indexer::{db::CountTable, indexer::run_once, indexer::IndexerConfig, rpc::JsonRpc};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn populates_nine_tables_and_reindex_is_idempotent() {
    if !rmpc_fork_e2e::can_run() {
        eprintln!(
            "[explorer-indexer] skipping: anvil not on PATH and no checked-in fixture found. \
             Install Foundry (https://getfoundry.sh) to run."
        );
        return;
    }
    let Some(fx) = try_pg_fixture().await else {
        return;
    };

    // Boot fork-anvil on a blocking thread (the harness uses
    // blocking reqwest + std::process). We hold the fixture for the
    // duration of the test.
    let fork = tokio::task::spawn_blocking(rmpc_fork_e2e::ForkFixture::new)
        .await
        .unwrap()
        .expect("ForkFixture boots");
    let rpc_url = fork.rpc_url.clone();

    let rpc = JsonRpc::new(&rpc_url);
    // The vault is real on Base mainnet; the gateway hasn't deployed
    // yet so we use a zero-address placeholder. eth_getLogs against
    // an empty-event address is allowed.
    let cfg = IndexerConfig {
        chain_id: rmpc_fork_e2e::BASE_CHAIN_ID as i64,
        chain_name: "base".into(),
        rpc_label: fork.rpc_label.clone(),
        gateway: Address::ZERO,
        vault: rmpc_fork_e2e::addresses::VAULT,
        registry: None,
        router_governance: None,
        max_blocks_per_tick: 200,
        // Anvil's `eth_blockNumber` returns the fork pin; we cap the
        // run at the pin so the heartbeat snapshot lands at a known
        // block.
        end_block: Some(fork.pin.block - explorer_indexer::CONFIRMATIONS),
    };

    // First run.
    let o1 = run_once(&fx.db, &rpc, &cfg).await.expect("run_once 1");
    assert!(o1.error.is_none(), "first run clean: {:?}", o1.error);
    assert!(
        o1.last_indexed_block.is_some(),
        "first run advances last_indexed_block"
    );

    // All nine tables addressable.
    for t in [
        CountTable::Chains,
        CountTable::Contracts,
        CountTable::Blocks,
        CountTable::Transactions,
        CountTable::AgentDeposits,
        CountTable::AgentPolicies,
        CountTable::VaultSnapshots,
        CountTable::WalletPositions,
        CountTable::IndexerRuns,
    ] {
        let _ = fx.db.count(t).await.unwrap_or_else(|e| panic!("{e}"));
    }
    // Heartbeat snapshot must have landed at least once.
    assert!(
        fx.db.count(CountTable::VaultSnapshots).await.unwrap() >= 1,
        "at least one vault_snapshots row from heartbeat"
    );
    // Bookkeeping rows present.
    assert_eq!(fx.db.count(CountTable::Chains).await.unwrap(), 1);
    assert_eq!(fx.db.count(CountTable::Contracts).await.unwrap(), 2);
    assert!(fx.db.count(CountTable::IndexerRuns).await.unwrap() >= 1);

    // Second run — re-entering the same `last_indexed_block` produces
    // no net inserts beyond a fresh `indexer_runs` audit row.
    let snap_before = fx.db.count(CountTable::VaultSnapshots).await.unwrap();
    let dep_before = fx.db.count(CountTable::AgentDeposits).await.unwrap();
    let pol_before = fx.db.count(CountTable::AgentPolicies).await.unwrap();
    let blk_before = fx.db.count(CountTable::Blocks).await.unwrap();
    let tx_before = fx.db.count(CountTable::Transactions).await.unwrap();

    let o2 = run_once(&fx.db, &rpc, &cfg).await.expect("run_once 2");
    assert!(o2.error.is_none());

    assert_eq!(
        fx.db.count(CountTable::VaultSnapshots).await.unwrap(),
        snap_before
    );
    assert_eq!(
        fx.db.count(CountTable::AgentDeposits).await.unwrap(),
        dep_before
    );
    assert_eq!(
        fx.db.count(CountTable::AgentPolicies).await.unwrap(),
        pol_before
    );
    assert_eq!(fx.db.count(CountTable::Blocks).await.unwrap(), blk_before);
    assert_eq!(
        fx.db.count(CountTable::Transactions).await.unwrap(),
        tx_before
    );

    // Tear down the anvil child.
    drop(fork);
}
