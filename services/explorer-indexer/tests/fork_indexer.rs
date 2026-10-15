//! Full-stack integration test: boot Postgres in a container, deploy a vault of OUR OWN to the Twin
//! chain through the deploy scripts (the smoke-test harness, which calls the "publish
//! contracts" runbook, `publish-contracts/` in this repo), point the indexer at the Twin chain and at the manifest addresses, run a
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
//! optionally `STAGE_SHEET` for the publish run (default: the committed `deployments/twin-918453/stage-sheet.env`). Clean room rule: this test never
//! reads the live production v1 vault or any hard-coded Robot Money address. Every address comes
//! from the manifests the publish run wrote.
//!
//! The second test (security round 1, core 1820) excludes and restores an adapter of
//! that vault through the real Safe and timelock, and checks that the indexer finds the exclusion
//! record at the ledger the vault's initializer created and that the explorer serves the holder's
//! claim.

mod common;

use common::pg_fixture;
use explorer_indexer::{db::CountTable, indexer::run_once, indexer::IndexerConfig, rpc::JsonRpc};

/// One test of this file at a time. Each deploys through its own `smoke_test::Fixture`, and two
/// fixtures sending from the same harness keys at once would race their nonces.
static TWIN_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn twin_serial() -> std::sync::MutexGuard<'static, ()> {
    TWIN_SERIAL
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::await_holding_lock)]
async fn populates_nine_tables_and_reindex_is_idempotent() {
    let _serial = twin_serial();
    let has_twin = std::env::var("TWIN_RPC_URL")
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    if !has_twin {
        panic!(
            "[explorer-indexer-tests] TWIN_RPC_URL REQUIRED here but unset. Start the Twin fork \
             (bun scripts/devnet/twin-fork.ts start) and export TWIN_RPC_URL."
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
        timelock: None,
        safe: None,
        max_blocks_per_tick: 200,
        start_block: None,
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

alloy_sol_types::sol! {
    /// The vault's governance lever that excludes (`false`) and restores (`true`) an adapter.
    interface ITwinVaultAdmin {
        function setAdapterAllowed(address adapter_, bool allowed_) external;
    }
    /// The ledger reads this test checks the index against.
    interface ITwinExclusionLedger {
        function VAULT() external view returns (address);
        function claimable(uint256 id, address holder) external view returns (uint256);
    }
}

/// Security round 1 (core 1820): the exclusion records of a proxy vault are indexed
/// from the ledger its initializer created, and the holder's claim is served.
///
/// Every vault is an ERC-1967 proxy, and its initializer creates the ledger (`RobotMoneyVaultOps.createLedger`). The
/// indexer used to derive the ledger as the vault's CREATE address at nonce 1, which holds no code
/// on a proxy, so no record was ever indexed and `/v1/accounts/:holder/exclusion-claims` said
/// nothing was owed. Here a holder deposits into the freshly published rmUSDC vault, governance
/// (the real Safe and timelock) excludes its Aave adapter, which opens record 1, and then restores
/// it, which drains the adapter into the record and closes it. The indexer then runs over the
/// whole range. It must store the vault's ledger as the vault names it, index the record at that
/// ledger, and the explorer must serve the holder a claim equal to the ledger's own `claimable`.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[allow(clippy::await_holding_lock)]
async fn exclusion_record_of_a_proxy_vault_is_indexed_at_its_factory_ledger() {
    use alloy_primitives::{Address, Bytes, U256};
    use alloy_sol_types::SolCall as _;
    use explorer_indexer::abi::IRobotMoneyVaultReads;
    use explorer_indexer::indexer::{classify_ledger_read, LedgerRead};
    use std::str::FromStr as _;

    let _serial = twin_serial();
    let has_twin = std::env::var("TWIN_RPC_URL")
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    if !has_twin {
        panic!(
            "[explorer-indexer-tests] TWIN_RPC_URL REQUIRED here but unset. Start the Twin fork \
             (bun scripts/devnet/twin-fork.ts start) and export TWIN_RPC_URL."
        );
    }
    let fx = pg_fixture().await;
    let twin = tokio::task::spawn_blocking(smoke_test::Fixture::new)
        .await
        .unwrap()
        .expect("smoke-test fixture deploys its own vault on the Twin chain");
    let rpc_url = twin.rpc_url().to_string();
    let rpc = JsonRpc::new(&rpc_url);
    let chain_id = twin.chain_id() as i64;
    let vault = twin.vault();
    let vault_hex = format!("{vault:#x}");

    // The vault names its ledger: a contract bound to this vault, and not the vault's own CREATE
    // address at nonce 1 (the old derivation).
    let head = rpc.block_number().await.expect("Twin head block");
    let reply = rpc
        .eth_call_at(
            vault,
            Bytes::from(IRobotMoneyVaultReads::exclusionLedgerCall {}.abi_encode()),
            head,
        )
        .await;
    let ledger = match classify_ledger_read(reply).expect("exclusionLedger() read") {
        LedgerRead::Ledger(ledger) => ledger,
        other => panic!("the published rmUSDC vault names no ExclusionLedger: {other:?}"),
    };
    assert_ne!(
        ledger,
        vault.create(1),
        "the ledger is the factory's creation, not the vault's"
    );
    assert!(
        !rpc.get_code_at(ledger, head)
            .await
            .expect("ledger code")
            .is_empty(),
        "the ledger the vault names holds code"
    );
    let bound = rpc
        .eth_call_at(
            ledger,
            Bytes::from(ITwinExclusionLedger::VAULTCall {}.abi_encode()),
            head,
        )
        .await
        .expect("ledger VAULT()");
    assert_eq!(
        Address::from_slice(&bound[12..32]),
        vault,
        "the ledger is bound to this vault"
    );

    // A holder deposits, so the adapters hold USDC and the record has a snapshot holder. Then
    // governance excludes the Aave adapter (record 1 opens) and restores it (the adapter's balance
    // goes to the record, which closes as Restored).
    let holder =
        Address::from_str(smoke_test::SHARE_RECEIVER_ADDRESS_HEX).expect("share receiver address");
    let holder_hex = format!("{holder:#x}");
    let amount: u128 = 1_000 * 1_000_000;
    tokio::task::block_in_place(|| -> Result<(), smoke_test::HarnessError> {
        twin.fund_usdc(holder, amount)?;
        twin.cast_send(
            smoke_test::SHARE_RECEIVER_PRIVATE_KEY_HEX,
            twin.usdc(),
            "approve(address,uint256)",
            &[&vault_hex, &amount.to_string()],
        )?;
        twin.cast_send(
            smoke_test::SHARE_RECEIVER_PRIVATE_KEY_HEX,
            vault,
            "deposit(uint256,address)",
            &[&amount.to_string(), &holder_hex],
        )?;
        let adapter = twin.aave_adapter();
        for (step, allowed) in [("exclude", false), ("restore", true)] {
            let data = ITwinVaultAdmin::setAdapterAllowedCall {
                adapter_: adapter,
                allowed_: allowed,
            }
            .abi_encode();
            twin.published().govern_call(
                &format!("indexer-exclusion-{step}-{}", std::process::id()),
                &vault_hex,
                &format!("0x{}", hex::encode(data)),
            )?;
        }
        Ok(())
    })
    .expect("deposit, exclude and restore through the real Safe and timelock");
    let last_action = rpc.block_number().await.expect("Twin head block");

    // Index past the restore. Each round mines a few blocks so the safe head passes it.
    let cfg = IndexerConfig {
        chain_id,
        chain_name: "twin".into(),
        rpc_label: "twin-fork".into(),
        gateway: twin.gateway(),
        vault,
        registry: None,
        router_governance: None,
        portfolio_router: None,
        investment_committee: None,
        consensus_receipt: None,
        timelock: None,
        safe: None,
        max_blocks_per_tick: 2000,
        start_block: None,
        end_block: None,
        feature_flags: 0,
    };
    let http = reqwest::Client::new();
    let mut indexed_to = None;
    for attempt in 0..60 {
        let o = run_once(&fx.db, &rpc, &cfg).await.expect("run_once");
        assert!(o.error.is_none(), "run {attempt} clean: {:?}", o.error);
        indexed_to = o.last_indexed_block;
        if indexed_to.is_some_and(|b| b as u64 >= last_action) {
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
    assert!(
        indexed_to.is_some_and(|b| b as u64 >= last_action),
        "the indexer never reached block {last_action} (at {indexed_to:?})"
    );

    // The ledger is stored as the vault named it, and the record is indexed at that ledger.
    let mapping: Vec<(Vec<u8>, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT vault_address, ledger_address FROM vault_exclusion_ledgers \
         WHERE chain_id = $1 AND vault_address = $2",
    )
    .bind(chain_id)
    .bind(vault.as_slice())
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(mapping, vec![(vault.to_vec(), Some(ledger.to_vec()))]);
    let records: Vec<(Vec<u8>, i64, Vec<u8>)> = sqlx::query_as(
        "SELECT ledger_address, exclusion_id, vault_address FROM exclusion_records \
         WHERE chain_id = $1 ORDER BY exclusion_id",
    )
    .bind(chain_id)
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        records,
        vec![(ledger.to_vec(), 1, vault.to_vec())],
        "record 1 of the factory-created ledger is indexed"
    );
    let reasons: Vec<i16> = sqlx::query_scalar(
        "SELECT reason FROM exclusion_finalizations WHERE chain_id = $1 AND ledger_address = $2",
    )
    .bind(chain_id)
    .bind(ledger.as_slice())
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(reasons, vec![0], "the restore closed the record (Restored)");

    // The ledger's own answer is the authority.
    let head = rpc.block_number().await.expect("Twin head block");
    let on_chain = rpc
        .eth_call_at(
            ledger,
            Bytes::from(
                ITwinExclusionLedger::claimableCall {
                    id: U256::from(1u64),
                    holder,
                }
                .abi_encode(),
            ),
            head,
        )
        .await
        .expect("ledger claimable(1, holder)");
    let on_chain = U256::from_be_slice(&on_chain[..32]);
    assert!(
        on_chain > U256::ZERO,
        "the restore recovered USDC for the holder"
    );

    // The explorer serves the same claim.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = explorer_api::router(explorer_api::AppState::new(fx.db.pool().clone(), chain_id));
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let body: serde_json::Value = http
        .get(format!(
            "http://{addr}/v1/accounts/{holder_hex}/exclusion-claims"
        ))
        .send()
        .await
        .expect("explorer-api answers")
        .json()
        .await
        .expect("exclusion-claims is JSON");
    let claims = body["claims"].as_array().expect("claims array");
    assert_eq!(claims.len(), 1, "{body}");
    assert_eq!(
        claims[0]["exclusion_ledger"]
            .as_str()
            .map(str::to_lowercase),
        Some(format!("{ledger:#x}")),
        "{body}"
    );
    assert_eq!(
        claims[0]["claimable_usdc"].as_str(),
        Some(on_chain.to_string().as_str()),
        "the served claim is the ledger's claimable: {body}"
    );
    assert_eq!(
        body["total_claimable_usdc"].as_str(),
        Some(on_chain.to_string().as_str()),
        "{body}"
    );

    drop(twin);
}
