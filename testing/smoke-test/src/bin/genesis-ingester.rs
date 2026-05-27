//! Canonical: docs/architecture.md §5.4 — Explorer Indexer and API
//! CLI entry point: `smoke-test-genesis-ingester`
//!
//! Ingests a Base-mainnet Anvil state snapshot into a geth-genesis-compatible
//! `alloc` JSON, restricted to the address allowlist declared in
//! `testing/ethereum-testnet/config/fork-block.json`. Overlays the harness
//! EOAs with ETH for gas and patches USDC storage so `HARNESS_USDC_HOLDER`
//! receives a clean-history balance grant.
//!
//! Canonical: docs/development/smoke-test-design.md (Devnet + USDC faucet sections).
//! Implements: issue #255 — genesis ingester.
//!
//! Usage:
//!
//!     smoke-test-genesis-ingester \
//!         --manifest testing/ethereum-testnet/config/fork-block.json \
//!         --snapshot testing/fixtures/fork-state/CURRENT.anvil-state \
//!         --output    /tmp/genesis-alloc.json
//!
//! The output JSON is the `alloc` map only — not a full genesis. The Docker
//! `setup` container is expected to merge it into the generated
//! `genesis.json` via `jq`.

use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use smoke_test::fork_manifest::ForkManifest;
use smoke_test::genesis_alloc::build_alloc;

#[derive(Parser, Debug)]
#[command(
    name = "smoke-test-genesis-ingester",
    about = "Build geth-genesis alloc from a Base snapshot + fork-block manifest (issue #255)"
)]
struct Cli {
    /// Path to the fork-block manifest JSON.
    #[arg(long)]
    manifest: PathBuf,

    /// Path to the Anvil `--dump-state` snapshot (typically
    /// `testing/fixtures/fork-state/CURRENT.anvil-state`).
    #[arg(long)]
    snapshot: PathBuf,

    /// Output path for the alloc JSON. Parent directory must exist.
    #[arg(long)]
    output: PathBuf,

    /// When set, refuse to write output unless `manifest.pinned == true`.
    /// CI uses this to guard against shipping an unpinned manifest into a
    /// release devnet image.
    #[arg(long, default_value_t = false)]
    require_pinned: bool,
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    let manifest = match ForkManifest::load(&cli.manifest) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("error: load manifest {}: {e}", cli.manifest.display());
            return ExitCode::from(2);
        }
    };

    if cli.require_pinned && !manifest.pinned {
        eprintln!(
            "error: manifest {} has pinned=false; refusing to ingest under --require-pinned",
            cli.manifest.display()
        );
        return ExitCode::from(3);
    }

    let alloc = match build_alloc(&cli.snapshot, &manifest) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("error: build alloc: {e}");
            return ExitCode::from(4);
        }
    };

    let json = match serde_json::to_string_pretty(&alloc) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: serialize alloc: {e}");
            return ExitCode::from(5);
        }
    };

    if let Err(e) = std::fs::write(&cli.output, json) {
        eprintln!("error: write {}: {e}", cli.output.display());
        return ExitCode::from(6);
    }

    eprintln!(
        "ingested {} accounts (allowlist {} + harness overlay) -> {}",
        alloc.0.len(),
        manifest.ingested_addresses.len(),
        cli.output.display()
    );
    ExitCode::SUCCESS
}
