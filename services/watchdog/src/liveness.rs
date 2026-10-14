//! Read-only watchdog liveness evaluation (issue #1378).
//!
//! Canonical: docs/architecture.md §5.6 "Watchdog liveness and deployment";
//! operator runbook: docs/operations/watchdog-liveness.md.
//!
//! # Why a heartbeat
//!
//! The watchdog's healthy output during a calm market is *no output at all*,
//! which is byte-identical to its output when it is dead. To make the two
//! distinguishable, the daemon refreshes `watchdog_cursor.updated_at` after every
//! successful poll — when it advances the cursor past an evaluated block
//! ([`crate::watchdog::store_cursor`]) and also when a poll finds no newly
//! indexed block ([`crate::watchdog::touch_cursor`]). A stopped, hung, or
//! crash-looping daemon stops refreshing it.
//!
//! # A quiet poll is only proof of watching while the indexer keeps up (DI-5)
//!
//! "No newly indexed block" has two causes: the market is quiet, or the
//! explorer indexer the watchdog reads has stopped (every tick failing, or the
//! process gone). The second used to refresh the heartbeat exactly like the
//! first, so `watchdog-liveness` exited 0 while the watchdog evaluated nothing
//! at all. A quiet poll therefore reads [`IndexerProgress`] first and refreshes
//! the heartbeat only when the indexer is within its [`IndexerLagBudget`]. When
//! it is not, the daemon pages (`indexer_behind:<chain>`) and lets the heartbeat
//! age, so this checker reports `stale` too.
//!
//! This module reads that heartbeat. The `watchdog-liveness` binary wraps it
//! for an external monitor (the stage supervisor in
//! `scripts/stage/fusion-watchdog-supervisor.sh`, or an off-host probe). It
//! never writes: a monitor that could refresh the heartbeat itself could mask
//! the very failure it exists to report.
//!
//! The migration comment in `0011_watchdog_cursor.sql` predates this use and is
//! deliberately not edited: sqlx checksums applied migrations, so touching the
//! file would make every existing database refuse to start.

use serde::Deserialize;
use sqlx::postgres::PgPool;

use crate::WatchdogError;

/// Process exit code for a healthy heartbeat.
pub const EXIT_HEALTHY: u8 = 0;
/// Process exit code for a stale or missing heartbeat: the watchdog is not
/// proving that it is watching.
pub const EXIT_UNHEALTHY: u8 = 1;
/// Process exit code when liveness could not be determined (bad arguments,
/// database unreachable). Never healthy: an unknown is paged, not ignored.
pub const EXIT_UNKNOWN: u8 = 2;

/// Result of comparing the watchdog cursor heartbeat with its permitted age.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorLiveness {
    /// A successful watchdog poll refreshed the cursor within the permitted age.
    Healthy {
        /// Age of the last successful poll according to the database clock.
        age_secs: i64,
    },
    /// The cursor exists but has not been refreshed within the permitted age.
    Stale {
        /// Age of the last successful poll according to the database clock.
        age_secs: i64,
    },
    /// The watchdog has never completed a successful poll for this chain (or
    /// the chain id is wrong, which must not read as health either).
    Missing,
}

impl CursorLiveness {
    /// Classify a heartbeat age against `max_age_secs`.
    ///
    /// `None` means no cursor row exists. A negative age (database clock
    /// stepped backwards) is clamped to zero rather than treated as stale.
    pub fn classify(age_secs: Option<i64>, max_age_secs: i64) -> Self {
        match age_secs.map(|a| a.max(0)) {
            Some(age_secs) if age_secs <= max_age_secs => Self::Healthy { age_secs },
            Some(age_secs) => Self::Stale { age_secs },
            None => Self::Missing,
        }
    }

    /// Whether the cursor proves a recent successful watchdog poll.
    pub fn is_healthy(self) -> bool {
        matches!(self, Self::Healthy { .. })
    }

    /// The `watchdog-liveness` exit code for this state.
    pub fn exit_code(self) -> u8 {
        if self.is_healthy() {
            EXIT_HEALTHY
        } else {
            EXIT_UNHEALTHY
        }
    }
}

/// Read and evaluate the durable watchdog heartbeat for `chain_id`.
///
/// Age is computed on the database server's clock, the same clock that wrote
/// `updated_at`, so skew on the monitor host cannot make a healthy cursor look
/// stale (or a stale one look healthy).
pub async fn check_cursor_liveness(
    pool: &PgPool,
    chain_id: i64,
    max_age_secs: i64,
) -> Result<CursorLiveness, WatchdogError> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT EXTRACT(EPOCH FROM now() - updated_at)::BIGINT \
         FROM watchdog_cursor WHERE chain_id = $1",
    )
    .bind(chain_id)
    .fetch_optional(pool)
    .await
    .map_err(WatchdogError::Db)?;

    Ok(CursorLiveness::classify(
        row.map(|(age,)| age),
        max_age_secs,
    ))
}

/// Default [`IndexerLagBudget::max_lag_blocks`]: 150 blocks is 300 s of Base
/// blocks, the default `sla.max_response_secs`. A healthy indexer trails the
/// head by its 5 confirmations plus at most one tick.
pub const DEFAULT_MAX_INDEXER_LAG_BLOCKS: i64 = 150;

/// Default [`IndexerLagBudget::max_silence_secs`]: the default
/// `sla.max_response_secs`. A healthy indexer finishes a run every tick (12 s),
/// including a tick with nothing new to read.
pub const DEFAULT_MAX_INDEXER_SILENCE_SECS: i64 = 300;

/// Default [`IndexerLagBudget::repage_secs`].
pub const DEFAULT_INDEXER_BEHIND_REPAGE_SECS: u64 = 3_600;

/// How far the explorer indexer may fall behind before a quiet poll stops
/// counting as watching (`[indexer_lag]` in the watchdog config, DI-5).
///
/// Absent means these defaults, so every existing config keeps parsing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct IndexerLagBudget {
    /// Most blocks the indexed head may trail the chain head the indexer last
    /// recorded. Catches a wedged indexer: a failed tick still records the head
    /// it read, so the gap grows while the cursor stands still.
    #[serde(default = "default_max_lag_blocks")]
    pub max_lag_blocks: i64,
    /// Most seconds since the newest indexer run that finished without an
    /// error. Catches an indexer process that is gone: it records no head at
    /// all, so the block gap freezes, but the silence grows.
    #[serde(default = "default_max_silence_secs")]
    pub max_silence_secs: i64,
    /// Floor between two `indexer_behind` pages for the same standing fault.
    #[serde(default = "default_indexer_behind_repage_secs")]
    pub repage_secs: u64,
}

fn default_max_lag_blocks() -> i64 {
    DEFAULT_MAX_INDEXER_LAG_BLOCKS
}

fn default_max_silence_secs() -> i64 {
    DEFAULT_MAX_INDEXER_SILENCE_SECS
}

fn default_indexer_behind_repage_secs() -> u64 {
    DEFAULT_INDEXER_BEHIND_REPAGE_SECS
}

impl Default for IndexerLagBudget {
    fn default() -> Self {
        Self {
            max_lag_blocks: DEFAULT_MAX_INDEXER_LAG_BLOCKS,
            max_silence_secs: DEFAULT_MAX_INDEXER_SILENCE_SECS,
            repage_secs: DEFAULT_INDEXER_BEHIND_REPAGE_SECS,
        }
    }
}

impl IndexerLagBudget {
    /// Refuse a budget that would page on every poll: a healthy indexer always
    /// trails the head by its confirmations and finishes a run every tick.
    pub fn validate(&self) -> Result<(), WatchdogError> {
        if self.max_lag_blocks <= 0 {
            return Err(WatchdogError::Config(
                "indexer_lag.max_lag_blocks must be greater than zero".into(),
            ));
        }
        if self.max_silence_secs <= 0 {
            return Err(WatchdogError::Config(
                "indexer_lag.max_silence_secs must be greater than zero".into(),
            ));
        }
        if self.repage_secs == 0 {
            return Err(WatchdogError::Config(
                "indexer_lag.repage_secs must be non-zero — 0 would page on every poll".into(),
            ));
        }
        Ok(())
    }
}

/// What the watchdog can see of the explorer indexer's progress, read from
/// `indexer_runs` (DI-5). The same definitions as the explorer's `/health`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexerProgress {
    /// Newest recorded `chain_head_block` minus the highest `last_indexed_block`
    /// of a run without an error. `None` while either side is unknown.
    pub lag_blocks: Option<i64>,
    /// Seconds (database clock) since the newest run without an error that
    /// committed a cursor finished. `None` when there is no such run.
    pub since_success_secs: Option<i64>,
    /// `error` of the newest finished run; `None` when it succeeded.
    pub last_error: Option<String>,
}

impl IndexerProgress {
    /// True when the indexer is measurably beyond `budget`. Unknown is not
    /// behind: with no run at all the poll loop has no indexed block to wait
    /// for, and the missing heartbeat already reports that.
    pub fn is_behind(&self, budget: &IndexerLagBudget) -> bool {
        self.lag_blocks.is_some_and(|l| l > budget.max_lag_blocks)
            || self
                .since_success_secs
                .is_some_and(|s| s > budget.max_silence_secs)
    }
}

/// Read [`IndexerProgress`] for `chain_id`.
///
/// The cursor is the highest `last_indexed_block` of a run without an error
/// (what the indexer resumes from); the head is the newest one any run
/// recorded, including a failed run, which is what makes a wedged indexer's
/// lag grow. Ages are computed on the database clock.
pub async fn read_indexer_progress(
    pool: &PgPool,
    chain_id: i64,
) -> Result<IndexerProgress, WatchdogError> {
    let (lag_blocks, since_success_secs, last_error): (Option<i64>, Option<i64>, Option<String>) =
        sqlx::query_as(
            "SELECT \
               (SELECT chain_head_block FROM indexer_runs \
                 WHERE chain_id = $1 AND chain_head_block IS NOT NULL \
                 ORDER BY run_id DESC LIMIT 1) \
               - (SELECT MAX(last_indexed_block) FROM indexer_runs \
                 WHERE chain_id = $1 AND error IS NULL), \
               (SELECT EXTRACT(EPOCH FROM now() - COALESCE(finished_at, started_at))::BIGINT \
                  FROM indexer_runs \
                 WHERE chain_id = $1 AND error IS NULL AND last_indexed_block IS NOT NULL \
                 ORDER BY run_id DESC LIMIT 1), \
               (SELECT error FROM indexer_runs \
                 WHERE chain_id = $1 AND finished_at IS NOT NULL \
                 ORDER BY run_id DESC LIMIT 1)",
        )
        .bind(chain_id)
        .fetch_one(pool)
        .await
        .map_err(WatchdogError::Db)?;
    Ok(IndexerProgress {
        lag_blocks,
        since_success_secs: since_success_secs.map(|s| s.max(0)),
        last_error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn progress(lag: Option<i64>, since: Option<i64>) -> IndexerProgress {
        IndexerProgress {
            lag_blocks: lag,
            since_success_secs: since,
            last_error: None,
        }
    }

    #[test]
    fn an_indexer_within_both_budgets_is_not_behind() {
        let b = IndexerLagBudget::default();
        assert!(!progress(Some(5), Some(12)).is_behind(&b));
        assert!(!progress(Some(b.max_lag_blocks), Some(b.max_silence_secs)).is_behind(&b));
    }

    #[test]
    fn a_wedged_indexer_is_behind_on_the_block_gap() {
        let b = IndexerLagBudget::default();
        // Every tick fails after reading the head: the last success may be
        // recent enough, but the gap is not.
        assert!(progress(Some(b.max_lag_blocks + 1), Some(0)).is_behind(&b));
    }

    #[test]
    fn a_dead_indexer_is_behind_on_silence_even_with_a_frozen_gap() {
        let b = IndexerLagBudget::default();
        // The process is gone: no run records a new head, so the gap stays at
        // the healthy 5 forever. Only the silence shows it.
        assert!(progress(Some(5), Some(b.max_silence_secs + 1)).is_behind(&b));
    }

    #[test]
    fn unknown_progress_is_not_behind() {
        assert!(!progress(None, None).is_behind(&IndexerLagBudget::default()));
    }

    #[test]
    fn a_budget_that_would_page_every_poll_is_refused() {
        let zero_lag = IndexerLagBudget {
            max_lag_blocks: 0,
            ..Default::default()
        };
        assert!(zero_lag.validate().is_err());
        let zero_silence = IndexerLagBudget {
            max_silence_secs: 0,
            ..Default::default()
        };
        assert!(zero_silence.validate().is_err());
        let zero_repage = IndexerLagBudget {
            repage_secs: 0,
            ..Default::default()
        };
        assert!(zero_repage.validate().is_err());
        assert!(IndexerLagBudget::default().validate().is_ok());
    }

    #[test]
    fn fresh_heartbeat_is_healthy_up_to_and_including_the_limit() {
        assert_eq!(
            CursorLiveness::classify(Some(0), 60),
            CursorLiveness::Healthy { age_secs: 0 }
        );
        assert_eq!(
            CursorLiveness::classify(Some(60), 60),
            CursorLiveness::Healthy { age_secs: 60 }
        );
    }

    #[test]
    fn heartbeat_older_than_the_limit_is_stale() {
        let s = CursorLiveness::classify(Some(61), 60);
        assert_eq!(s, CursorLiveness::Stale { age_secs: 61 });
        assert!(!s.is_healthy());
        assert_eq!(s.exit_code(), EXIT_UNHEALTHY);
    }

    #[test]
    fn missing_cursor_is_unhealthy_not_quiet() {
        let s = CursorLiveness::classify(None, 60);
        assert_eq!(s, CursorLiveness::Missing);
        assert_eq!(s.exit_code(), EXIT_UNHEALTHY);
    }

    #[test]
    fn negative_age_from_clock_step_is_clamped_to_healthy() {
        assert_eq!(
            CursorLiveness::classify(Some(-5), 60),
            CursorLiveness::Healthy { age_secs: 0 }
        );
    }

    #[test]
    fn exit_codes_are_distinct() {
        assert_eq!(
            CursorLiveness::Healthy { age_secs: 1 }.exit_code(),
            EXIT_HEALTHY
        );
        assert_ne!(EXIT_HEALTHY, EXIT_UNHEALTHY);
        assert_ne!(EXIT_UNHEALTHY, EXIT_UNKNOWN);
        assert_ne!(EXIT_HEALTHY, EXIT_UNKNOWN);
    }
}
