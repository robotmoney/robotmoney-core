//! Canonical: docs/implementation-plan.md §5 — Phase 1 End-to-end test plan
//!
//! rmpc integration test fixture. Wraps [`smoke_test::Fixture`] (the
//! devnet + deployed contracts) and adds:
//! - Building the `rmpc` binary once per process via [`once_cell`].
//! - Writing a per-fixture keystore and `rmpc.toml` config.
//! - Subprocess helpers for invoking rmpc commands.
//!
//! All chain-level accessors and on-chain poke helpers are forwarded
//! from the inner [`smoke_test::Fixture`] — see its docs for details.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::Mutex;

use alloy_primitives::Address;
use once_cell::sync::Lazy;

pub use rust_payment_client::signer::software::PASSPHRASE_ENV_VAR;
pub use smoke_test::{
    agent_address, prerequisites_available, HarnessError, AGENT_PRIVATE_KEY, DEPLOYER_ADDRESS_HEX,
    DEPLOYER_PRIVATE_KEY_HEX, PAUSER_ADDRESS_HEX, PAUSER_PRIVATE_KEY_HEX,
    SHARE_RECEIVER_ADDRESS_HEX,
};

const TEST_PASSPHRASE: &str = "rmpc-e2e-passphrase";

// -- RmpcRun ----------------------------------------------------------

/// Output of an `rmpc` subprocess invocation.
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

// -- rmpc binary cache ------------------------------------------------

static RMPC_BIN: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

fn ensure_rmpc_built() -> Result<PathBuf, HarnessError> {
    let mut guard = RMPC_BIN.lock().expect("RMPC_BIN mutex poisoned");
    if let Some(p) = guard.as_ref() {
        return Ok(p.clone());
    }
    let repo_root = smoke_test::locate_repo_root()?;
    let manifest = repo_root.join("clients/rust-payment-client/Cargo.toml");
    let target_dir = repo_root.join("target/e2e-rmpc");
    let out = Command::new("cargo")
        .args(["build", "--release", "--bin", "rmpc", "--manifest-path"])
        .arg(&manifest)
        .arg("--target-dir")
        .arg(&target_dir)
        .output()?;
    if !out.status.success() {
        return Err(HarnessError::other(format!(
            "cargo build rmpc failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )));
    }
    let bin = target_dir.join("release/rmpc");
    if !bin.exists() {
        return Err(HarnessError::other(format!(
            "rmpc binary not found at {}",
            bin.display()
        )));
    }
    *guard = Some(bin.clone());
    Ok(bin)
}

// -- Fixture ----------------------------------------------------------

/// rmpc test fixture. Owns the devnet (via the inner smoke-test fixture),
/// an rmpc binary, a keystore, and a config file.
pub struct Fixture {
    devnet: smoke_test::Fixture,
    rmpc_bin: PathBuf,
    keystore_path: PathBuf,
    config_path: PathBuf,
    state_dir: PathBuf,
}

impl Fixture {
    /// Boot the devnet, build rmpc, write a keystore and config.
    ///
    /// Uses `PassthroughAdapter` on the Geth+Lighthouse devnet (injected
    /// automatically by [`Self::with_deploy_env`]).
    pub fn new() -> Result<Self, HarnessError> {
        Self::with_deploy_env(&[])
    }

    /// Like [`Self::new`] but passes extra env vars to `forge script Deploy`.
    ///
    /// `USE_PASSTHROUGH_ADAPTER=true` is always injected (unless the caller
    /// explicitly overrides it) so the Geth+Lighthouse devnet never tries to
    /// call real Aave/Compound/Morpho contracts that have no on-chain storage
    /// in the genesis snapshot.
    pub fn with_deploy_env(extra_deploy_env: &[(&str, &str)]) -> Result<Self, HarnessError> {
        // Build rmpc first so we fail fast before the 60-90s devnet boot.
        let rmpc_bin = ensure_rmpc_built()?;
        // Always include USE_PASSTHROUGH_ADAPTER unless the caller overrides it.
        let mut env: Vec<(&str, &str)> = vec![("USE_PASSTHROUGH_ADAPTER", "true")];
        for &(k, v) in extra_deploy_env {
            // Caller override wins: drop our default if the key appears.
            if k == "USE_PASSTHROUGH_ADAPTER" {
                env.retain(|(ek, _)| *ek != "USE_PASSTHROUGH_ADAPTER");
            }
            env.push((k, v));
        }
        let devnet = smoke_test::Fixture::with_deploy_env(&env)?;
        let (keystore_path, config_path, state_dir) = write_keystore_and_config(&devnet)?;
        Ok(Fixture {
            devnet,
            rmpc_bin,
            keystore_path,
            config_path,
            state_dir,
        })
    }

    // ---- forwarded chain-level accessors ----------------------------

    pub fn rpc_url(&self) -> &str {
        self.devnet.rpc_url()
    }
    pub fn chain_id(&self) -> u64 {
        self.devnet.chain_id()
    }
    pub fn gateway(&self) -> Address {
        self.devnet.gateway()
    }
    pub fn usdc(&self) -> Address {
        self.devnet.usdc()
    }
    pub fn vault(&self) -> Address {
        self.devnet.vault()
    }
    pub fn agent(&self) -> Address {
        self.devnet.agent()
    }
    pub fn share_receiver(&self) -> Address {
        self.devnet.share_receiver()
    }
    pub fn gateway_runtime_hash(&self) -> &str {
        self.devnet.gateway_runtime_hash()
    }
    pub fn tempdir(&self) -> &Path {
        self.devnet.tempdir()
    }
    pub fn repo_root(&self) -> &Path {
        self.devnet.repo_root()
    }

    // ---- forwarded on-chain poke helpers ----------------------------

    pub fn cast_send(
        &self,
        pk: &str,
        to: Address,
        sig: &str,
        args: &[&str],
    ) -> Result<String, HarnessError> {
        self.devnet.cast_send(pk, to, sig, args)
    }

    pub fn approve_usdc_from_agent(&self, amount: u128) -> Result<String, HarnessError> {
        self.devnet.approve_usdc_from_agent(amount)
    }

    pub fn pause_gateway(&self) -> Result<String, HarnessError> {
        self.devnet.pause_gateway()
    }

    pub fn unpause_gateway(&self) -> Result<String, HarnessError> {
        self.devnet.unpause_gateway()
    }

    pub fn revoke_agent(&self) -> Result<String, HarnessError> {
        self.devnet.revoke_agent()
    }

    pub fn reauthorize_agent(
        &self,
        max_per_payment: u128,
        max_per_window: u128,
    ) -> Result<String, HarnessError> {
        self.devnet
            .reauthorize_agent(max_per_payment, max_per_window)
    }

    pub fn fund_usdc(&self, recipient: Address, amount: u128) -> Result<String, HarnessError> {
        self.devnet.fund_usdc(recipient, amount)
    }

    // ---- rmpc accessors ---------------------------------------------

    pub fn config_path(&self) -> &Path {
        &self.config_path
    }
    pub fn keystore_path(&self) -> &Path {
        &self.keystore_path
    }
    pub fn state_dir(&self) -> &Path {
        &self.state_dir
    }
    pub fn rmpc_binary(&self) -> &Path {
        &self.rmpc_bin
    }
    pub fn passphrase(&self) -> &str {
        TEST_PASSPHRASE
    }

    // ---- rmpc subprocess helpers ------------------------------------

    fn rmpc_command(&self) -> Command {
        let mut cmd = Command::new(&self.rmpc_bin);
        cmd.env(PASSPHRASE_ENV_VAR, TEST_PASSPHRASE)
            .env("RMPC_STATE_DIR", &self.state_dir);
        cmd
    }

    pub fn run_rmpc_self_check(&self) -> Result<RmpcRun, HarnessError> {
        let out = self
            .rmpc_command()
            .args(["self-check", "--config"])
            .arg(&self.config_path)
            .output()?;
        Ok(out.into())
    }

    pub fn run_rmpc_status(&self, payment_id: &str) -> Result<RmpcRun, HarnessError> {
        let out = self
            .rmpc_command()
            .args(["status", "--config"])
            .arg(&self.config_path)
            .args(["--payment-id", payment_id])
            .output()?;
        Ok(out.into())
    }

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
        Ok(cmd.output()?.into())
    }

    pub fn run_rmpc_withdraw<I, S>(&self, extra: I) -> Result<RmpcRun, HarnessError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut cmd = self.rmpc_command();
        cmd.args(["withdraw", "--config"]).arg(&self.config_path);
        for a in extra {
            cmd.arg(a);
        }
        Ok(cmd.output()?.into())
    }

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
        Ok(cmd.output()?.into())
    }
}

// -- Keystore + config ------------------------------------------------

fn write_keystore_and_config(
    devnet: &smoke_test::Fixture,
) -> Result<(PathBuf, PathBuf, PathBuf), HarnessError> {
    use rust_payment_client::signer::software::SoftwareSigner;

    let tmp = devnet.tempdir();

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
        chain_id = devnet.chain_id(),
        rpc_url = devnet.rpc_url(),
        gateway = devnet.gateway_hex(),
        usdc = devnet.usdc_hex(),
        vault = devnet.vault_hex(),
        hash = devnet.gateway_runtime_hash(),
        keystore = keystore_path.display(),
    );
    std::fs::write(&config_path, toml)?;

    Ok((keystore_path, config_path, state_dir))
}
