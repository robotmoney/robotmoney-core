//! Full-stack integration test: boot Postgres in a container, deploy a vault of OUR OWN to the Twin
//! chain through the deploy scripts (the smoke-test harness, which calls the devops "publish
//! contracts" runbook), point the indexer at the Twin chain and at the manifest addresses, run a
//! bounded range, and assert the contract of issue #57:
//!
//! - `indexer_runs` records a successful run.
//! - All 9 minimum tables are reachable by COUNT(*) (i.e. every
//!   migration applied cleanly under load).
//! - A `vault_snapshots` row exists for the NEW vault (heartbeat or event-driven; our vault
//!   always has totalAssets readable). The test waits for it and fails when it never lands.
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
    let new_vault = twin.vault();
    let new_vault_bytes: Vec<u8> = new_vault.as_slice().to_vec();
    let cfg_for = |head: u64| IndexerConfig {
        chain_id: twin.chain_id() as i64,
        chain_name: "twin".into(),
        rpc_label: "twin-fork".into(),
        gateway: twin.gateway(),
        vault: new_vault,
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

    // Wait for the indexer to index the freshly deployed vault: run, and when no vault_snapshots
    // row for the NEW vault exists yet, mine a block (an allowed Twin chain environment step, so
    // the safe head moves past the deploy block) and run again. Bounded: 30 attempts.
    let snapshots_for_new_vault = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM vault_snapshots WHERE chain_id = $1 AND contract = $2",
        )
        .bind(twin.chain_id() as i64)
        .bind(&new_vault_bytes[..])
        .fetch_one(fx.db.pool())
        .await
        .expect("count vault_snapshots for the new vault")
    };
    let http = reqwest::Client::new();
    let mut cfg = cfg_for(rpc.block_number().await.expect("Twin head block"));
    let mut o1 = None;
    for attempt in 0..30 {
        let head = rpc.block_number().await.expect("Twin head block");
        cfg = cfg_for(head);
        let o = run_once(&fx.db, &rpc, &cfg).await.expect("run_once");
        assert!(o.error.is_none(), "run {attempt} clean: {:?}", o.error);
        o1.get_or_insert(o);
        if snapshots_for_new_vault().await >= 1 {
            break;
        }
        let _ = http
            .post(&rpc_url)
            .json(
                &serde_json::json!({"jsonrpc":"2.0","id":1,"method":"anvil_mine","params":["0x6"]}),
            )
            .send()
            .await;
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    let o1 = o1.expect("at least one run");
    assert!(
        o1.last_indexed_block.is_some(),
        "first run advances last_indexed_block"
    );
    assert!(
        snapshots_for_new_vault().await >= 1,
        "no vault_snapshots row for the freshly deployed vault {new_vault:#x}"
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
    // Heartbeat snapshot for the NEW vault landed (asserted above).
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
