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
        dispatch_quorum_below_floor_alert, dispatch_quorum_below_floor_resolve,
        missing_receipt_dedup_key, no_baseline_dedup_key, quorum_below_floor_dedup_key,
    },
    config::Config,
    governance::{check_quorum_floor, QuorumStatus},
    pager_state::{ensure_pager_state_table, load_pager_state, save_pager_state},
    receipt_liveness::{
        check_receipt_liveness_status, AlertPager, PageAction, ReceiptLivenessStatus,
    },
    watchdog::{latest_indexed_block, run_cycles_since_cursor, CycleResult},
    WatchdogError,
};

/// Commit the outcome of one dispatch and persist the pager's durable state.
///
/// Task T08: nothing is committed before the receiver confirmed. On a failed
/// delivery the pager stays armed and refuses to retry before its failure
/// floor, so a hard-down receiver is neither hammered at the 12 s poll rate nor
/// silenced for a whole publishing cadence.
async fn commit_page(
    pool: &sqlx::PgPool,
    pager: &mut AlertPager,
    chain_id: i64,
    dedup_key: &str,
    now: i64,
    action: PageAction,
    sent: Result<(), WatchdogError>,
) {
    let ok = match &sent {
        Ok(()) => true,
        Err(e) => {
            error!(dedup_key, "alert dispatch failed, pager stays armed: {e}");
            false
        }
    };
    if pager.on_page_result(now, action, ok) {
        if let Err(e) = save_pager_state(pool, chain_id, dedup_key, pager.state()).await {
            // Durability is best-effort: losing the write must not take the
            // monitor off-line, but it must never be silent, because the next
            // restart is then the one that forgets an open incident.
            error!(dedup_key, "pager state persist failed: {e}");
        }
    }
}

/// Reconstruct a pager from whatever the previous process durably recorded.
async fn restore_pager(
    pool: &sqlx::PgPool,
    chain_id: i64,
    dedup_key: &str,
    min_repage_secs: u64,
) -> AlertPager {
    match load_pager_state(pool, chain_id, dedup_key).await {
        Ok(Some(state)) => {
            info!(
                dedup_key,
                firing = state.firing,
                "restored pager state across restart"
            );
            AlertPager::from_state(min_repage_secs, state)
        }
        Ok(None) => AlertPager::new(min_repage_secs),
        Err(e) => {
            error!(dedup_key, "pager state load failed, starting cold: {e}");
            AlertPager::new(min_repage_secs)
        }
    }
}

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

    // One incident per condition, not one per poll cycle — and the incident
    // outlives this process (task T08). The detection side was already
    // restart-durable (baseline from MIN(indexer_runs.started_at)); without
    // this the incident side was not, so a restart mid-incident left
    // `consensus_receipt_missing:<chain>` open forever.
    if let Err(e) = ensure_pager_state_table(&pool).await {
        error!("pager state table unavailable, pager state will not survive a restart: {e}");
    }
    let cadence = config.consensus_receipts.expected_cadence_secs;
    let gap_key = missing_receipt_dedup_key(chain_id);
    let baseline_key = no_baseline_dedup_key(chain_id);
    let quorum_key = quorum_below_floor_dedup_key(chain_id);
    let mut gap_pager = restore_pager(&pool, chain_id, &gap_key, cadence).await;
    let mut baseline_pager = restore_pager(&pool, chain_id, &baseline_key, cadence).await;
    let mut quorum_pager =
        restore_pager(&pool, chain_id, &quorum_key, config.governance.repage_secs).await;

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
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or_default();

        // Consensus-receipt anchoring gap (issue #1247 task 4.13). Deliberately
        // a separate path from the volume cycle above: a quiet swarm must never
        // pause the gateway, and a missing receipt must never be dropped
        // silently — a gap in the public record is exactly where someone would
        // look for suppression.
        if config.consensus_receipts.enabled {
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
                    match config.action.webhook_url.as_deref() {
                        Some(url) => {
                            // The condition is permanent until the first anchor
                            // lands, so the pager — not the poll interval —
                            // decides how often it reaches a human.
                            let action = gap_pager.on_firing(now);
                            if action == PageAction::Trigger {
                                let sent =
                                    dispatch_missing_receipt_alert(&client, url, &event).await;
                                commit_page(
                                    &pool,
                                    &mut gap_pager,
                                    chain_id,
                                    &gap_key,
                                    now,
                                    action,
                                    sent,
                                )
                                .await;
                            }
                            // A measurable gap means a baseline exists, so the
                            // "monitor is blind" incident is over.
                            let action = baseline_pager.on_clear(now);
                            if action == PageAction::Resolve {
                                let sent =
                                    dispatch_no_baseline_resolve(&client, url, chain_id).await;
                                commit_page(
                                    &pool,
                                    &mut baseline_pager,
                                    chain_id,
                                    &baseline_key,
                                    now,
                                    action,
                                    sent,
                                )
                                .await;
                            }
                        }
                        // Never silent: if there is nowhere to page, say so
                        // every cycle rather than swallowing the condition.
                        None => error!(
                            "consensus receipt missing but action.webhook_url is unset — \
                             the alert had nowhere to go"
                        ),
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
                        Some(url) => {
                            let action = baseline_pager.on_firing(now);
                            if action == PageAction::Trigger {
                                let sent = dispatch_no_baseline_alert(&client, url, chain_id).await;
                                commit_page(
                                    &pool,
                                    &mut baseline_pager,
                                    chain_id,
                                    &baseline_key,
                                    now,
                                    action,
                                    sent,
                                )
                                .await;
                            }
                            // The gap incident has no subject while there is no
                            // baseline at all: resolve it rather than leaving a
                            // trigger with no matching resolve (task T08c).
                            let action = gap_pager.on_clear(now);
                            if action == PageAction::Resolve {
                                let sent =
                                    dispatch_missing_receipt_resolve(&client, url, chain_id).await;
                                commit_page(
                                    &pool,
                                    &mut gap_pager,
                                    chain_id,
                                    &gap_key,
                                    now,
                                    action,
                                    sent,
                                )
                                .await;
                            }
                        }
                        None => error!(
                            "consensus receipt monitor is blind but action.webhook_url is unset \
                             — the alert had nowhere to go"
                        ),
                    }
                }
                Ok(ReceiptLivenessStatus::Healthy) => {
                    // AC-CORE-09: "successful anchoring resolves the alert."
                    if let Some(url) = config.action.webhook_url.as_deref() {
                        let action = gap_pager.on_clear(now);
                        if action == PageAction::Resolve {
                            let sent =
                                dispatch_missing_receipt_resolve(&client, url, chain_id).await;
                            let ok = sent.is_ok();
                            commit_page(
                                &pool,
                                &mut gap_pager,
                                chain_id,
                                &gap_key,
                                now,
                                action,
                                sent,
                            )
                            .await;
                            if ok {
                                info!(chain_id, "consensus receipt gap alert resolved");
                            }
                        }
                        let action = baseline_pager.on_clear(now);
                        if action == PageAction::Resolve {
                            let sent = dispatch_no_baseline_resolve(&client, url, chain_id).await;
                            let ok = sent.is_ok();
                            commit_page(
                                &pool,
                                &mut baseline_pager,
                                chain_id,
                                &baseline_key,
                                now,
                                action,
                                sent,
                            )
                            .await;
                            if ok {
                                info!(chain_id, "no-baseline alert resolved");
                            }
                        }
                    }
                }
                Err(e) => error!("consensus receipt liveness check failed: {e}"),
            }
        }

        // Standing quorum floor (task T22, decision D16). The contract's
        // MIN_QUORUM_THRESHOLD stops a new deployment from being wired below
        // the floor; this is the only thing that catches an ADMIN_ROLE holder
        // lowering the threshold on a router that is already live, after
        // AC-GOV-03's evidence was collected. Read-only; it never pauses.
        if config.governance.enabled {
            match check_quorum_floor(&client, &config.governance, chain_id).await {
                Ok(QuorumStatus::BelowFloor(breach)) => {
                    error!(
                        chain_id,
                        quorum_threshold = breach.threshold,
                        min_quorum_threshold = breach.min_threshold,
                        "RouterGovernance quorum threshold is below the floor — one voter is a quorum"
                    );
                    match config.action.webhook_url.as_deref() {
                        Some(url) => {
                            let action = quorum_pager.on_firing(now);
                            if action == PageAction::Trigger {
                                let sent =
                                    dispatch_quorum_below_floor_alert(&client, url, &breach).await;
                                commit_page(
                                    &pool,
                                    &mut quorum_pager,
                                    chain_id,
                                    &quorum_key,
                                    now,
                                    action,
                                    sent,
                                )
                                .await;
                            }
                        }
                        None => error!(
                            "quorum threshold is below the floor but action.webhook_url is unset \
                             — the alert had nowhere to go"
                        ),
                    }
                }
                Ok(QuorumStatus::Ok { threshold }) => {
                    if let Some(url) = config.action.webhook_url.as_deref() {
                        let action = quorum_pager.on_clear(now);
                        if action == PageAction::Resolve {
                            let sent =
                                dispatch_quorum_below_floor_resolve(&client, url, chain_id).await;
                            let ok = sent.is_ok();
                            commit_page(
                                &pool,
                                &mut quorum_pager,
                                chain_id,
                                &quorum_key,
                                now,
                                action,
                                sent,
                            )
                            .await;
                            if ok {
                                info!(chain_id, threshold, "quorum-floor alert resolved");
                            }
                        }
                    }
                }
                // A failed read is not health: it is logged loudly every cycle.
                // It is deliberately NOT a page of its own — an RPC outage is
                // already the volume path's problem — but it must never be
                // mistaken for a threshold that was read and found acceptable.
                Err(e) => error!(
                    chain_id,
                    "quorum floor check could not read RouterGovernance.quorumThreshold(): {e}"
                ),
            }
        }

        tokio::time::sleep(Duration::from_secs(args.poll_interval_secs)).await;
    }
}
