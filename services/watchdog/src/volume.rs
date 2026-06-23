//! Rolling mint/burn volume aggregation queries.
//!
//! Canonical: docs/technical/security-model.md §9
//!
//! # Mint (deposit) volume — three non-overlapping sources
//!
//! Mint volume sums exactly three classes of deposit so each deposit contributes
//! its amount **once** (issue #990, scan findings IDX-4 / IDX-7):
//!
//! 1. **Single-vault gateway deposits** — `agent_deposits` rows with a non-NULL
//!    `vault` (the gateway pins one vault). The routed-deposit *parent* row carries
//!    `vault IS NULL` and is excluded here because its full `amount` is already
//!    captured leg-by-leg in `router_deposit_legs`; counting both double-counted
//!    routed mints ~2× (IDX-7).
//! 2. **Routed deposit legs** — every `router_deposit_legs` row (one per vault in
//!    the router weight vector).
//! 3. **Direct ERC-4626 deposits** — `vault_transfer_events` rows with
//!    `direction = 'deposit'` whose `tx_hash` has **no** `agent_deposits` row, i.e.
//!    a depositor who called `vault.deposit()` directly rather than through the
//!    gateway (IDX-4). Every gateway/router deposit *also* emits an ERC-4626
//!    `Deposit` log, so the `tx_hash NOT IN (agent_deposits)` filter is what keeps
//!    those gateway-originated vault events from being counted twice.
//!
//! # Burn (withdrawal) volume
//!
//! Burn volume reads `vault_transfer_events` rows with `direction = 'withdrawal'`
//! (written by the indexer's merged `erc4626_withdraw` branch, issue #989,
//! migration 0008). The `'withdrawal'` literal is a cross-crate contract shared
//! with the indexer writer — keep them lock-step.
//!
//! All amounts are stored as `NUMERIC(78, 0)` (USDC base units, 6 decimals) and
//! returned as `u128`; USDC supply is well within range at the precision of
//! interest.

use bigdecimal::ToPrimitive;
use sqlx::postgres::PgPool;

use crate::WatchdogError;

/// Compute the total mint (deposit) volume for a single block, in USDC base units.
///
/// Sums the three non-overlapping deposit sources documented at the module level:
/// non-routed `agent_deposits` (vault NOT NULL), every `router_deposit_legs` row,
/// and direct ERC-4626 deposits (`vault_transfer_events` deposits with no
/// matching `agent_deposits` tx). Each deposit contributes its amount exactly once.
pub async fn mint_volume_per_block(
    pool: &PgPool,
    chain_id: i64,
    block_number: i64,
) -> Result<u128, WatchdogError> {
    let row: (Option<bigdecimal::BigDecimal>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(amount), 0) \
         FROM ( \
           SELECT amount FROM agent_deposits \
             WHERE chain_id = $1 AND block_number = $2 AND vault IS NOT NULL \
           UNION ALL \
           SELECT amount FROM router_deposit_legs \
             WHERE chain_id = $1 AND block_number = $2 \
           UNION ALL \
           SELECT vte.assets AS amount FROM vault_transfer_events vte \
             WHERE vte.chain_id = $1 AND vte.block_number = $2 \
               AND vte.direction = 'deposit' \
               AND NOT EXISTS ( \
                 SELECT 1 FROM agent_deposits ad \
                 WHERE ad.chain_id = vte.chain_id AND ad.tx_hash = vte.tx_hash \
               ) \
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
             WHERE vault IS NOT NULL \
           UNION ALL \
           SELECT chain_id, block_number, amount FROM router_deposit_legs \
           UNION ALL \
           SELECT vte.chain_id, vte.block_number, vte.assets AS amount \
             FROM vault_transfer_events vte \
             WHERE vte.direction = 'deposit' \
               AND NOT EXISTS ( \
                 SELECT 1 FROM agent_deposits ad \
                 WHERE ad.chain_id = vte.chain_id AND ad.tx_hash = vte.tx_hash \
               ) \
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

// ---- Per-vault variants (issue #1023, scan finding WD-4) -------------------
//
// The global functions above sum across *all* vaults; the four functions below
// scope every aggregation to a single `vault` address (the BYTEA `vault` column
// each source table already carries) so a per-vault threshold can be evaluated
// without one vault's volume diluting into the all-vault total. A spike confined
// to one vault is therefore visible to that vault's (potentially tighter) limit
// even while the global aggregate stays under the global cap.

/// Compute the mint (deposit) volume for a single block, scoped to one `vault`.
///
/// Same three non-overlapping deposit sources as [`mint_volume_per_block`], each
/// additionally filtered to rows whose `vault` column equals `vault`. The direct
/// ERC-4626 leg keys off `vault_transfer_events.vault`, so the deduplication
/// against gateway-originated deposits is unchanged.
pub async fn mint_volume_per_block_for_vault(
    pool: &PgPool,
    chain_id: i64,
    block_number: i64,
    vault: &[u8],
) -> Result<u128, WatchdogError> {
    let row: (Option<bigdecimal::BigDecimal>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(amount), 0) \
         FROM ( \
           SELECT amount FROM agent_deposits \
             WHERE chain_id = $1 AND block_number = $2 AND vault = $3 \
           UNION ALL \
           SELECT amount FROM router_deposit_legs \
             WHERE chain_id = $1 AND block_number = $2 AND vault = $3 \
           UNION ALL \
           SELECT vte.assets AS amount FROM vault_transfer_events vte \
             WHERE vte.chain_id = $1 AND vte.block_number = $2 \
               AND vte.vault = $3 \
               AND vte.direction = 'deposit' \
               AND NOT EXISTS ( \
                 SELECT 1 FROM agent_deposits ad \
                 WHERE ad.chain_id = vte.chain_id AND ad.tx_hash = vte.tx_hash \
               ) \
         ) sub",
    )
    .bind(chain_id)
    .bind(block_number)
    .bind(vault)
    .fetch_one(pool)
    .await
    .map_err(WatchdogError::Db)?;

    Ok(decimal_to_u128(row.0))
}

/// Compute the rolling per-hour mint (deposit) volume scoped to one `vault`.
pub async fn mint_volume_per_hour_for_vault(
    pool: &PgPool,
    chain_id: i64,
    now_unix: i64,
    window_secs: i64,
    vault: &[u8],
) -> Result<u128, WatchdogError> {
    let since = now_unix - window_secs;
    let row: (Option<bigdecimal::BigDecimal>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(d.amount), 0) \
         FROM ( \
           SELECT chain_id, block_number, amount FROM agent_deposits \
             WHERE vault = $3 \
           UNION ALL \
           SELECT chain_id, block_number, amount FROM router_deposit_legs \
             WHERE vault = $3 \
           UNION ALL \
           SELECT vte.chain_id, vte.block_number, vte.assets AS amount \
             FROM vault_transfer_events vte \
             WHERE vte.vault = $3 AND vte.direction = 'deposit' \
               AND NOT EXISTS ( \
                 SELECT 1 FROM agent_deposits ad \
                 WHERE ad.chain_id = vte.chain_id AND ad.tx_hash = vte.tx_hash \
               ) \
         ) d \
         JOIN blocks b ON b.chain_id = d.chain_id AND b.block_number = d.block_number \
         WHERE d.chain_id = $1 AND b.timestamp >= $2",
    )
    .bind(chain_id)
    .bind(since)
    .bind(vault)
    .fetch_one(pool)
    .await
    .map_err(WatchdogError::Db)?;

    Ok(decimal_to_u128(row.0))
}

/// Compute the burn (withdrawal) volume for a single block, scoped to one `vault`.
pub async fn burn_volume_per_block_for_vault(
    pool: &PgPool,
    chain_id: i64,
    block_number: i64,
    vault: &[u8],
) -> Result<u128, WatchdogError> {
    let row: (Option<bigdecimal::BigDecimal>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(assets), 0) \
         FROM vault_transfer_events \
         WHERE chain_id = $1 AND block_number = $2 AND vault = $3 \
           AND direction = 'withdrawal'",
    )
    .bind(chain_id)
    .bind(block_number)
    .bind(vault)
    .fetch_one(pool)
    .await
    .map_err(WatchdogError::Db)?;

    Ok(decimal_to_u128(row.0))
}

/// Compute the rolling per-hour burn (withdrawal) volume scoped to one `vault`.
pub async fn burn_volume_per_hour_for_vault(
    pool: &PgPool,
    chain_id: i64,
    now_unix: i64,
    window_secs: i64,
    vault: &[u8],
) -> Result<u128, WatchdogError> {
    let since = now_unix - window_secs;
    let row: (Option<bigdecimal::BigDecimal>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(v.assets), 0) \
         FROM vault_transfer_events v \
         JOIN blocks b ON b.chain_id = v.chain_id AND b.block_number = v.block_number \
         WHERE v.chain_id = $1 AND b.timestamp >= $2 AND v.vault = $3 \
           AND v.direction = 'withdrawal'",
    )
    .bind(chain_id)
    .bind(since)
    .bind(vault)
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
