// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §3-§6
// (See also: docs/technical/contract-upgradeability-plan.md;
//            docs/technical/smart-contract-invariants.md — UPG-1..UPG-8;
//            contracts/ProposerFloorTimelock.sol — the only upgrade authority;
//            contracts/test/GovernedUpgradeLifecycle.t.sol — pins the slot below)
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

/// @title GovernedUpgrade
/// @notice The one upgrade base every proxied Robot Money implementation inherits (ADR-0014 §3).
///         OZ `UUPSUpgradeable` as shipped, with one fixed upgrade authority and a one-way freeze.
///
///         - **Authority.** One address, the deployment's `ProposerFloorTimelock`, stored once by
///           `__GovernedUpgrade_init`. It must have code. No setter exists and no role confers
///           upgrade power: holding `ADMIN_ROLE`, `DEFAULT_ADMIN_ROLE` or any other role grants
///           none. The upgrade path is Safe → timelock (delay) → `upgradeToAndCall`.
///         - **Freeze.** `freezeUpgrades` sets one bit that nothing clears. From then on
///           `_authorizeUpgrade` always reverts, so no later code can ever be installed that could
///           clear it. The freeze names the reviewed implementation and its code hash, so a freeze
///           queued for implementation A reverts if an upgrade to B executed first.
///         - **Withdrawals.** Nothing here reads the frozen bit outside `_authorizeUpgrade` and
///           `freezeUpgrades`. There is no pause, no `whenNotFrozen` modifier and no hook on
///           transfers or redemptions (ADR-0014 §6): a freeze never touches withdrawal rights.
///
///         The two fields live in the ERC-7201 namespace `robotmoney.storage.GovernedUpgrade`, so
///         they never collide with the implementation's linear layout. `GovernedUpgradeLifecycle.t.sol`
///         recomputes the slot from the namespace string and reads it with `vm.load`.
abstract contract GovernedUpgrade is Initializable, UUPSUpgradeable {
    /// @notice How a proxy is born. Initialized state of one artifact, never a build variant.
    /// @dev `Unset` makes the initializer revert, so every deployment states its mode.
    ///      `Upgradeable`: upgrades and one freeze, each Safe → timelock.
    ///      `FrozenAtDeploy`: frozen inside the deployment transaction; nothing is allowed later.
    enum UpgradeMode {
        Unset,
        Upgradeable,
        FrozenAtDeploy
    }

    /// @custom:storage-location erc7201:robotmoney.storage.GovernedUpgrade
    struct GovernedUpgradeStorage {
        address authority;
        bool frozen;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("robotmoney.storage.GovernedUpgrade")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant GOVERNED_UPGRADE_STORAGE_LOCATION =
        0x5f8c19f69998101f56563e0013e2ccd167eee33eac647374045191b3bd187600;

    /// @notice The initializer was called with `UpgradeMode.Unset`.
    error UpgradeModeUnset();
    /// @notice The named upgrade authority has no code. It must be the deployment's timelock.
    /// @param authority The address that was refused.
    error UpgradeAuthorityNotContract(address authority);
    /// @notice An upgrade or freeze was attempted by an address other than the upgrade authority.
    /// @param caller The refused caller.
    error UpgradeNotAuthorized(address caller);
    /// @notice The proxy is frozen: no upgrade can ever run again.
    error UpgradesAreFrozen();
    /// @notice `freezeUpgrades` named an implementation or code hash other than the live one.
    /// @param live         The live ERC-1967 implementation.
    /// @param liveCodeHash Its runtime code hash.
    error FreezeTargetMismatch(address live, bytes32 liveCodeHash);

    /// @notice The proxy froze. No upgrade can run from now on.
    /// @param proxy          The frozen proxy (`address(this)`).
    /// @param implementation The implementation the proxy is frozen on.
    /// @param codeHash       That implementation's runtime code hash.
    event UpgradesFrozen(address indexed proxy, address indexed implementation, bytes32 codeHash);

    function _governedUpgradeStorage() private pure returns (GovernedUpgradeStorage storage $) {
        // solhint-disable-next-line no-inline-assembly
        assembly {
            $.slot := GOVERNED_UPGRADE_STORAGE_LOCATION
        }
    }

    /// @dev Store the upgrade authority once and apply the release mode. The only writer of the
    ///      namespace besides `freezeUpgrades`; runs once per proxy, inside its deployment transaction.
    ///      Write-once (UPG-3): a later implementation's `reinitializer(n)` is also `onlyInitializing`,
    ///      so without the zero check it could call this and rotate the authority. A second call
    ///      reverts `InvalidInitialization`, the error `Initializable` already declares, so no ABI grows.
    /// @param authority The deployment's `ProposerFloorTimelock`. Must have code.
    /// @param mode      `Upgradeable` or `FrozenAtDeploy`. `Unset` reverts.
    function __GovernedUpgrade_init(address authority, UpgradeMode mode) internal onlyInitializing {
        GovernedUpgradeStorage storage $ = _governedUpgradeStorage();
        if ($.authority != address(0)) revert InvalidInitialization();
        if (mode == UpgradeMode.Unset) revert UpgradeModeUnset();
        if (authority.code.length == 0) revert UpgradeAuthorityNotContract(authority);
        $.authority = authority;
        if (mode == UpgradeMode.FrozenAtDeploy) _freeze($);
    }

    /// @dev Pair with every `reinitializer(n)` (ADR-0014 §3): `onlyUpgradeAuthority reinitializer(n)`.
    ///      Inside a timelock-executed `upgradeToAndCall` the reinitializer runs by DELEGATECALL with
    ///      the timelock as `msg.sender`, so it passes. An upgrade installed with empty data leaves the
    ///      reinitializer pending: without this check anyone could call it first. With it, only a later
    ///      timelock operation can. The layout gate (`scripts/ci/storage_layout_gate.py`) fails a
    ///      production `reinitializer(` that lacks it.
    modifier onlyUpgradeAuthority() {
        if (msg.sender != _governedUpgradeStorage().authority) {
            revert UpgradeNotAuthorized(msg.sender);
        }
        _;
    }

    /// @notice The one address that may upgrade or freeze this proxy (the deployment's timelock).
    function upgradeAuthority() external view returns (address) {
        return _governedUpgradeStorage().authority;
    }

    /// @notice True once the proxy is frozen. It never becomes false again.
    function upgradesFrozen() external view returns (bool) {
        return _governedUpgradeStorage().frozen;
    }

    /// @notice Freeze this proxy forever on the live implementation. Upgrade authority only.
    /// @dev Reverts `FreezeTargetMismatch` unless the live ERC-1967 implementation and its code hash
    ///      equal the arguments, so a freeze scheduled for one reviewed implementation can never lock
    ///      in another. Reverts `UpgradesAreFrozen` when already frozen.
    /// @param expectedImplementation The implementation the freeze was reviewed against.
    /// @param expectedCodeHash       Its runtime code hash.
    function freezeUpgrades(address expectedImplementation, bytes32 expectedCodeHash)
        external
        onlyProxy
    {
        GovernedUpgradeStorage storage $ = _governedUpgradeStorage();
        if (msg.sender != $.authority) revert UpgradeNotAuthorized(msg.sender);
        if ($.frozen) revert UpgradesAreFrozen();
        address live = ERC1967Utils.getImplementation();
        if (live != expectedImplementation || live.codehash != expectedCodeHash) {
            revert FreezeTargetMismatch(live, live.codehash);
        }
        _freeze($);
    }

    function _freeze(GovernedUpgradeStorage storage $) private {
        $.frozen = true;
        address live = ERC1967Utils.getImplementation();
        emit UpgradesFrozen(address(this), live, live.codehash);
    }

    /// @inheritdoc UUPSUpgradeable
    /// @dev Only the stored authority, and never once frozen.
    function _authorizeUpgrade(address) internal view override {
        GovernedUpgradeStorage storage $ = _governedUpgradeStorage();
        if (msg.sender != $.authority) revert UpgradeNotAuthorized(msg.sender);
        if ($.frozen) revert UpgradesAreFrozen();
    }
}
