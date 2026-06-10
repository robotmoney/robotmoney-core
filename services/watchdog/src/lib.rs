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
//! - [`pause`] — `gateway.pause()` transaction construction and submission.
//! - [`watchdog`] — core polling loop and breach detection logic.

#![warn(missing_docs)]

pub mod alert;
pub mod config;
pub mod pause;
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
    /// Gateway pause transaction error (signing, RPC).
    #[error("gateway pause error: {0}")]
    Pause(String),
}
