//! Canonical: docs/architecture.md §14 — Audit Logging
//!
//! Workspace-wide guard for issue #247: every Rust binary and
//! long-running service must initialise logging through
//! `rmpc-logging` and **not** by calling `tracing_subscriber::fmt()`
//! or another logger directly. Mixing logger initialisation is the
//! exact failure mode the shared facade exists to prevent — this test
//! makes the regression load-bearing.
//!
//! If you legitimately add a new binary that needs a different
//! logging setup, add the file path to `EXEMPT` below and document the
//! reason in the same change.

use std::fs;
use std::path::{Path, PathBuf};

/// Repo-relative paths of every long-running service binary in the
/// workspace. These must initialise logging by calling
/// `rmpc_logging::init_service` directly.
const REQUIRED_SERVICES: &[&str] = &[
    "clients/explorer-api/src/main.rs",
    "services/explorer-indexer/src/main.rs",
];

/// CLI binaries that own their logger setup (rotation, audit file)
/// but must reuse the shared formatter from `rmpc-logging`. These
/// files are validated separately below.
const REQUIRED_CLIS_USING_SHARED_FORMATTER: &[(&str, &str)] = &[
    // The rmpc CLI's diagnostic format delegates to
    // `rmpc_logging::write_canonical_line`. The CLI's `main.rs` calls
    // its own `logging::init`, which is the wrapper around the shared
    // formatter + flexi_logger rotation + audit sink.
    (
        "clients/rust-payment-client/src/logging.rs",
        "rmpc_logging::write_canonical_line",
    ),
];

/// Binaries that legitimately do not need a logging facade — short
/// one-shot tools whose output is entirely user-facing stderr/stdout
/// (bootstrap-only paths per architecture §14). Document the
/// rationale next to the entry.
const EXEMPT: &[&str] = &[
    // Pre-init keystore importer: runs before any config exists, prints
    // CLI usage and exits.
    "clients/rust-payment-client/src/bin/rmpc_keystore_import.rs",
    // One-shot CLIs that wrap test-harness fixtures; their stderr is
    // already the user-facing channel.
    "testing/smoke-test/src/bin/smoke-test.rs",
    "testing/smoke-test/src/bin/genesis-ingester.rs",
    "testing/smoke-test/src/bin/fork-manifest-validate.rs",
];

fn workspace_root() -> PathBuf {
    // CARGO_MANIFEST_DIR is `crates/rmpc-logging`; the workspace root
    // is two levels up.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(Path::parent)
        .expect("workspace root resolves from rmpc-logging manifest")
        .to_path_buf()
}

fn read_repo(rel: &str) -> String {
    let path = workspace_root().join(rel);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// Each long-running service binary must contain a literal call to
/// `rmpc_logging::init_service`. We match on the call site rather
/// than the import so a `use rmpc_logging` without an init still
/// fails.
#[test]
fn every_service_binary_calls_init_service() {
    for rel in REQUIRED_SERVICES {
        let body = read_repo(rel);
        assert!(
            body.contains("rmpc_logging::init_service"),
            "{rel} does not call rmpc_logging::init_service — issue #247 requires every \
             long-running service to route logging through the shared facade. Either wire \
             the init call or add the file to EXEMPT with a documented reason."
        );
    }
}

/// No long-running service may install a `tracing_subscriber`
/// directly. Customisations live in `rmpc-logging` so every binary
/// inherits them.
#[test]
fn no_service_installs_tracing_subscriber_directly() {
    for rel in REQUIRED_SERVICES {
        let body = read_repo(rel);
        for needle in ["tracing_subscriber::fmt()", "tracing_subscriber::registry"] {
            assert!(
                !body.contains(needle),
                "{rel} contains `{needle}` — issue #247 forbids per-binary subscriber \
                 setup. Move the customisation into `rmpc-logging`."
            );
        }
    }
}

/// CLI binaries that keep their own rotating-file backend must still
/// produce the canonical diagnostic line shape by delegating the
/// format callback to `rmpc-logging`.
#[test]
fn cli_uses_shared_formatter() {
    for (rel, needle) in REQUIRED_CLIS_USING_SHARED_FORMATTER {
        let body = read_repo(rel);
        assert!(
            body.contains(needle),
            "{rel} must call `{needle}` so the file backend emits the same byte-shape \
             as the service stderr backend (issue #247)."
        );
    }
}

/// Every long-running service must keep a bootstrap-failure stderr
/// path so an operator can see *why* the process is dying when
/// `init_service` itself fails (e.g. another subscriber already
/// installed). The architecture §14 contract permits direct stderr
/// only for bootstrap-only paths — this is one of them.
#[test]
fn services_keep_bootstrap_stderr_fallback() {
    for rel in REQUIRED_SERVICES {
        let body = read_repo(rel);
        assert!(
            body.contains("logging init failed"),
            "{rel} must print `<service>: logging init failed: <err>` to stderr when \
             `rmpc_logging::init_service` returns Err (issue #247 bootstrap clause)."
        );
        assert!(
            body.contains("eprintln!"),
            "{rel} must use `eprintln!` for the bootstrap-failure path so the message \
             reaches stderr before any subscriber is installed."
        );
    }
}

/// Exempt binaries must actually exist; stale entries hide real
/// violations.
#[test]
fn exempt_paths_still_exist() {
    let root = workspace_root();
    for rel in EXEMPT {
        let path = root.join(rel);
        assert!(
            path.exists(),
            "EXEMPT entry {} does not exist; remove it or fix the path",
            path.display()
        );
    }
}
