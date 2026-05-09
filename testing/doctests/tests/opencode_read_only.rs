//! Canonical: docs/walkthroughs/opencode-readonly-fork.md (issue #53),
//! step 5 (read-only inspection).
//!
//! Boots an `anvil --fork-url $RMPC_FORK_RPC_URL` against Base mainnet
//! and runs `rmpc get-vault` against it through the operator config
//! the walkthrough ships. Asserts the JSON envelope contract from
//! `docs/technical/rmpc-read-output-contract.md` (chain_id,
//! block_number, source).
//!
//! Skip-clean (`return` after a printed warning) when no archive RPC
//! is configured, mirroring `testing/fork-e2e-rust`. A contributor
//! laptop without an RPC stays green; CI sets the secret.

use std::fs;
use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use doctests::opencode::{config_template_path, rmpc_bin};
use serde_json::Value;

/// Skip-clean macro mirroring `rmpc_fork_e2e::skip_if_no_fork!`.
macro_rules! skip_if_no_fork {
    () => {
        match std::env::var("RMPC_FORK_RPC_URL") {
            Ok(s) if !s.is_empty() => s,
            _ => {
                eprintln!(
                    "[opencode-walkthrough] skipping: RMPC_FORK_RPC_URL not set. \
                     Configure an archive RPC to exercise the fork test."
                );
                return;
            }
        }
    };
}

/// Find a TCP port that's free on 127.0.0.1 right now. Best-effort —
/// races are possible but unlikely on CI runners.
fn pick_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

/// Boot anvil with a fork URL on the chosen port. Wait until it accepts
/// TCP connections (anvil's `--silent` mode skips the readiness banner,
/// so we poll the socket).
struct AnvilGuard {
    child: Child,
    port: u16,
}

impl Drop for AnvilGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn boot_anvil(fork_url: &str) -> Result<AnvilGuard, String> {
    if which::which("anvil").is_err() {
        return Err("anvil not on PATH (install Foundry)".into());
    }
    let port = pick_port();
    let mut cmd = Command::new("anvil");
    let mut args = vec![
        "--fork-url".to_string(),
        fork_url.to_string(),
        "--port".to_string(),
        port.to_string(),
        "--silent".to_string(),
    ];
    if let Ok(block) = std::env::var("RMPC_FORK_BLOCK") {
        if !block.is_empty() {
            args.push("--fork-block-number".to_string());
            args.push(block);
        }
    }
    cmd.args(&args).stdout(Stdio::null()).stderr(Stdio::piped());
    let child = cmd.spawn().map_err(|e| format!("spawn anvil: {e}"))?;

    // Poll until anvil accepts connections (or 30s timeout).
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            Duration::from_millis(200),
        )
        .is_ok()
        {
            return Ok(AnvilGuard { child, port });
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err("anvil did not become reachable within 30s".into())
}

/// Write a temp config that points at the booted anvil. Reuses the
/// shipped fixture as a base; only `rpc_url` changes (so the parsed
/// shape stays in lockstep with the walkthrough's documented template).
fn write_temp_config(tmp: &tempfile::TempDir, port: u16) -> std::path::PathBuf {
    let template = fs::read_to_string(config_template_path()).expect("read template");
    let body = template.replace(
        "rpc_url               = \"http://127.0.0.1:8545\"",
        &format!("rpc_url               = \"http://127.0.0.1:{port}\""),
    );
    let path = tmp.path().join("rmpc-walkthrough.toml");
    fs::write(&path, body).expect("write temp config");
    path
}

#[test]
fn get_vault_against_fork_envelope_contract() {
    let fork_url = skip_if_no_fork!();
    let anvil = match boot_anvil(&fork_url) {
        Ok(g) => g,
        Err(e) => {
            eprintln!("[opencode-walkthrough] skipping: {e}");
            return;
        }
    };
    let tmp = tempfile::tempdir().expect("tempdir");
    let cfg = write_temp_config(&tmp, anvil.port);

    let mut child = Command::new(rmpc_bin())
        .args(["get-vault", "--config"])
        .arg(&cfg)
        .arg("--pretty")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn rmpc get-vault");
    let stdout = child.stdout.take().unwrap();
    let mut buf = String::new();
    let mut reader = BufReader::new(stdout);
    while let Ok(n) = reader.read_line(&mut buf) {
        if n == 0 {
            break;
        }
    }
    let status = child.wait().expect("wait rmpc");
    let mut stderr = String::new();
    if let Some(mut e) = child.stderr.take() {
        use std::io::Read;
        let _ = e.read_to_string(&mut stderr);
    }

    assert!(
        status.success(),
        "rmpc get-vault failed against fork: stderr=\n{stderr}\nstdout=\n{buf}"
    );

    let v: Value = serde_json::from_str(&buf)
        .unwrap_or_else(|e| panic!("rmpc get-vault stdout is not valid JSON: {e}\nstdout=\n{buf}"));

    // Contract from docs/technical/rmpc-read-output-contract.md.
    assert!(
        v.get("chain_id").is_some(),
        "envelope missing `chain_id`: {v}"
    );
    assert!(
        v.get("block_number").is_some(),
        "envelope missing `block_number`: {v}"
    );
    assert_eq!(
        v.get("source").and_then(Value::as_str),
        Some("json_rpc"),
        "envelope `source` must be `json_rpc`: {v}"
    );

    // Envelope partial shape.
    assert!(
        v.get("partial").is_some(),
        "envelope missing `partial`: {v}"
    );
    assert!(v.get("errors").is_some(), "envelope missing `errors`: {v}");

    // Vault data — confirm the walkthrough config points at the right contract.
    let data = &v["data"];
    assert_eq!(
        data["asset"].as_str().unwrap_or("").to_lowercase(),
        "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        "get-vault data.asset must be Base USDC"
    );
    assert_eq!(data["symbol"], "rmUSDC", "get-vault data.symbol drift");
    assert_eq!(data["decimals"], 6, "get-vault data.decimals drift");

    drop(anvil); // explicit teardown
}

#[test]
fn get_gateway_against_fork_is_partial() {
    let fork_url = skip_if_no_fork!();
    let anvil = match boot_anvil(&fork_url) {
        Ok(g) => g,
        Err(e) => {
            eprintln!("[opencode-walkthrough] skipping: {e}");
            return;
        }
    };
    let tmp = tempfile::tempdir().expect("tempdir");
    let cfg = write_temp_config(&tmp, anvil.port);

    let out = Command::new(rmpc_bin())
        .args(["get-gateway", "--config"])
        .arg(&cfg)
        .output()
        .expect("spawn rmpc get-gateway");

    assert!(
        out.status.success(),
        "rmpc get-gateway must exit 0 even for partial reads; \
         stderr=\n{}",
        String::from_utf8_lossy(&out.stderr)
    );

    let v: Value =
        serde_json::from_slice(&out.stdout).expect("rmpc get-gateway stdout is not valid JSON");

    // Envelope contract.
    assert!(
        v.get("chain_id").is_some(),
        "envelope missing chain_id: {v}"
    );
    assert_eq!(v["source"], "json_rpc", "source must be json_rpc: {v}");

    // Documented degradation shape: gateway_address is dead EOA.
    assert_eq!(
        v["partial"], true,
        "get-gateway must be partial=true when gateway is not deployed: {v}"
    );
    let errors = v["errors"]
        .as_array()
        .expect("errors must be an array when partial=true");
    assert!(
        !errors.is_empty(),
        "get-gateway must report at least one named per-field error: {v}"
    );
    for e in errors {
        assert!(
            e["field"].is_string(),
            "each error must carry a `field`: {e}"
        );
        assert!(
            e["error"].is_string() || e["message"].is_string(),
            "each error must carry an error/message string: {e}"
        );
    }

    drop(anvil);
}
