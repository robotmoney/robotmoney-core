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
use std::fs;
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
    let log_dir = tempfile::tempdir().expect("create log dir");
    let log_path = log_dir.path().join("smoke-test-cli_meta.log");
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
            "--log-file",
            log_path.to_str().expect("utf8 log path"),
        ])
        .current_dir(&repo_root)
        .env("SMOKE_TEST_LOG_FILE", &log_path)
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

    assert_log_file_present(&log_path);
    assert_log_contains(
        &log_path,
        &[
            "CLI starting",
            "chain startup config:",
            "chain RPC ready; waiting for EL/CL block production",
            "chain EL/CL stack ready",
            "dapp startup config:",
            "full stack ready",
            "shutdown reason=ctrl-c tearing down stacks",
        ],
    );
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

fn assert_log_file_present(log_path: &std::path::Path) {
    let raw = fs::read_to_string(log_path).unwrap_or_else(|err| {
        panic!(
            "smoke-test log file missing at {}: {err}",
            log_path.display()
        )
    });
    let mut services = std::collections::BTreeSet::new();
    let mut line_count = 0;

    for line in raw.lines() {
        line_count += 1;
        let (timestamp, rest) = line
            .split_once(" [")
            .unwrap_or_else(|| panic!("missing timestamp/service prefix: {line}"));
        chrono::DateTime::parse_from_rfc3339(timestamp)
            .unwrap_or_else(|err| panic!("invalid RFC3339 timestamp `{timestamp}`: {err}"));
        let (service, remainder) = rest
            .split_once("] [")
            .unwrap_or_else(|| panic!("missing service/level tag: {line}"));
        assert!(
            !service.is_empty(),
            "empty service tag in smoke-test log line: {line}"
        );
        let (level, message) = remainder
            .split_once("] ")
            .unwrap_or_else(|| panic!("missing level/message separator: {line}"));
        assert!(
            !level.is_empty() && !message.is_empty(),
            "incomplete smoke-test log line: {line}"
        );
        services.insert(service.to_string());
    }

    assert!(line_count > 0, "smoke-test log file was empty");
    assert!(
        services.len() >= 2,
        "expected logs from at least two services, got {services:?}"
    );
}

fn assert_log_contains(log_path: &std::path::Path, needles: &[&str]) {
    let raw = fs::read_to_string(log_path).unwrap_or_else(|err| {
        panic!(
            "smoke-test log file missing at {}: {err}",
            log_path.display()
        )
    });
    for needle in needles {
        assert!(
            raw.contains(needle),
            "expected smoke-test log to contain `{needle}`, but it did not"
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
