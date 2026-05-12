// SPDX-License-Identifier: MIT
// Canonical: none — Foundry test for contracts/gateway/RobotMoneyGateway.sol
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {AccessRoles} from "../gateway/AccessRoles.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {MockVault} from "../gateway/MockVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";

/// @dev Minimal fee-on-transfer token used to assert the gateway's
///      balance-delta defense (`FeeOnTransferDetected`). Charges 1% on transfer.
contract FeeOnTransferUSDC is TestERC20 {
    function transfer(address to, uint256 amount) public override returns (bool) {
        uint256 fee = amount / 100;
        super.transfer(address(0xdead), fee);
        return super.transfer(to, amount - fee);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 fee = amount / 100;
        // Pull full amount, route fee to burn, rest to receiver.
        super.transferFrom(from, address(0xdead), fee);
        return super.transferFrom(from, to, amount - fee);
    }
}

/// @dev Vault that mints an extra share to `msg.sender` (the gateway) on
///      deposit, simulating a malicious / buggy 4626 implementation that
///      re-routes shares to the caller. Trips the post-call rmUSDC custody
///      invariant.
contract ShareLeakVault is MockVault {
    constructor(address asset_) MockVault(asset_) {}

    function deposit(uint256 assets, address receiver) external override returns (uint256 shares) {
        IERC20(address(assetToken)).transferFrom(msg.sender, address(this), assets);
        shares = assets;
        _mint(receiver, shares);
        // Side-channel: also mint one rmUSDC share to the caller (gateway).
        _mint(msg.sender, 1);
    }
}

/// @dev Vault that under-pulls USDC on deposit so the gateway is left holding
///      leftover stablecoin after the call — trips the post-call USDC custody
///      invariant.
contract UnderPullVault is MockVault {
    constructor(address asset_) MockVault(asset_) {}

    function deposit(uint256 assets, address receiver) external override returns (uint256 shares) {
        // Pull `assets - 1` instead of `assets`. Gateway will end up with 1
        // wei of USDC stuck in custody.
        IERC20(address(assetToken)).transferFrom(msg.sender, address(this), assets - 1);
        shares = assets;
        _mint(receiver, shares);
    }
}

/// @dev Vault that attempts to re-enter `gateway.deposit()` during its own
///      `deposit()` call, simulating a malicious/compromised vault reentrant
///      callback. Expects the `nonReentrant` guard to block the second entry.
contract ReentrantVault is MockVault {
    RobotMoneyGateway public gateway;
    bool public attackArmed;

    // Parameters needed to attempt the second deposit call.
    bytes32 public reentrantOrderId;
    uint256 public reentrantAmount;
    uint64 public reentrantDeadline;
    bytes32 public reentrantIdemKey;

    constructor(address asset_) MockVault(asset_) {}

    function setGateway(RobotMoneyGateway gw) external {
        gateway = gw;
    }

    function armAttack(bytes32 orderId, uint256 amount, uint64 deadline, bytes32 idemKey) external {
        reentrantOrderId = orderId;
        reentrantAmount = amount;
        reentrantDeadline = deadline;
        reentrantIdemKey = idemKey;
        attackArmed = true;
    }

    function deposit(uint256 assets, address receiver) external override returns (uint256 shares) {
        IERC20(address(assetToken)).transferFrom(msg.sender, address(this), assets);
        shares = assets;
        _mint(receiver, shares);

        if (attackArmed) {
            attackArmed = false;
            // Attempt reentrancy — the nonReentrant modifier must block this.
            gateway.deposit(reentrantOrderId, reentrantAmount, reentrantDeadline, reentrantIdemKey);
        }
    }
}

contract RobotMoneyGatewayTest is Test {
    TestERC20 internal usdc;
    MockVault internal vault;
    RobotMoneyGateway internal gateway;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal agent = makeAddr("agent");
    address internal otherAgent = makeAddr("otherAgent");
    address internal stranger = makeAddr("stranger");
    address internal shareReceiver = makeAddr("shareReceiver");

    bytes32 internal adminRole;
    bytes32 internal pauserRole;
    bytes32 internal agentRole;

    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant MAX_PER_PAYMENT = 1_000 * ONE_USDC; // 1,000 USDC
    uint256 internal constant MAX_PER_WINDOW = 5_000 * ONE_USDC; // 5,000 USDC

    function setUp() public {
        usdc = new TestERC20();
        vault = new MockVault(address(usdc));
        gateway =
            new RobotMoneyGateway(IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser);

        adminRole = gateway.ADMIN_ROLE();
        pauserRole = gateway.PAUSER_ROLE();
        agentRole = gateway.AGENT_ROLE();

        // Pin a non-trivial timestamp so window math has headroom on both sides.
        vm.warp(1_700_000_000);
    }

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    function _defaultPolicy() internal view returns (IGateway.AgentPolicy memory) {
        return IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver
        });
    }

    /// @dev Default owner used by `_authorize` when none is specified.
    ///      Matches the pre-#269 admin-as-authorizer behavior at the test
    ///      level while exercising the new permissionless path under the
    ///      hood (any EOA may authorize; recorded owner == msg.sender).
    address internal depositor = makeAddr("depositor");

    function _authorize(address who, IGateway.AgentPolicy memory p) internal {
        _authorizeAs(depositor, who, p);
    }

    function _authorizeAs(address owner, address who, IGateway.AgentPolicy memory p) internal {
        vm.prank(owner);
        gateway.authorizeAgent(who, p);
    }

    function _fundAndApprove(address who, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.prank(who);
        usdc.approve(address(gateway), amt);
    }

    // -------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------

    function test_constructor_wiresImmutablesAndRoles() public view {
        assertEq(gateway.usdc(), address(usdc));
        assertEq(gateway.vault(), address(vault));
        assertEq(gateway.WINDOW_SECONDS(), 86400);
        assertFalse(gateway.paused());
        assertTrue(gateway.hasRole(adminRole, admin));
        assertTrue(gateway.hasRole(pauserRole, pauser));
        assertTrue(gateway.hasRole(0x00, admin)); // DEFAULT_ADMIN_ROLE
    }

    function test_constructor_revertsOnZeroAddresses() public {
        vm.expectRevert(RobotMoneyGateway.ZeroAddress.selector);
        new RobotMoneyGateway(IERC20(address(0)), IERC4626(address(vault)), admin, pauser);

        vm.expectRevert(RobotMoneyGateway.ZeroAddress.selector);
        new RobotMoneyGateway(IERC20(address(usdc)), IERC4626(address(0)), admin, pauser);

        vm.expectRevert(RobotMoneyGateway.ZeroAddress.selector);
        new RobotMoneyGateway(IERC20(address(usdc)), IERC4626(address(vault)), address(0), pauser);

        vm.expectRevert(RobotMoneyGateway.ZeroAddress.selector);
        new RobotMoneyGateway(IERC20(address(usdc)), IERC4626(address(vault)), admin, address(0));
    }

    function test_constructor_revertsOnAssetMismatch() public {
        TestERC20 otherUsdc = new TestERC20();
        vm.expectRevert(RobotMoneyGateway.AssetMismatch.selector);
        new RobotMoneyGateway(IERC20(address(otherUsdc)), IERC4626(address(vault)), admin, pauser);
    }

    // -------------------------------------------------------------------
    // authorizeAgent / revokeAgent
    // -------------------------------------------------------------------

    function test_authorizeAgent_grantsRoleAndStoresPolicy() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();

        vm.expectEmit(true, true, false, true, address(gateway));
        emit IGateway.AgentAuthorized(
            agent, depositor, p.validUntil, p.maxPerPayment, p.maxPerWindow, p.shareReceiver
        );
        vm.prank(depositor);
        gateway.authorizeAgent(agent, p);

        assertTrue(gateway.hasRole(agentRole, agent));
        assertEq(gateway.agentOwner(agent), depositor);

        (bool active, uint64 validUntil, uint256 maxPay, uint256 maxWin, address recv) =
            gateway.agents(agent);
        assertTrue(active);
        assertEq(validUntil, p.validUntil);
        assertEq(maxPay, p.maxPerPayment);
        assertEq(maxWin, p.maxPerWindow);
        assertEq(recv, shareReceiver);
    }

    /// @dev AC: a non-`ADMIN_ROLE` EOA calls `authorizeAgent` and the gateway
    ///      records `(msg.sender, agent)` as the owner pair (issue #269).
    function test_authorizeAgent_permissionless() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        address eoa = makeAddr("random-depositor-eoa");
        assertFalse(gateway.hasRole(adminRole, eoa), "EOA must not hold ADMIN_ROLE");

        vm.prank(eoa);
        gateway.authorizeAgent(agent, p);

        assertEq(gateway.agentOwner(agent), eoa);
        assertTrue(gateway.hasRole(agentRole, agent));
    }

    /// @dev AC: calling `authorizeAgent` from an EOA holding no roles does
    ///      not revert (issue #269).
    function test_authorizeAgent_no_longer_requires_admin_role() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        address rolelessEoa = makeAddr("roleless-eoa");
        assertFalse(gateway.hasRole(adminRole, rolelessEoa), "no ADMIN_ROLE");
        assertFalse(gateway.hasRole(pauserRole, rolelessEoa), "no PAUSER_ROLE");
        assertFalse(gateway.hasRole(agentRole, rolelessEoa), "no AGENT_ROLE");

        vm.prank(rolelessEoa);
        gateway.authorizeAgent(agent, p);
    }

    function test_authorizeAgent_revertsOnRoleSeparation_grantingAgentToAdmin() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        vm.prank(depositor);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        gateway.authorizeAgent(admin, p);
    }

    function test_authorizeAgent_revertsOnRoleSeparation_grantingAgentToPauser() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        vm.prank(depositor);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        gateway.authorizeAgent(pauser, p);
    }

    function test_authorizeAgent_revertsOnZeroShareReceiver() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        p.shareReceiver = address(0);
        vm.prank(depositor);
        vm.expectRevert(RobotMoneyGateway.InvalidShareReceiver.selector);
        gateway.authorizeAgent(agent, p);
    }

    function test_authorizeAgent_revertsOnInactivePolicy() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        p.active = false;
        vm.prank(depositor);
        vm.expectRevert(RobotMoneyGateway.InvalidValidUntil.selector);
        gateway.authorizeAgent(agent, p);
    }

    function test_authorizeAgent_revertsOnZeroCaps() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        p.maxPerPayment = 0;
        vm.prank(depositor);
        vm.expectRevert(RobotMoneyGateway.InvalidAmount.selector);
        gateway.authorizeAgent(agent, p);
    }

    function test_authorizeAgent_revertsWhenPaymentCapExceedsWindowCap() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        p.maxPerPayment = p.maxPerWindow + 1;
        vm.prank(depositor);
        vm.expectRevert(RobotMoneyGateway.InvalidAmount.selector);
        gateway.authorizeAgent(agent, p);
    }

    /// @dev Re-authorizing an already-owned agent is rejected; the owner
    ///      must `setPolicy` (or `revokeAgent` first). Replaces the
    ///      pre-#269 "admin re-authorizes" semantic.
    function test_authorizeAgent_revertsWhenAlreadyOwned() public {
        _authorize(agent, _defaultPolicy());

        address otherDepositor = makeAddr("other-depositor");
        IGateway.AgentPolicy memory p = _defaultPolicy();
        vm.prank(otherDepositor);
        vm.expectRevert(RobotMoneyGateway.AgentAlreadyOwned.selector);
        gateway.authorizeAgent(agent, p);

        // Even the original owner cannot re-authorize via this entrypoint
        // — they must use `setPolicy`.
        vm.prank(depositor);
        vm.expectRevert(RobotMoneyGateway.AgentAlreadyOwned.selector);
        gateway.authorizeAgent(agent, p);
    }

    function test_setPolicy_updatesPolicyKeepsRoleAndOwner() public {
        _authorize(agent, _defaultPolicy());

        IGateway.AgentPolicy memory updated = _defaultPolicy();
        updated.maxPerPayment = 42 * ONE_USDC;

        vm.expectEmit(true, true, false, true, address(gateway));
        emit IGateway.AgentAuthorized(
            agent,
            depositor,
            updated.validUntil,
            updated.maxPerPayment,
            updated.maxPerWindow,
            updated.shareReceiver
        );
        vm.prank(depositor);
        gateway.setPolicy(agent, updated);

        assertTrue(gateway.hasRole(agentRole, agent));
        assertEq(gateway.agentOwner(agent), depositor);
        (,, uint256 maxPay,,) = gateway.agents(agent);
        assertEq(maxPay, 42 * ONE_USDC);
    }

    /// @dev AC: only the recorded owner can update policy for an agent
    ///      they authorized (issue #269).
    function test_setPolicy_requires_recorded_owner() public {
        _authorize(agent, _defaultPolicy());

        IGateway.AgentPolicy memory updated = _defaultPolicy();
        updated.maxPerPayment = 7 * ONE_USDC;

        // A third party may not update policy.
        vm.prank(stranger);
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.setPolicy(agent, updated);

        // Even ADMIN_ROLE holders have no authority over the depositor's
        // agent — admin must revert with the same ownership error.
        vm.prank(admin);
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.setPolicy(agent, updated);

        // Recorded owner succeeds.
        vm.prank(depositor);
        gateway.setPolicy(agent, updated);
        (,, uint256 maxPay,,) = gateway.agents(agent);
        assertEq(maxPay, 7 * ONE_USDC);
    }

    function test_setPolicy_revertsOnZeroAgent() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        vm.prank(depositor);
        vm.expectRevert(RobotMoneyGateway.ZeroAddress.selector);
        gateway.setPolicy(address(0), p);
    }

    function test_setPolicy_revertsBeforeAuthorize() public {
        // No prior authorize ⇒ no recorded owner ⇒ NotAgentOwner.
        IGateway.AgentPolicy memory p = _defaultPolicy();
        vm.prank(depositor);
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.setPolicy(agent, p);
    }

    function test_setPolicy_validatesPolicyShape() public {
        _authorize(agent, _defaultPolicy());
        IGateway.AgentPolicy memory bad = _defaultPolicy();
        bad.shareReceiver = address(0);

        vm.prank(depositor);
        vm.expectRevert(RobotMoneyGateway.InvalidShareReceiver.selector);
        gateway.setPolicy(agent, bad);
    }

    function test_revokeAgent_clearsPolicyAndRoleAndOwner() public {
        _authorize(agent, _defaultPolicy());

        vm.expectEmit(true, true, false, false, address(gateway));
        emit IGateway.AgentRevoked(agent, depositor);
        vm.prank(depositor);
        gateway.revokeAgent(agent);

        assertFalse(gateway.hasRole(agentRole, agent));
        (bool active,,,,) = gateway.agents(agent);
        assertFalse(active);
        assertEq(gateway.agentOwner(agent), address(0));
    }

    /// @dev AC: only the recorded owner can revoke; a third-party caller
    ///      reverts with the new ownership-check error (issue #269).
    function test_revokeAgent_requires_recorded_owner() public {
        _authorize(agent, _defaultPolicy());

        vm.prank(stranger);
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.revokeAgent(agent);

        // ADMIN_ROLE no longer carries authority over agents.
        vm.prank(admin);
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.revokeAgent(agent);

        // Recorded owner succeeds.
        vm.prank(depositor);
        gateway.revokeAgent(agent);
        assertFalse(gateway.hasRole(agentRole, agent));
    }

    /// @dev After revoke, the agent address is releasable: a fresh depositor
    ///      can claim it via `authorizeAgent`. This is the round-trip
    ///      property the dapp's onboarding wizard relies on.
    function test_revokeAgent_then_authorizeAgent_by_different_owner() public {
        _authorize(agent, _defaultPolicy());
        vm.prank(depositor);
        gateway.revokeAgent(agent);

        address freshDepositor = makeAddr("fresh-depositor");
        IGateway.AgentPolicy memory p = _defaultPolicy();
        vm.prank(freshDepositor);
        gateway.authorizeAgent(agent, p);

        assertEq(gateway.agentOwner(agent), freshDepositor);
    }

    // -------------------------------------------------------------------
    // pause / unpause
    // -------------------------------------------------------------------

    function test_pause_byPauser_unpause_byAdmin() public {
        vm.expectEmit(true, false, false, false, address(gateway));
        emit IGateway.Paused(pauser);
        vm.prank(pauser);
        gateway.pause();
        assertTrue(gateway.paused());

        vm.expectEmit(true, false, false, false, address(gateway));
        emit IGateway.Unpaused(admin);
        vm.prank(admin);
        gateway.unpause();
        assertFalse(gateway.paused());
    }

    function test_pause_nonPauserReverts() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, pauserRole
            )
        );
        gateway.pause();
    }

    function test_unpause_nonAdminReverts() public {
        vm.prank(pauser);
        gateway.pause();
        vm.prank(pauser);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, pauser, adminRole
            )
        );
        gateway.unpause();
    }

    function test_pause_revertsIfAlreadyPaused() public {
        vm.prank(pauser);
        gateway.pause();
        vm.prank(pauser);
        vm.expectRevert(RobotMoneyGateway.PausedError.selector);
        gateway.pause();
    }

    function test_unpause_revertsIfNotPaused() public {
        vm.prank(admin);
        vm.expectRevert(RobotMoneyGateway.NotPaused.selector);
        gateway.unpause();
    }

    // -------------------------------------------------------------------
    // deposit — happy path
    // -------------------------------------------------------------------

    function test_deposit_happyPath_movesUsdcMintsSharesEmitsEvent() public {
        _authorize(agent, _defaultPolicy());
        uint256 amount = 100 * ONE_USDC;
        _fundAndApprove(agent, amount);

        bytes32 orderId = keccak256("order-1");
        bytes32 idem = keccak256("idem-1");
        uint64 deadline = uint64(block.timestamp + 60);

        bytes32 expectedPaymentId =
            keccak256(abi.encode(block.chainid, address(gateway), agent, orderId, amount, idem));
        uint64 expectedWindowId = uint64(block.timestamp / gateway.WINDOW_SECONDS());

        vm.expectEmit(true, true, true, true, address(gateway));
        emit IGateway.AgentDeposit(
            expectedPaymentId, orderId, agent, shareReceiver, amount, amount, expectedWindowId
        );

        vm.prank(agent);
        (bytes32 paymentId, uint256 sharesMinted) = gateway.deposit(orderId, amount, deadline, idem);

        assertEq(paymentId, expectedPaymentId);
        assertEq(sharesMinted, amount);

        // Funds moved.
        assertEq(usdc.balanceOf(agent), 0);
        assertEq(usdc.balanceOf(address(gateway)), 0);
        assertEq(usdc.balanceOf(address(vault)), amount);

        // Shares routed.
        assertEq(vault.balanceOf(shareReceiver), amount);
        assertEq(vault.balanceOf(address(gateway)), 0);

        // Bookkeeping.
        assertEq(gateway.agentWindowGross(agent, expectedWindowId), amount);
        assertTrue(gateway.usedPaymentIds(paymentId));

        // Allowance to vault must be cleared.
        assertEq(usdc.allowance(address(gateway), address(vault)), 0);
    }

    // -------------------------------------------------------------------
    // deposit — refusals
    // -------------------------------------------------------------------

    function test_deposit_revertsWhenPaused() public {
        _authorize(agent, _defaultPolicy());
        _fundAndApprove(agent, 100 * ONE_USDC);
        vm.prank(pauser);
        gateway.pause();

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.PausedError.selector);
        gateway.deposit(bytes32("o"), 100 * ONE_USDC, uint64(block.timestamp + 60), bytes32("i"));
    }

    function test_deposit_revertsForUnauthorizedCaller() public {
        // agent doesn't have AGENT_ROLE; expect AccessControl revert.
        _fundAndApprove(stranger, 100 * ONE_USDC);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, agentRole
            )
        );
        gateway.deposit(bytes32("o"), 100 * ONE_USDC, uint64(block.timestamp + 60), bytes32("i"));
    }

    function test_deposit_revertsAfterRevokeAgent() public {
        _authorize(agent, _defaultPolicy());
        vm.prank(depositor);
        gateway.revokeAgent(agent);

        _fundAndApprove(agent, 100 * ONE_USDC);
        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, agent, agentRole
            )
        );
        gateway.deposit(bytes32("o"), 100 * ONE_USDC, uint64(block.timestamp + 60), bytes32("i"));
    }

    function test_deposit_revertsOnZeroAmount() public {
        _authorize(agent, _defaultPolicy());
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.InvalidAmount.selector);
        gateway.deposit(bytes32("o"), 0, uint64(block.timestamp + 60), bytes32("i"));
    }

    function test_deposit_revertsOnPerPaymentCapExceeded() public {
        _authorize(agent, _defaultPolicy());
        _fundAndApprove(agent, MAX_PER_PAYMENT + 1);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.AmountExceedsPerPaymentCap.selector);
        gateway.deposit(
            bytes32("o"), MAX_PER_PAYMENT + 1, uint64(block.timestamp + 60), bytes32("i")
        );
    }

    function test_deposit_revertsOnExpiredDeadline() public {
        _authorize(agent, _defaultPolicy());
        _fundAndApprove(agent, 100 * ONE_USDC);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.DeadlineExpired.selector);
        gateway.deposit(bytes32("o"), 100 * ONE_USDC, uint64(block.timestamp - 1), bytes32("i"));
    }

    function test_deposit_revertsOnDeadlineTooFar() public {
        _authorize(agent, _defaultPolicy());
        _fundAndApprove(agent, 100 * ONE_USDC);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.DeadlineTooFar.selector);
        gateway.deposit(bytes32("o"), 100 * ONE_USDC, uint64(block.timestamp + 601), bytes32("i"));
    }

    function test_deposit_revertsOnExpiredPolicy() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        p.validUntil = uint64(block.timestamp + 100);
        _authorize(agent, p);
        _fundAndApprove(agent, 100 * ONE_USDC);

        vm.warp(block.timestamp + 200);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.AgentPolicyExpired.selector);
        gateway.deposit(bytes32("o"), 100 * ONE_USDC, uint64(block.timestamp + 60), bytes32("i"));
    }

    function test_deposit_revertsOnWindowCapExceeded_andRollsOver() public {
        // Tighten window to 2x payment cap.
        IGateway.AgentPolicy memory p = _defaultPolicy();
        p.maxPerWindow = 2 * MAX_PER_PAYMENT;
        _authorize(agent, p);
        _fundAndApprove(agent, 5 * MAX_PER_PAYMENT);

        // Two payments at the cap consume the window.
        vm.prank(agent);
        gateway.deposit(bytes32("o1"), MAX_PER_PAYMENT, uint64(block.timestamp + 60), bytes32("i1"));
        vm.prank(agent);
        gateway.deposit(bytes32("o2"), MAX_PER_PAYMENT, uint64(block.timestamp + 60), bytes32("i2"));

        // Third in same window must revert.
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.WindowCapExceeded.selector);
        gateway.deposit(bytes32("o3"), 1, uint64(block.timestamp + 60), bytes32("i3"));

        // Roll over to next window — should succeed.
        vm.warp(block.timestamp + gateway.WINDOW_SECONDS());
        vm.prank(agent);
        gateway.deposit(bytes32("o4"), MAX_PER_PAYMENT, uint64(block.timestamp + 60), bytes32("i4"));
    }

    function test_deposit_revertsOnReplay_sameOrderAndIdempotencyKey() public {
        _authorize(agent, _defaultPolicy());
        _fundAndApprove(agent, 200 * ONE_USDC);

        bytes32 orderId = keccak256("order-X");
        bytes32 idem = keccak256("idem-X");
        uint256 amount = 100 * ONE_USDC;

        vm.prank(agent);
        gateway.deposit(orderId, amount, uint64(block.timestamp + 60), idem);

        // Even with a different deadline, replay must be rejected
        // (deadline is intentionally excluded from the paymentId).
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.PaymentIdAlreadyUsed.selector);
        gateway.deposit(orderId, amount, uint64(block.timestamp + 120), idem);
    }

    function test_deposit_perAgentWindowsAreIndependent() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        p.maxPerWindow = MAX_PER_PAYMENT; // each agent gets one payment per window
        _authorize(agent, p);
        _authorize(otherAgent, p);

        _fundAndApprove(agent, MAX_PER_PAYMENT);
        _fundAndApprove(otherAgent, MAX_PER_PAYMENT);

        vm.prank(agent);
        gateway.deposit(bytes32("a1"), MAX_PER_PAYMENT, uint64(block.timestamp + 60), bytes32("ia"));
        // otherAgent must have its own untouched window allowance.
        vm.prank(otherAgent);
        gateway.deposit(bytes32("b1"), MAX_PER_PAYMENT, uint64(block.timestamp + 60), bytes32("ib"));
    }

    function test_deposit_revertsOnFeeOnTransferToken() public {
        // Fresh deployment using fee-on-transfer token.
        FeeOnTransferUSDC fotUsdc = new FeeOnTransferUSDC();
        MockVault fotVault = new MockVault(address(fotUsdc));
        RobotMoneyGateway fotGateway = new RobotMoneyGateway(
            IERC20(address(fotUsdc)), IERC4626(address(fotVault)), admin, pauser
        );

        IGateway.AgentPolicy memory p = _defaultPolicy();
        vm.prank(depositor);
        fotGateway.authorizeAgent(agent, p);

        fotUsdc.mint(agent, 200 * ONE_USDC);
        vm.prank(agent);
        fotUsdc.approve(address(fotGateway), 200 * ONE_USDC);

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.FeeOnTransferDetected.selector);
        fotGateway.deposit(bytes32("o"), 100 * ONE_USDC, uint64(block.timestamp + 60), bytes32("i"));
    }

    // -------------------------------------------------------------------
    // AC-named gates: deposit + role-separation regression coverage
    // -------------------------------------------------------------------

    /// @dev AC: `deposit()` still reverts for non-AGENT_ROLE callers. The
    ///      depositor-owned authorize redesign must not weaken the deposit
    ///      surface in any way (issue #269).
    function test_deposit_still_gated_on_agent_role() public {
        // Recorded owner alone is not enough; the recorded owner is NOT
        // granted AGENT_ROLE, only the agent address itself is. So a
        // depositor calling deposit() directly must revert.
        _authorize(agent, _defaultPolicy());

        _fundAndApprove(depositor, 100 * ONE_USDC);
        vm.prank(depositor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, depositor, agentRole
            )
        );
        gateway.deposit(bytes32("o"), 100 * ONE_USDC, uint64(block.timestamp + 60), bytes32("i"));

        // And a true stranger likewise.
        _fundAndApprove(stranger, 100 * ONE_USDC);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, agentRole
            )
        );
        gateway.deposit(bytes32("o"), 100 * ONE_USDC, uint64(block.timestamp + 60), bytes32("i"));
    }

    /// @dev AC: `_grantRole` and `_assertRoleSeparation` continue to reject
    ///      overlap on the roles that survive (issue #269).
    function test_role_separation_invariants_hold() public {
        // ADMIN_ROLE holder cannot also hold AGENT_ROLE: authorizing them as
        // an agent must revert via the AccessRoles override.
        IGateway.AgentPolicy memory p = _defaultPolicy();
        vm.prank(depositor);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        gateway.authorizeAgent(admin, p);

        // PAUSER_ROLE holder cannot also hold AGENT_ROLE.
        vm.prank(depositor);
        vm.expectRevert(AccessRoles.RoleSeparationViolated.selector);
        gateway.authorizeAgent(pauser, p);

        // Sanity: the constructor-granted roles are still pairwise disjoint.
        assertTrue(gateway.hasRole(adminRole, admin));
        assertFalse(gateway.hasRole(pauserRole, admin));
        assertFalse(gateway.hasRole(agentRole, admin));
        assertTrue(gateway.hasRole(pauserRole, pauser));
        assertFalse(gateway.hasRole(adminRole, pauser));
        assertFalse(gateway.hasRole(agentRole, pauser));
    }

    // -------------------------------------------------------------------
    // Coverage gap fillers
    // -------------------------------------------------------------------

    function test_authorizeAgent_revertsOnZeroAgent() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        vm.prank(depositor);
        vm.expectRevert(RobotMoneyGateway.ZeroAddress.selector);
        gateway.authorizeAgent(address(0), p);
    }

    function test_authorizeAgent_revertsOnExpiredValidUntil() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        // validUntil strictly less than block.timestamp triggers
        // InvalidValidUntil on the second active-policy check.
        p.validUntil = uint64(block.timestamp - 1);
        vm.prank(depositor);
        vm.expectRevert(RobotMoneyGateway.InvalidValidUntil.selector);
        gateway.authorizeAgent(agent, p);
    }

    function test_revokeAgent_revertsOnZeroAgent() public {
        vm.prank(depositor);
        vm.expectRevert(RobotMoneyGateway.ZeroAddress.selector);
        gateway.revokeAgent(address(0));
    }

    function test_deposit_revertsOnPreCallShareCustodyInvariant() public {
        // Seed gateway with rmUSDC shares before any deposit. The pre-call
        // invariant (line 222) must reject the call.
        _authorize(agent, _defaultPolicy());
        _fundAndApprove(agent, 100 * ONE_USDC);

        // Mint shares directly into the gateway via the vault's ERC20
        // facing — use `deal` to set its balance.
        deal(address(vault), address(gateway), 1, true);

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.ShareCustodyInvariantViolated.selector);
        gateway.deposit(bytes32("o"), 100 * ONE_USDC, uint64(block.timestamp + 60), bytes32("i"));
    }

    function test_deposit_revertsOnPostCallShareCustodyInvariant() public {
        // Vault that mints an extra share to the gateway during deposit. Trips
        // the post-call rmUSDC custody invariant (line 243-244).
        ShareLeakVault leaky = new ShareLeakVault(address(usdc));
        RobotMoneyGateway gw =
            new RobotMoneyGateway(IERC20(address(usdc)), IERC4626(address(leaky)), admin, pauser);
        IGateway.AgentPolicy memory p = _defaultPolicy();
        vm.prank(depositor);
        gw.authorizeAgent(agent, p);

        usdc.mint(agent, 100 * ONE_USDC);
        vm.prank(agent);
        usdc.approve(address(gw), 100 * ONE_USDC);

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.ShareCustodyInvariantViolated.selector);
        gw.deposit(bytes32("o"), 100 * ONE_USDC, uint64(block.timestamp + 60), bytes32("i"));
    }

    function test_deposit_revertsOnPostCallUsdcCustodyInvariant() public {
        // Vault that under-pulls USDC during deposit; gateway is left with
        // leftover USDC. Trips the post-call USDC custody invariant (line 247-248).
        UnderPullVault underPull = new UnderPullVault(address(usdc));
        RobotMoneyGateway gw = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(underPull)), admin, pauser
        );
        IGateway.AgentPolicy memory p = _defaultPolicy();
        vm.prank(depositor);
        gw.authorizeAgent(agent, p);

        usdc.mint(agent, 100 * ONE_USDC);
        vm.prank(agent);
        usdc.approve(address(gw), 100 * ONE_USDC);

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.ShareCustodyInvariantViolated.selector);
        gw.deposit(bytes32("o"), 100 * ONE_USDC, uint64(block.timestamp + 60), bytes32("i"));
    }

    // -------------------------------------------------------------------
    // Reentrancy guard
    // -------------------------------------------------------------------

    function test_deposit_revertsOnReentrancyAttempt() public {
        // Deploy a reentrant vault that tries to call gateway.deposit() from
        // inside its own deposit() implementation. The nonReentrant modifier
        // must prevent the second entry.
        ReentrantVault reentrantVault = new ReentrantVault(address(usdc));
        RobotMoneyGateway gw = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(reentrantVault)), admin, pauser
        );
        reentrantVault.setGateway(gw);

        IGateway.AgentPolicy memory p = _defaultPolicy();
        vm.prank(depositor);
        gw.authorizeAgent(agent, p);

        // Fund agent with enough for two deposits; approve the gateway.
        uint256 amount = 100 * ONE_USDC;
        usdc.mint(agent, 2 * amount);
        vm.prank(agent);
        usdc.approve(address(gw), 2 * amount);

        // Arm the vault to attempt a reentrant deposit with a different
        // idempotency key (so the paymentId check wouldn't be the blocker).
        reentrantVault.armAttack(
            bytes32("reentrant-order"),
            amount,
            uint64(block.timestamp + 60),
            bytes32("reentrant-idem")
        );

        // The outer deposit triggers the vault which tries to re-enter;
        // ReentrancyGuardReentrantCall must be thrown.
        vm.prank(agent);
        vm.expectRevert(bytes4(keccak256("ReentrancyGuardReentrantCall()")));
        gw.deposit(
            bytes32("outer-order"), amount, uint64(block.timestamp + 60), bytes32("outer-idem")
        );
    }
}
