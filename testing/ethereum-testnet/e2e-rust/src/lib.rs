//! End-to-end test harness for `rmpd` (Rust payment daemon).
//!
//! Issue #17 / `docs/implementation-plan-mvp.md` §4.
//!
//! Two flavors:
//!
//! - [`Fixture::anvil`] — spawns a fresh `anvil` child process, deploys
//!   the gateway stack via `forge script contracts/script/Deploy.s.sol`,
//!   and prepares a per-test keystore + config TOML pointing at it. Fast
//!   (sub-second blocks), used for logic-only scenarios.
//! - [`Fixture::geth`] — boots the existing
//!   `testing/ethereum-testnet/config/docker-compose.yaml` Geth +
//!   Lighthouse stack plus the `docker-compose.deployer.yaml` overlay.
//!   Slower (12-second block cadence), used for real-chain semantics.
//!   Gated behind `RMPD_E2E_GETH=1` so plain `cargo test` doesn't
//!   require Docker.
//!
//! Both flavors expose the same [`Fixture`] surface:
//!
//! - Deployed addresses ([`Fixture::gateway`], [`Fixture::usdc`],
//!   [`Fixture::vault`], [`Fixture::agent`]).
//! - The RPC URL ([`Fixture::rpc_url`]) and chain id
//!   ([`Fixture::chain_id`]).
//! - Subprocess helpers wrapping the `rmpd` binary
//!   ([`Fixture::run_rmpd_self_check`], [`Fixture::run_rmpd_status`],
//!   [`Fixture::run_rmpd_deposit`]).
//! - Anvil-only helpers ([`Fixture::evm_snapshot`],
//!   [`Fixture::evm_revert`], [`Fixture::anvil_set_next_base_fee`])
//!   that no-op or panic when invoked on a Geth fixture.
//!
//! The harness owns its tempdir and child processes; dropping the
//! [`Fixture`] tears everything down.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use alloy_primitives::{keccak256, Address};
use once_cell::sync::Lazy;
use serde::Deserialize;
use tempfile::TempDir;

pub use rust_payment_daemon::signer::software::PASSPHRASE_ENV_VAR;

const TEST_PASSPHRASE: &str = "rmpd-e2e-passphrase";

/// 32-byte secp256k1 private key for the test agent EOA. Test-only —
/// shared with the docker harness fixtures; never use on a real chain.
/// The matching address is computed at runtime via
/// [`agent_address`] (it is *not* the `0xFABB…` address listed in
/// `typescript-sdk/src/index.ts`; that constant is incorrect for this
/// privkey, see `cast wallet address`).
pub const AGENT_PRIVATE_KEY: [u8; 32] = [
    0xab, 0x63, 0xb2, 0x3e, 0xb7, 0x94, 0x1c, 0x12, 0x51, 0x75, 0x7e, 0x24, 0xb3, 0xd2, 0x35, 0x0d,
    0x2b, 0xc0, 0x5c, 0x3c, 0x38, 0x8d, 0x06, 0xf8, 0xfe, 0x6f, 0xea, 0xfe, 0xfb, 0x1e, 0x8c, 0x70,
];

/// Derive the agent EOA address from [`AGENT_PRIVATE_KEY`]. Computed
/// lazily so the harness stays a single source of truth — the deploy
/// script's `AGENT_ADDRESS` env, the keystore's address, and the
/// rmpd config all flow from this one helper.
pub fn agent_address() -> Address {
    use k256::ecdsa::SigningKey;
    let sk = SigningKey::from_bytes((&AGENT_PRIVATE_KEY).into())
        .expect("static AGENT_PRIVATE_KEY is valid");
    let vk = sk.verifying_key();
    let pubkey = vk.to_encoded_point(/* compress = */ false);
    // `pubkey.as_bytes()` is the SEC1 uncompressed form: 0x04 || X || Y.
    let hash = keccak256(&pubkey.as_bytes()[1..]);
    Address::from_slice(&hash[12..])
}

/// Genesis-funded deployer / admin from the docker harness. Used as
/// `--from` for `forge script` and as the Anvil-pre-funded sender.
pub const DEPLOYER_PRIVATE_KEY_HEX: &str =
    "0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31";
pub const DEPLOYER_ADDRESS_HEX: &str = "0x8943545177806ED17B9F23F0a21ee5948eCaa776";
pub const PAUSER_ADDRESS_HEX: &str = "0x71bE63f3384f5fb98995898A86B02Fb2426c5788";
pub const SHARE_RECEIVER_ADDRESS_HEX: &str = "0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec";

/// Errors raised by the harness itself. Failures from `rmpd`
/// subprocesses are reported via [`RmpdRun`] without converting to
/// [`HarnessError`] — callers want to assert on stdout/stderr/status.
#[derive(Debug, thiserror::Error)]
pub enum HarnessError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("foundry binary `{0}` not found on PATH; install via https://getfoundry.sh")]
    FoundryMissing(&'static str),
    #[error("RPC at {url} did not become healthy within {timeout:?}")]
    RpcTimeout { url: String, timeout: Duration },
    #[error("forge script failed: {0}")]
    DeployFailed(String),
    #[error("deployment JSON {0}: {1}")]
    DeploymentJson(PathBuf, String),
    #[error("rmpd binary not found at {0}")]
    RmpdBinaryMissing(PathBuf),
    #[error("cargo build of rmpd failed: {0}")]
    CargoBuildFailed(String),
    #[error("docker compose error: {0}")]
    Docker(String),
    #[error("{0}")]
    Other(String),
}

impl HarnessError {
    fn other<S: Into<String>>(s: S) -> Self {
        HarnessError::Other(s.into())
    }
}

/// Output of an `rmpd` subprocess invocation. UTF-8-decoded eagerly
/// since rmpd promises text output (JSON on stdout, log lines on
/// stderr).
#[derive(Debug)]
pub struct RmpdRun {
    pub status: std::process::ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

impl From<Output> for RmpdRun {
    fn from(o: Output) -> Self {
        Self {
            status: o.status,
            stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        }
    }
}

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

enum Backend {
    Anvil { child: Child },
    Geth { compose_dir: PathBuf },
}

/// Shared per-process artifacts: built `rmpd` binary path + the repo
/// root path. We build the binary once for the whole test run.
struct Shared {
    repo_root: PathBuf,
    rmpd_bin: PathBuf,
}

static SHARED: Lazy<Mutex<Option<Shared>>> = Lazy::new(|| Mutex::new(None));

/// A fully-wired test fixture. Drop tears down the backend.
pub struct Fixture {
    backend: Backend,
    /// Tempdir owning `keystore.json` + `rmpd.toml` + `state/`.
    /// Drop-order: must outlive the child process so any post-drop
    /// log inspection still works.
    tmp: TempDir,
    rpc_url: String,
    chain_id: u64,
    deployment: DeploymentJson,
    keystore_path: PathBuf,
    config_path: PathBuf,
    state_dir: PathBuf,
    rmpd_bin: PathBuf,
    repo_root: PathBuf,
}

impl Fixture {
    // ---- constructors ----------------------------------------------------

    /// Boot a fresh Anvil instance, deploy the gateway stack, and
    /// prepare a keystore + config TOML for `rmpd` invocations.
    pub fn anvil() -> Result<Self, HarnessError> {
        if which::which("anvil").is_err() {
            return Err(HarnessError::FoundryMissing("anvil"));
        }
        if which::which("forge").is_err() {
            return Err(HarnessError::FoundryMissing("forge"));
        }

        let shared = ensure_rmpd_built()?;
        let tmp = TempDir::new()?;

        let port = pick_free_port()?;
        let rpc_url = format!("http://127.0.0.1:{port}");

        // 31337 is Anvil's default chain id; keep it to match the
        // hardcoded testnet expectations.
        let chain_id: u64 = 31337;

        // Spawn anvil. We seed an account with the deployer privkey by
        // passing `--mnemonic-derivation-path` is overkill — instead use
        // `--accounts` + `--balance` to pre-fund N default Anvil accounts,
        // then send a one-shot `cast send` to top up our deployer
        // address. Simpler: use `--block-base-fee-per-gas 0` and have
        // the deployer fund itself by being one of the pre-funded
        // anvil accounts via `--mnemonic` "test test ... junk". But we
        // need the *specific* deployer EOA so the deploy script's role
        // separation lines up. Do it via `--account 0xdeployerpk:bal`
        // is not supported. The clean path: tell anvil to fund the
        // deployer with `--genesis` is also not exposed.
        //
        // Workaround: pass `--accounts 0` and use the
        // `--cache-path` + `--auto-impersonate` combination to
        // skip-sign as the deployer. Simpler still: the JSON-RPC
        // method `anvil_setBalance` lets us fund any address after
        // boot. So: spawn anvil with default accounts (which gives us
        // funded EOAs we don't actually use), then RPC `anvil_setBalance`
        // for the four addresses the deploy script expects.
        // Pipe to null — we don't drain anvil's stdout, and a piped
        // pipe will eventually backpressure-stall the child.
        let stdout = Stdio::null();
        let stderr = Stdio::null();
        let mut cmd = Command::new("anvil");
        // Instant-mine on tx is the Anvil default — leave --block-time
        // unset rather than pass 0 (which the CLI rejects).
        cmd.arg("--port")
            .arg(port.to_string())
            .arg("--chain-id")
            .arg(chain_id.to_string())
            .stdout(stdout)
            .stderr(stderr);
        let child = cmd.spawn().map_err(HarnessError::from)?;
        let backend = Backend::Anvil { child };

        // Park the child even on early-error paths.
        let mut fx_partial = PartialAnvil {
            backend: Some(backend),
        };

        wait_for_rpc(&rpc_url, Duration::from_secs(20))?;

        // Pre-fund the role addresses so the deploy script can broadcast.
        let funder = AnvilRpc::new(&rpc_url);
        let agent_hex = format!("{:#x}", agent_address());
        for addr in [
            DEPLOYER_ADDRESS_HEX.to_string(),
            PAUSER_ADDRESS_HEX.to_string(),
            agent_hex.clone(),
            SHARE_RECEIVER_ADDRESS_HEX.to_string(),
        ] {
            funder.set_balance(&addr, "0xde0b6b3a7640000000")?; // 1000 ETH
        }

        // Run the deploy script with DEPLOYMENT_OUT pointing at the
        // tmp dir so we don't pollute the repo's deployments/ folder.
        let dep_out = tmp.path().join("deployment.json");
        run_forge_deploy(&shared.repo_root, &rpc_url, &dep_out, &agent_hex)?;

        let deployment = read_deployment(&dep_out)?;
        if deployment.chain_id != chain_id {
            return Err(HarnessError::DeploymentJson(
                dep_out,
                format!(
                    "chain_id mismatch: deployment={}, anvil={}",
                    deployment.chain_id, chain_id
                ),
            ));
        }

        let (keystore_path, config_path, state_dir) =
            write_keystore_and_config(tmp.path(), &rpc_url, &deployment)?;

        let backend = fx_partial.take();
        Ok(Fixture {
            backend,
            tmp,
            rpc_url,
            chain_id,
            deployment,
            keystore_path,
            config_path,
            state_dir,
            rmpd_bin: shared.rmpd_bin,
            repo_root: shared.repo_root,
        })
    }

    /// Boot the Docker Geth+Lighthouse devnet, run the gateway
    /// deployer overlay, and prepare a keystore + config TOML.
    ///
    /// Requires Docker on PATH; expects the
    /// `testing/ethereum-testnet/config/docker-compose.yaml` stack to
    /// be free to start (port 8545 unbound). Tears the stack down on
    /// drop.
    pub fn geth() -> Result<Self, HarnessError> {
        if which::which("docker").is_err() {
            return Err(HarnessError::FoundryMissing("docker"));
        }
        let shared = ensure_rmpd_built()?;
        let tmp = TempDir::new()?;
        let compose_dir = shared.repo_root.join("testing/ethereum-testnet/config");
        let rpc_url = "http://127.0.0.1:8545".to_string();

        // Start the stack + run the deployer overlay one-shot. The
        // deployer writes /repo/deployments/devnet.json, which on the
        // host is `<repo_root>/deployments/devnet.json`.
        let status = Command::new("docker")
            .arg("compose")
            .arg("-f")
            .arg("docker-compose.yaml")
            .arg("-f")
            .arg("docker-compose.deployer.yaml")
            .arg("up")
            .arg("-d")
            .arg("geth")
            .arg("lighthouse")
            .current_dir(&compose_dir)
            .status()
            .map_err(HarnessError::from)?;
        if !status.success() {
            return Err(HarnessError::Docker(format!(
                "compose up geth+lighthouse failed: {status:?}"
            )));
        }
        wait_for_rpc(&rpc_url, Duration::from_secs(120))?;

        let dep_status = Command::new("docker")
            .arg("compose")
            .arg("-f")
            .arg("docker-compose.yaml")
            .arg("-f")
            .arg("docker-compose.deployer.yaml")
            .arg("up")
            .arg("--abort-on-container-exit")
            .arg("gateway-deployer")
            .current_dir(&compose_dir)
            .status()
            .map_err(HarnessError::from)?;
        if !dep_status.success() {
            // Best-effort teardown.
            let _ = Command::new("docker")
                .args(["compose", "down", "-v", "--remove-orphans"])
                .current_dir(&compose_dir)
                .status();
            return Err(HarnessError::Docker(format!(
                "gateway-deployer failed: {dep_status:?}"
            )));
        }

        let dep_path = shared.repo_root.join("deployments/devnet.json");
        let deployment = read_deployment(&dep_path)?;
        let chain_id = deployment.chain_id;

        let (keystore_path, config_path, state_dir) =
            write_keystore_and_config(tmp.path(), &rpc_url, &deployment)?;

        Ok(Fixture {
            backend: Backend::Geth { compose_dir },
            tmp,
            rpc_url,
            chain_id,
            deployment,
            keystore_path,
            config_path,
            state_dir,
            rmpd_bin: shared.rmpd_bin,
            repo_root: shared.repo_root,
        })
    }

    // ---- accessors -------------------------------------------------------

    pub fn rpc_url(&self) -> &str {
        &self.rpc_url
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
    pub fn config_path(&self) -> &Path {
        &self.config_path
    }
    pub fn keystore_path(&self) -> &Path {
        &self.keystore_path
    }
    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }
    pub fn tempdir(&self) -> &Path {
        self.tmp.path()
    }
    pub fn repo_root(&self) -> &Path {
        &self.repo_root
    }
    pub fn rmpd_binary(&self) -> &Path {
        &self.rmpd_bin
    }
    pub fn passphrase(&self) -> &str {
        TEST_PASSPHRASE
    }

    // ---- rmpd subprocess helpers ----------------------------------------

    fn rmpd_command(&self) -> Command {
        let mut cmd = Command::new(&self.rmpd_bin);
        cmd.env(PASSPHRASE_ENV_VAR, TEST_PASSPHRASE)
            .env("RMPD_STATE_DIR", &self.state_dir);
        cmd
    }

    /// `rmpd self-check --config <cfg>` as a subprocess.
    pub fn run_rmpd_self_check(&self) -> Result<RmpdRun, HarnessError> {
        let out = self
            .rmpd_command()
            .args(["self-check", "--config"])
            .arg(&self.config_path)
            .output()?;
        Ok(out.into())
    }

    /// `rmpd status --config <cfg> --payment-id <id>` as a subprocess.
    pub fn run_rmpd_status(&self, payment_id: &str) -> Result<RmpdRun, HarnessError> {
        let out = self
            .rmpd_command()
            .args(["status", "--config"])
            .arg(&self.config_path)
            .args(["--payment-id", payment_id])
            .output()?;
        Ok(out.into())
    }

    /// `rmpd deposit --config <cfg> [args...]` as a subprocess.
    /// `extra` lets callers append `--amount`, `--order-id`, etc.
    pub fn run_rmpd_deposit<I, S>(&self, extra: I) -> Result<RmpdRun, HarnessError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut cmd = self.rmpd_command();
        cmd.args(["deposit", "--config"]).arg(&self.config_path);
        for a in extra {
            cmd.arg(a);
        }
        let out = cmd.output()?;
        Ok(out.into())
    }

    /// Run rmpd with arbitrary args + extra env, for ad-hoc tests
    /// (e.g. swapping the passphrase to verify startup-fail paths).
    pub fn run_rmpd_with<I, S>(
        &self,
        args: I,
        extra_env: HashMap<String, String>,
    ) -> Result<RmpdRun, HarnessError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut cmd = self.rmpd_command();
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
        for a in args {
            cmd.arg(a);
        }
        let out = cmd.output()?;
        Ok(out.into())
    }

    // ---- Anvil-only RPC pokes -------------------------------------------

    fn require_anvil(&self, op: &str) -> Result<(), HarnessError> {
        match self.backend {
            Backend::Anvil { .. } => Ok(()),
            Backend::Geth { .. } => Err(HarnessError::other(format!(
                "{op} requires the Anvil backend (Geth devnet has no anvil_*/evm_* RPCs)"
            ))),
        }
    }

    /// `evm_snapshot` — returns the snapshot id as a 0x-prefixed hex
    /// string. Anvil only.
    pub fn evm_snapshot(&self) -> Result<String, HarnessError> {
        self.require_anvil("evm_snapshot")?;
        AnvilRpc::new(&self.rpc_url).evm_snapshot()
    }

    /// `evm_revert` — revert chain state to a previous snapshot.
    /// Returns the boolean result. Anvil only.
    pub fn evm_revert(&self, snap: &str) -> Result<bool, HarnessError> {
        self.require_anvil("evm_revert")?;
        AnvilRpc::new(&self.rpc_url).evm_revert(snap)
    }

    /// `anvil_setNextBlockBaseFeePerGas` — used by the fee-cap test
    /// (#19). Anvil only.
    pub fn anvil_set_next_base_fee(&self, wei: u64) -> Result<(), HarnessError> {
        self.require_anvil("anvil_setNextBlockBaseFeePerGas")?;
        AnvilRpc::new(&self.rpc_url).set_next_base_fee(wei)
    }

    /// Mint mock USDC to `recipient`. Calls `MockUSDC.mint(addr, amount)`
    /// from the deployer (which has minter rights post-deploy). Returns
    /// the tx hash. Works against either backend.
    pub fn fund_usdc(&self, recipient: Address, amount: u128) -> Result<String, HarnessError> {
        // Use `cast send` to keep the harness implementation small.
        // The deployer key is pre-funded on both Anvil and Geth.
        if which::which("cast").is_err() {
            return Err(HarnessError::FoundryMissing("cast"));
        }
        let usdc = format!("{:#x}", self.usdc());
        let recipient = format!("{recipient:#x}");
        let amount = amount.to_string();
        let out = Command::new("cast")
            .args([
                "send",
                "--rpc-url",
                &self.rpc_url,
                "--private-key",
                DEPLOYER_PRIVATE_KEY_HEX,
                &usdc,
                "mint(address,uint256)",
                &recipient,
                &amount,
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
        match &mut self.backend {
            Backend::Anvil { child } => {
                let _ = child.kill();
                let _ = child.wait();
            }
            Backend::Geth { compose_dir } => {
                // Best-effort teardown. Don't panic in drop.
                let _ = Command::new("docker")
                    .args([
                        "compose",
                        "-f",
                        "docker-compose.yaml",
                        "-f",
                        "docker-compose.deployer.yaml",
                        "down",
                        "-v",
                        "--remove-orphans",
                    ])
                    .current_dir(compose_dir)
                    .status();
            }
        }
    }
}

// Helper wrapper that kills the spawned anvil if `anvil()` errors out
// before returning the Fixture.
struct PartialAnvil {
    backend: Option<Backend>,
}

impl PartialAnvil {
    fn take(&mut self) -> Backend {
        self.backend
            .take()
            .expect("PartialAnvil::take called twice")
    }
}

impl Drop for PartialAnvil {
    fn drop(&mut self) {
        if let Some(Backend::Anvil { mut child }) = self.backend.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// ----- internals ---------------------------------------------------------

fn parse_addr(s: &str) -> Address {
    s.parse::<Address>().unwrap_or(Address::ZERO)
}

fn pick_free_port() -> Result<u16, HarnessError> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn wait_for_rpc(url: &str, timeout: Duration) -> Result<(), HarnessError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| HarnessError::other(format!("reqwest builder: {e}")))?;
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_chainId",
        "params": []
    });
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(resp) = client.post(url).json(&body).send() {
            if resp.status().is_success() {
                if let Ok(j) = resp.json::<serde_json::Value>() {
                    if j.get("result").is_some() {
                        return Ok(());
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(HarnessError::RpcTimeout {
        url: url.to_string(),
        timeout,
    })
}

fn run_forge_deploy(
    repo_root: &Path,
    rpc_url: &str,
    dep_out: &Path,
    agent_address_hex: &str,
) -> Result<(), HarnessError> {
    let out = Command::new("forge")
        .args(["script", "contracts/script/Deploy.s.sol:Deploy"])
        .args(["--rpc-url", rpc_url])
        .args(["--private-key", DEPLOYER_PRIVATE_KEY_HEX])
        .arg("--broadcast")
        .arg("--slow")
        .arg("-vvv")
        .env("ADMIN_ADDRESS", DEPLOYER_ADDRESS_HEX)
        .env("PAUSER_ADDRESS", PAUSER_ADDRESS_HEX)
        .env("AGENT_ADDRESS", agent_address_hex)
        .env("SHARE_RECEIVER_ADDRESS", SHARE_RECEIVER_ADDRESS_HEX)
        .env("DEPLOYMENT_OUT", dep_out)
        .current_dir(repo_root)
        .output()?;
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

fn write_keystore_and_config(
    tmp: &Path,
    rpc_url: &str,
    dep: &DeploymentJson,
) -> Result<(PathBuf, PathBuf, PathBuf), HarnessError> {
    use rust_payment_daemon::signer::software::SoftwareSigner;

    let keystore_path = tmp.join("keystore.json");
    SoftwareSigner::create_keystore(
        &keystore_path,
        &AGENT_PRIVATE_KEY,
        TEST_PASSPHRASE.as_bytes(),
    )
    .map_err(|e| HarnessError::other(format!("create_keystore: {e}")))?;

    let state_dir = tmp.join("state");
    std::fs::create_dir_all(&state_dir)?;

    let config_path = tmp.join("rmpd.toml");
    let toml = format!(
        r#"chain_id              = {chain_id}
rpc_url               = "{rpc_url}"
gateway_address       = "{gateway}"
usdc_address          = "{usdc}"
vault_address         = "{vault}"
gateway_runtime_hash  = "{hash}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "{keystore}"
"#,
        chain_id = dep.chain_id,
        rpc_url = rpc_url,
        gateway = dep.gateway,
        usdc = dep.usdc,
        vault = dep.vault,
        hash = dep.gateway_runtime_hash,
        keystore = keystore_path.display(),
    );
    std::fs::write(&config_path, toml)?;

    Ok((keystore_path, config_path, state_dir))
}

/// Locate the repo root by walking up from the crate's manifest dir
/// until we hit a directory containing both `foundry.toml` and
/// `clients/rust-payment-daemon`.
fn locate_repo_root() -> Result<PathBuf, HarnessError> {
    let mut p: PathBuf = env!("CARGO_MANIFEST_DIR").into();
    for _ in 0..8 {
        if p.join("foundry.toml").exists() && p.join("clients/rust-payment-daemon").exists() {
            return Ok(p);
        }
        if !p.pop() {
            break;
        }
    }
    Err(HarnessError::other(
        "could not locate repo root from CARGO_MANIFEST_DIR",
    ))
}

/// Build the `rmpd` binary once (release) and cache the path.
fn ensure_rmpd_built() -> Result<Shared, HarnessError> {
    let mut guard = SHARED.lock().expect("SHARED mutex poisoned");
    if let Some(s) = guard.as_ref() {
        return Ok(Shared {
            repo_root: s.repo_root.clone(),
            rmpd_bin: s.rmpd_bin.clone(),
        });
    }
    let repo_root = locate_repo_root()?;

    // Build the binary in the rmpd crate's own target dir to avoid
    // contention with any outer cargo invocation. We deliberately use
    // a release build so subsequent test invocations are fast; the
    // first invocation pays the build cost once per `cargo test` run.
    let manifest = repo_root.join("clients/rust-payment-daemon/Cargo.toml");
    let target_dir = repo_root.join("target/e2e-rmpd");
    let out = Command::new("cargo")
        .args(["build", "--release", "--bin", "rmpd", "--manifest-path"])
        .arg(&manifest)
        .arg("--target-dir")
        .arg(&target_dir)
        .output()?;
    if !out.status.success() {
        return Err(HarnessError::CargoBuildFailed(format!(
            "stdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    let rmpd_bin = target_dir.join("release/rmpd");
    if !rmpd_bin.exists() {
        return Err(HarnessError::RmpdBinaryMissing(rmpd_bin));
    }
    *guard = Some(Shared {
        repo_root: repo_root.clone(),
        rmpd_bin: rmpd_bin.clone(),
    });
    Ok(Shared {
        repo_root,
        rmpd_bin,
    })
}

/// Returns `true` iff both `anvil` and `forge` are on PATH. Tests use
/// this to skip-on-missing rather than fail when Foundry isn't
/// installed locally.
pub fn foundry_available() -> bool {
    which::which("anvil").is_ok() && which::which("forge").is_ok()
}

/// Returns `true` iff `docker` is on PATH and the operator opted in
/// via `RMPD_E2E_GETH=1`.
pub fn geth_enabled() -> bool {
    std::env::var("RMPD_E2E_GETH").ok().as_deref() == Some("1") && which::which("docker").is_ok()
}

// ----- Anvil JSON-RPC helpers --------------------------------------------

struct AnvilRpc<'a> {
    url: &'a str,
    client: reqwest::blocking::Client,
}

impl<'a> AnvilRpc<'a> {
    fn new(url: &'a str) -> Self {
        Self {
            url,
            client: reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .expect("reqwest client"),
        }
    }

    fn rpc(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, HarnessError> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params
        });
        let resp = self
            .client
            .post(self.url)
            .json(&body)
            .send()
            .map_err(|e| HarnessError::other(format!("rpc {method}: {e}")))?;
        let j: serde_json::Value = resp
            .json()
            .map_err(|e| HarnessError::other(format!("rpc {method} body: {e}")))?;
        if let Some(err) = j.get("error") {
            return Err(HarnessError::other(format!("rpc {method} error: {err}")));
        }
        j.get("result")
            .cloned()
            .ok_or_else(|| HarnessError::other(format!("rpc {method}: no result")))
    }

    fn set_balance(&self, addr: &str, hex_wei: &str) -> Result<(), HarnessError> {
        self.rpc("anvil_setBalance", serde_json::json!([addr, hex_wei]))?;
        Ok(())
    }

    fn evm_snapshot(&self) -> Result<String, HarnessError> {
        let v = self.rpc("evm_snapshot", serde_json::json!([]))?;
        v.as_str()
            .map(str::to_owned)
            .ok_or_else(|| HarnessError::other("evm_snapshot: non-string result"))
    }

    fn evm_revert(&self, snap: &str) -> Result<bool, HarnessError> {
        let v = self.rpc("evm_revert", serde_json::json!([snap]))?;
        Ok(v.as_bool().unwrap_or(false))
    }

    fn set_next_base_fee(&self, wei: u64) -> Result<(), HarnessError> {
        let hex = format!("0x{wei:x}");
        self.rpc("anvil_setNextBlockBaseFeePerGas", serde_json::json!([hex]))?;
        Ok(())
    }
}
