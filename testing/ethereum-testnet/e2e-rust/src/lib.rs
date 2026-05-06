//! Canonical: docs/implementation-plan.md §5 — Phase 1 End-to-end test plan (harness)
//!
//! End-to-end test harness for `rmpc` (Rust payment daemon).
//!
//! Issue #17 (scaffold), #18/#19 (scenarios), #37 (consolidation onto
//! Geth+Lighthouse only).
//!
//! Single backend: boots the
//! `testing/ethereum-testnet/config/docker-compose.yaml` Geth +
//! Lighthouse stack from the host and runs `forge script` against it
//! with overridable env so the deployed gateway matches the addresses
//! the harness owns. Rationale for dropping the prior Anvil flavor: the
//! project is not optimizing for fast feedback (#37), and parallel
//! Anvil/Geth coverage was net cost — duplicate scenarios, two harness
//! shapes, and impersonation paths that diverge from real-chain
//! semantics.
//!
//! [`Fixture`] surface:
//!
//! - Deployed addresses ([`Fixture::gateway`], [`Fixture::usdc`],
//!   [`Fixture::vault`], [`Fixture::agent`]).
//! - The RPC URL ([`Fixture::rpc_url`]) and chain id
//!   ([`Fixture::chain_id`]).
//! - Subprocess helpers wrapping the `rmpc` binary
//!   ([`Fixture::run_rmpc_self_check`], [`Fixture::run_rmpc_status`],
//!   [`Fixture::run_rmpc_deposit`]).
//! - On-chain state pokes ([`Fixture::pause_gateway`],
//!   [`Fixture::unpause_gateway`], [`Fixture::revoke_agent`],
//!   [`Fixture::reauthorize_agent`]) signed with real harness keys —
//!   no `anvil_impersonateAccount`.
//!
//! The harness owns its tempdir and the docker-compose stack; dropping
//! the [`Fixture`] tears the stack down.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use alloy_primitives::{keccak256, Address};
use once_cell::sync::Lazy;
use serde::Deserialize;
use tempfile::TempDir;

pub use rust_payment_client::signer::software::PASSPHRASE_ENV_VAR;

const TEST_PASSPHRASE: &str = "rmpc-e2e-passphrase";

/// 32-byte secp256k1 private key for the test agent EOA. Test-only —
/// shared with the docker harness fixtures; never use on a real chain.
/// The matching address is computed at runtime via [`agent_address`].
/// Note: this key derives `0xf93Ee4Cf8c6c40b329b0c0626F28333c132CF241`,
/// which **disagrees** with the agent address the docker
/// `gateway-deployer` overlay hardcodes (`0xFABB0ac9…`); the harness
/// runs `forge script` from the host with `AGENT_ADDRESS` set to
/// [`agent_address`]'s output so the deployed `AGENT_ROLE` matches the
/// keystore the harness writes. The TS SDK's `getTestAccounts` listing
/// is similarly off — see `typescript-sdk/src/index.ts`.
pub const AGENT_PRIVATE_KEY: [u8; 32] = [
    0xab, 0x63, 0xb2, 0x3e, 0xb7, 0x94, 0x1c, 0x12, 0x51, 0x75, 0x7e, 0x24, 0xb3, 0xd2, 0x35, 0x0d,
    0x2b, 0xc0, 0x5c, 0x3c, 0x38, 0x8d, 0x06, 0xf8, 0xfe, 0x6f, 0xea, 0xfe, 0xfb, 0x1e, 0x8c, 0x70,
];

/// Derive the agent EOA address from [`AGENT_PRIVATE_KEY`]. Computed
/// lazily so the harness stays a single source of truth — the deploy
/// script's `AGENT_ADDRESS` env, the keystore's address, and the
/// rmpc config all flow from this one helper.
pub fn agent_address() -> Address {
    derive_address(&AGENT_PRIVATE_KEY)
}

/// Genesis-funded deployer / admin from the docker harness. Used as
/// `--from` for `forge script` and as the deploy-time signer for
/// admin-role on-chain pokes (revoke/reauthorize agent).
pub const DEPLOYER_PRIVATE_KEY_HEX: &str =
    "0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31";
pub const DEPLOYER_ADDRESS_HEX: &str = "0x8943545177806ED17B9F23F0a21ee5948eCaa776";

/// Private key paired with `0x71bE63…` in `typescript-sdk/src/index.ts`.
/// **The pairing is wrong** — this key derives
/// `0x614561D2d143621E126e87831AEF287678B442b8`, *not* `0x71bE63…`. We
/// keep the key value for parity with the SDK and use the
/// actually-derived address ([`PAUSER_ADDRESS_HEX`]) when overriding
/// the deploy script's `PAUSER_ADDRESS` env, so PAUSER_ROLE lands on an
/// address whose key is known to the harness. This lets
/// [`Fixture::pause_gateway`] dispatch via `cast send` rather than
/// requiring `anvil_impersonateAccount` (which Geth does not expose).
pub const PAUSER_PRIVATE_KEY_HEX: &str =
    "0x53321db7c1e331d93a11a41d16f004d7ff63972ec8ec7c25db329728ceeb1710";

/// Address derived from [`PAUSER_PRIVATE_KEY_HEX`]. Verifiable via
/// `cast wallet address --private-key 0x53321db7…`. Granted PAUSER_ROLE
/// at deploy time by the harness (overrides the deploy script's
/// default `PAUSER_ADDRESS` env).
pub const PAUSER_ADDRESS_HEX: &str = "0x614561D2d143621E126e87831AEF287678B442b8";

/// Genesis-funded EOA registered as the share receiver. Owned by the
/// docker compose genesis allocation; not used as a signer in tests.
pub const SHARE_RECEIVER_ADDRESS_HEX: &str = "0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec";

/// Errors raised by the harness itself. Failures from `rmpc`
/// subprocesses are reported via [`RmpcRun`] without converting to
/// [`HarnessError`] — callers want to assert on stdout/stderr/status.
#[derive(Debug, thiserror::Error)]
pub enum HarnessError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("required binary `{0}` not found on PATH; install via https://getfoundry.sh")]
    FoundryMissing(&'static str),
    #[error("RPC at {url} did not become healthy within {timeout:?}")]
    RpcTimeout { url: String, timeout: Duration },
    #[error("forge script failed: {0}")]
    DeployFailed(String),
    #[error("deployment JSON {0}: {1}")]
    DeploymentJson(PathBuf, String),
    #[error("rmpc binary not found at {0}")]
    RmpcBinaryMissing(PathBuf),
    #[error("cargo build of rmpc failed: {0}")]
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

/// Output of an `rmpc` subprocess invocation. UTF-8-decoded eagerly
/// since rmpc promises text output (JSON on stdout, log lines on
/// stderr).
#[derive(Debug)]
pub struct RmpcRun {
    pub status: std::process::ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

impl From<Output> for RmpcRun {
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

/// Shared per-process artifacts: built `rmpc` binary path + the repo
/// root path. We build the binary once for the whole test run.
struct Shared {
    repo_root: PathBuf,
    rmpc_bin: PathBuf,
}

static SHARED: Lazy<Mutex<Option<Shared>>> = Lazy::new(|| Mutex::new(None));

/// A fully-wired test fixture. Drop tears down the docker stack.
pub struct Fixture {
    compose_dir: PathBuf,
    /// Tempdir owning `keystore.json` + `rmpc.toml` + `state/`.
    /// Drop-order: must outlive any post-drop log inspection.
    tmp: TempDir,
    rpc_url: String,
    chain_id: u64,
    deployment: DeploymentJson,
    keystore_path: PathBuf,
    config_path: PathBuf,
    state_dir: PathBuf,
    rmpc_bin: PathBuf,
    repo_root: PathBuf,
}

impl Fixture {
    // ---- constructors ----------------------------------------------------

    /// Boot the Docker Geth+Lighthouse devnet, run the gateway deploy
    /// script from the host, and prepare a keystore + config TOML for
    /// `rmpc` invocations.
    ///
    /// Requires `docker`, `forge`, and `cast` on PATH; expects the
    /// `testing/ethereum-testnet/config/docker-compose.yaml` stack to
    /// be free to start (port 8545 unbound). Tears the stack down on
    /// drop.
    pub fn new() -> Result<Self, HarnessError> {
        Self::with_deploy_env(&[])
    }

    /// Like [`Self::new`] but lets the caller pass extra env vars to
    /// the `forge script Deploy` invocation. Used by the window-cap
    /// test to lower `AGENT_MAX_PER_WINDOW` so the suite can exercise
    /// rollover without waiting 24 wall-clock hours.
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
        let shared = ensure_rmpc_built()?;
        let tmp = TempDir::new()?;
        let compose_dir = shared.repo_root.join("testing/ethereum-testnet/config");
        let rpc_url = "http://127.0.0.1:8545".to_string();

        // Bring up the entire devnet stack (setup → geth → beacon →
        // validators). `docker compose up -d` resolves the dependency
        // graph; without validators no blocks are produced and txs
        // never mine. We deliberately do NOT use the `gateway-deployer`
        // overlay — that container hardcodes addresses that disagree
        // with our key constants. Instead we run `forge script` from
        // the host with the correct env so PAUSER_ROLE / AGENT_ROLE
        // land on EOAs whose keys the harness owns.
        let status = Command::new("docker")
            .arg("compose")
            .arg("-f")
            .arg("docker-compose.yaml")
            .arg("up")
            .arg("-d")
            .current_dir(&compose_dir)
            .status()
            .map_err(HarnessError::from)?;
        if !status.success() {
            return Err(HarnessError::Docker(format!(
                "compose up devnet failed: {status:?}"
            )));
        }

        // Wait for the EL RPC to come up (~30s).
        wait_for_rpc(&rpc_url, Duration::from_secs(180))?;

        // Wait for actual block production. RPC up != consensus up;
        // until the beacon hands geth a payload and validators attest,
        // `eth_blockNumber` stays at 0 and txs stay queued forever.
        wait_for_block_height(&rpc_url, 1, Duration::from_secs(240)).inspect_err(|_e| {
            // Best-effort teardown so a stuck stack doesn't poison
            // subsequent test runs.
            let _ = Command::new("docker")
                .args(["compose", "down", "-v", "--remove-orphans"])
                .current_dir(&compose_dir)
                .status();
        })?;

        // Deploy from the host using the genesis-prefunded deployer
        // key. We point AGENT_ADDRESS at our derived agent EOA and
        // PAUSER_ADDRESS at the EOA derived from
        // [`PAUSER_PRIVATE_KEY_HEX`] so both roles end up on
        // harness-owned signers. (Issue #37: drop the impersonation
        // path that the previous Anvil flavor relied on.)
        let dep_out = tmp.path().join("deployment.json");
        let agent_hex = format!("{:#x}", agent_address());
        run_forge_deploy_with_env(
            &shared.repo_root,
            &rpc_url,
            &dep_out,
            &agent_hex,
            PAUSER_ADDRESS_HEX,
            extra_deploy_env,
        )
        .inspect_err(|_e| {
            let _ = Command::new("docker")
                .args(["compose", "down", "-v", "--remove-orphans"])
                .current_dir(&compose_dir)
                .status();
        })?;

        let deployment = read_deployment(&dep_out)?;
        let chain_id = deployment.chain_id;

        // Fund EOAs that aren't part of the genesis allocation:
        // - the agent (derived from AGENT_PRIVATE_KEY) needs gas;
        // - the pauser (derived from PAUSER_PRIVATE_KEY_HEX) needs gas
        //   to call `pause()` from `Fixture::pause_gateway`.
        fund_eth_from_deployer(&rpc_url, &agent_hex, "1000000000000000000")?; // 1 ETH
        fund_eth_from_deployer(&rpc_url, PAUSER_ADDRESS_HEX, "1000000000000000000")?; // 1 ETH

        let (keystore_path, config_path, state_dir) =
            write_keystore_and_config(tmp.path(), &rpc_url, &deployment)?;

        Ok(Fixture {
            compose_dir,
            tmp,
            rpc_url,
            chain_id,
            deployment,
            keystore_path,
            config_path,
            state_dir,
            rmpc_bin: shared.rmpc_bin,
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
    pub fn rmpc_binary(&self) -> &Path {
        &self.rmpc_bin
    }
    pub fn passphrase(&self) -> &str {
        TEST_PASSPHRASE
    }

    // ---- rmpc subprocess helpers ----------------------------------------

    fn rmpc_command(&self) -> Command {
        let mut cmd = Command::new(&self.rmpc_bin);
        cmd.env(PASSPHRASE_ENV_VAR, TEST_PASSPHRASE)
            .env("RMPC_STATE_DIR", &self.state_dir);
        cmd
    }

    /// `rmpc self-check --config <cfg>` as a subprocess.
    pub fn run_rmpc_self_check(&self) -> Result<RmpcRun, HarnessError> {
        let out = self
            .rmpc_command()
            .args(["self-check", "--config"])
            .arg(&self.config_path)
            .output()?;
        Ok(out.into())
    }

    /// `rmpc status --config <cfg> --payment-id <id>` as a subprocess.
    pub fn run_rmpc_status(&self, payment_id: &str) -> Result<RmpcRun, HarnessError> {
        let out = self
            .rmpc_command()
            .args(["status", "--config"])
            .arg(&self.config_path)
            .args(["--payment-id", payment_id])
            .output()?;
        Ok(out.into())
    }

    /// `rmpc deposit --config <cfg> [args...]` as a subprocess.
    /// `extra` lets callers append `--amount`, `--order-id`, etc.
    pub fn run_rmpc_deposit<I, S>(&self, extra: I) -> Result<RmpcRun, HarnessError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut cmd = self.rmpc_command();
        cmd.args(["deposit", "--config"]).arg(&self.config_path);
        for a in extra {
            cmd.arg(a);
        }
        let out = cmd.output()?;
        Ok(out.into())
    }

    /// Run rmpc with arbitrary args + extra env, for ad-hoc tests
    /// (e.g. swapping the passphrase to verify startup-fail paths).
    pub fn run_rmpc_with<I, S>(
        &self,
        args: I,
        extra_env: HashMap<String, String>,
    ) -> Result<RmpcRun, HarnessError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut cmd = self.rmpc_command();
        for (k, v) in extra_env {
            cmd.env(k, v);
        }
        for a in args {
            cmd.arg(a);
        }
        let out = cmd.output()?;
        Ok(out.into())
    }

    // ---- on-chain pokes (signed with real harness keys) ------------------

    /// Send a transaction via `cast send` from an arbitrary private key.
    ///
    /// `private_key_hex` must be 0x-prefixed. `to` is the contract
    /// address, `sig` is a Solidity-style call signature
    /// (e.g. `"approve(address,uint256)"`), and `args` are the
    /// stringified positional arguments. Returns the transaction hash on
    /// success.
    pub fn cast_send(
        &self,
        private_key_hex: &str,
        to: Address,
        sig: &str,
        args: &[&str],
    ) -> Result<String, HarnessError> {
        if which::which("cast").is_err() {
            return Err(HarnessError::FoundryMissing("cast"));
        }
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
    /// Convenience wrapper signing with [`AGENT_PRIVATE_KEY`].
    pub fn approve_usdc_from_agent(&self, amount: u128) -> Result<String, HarnessError> {
        let agent_pk_hex = format!("0x{}", hex::encode(AGENT_PRIVATE_KEY));
        self.cast_send(
            &agent_pk_hex,
            self.usdc(),
            "approve(address,uint256)",
            &[&format!("{:#x}", self.gateway()), &amount.to_string()],
        )
    }

    /// Pause the gateway by calling `pause()` from the PAUSER_ROLE
    /// holder. Signs with [`PAUSER_PRIVATE_KEY_HEX`] (which derives
    /// [`PAUSER_ADDRESS_HEX`], the EOA the harness grants PAUSER_ROLE
    /// at deploy time).
    pub fn pause_gateway(&self) -> Result<String, HarnessError> {
        self.cast_send(PAUSER_PRIVATE_KEY_HEX, self.gateway(), "pause()", &[])
    }

    /// Unpause the gateway. Per `AccessRoles` docs, unpause is
    /// asymmetric with pause: ADMIN_ROLE-only. Signs with the deployer
    /// key.
    pub fn unpause_gateway(&self) -> Result<String, HarnessError> {
        self.cast_send(DEPLOYER_PRIVATE_KEY_HEX, self.gateway(), "unpause()", &[])
    }

    /// Revoke the agent's `AGENT_ROLE` by sending `revokeAgent(agent)`
    /// from the deployer (which holds `ADMIN_ROLE`).
    pub fn revoke_agent(&self) -> Result<String, HarnessError> {
        self.cast_send(
            DEPLOYER_PRIVATE_KEY_HEX,
            self.gateway(),
            "revokeAgent(address)",
            &[&format!("{:#x}", self.agent())],
        )
    }

    /// Re-grant the agent's `AGENT_ROLE` with the original deploy
    /// policy. Used by tests that revoked the role to restore the
    /// shared fixture for subsequent scenarios. The policy values
    /// mirror Deploy.s.sol defaults; tests that need bespoke caps
    /// should boot a dedicated fixture via [`Fixture::with_deploy_env`]
    /// instead of relying on this re-grant.
    pub fn reauthorize_agent(
        &self,
        max_per_payment: u128,
        max_per_window: u128,
    ) -> Result<String, HarnessError> {
        let agent = format!("{:#x}", self.agent());
        let share_receiver = format!("{:#x}", self.share_receiver());
        // policy = (active=true, validUntil=type(uint64).max,
        //          maxPerPayment, maxPerWindow, shareReceiver)
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

    /// Mint mock USDC to `recipient`. Calls `MockUSDC.mint(addr, amount)`
    /// from the deployer (which has minter rights post-deploy). Returns
    /// the tx hash.
    pub fn fund_usdc(&self, recipient: Address, amount: u128) -> Result<String, HarnessError> {
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
        // Best-effort teardown. Don't panic in drop.
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

// ----- internals ---------------------------------------------------------

/// Derive an EOA address from a 32-byte secp256k1 private key.
/// Centralized so both [`agent_address`] and any future test-account
/// derivations share one implementation.
fn derive_address(privkey: &[u8; 32]) -> Address {
    use k256::ecdsa::SigningKey;
    let sk = SigningKey::from_bytes(privkey.into()).expect("static privkey is valid");
    let vk = sk.verifying_key();
    let pubkey = vk.to_encoded_point(/* compress = */ false);
    // `pubkey.as_bytes()` is the SEC1 uncompressed form: 0x04 || X || Y.
    let hash = keccak256(&pubkey.as_bytes()[1..]);
    Address::from_slice(&hash[12..])
}

fn parse_addr(s: &str) -> Address {
    s.parse::<Address>().unwrap_or(Address::ZERO)
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

/// Poll `eth_blockNumber` until it reaches `target_height`. The RPC
/// port comes up before the consensus stack hands geth a payload, so
/// we have to wait for actual block production before broadcasting
/// transactions.
fn wait_for_block_height(
    url: &str,
    target_height: u64,
    timeout: Duration,
) -> Result<(), HarnessError> {
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
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(resp) = client.post(url).json(&body).send() {
            if let Ok(j) = resp.json::<serde_json::Value>() {
                if let Some(s) = j.get("result").and_then(|v| v.as_str()) {
                    if let Ok(n) = u64::from_str_radix(s.trim_start_matches("0x"), 16) {
                        if n >= target_height {
                            return Ok(());
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(1000));
    }
    Err(HarnessError::RpcTimeout {
        url: url.to_string(),
        timeout,
    })
}

/// Send `value_wei` from the genesis-funded deployer to `recipient_hex`
/// via `cast send --value`. Used to fund EOAs that aren't part of the
/// genesis allocation.
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
            "cast send --value (fund eth) failed: stdout={} stderr={}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| HarnessError::other(format!("cast send fund eth json: {e}")))?;
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

fn write_keystore_and_config(
    tmp: &Path,
    rpc_url: &str,
    dep: &DeploymentJson,
) -> Result<(PathBuf, PathBuf, PathBuf), HarnessError> {
    use rust_payment_client::signer::software::SoftwareSigner;

    let keystore_path = tmp.join("keystore.json");
    SoftwareSigner::create_keystore(
        &keystore_path,
        &AGENT_PRIVATE_KEY,
        TEST_PASSPHRASE.as_bytes(),
    )
    .map_err(|e| HarnessError::other(format!("create_keystore: {e}")))?;

    let state_dir = tmp.join("state");
    std::fs::create_dir_all(&state_dir)?;

    let config_path = tmp.join("rmpc.toml");
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
/// `clients/rust-payment-client`.
fn locate_repo_root() -> Result<PathBuf, HarnessError> {
    let mut p: PathBuf = env!("CARGO_MANIFEST_DIR").into();
    for _ in 0..8 {
        if p.join("foundry.toml").exists() && p.join("clients/rust-payment-client").exists() {
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

/// Build the `rmpc` binary once (release) and cache the path.
fn ensure_rmpc_built() -> Result<Shared, HarnessError> {
    let mut guard = SHARED.lock().expect("SHARED mutex poisoned");
    if let Some(s) = guard.as_ref() {
        return Ok(Shared {
            repo_root: s.repo_root.clone(),
            rmpc_bin: s.rmpc_bin.clone(),
        });
    }
    let repo_root = locate_repo_root()?;

    // Build the binary in the rmpc crate's own target dir to avoid
    // contention with any outer cargo invocation. We deliberately use
    // a release build so subsequent test invocations are fast; the
    // first invocation pays the build cost once per `cargo test` run.
    let manifest = repo_root.join("clients/rust-payment-client/Cargo.toml");
    let target_dir = repo_root.join("target/e2e-rmpc");
    let out = Command::new("cargo")
        .args(["build", "--release", "--bin", "rmpc", "--manifest-path"])
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
    let rmpc_bin = target_dir.join("release/rmpc");
    if !rmpc_bin.exists() {
        return Err(HarnessError::RmpcBinaryMissing(rmpc_bin));
    }
    *guard = Some(Shared {
        repo_root: repo_root.clone(),
        rmpc_bin: rmpc_bin.clone(),
    });
    Ok(Shared {
        repo_root,
        rmpc_bin,
    })
}

/// Returns `true` iff `docker` and the foundry binaries (`forge`,
/// `cast`) are on PATH. Tests use this to skip-on-missing rather than
/// fail when prerequisites aren't installed locally.
pub fn prerequisites_available() -> bool {
    which::which("docker").is_ok() && which::which("forge").is_ok() && which::which("cast").is_ok()
}
