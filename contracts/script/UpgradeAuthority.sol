// SPDX-License-Identifier: MIT
// Canonical: docs/technical/contract-upgradeability-plan.md — Mechanism and authority (timelock-last stage order)
// (See also: docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md; issue 1808)
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {GovernedUUPS} from "../lib/GovernedUUPS.sol";
import {ExpectedChainGuard} from "./ExpectedChainGuard.sol";

/// @title UpgradeAuthority
/// @notice What every stage that deploys a proxied core contract shares (issue 1808):
///
///         - The upgrade authority. The timelock stage deploys the `TimelockController` LAST,
///           after every proxy. The proxies still name it from their first block: its address
///           is the CREATE2 address of the exact timelock the timelock stage deploys
///           (proposer and canceller = the Safe, executor = anyone, no admin, `minDelay`),
///           through the canonical CREATE2 factory with `TIMELOCK_SALT`. CREATE2 binds the
///           init code, so nothing but that Safe-controlled timelock can ever have code at the
///           address: there is no interim deployer, EOA or placeholder upgrade authority. The
///           timelock stage deploys it there and asserts every proxy names it.
///         - The release mode, `UPGRADE_MODE`: `upgradeable` or `frozen`, required, no default.
///           `frozen` freezes upgrades inside the atomic proxy initialization.
///         - One ERC-1967 proxy per contract, initialized in its constructor (no window in which
///           the proxy exists uninitialized).
///
///         Env vars (every proxy stage; all required on every chain, no defaults):
///           SAFE_ADDRESS        — the Safe that will be the timelock's only proposer
///           TIMELOCK_MIN_DELAY  — the timelock delay the timelock stage deploys with
///           UPGRADE_MODE        — `upgradeable` or `frozen`
abstract contract UpgradeAuthority is ExpectedChainGuard {
    /// @notice CREATE2 salt of the core timelock.
    bytes32 public constant TIMELOCK_SALT = keccak256("robotmoney.core.timelock.v1");

    /// @notice The upgrade authority and release mode a stage initializes its proxies with.
    struct UpgradeConfig {
        address timelock;
        GovernedUUPS.UpgradeMode mode;
    }

    /// @dev In-process (forge test) override, set by `setUpgradeConfig`. The broadcast `run()`
    ///      never reads it: it reads the env.
    UpgradeConfig internal _inProcessUpgrade;

    /// @notice Test seam for the in-process entry points: the timelock and mode the next
    ///         in-process run initializes its proxies with. Unset, an in-process run uses this
    ///         script contract as the timelock and `Upgradeable`. Never read by `run()`.
    function setUpgradeConfig(address timelock, GovernedUUPS.UpgradeMode mode) external {
        _inProcessUpgrade = UpgradeConfig({timelock: timelock, mode: mode});
    }

    /// @notice The init code of the core timelock for `safe` and `minDelay`.
    function timelockInitCode(address safe, uint256 minDelay) public pure returns (bytes memory) {
        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        return abi.encodePacked(
            type(TimelockController).creationCode,
            abi.encode(minDelay, proposers, executors, address(0))
        );
    }

    /// @notice The address the timelock stage deploys the core timelock at.
    function predictTimelock(address safe, uint256 minDelay) public pure returns (address) {
        return computeCreate2Address(
            TIMELOCK_SALT, keccak256(timelockInitCode(safe, minDelay)), CREATE2_FACTORY
        );
    }

    /// @dev The broadcast upgrade config: `<prefix>SAFE_ADDRESS`, `<prefix>TIMELOCK_MIN_DELAY`
    ///      and `<prefix>UPGRADE_MODE`, all required.
    function _readUpgradeConfig(string memory prefix)
        internal
        view
        returns (UpgradeConfig memory c)
    {
        address safe = _envAddressRequired(string.concat(prefix, "SAFE_ADDRESS"));
        require(safe != address(0), "SAFE_ADDRESS=0");
        uint256 minDelay = _envUintRequired(string.concat(prefix, "TIMELOCK_MIN_DELAY"));
        c.timelock = predictTimelock(safe, minDelay);
        c.mode = parseUpgradeMode(_envStringRequired(string.concat(prefix, "UPGRADE_MODE")));
    }

    /// @dev The in-process upgrade config (see `setUpgradeConfig`).
    function _inProcessUpgradeConfig() internal view returns (UpgradeConfig memory c) {
        c = _inProcessUpgrade;
        if (c.timelock == address(0)) {
            c = UpgradeConfig({timelock: address(this), mode: GovernedUUPS.UpgradeMode.Upgradeable});
        }
    }

    /// @notice `upgradeable` or `frozen`. Anything else reverts: there is no default mode.
    function parseUpgradeMode(string memory s) public pure returns (GovernedUUPS.UpgradeMode) {
        bytes32 h = keccak256(bytes(s));
        if (h == keccak256("upgradeable")) return GovernedUUPS.UpgradeMode.Upgradeable;
        if (h == keccak256("frozen")) return GovernedUUPS.UpgradeMode.FrozenAtDeploy;
        revert("UPGRADE_MODE must be upgradeable or frozen");
    }

    /// @notice The manifest word for `mode`.
    function upgradeModeName(GovernedUUPS.UpgradeMode mode) public pure returns (string memory) {
        if (mode == GovernedUUPS.UpgradeMode.Upgradeable) return "upgradeable";
        if (mode == GovernedUUPS.UpgradeMode.FrozenAtDeploy) return "frozen";
        revert("UPGRADE_MODE undeclared");
    }

    /// @dev Deploy one ERC-1967 proxy for `implementation`, initialized atomically with
    ///      `initData` in the proxy's constructor.
    function _deployProxy(address implementation, bytes memory initData)
        internal
        returns (address proxy)
    {
        proxy = address(new ERC1967Proxy(implementation, initData));
    }

    /// @dev The implementation an ERC-1967 proxy points at (the implementation slot).
    function _implementationOf(address proxy) internal view returns (address) {
        return address(
            uint160(
                uint256(
                    vm.load(
                        proxy, 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
                    )
                )
            )
        );
    }
}
