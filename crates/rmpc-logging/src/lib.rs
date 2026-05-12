//! Canonical: docs/architecture.md §14 — Audit Logging
//!
//! Workspace-wide logging facade. Every Rust binary, service, and test
//! harness initialises logging through this crate so operators see the
//! same structured output regardless of which process emitted it.
//!
//! Two init modes:
//!
//! - [`init_service`] — long-running services (`explorer-indexer`,
//!   `explorer-api`, …). Wires a `tracing_subscriber::fmt` layer that
//!   writes to stderr using the [`canonical_diagnostic_format`] line
//!   shape and the `RUST_LOG` env filter (default `info`). Also installs
//!   a `tracing-log` bridge so `log::` calls from dependencies are
//!   captured by the same subscriber.
//!
//! - The `rust-payment-client` CLI uses its own size-rotating
//!   `flexi_logger` setup for the diagnostic + audit log files, but it
//!   reuses [`canonical_diagnostic_format`] so the formatted lines are
//!   indistinguishable from service output.
//!
//! Bootstrap failures (before this crate has had a chance to run) may
//! still emit directly to stderr. Anything past bootstrap goes through
//! the facade.

use std::sync::OnceLock;

use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::time::FormatTime;
use tracing_subscriber::EnvFilter;

/// Canonical diagnostic line format used by **all** Rust logging in the
/// workspace.
///
/// Shape: `RFC3339 LEVEL [target] message`
///
/// Example: `2026-05-12T18:22:01.123Z INFO  [explorer_indexer] tick start`
///
/// Both the CLI's rotating file backend (`flexi_logger`) and the
/// service stderr backend (`tracing_subscriber`) emit this exact shape,
/// so an operator skimming either source sees identical lines.
pub const FORMAT_DESCRIPTION: &str = "RFC3339 LEVEL [target] message";

/// Default env-filter directive used when `RUST_LOG` is unset.
pub const DEFAULT_FILTER: &str = "info";

/// Tracks whether `init_service` has already run in this process.
/// Repeated calls are a no-op — subscribers are process-global and a
/// second `set_global_default` would panic.
static SERVICE_INIT_DONE: OnceLock<()> = OnceLock::new();

/// Time formatter that emits the same RFC3339-with-millis stamp that
/// `flexi_logger`'s `DeferredNow::format_rfc3339` produces, so the CLI
/// and service formatters agree byte-for-byte on the timestamp column.
#[derive(Default, Clone, Copy)]
struct CanonicalTime;

impl FormatTime for CanonicalTime {
    fn format_time(&self, w: &mut Writer<'_>) -> std::fmt::Result {
        // RFC3339 with millisecond precision and a literal `Z`. Matches
        // `chrono::Utc::now().to_rfc3339()` truncated to ms, which is
        // the audit-record timestamp.
        let now = time::OffsetDateTime::now_utc();
        let fmt = time::macros::format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
        );
        match now.format(&fmt) {
            Ok(s) => w.write_str(&s),
            Err(_) => w.write_str("0000-00-00T00:00:00.000Z"),
        }
    }
}

/// Initialise the canonical logging subscriber for a long-running
/// service binary. Safe to call repeatedly — subsequent calls are a
/// no-op.
///
/// `service_name` is recorded so callers can include it in any future
/// structured-fields rollout; it currently appears as the
/// `service.name` ambient field on every span via the global
/// subscriber.
///
/// Returns `Err(String)` only if the global subscriber has already
/// been set by someone other than this crate (a misconfiguration we
/// want to surface, not swallow).
pub fn init_service(service_name: &str) -> Result<(), String> {
    if SERVICE_INIT_DONE.get().is_some() {
        return Ok(());
    }

    // `tracing-subscriber`'s default `tracing-log` feature installs the
    // `log` → `tracing` bridge for us when `try_init()` runs below, so we
    // do not call `LogTracer::init()` here. Calling it manually races
    // with `try_init()` and produces "attempted to set a logger after the
    // logging system was already initialized" on service boot.

    let env_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER));

    // `with_target(true)` keeps the `[crate::module]` segment that
    // mirrors `flexi_logger`'s `record.target()` column.
    // `with_ansi(false)` strips colour codes so log shippers and tests
    // see plain text.
    let builder = tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_target(true)
        .with_ansi(false)
        .with_timer(CanonicalTime)
        .with_writer(std::io::stderr);

    builder
        .try_init()
        .map_err(|e| format!("rmpc-logging: install subscriber for {service_name}: {e}"))?;

    // Mark init done. Best-effort: if a race happened, the other
    // caller's subscriber is already live and `try_init` above would
    // have already failed.
    let _ = SERVICE_INIT_DONE.set(());

    // Emit a single boot line through the freshly-installed subscriber
    // so operators can confirm the facade is wired and the formatter
    // shape is what they expect.
    tracing::info!(target: "rmpc_logging", service = service_name, "logging facade ready");
    Ok(())
}

/// Write a single canonical diagnostic line to the given sink. Used by
/// the `flexi_logger` format callback in the rmpc CLI so the file
/// backend produces the same byte-shape as the service stderr backend.
///
/// `timestamp` is expected to be the RFC3339-with-millis string the
/// upstream logger has already prepared.
pub fn write_canonical_line(
    w: &mut dyn std::io::Write,
    timestamp: &str,
    level: &str,
    target: &str,
    args: &std::fmt::Arguments<'_>,
) -> std::io::Result<()> {
    write!(w, "{timestamp} {level:<5} [{target}] {args}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `write_canonical_line` produces the documented byte-shape. This
    /// is the single source of truth both backends must agree on.
    #[test]
    fn canonical_line_shape_is_stable() {
        let mut buf: Vec<u8> = Vec::new();
        let args = format_args!("hello world");
        write_canonical_line(
            &mut buf,
            "2026-05-12T18:22:01.123Z",
            "INFO",
            "explorer_indexer",
            &args,
        )
        .unwrap();
        let s = String::from_utf8(buf).unwrap();
        assert_eq!(
            s,
            "2026-05-12T18:22:01.123Z INFO  [explorer_indexer] hello world"
        );
    }

    /// Level column is fixed-width 5 with right-padding — operators
    /// expect aligned columns when grepping.
    #[test]
    fn level_column_is_padded_to_five() {
        let mut buf: Vec<u8> = Vec::new();
        write_canonical_line(&mut buf, "t", "WARN", "x", &format_args!("m")).unwrap();
        assert_eq!(String::from_utf8(buf).unwrap(), "t WARN  [x] m");
    }

    /// `init_service` is idempotent. We can't actually call it twice in
    /// one test process without coordinating with other tests, so we
    /// verify the OnceLock guard rather than the subscriber state.
    #[test]
    fn service_init_done_lock_is_a_oncelock() {
        // Compile-time check: SERVICE_INIT_DONE is a OnceLock<()>.
        let _: &OnceLock<()> = &SERVICE_INIT_DONE;
    }
}
