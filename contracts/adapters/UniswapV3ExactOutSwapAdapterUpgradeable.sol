// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0019-fund-swap-adapters-governed-uups-proxies.md;
//            docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md (the GovernedUUPS rules)
pragma solidity ^0.8.24;

import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {GovernedUUPS, GovernedUpgrade} from "../lib/GovernedUUPS.sol";
import {UniswapV3ExactOutSwapAdapter} from "./UniswapV3ExactOutSwapAdapter.sol";

/// @title UniswapV3ExactOutSwapAdapterUpgradeable
/// @notice The fund's Uniswap V3 swap adapter as the implementation of an OpenZeppelin `ERC1967Proxy` (ADR-0019). The
///         swap and price code is `UniswapV3ExactOutSwapAdapter`'s, unchanged. The router stays an immutable of the
///         implementation, so a router change is an upgrade. The adapter keeps no state between calls: the proxy's
///         only storage is `GovernedUUPS`'s ERC-7201 namespace (upgrade timelock, frozen flag) and OpenZeppelin's.
///         The fund reads `implementation()` to vet the implementation's code hash on every use
///         (`FundAdapterGuard`).
contract UniswapV3ExactOutSwapAdapterUpgradeable is UniswapV3ExactOutSwapAdapter, GovernedUUPS {
    constructor(address router_) UniswapV3ExactOutSwapAdapter(router_) {}

    /// @notice Name the upgrade timelock (the fund system's Safe-controlled timelock). Run once, atomically with the
    ///         proxy's deployment (`ERC1967Proxy(impl, abi.encodeCall(initialize, (timelock)))`).
    function initialize(address timelock) external initializer {
        __GovernedUUPS_init(timelock, UpgradeMode.Upgradeable);
    }

    /// @notice The router does not name a factory with code, so the 0.10.0 canonical pool check would refuse every pool.
    error RouterHasNoFactory(address router);

    /// @notice The one-time migration of the in-place upgrade to contracts 0.10.0 (ADR-0020), version 3. The adapter
    ///         keeps no state, so it writes nothing. It checks what the 0.10.0 canonical pool check (AGY-13) needs:
    ///         the router answers `factory()` with a contract. The upgrade timelock passes it as the data of
    ///         `upgradeToAndCall`; nobody else can run it, and it runs once.
    function migrateV0100() external reinitializer(3) {
        if (msg.sender != GovernedUpgrade.layout().upgradeTimelock) {
            revert GovernedUpgrade.NotUpgradeTimelock(msg.sender);
        }
        (bool ok, bytes memory d) = address(ROUTER).staticcall(abi.encodeWithSignature("factory()"));
        if (!ok || d.length != 32 || abi.decode(d, (address)).code.length == 0) {
            revert RouterHasNoFactory(address(ROUTER));
        }
    }

    /// @notice The implementation in the proxy's ERC-1967 slot (ADR-0019 vetting).
    function implementation() external view returns (address) {
        return ERC1967Utils.getImplementation();
    }
}
