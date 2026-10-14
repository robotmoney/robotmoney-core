// SPDX-License-Identifier: MIT
// Canonical: docs/operations/contract-release-runbooks.md — "Redeploy one vault into a live deployment"
//            publish-contracts/README.md — the `redeploy-vault` verb and the `redeploy-vault` govern row
//            robotmoney/robotmoney-monorepo issue 1796 (owner decision 2026-10-13, an experiment on Deploy 2)
//
// Deploys a NEW `ProtocolAssetVault` (rmPROTO) into a deployment whose timelock handover has already happened. It differs from
// `DeployProtocolAssetVault` in three ways, all of them forced by the handover:
//   1. It does NOT register the vault and does NOT touch router eligibility. The deployer holds no role on the registry any more: the
//      Safe, through the timelock, registers, migrates eligibility and retires the old vault (govern row `redeploy-vault`).
//   2. It hands the new vault over itself, the way `DeployTimelock` does for the four launch vaults: it links the registry (`setRegistry`),
//      moves EMERGENCY_ROLE to the independent emergency key, grants ADMIN_ROLE to the timelock and drops both roles from the deployer.
//   3. The vault is left paused. The govern row opens it in the same timelock batch that moves the router weights.
// Same vault class, same config file, same sheet inputs as the launch deploy: the new vault is configured exactly like the one it replaces.
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {DeployProtocolAssetVault} from "./DeployProtocolAssetVault.s.sol";

/// @dev Registry link surface of a vault: set once, ADMIN_ROLE only.
interface IVaultRegistryLink {
    function setRegistry(address newRegistry) external;
    function registry() external view returns (address);
}

/// @title RedeployProtocolAssetVault
/// @notice Single-vault redeploy of rmPROTO into a live deployment (issue 1796).
///
///         Required env vars (no defaults), the launch inputs plus two:
///           ADMIN_ADDRESS, SWAP_ROUTER, REGISTRY_ADDRESS, TVL_CAP, PER_DEPOSIT_CAP, EXIT_FEE_BPS, FEE_RECIPIENT,
///           NAV_DEVIATION_BPS, MIN_POOL_LIQUIDITY, DEPLOYMENT_OUT, EXPECTED_CHAIN_ID  as in `DeployProtocolAssetVault`
///           TIMELOCK_ADDRESS   the deployment's TimelockController. It must be a contract. It receives ADMIN_ROLE on the new vault.
///           EMERGENCY_ADDRESS  the deployment's independent emergency key. It receives EMERGENCY_ROLE on the new vault.
contract RedeployProtocolAssetVault is DeployProtocolAssetVault {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 internal constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    /// @notice Forge broadcast entrypoint.
    function run() external override returns (Deployed memory d) {
        _requireExpectedChain("");
        Params memory p = _readParamsFrom("");
        address timelock = _envAddressRequired("TIMELOCK_ADDRESS");
        address emergency = _envAddressRequired("EMERGENCY_ADDRESS");
        Cfg memory cfg = _parseCfg(vm.readFile(CONFIG_FILE), "assets");

        vm.startBroadcast();
        d = _redeploy(p, cfg, timelock, emergency);
        vm.stopBroadcast();

        _writeManifest(d, cfg);
        console2Log(d.vault);
    }

    /// @notice In-process variant for forge tests. No broadcast and no manifest. Every call runs as `p.admin` under a prank.
    function runRedeployInProcess(
        Params memory p,
        string memory json,
        address timelock,
        address emergency
    ) external returns (Deployed memory d) {
        Cfg memory cfg = _parseCfg(json, "assets");
        vm.startPrank(p.admin);
        d = _redeploy(p, cfg, timelock, emergency);
        vm.stopPrank();
    }

    /// @dev Deploy and configure exactly like the launch vault, check the library link, then hand the vault over. The caller owns the
    ///      broadcast (or prank) context: every call is made as `p.admin`.
    function _redeploy(Params memory p, Cfg memory cfg, address timelock, address emergency)
        internal
        returns (Deployed memory d)
    {
        require(
            timelock != address(0) && timelock.code.length != 0,
            "TIMELOCK_ADDRESS is not a contract"
        );
        require(p.registry.code.length != 0, "REGISTRY_ADDRESS has no code");
        require(emergency != address(0), "EMERGENCY_ADDRESS=0");
        require(emergency != p.admin, "EMERGENCY_ADDRESS == deployer");
        require(timelock != p.admin, "TIMELOCK_ADDRESS == deployer");
        // The binding target must be the deployment's real registry: a contract that answers hasRole and already gives the timelock ADMIN_ROLE. A wrong
        // address (another contract, a registry the timelock does not govern) reverts here, before anything is deployed. The timelock is never used to
        // grant itself a role: the deployer, still the vault's admin, grants it (_handOver).
        require(
            IAccessControl(p.registry).hasRole(ADMIN_ROLE, timelock),
            "timelock lacks ADMIN_ROLE on REGISTRY_ADDRESS"
        );

        d = _deployConfigured(p, cfg);
        _assertTickMathLinkIntegrity(d.vault, p.tvlCap);
        _handOver(d.vault, p.registry, p.admin, timelock, emergency);
        // Left unregistered on purpose: only the Safe, through the timelock, registers it (govern row `redeploy-vault`).
        d.registered = false;
    }

    /// @dev Mirrors the per-vault block of `DeployTimelock._deployAndWire`: link the registry while the deployer still holds ADMIN_ROLE,
    ///      move EMERGENCY_ROLE to the emergency key, then grant ADMIN_ROLE to the timelock and revoke it from the deployer. Every step is
    ///      read back, so a half-finished handover reverts the whole deploy.
    function _handOver(
        address vault,
        address registry,
        address deployer,
        address timelock,
        address emergency
    ) internal {
        IVaultRegistryLink(vault).setRegistry(registry);
        require(IVaultRegistryLink(vault).registry() == registry, "vault registry link not set");

        IAccessControl ac = IAccessControl(vault);
        ac.grantRole(EMERGENCY_ROLE, emergency);
        require(
            ac.hasRole(EMERGENCY_ROLE, emergency), "emergency key missing EMERGENCY_ROLE on vault"
        );
        ac.revokeRole(EMERGENCY_ROLE, deployer);
        require(!ac.hasRole(EMERGENCY_ROLE, deployer), "deployer still has EMERGENCY_ROLE on vault");

        ac.grantRole(ADMIN_ROLE, timelock);
        require(ac.hasRole(ADMIN_ROLE, timelock), "timelock missing ADMIN_ROLE on vault");
        ac.revokeRole(ADMIN_ROLE, deployer);
        require(!ac.hasRole(ADMIN_ROLE, deployer), "deployer still has ADMIN_ROLE on vault");
    }
}
