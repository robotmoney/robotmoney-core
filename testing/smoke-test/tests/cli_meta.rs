//! Meta-tests for the smoke-test CLI harness.
//!
//! These tests exercise the user-facing `smoke-test` binary instead of the
//! library fixture directly. That catches wiring regressions in:
//! - `--full-stack`
//! - `--dapp-port`
//! - endpoint summary output
//! - Ctrl-C teardown of both compose stacks
//!
//! The existing `fixture_meta` suite covers the chain fixture itself. This
//! file covers the CLI entrypoint around it.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use smoke_test::{locate_repo_root, prerequisites_available};
use test_utils::pick_free_port;

const BOOT_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[test]
fn full_stack_cli_boots_and_tears_down() {
    if !prerequisites_available() {
        eprintln!("[cli_meta] docker/forge/cast not on PATH; skipping.");
        return;
    }

    let repo_root = locate_repo_root().expect("locate repo root");
    let dapp_port = pick_free_port().expect("pick a free dapp port");
    let dapp_port = dapp_port.to_string();

    let mut child = Command::new("cargo")
        .args([
            "run",
            "--release",
            "-p",
            "smoke-test",
            "--",
            "--full-stack",
            "--dapp-port",
            &dapp_port,
        ])
        .current_dir(&repo_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn smoke-test");

    let stderr = child.stderr.take().expect("smoke-test stderr pipe");
    let stderr_handle = thread::spawn(move || drain_stderr(stderr));
    let stdout = child.stdout.take().expect("smoke-test stdout pipe");
    let (tx, rx) = mpsc::channel();
    let stdout_handle = thread::spawn(move || drain_stdout(stdout, tx));

    let endpoints = wait_for_summary(rx, BOOT_TIMEOUT).expect("smoke-test endpoint summary");
    assert_eq!(
        endpoints.get("dapp_url"),
        Some(&format!("http://localhost:{dapp_port}")),
        "smoke-test did not honor --dapp-port"
    );
    assert_required_fields(&endpoints);

    send_sigint(child.id());
    wait_for_exit(&mut child, SHUTDOWN_TIMEOUT).expect("smoke-test to exit after SIGINT");

    stdout_handle.join().expect("stdout reader thread");
    stderr_handle.join().expect("stderr reader thread");

    assert_no_containers_with_prefix("eth-");
    assert_no_containers_with_prefix("dapp-");
}

fn drain_stdout(stdout: impl std::io::Read + Send + 'static, tx: mpsc::Sender<String>) {
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        match line {
            Ok(line) => {
                let _ = tx.send(line);
            }
            Err(err) => {
                let _ = tx.send(format!("__STDOUT_ERROR__={err}"));
                break;
            }
        }
    }
}

fn drain_stderr(stderr: impl std::io::Read + Send + 'static) {
    let reader = BufReader::new(stderr);
    for line in reader.lines() {
        match line {
            Ok(line) => eprintln!("[smoke-test stderr] {line}"),
            Err(err) => {
                eprintln!("[smoke-test stderr] __ERROR__ {err}");
                break;
            }
        }
    }
}

fn wait_for_summary(
    rx: mpsc::Receiver<String>,
    timeout: Duration,
) -> Result<BTreeMap<String, String>, String> {
    let deadline = Instant::now() + timeout;
    let mut in_summary = false;
    let mut fields = BTreeMap::new();

    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(format!(
                "timed out after {:?} waiting for smoke-test endpoint summary",
                timeout
            ));
        }

        let line = match rx.recv_timeout(deadline.saturating_duration_since(now)) {
            Ok(line) => line,
            Err(RecvTimeoutError::Timeout) => {
                return Err(format!(
                    "timed out after {:?} waiting for smoke-test endpoint summary",
                    timeout
                ));
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err("smoke-test exited before emitting endpoint summary".to_string());
            }
        };

        eprintln!("[smoke-test] {line}");
        let trimmed = line.trim_end();
        if let Some(err) = trimmed.strip_prefix("__STDOUT_ERROR__=") {
            return Err(format!("stdout reader error: {err}"));
        }
        if trimmed == "--- endpoint summary ---" {
            in_summary = true;
            continue;
        }
        if trimmed == "--- end endpoint summary ---" {
            if !in_summary {
                return Err("saw end-of-summary marker before summary began".to_string());
            }
            return Ok(fields);
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            fields.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
}

fn assert_required_fields(fields: &BTreeMap<String, String>) {
    for key in [
        "rpc_url",
        "chain_id",
        "gateway_addr",
        "usdc_addr",
        "vault_addr",
        "agent_addr",
        "gateway_runtime_hash",
        "dapp_url",
        "explorer_api_url",
    ] {
        assert!(
            fields.contains_key(key),
            "missing {key} in smoke-test output"
        );
    }
}

fn send_sigint(pid: u32) {
    let pid = pid.to_string();
    let status = Command::new("kill")
        .args(["-INT", &pid])
        .status()
        .expect("send SIGINT");
    assert!(status.success(), "kill -INT {pid} failed: {status:?}");
}

fn wait_for_exit(child: &mut Child, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            if status.success() {
                return Ok(());
            }
            return Err(format!("smoke-test exited with {status}"));
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "timed out after {:?} waiting for smoke-test to exit",
                timeout
            ));
        }
        thread::sleep(Duration::from_secs(1));
    }
}

fn assert_no_containers_with_prefix(prefix: &str) {
    let output = Command::new("docker")
        .args(["ps", "--format", "{{.Names}}"])
        .output()
        .expect("docker ps");
    assert!(
        output.status.success(),
        "docker ps failed: {:?}",
        output.status
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.lines().all(|name| !name.starts_with(prefix)),
        "{prefix} containers still running:\n{stdout}"
    );
}
