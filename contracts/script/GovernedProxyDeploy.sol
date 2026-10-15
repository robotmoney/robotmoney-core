// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §3 (mechanism), §4 (authority),
//            §5 (release modes)
// (See also: contracts/lib/GovernedUpgrade.sol; contracts/script/DeployTimelock.s.sol — `runAuthority`
//  deploys the timelock every proxy names as its upgrade authority)
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

import {GovernedUpgrade} from "../lib/GovernedUpgrade.sol";
import {ExpectedChainGuard} from "./ExpectedChainGuard.sol";

/// @title GovernedProxyDeploy
/// @notice Shared proxy deployment for every stage script that deploys a proxied contract
///         (ADR-0014 §1): deploy the implementation, then an `ERC1967Proxy` whose constructor calls
///         `initialize` in the same transaction, so no public call can ever reach an uninitialized
///         proxy. Every proxy names the deployment's timelock as its upgrade authority and states
///         its release mode; the deployer never holds an upgrade path, not even for a moment.
/// @dev Broadcast entry points read `<prefix>UPGRADE_AUTHORITY` (an address with code: the timelock
///      `DeployTimelock.runAuthority` deployed first) and `<prefix>UPGRADE_MODE` (`upgradeable` or
///      `frozen-at-deploy`), both required on every chain: a deployment must state its mode.
///      In-process entry points (forge tests only, nothing broadcast) use `setInProcessUpgradeConfig`,
///      or, when it was never called, this script contract as the authority in `Upgradeable` mode.
///      After each proxy is deployed, `_deployProxy` reads it back: implementation slot, zero
///      ERC-1967 admin and beacon slots, authority and frozen bit.
abstract contract GovernedProxyDeploy is ExpectedChainGuard {
    /// @notice Upgrade authority and release mode the next proxy is born with.
    struct UpgradeConfig {
        address authority;
        GovernedUpgrade.UpgradeMode mode;
    }

    /// @dev The config `_deployProxy` uses. Every entry point sets it before deploying.
    UpgradeConfig internal _upgrade;

    /// @dev Test seam for in-process entry points. Zero authority means "use the defaults".
    UpgradeConfig private _inProcessUpgrade;

    /// @notice Test seam: the upgrade authority and mode the in-process entry points use. Forge
    ///         tests call it before an in-process run; a broadcast run never reads it.
    function setInProcessUpgradeConfig(address authority, GovernedUpgrade.UpgradeMode mode)
        external
    {
        _inProcessUpgrade = UpgradeConfig({authority: authority, mode: mode});
    }

    /// @dev Broadcast runs: read the authority and the mode from the environment, strictly.
    function _useEnvUpgradeConfig(string memory prefix) internal {
        address authority = _envAddressRequired(string.concat(prefix, "UPGRADE_AUTHORITY"));
        require(
            authority.code.length > 0,
            "UPGRADE_AUTHORITY has no code: deploy the timelock (DeployTimelock.runAuthority) first"
        );
        _upgrade = UpgradeConfig({
            authority: authority,
            mode: parseUpgradeMode(_envStringRequired(string.concat(prefix, "UPGRADE_MODE")))
        });
    }

    /// @dev In-process runs (forge tests): the configured seam, else this script as the authority.
    function _useInProcessUpgradeConfig() internal {
        UpgradeConfig memory c = _inProcessUpgrade;
        if (c.authority == address(0)) {
            c = UpgradeConfig({
                authority: address(this), mode: GovernedUpgrade.UpgradeMode.Upgradeable
            });
        }
        _upgrade = c;
    }

    /// @notice `upgradeable` or `frozen-at-deploy`; anything else (including `unset`) reverts.
    function parseUpgradeMode(string memory raw) public pure returns (GovernedUpgrade.UpgradeMode) {
        bytes32 h = keccak256(bytes(raw));
        if (h == keccak256("upgradeable")) return GovernedUpgrade.UpgradeMode.Upgradeable;
        if (h == keccak256("frozen-at-deploy")) return GovernedUpgrade.UpgradeMode.FrozenAtDeploy;
        revert("UPGRADE_MODE must be upgradeable or frozen-at-deploy");
    }

    /// @notice Manifest spelling of a mode.
    function upgradeModeName(GovernedUpgrade.UpgradeMode mode) public pure returns (string memory) {
        if (mode == GovernedUpgrade.UpgradeMode.Upgradeable) return "upgradeable";
        if (mode == GovernedUpgrade.UpgradeMode.FrozenAtDeploy) return "frozen-at-deploy";
        return "unset";
    }

    /// @dev Deploy an `ERC1967Proxy` over `implementation` whose constructor runs `initData` (the
    ///      `initialize` call), then read the proxy back. `initData` must name `_upgrade`'s authority
    ///      and mode; the read-back proves it did.
    function _deployProxy(address implementation, bytes memory initData)
        internal
        returns (address proxy)
    {
        proxy = address(new ERC1967Proxy(implementation, initData));
        require(
            address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))))
                == implementation,
            "proxy: implementation slot is not the implementation"
        );
        require(vm.load(proxy, ERC1967Utils.ADMIN_SLOT) == bytes32(0), "proxy: admin slot set");
        require(vm.load(proxy, ERC1967Utils.BEACON_SLOT) == bytes32(0), "proxy: beacon slot set");
        require(
            GovernedUpgrade(proxy).upgradeAuthority() == _upgrade.authority,
            "proxy: upgrade authority is not the configured timelock"
        );
        require(
            GovernedUpgrade(proxy).upgradesFrozen()
                == (_upgrade.mode == GovernedUpgrade.UpgradeMode.FrozenAtDeploy),
            "proxy: frozen state does not match UPGRADE_MODE"
        );
    }

    /// @dev ADR-0014 §8: the storage-layout identifier of a proxied contract, the sha256 of its committed
    ///      normalized layout snapshot (`contracts/test/fixtures/storage-layout/<artifact>.json`, the file
    ///      `scripts/ci/check-storage-layout.sh` gates in CI). Written into the stage manifest next to the
    ///      implementation, so the deployment records which layout the implementation it deployed has. The
    ///      verifier compares it with the snapshot of the checkout it runs from. Zero when the file is absent.
    function _layoutId(string memory artifact) internal view returns (bytes32) {
        string memory p =
            string.concat("contracts/test/fixtures/storage-layout/", artifact, ".json");
        if (!vm.exists(p)) return bytes32(0);
        return sha256(bytes(vm.readFile(p)));
    }

    /// @dev The ERC-1967 implementation of `proxy`, for manifests and logs.
    function _implementationOf(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }
}
