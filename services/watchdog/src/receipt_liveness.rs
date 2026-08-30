//! Consensus-receipt liveness monitoring (issue #1247 task 4.13).
//!
//! Canonical: `docs/architecture.md` §4.9 — Consensus Rebalance Receipt Contract
//! Canonical: `docs/technical/consensus-receipt-submitter-runbook.md` §5.3
//!
//! # Why this exists
//!
//! From the product proposal §2.1: *"A missing receipt is a product defect, not
//! an ops hiccup. If a session that should have produced a receipt silently
//! produces none, the record has a hole in exactly the place someone would look
//! for suppression."* The on-chain anchor exists to make the committee's record
//! censorship-resistant; a gap in it that nobody notices defeats the point.
//!
//! # What this can and cannot see
//!
//! `robotmoney-core` has **no visibility into swarm session state** — sessions
//! live in `robotmoney-frontend`. So this monitor cannot name the specific
//! session that went missing. What it can see, and what actually catches
//! suppression, is the *observable consequence*: the committee publishes on a
//! cadence, so an anchoring gap materially longer than that cadence means at
//! least one session that should have produced a receipt did not.
//!
//! Two deliberate limits, stated rather than hidden:
//!
//! - **Cold start is not alertable.** With no receipt ever anchored on a chain
//!   there is no cadence to be late against, so the monitor stays quiet until
//!   the first receipt lands. A never-started publisher is a deployment
//!   question, not a suppression signal.
//! - **This never pauses the gateway.** It is a separate path from
//!   [`crate::watchdog::run_cycle`] precisely so a quiet swarm can never trip
//!   the protocol's mint/burn pause. The response to a missing receipt is a
//!   page, never a halt.

use serde::Deserialize;
use sqlx::PgPool;

use crate::WatchdogError;

/// Default publishing cadence assumed for the committee, in seconds (24 h).
pub const DEFAULT_EXPECTED_CADENCE_SECS: u64 = 86_400;

/// Default grace period added to the cadence before paging, in seconds (6 h).
/// Absorbs a late session or a slow chain without masking a real gap.
pub const DEFAULT_GRACE_SECS: u64 = 21_600;

/// Configuration for the consensus-receipt liveness monitor.
///
/// Loaded from the optional `[consensus_receipts]` TOML section. Absent means
/// disabled, so every existing watchdog config keeps parsing unchanged.
#[derive(Debug, Clone, Deserialize)]
pub struct ReceiptLivenessConfig {
    /// Whether the monitor runs at all. Defaults to `false`.
    #[serde(default)]
    pub enabled: bool,
    /// Expected seconds between anchored receipts.
    #[serde(default = "default_expected_cadence_secs")]
    pub expected_cadence_secs: u64,
    /// Extra seconds tolerated on top of the cadence before paging.
    #[serde(default = "default_grace_secs")]
    pub grace_secs: u64,
}

fn default_expected_cadence_secs() -> u64 {
    DEFAULT_EXPECTED_CADENCE_SECS
}

fn default_grace_secs() -> u64 {
    DEFAULT_GRACE_SECS
}

impl Default for ReceiptLivenessConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            expected_cadence_secs: DEFAULT_EXPECTED_CADENCE_SECS,
            grace_secs: DEFAULT_GRACE_SECS,
        }
    }
}

impl ReceiptLivenessConfig {
    /// Total seconds allowed between anchored receipts before paging.
    pub fn budget_secs(&self) -> u64 {
        self.expected_cadence_secs.saturating_add(self.grace_secs)
    }

    /// Reject a nonsensical configuration rather than silently disabling the
    /// control — a zero cadence would page on every poll.
    pub fn validate(&self) -> Result<(), WatchdogError> {
        if self.enabled && self.expected_cadence_secs == 0 {
            return Err(WatchdogError::Config(
                "consensus_receipts.expected_cadence_secs must be non-zero when enabled".into(),
            ));
        }
        Ok(())
    }
}

/// A publishing gap long enough to mean a session that should have produced a
/// receipt did not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingReceiptEvent {
    /// Chain the gap was observed on.
    pub chain_id: i64,
    /// Unix seconds of the most recently anchored receipt.
    pub last_recorded_at: i64,
    /// Unix seconds at evaluation time.
    pub now: i64,
    /// Observed gap in seconds.
    pub seconds_since: i64,
    /// Configured cadence + grace, in seconds.
    pub budget_secs: u64,
}

/// Decide whether the observed anchoring gap is a missing receipt.
///
/// Pure — no database, no clock, no network — so the decision itself is covered
/// by `cargo test -p watchdog --lib`, which runs in CI with no Docker.
///
/// Returns `None` when the monitor is disabled, when no receipt has ever been
/// anchored (see the cold-start note in the module docs), when the clock is
/// behind the last receipt, or when the gap is within budget.
pub fn evaluate_receipt_liveness(
    cfg: &ReceiptLivenessConfig,
    chain_id: i64,
    last_recorded_at: Option<i64>,
    now: i64,
) -> Option<MissingReceiptEvent> {
    if !cfg.enabled {
        return None;
    }
    let last = last_recorded_at?;
    let seconds_since = now.checked_sub(last)?;
    if seconds_since <= 0 {
        // Clock skew, or a receipt timestamped in the future. Not a gap.
        return None;
    }
    let budget_secs = cfg.budget_secs();
    if (seconds_since as u128) <= budget_secs as u128 {
        return None;
    }
    Some(MissingReceiptEvent {
        chain_id,
        last_recorded_at: last,
        now,
        seconds_since,
        budget_secs,
    })
}

/// Unix seconds of the most recently anchored consensus receipt on `chain_id`,
/// or `None` when none has ever been anchored.
pub async fn latest_receipt_recorded_at(
    pool: &PgPool,
    chain_id: i64,
) -> Result<Option<i64>, WatchdogError> {
    let row: Option<(Option<i64>,)> =
        sqlx::query_as("SELECT MAX(recorded_at) FROM consensus_receipts WHERE chain_id = $1")
            .bind(chain_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.and_then(|(v,)| v))
}

/// Read the last anchoring time and evaluate the gap against `cfg`.
pub async fn check_receipt_liveness(
    pool: &PgPool,
    cfg: &ReceiptLivenessConfig,
    chain_id: i64,
    now: i64,
) -> Result<Option<MissingReceiptEvent>, WatchdogError> {
    if !cfg.enabled {
        return Ok(None);
    }
    let last = latest_receipt_recorded_at(pool, chain_id).await?;
    Ok(evaluate_receipt_liveness(cfg, chain_id, last, now))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(enabled: bool) -> ReceiptLivenessConfig {
        ReceiptLivenessConfig {
            enabled,
            expected_cadence_secs: 100,
            grace_secs: 10,
        }
    }

    #[test]
    fn disabled_monitor_never_fires() {
        assert_eq!(
            evaluate_receipt_liveness(&cfg(false), 1, Some(0), 1_000_000),
            None
        );
    }

    #[test]
    fn cold_start_is_not_alertable() {
        assert_eq!(
            evaluate_receipt_liveness(&cfg(true), 1, None, 1_000_000),
            None
        );
    }

    #[test]
    fn gap_within_budget_is_quiet() {
        // budget = 100 + 10 = 110; exactly at budget is still within.
        assert_eq!(evaluate_receipt_liveness(&cfg(true), 1, Some(0), 110), None);
        assert_eq!(evaluate_receipt_liveness(&cfg(true), 1, Some(0), 109), None);
    }

    #[test]
    fn gap_past_budget_fires_with_the_observed_numbers() {
        let e = evaluate_receipt_liveness(&cfg(true), 8453, Some(1_000), 1_200)
            .expect("a 200s gap against a 110s budget must fire");
        assert_eq!(e.chain_id, 8453);
        assert_eq!(e.last_recorded_at, 1_000);
        assert_eq!(e.now, 1_200);
        assert_eq!(e.seconds_since, 200);
        assert_eq!(e.budget_secs, 110);
    }

    #[test]
    fn clock_skew_does_not_fire() {
        assert_eq!(
            evaluate_receipt_liveness(&cfg(true), 1, Some(2_000), 1_000),
            None
        );
        assert_eq!(
            evaluate_receipt_liveness(&cfg(true), 1, Some(1_000), 1_000),
            None
        );
    }

    #[test]
    fn zero_cadence_is_refused_rather_than_silently_disabled() {
        let bad = ReceiptLivenessConfig {
            enabled: true,
            expected_cadence_secs: 0,
            grace_secs: 10,
        };
        assert!(bad.validate().is_err());

        // Disabled with a zero cadence is not an error — it is simply off.
        let off = ReceiptLivenessConfig {
            enabled: false,
            ..bad
        };
        assert!(off.validate().is_ok());
    }

    #[test]
    fn default_is_disabled_so_existing_configs_keep_parsing() {
        let d = ReceiptLivenessConfig::default();
        assert!(!d.enabled);
        assert_eq!(
            d.budget_secs(),
            DEFAULT_EXPECTED_CADENCE_SECS + DEFAULT_GRACE_SECS
        );
        assert!(d.validate().is_ok());
    }
}
