// SPDX-License-Identifier: MIT
// Canonical: docs/technical/security-model.md (pause-key abuse and pause-trigger rows: unpause is the one operation after the handover)
//            docs/operations/contract-release-runbooks.md section 4.3 (the deployer configures before the timelock handover)
// Implements: issue 1520 (stage 13 is the basket unpauses only; voting power, router eligibility and default weights are deploy-time)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DeployRouterGovernance} from "../script/DeployRouterGovernance.s.sol";
import {DeployProtocolAssetVault} from "../script/DeployProtocolAssetVault.s.sol";
import {DeployAgentTokenVault} from "../script/DeployAgentTokenVault.s.sol";
import {DeployRwaBasketVault} from "../script/DeployRwaBasketVault.s.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {BasketDeployFixture} from "./helpers/BasketDeployFixture.sol";

contract GovernanceVotersHarness is DeployRouterGovernance {
    function readVoters(string memory key) external view returns (address[] memory) {
        return _envVotersRequired(key);
    }
}

/// @notice The deployer sets voting power in the governance stage, before the timelock handover.
contract DeployTimeVotingPowerTest is Test {
    GovernanceVotersHarness internal script;
    PortfolioRouter internal router;
    address internal admin = makeAddr("dt-gov-admin");
    address internal voterA = makeAddr("dt-voter-a");
    address internal voterB = makeAddr("dt-voter-b");

    function setUp() public {
        script = new GovernanceVotersHarness();
        TestERC20 usdc = new TestERC20();
        VaultRegistry registry = new VaultRegistry(admin);
        router = new PortfolioRouter(address(usdc), address(registry), admin);
    }

    function test_votingPowerIsSetForEveryVoterAtDeployTime() public {
        address[] memory voters = new address[](2);
        voters[0] = voterA;
        voters[1] = voterB;
        DeployRouterGovernance.Deployed memory d =
            script.runInProcessWithVoters(admin, address(router), 3600, 3600, 2, voters, 1000);
        assertEq(d.governance.votingPower(voterA), 1000);
        assertEq(d.governance.votingPower(voterB), 1000);
        assertEq(d.governance.totalVotingPower(), 2000);
        assertEq(d.governance.quorumThreshold(), 2);
    }

    function test_totalVotingPowerBelowQuorumReverts() public {
        address[] memory voters = new address[](1);
        voters[0] = voterA;
        vm.expectRevert(bytes("total voting power is below the quorum"));
        script.runInProcessWithVoters(admin, address(router), 3600, 3600, 2000, voters, 1000);
    }

    function test_zeroVoterPowerReverts() public {
        address[] memory voters = new address[](1);
        voters[0] = voterA;
        vm.expectRevert(bytes("VOTER_POWER must be above 0"));
        script.runInProcessWithVoters(admin, address(router), 3600, 3600, 2, voters, 0);
    }

    function test_voterListIsRequiredAndStrict() public {
        vm.expectRevert(bytes("DT_VOTERS_UNSET must be set"));
        script.readVoters("DT_VOTERS_UNSET");

        vm.setEnv("DT_VOTERS_BAD", "not-an-address");
        vm.expectRevert(bytes("DT_VOTERS_BAD is malformed: expected a comma list of addresses"));
        script.readVoters("DT_VOTERS_BAD");

        vm.setEnv("DT_VOTERS_ZERO", vm.toString(address(0)));
        vm.expectRevert(bytes("DT_VOTERS_ZERO holds the zero address"));
        script.readVoters("DT_VOTERS_ZERO");

        vm.setEnv("DT_VOTERS_DUP", string.concat(vm.toString(voterA), ",", vm.toString(voterA)));
        vm.expectRevert(bytes("DT_VOTERS_DUP lists an address twice"));
        script.readVoters("DT_VOTERS_DUP");

        vm.setEnv("DT_VOTERS_OK", string.concat(vm.toString(voterA), ",", vm.toString(voterB)));
        address[] memory v = script.readVoters("DT_VOTERS_OK");
        assertEq(v.length, 2);
        assertEq(v[1], voterB);
    }
}

contract EligibilityHarness is DeployProtocolAssetVault {
    function makeEligible(VaultRegistry registry, address vault, uint256[] memory bps) external {
        _makeRouterEligible(registry, vault, bps);
    }

    function readBps(string memory prefix) external view returns (uint256[] memory) {
        return _readEligibilityBps(prefix);
    }
}

/// @notice The basket vault stages make a basket router-eligible and set the default weights, one atomic migrateEligibility.
contract DeployTimeEligibilityTest is BasketDeployFixture {
    EligibilityHarness internal h;
    PortfolioRouter internal router;
    address internal protoVault;
    address internal agentVault;
    address internal rwaVault;

    function setUp() public {
        _fixtureSetUp();
        h = new EligibilityHarness();
        router = new PortfolioRouter(address(usdc), address(registry), deployer);
        string memory empty =
            string.concat('{"swapRouter02":"', vm.toString(router02), '","assets":[]}');
        protoVault = new DeployProtocolAssetVault().runInProcess(_params(), empty).vault;
        agentVault =
        new DeployAgentTokenVault()
        .runInProcess(
            _params(),
            string.concat('{"swapRouter02":"', vm.toString(router02), '","shortlist":[]}')
        )
        .vault;
        rwaVault = new DeployRwaBasketVault().runInProcess(_params(), empty).vault;
        vm.startPrank(deployer);
        registry.setRouter(address(router));
        registry.grantRole(registry.ADMIN_ROLE(), address(h));
        vm.stopPrank();
    }

    function _two(uint256 a, uint256 b) internal pure returns (uint256[] memory v) {
        v = new uint256[](2);
        v[0] = a;
        v[1] = b;
    }

    function _three(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory v) {
        v = new uint256[](3);
        v[0] = a;
        v[1] = b;
        v[2] = c;
    }

    function test_eachFlipSetsTheDefaultVectorAndAZeroWeightIsAccepted() public {
        uint256[] memory one = new uint256[](1);
        one[0] = 10_000;
        h.makeEligible(registry, protoVault, one);
        assertTrue(registry.isRouterEligible(protoVault));
        assertEq(router.defaultWeightsLength(), 1);

        h.makeEligible(registry, agentVault, _two(9500, 500));
        assertTrue(registry.isRouterEligible(agentVault));

        h.makeEligible(registry, rwaVault, _three(9500, 500, 0));
        assertTrue(registry.isRouterEligible(rwaVault));
        assertEq(registry.routerEligibleCount(), 3);
        (address[] memory vaults, uint256[] memory bps) = router.getDefaultWeights();
        assertEq(vaults.length, 3);
        assertEq(vaults[0], protoVault);
        assertEq(vaults[2], rwaVault);
        assertEq(bps[0], 9500);
        assertEq(bps[1], 500);
        assertEq(bps[2], 0);
    }

    function test_noneLeavesTheBasketIneligible() public {
        h.makeEligible(registry, protoVault, new uint256[](0));
        assertFalse(registry.isRouterEligible(protoVault));
        assertEq(router.defaultWeightsLength(), 0);
    }

    function test_aVectorOfTheWrongLengthReverts() public {
        vm.expectRevert(
            bytes("ROUTER_DEFAULT_BPS length differs from the eligible set plus this vault")
        );
        h.makeEligible(registry, protoVault, _two(5000, 5000));
    }

    function test_theEnvIsRequiredNoneOrAList() public {
        vm.expectRevert(bytes("DTE_UNSET_ROUTER_DEFAULT_BPS must be set"));
        h.readBps("DTE_UNSET_");

        vm.setEnv("DTE_NONE_ROUTER_DEFAULT_BPS", "none");
        assertEq(h.readBps("DTE_NONE_").length, 0);

        vm.setEnv("DTE_LIST_ROUTER_DEFAULT_BPS", "9500,500,0");
        uint256[] memory v = h.readBps("DTE_LIST_");
        assertEq(v.length, 3);
        assertEq(v[0], 9500);
        assertEq(v[2], 0);

        vm.setEnv("DTE_BAD_ROUTER_DEFAULT_BPS", "95%,5");
        vm.expectRevert(
            bytes(
                "DTE_BAD_ROUTER_DEFAULT_BPS is malformed: expected none or a comma list of unsigned integers"
            )
        );
        h.readBps("DTE_BAD_");
    }
}
