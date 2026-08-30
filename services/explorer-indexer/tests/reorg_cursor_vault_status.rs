//! Integration tests for issue #1021 (IDX-2 / IDX-8): make the indexer's run
//! cursor and vault status rollback reorg-safe.
//!
//! - **IDX-2** — `delete_above_block(root)` must cap any successful run's
//!   `last_indexed_block` down to `root`, so a reorg that rolls back to `root`
//!   and then fails in the same run leaves the next run resuming at `root + 1`
//!   with no block gap (the failed run row is excluded from the
//!   `error IS NULL` MAX, so without the cap the next `last_indexed_block()`
//!   would still report the pre-reorg cursor).
//! - **IDX-8** — `delete_above_block(root)` must revert an in-place
//!   `vaults.status` change written at a block above `root`, by pruning the
//!   block-numbered `vault_status_events` history and re-deriving the live
//!   `vaults.status` from the surviving event `<= root`.
//!
//! Both assertions are exercised end-to-end through `run_once` as well as at
//! the db layer for deterministic root values.

mod common;

use alloy_primitives::Address;
use common::{try_pg_fixture, StubRpcServer};
use explorer_indexer::db::CountTable;
use explorer_indexer::{indexer::run_once, indexer::IndexerConfig, rpc::JsonRpc};

const CHAIN: i64 = 8453;

/// Minimal stub block JSON for `eth_getBlockByNumber`.
fn stub_block(number: u64, hash: &str, parent_hash: &str, timestamp: u64) -> serde_json::Value {
    serde_json::json!({
        "number":     format!("0x{:x}", number),
        "hash":       hash,
        "parentHash": parent_hash,
        "timestamp":  format!("0x{:x}", timestamp),
        "transactions": []
    })
}

// ─── IDX-2 ───────────────────────────────────────────────────────────────────

/// IDX-2 (db layer): a successful run recorded a cursor above the reorg root.
/// After `delete_above_block(root)`, the durable cursor
/// (`MAX(last_indexed_block) WHERE error IS NULL`) must resolve to `root`, even
/// though a *separate* failed run row still records the (pre-reorg) cursor.
#[tokio::test]
async fn delete_above_block_caps_successful_run_cursor_to_root() {
    let Some(fx) = try_pg_fixture().await else {
        return;
    };
    let db = &fx.db;
    db.upsert_chain(CHAIN, "base", "stub").await.unwrap();

    // A prior successful run advanced the cursor to block 105.
    let run_ok = db.start_run(CHAIN, 100).await.unwrap();
    db.finish_run(run_ok, Some(105), Some(105), 0, 0, None)
        .await
        .unwrap();
    assert_eq!(db.last_indexed_block(CHAIN).await.unwrap(), Some(105));

    // A later run rolls a reorg back to root=100, then fails — recording the
    // pre-reorg cursor on its (error IS NOT NULL) row. This must NOT keep the
    // durable cursor above root.
    let run_fail = db.start_run(CHAIN, 106).await.unwrap();
    db.delete_above_block(CHAIN, 100).await.unwrap();
    db.finish_run(run_fail, None, Some(105), 0, 0, Some("rpc outage"))
        .await
        .unwrap();

    // The durable cursor now reflects the rollback root, so the next run
    // resumes from root + 1 = 101.
    assert_eq!(
        db.last_indexed_block(CHAIN).await.unwrap(),
        Some(100),
        "successful-run cursor must be capped to the reorg root"
    );
}

/// IDX-2 (db layer): a full wipe (`root = -1`) must drop the cursor to NULL so
/// the next run re-indexes from block 0.
#[tokio::test]
async fn delete_above_block_full_wipe_clears_cursor() {
    let Some(fx) = try_pg_fixture().await else {
        return;
    };
    let db = &fx.db;
    db.upsert_chain(CHAIN, "base", "stub").await.unwrap();

    let run_ok = db.start_run(CHAIN, 0).await.unwrap();
    db.finish_run(run_ok, Some(50), Some(50), 0, 0, None)
        .await
        .unwrap();
    assert_eq!(db.last_indexed_block(CHAIN).await.unwrap(), Some(50));

    db.delete_above_block(CHAIN, -1).await.unwrap();

    assert_eq!(
        db.last_indexed_block(CHAIN).await.unwrap(),
        None,
        "full wipe (root=-1) must clear the durable cursor"
    );
}

/// IDX-2 (end-to-end): a reorg rollback followed by a same-run RPC failure must
/// leave the next run resuming at root + 1 with the previously-deleted blocks
/// re-indexed (no silent gap).
///
/// Tick 1 indexes cursor block 105. Tick 2 sees a reorged cursor hash → walks
/// back past 0 (root = -1, full wipe) → `delete_above_block(-1)` → then
/// `eth_blockNumber` is unset so `block_number()` errors *after* the rollback.
/// The next run must restart from block 0 and re-index, not resume above the
/// wiped blocks.
#[tokio::test]
async fn run_once_reorg_then_failure_resumes_from_root() {
    let Some(fx) = try_pg_fixture().await else {
        return;
    };

    let cfg = IndexerConfig {
        chain_id: CHAIN,
        chain_name: "base".into(),
        rpc_label: "stub".into(),
        gateway: Address::from([0xaau8; 20]),
        vault: Address::from([0xbbu8; 20]),
        registry: None,
        router_governance: None,
        portfolio_router: None,
        investment_committee: None,
        consensus_receipt: None,
        max_blocks_per_tick: 200,
        end_block: Some(105),
        feature_flags: 0,
    };

    // ── Tick 1: index cursor block 105 (hash 0xcc…). ──
    let pre = StubRpcServer::start().await;
    pre.set("eth_blockNumber", serde_json::json!("0x6e")); // 110
    pre.set("eth_getLogs", serde_json::Value::Array(Vec::new()));
    pre.set(
        "eth_call",
        serde_json::json!(format!("0x{}", "00".repeat(32))),
    );
    pre.set(
        "eth_getBlockByNumber",
        stub_block(
            105,
            &format!("0x{}", "cc".repeat(32)),
            &format!("0x{}", "bb".repeat(32)),
            1_700_000_000,
        ),
    );
    let rpc1 = JsonRpc::new(&pre.url);
    let o1 = run_once(&fx.db, &rpc1, &cfg).await.unwrap();
    assert!(o1.error.is_none(), "tick 1 must succeed: {:?}", o1.error);
    assert_eq!(o1.last_indexed_block, Some(105));
    // Seed a deletable row above the wipe root to prove re-index.
    fx.db
        .upsert_contract(CHAIN, [0xaau8; 20], "gateway", None)
        .await
        .unwrap();
    fx.db
        .insert_block(CHAIN, 100, [0xa1u8; 32], [0xa0u8; 32], 1_699_000_000)
        .await
        .unwrap();
    pre.shutdown();

    // ── Tick 2: reorged cursor hash + eth_blockNumber unset → fail after rollback. ──
    let post = StubRpcServer::start().await;
    // NOTE: eth_blockNumber intentionally NOT set → null result → decode error,
    // raised by block_number() which runs *after* delete_above_block.
    post.set("eth_getLogs", serde_json::Value::Array(Vec::new()));
    post.set(
        "eth_call",
        serde_json::json!(format!("0x{}", "00".repeat(32))),
    );
    post.set(
        "eth_getBlockByNumber",
        stub_block(
            105,
            &format!("0x{}", "dd".repeat(32)), // new hash ≠ stored 0xcc…
            &format!("0x{}", "ee".repeat(32)),
            1_700_000_100,
        ),
    );
    let rpc2 = JsonRpc::new(&post.url);
    let o2 = run_once(&fx.db, &rpc2, &cfg).await.unwrap();
    assert!(
        o2.error.is_some(),
        "tick 2 must fail after the rollback (block_number errors)"
    );
    // The rolled-back blocks are gone …
    assert_eq!(
        fx.db.get_block_hash(CHAIN, 100).await.unwrap(),
        None,
        "block 100 must be deleted by the reorg rollback"
    );
    // … and the durable cursor dropped to the wipe root (root=-1 → None), so the
    // next run resumes from block 0 rather than above the wiped blocks.
    assert_eq!(
        fx.db.last_indexed_block(CHAIN).await.unwrap(),
        None,
        "durable cursor must reflect the rollback, not the pre-reorg cursor"
    );
    post.shutdown();

    // ── Tick 3: a healthy chain re-indexes from block 0 (no gap). ──
    let heal = StubRpcServer::start().await;
    heal.set("eth_blockNumber", serde_json::json!("0x6e")); // 110
    heal.set("eth_getLogs", serde_json::Value::Array(Vec::new()));
    heal.set(
        "eth_call",
        serde_json::json!(format!("0x{}", "00".repeat(32))),
    );
    heal.set(
        "eth_getBlockByNumber",
        stub_block(
            105,
            &format!("0x{}", "dd".repeat(32)),
            &format!("0x{}", "ee".repeat(32)),
            1_700_000_200,
        ),
    );
    let rpc3 = JsonRpc::new(&heal.url);
    let o3 = run_once(&fx.db, &rpc3, &cfg).await.unwrap();
    assert!(o3.error.is_none(), "tick 3 must succeed: {:?}", o3.error);
    assert_eq!(
        o3.from_block, 0,
        "next run must resume from root + 1 = 0, re-indexing the wiped range"
    );
    assert_eq!(o3.last_indexed_block, Some(105));
    heal.shutdown();
}

// ─── IDX-8 ───────────────────────────────────────────────────────────────────

/// Register a vault at `registered_block` with status 0 (Active).
async fn seed_vault(db: &explorer_indexer::Db, vault: [u8; 20], registered_block: i64) {
    db.upsert_chain(CHAIN, "base", "stub").await.unwrap();
    db.upsert_vault(
        CHAIN,
        vault,
        "Test Vault",
        "balanced",
        alloy_primitives::U256::ZERO,
        0, // Active
        registered_block,
        registered_block,
        [0x01u8; 32],
    )
    .await
    .unwrap();
}

/// Read the live status of a vault.
async fn vault_status(db: &explorer_indexer::Db, vault: [u8; 20]) -> i16 {
    let row: (i16,) =
        sqlx::query_as("SELECT status FROM vaults WHERE chain_id = $1 AND vault_address = $2")
            .bind(CHAIN)
            .bind(&vault[..])
            .fetch_one(db.pool())
            .await
            .unwrap();
    row.0
}

/// IDX-8: a status change written above `root` is reverted by
/// `delete_above_block(root)` — both the live `vaults.status` and the history
/// event roll back.
#[tokio::test]
async fn delete_above_block_reverts_vault_status_above_root() {
    let Some(fx) = try_pg_fixture().await else {
        return;
    };
    let db = &fx.db;
    let vault = [0x11u8; 20];
    seed_vault(db, vault, 50).await;

    // Block 60: Active → Paused (status 1). Block 70: Paused → Retired (2).
    db.update_vault_status(CHAIN, vault, 60, 0, 1, 1_700_000_060)
        .await
        .unwrap();
    db.update_vault_status(CHAIN, vault, 70, 0, 2, 1_700_000_070)
        .await
        .unwrap();
    assert_eq!(vault_status(db, vault).await, 2, "live status is Retired");
    assert_eq!(db.count(CountTable::VaultStatusEvents).await.unwrap(), 2);

    // A reorg rolls back to root=65 → the Retired transition at block 70 is
    // orphaned. Status must revert to Paused (the surviving event at block 60).
    db.delete_above_block(CHAIN, 65).await.unwrap();
    assert_eq!(
        vault_status(db, vault).await,
        1,
        "status must revert to the surviving (block 60) Paused event"
    );
    assert_eq!(
        db.count(CountTable::VaultStatusEvents).await.unwrap(),
        1,
        "the orphaned block-70 status event must be pruned"
    );

    // A deeper reorg (root=55) orphans the block-60 event too → status reverts
    // to the registration default (Active = 0) and history is empty.
    db.delete_above_block(CHAIN, 55).await.unwrap();
    assert_eq!(
        vault_status(db, vault).await,
        0,
        "status must revert to the registration default (Active) when no event survives"
    );
    assert_eq!(db.count(CountTable::VaultStatusEvents).await.unwrap(), 0);
}

/// IDX-8: a vault whose status never changed is untouched by a rollback (the
/// re-derivation must not clobber an unchanged Active vault).
#[tokio::test]
async fn delete_above_block_leaves_unchanged_vault_status() {
    let Some(fx) = try_pg_fixture().await else {
        return;
    };
    let db = &fx.db;
    let vault = [0x22u8; 20];
    seed_vault(db, vault, 10).await;

    db.delete_above_block(CHAIN, 5).await.unwrap();
    assert_eq!(
        vault_status(db, vault).await,
        0,
        "an unchanged vault must remain Active after a rollback"
    );
}
