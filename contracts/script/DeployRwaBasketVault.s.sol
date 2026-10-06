// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.1 — Vault Family (RWA basket)
//            docs/prd.md §11.4 — RWA / Thematic Vault (rmRWA)
//            robotmoney/devops issue 53 / core issue 1499, core S4 (issue 1486)
//
// Deploys `RwaBasketVault` (a plain BasketVault) with deSPXA priced from its Uniswap V3 fee 500
// pool TWAP through the existing `UniswapV3SwapAdapter`, pauses it and registers it. No oracle.
// It does NOT call `setRouterEligible`: that step is `ActivateBasketVaultEligibility.s.sol`,
// run through the timelock after the checks pass.
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {BasketVaultDeployBase} from "./BasketVaultDeployBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BasketVault} from "../vaults/BasketVault.sol";
import {RwaBasketVault} from "../vaults/RwaBasketVault.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";

/// @title DeployRwaBasketVault
/// @notice Production deploy script for `RwaBasketVault` (rmRWA). One path on every chain.
///
///         Required env vars (no defaults):
///           ADMIN_ADDRESS     the broadcaster. Holds ADMIN_ROLE and EMERGENCY_ROLE on the new
///                             vault and ADMIN_ROLE on the registry until the timelock stage.
///           SWAP_ROUTER       must equal `swapRouter02` in rwa-assets.json (Uniswap V3 SwapRouter02)
///           REGISTRY_ADDRESS  the vault is registered here as "Robot Money RWA"
///           TVL_CAP, PER_DEPOSIT_CAP   USDC caps in 6-decimal units, from the frozen sheet
///           FEE_RECIPIENT   recipient for exit fees (not the deployer, not the admin)
///           DEPLOYMENT_OUT    output manifest path (required, no default)
///           EXPECTED_CHAIN_ID mandatory and equal to 8453 on Base mainnet
///           EXIT_FEE_BPS      exit fee in basis points, from the frozen sheet (0 is a valid value)
///
///         Assets come from `rwa-assets.json` (deSPXA only at launch). The vault is deployed paused.
contract DeployRwaBasketVault is BasketVaultDeployBase {
    string public constant VAULT_NAME = "Robot Money RWA";
    string public constant CONFIG_FILE = "config/rwa-assets.json";

    /// @notice Forge broadcast entrypoint.
    function run() external returns (Deployed memory d) {
        d = _runFrom("", CONFIG_FILE, "assets");
        console2Log(d.vault);
    }

    /// @notice In-process variant for forge tests and the stage driver's simulation. No
    ///         broadcast and no manifest. Every call runs as `p.admin` under a prank, so
    ///         `p.admin` becomes the vault's ADMIN and EMERGENCY holder as in a broadcast.
    /// @param p    Sheet inputs.
    /// @param json Body of the config file (the test passes a fixture, the driver passes the file).
    function runInProcess(Params memory p, string memory json)
        external
        returns (Deployed memory d)
    {
        Cfg memory cfg = _parseCfg(json, "assets");
        vm.startPrank(p.admin);
        d = _deployAll(p, cfg);
        vm.stopPrank();
    }

    function _newVault(Params memory p, address emergencyResponder)
        internal
        override
        returns (BasketVault)
    {
        return new RwaBasketVault(
            IERC20(p.usdc),
            ISwapRouter(p.swapRouter),
            p.tvlCap,
            p.perDepositCap,
            p.exitFeeBps,
            p.feeRecipient,
            p.admin,
            emergencyResponder
        );
    }

    function _registryName() internal pure override returns (string memory) {
        return VAULT_NAME;
    }

    function _label() internal pure override returns (string memory) {
        return "rwa_basket_vault";
    }

    function _usesAdapter() internal pure override returns (bool) {
        return true;
    }

    function console2Log(address vault) internal view {
        console2.log("DeployRwaBasketVault complete:", vault);
    }
}
