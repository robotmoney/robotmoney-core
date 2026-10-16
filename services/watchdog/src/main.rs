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
//! The DEPOSIT_PAUSER_ROLE key comes from `WATCHDOG_PAUSER_KEY_HEX` (preferred for
//! deployments) or from the config file's `action.pauser_private_key_hex`
//! literal (local dev). Either way it is consumed once here at startup: the
//! daemon derives the signing state, drops the raw hex, and threads the derived
//! state through the poll loop.
//!
//! # Startup validation
//!
//! The daemon validates the configuration on startup and exits non-zero if any
//! threshold is absent or zero, or if a pause-mode pauser key is invalid
//! (security model §9 requirement). Operators should treat a non-zero exit as a
//! misconfiguration alert; `watchdog-liveness` reports the resulting missing
//! cursor heartbeat to the external monitor.
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
        dispatch_indexer_behind_alert, dispatch_indexer_behind_resolve,
        dispatch_missing_receipt_alert, dispatch_missing_receipt_resolve,
        dispatch_no_baseline_alert, dispatch_no_baseline_resolve,
        dispatch_weight_setter_path_alert, dispatch_weight_setter_path_resolve,
        indexer_behind_dedup_key, missing_receipt_dedup_key, no_baseline_dedup_key,
        weight_setter_path_dedup_key,
    },
    config::Config,
    governance::{check_weight_setter_path, WeightSetterStatus},
    liveness::read_indexer_progress,
    pager_state::{commit_page, ensure_pager_state_table, load_pager_state},
    receipt_liveness::{
        check_receipt_liveness_status, AlertPager, PageAction, ReceiptLivenessStatus,
    },
    upgrade_monitor::{alert_new_proxy_changes, proxy_change_baseline},
    watchdog::{latest_indexed_block, run_cycles_since_cursor, CycleResult},
};

/// Wall-clock Unix seconds for pager bookkeeping and the receipt-gap check.
fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
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
    // Issue 1856: take the proxy-change baseline before the first cycle writes
    // the watchdog cursor, so a first-ever start is told from a restart. Only
    // this startup call may take the indexer cursor (issue 1868).
    if let Err(e) = proxy_change_baseline(&pool, chain_id, true).await {
        error!("proxy change baseline unavailable, every unpaged proxy change will page: {e}");
    }
    let cadence = config.consensus_receipts.expected_cadence_secs;
    let gap_key = missing_receipt_dedup_key(chain_id);
    let baseline_key = no_baseline_dedup_key(chain_id);
    let weight_setter_key = weight_setter_path_dedup_key(chain_id);
    let mut gap_pager = restore_pager(&pool, chain_id, &gap_key, cadence).await;
    let mut baseline_pager = restore_pager(&pool, chain_id, &baseline_key, cadence).await;
    let mut weight_setter_pager = restore_pager(
        &pool,
        chain_id,
        &weight_setter_key,
        config.governance.repage_secs,
    )
    .await;
    // DI-5: the indexer this daemon reads is behind its budget, so what the
    // daemon evaluates is not current. One incident, resolved once the indexer
    // is back within budget.
    let indexer_key = indexer_behind_dedup_key(chain_id);
    let mut indexer_pager = restore_pager(
        &pool,
        chain_id,
        &indexer_key,
        config.indexer_lag.repage_secs,
    )
    .await;

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
                    Ok(CycleResult::BreachUndelivered(kinds)) => {
                        // run_cycle logged each failed delivery; the cursor
                        // holds the block, so the next poll is the retry.
                        error!(
                            ?kinds,
                            "cycle: breach alert not delivered; retrying the same block next poll"
                        );
                    }
                    Ok(CycleResult::NoData) => {
                        info!("cycle: no new indexed data since cursor, waiting…");
                    }
                    Ok(CycleResult::IndexerBehind(_)) => {
                        // run_cycles_since_cursor logged the numbers; the
                        // page is below.
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

        // Read after the volume cycle, which may have spent up to its SLA
        // budget.
        let now = unix_now();

        // Explorer-indexer lag (DI-5). Read every poll, not only when the
        // volume cycle found nothing new: during a long catch-up the cycle
        // alternates between new blocks and none, and keying the incident on
        // the cycle result would open and resolve it every tick. One incident
        // while the indexer is behind its budget, resolved once it is not.
        // Alert-only: it never pauses the gateway.
        match read_indexer_progress(&pool, chain_id).await {
            Ok(progress) if progress.is_behind(&config.indexer_lag) => {
                match config.action.webhook_url.as_deref() {
                    Some(url) => {
                        let action = indexer_pager.on_firing(now);
                        if action == PageAction::Trigger {
                            let sent = dispatch_indexer_behind_alert(
                                &client,
                                url,
                                chain_id,
                                &progress,
                                &config.indexer_lag,
                            )
                            .await;
                            commit_page(
                                &pool,
                                &mut indexer_pager,
                                chain_id,
                                &indexer_key,
                                now,
                                action,
                                sent,
                            )
                            .await;
                        }
                    }
                    // Never silent: the stale heartbeat still pages through
                    // watchdog-liveness, but say here that this daemon could not.
                    None => error!(
                        "explorer indexer is behind but action.webhook_url is unset — \
                         the alert had nowhere to go"
                    ),
                }
            }
            Ok(_) => {
                if let Some(url) = config.action.webhook_url.as_deref() {
                    let action = indexer_pager.on_clear(now);
                    if action == PageAction::Resolve {
                        let sent = dispatch_indexer_behind_resolve(&client, url, chain_id).await;
                        let ok = sent.is_ok();
                        commit_page(
                            &pool,
                            &mut indexer_pager,
                            chain_id,
                            &indexer_key,
                            now,
                            action,
                            sent,
                        )
                        .await;
                        if ok {
                            info!(chain_id, "indexer-behind alert resolved");
                        }
                    }
                }
            }
            // A failed read is not health, and not a page of its own: the
            // volume path above shares the database and is already failing.
            Err(e) => error!(chain_id, "explorer indexer progress read failed: {e}"),
        }

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

        // Standing weight-setter path (issue 1698). Router weights change only
        // through RouterGovernance.applyReceipt on a Safe-scheduled timelock
        // operation. The verifier checks the three role sets that make that true
        // once, at deploy; this catches a grant executed after it. It replaced
        // the quorumThreshold() floor check, whose view issue 1698 deleted.
        // Read-only; it never pauses.
        if config.governance.enabled {
            match check_weight_setter_path(&client, &config.governance, chain_id).await {
                Ok(WeightSetterStatus::Drifted(breach)) => {
                    error!(
                        chain_id,
                        weight_setter_role_count = breach.weight_setter_role.count,
                        weight_setter_role_holders = ?breach.weight_setter_role.members,
                        apply_receipt_role_count = breach.weight_setter_appliers.count,
                        apply_receipt_role_holders = ?breach.weight_setter_appliers.members,
                        weight_setter_admin_count = breach.weight_setter_admins.count,
                        weight_setter_admins = ?breach.weight_setter_admins.members,
                        "router weight-setter path is not the configured one — weights can \
                         change outside applyReceipt or without the timelock delay"
                    );
                    match config.action.webhook_url.as_deref() {
                        Some(url) => {
                            let action = weight_setter_pager.on_firing(now);
                            if action == PageAction::Trigger {
                                let sent =
                                    dispatch_weight_setter_path_alert(&client, url, &breach).await;
                                commit_page(
                                    &pool,
                                    &mut weight_setter_pager,
                                    chain_id,
                                    &weight_setter_key,
                                    now,
                                    action,
                                    sent,
                                )
                                .await;
                            }
                        }
                        None => error!(
                            "the weight-setter path drifted but action.webhook_url is unset \
                             — the alert had nowhere to go"
                        ),
                    }
                }
                Ok(WeightSetterStatus::Ok) => {
                    if let Some(url) = config.action.webhook_url.as_deref() {
                        let action = weight_setter_pager.on_clear(now);
                        if action == PageAction::Resolve {
                            let sent =
                                dispatch_weight_setter_path_resolve(&client, url, chain_id).await;
                            let ok = sent.is_ok();
                            commit_page(
                                &pool,
                                &mut weight_setter_pager,
                                chain_id,
                                &weight_setter_key,
                                now,
                                action,
                                sent,
                            )
                            .await;
                            if ok {
                                info!(chain_id, "weight-setter path alert resolved");
                            }
                        }
                    }
                }
                // A failed read is not health: it is logged loudly every cycle.
                // It is deliberately NOT a page of its own — an RPC outage is
                // already the volume path's problem — but it must never be
                // mistaken for role sets that were read and found correct.
                Err(e) => error!(
                    chain_id,
                    "weight-setter path check could not read the role sets: {e}"
                ),
            }
        }

        // Governed upgrades and freezes of proxied core contracts (issue 1810).
        // Alert-only: an upgrade never pauses the gateway.
        if let Err(e) = alert_new_proxy_changes(
            &pool,
            &client,
            config.action.webhook_url.as_deref(),
            chain_id,
            now,
        )
        .await
        {
            error!("proxy upgrade check failed: {e}");
        }

        tokio::time::sleep(Duration::from_secs(args.poll_interval_secs)).await;
    }
}
