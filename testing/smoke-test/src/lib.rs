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

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use alloy_primitives::{keccak256, Address};
use serde::Deserialize;
use tempfile::TempDir;

// -- Genesis account constants ----------------------------------------

/// Genesis-funded deployer / admin. Used as `--from` for `forge script`
/// and for admin-role on-chain pokes (revoke/reauthorize, unpause).
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

// -- Fixture ----------------------------------------------------------

/// A fully-wired devnet fixture. Boot by calling [`Fixture::new`];
/// Drop tears down the Docker Compose stack.
pub struct Fixture {
    compose_dir: PathBuf,
    /// Tempdir for harness artifacts (deployment JSON, etc.).
    /// Exposed via [`Fixture::tempdir`] so callers can write
    /// additional files (keystores, configs) into the same directory.
    tmp: TempDir,
    chain_ports: ChainPorts,
    rpc_port: u16,
    rpc_url: String,
    chain_id: u64,
    deployment: DeploymentJson,
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
    fn allocate() -> Result<Self, HarnessError> {
        let mut used = HashSet::new();
        Ok(Self {
            rpc_port: allocate_unique_port(&mut used)?,
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
    fn allocate(dapp_port: Option<u16>, occupied_ports: &[u16]) -> Result<Self, HarnessError> {
        let mut used = occupied_ports.iter().copied().collect::<HashSet<_>>();
        let dapp_port = match dapp_port {
            Some(port) => reserve_port(&mut used, port, "dapp")?,
            None => allocate_unique_port(&mut used)?,
        };
        let postgres_port = allocate_unique_port(&mut used)?;
        let explorer_api_port = allocate_unique_port(&mut used)?;

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
        let cleanup = || {
            let _ = Command::new("docker")
                .args([
                    "compose",
                    "-f",
                    "docker-compose.yaml",
                    "down",
                    "-v",
                    "--remove-orphans",
                ])
                .current_dir(&compose_dir)
                .status();
        };

        let status = Command::new("docker")
            .arg("compose")
            .arg("-f")
            .arg("docker-compose.yaml")
            .arg("up")
            .arg("-d")
            .arg("--build")
            .env("GETH_RPC_PORT", chain_ports.rpc_port.to_string())
            .env("GETH_WS_PORT", chain_ports.ws_port.to_string())
            .env("GETH_AUTHRPC_PORT", chain_ports.authrpc_port.to_string())
            .env("BEACON_PORT", chain_ports.beacon_port.to_string())
            .current_dir(&compose_dir)
            .status()
            .map_err(HarnessError::from)?;
        if !status.success() {
            cleanup();
            return Err(HarnessError::Docker(format!(
                "compose up devnet failed: {status:?}"
            )));
        }

        eprintln!("smoke-test: waiting for chain containers to become ready...");
        wait_for_rpc(&rpc_url, Duration::from_secs(180))?;

        // Wait for real block production: RPC up != consensus up.
        wait_for_block_height(&rpc_url, 1, Duration::from_secs(240)).inspect_err(|_| {
            let _ = Command::new("docker")
                .args(["compose", "down", "-v", "--remove-orphans"])
                .current_dir(&compose_dir)
                .status();
        })?;

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
        .inspect_err(|_| {
            let _ = Command::new("docker")
                .args(["compose", "down", "-v", "--remove-orphans"])
                .current_dir(&compose_dir)
                .status();
        })?;

        let deployment = read_deployment(&dep_out)?;
        let chain_id = deployment.chain_id;

        fund_eth_from_deployer(&rpc_url, &agent_hex, "1000000000000000000")?;
        fund_eth_from_deployer(&rpc_url, PAUSER_ADDRESS_HEX, "1000000000000000000")?;

        Ok(Fixture {
            compose_dir,
            tmp,
            chain_ports,
            rpc_port: chain_ports.rpc_port,
            rpc_url,
            chain_id,
            deployment,
            repo_root,
        })
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
        let policy = format!(
            "(true,18446744073709551615,{max_per_payment},{max_per_window},{share_receiver})"
        );
        self.cast_send(
            DEPLOYER_PRIVATE_KEY_HEX,
            self.gateway(),
            "authorizeAgent(address,(bool,uint64,uint256,uint256,address))",
            &[&agent, &policy],
        )
    }

    /// Mint mock USDC to `recipient` via `MockUSDC.mint`.
    pub fn fund_usdc(&self, recipient: Address, amount: u128) -> Result<String, HarnessError> {
        let usdc = format!("{:#x}", self.usdc());
        let recipient_hex = format!("{recipient:#x}");
        let amount_str = amount.to_string();
        let out = Command::new("cast")
            .args([
                "send",
                "--rpc-url",
                &self.rpc_url,
                "--private-key",
                DEPLOYER_PRIVATE_KEY_HEX,
                &usdc,
                "mint(address,uint256)",
                &recipient_hex,
                &amount_str,
                "--json",
            ])
            .output()?;
        if !out.status.success() {
            return Err(HarnessError::other(format!(
                "cast send mint failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }
        let v: serde_json::Value = serde_json::from_slice(&out.stdout)
            .map_err(|e| HarnessError::other(format!("cast send mint json: {e}")))?;
        Ok(v.get("transactionHash")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
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
    }
}

// -- Public helpers ---------------------------------------------------

/// Returns `true` iff `docker`, `forge`, and `cast` are all on PATH.
pub fn prerequisites_available() -> bool {
    which::which("docker").is_ok() && which::which("forge").is_ok() && which::which("cast").is_ok()
}

// -- Internal helpers -------------------------------------------------

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

fn wait_for_rpc(url: &str, timeout: Duration) -> Result<(), HarnessError> {
    test_utils::wait_for_rpc(url, timeout).map_err(|_| HarnessError::RpcTimeout {
        url: url.to_string(),
        timeout,
    })
}

fn wait_for_block_height(url: &str, target: u64, timeout: Duration) -> Result<(), HarnessError> {
    test_utils::wait_for_block_height(url, target, timeout).map_err(|_| HarnessError::RpcTimeout {
        url: url.to_string(),
        timeout,
    })
}

fn fund_eth_from_deployer(
    rpc_url: &str,
    recipient_hex: &str,
    value_wei: &str,
) -> Result<String, HarnessError> {
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
        .env("DEPLOYMENT_OUT", dep_out)
        .current_dir(repo_root);
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let out = cmd.output()?;
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

/// Walk up from the crate manifest dir until we find the repo root
/// (identified by `foundry.toml` + `clients/rust-payment-client`).
pub fn locate_repo_root() -> Result<PathBuf, HarnessError> {
    test_utils::find_workspace_root()
        .ok_or_else(|| HarnessError::other("could not locate repo root from CARGO_MANIFEST_DIR"))
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
    pub endpoints: DappEndpoints,
}

impl DappStack {
    /// Build and start the dapp compose stack, injecting the deployed
    /// contract addresses as build args. Waits for the dapp and
    /// explorer-api health checks to pass before returning.
    ///
    /// `gateway_hex` and `vault_hex` are the checksummed hex addresses
    /// returned by [`Fixture::gateway_hex`] and [`Fixture::vault_hex`].
    pub fn boot(fixture: &Fixture, dapp_port: Option<u16>) -> Result<Self, HarnessError> {
        let compose_dir = fixture.repo_root().join("testing/ethereum-testnet/config");
        let gateway_hex = fixture.gateway_hex();
        let vault_hex = fixture.vault_hex();
        let gateway_runtime_hash = fixture.gateway_runtime_hash().to_string();
        let ports = DappPorts::allocate(dapp_port, &fixture.occupied_ports())?;
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
                .current_dir(&cleanup_compose_dir)
                .status();
        };

        let dapp_url = ports.dapp_url();
        let explorer_api_url = ports.explorer_api_url();
        let rpc_url = fixture.rpc_url().to_string();

        eprintln!("smoke-test: building and starting dapp stack (this may take several minutes for first build)...");

        let status = Command::new("docker")
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
            .env("INDEXER_GATEWAY", gateway_hex)
            .env("INDEXER_VAULT", vault_hex)
            // RPC is on the host; containers reach it via host.docker.internal
            .env(
                "INDEXER_RPC_URL",
                format!("http://host.docker.internal:{}", fixture.rpc_port()),
            )
            .env("VITE_FORK_RPC_URL", fixture.rpc_url())
            .env("VITE_EXPLORER_API_URL", &explorer_api_url)
            .env("VITE_DAPP_URL", &dapp_url)
            .env("INDEXER_CHAIN_ID", "32382")
            .env("INDEXER_CHAIN_NAME", "devnet")
            .env("EXPLORER_API_CHAIN_ID", "32382")
            .current_dir(&compose_dir)
            .status()
            .map_err(HarnessError::from)?;

        if !status.success() {
            cleanup();
            return Err(HarnessError::Docker(
                "compose up dapp stack failed".to_string(),
            ));
        }

        eprintln!("smoke-test: waiting for dapp containers to become ready...");
        // Wait for explorer-api /health endpoint
        wait_for_http_ok(
            &format!("{explorer_api_url}/health"),
            Duration::from_secs(300),
        )
        .inspect_err(|_| cleanup())?;
        // Wait for dapp frontend
        wait_for_http_ok(&dapp_url, Duration::from_secs(300)).inspect_err(|_| cleanup())?;

        Ok(DappStack {
            compose_dir,
            gateway_hex: gateway_hex.to_string(),
            vault_hex: vault_hex.to_string(),
            gateway_runtime_hash,
            endpoints: DappEndpoints {
                rpc_url,
                dapp_url,
                explorer_api_url,
            },
        })
    }
}

impl Drop for DappStack {
    fn drop(&mut self) {
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
    }
}

/// Poll `url` with HTTP GET until a 2xx response is received or
/// `timeout` elapses. Used to wait for explorer-api and dapp health.
fn wait_for_http_ok(url: &str, timeout: Duration) -> Result<(), HarnessError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| HarnessError::other(format!("reqwest builder: {e}")))?;
    let deadline = std::time::Instant::now() + timeout;
    let mut last = String::new();
    while std::time::Instant::now() < deadline {
        match client.get(url).send() {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            Ok(resp) => last = format!("HTTP {}", resp.status()),
            Err(e) => last = format!("{e}"),
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    Err(HarnessError::other(format!(
        "service at {url} not healthy after {timeout:?}: {last}"
    )))
}
