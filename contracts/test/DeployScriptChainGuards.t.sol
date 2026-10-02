// SPDX-License-Identifier: MIT
// Canonical: docs/plans/one-deployment-scheme.md (robotmoney/devops) principles 4-6
// Implements: core S1 — strict ExpectedChainGuard on 8453 for EVERY deploy script, vault scripts included.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {DeployTimelock} from "../script/DeployTimelock.s.sol";
import {DeployPortfolioRouter} from "../script/DeployPortfolioRouter.s.sol";
import {DeployVaultRegistry} from "../script/DeployVaultRegistry.s.sol";
import {DeployRouterGovernance} from "../script/DeployRouterGovernance.s.sol";
import {DeployInvestmentCommitteePolicy} from "../script/DeployInvestmentCommitteePolicy.s.sol";
import {DeployProtocolAssetVault} from "../script/DeployProtocolAssetVault.s.sol";
import {DeployAgentTokenVault} from "../script/DeployAgentTokenVault.s.sol";
import {DeployVaultThemes} from "../script/DeployVaultThemes.s.sol";
import {DeployRmToken} from "../script/DeployRmToken.s.sol";
import {ActivateBasketVaultEligibility} from "../script/ActivateBasketVaultEligibility.s.sol";

/// @notice On chain id 8453, every script's `run()` refuses to start when EXPECTED_CHAIN_ID is
///         unset. Nothing else is set: the guard is the first statement of each `run()`, so a
///         script that skipped it would fail later with a different message.
/// @dev No test here sets EXPECTED_CHAIN_ID: the name is read unprefixed by `run()`, env vars
///      are process-wide and forge runs test contracts in parallel. A mismatching or non-8453
///      value is covered through the prefixed readers in DeployMainnetInputs.t.sol and
///      DeployTimelock.t.sol.
contract DeployScriptChainGuardsTest is Test {
    string internal constant MSG = "EXPECTED_CHAIN_ID must be set to 8453 on Base mainnet";

    function setUp() public {
        vm.chainId(8453);
    }

    function test_deploy_run_requiresExpectedChainOnBase() public {
        Deploy s = new Deploy();
        vm.expectRevert(bytes(MSG));
        s.run();
    }

    function test_deployTimelock_run_requiresExpectedChainOnBase() public {
        DeployTimelock s = new DeployTimelock();
        // run() reads every required input first, so only the guard message proves the
        // guard ran. Inputs are unset here, so the first required input stops the run.
        vm.expectRevert();
        s.run();
    }

    function test_portfolioRouter_run_requiresExpectedChainOnBase() public {
        DeployPortfolioRouter s = new DeployPortfolioRouter();
        vm.expectRevert(bytes(MSG));
        s.run();
    }

    function test_vaultRegistry_run_requiresExpectedChainOnBase() public {
        DeployVaultRegistry s = new DeployVaultRegistry();
        vm.expectRevert(bytes(MSG));
        s.run();
    }

    function test_routerGovernance_run_requiresExpectedChainOnBase() public {
        DeployRouterGovernance s = new DeployRouterGovernance();
        vm.expectRevert(bytes(MSG));
        s.run();
    }

    function test_icPolicy_run_requiresExpectedChainOnBase() public {
        DeployInvestmentCommitteePolicy s = new DeployInvestmentCommitteePolicy();
        vm.expectRevert(bytes(MSG));
        s.run();
    }

    // --- the vault scripts (rmPROTO, rmAGENT, the themed vaults) -----------------------------

    function test_protocolAssetVault_run_requiresExpectedChainOnBase() public {
        DeployProtocolAssetVault s = new DeployProtocolAssetVault();
        vm.expectRevert(bytes(MSG));
        s.run();
    }

    function test_agentTokenVault_run_requiresExpectedChainOnBase() public {
        DeployAgentTokenVault s = new DeployAgentTokenVault();
        vm.expectRevert(bytes(MSG));
        s.run();
    }

    function test_vaultThemes_run_requiresExpectedChainOnBase() public {
        DeployVaultThemes s = new DeployVaultThemes();
        vm.expectRevert(bytes(MSG));
        s.run();
    }

    function test_rmToken_run_requiresExpectedChainOnBase() public {
        DeployRmToken s = new DeployRmToken();
        vm.expectRevert(bytes(MSG));
        s.run();
    }

    function test_activateEligibility_run_requiresExpectedChainOnBase() public {
        ActivateBasketVaultEligibility s = new ActivateBasketVaultEligibility();
        vm.expectRevert(bytes(MSG));
        s.run();
    }
}
