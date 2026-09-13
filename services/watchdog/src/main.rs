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
//! # Pauser key
//!
//! The PAUSER_ROLE key comes from `WATCHDOG_PAUSER_KEY_HEX` (preferred for
//! deployments) or from the config file's `action.pauser_private_key_hex`
//! literal (local dev). Either way it is consumed once here at startup: the
//! daemon derives the signing state, drops the raw hex, and threads the derived
//! state through the poll loop.
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
    alert::{
        dispatch_missing_receipt_alert, dispatch_missing_receipt_resolve,
        dispatch_no_baseline_alert, dispatch_no_baseline_resolve,
    },
    config::Config,
    receipt_liveness::{
        check_receipt_liveness_status, AlertPager, PageAction, ReceiptLivenessStatus,
    },
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
    ///
    /// No default on purpose. It used to default to `8453` (Base mainnet), so a
    /// deployment on any other chain — the Fusion devnet is `918453` — silently
    /// monitored a chain it had no rows for and reported health from an empty
    /// query. Supply it on the command line, via `WATCHDOG_CHAIN_ID`, or as
    /// `chain_id` in the config file; the daemon refuses to start otherwise.
    #[arg(long, env = "WATCHDOG_CHAIN_ID")]
    chain_id: Option<i64>,

    /// Seconds between poll cycles.
    #[arg(long, env = "WATCHDOG_POLL_INTERVAL_SECS", default_value = "12")]
    poll_interval_secs: u64,
}

#[tokio::main]
async fn main() {
    let _ = rmpc_logging::init_service("watchdog");
    let args = Args::parse();

    // Load and validate configuration — exit 1 on any misconfiguration.
    let mut config = match Config::from_file(&args.config) {
        Ok(c) => c,
        Err(e) => {
            error!("startup: {e}");
            std::process::exit(1);
        }
    };

    // Take the pauser secret out of `Config` exactly once, here at startup, and
    // keep only the derived signing state for the life of the process. After
    // this call `config.action.pauser_private_key_hex` is `None`, so nothing in
    // the poll loop can read the raw key back out of the config. (This bounds
    // the secret's lifetime in our own long-lived state; it is not a claim that
    // no copy survives anywhere in process memory — see config.rs.)
    let pauser = match config.take_pauser_signing_key() {
        Ok(k) => k,
        Err(e) => {
            error!("startup: {e}");
            std::process::exit(1);
        }
    };
    if let Some(signer) = pauser.as_ref() {
        info!(pauser = %signer.address(), "pauser signing key derived at startup");
    }
    // No further mutation: the config is read-only from here on.
    let config = config;

    // Resolve the chain id explicitly: flag/env first, then the profile's
    // `chain_id`, then refuse. A wrong chain id makes every chain-scoped query
    // return nothing, which reads as health; that must not be reachable by
    // omission.
    let chain_id = match args.chain_id.or(config.chain_id) {
        Some(id) => id,
        None => {
            error!(
                "startup: chain id is not set — pass --chain-id, set WATCHDOG_CHAIN_ID, or add \
                 `chain_id = <id>` to the config (Fusion devnet is 918453, Base mainnet 8453). \
                 Refusing to start rather than monitor a chain nobody chose."
            );
            std::process::exit(1);
        }
    };

    info!(
        config = ?args.config,
        chain_id,
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

    // One incident per condition, not one per poll cycle.
    let mut gap_pager = AlertPager::new(config.consensus_receipts.expected_cadence_secs);
    let mut baseline_pager = AlertPager::new(config.consensus_receipts.expected_cadence_secs);

    // Main poll loop.
    loop {
        match latest_indexed_block(&pool, chain_id).await {
            Ok(Some(block_number)) => {
                match run_cycles_since_cursor(
                    &pool,
                    &config,
                    &client,
                    chain_id,
                    block_number,
                    pauser.as_ref(),
                )
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

        // Consensus-receipt anchoring gap (issue #1247 task 4.13). Deliberately
        // a separate path from the volume cycle above: a quiet swarm must never
        // pause the gateway, and a missing receipt must never be dropped
        // silently — a gap in the public record is exactly where someone would
        // look for suppression.
        if config.consensus_receipts.enabled {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or_default();
            match check_receipt_liveness_status(&pool, &config.consensus_receipts, chain_id, now)
                .await
            {
                Ok(ReceiptLivenessStatus::Missing(event)) => {
                    error!(
                        chain_id,
                        seconds_since = event.seconds_since,
                        budget_secs = event.budget_secs,
                        "consensus receipt missing: a session that should have produced a receipt did not"
                    );
                    if let Some(url) = config.action.webhook_url.as_deref() {
                        // The condition is permanent until the first anchor
                        // lands, so the pager — not the poll interval — decides
                        // how often it reaches a human.
                        match gap_pager.on_firing(now) {
                            PageAction::Trigger => {
                                if let Err(e) =
                                    dispatch_missing_receipt_alert(&client, url, &event).await
                                {
                                    error!("missing-receipt alert dispatch failed: {e}");
                                }
                            }
                            PageAction::None | PageAction::Resolve => {}
                        }
                    } else {
                        // Never silent: if there is nowhere to page, say so
                        // every cycle rather than swallowing the condition.
                        error!(
                            "consensus receipt missing but action.webhook_url is unset — \
                             the alert had nowhere to go"
                        );
                    }
                    if let PageAction::Resolve = baseline_pager.on_clear() {
                        if let Some(url) = config.action.webhook_url.as_deref() {
                            if let Err(e) =
                                dispatch_no_baseline_resolve(&client, url, chain_id).await
                            {
                                error!("no-baseline resolve dispatch failed: {e}");
                            }
                        }
                    }
                }
                Ok(ReceiptLivenessStatus::NoBaseline) => {
                    // Enabled, and measuring nothing. Not health.
                    error!(
                        chain_id,
                        "consensus receipt monitor has no baseline: no anchored receipt and no \
                         indexer run for this chain id — the monitor is blind; check the chain id"
                    );
                    match config.action.webhook_url.as_deref() {
                        Some(url) => match baseline_pager.on_firing(now) {
                            PageAction::Trigger => {
                                if let Err(e) =
                                    dispatch_no_baseline_alert(&client, url, chain_id).await
                                {
                                    error!("no-baseline alert dispatch failed: {e}");
                                }
                            }
                            PageAction::None | PageAction::Resolve => {}
                        },
                        None => error!(
                            "consensus receipt monitor is blind but action.webhook_url is unset \
                             — the alert had nowhere to go"
                        ),
                    }
                }
                Ok(ReceiptLivenessStatus::Healthy) => {
                    // AC-CORE-09: "successful anchoring resolves the alert."
                    for (action, resolve_gap) in [
                        (gap_pager.on_clear(), true),
                        (baseline_pager.on_clear(), false),
                    ] {
                        if action != PageAction::Resolve {
                            continue;
                        }
                        let Some(url) = config.action.webhook_url.as_deref() else {
                            continue;
                        };
                        let sent = if resolve_gap {
                            dispatch_missing_receipt_resolve(&client, url, chain_id).await
                        } else {
                            dispatch_no_baseline_resolve(&client, url, chain_id).await
                        };
                        match sent {
                            Ok(()) => {
                                info!(chain_id, resolve_gap, "consensus receipt alert resolved")
                            }
                            Err(e) => error!("alert resolve dispatch failed: {e}"),
                        }
                    }
                }
                Err(e) => error!("consensus receipt liveness check failed: {e}"),
            }
        }

        tokio::time::sleep(Duration::from_secs(args.poll_interval_secs)).await;
    }
}
