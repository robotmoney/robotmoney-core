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
//!    `direction = 'deposit'`, net of the deposits sources 1 and 2 already count
//!    (IDX-4). Every gateway or router deposit *also* emits an ERC-4626 `Deposit`
//!    log from the vault it lands in, so per (transaction, vault) this source
//!    counts only what the vault's `Deposit` events exceed the transaction's
//!    single-vault gateway deposits and router legs to that vault by
//!    ([`DIRECT_DEPOSITS_NET`]), never below zero.
//!
//!    A direct `PortfolioRouter.deposit` / `depositFor` (public, no gateway) has
//!    no `agent_deposits` row, but each leg's vault `Deposit` is already a
//!    `router_deposit_legs` row. Without the netting a 501 USDC router deposit
//!    counted 1002 and tripped a 1000 USDC per-block pause (security round 1).
//!
//!    Netting per (transaction, vault), rather than dropping every `Deposit` of a
//!    transaction that holds a gateway deposit or a router leg, keeps a large
//!    direct deposit visible when it is batched with a small gateway or router
//!    deposit in one transaction. Security round 2: a contract or EIP-7702 agent
//!    batched `gateway.deposit(1 USDC)` with `vault.deposit(5,000,000 USDC)`, the
//!    old transaction-level `NOT EXISTS (agent_deposits)` dropped both `Deposit`
//!    rows, and mint volume read 1 USDC. The gateway deposits into its own pinned
//!    vault only (`RobotMoneyGateway._validateDestination`), so the indexer's
//!    `agent_deposits.vault` names the vault whose `Deposit` it nets.
//!
//! # Per-hour window: `[ts(X) - window, X]`
//!
//! A per-hour query sums the blocks after [`block_before_window`] up to and
//! including the evaluated block `X`, never past it. Security round 3: the
//! window used to be open at the top, so while the watchdog caught up on a
//! backlog (a DI-7 held cursor, an `IndexerBehind` stretch, a restart) the
//! per-hour sum of block `X` held every indexed block after `X` as well. With
//! a 3 hour backlog, each backlog block read about 3 hours of volume, breached
//! `PerHourMint`, paged its own incident and sent `pauseDeposits`, which only a
//! 48 h timelock operation undoes.
//!
//! # Cost: bounded by the window, not by history
//!
//! Every source is restricted to the evaluated block (per-block queries) or to
//! the blocks in `(block_before_window, X]` (per-hour queries) **before** it is
//! grouped, and the netting joins pre-aggregated legs and gateway deposits of
//! those same blocks. A transaction's logs share one block, so nothing is lost.
//! Security round 2: the round-1 netting was a correlated subquery run once per
//! (transaction, vault) of the whole chain history, each run scanning every leg
//! of that vault. At 20,000 router deposits the per-hour query took 37.8 s, and
//! the watchdog runs it for every Base block (2 s), so it fell ever further
//! behind the head while its heartbeat stayed fresh. The upper bound at `X`
//! keeps a catch-up evaluation to one window too: without it each backlog
//! block scanned the window plus the whole backlog after it.
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

/// The direct ERC-4626 deposit source, as `(chain_id, block_number, amount)` rows: per
/// (chain, block, transaction, vault), the vault's `Deposit` assets less the single-vault gateway
/// deposits (`agent_deposits`, `vault` NOT NULL) and the router legs (`router_deposit_legs`) that
/// transaction made to that vault, never below zero.
///
/// `$FILTER` (SQL over the alias `t`, starting with `AND`) is spliced into all three sources, so
/// each is cut to the evaluated block or window before it is grouped. Every source table carries
/// `chain_id`, `block_number` and `vault`, and the three are joined on the block as well as the
/// transaction, so the filter must name only those columns.
///
/// A gateway deposit and a `PortfolioRouter.deposit` leg each call `vault.deposit(amount)`, so the
/// vault's `Deposit` carries exactly that amount and a gateway-only or router-only transaction nets
/// to zero. A direct deposit to the same vault in that transaction stays counted.
const DIRECT_DEPOSITS_NET: &str = "\
    SELECT d.chain_id, d.block_number, \
           GREATEST(d.assets - COALESCE(rl.amount, 0) - COALESCE(ad.amount, 0), 0) AS amount \
      FROM ( \
        SELECT t.chain_id, t.block_number, t.tx_hash, t.vault, SUM(t.assets) AS assets \
          FROM vault_transfer_events t \
         WHERE t.direction = 'deposit' $FILTER \
         GROUP BY t.chain_id, t.block_number, t.tx_hash, t.vault \
      ) d \
      LEFT JOIN ( \
        SELECT t.chain_id, t.block_number, t.tx_hash, t.vault, SUM(t.amount) AS amount \
          FROM router_deposit_legs t \
         WHERE TRUE $FILTER \
         GROUP BY t.chain_id, t.block_number, t.tx_hash, t.vault \
      ) rl ON rl.chain_id = d.chain_id AND rl.block_number = d.block_number \
          AND rl.tx_hash = d.tx_hash AND rl.vault = d.vault \
      LEFT JOIN ( \
        SELECT t.chain_id, t.block_number, t.tx_hash, t.vault, SUM(t.amount) AS amount \
          FROM agent_deposits t \
         WHERE t.vault IS NOT NULL $FILTER \
         GROUP BY t.chain_id, t.block_number, t.tx_hash, t.vault \
      ) ad ON ad.chain_id = d.chain_id AND ad.block_number = d.block_number \
          AND ad.tx_hash = d.tx_hash AND ad.vault = d.vault";

/// The three mint sources of the module docs as `(chain_id, block_number, amount)` rows, each
/// restricted by `filter` (SQL over the alias `t`, starting with `AND`) before anything is summed.
fn mint_sources(filter: &str) -> String {
    format!(
        "SELECT t.chain_id, t.block_number, t.amount FROM agent_deposits t \
           WHERE t.vault IS NOT NULL {filter} \
         UNION ALL \
         SELECT t.chain_id, t.block_number, t.amount FROM router_deposit_legs t \
           WHERE TRUE {filter} \
         UNION ALL \
         {}",
        DIRECT_DEPOSITS_NET.replace("$FILTER", filter)
    )
}

/// The newest indexed block on `chain_id` at or below `until_block` whose timestamp is before
/// `since`, or `-1` when there is none. Block timestamps rise with the block number, so every block
/// after it, up to `until_block`, is in the window.
///
/// The per-hour queries filter each source on `block_number > ` this and `<= until_block` before
/// grouping, so their cost follows the window, not the chain's history (security round 2) nor the
/// backlog above the evaluated block (security round 3). It walks the `blocks` primary key down
/// from `until_block` and stops at the first block older than the window.
pub async fn block_before_window(
    pool: &PgPool,
    chain_id: i64,
    until_block: i64,
    since: i64,
) -> Result<i64, WatchdogError> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT block_number FROM blocks \
         WHERE chain_id = $1 AND block_number <= $2 AND timestamp < $3 \
         ORDER BY block_number DESC LIMIT 1",
    )
    .bind(chain_id)
    .bind(until_block)
    .bind(since)
    .fetch_optional(pool)
    .await
    .map_err(WatchdogError::Db)?;
    Ok(row.map_or(-1, |(b,)| b))
}

/// Compute the total mint (deposit) volume for a single block, in USDC base units.
///
/// Sums the three non-overlapping deposit sources documented at the module level:
/// non-routed `agent_deposits` (vault NOT NULL), every `router_deposit_legs` row,
/// and direct ERC-4626 deposits (`vault_transfer_events` deposits net of the gateway
/// deposits and router legs of the same transaction and vault). Each deposit
/// contributes its amount exactly once.
pub async fn mint_volume_per_block(
    pool: &PgPool,
    chain_id: i64,
    block_number: i64,
) -> Result<u128, WatchdogError> {
    let sql = format!(
        "SELECT COALESCE(SUM(amount), 0) FROM ({}) sub",
        mint_sources("AND t.chain_id = $1 AND t.block_number = $2")
    );
    let row: (Option<bigdecimal::BigDecimal>,) = sqlx::query_as(&sql)
        .bind(chain_id)
        .bind(block_number)
        .fetch_one(pool)
        .await
        .map_err(WatchdogError::Db)?;

    Ok(decimal_to_u128(row.0))
}

/// Compute the rolling per-hour mint (deposit) volume, in USDC base units.
///
/// Sums `amount` for all deposits in blocks up to and including `block_number` (the evaluated
/// block) whose `timestamp` (Unix seconds) is within the last `window_secs` seconds relative to
/// `now_unix`. A block after `block_number` is never counted, even when it is already indexed
/// (security round 3, see the module docs).
pub async fn mint_volume_per_hour(
    pool: &PgPool,
    chain_id: i64,
    block_number: i64,
    now_unix: i64,
    window_secs: i64,
) -> Result<u128, WatchdogError> {
    let since = now_unix - window_secs;
    let after_block = block_before_window(pool, chain_id, block_number, since).await?;
    let sql = format!(
        "SELECT COALESCE(SUM(d.amount), 0) \
         FROM ({}) d \
         JOIN blocks b ON b.chain_id = d.chain_id AND b.block_number = d.block_number \
         WHERE b.timestamp >= $2",
        mint_sources("AND t.chain_id = $1 AND t.block_number > $3 AND t.block_number <= $4")
    );
    let row: (Option<bigdecimal::BigDecimal>,) = sqlx::query_as(&sql)
        .bind(chain_id)
        .bind(since)
        .bind(after_block)
        .bind(block_number)
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
///
/// Cut to the blocks in `(block_before_window, block_number]` before the join, like the mint
/// queries, so a block after the evaluated `block_number` is never counted.
pub async fn burn_volume_per_hour(
    pool: &PgPool,
    chain_id: i64,
    block_number: i64,
    now_unix: i64,
    window_secs: i64,
) -> Result<u128, WatchdogError> {
    let since = now_unix - window_secs;
    let after_block = block_before_window(pool, chain_id, block_number, since).await?;
    let row: (Option<bigdecimal::BigDecimal>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(v.assets), 0) \
         FROM vault_transfer_events v \
         JOIN blocks b ON b.chain_id = v.chain_id AND b.block_number = v.block_number \
         WHERE v.chain_id = $1 AND b.timestamp >= $2 AND v.direction = 'withdrawal' \
           AND v.block_number > $3 AND v.block_number <= $4",
    )
    .bind(chain_id)
    .bind(since)
    .bind(after_block)
    .bind(block_number)
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
/// ERC-4626 source nets per (transaction, vault), so the deduplication against
/// gateway and router deposits is unchanged.
pub async fn mint_volume_per_block_for_vault(
    pool: &PgPool,
    chain_id: i64,
    block_number: i64,
    vault: &[u8],
) -> Result<u128, WatchdogError> {
    let sql = format!(
        "SELECT COALESCE(SUM(amount), 0) FROM ({}) sub",
        mint_sources("AND t.chain_id = $1 AND t.block_number = $2 AND t.vault = $3")
    );
    let row: (Option<bigdecimal::BigDecimal>,) = sqlx::query_as(&sql)
        .bind(chain_id)
        .bind(block_number)
        .bind(vault)
        .fetch_one(pool)
        .await
        .map_err(WatchdogError::Db)?;

    Ok(decimal_to_u128(row.0))
}

/// Compute the rolling per-hour mint (deposit) volume scoped to one `vault`, over the same
/// `[now_unix - window_secs, block_number]` window as [`mint_volume_per_hour`].
pub async fn mint_volume_per_hour_for_vault(
    pool: &PgPool,
    chain_id: i64,
    block_number: i64,
    now_unix: i64,
    window_secs: i64,
    vault: &[u8],
) -> Result<u128, WatchdogError> {
    let since = now_unix - window_secs;
    let after_block = block_before_window(pool, chain_id, block_number, since).await?;
    let sql = format!(
        "SELECT COALESCE(SUM(d.amount), 0) \
         FROM ({}) d \
         JOIN blocks b ON b.chain_id = d.chain_id AND b.block_number = d.block_number \
         WHERE b.timestamp >= $2",
        mint_sources(
            "AND t.chain_id = $1 AND t.block_number > $3 AND t.block_number <= $4 \
             AND t.vault = $5"
        )
    );
    let row: (Option<bigdecimal::BigDecimal>,) = sqlx::query_as(&sql)
        .bind(chain_id)
        .bind(since)
        .bind(after_block)
        .bind(block_number)
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

/// Compute the rolling per-hour burn (withdrawal) volume scoped to one `vault`, over the same
/// `[now_unix - window_secs, block_number]` window as [`burn_volume_per_hour`].
pub async fn burn_volume_per_hour_for_vault(
    pool: &PgPool,
    chain_id: i64,
    block_number: i64,
    now_unix: i64,
    window_secs: i64,
    vault: &[u8],
) -> Result<u128, WatchdogError> {
    let since = now_unix - window_secs;
    let after_block = block_before_window(pool, chain_id, block_number, since).await?;
    let row: (Option<bigdecimal::BigDecimal>,) = sqlx::query_as(
        "SELECT COALESCE(SUM(v.assets), 0) \
         FROM vault_transfer_events v \
         JOIN blocks b ON b.chain_id = v.chain_id AND b.block_number = v.block_number \
         WHERE v.chain_id = $1 AND b.timestamp >= $2 AND v.vault = $3 \
           AND v.direction = 'withdrawal' AND v.block_number > $4 AND v.block_number <= $5",
    )
    .bind(chain_id)
    .bind(since)
    .bind(vault)
    .bind(after_block)
    .bind(block_number)
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
