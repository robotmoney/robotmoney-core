// SPDX-License-Identifier: MIT
// Canonical: robotmoney/devops issue 53 / core issue 1499 principles 4-6
// Implements: core S1 (1483), the Twin chain half of DeployScriptChainGuards.t.sol.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DeployLibs} from "../script/DeployLibs.s.sol";
import {DeployVault} from "../script/DeployVault.s.sol";
import {DeployGateway} from "../script/DeployGateway.s.sol";
import {DeployTimelock} from "../script/DeployTimelock.s.sol";
import {DeployPortfolioRouter} from "../script/DeployPortfolioRouter.s.sol";
import {DeployVaultRegistry} from "../script/DeployVaultRegistry.s.sol";
import {DeployRouterGovernance} from "../script/DeployRouterGovernance.s.sol";
import {DeployInvestmentCommitteePolicy} from "../script/DeployInvestmentCommitteePolicy.s.sol";
import {DeployProtocolAssetVault} from "../script/DeployProtocolAssetVault.s.sol";
import {DeployAgentTokenVault} from "../script/DeployAgentTokenVault.s.sol";
import {DeployRwaBasketVault} from "../script/DeployRwaBasketVault.s.sol";
import {ActivateBasketVaultEligibility} from "../script/ActivateBasketVaultEligibility.s.sol";

/// @notice On the Twin chain (918453) the strict chain guard does not fire for an unset
///         EXPECTED_CHAIN_ID: each script's `run()` either fails on a later required input or
///         runs on, but never with the 8453 guard message. The 8453 side (guard fires) is
///         DeployScriptChainGuards.t.sol, so each script is pinned on both sides of the floor.
/// @dev No test sets an env var, so there is no race with the parallel 8453 contract.
contract DeployScriptChainGuardsTwinTest is Test {
    bytes32 internal constant GUARD_REVERT = keccak256(
        abi.encodeWithSignature(
            "Error(string)", "EXPECTED_CHAIN_ID must be set to 8453 on Base mainnet"
        )
    );

    function setUp() public {
        vm.chainId(918453);
    }

    /// @dev Passes when `data` is not the 8453 guard revert.
    function _notGuard(bool ok, bytes memory data) internal pure {
        if (!ok) {
            require(keccak256(data) != GUARD_REVERT, "the 8453 guard fired on the Twin chain");
        }
    }

    function test_libs_run_guardSilentOnTwinChain() public {
        (bool ok, bytes memory d) = address(new DeployLibs()).call(abi.encodeWithSignature("run()"));
        _notGuard(ok, d);
    }

    function test_vault_run_guardSilentOnTwinChain() public {
        (bool ok, bytes memory d) =
            address(new DeployVault()).call(abi.encodeWithSignature("run()"));
        _notGuard(ok, d);
    }

    function test_gateway_run_guardSilentOnTwinChain() public {
        (bool ok, bytes memory d) =
            address(new DeployGateway()).call(abi.encodeWithSignature("run()"));
        _notGuard(ok, d);
    }

    function test_deployTimelock_run_guardSilentOnTwinChain() public {
        (bool ok, bytes memory d) =
            address(new DeployTimelock()).call(abi.encodeWithSignature("run()"));
        _notGuard(ok, d);
    }

    function test_portfolioRouter_run_guardSilentOnTwinChain() public {
        (bool ok, bytes memory d) =
            address(new DeployPortfolioRouter()).call(abi.encodeWithSignature("run()"));
        _notGuard(ok, d);
    }

    function test_vaultRegistry_run_guardSilentOnTwinChain() public {
        (bool ok, bytes memory d) =
            address(new DeployVaultRegistry()).call(abi.encodeWithSignature("run()"));
        _notGuard(ok, d);
    }

    function test_routerGovernance_run_guardSilentOnTwinChain() public {
        (bool ok, bytes memory d) =
            address(new DeployRouterGovernance()).call(abi.encodeWithSignature("run()"));
        _notGuard(ok, d);
    }

    function test_icPolicy_run_guardSilentOnTwinChain() public {
        (bool ok, bytes memory d) =
            address(new DeployInvestmentCommitteePolicy()).call(abi.encodeWithSignature("run()"));
        _notGuard(ok, d);
    }

    function test_protocolAssetVault_run_guardSilentOnTwinChain() public {
        (bool ok, bytes memory d) =
            address(new DeployProtocolAssetVault()).call(abi.encodeWithSignature("run()"));
        _notGuard(ok, d);
    }

    function test_agentTokenVault_run_guardSilentOnTwinChain() public {
        (bool ok, bytes memory d) =
            address(new DeployAgentTokenVault()).call(abi.encodeWithSignature("run()"));
        _notGuard(ok, d);
    }

    function test_rwaBasketVault_run_guardSilentOnTwinChain() public {
        (bool ok, bytes memory d) =
            address(new DeployRwaBasketVault()).call(abi.encodeWithSignature("run()"));
        _notGuard(ok, d);
    }

    function test_activateEligibility_run_guardSilentOnTwinChain() public {
        (bool ok, bytes memory d) =
            address(new ActivateBasketVaultEligibility()).call(abi.encodeWithSignature("run()"));
        _notGuard(ok, d);
    }

    /// @notice Self-check of the helper: the 8453 guard revert is recognised, so the tests
    ///         above cannot pass vacuously.
    function test_helper_recognisesTheGuardRevert() public {
        vm.chainId(8453);
        (bool ok, bytes memory d) =
            address(new DeployVaultRegistry()).call(abi.encodeWithSignature("run()"));
        assertFalse(ok);
        assertEq(keccak256(d), GUARD_REVERT, "helper constant matches the real guard revert");
    }
}
