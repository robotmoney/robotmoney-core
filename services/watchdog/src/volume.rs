//! Rolling mint/burn volume aggregation queries.
//!
//! Canonical: docs/technical/security-model.md §9
//!
//! Queries the `agent_deposits` and `router_deposit_legs` tables (written by the
//! explorer-indexer) to compute:
//!
//! - **Per-block** mint volume: sum of `amount` on `agent_deposits` / `router_deposit_legs`
//!   for a specific `block_number`.
//! - **Per-hour** mint volume: sum of `amount` on the same tables for any block whose
//!   on-chain `timestamp` falls within the last 3600 seconds.
//!
//! Burn (withdrawal) volume is tracked via `vault_transfer_events` rows with
//! `direction = 'withdrawal'` (written by issue #675, migration 0008).
//!
//! All amounts are stored as `NUMERIC(78, 0)` (USDC base units, 6 decimals).  The
//! queries return `BIGINT` via `SUM(amount)::BIGINT`; values fit because USDC supply
//! is well within i64 range at the precision of interest.

use bigdecimal::ToPrimitive;
use sqlx::postgres::PgPool;

use crate::WatchdogError;

/// Compute the total mint (deposit) volume for a single block, in USDC base units.
///
/// Sums `amount` from both `agent_deposits` and `router_deposit_legs` for the given
/// `chain_id` and `block_number`.
pub async fn mint_volume_per_block(
    pool: &PgPool,
    chain_id: i64,
    block_number: i64,
) -> Result<u128, WatchdogError> {
    // agent_deposits.amount + router_deposit_legs.amount for this block.
    let row: (Option<bigdecimal::BigDecimal>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(amount), 0) \
         FROM ( \
           SELECT amount FROM agent_deposits \
             WHERE chain_id = $1 AND block_number = $2 \
           UNION ALL \
           SELECT amount FROM router_deposit_legs \
             WHERE chain_id = $1 AND block_number = $2 \
         ) sub",
    )
    .bind(chain_id)
    .bind(block_number)
    .fetch_one(pool)
    .await
    .map_err(WatchdogError::Db)?;

    Ok(decimal_to_u128(row.0))
}

/// Compute the rolling per-hour mint (deposit) volume, in USDC base units.
///
/// Sums `amount` for all deposits in blocks whose `timestamp` (Unix seconds) is
/// within the last `window_secs` seconds relative to `now_unix`.
pub async fn mint_volume_per_hour(
    pool: &PgPool,
    chain_id: i64,
    now_unix: i64,
    window_secs: i64,
) -> Result<u128, WatchdogError> {
    let since = now_unix - window_secs;
    let row: (Option<bigdecimal::BigDecimal>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(d.amount), 0) \
         FROM ( \
           SELECT chain_id, block_number, amount FROM agent_deposits \
           UNION ALL \
           SELECT chain_id, block_number, amount FROM router_deposit_legs \
         ) d \
         JOIN blocks b ON b.chain_id = d.chain_id AND b.block_number = d.block_number \
         WHERE d.chain_id = $1 AND b.timestamp >= $2",
    )
    .bind(chain_id)
    .bind(since)
    .fetch_one(pool)
    .await
    .map_err(WatchdogError::Db)?;

    Ok(decimal_to_u128(row.0))
}

/// Compute the total burn (withdrawal/redeem) volume for a single block, in USDC base units.
///
/// Reads `vault_transfer_events` rows with `direction = 'withdrawal'`.
pub async fn burn_volume_per_block(
    pool: &PgPool,
    chain_id: i64,
    block_number: i64,
) -> Result<u128, WatchdogError> {
    let row: (Option<bigdecimal::BigDecimal>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(assets), 0) \
         FROM vault_transfer_events \
         WHERE chain_id = $1 AND block_number = $2 AND direction = 'withdrawal'",
    )
    .bind(chain_id)
    .bind(block_number)
    .fetch_one(pool)
    .await
    .map_err(WatchdogError::Db)?;

    Ok(decimal_to_u128(row.0))
}

/// Compute the rolling per-hour burn (withdrawal/redeem) volume, in USDC base units.
pub async fn burn_volume_per_hour(
    pool: &PgPool,
    chain_id: i64,
    now_unix: i64,
    window_secs: i64,
) -> Result<u128, WatchdogError> {
    let since = now_unix - window_secs;
    let row: (Option<bigdecimal::BigDecimal>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(v.assets), 0) \
         FROM vault_transfer_events v \
         JOIN blocks b ON b.chain_id = v.chain_id AND b.block_number = v.block_number \
         WHERE v.chain_id = $1 AND b.timestamp >= $2 AND v.direction = 'withdrawal'",
    )
    .bind(chain_id)
    .bind(since)
    .fetch_one(pool)
    .await
    .map_err(WatchdogError::Db)?;

    Ok(decimal_to_u128(row.0))
}

/// Convert an `Option<BigDecimal>` (COALESCE result) to `u128`.
///
/// Returns `0` on `None` or values that do not fit.
fn decimal_to_u128(v: Option<bigdecimal::BigDecimal>) -> u128 {
    v.and_then(|d| d.to_u128()).unwrap_or(0)
}
