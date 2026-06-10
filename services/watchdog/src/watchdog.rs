//! Core watchdog loop: poll indexed volume data, compare against thresholds, and
//! trigger the configured action on breach.
//!
//! Canonical: docs/technical/security-model.md §9
//!
//! # Cycle
//!
//! 1. Determine the latest indexed block from `indexer_runs`.
//! 2. Query per-block mint/burn volume for that block.
//! 3. Query rolling per-hour mint/burn volume.
//! 4. Compare each metric against the global thresholds from [`Config`].
//! 5. On breach: dispatch pause and/or alert according to `action.mode`.
//! 6. Sleep for `poll_interval_secs` and repeat.
//!
//! The watchdog does NOT exit on a breach — it continues polling to catch
//! subsequent breaches and to log that the gateway remains paused.

use chrono::Utc;
use reqwest::Client;
use sqlx::postgres::PgPool;
use tracing::{error, info, warn};

use crate::{
    alert::{dispatch_alert, BreachEvent, ThresholdKind},
    config::Config,
    pause::{trigger_pause, PauseParams},
    volume::{
        burn_volume_per_block, burn_volume_per_hour, mint_volume_per_block, mint_volume_per_hour,
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
}

/// Run a single watchdog cycle against the given `block_number`.
///
/// Exposed as a free function so integration tests can drive individual cycles
/// deterministically without a real timer loop.
pub async fn run_cycle(
    pool: &PgPool,
    config: &Config,
    client: &Client,
    chain_id: i64,
    block_number: i64,
) -> Result<CycleResult, WatchdogError> {
    let now_unix = Utc::now().timestamp();

    // --- Compute volumes ---
    let mint_block = mint_volume_per_block(pool, chain_id, block_number).await?;
    let mint_hour = mint_volume_per_hour(pool, chain_id, now_unix, 3600).await?;
    let burn_block = burn_volume_per_block(pool, chain_id, block_number).await?;
    let burn_hour = burn_volume_per_hour(pool, chain_id, now_unix, 3600).await?;

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
    let mode = config.action.mode;

    if mode.includes_pause() {
        let rpc_url = config
            .action
            .gateway_rpc_url
            .as_deref()
            .unwrap_or("")
            .to_owned();
        let gw_addr_str = config.action.gateway_address.as_deref().unwrap_or("");
        let key_hex = config
            .action
            .pauser_private_key_hex
            .as_deref()
            .unwrap_or("");

        match parse_pause_params(rpc_url, gw_addr_str, key_hex, chain_id) {
            Ok(params) => match trigger_pause(client, &params).await {
                Ok(tx) => info!(tx_hash = %tx, "gateway.pause() submitted"),
                Err(e) => error!("gateway.pause() failed: {e}"),
            },
            Err(e) => error!("pause params invalid: {e}"),
        }
    }

    if mode.includes_alert() {
        if let Some(webhook_url) = &config.action.webhook_url {
            for event in &breaches {
                if let Err(e) = dispatch_alert(client, webhook_url, event).await {
                    error!("alert dispatch failed: {e}");
                }
            }
        }
    }

    let kinds: Vec<ThresholdKind> = breaches.into_iter().map(|b| b.kind).collect();
    Ok(CycleResult::Breached(kinds))
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

/// Parse and validate the gateway pause parameters from config strings.
fn parse_pause_params(
    rpc_url: String,
    gw_addr_str: &str,
    key_hex: &str,
    chain_id: i64,
) -> Result<PauseParams, WatchdogError> {
    use alloy_primitives::Address;
    use std::str::FromStr;

    let gateway_address = Address::from_str(gw_addr_str).map_err(|e| {
        WatchdogError::Pause(format!("invalid gateway address {gw_addr_str:?}: {e}"))
    })?;

    let key_hex = key_hex.trim_start_matches("0x");
    if key_hex.len() != 64 {
        return Err(WatchdogError::Pause(format!(
            "pauser_private_key_hex must be 32 bytes (64 hex chars), got {} chars",
            key_hex.len()
        )));
    }
    let mut key_bytes = [0u8; 32];
    hex::decode_to_slice(key_hex, &mut key_bytes)
        .map_err(|e| WatchdogError::Pause(format!("pauser key decode failed: {e}")))?;

    Ok(PauseParams {
        rpc_url,
        gateway_address,
        chain_id: chain_id as u64,
        pauser_key: key_bytes,
    })
}
