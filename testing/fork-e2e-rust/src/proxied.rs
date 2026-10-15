//! Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §1, §3 (QA plan v1 P1, issue 1808).
//!
//! The nine stateful core contracts run behind their own `ERC1967Proxy`: the implementation has a
//! constructor with no arguments that locks it, and the proxy's constructor calls `initialize` in
//! the deployment transaction. A fork test that deploys one of them from the Foundry artifacts
//! (`out/`) therefore deploys the implementation, linking its CREATE2 libraries first, then the
//! proxy with the `initialize` call data. These helpers do that, so a test keeps its one-line
//! "deploy the registry / router / gateway" call.
//!
//! The upgrade authority must be a contract (ADR-0014 §4: in a deployment it is the timelock). A
//! fork test that never upgrades names a one-byte stub contract it deploys itself.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use alloy_primitives::{Address, Bytes};
use alloy_sol_types::{sol, SolCall, SolValue};

use crate::{Account, HarnessError};

/// `GovernedUpgrade.UpgradeMode.Upgradeable`.
pub const MODE_UPGRADEABLE: u8 = 1;

/// Deploy gas for an implementation, a library or a proxy. The largest implementation is about
/// 23 KB of runtime (ADR-0014 §9), well inside this.
const DEPLOY_GAS: u64 = 12_000_000;

sol! {
    #[allow(missing_docs)]
    interface IVaultRegistryInit {
        function initialize(address admin, address upgradeAuthority, uint8 mode) external;
    }
    #[allow(missing_docs)]
    interface IPortfolioRouterInit {
        function initialize(address usdc, address registry, address admin, address upgradeAuthority, uint8 mode) external;
    }
    #[allow(missing_docs)]
    interface IRobotMoneyGatewayInit {
        function initialize(address usdc, address vault, address admin, address pauser, address router, address upgradeAuthority, uint8 mode) external;
    }
    #[allow(missing_docs)]
    interface IInvestmentCommitteePolicyInit {
        function initialize(address admin, address gateway, address upgradeAuthority, uint8 mode) external;
    }
    #[allow(missing_docs)]
    interface IConsensusRecommendationReceiptInit {
        function initialize(address admin, address gateway, address icPolicy, address upgradeAuthority, uint8 mode) external;
    }
    #[allow(missing_docs)]
    interface IBasketVaultInit {
        function initialize(address usdc, address swapRouter, uint256 tvlCap, uint256 perDepositCap, uint256 exitFeeBps, address feeRecipient, address admin, address emergencyResponder, address upgradeAuthority, uint8 mode) external;
    }
}

fn repo_root() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop();
    p.pop();
    p
}

fn artifact(sol_file: &str, contract: &str) -> Result<serde_json::Value, HarnessError> {
    let path = repo_root()
        .join("out")
        .join(sol_file)
        .join(format!("{contract}.json"));
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        HarnessError::Rpc(format!(
            "cannot read Foundry artefact {}; run `forge build` first: {e}",
            path.display()
        ))
    })?;
    serde_json::from_str(&raw)
        .map_err(|e| HarnessError::Rpc(format!("{} is not JSON: {e}", path.display())))
}

/// Creation code of `contract`, with every linked library deployed once (cached in `libs`, keyed
/// `path/File.sol:Name`) and its address written over the `__$…$__` placeholder.
fn linked_creation_code(
    deployer: &Account<'_>,
    sol_file: &str,
    contract: &str,
    libs: &mut HashMap<String, Address>,
) -> Result<Vec<u8>, HarnessError> {
    let a = artifact(sol_file, contract)?;
    let mut code = a["bytecode"]["object"]
        .as_str()
        .ok_or_else(|| HarnessError::Rpc(format!("{contract} artefact has no bytecode.object")))?
        .trim_start_matches("0x")
        .to_string();
    if let Some(refs) = a["bytecode"]["linkReferences"].as_object() {
        for (file, in_file) in refs {
            let Some(in_file) = in_file.as_object() else {
                continue;
            };
            for (lib, positions) in in_file {
                let key = format!("{file}:{lib}");
                let addr = match libs.get(&key) {
                    Some(addr) => *addr,
                    None => {
                        let lib_file = Path::new(file)
                            .file_name()
                            .and_then(|f| f.to_str())
                            .unwrap_or(file.as_str())
                            .to_string();
                        let lib_code = linked_creation_code(deployer, &lib_file, lib, libs)?;
                        let addr = deployer.deploy(Bytes::from(lib_code), DEPLOY_GAS)?;
                        libs.insert(key, addr);
                        addr
                    }
                };
                let addr_hex = hex::encode(addr.as_slice());
                for pos in positions.as_array().into_iter().flatten() {
                    let start = pos["start"].as_u64().unwrap_or(0) as usize * 2;
                    code.replace_range(start..start + 40, &addr_hex);
                }
            }
        }
    }
    hex::decode(&code)
        .map_err(|e| HarnessError::Rpc(format!("{contract} bytecode is not valid hex: {e}")))
}

/// A one-byte contract (runtime `0x00`): the upgrade authority of a proxy a fork test never
/// upgrades. `initialize` refuses an authority without code (ADR-0014 §4).
pub fn upgrade_authority_stub(deployer: &Account<'_>) -> Result<Address, HarnessError> {
    // PUSH1 1, PUSH1 12, PUSH1 0, CODECOPY, PUSH1 1, PUSH1 0, RETURN, then the runtime byte 0x00.
    let initcode = hex::decode("6001600c60003960016000f300").expect("static initcode");
    deployer.deploy(Bytes::from(initcode), 200_000)
}

/// Deploy `contract`'s implementation (libraries linked) and an `ERC1967Proxy` over it whose
/// constructor runs `init` (the `initialize` call data). Returns the proxy.
pub fn deploy_proxied(
    deployer: &Account<'_>,
    sol_file: &str,
    contract: &str,
    init: Vec<u8>,
) -> Result<Address, HarnessError> {
    let mut libs = HashMap::new();
    let implementation = deployer.deploy(
        Bytes::from(linked_creation_code(
            deployer, sol_file, contract, &mut libs,
        )?),
        DEPLOY_GAS,
    )?;
    let mut proxy_code =
        linked_creation_code(deployer, "ERC1967Proxy.sol", "ERC1967Proxy", &mut libs)?;
    proxy_code.extend_from_slice(&(implementation, Bytes::from(init)).abi_encode_params());
    deployer.deploy(Bytes::from(proxy_code), DEPLOY_GAS)
}

/// `VaultRegistry` behind its proxy, `admin` holding `ADMIN_ROLE`.
pub fn deploy_vault_registry(
    deployer: &Account<'_>,
    admin: Address,
) -> Result<Address, HarnessError> {
    let authority = upgrade_authority_stub(deployer)?;
    let init = IVaultRegistryInit::initializeCall {
        admin,
        upgradeAuthority: authority,
        mode: MODE_UPGRADEABLE,
    }
    .abi_encode();
    deploy_proxied(deployer, "VaultRegistry.sol", "VaultRegistry", init)
}

/// `PortfolioRouter` behind its proxy, `admin` holding the four router roles.
pub fn deploy_portfolio_router(
    deployer: &Account<'_>,
    usdc: Address,
    registry: Address,
    admin: Address,
) -> Result<Address, HarnessError> {
    let authority = upgrade_authority_stub(deployer)?;
    let init = IPortfolioRouterInit::initializeCall {
        usdc,
        registry,
        admin,
        upgradeAuthority: authority,
        mode: MODE_UPGRADEABLE,
    }
    .abi_encode();
    deploy_proxied(deployer, "PortfolioRouter.sol", "PortfolioRouter", init)
}

/// `RobotMoneyGateway` behind its proxy. `router` may be zero (single-vault mode).
pub fn deploy_robot_money_gateway(
    deployer: &Account<'_>,
    usdc: Address,
    vault: Address,
    admin: Address,
    pauser: Address,
    router: Address,
) -> Result<Address, HarnessError> {
    let authority = upgrade_authority_stub(deployer)?;
    let init = IRobotMoneyGatewayInit::initializeCall {
        usdc,
        vault,
        admin,
        pauser,
        router,
        upgradeAuthority: authority,
        mode: MODE_UPGRADEABLE,
    }
    .abi_encode();
    deploy_proxied(deployer, "RobotMoneyGateway.sol", "RobotMoneyGateway", init)
}

/// One basket vault kind (`ProtocolAssetVault`, `AgentTokenVault` or `RwaBasketVault`) behind its
/// proxy, initialized through `BasketVault.initialize` (ADR-0014 §3: the three kinds share it). Its
/// linked libraries (BasketSwapOps, BasketViews, BasketAssetConfigGuard, TwapTickMath, TickMath)
/// are deployed and linked first.
#[allow(clippy::too_many_arguments)]
pub fn deploy_basket_vault(
    deployer: &Account<'_>,
    contract: &str,
    usdc: Address,
    swap_router: Address,
    tvl_cap: alloy_primitives::U256,
    per_deposit_cap: alloy_primitives::U256,
    exit_fee_bps: alloy_primitives::U256,
    fee_recipient: Address,
    admin: Address,
    emergency_responder: Address,
) -> Result<Address, HarnessError> {
    let authority = upgrade_authority_stub(deployer)?;
    let init = IBasketVaultInit::initializeCall {
        usdc,
        swapRouter: swap_router,
        tvlCap: tvl_cap,
        perDepositCap: per_deposit_cap,
        exitFeeBps: exit_fee_bps,
        feeRecipient: fee_recipient,
        admin,
        emergencyResponder: emergency_responder,
        upgradeAuthority: authority,
        mode: MODE_UPGRADEABLE,
    }
    .abi_encode();
    deploy_proxied(deployer, &format!("{contract}.sol"), contract, init)
}

/// `InvestmentCommitteePolicy` behind its proxy.
pub fn deploy_investment_committee_policy(
    deployer: &Account<'_>,
    admin: Address,
    gateway: Address,
) -> Result<Address, HarnessError> {
    let authority = upgrade_authority_stub(deployer)?;
    let init = IInvestmentCommitteePolicyInit::initializeCall {
        admin,
        gateway,
        upgradeAuthority: authority,
        mode: MODE_UPGRADEABLE,
    }
    .abi_encode();
    deploy_proxied(
        deployer,
        "InvestmentCommitteePolicy.sol",
        "InvestmentCommitteePolicy",
        init,
    )
}

/// `ConsensusRecommendationReceipt` behind its proxy.
pub fn deploy_consensus_recommendation_receipt(
    deployer: &Account<'_>,
    admin: Address,
    gateway: Address,
    ic_policy: Address,
) -> Result<Address, HarnessError> {
    let authority = upgrade_authority_stub(deployer)?;
    let init = IConsensusRecommendationReceiptInit::initializeCall {
        admin,
        gateway,
        icPolicy: ic_policy,
        upgradeAuthority: authority,
        mode: MODE_UPGRADEABLE,
    }
    .abi_encode();
    deploy_proxied(
        deployer,
        "ConsensusRecommendationReceipt.sol",
        "ConsensusRecommendationReceipt",
        init,
    )
}
