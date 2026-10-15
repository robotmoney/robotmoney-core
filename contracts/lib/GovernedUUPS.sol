// SPDX-License-Identifier: MIT
// Canonical: docs/technical/contract-upgradeability-plan.md — Mechanism and authority
// (See also: docs/adr/ADR-0011-governed-uups-upgrades-and-freeze.md; issue 1808)
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC1822Proxiable} from "@openzeppelin/contracts/interfaces/draft-IERC1822.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

/// @title GovernedUpgrade
/// @notice The one implementation of the upgrade and freeze rules shared by every proxied
///         Robot Money core contract (issue 1808). It is an externally linked library: its
///         code runs by DELEGATECALL in the proxy's own storage, with the original
///         `msg.sender`. Keeping it out of each implementation keeps the EIP-170 tight core
///         contracts (gateway, vault family) deployable. `GovernedUUPS` forwards the exact
///         calldata of `upgradeToAndCall` and `freezeUpgrades` here, so the selectors match.
///
///         Storage lives in the ERC-7201 namespace `robotmoney.storage.GovernedUUPS`, so it
///         cannot collide with an inheriting contract's sequential layout:
///
///         - `upgradeTimelock`: the Safe-controlled `TimelockController`. The ONLY account
///           that can upgrade or freeze. Written once at initialization, no setter. It is
///           not an AccessControl role, so no grant, revoke or renounce can give or take it.
///         - `upgradesFrozen`: one-way. Nothing clears it. Once set, every new or previously
///           queued upgrade reverts and the ERC-1967 implementation slot is never written
///           again.
library GovernedUpgrade {
    /// @custom:storage-location erc7201:robotmoney.storage.GovernedUUPS
    struct Layout {
        address upgradeTimelock;
        bool upgradesFrozen;
    }

    /// @dev OpenZeppelin `Initializable` v5 storage (erc7201:openzeppelin.storage.Initializable).
    struct InitializableLayout {
        uint64 initialized;
        bool initializing;
    }

    // keccak256(abi.encode(uint256(keccak256("robotmoney.storage.GovernedUUPS")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant STORAGE =
        0x5c8ca260067dd2f24fedefaba3540fc9ead4f7cccd06bdb84380e8538f058700;

    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.Initializable")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant INITIALIZABLE_STORAGE =
        0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00;

    /// @notice Release mode values (`GovernedUUPS.UpgradeMode`).
    uint8 internal constant MODE_UPGRADEABLE = 1;
    uint8 internal constant MODE_FROZEN_AT_DEPLOY = 2;

    /// @notice Upgrades on this proxy are permanently disabled.
    event UpgradesFrozen(address indexed proxy, address indexed implementation, bytes32 codeHash);
    /// @notice OpenZeppelin `Initializable.Initialized`.
    event Initialized(uint64 version);

    error NotUpgradeTimelock(address caller);
    error UpgradesAreFrozen();
    error FreezeTargetMismatch(address liveImplementation, bytes32 liveCodeHash);
    error InvalidUpgradeTimelock(address timelock);
    error UpgradeModeUndeclared();
    /// @notice OpenZeppelin `Initializable.InvalidInitialization`.
    error InvalidInitialization();

    function layout() internal pure returns (Layout storage $) {
        assembly {
            $.slot := STORAGE
        }
    }

    /// @notice Record the upgrade authority and apply the release mode. The caller (the
    ///         inheriting contract's initializer) guarantees this runs once.
    /// @dev The timelock is a deterministic CREATE2 address bound to the Safe (see
    ///      contracts/script/UpgradeAuthority.sol). It may not have code yet during the deploy:
    ///      nothing but that exact Safe-proposer timelock can ever exist at that address, so
    ///      there is no interim authority. The timelock stage verifies its code and Safe
    ///      ownership, and that every proxy names it, before deposits open.
    function init(address timelock, uint8 mode) external {
        // Exactly once per proxy: a later reinitializer cannot re-run it to name another
        // authority (and nothing here ever writes `upgradesFrozen = false`).
        if (layout().upgradeTimelock != address(0)) revert InvalidInitialization();
        if (timelock == address(0)) revert InvalidUpgradeTimelock(timelock);
        if (mode != MODE_UPGRADEABLE && mode != MODE_FROZEN_AT_DEPLOY) {
            revert UpgradeModeUndeclared();
        }
        Layout storage $ = layout();
        $.upgradeTimelock = timelock;
        if (mode == MODE_FROZEN_AT_DEPLOY) {
            $.upgradesFrozen = true;
            address impl = ERC1967Utils.getImplementation();
            emit UpgradesFrozen(address(this), impl, impl.codehash);
        }
    }

    /// @notice Timelock-only, never once frozen: replace the implementation and optionally
    ///         run a call (a reinitializer) on it in the same transaction.
    function upgradeToAndCall(address newImplementation, bytes calldata data) external {
        _authorize();
        // No code: refuse with the typed error (a call to it could not be told apart from a
        // failing `proxiableUUID`).
        if (newImplementation.code.length == 0) {
            revert ERC1967Utils.ERC1967InvalidImplementation(newImplementation);
        }
        try IERC1822Proxiable(newImplementation).proxiableUUID() returns (bytes32 slot) {
            if (slot != ERC1967Utils.IMPLEMENTATION_SLOT) {
                revert ERC1967Utils.ERC1967InvalidImplementation(newImplementation);
            }
        } catch {
            revert ERC1967Utils.ERC1967InvalidImplementation(newImplementation);
        }
        ERC1967Utils.upgradeToAndCall(newImplementation, data);
    }

    /// @notice Timelock-only: permanently disable upgrades, bound to the reviewed target. Reverts
    ///         unless the live implementation and its runtime code hash both match, so a freeze
    ///         queued before an intervening upgrade cannot lock in the other version. Also
    ///         disables every initializer and reinitializer on the proxy (what OpenZeppelin's
    ///         `_disableInitializers` does).
    function freezeUpgrades(address expectedImplementation, bytes32 expectedCodeHash) external {
        _authorize();
        address impl = ERC1967Utils.getImplementation();
        bytes32 codeHash = impl.codehash;
        if (impl != expectedImplementation || codeHash != expectedCodeHash) {
            revert FreezeTargetMismatch(impl, codeHash);
        }
        layout().upgradesFrozen = true;
        emit UpgradesFrozen(address(this), impl, codeHash);

        InitializableLayout storage i;
        assembly {
            i.slot := INITIALIZABLE_STORAGE
        }
        if (i.initializing) revert InvalidInitialization();
        if (i.initialized != type(uint64).max) {
            i.initialized = type(uint64).max;
            emit Initialized(type(uint64).max);
        }
    }

    function _authorize() private view {
        Layout storage $ = layout();
        if (msg.sender != $.upgradeTimelock) revert NotUpgradeTimelock(msg.sender);
        if ($.upgradesFrozen) revert UpgradesAreFrozen();
    }
}

/// @title GovernedUUPS
/// @notice The UUPS entry points every proxied Robot Money core contract inherits (issue 1808,
///         docs/technical/contract-upgradeability-plan.md). Each core contract runs behind its
///         own ERC-1967 proxy. The implementation is one artifact for every environment; only
///         the initialized state (release mode, timelock) differs.
///
///         - The implementation's constructor disables initializers, so nobody can initialize
///           or take over the implementation contract itself.
///         - `upgradeToAndCall` and `freezeUpgrades` only run through an active ERC-1967 proxy
///           that points at this implementation, and only for `upgradeTimelock()`. Their rules
///           are in {GovernedUpgrade}; these entry points forward the exact calldata to it.
///         - The release mode is a required initializer argument with no default.
///           `Undeclared` (the zero value) reverts. `FrozenAtDeploy` sets the one-way flag
///           inside the atomic proxy initialization, before any public call reaches the proxy.
///         - `freezeUpgrades` also disables every initializer and reinitializer on the proxy.
abstract contract GovernedUUPS is Initializable, IERC1822Proxiable {
    /// @notice Release mode chosen at initialization. There is no default.
    enum UpgradeMode {
        Undeclared,
        Upgradeable,
        FrozenAtDeploy
    }

    address private immutable __self = address(this);

    /// @notice ERC-1967 `Upgraded`, emitted by {GovernedUpgrade} in the proxy's context.
    event Upgraded(address indexed implementation);
    /// @notice Upgrades on this proxy are permanently disabled. Emitted by {GovernedUpgrade}.
    event UpgradesFrozen(address indexed proxy, address indexed implementation, bytes32 codeHash);

    /// @notice Called on the implementation directly, or through a proxy that does not point at it.
    error UUPSUnauthorizedCallContext();

    /// @dev Lock the implementation: no initializer can ever run on it directly.
    constructor() {
        _disableInitializers();
    }

    /// @dev Record the upgrade timelock and apply the release mode. Called once from the
    ///      inheriting contract's `initialize`.
    function __GovernedUUPS_init(address timelock, UpgradeMode mode) internal onlyInitializing {
        GovernedUpgrade.init(timelock, uint8(mode));
    }

    /// @notice The only account that can upgrade or freeze this proxy.
    function upgradeTimelock() external view returns (address) {
        return GovernedUpgrade.layout().upgradeTimelock;
    }

    /// @notice True once upgrades are permanently disabled. There is no unset.
    function upgradesFrozen() external view returns (bool) {
        return GovernedUpgrade.layout().upgradesFrozen;
    }

    /// @inheritdoc IERC1822Proxiable
    function proxiableUUID() external view returns (bytes32) {
        if (address(this) != __self) revert UUPSUnauthorizedCallContext();
        return ERC1967Utils.IMPLEMENTATION_SLOT;
    }

    /// @notice Upgrade the proxy to `newImplementation` and, when `data` is not empty, run it
    ///         there. Timelock only, never once frozen (`GovernedUpgrade.upgradeToAndCall`).
    function upgradeToAndCall(address newImplementation, bytes calldata data) external {
        newImplementation;
        data;
        _forwardToGovernedUpgrade();
    }

    /// @notice Permanently disable upgrades, bound to the reviewed implementation and its
    ///         runtime code hash. Timelock only (`GovernedUpgrade.freezeUpgrades`).
    function freezeUpgrades(address expectedImplementation, bytes32 expectedCodeHash) external {
        expectedImplementation;
        expectedCodeHash;
        _forwardToGovernedUpgrade();
    }

    /// @dev Require an active proxy pointing at this implementation, then DELEGATECALL the
    ///      linked {GovernedUpgrade} library with this call's exact calldata (same selector)
    ///      and return or revert with its result.
    function _forwardToGovernedUpgrade() private {
        if (address(this) == __self || ERC1967Utils.getImplementation() != __self) {
            revert UUPSUnauthorizedCallContext();
        }
        address lib = address(GovernedUpgrade);
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            calldatacopy(ptr, 0, calldatasize())
            let ok := delegatecall(gas(), lib, ptr, calldatasize(), 0, 0)
            returndatacopy(ptr, 0, returndatasize())
            if iszero(ok) { revert(ptr, returndatasize()) }
        }
    }
}
