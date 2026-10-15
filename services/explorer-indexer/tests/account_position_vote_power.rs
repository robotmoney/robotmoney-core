//! Integration tests for issue #1022 (IDX-3): account-position accounting in
//! the explorer indexer.
//!
//! - **IDX-3** — `insert_wallet_position` had zero call sites, so the
//!   `wallet_positions` table (which backs the `account_positions` view / the
//!   per-account positions API read) was always empty. The ERC-4626
//!   `Deposit`/`Withdraw` handler branches now roll the owner's resulting share
//!   balance forward into `wallet_positions`. These tests drive a synthetic
//!   `Deposit` (then `Withdraw`) through `handle_log` and assert the resulting
//!   balance row.
//!
//! The file name keeps the IDX-5 vote-power half it used to carry because CI
//! selects it by name. That half was deleted with `RouterGovernance` voting
//! (issue #1698): there is no vote and no tally to index.
//!
//! Canonical: docs/code-review/20260619-code-review-internal-claude-scan-verification.md (IDX-3),
//!            services/explorer-indexer/src/scan_residual_seams.rs §B1.

mod common;

use alloy_primitives::{Address, Bytes, B256, U256};
use bigdecimal::BigDecimal;
use common::pg_fixture;
use explorer_indexer::abi::{IVaultEvents, Topics};
use explorer_indexer::indexer::{handle_log, IndexerConfig};
use explorer_indexer::rpc::LogEntry;

const CHAIN: i64 = 8453;

/// An `IndexerConfig` pinned to `vault` as the watched ERC-4626 vault. Only the
/// fields `handle_log` reads (chain_id) matter for the direct-dispatch tests.
fn cfg(vault: Address) -> IndexerConfig {
    IndexerConfig {
        chain_id: CHAIN,
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
        end_block: None,
        feature_flags: 0,
    }
}

/// Build a `LogEntry` for an ERC-4626 `Deposit(caller, owner, assets, shares)`
/// emitted by `vault`.
fn deposit_log(
    vault: Address,
    caller: Address,
    owner: Address,
    assets: U256,
    shares: U256,
    block_number: u64,
    log_index: u32,
) -> LogEntry {
    use alloy_primitives::LogData;
    use alloy_sol_types::SolEvent as _;
    let event = IVaultEvents::Deposit {
        caller,
        owner,
        assets,
        shares,
    };
    let log_data: LogData = event.encode_log_data();
    LogEntry {
        address: vault,
        topics: log_data.topics().to_vec(),
        data: Bytes::copy_from_slice(log_data.data.as_ref()),
        block_number,
        block_hash: B256::from([0xabu8; 32]),
        tx_hash: B256::from([0x11u8; 32]),
        tx_index: 0,
        log_index,
    }
}

/// Build a `LogEntry` for an ERC-4626
/// `Withdraw(caller, receiver, owner, assets, shares)` emitted by `vault`.
#[allow(clippy::too_many_arguments)]
fn withdraw_log(
    vault: Address,
    caller: Address,
    receiver: Address,
    owner: Address,
    assets: U256,
    shares: U256,
    block_number: u64,
    log_index: u32,
) -> LogEntry {
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
    LogEntry {
        address: vault,
        topics: log_data.topics().to_vec(),
        data: Bytes::copy_from_slice(log_data.data.as_ref()),
        block_number,
        block_hash: B256::from([0xcdu8; 32]),
        tx_hash: B256::from([0x22u8; 32]),
        tx_index: 0,
        log_index,
    }
}

// ─── IDX-3 ───────────────────────────────────────────────────────────────────

/// IDX-3: indexing an ERC-4626 `Deposit` populates `wallet_positions` for the
/// owner with the resulting share balance, and a subsequent `Withdraw` rolls
/// the balance back down. Before the fix the writer had no call site, so the
/// table — and the `account_positions` view over it — stayed empty.
#[tokio::test]
async fn deposit_and_withdraw_populate_wallet_positions() {
    let fx = pg_fixture().await;
    let db = &fx.db;
    let vault = Address::from([0xDDu8; 20]);
    let owner = Address::from([0x44u8; 20]);
    let caller = Address::from([0x55u8; 20]);

    db.upsert_chain(CHAIN, "base", "stub").await.unwrap();
    // wallet_positions.contract FKs contracts(chain_id, address).
    db.upsert_contract(CHAIN, vault.into_array(), "vault", None)
        .await
        .unwrap();

    let topics = Topics::new();
    let cfg = cfg(vault);

    // Deposit: mint 1_000 shares to owner at block 100.
    let dep = deposit_log(
        vault,
        caller,
        owner,
        U256::from(2_000u64),
        U256::from(1_000u64),
        100,
        0,
    );
    handle_log(db, &cfg, &topics, &dep).await.unwrap();

    // The view picks the most-recent row per owner; assert the balance is 1_000.
    let bal = position_balance(db, vault, owner).await;
    assert_eq!(
        bal,
        Some(BigDecimal::from(1_000)),
        "wallet_positions must reflect the minted share balance after a Deposit"
    );

    // Withdraw: burn 400 shares from owner at block 105 → balance 600.
    let wd = withdraw_log(
        vault,
        caller,
        owner,
        owner,
        U256::from(800u64),
        U256::from(400u64),
        105,
        0,
    );
    handle_log(db, &cfg, &topics, &wd).await.unwrap();

    let bal = position_balance(db, vault, owner).await;
    assert_eq!(
        bal,
        Some(BigDecimal::from(600)),
        "wallet_positions must roll the balance back down after a Withdraw"
    );
}

/// Read the latest `account_positions` (most-recent `wallet_positions`) share
/// balance for an owner, or `None` if no position row exists.
async fn position_balance(
    db: &explorer_indexer::Db,
    vault: Address,
    owner: Address,
) -> Option<BigDecimal> {
    let row: Option<(BigDecimal,)> = sqlx::query_as(
        "SELECT shares FROM account_positions \
         WHERE chain_id = $1 AND vault_address = $2 AND holder_address = $3",
    )
    .bind(CHAIN)
    .bind(vault.as_slice())
    .bind(owner.as_slice())
    .fetch_optional(db.pool())
    .await
    .unwrap();
    row.map(|(d,)| d)
}
