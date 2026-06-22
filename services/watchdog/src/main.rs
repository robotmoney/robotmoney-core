//! Watchdog daemon entry point.
//!
//! Canonical: docs/technical/security-model.md §9 — automated watchdog.
//!
//! # Usage
//!
//! ```text
//! watchdog --config services/watchdog/config.toml \
//!           --database-url postgres://... \
//!           --chain-id 8453 \
//!           --poll-interval-secs 12
//! ```
//!
//! All flags may be provided via environment variables with the prefix `WATCHDOG_`
//! (e.g. `WATCHDOG_DATABASE_URL`).
//!
//! # Startup validation
//!
//! The daemon validates the configuration on startup and exits non-zero if any
//! threshold is absent or zero (security model §9 requirement).  Operators should
//! treat a non-zero exit as a misconfiguration alert.
//!
//! # SLA
//!
//! The watchdog's maximum response time from breach detection to pause/alert is
//! recorded in `sla.max_response_secs` (default 300 s = 5 minutes, as required by
//! the Plan entry for issue #658).

use std::path::PathBuf;

use clap::Parser;
use reqwest::Client;
use sqlx::postgres::PgPoolOptions;
use std::time::Duration;
use tracing::{error, info};

use watchdog::{
    config::Config,
    watchdog::{latest_indexed_block, run_cycles_since_cursor, CycleResult},
};

/// CLI arguments for the watchdog daemon.
#[derive(Debug, Parser)]
#[command(
    name = "watchdog",
    about = "Robot Money mint/burn rate watchdog (security model §9)"
)]
struct Args {
    /// Path to the TOML configuration file.
    #[arg(
        long,
        env = "WATCHDOG_CONFIG",
        default_value = "services/watchdog/config.toml"
    )]
    config: PathBuf,

    /// Postgres connection URL for the explorer-indexer database.
    #[arg(long, env = "WATCHDOG_DATABASE_URL")]
    database_url: String,

    /// Chain ID to monitor.
    #[arg(long, env = "WATCHDOG_CHAIN_ID", default_value = "8453")]
    chain_id: i64,

    /// Seconds between poll cycles.
    #[arg(long, env = "WATCHDOG_POLL_INTERVAL_SECS", default_value = "12")]
    poll_interval_secs: u64,
}

#[tokio::main]
async fn main() {
    let _ = rmpc_logging::init_service("watchdog");
    let args = Args::parse();

    // Load and validate configuration — exit 1 on any misconfiguration.
    let config = match Config::from_file(&args.config) {
        Ok(c) => c,
        Err(e) => {
            error!("startup: {e}");
            std::process::exit(1);
        }
    };

    info!(
        config = ?args.config,
        chain_id = args.chain_id,
        poll_interval_secs = args.poll_interval_secs,
        sla_secs = config.sla.max_response_secs,
        "watchdog starting"
    );

    // Connect to the database.
    let pool = match PgPoolOptions::new()
        .max_connections(3)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&args.database_url)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            error!("database connect failed: {e}");
            std::process::exit(1);
        }
    };

    // Bound every individual RPC/webhook call by the SLA budget so a single hung
    // endpoint cannot stall the single-threaded poll loop (scan finding WD-1).
    // The per-action `timeout` in `run_cycle` is the hard ceiling; this client
    // timeout is the per-request guard underneath it.
    let client = match Client::builder()
        .timeout(Duration::from_secs(config.sla.max_response_secs))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            error!("http client build failed: {e}");
            std::process::exit(1);
        }
    };

    // Main poll loop.
    loop {
        match latest_indexed_block(&pool, args.chain_id).await {
            Ok(Some(block_number)) => {
                match run_cycles_since_cursor(&pool, &config, &client, args.chain_id, block_number)
                    .await
                {
                    Ok(CycleResult::Ok) => {}
                    Ok(CycleResult::Breached(kinds)) => {
                        info!(?kinds, "cycle: breach actions dispatched");
                    }
                    Ok(CycleResult::NoData) => {
                        info!("cycle: no new indexed data since cursor, waiting…");
                    }
                    Err(e) => {
                        error!("cycle error: {e}");
                    }
                }
            }
            Ok(None) => {
                info!("no indexed blocks yet, waiting…");
            }
            Err(e) => {
                error!("failed to fetch latest block: {e}");
            }
        }

        tokio::time::sleep(Duration::from_secs(args.poll_interval_secs)).await;
    }
}
