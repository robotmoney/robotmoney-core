// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0002-router-default-weights-on-chain.md (Amendment 2026-10-07)
// Canonical: docs/technical/security-model.md — Timelock overriding voted router weights
// Implements: core 1616 — bounded rotation path for WEIGHT_SETTER_ROLE
pragma solidity ^0.8.24;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {SafeGovernance} from "./helpers/SafeGovernance.sol";

/// @dev Any contract: a rotation target needs code, nothing else.
contract RotationStubGovernance {}

/// @title WeightSetterRotationTest
/// @notice One test per safety property of the rotation. Each test is mutation-checked: the
///         property's guard in `PortfolioRouter` is removed and the test must fail.
///         The Safe is a real SafeL2 proxy. State changes go through a two-signature
///         `execTransaction`. A call that must fail with an exact router error is replayed
///         with the Safe as `msg.sender` (`_assertSafeCallReverts`), because `execTransaction`
///         would hide that error as `GS013`.
///         The timelock is a real `TimelockController` at the production delay.
contract WeightSetterRotationTest is SafeGovernance {
    bytes32 internal constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 internal constant WEIGHT_SETTER_ROLE = keccak256("WEIGHT_SETTER_ROLE");
    bytes32 internal constant ROTATOR = keccak256("WEIGHT_SETTER_ROTATOR_ROLE");
    bytes32 internal constant EXECUTOR = keccak256("WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE");

    /// @dev The Base mainnet floor (172800 s). The test uses the production value.
    uint256 internal constant DELAY = 172800;

    PortfolioRouter internal router;
    TimelockController internal timelock;
    address internal safe;
    address internal deployer = makeAddr("deployer");
    address internal oldGov;
    address internal newGov;

    function setUp() public {
        TestERC20 usdc = new TestERC20();
        VaultRegistry registry = new VaultRegistry(deployer);
        router = new PortfolioRouter(address(usdc), address(registry), deployer);

        _installSafeSet();
        safe = _newDefaultSafe();
        // Safe is the only proposer and canceller, executor open, as DeployTimelock builds it.
        timelock = _newGovTimelock(safe, DELAY);

        oldGov = address(new RotationStubGovernance());
        newGov = address(new RotationStubGovernance());

        // The ceremony: governance gets the weight setter, the timelock gets ADMIN and the
        // executor role, the Safe gets the rotator role, and the deployer keeps nothing.
        vm.startPrank(deployer);
        router.grantRole(WEIGHT_SETTER_ROLE, oldGov);
        router.grantRole(ADMIN_ROLE, oldGov); // RouterGovernance holds ADMIN_ROLE on the router
        router.grantRole(ADMIN_ROLE, address(timelock));
        router.grantRole(ROTATOR, safe);
        router.grantRole(EXECUTOR, address(timelock));
        router.revokeRole(WEIGHT_SETTER_ROLE, deployer);
        router.revokeRole(ROTATOR, deployer);
        router.revokeRole(EXECUTOR, deployer);
        router.revokeRole(ADMIN_ROLE, deployer);
        vm.stopPrank();
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    function _unauthorized(address who, bytes32 role) internal pure returns (bytes memory) {
        return
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, who, role
            );
    }

    function _executeCall(address target) internal pure returns (bytes memory) {
        return abi.encodeCall(PortfolioRouter.executeWeightSetterRotation, (target));
    }

    /// @dev The Safe schedules `data` on the router through the timelock.
    function _schedule(bytes memory data, bytes32 salt) internal {
        _govSchedule(safe, timelock, address(router), data, salt, DELAY);
    }

    function _run(bytes memory data, bytes32 salt) internal {
        timelock.execute(address(router), 0, data, bytes32(0), salt);
    }

    function _propose(address target) internal {
        assertTrue(
            _safeExec(
                safe,
                address(router),
                abi.encodeCall(PortfolioRouter.proposeWeightSetterRotation, (target))
            ),
            "safe.execTransaction(propose) failed"
        );
    }

    function _proposeReverts(address target, bytes memory expected) internal {
        _assertSafeCallReverts(
            safe,
            address(router),
            abi.encodeCall(PortfolioRouter.proposeWeightSetterRotation, (target)),
            expected
        );
    }

    // ─── roles are separate and self-administered ────────────────────────────

    function test_rotationRoles_areSelfAdministered() public view {
        assertEq(router.getRoleAdmin(ROTATOR), ROTATOR);
        assertEq(router.getRoleAdmin(EXECUTOR), EXECUTOR);
        assertEq(router.getRoleAdmin(WEIGHT_SETTER_ROLE), WEIGHT_SETTER_ROLE);
    }

    function test_afterCeremony_eachRoleHasOneHolder() public view {
        assertEq(router.getRoleMemberCount(ROTATOR), 1);
        assertEq(router.getRoleMember(ROTATOR, 0), safe);
        assertEq(router.getRoleMemberCount(EXECUTOR), 1);
        assertEq(router.getRoleMember(EXECUTOR, 0), address(timelock));
        assertEq(router.getRoleMemberCount(WEIGHT_SETTER_ROLE), 1);
        assertEq(router.getRoleMember(WEIGHT_SETTER_ROLE, 0), oldGov);
    }

    // ─── the timelock alone cannot grant itself the role or set weights ──────

    function test_timelockAlone_cannotProposeOrCancel() public {
        vm.prank(address(timelock));
        vm.expectRevert(_unauthorized(address(timelock), ROTATOR));
        router.proposeWeightSetterRotation(newGov);

        _propose(newGov);
        vm.prank(address(timelock));
        vm.expectRevert(_unauthorized(address(timelock), ROTATOR));
        router.cancelWeightSetterRotation();
    }

    function test_timelockAlone_cannotGrantItselfTheWeightSetterOrRotatorRole() public {
        // The timelock already holds the executor role, which it administers: nothing to grant.
        bytes32[2] memory roles = [WEIGHT_SETTER_ROLE, ROTATOR];
        for (uint256 i = 0; i < roles.length; i++) {
            // Direct, as the timelock.
            vm.prank(address(timelock));
            vm.expectRevert(_unauthorized(address(timelock), roles[i]));
            router.grantRole(roles[i], address(timelock));

            // Through its own schedule and execute (the Safe schedules, as in production).
            bytes memory data =
                abi.encodeCall(IAccessControl.grantRole, (roles[i], address(timelock)));
            bytes32 salt = bytes32(i);
            _schedule(data, salt);
            vm.warp(block.timestamp + DELAY);
            vm.expectRevert();
            _run(data, salt);
        }
        assertFalse(router.hasRole(WEIGHT_SETTER_ROLE, address(timelock)));
        assertFalse(router.hasRole(ROTATOR, address(timelock)));
    }

    function test_timelockAlone_cannotSetActiveWeights() public {
        address[] memory v = new address[](0);
        uint256[] memory b = new uint256[](0);
        vm.prank(address(timelock));
        vm.expectRevert(_unauthorized(address(timelock), WEIGHT_SETTER_ROLE));
        router.setWeights(v, b);
    }

    function test_timelockAlone_cannotExecuteWithoutASafeProposal() public {
        bytes memory data = _executeCall(newGov);
        _schedule(data, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(PortfolioRouter.NoRotationPending.selector);
        _run(data, bytes32(0));
        assertTrue(router.hasRole(WEIGHT_SETTER_ROLE, oldGov));
    }

    // ─── the Safe alone cannot rotate ────────────────────────────────────────

    function test_safeAlone_cannotExecuteOrGrant() public {
        _propose(newGov);
        vm.warp(block.timestamp + DELAY + 1);
        _assertSafeCallReverts(
            safe, address(router), _executeCall(newGov), _unauthorized(safe, EXECUTOR)
        );

        _assertSafeCallReverts(
            safe,
            address(router),
            abi.encodeCall(IAccessControl.grantRole, (WEIGHT_SETTER_ROLE, newGov)),
            _unauthorized(safe, WEIGHT_SETTER_ROLE)
        );
        assertTrue(router.hasRole(WEIGHT_SETTER_ROLE, oldGov));
    }

    /// @dev The Safe schedules the timelock call early, waits out the delay, then proposes and
    ///      executes at once. The router measures the delay from the proposal, so this reverts.
    function test_executeBeforeDelayFromProposal_reverts() public {
        bytes memory data = _executeCall(newGov);
        _schedule(data, bytes32(0));
        vm.warp(block.timestamp + DELAY + 1);
        _propose(newGov);
        vm.expectRevert(
            abi.encodeWithSelector(
                PortfolioRouter.RotationNotReady.selector, block.timestamp + DELAY
            )
        );
        _run(data, bytes32(0));
        assertTrue(router.hasRole(WEIGHT_SETTER_ROLE, oldGov));
    }

    // ─── the happy path ──────────────────────────────────────────────────────

    function test_rotation_safeProposes_timelockExecutes_afterDelay() public {
        bytes memory data = _executeCall(newGov);

        vm.expectEmit(true, false, false, true, address(router));
        emit PortfolioRouter.WeightSetterRotationProposed(newGov, uint64(block.timestamp));
        _propose(newGov);
        (address pending, uint64 at) = router.pendingWeightSetterRotation();
        assertEq(pending, newGov);
        assertEq(at, uint64(block.timestamp));

        _schedule(data, bytes32(0));
        vm.warp(block.timestamp + DELAY);

        vm.expectEmit(true, false, false, true, address(router));
        emit PortfolioRouter.WeightSetterRotated(newGov, 1);
        _run(data, bytes32(0));

        assertTrue(router.hasRole(WEIGHT_SETTER_ROLE, newGov));
        assertFalse(router.hasRole(WEIGHT_SETTER_ROLE, oldGov));
        assertEq(router.getRoleMemberCount(WEIGHT_SETTER_ROLE), 1);
        (pending, at) = router.pendingWeightSetterRotation();
        assertEq(pending, address(0));
        assertEq(at, 0);
        // The Safe, the timelock and the deployer still do not hold the weight setter.
        assertFalse(router.hasRole(WEIGHT_SETTER_ROLE, safe));
        assertFalse(router.hasRole(WEIGHT_SETTER_ROLE, address(timelock)));
        assertFalse(router.hasRole(WEIGHT_SETTER_ROLE, deployer));
    }

    function test_afterRotation_oldHolderCannotSetWeights_newHolderPassesTheGate() public {
        bytes memory data = _executeCall(newGov);
        _propose(newGov);
        _schedule(data, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        _run(data, bytes32(0));

        address[] memory v = new address[](0);
        uint256[] memory b = new uint256[](0);
        vm.prank(oldGov);
        vm.expectRevert(_unauthorized(oldGov, WEIGHT_SETTER_ROLE));
        router.setWeights(v, b);

        // The new holder clears the access gate and stops at the weight-sum check.
        vm.prank(newGov);
        vm.expectRevert(PortfolioRouter.InvalidWeightSum.selector);
        router.setWeights(v, b);
    }

    /// @dev A holder is its own role admin and can grant the role to others. Execution
    ///      revokes every holder, so exactly one remains.
    function test_rotation_revokesEveryHolder_exactlyOneRemains() public {
        address extra = makeAddr("extra-holder");
        vm.prank(oldGov);
        router.grantRole(WEIGHT_SETTER_ROLE, extra);
        assertEq(router.getRoleMemberCount(WEIGHT_SETTER_ROLE), 2);

        bytes memory data = _executeCall(newGov);
        _propose(newGov);
        _schedule(data, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        _run(data, bytes32(0));

        assertEq(router.getRoleMemberCount(WEIGHT_SETTER_ROLE), 1);
        assertEq(router.getRoleMember(WEIGHT_SETTER_ROLE, 0), newGov);
        assertFalse(router.hasRole(WEIGHT_SETTER_ROLE, extra));
    }

    function test_rotation_canRunAgainAfterwards() public {
        bytes memory data = _executeCall(newGov);
        _propose(newGov);
        _schedule(data, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        _run(data, bytes32(0));

        address third = address(new RotationStubGovernance());
        _propose(third);
        bytes memory data2 = _executeCall(third);
        _schedule(data2, bytes32(uint256(1)));
        vm.warp(block.timestamp + DELAY);
        _run(data2, bytes32(uint256(1)));
        assertEq(router.getRoleMember(WEIGHT_SETTER_ROLE, 0), third);
    }

    // ─── RouterGovernance cannot touch the rotation ──────────────────────────

    /// @dev RouterGovernance holds ADMIN_ROLE on the router. That grants no rotation power.
    function test_routerGovernance_cannotProposeCancelOrExecute() public {
        vm.startPrank(oldGov);
        vm.expectRevert(_unauthorized(oldGov, ROTATOR));
        router.proposeWeightSetterRotation(newGov);
        vm.expectRevert(_unauthorized(oldGov, ROTATOR));
        router.cancelWeightSetterRotation();
        vm.expectRevert(_unauthorized(oldGov, EXECUTOR));
        router.executeWeightSetterRotation(newGov);
        // And ADMIN_ROLE cannot grant a rotation role.
        vm.expectRevert(_unauthorized(oldGov, ROTATOR));
        router.grantRole(ROTATOR, oldGov);
        vm.stopPrank();
    }

    /// @dev A hostile RouterGovernance with ADMIN_ROLE strips the timelock's ADMIN_ROLE. The
    ///      rotation still works, because the executor role is not administered by ADMIN_ROLE.
    function test_routerGovernance_revokingTimelockAdmin_doesNotBlockRotation() public {
        vm.startPrank(oldGov);
        router.revokeRole(ADMIN_ROLE, address(timelock));
        // ADMIN_ROLE does not administer the rotation roles, so the hostile holder cannot strip them.
        vm.expectRevert(_unauthorized(oldGov, EXECUTOR));
        router.revokeRole(EXECUTOR, address(timelock));
        vm.expectRevert(_unauthorized(oldGov, ROTATOR));
        router.revokeRole(ROTATOR, safe);
        vm.stopPrank();
        assertFalse(router.hasRole(ADMIN_ROLE, address(timelock)));

        bytes memory data = _executeCall(newGov);
        _propose(newGov);
        _schedule(data, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        _run(data, bytes32(0));
        assertEq(router.getRoleMember(WEIGHT_SETTER_ROLE, 0), newGov);
    }

    // ─── bounded: target, single pending, cancel ─────────────────────────────

    function test_propose_toZeroEoaOrEmptyAddress_reverts() public {
        address[3] memory bad = [address(0), makeAddr("an-eoa"), address(0xdead0000)];
        for (uint256 i = 0; i < bad.length; i++) {
            _proposeReverts(
                bad[i],
                abi.encodeWithSelector(PortfolioRouter.RotationTargetNotContract.selector, bad[i])
            );
        }
        (address pending,) = router.pendingWeightSetterRotation();
        assertEq(pending, address(0));
    }

    /// @dev Rotating to the timelock would give it WEIGHT_SETTER_ROLE and reopen the 1522 path.
    function test_propose_toRouterTimelockOrSafe_reverts() public {
        address[3] memory bad = [address(router), address(timelock), safe];
        for (uint256 i = 0; i < bad.length; i++) {
            _proposeReverts(
                bad[i],
                abi.encodeWithSelector(PortfolioRouter.RotationTargetForbidden.selector, bad[i])
            );
        }
    }

    /// @dev A target that became a rotation role holder after the proposal is refused at execution.
    function test_execute_toATargetThatNowHoldsARotationRole_reverts() public {
        bytes memory data = _executeCall(newGov);
        _propose(newGov);
        _schedule(data, bytes32(0));
        assertTrue(
            _safeExec(
                safe, address(router), abi.encodeCall(IAccessControl.grantRole, (ROTATOR, newGov))
            ),
            "safe.execTransaction(grant rotator) failed"
        );
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(
            abi.encodeWithSelector(PortfolioRouter.RotationTargetForbidden.selector, newGov)
        );
        _run(data, bytes32(0));
        assertTrue(router.hasRole(WEIGHT_SETTER_ROLE, oldGov));
    }

    function test_propose_whilePending_reverts() public {
        _propose(newGov);
        _proposeReverts(
            oldGov, abi.encodeWithSelector(PortfolioRouter.RotationAlreadyPending.selector)
        );
    }

    function test_execute_toADifferentTarget_reverts() public {
        _propose(newGov);
        address other = address(new RotationStubGovernance());
        bytes memory data = _executeCall(other);
        _schedule(data, bytes32(0));
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(
            abi.encodeWithSelector(PortfolioRouter.RotationTargetMismatch.selector, newGov, other)
        );
        _run(data, bytes32(0));
    }

    function test_cancel_clearsPending_andExecuteThenReverts() public {
        bytes memory data = _executeCall(newGov);
        _propose(newGov);
        _schedule(data, bytes32(0));

        vm.expectEmit(true, true, false, true, address(router));
        emit PortfolioRouter.WeightSetterRotationCancelled(newGov, safe);
        assertTrue(
            _safeExec(
                safe,
                address(router),
                abi.encodeCall(PortfolioRouter.cancelWeightSetterRotation, ())
            ),
            "safe.execTransaction(cancel) failed"
        );
        (address pending,) = router.pendingWeightSetterRotation();
        assertEq(pending, address(0));

        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(PortfolioRouter.NoRotationPending.selector);
        _run(data, bytes32(0));
        assertTrue(router.hasRole(WEIGHT_SETTER_ROLE, oldGov));

        // The Safe can propose again after a cancel.
        _propose(newGov);
    }

    function test_cancel_withNothingPending_reverts() public {
        _assertSafeCallReverts(
            safe,
            address(router),
            abi.encodeCall(PortfolioRouter.cancelWeightSetterRotation, ()),
            abi.encodeWithSelector(PortfolioRouter.NoRotationPending.selector)
        );
    }

    /// @dev An executor that is not a timelock has no delay to read, so it cannot execute.
    function test_execute_byAnExecutorThatIsNotATimelock_reverts() public {
        address eoaExecutor = makeAddr("eoa-executor");
        vm.prank(address(timelock));
        router.grantRole(EXECUTOR, eoaExecutor);
        _propose(newGov);
        vm.warp(block.timestamp + DELAY);
        vm.prank(eoaExecutor);
        vm.expectRevert();
        router.executeWeightSetterRotation(newGov);
    }
}
