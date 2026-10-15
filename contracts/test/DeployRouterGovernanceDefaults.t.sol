// SPDX-License-Identifier: MIT
// Canonical: docs/technical/governance-decisions.md §3.6 — setWeights call path
// Canonical: docs/technical/router-governance-handoff-runbook.md
// Implements: issue #1698 — the governance stage wires the weight setter for applyReceipt and nothing else
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DeployRouterGovernance} from "../script/DeployRouterGovernance.s.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {InvestmentCommitteePolicy} from "../gateway/InvestmentCommitteePolicy.sol";
import {ConsensusRecommendationReceipt} from "../gateway/ConsensusRecommendationReceipt.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @notice What the governance stage leaves behind, read from the chain: the weight
///         setter holds router ADMIN_ROLE, router WEIGHT_SETTER_ROLE and the receipt
///         register's ADMIN_ROLE; the deployer's router WEIGHT_SETTER_ROLE is gone; the
///         deployer holds the governance contract's ADMIN_ROLE and WEIGHT_SETTER_ROLE
///         until the timelock stage hands them over.
contract DeployRouterGovernanceDefaultsTest is Test {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 internal constant WEIGHT_SETTER_ROLE = keccak256("WEIGHT_SETTER_ROLE");

    DeployRouterGovernance internal script;
    PortfolioRouter internal router;
    ConsensusRecommendationReceipt internal receipts;
    address internal admin = makeAddr("gov-admin");

    function setUp() public {
        script = new DeployRouterGovernance();
        TestERC20 usdc = new TestERC20();
        VaultRegistry registry = new VaultRegistry(admin);
        router = new PortfolioRouter(address(usdc), address(registry), admin);
        InvestmentCommitteePolicy ic = new InvestmentCommitteePolicy(admin, address(this));
        receipts = new ConsensusRecommendationReceipt(admin, address(this), address(ic));
    }

    function test_stage_wiresTheWeightSetter() public {
        DeployRouterGovernance.Deployed memory d =
            script.runInProcessWith(admin, address(router), address(receipts));
        address gov = address(d.governance);
        assertEq(address(d.governance.router()), address(router));
        assertEq(address(d.governance.receipts()), address(receipts));
        assertTrue(router.hasRole(router.ADMIN_ROLE(), gov), "router ADMIN_ROLE");
        assertTrue(router.hasRole(router.WEIGHT_SETTER_ROLE(), gov), "router WEIGHT_SETTER_ROLE");
        assertEq(router.getRoleMemberCount(router.WEIGHT_SETTER_ROLE()), 1, "one router setter");
        assertTrue(receipts.hasRole(ADMIN_ROLE, gov), "receipt ADMIN_ROLE (release)");
        assertTrue(
            d.governance.hasRole(ADMIN_ROLE, admin), "deployer admin until the timelock stage"
        );
        assertTrue(
            d.governance.hasRole(WEIGHT_SETTER_ROLE, admin),
            "deployer setter until the timelock stage"
        );
    }

    /// @notice The router constructor seeds the deployer with the role. The stage drops it.
    function test_stage_deployerHoldsNoRouterWeightSetterRole() public {
        bytes32 role = router.WEIGHT_SETTER_ROLE();
        assertTrue(router.hasRole(role, admin), "precondition: deployer seeded");
        script.runInProcessWith(admin, address(router), address(receipts));
        assertFalse(router.hasRole(role, admin));
        assertTrue(
            router.hasRole(router.ADMIN_ROLE(), admin), "admin role stays until the timelock stage"
        );
    }

    /// @notice A deployer that does not administer the receipt register cannot wire the
    ///         release grant, and the stage stops instead of leaving applyReceipt dead.
    function test_stage_refusesWithoutReceiptAdmin() public {
        InvestmentCommitteePolicy ic = new InvestmentCommitteePolicy(admin, address(this));
        ConsensusRecommendationReceipt foreign = new ConsensusRecommendationReceipt(
            makeAddr("someone-else"), address(this), address(ic)
        );
        vm.expectRevert();
        script.runInProcessWith(admin, address(router), address(foreign));
    }

    function test_inProcess_refusesZeroInputs() public {
        vm.expectRevert(bytes("ADMIN_ADDRESS=0"));
        script.runInProcessWith(address(0), address(router), address(receipts));
        vm.expectRevert(bytes("ROUTER_ADDRESS=0"));
        script.runInProcessWith(admin, address(0), address(receipts));
        vm.expectRevert(bytes("CONSENSUS_RECEIPT_ADDRESS=0"));
        script.runInProcessWith(admin, address(router), address(0));
    }
}
