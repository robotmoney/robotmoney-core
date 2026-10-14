//! Suite — vault detail event indexing tests (issue #675).
//!
//! Acceptance criteria exercised here:
//!
//! - `adapter_allocation`: VaultAllocated (Allocated), VaultPulled (Pulled), and
//!   VaultRebalanced (Rebalanced) events are written to `adapter_allocations`.
//!
//! - `fee_charged`: ExitFeeCharged events are written to `vault_fee_events`.
//!
//! - ERC-4626 Deposit and Withdraw events are written to `vault_transfer_events`.
//!
//! All tests skip cleanly when Docker is not available.
//!
//! Canonical: docs/architecture.md §5.4

mod common;

use alloy_primitives::{Address, U256};
use common::{pg_fixture, StubRpcServer};
use explorer_indexer::{
    abi::IVaultEvents,
    db::CountTable,
    indexer::{run_once, IndexerConfig},
    rpc::JsonRpc,
};

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

/// Encode an `Allocated(uint256 indexed index, address indexed adapter, uint256 amount)` log.
fn encode_allocated_log(
    vault_addr: Address,
    adapter: Address,
    index: U256,
    amount: U256,
    block_number: u64,
    tx_hash: [u8; 32],
    log_index: u32,
) -> serde_json::Value {
    use alloy_primitives::LogData;
    use alloy_sol_types::SolEvent as _;

    let event = IVaultEvents::Allocated {
        index,
        adapter,
        amount,
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
        "blockHash":        format!("0x{}", hex::encode([0xabu8; 32])),
        "transactionHash":  format!("0x{}", hex::encode(tx_hash)),
        "transactionIndex": "0x0",
        "logIndex":         format!("0x{:x}", log_index),
    })
}

/// Encode a `Pulled(uint256 indexed index, address indexed adapter, uint256 amount)` log.
fn encode_pulled_log(
    vault_addr: Address,
    adapter: Address,
    index: U256,
    amount: U256,
    block_number: u64,
    tx_hash: [u8; 32],
    log_index: u32,
) -> serde_json::Value {
    use alloy_primitives::LogData;
    use alloy_sol_types::SolEvent as _;

    let event = IVaultEvents::Pulled {
        index,
        adapter,
        amount,
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
        "blockHash":        format!("0x{}", hex::encode([0xabu8; 32])),
        "transactionHash":  format!("0x{}", hex::encode(tx_hash)),
        "transactionIndex": "0x0",
        "logIndex":         format!("0x{:x}", log_index),
    })
}

/// Encode a `Rebalanced(uint256 totalMoved)` log.
fn encode_rebalanced_log(
    vault_addr: Address,
    total_moved: U256,
    block_number: u64,
    tx_hash: [u8; 32],
    log_index: u32,
) -> serde_json::Value {
    use alloy_primitives::LogData;
    use alloy_sol_types::SolEvent as _;

    let event = IVaultEvents::Rebalanced {
        totalMoved: total_moved,
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
        "blockHash":        format!("0x{}", hex::encode([0xabu8; 32])),
        "transactionHash":  format!("0x{}", hex::encode(tx_hash)),
        "transactionIndex": "0x0",
        "logIndex":         format!("0x{:x}", log_index),
    })
}

/// Encode an `ExitFeeCharged(address indexed owner, address indexed receiver,
/// uint256 grossAssets, uint256 fee, uint256 netAssets)` log.
#[allow(clippy::too_many_arguments)]
fn encode_exit_fee_charged_log(
    vault_addr: Address,
    owner: Address,
    receiver: Address,
    gross_assets: U256,
    fee: U256,
    net_assets: U256,
    block_number: u64,
    tx_hash: [u8; 32],
    log_index: u32,
) -> serde_json::Value {
    use alloy_primitives::LogData;
    use alloy_sol_types::SolEvent as _;

    let event = IVaultEvents::ExitFeeCharged {
        owner,
        receiver,
        grossAssets: gross_assets,
        fee,
        netAssets: net_assets,
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
        "blockHash":        format!("0x{}", hex::encode([0xabu8; 32])),
        "transactionHash":  format!("0x{}", hex::encode(tx_hash)),
        "transactionIndex": "0x0",
        "logIndex":         format!("0x{:x}", log_index),
    })
}

/// Encode an ERC-4626 `Deposit(address indexed caller, address indexed owner,
/// uint256 assets, uint256 shares)` log.
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
        "blockHash":        format!("0x{}", hex::encode([0xabu8; 32])),
        "transactionHash":  format!("0x{}", hex::encode(tx_hash)),
        "transactionIndex": "0x0",
        "logIndex":         format!("0x{:x}", log_index),
    })
}

#[allow(clippy::too_many_arguments)]
fn encode_erc4626_withdraw_log(
    vault_addr: Address,
    caller: Address,
    receiver: Address,
    owner: Address,
    assets: U256,
    shares: U256,
    block_number: u64,
    tx_hash: [u8; 32],
    log_index: u32,
) -> serde_json::Value {
    use alloy_primitives::LogData;
    use alloy_sol_types::SolEvent as _;

    let event = IVaultEvents::Withdraw {
        caller,
        receiver,
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
        "blockHash":        format!("0x{}", hex::encode([0xabu8; 32])),
        "transactionHash":  format!("0x{}", hex::encode(tx_hash)),
        "transactionIndex": "0x0",
        "logIndex":         format!("0x{:x}", log_index),
    })
}

fn base_config(vault: Address) -> IndexerConfig {
    IndexerConfig {
        chain_id: 8453,
        chain_name: "base".into(),
        rpc_label: "stub".into(),
        gateway: Address::from([0xCCu8; 20]),
        vault,
        registry: None,
        router_governance: None,
        portfolio_router: None,
        investment_committee: None,
        consensus_receipt: None,
        timelock: None,
        safe: None,
        max_blocks_per_tick: 200,
        start_block: None,
        end_block: Some(65),
        feature_flags: 0,
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/// Confirms VaultAllocated rows are written to `adapter_allocations`.
/// Test plan: `cargo test -p explorer-indexer -- adapter_allocation`
#[tokio::test]
async fn adapter_allocation_allocated_rows_written() {
    let fx = pg_fixture().await;

    let vault_addr = Address::from([0xAAu8; 20]);
    let adapter_addr = Address::from([0xBBu8; 20]);

    let allocated_log = encode_allocated_log(
        vault_addr,
        adapter_addr,
        U256::from(0u64),
        U256::from(500_000u64),
        50u64,
        [0x11u8; 32],
        0,
    );

    let stub = StubRpcServer::start().await;
    stub.set(
        "eth_blockNumber",
        serde_json::Value::String("0x46".into()), // 70
    );
    stub.set("eth_getLogs", serde_json::Value::Array(vec![allocated_log]));
    stub.set(
        "eth_call",
        serde_json::Value::String(format!("0x{}", "00".repeat(32))),
    );
    stub.set("eth_getBlockByNumber", stub_block(65, 0xab, 0xaa));

    let rpc = JsonRpc::new(&stub.url);
    let cfg = base_config(vault_addr);

    let o = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(o.error.is_none(), "tick must succeed: {:?}", o.error);
    stub.shutdown();

    let count = fx.db.count(CountTable::AdapterAllocations).await.unwrap();
    assert_eq!(
        count, 1,
        "adapter_allocations must have one row after Allocated event"
    );

    // Verify event_kind and amount.
    let row: (String, bigdecimal::BigDecimal, Option<Vec<u8>>) = sqlx::query_as(
        "SELECT event_kind, amount, adapter FROM adapter_allocations WHERE chain_id = $1",
    )
    .bind(8453i64)
    .fetch_one(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(row.0, "allocated");
    assert_eq!(row.2.as_deref(), Some(adapter_addr.as_slice()));
}

/// Confirms VaultPulled rows are written to `adapter_allocations` (AC: adapter_allocation).
#[tokio::test]
async fn adapter_allocation_pulled_rows_written() {
    let fx = pg_fixture().await;

    let vault_addr = Address::from([0xAAu8; 20]);
    let adapter_addr = Address::from([0xBBu8; 20]);

    let pulled_log = encode_pulled_log(
        vault_addr,
        adapter_addr,
        U256::from(0u64),
        U256::from(200_000u64),
        50u64,
        [0x22u8; 32],
        0,
    );

    let stub = StubRpcServer::start().await;
    stub.set("eth_blockNumber", serde_json::Value::String("0x46".into()));
    stub.set("eth_getLogs", serde_json::Value::Array(vec![pulled_log]));
    stub.set(
        "eth_call",
        serde_json::Value::String(format!("0x{}", "00".repeat(32))),
    );
    stub.set("eth_getBlockByNumber", stub_block(65, 0xab, 0xaa));

    let rpc = JsonRpc::new(&stub.url);
    let cfg = base_config(vault_addr);

    let o = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(o.error.is_none(), "tick must succeed: {:?}", o.error);
    stub.shutdown();

    let count = fx.db.count(CountTable::AdapterAllocations).await.unwrap();
    assert_eq!(
        count, 1,
        "adapter_allocations must have one row after Pulled event"
    );

    let row: (String,) =
        sqlx::query_as("SELECT event_kind FROM adapter_allocations WHERE chain_id = $1")
            .bind(8453i64)
            .fetch_one(fx.db.pool())
            .await
            .unwrap();
    assert_eq!(row.0, "pulled");
}

/// Confirms VaultRebalanced rows are written to `adapter_allocations` (AC: adapter_allocation).
/// The adapter and adapter_index columns must be NULL for Rebalanced events.
#[tokio::test]
async fn adapter_allocation_rebalanced_rows_written() {
    let fx = pg_fixture().await;

    let vault_addr = Address::from([0xAAu8; 20]);

    let rebalanced_log =
        encode_rebalanced_log(vault_addr, U256::from(300_000u64), 50u64, [0x33u8; 32], 0);

    let stub = StubRpcServer::start().await;
    stub.set("eth_blockNumber", serde_json::Value::String("0x46".into()));
    stub.set(
        "eth_getLogs",
        serde_json::Value::Array(vec![rebalanced_log]),
    );
    stub.set(
        "eth_call",
        serde_json::Value::String(format!("0x{}", "00".repeat(32))),
    );
    stub.set("eth_getBlockByNumber", stub_block(65, 0xab, 0xaa));

    let rpc = JsonRpc::new(&stub.url);
    let cfg = base_config(vault_addr);

    let o = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(o.error.is_none(), "tick must succeed: {:?}", o.error);
    stub.shutdown();

    let count = fx.db.count(CountTable::AdapterAllocations).await.unwrap();
    assert_eq!(
        count, 1,
        "adapter_allocations must have one row after Rebalanced event"
    );

    // Adapter and adapter_index must be NULL for Rebalanced.
    let row: (String, Option<Vec<u8>>, Option<i64>) = sqlx::query_as(
        "SELECT event_kind, adapter, adapter_index FROM adapter_allocations WHERE chain_id = $1",
    )
    .bind(8453i64)
    .fetch_one(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(row.0, "rebalanced");
    assert!(row.1.is_none(), "adapter must be NULL for Rebalanced event");
    assert!(
        row.2.is_none(),
        "adapter_index must be NULL for Rebalanced event"
    );
}

/// Confirms ExitFeeCharged rows are written to `vault_fee_events`.
/// Test plan: `cargo test -p explorer-indexer -- fee_charged`
#[tokio::test]
async fn fee_charged_rows_written() {
    let fx = pg_fixture().await;

    let vault_addr = Address::from([0xAAu8; 20]);
    let owner = Address::from([0x11u8; 20]);
    let receiver = Address::from([0x22u8; 20]);

    let fee_log = encode_exit_fee_charged_log(
        vault_addr,
        owner,
        receiver,
        U256::from(1_000_000u64),
        U256::from(5_000u64),
        U256::from(995_000u64),
        50u64,
        [0x44u8; 32],
        0,
    );

    let stub = StubRpcServer::start().await;
    stub.set("eth_blockNumber", serde_json::Value::String("0x46".into()));
    stub.set("eth_getLogs", serde_json::Value::Array(vec![fee_log]));
    stub.set(
        "eth_call",
        serde_json::Value::String(format!("0x{}", "00".repeat(32))),
    );
    stub.set("eth_getBlockByNumber", stub_block(65, 0xab, 0xaa));

    let rpc = JsonRpc::new(&stub.url);
    let cfg = base_config(vault_addr);

    let o = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(o.error.is_none(), "tick must succeed: {:?}", o.error);
    stub.shutdown();

    let count = fx.db.count(CountTable::VaultFeeEvents).await.unwrap();
    assert_eq!(
        count, 1,
        "vault_fee_events must have one row after ExitFeeCharged event"
    );

    // Verify owner and receiver addresses.
    let row: (Vec<u8>, Vec<u8>) =
        sqlx::query_as("SELECT owner, receiver FROM vault_fee_events WHERE chain_id = $1")
            .bind(8453i64)
            .fetch_one(fx.db.pool())
            .await
            .unwrap();
    assert_eq!(row.0, owner.as_slice(), "owner address must match");
    assert_eq!(row.1, receiver.as_slice(), "receiver address must match");
}

/// Confirms ERC-4626 Deposit events are written to `vault_transfer_events`
/// with direction='deposit'.
#[tokio::test]
async fn erc4626_deposit_rows_written() {
    let fx = pg_fixture().await;

    let vault_addr = Address::from([0xAAu8; 20]);
    let caller = Address::from([0x33u8; 20]);
    let owner = Address::from([0x44u8; 20]);

    let deposit_log = encode_erc4626_deposit_log(
        vault_addr,
        caller,
        owner,
        U256::from(1_000_000u64),
        U256::from(1_000_000u64),
        50u64,
        [0x55u8; 32],
        0,
    );

    let stub = StubRpcServer::start().await;
    stub.set("eth_blockNumber", serde_json::Value::String("0x46".into()));
    stub.set("eth_getLogs", serde_json::Value::Array(vec![deposit_log]));
    stub.set(
        "eth_call",
        serde_json::Value::String(format!("0x{}", "00".repeat(32))),
    );
    stub.set("eth_getBlockByNumber", stub_block(65, 0xab, 0xaa));

    let rpc = JsonRpc::new(&stub.url);
    let cfg = base_config(vault_addr);

    let o = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(o.error.is_none(), "tick must succeed: {:?}", o.error);
    stub.shutdown();

    let count = fx.db.count(CountTable::VaultTransferEvents).await.unwrap();
    assert_eq!(
        count, 1,
        "vault_transfer_events must have one row after ERC-4626 Deposit event"
    );

    let row: (String,) =
        sqlx::query_as("SELECT direction FROM vault_transfer_events WHERE chain_id = $1")
            .bind(8453i64)
            .fetch_one(fx.db.pool())
            .await
            .unwrap();
    assert_eq!(row.0, "deposit");
}

/// Regression for issue #989: a single ERC-4626 Withdraw log must persist BOTH a
/// vault_transfer_events row with direction='withdrawal' (the table the watchdog
/// burn-volume circuit breaker reads) AND the owner's account_history_events
/// withdrawal row. Previously two `topic0 == erc4626_withdraw` branches existed;
/// the first returned early, making the vault_transfer_events writer dead code and
/// stranding the burn alarm. The branches are now merged into one writer.
#[tokio::test]
async fn erc4626_withdraw_writes_both_transfer_and_history_rows() {
    let fx = pg_fixture().await;

    let vault_addr = Address::from([0xAAu8; 20]);
    let caller = Address::from([0x33u8; 20]);
    let receiver = Address::from([0x44u8; 20]);
    let owner = Address::from([0x55u8; 20]);

    let withdraw_log = encode_erc4626_withdraw_log(
        vault_addr,
        caller,
        receiver,
        owner,
        U256::from(2_000_000u64),
        U256::from(2_000_000u64),
        50u64,
        [0x66u8; 32],
        0,
    );

    let stub = StubRpcServer::start().await;
    stub.set("eth_blockNumber", serde_json::Value::String("0x46".into()));
    stub.set("eth_getLogs", serde_json::Value::Array(vec![withdraw_log]));
    stub.set(
        "eth_call",
        serde_json::Value::String(format!("0x{}", "00".repeat(32))),
    );
    stub.set("eth_getBlockByNumber", stub_block(65, 0xab, 0xaa));

    let rpc = JsonRpc::new(&stub.url);
    let cfg = base_config(vault_addr);

    let o = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(o.error.is_none(), "tick must succeed: {:?}", o.error);
    stub.shutdown();

    // Exactly one vault_transfer_events row with direction='withdrawal'.
    let transfer_count = fx.db.count(CountTable::VaultTransferEvents).await.unwrap();
    assert_eq!(
        transfer_count, 1,
        "exactly one vault_transfer_events row expected after ERC-4626 Withdraw"
    );
    let transfer_row: (String,) =
        sqlx::query_as("SELECT direction FROM vault_transfer_events WHERE chain_id = $1")
            .bind(8453i64)
            .fetch_one(fx.db.pool())
            .await
            .unwrap();
    assert_eq!(
        transfer_row.0, "withdrawal",
        "vault_transfer_events.direction must be 'withdrawal' (feeds watchdog burn alarm)"
    );

    // The owner's account_history_events withdrawal row is still written (no regression).
    let history_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM account_history_events \
         WHERE chain_id = $1 AND kind = 'withdrawal'",
    )
    .bind(8453i64)
    .fetch_one(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        history_count, 1,
        "owner's account_history_events withdrawal row must still be written"
    );
}

/// Structural guard for issue #989: `handle_log` must contain exactly one branch
/// keyed on `topics.erc4626_withdraw`. A second branch is unreachable (the first
/// returns early), which is the defect that stranded the watchdog burn alarm.
/// This test fails if a duplicate branch is ever reintroduced. Runs without a DB.
#[test]
fn handle_log_has_single_erc4626_withdraw_branch() {
    let src = include_str!("../src/indexer.rs");
    let matches = src.matches("topic0 == topics.erc4626_withdraw").count();
    assert_eq!(
        matches, 1,
        "expected exactly one `topic0 == topics.erc4626_withdraw` branch in handle_log, \
         found {matches}; a duplicate branch is unreachable and strands the watchdog burn alarm"
    );
}

// ── Exclusion records (QA plan X7, core issue 1820) ─────────────────────────

/// One canned `eth_getLogs` entry for `log_data` emitted by `address`.
fn log_json(
    address: Address,
    log_data: &alloy_primitives::LogData,
    block_number: u64,
    tx_hash: [u8; 32],
    log_index: u32,
) -> serde_json::Value {
    let topics: Vec<String> = log_data
        .topics()
        .iter()
        .map(|t| format!("{:#x}", t))
        .collect();
    serde_json::json!({
        "address":          format!("{:#x}", address),
        "topics":           topics,
        "data":             format!("0x{}", hex::encode(log_data.data.as_ref())),
        "blockNumber":      format!("0x{:x}", block_number),
        "blockHash":        format!("0x{}", hex::encode([0xabu8; 32])),
        "transactionHash":  format!("0x{}", hex::encode(tx_hash)),
        "transactionIndex": "0x0",
        "logIndex":         format!("0x{:x}", log_index),
    })
}

/// `(holder, balance_at, block_number)` of every stored snapshot balance, by holder.
async fn exclusion_balances(pool: &sqlx::PgPool) -> Vec<(Vec<u8>, String, i64)> {
    sqlx::query_as(
        "SELECT holder, CAST(balance_at AS text), block_number \
         FROM exclusion_holder_balances WHERE chain_id = $1 ORDER BY holder",
    )
    .bind(8453i64)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// Rows of `table` on chain 8453. `table` is a literal from the test, never input.
async fn table_count(pool: &sqlx::PgPool, table: &str) -> i64 {
    let q = format!("SELECT COUNT(*)::BIGINT FROM {table} WHERE chain_id = 8453");
    sqlx::query_scalar(&q).fetch_one(pool).await.unwrap()
}

/// A vault's exclusion record, end to end through `run_once`.
///
/// Two depositors hold the vault's shares when the ExclusionLedger opens record 1 (block 55). A
/// third holder got its shares by a plain transfer, which `wallet_positions` does not follow; it
/// shows up when it claims (block 60). The indexer stores the record, the credit, the claim and the
/// close, and reads every holder's `balanceAt` from the ledger: the two depositors when the record
/// opens, the transferee when it claims. An `ExclusionOpened` from an address that is not the
/// ledger of a watched vault writes nothing.
///
/// A reorg to block 56 then drops the credit, the claim, the close and the transferee's balance,
/// and keeps the record and the two balances read at its block.
#[tokio::test]
async fn exclusion_record_events_store_each_snapshot_holders_balance() {
    use alloy_sol_types::{SolCall as _, SolEvent as _};
    use explorer_indexer::abi::{IExclusionLedgerEvents, IExclusionLedgerReads};
    use explorer_indexer::indexer::exclusion_ledger_of;
    use std::sync::Arc;

    let fx = pg_fixture().await;

    let vault_addr = Address::from([0xAAu8; 20]);
    let ledger = exclusion_ledger_of(vault_addr);
    let impostor = Address::from([0x77u8; 20]);
    let adapter = Address::from([0xADu8; 20]);
    let holder_a = Address::from([0x0Au8; 20]);
    let holder_b = Address::from([0x0Bu8; 20]);
    let holder_c = Address::from([0x0Cu8; 20]);
    let id = U256::from(1u64);

    let opened = IExclusionLedgerEvents::ExclusionOpened {
        exclusionId: id,
        adapterIndex: U256::from(2u64),
        adapter,
        snapshotSupply: U256::from(1_000u64),
        adapterValue: U256::from(500u64),
    }
    .encode_log_data();
    let spoofed = IExclusionLedgerEvents::ExclusionOpened {
        exclusionId: U256::from(9u64),
        adapterIndex: U256::from(0u64),
        adapter,
        snapshotSupply: U256::from(1u64),
        adapterValue: U256::ZERO,
    }
    .encode_log_data();
    let credited = IExclusionLedgerEvents::ExclusionRecoveryCredited {
        exclusionId: id,
        source: 2, // AdminRebalance
        amount: U256::from(300u64),
        recoveredUsdc: U256::from(300u64),
    }
    .encode_log_data();
    let claimed = IExclusionLedgerEvents::ExclusionClaimed {
        exclusionId: id,
        holder: holder_c,
        amount: U256::from(30u64),
    }
    .encode_log_data();
    let finalized = IExclusionLedgerEvents::ExclusionFinalized {
        exclusionId: id,
        reason: 1, // Removed
        recoveredUsdc: U256::from(300u64),
    }
    .encode_log_data();

    let logs = vec![
        encode_erc4626_deposit_log(
            vault_addr,
            holder_a,
            holder_a,
            U256::from(600u64),
            U256::from(600u64),
            50,
            [0x50u8; 32],
            0,
        ),
        encode_erc4626_deposit_log(
            vault_addr,
            holder_b,
            holder_b,
            U256::from(400u64),
            U256::from(400u64),
            51,
            [0x51u8; 32],
            0,
        ),
        log_json(ledger, &opened, 55, [0x55u8; 32], 3),
        log_json(impostor, &spoofed, 56, [0x56u8; 32], 0),
        log_json(ledger, &credited, 57, [0x57u8; 32], 1),
        log_json(ledger, &claimed, 60, [0x60u8; 32], 0),
        log_json(ledger, &finalized, 62, [0x62u8; 32], 0),
    ];

    // `balanceAt(holder, 1)` on the ledger: a 600, b 300 (b moved 100 to c before the snapshot),
    // c 100. Every other read (the vault's snapshot reads) answers zero.
    let ledger_hex = format!("{:#x}", ledger);
    let selector = format!(
        "0x{}",
        hex::encode(IExclusionLedgerReads::balanceAtCall::SELECTOR)
    );
    let word = |v: u64| format!("0x{}", hex::encode(U256::from(v).to_be_bytes::<32>()));
    let stub = StubRpcServer::start().await;
    stub.set("eth_blockNumber", serde_json::Value::String("0x46".into()));
    stub.set("eth_getLogs", serde_json::Value::Array(logs));
    stub.set("eth_getBlockByNumber", stub_block(65, 0xab, 0xaa));
    stub.set_call_hook(Arc::new(move |to: &str, data: &str| {
        if to != ledger_hex || !data.starts_with(&selector) {
            return Ok(word(0));
        }
        // The holder is the low 20 bytes of the first argument word.
        let holder = data.get(34..74).unwrap_or_default();
        let balance = if holder == hex::encode(holder_a.as_slice()) {
            600
        } else if holder == hex::encode(holder_b.as_slice()) {
            300
        } else if holder == hex::encode(holder_c.as_slice()) {
            100
        } else {
            0
        };
        Ok(word(balance))
    }));

    let rpc = JsonRpc::new(&stub.url);
    let cfg = base_config(vault_addr);
    let o = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(o.error.is_none(), "tick must succeed: {:?}", o.error);

    let ledger_calls = stub
        .captured_requests()
        .into_iter()
        .filter(|r| {
            r["method"] == "eth_call"
                && r["params"][0]["to"].as_str().map(str::to_lowercase)
                    == Some(format!("{:#x}", ledger))
        })
        .count();
    stub.shutdown();
    assert_eq!(
        ledger_calls, 3,
        "balanceAt is read for the two depositors at the snapshot and the transferee at its claim"
    );

    let records: Vec<(Vec<u8>, i64, Vec<u8>, i64, String, i64)> = sqlx::query_as(
        "SELECT ledger_address, exclusion_id, vault_address, adapter_index, \
                CAST(snapshot_supply AS text), block_number \
         FROM exclusion_records WHERE chain_id = $1",
    )
    .bind(8453i64)
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        records,
        vec![(
            ledger.to_vec(),
            1,
            vault_addr.to_vec(),
            2,
            "1000".to_string(),
            55
        )],
        "one record, from the vault's ledger; the impostor's event is ignored"
    );

    let pool = fx.db.pool();
    assert_eq!(
        exclusion_balances(pool).await,
        vec![
            (holder_a.to_vec(), "600".to_string(), 55),
            (holder_b.to_vec(), "300".to_string(), 55),
            (holder_c.to_vec(), "100".to_string(), 60),
        ]
    );

    assert_eq!(table_count(pool, "exclusion_recoveries").await, 1);
    assert_eq!(table_count(pool, "exclusion_claims").await, 1);
    assert_eq!(table_count(pool, "exclusion_finalizations").await, 1);

    // A reorg to block 56 orphans the credit, the claim and the close.
    fx.db.delete_above_block(8453, 56).await.unwrap();
    assert_eq!(table_count(pool, "exclusion_records").await, 1);
    assert_eq!(table_count(pool, "exclusion_recoveries").await, 0);
    assert_eq!(table_count(pool, "exclusion_claims").await, 0);
    assert_eq!(table_count(pool, "exclusion_finalizations").await, 0);
    assert_eq!(
        exclusion_balances(pool).await,
        vec![
            (holder_a.to_vec(), "600".to_string(), 55),
            (holder_b.to_vec(), "300".to_string(), 55),
        ],
        "the transferee's balance was read at its orphaned claim and goes with it"
    );
}

/// `exclusion_ledger_of` derives the ledger as the vault's first CREATE (nonce 1). That holds only
/// while `new ExclusionLedger(...)` is the only contract `RobotMoneyVault` ever creates: a creation
/// before it in the constructor (or in a state-variable initializer, which runs first) moves the
/// ledger to nonce 2, and the indexer would watch an empty address and miss every exclusion record
/// with no error. This reads the Solidity source and fails on any other `new <Contract>(`. Its bases
/// (OpenZeppelin's ERC4626 and ReentrancyGuard, and `AdminFloorAccessControlCounter` over
/// OpenZeppelin's AccessControl) create nothing. Runs without a DB.
#[test]
fn exclusion_ledger_is_the_vaults_only_contract_creation() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("contracts")
        .join("RobotMoneyVault.sol");
    let src = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));

    // Drop comments, so NatSpec that mentions `new X(` is not code.
    let mut code = String::new();
    let mut in_block = false;
    for line in src.lines() {
        let mut rest = line;
        let mut kept = String::new();
        loop {
            if in_block {
                match rest.find("*/") {
                    Some(end) => {
                        rest = &rest[end + 2..];
                        in_block = false;
                    }
                    None => break,
                }
            } else {
                let line_comment = rest.find("//");
                let block_comment = rest.find("/*");
                match (line_comment, block_comment) {
                    (Some(l), Some(b)) if b < l => {
                        kept.push_str(&rest[..b]);
                        rest = &rest[b + 2..];
                        in_block = true;
                    }
                    (Some(l), _) => {
                        kept.push_str(&rest[..l]);
                        break;
                    }
                    (None, Some(b)) => {
                        kept.push_str(&rest[..b]);
                        rest = &rest[b + 2..];
                        in_block = true;
                    }
                    (None, None) => {
                        kept.push_str(rest);
                        break;
                    }
                }
            }
        }
        code.push_str(&kept);
        code.push('\n');
    }

    // Every `new <Name>(` whose name starts with a capital letter: a contract creation. Array
    // allocations (`new uint256[](n)`, `new address[](n)`) start lower case.
    let mut created: Vec<(usize, String)> = Vec::new();
    for (at, _) in code.match_indices("new ") {
        let name: String = code[at + 4..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        let boundary = at == 0
            || !code[..at]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
        if boundary
            && name.starts_with(|c: char| c.is_ascii_uppercase())
            && code[at + 4 + name.len()..].trim_start().starts_with('(')
        {
            created.push((at, name));
        }
    }
    assert_eq!(
        created.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>(),
        vec!["ExclusionLedger"],
        "RobotMoneyVault must create exactly one contract, its ExclusionLedger, or \
         `exclusion_ledger_of` (vault CREATE address at nonce 1) no longer finds the ledger"
    );
    let constructor = code
        .find("constructor(")
        .expect("RobotMoneyVault declares a constructor");
    let after_constructor = code[constructor..]
        .find("\n    function ")
        .map(|i| constructor + i)
        .unwrap_or(code.len());
    assert!(
        (constructor..after_constructor).contains(&created[0].0),
        "the ExclusionLedger must be created in the constructor"
    );
}
