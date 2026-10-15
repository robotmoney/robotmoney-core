// SPDX-License-Identifier: MIT
// Canonical: docs/operations/contract-release-runbooks.md — "Redeploy one vault into a live deployment"
//            publish-contracts/README.md — the `redeploy-vault` verb and the `redeploy-vault` govern row
//            robotmoney/robotmoney-monorepo issue 1796 (owner decision 2026-10-13, an experiment on Deploy 2)
//
// Deploys a NEW `ProtocolAssetVault` (rmPROTO) into a deployment whose timelock handover has already happened. It differs from
// `DeployProtocolAssetVault` in three ways, all of them forced by the handover:
//   1. It does NOT register the vault, does NOT link the registry and does NOT touch router eligibility. The deployer holds no role on
//      the registry any more: the Safe, through the timelock, links the registry (the set-once ADMIN_ROLE link, which the timelock holds
//      after step 2), registers, migrates eligibility and retires the old vault, all in ONE batch (govern row `redeploy-vault`). Only
//      `DeployTimelock` links the registry from a script (core S5, `scripts/ci/check-set-registry-owner.ts`).
//   2. It hands the new vault over itself, the way `DeployTimelock` does for the four launch vaults: it moves EMERGENCY_ROLE to the
//      independent emergency key, grants ADMIN_ROLE to the timelock and drops both roles from the deployer.
//   3. The vault is paused right after it is created, before its first asset is added (QA plan v1 E3), so no direct deposit can land
//      while it is configured, and it is left paused. The govern row opens it in the same timelock batch that moves the router weights
//      and copies the old vault's router cap to it.
// Same vault class, same config file, same sheet inputs as the launch deploy: the new vault is configured exactly like the one it replaces.
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {DeployProtocolAssetVault} from "./DeployProtocolAssetVault.s.sol";
import {GovernedUpgrade} from "../lib/GovernedUpgrade.sol";

/// @dev Read side of a vault's registry link. The link itself is set by the timelock in the govern batch, never here.
interface IVaultRegistryView {
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
///           UPGRADE_MODE       `upgradeable` or `frozen-at-deploy` (ADR-0014 §5). The new vault's upgrade authority is
///                              TIMELOCK_ADDRESS itself (ADR-0014 §4), so no separate UPGRADE_AUTHORITY is read.
///         REGISTRY_ADDRESS is read and checked for code only: the vault is left unlinked for the govern batch.
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
        _upgrade = UpgradeConfig({
            authority: timelock, mode: parseUpgradeMode(_envStringRequired("UPGRADE_MODE"))
        });

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
        _upgrade =
            UpgradeConfig({authority: timelock, mode: GovernedUpgrade.UpgradeMode.Upgradeable});
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

        d = _deployConfigured({p: p, cfg: cfg, pauseBeforeAssets: true});
        _assertTickMathLinkIntegrity(d.vault, p.tvlCap);
        _handOver(d.vault, p.admin, timelock, emergency);
        // Left unregistered on purpose: only the Safe, through the timelock, registers it (govern row `redeploy-vault`).
        d.registered = false;
    }

    /// @dev Mirrors the role block of `DeployTimelock._deployAndWire` without the registry link: move EMERGENCY_ROLE to the emergency
    ///      key, then grant ADMIN_ROLE to the timelock and revoke it from the deployer. The registry link is the timelock's first call in
    ///      the govern batch, so the vault must leave here unlinked. Every step is read back, so a half-finished handover reverts the
    ///      whole deploy.
    function _handOver(address vault, address deployer, address timelock, address emergency)
        internal
    {
        require(
            IVaultRegistryView(vault).registry() == address(0),
            "vault registry link is the govern batch's, not the deploy's"
        );

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
