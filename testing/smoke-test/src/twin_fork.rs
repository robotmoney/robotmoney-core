//! Canonical: docs/technical/full-stack-devnet.md, scripts/devnet/README-twin-fork.md (core 1498, 1496, c5).
//!
//! The Twin chain (chain id 918453) is a pinned lazy fork of real Base state made with anvil. This
//! module is the Rust side of `scripts/devnet/twin-fork.ts`: it spawns the tool, or reuses a fork
//! that is already running (the env `TWIN_RPC_URL`), waits until the fork is ready, and drives the
//! three environment steps that may differ from production: fund gas, fund USDC and warp time.
//!
//! There is no warm list, no state dump, no patched state and no genesis snapshot. The harness
//! deploys its own vault through the publish contracts runbook and reads the addresses from the
//! manifests. Nothing here knows a production v1 address (clean room rule).
//!
//! ## Reuse
//!
//! * `TWIN_RPC_URL` set: the harness uses that fork (the CI composite action
//!   `.github/actions/twin-fork` exports it). It never stops a fork it did not start.
//! * `TWIN_RPC_URL` unset: the harness starts its own fork on a free port (or the pinned port) and
//!   stops it on drop. `TWIN_PIN_BLOCK` pins the block (a CI run sets it once); unset means the tool
//!   picks the upstream head minus 2. `BASE_UPSTREAM_RPC` (optional secret) and `TWIN_CACHE_DIR`
//!   pass through to the tool. This module never logs the upstream URL.
//!
//! ## Block time
//!
//! A harness-started fork runs with `--block-time 1`. `services/explorer-indexer` caps its safe head
//! at `tip - CONFIRMATIONS` (5), so the tip has to keep moving after the last transaction. A fork
//! reused from the environment must be started with the same block time (the composite action takes
//! the input `block-time`).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use alloy_primitives::U256;

use crate::{logging, HarnessError};

/// Synthetic chain id of the Twin chain. rmpc refuses software-keystore writes on 8453.
pub const TWIN_CHAIN_ID: u64 = 918_453;

/// Real Base USDC (FiatTokenProxy). Real Base state, so it is the real token on the Twin chain.
pub const BASE_USDC_ADDR: &str = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/// Env: RPC URL of a Twin fork that is already running. When set the harness reuses it.
pub const TWIN_RPC_URL_ENV: &str = "TWIN_RPC_URL";
/// Env: pinned Base block for a harness-started fork (a CI run chooses it once).
pub const TWIN_PIN_BLOCK_ENV: &str = "TWIN_PIN_BLOCK";
/// Env: directory that persists anvil's RPC cache (the tool runs anvil with HOME set to it).
pub const TWIN_CACHE_DIR_ENV: &str = "TWIN_CACHE_DIR";
/// Env override for the address containers use to reach the host-side fork.
pub const TWIN_HOST_ADDR_ENV: &str = "SMOKE_TEST_ANVIL_HOST_ADDR";

/// ETH has 18 decimals.
const WEI_PER_ETH: u128 = 1_000_000_000_000_000_000;

/// A Twin fork the harness talks to. Drop stops a fork the harness started. A reused fork is left alone.
pub struct TwinFork {
    rpc_port: u16,
    rpc_url: String,
    script: PathBuf,
    /// Some(dir) when this fixture started the fork and so owns stopping it.
    owned_state_dir: Option<PathBuf>,
}

/// Port of an `http://host:port` URL. None when there is no explicit port.
pub fn port_from_url(url: &str) -> Option<u16> {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let authority = rest.split('/').next().unwrap_or(rest);
    authority.rsplit_once(':')?.1.parse::<u16>().ok()
}

/// Decimal ETH string for `anvil_setBalance` through `twin-fork.ts fund-gas`. The tool takes ETH
/// with up to 18 decimals, so a wei amount converts exactly.
pub fn wei_to_eth_string(wei: u128) -> String {
    let whole = wei / WEI_PER_ETH;
    let frac = wei % WEI_PER_ETH;
    if frac == 0 {
        return whole.to_string();
    }
    let frac = format!("{frac:018}");
    format!("{whole}.{}", frac.trim_end_matches('0'))
}

/// `balanceOf(address)` calldata for the real USDC token.
pub fn usdc_balance_of_calldata(holder: &str) -> String {
    let h = holder.trim_start_matches("0x").to_lowercase();
    format!("0x70a08231{h:0>64}")
}

/// The argv `twin-fork.ts start` gets for a harness-owned fork. Pure, so it is unit tested.
/// Never contains an upstream URL: the tool reads `BASE_UPSTREAM_RPC` from its environment.
pub fn start_args(
    script: &Path,
    port: u16,
    state_dir: &Path,
    pin_block: Option<&str>,
    cache_dir: Option<&str>,
) -> Vec<String> {
    let mut a = vec![
        script.to_string_lossy().to_string(),
        "start".into(),
        "--port".into(),
        port.to_string(),
        // Containers (the explorer-indexer) reach the fork over the Docker bridge, not loopback.
        "--host".into(),
        "0.0.0.0".into(),
        // The indexer's safe head is tip - 5, so the tip must keep moving. See the module docs.
        "--block-time".into(),
        "1".into(),
        "--state-dir".into(),
        state_dir.to_string_lossy().to_string(),
        "--pin-file".into(),
        state_dir.join("pin.json").to_string_lossy().to_string(),
        "--pin-block".into(),
        pin_block
            .filter(|p| !p.is_empty())
            .unwrap_or("auto")
            .to_string(),
    ];
    if let Some(c) = cache_dir.filter(|c| !c.is_empty()) {
        a.push("--cache-dir".into());
        a.push(c.to_string());
    }
    a
}

/// Boot the Twin chain: reuse the fork named by `TWIN_RPC_URL`, or run `scripts/devnet/twin-fork.ts`
/// on `preferred_port`, and return once it answers with chain id 918453. See [`TwinFork::boot`].
pub fn boot_twin_fork(repo_root: &Path, preferred_port: u16) -> Result<TwinFork, HarnessError> {
    TwinFork::boot(repo_root, preferred_port)
}

impl TwinFork {
    /// Reuse the fork named by `TWIN_RPC_URL`, or start one on `preferred_port`.
    pub fn boot(repo_root: &Path, preferred_port: u16) -> Result<Self, HarnessError> {
        if which::which("bun").is_err() {
            return Err(HarnessError::FoundryMissing("bun"));
        }
        let script = repo_root.join("scripts/devnet/twin-fork.ts");
        if !script.is_file() {
            return Err(HarnessError::other(format!(
                "{} not found: the Twin chain needs scripts/devnet/twin-fork.ts",
                script.display()
            )));
        }
        let reused = std::env::var(TWIN_RPC_URL_ENV)
            .ok()
            .map(|u| u.trim().trim_end_matches('/').to_string())
            .filter(|u| !u.is_empty());
        let me = match reused {
            Some(url) => {
                let rpc_port = port_from_url(&url).ok_or_else(|| {
                    HarnessError::other(format!(
                        "{TWIN_RPC_URL_ENV} must be http://host:port (got a URL without a port)"
                    ))
                })?;
                logging::info("twin", format!("reusing the running Twin fork at {url}"));
                Self {
                    rpc_port,
                    rpc_url: url,
                    script,
                    owned_state_dir: None,
                }
            }
            None => {
                if port_has_listener(preferred_port) {
                    return Err(HarnessError::other(format!(
                        "port {preferred_port} already has a listener. Stop it, or set \
                         {TWIN_RPC_URL_ENV} to reuse a running Twin fork; booting on top of it would \
                         silently run this fixture against that chain"
                    )));
                }
                let state_dir = std::env::temp_dir().join(format!(
                    "smoke-twin-{}-{preferred_port}",
                    std::process::id()
                ));
                std::fs::create_dir_all(&state_dir)?;
                let pin = std::env::var(TWIN_PIN_BLOCK_ENV).ok();
                let cache = std::env::var(TWIN_CACHE_DIR_ENV).ok();
                let args = start_args(
                    &script,
                    preferred_port,
                    &state_dir,
                    pin.as_deref(),
                    cache.as_deref(),
                );
                logging::info(
                    "twin",
                    "starting the Twin fork with scripts/devnet/twin-fork.ts",
                );
                // From here on a failure must still stop what may have started.
                let me = Self {
                    rpc_port: preferred_port,
                    rpc_url: crate::localhost_url(preferred_port),
                    script: script.clone(),
                    owned_state_dir: Some(state_dir),
                };
                let out = Command::new("bun")
                    .args(&args)
                    .env_remove(TWIN_RPC_URL_ENV)
                    .stdin(Stdio::null())
                    .output()?;
                logging::log_command_output("twin", &out);
                if !out.status.success() {
                    return Err(HarnessError::other(format!(
                        "twin-fork start failed ({:?}): {}",
                        out.status.code(),
                        String::from_utf8_lossy(&out.stderr)
                    )));
                }
                me
            }
        };
        me.wait_ready(Duration::from_secs(180))?;
        Ok(me)
    }

    pub fn rpc_url(&self) -> &str {
        &self.rpc_url
    }

    pub fn rpc_port(&self) -> u16 {
        self.rpc_port
    }

    /// True iff this fixture started the fork (and so stops it).
    pub fn is_owned(&self) -> bool {
        self.owned_state_dir.is_some()
    }

    /// RPC endpoint a Docker container can reach: the bridge gateway address and the fork port.
    pub fn container_rpc_url(&self) -> String {
        format!("http://{}:{}", container_host_addr(), self.rpc_port)
    }

    /// Run one `twin-fork.ts` command against this fork.
    fn tool(&self, args: &[&str]) -> Result<String, HarnessError> {
        let out = Command::new("bun")
            .arg(&self.script)
            .args(args)
            .arg("--rpc-url")
            .arg(&self.rpc_url)
            .stdin(Stdio::null())
            .output()?;
        if !out.status.success() {
            return Err(HarnessError::other(format!(
                "twin-fork {} failed ({:?}): {}",
                args.first().copied().unwrap_or(""),
                out.status.code(),
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// `eth_chainId` is 918453 and the fork has a head block. Polls until `timeout`.
    fn wait_ready(&self, timeout: Duration) -> Result<(), HarnessError> {
        crate::wait_for_rpc(&self.rpc_url, timeout)?;
        let id = self.chain_id()?;
        if id != TWIN_CHAIN_ID {
            return Err(HarnessError::other(format!(
                "{} reports chain id {id}, the Twin chain is {TWIN_CHAIN_ID}. Refusing to run on it.",
                self.rpc_url
            )));
        }
        Ok(())
    }

    fn chain_id(&self) -> Result<u64, HarnessError> {
        let v = self.rpc("eth_chainId", serde_json::json!([]))?;
        let hex = v
            .as_str()
            .ok_or_else(|| HarnessError::other("eth_chainId returned a non-string result"))?;
        u64::from_str_radix(hex.trim_start_matches("0x"), 16)
            .map_err(|e| HarnessError::other(format!("eth_chainId parse: {e}")))
    }

    /// Set the native balance of `address` to `wei` (an environment step: fund gas).
    pub fn fund_gas(&self, address: &str, wei: u128) -> Result<(), HarnessError> {
        self.tool(&["fund-gas", address, &wei_to_eth_string(wei)])?;
        Ok(())
    }

    /// Set the real FiatToken balance of `address` to `units` USDC base units (6 decimals). This is
    /// an absolute write, not a grant. See [`crate::Fixture::fund_usdc`] for the additive form.
    pub fn set_usdc_balance(&self, address: &str, units: u128) -> Result<(), HarnessError> {
        self.tool(&["fund-usdc", address, &units.to_string()])?;
        Ok(())
    }

    /// Set the ERC-20 balance of `holder` on `token` to `units`, for a plain OpenZeppelin-layout token whose
    /// `_balances` mapping sits at storage slot 0 (the live RM token). The slot is `keccak256(holder . 0)`,
    /// derived with `cast index`. Verifies with `balanceOf`, so a token with another layout fails loudly.
    /// Total supply is not changed. Like `set_usdc_balance`, this is a Twin chain environment step.
    pub fn set_slot0_erc20_balance(
        &self,
        token: &str,
        holder: &str,
        units: u128,
    ) -> Result<(), HarnessError> {
        let idx = Command::new("cast")
            .args(["index", "address", holder, "0"])
            .output()?;
        if !idx.status.success() {
            return Err(HarnessError::other(format!(
                "cast index failed: {}",
                String::from_utf8_lossy(&idx.stderr)
            )));
        }
        let slot = String::from_utf8_lossy(&idx.stdout).trim().to_string();
        let word = format!("0x{units:064x}");
        self.rpc("anvil_setStorageAt", serde_json::json!([token, slot, word]))?;
        let data = format!(
            "0x70a08231{:0>64}",
            holder.trim_start_matches("0x").to_lowercase()
        );
        let v = self.rpc(
            "eth_call",
            serde_json::json!([{"to": token, "data": data}, "latest"]),
        )?;
        let got = U256::from_str_radix(v.as_str().unwrap_or("0x0").trim_start_matches("0x"), 16)
            .map_err(|e| HarnessError::other(format!("balanceOf parse: {e}")))?;
        if got != U256::from(units) {
            return Err(HarnessError::other(format!(
                "{token} balanceOf({holder}) is {got}, wanted {units}: storage slot 0 is not its balances mapping"
            )));
        }
        Ok(())
    }

    /// USDC balance of `address` by a plain `eth_call` to the real token.
    pub fn usdc_balance(&self, address: &str) -> Result<u128, HarnessError> {
        let v = self.rpc(
            "eth_call",
            serde_json::json!([{"to": BASE_USDC_ADDR, "data": usdc_balance_of_calldata(address)}, "latest"]),
        )?;
        let hex = v.as_str().ok_or_else(|| {
            HarnessError::other("eth_call balanceOf returned a non-string result")
        })?;
        let n = U256::from_str_radix(hex.trim_start_matches("0x"), 16)
            .map_err(|e| HarnessError::other(format!("balanceOf parse: {e}")))?;
        u128::try_from(n).map_err(|_| HarnessError::other("USDC balance does not fit in u128"))
    }

    /// Move chain time forward by `seconds` and mine a block (`evm_increaseTime` then `evm_mine`).
    /// This is how a 48h governance wait runs on the Twin chain. The tool refuses chain id 8453.
    pub fn warp(&self, seconds: u64) -> Result<(), HarnessError> {
        self.tool(&["warp", &seconds.to_string()])?;
        Ok(())
    }

    fn rpc(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, HarnessError> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| HarnessError::other(format!("reqwest builder: {e}")))?;
        let body =
            serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        let resp = client
            .post(&self.rpc_url)
            .json(&body)
            .send()
            .map_err(|e| HarnessError::other(format!("{method}: {e}")))?;
        if !resp.status().is_success() {
            return Err(HarnessError::other(format!(
                "{method}: HTTP {}",
                resp.status()
            )));
        }
        let json: serde_json::Value = resp
            .json()
            .map_err(|e| HarnessError::other(format!("{method}: response decode: {e}")))?;
        if let Some(error) = json.get("error") {
            return Err(HarnessError::other(format!("{method}: {error}")));
        }
        Ok(json
            .get("result")
            .cloned()
            .unwrap_or(serde_json::Value::Null))
    }
}

impl Drop for TwinFork {
    fn drop(&mut self) {
        if let Some(dir) = self.owned_state_dir.take() {
            logging::info("twin", "stopping the Twin fork this fixture started");
            let _ = Command::new("bun")
                .arg(&self.script)
                .args(["stop", "--port", &self.rpc_port.to_string(), "--state-dir"])
                .arg(&dir)
                .env_remove(TWIN_RPC_URL_ENV)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

/// True when something already accepts connections on `port` (loopback). A live local listener
/// answers at once and a free port refuses at once, so a short timeout is enough.
fn port_has_listener(port: u16) -> bool {
    use std::net::{Ipv4Addr, SocketAddr, TcpStream};
    TcpStream::connect_timeout(
        &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        Duration::from_millis(250),
    )
    .is_ok()
}

/// Address a container uses to reach the host. Prefers the Docker bridge gateway (routable from
/// every bridge network on Linux), falls back to `host.docker.internal`.
fn container_host_addr() -> String {
    if let Ok(value) = std::env::var(TWIN_HOST_ADDR_ENV) {
        let value = value.trim().to_string();
        if !value.is_empty() {
            return value;
        }
    }
    let out = Command::new("docker")
        .args([
            "network",
            "inspect",
            "bridge",
            "-f",
            "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
        ])
        .output();
    if let Ok(out) = out {
        if out.status.success() {
            let gateway = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !gateway.is_empty() {
                return gateway;
            }
        }
    }
    "host.docker.internal".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chain_id_is_the_twin_id_not_base() {
        assert_eq!(TWIN_CHAIN_ID, 918_453);
        assert_ne!(TWIN_CHAIN_ID, 8_453);
    }

    #[test]
    fn port_from_url_reads_the_port() {
        assert_eq!(port_from_url("http://127.0.0.1:8545"), Some(8545));
        assert_eq!(port_from_url("http://localhost:18545/"), Some(18545));
        assert_eq!(port_from_url("http://localhost"), None);
        assert_eq!(port_from_url("http://localhost:notaport"), None);
    }

    #[test]
    fn wei_to_eth_string_is_exact() {
        assert_eq!(wei_to_eth_string(0), "0");
        assert_eq!(wei_to_eth_string(WEI_PER_ETH), "1");
        assert_eq!(wei_to_eth_string(10_000 * WEI_PER_ETH), "10000");
        assert_eq!(wei_to_eth_string(WEI_PER_ETH / 2), "0.5");
        assert_eq!(wei_to_eth_string(1), "0.000000000000000001");
        assert_eq!(wei_to_eth_string(WEI_PER_ETH + 10u128.pow(16)), "1.01");
    }

    #[test]
    fn balance_of_calldata_pads_the_holder() {
        assert_eq!(
            usdc_balance_of_calldata("0xaE67A1B2A267a124Cf762098E3Cbf6B03329E6d5"),
            "0x70a08231000000000000000000000000ae67a1b2a267a124cf762098e3cbf6b03329e6d5"
        );
    }

    #[test]
    fn start_args_never_carry_an_upstream_url_and_always_tick_blocks() {
        let a = start_args(
            Path::new("/r/scripts/devnet/twin-fork.ts"),
            18545,
            Path::new("/t/s"),
            None,
            None,
        );
        assert!(!a.iter().any(|x| x.contains("http")), "{a:?}");
        let at = |k: &str| a[a.iter().position(|x| x == k).unwrap() + 1].clone();
        assert_eq!(at("--block-time"), "1");
        assert_eq!(at("--host"), "0.0.0.0");
        assert_eq!(at("--pin-block"), "auto");
        assert!(!a.contains(&"--cache-dir".to_string()));
    }

    #[test]
    fn start_args_pass_the_pin_and_the_cache_dir() {
        let a = start_args(
            Path::new("/r/twin-fork.ts"),
            1,
            Path::new("/t/s"),
            Some("34567890"),
            Some("/cache"),
        );
        let at = |k: &str| a[a.iter().position(|x| x == k).unwrap() + 1].clone();
        assert_eq!(at("--pin-block"), "34567890");
        assert_eq!(at("--cache-dir"), "/cache");
        // An empty pin env (a CI input that was left blank) means auto, not "".
        let b = start_args(
            Path::new("/r/twin-fork.ts"),
            1,
            Path::new("/t/s"),
            Some(""),
            Some(""),
        );
        assert_eq!(
            b[b.iter().position(|x| x == "--pin-block").unwrap() + 1],
            "auto"
        );
        assert!(!b.contains(&"--cache-dir".to_string()));
    }
}
