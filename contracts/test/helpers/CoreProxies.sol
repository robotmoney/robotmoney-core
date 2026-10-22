// SPDX-License-Identifier: MIT
// Canonical: docs/technical/contract-upgradeability-plan.md — Mechanism and authority (issue 1808)
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {GovernedUUPS} from "../../lib/GovernedUUPS.sol";
import {RobotMoneyVault} from "../../RobotMoneyVault.sol";
import {BasketVault} from "../../vaults/BasketVault.sol";
import {ProtocolAssetVault} from "../../vaults/ProtocolAssetVault.sol";
import {AgentTokenVault} from "../../vaults/AgentTokenVault.sol";
import {RwaBasketVault} from "../../vaults/RwaBasketVault.sol";
import {VaultRegistry} from "../../VaultRegistry.sol";
import {PortfolioRouter} from "../../PortfolioRouter.sol";
import {RouterGovernance} from "../../RouterGovernance.sol";
import {RobotMoneyGateway} from "../../gateway/RobotMoneyGateway.sol";
import {ConsensusRecommendationReceipt} from "../../gateway/ConsensusRecommendationReceipt.sol";
import {ISwapRouter} from "../../interfaces/ISwapRouter.sol";

/// @title CoreProxies
/// @notice Test helper (issue 1808): every proxied core contract is deployed the way production
///         deploys it, an implementation plus an ERC-1967 proxy initialized in its constructor.
///         Each function takes the arguments the contract's constructor took before issue 1808,
///         so a test that used `new X(args)` calls `CoreProxies.x(args)` and gets the proxy.
///
///         The upgrade timelock is `TEST_UPGRADE_TIMELOCK` unless the test sets another with
///         `useUpgradeConfig` (the handover tests use the timelock the timelock stage deploys).
///         The mode is `Upgradeable` unless set.
///
///         Implementations are cached in the calling test contract's storage (one per contract
///         type and test), so a `vm.expectRevert` placed before a helper call that follows an
///         earlier deploy of the same type binds to the proxy creation (the initializer), the
///         way it bound to the constructor before.
library CoreProxies {
    /// @notice The default upgrade timelock of a test proxy (any test may prank it).
    address internal constant TEST_UPGRADE_TIMELOCK =
        address(uint160(uint256(keccak256("robotmoney.test.upgrade-timelock"))));

    bytes32 private constant CONFIG_SLOT = keccak256("robotmoney.test.CoreProxies.config");

    struct Config {
        address timelock;
        GovernedUUPS.UpgradeMode mode;
    }

    /// @notice Set the upgrade timelock and mode of every later helper deploy in this test.
    function useUpgradeConfig(address timelock, GovernedUUPS.UpgradeMode mode) internal {
        Config storage c = _config();
        c.timelock = timelock;
        c.mode = mode;
    }

    function config() internal view returns (address timelock, GovernedUUPS.UpgradeMode mode) {
        Config storage c = _config();
        timelock = c.timelock == address(0) ? TEST_UPGRADE_TIMELOCK : c.timelock;
        mode = c.mode == GovernedUUPS.UpgradeMode.Undeclared
            ? GovernedUUPS.UpgradeMode.Upgradeable
            : c.mode;
    }

    /// @notice The `useUpgradeConfig` setting of another test contract (a helper that runs the
    ///         stage scripts reads its caller's setting), with the same defaults as `config`.
    function configOf(address testContract)
        internal
        view
        returns (address timelock, GovernedUUPS.UpgradeMode mode)
    {
        uint256 w = uint256(_vm().load(testContract, CONFIG_SLOT));
        timelock = address(uint160(w));
        mode = GovernedUUPS.UpgradeMode(uint8(w >> 160));
        if (timelock == address(0)) timelock = TEST_UPGRADE_TIMELOCK;
        if (mode == GovernedUUPS.UpgradeMode.Undeclared) {
            mode = GovernedUUPS.UpgradeMode.Upgradeable;
        }
    }

    /// @notice The implementation an ERC-1967 proxy points at.
    function implementationOf(address proxy) internal view returns (address) {
        bytes32 v =
            _vm().load(proxy, 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc);
        return address(uint160(uint256(v)));
    }

    // ─── Core contracts ────────────────────────────────────────────────────

    function robotMoneyVault(
        IERC20 asset_,
        uint256 tvlCap,
        uint256 perDepositCap,
        uint256 exitFeeBps,
        address feeRecipient,
        address admin,
        address emergencyResponder
    ) internal returns (RobotMoneyVault) {
        address impl = _impl("RobotMoneyVault", type(RobotMoneyVault).creationCode);
        (address t, GovernedUUPS.UpgradeMode m) = config();
        return RobotMoneyVault(
            proxy(
                impl,
                abi.encodeCall(
                    RobotMoneyVault.initialize,
                    (
                        asset_,
                        tvlCap,
                        perDepositCap,
                        exitFeeBps,
                        feeRecipient,
                        admin,
                        emergencyResponder,
                        t,
                        m
                    )
                )
            )
        );
    }

    function protocolAssetVault(
        IERC20 usdc,
        ISwapRouter swapRouter,
        uint256 tvlCap,
        uint256 perDepositCap,
        uint256 exitFeeBps,
        address feeRecipient,
        address admin,
        address emergencyResponder
    ) internal returns (ProtocolAssetVault) {
        address impl = _impl("ProtocolAssetVault", type(ProtocolAssetVault).creationCode);
        BasketVault.InitParams memory p = basketParams(
            usdc,
            swapRouter,
            tvlCap,
            perDepositCap,
            exitFeeBps,
            feeRecipient,
            admin,
            emergencyResponder
        );
        (address t, GovernedUUPS.UpgradeMode m) = config();
        return
            ProtocolAssetVault(
                proxy(impl, abi.encodeCall(ProtocolAssetVault.initialize, (p, t, m)))
            );
    }

    function agentTokenVault(
        IERC20 usdc,
        ISwapRouter swapRouter,
        uint256 tvlCap,
        uint256 perDepositCap,
        uint256 exitFeeBps,
        address feeRecipient,
        address admin,
        address emergencyResponder
    ) internal returns (AgentTokenVault) {
        address impl = _impl("AgentTokenVault", type(AgentTokenVault).creationCode);
        BasketVault.InitParams memory p = basketParams(
            usdc,
            swapRouter,
            tvlCap,
            perDepositCap,
            exitFeeBps,
            feeRecipient,
            admin,
            emergencyResponder
        );
        (address t, GovernedUUPS.UpgradeMode m) = config();
        return AgentTokenVault(proxy(impl, abi.encodeCall(AgentTokenVault.initialize, (p, t, m))));
    }

    function rwaBasketVault(
        IERC20 usdc,
        ISwapRouter swapRouter,
        uint256 tvlCap,
        uint256 perDepositCap,
        uint256 exitFeeBps,
        address feeRecipient,
        address admin,
        address emergencyResponder
    ) internal returns (RwaBasketVault) {
        address impl = _impl("RwaBasketVault", type(RwaBasketVault).creationCode);
        BasketVault.InitParams memory p = basketParams(
            usdc,
            swapRouter,
            tvlCap,
            perDepositCap,
            exitFeeBps,
            feeRecipient,
            admin,
            emergencyResponder
        );
        (address t, GovernedUUPS.UpgradeMode m) = config();
        return RwaBasketVault(proxy(impl, abi.encodeCall(RwaBasketVault.initialize, (p, t, m))));
    }

    function vaultRegistry(address admin) internal returns (VaultRegistry) {
        address impl = _impl("VaultRegistry", type(VaultRegistry).creationCode);
        (address t, GovernedUUPS.UpgradeMode m) = config();
        return VaultRegistry(proxy(impl, abi.encodeCall(VaultRegistry.initialize, (admin, t, m))));
    }

    function portfolioRouter(address usdc, address registry, address admin)
        internal
        returns (PortfolioRouter)
    {
        address impl = _impl("PortfolioRouter", type(PortfolioRouter).creationCode);
        (address t, GovernedUUPS.UpgradeMode m) = config();
        return PortfolioRouter(
            proxy(impl, abi.encodeCall(PortfolioRouter.initialize, (usdc, registry, admin, t, m)))
        );
    }

    function routerGovernance(address router, address receipts, address admin)
        internal
        returns (RouterGovernance)
    {
        address impl = _impl("RouterGovernance", type(RouterGovernance).creationCode);
        (address t, GovernedUUPS.UpgradeMode m) = config();
        return RouterGovernance(
            proxy(
                impl, abi.encodeCall(RouterGovernance.initialize, (router, receipts, admin, t, m))
            )
        );
    }

    function robotMoneyGateway(
        IERC20 usdc,
        IERC4626 vault,
        address admin,
        address pauser,
        address router
    ) internal returns (RobotMoneyGateway) {
        address impl = _impl("RobotMoneyGateway", type(RobotMoneyGateway).creationCode);
        (address t, GovernedUUPS.UpgradeMode m) = config();
        return RobotMoneyGateway(
            proxy(
                impl,
                abi.encodeCall(
                    RobotMoneyGateway.initialize, (usdc, vault, admin, pauser, router, t, m)
                )
            )
        );
    }

    function consensusRecommendationReceipt(address admin)
        internal
        returns (ConsensusRecommendationReceipt)
    {
        address impl = _impl(
            "ConsensusRecommendationReceipt", type(ConsensusRecommendationReceipt).creationCode
        );
        (address t, GovernedUUPS.UpgradeMode m) = config();
        return ConsensusRecommendationReceipt(
            proxy(impl, abi.encodeCall(ConsensusRecommendationReceipt.initialize, (admin, t, m)))
        );
    }

    // ─── Building blocks ───────────────────────────────────────────────────

    function basketParams(
        IERC20 usdc,
        ISwapRouter swapRouter,
        uint256 tvlCap,
        uint256 perDepositCap,
        uint256 exitFeeBps,
        address feeRecipient,
        address admin,
        address emergencyResponder
    ) internal pure returns (BasketVault.InitParams memory) {
        return BasketVault.InitParams({
            usdc: usdc,
            swapRouter: swapRouter,
            tvlCap: tvlCap,
            perDepositCap: perDepositCap,
            exitFeeBps: exitFeeBps,
            feeRecipient: feeRecipient,
            admin: admin,
            emergencyResponder: emergencyResponder
        });
    }

    /// @notice One ERC-1967 proxy over `impl`, initialized in its constructor with `initData`.
    function proxy(address impl, bytes memory initData) internal returns (address) {
        return address(new ERC1967Proxy(impl, initData));
    }

    /// @dev The cached implementation for `name`, deployed from `creationCode` on first use.
    function _impl(string memory name, bytes memory creationCode) private returns (address impl) {
        bytes32 slot = keccak256(abi.encodePacked("robotmoney.test.CoreProxies.impl.", name));
        assembly {
            impl := sload(slot)
        }
        if (impl.code.length != 0) return impl;
        assembly {
            impl := create(0, add(creationCode, 0x20), mload(creationCode))
        }
        require(impl != address(0), "CoreProxies: implementation deploy failed");
        assembly {
            sstore(slot, impl)
        }
    }

    function _config() private pure returns (Config storage c) {
        bytes32 slot = CONFIG_SLOT;
        assembly {
            c.slot := slot
        }
    }

    function _vm() private pure returns (VmLoad) {
        return VmLoad(address(uint160(uint256(keccak256("hevm cheat code")))));
    }
}

interface VmLoad {
    function load(address target, bytes32 slot) external view returns (bytes32);
}
