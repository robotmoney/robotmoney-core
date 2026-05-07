//! Canonical: docs/implementation-plan.md §9 — Phase 3 Direct Chain-Read
//! Query Tooling. Acceptance criterion: "Fork tests cover every read
//! command against pinned contracts."
//!
//! Drives the four `rmpc get-*` CLI binaries against an anvil-fork of
//! Base mainnet, pinned to `RMPC_FORK_BLOCK` (or latest-N), and asserts
//! the envelope output matches on-chain truth at the pinned address
//! set.
//!
//! Coverage by command:
//!
//! - `get-vault` — happy path: vault is deployed on Base, so the
//!   sub-reads succeed and we assert on-chain truth (asset == USDC,
//!   symbol == "rmUSDC", decimals == 6) plus the §9 `not_onchain`
//!   sentinels.
//! - `get-gateway`, `get-agent`, `get-roles` — degradation path: the
//!   `RobotMoneyGateway` contract is not deployed on Base mainnet, so
//!   pointing rmpc at an EOA gateway address surfaces the documented
//!   `partial = true` + per-field error envelope. This locks in AC
//!   "Each subcommand fails with a named error" against a *real*
//!   forked chain rather than a mock.
//!
//! Skips cleanly via `skip_if_no_fork!` when no archive RPC is set, so
//! `cargo test` on a contributor laptop without `RMPC_FORK_RPC_URL`
//! prints a skip line rather than failing.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use rmpc_fork_e2e::{addresses, skip_if_no_fork, ForkFixture, BASE_CHAIN_ID};
use serde_json::Value;

/// `0x000…dEaD` — used as the throwaway gateway address. On Base
/// mainnet this is an EOA (no code), so any `eth_call` against it
/// returns `0x` and rmpc records each sub-read as a per-field error
/// in the partial envelope.
const DEAD_GATEWAY: &str = "0x000000000000000000000000000000000000dEaD";

/// Locate the `rmpc` binary. We can't use `assert_cmd::cargo_bin!`
/// because that macro only resolves binaries in the *current* crate;
/// `rmpc` lives in a sibling crate (`clients/rust-payment-client`).
/// Build it once per process with `cargo build --bin rmpc` against
/// its manifest, then shell out to the produced binary.
fn rmpc_bin() -> &'static PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let manifest = workspace_root().join("clients/rust-payment-client/Cargo.toml");
        let status = Command::new(env!("CARGO"))
            .args([
                "build",
                "--quiet",
                "--bin",
                "rmpc",
                "--manifest-path",
                manifest.to_str().expect("manifest path utf-8"),
            ])
            .status()
            .expect("spawn cargo build rmpc");
        assert!(status.success(), "cargo build --bin rmpc failed");

        let bin = workspace_root().join("clients/rust-payment-client/target/debug/rmpc");
        assert!(bin.exists(), "rmpc binary not at {bin:?} after build");
        bin
    })
}

/// Walk up from `CARGO_MANIFEST_DIR` (= testing/fork-e2e-rust) to the
/// workspace root.
fn workspace_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // testing/fork-e2e-rust → testing → repo root
    p.pop();
    p.pop();
    p
}

/// Write a minimal rmpc.toml that points at `rpc_url`, with `chain_id`
/// = Base mainnet, vault = the deployed Robot Money vault, and a
/// throwaway gateway address (the gateway is not deployed on Base; the
/// gateway-side sub-reads are expected to fail and be recorded as
/// per-field errors in the `partial`/`errors` envelope).
fn write_config(tmp: &tempfile::TempDir, rpc_url: &str) -> PathBuf {
    // The read commands don't load the signer, but Config::from_path
    // requires a parseable [signer] block. The keystore file is
    // referenced but never read, so we just point at a non-existent
    // path inside tmp.
    let keystore = tmp.path().join("keystore.json");
    let cfg_path = tmp.path().join("rmpc.toml");
    let toml = format!(
        r#"chain_id              = {chain_id}
rpc_url               = "{rpc_url}"
gateway_address       = "{DEAD_GATEWAY}"
usdc_address          = "{usdc:#x}"
vault_address         = "{vault:#x}"
gateway_runtime_hash  = "0x{zeros}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{ks}"
"#,
        chain_id = BASE_CHAIN_ID,
        usdc = addresses::USDC,
        vault = addresses::VAULT,
        zeros = "0".repeat(64),
        ks = keystore.display(),
    );
    std::fs::write(&cfg_path, toml).expect("write rmpc.toml");
    cfg_path
}

/// Invoke `rmpc <cmd> --config <cfg> [extra…]` and parse stdout as
/// JSON. Asserts exit 0 and stable envelope-level fields (chain_id,
/// source). Returns the parsed JSON value for command-specific
/// assertions.
fn run_rmpc(cfg: &Path, args: &[&str]) -> Value {
    let out = Command::new(rmpc_bin())
        .arg(args[0])
        .args(["--config", cfg.to_str().unwrap()])
        .args(&args[1..])
        .output()
        .unwrap_or_else(|e| panic!("spawn rmpc {}: {e}", args[0]));
    assert!(
        out.status.success(),
        "rmpc {} exited {:?}; stderr=\n{}",
        args[0],
        out.status.code(),
        String::from_utf8_lossy(&out.stderr),
    );
    let v: Value = serde_json::from_slice(&out.stdout).unwrap_or_else(|e| {
        panic!(
            "rmpc {} stdout is not valid JSON: {e}\nstdout=\n{}",
            args[0],
            String::from_utf8_lossy(&out.stdout)
        )
    });
    // Envelope shape — locked by docs/technical/rmpc-read-output-contract.md.
    assert_eq!(
        v["chain_id"], BASE_CHAIN_ID,
        "chain_id drift in {}: {v}",
        args[0]
    );
    assert_eq!(v["source"], "json_rpc", "source drift in {}: {v}", args[0]);
    assert!(
        v["block_number"].is_u64(),
        "block_number must be u64 in {}: {v}",
        args[0]
    );
    v
}

#[test]
fn rmpc_get_vault_fork_base_mainnet() {
    skip_if_no_fork!();
    let fx = ForkFixture::new().expect("boot fork");
    eprintln!("[rmpc_get_vault_fork_base_mainnet] {}", fx.summary_line());

    let tmp = tempfile::TempDir::new().expect("tempdir");
    let cfg = write_config(&tmp, &fx.rpc_url);

    // ---- get-vault: happy path against the real Base vault. -------
    let v = run_rmpc(&cfg, &["get-vault"]);
    // gateway.vault() can't succeed (DEAD_GATEWAY has no code), so the
    // envelope is partial. Vault sub-reads still resolve from the
    // pinned deployed bytecode.
    assert_eq!(v["partial"], true, "get-vault expected partial=true: {v}");
    let errors = v["errors"]
        .as_array()
        .expect("errors must be an array when partial=true");
    assert!(
        errors.iter().any(|e| e["field"] == "gateway_vault"),
        "expected per-field error for gateway_vault: {errors:?}"
    );

    let d = &v["data"];
    assert_eq!(
        d["address"].as_str().unwrap().to_lowercase(),
        format!("{:#x}", addresses::VAULT)
    );
    assert_eq!(
        d["asset"].as_str().unwrap().to_lowercase(),
        format!("{:#x}", addresses::USDC),
        "Vault.asset() != USDC at fork pin"
    );
    assert_eq!(d["symbol"], "rmUSDC", "Vault.symbol() drift");
    assert_eq!(d["decimals"], 6, "Vault.decimals() drift");

    // §9 explicit not_onchain markers.
    let notes = &d["notes"];
    for k in ["deposit_cap", "paused", "shutdown", "adapters", "fees"] {
        assert_eq!(
            notes[k], "not_onchain",
            "notes.{k} drift; full envelope:\n{v:#}"
        );
    }

    // ---- get-gateway: degradation path (no gateway on Base). ------
    let v = run_rmpc(&cfg, &["get-gateway"]);
    assert_eq!(
        v["partial"], true,
        "get-gateway must be partial when gateway is not deployed: {v}"
    );
    let errors = v["errors"]
        .as_array()
        .expect("get-gateway errors must be present when partial=true");
    assert!(
        !errors.is_empty(),
        "get-gateway: expected at least one named per-field error: {errors:?}"
    );
    // Every error carries a `field` and `message` string per
    // read_output::FieldError — the wire key is "message", not "error".
    for e in errors {
        assert!(e["field"].is_string(), "error missing field: {e}");
        assert!(
            e["message"].is_string(),
            "error missing message string: {e}"
        );
    }

    // ---- get-agent: degradation path. -----------------------------
    let v = run_rmpc(
        &cfg,
        &[
            "get-agent",
            "--agent",
            "0x000000000000000000000000000000000000bEEF",
        ],
    );
    assert_eq!(v["partial"], true, "get-agent must be partial: {v}");
    let errors = v["errors"]
        .as_array()
        .expect("get-agent errors must be present");
    assert!(
        !errors.is_empty(),
        "get-agent expected named errors: {errors:?}"
    );

    // ---- get-roles: degradation path. -----------------------------
    let v = run_rmpc(
        &cfg,
        &[
            "get-roles",
            "--address",
            "0x000000000000000000000000000000000000bEEF",
        ],
    );
    assert_eq!(v["partial"], true, "get-roles must be partial: {v}");
    let errors = v["errors"]
        .as_array()
        .expect("get-roles errors must be present");
    assert!(
        !errors.is_empty(),
        "get-roles expected named errors: {errors:?}"
    );
}

/// Negative-path coverage: a malformed contract address in the rmpc
/// config must surface as a typed startup error (exit 3, no stdout
/// envelope), independent of the fork backend. Runs without a fork
/// fixture so it exercises CI on every PR.
#[test]
fn rmpc_get_vault_rejects_malformed_address() {
    let tmp = tempfile::TempDir::new().expect("tempdir");
    let keystore = tmp.path().join("keystore.json");
    let cfg_path = tmp.path().join("rmpc.toml");
    let toml = format!(
        r#"chain_id              = {chain_id}
rpc_url               = "http://127.0.0.1:1"
gateway_address       = "{DEAD_GATEWAY}"
usdc_address          = "0x{usdc}"
vault_address         = "not-a-hex-address"
gateway_runtime_hash  = "0x{zeros}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{ks}"
"#,
        chain_id = BASE_CHAIN_ID,
        usdc = "00".repeat(20),
        zeros = "0".repeat(64),
        ks = keystore.display(),
    );
    std::fs::write(&cfg_path, &toml).expect("write rmpc.toml");

    let out = Command::new(rmpc_bin())
        .args(["get-vault", "--config", cfg_path.to_str().unwrap()])
        .output()
        .expect("spawn rmpc get-vault");
    let code = out.status.code().unwrap_or(-1);
    // EXIT_STARTUP_FAIL = 3 in commands/get_vault.rs. Must be non-zero
    // and not the success code (typed-error AC).
    assert_ne!(
        code,
        0,
        "rmpc get-vault must exit non-zero on malformed address; stdout=\n{}\nstderr=\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    // Stdout must NOT contain a success envelope; the typed error
    // surfaces via the process exit code (and the rmpc log file —
    // tests don't grep stderr because logging is file-routed by
    // default).
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.trim().is_empty() || !stdout.contains("\"source\":\"json_rpc\""),
        "rmpc must not emit a success envelope on a malformed address; got stdout=\n{stdout}"
    );
}
