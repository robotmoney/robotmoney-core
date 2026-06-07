// SPDX-License-Identifier: MIT
// Canonical: none — Foundry test for contracts/script/DeployProtocolAssetVault.s.sol
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployProtocolAssetVault} from "../script/DeployProtocolAssetVault.s.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {ProtocolAssetVault} from "../vaults/ProtocolAssetVault.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @dev Minimal ISwapRouter stub for deploy tests. ProtocolAssetVault's
///      constructor only stores the router address and does not call any
///      router methods, so a zero-implementation stub is sufficient.
contract StubSwapRouter is ISwapRouter {
    function exactInputSingle(ExactInputSingleParams calldata) external pure returns (uint256) {
        return 0;
    }
}

/// @notice Tests for DeployProtocolAssetVault.s.sol.
///
/// Acceptance criteria (issue #692):
///   - Script deploys ProtocolAssetVault with a non-zero address.
///   - Vault is registered in VaultRegistry when REGISTRY_ADDRESS is provided.
///   - Script does NOT call setRouterEligible (vault stays ineligible after deploy).
///   - Zero-address guards on required parameters revert with expected messages.
contract DeployProtocolAssetVaultTest is Test {
    DeployProtocolAssetVault internal script;
    TestERC20 internal usdc;
    StubSwapRouter internal swapRouter;
    VaultRegistry internal registry;

    address internal admin = address(this);
    address internal emergencyResponder = makeAddr("emergencyResponder");

    function setUp() public {
        script = new DeployProtocolAssetVault();
        usdc = new TestERC20();
        swapRouter = new StubSwapRouter();
        registry = new VaultRegistry(admin);
    }

    // ─── Happy path: without registry ─────────────────────────────────────────

    /// @notice Vault address is non-zero after deploy without registry.
    function test_deploy_vaultAddressNonZero() public {
        DeployProtocolAssetVault.Deployed memory d = script.runInProcessWith(
            admin, emergencyResponder, address(swapRouter), address(usdc), address(0)
        );
        assertTrue(d.vault != address(0), "vault address must be non-zero");
    }

    /// @notice Without REGISTRY_ADDRESS, registered flag is false.
    function test_deploy_notRegisteredWhenNoRegistry() public {
        DeployProtocolAssetVault.Deployed memory d = script.runInProcessWith(
            admin, emergencyResponder, address(swapRouter), address(usdc), address(0)
        );
        assertFalse(d.registered, "registered should be false when registry not supplied");
    }

    // ─── Happy path: with registry ─────────────────────────────────────────────

    /// @notice Vault is registered in VaultRegistry when registry is provided.
    function test_deploy_registersVaultInRegistry() public {
        DeployProtocolAssetVault.Deployed memory d = script.runInProcessWith(
            admin, emergencyResponder, address(swapRouter), address(usdc), address(registry)
        );

        assertTrue(d.registered, "registered flag must be true");
        assertEq(d.registry, address(registry), "registry address mismatch");
        assertEq(registry.vaultCount(), 1, "registry should have one vault");

        address[] memory vaults = registry.listVaults();
        assertEq(vaults[0], d.vault, "vault address mismatch in registry");
    }

    /// @notice Vault metadata stored in registry matches expected values.
    function test_deploy_metadataStoredCorrectly() public {
        DeployProtocolAssetVault.Deployed memory d = script.runInProcessWith(
            admin, emergencyResponder, address(swapRouter), address(usdc), address(registry)
        );

        (VaultRegistry.VaultMetadata memory meta,) = registry.getVault(d.vault);
        assertEq(meta.name, "Robot Money Protocol", "vault name mismatch");
        assertEq(meta.asset, address(usdc), "vault asset mismatch");
    }

    /// @notice Vault has Active status immediately after registration.
    function test_deploy_vaultIsActiveAfterRegistration() public {
        DeployProtocolAssetVault.Deployed memory d = script.runInProcessWith(
            admin, emergencyResponder, address(swapRouter), address(usdc), address(registry)
        );

        (, VaultRegistry.VaultStatus status) = registry.getVault(d.vault);
        assertEq(uint256(status), uint256(VaultRegistry.VaultStatus.Active), "vault not Active");
    }

    // ─── Critical: setRouterEligible NOT called ────────────────────────────────

    /// @notice The deploy script must NOT call setRouterEligible. Router
    ///         eligibility activation is separated into
    ///         ActivateBasketVaultEligibility.s.sol and is gated behind the
    ///         BASKET_VAULT_AUDIT_COMPLETE env flag.
    function test_deploy_doesNotSetRouterEligible() public {
        DeployProtocolAssetVault.Deployed memory d = script.runInProcessWith(
            admin, emergencyResponder, address(swapRouter), address(usdc), address(registry)
        );

        assertFalse(
            registry.isRouterEligible(d.vault),
            "setRouterEligible must NOT be called by the deploy script"
        );
    }

    // ─── ERC-4626 / vault properties ──────────────────────────────────────────

    /// @notice Vault's ERC-4626 asset() returns the configured USDC address.
    function test_deploy_vaultAssetIsUsdc() public {
        DeployProtocolAssetVault.Deployed memory d = script.runInProcessWith(
            admin, emergencyResponder, address(swapRouter), address(usdc), address(0)
        );

        address vaultAsset = ProtocolAssetVault(d.vault).asset();
        assertEq(vaultAsset, address(usdc), "vault asset() must equal USDC");
    }

    /// @notice Admin holds ADMIN_ROLE on the deployed vault.
    function test_deploy_adminHoldsAdminRole() public {
        DeployProtocolAssetVault.Deployed memory d = script.runInProcessWith(
            admin, emergencyResponder, address(swapRouter), address(usdc), address(0)
        );

        bytes32 adminRole = ProtocolAssetVault(d.vault).ADMIN_ROLE();
        assertTrue(
            ProtocolAssetVault(d.vault).hasRole(adminRole, admin), "admin must hold ADMIN_ROLE"
        );
    }

    // ─── Zero-address guards ───────────────────────────────────────────────────

    function test_reverts_on_zero_admin() public {
        vm.expectRevert(bytes("admin=0"));
        script.runInProcessWith(
            address(0), emergencyResponder, address(swapRouter), address(usdc), address(0)
        );
    }

    function test_reverts_on_zero_emergencyResponder() public {
        vm.expectRevert(bytes("emergencyResponder=0"));
        script.runInProcessWith(admin, address(0), address(swapRouter), address(usdc), address(0));
    }

    function test_reverts_on_zero_swapRouter() public {
        vm.expectRevert(bytes("swapRouter=0"));
        script.runInProcessWith(
            admin, emergencyResponder, address(0), address(usdc), address(0)
        );
    }

    function test_reverts_on_zero_usdc() public {
        vm.expectRevert(bytes("usdc=0"));
        script.runInProcessWith(
            admin, emergencyResponder, address(swapRouter), address(0), address(0)
        );
    }
}
