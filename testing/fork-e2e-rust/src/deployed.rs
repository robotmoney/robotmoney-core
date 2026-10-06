//! Canonical: core issue 1498 (Twin chain clean room rule), core issue 1488.
//!
//! The vault every fork test runs against. A test never reads a production Robot Money contract:
//! it deploys its OWN vault through the one deploy driver (`bun publish-contracts/src/cli.ts
//! --stage vault`, the same CLI every deploy uses) and reads the address from the manifest the stage wrote.
//!
//! Two sources, in this order:
//!
//! 1. `RMPC_DEPLOY_MANIFEST`: a path to a merged manifest that the publish contracts flow wrote on
//!    this chain. The harness reads `vault` and the adapter keys from it and deploys nothing.
//! 2. Otherwise the harness runs the vault stage itself, once per fixture, against the fixture's
//!    chain. The deployer is a throwaway encrypted keystore the rehearsal key helper makes in a
//!    0700 temp directory (a random passphrase in a 0600 file, never an argument). Gas and USDC for
//!    the seed are the two allowed environment steps (anvil_setBalance and the FiatToken balance slot).
//!
//! No Robot Money address is hard-coded here. The three anvil dev accounts below are the public
//! anvil defaults, not Robot Money contracts.

use std::path::PathBuf;
use std::process::Command;

use alloy_primitives::{Address, U256};

use crate::{ForkFixture, HarnessError};

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
    deploy_with_retry(fx)
}

/// True when a failed vault stage was caused by the public upstream behind the lazy fork (HTTP 5xx,
/// rate limit, timeout) and not by our contracts. The Twin fork reads real Base state on demand,
/// so a 502 from mainnet.base.org surfaces inside forge as an arbitrary revert.
pub fn is_transient_upstream_failure(stderr: &str) -> bool {
    [
        "502 Bad Gateway",
        "503 Service",
        "504 Gateway",
        "429",
        "Too Many Requests",
        "HTTP error 5",
        "failed to get account for",
        "failed to get storage",
        "Failed to send/recv",
        "operation timed out",
    ]
    .iter()
    .any(|m| stderr.contains(m))
}

/// Deploy through the real stage, retrying (up to 3 attempts) only on a transient upstream failure.
/// Any other failure, and the last transient one, is returned unchanged. Each attempt is a full
/// stage run from a clean `forge script` (a failed simulation broadcasts nothing).
fn deploy_with_retry(fx: &ForkFixture) -> Result<DeployedVault, HarnessError> {
    let mut last = None;
    for attempt in 1..=3u32 {
        match deploy_own_vault(fx) {
            Ok(v) => return Ok(v),
            Err(HarnessError::Rpc(msg)) if is_transient_upstream_failure(&msg) => {
                eprintln!("[deploy] vault stage hit a transient upstream failure (attempt {attempt}/3); retrying");
                std::thread::sleep(std::time::Duration::from_secs(3 * u64::from(attempt)));
                last = Some(HarnessError::Rpc(msg));
            }
            Err(e) => return Err(e),
        }
    }
    Err(last.expect("loop ran"))
}

/// The Twin chain id. The publish-contracts CLI deploys only here (and to Base mainnet, never from a test).
pub const TWIN_CHAIN_ID: u64 = 918453;
/// The one deploy driver, relative to the repo root.
const PUBLISH_CLI_REL: &str = "publish-contracts/src/cli.ts";
const REHEARSAL_CLI_REL: &str = "publish-contracts/src/rehearsal/cli.ts";
/// The committed Twin chain stage sheet (parameter lines only), relative to the repo root.
const STAGE_SHEET_REL: &str = "deployments/twin-918453/stage-sheet.env";

/// The sheet for one run: the stage sheet's lines, with every key in `replace` swapped for the given value.
/// A key the stage sheet lacks is appended, so the result never carries one key twice.
pub fn render_sheet(stage_sheet: &str, replace: &[(String, String)]) -> String {
    let mut out = String::new();
    for line in stage_sheet.lines() {
        let body = line.trim_start();
        let key = body.split('=').next().unwrap_or("").trim();
        if replace.iter().any(|(k, _)| k == key) {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    for (k, v) in replace {
        out.push_str(&format!("{k}={v}\n"));
    }
    out
}

/// Parse the `NAME=value` lines the rehearsal key helper prints (addresses and numbers only).
pub fn parse_fragment(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|l| {
            let l = l.trim();
            if l.is_empty() || l.starts_with('#') {
                return None;
            }
            let (k, v) = l.split_once('=')?;
            let k = k.trim();
            k.bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                .then(|| (k.to_string(), v.trim().trim_matches('"').to_string()))
        })
        .collect()
}

fn git_head(root: &std::path::Path) -> Result<String, HarnessError> {
    let out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(root)
        .output()?;
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || sha.len() != 40 {
        return Err(HarnessError::Rpc("git rev-parse HEAD failed".into()));
    }
    Ok(sha)
}

/// A random 48-hex-character passphrase from the OS, written to a new 0600 file. It is never an argument.
fn write_random_password(path: &std::path::Path) -> Result<(), HarnessError> {
    use std::io::{Read, Write};
    use std::os::unix::fs::OpenOptionsExt;
    let mut raw = [0u8; 24];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut raw)?;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(hex::encode(raw).as_bytes())?;
    Ok(())
}

/// Deploy this fixture's own vault through the one driver: `bun publish-contracts/src/cli.ts --stage vault`
/// on the Twin chain, signed by a throwaway encrypted keystore. Then read the manifest the CLI wrote.
/// Gas and USDC for the seed are the two allowed environment steps (anvil_setBalance and the FiatToken balance slot).
pub fn deploy_own_vault(fx: &ForkFixture) -> Result<DeployedVault, HarnessError> {
    if fx.chain_id != TWIN_CHAIN_ID {
        return Err(HarnessError::Rpc(format!(
            "the vault deploy runs on the Twin chain ({TWIN_CHAIN_ID}); this fixture is chain {}",
            fx.chain_id
        )));
    }
    let root = repo_root();
    let dir = tempfile::tempdir()?; // 0700, removed when it drops
    let keys = dir.path().join("keys");
    let pw = dir.path().join("passphrase");
    let mdir = dir.path().join("manifests");
    let counts = dir.path().join("counts");
    std::fs::create_dir_all(&mdir)?;
    std::fs::create_dir_all(&counts)?;
    write_random_password(&pw)?;
    let made = Command::new("bun")
        .arg(root.join(REHEARSAL_CLI_REL))
        .args(["keys", "--dir"])
        .arg(&keys)
        .arg("--password-file")
        .arg(&pw)
        .args(["--chain-id", &TWIN_CHAIN_ID.to_string()])
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| HarnessError::Rpc(format!("spawn the rehearsal key helper: {e}")))?;
    if !made.status.success() {
        return Err(HarnessError::Rpc(format!(
            "rehearsal key helper failed: {}",
            String::from_utf8_lossy(&made.stderr)
        )));
    }
    let mut replace = parse_fragment(&String::from_utf8_lossy(&made.stdout));
    let deployer: Address = replace
        .iter()
        .find(|(k, _)| k == "ADMIN_ADDRESS")
        .ok_or_else(|| HarnessError::Rpc("the key helper printed no ADMIN_ADDRESS".into()))?
        .1
        .parse()
        .map_err(|e| HarnessError::Rpc(format!("ADMIN_ADDRESS is not an address: {e}")))?;
    // The fixture's economics: public anvil accounts receive the seed shares and the fees. No Safe is made
    // by a vault-only run, so the fee recipient is an address, not `@safe`.
    for (k, v) in [
        ("SHARE_RECEIVER_ADDRESS", ANVIL_SEED_RECEIVER.to_string()),
        ("FEE_RECIPIENT_ADDRESS", ANVIL_FEE_RECIPIENT.to_string()),
        ("SEED_DEPOSIT_USDC", SEED_DEPOSIT_USDC.to_string()),
        ("VAULT_USDC_TVL_CAP", TVL_CAP.to_string()),
        ("VAULT_USDC_PER_DEPOSIT_CAP", PER_DEPOSIT_CAP.to_string()),
        ("VAULT_USDC_EXIT_FEE_BPS", EXIT_FEE_BPS.to_string()),
    ] {
        replace.push((k.to_string(), v));
    }
    let stage_sheet = std::fs::read_to_string(root.join(STAGE_SHEET_REL))?;
    let sheet = dir.path().join("run-sheet.env");
    std::fs::write(&sheet, render_sheet(&stage_sheet, &replace))?;

    let one_eth = U256::from(10u64).pow(U256::from(18u64));
    fx.rpc()
        .set_balance(deployer, one_eth * U256::from(100u64))?;
    fx.fund_usdc(deployer, U256::from(SEED_DEPOSIT_USDC))?;

    let signer = format!(
        "keystore:{}:{}",
        keys.join("DEPLOYER").display(),
        pw.display()
    );
    let status = Command::new("bun")
        .current_dir(&root)
        .arg(root.join(PUBLISH_CLI_REL))
        .args([
            "--stage",
            "vault",
            "--chain",
            &TWIN_CHAIN_ID.to_string(),
            "--rpc",
            &fx.rpc_url,
        ])
        .arg("--sheet")
        .arg(&sheet)
        .args([
            "--signer",
            &signer,
            "--environment",
            "stage",
            "--core-sha",
            &git_head(&root)?,
        ])
        .arg("--counts-dir")
        .arg(&counts)
        .arg("--evidence")
        .arg(dir.path().join("evidence"))
        .env("PUBLISH_MANIFEST_DIR", &mdir)
        // The CLI refuses an unattended run without YES=1, and refuses YES=1 on 8453. This is the Twin chain only.
        .env("YES", "1")
        .env_remove("CONFIRM")
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| HarnessError::Rpc(format!("spawn publish-contracts: {e}")))?;
    if !status.status.success() {
        return Err(HarnessError::Rpc(format!(
            "vault stage failed: {}",
            String::from_utf8_lossy(&status.stderr)
        )));
    }
    let out = mdir.join("vault.json");
    let text = std::fs::read_to_string(&out)?;
    // Keep the manifest path for the record; the tempdir (keystores included) drops with this call.
    parse_manifest(&text, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_sheet_replaces_keys_and_never_duplicates_one() {
        let s = render_sheet(
            "A=1\n# note\nB=2\nTVL=old\n",
            &[("TVL".into(), "new".into()), ("C".into(), "3".into())],
        );
        assert_eq!(s.matches("TVL=").count(), 1);
        assert!(
            s.contains("TVL=new")
                && s.contains("C=3")
                && s.contains("A=1")
                && !s.contains("TVL=old")
        );
    }

    #[test]
    fn fragment_parser_reads_name_value_lines() {
        let f = parse_fragment(
            "# x\nADMIN_ADDRESS=0xabc\nVAULT_NAME=\"Robot Money USDC\"\nnot a line\n",
        );
        assert_eq!(f[0], ("ADMIN_ADDRESS".to_string(), "0xabc".to_string()));
        assert_eq!(f[1].1, "Robot Money USDC");
        assert_eq!(f.len(), 2);
    }

    #[test]
    fn transient_upstream_failures_are_recognised() {
        assert!(is_transient_upstream_failure(
            "failed to get account for 0x86AB: HTTP error 502 with body: <title>502 Bad Gateway</title>"
        ));
        assert!(!is_transient_upstream_failure(
            "Error: revert: InsufficientGas(1, 2)"
        ));
    }

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
