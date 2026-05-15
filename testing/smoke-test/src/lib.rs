//! Canonical: docs/testing/smoke-test-design.md
//!
//! Devnet fixture library for Robot Money integration tests.
//!
//! Boot the Geth+Lighthouse devnet and deploy contracts by constructing
//! [`Fixture`]. Drop tears the Docker Compose stack down unconditionally.
//!
//! This crate is chain-level only — no knowledge of any client binary
//! (rmpc, dapp, explorer). Callers that need client helpers import this
//! crate as a dependency and build on top of [`Fixture`].
//!
//! Public surface:
//! - [`Fixture::new`] / [`Fixture::with_deploy_env`] — boot and deploy.
//! - Address accessors: [`Fixture::rpc_url`], [`Fixture::gateway`], etc.
//! - On-chain poke helpers: [`Fixture::pause_gateway`], [`Fixture::fund_usdc`], etc.
//! - [`prerequisites_available`] — check for docker/forge/cast on PATH.
//! - [`fork_manifest::ForkManifest`] — typed view over
//!   `testing/ethereum-testnet/config/fork-block.json` (issue #255).

pub mod fork_manifest;
pub mod genesis_alloc;
pub mod logging;

use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use alloy_primitives::{keccak256, Address};
use serde::Deserialize;
use tempfile::TempDir;

// -- Genesis account constants ----------------------------------------

/// Genesis-funded deployer. Used as `--from` for `forge script` and is
/// the recorded **agent owner** in the smoke-test fixture (issue #269 —
/// each depositor is the sole authority over her own agent, so the
/// deployer EOA stands in as the depositor for `revoke_agent` and
/// `reauthorize_agent`). Also holds `ADMIN_ROLE`, which is now scoped to
/// protocol-wide kill switches (`unpause`) and no longer gates any
/// agent's lifecycle.
pub const DEPLOYER_PRIVATE_KEY_HEX: &str =
    "0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31";
pub const DEPLOYER_ADDRESS_HEX: &str = "0x8943545177806ED17B9F23F0a21ee5948eCaa776";

/// Key paired with PAUSER_ROLE. The derived address (`0x6145…`) is
/// granted PAUSER_ROLE at deploy time so [`Fixture::pause_gateway`] can
/// use `cast send` (real signature) without `anvil_impersonateAccount`.
pub const PAUSER_PRIVATE_KEY_HEX: &str =
    "0x53321db7c1e331d93a11a41d16f004d7ff63972ec8ec7c25db329728ceeb1710";
pub const PAUSER_ADDRESS_HEX: &str = "0x614561D2d143621E126e87831AEF287678B442b8";

/// Genesis-funded EOA registered as the vault share receiver.
pub const SHARE_RECEIVER_ADDRESS_HEX: &str = "0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec";

/// Harness USDC holder — the clean-history EOA that receives a genesis-time
/// USDC balance grant on the smoke-test devnet. See
/// `docs/testing/smoke-test-design.md` (USDC faucet section) and issue #255.
///
/// This key MUST NOT be used on any real chain. It is test-only by
/// construction. The genesis ingester writes
/// `usdc.balances[HARNESS_USDC_HOLDER_ADDRESS_HEX] = grant_units` into the
/// devnet's `genesis.json` alloc, and `Fixture::fund_usdc` signs a plain
/// `transfer(address,uint256)` from this key against the canonical Base USDC
/// proxy.
pub const HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX: &str =
    "0xd2dffaf3c3c5e3e2f5cb5cef1a3a2e0e0a8b9d4ae2f6c1d3e8a5b7c9e0f1a2b3";
/// Address derived from [`HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX`]. Verified
/// against `cast wallet address` at definition time. Used by the genesis
/// ingester (for the USDC balance grant + ETH-for-gas alloc) and by
/// `Fixture::fund_usdc` (as the transfer sender).
pub const HARNESS_USDC_HOLDER_ADDRESS_HEX: &str = "0xaE67A1B2A267a124Cf762098E3Cbf6B03329E6d5";

/// 32-byte secp256k1 private key for the test agent EOA. Test-only —
/// never use on a real chain.
/// Derives `0xf93Ee4Cf8c6c40b329b0c0626F28333c132CF241`.
pub const AGENT_PRIVATE_KEY: [u8; 32] = [
    0xab, 0x63, 0xb2, 0x3e, 0xb7, 0x94, 0x1c, 0x12, 0x51, 0x75, 0x7e, 0x24, 0xb3, 0xd2, 0x35, 0x0d,
    0x2b, 0xc0, 0x5c, 0x3c, 0x38, 0x8d, 0x06, 0xf8, 0xfe, 0x6f, 0xea, 0xfe, 0xfb, 0x1e, 0x8c, 0x70,
];

/// Derive the agent EOA address from [`AGENT_PRIVATE_KEY`].
pub fn agent_address() -> Address {
    derive_address(&AGENT_PRIVATE_KEY)
}

// -- Error type -------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum HarnessError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("required binary `{0}` not found on PATH")]
    FoundryMissing(&'static str),
    #[error("RPC at {url} did not become healthy within {timeout:?}")]
    RpcTimeout { url: String, timeout: Duration },
    #[error("forge script failed: {0}")]
    DeployFailed(String),
    #[error("deployment JSON {0}: {1}")]
    DeploymentJson(PathBuf, String),
    #[error("docker compose error: {0}")]
    Docker(String),
    #[error("{0}")]
    Other(String),
}

impl HarnessError {
    pub fn other<S: Into<String>>(s: S) -> Self {
        HarnessError::Other(s.into())
    }
}

// -- Deployment JSON --------------------------------------------------

#[derive(Debug, Deserialize)]
struct DeploymentJson {
    chain_id: u64,
    usdc: String,
    vault: String,
    /// PassthroughAdapter address registered with the vault at deploy time.
    /// Absent on legacy deployments (pre-#277); those used MockVault with no adapter.
    #[serde(default)]
    adapter: String,
    gateway: String,
    #[serde(default)]
    #[allow(dead_code)]
    admin: String,
    #[serde(default)]
    #[allow(dead_code)]
    pauser: String,
    agent: String,
    share_receiver: String,
    gateway_runtime_hash: String,
}

/// Typed view over the registry deployment JSON produced by DeployVaultRegistry.s.sol.
#[derive(Debug, Deserialize)]
struct RegistryDeploymentJson {
    registry: String,
    #[serde(default)]
    #[allow(dead_code)]
    chain_id: u64,
    #[serde(default)]
    #[allow(dead_code)]
    vault_registered: bool,
}

/// Typed view over the router deployment JSON produced by DeployPortfolioRouter.s.sol.
#[derive(Debug, Deserialize)]
struct RouterDeploymentJson {
    router: String,
    #[serde(default)]
    #[allow(dead_code)]
    chain_id: u64,
}

/// Typed view over the governance deployment JSON produced by DeployRouterGovernance.s.sol.
#[derive(Debug, Deserialize)]
struct GovernanceDeploymentJson {
    governance: String,
    #[serde(default)]
    #[allow(dead_code)]
    chain_id: u64,
}

#[derive(Debug, Deserialize)]
struct ComposePsEntry {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "State")]
    state: String,
}

// -- Fixture ----------------------------------------------------------

/// A fully-wired devnet fixture. Boot by calling [`Fixture::new`];
/// Drop tears down the Docker Compose stack.
pub struct Fixture {
    compose_dir: PathBuf,
    /// Tempdir for harness artifacts (deployment JSON, etc.).
    /// Exposed via [`Fixture::tempdir`] so callers can write
    /// additional files (keystores, configs) into the same directory.
    tmp: TempDir,
    compose_log_followers: Vec<MonitoredChild>,
    chain_ports: ChainPorts,
    rpc_port: u16,
    rpc_url: String,
    chain_id: u64,
    deployment: DeploymentJson,
    registry_deployment: RegistryDeploymentJson,
    router_deployment: RouterDeploymentJson,
    governance_deployment: GovernanceDeploymentJson,
    repo_root: PathBuf,
}

#[derive(Debug, Clone, Copy)]
struct ChainPorts {
    rpc_port: u16,
    ws_port: u16,
    authrpc_port: u16,
    beacon_port: u16,
}

#[derive(Debug, Clone, Copy)]
struct DappPorts {
    postgres_port: u16,
    explorer_api_port: u16,
    dapp_port: u16,
}

struct ComposeContainerStatus {
    id: String,
    name: String,
    service: Option<String>,
    state: String,
    health: Option<String>,
    exit_code: Option<i64>,
    oom_killed: bool,
    error: Option<String>,
}

impl ComposeContainerStatus {
    fn describe(&self) -> String {
        let service = self.service.as_deref().unwrap_or("unknown");
        let health = self.health.as_deref().unwrap_or("n/a");
        let exit_code = self
            .exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "n/a".to_string());
        let error = self.error.as_deref().unwrap_or("");
        format!(
            "id={} container={} service={} state={} health={} exit_code={} oom_killed={} error={}",
            self.id, self.name, service, self.state, health, exit_code, self.oom_killed, error
        )
    }

    fn is_unhealthy(&self) -> bool {
        self.oom_killed
            || matches!(
                self.state.as_str(),
                "exited" | "dead" | "removing" | "restarting"
            )
            || self.exit_code.is_some_and(|code| code != 0)
            || self.error.as_deref().is_some_and(|error| !error.is_empty())
    }
}

struct MonitoredChild {
    label: String,
    child: Arc<Mutex<Child>>,
    terminated: Arc<AtomicBool>,
}

impl MonitoredChild {
    fn new(label: impl Into<String>, child: Child) -> Self {
        let label = label.into();
        let child = Arc::new(Mutex::new(child));
        let terminated = Arc::new(AtomicBool::new(false));
        let watcher_child = Arc::clone(&child);
        let watcher_terminated = Arc::clone(&terminated);
        let watcher_label = label.clone();
        thread::spawn(move || loop {
            if watcher_terminated.load(Ordering::SeqCst) {
                return;
            }
            let status = match watcher_child.lock() {
                Ok(mut child) => match child.try_wait() {
                    Ok(Some(status)) => Some(Ok(status)),
                    Ok(None) => None,
                    Err(err) => Some(Err(err)),
                },
                Err(_) => return,
            };
            match status {
                Some(Ok(status)) => {
                    if !watcher_terminated.load(Ordering::SeqCst) {
                        if status.success() {
                            logging::info(
                                &watcher_label,
                                format!("process exited cleanly: {status}"),
                            );
                        } else {
                            logging::error(
                                &watcher_label,
                                format!("process exited unexpectedly: {status}"),
                            );
                        }
                    }
                    return;
                }
                Some(Err(err)) => {
                    logging::error(
                        &watcher_label,
                        format!("process status check failed: {err}"),
                    );
                    return;
                }
                None => thread::sleep(Duration::from_secs(5)),
            }
        });
        Self {
            label,
            child,
            terminated,
        }
    }

    fn terminate(&self) {
        if self.terminated.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        } else {
            logging::warn(&self.label, "child lock poisoned during shutdown");
        }
    }
}

impl Drop for MonitoredChild {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn allocate_unique_port(used: &mut HashSet<u16>) -> Result<u16, HarnessError> {
    loop {
        let port = test_utils::pick_free_port()?;
        if used.insert(port) {
            return Ok(port);
        }
    }
}

fn reserve_port(
    used: &mut HashSet<u16>,
    port: u16,
    label: &'static str,
) -> Result<u16, HarnessError> {
    if used.insert(port) {
        Ok(port)
    } else {
        Err(HarnessError::other(format!(
            "{label} port {port} collides with another allocated port"
        )))
    }
}

fn localhost_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn browser_url(port: u16) -> String {
    format!("http://localhost:{port}")
}

impl ChainPorts {
    /// Allocate chain ports. The Geth RPC port may be pinned via the
    /// `SMOKE_TEST_GETH_RPC_PORT` env var so an external reverse proxy
    /// (e.g. a named cloudflared tunnel with a stable hostname) can
    /// target a deterministic local port. WS / authrpc / beacon stay
    /// randomized since nothing outside the host attaches to them.
    fn allocate() -> Result<Self, HarnessError> {
        let mut used = HashSet::new();
        let rpc_port = match std::env::var("SMOKE_TEST_GETH_RPC_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
        {
            Some(p) => reserve_port(&mut used, p, "geth_rpc")?,
            None => allocate_unique_port(&mut used)?,
        };
        Ok(Self {
            rpc_port,
            ws_port: allocate_unique_port(&mut used)?,
            authrpc_port: allocate_unique_port(&mut used)?,
            beacon_port: allocate_unique_port(&mut used)?,
        })
    }

    fn rpc_url(&self) -> String {
        localhost_url(self.rpc_port)
    }
}

impl DappPorts {
    fn allocate(
        dapp_port: Option<u16>,
        explorer_api_port: Option<u16>,
        occupied_ports: &[u16],
    ) -> Result<Self, HarnessError> {
        let mut used = occupied_ports.iter().copied().collect::<HashSet<_>>();
        let dapp_port = match dapp_port {
            Some(port) => reserve_port(&mut used, port, "dapp")?,
            None => allocate_unique_port(&mut used)?,
        };
        let postgres_port = allocate_unique_port(&mut used)?;
        let explorer_api_port = match explorer_api_port {
            Some(port) => reserve_port(&mut used, port, "explorer_api")?,
            None => allocate_unique_port(&mut used)?,
        };

        Ok(Self {
            postgres_port,
            explorer_api_port,
            dapp_port,
        })
    }

    fn dapp_url(&self) -> String {
        browser_url(self.dapp_port)
    }

    fn explorer_api_url(&self) -> String {
        browser_url(self.explorer_api_port)
    }
}

impl Fixture {
    /// Boot the Docker Geth+Lighthouse devnet, run the gateway deploy
    /// script, and fund the test EOAs.
    pub fn new() -> Result<Self, HarnessError> {
        Self::with_deploy_env(&[])
    }

    /// Like [`Self::new`] but passes extra env vars to `forge script Deploy`.
    /// Used to override deploy-time parameters (e.g. `AGENT_MAX_PER_WINDOW`).
    pub fn with_deploy_env(extra_deploy_env: &[(&str, &str)]) -> Result<Self, HarnessError> {
        if which::which("docker").is_err() {
            return Err(HarnessError::FoundryMissing("docker"));
        }
        if which::which("forge").is_err() {
            return Err(HarnessError::FoundryMissing("forge"));
        }
        if which::which("cast").is_err() {
            return Err(HarnessError::FoundryMissing("cast"));
        }

        let repo_root = locate_repo_root()?;
        let tmp = TempDir::new()?;
        let compose_dir = repo_root.join("testing/ethereum-testnet/config");
        let chain_ports = ChainPorts::allocate()?;
        let rpc_url = chain_ports.rpc_url();

        // Issue #255: render the genesis alloc overlay before booting compose
        // so the `setup` container can bind-mount + merge it into the EL
        // genesis.json. If rendering fails (missing fixture, malformed
        // manifest), fall back to the legacy clean-room genesis path —
        // verbose-logging the reason so the operator can fix it offline.
        let alloc_overlay_path = match render_genesis_alloc_overlay(&repo_root, tmp.path()) {
            Ok(Some(p)) => Some(p),
            Ok(None) => {
                eprintln!(
                    "smoke-test: skipping genesis alloc overlay (fixture or manifest absent); \
                     booting with clean-room genesis (legacy behaviour)"
                );
                None
            }
            Err(e) => {
                eprintln!(
                    "smoke-test: genesis alloc overlay rendering failed: {e}; \
                     falling back to clean-room genesis"
                );
                None
            }
        };

        let compose_files: Vec<&str> = if alloc_overlay_path.is_some() {
            vec![
                "-f",
                "docker-compose.yaml",
                "-f",
                "docker-compose.alloc.yaml",
            ]
        } else {
            vec!["-f", "docker-compose.yaml"]
        };
        let compose_files_owned: Vec<String> =
            compose_files.iter().map(|s| s.to_string()).collect();
        let mut compose_log_env = vec![
            ("GETH_RPC_PORT", chain_ports.rpc_port.to_string()),
            ("GETH_WS_PORT", chain_ports.ws_port.to_string()),
            ("GETH_AUTHRPC_PORT", chain_ports.authrpc_port.to_string()),
            ("BEACON_PORT", chain_ports.beacon_port.to_string()),
        ];
        if let Some(ref p) = alloc_overlay_path {
            compose_log_env.push(("SMOKE_GENESIS_ALLOC_FILE", p.to_string_lossy().to_string()));
            std::env::set_var("SMOKE_GENESIS_ALLOC_FILE", p);
        }
        let compose_project = "ethereum-testnet";
        let genesis_timestamp =
            std::env::var("GENESIS_TIMESTAMP").unwrap_or_else(|_| "unset".to_string());
        let overlay_mode = if alloc_overlay_path.is_some() {
            "alloc-overlay"
        } else {
            "clean-room"
        };
        logging::info(
            "smoke-test",
            format!(
                "chain startup config: project={compose_project} mode={overlay_mode} genesis_timestamp={genesis_timestamp} rpc_port={} ws_port={} authrpc_port={} beacon_port={} compose_files={}",
                chain_ports.rpc_port,
                chain_ports.ws_port,
                chain_ports.authrpc_port,
                chain_ports.beacon_port,
                compose_files_owned.join(" "),
            ),
        );
        ensure_compose_project_idle(&compose_dir, &compose_files_owned)?;
        let cleanup_compose_files = compose_files_owned.clone();
        let cleanup_compose_dir = compose_dir.clone();
        let cleanup_alloc_overlay_path = alloc_overlay_path
            .as_ref()
            .map(|p| p.to_string_lossy().to_string());
        let cleanup = move || {
            let mut c = Command::new("docker");
            c.arg("compose");
            for f in &cleanup_compose_files {
                c.arg(f);
            }
            c.args(["down", "-v", "--remove-orphans"]);
            if let Some(ref p) = cleanup_alloc_overlay_path {
                c.env("SMOKE_GENESIS_ALLOC_FILE", p);
            }
            c.current_dir(&cleanup_compose_dir);
            let _ = c.status();
        };

        let mut up_cmd = Command::new("docker");
        up_cmd.arg("compose");
        for f in &compose_files_owned {
            up_cmd.arg(f);
        }
        up_cmd
            .arg("up")
            .arg("-d")
            .arg("--build")
            .env("GETH_RPC_PORT", chain_ports.rpc_port.to_string())
            .env("GETH_WS_PORT", chain_ports.ws_port.to_string())
            .env("GETH_AUTHRPC_PORT", chain_ports.authrpc_port.to_string())
            .env("BEACON_PORT", chain_ports.beacon_port.to_string())
            .current_dir(&compose_dir);
        if let Some(ref p) = alloc_overlay_path {
            up_cmd.env("SMOKE_GENESIS_ALLOC_FILE", p);
        }
        logging::info("smoke-test", "bringing up chain compose stack");
        let up_out = up_cmd.output().map_err(HarnessError::from)?;
        logging::log_command_output("compose", &up_out);
        if !up_out.status.success() {
            log_compose_state(
                &compose_dir,
                &compose_files_owned,
                &compose_log_env,
                "chain-compose",
                "compose up failed",
                200,
            );
            cleanup();
            return Err(HarnessError::Docker(format!(
                "compose up devnet failed: {:?}",
                up_out.status
            )));
        }

        let mut compose_log_followers = Vec::new();
        let chain_log_follower = start_compose_log_follower(
            &compose_dir,
            &compose_files_owned,
            &compose_log_env,
            "chain-compose",
        )
        .inspect_err(|err| {
            logging::error(
                "smoke-test",
                format!("chain compose log follower failed: {err}"),
            );
            log_compose_state(
                &compose_dir,
                &compose_files_owned,
                &compose_log_env,
                "chain-compose",
                "log follower startup failure",
                200,
            );
            cleanup();
        })?;
        compose_log_followers.push(chain_log_follower);

        eprintln!("smoke-test: waiting for chain containers to become ready...");
        logging::info("smoke-test", "waiting for chain containers to become ready");
        let chain_probe_dir = compose_dir.clone();
        let mut chain_health_probe = compose_health_probe(
            &chain_probe_dir,
            &compose_files_owned,
            &compose_log_env,
            "chain-compose",
        );
        wait_for_rpc_with_probe(
            &rpc_url,
            Duration::from_secs(180),
            Some(&mut chain_health_probe),
        )
        .inspect_err(|err| {
            logging::error("smoke-test", format!("chain RPC readiness failed: {err}"));
            log_compose_state(
                &compose_dir,
                &compose_files_owned,
                &compose_log_env,
                "chain-compose",
                "RPC readiness timeout",
                200,
            );
            cleanup();
        })?;
        logging::info(
            "smoke-test",
            "chain RPC ready; waiting for EL/CL block production",
        );

        // Wait for real block production: RPC up != consensus up.
        wait_for_block_height_with_probe(
            &rpc_url,
            1,
            Duration::from_secs(240),
            Some(&mut chain_health_probe),
        )
        .inspect_err(|err| {
            logging::error(
                "smoke-test",
                format!("chain block-production readiness failed: {err}"),
            );
            log_compose_state(
                &compose_dir,
                &compose_files_owned,
                &compose_log_env,
                "chain-compose",
                "block-production timeout",
                200,
            );
            cleanup();
        })?;
        logging::info("smoke-test", "chain EL/CL stack ready");
        wait_for_rpc_with_probe(
            &rpc_url,
            Duration::from_secs(60),
            Some(&mut chain_health_probe),
        )
        .inspect_err(|err| {
            logging::error(
                "smoke-test",
                format!("post-readiness RPC stability check failed: {err}"),
            );
            log_compose_state(
                &compose_dir,
                &compose_files_owned,
                &compose_log_env,
                "chain-compose",
                "post-readiness RPC stability failure",
                200,
            );
            cleanup();
        })?;
        logging::info(
            "smoke-test",
            "post-readiness chain RPC stable; starting deployment",
        );

        let dep_out = tmp.path().join("deployment.json");
        let agent_hex = format!("{:#x}", agent_address());
        run_forge_deploy_with_env(
            &repo_root,
            &rpc_url,
            &dep_out,
            &agent_hex,
            PAUSER_ADDRESS_HEX,
            extra_deploy_env,
        )
        .inspect_err(|err| {
            logging::error("smoke-test", format!("forge deploy failed: {err}"));
            log_compose_state(
                &compose_dir,
                &compose_files_owned,
                &compose_log_env,
                "chain-compose",
                "deployment failure",
                200,
            );
            cleanup();
        })?;

        let deployment = read_deployment(&dep_out)?;
        let chain_id = deployment.chain_id;

        // Deploy VaultRegistry and register RobotMoneyVault as the first active vault
        // (issue #294). The registry deployment JSON is written to a separate path in
        // the same tempdir so rmpc and downstream tooling can discover the registry
        // address without manual editing.
        let reg_out = tmp.path().join("registry.json");
        run_forge_deploy_registry(
            &repo_root,
            &rpc_url,
            &reg_out,
            &deployment.vault,
            &deployment.usdc,
        )
        .inspect_err(|err| {
            logging::error("smoke-test", format!("forge deploy registry failed: {err}"));
            log_compose_state(
                &compose_dir,
                &compose_files_owned,
                &compose_log_env,
                "chain-compose",
                "registry deployment failure",
                200,
            );
            cleanup();
        })?;

        let registry_deployment = read_registry_deployment(&reg_out)?;

        // Pin the fork block for the router simulation to the current chain
        // head — guarantees the simulation sees the registerVault tx that
        // run_forge_deploy_registry just mined (avoids a race where Geth
        // reports a stale "latest" before the block propagates to the RPC).
        let fork_block = fetch_current_block_number(&rpc_url).inspect_err(|err| {
            logging::error("smoke-test", format!("fetch block number failed: {err}"));
            log_compose_state(
                &compose_dir,
                &compose_files_owned,
                &compose_log_env,
                "chain-compose",
                "block number fetch failure",
                200,
            );
            cleanup();
        })?;

        // Deploy PortfolioRouter and wire initial weights (issue #303).
        // 10 000 bps → RobotMoneyVault as the sole active vault.
        let router_out = tmp.path().join("router.json");
        run_forge_deploy_router(
            &repo_root,
            &rpc_url,
            fork_block,
            &router_out,
            &registry_deployment.registry,
            &deployment.vault,
            &deployment.usdc,
        )
        .inspect_err(|err| {
            logging::error("smoke-test", format!("forge deploy router failed: {err}"));
            log_compose_state(
                &compose_dir,
                &compose_files_owned,
                &compose_log_env,
                "chain-compose",
                "router deployment failure",
                200,
            );
            cleanup();
        })?;

        let router_deployment = read_router_deployment(&router_out)?;

        // Deploy RouterGovernance and wire it to the PortfolioRouter (issue #364).
        // ADMIN_ROLE is held by the deployer; voting power is assigned per test.
        let governance_out = tmp.path().join("governance.json");
        run_forge_deploy_governance(
            &repo_root,
            &rpc_url,
            &governance_out,
            &router_deployment.router,
        )
        .inspect_err(|err| {
            logging::error("smoke-test", format!("forge deploy governance failed: {err}"));
            log_compose_state(
                &compose_dir,
                &compose_files_owned,
                &compose_log_env,
                "chain-compose",
                "governance deployment failure",
                200,
            );
            cleanup();
        })?;

        let governance_deployment = read_governance_deployment(&governance_out)?;

        fund_eth_from_deployer(&rpc_url, &agent_hex, "1000000000000000000").inspect_err(|err| {
            logging::error("smoke-test", format!("funding agent failed: {err}"));
            log_compose_state(
                &compose_dir,
                &compose_files_owned,
                &compose_log_env,
                "chain-compose",
                "agent funding failure",
                200,
            );
            cleanup();
        })?;
        fund_eth_from_deployer(&rpc_url, PAUSER_ADDRESS_HEX, "1000000000000000000").inspect_err(
            |err| {
                logging::error("smoke-test", format!("funding pauser failed: {err}"));
                log_compose_state(
                    &compose_dir,
                    &compose_files_owned,
                    &compose_log_env,
                    "chain-compose",
                    "funding failure",
                    200,
                );
                cleanup();
            },
        )?;

        let fx = Fixture {
            compose_dir,
            tmp,
            compose_log_followers,
            chain_ports,
            rpc_port: chain_ports.rpc_port,
            rpc_url,
            chain_id,
            deployment,
            registry_deployment,
            router_deployment,
            governance_deployment,
            repo_root,
        };

        // Fund the agent's USDC balance. Deploy.s.sol no longer mints (USDC
        // is now real Base USDC seeded into genesis alloc, not MockUSDC), so
        // the harness funds via a real ERC-20 transfer from
        // HARNESS_USDC_HOLDER. Use a generous amount that comfortably
        // exceeds every scenario's deposit (largest is
        // OVER_PAYMENT_CAP_DEPOSIT = 20_000 USDC) but stays well under the
        // genesis grant (1M USDC by default in fork-block.json).
        const AGENT_USDC_GRANT: u128 = 500_000 * 1_000_000; // 500k USDC, 6dp
        fx.fund_usdc(fx.agent(), AGENT_USDC_GRANT)
            .inspect_err(|err| {
                logging::error("smoke-test", format!("funding USDC failed: {err}"));
                log_compose_state(
                    &fx.compose_dir,
                    &compose_files_owned,
                    &compose_log_env,
                    "chain-compose",
                    "USDC funding failure",
                    200,
                );
                cleanup();
            })?;

        Ok(fx)
    }

    // ---- accessors --------------------------------------------------

    pub fn rpc_url(&self) -> &str {
        &self.rpc_url
    }
    pub fn rpc_port(&self) -> u16 {
        self.rpc_port
    }
    fn occupied_ports(&self) -> [u16; 4] {
        [
            self.chain_ports.rpc_port,
            self.chain_ports.ws_port,
            self.chain_ports.authrpc_port,
            self.chain_ports.beacon_port,
        ]
    }
    pub fn chain_id(&self) -> u64 {
        self.chain_id
    }
    pub fn gateway(&self) -> Address {
        parse_addr(&self.deployment.gateway)
    }
    pub fn usdc(&self) -> Address {
        parse_addr(&self.deployment.usdc)
    }
    pub fn vault(&self) -> Address {
        parse_addr(&self.deployment.vault)
    }
    /// PassthroughAdapter address registered with the vault at deploy time.
    /// Returns `Address::ZERO` for legacy deployments that predate issue #277.
    pub fn adapter(&self) -> Address {
        if self.deployment.adapter.is_empty() {
            Address::ZERO
        } else {
            parse_addr(&self.deployment.adapter)
        }
    }
    pub fn agent(&self) -> Address {
        parse_addr(&self.deployment.agent)
    }
    pub fn share_receiver(&self) -> Address {
        parse_addr(&self.deployment.share_receiver)
    }
    pub fn gateway_runtime_hash(&self) -> &str {
        &self.deployment.gateway_runtime_hash
    }
    /// Raw string form of the gateway address (for TOML/config templating).
    pub fn gateway_hex(&self) -> &str {
        &self.deployment.gateway
    }
    /// Raw string form of the USDC address.
    pub fn usdc_hex(&self) -> &str {
        &self.deployment.usdc
    }
    /// Raw string form of the vault address.
    pub fn vault_hex(&self) -> &str {
        &self.deployment.vault
    }
    /// VaultRegistry address deployed by DeployVaultRegistry.s.sol (issue #294).
    /// RobotMoneyVault is registered as the first active vault in this registry.
    pub fn registry(&self) -> Address {
        parse_addr(&self.registry_deployment.registry)
    }
    /// Raw string form of the VaultRegistry address.
    pub fn registry_hex(&self) -> &str {
        &self.registry_deployment.registry
    }
    /// PortfolioRouter address deployed by DeployPortfolioRouter.s.sol (issue #303).
    /// Initial weights: 10 000 bps to RobotMoneyVault.
    pub fn router(&self) -> Address {
        parse_addr(&self.router_deployment.router)
    }
    /// Raw string form of the PortfolioRouter address.
    pub fn router_hex(&self) -> &str {
        &self.router_deployment.router
    }
    /// RouterGovernance address deployed by DeployRouterGovernance.s.sol (issue #364).
    /// Deployer holds ADMIN_ROLE; voting power is assigned per test via setVotingPower.
    pub fn governance(&self) -> Address {
        parse_addr(&self.governance_deployment.governance)
    }
    /// Raw string form of the RouterGovernance address.
    pub fn governance_hex(&self) -> &str {
        &self.governance_deployment.governance
    }
    /// Path to the fixture's private tempdir. Callers may write
    /// additional files (keystores, client configs) here.
    pub fn tempdir(&self) -> &Path {
        self.tmp.path()
    }
    pub fn repo_root(&self) -> &Path {
        &self.repo_root
    }

    // ---- on-chain poke helpers --------------------------------------

    /// Send a transaction via `cast send` from an arbitrary private key.
    pub fn cast_send(
        &self,
        private_key_hex: &str,
        to: Address,
        sig: &str,
        args: &[&str],
    ) -> Result<String, HarnessError> {
        let to_hex = format!("{to:#x}");
        logging::debug(
            "rpc",
            format!("eth_sendRawTransaction via cast send {sig} -> {to_hex}"),
        );
        let mut cmd = Command::new("cast");
        cmd.args([
            "send",
            "--rpc-url",
            &self.rpc_url,
            "--private-key",
            private_key_hex,
            &to_hex,
            sig,
        ]);
        for a in args {
            cmd.arg(a);
        }
        cmd.arg("--json");
        let out = cmd.output()?;
        logging::log_command_output("cast", &out);
        if !out.status.success() {
            return Err(HarnessError::other(format!(
                "cast send {sig} failed: stdout={} stderr={}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        let v: serde_json::Value = serde_json::from_slice(&out.stdout)
            .map_err(|e| HarnessError::other(format!("cast send {sig} json: {e}")))?;
        Ok(v.get("transactionHash")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string())
    }

    /// Approve `gateway` to pull `amount` USDC from the agent EOA.
    pub fn approve_usdc_from_agent(&self, amount: u128) -> Result<String, HarnessError> {
        let agent_pk_hex = format!("0x{}", hex::encode(AGENT_PRIVATE_KEY));
        self.cast_send(
            &agent_pk_hex,
            self.usdc(),
            "approve(address,uint256)",
            &[&format!("{:#x}", self.gateway()), &amount.to_string()],
        )
    }

    /// Pause the gateway from the PAUSER_ROLE holder.
    pub fn pause_gateway(&self) -> Result<String, HarnessError> {
        self.cast_send(PAUSER_PRIVATE_KEY_HEX, self.gateway(), "pause()", &[])
    }

    /// Unpause the gateway. Unpause is ADMIN_ROLE-only.
    pub fn unpause_gateway(&self) -> Result<String, HarnessError> {
        self.cast_send(DEPLOYER_PRIVATE_KEY_HEX, self.gateway(), "unpause()", &[])
    }

    /// Revoke the agent's `AGENT_ROLE`.
    pub fn revoke_agent(&self) -> Result<String, HarnessError> {
        self.cast_send(
            DEPLOYER_PRIVATE_KEY_HEX,
            self.gateway(),
            "revokeAgent(address)",
            &[&format!("{:#x}", self.agent())],
        )
    }

    /// Re-grant the agent's `AGENT_ROLE` with the given policy caps.
    pub fn reauthorize_agent(
        &self,
        max_per_payment: u128,
        max_per_window: u128,
    ) -> Result<String, HarnessError> {
        let agent = format!("{:#x}", self.agent());
        let share_receiver = format!("{:#x}", self.share_receiver());
        // allowedDestinations left empty ([]) for smoke-test: open policy
        // allows any registered destination (vault or router).
        let policy = format!(
            "(true,18446744073709551615,{max_per_payment},{max_per_window},{share_receiver},[],0x0000000000000000000000000000000000000000,0,0,[])"
        );
        self.cast_send(
            DEPLOYER_PRIVATE_KEY_HEX,
            self.gateway(),
            "authorizeAgent(address,(bool,uint64,uint256,uint256,address,address[],address,uint256,uint256,address[]))",
            &[&agent, &policy],
        )
    }

    /// Assign `power` voting power to `voter` on the RouterGovernance contract.
    /// Callable by the deployer, who holds ADMIN_ROLE on the governance contract.
    pub fn set_voting_power(&self, voter: Address, power: u128) -> Result<String, HarnessError> {
        self.cast_send(
            DEPLOYER_PRIVATE_KEY_HEX,
            self.governance(),
            "setVotingPower(address,uint256)",
            &[&format!("{voter:#x}"), &power.to_string()],
        )
    }

    /// Fund `recipient` with `amount` USDC by signing a real
    /// `transfer(address,uint256)` from [`HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX`].
    ///
    /// This is the canonical USDC faucet for the smoke-test devnet. The
    /// holder EOA receives its USDC balance at genesis (the alloc builder
    /// patches `balances[holder] += grant` and `totalSupply += grant`), so
    /// `fund_usdc` is a vanilla ERC-20 transfer signed by the holder's key
    /// — no `cast send` from the deployer, no Anvil cheats, no whale
    /// impersonation. The signature is recoverable, the Transfer event
    /// fires, and behaviour matches prod.
    pub fn fund_usdc(&self, recipient: Address, amount: u128) -> Result<String, HarnessError> {
        self.cast_send(
            HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX,
            self.usdc(),
            "transfer(address,uint256)",
            &[&format!("{recipient:#x}"), &amount.to_string()],
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        logging::info("chain-compose", "tearing down chain compose stack");
        for child in &mut self.compose_log_followers {
            child.terminate();
        }
        let _ = Command::new("docker")
            .args([
                "compose",
                "-f",
                "docker-compose.yaml",
                "down",
                "-v",
                "--remove-orphans",
            ])
            .current_dir(&self.compose_dir)
            .status();
        logging::info("chain-compose", "chain compose teardown complete");
    }
}

// -- Public helpers ---------------------------------------------------

/// Returns `true` iff `docker`, `forge`, and `cast` are all on PATH.
pub fn prerequisites_available() -> bool {
    which::which("docker").is_ok() && which::which("forge").is_ok() && which::which("cast").is_ok()
}

// -- Internal helpers -------------------------------------------------

/// Issue #255: render the genesis alloc overlay JSON into `out_dir` and
/// return its absolute path. Returns `Ok(None)` (NOT an error) when either
/// the fork-block manifest or the Anvil fixture snapshot is missing — the
/// caller falls back to the legacy clean-room genesis path in that case so
/// developer shells without the snapshot still work.
///
/// Errors are reserved for cases where both inputs exist but the build
/// itself fails (malformed manifest, missing required ingested address, IO
/// failure writing the output). The caller logs these and falls back.
fn render_genesis_alloc_overlay(
    repo_root: &Path,
    out_dir: &Path,
) -> Result<Option<PathBuf>, HarnessError> {
    let manifest_path = repo_root.join("testing/ethereum-testnet/config/fork-block.json");
    let snapshot_path = repo_root.join("testing/fixtures/fork-state/CURRENT.anvil-state");
    if !manifest_path.exists() || !snapshot_path.exists() {
        return Ok(None);
    }

    let manifest = fork_manifest::ForkManifest::load(&manifest_path)
        .map_err(|e| HarnessError::other(format!("load fork-block.json: {e}")))?;
    let alloc = genesis_alloc::build_alloc(&snapshot_path, &manifest)
        .map_err(|e| HarnessError::other(format!("build alloc: {e}")))?;
    let json = serde_json::to_string_pretty(&alloc)
        .map_err(|e| HarnessError::other(format!("serialize alloc: {e}")))?;

    let out_path = out_dir.join("genesis-alloc.json");
    std::fs::write(&out_path, json)?;
    // docker requires an absolute path for bind-mount source; the tempdir
    // path already is absolute, but be defensive.
    let absolute = std::fs::canonicalize(&out_path)?;
    eprintln!(
        "smoke-test: rendered genesis alloc overlay ({} accounts) -> {}",
        alloc.0.len(),
        absolute.display()
    );
    Ok(Some(absolute))
}

fn derive_address(privkey: &[u8; 32]) -> Address {
    use k256::ecdsa::SigningKey;
    let sk = SigningKey::from_bytes(privkey.into()).expect("static privkey is valid");
    let vk = sk.verifying_key();
    let pubkey = vk.to_encoded_point(false);
    let hash = keccak256(&pubkey.as_bytes()[1..]);
    Address::from_slice(&hash[12..])
}

fn parse_addr(s: &str) -> Address {
    s.parse::<Address>().unwrap_or(Address::ZERO)
}

#[allow(dead_code)]
fn wait_for_rpc(url: &str, timeout: Duration) -> Result<(), HarnessError> {
    wait_for_rpc_with_probe(url, timeout, None)
}

fn wait_for_rpc_with_probe(
    url: &str,
    timeout: Duration,
    mut health_probe: Option<&mut dyn FnMut() -> Result<(), HarnessError>>,
) -> Result<(), HarnessError> {
    logging::debug("rpc", format!("polling {url} for chain RPC health"));
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| HarnessError::other(format!("reqwest builder: {e}")))?;
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_chainId",
        "params": []
    });
    let deadline = std::time::Instant::now() + timeout;
    #[allow(unused_assignments)]
    let mut last_error: Option<String> = None;
    let mut unreachable_since: Option<std::time::Instant> = None;
    while std::time::Instant::now() < deadline {
        if let Some(probe) = health_probe.as_deref_mut() {
            probe()?;
        }
        match client.post(url).json(&body).send() {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(json) = resp.json::<serde_json::Value>() {
                    if json.get("result").is_some() {
                        if let Some(since) = unreachable_since.take() {
                            logging::info(
                                "rpc",
                                format!(
                                    "RPC recovered after {}s: {url}",
                                    since.elapsed().as_secs()
                                ),
                            );
                        }
                        logging::debug("rpc", format!("{url} returned chainId"));
                        return Ok(());
                    }
                    last_error = Some("missing result field".to_string());
                } else {
                    last_error = Some("invalid JSON-RPC response".to_string());
                }
            }
            Ok(resp) => {
                last_error = Some(format!("HTTP {}", resp.status()));
                if unreachable_since.is_none() {
                    unreachable_since = Some(std::time::Instant::now());
                    logging::warn(
                        "rpc",
                        format!(
                            "RPC unreachable at {url}: {}",
                            last_error.as_deref().unwrap_or("unknown error")
                        ),
                    );
                }
            }
            Err(err) => {
                last_error = Some(err.to_string());
                if unreachable_since.is_none() {
                    unreachable_since = Some(std::time::Instant::now());
                    logging::warn(
                        "rpc",
                        format!(
                            "RPC unreachable at {url}: {}",
                            last_error.as_deref().unwrap_or("unknown error")
                        ),
                    );
                }
            }
        }
        if let Some(since) = unreachable_since {
            if since.elapsed() >= Duration::from_secs(30) {
                logging::warn(
                    "rpc",
                    format!(
                        "RPC still unreachable at {url} after {}s: {}",
                        since.elapsed().as_secs(),
                        last_error.as_deref().unwrap_or("unknown error")
                    ),
                );
            }
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    Err(HarnessError::RpcTimeout {
        url: url.to_string(),
        timeout,
    })
}

#[allow(dead_code)]
fn wait_for_block_height(url: &str, target: u64, timeout: Duration) -> Result<(), HarnessError> {
    wait_for_block_height_with_probe(url, target, timeout, None)
}

fn wait_for_block_height_with_probe(
    url: &str,
    target: u64,
    timeout: Duration,
    mut health_probe: Option<&mut dyn FnMut() -> Result<(), HarnessError>>,
) -> Result<(), HarnessError> {
    logging::debug(
        "rpc",
        format!("polling {url} for block height {target} readiness"),
    );
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| HarnessError::other(format!("reqwest builder: {e}")))?;
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_blockNumber",
        "params": []
    });
    let deadline = std::time::Instant::now() + timeout;
    let mut last_error: Option<String> = None;
    let mut last_block: Option<u64> = None;
    let mut last_progress = std::time::Instant::now();
    let mut first_success_logged = false;
    let mut stall_warned = false;
    let mut unreachable_since: Option<std::time::Instant> = None;
    while std::time::Instant::now() < deadline {
        if let Some(probe) = health_probe.as_deref_mut() {
            probe()?;
        }
        match client.post(url).json(&body).send() {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(json) = resp.json::<serde_json::Value>() {
                    if let Some(block_hex) = json.get("result").and_then(|v| v.as_str()) {
                        if let Ok(block) =
                            u64::from_str_radix(block_hex.trim_start_matches("0x"), 16)
                        {
                            let now = chrono::Utc::now()
                                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                            if !first_success_logged {
                                logging::info(
                                    "rpc",
                                    format!(
                                        "first eth_blockNumber response at {now}: block={block} url={url}"
                                    ),
                                );
                                first_success_logged = true;
                            }
                            if let Some(since) = unreachable_since.take() {
                                logging::info(
                                    "rpc",
                                    format!(
                                        "RPC recovered after {}s: block={block} url={url}",
                                        since.elapsed().as_secs()
                                    ),
                                );
                            }
                            if last_block.is_none_or(|prev| block > prev) {
                                last_block = Some(block);
                                last_progress = std::time::Instant::now();
                                stall_warned = false;
                            } else if !stall_warned
                                && last_block.is_some()
                                && last_progress.elapsed() >= Duration::from_secs(30)
                            {
                                logging::warn(
                                    "rpc",
                                    format!(
                                        "block production stalled at block={} for {}s on {url}",
                                        last_block.unwrap_or(block),
                                        last_progress.elapsed().as_secs()
                                    ),
                                );
                                stall_warned = true;
                            }
                            if block >= target {
                                logging::info(
                                    "rpc",
                                    format!(
                                        "block target reached: block={block} target={target} url={url}"
                                    ),
                                );
                                return Ok(());
                            }
                        } else {
                            last_error = Some(format!("invalid block hex {block_hex}"));
                        }
                    } else {
                        last_error = Some("missing result field".to_string());
                    }
                } else {
                    last_error = Some("invalid JSON-RPC response".to_string());
                }
            }
            Ok(resp) => {
                last_error = Some(format!("HTTP {}", resp.status()));
                if unreachable_since.is_none() {
                    unreachable_since = Some(std::time::Instant::now());
                    logging::warn(
                        "rpc",
                        format!(
                            "RPC unreachable at {url}: {}",
                            last_error.as_deref().unwrap_or("unknown error")
                        ),
                    );
                }
            }
            Err(err) => {
                last_error = Some(err.to_string());
                if unreachable_since.is_none() {
                    unreachable_since = Some(std::time::Instant::now());
                    logging::warn(
                        "rpc",
                        format!(
                            "RPC unreachable at {url}: {}",
                            last_error.as_deref().unwrap_or("unknown error")
                        ),
                    );
                }
            }
        }
        if let Some(since) = unreachable_since {
            if since.elapsed() >= Duration::from_secs(30) {
                logging::warn(
                    "rpc",
                    format!(
                        "RPC still unreachable at {url} after {}s: {}",
                        since.elapsed().as_secs(),
                        last_error.as_deref().unwrap_or("unknown error")
                    ),
                );
            }
        }
        std::thread::sleep(Duration::from_millis(1000));
    }
    Err(HarnessError::RpcTimeout {
        url: url.to_string(),
        timeout,
    })
}

fn ensure_compose_project_idle(
    compose_dir: &Path,
    compose_files: &[String],
) -> Result<(), HarnessError> {
    let running = compose_running_container_names(compose_dir, compose_files)?;
    if running.is_empty() {
        return Ok(());
    }

    Err(HarnessError::Docker(format!(
        "ethereum-testnet compose project already running containers: {}; \
         stop the existing smoke-test instance before starting another",
        running.join(", ")
    )))
}

fn compose_running_container_names(
    compose_dir: &Path,
    compose_files: &[String],
) -> Result<Vec<String>, HarnessError> {
    let mut cmd = Command::new("docker");
    cmd.arg("compose");
    for file in compose_files {
        cmd.arg(file);
    }
    let output = cmd
        .arg("ps")
        .arg("--format")
        .arg("json")
        .current_dir(compose_dir)
        .output()
        .map_err(HarnessError::from)?;

    if !output.status.success() {
        return Err(HarnessError::Docker(format!(
            "docker compose ps failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    parse_compose_ps_stdout(&output.stdout)
}

fn parse_compose_ps_stdout(stdout: &[u8]) -> Result<Vec<String>, HarnessError> {
    let mut running = Vec::new();
    for line in String::from_utf8_lossy(stdout).lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let entry: ComposePsEntry = serde_json::from_str(line).map_err(|e| {
            HarnessError::Docker(format!("docker compose ps parse error: {e}; line={line}"))
        })?;
        if entry.state.eq_ignore_ascii_case("running") {
            running.push(entry.name);
        }
    }
    Ok(running)
}

fn fund_eth_from_deployer(
    rpc_url: &str,
    recipient_hex: &str,
    value_wei: &str,
) -> Result<String, HarnessError> {
    logging::debug(
        "rpc",
        format!("eth_sendRawTransaction via cast send value={value_wei} -> {recipient_hex}"),
    );
    let out = Command::new("cast")
        .args([
            "send",
            "--rpc-url",
            rpc_url,
            "--private-key",
            DEPLOYER_PRIVATE_KEY_HEX,
            "--value",
            value_wei,
            recipient_hex,
            "--json",
        ])
        .output()?;
    logging::log_command_output("cast", &out);
    if !out.status.success() {
        return Err(HarnessError::other(format!(
            "fund eth failed: stdout={} stderr={}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| HarnessError::other(format!("fund eth json: {e}")))?;
    Ok(v.get("transactionHash")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string())
}

fn run_forge_deploy_with_env(
    repo_root: &Path,
    rpc_url: &str,
    dep_out: &Path,
    agent_address_hex: &str,
    pauser_address_hex: &str,
    extra_env: &[(&str, &str)],
) -> Result<(), HarnessError> {
    let mut cmd = Command::new("forge");
    cmd.args(["script", "contracts/script/Deploy.s.sol:Deploy"])
        .args(["--rpc-url", rpc_url])
        .args(["--private-key", DEPLOYER_PRIVATE_KEY_HEX])
        .arg("--broadcast")
        .arg("--slow")
        .arg("-vvv")
        .env("ADMIN_ADDRESS", DEPLOYER_ADDRESS_HEX)
        .env("PAUSER_ADDRESS", pauser_address_hex)
        .env("AGENT_ADDRESS", agent_address_hex)
        .env("SHARE_RECEIVER_ADDRESS", SHARE_RECEIVER_ADDRESS_HEX)
        // Bind the gateway to the canonical Base USDC seeded into genesis
        // (issue #255). Tells Deploy.s.sol to skip MockUSDC + the
        // permissioned post-deploy mint. The harness funds the agent via
        // `Fixture::fund_usdc` (real ERC-20 transfer from
        // HARNESS_USDC_HOLDER) instead.
        .env("USDC_ADDRESS", genesis_alloc::BASE_USDC_ADDR)
        .env("DEPLOYMENT_OUT", dep_out)
        .current_dir(repo_root);
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let out = cmd.output()?;
    logging::log_command_output("forge", &out);
    if !out.status.success() {
        return Err(HarnessError::DeployFailed(format!(
            "forge script exited {:?}\nstdout:\n{}\nstderr:\n{}",
            out.status,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    Ok(())
}

fn read_deployment(path: &Path) -> Result<DeploymentJson, HarnessError> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| HarnessError::DeploymentJson(path.to_path_buf(), e.to_string()))?;
    serde_json::from_str(&raw)
        .map_err(|e| HarnessError::DeploymentJson(path.to_path_buf(), e.to_string()))
}

/// Run the DeployVaultRegistry forge script (issue #294) and write the
/// registry deployment JSON to `reg_out`. The deployer EOA (which holds
/// `ADMIN_ROLE` on the newly-deployed registry) broadcasts via its private
/// key, so `msg.sender` on `registerVault` is the admin — no `vm.prank` is
/// needed inside the script's `run()` entrypoint.
fn run_forge_deploy_registry(
    repo_root: &Path,
    rpc_url: &str,
    reg_out: &Path,
    vault_address: &str,
    usdc_address: &str,
) -> Result<(), HarnessError> {
    let mut cmd = Command::new("forge");
    cmd.args([
        "script",
        "contracts/script/DeployVaultRegistry.s.sol:DeployVaultRegistry",
    ])
    .args(["--rpc-url", rpc_url])
    .args(["--private-key", DEPLOYER_PRIVATE_KEY_HEX])
    .arg("--broadcast")
    .arg("--slow")
    .arg("-vvv")
    .env("ADMIN_ADDRESS", DEPLOYER_ADDRESS_HEX)
    .env("VAULT_ADDRESS", vault_address)
    .env("USDC_ADDRESS", usdc_address)
    .env("VAULT_NAME", "Robot Money USDC")
    .env("DEPLOYMENT_OUT", reg_out)
    .current_dir(repo_root);
    let out = cmd.output()?;
    logging::log_command_output("forge-registry", &out);
    if !out.status.success() {
        return Err(HarnessError::DeployFailed(format!(
            "forge script DeployVaultRegistry exited {:?}\nstdout:\n{}\nstderr:\n{}",
            out.status,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    Ok(())
}

fn read_registry_deployment(path: &Path) -> Result<RegistryDeploymentJson, HarnessError> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| HarnessError::DeploymentJson(path.to_path_buf(), e.to_string()))?;
    serde_json::from_str(&raw)
        .map_err(|e| HarnessError::DeploymentJson(path.to_path_buf(), e.to_string()))
}

/// Run the DeployPortfolioRouter forge script (issue #303) and write the
/// router deployment JSON to `router_out`. Sets initial weights to 10 000 bps
/// (100%) pointing at RobotMoneyVault — the sole active vault at this phase.
///
/// `fork_block` pins the forge simulation to a specific chain head so that
/// the simulation sees the `registerVault` tx from `run_forge_deploy_registry`
/// regardless of Geth's "latest" propagation timing.
fn run_forge_deploy_router(
    repo_root: &Path,
    rpc_url: &str,
    fork_block: u64,
    router_out: &Path,
    registry_address: &str,
    vault_address: &str,
    usdc_address: &str,
) -> Result<(), HarnessError> {
    let mut cmd = Command::new("forge");
    cmd.args([
        "script",
        "contracts/script/DeployPortfolioRouter.s.sol:DeployPortfolioRouter",
    ])
    .args(["--rpc-url", rpc_url])
    .args(["--fork-block-number", &fork_block.to_string()])
    .args(["--private-key", DEPLOYER_PRIVATE_KEY_HEX])
    .arg("--broadcast")
    .arg("--slow")
    .arg("-vvv")
    .env("ADMIN_ADDRESS", DEPLOYER_ADDRESS_HEX)
    .env("REGISTRY_ADDRESS", registry_address)
    .env("VAULT_ADDRESS", vault_address)
    .env("USDC_ADDRESS", usdc_address)
    .env("DEPLOYMENT_OUT", router_out)
    .current_dir(repo_root);
    let out = cmd.output()?;
    logging::log_command_output("forge-router", &out);
    if !out.status.success() {
        return Err(HarnessError::DeployFailed(format!(
            "forge script DeployPortfolioRouter exited {:?}\nstdout:\n{}\nstderr:\n{}",
            out.status,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    Ok(())
}

/// Query the chain head block number via `cast block-number`. Used to pin
/// the forge simulation fork block after `run_forge_deploy_registry` so the
/// router simulation sees the `registerVault` tx regardless of Geth's
/// "latest" propagation timing.
fn fetch_current_block_number(rpc_url: &str) -> Result<u64, HarnessError> {
    let out = Command::new("cast")
        .args(["block-number", "--rpc-url", rpc_url])
        .output()?;
    if !out.status.success() {
        return Err(HarnessError::Other(format!(
            "cast block-number failed: {}",
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    s.parse::<u64>().map_err(|e| {
        HarnessError::Other(format!("cast block-number returned non-integer {s:?}: {e}"))
    })
}

fn read_router_deployment(path: &Path) -> Result<RouterDeploymentJson, HarnessError> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| HarnessError::DeploymentJson(path.to_path_buf(), e.to_string()))?;
    serde_json::from_str(&raw)
        .map_err(|e| HarnessError::DeploymentJson(path.to_path_buf(), e.to_string()))
}

/// Deploy RouterGovernance via forge script. The deployer holds ADMIN_ROLE.
/// Voting power is assigned per-test via `setVotingPower` (issue #364).
fn run_forge_deploy_governance(
    repo_root: &Path,
    rpc_url: &str,
    governance_out: &Path,
    router_address: &str,
) -> Result<(), HarnessError> {
    let mut cmd = Command::new("forge");
    cmd.args([
        "script",
        "contracts/script/DeployRouterGovernance.s.sol:DeployRouterGovernance",
    ])
    .args(["--rpc-url", rpc_url])
    .args(["--private-key", DEPLOYER_PRIVATE_KEY_HEX])
    .arg("--broadcast")
    .arg("--slow")
    .arg("-vvv")
    .env("ADMIN_ADDRESS", DEPLOYER_ADDRESS_HEX)
    .env("ROUTER_ADDRESS", router_address)
    .env("DEPLOYMENT_OUT", governance_out)
    .current_dir(repo_root);
    let out = cmd.output()?;
    logging::log_command_output("forge-governance", &out);
    if !out.status.success() {
        return Err(HarnessError::DeployFailed(format!(
            "forge script DeployRouterGovernance exited {:?}\nstdout:\n{}\nstderr:\n{}",
            out.status,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    Ok(())
}

fn read_governance_deployment(path: &Path) -> Result<GovernanceDeploymentJson, HarnessError> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| HarnessError::DeploymentJson(path.to_path_buf(), e.to_string()))?;
    serde_json::from_str(&raw)
        .map_err(|e| HarnessError::DeploymentJson(path.to_path_buf(), e.to_string()))
}

/// Walk up from the crate manifest dir until we find the repo root
/// (identified by `foundry.toml` + `clients/rust-payment-client`).
pub fn locate_repo_root() -> Result<PathBuf, HarnessError> {
    test_utils::find_workspace_root()
        .ok_or_else(|| HarnessError::other("could not locate repo root from CARGO_MANIFEST_DIR"))
}

fn start_compose_log_follower(
    compose_dir: &Path,
    compose_args: &[String],
    compose_env: &[(&str, String)],
    service_label: &'static str,
) -> Result<MonitoredChild, HarnessError> {
    let mut cmd = Command::new("docker");
    cmd.arg("compose");
    for arg in compose_args {
        cmd.arg(arg);
    }
    for (key, value) in compose_env {
        cmd.env(key, value);
    }
    cmd.args(["logs", "--follow", "--no-color", "--timestamps"])
        .current_dir(compose_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| HarnessError::other(format!("compose logs spawn: {e}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| HarnessError::other("compose logs stdout unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| HarnessError::other("compose logs stderr unavailable"))?;
    let stdout_label = service_label.to_string();
    let stderr_label = service_label.to_string();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if let Some((service, message)) = parse_compose_log_line(&line) {
                logging::info(&service, message);
            } else {
                logging::info(&stdout_label, line);
            }
        }
    });
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            logging::error(&stderr_label, line);
        }
    });
    Ok(MonitoredChild::new(service_label, child))
}

fn log_compose_state(
    compose_dir: &Path,
    compose_args: &[String],
    compose_env: &[(&str, String)],
    service_label: &'static str,
    reason: &str,
    tail_lines: u32,
) {
    logging::warn(
        service_label,
        format!("capturing compose state for {reason}; ps/logs follow"),
    );

    let mut ps = Command::new("docker");
    ps.arg("compose");
    for arg in compose_args {
        ps.arg(arg);
    }
    for (key, value) in compose_env {
        ps.env(key, value);
    }
    ps.args(["ps", "--all", "--no-trunc"])
        .current_dir(compose_dir);
    match ps.output() {
        Ok(out) => logging::log_command_output(service_label, &out),
        Err(err) => logging::error(service_label, format!("compose ps failed: {err}")),
    }
    match compose_container_statuses(compose_dir, compose_args, compose_env) {
        Ok(statuses) => {
            if statuses.is_empty() {
                logging::warn(service_label, "compose ps returned no containers");
            } else {
                for status in statuses {
                    logging::info(service_label, status.describe());
                }
            }
        }
        Err(err) => logging::error(service_label, format!("compose inspect failed: {err}")),
    }

    let mut logs = Command::new("docker");
    logs.arg("compose");
    for arg in compose_args {
        logs.arg(arg);
    }
    for (key, value) in compose_env {
        logs.env(key, value);
    }
    let tail = tail_lines.to_string();
    logs.args(["logs", "--no-color", "--timestamps", "--tail", &tail])
        .current_dir(compose_dir);
    match logs.output() {
        Ok(out) => logging::log_command_output(service_label, &out),
        Err(err) => logging::error(service_label, format!("compose logs failed: {err}")),
    }
}

fn compose_health_probe<'a>(
    compose_dir: &'a Path,
    compose_args: &'a [String],
    compose_env: &'a [(&str, String)],
    service_label: &'static str,
) -> impl FnMut() -> Result<(), HarnessError> + 'a {
    move || {
        let statuses = compose_container_statuses(compose_dir, compose_args, compose_env)?;
        if statuses.is_empty() {
            logging::error(
                service_label,
                "compose health probe found no containers for the stack",
            );
            return Err(HarnessError::Docker(format!(
                "{service_label} container health probe found no running containers"
            )));
        }
        let unhealthy = statuses
            .into_iter()
            .filter(|status| {
                !(status.service.as_deref() == Some("setup") && status.exit_code == Some(0))
                    && status.is_unhealthy()
            })
            .collect::<Vec<_>>();
        if unhealthy.is_empty() {
            return Ok(());
        }
        for status in &unhealthy {
            logging::error(service_label, status.describe());
        }
        Err(HarnessError::Docker(format!(
            "{service_label} container health probe detected {} unhealthy container(s)",
            unhealthy.len()
        )))
    }
}

fn compose_container_statuses(
    compose_dir: &Path,
    compose_args: &[String],
    compose_env: &[(&str, String)],
) -> Result<Vec<ComposeContainerStatus>, HarnessError> {
    let mut ps = Command::new("docker");
    ps.arg("compose");
    for arg in compose_args {
        ps.arg(arg);
    }
    for (key, value) in compose_env {
        ps.env(key, value);
    }
    ps.args(["ps", "-q", "--all"]).current_dir(compose_dir);
    let out = ps.output().map_err(HarnessError::from)?;
    if !out.status.success() {
        return Err(HarnessError::Docker(format!(
            "compose ps -q failed: stdout={} stderr={}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )));
    }

    let ids = String::from_utf8_lossy(&out.stdout);
    let mut statuses = Vec::new();
    for id in ids.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let inspect_out = Command::new("docker")
            .args(["inspect", id])
            .output()
            .map_err(HarnessError::from)?;
        if !inspect_out.status.success() {
            let stderr = String::from_utf8_lossy(&inspect_out.stderr);
            if stderr.contains("no such object")
                || stderr.contains("No such object")
                || stderr.contains("No such container")
            {
                logging::warn(
                    "compose",
                    format!("container {id} disappeared before inspect completed"),
                );
                continue;
            }
            return Err(HarnessError::Docker(format!(
                "docker inspect {id} failed: stdout={} stderr={}",
                String::from_utf8_lossy(&inspect_out.stdout),
                String::from_utf8_lossy(&inspect_out.stderr)
            )));
        }
        let payload: Vec<serde_json::Value> = serde_json::from_slice(&inspect_out.stdout)
            .map_err(|e| HarnessError::Docker(format!("docker inspect {id} json: {e}")))?;
        let Some(container) = payload.into_iter().next() else {
            continue;
        };
        let Some(state) = container.get("State") else {
            continue;
        };
        let name = container
            .get("Name")
            .and_then(|v| v.as_str())
            .unwrap_or(id)
            .trim_start_matches('/')
            .to_string();
        let service = container
            .get("Config")
            .and_then(|v| v.get("Labels"))
            .and_then(|v| v.get("com.docker.compose.service"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        statuses.push(ComposeContainerStatus {
            id: id.to_string(),
            name,
            service,
            state: state
                .get("Status")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string(),
            health: state
                .get("Health")
                .and_then(|v| v.get("Status"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            exit_code: state.get("ExitCode").and_then(|v| v.as_i64()),
            oom_killed: state
                .get("OOMKilled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            error: state
                .get("Error")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        });
    }
    Ok(statuses)
}

fn parse_compose_log_line(line: &str) -> Option<(String, String)> {
    let (service, message) = line.split_once('|')?;
    let service = service.trim();
    let message = message.trim_start();
    if service.is_empty() || message.is_empty() {
        return None;
    }
    Some((service.to_string(), message.to_string()))
}

fn public_endpoints_label(public_endpoints: &PublicEndpoints) -> &'static str {
    match public_endpoints {
        PublicEndpoints::Local => "local",
        PublicEndpoints::EphemeralTunnel => "ephemeral-tunnel",
        PublicEndpoints::Named { .. } => "named",
    }
}

// -- DappStack --------------------------------------------------------

/// URLs for the full dapp stack services, printed as the structured
/// endpoint summary after all services pass their health checks.
pub struct DappEndpoints {
    pub rpc_url: String,
    pub dapp_url: String,
    pub explorer_api_url: String,
}

/// Manages the second docker-compose stack (dapp + explorer-api +
/// explorer-indexer + Postgres) started by `--full-stack`. Drop tears
/// the stack down unconditionally.
///
/// Canonical: docs/implementation-plan.md §10.5 — Phase 4.5.
/// Boot via [`DappStack::boot`] after the chain fixture is ready and
/// contracts are deployed.
pub struct DappStack {
    compose_dir: PathBuf,
    gateway_hex: String,
    vault_hex: String,
    gateway_runtime_hash: String,
    compose_log_followers: Vec<MonitoredChild>,
    pub endpoints: DappEndpoints,
    _tunnels: Option<Tunnels>,
    /// Env vars captured at boot time for `rebuild_dapp`.
    rebuild_env: Vec<(String, String)>,
}

/// Where the dapp, RPC, and explorer-api are publicly reachable from a
/// browser. Selected by [`DappStack::boot`]:
///
/// - [`PublicEndpoints::Local`] — bind only to localhost; no public
///   reachability. Default for unit / Playwright tests.
/// - [`PublicEndpoints::EphemeralTunnel`] — open three
///   `trycloudflare.com` quick tunnels and bake the random URLs into
///   the dapp bundle. Demo affordance only.
/// - [`PublicEndpoints::Named`] — caller supplies the three public
///   URLs explicitly. Use when a stable reverse proxy (e.g. a named
///   cloudflared tunnel with fixed hostnames) already fronts the
///   pinned local ports. The bundle is built with those URLs.
pub enum PublicEndpoints {
    Local,
    EphemeralTunnel,
    Named {
        rpc_url: String,
        dapp_url: String,
        explorer_api_url: String,
    },
}

/// Options for [`DappStack::boot`].
pub struct DappStackOptions {
    pub dapp_port: Option<u16>,
    pub explorer_api_port: Option<u16>,
    pub public_endpoints: PublicEndpoints,
}

impl DappStack {
    /// Build and start the dapp compose stack, injecting the deployed
    /// contract addresses as build args. Waits for the dapp and
    /// explorer-api health checks to pass before returning.
    pub fn boot(fixture: &Fixture, opts: DappStackOptions) -> Result<Self, HarnessError> {
        let compose_dir = fixture.repo_root().join("testing/ethereum-testnet/config");
        let gateway_hex = fixture.gateway_hex();
        let vault_hex = fixture.vault_hex();
        let gateway_runtime_hash = fixture.gateway_runtime_hash().to_string();
        let ports = DappPorts::allocate(
            opts.dapp_port,
            opts.explorer_api_port,
            &fixture.occupied_ports(),
        )?;
        let cleanup_gateway_hex = gateway_hex.to_string();
        let cleanup_vault_hex = vault_hex.to_string();
        let cleanup_runtime_hash = gateway_runtime_hash.clone();
        let cleanup_compose_dir = compose_dir.clone();
        let cleanup = move || {
            let _ = Command::new("docker")
                .args([
                    "compose",
                    "-f",
                    "docker-compose.dapp.yaml",
                    "down",
                    "-v",
                    "--remove-orphans",
                ])
                .env("VITE_GATEWAY_ADDRESS", &cleanup_gateway_hex)
                .env("VITE_VAULT_ADDRESS", &cleanup_vault_hex)
                .env("VITE_GATEWAY_EXPECTED_CODE_HASH", &cleanup_runtime_hash)
                .env("INDEXER_GATEWAY", &cleanup_gateway_hex)
                .env("INDEXER_VAULT", &cleanup_vault_hex)
                .env("INDEXER_REGISTRY", "")
                .current_dir(&cleanup_compose_dir)
                .status();
        };

        let local_dapp_url = ports.dapp_url();
        let local_explorer_api_url = ports.explorer_api_url();
        let local_rpc_url = fixture.rpc_url().to_string();
        let dapp_compose_files = vec!["-f".to_string(), "docker-compose.dapp.yaml".to_string()];
        let dapp_log_env = vec![
            ("POSTGRES_PORT", ports.postgres_port.to_string()),
            ("EXPLORER_API_PORT", ports.explorer_api_port.to_string()),
            ("DAPP_PORT", ports.dapp_port.to_string()),
            ("VITE_GATEWAY_ADDRESS", gateway_hex.to_string()),
            ("VITE_VAULT_ADDRESS", vault_hex.to_string()),
            (
                "VITE_GATEWAY_EXPECTED_CODE_HASH",
                gateway_runtime_hash.clone(),
            ),
            // Issue #320: surface registry and router addresses so the dapp's
            // DestinationSelector can list registered vaults and offer the
            // Portfolio Router deposit path.
            ("VITE_REGISTRY_ADDRESS", fixture.registry_hex().to_string()),
            ("VITE_ROUTER_ADDRESS", fixture.router_hex().to_string()),
            // Issue #364: RouterGovernance address for the Governance tab.
            ("VITE_GOVERNANCE_ADDRESS", fixture.governance_hex().to_string()),
            ("INDEXER_GATEWAY", gateway_hex.to_string()),
            ("INDEXER_VAULT", vault_hex.to_string()),
            ("INDEXER_REGISTRY", fixture.registry_hex().to_string()),
            (
                "INDEXER_RPC_URL",
                format!("http://host.docker.internal:{}", fixture.rpc_port()),
            ),
            ("VITE_DEVNET_RPC_URL", "".to_string()),
            ("VITE_EXPLORER_API_URL", "".to_string()),
            ("VITE_DAPP_URL", "".to_string()),
            (
                "VITE_FAUCET_HARNESS_PRIVATE_KEY",
                HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX.to_string(),
            ),
            ("INDEXER_CHAIN_ID", "918453".to_string()),
            ("INDEXER_CHAIN_NAME", "devnet".to_string()),
            ("EXPLORER_API_CHAIN_ID", "918453".to_string()),
        ];
        logging::info(
            "smoke-test",
            format!(
                "dapp startup config: project=robotmoney-dapp mode={} dapp_port={} explorer_api_port={} postgres_port={}",
                public_endpoints_label(&opts.public_endpoints),
                ports.dapp_port,
                ports.explorer_api_port,
                ports.postgres_port,
            ),
        );

        let (tunnels, vite_rpc_url, vite_dapp_url, vite_explorer_api_url) = match opts
            .public_endpoints
        {
            PublicEndpoints::Local => (
                None,
                local_rpc_url.clone(),
                local_dapp_url.clone(),
                local_explorer_api_url.clone(),
            ),
            PublicEndpoints::EphemeralTunnel => {
                let t =
                    Tunnels::start(fixture.rpc_port(), ports.dapp_port, ports.explorer_api_port)?;
                let urls = (
                    t.rpc_url.clone(),
                    t.dapp_url.clone(),
                    t.explorer_api_url.clone(),
                );
                (Some(t), urls.0, urls.1, urls.2)
            }
            PublicEndpoints::Named {
                rpc_url,
                dapp_url,
                explorer_api_url,
            } => (None, rpc_url, dapp_url, explorer_api_url),
        };

        let rebuild_env: Vec<(String, String)> = vec![
            ("POSTGRES_PORT".into(), ports.postgres_port.to_string()),
            (
                "EXPLORER_API_PORT".into(),
                ports.explorer_api_port.to_string(),
            ),
            ("DAPP_PORT".into(), ports.dapp_port.to_string()),
            ("VITE_GATEWAY_ADDRESS".into(), gateway_hex.to_string()),
            ("VITE_VAULT_ADDRESS".into(), vault_hex.to_string()),
            (
                "VITE_GATEWAY_EXPECTED_CODE_HASH".into(),
                gateway_runtime_hash.clone(),
            ),
            (
                "VITE_REGISTRY_ADDRESS".into(),
                fixture.registry_hex().to_string(),
            ),
            (
                "VITE_ROUTER_ADDRESS".into(),
                fixture.router_hex().to_string(),
            ),
            // Issue #364: RouterGovernance address for the Governance tab.
            (
                "VITE_GOVERNANCE_ADDRESS".into(),
                fixture.governance_hex().to_string(),
            ),
            ("INDEXER_GATEWAY".into(), gateway_hex.to_string()),
            ("INDEXER_VAULT".into(), vault_hex.to_string()),
            (
                "INDEXER_REGISTRY".into(),
                fixture.registry_hex().to_string(),
            ),
            (
                "INDEXER_RPC_URL".into(),
                format!("http://host.docker.internal:{}", fixture.rpc_port()),
            ),
            ("VITE_DEVNET_RPC_URL".into(), vite_rpc_url.clone()),
            (
                "VITE_EXPLORER_API_URL".into(),
                vite_explorer_api_url.clone(),
            ),
            ("VITE_DAPP_URL".into(), vite_dapp_url.clone()),
            (
                "VITE_FAUCET_HARNESS_PRIVATE_KEY".into(),
                HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX.into(),
            ),
            ("INDEXER_CHAIN_ID".into(), "918453".into()),
            ("INDEXER_CHAIN_NAME".into(), "devnet".into()),
            ("EXPLORER_API_CHAIN_ID".into(), "918453".into()),
        ];

        eprintln!("smoke-test: building and starting dapp stack (this may take several minutes for first build)...");

        logging::info("smoke-test", "bringing up full-stack compose services");
        let up_out = Command::new("docker")
            .arg("compose")
            .arg("-f")
            .arg("docker-compose.dapp.yaml")
            .arg("up")
            .arg("-d")
            .arg("--build")
            .env("POSTGRES_PORT", ports.postgres_port.to_string())
            .env("EXPLORER_API_PORT", ports.explorer_api_port.to_string())
            .env("DAPP_PORT", ports.dapp_port.to_string())
            .env("VITE_GATEWAY_ADDRESS", gateway_hex)
            .env("VITE_VAULT_ADDRESS", vault_hex)
            .env("VITE_GATEWAY_EXPECTED_CODE_HASH", &gateway_runtime_hash)
            // Issue #320: thread registry and router addresses into the dapp
            // build so the DestinationSelector and router deposit flow work.
            .env("VITE_REGISTRY_ADDRESS", fixture.registry_hex())
            .env("VITE_ROUTER_ADDRESS", fixture.router_hex())
            // Issue #364: thread governance address into the dapp build.
            .env("VITE_GOVERNANCE_ADDRESS", fixture.governance_hex())
            .env("INDEXER_GATEWAY", gateway_hex)
            .env("INDEXER_VAULT", vault_hex)
            .env("INDEXER_REGISTRY", fixture.registry_hex())
            // RPC is on the host; containers reach it via host.docker.internal
            .env(
                "INDEXER_RPC_URL",
                format!("http://host.docker.internal:{}", fixture.rpc_port()),
            )
            // VITE_FORK_RPC_URL intentionally NOT set: the dapp routes all
            // chain reads through the user's wallet RPC (see
            // docs/security/dapp-topology.md §2). VITE_DEVNET_RPC_URL is
            // passed as a *UX hint*: the dapp's Connect Wallet button uses
            // it to call `wallet_addEthereumChain` so MetaMask prefills the
            // RPC URL when prompting the user to add chain 918453. The
            // dapp never fetches from this URL itself.
            .env("VITE_DEVNET_RPC_URL", &vite_rpc_url)
            .env("VITE_EXPLORER_API_URL", &vite_explorer_api_url)
            .env("VITE_DAPP_URL", &vite_dapp_url)
            // Issue #261: thread the harness USDC holder key through to
            // the dapp build so the testnet Faucet tab + onboarding seed
            // can drip canonical USDC via a real ERC-20 `transfer` from
            // the holder EOA — same path as `Fixture::fund_usdc` on the
            // Rust side. Trimmed to remove the historical "0x" prefix
            // because the JS side normalizes both forms.
            .env(
                "VITE_FAUCET_HARNESS_PRIVATE_KEY",
                HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX,
            )
            .env("INDEXER_CHAIN_ID", "918453")
            .env("INDEXER_CHAIN_NAME", "devnet")
            .env("EXPLORER_API_CHAIN_ID", "918453")
            .current_dir(&compose_dir)
            .output()
            .map_err(HarnessError::from)?;
        logging::log_command_output("compose", &up_out);

        if !up_out.status.success() {
            log_compose_state(
                &compose_dir,
                &dapp_compose_files,
                &dapp_log_env,
                "dapp-compose",
                "compose up failed",
                200,
            );
            cleanup();
            return Err(HarnessError::Docker(
                "compose up dapp stack failed".to_string(),
            ));
        }

        let mut compose_log_followers = Vec::new();
        let dapp_log_env = {
            dapp_log_env
                .into_iter()
                .map(|(key, value)| match key {
                    "VITE_DEVNET_RPC_URL" => (key, vite_rpc_url.clone()),
                    "VITE_EXPLORER_API_URL" => (key, vite_explorer_api_url.clone()),
                    "VITE_DAPP_URL" => (key, vite_dapp_url.clone()),
                    _ => (key, value),
                })
                .collect::<Vec<_>>()
        };
        let dapp_log_follower = start_compose_log_follower(
            &compose_dir,
            &dapp_compose_files,
            &dapp_log_env,
            "dapp-compose",
        )
        .inspect_err(|err| {
            logging::error(
                "smoke-test",
                format!("dapp compose log follower failed: {err}"),
            );
            log_compose_state(
                &compose_dir,
                &dapp_compose_files,
                &dapp_log_env,
                "dapp-compose",
                "log follower startup failure",
                200,
            );
            cleanup();
        })?;
        compose_log_followers.push(dapp_log_follower);

        eprintln!("smoke-test: waiting for dapp containers to become ready...");
        logging::info("smoke-test", "waiting for dapp containers to become ready");
        // Health checks go to the local host ports — the tunnels are
        // user-facing only and need not be up for readiness.
        let dapp_probe_dir = compose_dir.clone();
        let mut dapp_health_probe = compose_health_probe(
            &dapp_probe_dir,
            &dapp_compose_files,
            &dapp_log_env,
            "dapp-compose",
        );
        wait_for_http_ok_with_probe(
            &format!("{local_explorer_api_url}/health"),
            Duration::from_secs(300),
            Some(&mut dapp_health_probe),
        )
        .inspect_err(|err| {
            logging::error(
                "smoke-test",
                format!("explorer-api readiness failed: {err}"),
            );
            log_compose_state(
                &compose_dir,
                &dapp_compose_files,
                &dapp_log_env,
                "dapp-compose",
                "explorer-api readiness timeout",
                200,
            );
            cleanup();
        })?;
        wait_for_http_ok_with_probe(
            &local_dapp_url,
            Duration::from_secs(300),
            Some(&mut dapp_health_probe),
        )
        .inspect_err(|err| {
            logging::error("smoke-test", format!("dapp readiness failed: {err}"));
            log_compose_state(
                &compose_dir,
                &dapp_compose_files,
                &dapp_log_env,
                "dapp-compose",
                "dapp readiness timeout",
                200,
            );
            cleanup();
        })?;

        Ok(DappStack {
            compose_dir,
            gateway_hex: gateway_hex.to_string(),
            vault_hex: vault_hex.to_string(),
            gateway_runtime_hash,
            compose_log_followers,
            endpoints: DappEndpoints {
                rpc_url: vite_rpc_url,
                dapp_url: vite_dapp_url,
                explorer_api_url: vite_explorer_api_url,
            },
            _tunnels: tunnels,
            rebuild_env,
        })
    }

    /// Rebuild and restart only the `dapp` container in-place, leaving
    /// postgres, explorer-indexer, and explorer-api untouched. All VITE_*
    /// build args are re-injected from the values captured at boot time so
    /// the new bundle points at the same devnet addresses and ports.
    ///
    /// Docker's build output is streamed to the caller's stderr so the
    /// developer can see progress during the (potentially long) bun build.
    pub fn rebuild_dapp(&self) -> Result<(), HarnessError> {
        logging::info("smoke-test", "rebuilding dapp container (--no-deps)");
        let mut cmd = Command::new("docker");
        cmd.args([
            "compose",
            "-f",
            "docker-compose.dapp.yaml",
            "up",
            "--build",
            "--no-deps",
            "-d",
            "dapp",
        ]);
        for (k, v) in &self.rebuild_env {
            cmd.env(k, v);
        }
        let status = cmd
            .current_dir(&self.compose_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .map_err(HarnessError::from)?;
        if !status.success() {
            return Err(HarnessError::Docker("dapp rebuild failed".to_string()));
        }
        Ok(())
    }
}

// -- Tunnels ----------------------------------------------------------

/// Owns one `cloudflared tunnel --url` child process per exposed port and
/// stores the public `trycloudflare.com` URL each tunnel announced. Drop
/// kills every child, which is how Cloudflare's ephemeral tunnels close.
struct Tunnels {
    children: Vec<MonitoredChild>,
    rpc_url: String,
    dapp_url: String,
    explorer_api_url: String,
}

impl Tunnels {
    fn start(rpc_port: u16, dapp_port: u16, explorer_api_port: u16) -> Result<Self, HarnessError> {
        let (c_rpc, rpc_url) = spawn_tunnel(rpc_port)?;
        let (c_dapp, dapp_url) = spawn_tunnel(dapp_port)?;
        let (c_expl, explorer_api_url) = spawn_tunnel(explorer_api_port)?;
        Ok(Self {
            children: vec![c_rpc, c_dapp, c_expl],
            rpc_url,
            dapp_url,
            explorer_api_url,
        })
    }
}

impl Drop for Tunnels {
    fn drop(&mut self) {
        for child in &mut self.children {
            child.terminate();
        }
    }
}

fn spawn_tunnel(port: u16) -> Result<(MonitoredChild, String), HarnessError> {
    logging::debug(
        "cloudflared",
        format!("starting ephemeral tunnel for localhost:{port}"),
    );
    // `--config /dev/null` is load-bearing: without it cloudflared loads
    // `/etc/cloudflared/config.yml` if it exists on the host and conflates
    // the quick-tunnel URL with the host's named-tunnel credentials, which
    // makes the announced URL return CF 404. Forcing an empty config keeps
    // every invocation a true ephemeral quick tunnel.
    let mut child = Command::new("cloudflared")
        .args([
            "tunnel",
            "--no-autoupdate",
            "--config",
            "/dev/null",
            "--url",
            &format!("http://127.0.0.1:{port}"),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| HarnessError::other(format!("cloudflared spawn: {e}")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| HarnessError::other("cloudflared stderr unavailable"))?;
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        let mut sent = false;
        for line in reader.lines().map_while(Result::ok) {
            logging::info("cloudflared", &line);
            if !sent {
                if let Some(url) = extract_trycloudflare_url(&line) {
                    logging::info("cloudflared", format!("announced public url {url}"));
                    let _ = tx.send(url);
                    sent = true;
                }
            }
        }
    });
    match rx.recv_timeout(Duration::from_secs(60)) {
        Ok(url) => Ok((
            MonitoredChild::new(format!("cloudflared:{port}"), child),
            url,
        )),
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(HarnessError::other(format!(
                "cloudflared URL not announced within 60s ({e})"
            )))
        }
    }
}

fn extract_trycloudflare_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    let needle = ".trycloudflare.com";
    let end = rest.find(needle)? + needle.len();
    Some(rest[..end].to_string())
}

impl Drop for DappStack {
    fn drop(&mut self) {
        logging::info("dapp-compose", "tearing down dapp compose stack");
        for child in &mut self.compose_log_followers {
            child.terminate();
        }
        let _ = Command::new("docker")
            .args([
                "compose",
                "-f",
                "docker-compose.dapp.yaml",
                "down",
                "-v",
                "--remove-orphans",
            ])
            .env("VITE_GATEWAY_ADDRESS", &self.gateway_hex)
            .env("VITE_VAULT_ADDRESS", &self.vault_hex)
            .env(
                "VITE_GATEWAY_EXPECTED_CODE_HASH",
                &self.gateway_runtime_hash,
            )
            .env("INDEXER_GATEWAY", &self.gateway_hex)
            .env("INDEXER_VAULT", &self.vault_hex)
            .current_dir(&self.compose_dir)
            .status();
        logging::info("dapp-compose", "dapp compose teardown complete");
    }
}

/// Poll `url` with HTTP GET until a 2xx response is received or
/// `timeout` elapses. Used to wait for explorer-api and dapp health.
#[allow(dead_code)]
fn wait_for_http_ok(url: &str, timeout: Duration) -> Result<(), HarnessError> {
    wait_for_http_ok_with_probe(url, timeout, None)
}

fn wait_for_http_ok_with_probe(
    url: &str,
    timeout: Duration,
    mut health_probe: Option<&mut dyn FnMut() -> Result<(), HarnessError>>,
) -> Result<(), HarnessError> {
    logging::debug("http", format!("polling {url} for HTTP health"));
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| HarnessError::other(format!("reqwest builder: {e}")))?;
    let deadline = std::time::Instant::now() + timeout;
    let mut last = String::new();
    while std::time::Instant::now() < deadline {
        if let Some(probe) = health_probe.as_deref_mut() {
            probe()?;
        }
        match client.get(url).send() {
            Ok(resp) if resp.status().is_success() => {
                logging::debug("http", format!("{url} returned {}", resp.status()));
                return Ok(());
            }
            Ok(resp) => last = format!("HTTP {}", resp.status()),
            Err(e) => last = format!("{e}"),
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    Err(HarnessError::other(format!(
        "service at {url} not healthy after {timeout:?}: {last}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_collision_guard_filters_running_containers() {
        let stdout = br#"{"Name":"eth-execution","State":"running"}
{"Name":"eth-beacon","State":"running"}
{"Name":"eth-validator-1","State":"exited"}
{"Name":"eth-validator-2","State":"paused"}
"#;

        let names = parse_compose_ps_stdout(stdout).expect("parse compose ps output");
        assert_eq!(names, vec!["eth-execution", "eth-beacon"]);
    }

    #[test]
    fn parse_compose_ps_stdout_ignores_empty_output() {
        let names = parse_compose_ps_stdout(b"\n\n").expect("parse empty output");
        assert!(names.is_empty());
    }
}
