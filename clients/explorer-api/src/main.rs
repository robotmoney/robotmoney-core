// Explorer API binary entry point.
//
// Required environment variables:
//   DATABASE_URL            — Postgres connection string.
//   EXPLORER_API_CHAIN_ID   — EIP-155 chain id this instance is scoped to.
//                             All agent/deposit/transaction reads filter on
//                             this value (docs/technical/explorer-schema-decisions.md §4).
//
// Optional environment variables:
//   EXPLORER_API_BIND  — bind address (default `0.0.0.0:8080`).
//   RUST_LOG           — tracing filter (default `info`).

use std::net::SocketAddr;

use anyhow::Context;
use sqlx::postgres::PgPoolOptions;
use tracing_subscriber::EnvFilter;

use explorer_api::{router, AppState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL not set")?;
    let chain_id: i64 = std::env::var("EXPLORER_API_CHAIN_ID")
        .context("EXPLORER_API_CHAIN_ID not set")?
        .parse()
        .context("EXPLORER_API_CHAIN_ID must be a valid integer")?;
    let bind: SocketAddr = std::env::var("EXPLORER_API_BIND")
        .unwrap_or_else(|_| "0.0.0.0:8080".to_string())
        .parse()
        .context("EXPLORER_API_BIND invalid")?;

    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url)
        .await
        .context("connecting to Postgres")?;

    let state = AppState::new(pool, chain_id);
    let app = router(state);

    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(?bind, chain_id, "explorer-api listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
