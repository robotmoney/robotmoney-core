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
        gateway: Some(Address::from([0xCCu8; 20])),
        vault,
        registry: None,
        router_governance: None,
        portfolio_router: None,
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

/// One `exclusion_records` row: `(ledger_address, exclusion_id, vault_address, adapter_index,
/// snapshot_supply, block_number)`.
type ExclusionRecordRow = (Vec<u8>, i64, Vec<u8>, i64, String, i64);

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
/// The ledger is where the vault's initializer created it, and the indexer learns it
/// from the vault's `exclusionLedger()` (security round 1). The vault's own CREATE address at
/// nonce 1, which the indexer used to derive, is the impostor here: on a proxy vault it is no
/// ledger at all.
///
/// A reorg to block 56 then drops the credit, the claim, the close and the transferee's balance,
/// and keeps the record and the two balances read at its block.
#[tokio::test]
async fn exclusion_record_events_store_each_snapshot_holders_balance() {
    use alloy_sol_types::{SolCall as _, SolEvent as _};
    use explorer_indexer::abi::{
        IExclusionLedgerEvents, IExclusionLedgerReads, IRobotMoneyVaultReads,
    };
    use std::sync::Arc;

    let fx = pg_fixture().await;

    let vault_addr = Address::from([0xAAu8; 20]);
    let factory = Address::from([0xFAu8; 20]);
    let ledger = factory.create(1);
    let impostor = vault_addr.create(1);
    assert_ne!(ledger, impostor);
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

    // The vault's `exclusionLedger()` names the factory-created ledger. `balanceAt(holder, 1)` on
    // the ledger: a 600, b 300 (b moved 100 to c before the snapshot), c 100. Every other read (the
    // vault's snapshot reads) answers zero.
    let ledger_hex = format!("{:#x}", ledger);
    let vault_hex = format!("{:#x}", vault_addr);
    let selector = format!(
        "0x{}",
        hex::encode(IExclusionLedgerReads::balanceAtCall::SELECTOR)
    );
    let ledger_getter = format!(
        "0x{}",
        hex::encode(IRobotMoneyVaultReads::exclusionLedgerCall::SELECTOR)
    );
    let ledger_word = format!("0x{:0>64}", hex::encode(ledger.as_slice()));
    let word = |v: u64| format!("0x{}", hex::encode(U256::from(v).to_be_bytes::<32>()));
    let stub = StubRpcServer::start().await;
    stub.set("eth_blockNumber", serde_json::Value::String("0x46".into()));
    stub.set("eth_getLogs", serde_json::Value::Array(logs));
    stub.set("eth_getBlockByNumber", stub_block(65, 0xab, 0xaa));
    stub.set_call_hook(Arc::new(move |to: &str, data: &str| {
        if to == vault_hex && data.starts_with(&ledger_getter) {
            return Ok(ledger_word.clone());
        }
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

    let records: Vec<ExclusionRecordRow> = sqlx::query_as(
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
    let mapping: Vec<(Vec<u8>, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT vault_address, ledger_address FROM vault_exclusion_ledgers WHERE chain_id = $1",
    )
    .bind(8453i64)
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        mapping,
        vec![(vault_addr.to_vec(), Some(ledger.to_vec()))],
        "the ledger is stored as the vault's exclusionLedger() named it"
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

/// Security round 2: an exclusion record's snapshot balances are read by a budgeted pass, not all
/// inside the tick that indexes the record.
///
/// Deposits have no minimum and take any receiver, so dust receivers can give a vault a huge
/// depositor history. When a record opened, the tick read `balanceAt` for every owner in that
/// history, one eth_call at a time, and one refused read failed the whole tick, so it started over
/// on every retry. Here 3,000 dust holders hold shares at the snapshot and 500 more exited before
/// it. The read of holder 1,500 is refused once. The tick still succeeds within the pass's budget,
/// the pass goes on from that holder on the next tick, every holder's balance is stored, and no
/// exited owner is ever read.
#[tokio::test]
async fn exclusion_snapshot_balances_are_read_by_a_budgeted_pass() {
    use alloy_sol_types::{SolCall as _, SolEvent as _};
    use explorer_indexer::abi::{IExclusionLedgerEvents, IExclusionLedgerReads};
    use explorer_indexer::indexer::SNAPSHOT_READ_TIME_BUDGET;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    const HOLDERS: i64 = 3_000;
    const EXITED: i64 = 500;
    const REFUSED: i64 = 1_500;

    let fx = pg_fixture().await;
    let chain = 8453i64;
    let vault = Address::from([0xAAu8; 20]);
    let ledger = Address::from([0x1Eu8; 20]);
    fx.db.upsert_chain(chain, "base", "stub").await.unwrap();
    fx.db
        .upsert_contract(chain, vault.into_array(), "vault", None)
        .await
        .unwrap();
    fx.db
        .insert_vault_exclusion_ledger(chain, vault.into_array(), Some(ledger.into_array()), 1)
        .await
        .unwrap();
    // Owner n is the 20-byte address n. Holders 1..=3000 deposited 1 share at block 10; owners
    // 3001..=3500 deposited at block 10 and withdrew everything at block 20.
    sqlx::query(
        "INSERT INTO wallet_positions (chain_id, contract, owner, block_number, shares) \
         SELECT $1, $2, decode(lpad(to_hex(n), 40, '0'), 'hex'), 10, 1 \
           FROM generate_series(1, $3::bigint) n",
    )
    .bind(chain)
    .bind(vault.as_slice())
    .bind(HOLDERS + EXITED)
    .execute(fx.db.pool())
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO wallet_positions (chain_id, contract, owner, block_number, shares) \
         SELECT $1, $2, decode(lpad(to_hex(n), 40, '0'), 'hex'), 20, 0 \
           FROM generate_series($3::bigint, $4::bigint) n",
    )
    .bind(chain)
    .bind(vault.as_slice())
    .bind(HOLDERS + 1)
    .bind(HOLDERS + EXITED)
    .execute(fx.db.pool())
    .await
    .unwrap();

    let opened = IExclusionLedgerEvents::ExclusionOpened {
        exclusionId: U256::from(1u64),
        adapterIndex: U256::from(1u64),
        adapter: Address::from([0xADu8; 20]),
        snapshotSupply: U256::from(HOLDERS as u64),
        adapterValue: U256::from(500u64),
    }
    .encode_log_data();

    let ledger_hex = format!("{:#x}", ledger);
    let selector = format!(
        "0x{}",
        hex::encode(IExclusionLedgerReads::balanceAtCall::SELECTOR)
    );
    let one = format!("0x{}", hex::encode(U256::from(1u64).to_be_bytes::<32>()));
    let zero = format!("0x{}", "00".repeat(32));
    let refused_holder = format!("{REFUSED:040x}");
    let refused_once = Arc::new(AtomicBool::new(false));
    let read: Arc<Mutex<Vec<i64>>> = Arc::default();
    let (refused_once_hook, read_hook) = (refused_once.clone(), read.clone());
    let stub = StubRpcServer::start().await;
    stub.honour_log_filter(true);
    stub.set("eth_blockNumber", serde_json::Value::String("0x46".into()));
    stub.set(
        "eth_getLogs",
        serde_json::Value::Array(vec![log_json(ledger, &opened, 55, [0x55u8; 32], 0)]),
    );
    stub.set("eth_getBlockByNumber", stub_block(65, 0xab, 0xaa));
    stub.set_call_hook(Arc::new(move |to: &str, data: &str| {
        if to != ledger_hex || !data.starts_with(&selector) {
            return Ok(zero.clone());
        }
        // The holder is the low 20 bytes of the first argument word.
        let holder = data.get(34..74).unwrap_or_default();
        if holder == refused_holder && !refused_once_hook.swap(true, Ordering::SeqCst) {
            return Err("upstream request timeout".to_string());
        }
        read_hook
            .lock()
            .unwrap()
            .push(i64::from_str_radix(holder, 16).unwrap_or(-1));
        Ok(one.clone())
    }));
    let rpc = JsonRpc::new(&stub.url);
    let cfg = IndexerConfig {
        end_block: None,
        ..base_config(vault)
    };
    let stored = || async {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM exclusion_holder_balances WHERE chain_id = $1",
        )
        .bind(chain)
        .fetch_one(fx.db.pool())
        .await
        .unwrap()
    };

    // The tick that indexes the record: the refused read ends its pass, not the tick.
    let started = std::time::Instant::now();
    let o = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    let elapsed = started.elapsed();
    assert!(
        o.error.is_none(),
        "a refused balance read must not fail the tick: {:?}",
        o.error
    );
    assert!(
        elapsed < SNAPSHOT_READ_TIME_BUDGET + std::time::Duration::from_secs(10),
        "the tick took {elapsed:?}; the snapshot pass's budget is {SNAPSHOT_READ_TIME_BUDGET:?}"
    );
    assert!(
        refused_once.load(Ordering::SeqCst),
        "holder {REFUSED} was asked"
    );
    let first = stored().await;
    assert!(
        first < HOLDERS,
        "the pass stopped at the refused read, {first} of {HOLDERS} stored"
    );

    // Later ticks (one new block each) go on from the refused holder.
    let mut tip = 0x46u64;
    for _ in 0..10 {
        if stored().await == HOLDERS {
            break;
        }
        tip += 1;
        stub.set(
            "eth_blockNumber",
            serde_json::Value::String(format!("0x{tip:x}")),
        );
        let o = run_once(&fx.db, &rpc, &cfg).await.unwrap();
        assert!(o.error.is_none(), "{:?}", o.error);
    }
    stub.shutdown();
    assert_eq!(
        stored().await,
        HOLDERS,
        "every holder's snapshot balance is stored"
    );

    let read = read.lock().unwrap().clone();
    assert!(
        read.iter().all(|&n| (1..=HOLDERS).contains(&n)),
        "an owner who exited before the snapshot is never read"
    );
    let mut distinct = read.clone();
    distinct.sort_unstable();
    distinct.dedup();
    assert_eq!(
        distinct.len(),
        read.len(),
        "a holder whose read succeeded is not read again"
    );
    let done: bool = sqlx::query_scalar(
        "SELECT done FROM exclusion_snapshot_progress WHERE chain_id = $1 AND exclusion_id = 1",
    )
    .bind(chain)
    .fetch_one(fx.db.pool())
    .await
    .unwrap();
    assert!(done, "the snapshot is marked read through");
}

/// Security round 2: a governed upgrade that points a vault at a new ExclusionLedger.
///
/// Under ADR-0014 the way to fix a ledger bug is a vault upgrade whose reinitializer names a new
/// ledger. The indexer read `exclusionLedger()` once and kept the answer for ever, so it went on
/// watching the old ledger and dropped every record of the new one at the emitter gate. A basket
/// vault (a stored "no ledger") that gained a ledger by an upgrade stayed unwatched the same way.
///
/// Vault A was stored with ledger L1, basket vault B with no ledger. In one tick A upgrades (block
/// 55) and its new ledger L2 opens record 1 (block 56) in the same tick, a late record 2 still
/// opens on L1 (block 57), and B upgrades (block 58) and its new ledger L3 opens record 1 (block
/// 59). The node answers `eth_getLogs` by its filter, so L2's and L3's logs come back only if the
/// indexer asks for them. All three records are stored, A keeps L1 and gains L2, B gains L3, and
/// the getter is read once per upgrade, not every tick.
#[tokio::test]
async fn a_vault_upgrade_that_moves_its_ledger_keeps_both_ledgers_indexed() {
    use alloy_sol_types::{SolCall as _, SolEvent as _};
    use explorer_indexer::abi::{
        IExclusionLedgerEvents, IGovernedUpgradeEvents, IRobotMoneyVaultReads,
    };
    use std::sync::Arc;

    let fx = pg_fixture().await;
    let chain = 8453i64;
    fx.db.upsert_chain(chain, "base", "stub").await.unwrap();

    let vault_a = Address::from([0xA1u8; 20]);
    let basket_b = Address::from([0xB2u8; 20]);
    let l1 = Address::from([0x11u8; 20]);
    let l2 = Address::from([0x12u8; 20]);
    let l3 = Address::from([0x13u8; 20]);
    let adapter = Address::from([0xADu8; 20]);

    // B is a registered vault (it is read for a ledger like every watched vault).
    fx.db
        .upsert_contract(chain, basket_b.into_array(), "vault", None)
        .await
        .unwrap();
    fx.db
        .upsert_vault(
            chain,
            basket_b.into_array(),
            "Robot Money Basket",
            "SPECULATIVE",
            U256::ZERO,
            0,
            1,
            1,
            [0x01; 32],
        )
        .await
        .unwrap();
    // What earlier ticks stored: A named L1, B reverted (no ledger).
    fx.db
        .insert_vault_exclusion_ledger(chain, vault_a.into_array(), Some(l1.into_array()), 1)
        .await
        .unwrap();
    fx.db
        .insert_vault_exclusion_ledger(chain, basket_b.into_array(), None, 1)
        .await
        .unwrap();

    let upgraded = IGovernedUpgradeEvents::Upgraded {
        implementation: Address::from([0x99u8; 20]),
    }
    .encode_log_data();
    let opened = |id: u64| {
        IExclusionLedgerEvents::ExclusionOpened {
            exclusionId: U256::from(id),
            adapterIndex: U256::from(1u64),
            adapter,
            snapshotSupply: U256::from(1_000u64),
            adapterValue: U256::from(500u64),
        }
        .encode_log_data()
    };
    let logs = vec![
        log_json(vault_a, &upgraded, 55, [0x55u8; 32], 0),
        log_json(l2, &opened(1), 56, [0x56u8; 32], 0),
        log_json(l1, &opened(2), 57, [0x57u8; 32], 0),
        log_json(basket_b, &upgraded, 58, [0x58u8; 32], 0),
        log_json(l3, &opened(1), 59, [0x59u8; 32], 0),
    ];

    // After the upgrades the getters name L2 (A) and L3 (B). Every other read answers zero.
    let getter = format!(
        "0x{}",
        hex::encode(IRobotMoneyVaultReads::exclusionLedgerCall::SELECTOR)
    );
    let a_hex = format!("{:#x}", vault_a);
    let b_hex = format!("{:#x}", basket_b);
    let word_of = |a: Address| format!("0x{:0>64}", hex::encode(a.as_slice()));
    let (l2_word, l3_word) = (word_of(l2), word_of(l3));
    let getter_hook = getter.clone();
    let stub = StubRpcServer::start().await;
    stub.honour_log_filter(true);
    stub.set("eth_blockNumber", serde_json::Value::String("0x46".into()));
    stub.set("eth_getLogs", serde_json::Value::Array(logs));
    stub.set("eth_getBlockByNumber", stub_block(65, 0xab, 0xaa));
    stub.set_call_hook(Arc::new(move |to: &str, data: &str| {
        if data.starts_with(&getter_hook) && to == a_hex {
            return Ok(l2_word.clone());
        }
        if data.starts_with(&getter_hook) && to == b_hex {
            return Ok(l3_word.clone());
        }
        Ok(format!("0x{}", "00".repeat(32)))
    }));

    let rpc = JsonRpc::new(&stub.url);
    let o = run_once(&fx.db, &rpc, &base_config(vault_a)).await.unwrap();
    assert!(o.error.is_none(), "tick must succeed: {:?}", o.error);
    let getter_reads = stub
        .captured_requests()
        .into_iter()
        .filter(|r| {
            r["method"] == "eth_call"
                && r["params"][0]["data"]
                    .as_str()
                    .is_some_and(|d| d.starts_with(&getter))
        })
        .count();
    stub.shutdown();
    assert_eq!(
        getter_reads, 2,
        "each vault is read again for its upgrade, once; a stored vault is not read every tick"
    );

    let mapping: Vec<(Vec<u8>, Option<Vec<u8>>, i64)> = sqlx::query_as(
        "SELECT vault_address, ledger_address, block_number FROM vault_exclusion_ledgers \
         WHERE chain_id = $1 ORDER BY vault_address, block_number",
    )
    .bind(chain)
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        mapping,
        vec![
            (vault_a.to_vec(), Some(l1.to_vec()), 1),
            (vault_a.to_vec(), Some(l2.to_vec()), 55),
            (basket_b.to_vec(), None, 1),
            (basket_b.to_vec(), Some(l3.to_vec()), 58),
        ],
        "an upgrade adds the new ledger as of its block and keeps the old answer"
    );

    let records: Vec<(Vec<u8>, i64, Vec<u8>)> = sqlx::query_as(
        "SELECT ledger_address, exclusion_id, vault_address FROM exclusion_records \
         WHERE chain_id = $1 ORDER BY ledger_address, exclusion_id",
    )
    .bind(chain)
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        records,
        vec![
            (l1.to_vec(), 2, vault_a.to_vec()),
            (l2.to_vec(), 1, vault_a.to_vec()),
            (l3.to_vec(), 1, basket_b.to_vec()),
        ],
        "the new ledgers' records from the upgrade tick and the old ledger's late record are all indexed"
    );

    // A reorg below the upgrade drops the new answer with it, so a re-index reads the vault again.
    fx.db.delete_above_block(chain, 54).await.unwrap();
    let left: Vec<(Vec<u8>, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT vault_address, ledger_address FROM vault_exclusion_ledgers \
         WHERE chain_id = $1 ORDER BY vault_address, block_number",
    )
    .bind(chain)
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        left,
        vec![
            (vault_a.to_vec(), Some(l1.to_vec())),
            (basket_b.to_vec(), None),
        ]
    );
}

/// The indexer reads each vault's ledger from its `exclusionLedger()` once, stores the answer
/// (`exclusion_ledgers_of`, `vault_exclusion_ledgers`), and reads it again only when the vault
/// emits `Upgraded` or `Initialized` (security rounds 2 and 3). That holds only while (a)
/// `RobotMoneyVault` keeps the external view `exclusionLedger()` (the getter
/// `IRobotMoneyVaultReads` calls), and (b) the only write to the stored ledger is
/// `RobotMoneyVaultOps.createLedger`, which `initialize` calls once and which reverts on a second call. A reinitializer is
/// seen through the `Upgraded` event of its upgrade
/// (`a_vault_upgrade_that_moves_its_ledger_keeps_both_ledgers_indexed`) or, run later by its own
/// timelock operation, through its `Initialized` event
/// (`a_reinitializer_run_after_its_upgrade_moves_the_ledger_and_is_indexed`);
/// a setter callable without an upgrade would move the ledger with no event the indexer follows,
/// and the new ledger's records would be lost with no error. The vault creates no contract itself
/// (the library does, through DELEGATECALL), so no address derived from the vault is a ledger.
///
/// This replaces the guard on the old derivation (the vault's CREATE address at nonce 1), which
/// failed once the ledger's creation moved into the proxy initializer. Runs without a DB.
#[test]
fn exclusion_ledger_is_set_once_by_the_initializer_and_read_from_the_vault() {
    use alloy_sol_types::SolCall as _;
    use explorer_indexer::abi::IRobotMoneyVaultReads;

    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("contracts")
        .join("RobotMoneyVault.sol");
    let src = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));

    // Drop comments, so NatSpec that mentions the ledger is not code.
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
    let squashed: String = code.split_whitespace().collect::<Vec<_>>().join(" ");

    // (a) The getter the indexer calls.
    assert!(
        squashed.contains("function exclusionLedger() external view returns (ExclusionLedger)"),
        "RobotMoneyVault must keep `function exclusionLedger() external view returns \
         (ExclusionLedger)`: the indexer reads the ledger through that getter"
    );
    assert_eq!(
        IRobotMoneyVaultReads::exclusionLedgerCall::SIGNATURE,
        "exclusionLedger()",
        "the indexer's read must name the vault's getter"
    );

    // (b) One write, inside `RobotMoneyVaultOps.createLedger`, of the ledger it created, and one
    // call to it, from `initialize`.
    assert_eq!(
        squashed.matches("RobotMoneyVaultOps.createLedger(").count(),
        1,
        "the vault must call `RobotMoneyVaultOps.createLedger` exactly once (from initialize)"
    );
    assert!(
        !squashed.contains(".ledger = "),
        "RobotMoneyVault must not write the stored ledger itself: only createLedger may"
    );
    let ops_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("contracts")
        .join("lib")
        .join("RobotMoneyVaultOps.sol");
    let ops = std::fs::read_to_string(&ops_path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", ops_path.display()));
    let ops: String = ops
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert_eq!(
        ops.matches("$.ledger = ").count(),
        1,
        "RobotMoneyVaultOps must write the stored ledger exactly once, or the ledger the indexer \
         stored can move under it"
    );
    let create = ops
        .find("function createLedger(")
        .expect("RobotMoneyVaultOps declares createLedger");
    let create_end = ops[create..]
        .find(" function ")
        .map(|i| create + i)
        .unwrap_or(ops.len());
    let write = ops.find("$.ledger = ").unwrap();
    assert!(
        (create..create_end).contains(&write),
        "the one write to the stored ledger must be in createLedger"
    );
    assert!(
        ops[create..create_end].contains("!= address(0)) revert InvalidParam()"),
        "createLedger must be write-once"
    );

    // The vault creates no contract, so no address derived from it is the ledger.
    let mut created: Vec<String> = Vec::new();
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
            created.push(name);
        }
    }
    assert!(
        created.is_empty(),
        "RobotMoneyVault creates {created:?}; only RobotMoneyVaultOps.createLedger may create the ledger"
    );
}

/// Security round 1 (core 1820): how the reply of a vault's `exclusionLedger()` is read. A ledger
/// is stored and watched; a revert (a BasketVault) is a stored "no ledger"; no code or an
/// uninitialized proxy is asked again next tick; a node that cannot answer fails the tick, so the
/// cursor stays and no ledger event of the range is lost. Runs without a DB.
#[test]
fn ledger_read_classifies_each_reply() {
    use alloy_primitives::Bytes;
    use explorer_indexer::indexer::{classify_ledger_read, LedgerRead};
    use explorer_indexer::rpc::RpcError;

    let ledger = Address::from([0x1eu8; 20]);
    let mut word = vec![0u8; 12];
    word.extend_from_slice(ledger.as_slice());
    assert_eq!(
        classify_ledger_read(Ok(Bytes::from(word))).unwrap(),
        LedgerRead::Ledger(ledger)
    );
    // A BasketVault has no getter: the call reverts. Final.
    let revert = RpcError::Server {
        method: "eth_call".into(),
        message: r#"{"code":3,"message":"execution reverted"}"#.into(),
    };
    assert_eq!(
        classify_ledger_read(Err(revert)).unwrap(),
        LedgerRead::NoLedger
    );
    // A word that is not an address is not a RobotMoneyVault either.
    assert_eq!(
        classify_ledger_read(Ok(Bytes::from(vec![0xffu8; 32]))).unwrap(),
        LedgerRead::NoLedger
    );
    // No code at the read block, or an uninitialized proxy: ask again next tick.
    assert_eq!(
        classify_ledger_read(Ok(Bytes::new())).unwrap(),
        LedgerRead::Unknown
    );
    assert_eq!(
        classify_ledger_read(Ok(Bytes::from(vec![0u8; 32]))).unwrap(),
        LedgerRead::Unknown
    );
    // A node that cannot answer fails the tick, so the cursor stays and no ledger event of the
    // range is lost.
    let pruned = RpcError::Server {
        method: "eth_call".into(),
        message: r#"{"code":-32000,"message":"missing trie node"}"#.into(),
    };
    assert!(classify_ledger_read(Err(pruned)).is_err());
    assert!(classify_ledger_read(Err(RpcError::Transport("eth_call: timeout".into()))).is_err());
}

// ── Security round 3: ledger moves and snapshot candidates ─────────────────────

/// `(vault_address, ledger_address, block_number)` of every stored ledger answer, by vault and block.
async fn ledger_rows(pool: &sqlx::PgPool) -> Vec<(Vec<u8>, Option<Vec<u8>>, i64)> {
    sqlx::query_as(
        "SELECT vault_address, ledger_address, block_number FROM vault_exclusion_ledgers \
         WHERE chain_id = $1 ORDER BY vault_address, block_number",
    )
    .bind(8453i64)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// `(ledger_address, exclusion_id, vault_address)` of every stored exclusion record.
async fn record_keys(pool: &sqlx::PgPool) -> Vec<(Vec<u8>, i64, Vec<u8>)> {
    sqlx::query_as(
        "SELECT ledger_address, exclusion_id, vault_address FROM exclusion_records \
         WHERE chain_id = $1 ORDER BY ledger_address, exclusion_id",
    )
    .bind(8453i64)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// The blocks of the `exclusionLedger()` reads the stub answered, in order (`u64::MAX` for a tag).
fn getter_read_blocks(stub: &StubRpcServer) -> Vec<u64> {
    use alloy_sol_types::SolCall as _;
    use explorer_indexer::abi::IRobotMoneyVaultReads;
    let getter = format!(
        "0x{}",
        hex::encode(IRobotMoneyVaultReads::exclusionLedgerCall::SELECTOR)
    );
    stub.captured_requests()
        .into_iter()
        .filter(|r| {
            r["method"] == "eth_call"
                && r["params"][0]["data"]
                    .as_str()
                    .is_some_and(|d| d.starts_with(&getter))
        })
        .map(|r| {
            r["params"][1]
                .as_str()
                .and_then(|b| u64::from_str_radix(b.trim_start_matches("0x"), 16).ok())
                .unwrap_or(u64::MAX)
        })
        .collect()
}

/// An `ExclusionOpened` of record `id`.
fn opened_record(id: u64) -> alloy_primitives::LogData {
    use alloy_sol_types::SolEvent as _;
    explorer_indexer::abi::IExclusionLedgerEvents::ExclusionOpened {
        exclusionId: U256::from(id),
        adapterIndex: U256::from(1u64),
        adapter: Address::from([0xADu8; 20]),
        snapshotSupply: U256::from(1_000u64),
        adapterValue: U256::from(500u64),
    }
    .encode_log_data()
}

/// Security round 3: a reinitializer that a later timelock operation runs moves the vault's
/// ledger, and the indexer follows it.
///
/// `upgrade-proxy` with no `call=` installs an implementation and leaves its reinitializer pending
/// (`GovernedUpgrade`, contract-release-runbooks.md §4.12). A later Safe-scheduled timelock
/// operation runs it, and that transaction emits `Initialized(2)`, not `Upgraded`. The indexer
/// re-read `exclusionLedger()` only on `Upgraded`, at the safe head: the upgrade's tick read the
/// old ledger (already known), and the reinitializer's tick read nothing. It kept watching L1 and
/// dropped every record of L2 at the emitter gate, with no error.
///
/// An indexer live before the move stored L1. Tick 1 (to block 58) holds the upgrade at 55, after
/// which the getter still names L1. Tick 2 (to block 65) holds the reinitializer at 60, which
/// moves the vault to L2, and L2 opens record 1 at 61. L2 is stored as of 60, read at that block,
/// and its record is indexed.
#[tokio::test]
async fn a_reinitializer_run_after_its_upgrade_moves_the_ledger_and_is_indexed() {
    use alloy_sol_types::SolEvent as _;
    use explorer_indexer::abi::IGovernedUpgradeEvents;
    use std::sync::Arc;

    const UPGRADE: u64 = 55;
    const REINIT: u64 = 60;

    let fx = pg_fixture().await;
    let chain = 8453i64;
    fx.db.upsert_chain(chain, "base", "stub").await.unwrap();
    let vault = Address::from([0xA1u8; 20]);
    let l1 = Address::from([0x11u8; 20]);
    let l2 = Address::from([0x12u8; 20]);
    fx.db
        .insert_vault_exclusion_ledger(chain, vault.into_array(), Some(l1.into_array()), 1)
        .await
        .unwrap();

    let upgraded = IGovernedUpgradeEvents::Upgraded {
        implementation: Address::from([0x99u8; 20]),
    }
    .encode_log_data();
    let reinitialized = IGovernedUpgradeEvents::Initialized { version: 2 }.encode_log_data();
    let logs = vec![
        log_json(vault, &upgraded, UPGRADE, [0x55u8; 32], 0),
        log_json(vault, &reinitialized, REINIT, [0x60u8; 32], 0),
        log_json(l2, &opened_record(1), REINIT + 1, [0x61u8; 32], 0),
    ];

    let getter = format!(
        "0x{}",
        hex::encode(
            <explorer_indexer::abi::IRobotMoneyVaultReads::exclusionLedgerCall as alloy_sol_types::SolCall>::SELECTOR
        )
    );
    let vault_hex = format!("{:#x}", vault);
    let word_of = |a: Address| format!("0x{:0>64}", hex::encode(a.as_slice()));
    let (l1_word, l2_word) = (word_of(l1), word_of(l2));
    let stub = StubRpcServer::start().await;
    stub.honour_log_filter(true);
    stub.set("eth_blockNumber", serde_json::Value::String("0x46".into()));
    stub.set("eth_getLogs", serde_json::Value::Array(logs));
    stub.set("eth_getBlockByNumber", stub_block(65, 0xab, 0xaa));
    stub.set_call_hook_at(Arc::new(move |to: &str, data: &str, block: u64| {
        if to == vault_hex && data.starts_with(&getter) {
            // The reinitializer moved the ledger, not the upgrade.
            return Ok(if block < REINIT {
                l1_word.clone()
            } else {
                l2_word.clone()
            });
        }
        Ok(format!("0x{}", "00".repeat(32)))
    }));
    let rpc = JsonRpc::new(&stub.url);

    // Tick 1: the upgrade alone moves nothing.
    let cfg = IndexerConfig {
        start_block: Some(0),
        end_block: Some(58),
        ..base_config(vault)
    };
    let o = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(o.error.is_none(), "tick 1: {:?}", o.error);
    assert_eq!(
        getter_read_blocks(&stub),
        vec![UPGRADE],
        "the upgrade is read at its own block"
    );
    assert_eq!(
        ledger_rows(fx.db.pool()).await,
        vec![(vault.to_vec(), Some(l1.to_vec()), 1)],
        "an upgrade installed without its reinitializer leaves the vault on L1"
    );

    // Tick 2: the reinitializer's `Initialized` moves the vault to L2.
    let cfg = IndexerConfig {
        start_block: Some(0),
        end_block: Some(65),
        ..base_config(vault)
    };
    let o = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(o.error.is_none(), "tick 2: {:?}", o.error);
    let reads = getter_read_blocks(&stub);
    stub.shutdown();
    assert_eq!(
        reads,
        vec![UPGRADE, REINIT],
        "the reinitializer's Initialized is a re-read trigger, read at its own block"
    );
    assert_eq!(
        ledger_rows(fx.db.pool()).await,
        vec![
            (vault.to_vec(), Some(l1.to_vec()), 1),
            (vault.to_vec(), Some(l2.to_vec()), REINIT as i64),
        ],
        "L2 is stored as of the reinitializer's block, and L1 stays"
    );
    assert_eq!(
        record_keys(fx.db.pool()).await,
        vec![(l2.to_vec(), 1, vault.to_vec())],
        "the new ledger's record is indexed, not dropped at the emitter gate"
    );
}

/// Security round 3: an indexer rebuilt after a ledger move still indexes the old ledger.
///
/// Every `exclusionLedger()` read used to be made at the safe head, which names only the newest
/// ledger. A rebuild from the deploy floor (or an indexer started after the move) stored only L2,
/// the upgrade's re-read named L2 again, and L1's records, recoveries and claims were never
/// fetched. The dapp reads only the vault's current ledger, so the explorer is the one surface for
/// claims on the old one.
///
/// Fresh database. The getter names L1 below the upgrade block U and L2 from U. L1 opens record 1
/// before U, the upgrade (with its reinitializer, one transaction) moves the vault at U, and L2
/// opens record 1 after it. Both records are indexed in the first tick. In the next tick a late
/// claim on L1 is indexed too: L1 stays watched.
#[tokio::test]
async fn a_rebuilt_index_learns_the_ledger_a_vault_moved_away_from() {
    use alloy_sol_types::SolEvent as _;
    use explorer_indexer::abi::{IExclusionLedgerEvents, IGovernedUpgradeEvents};
    use std::sync::Arc;

    const U: u64 = 55;

    let fx = pg_fixture().await;
    let vault = Address::from([0xA1u8; 20]);
    let l1 = Address::from([0x11u8; 20]);
    let l2 = Address::from([0x12u8; 20]);
    let holder = Address::from([0x0Au8; 20]);

    let upgraded = IGovernedUpgradeEvents::Upgraded {
        implementation: Address::from([0x99u8; 20]),
    }
    .encode_log_data();
    let reinitialized = IGovernedUpgradeEvents::Initialized { version: 2 }.encode_log_data();
    let claimed = IExclusionLedgerEvents::ExclusionClaimed {
        exclusionId: U256::from(1u64),
        holder,
        amount: U256::from(30u64),
    }
    .encode_log_data();
    let logs = vec![
        log_json(l1, &opened_record(1), 50, [0x50u8; 32], 0),
        log_json(vault, &upgraded, U, [0x55u8; 32], 0),
        log_json(vault, &reinitialized, U, [0x55u8; 32], 1),
        log_json(l2, &opened_record(1), 56, [0x56u8; 32], 0),
        log_json(l1, &claimed, 68, [0x68u8; 32], 0),
    ];

    let getter = format!(
        "0x{}",
        hex::encode(
            <explorer_indexer::abi::IRobotMoneyVaultReads::exclusionLedgerCall as alloy_sol_types::SolCall>::SELECTOR
        )
    );
    let vault_hex = format!("{:#x}", vault);
    let word_of = |a: Address| format!("0x{:0>64}", hex::encode(a.as_slice()));
    let (l1_word, l2_word) = (word_of(l1), word_of(l2));
    let stub = StubRpcServer::start().await;
    stub.honour_log_filter(true);
    stub.set("eth_blockNumber", serde_json::Value::String("0x46".into()));
    stub.set("eth_getLogs", serde_json::Value::Array(logs));
    stub.set("eth_getBlockByNumber", stub_block(65, 0xab, 0xaa));
    stub.set_call_hook_at(Arc::new(move |to: &str, data: &str, block: u64| {
        if to == vault_hex && data.starts_with(&getter) {
            return Ok(if block < U {
                l1_word.clone()
            } else {
                l2_word.clone()
            });
        }
        Ok(format!("0x{}", "00".repeat(32)))
    }));
    let rpc = JsonRpc::new(&stub.url);

    let cfg = IndexerConfig {
        start_block: Some(0),
        end_block: Some(65),
        ..base_config(vault)
    };
    let o = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(o.error.is_none(), "tick 1: {:?}", o.error);
    assert_eq!(
        ledger_rows(fx.db.pool()).await,
        vec![
            (vault.to_vec(), Some(l1.to_vec()), 0),
            (vault.to_vec(), Some(l2.to_vec()), U as i64),
        ],
        "the first read, at the range's first block, names L1; the upgrade's names L2"
    );
    assert_eq!(
        record_keys(fx.db.pool()).await,
        vec![
            (l1.to_vec(), 1, vault.to_vec()),
            (l2.to_vec(), 1, vault.to_vec())
        ],
        "the old ledger's record from before the move is indexed, and the new one's"
    );

    // The next tick: a late claim on L1. L1 is still in the filter, and the claim is stored.
    stub.set("eth_blockNumber", serde_json::Value::String("0x4b".into()));
    let cfg = IndexerConfig {
        start_block: Some(0),
        end_block: Some(70),
        ..base_config(vault)
    };
    let o = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(o.error.is_none(), "tick 2: {:?}", o.error);
    let last_filter = stub
        .captured_requests()
        .into_iter()
        .rfind(|r| r["method"] == "eth_getLogs")
        .expect("tick 2 asked for logs");
    stub.shutdown();
    let watched: Vec<String> = last_filter["params"][0]["address"]
        .as_array()
        .expect("address filter must be an array")
        .iter()
        .map(|a| a.as_str().unwrap().to_lowercase())
        .collect();
    assert!(
        watched.contains(&format!("{:#x}", l1)) && watched.contains(&format!("{:#x}", l2)),
        "both ledgers stay watched: {watched:?}"
    );
    assert_eq!(
        table_count(fx.db.pool(), "exclusion_claims").await,
        1,
        "a late claim on the old ledger is indexed"
    );
}

/// Security round 3: on a node that keeps no old state, the ledger read falls back to the safe
/// head, and the tick still succeeds.
///
/// Reading `exclusionLedger()` at the range's own block needs that block's state. A pruned,
/// non-archive node answers `missing trie node` for it. Failing the tick there would wedge every
/// deployment on such a node, so the read is made at the safe head instead, which every node holds.
/// That answer names the newest ledger, as before round 3, and its records are indexed.
#[tokio::test]
async fn a_node_without_old_state_reads_the_ledger_at_the_safe_head() {
    use alloy_sol_types::SolEvent as _;
    use explorer_indexer::abi::IGovernedUpgradeEvents;
    use std::sync::Arc;

    const SAFE_HEAD: u64 = 65;

    let fx = pg_fixture().await;
    let vault = Address::from([0xA1u8; 20]);
    let l2 = Address::from([0x12u8; 20]);
    let upgraded = IGovernedUpgradeEvents::Upgraded {
        implementation: Address::from([0x99u8; 20]),
    }
    .encode_log_data();
    let logs = vec![
        log_json(vault, &upgraded, 55, [0x55u8; 32], 0),
        log_json(l2, &opened_record(1), 56, [0x56u8; 32], 0),
    ];

    let getter = format!(
        "0x{}",
        hex::encode(
            <explorer_indexer::abi::IRobotMoneyVaultReads::exclusionLedgerCall as alloy_sol_types::SolCall>::SELECTOR
        )
    );
    let vault_hex = format!("{:#x}", vault);
    let l2_word = format!("0x{:0>64}", hex::encode(l2.as_slice()));
    let stub = StubRpcServer::start().await;
    stub.honour_log_filter(true);
    stub.set("eth_blockNumber", serde_json::Value::String("0x46".into()));
    stub.set("eth_getLogs", serde_json::Value::Array(logs));
    stub.set("eth_getBlockByNumber", stub_block(65, 0xab, 0xaa));
    stub.set_call_hook_at(Arc::new(move |to: &str, data: &str, block: u64| {
        if to == vault_hex && data.starts_with(&getter) {
            return if block == SAFE_HEAD {
                Ok(l2_word.clone())
            } else {
                Err(format!("missing trie node 0xabc (block {block})"))
            };
        }
        Ok(format!("0x{}", "00".repeat(32)))
    }));
    let rpc = JsonRpc::new(&stub.url);

    let cfg = IndexerConfig {
        start_block: Some(0),
        ..base_config(vault)
    };
    let o = run_once(&fx.db, &rpc, &cfg).await.unwrap();
    assert!(
        o.error.is_none(),
        "a node without old state must not fail the tick: {:?}",
        o.error
    );
    let reads = getter_read_blocks(&stub);
    stub.shutdown();
    assert_eq!(
        reads,
        vec![0, SAFE_HEAD, 55, SAFE_HEAD],
        "each read at an old block falls back to the safe head"
    );
    assert_eq!(
        ledger_rows(fx.db.pool()).await,
        vec![(vault.to_vec(), Some(l2.to_vec()), SAFE_HEAD as i64)],
        "the safe head's answer is stored as of the block it was read at"
    );
    assert_eq!(
        record_keys(fx.db.pool()).await,
        vec![(l2.to_vec(), 1, vault.to_vec())]
    );
}

/// Security round 3: a holder who redeems everything in the record's own block, after the record
/// opens, keeps its snapshot balance in the explorer.
///
/// The snapshot pass took as candidates the owners whose latest `wallet_positions` row at or below
/// the record's block held shares. A block's row is the balance after every log of the block, while
/// `ExclusionLedger.checkpoint` keeps the pre-change balance, so `balanceAt` still holds the
/// holder's shares. The holder's zero row ruled it out, the pass marked the record done, and
/// `/v1/accounts/:address/exclusion-claims` showed nothing until the holder claimed on chain.
///
/// G and H deposit at block 45. At block 55 the record opens, then H redeems all its shares and D
/// makes its first deposit. The pass must read G, H and D, store G's 50 and H's 100, store nothing
/// for D (`balanceAt` zero: it deposited after the snapshot), and mark the record done.
#[tokio::test]
async fn a_holder_who_exits_in_the_records_own_block_keeps_its_snapshot_balance() {
    use alloy_sol_types::SolCall as _;
    use explorer_indexer::abi::{IExclusionLedgerReads, IRobotMoneyVaultReads};
    use std::sync::Arc;

    let fx = pg_fixture().await;
    let vault = Address::from([0xAAu8; 20]);
    let ledger = Address::from([0x1Eu8; 20]);
    let holder_g = Address::from([0x06u8; 20]);
    let holder_h = Address::from([0x08u8; 20]);
    let holder_d = Address::from([0x0Du8; 20]);

    let logs = vec![
        encode_erc4626_deposit_log(
            vault,
            holder_g,
            holder_g,
            U256::from(50u64),
            U256::from(50u64),
            45,
            [0x45u8; 32],
            0,
        ),
        encode_erc4626_deposit_log(
            vault,
            holder_h,
            holder_h,
            U256::from(100u64),
            U256::from(100u64),
            45,
            [0x46u8; 32],
            1,
        ),
        // The record opens first in block 55 ...
        log_json(ledger, &opened_record(1), 55, [0x55u8; 32], 0),
        // ... then H redeems everything and D deposits for the first time, in the same block.
        encode_erc4626_withdraw_log(
            vault,
            holder_h,
            holder_h,
            holder_h,
            U256::from(100u64),
            U256::from(100u64),
            55,
            [0x56u8; 32],
            1,
        ),
        encode_erc4626_deposit_log(
            vault,
            holder_d,
            holder_d,
            U256::from(30u64),
            U256::from(30u64),
            55,
            [0x57u8; 32],
            2,
        ),
    ];

    let ledger_hex = format!("{:#x}", ledger);
    let vault_hex = format!("{:#x}", vault);
    let getter = format!(
        "0x{}",
        hex::encode(IRobotMoneyVaultReads::exclusionLedgerCall::SELECTOR)
    );
    let balance_at = format!(
        "0x{}",
        hex::encode(IExclusionLedgerReads::balanceAtCall::SELECTOR)
    );
    let ledger_word = format!("0x{:0>64}", hex::encode(ledger.as_slice()));
    let word = |v: u64| format!("0x{}", hex::encode(U256::from(v).to_be_bytes::<32>()));
    let (g_hex, h_hex) = (
        hex::encode(holder_g.as_slice()),
        hex::encode(holder_h.as_slice()),
    );
    let read: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let read_hook = read.clone();
    let stub = StubRpcServer::start().await;
    stub.set("eth_blockNumber", serde_json::Value::String("0x46".into()));
    stub.set("eth_getLogs", serde_json::Value::Array(logs));
    stub.set("eth_getBlockByNumber", stub_block(65, 0xab, 0xaa));
    stub.set_call_hook(Arc::new(move |to: &str, data: &str| {
        if to == vault_hex && data.starts_with(&getter) {
            return Ok(ledger_word.clone());
        }
        if to != ledger_hex || !data.starts_with(&balance_at) {
            return Ok(word(0));
        }
        // The holder is the low 20 bytes of the first argument word. The ledger's checkpoint keeps
        // the balance at the record: G 50, H 100 (its exit came after), D 0 (it came after).
        let holder = data.get(34..74).unwrap_or_default().to_string();
        read_hook.lock().unwrap().push(holder.clone());
        Ok(word(if holder == g_hex {
            50
        } else if holder == h_hex {
            100
        } else {
            0
        }))
    }));
    let rpc = JsonRpc::new(&stub.url);
    let o = run_once(&fx.db, &rpc, &base_config(vault)).await.unwrap();
    stub.shutdown();
    assert!(o.error.is_none(), "tick must succeed: {:?}", o.error);

    let positions: Vec<(Vec<u8>, i64, String)> = sqlx::query_as(
        "SELECT owner, block_number, CAST(shares AS text) FROM wallet_positions \
         WHERE chain_id = $1 AND owner = $2 ORDER BY block_number",
    )
    .bind(8453i64)
    .bind(holder_h.as_slice())
    .fetch_all(fx.db.pool())
    .await
    .unwrap();
    assert_eq!(
        positions,
        vec![
            (holder_h.to_vec(), 45, "100".to_string()),
            (holder_h.to_vec(), 55, "0".to_string()),
        ],
        "setup: H's row in the record's block is zero"
    );

    let mut asked = read.lock().unwrap().clone();
    asked.sort();
    let mut expected = vec![
        hex::encode(holder_g.as_slice()),
        hex::encode(holder_h.as_slice()),
        hex::encode(holder_d.as_slice()),
    ];
    expected.sort();
    assert_eq!(asked, expected, "G, H and D are each read once");

    assert_eq!(
        exclusion_balances(fx.db.pool()).await,
        vec![
            (holder_g.to_vec(), "50".to_string(), 55),
            (holder_h.to_vec(), "100".to_string(), 55),
        ],
        "H keeps its pre-exit snapshot balance; D's zero is not stored"
    );
    let done: bool = sqlx::query_scalar(
        "SELECT done FROM exclusion_snapshot_progress WHERE chain_id = $1 AND exclusion_id = 1",
    )
    .bind(8453i64)
    .fetch_one(fx.db.pool())
    .await
    .unwrap();
    assert!(done, "the pass reports the record read through");
}
