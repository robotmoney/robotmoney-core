// SPDX-License-Identifier: MIT
// Canonical: docs/operations/contract-release-runbooks.md §4.2 item 4 — Network identity
// Implements: issue #1483 (S1) — strict ExpectedChainGuard on 8453 for every deploy script
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DeployPortfolioRouter} from "../script/DeployPortfolioRouter.s.sol";
import {DeployVaultRegistry} from "../script/DeployVaultRegistry.s.sol";
import {DeployRouterGovernance} from "../script/DeployRouterGovernance.s.sol";
import {DeployInvestmentCommitteePolicy} from "../script/DeployInvestmentCommitteePolicy.s.sol";
import {DeployProtocolAssetVault} from "../script/DeployProtocolAssetVault.s.sol";
import {DeployAgentTokenVault} from "../script/DeployAgentTokenVault.s.sol";
import {DeployRwaBasketVault} from "../script/DeployRwaBasketVault.s.sol";
import {DeployVaultThemes} from "../script/DeployVaultThemes.s.sol";
import {DeployRmToken} from "../script/DeployRmToken.s.sol";
import {ActivateBasketVaultEligibility} from "../script/ActivateBasketVaultEligibility.s.sol";
import {Deploy} from "../script/Deploy.s.sol";

/// @notice On chain id 8453 every script's `run()` refuses to start when EXPECTED_CHAIN_ID is
///         unset. Nothing else is set: the guard is the first statement of each `run()` (the
///         vault scripts included), so a script that skipped it would fail later with a
///         different message or not at all.
/// @dev No test here sets EXPECTED_CHAIN_ID: `run()` reads the unprefixed name, env vars are
///      process-wide and forge runs test contracts in parallel. A mismatching value is
///      covered through the prefixed readers in DeployMainnetInputs.t.sol,
///      DeployTimelock.t.sol and the vault harness below.
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

    // --- the vault scripts (rmPROTO, rmAGENT, the themed vaults) -------------------------

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

    function test_rwaBasketVault_run_requiresExpectedChainOnBase() public {
        DeployRwaBasketVault s = new DeployRwaBasketVault();
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

contract ProtocolVaultInputsHarness is DeployProtocolAssetVault {
    function readPrefixed(string memory prefix) external view returns (Params memory) {
        _requireExpectedChain(prefix);
        return _readParamsFrom(prefix);
    }
}

/// @notice The rmPROTO script's sheet inputs: caps, exit fee and fee recipient are required on
///         every chain, and the chain guard is strict on 8453. Every case reads through a prefix
///         no other test uses (env vars are process-wide and forge runs tests in parallel).
contract ProtocolVaultInputsTest is Test {
    ProtocolVaultInputsHarness internal h;

    function setUp() public {
        h = new ProtocolVaultInputsHarness();
    }

    function _sheet(string memory p, string memory skip) internal {
        _set(p, skip, "ADMIN_ADDRESS", vm.toString(makeAddr("pv-admin")));
        _set(p, skip, "SWAP_ROUTER", vm.toString(makeAddr("pv-router")));
        _set(p, skip, "REGISTRY_ADDRESS", vm.toString(makeAddr("pv-registry")));
        _set(p, skip, "TVL_CAP", "50000000000");
        _set(p, skip, "PER_DEPOSIT_CAP", "5000000000");
        _set(p, skip, "EXIT_FEE_BPS", "0");
        _set(p, skip, "FEE_RECIPIENT", vm.toString(makeAddr("pv-fee")));
    }

    function _set(string memory p, string memory skip, string memory name, string memory v)
        internal
    {
        if (keccak256(bytes(skip)) == keccak256(bytes(name))) return;
        vm.setEnv(string.concat(p, name), v);
    }

    function test_allInputs_read() public {
        _sheet("RM_S1_PV_OK_", "");
        DeployProtocolAssetVault.Params memory r = h.readPrefixed("RM_S1_PV_OK_");
        assertEq(r.tvlCap, 50_000_000_000);
        assertEq(r.perDepositCap, 5_000_000_000);
        assertEq(r.feeRecipient, makeAddr("pv-fee"));
    }

    function test_missingInputs_revert() public {
        string[4] memory names = ["TVL_CAP", "PER_DEPOSIT_CAP", "EXIT_FEE_BPS", "FEE_RECIPIENT"];
        for (uint256 i = 0; i < names.length; i++) {
            string memory p = string.concat("RM_S1_PV_MISSING_", vm.toString(i), "_");
            _sheet(p, names[i]);
            vm.expectRevert(bytes(string.concat(p, names[i], " must be set")));
            h.readPrefixed(p);
        }
    }

    function test_malformedCap_reverts() public {
        string memory p = "RM_S1_PV_BAD_";
        _sheet(p, "");
        vm.setEnv(string.concat(p, "TVL_CAP"), "lots");
        vm.expectRevert(
            bytes(string.concat(p, "TVL_CAP is malformed: expected an unsigned integer"))
        );
        h.readPrefixed(p);
    }

    function test_base_unsetExpectedChain_reverts() public {
        vm.chainId(8453);
        string memory p = "RM_S1_PV_BASE_";
        _sheet(p, "");
        vm.expectRevert(bytes("EXPECTED_CHAIN_ID must be set to 8453 on Base mainnet"));
        h.readPrefixed(p);
    }

    function test_twin_mismatchedExpectedChain_reverts() public {
        vm.chainId(918453);
        string memory p = "RM_S1_PV_TWIN_";
        _sheet(p, "");
        vm.setEnv(string.concat(p, "EXPECTED_CHAIN_ID"), "8453");
        vm.expectRevert(bytes("EXPECTED_CHAIN_ID does not match the RPC's chain id"));
        h.readPrefixed(p);
    }
}
