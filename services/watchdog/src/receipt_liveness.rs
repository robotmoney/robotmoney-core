//! Consensus-receipt liveness monitoring (issue #1247 task 4.13).
//!
//! Canonical: `docs/architecture.md` §4.9 — Consensus Recommendation Receipt Contract
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
//! Two deliberate properties:
//!
//! - **Cold start is alertable.** Before the first receipt, the earliest
//!   persisted `indexer_runs.started_at` is the cadence baseline. Restarting the
//!   watchdog therefore cannot reset the clock and hide a never-started
//!   publisher.
//! - **No baseline at all is a fault, not health.** If neither an anchored
//!   receipt nor an `indexer_runs` row exists for the configured chain id there
//!   is nothing to measure from, and that used to be indistinguishable from
//!   "healthy" at the call site. [`classify_receipt_liveness`] returns
//!   [`ReceiptLivenessStatus::NoBaseline`] for it and the daemon pages, because
//!   the overwhelmingly likely cause is a chain id that matches no data.
//! - **One incident, not one per poll.** The missing-receipt condition stays
//!   true until the first anchor lands, so [`AlertPager`] rate-limits it to one
//!   trigger per publishing cadence and sends exactly one resolve when it
//!   clears.
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
    /// Unix seconds of the most recently anchored receipt, or `None` when this
    /// is a cold-start alert before the first anchor.
    pub last_recorded_at: Option<i64>,
    /// Persisted timestamp used as the beginning of the observed gap. This is
    /// the last receipt normally and the earliest indexer run on cold start.
    pub gap_started_at: i64,
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
/// `monitoring_started_at` is the earliest persisted indexer-run timestamp. It
/// is required only before the first receipt exists. Returns `None` when the
/// monitor is disabled, there is no persisted baseline yet, the clock is behind
/// the baseline, or the gap is within budget.
pub fn evaluate_receipt_liveness(
    cfg: &ReceiptLivenessConfig,
    chain_id: i64,
    last_recorded_at: Option<i64>,
    monitoring_started_at: Option<i64>,
    now: i64,
) -> Option<MissingReceiptEvent> {
    if !cfg.enabled {
        return None;
    }
    let gap_started_at = last_recorded_at.or(monitoring_started_at)?;
    let seconds_since = now.checked_sub(gap_started_at)?;
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
        last_recorded_at,
        gap_started_at,
        now,
        seconds_since,
        budget_secs,
    })
}

/// Return the most recent receipt time and the earliest persisted indexer run.
/// The latter makes a never-anchored cold start observable across restarts.
pub async fn receipt_liveness_baseline(
    pool: &PgPool,
    chain_id: i64,
) -> Result<(Option<i64>, Option<i64>), WatchdogError> {
    let row: (Option<i64>, Option<i64>) = sqlx::query_as(
        "SELECT \
           (SELECT MAX(recorded_at) FROM consensus_receipts WHERE chain_id = $1), \
           MIN(EXTRACT(EPOCH FROM started_at)::BIGINT) \
         FROM indexer_runs WHERE chain_id = $1",
    )
    .bind(chain_id)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// What one liveness cycle actually observed.
///
/// The previous shape — `Option<MissingReceiptEvent>` — could not express
/// "there is nothing to measure against", so at the call site a blind monitor
/// and a healthy one were the same value (`None`) and the blind case was
/// handled by an empty match arm. On the Fusion devnet, where the binary's
/// `--chain-id` default (Base mainnet's 8453) does not match the chain
/// (918453), that made a structurally blind monitor report perfect health.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiptLivenessStatus {
    /// A baseline exists and the gap is inside budget.
    Healthy,
    /// No anchored receipt AND no `indexer_runs` row for this chain id: there
    /// is no timestamp to measure a gap from. A fault, never health.
    NoBaseline,
    /// The gap exceeds cadence + grace.
    Missing(MissingReceiptEvent),
}

/// Read the baseline and classify this cycle. Same query as
/// [`check_receipt_liveness`], but it distinguishes blindness from health.
pub async fn check_receipt_liveness_status(
    pool: &PgPool,
    cfg: &ReceiptLivenessConfig,
    chain_id: i64,
    now: i64,
) -> Result<ReceiptLivenessStatus, WatchdogError> {
    let (last, started) = receipt_liveness_baseline(pool, chain_id).await?;
    Ok(classify_receipt_liveness(cfg, chain_id, last, started, now))
}

/// Pure classifier behind [`check_receipt_liveness_status`].
pub fn classify_receipt_liveness(
    cfg: &ReceiptLivenessConfig,
    chain_id: i64,
    last_recorded_at: Option<i64>,
    monitoring_started_at: Option<i64>,
    now: i64,
) -> ReceiptLivenessStatus {
    if !cfg.enabled {
        return ReceiptLivenessStatus::Healthy;
    }
    if last_recorded_at.is_none() && monitoring_started_at.is_none() {
        return ReceiptLivenessStatus::NoBaseline;
    }
    match evaluate_receipt_liveness(cfg, chain_id, last_recorded_at, monitoring_started_at, now) {
        Some(e) => ReceiptLivenessStatus::Missing(e),
        None => ReceiptLivenessStatus::Healthy,
    }
}

/// What the caller should send to the alert receiver this cycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageAction {
    /// Nothing to send — the receiver already holds the correct state.
    None,
    /// Open (or deliberately re-open) the incident.
    Trigger,
    /// Close the incident that this pager opened.
    Resolve,
}

/// Durable part of an [`AlertPager`]: what the alert receiver believes.
///
/// Persisted per `(chain_id, dedup_key)` so a restart mid-incident does not
/// forget that a trigger was delivered. Before this existed the pager lived in
/// two `let mut` bindings in `main()`: a watchdog restarted during an open
/// incident returned `PageAction::None` from `on_clear()` forever, so
/// `consensus_receipt_missing:<chain>` never closed — the exact "trigger with
/// no matching resolve" failure [`crate::alert`] names as equivalent to not
/// paging at all. The same restart also reset the re-page floor.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PagerState {
    /// True while a delivered trigger has no delivered resolve.
    pub firing: bool,
    /// Unix seconds of the last **confirmed** trigger delivery.
    pub last_paged_at: Option<i64>,
}

/// Upper bound on the post-failure retry floor, in seconds.
///
/// A hard-down receiver must not be re-POSTed at the poll rate (12 s), but it
/// must also not be left alone for a 24 h cadence: the floor is
/// `min(min_repage_secs, RETRY_FLOOR_CEILING_SECS)`.
pub const RETRY_FLOOR_CEILING_SECS: u64 = 60;

/// Rate-limits one alert condition into one incident.
///
/// Why this exists: the missing-receipt condition is *permanent* until the
/// first anchor lands, and the poll loop re-evaluated it every
/// `--poll-interval-secs` (12 s by default). Without this, a zero-anchor chain
/// POSTed a fresh page roughly 7 200 times a day, which buries the signal
/// completely. The poll interval must not set the page rate: at most one
/// trigger per `min_repage_secs` (the configured publishing cadence), and
/// exactly one resolve when the condition clears.
///
/// # Deliver first, commit second
///
/// [`on_firing`](Self::on_firing) and [`on_clear`](Self::on_clear) take `&self`
/// and only *decide*. State moves in [`on_page_result`](Self::on_page_result),
/// and only when the dispatcher returned `Ok(())`. The previous shape stamped
/// `last_paged_at` before any I/O and the caller merely logged the dispatch
/// error, so a single transient non-2xx silenced the page for a whole
/// `expected_cadence_secs` — 86 400 s on the committed staging profile,
/// including the `no_baseline` page whose entire job is to say the monitor is
/// blind.
#[derive(Debug, Clone)]
pub struct AlertPager {
    state: PagerState,
    min_repage_secs: u64,
    /// Earliest time a retry may be attempted after a failed delivery. Never
    /// persisted: a restart is itself a fresh attempt.
    retry_not_before: Option<i64>,
}

impl AlertPager {
    /// `min_repage_secs` is the floor between two triggers for the same key.
    pub fn new(min_repage_secs: u64) -> Self {
        Self::from_state(min_repage_secs, PagerState::default())
    }

    /// Reconstruct a pager over state restored from the database.
    pub fn from_state(min_repage_secs: u64, state: PagerState) -> Self {
        Self {
            state,
            min_repage_secs,
            retry_not_before: None,
        }
    }

    /// The durable state to persist.
    pub fn state(&self) -> PagerState {
        self.state
    }

    /// True while a delivered trigger is still unresolved.
    pub fn is_firing(&self) -> bool {
        self.state.firing
    }

    /// Seconds to wait after a failed delivery before trying again.
    pub fn retry_floor_secs(&self) -> u64 {
        self.min_repage_secs.min(RETRY_FLOOR_CEILING_SECS)
    }

    fn blocked_by_retry_floor(&self, now: i64) -> bool {
        matches!(self.retry_not_before, Some(t) if now < t)
    }

    /// The condition is true right now — what should be sent? Pure.
    pub fn on_firing(&self, now: i64) -> PageAction {
        if self.blocked_by_retry_floor(now) {
            return PageAction::None;
        }
        let due = match self.state.last_paged_at {
            None => true,
            Some(prev) => now.saturating_sub(prev) >= self.min_repage_secs as i64,
        };
        if due {
            PageAction::Trigger
        } else {
            PageAction::None
        }
    }

    /// The condition is false right now — what should be sent? Pure.
    pub fn on_clear(&self, now: i64) -> PageAction {
        if self.blocked_by_retry_floor(now) {
            return PageAction::None;
        }
        if self.state.firing {
            PageAction::Resolve
        } else {
            PageAction::None
        }
    }

    /// Commit the outcome of dispatching `action`.
    ///
    /// Returns `true` when the durable [`PagerState`] changed and should be
    /// persisted. On `ok == false` nothing is committed: the pager stays armed
    /// and simply refuses to retry before the failure floor.
    pub fn on_page_result(&mut self, now: i64, action: PageAction, ok: bool) -> bool {
        if action == PageAction::None {
            return false;
        }
        if !ok {
            self.retry_not_before = Some(now.saturating_add(self.retry_floor_secs() as i64));
            return false;
        }
        self.retry_not_before = None;
        let before = self.state;
        match action {
            PageAction::Trigger => {
                self.state.firing = true;
                self.state.last_paged_at = Some(now);
            }
            PageAction::Resolve => {
                self.state.firing = false;
                self.state.last_paged_at = None;
            }
            PageAction::None => {}
        }
        self.state != before
    }
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
    fn a_disabled_monitor_reports_no_condition_at_all() {
        assert_eq!(
            classify_receipt_liveness(&cfg(false), 918_453, None, None, 1_000_000),
            ReceiptLivenessStatus::Healthy,
        );
    }

    #[test]
    fn no_indexer_run_and_no_receipt_is_blindness_not_health() {
        assert_eq!(
            classify_receipt_liveness(&cfg(true), 918_453, None, None, 1_000_000),
            ReceiptLivenessStatus::NoBaseline,
        );
    }

    #[test]
    fn a_baseline_inside_budget_is_healthy() {
        assert_eq!(
            classify_receipt_liveness(&cfg(true), 918_453, Some(1_000), None, 1_050),
            ReceiptLivenessStatus::Healthy,
        );
    }

    #[test]
    fn a_baseline_beyond_budget_is_missing() {
        match classify_receipt_liveness(&cfg(true), 918_453, None, Some(1_000), 1_200) {
            ReceiptLivenessStatus::Missing(e) => {
                assert_eq!(e.chain_id, 918_453);
                assert_eq!(e.last_recorded_at, None);
                assert_eq!(e.gap_started_at, 1_000);
            }
            other => panic!("expected Missing, got {other:?}"),
        }
    }

    /// Deliver `action` successfully and commit it, as the daemon does.
    fn deliver(pager: &mut AlertPager, now: i64, action: PageAction) {
        pager.on_page_result(now, action, true);
    }

    #[test]
    fn the_poll_interval_does_not_set_the_page_rate() {
        // 12 s poll interval, 100 s minimum re-page: the second and third
        // cycles must send nothing at all.
        let mut pager = AlertPager::new(100);
        assert_eq!(pager.on_firing(1_000), PageAction::Trigger);
        deliver(&mut pager, 1_000, PageAction::Trigger);
        assert_eq!(pager.on_firing(1_012), PageAction::None);
        assert_eq!(pager.on_firing(1_024), PageAction::None);
        assert_eq!(pager.on_firing(1_099), PageAction::None);
        assert_eq!(
            pager.on_firing(1_100),
            PageAction::Trigger,
            "one re-page is due once the cadence has elapsed"
        );
    }

    #[test]
    fn anchoring_resolves_the_incident_exactly_once() {
        let mut pager = AlertPager::new(100);
        assert_eq!(
            pager.on_clear(900),
            PageAction::None,
            "never fired, nothing to resolve"
        );
        assert_eq!(pager.on_firing(1_000), PageAction::Trigger);
        deliver(&mut pager, 1_000, PageAction::Trigger);
        assert_eq!(pager.on_clear(1_001), PageAction::Resolve);
        deliver(&mut pager, 1_001, PageAction::Resolve);
        assert_eq!(
            pager.on_clear(1_002),
            PageAction::None,
            "resolve is not repeated"
        );
        assert_eq!(
            pager.on_firing(1_002),
            PageAction::Trigger,
            "a gap that re-opens after a resolve pages immediately"
        );
    }

    // ---- T08: deliver first, commit second ---------------------------------

    #[test]
    fn a_failed_trigger_dispatch_leaves_the_pager_armed() {
        // Regression for the defect this test was written to reproduce: the old
        // pager stamped `last_paged_at` inside `on_firing`, so ONE transient
        // non-2xx silenced the page for a whole `min_repage_secs`.
        let mut pager = AlertPager::new(86_400);
        assert_eq!(pager.on_firing(1_000), PageAction::Trigger);
        pager.on_page_result(1_000, PageAction::Trigger, false);

        assert!(
            !pager.is_firing(),
            "an undelivered trigger must not be recorded as an open incident"
        );
        assert_eq!(
            pager.state().last_paged_at,
            None,
            "nothing was delivered, so nothing may be committed"
        );
        assert_eq!(
            pager.on_firing(1_000 + RETRY_FLOOR_CEILING_SECS as i64),
            PageAction::Trigger,
            "the retry is due one failure floor later, not one cadence later"
        );
    }

    #[test]
    fn a_hard_down_receiver_is_not_hammered_at_the_poll_rate() {
        let mut pager = AlertPager::new(86_400);
        assert_eq!(pager.retry_floor_secs(), RETRY_FLOOR_CEILING_SECS);
        assert_eq!(pager.on_firing(1_000), PageAction::Trigger);
        pager.on_page_result(1_000, PageAction::Trigger, false);
        // The 12 s poll cycles inside the floor send nothing.
        for t in [1_012, 1_024, 1_036, 1_048, 1_059] {
            assert_eq!(
                pager.on_firing(t),
                PageAction::None,
                "poll at {t} must be inside the failure floor"
            );
        }
        assert_eq!(pager.on_firing(1_060), PageAction::Trigger);
    }

    #[test]
    fn the_failure_floor_never_exceeds_the_repage_cadence() {
        // A profile with a cadence shorter than the ceiling keeps its cadence.
        assert_eq!(AlertPager::new(30).retry_floor_secs(), 30);
        assert_eq!(AlertPager::new(0).retry_floor_secs(), 0);
    }

    #[test]
    fn a_failed_resolve_is_retried_and_the_incident_stays_open() {
        let mut pager = AlertPager::new(100);
        deliver(&mut pager, 1_000, PageAction::Trigger);
        assert_eq!(pager.on_clear(1_010), PageAction::Resolve);
        pager.on_page_result(1_010, PageAction::Resolve, false);
        assert!(
            pager.is_firing(),
            "an undelivered resolve must leave the incident open so it is retried"
        );
        assert_eq!(pager.on_clear(1_069), PageAction::None, "inside the floor");
        assert_eq!(pager.on_clear(1_070), PageAction::Resolve);
        deliver(&mut pager, 1_070, PageAction::Resolve);
        assert!(!pager.is_firing());
    }

    #[test]
    fn a_pager_reconstructed_over_restored_state_still_resolves() {
        // The restart case: the process that delivered the trigger is gone.
        let mut before = AlertPager::new(100);
        assert_eq!(before.on_firing(1_000), PageAction::Trigger);
        assert!(before.on_page_result(1_000, PageAction::Trigger, true));
        let persisted = before.state();
        assert_eq!(
            persisted,
            PagerState {
                firing: true,
                last_paged_at: Some(1_000)
            }
        );
        let mut after_restart = AlertPager::from_state(100, persisted);
        assert_eq!(
            after_restart.on_clear(1_050),
            PageAction::Resolve,
            "a restart mid-incident must not lose the open incident"
        );
        assert!(after_restart.on_page_result(1_050, PageAction::Resolve, true));
        assert_eq!(after_restart.state(), PagerState::default());
    }

    #[test]
    fn a_restart_does_not_bypass_the_repage_floor() {
        let restored = AlertPager::from_state(
            100,
            PagerState {
                firing: true,
                last_paged_at: Some(1_000),
            },
        );
        assert_eq!(
            restored.on_firing(1_050),
            PageAction::None,
            "the re-page floor is carried across the restart, not reset by it"
        );
        assert_eq!(restored.on_firing(1_100), PageAction::Trigger);
    }

    #[test]
    fn committing_a_no_op_action_never_marks_state_dirty() {
        let mut pager = AlertPager::new(100);
        assert!(!pager.on_page_result(1_000, PageAction::None, true));
        assert_eq!(pager.state(), PagerState::default());
        deliver(&mut pager, 1_000, PageAction::Trigger);
        assert!(
            pager.on_page_result(1_100, PageAction::Trigger, true),
            "a re-page moves last_paged_at, which is durable state"
        );
        assert_eq!(pager.state().last_paged_at, Some(1_100));
    }

    #[test]
    fn disabled_monitor_never_fires() {
        assert_eq!(
            evaluate_receipt_liveness(&cfg(false), 1, Some(0), Some(0), 1_000_000),
            None
        );
    }

    #[test]
    fn cold_start_uses_persisted_monitoring_baseline() {
        let e = evaluate_receipt_liveness(&cfg(true), 1, None, Some(1_000), 1_200)
            .expect("cold start beyond cadence budget must page");
        assert_eq!(e.last_recorded_at, None);
        assert_eq!(e.gap_started_at, 1_000);
        assert_eq!(e.seconds_since, 200);
    }

    #[test]
    fn cold_start_without_any_indexer_run_has_no_baseline_yet() {
        assert_eq!(
            evaluate_receipt_liveness(&cfg(true), 1, None, None, 1_000_000),
            None
        );
    }

    #[test]
    fn gap_within_budget_is_quiet() {
        // budget = 100 + 10 = 110; exactly at budget is still within.
        assert_eq!(
            evaluate_receipt_liveness(&cfg(true), 1, Some(0), None, 110),
            None
        );
        assert_eq!(
            evaluate_receipt_liveness(&cfg(true), 1, Some(0), None, 109),
            None
        );
    }

    #[test]
    fn gap_past_budget_fires_with_the_observed_numbers() {
        let e = evaluate_receipt_liveness(&cfg(true), 8453, Some(1_000), Some(10), 1_200)
            .expect("a 200s gap against a 110s budget must fire");
        assert_eq!(e.chain_id, 8453);
        assert_eq!(e.last_recorded_at, Some(1_000));
        assert_eq!(e.gap_started_at, 1_000);
        assert_eq!(e.now, 1_200);
        assert_eq!(e.seconds_since, 200);
        assert_eq!(e.budget_secs, 110);
    }

    #[test]
    fn clock_skew_does_not_fire() {
        assert_eq!(
            evaluate_receipt_liveness(&cfg(true), 1, Some(2_000), None, 1_000),
            None
        );
        assert_eq!(
            evaluate_receipt_liveness(&cfg(true), 1, Some(1_000), None, 1_000),
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
