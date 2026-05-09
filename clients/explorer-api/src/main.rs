// Explorer API binary entry point.
//
// Required environment variables:
//   DATABASE_URL            — Postgres connection string.
//   EXPLORER_API_CHAIN_ID   — EIP-155 chain id this instance is scoped to.
//                             All agent/deposit/transaction reads filter on
//                             this value (docs/technical/explorer-schema-decisions.md §4).
//
// Optional environment variables:
//   EXPLORER_API_BIND           — bind address (default `0.0.0.0:8080`).
//   EXPLORER_API_ALLOW_ORIGINS  — comma-separated list of allowed CORS origins
//                                 (e.g. `https://app.example.com,https://staging.example.com`).
//                                 Omitting this variable disables CORS headers entirely —
//                                 all cross-origin requests will be blocked by browsers.
//   RUST_LOG                    — tracing filter (default `info`).

use std::net::SocketAddr;

use anyhow::Context;
use axum::http::HeaderValue;
use sqlx::postgres::PgPoolOptions;
use tower_http::cors::{AllowOrigin, CorsLayer};
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
    let base_app = router(state);

    // Build the CORS layer from EXPLORER_API_ALLOW_ORIGINS.
    // The variable is a comma-separated list of origin strings.  An absent or
    // empty variable disables the layer (no Access-Control-Allow-Origin header
    // is emitted, which is correct for deployments where the API is not
    // accessed cross-origin).
    let app = match build_cors_layer()? {
        Some(cors) => base_app.layer(cors),
        None => {
            tracing::warn!(
                "EXPLORER_API_ALLOW_ORIGINS not set — CORS headers disabled; \
                 cross-origin browser requests will be blocked"
            );
            base_app
        }
    };

    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(?bind, chain_id, "explorer-api listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Parse `EXPLORER_API_ALLOW_ORIGINS` and produce a `CorsLayer`.
///
/// Returns `Ok(None)` when the variable is absent or empty.
/// Returns `Err` if any origin string is not a valid `HeaderValue`.
fn build_cors_layer() -> anyhow::Result<Option<CorsLayer>> {
    let raw = match std::env::var("EXPLORER_API_ALLOW_ORIGINS") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => return Ok(None),
    };

    let origins: Vec<HeaderValue> = raw
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.parse::<HeaderValue>()
                .with_context(|| format!("invalid origin in EXPLORER_API_ALLOW_ORIGINS: {s}"))
        })
        .collect::<anyhow::Result<_>>()?;

    if origins.is_empty() {
        return Ok(None);
    }

    tracing::info!(
        origins = ?origins,
        "CORS enabled"
    );

    // The API is read-only; only GET and the browser's automatic OPTIONS
    // preflight are permitted.
    let layer = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_methods([axum::http::Method::GET])
        .allow_headers(tower_http::cors::Any);

    Ok(Some(layer))
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
