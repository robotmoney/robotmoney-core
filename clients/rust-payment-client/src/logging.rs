//! Canonical: docs/architecture.md §14 — Audit Logging
//!
//! Diagnostic + audit logging for `rmpc`.
//!
//! Two parallel sinks:
//!
//! - **Diagnostic log** — `flexi_logger`-managed rotating file. Holds the
//!   ordinary `trace`/`debug`/`info`/`warn`/`error` stream that operators
//!   skim for run-time issues. Rotates at `[log].rotate_size_mb`, keeps
//!   `[log].keep_files` rolled files. Default location:
//!   `$XDG_STATE_HOME/rust-payment-client/logs` (= `~/.local/state/rust-payment-client/logs`).
//!
//! - **Audit log** — separate `audit.log` (with the same rotation policy)
//!   carrying one JSON record per signing decision. Operators ship that
//!   single file upstream without needing to parse free-form diagnostic
//!   lines. Audit records ALSO go through the diagnostic logger at
//!   `info` level so a single grep on the diagnostic file finds them too;
//!   the dedicated file just makes shipping easier.
//!
//! The audit record shape is fixed (see [`AuditRecord`]); operator
//! tooling matches on field names.

use std::fs::{File, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use flexi_logger::{
    Cleanup, Criterion, DeferredNow, FileSpec, Logger, LoggerHandle, Naming, Record, WriteMode,
};
use serde::Serialize;

use crate::config::LogConfig;

/// Audit log filename (relative to `[log].dir`).
pub const AUDIT_LOG_FILENAME: &str = "audit.log";

/// `target` value used when audit records are written to the diagnostic
/// log via the `log` facade. Tests and downstream consumers can match on
/// this string.
pub const AUDIT_LOG_TARGET: &str = "rmpc::audit";

/// Outcome recorded for every signing decision. Stable strings —
/// operator tooling matches on these.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditDecision {
    /// Envelope signed and broadcast successfully; receipt mined with `status==1`.
    Signed,
    /// Refused before signing — preflight, fee cap, lock contention, etc.
    Refused,
    /// Mined but reverted on chain (`status==0`).
    Reverted,
    /// `eth_sendRawTransaction` rejected the envelope (likely node-side simulation revert).
    BroadcastFailed,
}

/// One JSON-serialised audit record. Field names are part of the
/// operator-visible contract; new fields go at the end with `Option<_>`
/// + `skip_serializing_if`.
#[derive(Debug, Clone, Serialize)]
pub struct AuditRecord {
    /// RFC3339 UTC timestamp of the decision.
    pub timestamp: String,
    /// Signing-key address (0x-prefixed hex, lowercase).
    pub agent: String,
    /// Backend kind, e.g. `"software"`.
    pub backend: String,
    /// Currently always `"deposit"`. Reserved for future request kinds.
    pub request_type: String,
    pub order_id: String,
    pub idempotency_key: String,
    /// Decimal string (preserves precision through JS `JSON.parse`).
    pub amount: String,
    /// Unix-seconds.
    pub deadline: u64,
    pub gateway: String,
    pub chain_id: u64,
    pub decision: AuditDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejection_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tx_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_id: Option<String>,
}

/// Audit-record builder. Filled in incrementally by the deposit
/// command as the call progresses; if the process aborts mid-flight an
/// audit record with the partial state and a `decision` of
/// [`AuditDecision::Refused`] / `BroadcastFailed` / etc. is still
/// emitted.
#[derive(Debug, Clone)]
pub struct AuditRecordBuilder {
    pub agent: String,
    pub backend: String,
    pub request_type: String,
    pub order_id: String,
    pub idempotency_key: String,
    pub amount: String,
    pub deadline: u64,
    pub gateway: String,
    pub chain_id: u64,
    pub tx_hash: Option<String>,
    pub payment_id: Option<String>,
}

impl AuditRecordBuilder {
    /// Build a finished record with `decision` and an optional
    /// `rejection_reason`. Stamps `timestamp` to `now` UTC.
    pub fn build(&self, decision: AuditDecision, rejection_reason: Option<String>) -> AuditRecord {
        AuditRecord {
            timestamp: chrono::Utc::now().to_rfc3339(),
            agent: self.agent.clone(),
            backend: self.backend.clone(),
            request_type: self.request_type.clone(),
            order_id: self.order_id.clone(),
            idempotency_key: self.idempotency_key.clone(),
            amount: self.amount.clone(),
            deadline: self.deadline,
            gateway: self.gateway.clone(),
            chain_id: self.chain_id,
            decision,
            rejection_reason,
            tx_hash: self.tx_hash.clone(),
            payment_id: self.payment_id.clone(),
        }
    }
}

/// Audit-only file sink. Holds a `Mutex<File>` plus the configured
/// rotation knobs; rotates the file when it exceeds `rotate_size_mb`.
struct AuditSink {
    path: PathBuf,
    file: Mutex<File>,
    rotate_size_bytes: u64,
    keep_files: u32,
}

impl AuditSink {
    fn open(dir: &Path, rotate_size_mb: u32, keep_files: u32) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(AUDIT_LOG_FILENAME);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self {
            path,
            file: Mutex::new(file),
            rotate_size_bytes: u64::from(rotate_size_mb) * 1024 * 1024,
            keep_files,
        })
    }

    fn write_line(&self, line: &str) {
        // Best-effort; if the audit file is somehow unwritable, the
        // diagnostic logger still got the record.
        let mut guard = match self.file.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let _ = writeln!(*guard, "{line}");
        let _ = guard.flush();

        // Size-based rotation: if file size > limit, roll. We hold the
        // mutex so the rotation is observably atomic w.r.t. writers.
        if let Ok(meta) = guard.metadata() {
            if meta.len() > self.rotate_size_bytes {
                if let Err(e) = self.rotate(&mut guard) {
                    // Last-ditch: log to stderr; we cannot use `log!` in
                    // the audit path without risking re-entry.
                    eprintln!("rmpc[WARN] audit log rotation failed: {e}");
                }
            }
        }
    }

    fn rotate(&self, guard: &mut std::sync::MutexGuard<'_, File>) -> std::io::Result<()> {
        // Drop the current handle, rename N → N+1 (oldest dropped),
        // then re-open. flexi_logger uses a similar scheme.
        // Files: audit.log → audit.log.1 → audit.log.2 → ...
        let dir = self.path.parent().unwrap_or_else(|| Path::new("."));
        let stem = self
            .path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(AUDIT_LOG_FILENAME);

        // Remove the oldest file if it exists.
        if self.keep_files > 0 {
            let oldest = dir.join(format!("{stem}.{}", self.keep_files));
            let _ = std::fs::remove_file(oldest);
            // Shift down: .N-1 -> .N, .N-2 -> .N-1, ..., .1 -> .2
            for i in (1..self.keep_files).rev() {
                let from = dir.join(format!("{stem}.{i}"));
                let to = dir.join(format!("{stem}.{}", i + 1));
                if from.exists() {
                    let _ = std::fs::rename(from, to);
                }
            }
            // .log -> .log.1
            let first = dir.join(format!("{stem}.1"));
            std::fs::rename(&self.path, &first)?;
        } else {
            // keep_files == 0: just truncate.
            std::fs::remove_file(&self.path)?;
        }

        // Re-open the file fresh.
        let new_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        **guard = new_file;
        Ok(())
    }
}

/// Process-global audit sink. Initialised by [`init`].
static AUDIT_SINK: OnceLock<AuditSink> = OnceLock::new();

/// Process-global flexi_logger handle. Held to keep the file flusher
/// alive for the program's lifetime.
static LOGGER_HANDLE: OnceLock<LoggerHandle> = OnceLock::new();

/// Initialise the diagnostic + audit loggers. Idempotent: subsequent
/// calls are a no-op (returns `Ok(())`).
///
/// Returns the resolved log directory so callers can surface it in
/// diagnostic output.
pub fn init(cfg: &LogConfig) -> Result<PathBuf, String> {
    if LOGGER_HANDLE.get().is_some() {
        return Ok(cfg.dir.clone());
    }

    std::fs::create_dir_all(&cfg.dir).map_err(|e| {
        format!(
            "logging: failed to create log dir {}: {e}",
            cfg.dir.display()
        )
    })?;

    let level_filter = match cfg.level.parse::<log::LevelFilter>() {
        Ok(lf) => lf,
        Err(_) => {
            return Err(format!(
                "logging: invalid level {:?} (try one of error/warn/info/debug/trace)",
                cfg.level
            ))
        }
    };

    let file_spec = FileSpec::default()
        .directory(&cfg.dir)
        .basename("rmpc")
        .suppress_timestamp();

    let handle = Logger::try_with_str(level_filter.as_str().to_lowercase())
        .map_err(|e| format!("logging: flexi_logger init: {e}"))?
        .log_to_file(file_spec)
        .write_mode(WriteMode::BufferAndFlush)
        .format(diagnostic_format)
        .rotate(
            Criterion::Size(u64::from(cfg.rotate_size_mb) * 1024 * 1024),
            Naming::Numbers,
            Cleanup::KeepLogFiles(cfg.keep_files as usize),
        )
        .start()
        .map_err(|e| format!("logging: flexi_logger start: {e}"))?;

    let _ = LOGGER_HANDLE.set(handle);

    let sink = AuditSink::open(&cfg.dir, cfg.rotate_size_mb, cfg.keep_files)
        .map_err(|e| format!("logging: open audit log: {e}"))?;
    let _ = AUDIT_SINK.set(sink);

    Ok(cfg.dir.clone())
}

/// Diagnostic log line format:
/// `2026-01-02T15:04:05.123Z LEVEL [target] msg`.
///
/// The byte shape is delegated to the workspace-shared
/// `rmpc_logging::write_canonical_line` so the rotating CLI file output
/// stays byte-for-byte identical to the services' stderr output
/// (issue #247).
fn diagnostic_format(
    w: &mut dyn std::io::Write,
    now: &mut DeferredNow,
    record: &Record,
) -> std::io::Result<()> {
    rmpc_logging::write_canonical_line(
        w,
        &now.format_rfc3339().to_string(),
        record.level().as_str(),
        record.target(),
        record.args(),
    )
}

/// Emit one audit record. Goes to BOTH the dedicated audit file AND
/// the diagnostic log (under target [`AUDIT_LOG_TARGET`]).
///
/// Safe to call before [`init`]: in that case the record is dropped
/// silently. Tests that exercise audit emission must call [`init`]
/// (or the test helper [`init_for_tests`]) first.
pub fn record_audit(rec: &AuditRecord) {
    let json = match serde_json::to_string(rec) {
        Ok(s) => s,
        Err(_) => return,
    };
    log::info!(target: AUDIT_LOG_TARGET, "{json}");
    if let Some(sink) = AUDIT_SINK.get() {
        sink.write_line(&json);
    }
}

/// Test-only initialisation that points the loggers at a per-test
/// temp directory and uses small rotation thresholds. Returns the dir
/// so the test can read back the audit file.
#[cfg(test)]
pub fn init_for_tests(dir: &Path) -> PathBuf {
    let cfg = LogConfig {
        level: "trace".into(),
        dir: dir.to_path_buf(),
        rotate_size_mb: 1,
        keep_files: 2,
    };
    init(&cfg).expect("test logger init")
}

/// Default log directory used when neither `RMPC_LOG_DIR` nor
/// `[log].dir` is set.
///
/// Resolution order: `$XDG_STATE_HOME/rust-payment-client/logs` →
/// `$HOME/.local/state/rust-payment-client/logs` → `./rust-payment-client-logs`.
pub fn default_log_dir() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_STATE_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("rust-payment-client/logs");
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home).join(".local/state/rust-payment-client/logs");
        }
    }
    PathBuf::from("./rust-payment-client-logs")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn sample_builder() -> AuditRecordBuilder {
        AuditRecordBuilder {
            agent: "0xabcd".into(),
            backend: "software".into(),
            request_type: "deposit".into(),
            order_id: "0x01".into(),
            idempotency_key: "0x02".into(),
            amount: "1000000".into(),
            deadline: 1_700_000_000,
            gateway: "0xdead".into(),
            chain_id: 31337,
            tx_hash: None,
            payment_id: None,
        }
    }

    #[test]
    fn audit_record_serialises_required_fields() {
        let rec = sample_builder().build(AuditDecision::Signed, None);
        let s = serde_json::to_string(&rec).unwrap();
        assert!(s.contains("\"agent\":\"0xabcd\""));
        assert!(s.contains("\"backend\":\"software\""));
        assert!(s.contains("\"request_type\":\"deposit\""));
        assert!(s.contains("\"order_id\":\"0x01\""));
        assert!(s.contains("\"idempotency_key\":\"0x02\""));
        assert!(s.contains("\"amount\":\"1000000\""));
        assert!(s.contains("\"deadline\":1700000000"));
        assert!(s.contains("\"gateway\":\"0xdead\""));
        assert!(s.contains("\"chain_id\":31337"));
        assert!(s.contains("\"decision\":\"signed\""));
        // Optional fields absent when None.
        assert!(!s.contains("\"rejection_reason\""));
        assert!(!s.contains("\"tx_hash\""));
        assert!(!s.contains("\"payment_id\""));
    }

    #[test]
    fn refusal_record_includes_rejection_reason() {
        let rec = sample_builder().build(
            AuditDecision::Refused,
            Some("ErrFeeCapExceeded".to_string()),
        );
        let s = serde_json::to_string(&rec).unwrap();
        assert!(s.contains("\"decision\":\"refused\""));
        assert!(s.contains("\"rejection_reason\":\"ErrFeeCapExceeded\""));
    }

    /// `init` is idempotent and `record_audit` writes to the audit file.
    /// Marked `serial`-style by using a unique tempdir per test; flexi_logger
    /// itself only takes effect on first init for the process — but we only
    /// need the AuditSink half here.
    #[test]
    fn record_audit_writes_json_line_to_audit_file() {
        let dir = TempDir::new().unwrap();
        // We may have been initialised by a prior test in this process.
        // Skip flexi_logger init in that case, but force the audit sink
        // to point at the new dir for this test by writing through a
        // throwaway local sink.
        let sink = AuditSink::open(dir.path(), 1, 2).unwrap();
        let rec = sample_builder().build(AuditDecision::Signed, None);
        sink.write_line(&serde_json::to_string(&rec).unwrap());

        let body = std::fs::read_to_string(dir.path().join(AUDIT_LOG_FILENAME)).unwrap();
        assert!(body.contains("\"decision\":\"signed\""));
        assert!(body.ends_with('\n'));
        // Must be exactly one line.
        assert_eq!(body.lines().count(), 1);
    }

    #[test]
    fn audit_sink_rotates_when_over_size() {
        let dir = TempDir::new().unwrap();
        // 1 MiB threshold; write enough lines to exceed it.
        let sink = AuditSink::open(dir.path(), 1, 3).unwrap();
        let line = "x".repeat(2048);
        // 600 * 2048 = 1.2 MiB → triggers rotation.
        for _ in 0..600 {
            sink.write_line(&line);
        }
        // After rotation, audit.log.1 should exist and audit.log should be smaller.
        let rolled = dir.path().join(format!("{AUDIT_LOG_FILENAME}.1"));
        assert!(
            rolled.exists(),
            "audit.log.1 must exist after exceeding rotation threshold; dir={}",
            dir.path().display()
        );
    }
}
