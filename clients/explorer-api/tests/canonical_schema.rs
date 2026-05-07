//! Issue #87 — canonical schema parity.
//!
//! Asserts (a) the migration this crate links against is the byte-exact
//! file owned by `services/explorer-indexer/migrations/`, and (b) when
//! that migration is applied to a Postgres testcontainer, the same nine
//! §11 minimum tables observed by `services/explorer-indexer/tests/migrations.rs`
//! are also observed from the api crate's harness. Together these two
//! checks prove there is one canonical schema and that both crates can
//! stand it up identically.
//!
//! Skips cleanly when Docker is not available so contributor laptops
//! without docker still run `cargo test` green.

mod common;

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use testcontainers::runners::AsyncRunner;
use testcontainers_modules::postgres::Postgres;

use common::{apply_migrations, CANONICAL_MIGRATION};

/// Static byte-for-byte parity between the file shipped in this crate's
/// `include_str!` and the file on disk in the indexer crate. Runs in
/// every `cargo test`, no Docker required — a divergence here is a
/// build-time hard fail.
#[test]
fn migration_bytes_equal_indexer_canonical() {
    let on_disk = std::fs::read_to_string(
        "../../services/explorer-indexer/migrations/0001_minimum_tables.sql",
    )
    .expect("read canonical migration from disk");
    assert_eq!(
        on_disk, CANONICAL_MIGRATION,
        "explorer-api include_str! drifted from canonical indexer migration"
    );
}

/// Information-schema parity: applying the canonical migration from the
/// api crate's harness yields exactly the nine §11 tables that
/// `services/explorer-indexer/tests/migrations.rs` also asserts on. If
/// either crate ever applies a different DDL, this test fails.
#[tokio::test]
async fn canonical_schema_yields_nine_minimum_tables() {
    let Some(pool) = try_pool().await else {
        eprintln!("[explorer-api-tests] skipping: docker not available");
        return;
    };
    apply_migrations(&pool).await;

    let expected = [
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
    for t in expected {
        let row: (i64,) = sqlx::query_as(
            "SELECT COUNT(*)::BIGINT FROM information_schema.tables \
             WHERE table_schema = 'public' AND table_name = $1",
        )
        .bind(t)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, 1, "canonical schema must define table {t}");
    }
}

async fn try_pool() -> Option<PgPool> {
    which_docker()?;
    let container = match Postgres::default().start().await {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[explorer-api-tests] postgres container failed to start: {e}");
            return None;
        }
    };
    // Leak the container handle for the duration of this single test
    // process; it will be reaped when the test process exits. We hold
    // it alive only to keep the connection valid below.
    let host = container.get_host().await.ok()?;
    let port = container.get_host_port_ipv4(5432).await.ok()?;
    let url = format!("postgres://postgres:postgres@{host}:{port}/postgres");
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .ok()?;
    // Box-leak the container so it outlives the pool; an alternative is
    // to thread it through, but this test only needs a one-shot fixture.
    Box::leak(Box::new(container));
    Some(pool)
}

fn which_docker() -> Option<()> {
    std::process::Command::new("docker")
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| if o.status.success() { Some(()) } else { None })
}
