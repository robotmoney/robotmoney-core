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

/// @dev Vault that, during redeem, routes USDC to the caller (the gateway)
///      instead of to the designated receiver. This trips the post-redeem
///      gateway-USDC-balance invariant (UnexpectedAssetsReceived).
contract UnexpectedAssetsRedeemVault is MockVault {
    constructor(address asset_) MockVault(asset_) {}

    function redeem(uint256 shares, address, address owner)
        external
        override
        returns (uint256 assets)
    {
        _burn(owner, shares);
        assets = shares;
        // Route USDC to msg.sender (the gateway) rather than the designated
        // receiver. The gateway's USDC balance rises, tripping the invariant.
        IERC20(address(assetToken)).transfer(msg.sender, assets);
    }
}

/// @dev Vault that, during redeem, re-mints 1 share to the caller after
///      burning the redeemed shares. The gateway must hold zero shares after
///      redeem; re-minting 1 trips the ShareCustodyInvariantViolated check.
contract ShareLeakRedeemVault is MockVault {
    constructor(address asset_) MockVault(asset_) {}

    function redeem(uint256 shares, address receiver, address owner)
        external
        override
        returns (uint256 assets)
    {
        _burn(owner, shares);
        assets = shares;
        IERC20(address(assetToken)).transfer(receiver, assets);
        // Re-mint 1 share to the caller (gateway), breaking the zero-share
        // post-condition the gateway asserts after every redeem.
        _mint(msg.sender, 1);
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
        gateway = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(0)
        );

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
        address[] memory noDestinations = new address[](0);
        return IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: noDestinations,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: noDestinations
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
        new RobotMoneyGateway(
            IERC20(address(0)), IERC4626(address(vault)), admin, pauser, address(0)
        );

        vm.expectRevert(RobotMoneyGateway.ZeroAddress.selector);
        new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(0)), admin, pauser, address(0)
        );

        vm.expectRevert(RobotMoneyGateway.ZeroAddress.selector);
        new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), address(0), pauser, address(0)
        );

        vm.expectRevert(RobotMoneyGateway.ZeroAddress.selector);
        new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, address(0), address(0)
        );
    }

    function test_constructor_revertsOnAssetMismatch() public {
        TestERC20 otherUsdc = new TestERC20();
        vm.expectRevert(RobotMoneyGateway.AssetMismatch.selector);
        new RobotMoneyGateway(
            IERC20(address(otherUsdc)), IERC4626(address(vault)), admin, pauser, address(0)
        );
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

        (bool active, uint64 validUntil, uint256 maxPay, uint256 maxWin, address recv,,,) =
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
        (,, uint256 maxPay,,,,,) = gateway.agents(agent);
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
        (,, uint256 maxPay,,,,,) = gateway.agents(agent);
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
        (bool active,,,,,,,) = gateway.agents(agent);
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

        // Bookkeeping: rolling-window deposit gross (#497).
        // agentWindowGross is deprecated; use effectiveDepositWindowGross.
        assertEq(gateway.effectiveDepositWindowGross(agent), amount);
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
            IERC20(address(fotUsdc)), IERC4626(address(fotVault)), admin, pauser, address(0)
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
        RobotMoneyGateway gw = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(leaky)), admin, pauser, address(0)
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

    function test_deposit_revertsOnPostCallUsdcCustodyInvariant() public {
        // Vault that under-pulls USDC during deposit; gateway is left with
        // leftover USDC. Trips the post-call USDC custody invariant (line 247-248).
        UnderPullVault underPull = new UnderPullVault(address(usdc));
        RobotMoneyGateway gw = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(underPull)), admin, pauser, address(0)
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
            IERC20(address(usdc)), IERC4626(address(reentrantVault)), admin, pauser, address(0)
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

// ───────────────────────────────────────────────────────────────────────────
// GatewayRollingDepositWindowTest
// Tests for rolling-window deposit accounting (issue #497).
//
// Before #497 deposits used a calendar-aligned fixed window — an agent could
// deposit maxPerWindow at the end of window N and again at the start of
// window N+1, spending ~2x the cap within 2 seconds. This suite verifies
// that the rolling-anchor logic eliminates that boundary burst and that the
// deposit and withdrawal window states remain independent.
// ───────────────────────────────────────────────────────────────────────────

contract GatewayRollingDepositWindowTest is Test {
    TestERC20 internal usdc;
    MockVault internal vault;
    RobotMoneyGateway internal gateway;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal agent = makeAddr("agent");
    address internal depositor = makeAddr("depositor");
    address internal shareReceiver = makeAddr("shareReceiver");
    address internal assetRecipient = makeAddr("assetRecipient");

    uint256 internal constant ONE_USDC = 1e6;
    // Per-payment cap equals the per-window cap so a single max deposit
    // consumes the entire rolling budget — simplest shape for boundary tests.
    uint256 internal constant MAX_PER_PAYMENT = 1_000 * ONE_USDC;
    uint256 internal constant MAX_PER_WINDOW = 1_000 * ONE_USDC;
    uint256 internal constant MAX_WITHDRAW_PER_PAYMENT = 500 * ONE_USDC;
    uint256 internal constant MAX_WITHDRAW_PER_WINDOW = 500 * ONE_USDC;

    function setUp() public {
        usdc = new TestERC20();
        vault = new MockVault(address(usdc));
        gateway = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(0)
        );
        vm.warp(1_700_000_000);
    }

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    function _defaultPolicy() internal view returns (IGateway.AgentPolicy memory) {
        address[] memory none = new address[](0);
        return IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: none,
            assetRecipient: assetRecipient,
            maxWithdrawPerPayment: MAX_WITHDRAW_PER_PAYMENT,
            maxWithdrawPerWindow: MAX_WITHDRAW_PER_WINDOW,
            allowedSourceVaults: none
        });
    }

    function _authorize(IGateway.AgentPolicy memory p) internal {
        vm.prank(depositor);
        gateway.authorizeAgent(agent, p);
    }

    function _fundAndApprove(uint256 amt) internal {
        usdc.mint(agent, amt);
        vm.prank(agent);
        usdc.approve(address(gateway), amt);
    }

    function _deposit(bytes32 orderId, uint256 amount, bytes32 idem) internal {
        vm.prank(agent);
        gateway.deposit(orderId, amount, uint64(block.timestamp + 60), idem);
    }

    function _mintSharesAndApprove(uint256 shares) internal {
        usdc.mint(depositor, shares);
        vm.prank(depositor);
        usdc.approve(address(vault), shares);
        vm.prank(depositor);
        vault.deposit(shares, agent);
        vm.prank(agent);
        vault.approve(address(gateway), shares);
    }

    // -------------------------------------------------------------------
    // AC: boundary-burst blocked (#497 acceptance criterion 1)
    //
    // Old fixed-window accounting: deposit maxPerWindow at timestamp
    // WINDOW_SECONDS-1, cross the calendar boundary to WINDOW_SECONDS, deposit
    // again — two full caps in under 2 seconds. Rolling accounting must reject
    // the second deposit.
    // -------------------------------------------------------------------

    function test_deposit_rollingWindow_blocksBoundaryBurst() public {
        _authorize(_defaultPolicy());

        uint64 windowSeconds = gateway.WINDOW_SECONDS();

        // Warp to one second before the next calendar window boundary.
        uint256 currentWindow = block.timestamp / windowSeconds;
        uint256 nextBoundary = (currentWindow + 1) * windowSeconds;
        vm.warp(nextBoundary - 1);

        // First deposit: consumes the full rolling cap.
        _fundAndApprove(MAX_PER_WINDOW);
        _deposit(keccak256("o-pre"), MAX_PER_WINDOW, keccak256("i-pre"));

        // Cross the calendar window boundary by 2 seconds. Fixed-window
        // accounting would open a fresh cap; rolling accounting must not.
        vm.warp(nextBoundary + 1);
        _fundAndApprove(1);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.WindowCapExceeded.selector);
        gateway.deposit(keccak256("o-post"), 1, uint64(block.timestamp + 60), keccak256("i-post"));
    }

    // -------------------------------------------------------------------
    // AC: full cap available after a full WINDOW_SECONDS (#497 AC 2)
    // -------------------------------------------------------------------

    function test_deposit_rollingWindow_fullCapAfterFullWindow() public {
        _authorize(_defaultPolicy());

        _fundAndApprove(MAX_PER_WINDOW);
        _deposit(keccak256("o1"), MAX_PER_WINDOW, keccak256("i1"));

        // Advance by exactly WINDOW_SECONDS from the anchor.
        vm.warp(block.timestamp + gateway.WINDOW_SECONDS());

        _fundAndApprove(MAX_PER_WINDOW);
        // Must succeed — rolling window has expired.
        _deposit(keccak256("o2"), MAX_PER_WINDOW, keccak256("i2"));
    }

    // -------------------------------------------------------------------
    // AC: deposit and withdrawal window states are tracked independently
    // (#497 AC 3)
    //
    // After a deposit and a withdrawal in the same block, the two window
    // mappings must hold independent values.
    // -------------------------------------------------------------------

    function test_deposit_and_withdraw_windowsAreIndependent() public {
        _authorize(_defaultPolicy());

        uint256 depositAmount = MAX_PER_WINDOW;
        uint256 withdrawShares = MAX_WITHDRAW_PER_WINDOW;

        _fundAndApprove(depositAmount);
        _deposit(keccak256("d-order"), depositAmount, keccak256("d-idem"));

        _mintSharesAndApprove(withdrawShares);
        vm.prank(agent);
        gateway.withdraw(
            keccak256("w-order"),
            withdrawShares,
            address(vault),
            uint64(block.timestamp + 60),
            keccak256("w-idem")
        );

        // Deposit window should reflect the deposit amount.
        assertEq(
            gateway.effectiveDepositWindowGross(agent),
            depositAmount,
            "deposit window gross must reflect deposit"
        );

        // Withdrawal window should reflect the withdrawal amount independently.
        assertEq(
            gateway.effectiveWithdrawWindowGross(agent),
            withdrawShares,
            "withdraw window gross must reflect withdrawal"
        );
    }

    // -------------------------------------------------------------------
    // AC: effectiveDepositWindowGross returns rolling-anchor gross (#497 AC 4)
    // -------------------------------------------------------------------

    function test_effectiveDepositWindowGross_returnsMidWindowGross() public {
        _authorize(_defaultPolicy());

        uint256 amount = MAX_PER_WINDOW / 2;
        _fundAndApprove(amount);
        _deposit(keccak256("o-mid"), amount, keccak256("i-mid"));

        // Still within the rolling window — must report the deposited amount.
        assertEq(
            gateway.effectiveDepositWindowGross(agent),
            amount,
            "mid-window gross must equal deposited amount"
        );

        // Advance past the window — must report zero.
        vm.warp(block.timestamp + gateway.WINDOW_SECONDS());
        assertEq(
            gateway.effectiveDepositWindowGross(agent),
            0,
            "expired rolling window must report zero gross"
        );
    }

    // -------------------------------------------------------------------
    // effectiveDepositWindowGross returns 0 for agent that has never deposited
    // -------------------------------------------------------------------

    function test_effectiveDepositWindowGross_zeroForUntouchedAgent() public view {
        assertEq(
            gateway.effectiveDepositWindowGross(agent),
            0,
            "untouched agent must report zero rolling deposit gross"
        );
    }

    // -------------------------------------------------------------------
    // Fuzz: cumulative deposits in any WINDOW_SECONDS interval never exceed
    // maxPerWindow (#497 AC 5)
    //
    // For random deposit amounts and inter-deposit time offsets, verify that
    // the contract never allows the cumulative rolling gross to exceed cap.
    // We simulate this by computing what the contract allows and asserting
    // the invariant ourselves after every successful deposit.
    // -------------------------------------------------------------------

    function testFuzz_deposit_rollingWindow_neverExceedsCapInAnyInterval(
        uint8 numDeposits,
        uint64[8] memory timeOffsets,
        uint32[8] memory rawAmounts
    ) public {
        // Bound inputs to tractable ranges.
        numDeposits = uint8(bound(numDeposits, 1, 8));
        uint64 windowSeconds = gateway.WINDOW_SECONDS();

        // Use a policy where maxPerPayment can be any fraction of maxPerWindow.
        IGateway.AgentPolicy memory p = _defaultPolicy();
        // Allow each payment to be at most half the window cap to permit
        // multi-deposit sequences.
        p.maxPerPayment = MAX_PER_WINDOW / 2;
        p.maxPerWindow = MAX_PER_WINDOW;
        _authorize(p);

        // Fund agent generously.
        _fundAndApprove(MAX_PER_WINDOW * 10);

        uint256 rollingGross;
        uint64 windowAnchor;

        for (uint8 i = 0; i < numDeposits; i++) {
            // Apply a bounded time offset between 0 and 2×WINDOW_SECONDS.
            uint64 offset = uint64(bound(timeOffsets[i], 0, 2 * windowSeconds));
            vm.warp(block.timestamp + offset);

            // Recompute expected rolling state.
            if (windowAnchor == 0 || block.timestamp >= uint256(windowAnchor) + windowSeconds) {
                windowAnchor = uint64(block.timestamp);
                rollingGross = 0;
            }

            uint256 amount = bound(rawAmounts[i], 1, p.maxPerPayment);
            bool shouldRevert = (rollingGross + amount > MAX_PER_WINDOW);

            bytes32 orderId = keccak256(abi.encode("fuzz-order", i));
            bytes32 idem = keccak256(abi.encode("fuzz-idem", i));

            if (shouldRevert) {
                vm.prank(agent);
                vm.expectRevert(RobotMoneyGateway.WindowCapExceeded.selector);
                gateway.deposit(orderId, amount, uint64(block.timestamp + 60), idem);
                // State unchanged — anchor and gross stay the same.
            } else {
                vm.prank(agent);
                gateway.deposit(orderId, amount, uint64(block.timestamp + 60), idem);

                rollingGross += amount;
                // Invariant: effective gross must not exceed cap.
                assertLe(
                    gateway.effectiveDepositWindowGross(agent),
                    MAX_PER_WINDOW,
                    "rolling deposit gross must not exceed maxPerWindow"
                );
            }
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────
// GatewayWithdrawTest
// Tests for gateway.withdraw() — agent-initiated vault redemption.
// ───────────────────────────────────────────────────────────────────────────

contract GatewayWithdrawTest is Test {
    TestERC20 internal usdc;
    MockVault internal vault;
    RobotMoneyGateway internal gateway;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal agent = makeAddr("agent");
    address internal depositor = makeAddr("depositor");
    address internal shareReceiver = makeAddr("shareReceiver");
    address internal assetRecipient = makeAddr("assetRecipient");

    bytes32 internal agentRole;

    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant MAX_PER_PAYMENT = 1_000 * ONE_USDC;
    uint256 internal constant MAX_PER_WINDOW = 5_000 * ONE_USDC;
    uint256 internal constant MAX_WITHDRAW_PER_PAYMENT = 500 * ONE_USDC;
    uint256 internal constant MAX_WITHDRAW_PER_WINDOW = 2_500 * ONE_USDC;

    function setUp() public {
        usdc = new TestERC20();
        vault = new MockVault(address(usdc));
        gateway = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(0)
        );
        agentRole = gateway.AGENT_ROLE();
        vm.warp(1_700_000_000);
    }

    // -------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------

    function _defaultPolicy() internal view returns (IGateway.AgentPolicy memory) {
        address[] memory noDestinations = new address[](0);
        return IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: noDestinations,
            assetRecipient: assetRecipient,
            maxWithdrawPerPayment: MAX_WITHDRAW_PER_PAYMENT,
            maxWithdrawPerWindow: MAX_WITHDRAW_PER_WINDOW,
            allowedSourceVaults: noDestinations
        });
    }

    function _authorize(IGateway.AgentPolicy memory p) internal {
        vm.prank(depositor);
        gateway.authorizeAgent(agent, p);
    }

    /// @dev Mint USDC to the depositor, deposit through gateway to give agent
    ///      `shares` vault shares, approve gateway to spend them.
    function _mintSharesAndApprove(uint256 shares) internal {
        // Deposit USDC into the vault via the gateway; shares go to shareReceiver.
        usdc.mint(depositor, shares);
        vm.prank(depositor);
        usdc.approve(address(vault), shares);
        vm.prank(depositor);
        vault.deposit(shares, agent); // send shares directly to agent

        vm.prank(agent);
        vault.approve(address(gateway), shares);
    }

    // -------------------------------------------------------------------
    // Happy path
    // -------------------------------------------------------------------

    function test_withdraw_happyPath_burnsSharesSendsUsdcToRecipient() public {
        _authorize(_defaultPolicy());
        uint256 shares = 100 * ONE_USDC;
        _mintSharesAndApprove(shares);

        bytes32 orderId = keccak256("w-order-1");
        bytes32 idem = keccak256("w-idem-1");
        uint64 deadline = uint64(block.timestamp + 60);
        uint64 expectedWindowId = uint64(block.timestamp / gateway.WINDOW_SECONDS());

        bytes32 expectedPaymentId =
            keccak256(abi.encode(block.chainid, address(gateway), agent, orderId, shares, idem));

        vm.expectEmit(true, true, true, true, address(gateway));
        emit IGateway.AgentWithdrawal(
            expectedPaymentId,
            orderId,
            agent,
            address(vault),
            shares,
            shares, // 1:1 redeem in MockVault
            assetRecipient,
            expectedWindowId
        );

        vm.prank(agent);
        (bytes32 paymentId, uint256 assetsOut) =
            gateway.withdraw(orderId, shares, address(vault), deadline, idem);

        assertEq(paymentId, expectedPaymentId, "paymentId mismatch");
        assertEq(assetsOut, shares, "assetsOut should be 1:1");

        // Agent shares burned.
        assertEq(vault.balanceOf(agent), 0, "agent shares must be zero");
        // Gateway holds no shares.
        assertEq(vault.balanceOf(address(gateway)), 0, "gateway must hold no shares");
        // USDC went to assetRecipient, not agent, not gateway.
        assertEq(usdc.balanceOf(assetRecipient), shares, "USDC to assetRecipient");
        assertEq(usdc.balanceOf(agent), 0, "agent must not receive USDC");
        assertEq(usdc.balanceOf(address(gateway)), 0, "gateway must not hold USDC");

        // Rolling-window gross updated (#449).
        assertEq(
            gateway.effectiveWithdrawWindowGross(agent), shares, "rolling window gross updated"
        );
        expectedWindowId; // silence unused-variable warning; event field still emitted
        // PaymentId consumed.
        assertTrue(gateway.usedPaymentIds(paymentId), "paymentId must be marked used");
    }

    // -------------------------------------------------------------------
    // Redirect blocked — agent cannot specify a different recipient
    // -------------------------------------------------------------------

    function test_withdraw_redirectBlocked_assetsAlwaysGoToAssetRecipient() public {
        _authorize(_defaultPolicy());
        uint256 shares = 100 * ONE_USDC;
        _mintSharesAndApprove(shares);

        vm.prank(agent);
        (, uint256 assetsOut) = gateway.withdraw(
            keccak256("o"), shares, address(vault), uint64(block.timestamp + 60), keccak256("i")
        );

        // Only assetRecipient received USDC.
        assertEq(usdc.balanceOf(assetRecipient), assetsOut, "USDC must go to assetRecipient");
        // agent cannot have gotten the USDC.
        assertEq(usdc.balanceOf(agent), 0, "agent must not receive USDC");
    }

    // -------------------------------------------------------------------
    // Reverts: withdrawal disabled
    // -------------------------------------------------------------------

    function test_withdraw_revertsWhenWithdrawalNotEnabled() public {
        // Policy with maxWithdrawPerPayment = 0 disables withdrawal.
        IGateway.AgentPolicy memory p = _defaultPolicy();
        p.maxWithdrawPerPayment = 0;
        p.maxWithdrawPerWindow = 0;
        p.assetRecipient = address(0); // no recipient needed when disabled
        _authorize(p);

        _mintSharesAndApprove(100 * ONE_USDC);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.WithdrawalNotEnabled.selector);
        gateway.withdraw(
            keccak256("o"),
            100 * ONE_USDC,
            address(vault),
            uint64(block.timestamp + 60),
            keccak256("i")
        );
    }

    // -------------------------------------------------------------------
    // Reverts: per-payment cap
    // -------------------------------------------------------------------

    function test_withdraw_revertsWhenSharesExceedPerPaymentCap() public {
        _authorize(_defaultPolicy());
        uint256 overCap = MAX_WITHDRAW_PER_PAYMENT + 1;
        _mintSharesAndApprove(overCap);

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.SharesExceedWithdrawPerPaymentCap.selector);
        gateway.withdraw(
            keccak256("o"), overCap, address(vault), uint64(block.timestamp + 60), keccak256("i")
        );
    }

    // -------------------------------------------------------------------
    // Reverts: window cap
    // -------------------------------------------------------------------

    function test_withdraw_revertsWhenWindowCapExceeded() public {
        // Policy with small window: 2x single payment.
        IGateway.AgentPolicy memory p = _defaultPolicy();
        p.maxWithdrawPerWindow = 2 * MAX_WITHDRAW_PER_PAYMENT;
        _authorize(p);

        uint256 shares = MAX_WITHDRAW_PER_PAYMENT;
        _mintSharesAndApprove(3 * shares);

        vm.prank(agent);
        gateway.withdraw(
            keccak256("o1"), shares, address(vault), uint64(block.timestamp + 60), keccak256("i1")
        );
        vm.prank(agent);
        vault.approve(address(gateway), shares);
        vm.prank(agent);
        gateway.withdraw(
            keccak256("o2"), shares, address(vault), uint64(block.timestamp + 60), keccak256("i2")
        );

        // Third in same window must revert.
        vm.prank(agent);
        vault.approve(address(gateway), 1);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.WithdrawWindowCapExceeded.selector);
        gateway.withdraw(
            keccak256("o3"), 1, address(vault), uint64(block.timestamp + 60), keccak256("i3")
        );

        // Roll window — should succeed again.
        vm.warp(block.timestamp + gateway.WINDOW_SECONDS());
        _mintSharesAndApprove(shares);
        vm.prank(agent);
        gateway.withdraw(
            keccak256("o4"), shares, address(vault), uint64(block.timestamp + 60), keccak256("i4")
        );
    }

    // -------------------------------------------------------------------
    // Reverts: rolling-window boundary burst (#449)
    //
    // Pre-#449, an agent could drain `maxWithdrawPerWindow` at the end of
    // calendar window N and then another full `maxWithdrawPerWindow` at the
    // first second of window N+1 — a ~2x burst inside a few seconds. With
    // the rolling-window accounting introduced by #449, the second draw
    // must revert because <WINDOW_SECONDS has elapsed since the anchor.
    // -------------------------------------------------------------------
    function test_withdraw_rollingWindow_blocksBoundaryBurst() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        // Window cap equals the per-payment cap so a single max withdrawal
        // consumes the rolling budget.
        p.maxWithdrawPerWindow = MAX_WITHDRAW_PER_PAYMENT;
        _authorize(p);

        uint256 shares = MAX_WITHDRAW_PER_PAYMENT;
        uint64 windowSeconds = gateway.WINDOW_SECONDS();

        // Warp to one second before the next calendar window boundary so the
        // first withdrawal lands in window N.
        uint256 currentWindow = block.timestamp / windowSeconds;
        uint256 nextBoundary = (currentWindow + 1) * windowSeconds;
        vm.warp(nextBoundary - 1);

        _mintSharesAndApprove(shares);
        vm.prank(agent);
        gateway.withdraw(
            keccak256("o-pre-boundary"),
            shares,
            address(vault),
            uint64(block.timestamp + 60),
            keccak256("i-pre-boundary")
        );

        // Cross the calendar window boundary by two seconds; fixed-window
        // accounting would now allow another full cap. Rolling accounting
        // must reject it.
        vm.warp(nextBoundary + 1);
        _mintSharesAndApprove(shares);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.WithdrawWindowCapExceeded.selector);
        gateway.withdraw(
            keccak256("o-post-boundary"),
            shares,
            address(vault),
            uint64(block.timestamp + 60),
            keccak256("i-post-boundary")
        );

        // After a full WINDOW_SECONDS has elapsed since the anchor, the
        // rolling window resets and a fresh cap is available again.
        vm.warp(nextBoundary - 1 + windowSeconds);
        vm.prank(agent);
        gateway.withdraw(
            keccak256("o-after-rolling"),
            shares,
            address(vault),
            uint64(block.timestamp + 60),
            keccak256("i-after-rolling")
        );
    }

    // View helper `effectiveWithdrawWindowGross` returns 0 for an agent that
    // has never withdrawn (windowStart == 0 branch).
    function test_effectiveWithdrawWindowGross_zeroForUntouchedAgent() public view {
        assertEq(
            gateway.effectiveWithdrawWindowGross(agent),
            0,
            "untouched agent must report zero rolling-window gross"
        );
    }

    // View helper `effectiveWithdrawWindowGross` returns 0 after the rolling
    // window has fully expired (expired-anchor branch).
    function test_effectiveWithdrawWindowGross_zeroAfterWindowExpires() public {
        _authorize(_defaultPolicy());
        uint256 shares = MAX_WITHDRAW_PER_PAYMENT;
        _mintSharesAndApprove(shares);

        vm.prank(agent);
        gateway.withdraw(
            keccak256("o-expire"),
            shares,
            address(vault),
            uint64(block.timestamp + 60),
            keccak256("i-expire")
        );
        assertEq(
            gateway.effectiveWithdrawWindowGross(agent),
            shares,
            "in-window gross must reflect the draw"
        );

        // Advance past WINDOW_SECONDS — the rolling window is now expired
        // and the view must report zero usage.
        vm.warp(block.timestamp + gateway.WINDOW_SECONDS());
        assertEq(
            gateway.effectiveWithdrawWindowGross(agent),
            0,
            "expired rolling window must report zero gross"
        );
    }

    // Inside a single rolling window, any withdrawal pattern up to the cap
    // must continue to succeed (#449 acceptance criterion).
    function test_withdraw_rollingWindow_intraWindowPatternStillSucceeds() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        p.maxWithdrawPerWindow = 3 * MAX_WITHDRAW_PER_PAYMENT;
        _authorize(p);

        uint256 shares = MAX_WITHDRAW_PER_PAYMENT;

        // Three sub-cap withdrawals spaced out within WINDOW_SECONDS all
        // succeed up to the configured cap.
        for (uint256 i = 0; i < 3; i++) {
            _mintSharesAndApprove(shares);
            vm.prank(agent);
            gateway.withdraw(
                keccak256(abi.encode("intra", i)),
                shares,
                address(vault),
                uint64(block.timestamp + 60),
                keccak256(abi.encode("intra-i", i))
            );
            // Advance a few seconds — still within the rolling window.
            vm.warp(block.timestamp + 60);
        }

        // The next share over the cap, still inside the rolling window,
        // must revert.
        _mintSharesAndApprove(1);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.WithdrawWindowCapExceeded.selector);
        gateway.withdraw(
            keccak256("intra-overflow"),
            1,
            address(vault),
            uint64(block.timestamp + 60),
            keccak256("intra-overflow-i")
        );
    }

    // A new policy issued by the depositor after expiry must NOT reset the
    // rolling window mid-flight — the cap is enforced against the agent's
    // historical withdrawal anchor, not against per-policy state.
    // After a full WINDOW_SECONDS however, a fresh budget is naturally
    // available.
    function test_withdraw_rollingWindow_policyRefreshDoesNotResetMidWindow() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        p.maxWithdrawPerWindow = MAX_WITHDRAW_PER_PAYMENT;
        _authorize(p);

        uint256 shares = MAX_WITHDRAW_PER_PAYMENT;
        _mintSharesAndApprove(shares);
        vm.prank(agent);
        gateway.withdraw(
            keccak256("o-1"), shares, address(vault), uint64(block.timestamp + 60), keccak256("i-1")
        );

        // Mid-window: depositor re-issues policy (e.g. bumps validUntil).
        // Rolling state must persist; another full draw must still revert.
        IGateway.AgentPolicy memory p2 = p;
        p2.validUntil = uint64(block.timestamp + 365 days);
        vm.prank(depositor);
        gateway.setPolicy(agent, p2);

        _mintSharesAndApprove(shares);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.WithdrawWindowCapExceeded.selector);
        gateway.withdraw(
            keccak256("o-2"), shares, address(vault), uint64(block.timestamp + 60), keccak256("i-2")
        );

        // After a full window elapses, the rolling budget refreshes.
        vm.warp(block.timestamp + gateway.WINDOW_SECONDS());
        vm.prank(agent);
        gateway.withdraw(
            keccak256("o-3"), shares, address(vault), uint64(block.timestamp + 60), keccak256("i-3")
        );
    }

    // -------------------------------------------------------------------
    // Reverts: invalid source vault
    // -------------------------------------------------------------------

    function test_withdraw_revertsWhenSourceVaultNotPinnedVault() public {
        _authorize(_defaultPolicy());
        _mintSharesAndApprove(100 * ONE_USDC);

        address rando = makeAddr("rando-vault");
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.InvalidSourceVault.selector);
        gateway.withdraw(
            keccak256("o"), 100 * ONE_USDC, rando, uint64(block.timestamp + 60), keccak256("i")
        );
    }

    function test_withdraw_revertsWhenSourceVaultNotInAllowedList() public {
        // Policy that pins allowedSourceVaults to something other than the vault.
        IGateway.AgentPolicy memory p = _defaultPolicy();
        address[] memory sources = new address[](1);
        sources[0] = makeAddr("other-vault"); // not the real vault
        p.allowedSourceVaults = sources;
        _authorize(p);

        _mintSharesAndApprove(100 * ONE_USDC);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.InvalidSourceVault.selector);
        gateway.withdraw(
            keccak256("o"),
            100 * ONE_USDC,
            address(vault),
            uint64(block.timestamp + 60),
            keccak256("i")
        );
    }

    // -------------------------------------------------------------------
    // Reverts: paused
    // -------------------------------------------------------------------

    function test_withdraw_revertsWhenPaused() public {
        _authorize(_defaultPolicy());
        _mintSharesAndApprove(100 * ONE_USDC);

        vm.prank(pauser);
        gateway.pause();

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.PausedError.selector);
        gateway.withdraw(
            keccak256("o"),
            100 * ONE_USDC,
            address(vault),
            uint64(block.timestamp + 60),
            keccak256("i")
        );
    }

    // -------------------------------------------------------------------
    // Reverts: receipt allowance check
    // -------------------------------------------------------------------

    function test_withdraw_revertsWhenInsufficientShareAllowance() public {
        _authorize(_defaultPolicy());

        // Mint shares to agent but approve zero to gateway.
        usdc.mint(depositor, 100 * ONE_USDC);
        vm.prank(depositor);
        usdc.approve(address(vault), 100 * ONE_USDC);
        vm.prank(depositor);
        vault.deposit(100 * ONE_USDC, agent);
        // Do NOT approve gateway.

        vm.prank(agent);
        vm.expectRevert(); // ERC20 insufficient allowance revert
        gateway.withdraw(
            keccak256("o"),
            100 * ONE_USDC,
            address(vault),
            uint64(block.timestamp + 60),
            keccak256("i")
        );
    }

    // -------------------------------------------------------------------
    // Reverts: zero shares
    // -------------------------------------------------------------------

    function test_withdraw_revertsOnZeroShares() public {
        _authorize(_defaultPolicy());
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.InvalidAmount.selector);
        gateway.withdraw(
            keccak256("o"), 0, address(vault), uint64(block.timestamp + 60), keccak256("i")
        );
    }

    // -------------------------------------------------------------------
    // Reverts: deadline checks
    // -------------------------------------------------------------------

    function test_withdraw_revertsOnExpiredDeadline() public {
        _authorize(_defaultPolicy());
        _mintSharesAndApprove(100 * ONE_USDC);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.DeadlineExpired.selector);
        gateway.withdraw(
            keccak256("o"),
            100 * ONE_USDC,
            address(vault),
            uint64(block.timestamp - 1),
            keccak256("i")
        );
    }

    function test_withdraw_revertsOnDeadlineTooFar() public {
        _authorize(_defaultPolicy());
        _mintSharesAndApprove(100 * ONE_USDC);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.DeadlineTooFar.selector);
        gateway.withdraw(
            keccak256("o"),
            100 * ONE_USDC,
            address(vault),
            uint64(block.timestamp + 601),
            keccak256("i")
        );
    }

    // -------------------------------------------------------------------
    // Reverts: policy validation — assetRecipient required when withdrawal enabled
    // -------------------------------------------------------------------

    function test_authorizeAgent_revertsWhenWithdrawEnabledButNoAssetRecipient() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        p.assetRecipient = address(0);
        // maxWithdrawPerPayment > 0 but no assetRecipient — must revert.
        vm.prank(depositor);
        vm.expectRevert(RobotMoneyGateway.InvalidAssetRecipient.selector);
        gateway.authorizeAgent(agent, p);
    }

    // -------------------------------------------------------------------
    // Reverts: idempotency
    // -------------------------------------------------------------------

    function test_withdraw_revertsOnReplay() public {
        _authorize(_defaultPolicy());
        uint256 shares = 100 * ONE_USDC;
        _mintSharesAndApprove(shares);

        bytes32 orderId = keccak256("w-replay");
        bytes32 idem = keccak256("w-idem-replay");

        vm.prank(agent);
        gateway.withdraw(orderId, shares, address(vault), uint64(block.timestamp + 60), idem);

        // Mint more shares and try the same orderId/idem again.
        _mintSharesAndApprove(shares);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.PaymentIdAlreadyUsed.selector);
        gateway.withdraw(orderId, shares, address(vault), uint64(block.timestamp + 120), idem);
    }

    // -------------------------------------------------------------------
    // Reverts: policy expired at call time
    // -------------------------------------------------------------------

    function test_withdraw_revertsWhenPolicyExpired() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        uint64 shortValidity = uint64(block.timestamp + 1);
        p.validUntil = shortValidity;
        _authorize(p);

        _mintSharesAndApprove(100 * ONE_USDC);

        // Warp past validUntil so the policy is now expired.
        vm.warp(shortValidity + 1);

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.AgentPolicyExpired.selector);
        gateway.withdraw(
            keccak256("o-expired"),
            100 * ONE_USDC,
            address(vault),
            uint64(block.timestamp + 60),
            keccak256("i-expired")
        );
    }

    // -------------------------------------------------------------------
    // allowedSourceVaults: vault in allowed list succeeds
    // -------------------------------------------------------------------

    function test_withdraw_succeedsWhenSourceVaultInAllowedList() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        address[] memory sources = new address[](1);
        sources[0] = address(vault); // vault IS in the allowed list
        p.allowedSourceVaults = sources;
        _authorize(p);

        uint256 shares = 100 * ONE_USDC;
        _mintSharesAndApprove(shares);

        vm.prank(agent);
        // Must succeed — sourceVault matches the single allowedSourceVaults entry.
        gateway.withdraw(
            keccak256("o-allowed"),
            shares,
            address(vault),
            uint64(block.timestamp + 60),
            keccak256("i-allowed")
        );
    }

    // -------------------------------------------------------------------
    // _validatePolicy: withdrawal window cap must be non-zero when enabled
    // -------------------------------------------------------------------

    function test_authorizeAgent_revertsWhenWithdrawWindowCapIsZero() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        p.maxWithdrawPerWindow = 0; // payment cap > 0 but window cap = 0
        vm.prank(depositor);
        vm.expectRevert(RobotMoneyGateway.InvalidAmount.selector);
        gateway.authorizeAgent(agent, p);
    }

    function test_authorizeAgent_revertsWhenPaymentCapExceedsWithdrawWindowCap() public {
        IGateway.AgentPolicy memory p = _defaultPolicy();
        p.maxWithdrawPerPayment = MAX_WITHDRAW_PER_WINDOW + 1; // exceeds window cap
        vm.prank(depositor);
        vm.expectRevert(RobotMoneyGateway.InvalidAmount.selector);
        gateway.authorizeAgent(agent, p);
    }

    // -------------------------------------------------------------------
    // Defensive invariant: vault routes USDC to gateway → UnexpectedAssetsReceived
    // -------------------------------------------------------------------

    function test_withdraw_revertsOnUnexpectedAssetsReceived() public {
        // Deploy a gateway backed by the misbehaving vault.
        UnexpectedAssetsRedeemVault badVault = new UnexpectedAssetsRedeemVault(address(usdc));
        RobotMoneyGateway gw = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(badVault)), admin, pauser, address(0)
        );
        bytes32 role = gw.AGENT_ROLE();

        // Authorize agent with withdrawal-enabled policy.
        IGateway.AgentPolicy memory p = _defaultPolicy();
        vm.prank(depositor);
        gw.authorizeAgent(agent, p);

        // Mint shares to agent via badVault and approve gw.
        uint256 shares = 100 * ONE_USDC;
        usdc.mint(depositor, shares);
        vm.prank(depositor);
        usdc.approve(address(badVault), shares);
        vm.prank(depositor);
        badVault.deposit(shares, agent);
        vm.prank(agent);
        badVault.approve(address(gw), shares);

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.UnexpectedAssetsReceived.selector);
        gw.withdraw(
            keccak256("o-bad"),
            shares,
            address(badVault),
            uint64(block.timestamp + 60),
            keccak256("i-bad")
        );
    }

    // -------------------------------------------------------------------
    // Defensive invariant: vault leaks shares to gateway → ShareCustodyInvariantViolated
    // -------------------------------------------------------------------

    function test_withdraw_revertsOnShareCustodyInvariantViolated() public {
        ShareLeakRedeemVault leakyVault = new ShareLeakRedeemVault(address(usdc));
        RobotMoneyGateway gw = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(leakyVault)), admin, pauser, address(0)
        );

        IGateway.AgentPolicy memory p = _defaultPolicy();
        vm.prank(depositor);
        gw.authorizeAgent(agent, p);

        uint256 shares = 100 * ONE_USDC;
        usdc.mint(depositor, shares);
        vm.prank(depositor);
        usdc.approve(address(leakyVault), shares);
        vm.prank(depositor);
        leakyVault.deposit(shares, agent);
        vm.prank(agent);
        leakyVault.approve(address(gw), shares);

        // Mint extra USDC to leakyVault so it can send assets to assetRecipient AND
        // still re-mint 1 share. The vault only needs enough USDC for the redeem.
        // (leakyVault already holds `shares` USDC from the deposit above.)

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.ShareCustodyInvariantViolated.selector);
        gw.withdraw(
            keccak256("o-leak"),
            shares,
            address(leakyVault),
            uint64(block.timestamp + 60),
            keccak256("i-leak")
        );
    }
}
