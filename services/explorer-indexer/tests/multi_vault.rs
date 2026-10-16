//! Suite-08 — multi-vault schema migration tests (issue #315).
//!
//! Acceptance criteria exercised here:
//!
//! AC-2: vault_snapshots rows for the second registered vault are indexed
//!       independently (two registered vaults, each gets its own snapshot).
//!
//! AC-3: router_weight_snapshots populated on the router's WeightsSet events
//!       (RouterGovernance.applyReceipt calls PortfolioRouter.setWeights).
//!
//! AC-4 (governance_proposals / governance_votes from ProposalCreated and
//! VoteCast) is gone: RouterGovernance voting was deleted (issue 1698) and
//! migration 0025 dropped both tables. `account_history.rs` checks the old
//! events are ignored.
//!
//! DI-1: a vault registered in a tick has its own Deposit logs from the
//!       registration block to the tick target fetched and applied in that
//!       same tick, before the cursor moves past them.
//!
//! DI-2: a DepositsPaused or Retired vault stays in the watched set and the
//!       snapshot heartbeat, so its holders' exits are indexed and its TVL
//!       follows them.
//!
//! All tests skip cleanly when Docker is not available.
//!
//! Canonical: docs/technical/explorer-schema-decisions.md §3.4 / §3.5
//!            Plan tracking issue #109 §"Phase: Multi-vault explorer"
//!            docs/technical/governance-decisions.md §3.5

mod common;

use alloy_primitives::{Address, U256};
use common::{pg_fixture, StubRpcServer};
use explorer_indexer::{
    abi::{
        IPortfolioRouterEvents, IRobotMoneyVaultReads, IVaultEvents, IVaultReads,
        IVaultRegistryEvents,
    },
    db::CountTable,
    indexer::{run_once, IndexerConfig},
    rpc::JsonRpc,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

// ── Helpers ──────────────────────────────────────────────────────────────────

fn stub_block(number: u64, hash_byte: u8, parent_byte: u8) -> serde_json::Value {
    serde_json::json!({
        "number":     format!("0x{:x}", number),
        "hash":       format!("0x{}", hex::encode([hash_byte; 32])),
        "parentHash": format!("0x{}", hex::encode([parent_byte; 32])),
        "timestamp":  "0x65000000",
        "transactions": []
    })
}

/// Encode a `VaultRegistered` log for the stub server.
/// New signature (VaultRegistry.sol:67): `(address indexed vault, string name, address indexed asset)`.
fn encode_vault_registered_log(
    registry_addr: Address,
    vault_addr: Address,
    name: &str,
    asset_addr: Address,
    block_number: u64,
    tx_hash: [u8; 32],
    log_index: u32,
) -> serde_json::Value {
    use alloy_primitives::LogData;
    use alloy_sol_types::SolEvent as _;

    let event = IVaultRegistryEvents::VaultRegistered {
        vault: vault_addr,
        name: name.to_string(),
        asset: asset_addr,
    };
    let log_data: LogData = event.encode_log_data();
    let topics: Vec<String> = log_data
        .topics()
        .iter()
        .map(|t| format!("{:#x}", t))
        .collect();
    let data_hex = format!("0x{}", hex::encode(log_data.data.as_ref()));

    serde_json::json!({
        "address":          format!("{:#x}", registry_addr),
        "topics":           topics,
        "data":             data_hex,
        "blockNumber":      format!("0x{:x}", block_number),
        "blockHash":        format!("0x{}", hex::encode([0xabu8; 32])),
        "transactionHash":  format!("0x{}", hex::encode(tx_hash)),
        "transactionIndex": "0x0",
        "logIndex":         format!("0x{:x}", log_index),
    })
}

/// Encode an ERC-4626 `Deposit(address indexed caller, address indexed owner, uint256 assets,
/// uint256 shares)` log emitted by `vault_addr`.
#[allow(clippy::too_many_arguments)]
fn encode_erc4626_deposit_log(
    vault_addr: Address,
    caller: Address,
    owner: Address,
    assets: U256,
    shares: U256,
    block_number: u64,
    tx_hash: [u8; 32],
    log_index: u32,
) -> serde_json::Value {
    use alloy_primitives::LogData;
    use alloy_sol_types::SolEvent as _;

    let event = IVaultEvents::Deposit {
        caller,
        owner,
        assets,
        shares,
    };
    let log_data: LogData = event.encode_log_data();
    let topics: Vec<String> = log_data
        .topics()
        .iter()
        .map(|t| format!("{:#x}", t))
        .collect();
    let data_hex = format!("0x{}", hex::encode(log_data.data.as_ref()));

    serde_json::json!({
        "address":          format!("{:#x}", vault_addr),
        "topics":           topics,
        "data":             data_hex,
        "blockNumber":      format!("0x{:x}", block_number),
        "blockHash":        format!("0x{}", hex::encode([0xefu8; 32])),
        "transactionHash":  format!("0x{}", hex::encode(tx_hash)),
        "transactionIndex": "0x0",
        "logIndex":         format!("0x{:x}", log_index),
    })
}

/// Encode any decoded event as a log `emitter` sent, in the stub's `eth_getLogs` shape.
fn encode_event_log<E: alloy_sol_types::SolEvent>(
    emitter: Address,
    event: &E,
    block_number: u64,
    tx_hash: [u8; 32],
    log_index: u32,
) -> serde_json::Value {
    let log_data = event.encode_log_data();
    let topics: Vec<String> = log_data
        .topics()
        .iter()
        .map(|t| format!("{:#x}", t))
        .collect();
    serde_json::json!({
        "address":          format!("{:#x}", emitter),
        "topics":           topics,
        "data":             format!("0x{}", hex::encode(log_data.data.as_ref())),
        "blockNumber":      format!("0x{:x}", block_number),
        "blockHash":        format!("0x{}", hex::encode([0xabu8; 32])),
        "transactionHash":  format!("0x{}", hex::encode(tx_hash)),
        "transactionIndex": "0x0",
        "logIndex":         format!("0x{:x}", log_index),
    })
}

/// Encode a `WeightsSet(address[] vaults, uint256[] bps)` log from the
/// PortfolioRouter. `RouterGovernance.applyReceipt` produces it through
/// `setWeights` (issue 1698).
fn encode_weights_set_log(
    router_addr: Address,
    vaults: &[Address],
    bps: &[U256],
    block_number: u64,
    tx_hash: [u8; 32],
    log_index: u32,
) -> serde_json::Value {
    use alloy_primitives::LogData;
    use alloy_sol_types::SolEvent as _;

    let event = IPortfolioRouterEvents::WeightsSet {
        vaults: vaults.to_vec(),
        bps: bps.to_vec(),
    };
    let log_data: LogData = event.encode_log_data();
    let topics: Vec<String> = log_data
        .topics()
        .iter()
        .map(|t| format!("{:#x}", t))
        .collect();
    let data_hex = format!("0x{}", hex::encode(log_data.data.as_ref()));

    serde_json::json!({
        "address":          format!("{:#x}", router_addr),
        "topics":           topics,
        "data":             data_hex,
        "blockNumber":      format!("0x{:x}", block_number),
        "blockHash":        format!("0x{}", hex::encode([0xbcu8; 32])),
        "transactionHash":  format!("0x{}", hex::encode(tx_hash)),
        "transactionIndex": "0x0",
        "logIndex":         format!("0x{:x}", log_index),
    })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// AC-2: Two registered vaults are snapshotted independently in one tick.
///
/// Sequence:
///   Tick 1 — register vault A and vault B via VaultRegistered events.
///             Both vaults must appear in the vaults table.
///   Tick 2 — no new events. Heartbeat fires for both vaults because no
///             prior snapshot exists. Each vault must have exactly one
///             vault_snapshots row after the tick.
///
/// The stub server returns identical (zero) state-read responses for
/// every eth_call so that the test does not need real vault state.
#[tokio::test]
async fn two_registered_vaults_indexed_independently() {
    let fx = pg_fixture().await;

    let registry_addr = Address::from([0xEEu8; 20]);
    let vault_a = Address::from([0xAAu8; 20]);
    let vault_b = Address::from([0xBBu8; 20]);
    let asset_addr = Address::from([0xDDu8; 20]);

    // Tick 1: register both vaults.
    let reg_a = encode_vault_registered_log(
        registry_addr,
        vault_a,
        "Vault A",
        asset_addr,
        50u64,
        [0x11u8; 32],
        0,
    );
    let reg_b = encode_vault_registered_log(
        registry_addr,
        vault_b,
        "Vault B",
        asset_addr,
        50u64,
        [0x11u8; 32],
        1,
    );

    let stub1 = StubRpcServer::start().await;
    stub1.set(
        "eth_blockNumber",
        serde_json::Value::String("0x46".into()), // 70
    );
    stub1.set("eth_getLogs", serde_json::Value::Array(vec![reg_a, reg_b]));
    // Zero-state eth_call response (32 zero bytes).
    stub1.set(
        "eth_call",
        serde_json::Value::String(format!("0x{}", "00".repeat(32))),
    );
    stub1.set("eth_getBlockByNumber", stub_block(65, 0xab, 0xaa));

    let rpc1 = JsonRpc::new(&stub1.url);
    let cfg = IndexerConfig {
        chain_id: 8453,
        chain_name: "base".into(),
        rpc_label: "stub".into(),
        gateway: Address::from([0xCCu8; 20]),
        vault: vault_a,
        registry: Some(registry_addr),
        router_governance: None,
        portfolio_router: None,
        investment_committee: None,
        consensus_receipt: None,
        timelock: None,
        safe: None,
        max_blocks_per_tick: 200,
        start_block: None,
        end_block: Some(65),
        feature_flags: 4,
    };

    let o1 = run_once(&fx.db, &rpc1, &cfg).await.unwrap();
    assert!(o1.error.is_none(), "tick 1 must succeed: {:?}", o1.error);
    stub1.shutdown();

    // Both vaults must be registered.
    let vault_count = fx.db.count(CountTable::Vaults).await.unwrap();
    assert_eq!(vault_count, 2, "both vaults must be in the vaults table");

    // Tick 2: no events, heartbeat fires for both vaults because no
    // prior snapshot exists.
    let stub2 = StubRpcServer::start().await;
    stub2.set(
        "eth_blockNumber",
        serde_json::Value::String("0x5e".into()), // 94
    );
    stub2.set("eth_getLogs", serde_json::Value::Array(Vec::new()));
    stub2.set(
        "eth_call",
        serde_json::Value::String(format!("0x{}", "00".repeat(32))),
    );
    // The stub answers every header request with this one block, including the reorg check's read
    // of block 65. It carries block 65's hash (0xab), so tick 2 sees no reorg. A different hash
    // would read as a reorg of block 65, and the rollback now deletes the vaults registered above
    // its root (QA plan X7, DI-8), which these two vaults would not survive.
    stub2.set("eth_getBlockByNumber", stub_block(89, 0xab, 0xaa));

    let rpc2 = JsonRpc::new(&stub2.url);
    let cfg2 = IndexerConfig {
        chain_id: 8453,
        chain_name: "base".into(),
        rpc_label: "stub".into(),
        gateway: Address::from([0xCCu8; 20]),
        vault: vault_a,
        registry: Some(registry_addr),
        router_governance: None,
        portfolio_router: None,
        investment_committee: None,
        consensus_receipt: None,
        timelock: None,
        safe: None,
        max_blocks_per_tick: 200,
        start_block: None,
        end_block: Some(89),
        feature_flags: 4,
    };

    let o2 = run_once(&fx.db, &rpc2, &cfg2).await.unwrap();
    assert!(o2.error.is_none(), "tick 2 must succeed: {:?}", o2.error);
    stub2.shutdown();

    // Each vault must have its own vault_snapshots row.
    let snaps_a: (i64,) = sqlx::query_as(
        "SELECT COUNT(*)::BIGINT FROM vault_snapshots WHERE chain_id = $1 AND contract = $2",
    )
    .bind(8453i64)
    .bind(&vault_a.into_array()[..])
    .fetch_one(fx.db.pool())
    .await
    .unwrap();
    assert!(snaps_a.0 >= 1, "vault A must have at least one snapshot");

    let snaps_b: (i64,) = sqlx::query_as(
        "SELECT COUNT(*)::BIGINT FROM vault_snapshots WHERE chain_id = $1 AND contract = $2",
    )
    .bind(8453i64)
    .bind(&vault_b.into_array()[..])
    .fetch_one(fx.db.pool())
    .await
    .unwrap();
    assert!(snaps_b.0 >= 1, "vault B must have at least one snapshot");
}

/// AC-3: WeightsSet event from the PortfolioRouter populates
/// router_weight_snapshots with one row per vault leg.
#[tokio::test]
async fn weights_set_event_populates_router_weight_snapshots() {
    let fx = pg_fixture().await;

    let router_addr = Address::from([0xFFu8; 20]);
    let vault_a = Address::from([0xAAu8; 20]);
    let vault_b = Address::from([0xBBu8; 20]);

    // WeightsSet: vaultA = 6000 bps, vaultB = 4000 bps.
    let weights_log = encode_weights_set_log(
        router_addr,
        &[vault_a, vault_b],
        &[U256::from(6000u64), U256::from(4000u64)],
        50u64,
        [0x22u8; 32],
        0,
    );

    let stub = StubRpcServer::start().await;
    stub.set(
        "eth_blockNumber",
        serde_json::Value::String("0x46".into()), // 70
    );
    stub.set("eth_getLogs", serde_json::Value::Array(vec![weights_log]));
    stub.set(
        "eth_call",
        serde_json::Value::String(format!("0x{}", "00".repeat(32))),
    );
    stub.set("eth_getBlockByNumber", stub_block(65, 0xab, 0xaa));

    let rpc = JsonRpc::new(&stub.url);
    let cfg = IndexerConfig {
        chain_id: 8453,
        chain_name: "base".into(),
        rpc_label: "stub".into(),
        gateway: Address::from([0xCCu8; 20]),
        vault: Address::from([0xDDu8; 20]),
        registry: None,
        router_governance: None,
        portfolio_router: Some(router_addr),
        investment_committee: None,
        consensus_receipt: None,
        timelock: None,
        safe: None,
        max_blocks_per_tick: 200,
        start_block: None,
        end_block: Some(65),
        feature_flags: 4,
    };

    let o = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(o.error.is_none(), "tick must succeed: {:?}", o.error);
    stub.shutdown();

    // One row per WeightsSet event, containing one vault/weight entry per leg.
    let count = fx
        .db
        .count(CountTable::RouterWeightSnapshots)
        .await
        .unwrap();
    assert_eq!(
        count, 1,
        "router_weight_snapshots must have one row per WeightsSet event"
    );

    let row: (Vec<Vec<u8>>, Vec<i64>) = sqlx::query_as(
        "SELECT vault_addresses, bps_values FROM router_weight_snapshots \
         WHERE chain_id = $1 AND router_address = $2",
    )
    .bind(8453i64)
    .bind(&router_addr.into_array()[..])
    .fetch_one(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        row.0,
        vec![vault_a.as_slice().to_vec(), vault_b.as_slice().to_vec()]
    );
    assert_eq!(row.1, vec![6000i64, 4000i64]);
}

/// DI-1: a vault registered and deposited into within one tick has its deposit indexed in that
/// tick.
///
/// The tick's address set is read from `vaults` before the tick's own `VaultRegistered` is applied,
/// so it cannot name the new vault. The stub answers like a node (`honour_log_filter`), so the
/// deposit at block 55 is only in an answer whose filter names the vault. Before the fix the next
/// tick started at block 66 and the deposit was never fetched: no `vault_transfer_events` row, no
/// position, and the vault's TVL history began after it. The indexer discovers the registrations
/// of the interval first (a registry-only `eth_getLogs`, issue 1796 DI-1), adds the new vault and
/// its ExclusionLedger (X7) to the address set, and then fetches the interval's logs once with the
/// complete set.
///
/// The ledger is the one the new vault's `exclusionLedger()` names (security round 1): the
/// address the vault's initializer created, read from the vault in the same tick, never an
/// address derived from the vault.
#[tokio::test]
async fn vault_registered_and_deposited_in_one_tick_indexes_the_deposit() {
    use alloy_sol_types::SolCall as _;

    let fx = pg_fixture().await;

    let registry_addr = Address::from([0xEEu8; 20]);
    let pinned_vault = Address::from([0xAAu8; 20]);
    let new_vault = Address::from([0xB7u8; 20]);
    let new_ledger = Address::from([0xFAu8; 20]).create(7);
    let asset_addr = Address::from([0xDDu8; 20]);
    let depositor = Address::from([0x5Au8; 20]);
    let assets = U256::from(1_000_000u64);
    let shares = U256::from(999_000u64);

    let reg_log = encode_vault_registered_log(
        registry_addr,
        new_vault,
        "Robot Money Protocol Vault",
        asset_addr,
        50u64,
        [0x11u8; 32],
        0,
    );
    let deposit_log = encode_erc4626_deposit_log(
        new_vault,
        depositor,
        depositor,
        assets,
        shares,
        55u64,
        [0x55u8; 32],
        0,
    );

    let stub = StubRpcServer::start().await;
    stub.honour_log_filter(true);
    stub.set(
        "eth_blockNumber",
        serde_json::Value::String("0x46".into()), // 70
    );
    stub.set(
        "eth_getLogs",
        serde_json::Value::Array(vec![reg_log, deposit_log]),
    );
    // The new vault's `exclusionLedger()` names its factory-created ledger; every other read
    // answers zero (the pinned vault names no ledger yet).
    let new_vault_hex = format!("{:#x}", new_vault);
    let ledger_getter = format!(
        "0x{}",
        hex::encode(IRobotMoneyVaultReads::exclusionLedgerCall::SELECTOR)
    );
    let ledger_word = format!("0x{:0>64}", hex::encode(new_ledger.as_slice()));
    stub.set_call_hook(Arc::new(move |to: &str, data: &str| {
        if to == new_vault_hex && data.starts_with(&ledger_getter) {
            Ok(ledger_word.clone())
        } else {
            Ok(format!("0x{}", "00".repeat(32)))
        }
    }));
    stub.set("eth_getBlockByNumber", stub_block(65, 0xab, 0xaa));

    let rpc = JsonRpc::new(&stub.url);
    let cfg = IndexerConfig {
        chain_id: 8453,
        chain_name: "base".into(),
        rpc_label: "stub".into(),
        gateway: Address::from([0xCCu8; 20]),
        vault: pinned_vault,
        registry: Some(registry_addr),
        router_governance: None,
        portfolio_router: None,
        investment_committee: None,
        consensus_receipt: None,
        timelock: None,
        safe: None,
        max_blocks_per_tick: 200,
        // The stub honours the filter's block range, so pin the first block at 0 rather than lean
        // on deploy-block detection against a stub that serves no code.
        start_block: Some(0),
        end_block: Some(65),
        feature_flags: 4,
    };

    let o = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(o.error.is_none(), "tick must succeed: {:?}", o.error);
    assert_eq!(
        o.last_indexed_block,
        Some(65),
        "the tick closes at the target"
    );

    // The first call discovers the interval's registrations from the registry alone; the second is
    // the interval's log fetch, with the new vault in its address set.
    let get_logs: Vec<serde_json::Value> = stub
        .captured_requests()
        .into_iter()
        .filter(|r| r["method"].as_str() == Some("eth_getLogs"))
        .collect();
    stub.shutdown();
    assert_eq!(
        get_logs.len(),
        2,
        "a tick that registers a vault discovers it, then fetches the interval once: {get_logs:?}"
    );
    let want = format!("{:#x}", new_vault);
    let addrs = |r: &serde_json::Value| -> Vec<String> {
        r["params"][0]["address"]
            .as_array()
            .expect("address filter must be an array")
            .iter()
            .map(|a| a.as_str().unwrap().to_lowercase())
            .collect()
    };
    assert_eq!(
        addrs(&get_logs[0]),
        vec![format!("{:#x}", registry_addr)],
        "the discovery read names the registry alone"
    );
    // The new vault and its ExclusionLedger (QA plan X7), whose exclusion-record events come from
    // the ledger's own address: the one the vault names, not its CREATE address at nonce 1.
    for want in [want.clone(), format!("{:#x}", new_ledger)] {
        assert!(
            addrs(&get_logs[1]).contains(&want),
            "the interval's fetch names {want}: {:?}",
            addrs(&get_logs[1])
        );
    }
    assert!(
        !addrs(&get_logs[1]).contains(&format!("{:#x}", new_vault.create(1))),
        "no address derived from the vault is watched as its ledger"
    );
    assert_eq!(
        get_logs[1]["params"][0]["fromBlock"], "0x0",
        "from the tick's first block, which covers the registration block (50)"
    );
    assert_eq!(
        get_logs[1]["params"][0]["toBlock"], "0x41",
        "to the tick target (65)"
    );

    // The deposit is indexed: a transfer row, the depositor's position, and its block row.
    let transfers: Vec<(i64, String, String, String)> = sqlx::query_as(
        "SELECT block_number, direction, CAST(assets AS text), CAST(shares AS text) \
         FROM vault_transfer_events WHERE chain_id = $1 AND vault = $2",
    )
    .bind(8453i64)
    .bind(&new_vault.into_array()[..])
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        transfers,
        vec![(
            55i64,
            "deposit".to_string(),
            assets.to_string(),
            shares.to_string()
        )],
        "the new vault's deposit in its registration tick must be indexed"
    );

    let position: Option<(String,)> = sqlx::query_as(
        "SELECT CAST(shares AS text) FROM wallet_positions \
         WHERE chain_id = $1 AND contract = $2 AND owner = $3 \
         ORDER BY block_number DESC LIMIT 1",
    )
    .bind(8453i64)
    .bind(&new_vault.into_array()[..])
    .bind(&depositor.into_array()[..])
    .fetch_optional(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        position.map(|p| p.0),
        Some(shares.to_string()),
        "the depositor holds the minted shares"
    );

    let block_55: Option<(i64,)> =
        sqlx::query_as("SELECT block_number FROM blocks WHERE chain_id = $1 AND block_number = 55")
            .bind(8453i64)
            .fetch_optional(fx.db.pool())
            .await
            .unwrap();
    assert!(
        block_55.is_some(),
        "the deposit's block is stored like any event block"
    );

    // The new vault's TVL history starts in this tick, at the deposit block (the event-driven
    // snapshot). The read at the target (65) finds the same state and writes no second row
    // (issue 1768).
    let snaps: (i64,) = sqlx::query_as(
        "SELECT COUNT(*)::BIGINT FROM vault_snapshots \
         WHERE chain_id = $1 AND contract = $2 AND block_number = 55",
    )
    .bind(8453i64)
    .bind(&new_vault.into_array()[..])
    .fetch_one(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        snaps.0, 1,
        "the new vault is snapshotted in its registration tick"
    );
}

/// DI-2: a vault that is Retired (or DepositsPaused) keeps having its withdrawals indexed and its
/// TVL snapshotted.
///
/// The old rmPROTO is retired after its redeploy (issue 1796) and its holders exit afterwards with
/// `redeem`/`redeemInKind`, which emit ERC-4626 `Withdraw` from the old vault. The tick's address
/// set used to hold only `status = 0` vaults, and so did the snapshot heartbeat. Once retired, the
/// vault's `Withdraw` logs were never fetched (the stub answers like a node,
/// `honour_log_filter`): the holder's position kept the burned shares, the watchdog's burn volume
/// missed them, and the vault's last snapshot stayed as its TVL forever. The paused vault is the
/// same gap for status 1.
///
/// Each tick is a separate `run_once` that reads the watched set from `vaults`, as after a restart.
///   Tick 1 (to 65): both vaults are registered at block 50.
///   Tick 2 (to 80): the holder deposits into both at 70; at 75 the old vault is retired and the
///                   other one paused.
///   Tick 3 (to 100): the holder exits the old vault fully and the paused one in part, at 90.
#[tokio::test]
async fn retired_vault_withdrawals_still_index_and_snapshot() {
    let fx = pg_fixture().await;

    let registry_addr = Address::from([0xEEu8; 20]);
    let pinned_vault = Address::from([0xAAu8; 20]);
    let old_vault = Address::from([0xB0u8; 20]);
    let paused_vault = Address::from([0xB1u8; 20]);
    let asset_addr = Address::from([0xDDu8; 20]);
    let holder = Address::from([0x5Au8; 20]);

    let logs = vec![
        encode_vault_registered_log(
            registry_addr,
            old_vault,
            "Robot Money Protocol Vault",
            asset_addr,
            50,
            [0x11u8; 32],
            0,
        ),
        encode_vault_registered_log(
            registry_addr,
            paused_vault,
            "Robot Money Agent Vault",
            asset_addr,
            50,
            [0x11u8; 32],
            1,
        ),
        encode_erc4626_deposit_log(
            old_vault,
            holder,
            holder,
            U256::from(1_000_000u64),
            U256::from(1_000_000u64),
            70,
            [0x70u8; 32],
            0,
        ),
        encode_erc4626_deposit_log(
            paused_vault,
            holder,
            holder,
            U256::from(2_000_000u64),
            U256::from(2_000_000u64),
            70,
            [0x70u8; 32],
            1,
        ),
        encode_event_log(
            registry_addr,
            &IVaultRegistryEvents::VaultStatusChanged {
                vault: old_vault,
                newStatus: 2, // Retired
                timestamp: U256::from(1_700_000_075u64),
            },
            75,
            [0x75u8; 32],
            0,
        ),
        encode_event_log(
            registry_addr,
            &IVaultRegistryEvents::VaultStatusChanged {
                vault: paused_vault,
                newStatus: 1, // DepositsPaused
                timestamp: U256::from(1_700_000_075u64),
            },
            75,
            [0x75u8; 32],
            1,
        ),
        encode_event_log(
            old_vault,
            &IVaultEvents::Withdraw {
                caller: holder,
                receiver: holder,
                owner: holder,
                assets: U256::from(1_000_000u64),
                shares: U256::from(1_000_000u64),
            },
            90,
            [0x90u8; 32],
            0,
        ),
        encode_event_log(
            paused_vault,
            &IVaultEvents::Withdraw {
                caller: holder,
                receiver: holder,
                owner: holder,
                assets: U256::from(500_000u64),
                shares: U256::from(500_000u64),
            },
            90,
            [0x90u8; 32],
            1,
        ),
    ];

    let stub = StubRpcServer::start().await;
    stub.honour_log_filter(true);
    stub.set("eth_blockNumber", serde_json::json!("0x100"));
    stub.set("eth_getLogs", serde_json::Value::Array(logs));
    stub.set("eth_getBlockByNumber", stub_block(65, 0xab, 0xaa));

    // Each vault's (totalAssets, totalSupply) on chain, keyed by lower-case `0x` address. Every
    // other read answers 0.
    let chain: Arc<Mutex<HashMap<String, (u64, u64)>>> = Arc::default();
    let reads = chain.clone();
    let assets_sel =
        hex::encode(<IVaultReads::totalAssetsCall as alloy_sol_types::SolCall>::SELECTOR);
    let supply_sel =
        hex::encode(<IVaultReads::totalSupplyCall as alloy_sol_types::SolCall>::SELECTOR);
    stub.set_call_hook(Arc::new(move |to: &str, data: &str| {
        let (assets, supply) = reads.lock().unwrap().get(to).copied().unwrap_or((0, 0));
        let data = data.trim_start_matches("0x");
        let v = if data.starts_with(&assets_sel) {
            assets
        } else if data.starts_with(&supply_sel) {
            supply
        } else {
            0
        };
        Ok(format!(
            "0x{}",
            hex::encode(U256::from(v).to_be_bytes::<32>())
        ))
    }));
    let set_chain = |vault: Address, assets: u64, supply: u64| {
        chain
            .lock()
            .unwrap()
            .insert(format!("{:#x}", vault), (assets, supply));
    };

    let cfg = |end_block: u64| IndexerConfig {
        chain_id: 8453,
        chain_name: "base".into(),
        rpc_label: "stub".into(),
        gateway: Address::from([0xCCu8; 20]),
        vault: pinned_vault,
        registry: Some(registry_addr),
        router_governance: None,
        portfolio_router: None,
        investment_committee: None,
        consensus_receipt: None,
        timelock: None,
        safe: None,
        max_blocks_per_tick: 200,
        // The stub honours the filter's block range, so pin the first block at 0 rather than lean
        // on deploy-block detection against a stub that serves no code.
        start_block: Some(0),
        end_block: Some(end_block),
        feature_flags: 4,
    };
    let db = &fx.db;
    let url = stub.url.clone();
    let tick = move |end_block: u64| {
        let rpc = JsonRpc::new(&url);
        let cfg = cfg(end_block);
        async move {
            let o = run_once(db, &rpc, &cfg).await.unwrap();
            assert!(
                o.error.is_none(),
                "tick to {end_block} must succeed: {:?}",
                o.error
            );
            assert_eq!(o.last_indexed_block, Some(end_block as i64));
        }
    };

    tick(65).await;
    set_chain(old_vault, 1_000_000, 1_000_000);
    set_chain(paused_vault, 2_000_000, 2_000_000);
    tick(80).await;

    let status = |vault: Address| {
        let pool = fx.db.pool().clone();
        async move {
            let (s,): (i16,) = sqlx::query_as(
                "SELECT status FROM vaults WHERE chain_id = $1 AND vault_address = $2",
            )
            .bind(8453i64)
            .bind(&vault.into_array()[..])
            .fetch_one(&pool)
            .await
            .unwrap();
            s
        }
    };
    assert_eq!(
        status(old_vault).await,
        2,
        "the old vault is Retired before its holder exits"
    );
    assert_eq!(
        status(paused_vault).await,
        1,
        "the other vault is DepositsPaused"
    );

    // The holder exits after the status change. Neither vault is Active any more.
    set_chain(old_vault, 0, 0);
    set_chain(paused_vault, 1_500_000, 1_500_000);
    let requests_before = stub.captured_requests().len();
    tick(100).await;

    let tick3_get_logs: Vec<serde_json::Value> = stub
        .captured_requests()
        .into_iter()
        .skip(requests_before)
        .filter(|r| r["method"].as_str() == Some("eth_getLogs"))
        .collect();
    stub.shutdown();
    // Each tick first discovers registrations from the registry alone (DI-1). The tick's fetch is
    // the other call, and no vault is registered in tick 3.
    let registry_only = vec![format!("{:#x}", registry_addr)];
    let addrs_of = |r: &serde_json::Value| -> Vec<String> {
        r["params"][0]["address"]
            .as_array()
            .expect("address filter must be an array")
            .iter()
            .map(|a| a.as_str().unwrap().to_lowercase())
            .collect()
    };
    let tick3_get_logs: Vec<serde_json::Value> = tick3_get_logs
        .into_iter()
        .filter(|r| addrs_of(r) != registry_only)
        .collect();
    assert_eq!(
        tick3_get_logs.len(),
        1,
        "one fetch for the interval in tick 3: {tick3_get_logs:?}"
    );
    let filter: Vec<String> = tick3_get_logs[0]["params"][0]["address"]
        .as_array()
        .expect("address filter must be an array")
        .iter()
        .map(|a| a.as_str().unwrap().to_lowercase())
        .collect();
    for vault in [old_vault, paused_vault] {
        assert!(
            filter.contains(&format!("{:#x}", vault)),
            "a vault is watched whatever its status: {vault:#x} missing from {filter:?}"
        );
    }

    // The exits are indexed: one withdrawal row per vault, read by the watchdog's burn volume.
    let withdrawals: Vec<(Vec<u8>, i64, String, String)> = sqlx::query_as(
        "SELECT vault, block_number, CAST(assets AS text), CAST(shares AS text)          FROM vault_transfer_events          WHERE chain_id = $1 AND direction = 'withdrawal' ORDER BY vault",
    )
    .bind(8453i64)
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        withdrawals,
        vec![
            (
                old_vault.as_slice().to_vec(),
                90i64,
                "1000000".to_string(),
                "1000000".to_string()
            ),
            (
                paused_vault.as_slice().to_vec(),
                90i64,
                "500000".to_string(),
                "500000".to_string()
            ),
        ],
        "both exits after the status change must be indexed"
    );

    // The holder's positions follow the exits: nothing left in the old vault.
    let position = |vault: Address| {
        let pool = fx.db.pool().clone();
        async move {
            let (shares,): (String,) = sqlx::query_as(
                "SELECT CAST(shares AS text) FROM wallet_positions                  WHERE chain_id = $1 AND contract = $2 AND owner = $3                  ORDER BY block_number DESC LIMIT 1",
            )
            .bind(8453i64)
            .bind(&vault.into_array()[..])
            .bind(&holder.into_array()[..])
            .fetch_one(&pool)
            .await
            .unwrap();
            shares
        }
    };
    assert_eq!(
        position(old_vault).await,
        "0",
        "the holder left the retired vault"
    );
    assert_eq!(position(paused_vault).await, "1500000");

    // Each vault's newest snapshot is read after the exits. The retired vault's TVL is 0, not the
    // 1000000 it held when it was retired. The exits are at block 90, where the event-driven snapshot
    // is taken. Tick 3's read at the target (100) finds the same state and writes no second row
    // (issue 1768), so the newest row is the one at the exit block.
    let latest_snapshot = |vault: Address| {
        let pool = fx.db.pool().clone();
        async move {
            let row: (i64, String) = sqlx::query_as(
                "SELECT block_number, CAST(total_assets AS text) FROM vault_snapshots                  WHERE chain_id = $1 AND contract = $2 ORDER BY block_number DESC LIMIT 1",
            )
            .bind(8453i64)
            .bind(&vault.into_array()[..])
            .fetch_one(&pool)
            .await
            .unwrap();
            row
        }
    };
    assert_eq!(
        latest_snapshot(old_vault).await,
        (90i64, "0".to_string()),
        "the retired vault is snapshotted after its holder exits"
    );
    assert_eq!(
        latest_snapshot(paused_vault).await,
        (90i64, "1500000".to_string()),
        "the paused vault is snapshotted after its holder's partial exit"
    );
}
