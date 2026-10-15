// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §2.3 — Governance Boundary
// Canonical: docs/technical/governance-decisions.md §3.6 — setWeights call path
// Implements: issue #1698 — the weight setter applies a consensus receipt in one call; voting deleted.
//             The governance stage deploys the weight setter with no voting surface and wires the
//             router roles; the receipt register is wired by stage 11.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {DeployRouterGovernance} from "../script/DeployRouterGovernance.s.sol";
import {RouterGovernance} from "../RouterGovernance.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {Proxied} from "./helpers/Proxied.sol";

/// @dev What the governance stage (DeployRouterGovernance) leaves on a fresh
///      router: the weight setter holds both router roles, the deployer keeps
///      router ADMIN_ROLE until stage 11 and no WEIGHT_SETTER_ROLE, and the
///      deployed bytecode carries no voting surface. The quorum-floor tests this
///      file used to hold went with the quorum (issue #1698).
contract DeployRouterGovernanceDefaultsTest is Test {
    DeployRouterGovernance internal script;
    PortfolioRouter internal router;
    address internal admin = makeAddr("gov-admin");

    function setUp() public {
        script = new DeployRouterGovernance();
        TestERC20 usdc = new TestERC20();
        VaultRegistry registry = Proxied.vaultRegistry(admin);
        router = Proxied.portfolioRouter(address(usdc), address(registry), admin);
    }

    // ─── Stage 7 wires the weight setter ─────────────────────────────────────

    /// @notice The stage grants WEIGHT_SETTER_ROLE to RouterGovernance, the sole setWeights gate.
    function test_stage7_grantsWeightSetterRoleToGovernance() public {
        DeployRouterGovernance.Deployed memory d = script.runInProcessWith(admin, address(router));
        assertTrue(router.hasRole(router.WEIGHT_SETTER_ROLE(), address(d.governance)));
        assertEq(router.getRoleMemberCount(router.WEIGHT_SETTER_ROLE()), 1, "one weight setter");
    }

    /// @notice The stage grants router ADMIN_ROLE to RouterGovernance (setDefaultWeights,
    ///         clearVotedWeights) and reads it back.
    function test_stage7_grantsRouterAdminRoleToGovernance() public {
        DeployRouterGovernance.Deployed memory d = script.runInProcessWith(admin, address(router));
        assertTrue(router.hasRole(router.ADMIN_ROLE(), address(d.governance)));
    }

    /// @notice The router constructor seeds the deployer with the setter. The stage drops it.
    function test_stage7_deployerHoldsNoWeightSetterRole() public {
        bytes32 role = router.WEIGHT_SETTER_ROLE();
        assertTrue(router.hasRole(role, admin), "precondition: deployer seeded");
        script.runInProcessWith(admin, address(router));
        assertFalse(router.hasRole(role, admin));
        assertTrue(router.hasRole(router.ADMIN_ROLE(), admin), "admin role stays until stage 11");
    }

    /// @notice The governance contract's ADMIN_ROLE is the deployer's until stage 11.
    function test_stage7_governanceAdminIsTheDeployer() public {
        DeployRouterGovernance.Deployed memory d = script.runInProcessWith(admin, address(router));
        assertTrue(d.governance.hasRole(d.governance.ADMIN_ROLE(), admin));
        assertEq(d.admin, admin);
        assertEq(address(d.router), address(router));
        assertEq(address(d.governance.router()), address(router));
    }

    /// @notice The register is not known at this stage (it is deployed later), so
    ///         `applyReceipt` refuses until stage 11 wires it.
    function test_stage7_leavesTheReceiptRegisterForStage11() public {
        DeployRouterGovernance.Deployed memory d = script.runInProcessWith(admin, address(router));
        assertEq(address(d.governance.receiptContract()), address(0));
        vm.prank(admin);
        vm.expectRevert(RouterGovernance.ReceiptContractNotSet.selector);
        d.governance
            .applyReceipt(keccak256("r"), keccak256("d"), new address[](0), new uint256[](0));
    }

    /// @notice The stage refuses to wire a weight setter when the caller cannot grant
    ///         router ADMIN_ROLE: a governance contract that cannot act is a broken
    ///         deployment, not a safer one.
    function test_stage7_refusesWhenCallerLacksRouterAdminRole() public {
        address notAdmin = makeAddr("not-the-router-admin");
        vm.expectRevert(
            bytes(
                "caller lacks router ADMIN_ROLE: cannot wire governance (run this script before DeployTimelock hands the router ADMIN_ROLE away)"
            )
        );
        script.runInProcessWith(notAdmin, address(router));
    }

    function test_stage7_refusesZeroAddresses() public {
        vm.expectRevert(bytes("ADMIN_ADDRESS=0"));
        script.runInProcessWith(address(0), address(router));
        vm.expectRevert(bytes("ROUTER_ADDRESS=0"));
        script.runInProcessWith(admin, address(0));
    }

    // ─── No voting surface on the deployed artifact ──────────────────────────

    /// @notice Issue #1698: the bytecode the stage deploys answers none of the
    ///         voting selectors. A missing selector reverts with empty data.
    function test_deployedGovernanceHasNoVotingSurface() public {
        DeployRouterGovernance.Deployed memory d = script.runInProcessWith(admin, address(router));
        address gov = address(d.governance);
        bytes[] memory gone = new bytes[](9);
        gone[0] = abi.encodeWithSignature(
            "propose(address[],uint256[])", new address[](0), new uint256[](0)
        );
        gone[1] = abi.encodeWithSignature("vote(uint256)", uint256(1));
        gone[2] = abi.encodeWithSignature("execute(uint256)", uint256(1));
        gone[3] = abi.encodeWithSignature("setVotingPower(address,uint256)", admin, uint256(1));
        gone[4] = abi.encodeWithSignature("votingPower(address)", admin);
        gone[5] = abi.encodeWithSignature("quorumThreshold()");
        gone[6] = abi.encodeWithSignature("votingPeriod()");
        gone[7] = abi.encodeWithSignature("executionDelay()");
        gone[8] = abi.encodeWithSignature("totalVotingPower()");
        for (uint256 i = 0; i < gone.length; i++) {
            vm.prank(admin);
            (bool ok, bytes memory ret) = gov.call(gone[i]);
            assertFalse(ok, "a voting selector still answers on the deployed artifact");
            assertEq(ret.length, 0, "a voting selector still exists on the deployed artifact");
        }
    }
}
