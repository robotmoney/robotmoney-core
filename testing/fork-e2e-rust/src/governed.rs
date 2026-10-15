//! Deploy a governed core contract from its Foundry artifact the way the stage scripts do (core 1808).
//!
//! Every core contract is an ERC-1967 UUPS proxy. Its implementation links external libraries
//! (`GovernedUpgrade` at least), so the artifact's creation code carries `__$...$__` placeholders,
//! and its constructor only disables initializers. A test deploy therefore:
//!
//! 1. deploys each linked library and writes its address over the placeholder,
//! 2. deploys the implementation,
//! 3. deploys an `ERC1967Proxy` whose constructor calls `initialize(<the old constructor args>,
//!    upgradeTimelock, FrozenAtDeploy)`.
//!
//! Every core `initialize` takes the old constructor arguments first and then
//! `(address upgradeTimelock_, UpgradeMode upgradeMode_)`, so callers pass the same ABI words they
//! passed to the constructor before. A test proxy is frozen at deploy: no test upgrades it, and
//! the timelock it names never acts.

use std::collections::HashMap;
use std::path::PathBuf;

use alloy_primitives::{Address, Bytes, U256};
use serde_json::Value;

use crate::{Account, HarnessError};

/// `UpgradeMode.FrozenAtDeploy` (`{Undeclared, Upgradeable, FrozenAtDeploy}`).
pub const UPGRADE_MODE_FROZEN_AT_DEPLOY: u8 = 2;

/// The nonzero upgrade timelock a test proxy is bound to. The proxy is frozen at deploy, so it never acts.
pub const TEST_UPGRADE_TIMELOCK: Address = Address::repeat_byte(0x71);

/// Gas for a library or implementation CREATE: a contract near the EIP-170 limit costs about 5.3M.
const CODE_DEPLOY_GAS: u64 = 12_000_000;

fn repo_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop();
    p.pop();
    p
}

/// The Foundry artifact `out/<sol_file>/<contract>.json`.
pub fn artifact(sol_file: &str, contract: &str) -> Result<Value, HarnessError> {
    let path = repo_root()
        .join("out")
        .join(sol_file)
        .join(format!("{contract}.json"));
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        HarnessError::Rpc(format!(
            "cannot read Foundry artifact {}; run `forge build` first: {e}",
            path.display()
        ))
    })?;
    serde_json::from_str(&raw)
        .map_err(|e| HarnessError::Rpc(format!("{} is not JSON: {e}", path.display())))
}

/// ABI words of a list of addresses, each left-padded to 32 bytes.
pub fn address_words(args: &[Address]) -> Vec<u8> {
    let mut out = Vec::with_capacity(32 * args.len());
    for a in args {
        out.extend_from_slice(&[0u8; 12]);
        out.extend_from_slice(a.as_slice());
    }
    out
}

/// Creation code of `sol_file:contract` with every library it links deployed by `deployer` and written in.
/// `deployed` caches libraries already deployed in this call tree (keyed by `file:name`).
fn linked_creation_code(
    deployer: &Account<'_>,
    sol_file: &str,
    contract: &str,
    deployed: &mut HashMap<String, Address>,
) -> Result<Vec<u8>, HarnessError> {
    let art = artifact(sol_file, contract)?;
    let mut hex_code = art["bytecode"]["object"]
        .as_str()
        .ok_or_else(|| HarnessError::Rpc(format!("{contract} artifact has no bytecode.object")))?
        .trim_start_matches("0x")
        .to_string();
    if let Some(refs) = art["bytecode"]["linkReferences"].as_object() {
        for (file, libs) in refs {
            let lib_sol = file.rsplit('/').next().unwrap_or(file);
            for (lib, positions) in libs.as_object().into_iter().flatten() {
                let key = format!("{file}:{lib}");
                let addr = match deployed.get(&key) {
                    Some(a) => *a,
                    None => {
                        let code = linked_creation_code(deployer, lib_sol, lib, deployed)?;
                        let a = deployer.deploy(Bytes::from(code), CODE_DEPLOY_GAS)?;
                        deployed.insert(key, a);
                        a
                    }
                };
                let addr_hex = hex::encode(addr.as_slice());
                for p in positions.as_array().into_iter().flatten() {
                    let start = p["start"].as_u64().unwrap_or_default() as usize * 2;
                    hex_code.replace_range(start..start + 40, &addr_hex);
                }
            }
        }
    }
    hex::decode(&hex_code).map_err(|e| {
        HarnessError::Rpc(format!(
            "{contract} creation code is not hex after linking: {e}"
        ))
    })
}

/// The 4-byte selector of the contract's single `initialize(...)`, read from the artifact.
fn initialize_selector(sol_file: &str, contract: &str) -> Result<[u8; 4], HarnessError> {
    let art = artifact(sol_file, contract)?;
    let ids = art["methodIdentifiers"].as_object().ok_or_else(|| {
        HarnessError::Rpc(format!("{contract} artifact has no methodIdentifiers"))
    })?;
    let mut found = ids.iter().filter(|(sig, _)| sig.starts_with("initialize("));
    let (_, id) = found
        .next()
        .ok_or_else(|| HarnessError::Rpc(format!("{contract} has no initialize")))?;
    if found.next().is_some() {
        return Err(HarnessError::Rpc(format!(
            "{contract} has more than one initialize"
        )));
    }
    let bytes = hex::decode(id.as_str().unwrap_or_default())
        .map_err(|e| HarnessError::Rpc(format!("{contract} initialize selector: {e}")))?;
    bytes
        .try_into()
        .map_err(|_| HarnessError::Rpc(format!("{contract} initialize selector is not 4 bytes")))
}

/// Deploy a governed core contract behind an `ERC1967Proxy`, initialized with `init_args` (the ABI words of
/// its old constructor arguments) plus the test timelock and `FrozenAtDeploy`. Returns the proxy address.
pub fn deploy_governed(
    deployer: &Account<'_>,
    sol_file: &str,
    contract: &str,
    init_args: &[u8],
    gas_limit: u64,
) -> Result<Address, HarnessError> {
    let mut libs = HashMap::new();
    let implementation_code = linked_creation_code(deployer, sol_file, contract, &mut libs)?;
    let implementation = deployer.deploy(
        Bytes::from(implementation_code),
        gas_limit.max(CODE_DEPLOY_GAS),
    )?;

    let mut init = initialize_selector(sol_file, contract)?.to_vec();
    init.extend_from_slice(init_args);
    init.extend_from_slice(&address_words(&[TEST_UPGRADE_TIMELOCK]));
    init.extend_from_slice(&U256::from(UPGRADE_MODE_FROZEN_AT_DEPLOY).to_be_bytes::<32>());

    // ERC1967Proxy(address implementation, bytes data)
    let mut proxy_code =
        linked_creation_code(deployer, "ERC1967Proxy.sol", "ERC1967Proxy", &mut libs)?;
    proxy_code.extend_from_slice(&address_words(&[implementation]));
    proxy_code.extend_from_slice(&U256::from(64u64).to_be_bytes::<32>());
    proxy_code.extend_from_slice(&U256::from(init.len()).to_be_bytes::<32>());
    let padded = init.len().div_ceil(32) * 32;
    init.resize(padded, 0);
    proxy_code.extend_from_slice(&init);
    deployer.deploy(Bytes::from(proxy_code), gas_limit)
}

/// [`deploy_governed`] for a contract whose old constructor took only addresses.
pub fn deploy_governed_with_address_args(
    deployer: &Account<'_>,
    sol_file: &str,
    contract: &str,
    args: &[Address],
    gas_limit: u64,
) -> Result<Address, HarnessError> {
    deploy_governed(
        deployer,
        sol_file,
        contract,
        &address_words(args),
        gas_limit,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn address_words_left_pads_each_address() {
        let a = Address::repeat_byte(0xab);
        let w = address_words(&[a, Address::ZERO]);
        assert_eq!(w.len(), 64);
        assert_eq!(&w[..12], &[0u8; 12]);
        assert_eq!(&w[12..32], a.as_slice());
        assert_eq!(&w[32..], &[0u8; 32]);
    }

    #[test]
    fn test_timelock_is_nonzero_and_mode_is_frozen() {
        assert_ne!(TEST_UPGRADE_TIMELOCK, Address::ZERO);
        assert_eq!(UPGRADE_MODE_FROZEN_AT_DEPLOY, 2);
    }
}
