//! Full-stack integration test: boot Postgres in a container, deploy a vault of OUR OWN to the Twin
//! chain through the deploy scripts (the smoke-test harness, which calls the devops "publish
//! contracts" runbook), point the indexer at the Twin chain and at the manifest addresses, run a
//! bounded range, and assert the contract of issue #57:
//!
//! - `indexer_runs` records a successful run.
//! - All 9 minimum tables are reachable by COUNT(*) (i.e. every
//!   migration applied cleanly under load).
//! - At least one `vault_snapshots` row is produced (heartbeat or
//!   event-driven; our vault always has totalAssets readable, so the snapshot succeeds).
//! - Re-running the same range produces 0 net inserts (idempotency).
//!
//! The Twin chain (id 918453) is a pinned lazy fork of real Base state made with anvil (core 1498,
//! 1496). Set `TWIN_RPC_URL` to a running fork (CI does, through .github/actions/twin-fork), and
//! `PUBLISH_CONTRACTS_DIR` and `STAGE_SHEET` for the publish run. Clean room rule: this test never
//! reads the live production v1 vault or any hard-coded Robot Money address. Every address comes
//! from the manifests the publish run wrote.

mod common;

use common::pg_fixture;
use explorer_indexer::{db::CountTable, indexer::run_once, indexer::IndexerConfig, rpc::JsonRpc};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn populates_nine_tables_and_reindex_is_idempotent() {
    let has_twin = std::env::var("TWIN_RPC_URL")
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    if !has_twin {
        panic!(
            "[explorer-indexer-tests] TWIN_RPC_URL REQUIRED here but unset. Start the Twin fork \
             (bun scripts/devnet/twin-fork.ts start) and export TWIN_RPC_URL, \
             PUBLISH_CONTRACTS_DIR and STAGE_SHEET."
        );
    }
    let fx = pg_fixture().await;

    // Deploy our own vault. The harness uses blocking reqwest and std::process, so run it on a
    // blocking thread. It reuses the running Twin fork and never stops it.
    let twin = tokio::task::spawn_blocking(smoke_test::Fixture::new)
        .await
        .unwrap()
        .expect("smoke-test fixture deploys its own vault on the Twin chain");
    let rpc_url = twin.rpc_url().to_string();

    let rpc = JsonRpc::new(&rpc_url);
    let head = rpc.block_number().await.expect("Twin head block");
    let cfg = IndexerConfig {
        chain_id: twin.chain_id() as i64,
        chain_name: "twin".into(),
        rpc_label: "twin-fork".into(),
        gateway: twin.gateway(),
        vault: twin.vault(),
        registry: None,
        router_governance: None,
        portfolio_router: None,
        investment_committee: None,
        consensus_receipt: None,
        max_blocks_per_tick: 200,
        // Cap the run at the safe head so the heartbeat snapshot lands at a known block.
        end_block: Some(head.saturating_sub(explorer_indexer::CONFIRMATIONS)),
        feature_flags: 0,
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

    // A fork this test did not start is left running.
    drop(twin);
}
