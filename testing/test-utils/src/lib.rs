// Canonical: none — shared test helper crate
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// Walk up from `CARGO_MANIFEST_DIR` to find the workspace root.
/// Identified by the presence of both `foundry.toml` and `clients/rust-payment-client`.
pub fn find_workspace_root() -> Option<PathBuf> {
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for _ in 0..8 {
        if dir.join("foundry.toml").exists() && dir.join("clients/rust-payment-client").exists() {
            return Some(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

/// Bind to port 0 and return the OS-assigned ephemeral port.
pub fn pick_free_port() -> std::io::Result<u16> {
    let l = TcpListener::bind("127.0.0.1:0")?;
    Ok(l.local_addr()?.port())
}

/// Poll `eth_chainId` until the RPC responds or `timeout` elapses.
/// Returns `Err(String)` with the last error on timeout.
pub fn wait_for_rpc(url: &str, timeout: Duration) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| format!("reqwest builder: {e}"))?;
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []
    });
    let deadline = Instant::now() + timeout;
    let mut last = String::new();
    while Instant::now() < deadline {
        match client.post(url).json(&body).send() {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(j) = resp.json::<serde_json::Value>() {
                    if j.get("result").is_some() {
                        return Ok(());
                    }
                }
            }
            Ok(resp) => last = format!("HTTP {}", resp.status()),
            Err(e) => last = format!("{e}"),
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(format!(
        "RPC at {url} not reachable after {timeout:?}: {last}"
    ))
}

/// Poll `eth_blockNumber` until `>= target` or `timeout` elapses.
pub fn wait_for_block_height(url: &str, target: u64, timeout: Duration) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("reqwest builder: {e}"))?;
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []
    });
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(resp) = client.post(url).json(&body).send() {
            if let Ok(j) = resp.json::<serde_json::Value>() {
                if let Some(s) = j.get("result").and_then(|v| v.as_str()) {
                    if let Ok(n) = u64::from_str_radix(s.trim_start_matches("0x"), 16) {
                        if n >= target {
                            return Ok(());
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(1000));
    }
    Err(format!(
        "block height {target} not reached at {url} after {timeout:?}"
    ))
}

/// Build the `rmpc` binary once per process and cache the path.
/// Uses the workspace Cargo.toml and the shared `target/debug/` directory.
pub fn build_rmpc_bin() -> &'static PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let root = find_workspace_root().expect("could not locate workspace root");
        let manifest = root.join("Cargo.toml");
        let status = Command::new(env!("CARGO"))
            .args(["build", "--quiet", "--bin", "rmpc", "--manifest-path"])
            .arg(&manifest)
            .status()
            .expect("spawn cargo build for rmpc");
        assert!(status.success(), "cargo build --bin rmpc failed");
        let bin = root.join("target/debug/rmpc");
        assert!(bin.exists(), "rmpc binary not found at {bin:?} after build");
        bin
    })
}
