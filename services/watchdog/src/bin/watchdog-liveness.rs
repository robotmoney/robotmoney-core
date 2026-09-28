//! Read-only watchdog heartbeat check for an external monitor (issue #1378).
//!
//! Canonical: docs/architecture.md §5.6 "Watchdog liveness and deployment";
//! operator runbook: docs/operations/watchdog-liveness.md.
//!
//! ```text
//! WATCHDOG_DATABASE_URL=postgres://... \
//!   watchdog-liveness --chain-id 918453 --max-age-secs 180
//! ```
//!
//! Exit codes (see [`watchdog::liveness`]):
//!
//! - `0` — `watchdog_cursor.updated_at` is no older than `--max-age-secs`.
//! - `1` — the heartbeat is stale or missing: the watchdog is stopped, hung,
//!   crash-looping, or failed at startup (for example on an invalid pauser key).
//! - `2` — liveness is unknown (bad arguments, database unreachable). A monitor
//!   must page on this too; only `0` is healthy.
//!
//! The database URL is read from `WATCHDOG_DATABASE_URL` when `--database-url`
//! is not given, so a supervisor never has to put the credential on a command
//! line where `ps` would show it.

use std::{process::ExitCode, time::Duration};

use clap::Parser;
use sqlx::postgres::PgPoolOptions;
use watchdog::liveness::{check_cursor_liveness, CursorLiveness, EXIT_UNKNOWN};

/// Check that the watchdog completed a successful poll recently enough.
#[derive(Debug, Parser)]
#[command(
    name = "watchdog-liveness",
    about = "Exit 0 only if the watchdog's cursor heartbeat is fresh (issue #1378)"
)]
struct Args {
    /// Postgres connection URL for the explorer-indexer database.
    #[arg(long, env = "WATCHDOG_DATABASE_URL", hide_env_values = true)]
    database_url: String,

    /// Chain ID monitored by the watchdog. No default, for the same reason the
    /// daemon has none: a wrong chain must be chosen on purpose, never by
    /// omission (a wrong chain id reports `missing`, which pages).
    #[arg(long, env = "WATCHDOG_CHAIN_ID")]
    chain_id: i64,

    /// Maximum permitted age of `watchdog_cursor.updated_at`, in seconds.
    #[arg(long, env = "WATCHDOG_LIVENESS_MAX_AGE_SECS", default_value = "180")]
    max_age_secs: i64,
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = match Args::try_parse() {
        Ok(a) => a,
        Err(e) if e.use_stderr() => {
            eprintln!("watchdog liveness unknown: {e}");
            return ExitCode::from(EXIT_UNKNOWN);
        }
        Err(e) => {
            // --help / --version.
            let _ = e.print();
            return ExitCode::SUCCESS;
        }
    };
    if args.max_age_secs <= 0 {
        eprintln!("watchdog liveness unknown: --max-age-secs must be greater than zero");
        return ExitCode::from(EXIT_UNKNOWN);
    }

    let pool = match PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&args.database_url)
        .await
    {
        Ok(pool) => pool,
        Err(error) => {
            eprintln!("watchdog liveness unknown: database connect failed: {error}");
            return ExitCode::from(EXIT_UNKNOWN);
        }
    };

    let state = match check_cursor_liveness(&pool, args.chain_id, args.max_age_secs).await {
        Ok(state) => state,
        Err(error) => {
            eprintln!("watchdog liveness unknown: cursor query failed: {error}");
            return ExitCode::from(EXIT_UNKNOWN);
        }
    };
    match state {
        CursorLiveness::Healthy { age_secs } => println!(
            "watchdog liveness healthy: chain_id={} age_secs={age_secs} max_age_secs={}",
            args.chain_id, args.max_age_secs
        ),
        CursorLiveness::Stale { age_secs } => eprintln!(
            "watchdog liveness stale: chain_id={} age_secs={age_secs} max_age_secs={}",
            args.chain_id, args.max_age_secs
        ),
        CursorLiveness::Missing => eprintln!(
            "watchdog liveness missing: chain_id={} has no watchdog_cursor row",
            args.chain_id
        ),
    }
    ExitCode::from(state.exit_code())
}
