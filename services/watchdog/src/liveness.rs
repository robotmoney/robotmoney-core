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
//! This module reads that heartbeat. The `watchdog-liveness` binary wraps it
//! for an external monitor (the stage supervisor in
//! `scripts/stage/fusion-watchdog-supervisor.sh`, or an off-host probe). It
//! never writes: a monitor that could refresh the heartbeat itself could mask
//! the very failure it exists to report.
//!
//! The migration comment in `0011_watchdog_cursor.sql` predates this use and is
//! deliberately not edited: sqlx checksums applied migrations, so touching the
//! file would make every existing database refuse to start.

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

#[cfg(test)]
mod tests {
    use super::*;

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
