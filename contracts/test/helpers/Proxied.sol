// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §3 — every proxied contract is an
//            implementation behind its own ERC1967Proxy, initialized in the proxy's deployment.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {GovernedUpgrade} from "../../lib/GovernedUpgrade.sol";
import {RobotMoneyVault} from "../../RobotMoneyVault.sol";
import {ExclusionLedgerFactory} from "../../ExclusionLedgerFactory.sol";
import {BasketVault} from "../../vaults/BasketVault.sol";
import {ProtocolAssetVault} from "../../vaults/ProtocolAssetVault.sol";
import {AgentTokenVault} from "../../vaults/AgentTokenVault.sol";
import {RwaBasketVault} from "../../vaults/RwaBasketVault.sol";
import {PortfolioRouter} from "../../PortfolioRouter.sol";
import {VaultRegistry} from "../../VaultRegistry.sol";
import {RobotMoneyGateway} from "../../gateway/RobotMoneyGateway.sol";
import {InvestmentCommitteePolicy} from "../../gateway/InvestmentCommitteePolicy.sol";
import {ConsensusRecommendationReceipt} from "../../gateway/ConsensusRecommendationReceipt.sol";
import {ISwapRouter} from "../../interfaces/ISwapRouter.sol";

/// @title Proxied
/// @notice Test fixtures for the nine proxied contracts (ADR-0014 §1). Each function takes the
///         former constructor arguments, deploys the implementation, then an `ERC1967Proxy` whose
///         constructor runs `initialize`, exactly as the deploy scripts do, and returns the proxy
///         typed as the contract.
/// @dev The upgrade authority is the calling contract (`address(this)`: internal library functions
///      run in the caller's context, and a test contract has code) in `Upgradeable` mode. A test that
///      exercises upgrades or the freeze names a timelock instead (`GovernedUpgradeLifecycle.t.sol`).
///      A test that expects the initializer to revert deploys the implementation first
///      (`*Implementation`), arms `vm.expectRevert`, then calls `proxy`: the proxy's CREATE is then the
///      call that reverts.
library Proxied {
    GovernedUpgrade.UpgradeMode internal constant MODE = GovernedUpgrade.UpgradeMode.Upgradeable;

    /// @dev Every `initialize` of the nine kinds ends with `(address upgradeAuthority, UpgradeMode
    ///      mode)`, so the authority is the second-to-last ABI word of the call data. The `*Init`
    ///      helpers write `address(this)` there; this swaps in `authority`.
    function _withAuthority(bytes memory init, address authority)
        private
        pure
        returns (bytes memory)
    {
        uint256 at = init.length - 64; // last two 32-byte words: authority, mode
        assembly {
            mstore(add(add(init, 32), at), authority)
        }
        return init;
    }

    /// @notice A proxy over `implementation` initialized with `initData` in its constructor.
    function proxy(address implementation, bytes memory initData) internal returns (address) {
        return address(new ERC1967Proxy(implementation, initData));
    }

    // ─── RobotMoneyVault ──────────────────────────────────────────────

    function robotMoneyVaultInit(
        IERC20 asset,
        uint256 tvlCap,
        uint256 perDepositCap,
        uint256 exitFeeBps,
        address feeRecipient,
        address admin,
        address emergencyResponder,
        ExclusionLedgerFactory factory
    ) internal view returns (bytes memory) {
        return abi.encodeCall(
            RobotMoneyVault.initialize,
            (
                asset,
                tvlCap,
                perDepositCap,
                exitFeeBps,
                feeRecipient,
                admin,
                emergencyResponder,
                factory,
                address(this),
                MODE
            )
        );
    }

    function robotMoneyVault(
        IERC20 asset,
        uint256 tvlCap,
        uint256 perDepositCap,
        uint256 exitFeeBps,
        address feeRecipient,
        address admin,
        address emergencyResponder
    ) internal returns (RobotMoneyVault) {
        return robotMoneyVaultAs(
            address(this),
            asset,
            tvlCap,
            perDepositCap,
            exitFeeBps,
            feeRecipient,
            admin,
            emergencyResponder
        );
    }

    /// @notice `robotMoneyVault` with an explicit upgrade authority (a timelock deployed first,
    ///         as `DeployTimelock.runAuthority` does), in `Upgradeable` mode.
    function robotMoneyVaultAs(
        address authority,
        IERC20 asset,
        uint256 tvlCap,
        uint256 perDepositCap,
        uint256 exitFeeBps,
        address feeRecipient,
        address admin,
        address emergencyResponder
    ) internal returns (RobotMoneyVault vault) {
        address implementation = address(new RobotMoneyVault());
        ExclusionLedgerFactory factory = new ExclusionLedgerFactory();
        bytes memory init = robotMoneyVaultInit(
            asset,
            tvlCap,
            perDepositCap,
            exitFeeBps,
            feeRecipient,
            admin,
            emergencyResponder,
            factory
        );
        vault = RobotMoneyVault(proxy(implementation, _withAuthority(init, authority)));
    }

    // ─── Basket kinds (one initializer in `BasketVault`) ──────────────

    function basketInit(
        IERC20 usdc,
        ISwapRouter swapRouter,
        uint256 tvlCap,
        uint256 perDepositCap,
        uint256 exitFeeBps,
        address feeRecipient,
        address admin,
        address emergencyResponder
    ) internal view returns (bytes memory) {
        return abi.encodeCall(
            BasketVault.initialize,
            (
                usdc,
                swapRouter,
                tvlCap,
                perDepositCap,
                exitFeeBps,
                feeRecipient,
                admin,
                emergencyResponder,
                address(this),
                MODE
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
        return protocolAssetVaultAs(
            address(this),
            usdc,
            swapRouter,
            tvlCap,
            perDepositCap,
            exitFeeBps,
            feeRecipient,
            admin,
            emergencyResponder
        );
    }

    /// @notice `protocolAssetVault` with an explicit upgrade authority, in `Upgradeable` mode.
    function protocolAssetVaultAs(
        address authority,
        IERC20 usdc,
        ISwapRouter swapRouter,
        uint256 tvlCap,
        uint256 perDepositCap,
        uint256 exitFeeBps,
        address feeRecipient,
        address admin,
        address emergencyResponder
    ) internal returns (ProtocolAssetVault vault) {
        address implementation = address(new ProtocolAssetVault());
        bytes memory init = basketInit(
            usdc,
            swapRouter,
            tvlCap,
            perDepositCap,
            exitFeeBps,
            feeRecipient,
            admin,
            emergencyResponder
        );
        vault = ProtocolAssetVault(proxy(implementation, _withAuthority(init, authority)));
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
        return agentTokenVaultAs(
            address(this),
            usdc,
            swapRouter,
            tvlCap,
            perDepositCap,
            exitFeeBps,
            feeRecipient,
            admin,
            emergencyResponder
        );
    }

    /// @notice `agentTokenVault` with an explicit upgrade authority, in `Upgradeable` mode.
    function agentTokenVaultAs(
        address authority,
        IERC20 usdc,
        ISwapRouter swapRouter,
        uint256 tvlCap,
        uint256 perDepositCap,
        uint256 exitFeeBps,
        address feeRecipient,
        address admin,
        address emergencyResponder
    ) internal returns (AgentTokenVault vault) {
        address implementation = address(new AgentTokenVault());
        bytes memory init = basketInit(
            usdc,
            swapRouter,
            tvlCap,
            perDepositCap,
            exitFeeBps,
            feeRecipient,
            admin,
            emergencyResponder
        );
        vault = AgentTokenVault(proxy(implementation, _withAuthority(init, authority)));
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
        return rwaBasketVaultAs(
            address(this),
            usdc,
            swapRouter,
            tvlCap,
            perDepositCap,
            exitFeeBps,
            feeRecipient,
            admin,
            emergencyResponder
        );
    }

    /// @notice `rwaBasketVault` with an explicit upgrade authority, in `Upgradeable` mode.
    function rwaBasketVaultAs(
        address authority,
        IERC20 usdc,
        ISwapRouter swapRouter,
        uint256 tvlCap,
        uint256 perDepositCap,
        uint256 exitFeeBps,
        address feeRecipient,
        address admin,
        address emergencyResponder
    ) internal returns (RwaBasketVault vault) {
        address implementation = address(new RwaBasketVault());
        bytes memory init = basketInit(
            usdc,
            swapRouter,
            tvlCap,
            perDepositCap,
            exitFeeBps,
            feeRecipient,
            admin,
            emergencyResponder
        );
        vault = RwaBasketVault(proxy(implementation, _withAuthority(init, authority)));
    }

    // ─── Router and registry ──────────────────────────────────────────

    function portfolioRouterInit(address usdc, address registry, address admin)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodeCall(
            PortfolioRouter.initialize, (usdc, registry, admin, address(this), MODE)
        );
    }

    function portfolioRouter(address usdc, address registry, address admin)
        internal
        returns (PortfolioRouter)
    {
        return portfolioRouterAs(address(this), usdc, registry, admin);
    }

    /// @notice `portfolioRouter` with an explicit upgrade authority, in `Upgradeable` mode.
    function portfolioRouterAs(address authority, address usdc, address registry, address admin)
        internal
        returns (PortfolioRouter)
    {
        address implementation = address(new PortfolioRouter());
        return PortfolioRouter(
            proxy(
                implementation,
                _withAuthority(portfolioRouterInit(usdc, registry, admin), authority)
            )
        );
    }

    function vaultRegistryInit(address admin) internal view returns (bytes memory) {
        return abi.encodeCall(VaultRegistry.initialize, (admin, address(this), MODE));
    }

    function vaultRegistry(address admin) internal returns (VaultRegistry) {
        return vaultRegistryAs(address(this), admin);
    }

    /// @notice `vaultRegistry` with an explicit upgrade authority, in `Upgradeable` mode.
    function vaultRegistryAs(address authority, address admin) internal returns (VaultRegistry) {
        address implementation = address(new VaultRegistry());
        return
            VaultRegistry(
                proxy(implementation, _withAuthority(vaultRegistryInit(admin), authority))
            );
    }

    // ─── Gateway, IC policy, receipt ──────────────────────────────────

    function gatewayInit(IERC20 usdc, IERC4626 vault, address admin, address pauser, address router)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodeCall(
            RobotMoneyGateway.initialize, (usdc, vault, admin, pauser, router, address(this), MODE)
        );
    }

    function robotMoneyGateway(
        IERC20 usdc,
        IERC4626 vault,
        address admin,
        address pauser,
        address router
    ) internal returns (RobotMoneyGateway) {
        return robotMoneyGatewayAs(address(this), usdc, vault, admin, pauser, router);
    }

    /// @notice `robotMoneyGateway` with an explicit upgrade authority, in `Upgradeable` mode.
    function robotMoneyGatewayAs(
        address authority,
        IERC20 usdc,
        IERC4626 vault,
        address admin,
        address pauser,
        address router
    ) internal returns (RobotMoneyGateway) {
        address implementation = address(new RobotMoneyGateway());
        return RobotMoneyGateway(
            proxy(
                implementation,
                _withAuthority(gatewayInit(usdc, vault, admin, pauser, router), authority)
            )
        );
    }

    function investmentCommitteePolicy(address admin, address gateway)
        internal
        returns (InvestmentCommitteePolicy)
    {
        address implementation = address(new InvestmentCommitteePolicy());
        return InvestmentCommitteePolicy(
            proxy(
                implementation,
                abi.encodeCall(
                    InvestmentCommitteePolicy.initialize, (admin, gateway, address(this), MODE)
                )
            )
        );
    }

    /// @notice `investmentCommitteePolicy` with `authority` (the timelock) as the upgrade authority.
    function investmentCommitteePolicyAs(address authority, address admin, address gateway)
        internal
        returns (InvestmentCommitteePolicy)
    {
        address implementation = address(new InvestmentCommitteePolicy());
        return InvestmentCommitteePolicy(
            proxy(
                implementation,
                abi.encodeCall(
                    InvestmentCommitteePolicy.initialize, (admin, gateway, authority, MODE)
                )
            )
        );
    }

    /// @notice `consensusRecommendationReceipt` with `authority` (the timelock) as the upgrade
    ///         authority.
    function consensusRecommendationReceiptAs(
        address authority,
        address admin,
        address gateway,
        address icPolicy
    ) internal returns (ConsensusRecommendationReceipt) {
        address implementation = address(new ConsensusRecommendationReceipt());
        return ConsensusRecommendationReceipt(
            proxy(
                implementation,
                abi.encodeCall(
                    ConsensusRecommendationReceipt.initialize,
                    (admin, gateway, icPolicy, authority, MODE)
                )
            )
        );
    }

    function consensusRecommendationReceipt(address admin, address gateway, address icPolicy)
        internal
        returns (ConsensusRecommendationReceipt)
    {
        address implementation = address(new ConsensusRecommendationReceipt());
        return ConsensusRecommendationReceipt(
            proxy(
                implementation,
                abi.encodeCall(
                    ConsensusRecommendationReceipt.initialize,
                    (admin, gateway, icPolicy, address(this), MODE)
                )
            )
        );
    }
}
