//! Canonical: docs/implementation-plan.md §9 — fork tests for `rmpc`
//! read commands (issue #50).
//!
//! Shared helpers that locate / build the `rmpc` binary (which lives
//! in a separate crate at `clients/rust-payment-client`) and write
//! a temporary operator config TOML pointing at the fork's anvil
//! RPC URL. Fork tests in this directory shell out to `rmpc` and
//! parse the JSON envelope it prints to stdout.

#![allow(dead_code)] // each integration target only uses a subset

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use alloy_primitives::Address;

/// Path to this crate's manifest, used to locate the sibling
/// `rust-payment-client` crate.
fn manifest_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

/// Resolve the path to the `rust-payment-client` crate manifest
/// (sibling crate at `clients/rust-payment-client/Cargo.toml`).
fn rmpc_manifest() -> PathBuf {
    // testing/fork-e2e-rust → repo root → clients/rust-payment-client
    manifest_dir()
        .join("..")
        .join("..")
        .join("clients")
        .join("rust-payment-client")
        .join("Cargo.toml")
}

/// Build the `rmpc` binary once per process and return its path.
/// Cached behind a [`OnceLock`] so tests sharing a process don't
/// rebuild.
pub fn rmpc_path() -> &'static Path {
    static CACHED: OnceLock<PathBuf> = OnceLock::new();
    CACHED.get_or_init(|| {
        let manifest = rmpc_manifest();
        let status = Command::new("cargo")
            .args(["build", "--bin", "rmpc", "--manifest-path"])
            .arg(&manifest)
            .status()
            .expect("spawn cargo build for rmpc");
        assert!(status.success(), "cargo build of rmpc failed");
        // Workspace target dir: binary lands at <workspace-root>/target/debug/rmpc
        // because rust-payment-client is a workspace member.
        let bin = manifest_dir()
            .join("..")
            .join("..")
            .join("target")
            .join("debug")
            .join("rmpc");
        assert!(
            bin.exists(),
            "rmpc binary missing at {} after build",
            bin.display()
        );
        bin
    })
}

/// Write a temporary `rmpc.toml` pointing at `rpc_url` with
/// `chain_id` baked in. Uses the supplied USDC + gateway addresses;
/// the read commands under test only read `usdc_address` (for
/// get-balance / get-allowance) and `gateway_address` (for
/// get-deposit). `gateway_runtime_hash` is set to a placeholder
/// because read commands skip the preflight that consumes it.
pub fn write_config(
    dir: &Path,
    rpc_url: &str,
    chain_id: u64,
    usdc: Address,
    gateway: Address,
) -> PathBuf {
    let config_path = dir.join("rmpc.toml");
    let toml = format!(
        r#"chain_id              = {chain_id}
rpc_url               = "{rpc_url}"
gateway_address       = "{gateway:#x}"
usdc_address          = "{usdc:#x}"
vault_address         = "0x0000000000000000000000000000000000000d00"
gateway_runtime_hash  = "0x0000000000000000000000000000000000000000000000000000000000000000"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{}"
"#,
        dir.join("keystore.json").display(),
    );
    std::fs::write(&config_path, toml).expect("write rmpc.toml");
    config_path
}
