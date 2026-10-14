//! Core watchdog loop: poll indexed volume data, compare against thresholds, and
//! trigger the configured action on breach.
//!
//! Canonical: docs/technical/security-model.md §9
//!
//! # Cycle
//!
//! 1. Determine the latest indexed block from `indexer_runs` and load the
//!    watchdog's last-processed-block cursor.
//! 2. For **every** block in `(cursor, latest]` (not just the latest — scan
//!    finding WD-6), query per-block mint/burn volume and the rolling per-hour
//!    volume anchored to that block's on-chain timestamp (WD-2).
//! 3. Compare each metric against the global thresholds from [`Config`].
//! 4. On breach: dispatch the alert first, then the pause under an SLA-bounded
//!    timeout, so a hung pause RPC never starves the alert path (WD-1). Every
//!    breach alert goes through an [`AlertPager`] keyed on the block, the
//!    threshold and the scope, and is committed only once the receiver
//!    confirmed it (DI-7).
//! 5. Advance the cursor past each block that was evaluated AND whose breach
//!    alerts were all delivered. A block with an undelivered alert holds the
//!    cursor; the next cycle re-evaluates it, re-sends only the undelivered
//!    alerts and does not re-send a pause that already went out (DI-7).
//! 6. With no new block, refresh the liveness heartbeat only while the
//!    explorer indexer is within its lag budget; otherwise report
//!    [`CycleResult::IndexerBehind`] and let the heartbeat age (DI-5).
//! 7. Sleep for `poll_interval_secs` and repeat.
//!
//! The watchdog does NOT exit on a breach — it continues polling to catch
//! subsequent breaches and to log that gateway deposits remain paused (a deposit
//! pause never freezes withdrawals).

use std::time::Duration;

use reqwest::Client;
use sqlx::postgres::PgPool;
use tokio::time::timeout;
use tracing::{error, info, warn};

use crate::{
    alert::{
        dispatch_alert, volume_breach_block_prefix, volume_breach_dedup_key,
        volume_breach_pause_key, BreachEvent, ThresholdKind,
    },
    config::Config,
    liveness::{read_indexer_progress, IndexerProgress},
    pager_state::{
        clear_pager_states_with_prefix, commit_page, load_pager_state, save_pager_state,
    },
    pause::{trigger_pause, PauseParams, PauserSigningKey},
    receipt_liveness::{AlertPager, PageAction, PagerState},
    volume::{
        burn_volume_per_block, burn_volume_per_block_for_vault, burn_volume_per_hour,
        burn_volume_per_hour_for_vault, mint_volume_per_block, mint_volume_per_block_for_vault,
        mint_volume_per_hour, mint_volume_per_hour_for_vault,
    },
    WatchdogError,
};

/// Result of a single watchdog poll cycle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CycleResult {
    /// No threshold was breached; normal operation.
    Ok,
    /// One or more thresholds were breached; actions were dispatched.
    Breached(Vec<ThresholdKind>),
    /// The indexer has not yet written any block data; poll again later.
    NoData,
    /// One or more thresholds were breached and acted on, but at least one
    /// breach alert was not confirmed by the receiver. The cursor stays on
    /// this block so the next cycle retries the undelivered alerts (DI-7).
    BreachUndelivered(Vec<ThresholdKind>),
    /// No new indexed block, and the explorer indexer is beyond its lag
    /// budget: the watchdog has nothing current to evaluate. The liveness
    /// heartbeat was NOT refreshed (DI-5).
    IndexerBehind(IndexerProgress),
}

/// Rolling per-hour window width, in seconds.
const HOUR_WINDOW_SECS: i64 = 3600;

/// Re-page floor for a volume-breach key. A key names one block's breach, so
/// once delivered it is never paged again; a retry skips it on `firing`.
const BREACH_REPAGE_SECS: u64 = i64::MAX as u64;

/// Wall-clock Unix seconds, for pager bookkeeping only. Breach decisions are
/// anchored to chain time (WD-2), never to this.
fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// Run a single watchdog cycle against the given `block_number`.
///
/// Exposed as a free function so integration tests can drive individual cycles
/// deterministically without a real timer loop. Most callers should prefer
/// [`run_cycles_since_cursor`], which evaluates every block since the cursor and
/// persists progress; this single-block entry point is retained for tests and is
/// also used internally per block by the cursor loop.
///
/// `pauser` carries the signing state derived once at startup by
/// [`Config::take_pauser_signing_key`]; pass `None` when no pauser key is
/// configured (alert-only deployments). The cycle never reads raw key material
/// from `config`.
pub async fn run_cycle(
    pool: &PgPool,
    config: &Config,
    client: &Client,
    chain_id: i64,
    block_number: i64,
    pauser: Option<&PauserSigningKey>,
) -> Result<CycleResult, WatchdogError> {
    // Anchor the rolling per-hour window to indexed *chain* time, not wall-clock
    // (scan finding WD-2). Using the evaluated block's on-chain timestamp keeps
    // the window consistent whether the watchdog is at tip or catching up, and
    // makes the breach decision deterministic for a given indexed state. Fall
    // back to the block's persisted timestamp; if the header row is somehow
    // missing the per-hour window is empty rather than wall-clock-skewed.
    let now_unix = match block_timestamp(pool, chain_id, block_number).await? {
        Some(ts) => ts,
        None => match latest_block_timestamp(pool, chain_id).await? {
            Some(ts) => {
                warn!(
                    chain_id,
                    block_number,
                    "no persisted header for evaluated block; anchoring per-hour \
                     window to latest known chain time instead"
                );
                ts
            }
            None => {
                warn!(
                    chain_id,
                    block_number, "no persisted block headers; per-hour window empty this cycle"
                );
                0
            }
        },
    };

    // --- Compute volumes ---
    let mint_block = mint_volume_per_block(pool, chain_id, block_number).await?;
    let mint_hour = mint_volume_per_hour(pool, chain_id, now_unix, HOUR_WINDOW_SECS).await?;
    let burn_block = burn_volume_per_block(pool, chain_id, block_number).await?;
    let burn_hour = burn_volume_per_hour(pool, chain_id, now_unix, HOUR_WINDOW_SECS).await?;

    // --- Compare against thresholds ---
    let mut breaches: Vec<BreachEvent> = Vec::new();

    let pb_mint_limit = config.global_per_block_mint_limit();
    if mint_block > pb_mint_limit {
        warn!(
            chain_id,
            block_number,
            volume = mint_block,
            threshold = pb_mint_limit,
            "per-block mint threshold breached"
        );
        breaches.push(BreachEvent {
            kind: ThresholdKind::PerBlockMint,
            threshold_usdc: pb_mint_limit,
            volume_usdc: mint_block,
            chain_id,
            block_number,
            vault: None,
        });
    }

    let ph_mint_limit = config.global_per_hour_mint_limit();
    if mint_hour > ph_mint_limit {
        warn!(
            chain_id,
            block_number,
            volume = mint_hour,
            threshold = ph_mint_limit,
            "per-hour mint threshold breached"
        );
        breaches.push(BreachEvent {
            kind: ThresholdKind::PerHourMint,
            threshold_usdc: ph_mint_limit,
            volume_usdc: mint_hour,
            chain_id,
            block_number,
            vault: None,
        });
    }

    let pb_burn_limit = config.global_per_block_burn_limit();
    if burn_block > pb_burn_limit {
        warn!(
            chain_id,
            block_number,
            volume = burn_block,
            threshold = pb_burn_limit,
            "per-block burn threshold breached"
        );
        breaches.push(BreachEvent {
            kind: ThresholdKind::PerBlockBurn,
            threshold_usdc: pb_burn_limit,
            volume_usdc: burn_block,
            chain_id,
            block_number,
            vault: None,
        });
    }

    let ph_burn_limit = config.global_per_hour_burn_limit();
    if burn_hour > ph_burn_limit {
        warn!(
            chain_id,
            block_number,
            volume = burn_hour,
            threshold = ph_burn_limit,
            "per-hour burn threshold breached"
        );
        breaches.push(BreachEvent {
            kind: ThresholdKind::PerHourBurn,
            threshold_usdc: ph_burn_limit,
            volume_usdc: burn_hour,
            chain_id,
            block_number,
            vault: None,
        });
    }

    // --- Per-vault threshold checks (scan finding WD-4) ---
    //
    // The global checks above measure the all-vault aggregate. A vault configured
    // with a *tighter* override (`[vault."<hex>"]` in config) must additionally be
    // measured against its own limit so a spike confined to that vault is caught
    // even when the global aggregate stays under the global cap. Volume is scoped
    // per vault (GROUP-BY-vault semantics) so one vault's spike never dilutes into
    // another's per-vault check.
    for vault_hex in config.vault.keys() {
        let Some(vault_bytes) = decode_vault_hex(vault_hex) else {
            warn!(
                vault = %vault_hex,
                "per-vault threshold key is not valid hex; skipping this vault"
            );
            continue;
        };

        evaluate_vault_breaches(
            pool,
            config,
            chain_id,
            block_number,
            now_unix,
            vault_hex,
            &vault_bytes,
            &mut breaches,
        )
        .await?;
    }

    if breaches.is_empty() {
        info!(
            chain_id,
            block_number,
            mint_block,
            mint_hour,
            burn_block,
            burn_hour,
            "watchdog cycle: all volumes within thresholds"
        );
        return Ok(CycleResult::Ok);
    }

    // --- Dispatch actions ---
    //
    // Alert FIRST, pause SECOND, and bound every action by the SLA budget (scan
    // finding WD-1). Previously the pause RPC was awaited before the alert with no
    // timeout, so a hung gateway RPC stalled the single-threaded cycle: the alert
    // never fired and the next poll never ran. Dispatching the on-call alert
    // before the pause guarantees a human is paged even if the automated pause is
    // wedged, and the per-action timeout caps how long any one RPC can block.
    let mode = config.action.mode;
    let sla = Duration::from_secs(config.sla.max_response_secs);
    let now = unix_now();

    // DI-7: a breach alert used to be fire-and-forget. A non-2xx or a timeout
    // was logged, the cursor moved past the block, and the alert was never
    // sent again. Each alert now goes through an `AlertPager` under its own
    // block-scoped key and is committed only on a confirmed delivery; an
    // undelivered one holds the cursor on this block (see
    // `run_cycles_since_cursor`), and a retry skips every key already
    // delivered, so the receiver hears each breach once.
    let mut undelivered = 0usize;
    if mode.includes_alert() {
        if let Some(webhook_url) = &config.action.webhook_url {
            for event in &breaches {
                let key = volume_breach_dedup_key(event);
                let state = match load_pager_state(pool, chain_id, &key).await {
                    Ok(state) => state.unwrap_or_default(),
                    // Unknown is not "delivered": send it. The worst case is a
                    // duplicate under the same dedup_key, never a lost page.
                    Err(e) => {
                        error!(dedup_key = %key, "breach pager state load failed, sending anyway: {e}");
                        PagerState::default()
                    }
                };
                if state.firing {
                    info!(
                        dedup_key = %key,
                        "breach alert already delivered on an earlier attempt at this block; not re-sent"
                    );
                    continue;
                }
                let mut pager = AlertPager::from_state(BREACH_REPAGE_SECS, state);
                let action = pager.on_firing(now);
                if action != PageAction::Trigger {
                    continue;
                }
                let sent = match timeout(sla, dispatch_alert(client, webhook_url, event)).await {
                    Ok(sent) => sent,
                    Err(_) => Err(WatchdogError::Alert(format!(
                        "alert dispatch exceeded the {}s SLA budget; aborted",
                        config.sla.max_response_secs
                    ))),
                };
                if sent.is_err() {
                    undelivered += 1;
                }
                commit_page(pool, &mut pager, chain_id, &key, now, action, sent).await;
            }
        }
    }

    if mode.includes_pause() {
        // A retry of this block (held for an undelivered alert) must not send
        // the pause again: it went out on the first attempt.
        let pause_key = volume_breach_pause_key(chain_id, block_number);
        let already_submitted = matches!(
            load_pager_state(pool, chain_id, &pause_key).await,
            Ok(Some(PagerState { firing: true, .. }))
        );
        if already_submitted {
            info!(
                chain_id,
                block_number,
                "gateway.pauseDeposits() already submitted for this block on an earlier attempt; not re-sent"
            );
        } else if trigger_pause_once(config, client, chain_id, pauser, sla).await && undelivered > 0
        {
            // Only a block that will be retried needs the record; a delivered
            // block moves on and never looks at it.
            let submitted = PagerState {
                firing: true,
                last_paged_at: Some(now),
            };
            if let Err(e) = save_pager_state(pool, chain_id, &pause_key, submitted).await {
                error!(
                    chain_id,
                    block_number,
                    "pause record persist failed; the retry may send the pause again: {e}"
                );
            }
        }
    }

    let kinds: Vec<ThresholdKind> = breaches.into_iter().map(|b| b.kind).collect();
    if undelivered > 0 {
        error!(
            chain_id,
            block_number,
            undelivered,
            "breach alert(s) not delivered; holding the cursor on this block so the next cycle retries them"
        );
        return Ok(CycleResult::BreachUndelivered(kinds));
    }
    Ok(CycleResult::Breached(kinds))
}

/// Submit `gateway.pauseDeposits()` once under the SLA budget. Returns `true`
/// when the transaction was submitted (or deposits were already paused).
///
/// Every failure is logged, never silent; the alert was dispatched before this
/// runs, so a hung or failing pause never starves it (WD-1).
async fn trigger_pause_once(
    config: &Config,
    client: &Client,
    chain_id: i64,
    pauser: Option<&PauserSigningKey>,
    sla: Duration,
) -> bool {
    let rpc_url = config
        .action
        .gateway_rpc_url
        .as_deref()
        .unwrap_or("")
        .to_owned();
    let gw_addr_str = config.action.gateway_address.as_deref().unwrap_or("");

    match pauser {
        Some(signer) => match parse_pause_params(
            rpc_url,
            gw_addr_str,
            signer,
            chain_id,
            config.action.pause_fee_bump_bps,
        ) {
            Ok(params) => match timeout(sla, trigger_pause(client, &params)).await {
                Ok(Ok(tx)) => {
                    info!(tx_hash = %tx, "gateway.pauseDeposits() submitted");
                    true
                }
                Ok(Err(e)) => {
                    error!("gateway.pauseDeposits() failed: {e}");
                    false
                }
                Err(_) => {
                    error!(
                        sla_secs = config.sla.max_response_secs,
                        "gateway.pauseDeposits() exceeded SLA budget; aborted (alert already dispatched)"
                    );
                    false
                }
            },
            Err(e) => {
                error!("pause params invalid: {e}");
                false
            }
        },
        // Startup validation rejects a pause mode with no key, so reaching
        // here means the caller did not thread the derived signer through.
        // Never silent: the pause simply did not happen.
        None => {
            error!(
                "action.mode includes pause but no pauser signing key was derived \
                 at startup; gateway.pauseDeposits() NOT attempted (alert already dispatched)"
            );
            false
        }
    }
}

/// Fetch the latest indexed block number for `chain_id` from `indexer_runs`.
///
/// Returns `None` if no successful run has been recorded yet.
pub async fn latest_indexed_block(
    pool: &PgPool,
    chain_id: i64,
) -> Result<Option<i64>, WatchdogError> {
    let row: Option<(Option<i64>,)> = sqlx::query_as(
        "SELECT MAX(last_indexed_block) FROM indexer_runs \
         WHERE chain_id = $1 AND error IS NULL",
    )
    .bind(chain_id)
    .fetch_optional(pool)
    .await
    .map_err(WatchdogError::Db)?;

    Ok(row.and_then(|(v,)| v))
}

/// Look up the on-chain timestamp (Unix seconds) of a single block.
///
/// Returns `None` if the indexer has not persisted a header row for that block.
pub async fn block_timestamp(
    pool: &PgPool,
    chain_id: i64,
    block_number: i64,
) -> Result<Option<i64>, WatchdogError> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT timestamp FROM blocks WHERE chain_id = $1 AND block_number = $2")
            .bind(chain_id)
            .bind(block_number)
            .fetch_optional(pool)
            .await
            .map_err(WatchdogError::Db)?;
    Ok(row.map(|(t,)| t))
}

/// Look up the on-chain timestamp of the highest persisted block for `chain_id`.
async fn latest_block_timestamp(
    pool: &PgPool,
    chain_id: i64,
) -> Result<Option<i64>, WatchdogError> {
    let row: Option<(Option<i64>,)> =
        sqlx::query_as("SELECT MAX(timestamp) FROM blocks WHERE chain_id = $1")
            .bind(chain_id)
            .fetch_optional(pool)
            .await
            .map_err(WatchdogError::Db)?;
    Ok(row.and_then(|(v,)| v))
}

/// Load the watchdog's last-processed-block cursor for `chain_id`.
///
/// Returns `None` if the watchdog has never recorded progress for this chain.
pub async fn load_cursor(pool: &PgPool, chain_id: i64) -> Result<Option<i64>, WatchdogError> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT last_processed_block FROM watchdog_cursor WHERE chain_id = $1")
            .bind(chain_id)
            .fetch_optional(pool)
            .await
            .map_err(WatchdogError::Db)?;
    Ok(row.map(|(b,)| b))
}

/// Persist the watchdog's last-processed-block cursor for `chain_id`.
///
/// Idempotent upsert keyed on `chain_id`; safe to call after every evaluated
/// block so a crash mid-range re-processes the remaining blocks rather than
/// skipping them.
pub async fn store_cursor(
    pool: &PgPool,
    chain_id: i64,
    last_processed_block: i64,
) -> Result<(), WatchdogError> {
    sqlx::query(
        "INSERT INTO watchdog_cursor (chain_id, last_processed_block, updated_at) \
         VALUES ($1, $2, now()) \
         ON CONFLICT (chain_id) DO UPDATE \
           SET last_processed_block = EXCLUDED.last_processed_block, updated_at = now()",
    )
    .bind(chain_id)
    .bind(last_processed_block)
    .execute(pool)
    .await
    .map_err(WatchdogError::Db)?;
    Ok(())
}

/// Refresh the cursor heartbeat without changing its progress position.
///
/// A no-new-block poll is still evidence that the watchdog is running and able
/// to read its database. Keeping this timestamp fresh makes quiet operation
/// distinguishable from a stopped process for the external liveness monitor.
/// [`run_cycles_since_cursor`] calls it only while the indexer is within its
/// lag budget: a quiet poll behind a stopped indexer proves nothing (DI-5).
pub async fn touch_cursor(pool: &PgPool, chain_id: i64) -> Result<(), WatchdogError> {
    sqlx::query("UPDATE watchdog_cursor SET updated_at = now() WHERE chain_id = $1")
        .bind(chain_id)
        .execute(pool)
        .await
        .map_err(WatchdogError::Db)?;
    Ok(())
}

/// Evaluate **every** block newly indexed since the watchdog's cursor, advancing
/// the cursor past each block it successfully evaluates (scan finding WD-6).
///
/// On the first run for a chain (no cursor row) the cursor is seeded at
/// `latest_indexed_block - 1`, so the latest block is evaluated exactly once and
/// the watchdog does not replay the entire indexed history.
///
/// Returns the aggregate result: `NoData` if there is nothing new to evaluate,
/// `IndexerBehind` if there is nothing new because the indexer is beyond its
/// lag budget, `BreachUndelivered` if a block's breach alert was not delivered,
/// `Breached` with the union of all kinds breached across the range, otherwise
/// `Ok`. The cursor advances block-by-block, so a mid-range error or an
/// undelivered alert leaves the remaining blocks to be retried on the next
/// cycle rather than skipped.
pub async fn run_cycles_since_cursor(
    pool: &PgPool,
    config: &Config,
    client: &Client,
    chain_id: i64,
    latest_indexed_block: i64,
    pauser: Option<&PauserSigningKey>,
) -> Result<CycleResult, WatchdogError> {
    let cursor = load_cursor(pool, chain_id).await?;
    // First run: start one below the latest indexed block so we evaluate exactly
    // that block, not the whole history.
    let from_block = cursor.map(|c| c + 1).unwrap_or(latest_indexed_block);

    if from_block > latest_indexed_block {
        // Nothing new since last cycle. That is a quiet market only while the
        // indexer keeps up (DI-5). Behind a wedged or stopped indexer it is
        // blindness, and refreshing the heartbeat here made `watchdog-liveness`
        // exit 0 while nothing was evaluated. Let the heartbeat age instead;
        // the caller pages `indexer_behind:<chain>`.
        let progress = read_indexer_progress(pool, chain_id).await?;
        if progress.is_behind(&config.indexer_lag) {
            error!(
                chain_id,
                lag_blocks = ?progress.lag_blocks,
                since_success_secs = ?progress.since_success_secs,
                last_error = ?progress.last_error,
                max_lag_blocks = config.indexer_lag.max_lag_blocks,
                max_silence_secs = config.indexer_lag.max_silence_secs,
                "no new indexed block and the explorer indexer is behind its budget; \
                 the liveness heartbeat is NOT refreshed"
            );
            return Ok(CycleResult::IndexerBehind(progress));
        }
        touch_cursor(pool, chain_id).await?;
        return Ok(CycleResult::NoData);
    }

    let mut all_kinds: Vec<ThresholdKind> = Vec::new();
    for block_number in from_block..=latest_indexed_block {
        let breached = match run_cycle(pool, config, client, chain_id, block_number, pauser).await {
            Ok(CycleResult::Breached(kinds)) => {
                merge_kinds(&mut all_kinds, kinds);
                true
            }
            Ok(CycleResult::BreachUndelivered(kinds)) => {
                // DI-7: do NOT advance past a block whose breach alert the
                // receiver has not confirmed. The next cycle re-evaluates it and
                // re-sends only what is still undelivered. Later blocks wait:
                // this block's pause went out on the first pass (and is not
                // re-sent once submitted), and the held cursor ages the
                // heartbeat, so `watchdog-liveness` pages as well.
                merge_kinds(&mut all_kinds, kinds);
                return Ok(CycleResult::BreachUndelivered(all_kinds));
            }
            Ok(CycleResult::Ok) | Ok(CycleResult::NoData) | Ok(CycleResult::IndexerBehind(_)) => {
                false
            }
            Err(e) => {
                // Do NOT advance the cursor past a block we failed to evaluate;
                // return so the next cycle retries from here.
                error!(chain_id, block_number, "cycle error mid-range: {e}");
                return Err(e);
            }
        };
        // Advance the cursor only after a successful evaluation of this block.
        store_cursor(pool, chain_id, block_number).await?;
        if breached {
            // The block is done: its per-breach delivery records only mattered
            // while it could be retried.
            let prefix = volume_breach_block_prefix(chain_id, block_number);
            if let Err(e) = clear_pager_states_with_prefix(pool, chain_id, &prefix).await {
                warn!(
                    chain_id,
                    block_number, "could not clear delivered breach records: {e}"
                );
            }
        }
    }

    if all_kinds.is_empty() {
        Ok(CycleResult::Ok)
    } else {
        Ok(CycleResult::Breached(all_kinds))
    }
}

/// Add each kind in `kinds` to `all` once.
fn merge_kinds(all: &mut Vec<ThresholdKind>, kinds: Vec<ThresholdKind>) {
    for k in kinds {
        if !all.contains(&k) {
            all.push(k);
        }
    }
}

/// Decode a per-vault config key (lowercase hex address, no `0x` prefix) to raw
/// bytes for binding against the BYTEA `vault` column.
///
/// Tolerates an optional `0x` prefix so a mis-keyed config entry still resolves.
/// Returns `None` if the key is not valid hex.
fn decode_vault_hex(vault_hex: &str) -> Option<Vec<u8>> {
    let trimmed = vault_hex.trim_start_matches("0x");
    hex::decode(trimmed).ok()
}

/// Evaluate the four per-vault thresholds for a single configured vault and push
/// any breaches (with `vault` set) onto `breaches`.
///
/// Each metric is compared against the vault's *effective* limit from
/// [`Config::per_block_mint_limit`] and siblings, which fall back to the global
/// limit when the vault omits that override. A breach is recorded only when the
/// vault's own scoped volume exceeds its effective limit.
#[allow(clippy::too_many_arguments)]
async fn evaluate_vault_breaches(
    pool: &PgPool,
    config: &Config,
    chain_id: i64,
    block_number: i64,
    now_unix: i64,
    vault_hex: &str,
    vault_bytes: &[u8],
    breaches: &mut Vec<BreachEvent>,
) -> Result<(), WatchdogError> {
    let mint_block =
        mint_volume_per_block_for_vault(pool, chain_id, block_number, vault_bytes).await?;
    let mint_hour =
        mint_volume_per_hour_for_vault(pool, chain_id, now_unix, HOUR_WINDOW_SECS, vault_bytes)
            .await?;
    let burn_block =
        burn_volume_per_block_for_vault(pool, chain_id, block_number, vault_bytes).await?;
    let burn_hour =
        burn_volume_per_hour_for_vault(pool, chain_id, now_unix, HOUR_WINDOW_SECS, vault_bytes)
            .await?;

    let checks = [
        (
            ThresholdKind::PerBlockMint,
            mint_block,
            config.per_block_mint_limit(vault_hex),
        ),
        (
            ThresholdKind::PerHourMint,
            mint_hour,
            config.per_hour_mint_limit(vault_hex),
        ),
        (
            ThresholdKind::PerBlockBurn,
            burn_block,
            config.per_block_burn_limit(vault_hex),
        ),
        (
            ThresholdKind::PerHourBurn,
            burn_hour,
            config.per_hour_burn_limit(vault_hex),
        ),
    ];

    for (kind, volume, limit) in checks {
        if volume > limit {
            warn!(
                chain_id,
                block_number,
                vault = %vault_hex,
                volume,
                threshold = limit,
                kind = kind.label(),
                "per-vault threshold breached"
            );
            breaches.push(BreachEvent {
                kind,
                threshold_usdc: limit,
                volume_usdc: volume,
                chain_id,
                block_number,
                vault: Some(vault_hex.to_owned()),
            });
        }
    }

    Ok(())
}

/// Parse and validate the gateway pause parameters from config strings.
///
/// Takes the startup-derived signing state by reference; no key material is
/// decoded here, so a breach cycle never touches raw secret bytes.
fn parse_pause_params<'a>(
    rpc_url: String,
    gw_addr_str: &str,
    signer: &'a PauserSigningKey,
    chain_id: i64,
    fee_bump_bps: u64,
) -> Result<PauseParams<'a>, WatchdogError> {
    use alloy_primitives::Address;
    use std::str::FromStr;

    let gateway_address = Address::from_str(gw_addr_str).map_err(|e| {
        WatchdogError::Pause(format!("invalid gateway address {gw_addr_str:?}: {e}"))
    })?;

    Ok(PauseParams {
        rpc_url,
        gateway_address,
        chain_id: chain_id as u64,
        signer,
        fee_bump_bps,
    })
}
