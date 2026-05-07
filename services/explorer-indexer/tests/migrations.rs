//! Schema sanity: bring up Postgres in a container, apply migrations,
//! confirm all nine §11 tables exist with `chain_id` and (where
//! applicable) `block_number` columns.
//!
//! Skips cleanly when Docker is not available so contributor laptops
//! without docker still run `cargo test` green.

mod common;

use common::try_pg_fixture;

#[tokio::test]
async fn migrations_create_all_nine_tables() {
    let Some(fx) = try_pg_fixture().await else {
        return;
    };
    for t in [
        "chains",
        "contracts",
        "blocks",
        "transactions",
        "agent_deposits",
        "agent_policies",
        "vault_snapshots",
        "wallet_positions",
        "indexer_runs",
    ] {
        let n = fx.db.count(t).await.expect(t);
        // Nothing inserted yet — just confirms the table exists and
        // the COUNT(*) plan succeeds.
        assert_eq!(n, 0, "table {t} should be empty");
    }
}

#[tokio::test]
async fn every_row_has_chain_id_and_block_number() {
    let Some(fx) = try_pg_fixture().await else {
        return;
    };
    // §11 acceptance criterion: each row carries chain_id and
    // block_number. Verified by interrogating information_schema:
    // every minimum table has a `chain_id` column, and every event
    // / state-snapshot table also has `block_number`.
    let needs_block_number = [
        "blocks",
        "transactions",
        "agent_deposits",
        "agent_policies",
        "vault_snapshots",
        "wallet_positions",
    ];
    let needs_chain_id = [
        "chains",
        "contracts",
        "blocks",
        "transactions",
        "agent_deposits",
        "agent_policies",
        "vault_snapshots",
        "wallet_positions",
        "indexer_runs",
    ];
    for t in needs_chain_id {
        let row: (i64,) = sqlx::query_as(
            "SELECT COUNT(*)::BIGINT FROM information_schema.columns WHERE table_name = $1 AND column_name = 'chain_id'",
        )
        .bind(t)
        .fetch_one(fx.db.pool())
        .await
        .unwrap();
        assert_eq!(row.0, 1, "{t} must have a chain_id column");
    }
    for t in needs_block_number {
        let row: (i64,) = sqlx::query_as(
            "SELECT COUNT(*)::BIGINT FROM information_schema.columns WHERE table_name = $1 AND column_name = 'block_number'",
        )
        .bind(t)
        .fetch_one(fx.db.pool())
        .await
        .unwrap();
        assert_eq!(row.0, 1, "{t} must have a block_number column");
    }
}
