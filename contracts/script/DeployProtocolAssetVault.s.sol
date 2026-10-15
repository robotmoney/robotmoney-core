// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.1 — Vault Family (protocol-asset basket)
//            docs/prd.md §11.2 — Protocol Asset Vault (rmPROTO)
//            robotmoney/devops issue 53 / core issue 1499, core S4 (issue 1486)
//
// Deploys `ProtocolAssetVault` with the config assets (wETH and cbBTC), pauses it and registers it.
// Router eligibility is deploy-time configuration (issue 1520): after registering, the broadcast
// path calls `registry.migrateEligibility` once when `ROUTER_DEFAULT_BPS` is a vector (it also sets
// the router default weights), and leaves the vault ineligible when it is `none`. The deployer
// holds ADMIN_ROLE on the registry until the timelock stage. After the handover stage 13 unpauses the
// vault through the Safe and the timelock (scripts/deploy/stage-table.json vault rules, issue 1705).
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {BasketVaultDeployBase} from "./BasketVaultDeployBase.sol";

import {BasketVault} from "../vaults/BasketVault.sol";
import {ProtocolAssetVault} from "../vaults/ProtocolAssetVault.sol";

/// @title DeployProtocolAssetVault
/// @notice Production deploy script for `ProtocolAssetVault` (rmPROTO). One path on every chain.
///
///         Required env vars (no defaults):
///           ADMIN_ADDRESS     the broadcaster. Holds ADMIN_ROLE and EMERGENCY_ROLE on the new
///                             vault and ADMIN_ROLE on the registry until the timelock stage.
///           SWAP_ROUTER       must equal `swapRouter02` in protocol-assets.json (Uniswap V3 SwapRouter02)
///           REGISTRY_ADDRESS  the vault is registered here as "Robot Money Protocol"
///           TVL_CAP, PER_DEPOSIT_CAP   USDC caps in 6-decimal units, from the frozen sheet
///           FEE_RECIPIENT   recipient for exit fees (not the deployer, not the admin)
///           DEPLOYMENT_OUT    output manifest path (required, no default)
///           EXPECTED_CHAIN_ID mandatory and equal to 8453 on Base mainnet
///           EXIT_FEE_BPS      exit fee in basis points, from the frozen sheet (0 is a valid value)
///           ROUTER_DEFAULT_BPS  `none`, or the router default weight vector (bps, comma list) after this vault flips eligible
///
///         Assets come from `protocol-assets.json` (wETH and cbBTC at launch). The vault is deployed paused.
contract DeployProtocolAssetVault is BasketVaultDeployBase {
    string public constant VAULT_NAME = "Robot Money Protocol";
    string public constant CONFIG_FILE = "config/protocol-assets.json";

    /// @notice Forge broadcast entrypoint.
    function run() external virtual returns (Deployed memory d) {
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
        _vaultUpgrade = _inProcessUpgradeConfig();
        vm.startPrank(p.admin);
        d = _deployAll(p, cfg);
        vm.stopPrank();
    }

    function _newVault(Params memory p, address emergencyResponder)
        internal
        override
        returns (BasketVault)
    {
        address impl = address(new ProtocolAssetVault());
        return BasketVault(
            _deployProxy(
                impl,
                abi.encodeCall(
                    ProtocolAssetVault.initialize,
                    (
                        _basketInitParams(p, emergencyResponder),
                        _vaultUpgrade.timelock,
                        _vaultUpgrade.mode
                    )
                )
            )
        );
    }

    function _registryName() internal pure override returns (string memory) {
        return VAULT_NAME;
    }

    function _label() internal pure override returns (string memory) {
        return "protocol_asset_vault";
    }

    function _usesAdapter() internal pure override returns (bool) {
        return false;
    }

    function console2Log(address vault) internal view {
        console2.log("DeployProtocolAssetVault complete:", vault);
    }
}
