//! Canonical: docs/development/smoke-test-design.md
//!
//! Devnet fixture library for Robot Money integration tests.
//!
//! Boot the Twin chain (918453), fund keys and call the one runbook "publish
//! contracts" by constructing [`Fixture`]. The harness deploys nothing itself.
//! The chain is the Twin fork ([`twin_fork::TwinFork`]): started by
//! `scripts/devnet/twin-fork.ts`, or reused when `TWIN_RPC_URL` is set. Drop stops a fork the
//! fixture started.
//!
//! This crate is chain-level only — no knowledge of any client binary
//! (rmpc, dapp, explorer). Callers that need client helpers import this
//! crate as a dependency and build on top of [`Fixture`].
//!
//! Public surface:
//! - [`Fixture::new`] / [`Fixture::with_deploy_env`] — boot the Twin chain, fund keys, call publish contracts.
//! - Address accessors: [`Fixture::rpc_url`], [`Fixture::gateway`], etc.
//! - On-chain poke helpers: [`Fixture::pause_gateway_deposits`], [`Fixture::fund_usdc`], etc.
//! - [`Fixture::warp`] / [`Fixture::fund_gas`] — the Twin chain environment steps.
//! - [`prerequisites_available`] — check for anvil/bun/forge/cast on PATH.

/// Dev-scout module for Base testnet fixture support (issue #842).
/// Automated account funding seams for Base testnet e2e tests (issue #839).
pub mod base_testnet;
pub mod logging;
/// The one runbook, "publish contracts": the harness calls it, it deploys nothing itself.
pub mod publish;
/// Dev-scout map for the real-adapter state injection boundary (issue #739).
pub mod real_adapter_state;
pub mod stage_table;
/// The Twin chain: a pinned lazy fork of real Base state (core 1498, 1496). Fund gas, fund USDC, warp.
pub mod twin_fork;

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use alloy_primitives::{keccak256, Address};
use tempfile::TempDir;

// -- Harness account constants ----------------------------------------

/// Key paired with DEPOSIT_PAUSER_ROLE. The derived address (`0x6145…`) is
/// the sheet's PAUSER_ADDRESS, granted DEPOSIT_PAUSER_ROLE by publish contracts, so [`Fixture::pause_gateway_deposits`] can
/// use `cast send` with a real signed transaction.
pub const PAUSER_PRIVATE_KEY_HEX: &str =
    "0x53321db7c1e331d93a11a41d16f004d7ff63972ec8ec7c25db329728ceeb1710";
pub const PAUSER_ADDRESS_HEX: &str = "0x614561D2d143621E126e87831AEF287678B442b8";

/// The test depositor: the EOA registered as the vault share receiver (funded with gas at boot). It
/// authorizes the harness agent the way a depositor does, through commitAuthorization and
/// revealAuthorization (the deploy authorizes no agent, core 1527). Test-only, never use on a real chain.
pub const SHARE_RECEIVER_PRIVATE_KEY_HEX: &str =
    "0x933674982877bf1253a5009559b380ddf0eadaa9bd1938d08074ba9c8a8be893";
/// Address derived from [`SHARE_RECEIVER_PRIVATE_KEY_HEX`].
pub const SHARE_RECEIVER_ADDRESS_HEX: &str = "0x5662f34e72De59CCAB95Ec7Ed0e1D1895D5fA7DD";

/// Default policy caps (USDC base units) of the agent the test depositor authorizes after the deploy:
/// per payment 10_000 USDC, per window 100_000 USDC.
pub const DEFAULT_AGENT_MAX_PER_PAYMENT: u128 = 10_000 * 1_000_000;
/// See [`DEFAULT_AGENT_MAX_PER_PAYMENT`].
pub const DEFAULT_AGENT_MAX_PER_WINDOW: u128 = 100_000 * 1_000_000;

/// Harness USDC holder — the clean-history EOA that receives a USDC balance grant at boot
/// (the Twin chain environment step "fund USDC", a write to the real FiatToken balance slot). See
/// `docs/development/smoke-test-design.md` (USDC faucet section) and issue #255.
///
/// This key MUST NOT be used on any real chain. It is test-only by
/// construction. It is the dapp harness's admin EOA and the ETH faucet
/// ([`Fixture::fund_eth_from_harness`]).
pub const HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX: &str =
    "0xd2dffaf3c3c5e3e2f5cb5cef1a3a2e0e0a8b9d4ae2f6c1d3e8a5b7c9e0f1a2b3";
/// Address derived from [`HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX`]. Verified
/// against `cast wallet address` at definition time.
pub const HARNESS_USDC_HOLDER_ADDRESS_HEX: &str = "0xaE67A1B2A267a124Cf762098E3Cbf6B03329E6d5";

/// Fixed host+container port for the `receipt-fixtures` compose service
/// (issue #1294). Not randomized like [`DappPorts`] — that service's
/// container_name is already fixed (`dapp-receipt-fixtures`), so this
/// compose project is already single-instance-per-host; using a fixed port
/// here matches that existing constraint rather than introducing a new one.
/// See `testing/ethereum-testnet/config/docker-compose.dapp.yaml`.
pub const RECEIPT_FIXTURES_PORT: u16 = 8097;

/// Compose profile that gates the `receipt-fixtures` service.
pub const RECEIPT_FIXTURES_PROFILE: &str = "receipt-fixtures";

/// Setting this env var (any value) boots the devnet without the seeded
/// fixture receipts and without the `receipt-fixtures` service, so an
/// acceptance stack indexes only receipts a real frontend produced.
pub const NO_RECEIPT_FIXTURES_ENV: &str = "SMOKE_TEST_NO_RECEIPT_FIXTURES";

/// Whether this process seeds and serves the fixture consensus receipts.
pub fn receipt_fixtures_enabled() -> bool {
    std::env::var_os(NO_RECEIPT_FIXTURES_ENV).is_none()
}

/// The fixture payload directory served by the `receipt-fixtures` compose service, relative to the repo root.
pub const RECEIPT_FIXTURES_DIR_REL: &str =
    "testing/ethereum-testnet/config/consensus-receipt-fixtures";

/// The committee member id the harness agent is registered under before it records the fixture receipts.
pub const RECEIPT_AGENT_ID: &str = "smoke-test-receipt-agent";

/// The on-chain digest receipt-b is recorded with. Deliberately NOT the keccak256 of `receipt-b.json`, so the
/// indexer's re-fetch never verifies it.
pub const RECEIPT_B_WRONG_DIGEST_PREIMAGE: &[u8] = b"smoke-test-wrong-digest-marker-for-1294";

/// `keccak256(abi.encodePacked("robotmoney:consensus-receipt-id:v1\n", sessionId, "\n", subjectId))`, mirroring
/// `ConsensusRecommendationReceipt.computeReceiptId` exactly (contracts/gateway/ConsensusRecommendationReceipt.sol).
/// `abi.encodePacked` on `string` params is a plain byte concatenation, so this needs no RPC round trip.
pub fn compute_receipt_id(session_id: &str, subject_id: &str) -> [u8; 32] {
    const RECEIPT_ID_DOMAIN: &str = "robotmoney:consensus-receipt-id:v1\n";
    let mut buf =
        Vec::with_capacity(RECEIPT_ID_DOMAIN.len() + session_id.len() + 1 + subject_id.len());
    buf.extend_from_slice(RECEIPT_ID_DOMAIN.as_bytes());
    buf.extend_from_slice(session_id.as_bytes());
    buf.push(b'\n');
    buf.extend_from_slice(subject_id.as_bytes());
    keccak256(&buf).0
}

/// One seeded fixture receipt: its served bytes, the receipt id derived from the payload's own
/// `session_id`/`subject_id`, and the public `payload_uri` it is recorded under.
#[derive(Debug, Clone)]
pub struct FixtureReceipt {
    pub bytes: Vec<u8>,
    pub receipt_id: [u8; 32],
    pub payload_uri: String,
}

/// Read a fixture payload from [`RECEIPT_FIXTURES_DIR_REL`] and derive its receipt id from the payload itself, so
/// the id and the served bytes can never drift apart.
pub fn load_fixture_receipt(repo_root: &Path, file: &str) -> Result<FixtureReceipt, HarnessError> {
    let path = repo_root.join(RECEIPT_FIXTURES_DIR_REL).join(file);
    let bytes = std::fs::read(&path)
        .map_err(|e| HarnessError::other(format!("read {}: {e}", path.display())))?;
    let v: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| HarnessError::other(format!("parse {}: {e}", path.display())))?;
    let field = |k: &str| -> Result<String, HarnessError> {
        v.get(k)
            .and_then(|x| x.as_str())
            .map(str::to_string)
            .ok_or_else(|| HarnessError::other(format!("{}: no string `{k}`", path.display())))
    };
    let receipt_id = compute_receipt_id(&field("session_id")?, &field("subject_id")?);
    Ok(FixtureReceipt {
        bytes,
        receipt_id,
        payload_uri: format!("http://receipt-fixtures:{RECEIPT_FIXTURES_PORT}/{file}"),
    })
}

/// `COMPOSE_PROFILES` value for bringing the dapp stack up.
fn dapp_compose_profiles_for_up() -> &'static str {
    if receipt_fixtures_enabled() {
        RECEIPT_FIXTURES_PROFILE
    } else {
        ""
    }
}

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

/// The live ROBOTMONEY (RM) token on Base, 18 decimals. Nothing deploys an RM token: the Twin
/// fork (918453) is a fork of real Base, so the live token exists there at this address (core 1489).
pub const RM_TOKEN_ADDRESS_HEX: &str = "0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3";

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

// -- Fixture ----------------------------------------------------------

/// A fully-wired devnet fixture. Boot by calling [`Fixture::new`];
/// Drop stops the Twin fork when the fixture started it.
pub struct Fixture {
    /// The Twin chain (918453): a pinned lazy fork of real Base state.
    twin: twin_fork::TwinFork,
    /// Tempdir for harness artifacts (deployment JSON, etc.).
    /// Exposed via [`Fixture::tempdir`] so callers can write
    /// additional files (keystores, configs) into the same directory.
    tmp: TempDir,
    rpc_port: u16,
    rpc_url: String,
    chain_id: u64,
    /// The deployed topology, read from the manifests the publish-contracts driver wrote.
    topology: publish::Topology,
    /// The publish run: generated sheet, rehearsal keystores, manifest directory.
    published: publish::Published,
    /// keccak256 of the gateway's runtime code on this chain.
    gateway_runtime_hash: String,
    repo_root: PathBuf,
    /// Harness-owned nonce source of truth for every EOA this devnet sends
    /// from (issue #1241, extended to the funding path by issue #1374).
    /// Created before the first boot-time funding send and moved in here, so
    /// boot funding, deploy funding and every later [`Fixture::cast_send`]
    /// share one nonce sequence per sender. See [`NonceTracker`].
    nonce_tracker: NonceTracker,
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

/// Compose services that are one-shot BY DESIGN: they run to completion and
/// exit 0, so the health probe must not read their `exited` state as a stack
/// failure.
///
/// - `explorer-migrate` — the dapp stack's schema migration step
///   (`docker-compose.dapp.yaml`, issue #1359). The explorer schema used to be
///   migrated as a side effect of the indexer's boot; it is now its own
///   container that `explorer-indexer` and `explorer-api` wait on with
///   `service_completed_successfully`.
///
/// Only a ZERO exit is exempted (see [`is_completed_one_shot`]). A failing
/// migration still trips the probe — that is the point of making migration an
/// explicit step.
const ONE_SHOT_COMPOSE_SERVICES: [&str; 1] = ["explorer-migrate"];

/// True when this container is a [`ONE_SHOT_COMPOSE_SERVICES`] member that has
/// finished successfully, and so must be excluded from the unhealthy set.
fn is_completed_one_shot(status: &ComposeContainerStatus) -> bool {
    status.exit_code == Some(0)
        && status
            .service
            .as_deref()
            .is_some_and(|service| ONE_SHOT_COMPOSE_SERVICES.contains(&service))
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

/// Host port of the Twin fork. `SMOKE_TEST_RPC_PORT` pins it so an external reverse proxy (a named
/// cloudflared tunnel with a stable hostname) can target a deterministic local port.
fn allocate_chain_rpc_port() -> Result<u16, HarnessError> {
    match std::env::var("SMOKE_TEST_RPC_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
    {
        Some(p) => Ok(p),
        None => Ok(test_utils::pick_free_port()?),
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
    /// Boot the Twin chain, fund keys, run the "publish contracts" runbook.
    ///
    /// The Twin chain (918453) is a pinned lazy fork of real Base state: real Aave V3, Compound V3,
    /// Morpho, Uniswap and USDC. [`twin_fork::TwinFork::boot`] starts it with
    /// `scripts/devnet/twin-fork.ts`, or reuses the fork named by `TWIN_RPC_URL`. The harness
    /// deploys its own vault through the runbook and reads every address from the manifests.
    pub fn new() -> Result<Self, HarnessError> {
        Self::with_deploy_env(&[])
    }

    /// Like [`Self::new`] but passes allow-listed sheet parameter overrides to publish contracts.
    /// Used to override deploy-time parameters. `AGENT_MAX_PER_PAYMENT` and `AGENT_MAX_PER_WINDOW` are not
    /// sheet keys (the deploy authorizes no agent): they set the caps of the policy the test depositor
    /// authorizes for the harness agent after the deploy.
    pub fn with_deploy_env(extra_deploy_env: &[(&str, &str)]) -> Result<Self, HarnessError> {
        let cap = |name: &str, default: u128| -> Result<u128, HarnessError> {
            match extra_deploy_env.iter().find(|(k, _)| *k == name) {
                Some((_, v)) => v
                    .parse::<u128>()
                    .map_err(|e| HarnessError::other(format!("{name}={v} is not a number: {e}"))),
                None => Ok(default),
            }
        };
        let agent_max_per_payment = cap("AGENT_MAX_PER_PAYMENT", DEFAULT_AGENT_MAX_PER_PAYMENT)?;
        let agent_max_per_window = cap("AGENT_MAX_PER_WINDOW", DEFAULT_AGENT_MAX_PER_WINDOW)?;
        let sheet_env: Vec<(&str, &str)> = extra_deploy_env
            .iter()
            .filter(|(k, _)| !k.starts_with("AGENT_"))
            .copied()
            .collect();
        let extra_deploy_env = sheet_env.as_slice();
        for tool in ["anvil", "forge", "cast", "bun"] {
            if which::which(tool).is_err() {
                return Err(HarnessError::FoundryMissing(tool));
            }
        }

        let repo_root = locate_repo_root()?;
        let tmp = TempDir::new()?;
        // Stamp this boot with a unique run-id (exported for the compose label interpolation) and
        // reap any dapp containers stranded by a previous run.
        let (run_id, _run_created) = ensure_run_identity();
        logging::info("smoke-test", format!("boot run-id={run_id}"));
        reap_stale_testnet_containers(&run_id);

        let twin = twin_fork::boot_twin_fork(&repo_root, allocate_chain_rpc_port()?)?;
        let rpc_port = twin.rpc_port();
        let rpc_url = twin.rpc_url().to_string();
        logging::info(
            "smoke-test",
            format!(
                "Twin chain ready: rpc={rpc_url} owned={} pin_block_env={}",
                twin.is_owned(),
                std::env::var(twin_fork::TWIN_PIN_BLOCK_ENV).unwrap_or_else(|_| "auto".into())
            ),
        );
        // One nonce source of truth for this chain's whole lifetime (issue #1374). Every send the
        // harness makes from a key draws from it.
        let nonce_tracker = NonceTracker::new(rpc_url.clone());

        // The harness deploys nothing itself. It funds keys, then calls the one runbook, "publish
        // contracts", with the Twin chain arguments: all four vaults, the real Safe, the timelock
        // handover and the verifier. A fresh rehearsal keystore set is minted for every boot, so a
        // redeploy from a new SHA never reuses a deployer.
        let publish_cfg = publish::PublishConfig::from_env(&repo_root).inspect_err(|err| {
            logging::error("smoke-test", format!("publish contracts config: {err}"));
        })?;
        let key_parent = if Path::new("/dev/shm").is_dir() {
            PathBuf::from("/dev/shm")
        } else {
            tmp.path().to_path_buf()
        };
        let keys = publish::make_keys(&publish_cfg, &key_parent).inspect_err(|err| {
            logging::error("smoke-test", format!("rehearsal key helper failed: {err}"));
        })?;

        // Environment steps that may differ from production: fund gas and fund USDC (core 1498).
        // The deployer seeds rmUSDC with real USDC, so it needs USDC before the run.
        const DEPLOYER_USDC_GRANT: u128 = 10_000 * 1_000_000; // 10k USDC, 6dp
        const GAS_WEI: u128 = 1_000_000_000_000_000_000; // 1 ETH
        const DEPLOYER_GAS_WEI: u128 = 10_000_000_000_000_000_000; // 10 ETH
        const HOLDER_GAS_WEI: u128 = 1_000_000_000_000_000_000_000; // 1000 ETH, the faucet reserve
        const HOLDER_USDC_GRANT: u128 = 1_000_000 * 1_000_000; // 1M USDC, 6dp, the faucet reserve
        let agent_hex = format!("{:#x}", agent_address());
        let deployer_hex = keys.address("ADMIN_ADDRESS")?.to_string();
        let fund = || -> Result<(), HarnessError> {
            twin.fund_gas(&deployer_hex, DEPLOYER_GAS_WEI)?;
            twin.set_usdc_balance(&deployer_hex, DEPLOYER_USDC_GRANT)?;
            let mut gas_only: Vec<String> = Vec::new();
            gas_only.extend(keys.address_list("SAFE_OWNERS"));
            gas_only.extend(keys.address_list("VOTER_ADDRESSES"));
            gas_only.push(keys.address("EMERGENCY_ADDRESS")?.to_string());
            gas_only.push(agent_hex.clone());
            gas_only.push(PAUSER_ADDRESS_HEX.to_string());
            for a in gas_only {
                twin.fund_gas(&a, GAS_WEI)?;
            }
            twin.fund_gas(HARNESS_USDC_HOLDER_ADDRESS_HEX, HOLDER_GAS_WEI)?;
            twin.set_usdc_balance(HARNESS_USDC_HOLDER_ADDRESS_HEX, HOLDER_USDC_GRANT)?;
            twin.fund_gas(SHARE_RECEIVER_ADDRESS_HEX, GAS_WEI)?;
            Ok(())
        };
        fund().inspect_err(|err| {
            logging::error("smoke-test", format!("funding keys failed: {err}"));
        })?;

        // Issue 1554: rmAGENT launches holding RM, and `BasketVault.addAsset` needs the RM/USDC pool to have
        // liquidity and observation history. The live pool is unfunded until the owner funds it, so the Twin
        // chain funds the same pool with real transactions first. The addAsset floors are not relaxed.
        fund_rm_pool(&publish_cfg, twin.rpc_url(), &repo_root).inspect_err(|err| {
            logging::error("smoke-test", format!("funding the RM pool failed: {err}"));
        })?;

        // Identity lines are addresses only. The agent and the pauser are the
        // harness's own known keys, so the e2e suites can sign as them.
        let mut identity = keys.fragment.clone();
        identity.insert("CHAIN_ID".into(), publish::TWIN_CHAIN_ID.to_string());
        identity.insert("PAUSER_ADDRESS".into(), PAUSER_ADDRESS_HEX.to_string());
        identity.insert(
            "SHARE_RECEIVER_ADDRESS".into(),
            SHARE_RECEIVER_ADDRESS_HEX.to_string(),
        );
        let published = publish::Published::deploy(
            &publish_cfg,
            &rpc_url,
            keys,
            &identity,
            extra_deploy_env,
            tmp.path(),
        )
        .inspect_err(|err| {
            logging::error("smoke-test", format!("publish contracts failed: {err}"));
        })?;
        let topology = publish::load_topology(&published.manifest_dir).inspect_err(|err| {
            logging::error("smoke-test", format!("manifest read failed: {err}"));
        })?;
        let gateway_runtime_hash = runtime_code_hash(&rpc_url, &topology.gateway)?;
        let chain_id = publish::TWIN_CHAIN_ID;

        let fx = Fixture {
            twin,
            tmp,
            rpc_port,
            rpc_url,
            chain_id,
            topology,
            published,
            gateway_runtime_hash,
            repo_root,
            nonce_tracker,
        };

        // The deploy authorized no agent. The test depositor authorizes the harness agent the way any depositor
        // does: commitAuthorization, then revealAuthorization in a later block.
        fx.depositor_authorize_agent(agent_max_per_payment, agent_max_per_window)
            .inspect_err(|err| {
                logging::error(
                    "smoke-test",
                    format!("depositor authorization failed: {err}"),
                );
            })?;

        // Fund the agent's USDC balance on the real token. Generous amount: the largest scenario
        // deposit is OVER_PAYMENT_CAP_DEPOSIT = 20_000 USDC.
        const AGENT_USDC_GRANT: u128 = 500_000 * 1_000_000; // 500k USDC, 6dp
        fx.fund_usdc(fx.agent(), AGENT_USDC_GRANT)
            .inspect_err(|err| {
                logging::error("smoke-test", format!("funding USDC failed: {err}"));
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
    /// RPC endpoint the explorer-indexer container must dial: the host-side Twin fork over the
    /// Docker bridge (the fork listens on every interface).
    pub fn indexer_rpc_url(&self) -> String {
        self.twin.container_rpc_url()
    }
    /// Host ports the fixture already holds, so the dapp stack never reuses one.
    fn occupied_ports(&self) -> [u16; 1] {
        [self.rpc_port]
    }
    /// The Twin chain this fixture runs on.
    pub fn twin(&self) -> &twin_fork::TwinFork {
        &self.twin
    }
    /// Move chain time forward by `seconds` and mine a block. This is how the 48h governance waits
    /// run on the Twin chain: no real waiting.
    pub fn warp(&self, seconds: u64) -> Result<(), HarnessError> {
        self.twin.warp(seconds)
    }
    /// Set the native balance of `address` to `wei` (an environment step).
    pub fn fund_gas(&self, address: Address, wei: u128) -> Result<(), HarnessError> {
        self.twin.fund_gas(&format!("{address:#x}"), wei)
    }
    pub fn chain_id(&self) -> u64 {
        self.chain_id
    }
    pub fn gateway(&self) -> Address {
        parse_addr(&self.topology.gateway)
    }
    pub fn usdc(&self) -> Address {
        parse_addr(&self.topology.usdc)
    }
    /// rmUSDC, the primary vault.
    pub fn vault(&self) -> Address {
        parse_addr(&self.topology.vault)
    }
    /// Strategy adapters registered with the primary vault, read from the core manifest.
    /// Returns `Address::ZERO` when the manifest does not name one.
    pub fn aave_adapter(&self) -> Address {
        parse_addr(&self.topology.aave_adapter)
    }
    pub fn compound_adapter(&self) -> Address {
        parse_addr(&self.topology.compound_adapter)
    }
    pub fn moonwell_flagship_adapter(&self) -> Address {
        parse_addr(&self.topology.moonwell_flagship_adapter)
    }
    /// The harness agent key's address. The test depositor authorizes it after the deploy.
    pub fn agent(&self) -> Address {
        agent_address()
    }
    pub fn share_receiver(&self) -> Address {
        parse_addr(SHARE_RECEIVER_ADDRESS_HEX)
    }
    pub fn gateway_runtime_hash(&self) -> &str {
        &self.gateway_runtime_hash
    }
    /// Raw string form of the gateway address (for TOML/config templating).
    pub fn gateway_hex(&self) -> &str {
        &self.topology.gateway
    }
    pub fn usdc_hex(&self) -> &str {
        &self.topology.usdc
    }
    pub fn vault_hex(&self) -> &str {
        &self.topology.vault
    }
    pub fn registry(&self) -> Address {
        parse_addr(&self.topology.registry)
    }
    pub fn registry_hex(&self) -> &str {
        &self.topology.registry
    }
    pub fn router(&self) -> Address {
        parse_addr(&self.topology.router)
    }
    pub fn router_hex(&self) -> &str {
        &self.topology.router
    }
    /// RouterGovernance. Its admin is the timelock after handover; the deployer holds nothing.
    pub fn governance(&self) -> Address {
        parse_addr(&self.topology.governance)
    }
    pub fn governance_hex(&self) -> &str {
        &self.topology.governance
    }
    pub fn ic_policy(&self) -> Address {
        parse_addr(&self.topology.ic_policy)
    }
    pub fn ic_policy_hex(&self) -> &str {
        &self.topology.ic_policy
    }
    pub fn consensus_receipt(&self) -> Address {
        parse_addr(&self.topology.consensus_receipt)
    }
    pub fn consensus_receipt_hex(&self) -> &str {
        &self.topology.consensus_receipt
    }
    /// The TimelockController that holds the admin roles after handover.
    pub fn timelock(&self) -> Address {
        parse_addr(&self.topology.timelock)
    }
    pub fn timelock_hex(&self) -> &str {
        &self.topology.timelock
    }
    /// The real 2-of-3 Safe (SafeL2 1.4.1 proxy) that proposes to the timelock.
    pub fn safe(&self) -> Address {
        parse_addr(&self.topology.safe)
    }
    pub fn safe_hex(&self) -> &str {
        &self.topology.safe
    }
    /// A vault by its key: rmUSDC, rmPROTO, rmAGENT or rmRWA.
    pub fn vault_by_key(&self, key: &str) -> Address {
        self.topology
            .vaults
            .get(key)
            .map(|a| parse_addr(a))
            .unwrap_or(Address::ZERO)
    }
    /// rmPROTO (ProtocolAssetVault: wETH and cbBTC).
    pub fn proto_vault(&self) -> Address {
        self.vault_by_key("rmPROTO")
    }
    /// rmAGENT (AgentTokenVault: deployed paused, holding RM as its one asset).
    pub fn agent_vault(&self) -> Address {
        self.vault_by_key("rmAGENT")
    }
    /// rmRWA (deSPXA only, plain basket row).
    pub fn rwa_vault(&self) -> Address {
        self.vault_by_key("rmRWA")
    }
    /// JSON `{rmUSDC,rmPROTO,rmAGENT,rmRWA}` map, threaded to the dapp as
    /// `VITE_VAULT_ADDRESSES`. Read from the manifests, never hand-typed.
    pub fn vault_address_map_json(&self) -> String {
        serde_json::json!({
            "rmUSDC": self.topology.vaults.get("rmUSDC"),
            "rmPROTO": self.topology.vaults.get("rmPROTO"),
            "rmAGENT": self.topology.vaults.get("rmAGENT"),
            "rmRWA": self.topology.vaults.get("rmRWA"),
        })
        .to_string()
    }
    /// The vault addresses by name (rmUSDC, rmPROTO, rmAGENT, rmRWA), read from the manifests.
    pub fn vault_addresses(&self) -> &std::collections::BTreeMap<String, String> {
        &self.topology.vaults
    }
    /// The publish run behind this fixture (sheet, keystores, manifests).
    pub fn published(&self) -> &publish::Published {
        &self.published
    }
    /// The manifest directory the driver wrote.
    pub fn manifest_dir(&self) -> &Path {
        &self.published.manifest_dir
    }
    /// Run one governance row through the real Safe and the timelock. Returns the first tx hash.
    pub fn govern(&self, row: &str, args: &[&str]) -> Result<String, HarnessError> {
        let rows = self.published.govern(row, args)?;
        Ok(rows.first().map(|r| r.tx_hash.clone()).unwrap_or_default())
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
    ///
    /// The gas limit is the node's `eth_estimateGas` result scaled by a 1.5x
    /// buffer (see [`Fixture::estimate_gas_buffered`]) rather than the bare
    /// estimate `cast send` would otherwise forward. This mirrors production
    /// wallets (MetaMask et al. always pad) and the dapp-e2e mock wallet fix
    /// from issue #897: Geth under-estimates transactions whose true cost grows
    /// with same-block state — e.g. several depositors routing into the same
    /// strategy adapter in one block, where the later txs cost more than an
    /// estimate taken against the pre-block state — or that earn storage-clear
    /// gas refunds. Without the buffer those txs mine with too low a gas cap and
    /// revert out-of-gas; with `cast send` reporting only the receipt, the
    /// failure was silent. See `docs/testing/geth-gas-estimation.md`.
    ///
    /// Reverted transactions (receipt `status != 0x1`, including out-of-gas) now
    /// surface as an `Err` instead of an `Ok(tx_hash)`, so a failed deposit can
    /// no longer masquerade as a successful one.
    ///
    /// ## Send-layer failure policy (issue #1241)
    ///
    /// This is the fourth instance of the `latest`-pinned read-after-write
    /// class documented in `docs/testing/geth-state-lag.md`: `cast send`
    /// without an explicit `--nonce` derives one itself from
    /// `eth_getTransactionCount(from, "latest")`, and a receipt-confirmed
    /// prior send does not guarantee that read reflects it yet. Instead of
    /// leaning on cast's implicit lookup, [`Fixture::pin_next_nonce`] makes
    /// this harness the nonce source of truth for every sender: it queries
    /// the `pending`-tagged count (not `latest`) and, once it has pinned a
    /// nonce for an address, polls until a later pin reads strictly past it.
    ///
    /// A failed send is then classified (see [`classify_send_failure`])
    /// rather than always retried:
    /// - `replacement transaction underpriced` means the node refused the
    ///   send outright — nothing entered the chain, so re-sending with the
    ///   same pinned nonce is idempotent and safe.
    /// - `already known` / `nonce too low` mean the write may already have
    ///   landed. Blindly re-sending here could double-apply it (e.g. a
    ///   second `deposit`), so these are resolved by looking up the receipt
    ///   for whatever transaction actually consumed the pinned nonce
    ///   ([`Fixture::find_receipt_for_nonce`]) — never by re-sending. See
    ///   [`run_cast_send_retry`] for the shared decision logic.
    pub fn cast_send(
        &self,
        private_key_hex: &str,
        to: Address,
        sig: &str,
        args: &[&str],
    ) -> Result<String, HarnessError> {
        let to_hex = format!("{to:#x}");
        let from = derive_address(&privkey_hex_to_bytes(private_key_hex)?);
        let from_hex = format!("{from:#x}");
        logging::debug(
            "rpc",
            format!("eth_sendRawTransaction via cast send {sig} -> {to_hex}"),
        );
        let gas_limit = self.estimate_gas_buffered(&from_hex, &to_hex, sig, args)?;
        let gas_limit_s = gas_limit.to_string();
        let nonce = self.nonce_tracker.pin_next_nonce(&from_hex)?;
        let nonce_s = nonce.to_string();

        let v = run_cast_send_retry(
            NONCE_RETRY_DELAYS.len() as u32,
            |attempt| {
                if !NONCE_RETRY_DELAYS[attempt as usize].is_zero() {
                    thread::sleep(NONCE_RETRY_DELAYS[attempt as usize]);
                }
                let mut cmd = Command::new("cast");
                cmd.args([
                    "send",
                    "--rpc-url",
                    &self.rpc_url,
                    "--private-key",
                    private_key_hex,
                    "--gas-limit",
                    &gas_limit_s,
                    "--nonce",
                    &nonce_s,
                    &to_hex,
                    sig,
                ]);
                for a in args {
                    cmd.arg(a);
                }
                cmd.arg("--json");
                let out = match cmd.output() {
                    Ok(out) => out,
                    Err(e) => {
                        return SendAttemptOutcome::Failed(
                            SendFailureClass::Hard,
                            format!("cast send {sig} IO error: {e}"),
                        )
                    }
                };
                logging::log_command_output("cast", &out);
                if out.status.success() {
                    return match serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                        Ok(v) => SendAttemptOutcome::Mined(v),
                        Err(e) => SendAttemptOutcome::Failed(
                            SendFailureClass::Hard,
                            format!("cast send {sig} json: {e}"),
                        ),
                    };
                }
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                let class = classify_send_failure(&stderr);
                SendAttemptOutcome::Failed(
                    class,
                    format!("cast send {sig} failed: stdout={stdout} stderr={stderr}"),
                )
            },
            || self.nonce_tracker.find_receipt_for_nonce(&from_hex, nonce),
        )
        .inspect_err(|_| self.nonce_tracker.release_pin_if_unused(&from_hex, nonce))?;

        let tx_hash = v
            .get("transactionHash")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        // `cast send` exits 0 as soon as the tx mines — even when it mines as a
        // REVERTED tx (receipt `status == 0x0`). Gas estimation catches most
        // reverts up front, but a tx whose state changes between estimate and
        // inclusion (or one sent with an explicit `--gas-limit`) can land
        // reverted with a zero process exit. Assert the receipt status so a
        // reverted seeding tx fails loudly instead of being silently accepted.
        let status = v.get("status").and_then(|x| x.as_str()).ok_or_else(|| {
            HarnessError::other(format!("cast send {sig} receipt missing status field: {v}"))
        })?;
        if !receipt_status_succeeded(status) {
            let reason = self.tx_revert_reason(&tx_hash);
            return Err(HarnessError::other(format!(
                "cast send {sig} -> {to_hex} mined as a REVERTED tx (receipt status={status}, hash={tx_hash}){reason}"
            )));
        }
        Ok(tx_hash)
    }
}

// -- NonceTracker -----------------------------------------------------

/// The nonce this harness pins for the next send from an address, given the
/// last nonce it pinned for that address (`None` on the first send) and the
/// node's current `pending` transaction count (issues #1241, #1374).
///
/// The node's count is a *lower* bound, never an authority: geth reports a
/// `pending` count that has not yet absorbed an in-flight send, so two sends
/// issued close together both read the same number. Taking `prev + 1`
/// whenever the node has not moved past the last pin makes the harness — not
/// the node's read timing — the monotonic source of truth for each sender's
/// nonce sequence. That is what makes two same-account sends structurally
/// unable to collide, rather than merely unlikely to.
fn next_pinned_nonce(prev: Option<u64>, pending: u64) -> u64 {
    match prev {
        Some(p) => pending.max(p + 1),
        None => pending,
    }
}

/// Harness-owned nonce source of truth for every EOA the devnet harness
/// sends from (issue #1241, extended by issue #1374).
///
/// One tracker exists per devnet instance and is created before the first
/// funding send in [`Fixture::new`], so boot-time funding, deploy-time
/// funding and every later [`Fixture::cast_send`] share a single nonce
/// sequence per sender. Before #1374 the funding helpers
/// (`fund_eth_from_deployer`, `fund_usdc_to_deployer`,
/// [`Fixture::fund_eth_from_harness`]) bypassed the tracker entirely and let
/// `cast send` derive its own nonce from a `latest`-tagged read — the read
/// that lags a just-sent transaction — so two funding sends from the same
/// account collided and geth rejected the second with `replacement
/// transaction underpriced`, reddening PRs whose diffs could not have caused
/// it. All sends now route through [`NonceTracker::pin_next_nonce`].
pub(crate) struct NonceTracker {
    rpc_url: String,
    /// Per-sender last-pinned nonce, keyed by lowercase `0x`-EOA hex. Scoped
    /// to one devnet instance rather than a process-global map, so nonce
    /// state from one test's devnet never leaks into another test's freshly
    /// reset chain.
    pins: Mutex<HashMap<String, u64>>,
}

impl NonceTracker {
    fn new(rpc_url: impl Into<String>) -> Self {
        Self {
            rpc_url: rpc_url.into(),
            pins: Mutex::new(HashMap::new()),
        }
    }

    fn rpc_url(&self) -> &str {
        &self.rpc_url
    }

    /// Pin the nonce for the next send from `from_hex` rather than letting
    /// `cast send` derive it implicitly (issue #1241).
    ///
    /// `cast send` without `--nonce` calls
    /// `eth_getTransactionCount(from, "latest")` itself — exactly the
    /// `latest`-pinned read-after-write class documented in
    /// `docs/testing/geth-state-lag.md`: a receipt-confirmed send does not
    /// guarantee that read reflects it yet, so the next implicit lookup can
    /// return a stale (too-low) nonce and collide with the previous send.
    ///
    /// Instead this queries the `pending`-tagged count (mempool-inclusive,
    /// not mined-only) and hands out `next_pinned_nonce(prev, pending)` — the
    /// node's count only when it has already moved past the last pin, and
    /// `prev + 1` otherwise.
    ///
    /// ## Why the lock spans the read (issue #1374)
    ///
    /// The map lock is held across the `pending` read *and* the insert, so
    /// nonce issuance for a given tracker is serialised. Releasing it around
    /// the RPC — as this did before #1374 — let two concurrent callers both
    /// observe the same `prev`, read the same `pending`, and pin the *same*
    /// nonce; the second send to reach geth was then rejected with
    /// `replacement transaction underpriced`. the boot-time funding sends
    /// from shared keys, so that window was live.
    fn pin_next_nonce(&self, from_hex: &str) -> Result<u64, HarnessError> {
        self.pin_next_nonce_with(from_hex, |addr| {
            self.eth_get_transaction_count(addr, "pending")
        })
    }

    /// [`NonceTracker::pin_next_nonce`] with the `pending`-count read
    /// injected, so the serialisation invariant is exercisable without a
    /// chain (see `tests::concurrent_pins_never_hand_out_a_colliding_nonce`).
    fn pin_next_nonce_with(
        &self,
        from_hex: &str,
        read_pending: impl Fn(&str) -> Result<u64, HarnessError>,
    ) -> Result<u64, HarnessError> {
        let key = from_hex.to_lowercase();
        // Held across the read: see this method's "Why the lock spans the
        // read" note. `unwrap_or_else(into_inner)` keeps a panicking caller
        // from poisoning every later send.
        let mut pins = self.pins.lock().unwrap_or_else(|e| e.into_inner());
        let pending = read_pending(from_hex)?;
        let nonce = next_pinned_nonce(pins.get(&key).copied(), pending);
        pins.insert(key, nonce);
        Ok(nonce)
    }

    /// Hand a pinned nonce back after a send that failed (issue #1374).
    ///
    /// Pins are monotonic, so a nonce pinned for a send that never reached
    /// the chain — an unfunded faucet, a bad RPC URL — would otherwise leave
    /// a permanent gap: every later send from that address would pin past the
    /// unused nonce and sit in the mempool forever. That would turn one loud
    /// funding failure into a silent hang, the opposite of what this issue is
    /// for.
    ///
    /// Releasing is conditional, never blind: it asks the node for the
    /// `pending` count first and keeps the pin if anything at all — mined or
    /// merely queued — already consumed the nonce, so a send whose success
    /// response was merely lost can never be re-issued under a nonce that is
    /// already spoken for. Best-effort by construction: if the node cannot be
    /// reached the pin simply stands, because the caller is already
    /// propagating a hard error.
    fn release_pin_if_unused(&self, from_hex: &str, nonce: u64) {
        let read = |addr: &str| self.eth_get_transaction_count(addr, "pending");
        self.release_pin_if_unused_with(from_hex, nonce, read);
    }

    /// [`NonceTracker::release_pin_if_unused`] with the `pending`-count read
    /// injected, so its "only when genuinely unused" rule is testable without
    /// a chain.
    fn release_pin_if_unused_with(
        &self,
        from_hex: &str,
        nonce: u64,
        read_pending: impl Fn(&str) -> Result<u64, HarnessError>,
    ) {
        let Ok(pending) = read_pending(from_hex) else {
            return;
        };
        if pending > nonce {
            // Something consumed it — keep the pin.
            return;
        }
        let key = from_hex.to_lowercase();
        let mut pins = self.pins.lock().unwrap_or_else(|e| e.into_inner());
        if pins.get(&key).copied() != Some(nonce) {
            // A later send already moved this sender on; not ours to rewind.
            return;
        }
        match nonce.checked_sub(1) {
            Some(prev) => pins.insert(key, prev),
            None => pins.remove(&key),
        };
    }

    /// Query `eth_getTransactionCount(address, tag)` via `cast rpc`. `tag` is
    /// `"pending"` (mempool-inclusive; used to pin the next send's nonce) or
    /// `"latest"` (mined-only; used to detect that a pinned nonce has
    /// actually landed — see [`Fixture::find_receipt_for_nonce`]).
    fn eth_get_transaction_count(&self, address_hex: &str, tag: &str) -> Result<u64, HarnessError> {
        let out = Command::new("cast")
            .args([
                "rpc",
                "--rpc-url",
                &self.rpc_url,
                "eth_getTransactionCount",
                address_hex,
                tag,
            ])
            .output()?;
        if !out.status.success() {
            return Err(HarnessError::other(format!(
                "eth_getTransactionCount({address_hex}, {tag}) failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        parse_hex_rpc_result(
            &out.stdout,
            &format!("eth_getTransactionCount({address_hex}, {tag})"),
        )
    }

    /// Query `eth_blockNumber` via `cast rpc`. Used by
    /// [`Fixture::find_receipt_for_nonce`] to bound the block-scan window.
    fn eth_block_number(&self) -> Result<u64, HarnessError> {
        let out = Command::new("cast")
            .args(["rpc", "--rpc-url", &self.rpc_url, "eth_blockNumber"])
            .output()?;
        if !out.status.success() {
            return Err(HarnessError::other(format!(
                "eth_blockNumber failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        parse_hex_rpc_result(&out.stdout, "eth_blockNumber")
    }

    /// Fetch a full block (with transaction bodies) via `cast rpc
    /// eth_getBlockByNumber`. Used by [`Fixture::find_receipt_for_nonce`] to
    /// scan for the transaction that consumed a given `(from, nonce)`.
    fn eth_get_block_by_number(&self, block_num: u64) -> Result<serde_json::Value, HarnessError> {
        let out = Command::new("cast")
            .args([
                "rpc",
                "--rpc-url",
                &self.rpc_url,
                "eth_getBlockByNumber",
                &format!("{block_num:#x}"),
                "true",
            ])
            .output()?;
        if !out.status.success() {
            return Err(HarnessError::other(format!(
                "eth_getBlockByNumber({block_num}) failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        serde_json::from_slice(&out.stdout).map_err(|e| {
            HarnessError::other(format!("eth_getBlockByNumber({block_num}) json: {e}"))
        })
    }

    /// Fetch a mined transaction's receipt via `cast receipt --json`. Shares
    /// the same top-level shape (`transactionHash`, `status`, ...) as `cast
    /// send --json`'s output, so callers can treat both uniformly.
    fn fetch_receipt(&self, tx_hash: &str) -> Result<serde_json::Value, HarnessError> {
        let out = Command::new("cast")
            .args(["receipt", "--rpc-url", &self.rpc_url, tx_hash, "--json"])
            .output()?;
        if !out.status.success() {
            return Err(HarnessError::other(format!(
                "cast receipt {tx_hash} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        serde_json::from_slice(&out.stdout)
            .map_err(|e| HarnessError::other(format!("cast receipt {tx_hash} json: {e}")))
    }

    /// Resolve an ambiguous send outcome (`already known` / `nonce too low`)
    /// by finding the transaction that actually consumed `nonce` and
    /// returning its receipt, instead of re-sending (issue #1241).
    ///
    /// [`Fixture::pin_next_nonce`] makes this harness the sole nonce source
    /// for `from_hex`, so whichever transaction consumed `nonce` — this
    /// attempt or an earlier one whose success response was lost — IS the
    /// write this call intended; re-sending on ambiguity risks double-
    /// applying it (e.g. a double deposit). This waits (bounded, 30s
    /// deadline / 500ms poll — the same shape as
    /// `wait_for_vault_registered`'s registry-visibility poll) for the
    /// mined transaction count to pass `nonce`, then scans back through
    /// recent blocks for the `(from, nonce)` transaction and returns its
    /// receipt.
    fn find_receipt_for_nonce(
        &self,
        from_hex: &str,
        nonce: u64,
    ) -> Result<serde_json::Value, HarnessError> {
        const DEADLINE: Duration = Duration::from_secs(30);
        const POLL_INTERVAL: Duration = Duration::from_millis(500);
        let start = std::time::Instant::now();
        loop {
            let mined = self.eth_get_transaction_count(from_hex, "latest")?;
            if mined > nonce {
                break;
            }
            if start.elapsed() >= DEADLINE {
                return Err(HarnessError::other(format!(
                    "ambiguous send outcome for {from_hex} nonce {nonce} never resolved: mined \
                     transaction count still {mined} after {DEADLINE:?} — refusing to resend a \
                     write whose effect is unknown"
                )));
            }
            thread::sleep(POLL_INTERVAL);
        }

        let from_lower = from_hex.to_lowercase();
        let latest_block = self.eth_block_number()?;
        const SCAN_BLOCKS: u64 = 20;
        let earliest = latest_block.saturating_sub(SCAN_BLOCKS);
        for block_num in (earliest..=latest_block).rev() {
            let block = self.eth_get_block_by_number(block_num)?;
            let Some(txs) = block.get("transactions").and_then(|t| t.as_array()) else {
                continue;
            };
            for tx in txs {
                let tx_from = tx.get("from").and_then(|f| f.as_str()).unwrap_or_default();
                let tx_nonce = tx
                    .get("nonce")
                    .and_then(|n| n.as_str())
                    .and_then(|n| u64::from_str_radix(n.trim_start_matches("0x"), 16).ok());
                if tx_from.eq_ignore_ascii_case(&from_lower) && tx_nonce == Some(nonce) {
                    let hash = tx.get("hash").and_then(|h| h.as_str()).ok_or_else(|| {
                        HarnessError::other(format!(
                            "found tx for {from_hex} nonce {nonce} in block {block_num} with no hash field"
                        ))
                    })?;
                    return self.fetch_receipt(hash);
                }
            }
        }
        Err(HarnessError::other(format!(
            "mined transaction count for {from_hex} passed nonce {nonce}, but no matching \
             transaction was found scanning the last {SCAN_BLOCKS} blocks ({earliest}..={latest_block})"
        )))
    }
}

impl Fixture {
    /// Best-effort decode of a reverted tx's revert reason via `cast run`,
    /// appended to the harness error for fast diagnosis. Returns an empty
    /// string when no reason can be recovered (e.g. `cast run` unavailable),
    /// so the caller's error stays well-formed regardless.
    fn tx_revert_reason(&self, tx_hash: &str) -> String {
        if tx_hash.is_empty() {
            return String::new();
        }
        let out = match Command::new("cast")
            .args(["run", "--rpc-url", &self.rpc_url, tx_hash])
            .output()
        {
            Ok(out) => out,
            Err(_) => return String::new(),
        };
        let mut text = String::from_utf8_lossy(&out.stdout).to_string();
        text.push_str(&String::from_utf8_lossy(&out.stderr));
        let reason = text
            .lines()
            .find(|l| {
                let l = l.to_lowercase();
                l.contains("revert") || l.contains("error")
            })
            .map(str::trim)
            .unwrap_or("");
        if reason.is_empty() {
            String::new()
        } else {
            format!("; revert: {reason}")
        }
    }

    /// Raw `eth_call` of `sig` (for example `assets(uint256)`) with `args` on `to`: the undecoded
    /// return data as a lowercase 0x hex string. Read-only, no signing.
    pub fn cast_call_raw(
        &self,
        to: Address,
        sig: &str,
        args: &[&str],
    ) -> Result<String, HarnessError> {
        cast_call_raw_at(&self.rpc_url, &format!("{to:#x}"), sig, args)
    }

    /// Read `token.balanceOf(owner)` via a plain `eth_call` (`cast call`).
    /// Used to verify deposits actually minted shares to the recipient. No
    /// signing, no impersonation — a read-only query against the live chain.
    pub fn erc20_balance_of(&self, token: Address, owner: Address) -> Result<u128, HarnessError> {
        // balanceOf(address) selector 0x70a08231, owner left-padded to 32 bytes.
        let data = format!(
            "0x70a08231000000000000000000000000{}",
            format!("{owner:#x}").trim_start_matches("0x")
        );
        let out = Command::new("cast")
            .args([
                "call",
                "--rpc-url",
                &self.rpc_url,
                &format!("{token:#x}"),
                &data,
            ])
            .output()?;
        if !out.status.success() {
            return Err(HarnessError::other(format!(
                "cast call balanceOf({owner:#x}) on {token:#x} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        let raw = String::from_utf8_lossy(&out.stdout);
        let s = raw.trim().trim_start_matches("0x");
        if s.is_empty() || s.chars().all(|c| c == '0') {
            return Ok(0);
        }
        // The ABI word is up to 256 bits. The demo seeds share counts well
        // within u128, but a value past 2^128 must not silently read back as
        // zero: if the high half is non-zero, saturate so the non-zero check
        // stays honest; otherwise return the exact low-128-bit value.
        let low = &s[s.len().saturating_sub(32)..];
        let high_nonzero = s.len() > 32 && s[..s.len() - 32].chars().any(|c| c != '0');
        let low_val = u128::from_str_radix(low, 16).unwrap_or(u128::MAX);
        Ok(if high_nonzero { u128::MAX } else { low_val })
    }

    /// Read `token.allowance(owner, spender)` via a plain `eth_call`
    /// (`cast call`). Used to confirm an `approve` is visible on-chain before
    /// the dependent `transferFrom`/`deposit` is sent. No signing — a read-only
    /// query against the live chain.
    ///
    /// This is the read half of the poll-after-write fix for the Geth
    /// read-after-write state-lag class; canonical doc:
    /// `docs/testing/geth-state-lag.md`.
    pub fn erc20_allowance(
        &self,
        token: Address,
        owner: Address,
        spender: Address,
    ) -> Result<u128, HarnessError> {
        // allowance(address,address) selector 0xdd62ed3e, owner then spender
        // each left-padded to 32 bytes.
        let data = format!(
            "0xdd62ed3e000000000000000000000000{}000000000000000000000000{}",
            format!("{owner:#x}").trim_start_matches("0x"),
            format!("{spender:#x}").trim_start_matches("0x"),
        );
        let out = Command::new("cast")
            .args([
                "call",
                "--rpc-url",
                &self.rpc_url,
                &format!("{token:#x}"),
                &data,
            ])
            .output()?;
        if !out.status.success() {
            return Err(HarnessError::other(format!(
                "cast call allowance({owner:#x},{spender:#x}) on {token:#x} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        let raw = String::from_utf8_lossy(&out.stdout);
        let s = raw.trim().trim_start_matches("0x");
        if s.is_empty() || s.chars().all(|c| c == '0') {
            return Ok(0);
        }
        // Same up-to-256-bit decode as `erc20_balance_of`: saturate when the
        // high half is non-zero so the visibility check stays honest.
        let low = &s[s.len().saturating_sub(32)..];
        let high_nonzero = s.len() > 32 && s[..s.len() - 32].chars().any(|c| c != '0');
        let low_val = u128::from_str_radix(low, 16).unwrap_or(u128::MAX);
        Ok(if high_nonzero { u128::MAX } else { low_val })
    }

    /// Estimate gas for a `cast send` and return a 1.5x-buffered limit.
    ///
    /// A failing estimate means the transaction would revert on-chain (the node
    /// rejects the `eth_estimateGas` call); we propagate that as an `Err` so the
    /// caller never sends a doomed transaction. See `cast_send` for why the
    /// buffer is required.
    fn estimate_gas_buffered(
        &self,
        from_hex: &str,
        to_hex: &str,
        sig: &str,
        args: &[&str],
    ) -> Result<u128, HarnessError> {
        let mut cmd = Command::new("cast");
        cmd.args([
            "estimate",
            "--rpc-url",
            &self.rpc_url,
            "--from",
            from_hex,
            to_hex,
            sig,
        ]);
        for a in args {
            cmd.arg(a);
        }
        let out = cmd.output()?;
        logging::log_command_output("cast", &out);
        if !out.status.success() {
            return Err(HarnessError::other(format!(
                "cast estimate {sig} failed (tx would revert): from={from_hex} to={to_hex} stdout={} stderr={}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        let est: u128 = String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse()
            .map_err(|e| HarnessError::other(format!("cast estimate {sig} parse: {e}")))?;
        // 1.5x buffer, matching the dapp-e2e mock-wallet policy (issue #897).
        Ok(est.saturating_mul(3) / 2)
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

    /// Pause new gateway deposits from the DEPOSIT_PAUSER_ROLE holder.
    /// Withdrawals stay open while deposits are paused (core 1494).
    pub fn pause_gateway_deposits(&self) -> Result<String, HarnessError> {
        self.cast_send(
            PAUSER_PRIVATE_KEY_HEX,
            self.gateway(),
            "pauseDeposits()",
            &[],
        )
    }

    /// Send `sig(args)` to `target` as a Safe -> Timelock call through the real SafeL2 (the CLI's Twin-only
    /// generic call). The calldata is built with `cast calldata`. `label` names the kind of call: a process-wide
    /// counter is appended so every call is its own timelock operation (the label is the salt, and a repeated
    /// label would reuse the earlier call's spent or reverted operation).
    fn timelock_call(
        &self,
        label: &str,
        target: Address,
        sig: &str,
        args: &[&str],
    ) -> Result<String, HarnessError> {
        let out = Command::new("cast")
            .arg("calldata")
            .arg(sig)
            .args(args)
            .output()?;
        if !out.status.success() {
            return Err(HarnessError::other(format!(
                "cast calldata {sig} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        let data = String::from_utf8_lossy(&out.stdout).trim().to_string();
        static CALL_SEQ: AtomicU64 = AtomicU64::new(0);
        let unique = format!("{label}-{}", CALL_SEQ.fetch_add(1, Ordering::SeqCst));
        let rows = self
            .published
            .govern_call(&unique, &format!("{target:#x}"), &data)?;
        Ok(rows.first().map(|r| r.tx_hash.clone()).unwrap_or_default())
    }

    /// Resume gateway deposits through the real Safe and the timelock (a generic timelock call:
    /// `unpauseDeposits()` is ADMIN_ROLE, held by the timelock after handover; it is not a mainnet govern row).
    pub fn unpause_gateway_deposits(&self) -> Result<String, HarnessError> {
        self.timelock_call(
            "gateway-unpause-deposits",
            self.gateway(),
            "unpauseDeposits()",
            &[],
        )
    }

    /// Revoke the agent as its owner, the test depositor (`revokeAgent` requires the recorded owner).
    pub fn revoke_agent(&self) -> Result<String, HarnessError> {
        let agent = format!("{:#x}", self.agent());
        self.cast_send(
            SHARE_RECEIVER_PRIVATE_KEY_HEX,
            self.gateway(),
            "revokeAgent(address)",
            &[&agent],
        )
    }

    /// Re-authorize the agent with the given policy caps, as the test depositor (commit then reveal). The
    /// agent must not be authorized now: revoke it first.
    pub fn reauthorize_agent(
        &self,
        max_per_payment: u128,
        max_per_window: u128,
    ) -> Result<String, HarnessError> {
        self.depositor_authorize_agent(max_per_payment, max_per_window)
    }

    /// The test depositor authorizes the harness agent: `commitAuthorization(keccak(agent, depositor, salt))`,
    /// then `revealAuthorization(agent, salt, policy)` in a later block. The policy names the depositor as the
    /// share receiver (the permissionless path requires it). Returns the reveal transaction hash.
    pub fn depositor_authorize_agent(
        &self,
        max_per_payment: u128,
        max_per_window: u128,
    ) -> Result<String, HarnessError> {
        let agent = self.agent();
        let depositor = self.share_receiver();
        let salt = keccak256(b"smoke-test depositor agent authorization");
        let mut preimage = Vec::with_capacity(96);
        for addr in [agent, depositor] {
            preimage.extend_from_slice(&[0u8; 12]);
            preimage.extend_from_slice(addr.as_slice());
        }
        preimage.extend_from_slice(salt.as_slice());
        let commit_hash = format!("0x{}", hex::encode(keccak256(&preimage).0));
        self.cast_send(
            SHARE_RECEIVER_PRIVATE_KEY_HEX,
            self.gateway(),
            "commitAuthorization(bytes32)",
            &[&commit_hash],
        )?;
        // The reveal must land in a later block than the commit (CommitmentTooRecent otherwise). A fork without a
        // block time mines only on transactions, so mine one block here (a one-second warp).
        let commit_head = self.nonce_tracker.eth_block_number()?;
        self.warp(1)?;
        if self.nonce_tracker.eth_block_number()? <= commit_head {
            return Err(HarnessError::other(
                "no new block after commitAuthorization and a one-second warp",
            ));
        }
        let receiver = format!("{depositor:#x}");
        // (active, validUntil, maxPerPayment, maxPerWindow, shareReceiver, allowedDestinations,
        //  assetRecipient, maxWithdrawPerPayment, maxWithdrawPerWindow, allowedSourceVaults)
        // validUntil is the year 2100: the Twin chain time warps forward through every timelock delay.
        let policy = format!(
            "(true,4102444800,{max_per_payment},{max_per_window},{receiver},[],{receiver},{max_per_payment},{max_per_window},[])"
        );
        self.cast_send(
            SHARE_RECEIVER_PRIVATE_KEY_HEX,
            self.gateway(),
            "revealAuthorization(address,bytes32,(bool,uint64,uint256,uint256,address,address[],address,uint256,uint256,address[]))",
            &[&format!("{agent:#x}"), &format!("0x{}", hex::encode(salt.0)), &policy],
        )
    }

    /// `authorizeAgent(agent, policy)` through the real Safe and the timelock (a generic timelock call,
    /// ADMIN_ROLE). Used to re-grant the fixture agent and to prove the role-separation invariant: an
    /// address that already holds admin cannot be authorized as an agent, so the execute step reverts.
    pub fn authorize_agent_for(
        &self,
        agent: Address,
        max_per_payment: u128,
        max_per_window: u128,
    ) -> Result<String, HarnessError> {
        let agent = format!("{agent:#x}");
        let share_receiver = format!("{:#x}", self.share_receiver());
        // (active, validUntil, maxPerPayment, maxPerWindow, shareReceiver, allowedDestinations,
        //  assetRecipient, maxWithdrawPerPayment, maxWithdrawPerWindow, allowedSourceVaults)
        // validUntil is the year 2100: the Twin chain time warps forward through every timelock delay.
        let policy = format!(
            "(true,4102444800,{max_per_payment},{max_per_window},{share_receiver},[],{share_receiver},{max_per_payment},{max_per_window},[])"
        );
        self.timelock_call(
            "gateway-reauthorize-agent",
            self.gateway(),
            "authorizeAgent(address,(bool,uint64,uint256,uint256,address,address[],address,uint256,uint256,address[]))",
            &[&agent, &policy],
        )
    }

    /// Seed the two fixture consensus receipts the dapp e2e spec `consensus-receipts-seeded.spec.ts` asserts on
    /// (issue #1294). Runs on `--full-stack` boots unless `--no-receipt-fixtures` is set (see [`DappStack::boot`]).
    ///
    /// - `receipt-a.json`: recorded with its OWN correct digest and released. Its weights equal the live router
    ///   vector under the missing-vault = 0 bps rule (the Twin stage sheet `ROUTER_WEIGHTS` the deployer leaves on
    ///   the router before the handover: rmUSDC 6000, rmPROTO 2500, rmRWA 1500, rmAGENT 0), so it renders
    ///   "Verified", "Released" and "Applied".
    /// - `receipt-b.json`: recorded with a deliberately WRONG digest and never released. Its weights differ from
    ///   the live vector, so it renders "Unverified", "Recorded, not released" and "Not applied".
    ///
    /// Authorities are the mainnet ones (docs/architecture.md §4.9.2). No test-only admin grant exists:
    /// - `committeeRegister` needs the gateway's ADMIN_ROLE, held by the timelock after handover: a Safe -> Timelock
    ///   generic call ([`Self::timelock_call`]).
    /// - `consensusRecordReceipt` needs AGENT_ROLE plus COMMITTEE_AGENT_ROLE: the harness agent key signs it.
    /// - `releaseReceipt` needs the receipt contract's ADMIN_ROLE, held by the timelock: the publish-contracts govern
    ///   row `release-receipt` (the same row `core-stack governance release` and the Fusion acceptance scripts run).
    ///
    /// Both payloads are served by the `receipt-fixtures` compose service at [`RECEIPT_FIXTURES_PORT`] under the
    /// hostname `receipt-fixtures`: the indexer reaches it over the compose network, and the Playwright browser maps
    /// the same hostname to 127.0.0.1 (`clients/dapp/playwright.config.ts`). The bytes only need to exist by the
    /// indexer's first fetch, after the compose stack is up, so seeding before that service starts is safe.
    pub fn seed_consensus_receipts(&self) -> Result<(), HarnessError> {
        let a = load_fixture_receipt(&self.repo_root, "receipt-a.json")?;
        let b = load_fixture_receipt(&self.repo_root, "receipt-b.json")?;
        let agent_hex = format!("{:#x}", self.agent());
        self.timelock_call(
            "gateway-committee-register",
            self.gateway(),
            "committeeRegister(address,string)",
            &[&agent_hex, RECEIPT_AGENT_ID],
        )?;

        let agent_pk_hex = format!("0x{}", hex::encode(AGENT_PRIVATE_KEY));
        let id_a = format!("0x{}", hex::encode(a.receipt_id));
        let digest_a = format!("0x{}", hex::encode(keccak256(&a.bytes).0));
        self.cast_send(
            &agent_pk_hex,
            self.gateway(),
            "consensusRecordReceipt(bytes32,bytes32,string)",
            &[&id_a, &digest_a, &a.payload_uri],
        )?;
        let id_b = format!("0x{}", hex::encode(b.receipt_id));
        let digest_b = format!(
            "0x{}",
            hex::encode(keccak256(RECEIPT_B_WRONG_DIGEST_PREIMAGE).0)
        );
        self.cast_send(
            &agent_pk_hex,
            self.gateway(),
            "consensusRecordReceipt(bytes32,bytes32,string)",
            &[&id_b, &digest_b, &b.payload_uri],
        )?;

        // Release receipt A only: a signalling-only act (no funds move, no router weight changes). Receipt B stays
        // recorded, not released.
        self.govern("release-receipt", &["--receipt-id", &id_a])?;
        logging::info(
            "smoke-test",
            format!("seeded consensus receipts: a={id_a} (released) b={id_b} (recorded only)"),
        );
        Ok(())
    }

    /// Grant `amount` USDC base units (6 decimals) to `recipient` on the real Base USDC token.
    ///
    /// This is the Twin chain environment step "fund USDC": it writes the real FiatToken
    /// `balanceAndBlacklistStates[recipient]` storage slot with
    /// `scripts/devnet/twin-fork.ts fund-usdc` (anvil_setStorageAt), so the real token's own code
    /// reads and spends the balance. Total supply is not changed. The write is absolute on the
    /// slot, so this reads the current balance first and sets balance + amount: a grant, never an
    /// overwrite. Returns the recipient's new balance.
    pub fn fund_usdc(&self, recipient: Address, amount: u128) -> Result<u128, HarnessError> {
        let who = format!("{recipient:#x}");
        let before = self.twin.usdc_balance(&who)?;
        let after = before
            .checked_add(amount)
            .ok_or_else(|| HarnessError::other("USDC grant overflows u128"))?;
        self.twin.set_usdc_balance(&who, after)?;
        Ok(after)
    }

    /// Fund `recipient` with `value_wei` native ETH by signing a plain value
    /// transfer from [`HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX`] (issue #466).
    ///
    /// The holder EOA is funded with 1000 ETH at boot (fund gas), so a
    /// vanilla value transfer signed by the holder's key needs no cheat
    /// and no impersonation. Returns the transaction hash.
    pub fn fund_eth_from_harness(
        &self,
        recipient: Address,
        value_wei: &str,
    ) -> Result<String, HarnessError> {
        let to_hex = format!("{recipient:#x}");
        logging::debug(
            "rpc",
            format!("eth_sendRawTransaction via cast send value={value_wei} -> {to_hex}"),
        );
        let v = pinned_cast_send(
            &self.nonce_tracker,
            "fund_eth_from_harness",
            HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX,
            &["--value", value_wei, &to_hex],
        )?;
        Ok(v.get("transactionHash")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string())
    }
}

/// Raw `cast call` of `sig` on `to` at `rpc_url`: lowercase 0x hex return data. Read-only.
fn cast_call_raw_at(
    rpc_url: &str,
    to: &str,
    sig: &str,
    args: &[&str],
) -> Result<String, HarnessError> {
    let mut cmd = Command::new("cast");
    cmd.args(["call", "--rpc-url", rpc_url, to, sig]);
    cmd.args(args);
    let out = cmd.output()?;
    if !out.status.success() {
        return Err(HarnessError::other(format!(
            "cast call {sig} on {to} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_lowercase())
}

/// Fund the live RM/USDC Uniswap V3 pool on the Twin chain (issue 1554) with `rehearsal fund-rm-pool`, the one
/// implementation of the step (the twin-publish CI action runs the same verb). Real pool, real position manager,
/// real transactions: it gives a funder RM and USDC with the fork's balance helpers, raises the pool's
/// observation cardinality and mints one in-range position. It asserts the `BasketVault.addAsset` floors
/// (cardinality >= 2, liquidity >= 1e6) itself, so a failure names the pool and not a later revert.
fn fund_rm_pool(
    cfg: &publish::PublishConfig,
    rpc_url: &str,
    repo_root: &Path,
) -> Result<(), HarnessError> {
    let out = Command::new("bun")
        .arg(cfg.rehearsal_cli())
        .args(["fund-rm-pool", "--rpc", rpc_url, "--core-dir"])
        .arg(repo_root)
        .stdin(Stdio::null())
        .output()?;
    if !out.status.success() {
        return Err(HarnessError::other(format!(
            "rehearsal fund-rm-pool failed: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    logging::info("smoke-test", String::from_utf8_lossy(&out.stderr).trim());
    Ok(())
}

// -- Public helpers ---------------------------------------------------

/// Returns `true` iff `anvil`, `bun`, `forge`, and `cast` are all on PATH: the Twin fork
/// (anvil, started by the bun tool) and the publish run (forge, cast, bun) need them. The dapp
/// stack additionally needs docker, which [`DappStack::boot`] checks itself.
pub fn prerequisites_available() -> bool {
    ["anvil", "bun", "forge", "cast"]
        .iter()
        .all(|t| which::which(t).is_ok())
}

// -- Internal helpers -------------------------------------------------

/// Parse a `0x`-prefixed (or bare) 32-byte hex private key into raw bytes.
/// Used to recover the sender address for gas estimation in [`Fixture::cast_send`].
fn privkey_hex_to_bytes(pk_hex: &str) -> Result<[u8; 32], HarnessError> {
    let s = pk_hex.strip_prefix("0x").unwrap_or(pk_hex);
    let bytes =
        hex::decode(s).map_err(|e| HarnessError::other(format!("invalid private key hex: {e}")))?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| HarnessError::other("private key must be exactly 32 bytes"))
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

/// Sub-second readiness poll cadence for HTTP/RPC probes: a quickly-booting
/// service is detected within a quarter second rather than waiting out a
/// multi-second tick. The per-request timeout (5s) still bounds a hung probe,
/// so tightening the cadence costs nothing but a few extra cheap calls.
const READINESS_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Block-height poll cadence. Slower than [`READINESS_POLL_INTERVAL`] because a
/// new block only arrives once per slot, so polling faster cannot surface one
/// sooner.
const BLOCK_POLL_INTERVAL: Duration = Duration::from_millis(500);

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
    let started = std::time::Instant::now();
    let deadline = started + timeout;
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
                        logging::info(
                            "rpc",
                            format!(
                                "{url} ready in {}ms (chainId)",
                                started.elapsed().as_millis()
                            ),
                        );
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
        std::thread::sleep(READINESS_POLL_INTERVAL);
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
        std::thread::sleep(BLOCK_POLL_INTERVAL);
    }
    Err(HarnessError::RpcTimeout {
        url: url.to_string(),
        timeout,
    })
}

/// Environment variables the compose files read to stamp run-identity labels
/// onto every container (see docker-compose.dapp.yaml).
const RUN_ID_ENV: &str = "SMOKE_RUN_ID";
const RUN_CREATED_ENV: &str = "SMOKE_RUN_CREATED";

/// Docker label key carrying the run-id of the boot that created a container.
/// A boot reaps containers in our compose projects whose run-id differs from
/// its own (i.e. stranded by a previous, now-dead run).
const RUN_ID_LABEL: &str = "com.robotmoney.testnet.run-id";

/// Compose projects whose containers belong to a devnet boot. The reaper scans
/// only these so it never touches unrelated containers on the host.
const TESTNET_COMPOSE_PROJECTS: [&str; 1] = ["robotmoney-dapp"];

/// Mint (once per process) a unique run-id and creation timestamp and export
/// them so child `docker compose` invocations stamp them as container labels.
/// Idempotent: a run-id already set earlier in the same process is reused, so
/// the fixture boot and the dapp overlay share one identity and are reaped
/// together.
fn ensure_run_identity() -> (String, String) {
    if let (Ok(id), Ok(created)) = (std::env::var(RUN_ID_ENV), std::env::var(RUN_CREATED_ENV)) {
        if !id.is_empty() {
            return (id, created);
        }
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let created = now.as_secs().to_string();
    // Sub-second precision plus the pid keeps two boots from the same process
    // (or two processes within the same second) distinct.
    let run_id = format!("{:016x}-{:x}", now.as_nanos() as u64, std::process::id());
    std::env::set_var(RUN_ID_ENV, &run_id);
    std::env::set_var(RUN_CREATED_ENV, &created);
    (run_id, created)
}

/// Parse `docker ps` label output (lines of `<id>\t<run-id>\t<name>`) and return
/// the `(id, name)` pairs whose run-id differs from `current_run_id` — i.e. the
/// containers stranded by a previous run. Pure (no docker), so the
/// stale-vs-current decision is unit-tested without a live daemon.
fn stale_containers_from_listing(listing: &str, current_run_id: &str) -> Vec<(String, String)> {
    let mut stale = Vec::new();
    for line in listing.lines() {
        let mut cols = line.split('\t');
        let id = cols.next().unwrap_or("").trim();
        let run_id = cols.next().unwrap_or("").trim();
        let name = cols.next().unwrap_or("").trim();
        if id.is_empty() || run_id == current_run_id {
            continue;
        }
        stale.push((id.to_string(), name.to_string()));
    }
    stale
}

/// Force-remove devnet containers stranded by a previous run. Scans only our
/// compose projects (via Docker's built-in `com.docker.compose.project` label)
/// and removes any container whose run-id label differs from `current_run_id`.
/// Containers from the current run are protected by the run-id match; legacy
/// containers booted before run-id labels existed carry an empty run-id and so
/// are treated as stale and reaped. Best-effort: docker errors are logged, not
/// propagated, so a transient `docker` hiccup never blocks a boot.
fn reap_stale_testnet_containers(current_run_id: &str) {
    let mut stale: Vec<(String, String)> = Vec::new();
    for project in TESTNET_COMPOSE_PROJECTS {
        let listing = Command::new("docker")
            .args([
                "ps",
                "-a",
                "--filter",
                &format!("label=com.docker.compose.project={project}"),
                "--format",
                &format!("{{{{.ID}}}}\t{{{{.Label \"{RUN_ID_LABEL}\"}}}}\t{{{{.Names}}}}"),
            ])
            .output();
        match listing {
            Ok(out) if out.status.success() => {
                stale.extend(stale_containers_from_listing(
                    &String::from_utf8_lossy(&out.stdout),
                    current_run_id,
                ));
            }
            Ok(out) => logging::warn(
                "smoke-test",
                format!(
                    "reaper: `docker ps` for project {project} failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ),
            ),
            Err(err) => {
                logging::warn(
                    "smoke-test",
                    format!("reaper: `docker ps` not runnable: {err}"),
                );
                return;
            }
        }
    }
    if stale.is_empty() {
        return;
    }
    let names: Vec<&str> = stale.iter().map(|(_, n)| n.as_str()).collect();
    logging::info(
        "smoke-test",
        format!(
            "reaper: removing {} container(s) stranded by previous run(s): {}",
            stale.len(),
            names.join(", ")
        ),
    );
    let mut rm = Command::new("docker");
    rm.args(["rm", "-f"]);
    for (id, _) in &stale {
        rm.arg(id);
    }
    match rm.output() {
        Ok(out) if out.status.success() => {}
        Ok(out) => logging::warn(
            "smoke-test",
            format!(
                "reaper: `docker rm -f` failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ),
        ),
        Err(err) => logging::warn(
            "smoke-test",
            format!("reaper: `docker rm -f` not runnable: {err}"),
        ),
    }
}

/// Proactively tear down any stale `robotmoney-dapp` compose state before a
/// fresh `DappStack::boot`. Runs `compose down -v --remove-orphans` on
/// `docker-compose.dapp.yaml` so that containers, volumes, AND the
/// `robotmoney-dapp_default` Docker network are fully removed.
///
/// This addresses the root cause of issue #1085: `reap_stale_testnet_containers`
/// force-removes individual containers by ID but does not remove the Docker
/// network itself. A network stuck in `REMOVING` state (left by a cancelled or
/// crashed CI run) causes the subsequent `compose up --build` to fail in ~36 s
/// because Docker cannot create a new network with the same name. Calling
/// `compose down` before `compose up` removes the network atomically.
///
/// The minimum required env vars for `compose down` are the mandatory `?:`
/// substitutions in `docker-compose.dapp.yaml`; everything else defaults.
/// Best-effort: a non-zero exit means there was nothing to tear down (happy
/// path); the outcome is logged and execution continues regardless.
fn purge_stale_dapp_compose_state(
    compose_dir: &Path,
    gateway_hex: &str,
    vault_hex: &str,
    gateway_runtime_hash: &str,
) {
    logging::info(
        "smoke-test",
        "purging stale dapp compose state before boot (removes stuck networks/volumes)",
    );
    let out = Command::new("docker")
        .args([
            "compose",
            "-f",
            "docker-compose.dapp.yaml",
            "down",
            "-v",
            "--remove-orphans",
        ])
        .env("COMPOSE_PROFILES", RECEIPT_FIXTURES_PROFILE)
        // Satisfy the mandatory ?:-substitutions in docker-compose.dapp.yaml.
        // compose down does not bind ports, so port env vars are not required.
        .env("VITE_GATEWAY_ADDRESS", gateway_hex)
        .env("VITE_VAULT_ADDRESS", vault_hex)
        .env("VITE_GATEWAY_EXPECTED_CODE_HASH", gateway_runtime_hash)
        .env("INDEXER_GATEWAY", gateway_hex)
        .env("INDEXER_VAULT", vault_hex)
        .current_dir(compose_dir)
        .output();
    match out {
        Ok(out) if out.status.success() => {
            logging::info("smoke-test", "stale dapp compose state purged");
        }
        Ok(out) => {
            // Non-zero exit is normal when the project has no containers/networks
            // to remove; log at debug so CI noise stays low.
            logging::debug(
                "smoke-test",
                format!(
                    "dapp compose down (pre-boot purge) exited {:?}: {} {}",
                    out.status,
                    String::from_utf8_lossy(&out.stdout).trim(),
                    String::from_utf8_lossy(&out.stderr).trim(),
                ),
            );
        }
        Err(err) => {
            logging::warn(
                "smoke-test",
                format!("dapp compose down (pre-boot purge) failed to launch: {err}"),
            );
        }
    }
}

/// keccak256 of the runtime code at `addr`, read with `cast code`.
fn runtime_code_hash(rpc_url: &str, addr: &str) -> Result<String, HarnessError> {
    let out = Command::new("cast")
        .args(["code", addr, "--rpc-url", rpc_url])
        .output()?;
    if !out.status.success() {
        return Err(HarnessError::other(format!(
            "cast code {addr} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let bytes = hex::decode(raw.trim_start_matches("0x"))
        .map_err(|e| HarnessError::other(format!("cast code {addr} is not hex: {e}")))?;
    if bytes.is_empty() {
        return Err(HarnessError::other(format!("{addr} has no code")));
    }
    Ok(format!("0x{}", hex::encode(keccak256(&bytes).0)))
}

/// Delays before the 2nd, 3rd and 4th attempt of a
/// [`SendFailureClass::SafeRetry`] send. The first attempt is immediate.
const NONCE_RETRY_DELAYS: [Duration; 4] = [
    Duration::ZERO,
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
];

/// Run one `cast send` under a harness-pinned nonce and the issue #1241
/// send-failure policy, and return its parsed `--json` receipt.
///
/// This is the funding path's half of what [`Fixture::cast_send`] does for
/// contract pokes (issue #1374). `args` is everything between the pinned
/// flags and `--json`: either `["--value", wei, recipient]` for a plain value
/// transfer or `[to, sig, args...]` for a call. Gas is left to `cast`'s own
/// estimate — unlike [`Fixture::cast_send`] these are fixed-cost transfers
/// with no same-block state growth to under-estimate (issue #897).
///
/// The three properties this buys, none of which the previous bare
/// `Command::new("cast").arg("send")` had:
///
/// 1. **No colliding nonce.** `--nonce` comes from
///    [`NonceTracker::pin_next_nonce`], which is monotonic per sender and
///    serialised across threads, so two funding sends from one account
///    cannot be handed the same nonce. This is the actual defect behind
///    `replacement transaction underpriced` in fixture bring-up.
/// 2. **Scoped retry.** Only [`SendFailureClass::SafeRetry`] (the node
///    refused the send outright, so nothing entered the chain) is retried;
///    [`SendFailureClass::Ambiguous`] is resolved by receipt lookup, never by
///    re-sending.
/// 3. **A genuine failure still fails loudly.** Anything unrecognised —
///    `insufficient funds` from an unfunded faucet, a bad RPC URL, `cast`
///    missing — classifies as [`SendFailureClass::Hard`] and propagates
///    immediately with `{label} failed:` and the full stdout/stderr, so it is
///    never retried into silence and never mistaken for the nonce race.
fn pinned_cast_send(
    tracker: &NonceTracker,
    label: &str,
    private_key_hex: &str,
    args: &[&str],
) -> Result<serde_json::Value, HarnessError> {
    let from = derive_address(&privkey_hex_to_bytes(private_key_hex)?);
    let from_hex = format!("{from:#x}");
    let nonce = tracker.pin_next_nonce(&from_hex)?;
    let nonce_s = nonce.to_string();
    run_cast_send_retry(
        NONCE_RETRY_DELAYS.len() as u32,
        |attempt| {
            if !NONCE_RETRY_DELAYS[attempt as usize].is_zero() {
                thread::sleep(NONCE_RETRY_DELAYS[attempt as usize]);
            }
            let mut cmd = Command::new("cast");
            cmd.args([
                "send",
                "--rpc-url",
                tracker.rpc_url(),
                "--private-key",
                private_key_hex,
                "--nonce",
                &nonce_s,
            ]);
            cmd.args(args);
            cmd.arg("--json");
            let out = match cmd.output() {
                Ok(out) => out,
                Err(e) => {
                    return SendAttemptOutcome::Failed(
                        SendFailureClass::Hard,
                        format!("{label} IO error: {e}"),
                    )
                }
            };
            logging::log_command_output("cast", &out);
            if out.status.success() {
                return match serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                    Ok(v) => SendAttemptOutcome::Mined(v),
                    Err(e) => SendAttemptOutcome::Failed(
                        SendFailureClass::Hard,
                        format!("{label} json: {e}"),
                    ),
                };
            }
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let class = classify_send_failure(&stderr);
            SendAttemptOutcome::Failed(
                class,
                format!("{label} failed: stdout={stdout} stderr={stderr}"),
            )
        },
        || tracker.find_receipt_for_nonce(&from_hex, nonce),
    )
    .inspect_err(|_| tracker.release_pin_if_unused(&from_hex, nonce))
}

/// Interpret a transaction receipt `status` word from `cast send --json`.
///
/// Foundry emits the status as a hex quantity: `"0x1"` for a successful tx and
/// `"0x0"` for a reverted one. A reverted tx (status `0x0`) still mines, so
/// `cast send` exits 0 and the calling harness used to swallow the revert
/// (issue #904). Returns `true` only when the word denotes a non-zero (success)
/// status, treating any non-zero hex word as success to stay robust to future
/// formatting; an empty or all-zero word is a failure.
fn receipt_status_succeeded(status: &str) -> bool {
    let stripped = status.trim_start_matches("0x").trim_start_matches("0X");
    !stripped.is_empty() && stripped.chars().any(|c| c != '0')
}

/// Parse a `cast rpc` result that is a single quoted hex-quantity string
/// (e.g. `"0x1a"`), as returned by `eth_getTransactionCount` /
/// `eth_blockNumber`. `what` names the call in the error message.
fn parse_hex_rpc_result(stdout: &[u8], what: &str) -> Result<u64, HarnessError> {
    let raw = String::from_utf8_lossy(stdout);
    let hex = raw.trim().trim_matches('"').trim_start_matches("0x");
    u64::from_str_radix(hex, 16)
        .map_err(|e| HarnessError::other(format!("{what} returned non-hex result {raw:?}: {e}")))
}

/// Classification of a failed `cast send` attempt (issue #1241), used by
/// [`run_cast_send_retry`] to decide whether re-sending is safe. See
/// `docs/testing/geth-state-lag.md` and [`Fixture::cast_send`]'s doc comment
/// for the full policy this implements.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SendFailureClass {
    /// The node rejected the transaction outright (`replacement transaction
    /// underpriced`): nothing entered the chain, so re-sending is
    /// idempotent and safe.
    SafeRetry,
    /// The transaction may already have landed (`already known` / `nonce
    /// too low`). Re-sending here could double-apply a write (e.g. a
    /// double deposit); the caller MUST resolve this via a receipt lookup,
    /// never by re-sending.
    Ambiguous,
    /// Any other failure is a hard, non-retryable error.
    Hard,
}

/// Classify a `cast send` failure's stderr text into a [`SendFailureClass`].
/// Pure and independent of any live chain so the retry/ambiguity policy in
/// [`run_cast_send_retry`] is unit-testable without a devnet.
fn classify_send_failure(stderr: &str) -> SendFailureClass {
    if stderr.contains("replacement transaction underpriced") {
        SendFailureClass::SafeRetry
    } else if stderr.contains("already known") || stderr.contains("nonce too low") {
        SendFailureClass::Ambiguous
    } else {
        SendFailureClass::Hard
    }
}

/// Outcome of one raw `cast send` attempt, as classified from its process
/// exit status. Threaded through [`run_cast_send_retry`] so the retry
/// policy can be exercised by a real `Command` in production and by a fake
/// closure in tests.
enum SendAttemptOutcome {
    /// `cast send` exited 0 and the transaction mined; carries `cast send
    /// --json`'s parsed receipt.
    Mined(serde_json::Value),
    /// `cast send` failed; carries its classification and a fully-formatted
    /// message for the eventual hard-error text.
    Failed(SendFailureClass, String),
}

/// Drives the send-retry/ambiguity policy for [`Fixture::cast_send`] (issue
/// #1241). `attempt(n)` performs (or, in tests, simulates) the nth raw send;
/// `lookup_receipt` resolves an ambiguous outcome by looking up whatever
/// transaction actually consumed the pinned nonce — it must be a real
/// receipt query, never a re-send.
///
/// - [`SendFailureClass::SafeRetry`]: nothing entered the chain, so `attempt`
///   is called again (up to `max_attempts` total calls).
/// - [`SendFailureClass::Ambiguous`]: `attempt` is NEVER called again — the
///   write may already have landed, so the only safe resolution is
///   `lookup_receipt`.
/// - [`SendFailureClass::Hard`]: propagated immediately.
fn run_cast_send_retry(
    max_attempts: u32,
    mut attempt: impl FnMut(u32) -> SendAttemptOutcome,
    mut lookup_receipt: impl FnMut() -> Result<serde_json::Value, HarnessError>,
) -> Result<serde_json::Value, HarnessError> {
    assert!(
        max_attempts > 0,
        "run_cast_send_retry requires at least one attempt"
    );
    for n in 0..max_attempts {
        match attempt(n) {
            SendAttemptOutcome::Mined(v) => return Ok(v),
            SendAttemptOutcome::Failed(SendFailureClass::SafeRetry, msg) => {
                if n + 1 == max_attempts {
                    return Err(HarnessError::other(msg));
                }
            }
            SendAttemptOutcome::Failed(SendFailureClass::Ambiguous, msg) => {
                return lookup_receipt().map_err(|e| {
                    HarnessError::other(format!(
                        "cast send outcome ambiguous ({msg}) and could not be resolved by \
                         receipt lookup: {e}"
                    ))
                });
            }
            SendAttemptOutcome::Failed(SendFailureClass::Hard, msg) => {
                return Err(HarnessError::other(msg));
            }
        }
    }
    unreachable!("loop above always returns before exhausting max_attempts")
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
            .filter(|status| !is_completed_one_shot(status) && status.is_unhealthy())
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
/// Canonical: Plan tracking issue #109 §10.5 — Phase 4.5.
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
        // Share the chain boot's run-id (already set in this process) so the
        // dapp containers carry the same run-identity labels and are reaped
        // together; mint one defensively if a caller boots the dapp stack
        // without first booting the chain fixture.
        ensure_run_identity();

        // The fixture receipts and the `receipt-fixtures` service that serves them are one switch
        // (`--no-receipt-fixtures` turns both off), so they are decided here, together.
        if receipt_fixtures_enabled() {
            fixture.seed_consensus_receipts().inspect_err(|err| {
                logging::error(
                    "smoke-test",
                    format!("consensus receipt fixture seeding failed: {err}"),
                );
            })?;
        }

        let compose_dir = fixture.repo_root().join("testing/ethereum-testnet/config");

        // Proactively purge any stale dapp compose state (containers, networks,
        // volumes) from a previous run before calling compose-up. This is
        // belt-and-suspenders over reap_stale_testnet_containers: that helper
        // force-removes individual containers but does NOT remove the
        // robotmoney-dapp_default Docker network, which can get stuck in
        // REMOVING state after an aborted CI run. A stuck network causes the
        // subsequent compose-up to fail immediately (in ~36 s, well before
        // image builds complete) because Docker cannot create a new network
        // with the same name. Calling compose-down here removes containers,
        // volumes, AND the stuck network atomically before we start fresh.
        // Best-effort: a non-zero exit here means there was nothing to clean
        // up, which is the happy path; we log the outcome and continue.
        purge_stale_dapp_compose_state(
            &compose_dir,
            fixture.gateway_hex(),
            fixture.vault_hex(),
            fixture.gateway_runtime_hash(),
        );
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
                .env("COMPOSE_PROFILES", RECEIPT_FIXTURES_PROFILE)
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
        // The Docker-bridge host address and the Twin fork port (the fork runs on the host).
        let indexer_rpc_url = fixture.indexer_rpc_url();
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
            (
                "VITE_GOVERNANCE_ADDRESS",
                fixture.governance_hex().to_string(),
            ),
            // Core 1544: the timelock and the Safe that proposes to it, so the admin
            // tabs build a Safe -> Timelock proposal instead of a wallet transaction.
            ("VITE_TIMELOCK_ADDRESS", fixture.timelock_hex().to_string()),
            ("VITE_SAFE_ADDRESS", fixture.safe_hex().to_string()),
            // Issues #463/#466: the live RM token address so the main-page
            // balances panel renders the RM row (core 1489: nothing deploys RM).
            ("VITE_RM_TOKEN_ADDRESS", RM_TOKEN_ADDRESS_HEX.to_string()),
            // Issue #1294: bucket-vault-symbol map so ConsensusReceiptPanel can
            // compute applied vs not-applied against live router weights.
            ("VITE_VAULT_ADDRESSES", fixture.vault_address_map_json()),
            ("INDEXER_GATEWAY", gateway_hex.to_string()),
            ("INDEXER_VAULT", vault_hex.to_string()),
            ("INDEXER_REGISTRY", fixture.registry_hex().to_string()),
            // Index WeightsSet/DefaultWeightsSet and RouterDeposit events from PortfolioRouter
            // (issue #615); router deposits trigger fresh TVL snapshots for all registered vaults.
            ("INDEXER_PORTFOLIO_ROUTER", fixture.router_hex().to_string()),
            // Issue #1294: index ReceiptRecorded/ReceiptReleased events from
            // ConsensusRebalanceReceipt and verify each payload_uri's digest.
            (
                "INDEXER_CONSENSUS_RECEIPT",
                fixture.consensus_receipt_hex().to_string(),
            ),
            // Issue #1294: fixed port for the receipt-fixtures compose service
            // (see RECEIPT_FIXTURES_PORT).
            ("RECEIPT_FIXTURES_PORT", RECEIPT_FIXTURES_PORT.to_string()),
            // The indexer reaches the host-side Twin fork over the Docker bridge (gateway address
            // and fork port), see Fixture::indexer_rpc_url.
            ("INDEXER_RPC_URL", indexer_rpc_url.clone()),
            ("VITE_DEVNET_RPC_URL", "".to_string()),
            ("VITE_EXPLORER_API_URL", "".to_string()),
            ("VITE_DAPP_URL", "".to_string()),
            // The dapp faucet (Faucet tab and onboarding seed) signs with the harness USDC holder,
            // the Twin chain's funded faucet reserve. Test-only key; a mainnet build refuses any
            // faucet key (clients/dapp/src/lib/buildEnvValidation.ts).
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
            // Core 1544: the timelock and the Safe that proposes to it.
            (
                "VITE_TIMELOCK_ADDRESS".into(),
                fixture.timelock_hex().to_string(),
            ),
            ("VITE_SAFE_ADDRESS".into(), fixture.safe_hex().to_string()),
            // Issues #463/#466: the live RM token address so the main-page
            // balances panel renders the RM row (core 1489: nothing deploys RM).
            ("VITE_RM_TOKEN_ADDRESS".into(), RM_TOKEN_ADDRESS_HEX.into()),
            // Issue #1294: bucket-vault-symbol map so ConsensusReceiptPanel can
            // compute applied vs not-applied against live router weights.
            (
                "VITE_VAULT_ADDRESSES".into(),
                fixture.vault_address_map_json(),
            ),
            ("INDEXER_GATEWAY".into(), gateway_hex.to_string()),
            ("INDEXER_VAULT".into(), vault_hex.to_string()),
            (
                "INDEXER_REGISTRY".into(),
                fixture.registry_hex().to_string(),
            ),
            // Index WeightsSet/DefaultWeightsSet from PortfolioRouter (issue #615).
            (
                "INDEXER_PORTFOLIO_ROUTER".into(),
                fixture.router_hex().to_string(),
            ),
            // Issue #1294: index ReceiptRecorded/ReceiptReleased events from
            // ConsensusRebalanceReceipt and verify each payload_uri's digest.
            (
                "INDEXER_CONSENSUS_RECEIPT".into(),
                fixture.consensus_receipt_hex().to_string(),
            ),
            // Issue #1294: fixed port for the receipt-fixtures compose service.
            (
                "RECEIPT_FIXTURES_PORT".into(),
                RECEIPT_FIXTURES_PORT.to_string(),
            ),
            // Issue #775: see dapp_log_env comment above.
            ("INDEXER_RPC_URL".into(), indexer_rpc_url.clone()),
            ("VITE_DEVNET_RPC_URL".into(), vite_rpc_url.clone()),
            (
                "VITE_EXPLORER_API_URL".into(),
                vite_explorer_api_url.clone(),
            ),
            ("VITE_DAPP_URL".into(), vite_dapp_url.clone()),
            (
                "VITE_FAUCET_HARNESS_PRIVATE_KEY".into(),
                HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX.to_string(),
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
            .env("COMPOSE_PROFILES", dapp_compose_profiles_for_up())
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
            // Core 1544: the timelock and the Safe that proposes to it (admin tabs).
            .env("VITE_TIMELOCK_ADDRESS", fixture.timelock_hex())
            .env("VITE_SAFE_ADDRESS", fixture.safe_hex())
            // Issues #463/#466: thread the live RM token address into the dapp
            // build so the main-page balances panel renders the RM row.
            .env("VITE_RM_TOKEN_ADDRESS", RM_TOKEN_ADDRESS_HEX)
            // Issue #1294: bucket-vault-symbol map so ConsensusReceiptPanel can
            // compute applied vs not-applied against live router weights.
            .env("VITE_VAULT_ADDRESSES", fixture.vault_address_map_json())
            .env("INDEXER_GATEWAY", gateway_hex)
            .env("INDEXER_VAULT", vault_hex)
            .env("INDEXER_REGISTRY", fixture.registry_hex())
            // Index WeightsSet/DefaultWeightsSet and RouterDeposit events from PortfolioRouter (issue #615).
            .env("INDEXER_PORTFOLIO_ROUTER", fixture.router_hex())
            // Issue #1294: index ReceiptRecorded/ReceiptReleased events from
            // ConsensusRebalanceReceipt and verify each payload_uri's digest.
            .env("INDEXER_CONSENSUS_RECEIPT", fixture.consensus_receipt_hex())
            // Issue #1294: fixed port for the receipt-fixtures compose service.
            .env("RECEIPT_FIXTURES_PORT", RECEIPT_FIXTURES_PORT.to_string())
            // The indexer reaches the host-side Twin fork over the Docker bridge (gateway address
            // and fork port). The fork listens on every interface.
            .env("INDEXER_RPC_URL", &indexer_rpc_url)
            // VITE_FORK_RPC_URL intentionally NOT set: the dapp routes all
            // chain reads through the user's wallet RPC (see
            // docs/technical/dapp-topology.md §2). VITE_DEVNET_RPC_URL is
            // passed as a *UX hint*: the dapp's Connect Wallet button uses
            // it to call `wallet_addEthereumChain` so MetaMask prefills the
            // RPC URL when prompting the user to add chain 918453. The
            // dapp never fetches from this URL itself.
            .env("VITE_DEVNET_RPC_URL", &vite_rpc_url)
            .env("VITE_EXPLORER_API_URL", &vite_explorer_api_url)
            .env("VITE_DAPP_URL", &vite_dapp_url)
            // The faucet is a Twin chain environment step (fund USDC from the harness holder), not
            // a deployment step, so the publish run never sees this key. The dapp build gets it.
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
            .env("COMPOSE_PROFILES", RECEIPT_FIXTURES_PROFILE)
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
    let started = std::time::Instant::now();
    let deadline = started + timeout;
    let mut last = String::new();
    while std::time::Instant::now() < deadline {
        if let Some(probe) = health_probe.as_deref_mut() {
            probe()?;
        }
        match client.get(url).send() {
            Ok(resp) if resp.status().is_success() => {
                logging::info(
                    "http",
                    format!(
                        "{url} ready in {}ms (HTTP {})",
                        started.elapsed().as_millis(),
                        resp.status()
                    ),
                );
                return Ok(());
            }
            Ok(resp) => last = format!("HTTP {}", resp.status()),
            Err(e) => last = format!("{e}"),
        }
        std::thread::sleep(READINESS_POLL_INTERVAL);
    }
    Err(HarnessError::other(format!(
        "service at {url} not healthy after {timeout:?}: {last}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The depositor key must derive the share receiver address the sheet names, or the depositor's
    /// commit and reveal would be signed by a different account than the policy's share receiver.
    #[test]
    fn share_receiver_key_derives_the_share_receiver_address() {
        let pk = privkey_hex_to_bytes(SHARE_RECEIVER_PRIVATE_KEY_HEX).unwrap();
        assert_eq!(derive_address(&pk), parse_addr(SHARE_RECEIVER_ADDRESS_HEX));
    }

    const RECEIPT_A_ID_VECTOR: &str =
        "0x379e538a5b294305dbd33d7781ef89aafee97b59e2a0ede478cd87c1895fc17a";

    /// `compute_receipt_id` must equal `ConsensusRecommendationReceipt.computeReceiptId`. The vector is
    /// `cast keccak` of the packed preimage `"robotmoney:consensus-receipt-id:v1\n" + session + "\n" + subject`.
    #[test]
    fn compute_receipt_id_matches_the_contract_preimage() {
        let id = compute_receipt_id(
            "12940000-0000-4000-8000-00000000000a",
            "treasury-allocation",
        );
        assert_eq!(format!("0x{}", hex::encode(id)), RECEIPT_A_ID_VECTOR);
    }

    /// The seeded fixtures load, derive distinct ids from their own payload fields, and are served under the
    /// `receipt-fixtures` hostname. receipt-a matches the live router vector under the missing-vault = 0 bps rule
    /// (the Twin stage sheet `ROUTER_WEIGHTS`: rmUSDC 6000, rmPROTO 2500, rmRWA 1500, rmAGENT 0), and receipt-b differs from it.
    #[test]
    fn fixture_receipts_load_and_carry_the_expected_weights() {
        let root = locate_repo_root().expect("repo root");
        let a = load_fixture_receipt(&root, "receipt-a.json").expect("receipt-a");
        let b = load_fixture_receipt(&root, "receipt-b.json").expect("receipt-b");
        assert_ne!(a.receipt_id, b.receipt_id);
        assert_eq!(
            a.payload_uri,
            format!("http://receipt-fixtures:{RECEIPT_FIXTURES_PORT}/receipt-a.json")
        );
        let weights = |bytes: &[u8]| -> Vec<(String, u64)> {
            let v: serde_json::Value = serde_json::from_slice(bytes).unwrap();
            v["weights"]
                .as_array()
                .unwrap()
                .iter()
                .map(|w| {
                    (
                        w["bucket"].as_str().unwrap().to_string(),
                        w["weight_bps"].as_u64().unwrap(),
                    )
                })
                .collect()
        };
        let live = vec![
            ("agent_tokens".to_string(), 0),
            ("conservative_defi_yield".to_string(), 6_000),
            ("protocol_tokens".to_string(), 2_500),
            ("real_world_assets".to_string(), 1_500),
        ];
        assert_eq!(weights(&a.bytes), live);
        assert_ne!(weights(&b.bytes), live);
        assert_ne!(
            keccak256(&b.bytes).0,
            keccak256(RECEIPT_B_WRONG_DIGEST_PREIMAGE).0
        );
    }

    fn exited_status(service: &str, exit_code: i64) -> ComposeContainerStatus {
        ComposeContainerStatus {
            id: "deadbeef".to_string(),
            name: format!("dapp-{service}"),
            service: Some(service.to_string()),
            state: "exited".to_string(),
            health: None,
            exit_code: Some(exit_code),
            oom_killed: false,
            error: None,
        }
    }

    /// Issue #1359: `explorer-migrate` runs the explorer schema migration and
    /// exits. `is_unhealthy` classifies ANY exited container as unhealthy, so
    /// without the one-shot exemption the dapp stack's health probe would abort
    /// every full-stack boot the moment the migration finished successfully.
    #[test]
    fn completed_migrate_one_shot_is_not_treated_as_unhealthy() {
        let migrate = exited_status("explorer-migrate", 0);
        assert!(
            migrate.is_unhealthy(),
            "an exited container is unhealthy in the general case"
        );
        assert!(
            is_completed_one_shot(&migrate),
            "explorer-migrate exiting 0 must be exempted from the unhealthy set"
        );
    }

    /// The exemption is strictly for a SUCCESSFUL run: a failed migration is
    /// exactly the condition the explicit migrate step exists to surface, so it
    /// must still fail the probe.
    #[test]
    fn failed_migrate_one_shot_is_still_unhealthy() {
        let migrate = exited_status("explorer-migrate", 1);
        assert!(
            !is_completed_one_shot(&migrate),
            "a non-zero migrate exit must NOT be exempted"
        );
        assert!(migrate.is_unhealthy());
    }

    /// A long-running service that exits 0 is still a stack failure — the
    /// exemption is keyed on the service name, not on the exit code alone.
    #[test]
    fn long_running_service_exiting_zero_is_still_unhealthy() {
        let indexer = exited_status("explorer-indexer", 0);
        assert!(!is_completed_one_shot(&indexer));
        assert!(indexer.is_unhealthy());
    }

    #[test]
    fn reaper_keeps_current_run_and_marks_others_stale() {
        // `docker ps` label listing: <id>\t<run-id>\t<name>. CURRENT is the
        // active boot; PREVIOUS is a stranded run; the empty-run-id row is a
        // legacy container booted before run-id labels existed.
        let listing = "\
aaa111\tCURRENT\teth-execution
bbb222\tPREVIOUS\teth-execution
ccc333\t\teth-beacon
";
        let stale = stale_containers_from_listing(listing, "CURRENT");
        assert_eq!(
            stale,
            vec![
                ("bbb222".to_string(), "eth-execution".to_string()),
                ("ccc333".to_string(), "eth-beacon".to_string()),
            ],
            "previous-run and legacy (empty run-id) containers are stale; current run is kept"
        );
    }

    #[test]
    fn reaper_listing_tolerates_blank_lines_and_missing_columns() {
        let listing = "\n\nddd444\tOLD\n";
        // Missing name column -> name parses as empty string, still flagged stale.
        let stale = stale_containers_from_listing(listing, "CURRENT");
        assert_eq!(stale, vec![("ddd444".to_string(), String::new())]);
    }

    #[test]
    fn run_identity_is_stable_and_distinct_per_id() {
        // Two distinct ids never collide on the formatted prefix shape.
        let a = format!("{:016x}-{:x}", 1u64, 2u32);
        let b = format!("{:016x}-{:x}", 3u64, 2u32);
        assert_ne!(a, b);
        assert!(a.contains('-'));
    }

    #[test]
    fn receipt_status_succeeded_accepts_success_word() {
        // `cast send --json` reports a successful tx as status "0x1" (issue #904).
        assert!(receipt_status_succeeded("0x1"));
        assert!(receipt_status_succeeded("0X1"));
        // Robust to a non-canonical non-zero word.
        assert!(receipt_status_succeeded("0x01"));
    }

    #[test]
    fn receipt_status_succeeded_rejects_reverted_receipt() {
        // A reverted tx mines with status "0x0"; cast send still exits 0, so the
        // status word is the only signal that the tx reverted (issue #904).
        assert!(!receipt_status_succeeded("0x0"));
        assert!(!receipt_status_succeeded("0x00"));
        // A malformed/empty word must never be treated as success.
        assert!(!receipt_status_succeeded("0x"));
        assert!(!receipt_status_succeeded(""));
    }

    // -- issue #1241: cast_send nonce-pinning + retry/ambiguity policy ----

    #[test]
    fn classify_send_failure_treats_underpriced_replacement_as_safe_retry() {
        // The node refused the send outright — nothing entered the chain.
        let class = classify_send_failure(
            "Error: server returned an error response: error code -32000: replacement \
             transaction underpriced",
        );
        assert_eq!(class, SendFailureClass::SafeRetry);
    }

    #[test]
    fn classify_send_failure_treats_already_known_and_nonce_too_low_as_ambiguous() {
        // Both mean the write may already have landed; neither is safe to
        // resolve by re-sending (issue #1241 AC).
        assert_eq!(
            classify_send_failure(
                "Error: server returned an error response: error code -32000: already known"
            ),
            SendFailureClass::Ambiguous
        );
        assert_eq!(
            classify_send_failure(
                "Error: server returned an error response: error code -32003: nonce too low"
            ),
            SendFailureClass::Ambiguous
        );
    }

    #[test]
    fn classify_send_failure_treats_unrecognised_errors_as_hard() {
        assert_eq!(
            classify_send_failure("Error: insufficient funds for gas * price + value"),
            SendFailureClass::Hard
        );
    }

    #[test]
    fn retry_policy_retries_a_node_rejected_send_and_never_consults_receipt_lookup() {
        // A `SafeRetry` classification means nothing entered the chain, so
        // the policy must call `attempt` again — and must NOT touch
        // `lookup_receipt` at all, since there is nothing ambiguous to
        // resolve.
        let attempts = std::cell::Cell::new(0u32);
        let lookups = std::cell::Cell::new(0u32);
        let result = run_cast_send_retry(
            4,
            |_n| {
                attempts.set(attempts.get() + 1);
                if attempts.get() < 3 {
                    SendAttemptOutcome::Failed(
                        SendFailureClass::SafeRetry,
                        "replacement transaction underpriced".to_string(),
                    )
                } else {
                    SendAttemptOutcome::Mined(serde_json::json!({
                        "transactionHash": "0xabc",
                        "status": "0x1",
                    }))
                }
            },
            || {
                lookups.set(lookups.get() + 1);
                panic!("lookup_receipt must never be called for a SafeRetry outcome");
            },
        );
        assert_eq!(
            attempts.get(),
            3,
            "the rejected send must be retried until it lands"
        );
        assert_eq!(lookups.get(), 0);
        assert_eq!(
            result.expect("retry should eventually succeed")["transactionHash"],
            "0xabc"
        );
    }

    #[test]
    fn retry_policy_resolves_ambiguous_outcome_by_receipt_lookup_not_resend() {
        // `already known` / `nonce too low` must resolve via a receipt
        // lookup, and `attempt` must be called EXACTLY ONCE — a second call
        // would be a re-send, which for a write like `deposit` would be a
        // double-deposit. This is the double-deposit-impossible-by-
        // construction guarantee from the issue #1241 AC.
        for ambiguous_stderr in ["already known", "nonce too low"] {
            let attempts = std::cell::Cell::new(0u32);
            let lookups = std::cell::Cell::new(0u32);
            let result = run_cast_send_retry(
                4,
                |_n| {
                    attempts.set(attempts.get() + 1);
                    SendAttemptOutcome::Failed(
                        classify_send_failure(ambiguous_stderr),
                        ambiguous_stderr.to_string(),
                    )
                },
                || {
                    lookups.set(lookups.get() + 1);
                    Ok(serde_json::json!({
                        "transactionHash": "0xresolved",
                        "status": "0x1",
                    }))
                },
            );
            assert_eq!(
                attempts.get(),
                1,
                "an ambiguous outcome for {ambiguous_stderr:?} must never trigger a re-send"
            );
            assert_eq!(
                lookups.get(),
                1,
                "exactly one receipt lookup resolves the ambiguity"
            );
            assert_eq!(
                result.expect("ambiguous outcome resolves via the receipt lookup")
                    ["transactionHash"],
                "0xresolved"
            );
        }
    }

    #[test]
    fn retry_policy_propagates_hard_errors_without_retry_or_lookup() {
        let attempts = std::cell::Cell::new(0u32);
        let result = run_cast_send_retry(
            4,
            |_n| {
                attempts.set(attempts.get() + 1);
                SendAttemptOutcome::Failed(SendFailureClass::Hard, "insufficient funds".to_string())
            },
            || panic!("lookup_receipt must never be called for a Hard outcome"),
        );
        assert_eq!(attempts.get(), 1);
        assert!(result.is_err());
    }

    #[test]
    fn retry_policy_errors_when_the_safe_retry_budget_is_exhausted() {
        // Exhausting the retry budget on a persistently rejected send must
        // fail loudly, not silently return a bogus success.
        let result = run_cast_send_retry(
            3,
            |_n| {
                SendAttemptOutcome::Failed(
                    SendFailureClass::SafeRetry,
                    "replacement transaction underpriced".to_string(),
                )
            },
            || panic!("lookup_receipt must never be called for a SafeRetry outcome"),
        );
        assert!(result.is_err());
    }

    #[test]
    fn parse_hex_rpc_result_parses_quoted_hex_quantity() {
        assert_eq!(parse_hex_rpc_result(b"\"0x1a\"", "test").unwrap(), 26);
        assert_eq!(parse_hex_rpc_result(b"\"0x0\"\n", "test").unwrap(), 0);
    }

    #[test]
    fn parse_hex_rpc_result_rejects_non_hex_payload() {
        assert!(parse_hex_rpc_result(b"not-hex", "test").is_err());
    }

    // -- issue #1374: the funding-path nonce race ------------------------
    //
    // The production symptom is geth answering a funding `cast send` with
    // `-32000: replacement transaction underpriced` during fixture bring-up,
    // which panics the test before it asserts anything. Its cause is two
    // same-account sends being handed the SAME nonce, and that is what these
    // tests pin down — the nonce-issuance decision and its serialisation,
    // both exercisable without Docker or a chain.

    const FUNDING_SENDER: &str = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

    #[test]
    fn next_pinned_nonce_never_repeats_a_nonce_the_node_has_not_absorbed_yet() {
        // THE RACE, reduced to one decision. geth's `pending` count does not
        // include a send it has not seen yet, so a second send issued moments
        // after the first reads the SAME count. Trusting that count verbatim
        // (`nonce = pending`) hands out nonce 7 twice -> the node rejects the
        // second with `replacement transaction underpriced`.
        assert_eq!(next_pinned_nonce(Some(7), 7), 8);
        // Still true when the node has regressed further behind.
        assert_eq!(next_pinned_nonce(Some(9), 7), 10);
    }

    #[test]
    fn next_pinned_nonce_defers_to_the_node_when_it_has_moved_ahead() {
        // First send from this address: the harness has no opinion yet, so
        // the node's count is the only truth available.
        assert_eq!(next_pinned_nonce(None, 4), 4);
        // A send this harness did not issue (a forge script broadcasting from
        // the deployer, say) pushed the count past our last pin — take the
        // node's number, never a stale `prev + 1` that would collide with it.
        assert_eq!(next_pinned_nonce(Some(4), 9), 9);
    }

    #[test]
    fn concurrent_pins_never_hand_out_a_colliding_nonce() {
        // Reproduces the race at its source. boot-time funding runs on
        // two scoped threads and `DappStack::boot` funds while the fixture is
        // live, so concurrent pins for one sender are a real shape here.
        //
        // The fake node is a LAGGING one: it always reports the same
        // `pending` count, exactly as geth does for sends it has not absorbed
        // yet, and sleeps to widen the window. Before the fix
        // `pin_next_nonce` released the map lock around this read, so all
        // eight threads observed the same `prev`, read the same count, and
        // pinned the same nonce — seven of the eight sends would have come
        // back `replacement transaction underpriced`. This assertion is red
        // on that code and green once the lock spans the read.
        const THREADS: usize = 8;
        const STALE_PENDING: u64 = 11;
        let tracker = NonceTracker::new("http://unused.invalid");
        let pinned: Vec<u64> = thread::scope(|s| {
            let handles: Vec<_> = (0..THREADS)
                .map(|_| {
                    let tracker = &tracker;
                    s.spawn(move || {
                        tracker
                            .pin_next_nonce_with(FUNDING_SENDER, |_| {
                                thread::sleep(Duration::from_millis(20));
                                Ok(STALE_PENDING)
                            })
                            .expect("pin_next_nonce_with")
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|h| h.join().expect("pin thread panicked"))
                .collect()
        });

        let mut sorted = pinned.clone();
        sorted.sort_unstable();
        let expected: Vec<u64> = (0..THREADS as u64).map(|i| STALE_PENDING + i).collect();
        assert_eq!(
            sorted, expected,
            "concurrent pins for one sender must be distinct and contiguous; got {pinned:?} — a \
             repeated nonce here IS the `replacement transaction underpriced` failure"
        );
    }

    #[test]
    fn pins_are_scoped_per_sender_address() {
        // Two different faucet keys must not consume one another's sequence:
        // the deployer and the USDC holder both fund, concurrently.
        let tracker = NonceTracker::new("http://unused.invalid");
        let other = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
        let a1 = tracker
            .pin_next_nonce_with(FUNDING_SENDER, |_| Ok(3))
            .unwrap();
        let b1 = tracker.pin_next_nonce_with(other, |_| Ok(3)).unwrap();
        let a2 = tracker
            .pin_next_nonce_with(FUNDING_SENDER, |_| Ok(3))
            .unwrap();
        assert_eq!((a1, b1, a2), (3, 3, 4));
        // Address case must not fork a sender into two sequences.
        let a3 = tracker
            .pin_next_nonce_with(&FUNDING_SENDER.to_lowercase(), |_| Ok(3))
            .unwrap();
        assert_eq!(a3, 5);
    }

    #[test]
    fn a_failed_send_hands_its_unused_nonce_back_for_the_next_one() {
        // A hard funding failure (unfunded faucet) leaves its pinned nonce
        // unconsumed. Because pins are monotonic, keeping it would make every
        // later send from that address pin past a gap and sit in the mempool
        // forever — one loud failure turning into a silent hang.
        let tracker = NonceTracker::new("http://unused.invalid");
        let pinned = tracker
            .pin_next_nonce_with(FUNDING_SENDER, |_| Ok(5))
            .unwrap();
        assert_eq!(pinned, 5);
        // Node still reports 5 pending: nothing consumed it.
        tracker.release_pin_if_unused_with(FUNDING_SENDER, pinned, |_| Ok(5));
        let reused = tracker
            .pin_next_nonce_with(FUNDING_SENDER, |_| Ok(5))
            .unwrap();
        assert_eq!(reused, 5, "the next send must reuse the unspent nonce");
    }

    #[test]
    fn a_send_that_did_land_keeps_its_nonce_pinned() {
        // The mirror case: the send failed from cast's point of view but the
        // node already absorbed it. Rewinding here would re-issue a nonce
        // that is already spoken for — which is precisely the `replacement
        // transaction underpriced` collision this issue exists to remove.
        let tracker = NonceTracker::new("http://unused.invalid");
        let pinned = tracker
            .pin_next_nonce_with(FUNDING_SENDER, |_| Ok(5))
            .unwrap();
        tracker.release_pin_if_unused_with(FUNDING_SENDER, pinned, |_| Ok(6));
        let next = tracker
            .pin_next_nonce_with(FUNDING_SENDER, |_| Ok(6))
            .unwrap();
        assert_eq!(next, 6, "a consumed nonce must never be handed out twice");
    }

    #[test]
    fn a_genuine_funding_failure_is_not_retried_and_stays_distinguishable() {
        // AC: an unfunded faucet must still fail LOUDLY, and must not be
        // mistaken for (or retried like) the nonce race. `insufficient funds`
        // classifies Hard, so the first attempt's message propagates verbatim
        // and `attempt` is never called again — the failure cannot be retried
        // into silence.
        let calls = std::cell::Cell::new(0u32);
        let err = run_cast_send_retry(
            4,
            |_| {
                calls.set(calls.get() + 1);
                SendAttemptOutcome::Failed(
                    SendFailureClass::Hard,
                    "fund eth failed: stdout= stderr=server returned an error response: error \
                     code -32000: insufficient funds for gas * price + value"
                        .to_string(),
                )
            },
            || panic!("a hard funding failure must never be resolved by receipt lookup"),
        )
        .expect_err("an unfunded faucet must surface as an error");
        assert_eq!(calls.get(), 1, "a hard funding failure must not be retried");
        let text = err.to_string();
        assert!(
            text.contains("fund eth failed") && text.contains("insufficient funds"),
            "the funding label and the node's reason must both survive: {text}"
        );
        assert!(
            !text.contains("replacement transaction underpriced"),
            "a genuine funding failure must not read as the nonce race: {text}"
        );
    }
}
