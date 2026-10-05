//! Canonical: core issue 1498 (Twin chain clean room rule), core issue 1488.
//!
//! The vault every fork test runs against. A test never reads a production Robot Money contract:
//! it deploys its OWN vault through the real stage script (`scripts/deploy/core-stages.ts
//! --stages vault`, the same runner the publish contracts flow uses) and reads the address from the
//! manifest the stage wrote.
//!
//! Two sources, in this order:
//!
//! 1. `RMPC_DEPLOY_MANIFEST`: a path to a merged manifest that the publish contracts flow wrote on
//!    this chain. The harness reads `vault` and the adapter keys from it and deploys nothing.
//! 2. Otherwise the harness runs the vault stage itself, once per fixture, against the fixture's
//!    chain. The deployer is the first anvil dev account, unlocked on the node (`--unlocked
//!    --sender`), so no key is read, stored or passed. Gas and USDC for the seed are the two
//!    allowed environment steps (anvil_setBalance and the FiatToken balance slot).
//!
//! No Robot Money address is hard-coded here. The three anvil dev accounts below are the public
//! anvil defaults, not Robot Money contracts.

use std::path::PathBuf;
use std::process::Command;

use alloy_primitives::{Address, U256};

use crate::{ForkFixture, HarnessError};

/// anvil dev account 0: the stage deployer and vault admin (unlocked on every anvil node).
pub const ANVIL_DEPLOYER: &str = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
/// anvil dev account 1: the vault fee recipient.
pub const ANVIL_FEE_RECIPIENT: &str = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
/// anvil dev account 2: the seed share receiver (never the deployer).
pub const ANVIL_SEED_RECEIVER: &str = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

/// Seed deposit: 1 USDC in 6-decimal units.
pub const SEED_DEPOSIT_USDC: u64 = 1_000_000;
/// TVL cap: 1,000,000 USDC.
pub const TVL_CAP: u64 = 1_000_000_000_000;
/// Per-deposit cap: 100,000 USDC.
pub const PER_DEPOSIT_CAP: u64 = 100_000_000_000;
/// Exit fee in basis points.
pub const EXIT_FEE_BPS: u64 = 10;

/// The vault and adapters a fork test runs against, as the stage manifest recorded them.
#[derive(Debug, Clone)]
pub struct DeployedVault {
    pub vault: Address,
    pub aave_adapter: Address,
    pub compound_adapter: Address,
    pub moonwell_adapter: Address,
    /// Where the manifest was read from or written to.
    pub manifest_path: PathBuf,
}

fn repo_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop();
    p.pop();
    p
}

fn manifest_addr(m: &serde_json::Value, key: &str) -> Result<Address, HarnessError> {
    m[key]
        .as_str()
        .ok_or_else(|| HarnessError::Rpc(format!("deploy manifest lacks \"{key}\"")))?
        .parse()
        .map_err(|e| HarnessError::Rpc(format!("deploy manifest \"{key}\" is not an address: {e}")))
}

/// Parse a merged stage manifest.
pub fn parse_manifest(json: &str, manifest_path: PathBuf) -> Result<DeployedVault, HarnessError> {
    let m: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| HarnessError::Rpc(format!("deploy manifest is not JSON: {e}")))?;
    Ok(DeployedVault {
        vault: manifest_addr(&m, "vault")?,
        aave_adapter: manifest_addr(&m, "aave_adapter")?,
        compound_adapter: manifest_addr(&m, "compound_adapter")?,
        moonwell_adapter: manifest_addr(&m, "moonwell_flagship_adapter")?,
        manifest_path,
    })
}

/// Resolve the fixture's vault: the publish contracts manifest when `RMPC_DEPLOY_MANIFEST` is set,
/// otherwise a fresh deploy of the vault stage.
pub fn resolve(fx: &ForkFixture) -> Result<DeployedVault, HarnessError> {
    if let Ok(path) = std::env::var("RMPC_DEPLOY_MANIFEST") {
        if !path.is_empty() {
            let text = std::fs::read_to_string(&path)?;
            return parse_manifest(&text, PathBuf::from(path));
        }
    }
    deploy_own_vault(fx)
}

/// Deploy this fixture's own vault through the real stage runner and read the manifest it wrote.
pub fn deploy_own_vault(fx: &ForkFixture) -> Result<DeployedVault, HarnessError> {
    let deployer: Address = ANVIL_DEPLOYER.parse().expect("anvil deployer address");
    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    // Environment steps: fund gas, fund USDC for the seed.
    fx.rpc()
        .set_balance(deployer, one_eth * U256::from(100u64))?;
    fx.fund_usdc(deployer, U256::from(SEED_DEPOSIT_USDC))?;

    let dir = tempfile::tempdir()?;
    let out = dir.path().join("deploy-manifest.json");
    let status = Command::new("bun")
        .current_dir(repo_root())
        .args(["scripts/deploy/core-stages.ts", "--rpc-url", &fx.rpc_url])
        .arg("--out")
        .arg(&out)
        .args(["--stages", "vault", "--forge-arg", "--unlocked"])
        .args(["--forge-arg", "--sender", "--forge-arg", ANVIL_DEPLOYER])
        // foundry.toml fs_permissions grants write on /tmp only: the runner's work dir must be there.
        .env("TMPDIR", "/tmp")
        .env("EXPECTED_CHAIN_ID", fx.chain_id.to_string())
        .env("ADMIN_ADDRESS", ANVIL_DEPLOYER)
        .env("FEE_RECIPIENT", ANVIL_FEE_RECIPIENT)
        .env("SEED_SHARE_RECEIVER", ANVIL_SEED_RECEIVER)
        .env("SEED_DEPOSIT_USDC", SEED_DEPOSIT_USDC.to_string())
        .env("TVL_CAP", TVL_CAP.to_string())
        .env("PER_DEPOSIT_CAP", PER_DEPOSIT_CAP.to_string())
        .env("EXIT_FEE_BPS", EXIT_FEE_BPS.to_string())
        .output()
        .map_err(|e| HarnessError::Rpc(format!("spawn bun core-stages: {e}")))?;
    if !status.status.success() {
        return Err(HarnessError::Rpc(format!(
            "vault stage failed: {}",
            String::from_utf8_lossy(&status.stderr)
        )));
    }
    let text = std::fs::read_to_string(&out)?;
    // Keep the manifest after the tempdir drops: the path is informational only.
    parse_manifest(&text, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_manifest_reads_addresses() {
        let a = "0x00000000000000000000000000000000000000a1";
        let json = format!(
            r#"{{"vault":"{a}","aave_adapter":"{a}","compound_adapter":"{a}","moonwell_flagship_adapter":"{a}"}}"#
        );
        let d = parse_manifest(&json, PathBuf::from("m.json")).expect("parse");
        assert_eq!(d.vault, a.parse::<Address>().unwrap());
    }

    #[test]
    fn parse_manifest_rejects_missing_vault() {
        let err = parse_manifest("{}", PathBuf::from("m.json")).unwrap_err();
        assert!(err.to_string().contains("\"vault\""));
    }
}
