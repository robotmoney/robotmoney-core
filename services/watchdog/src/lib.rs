//! Robot Money mint/burn rate watchdog (issue #658).
//!
//! Canonical: docs/technical/security-model.md §9
//!
//! Implements the automated watchdog required by the security model:
//!
//! > "An automated watchdog must monitor per-block and per-hour mint and burn
//! > volume against defined thresholds. Breach must trigger an automated pause
//! > or alert to an on-call operator with a maximum response-time SLA."
//!
//! # Crate layout
//!
//! - [`config`] — TOML configuration loader and threshold validation.
//! - [`volume`] — rolling mint/burn aggregation queries against the indexer DB.
//! - [`alert`] — structured JSON webhook/PagerDuty alert dispatcher.
//! - [`pause`] — `gateway.pauseDeposits()` transaction construction and
//!   submission. The deposit pause stops new gateway deposits only; withdrawals
//!   are never frozen (core 1494).
//! - [`watchdog`] — core polling loop and breach detection logic.
//! - [`receipt_liveness`] — consensus-receipt anchoring-gap monitor (issue
//!   #1247 task 4.13). Alert-only; it never pauses the gateway.
//! - [`pager_state`] — durable per-incident pager state, so a restart mid-incident
//!   still sends the matching resolve (task T08).
//! - [`governance`] — standing weight-setter-path check (issue 1698): the
//!   router's `WEIGHT_SETTER_ROLE` and the weight setter's `ADMIN_ROLE` each
//!   have exactly the configured holder. Read-only; it never pauses the gateway.
//! - [`freeze_deadline`] — missed freeze-deadline alert (issue 1809, ADR-0014
//!   §5): once the release's freeze deadline passes, every proxy must read
//!   `upgradesFrozen()`. Read-only; it never pauses, upgrades or freezes.
//! - [`upgrade_events`] — one page per executed proxy upgrade or freeze (issue
//!   1810, ADR-0014 §3, §5), read from the indexer's `proxy_upgrade_events`.
//!   Read-only; it never pauses, upgrades or freezes.
//! - [`liveness`] — read-only `watchdog_cursor.updated_at` heartbeat check used
//!   by the `watchdog-liveness` binary (issue #1378), and the explorer-indexer
//!   lag budget that decides whether a quiet poll may refresh it (DI-5).

#![warn(missing_docs)]

pub mod alert;
pub mod config;
pub mod freeze_deadline;
pub mod governance;
pub mod liveness;
pub mod pager_state;
pub mod pause;
pub mod receipt_liveness;
/// Dev-scout seam map for the off-chain scan-remediation phase (issue #994) —
/// documentation-only, no runtime code.
pub mod scan_remediation_seams;
/// Dev-scout seam map for the off-chain scan-remediation **residual** phase
/// (issue #1027) — the per-vault threshold-enforcement seam for #1023.
/// Documentation-only, no runtime code; the bug it describes is still present
/// at HEAD.
pub mod scan_residual_seams;
pub mod upgrade_events;
pub mod volume;
pub mod watchdog;

/// Top-level error type for the watchdog crate.
#[derive(Debug, thiserror::Error)]
pub enum WatchdogError {
    /// Configuration error (invalid/missing field, zero threshold, etc.).
    #[error("config error: {0}")]
    Config(String),
    /// Database query error.
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    /// Alert dispatch error (HTTP, serialisation).
    #[error("alert dispatch error: {0}")]
    Alert(String),
    /// Gateway `pauseDeposits()` transaction error (signing, RPC).
    #[error("gateway pause error: {0}")]
    Pause(String),
}
