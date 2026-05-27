//! Canonical: docs/architecture.md §3 — Technology Stack
//! CLI entry point: `smoke-test-fork-manifest-validate`
//!
//! Validates `testing/ethereum-testnet/config/fork-block.json` against every
//! rule encoded in `smoke_test::fork_manifest`. Used as a CI guard so an
//! invalid manifest is caught before any devnet boot is attempted.
//!
//! Canonical: docs/development/smoke-test-design.md (Devnet section).
//! Implements: issue #255 acceptance criteria — manifest validator CI gate.
//!
//! Usage:
//!
//!     smoke-test-fork-manifest-validate \
//!         --manifest testing/ethereum-testnet/config/fork-block.json
//!
//! Exit codes:
//!   0 — manifest is structurally valid.
//!   2 — IO or JSON parse error.
//!   3 — semantic validation error (missing field, wrong chain, etc.).
//!   4 — `--require-pinned` was passed but `pinned == false`.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use smoke_test::fork_manifest::{ForkManifest, ManifestError};

#[derive(Parser, Debug)]
#[command(
    name = "smoke-test-fork-manifest-validate",
    about = "Validate the fork-block manifest (issue #255 CI guard)"
)]
struct Cli {
    /// Path to the manifest JSON. Defaults to the canonical path inside
    /// this repo.
    #[arg(
        long,
        default_value = "testing/ethereum-testnet/config/fork-block.json"
    )]
    manifest: PathBuf,

    /// Fail with exit code 4 if the manifest's `pinned` flag is `false`.
    /// CI on release branches should pass this so an unpinned manifest
    /// cannot ship.
    #[arg(long, default_value_t = false)]
    require_pinned: bool,
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    let manifest = match ForkManifest::load(&cli.manifest) {
        Ok(m) => m,
        Err(ManifestError::Io(e)) => {
            eprintln!("io error: {}: {e}", cli.manifest.display());
            return ExitCode::from(2);
        }
        Err(ManifestError::Json(e)) => {
            eprintln!("json parse error: {}: {e}", cli.manifest.display());
            return ExitCode::from(2);
        }
        Err(ManifestError::Invalid(msg)) => {
            eprintln!("invalid manifest: {msg}");
            return ExitCode::from(3);
        }
    };

    if cli.require_pinned && !manifest.pinned {
        eprintln!(
            "manifest {} has pinned=false; release CI requires pinned=true",
            cli.manifest.display()
        );
        return ExitCode::from(4);
    }

    println!(
        "ok: chain={} block={} ingested={} holder={} grant={} pinned={}",
        manifest.chain,
        manifest.block_number,
        manifest.ingested_addresses.len(),
        manifest.harness_usdc_holder,
        manifest.harness_usdc_grant_units,
        manifest.pinned,
    );
    ExitCode::SUCCESS
}
