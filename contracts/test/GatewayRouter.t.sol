// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §5 — On-Chain Gateway, §4.2 — Portfolio Router
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {AccessRoles} from "../gateway/AccessRoles.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {MockVault} from "../gateway/MockVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {FeeOnTransferUSDC, ShareLeakVault, UnderPullVault} from "./RobotMoneyGateway.t.sol";

// ─── Test fixtures ────────────────────────────────────────────────────────────

/// @notice Minimal ERC-4626-shaped vault for router integration tests. 1:1 deposit.
contract RouterMockVault is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable assetToken;

    constructor(address asset_, string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        assetToken = IERC20(asset_);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }

    function totalAssets() external view returns (uint256) {
        return assetToken.balanceOf(address(this));
    }

    function previewDeposit(uint256 assets) external pure returns (uint256) {
        return assets;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        assetToken.safeTransferFrom(msg.sender, address(this), assets);
        shares = assets;
        _mint(receiver, shares);
    }
}

/// @notice Mock router that underpulls USDC during deposit, leaving residual USDC
///         in the caller (gateway). Used to trigger the router-path USDC custody invariant.
contract UnderPullRouter {
    IERC20 public immutable usdc;

    constructor(address usdc_) {
        usdc = IERC20(usdc_);
    }

    function depositFor(address, uint256 amount, uint256[] calldata)
        external
        returns (uint256[] memory sharesPerLeg)
    {
        // Pull `amount - 1` instead of `amount`. The gateway will be left holding 1 wei.
        usdc.transferFrom(msg.sender, address(this), amount - 1);
        sharesPerLeg = new uint256[](0);
    }
}

/// @title GatewayRouterTest
/// @notice Tests for gateway.depositTo routing through the PortfolioRouter.
///         Covers: AC1 (router deposit), AC2 (policy restriction), AC3 (invalid
///         destination), AC4 (AgentDepositRouted event), AC5 (single-vault path
///         unaffected).
contract GatewayRouterTest is Test {
    using SafeERC20 for IERC20;

    TestERC20 internal usdc;
    MockVault internal vault;
    VaultRegistry internal registry;
    RouterMockVault internal vaultA;
    RouterMockVault internal vaultB;
    PortfolioRouter internal router;
    RobotMoneyGateway internal gateway;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal agent = makeAddr("agent");
    address internal otherAgent = makeAddr("otherAgent");
    address internal depositor = makeAddr("depositor");
    address internal shareReceiver = makeAddr("shareReceiver");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant MAX_PER_PAYMENT = 1_000 * ONE_USDC;
    uint256 internal constant MAX_PER_WINDOW = 5_000 * ONE_USDC;

    function setUp() public {
        vm.warp(1_700_000_000);

        usdc = new TestERC20();
        vault = new MockVault(address(usdc));

        // Registry + two vaults for the router
        registry = new VaultRegistry(admin);
        vaultA = new RouterMockVault(address(usdc), "Vault A Shares", "vA");
        vaultB = new RouterMockVault(address(usdc), "Vault B Shares", "vB");

        vm.startPrank(admin);
        registry.registerVault(
            address(vaultA),
            VaultRegistry.VaultMetadata({name: "Vault A", asset: address(usdc), registeredAt: 0})
        );
        registry.registerVault(
            address(vaultB),
            VaultRegistry.VaultMetadata({name: "Vault B", asset: address(usdc), registeredAt: 0})
        );
        vm.stopPrank();

        // Deploy router (60%/40% split)
        router = new PortfolioRouter(address(usdc), address(registry), admin);
        address[] memory vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
        uint256[] memory bps = new uint256[](2);
        bps[0] = 6000;
        bps[1] = 4000;
        vm.prank(admin);
        router.setWeights(vaults, bps);

        // Deploy gateway with router support
        gateway = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(router)
        );
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _policyWithRouter() internal view returns (IGateway.AgentPolicy memory) {
        address[] memory destinations = new address[](1);
        destinations[0] = address(router);
        return IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: destinations
        });
    }

    function _policyWithVaultOnly() internal view returns (IGateway.AgentPolicy memory) {
        address[] memory destinations = new address[](1);
        destinations[0] = address(vault);
        return IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: destinations
        });
    }

    function _policyOpenDestinations() internal view returns (IGateway.AgentPolicy memory) {
        address[] memory empty = new address[](0);
        return IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: empty
        });
    }

    function _authorize(address who, IGateway.AgentPolicy memory p) internal {
        vm.prank(depositor);
        gateway.authorizeAgent(who, p);
    }

    function _fundAndApprove(address who, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.prank(who);
        usdc.approve(address(gateway), amt);
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    /// @dev Verify router is wired into the gateway.
    function test_gatewayRouter_constructor_wiresRouter() public view {
        assertEq(gateway.router(), address(router));
    }

    /// @dev A gateway deployed without a router address returns zero.
    function test_gatewayRouter_constructor_noRouter_returnsZero() public {
        RobotMoneyGateway gw = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(0)
        );
        assertEq(gw.router(), address(0));
    }

    // ─── AC1: agent with router policy deposits through router ────────────────

    /// @dev AC1: Agent with router-allowed policy calls depositTo(router) and
    ///      receives proportional vault receipts split across vaultA and vaultB.
    function test_depositTo_router_happyPath_proportionalReceipts() public {
        _authorize(agent, _policyWithRouter());
        uint256 amount = 100 * ONE_USDC;
        _fundAndApprove(agent, amount);

        uint256[] memory minShares = new uint256[](0);
        bytes32 orderId = keccak256("order-r1");
        bytes32 idem = keccak256("idem-r1");
        uint64 deadline = uint64(block.timestamp + 60);

        bytes32 expectedPaymentId =
            keccak256(abi.encode(block.chainid, address(gateway), agent, orderId, amount, idem));
        uint64 expectedWindowId = uint64(block.timestamp / gateway.WINDOW_SECONDS());

        vm.expectEmit(true, true, true, false, address(gateway));
        emit IGateway.AgentDepositRouted(
            expectedPaymentId,
            orderId,
            agent,
            shareReceiver,
            address(router),
            amount,
            new uint256[](2), // placeholder — we check amounts below
            expectedWindowId
        );

        vm.prank(agent);
        bytes32 paymentId =
            gateway.depositTo(orderId, amount, deadline, idem, address(router), minShares);

        assertEq(paymentId, expectedPaymentId);

        // 60/40 split: vaultA gets 60 USDC, vaultB gets 40 USDC.
        assertEq(vaultA.balanceOf(shareReceiver), 60 * ONE_USDC, "vaultA shares to shareReceiver");
        assertEq(vaultB.balanceOf(shareReceiver), 40 * ONE_USDC, "vaultB shares to shareReceiver");

        // Gateway must not custody any USDC or shares.
        assertEq(usdc.balanceOf(address(gateway)), 0, "gateway usdc clean");
        assertEq(IERC20(address(vaultA)).balanceOf(address(gateway)), 0, "gateway vaultA clean");
        assertEq(IERC20(address(vaultB)).balanceOf(address(gateway)), 0, "gateway vaultB clean");

        // Window gross and idempotency key recorded.
        assertEq(gateway.agentWindowGross(agent, expectedWindowId), amount);
        assertTrue(gateway.usedPaymentIds(paymentId));
    }

    /// @dev AC1: slippage protection: when minSharesPerLeg is set and the vault
    ///      returns fewer shares than the minimum, the whole call reverts.
    function test_depositTo_router_slippageReverts() public {
        _authorize(agent, _policyWithRouter());
        uint256 amount = 100 * ONE_USDC;
        _fundAndApprove(agent, amount);

        // Require 61 USDC worth of vaultA shares but 60/40 split gives only 60.
        uint256[] memory minShares = new uint256[](2);
        minShares[0] = 61 * ONE_USDC; // vaultA: 60 USDC expected, require 61
        minShares[1] = 0;

        vm.prank(agent);
        vm.expectRevert(PortfolioRouter.SlippageExceeded.selector);
        gateway.depositTo(
            keccak256("order-slip"),
            amount,
            uint64(block.timestamp + 60),
            keccak256("idem-slip"),
            address(router),
            minShares
        );
    }

    // ─── AC2: policy restriction — agent cannot route to router ───────────────

    /// @dev AC2: Agent whose allowedDestinations contains only the vault cannot
    ///      call depositTo with destination=router.
    function test_depositTo_router_revertsWhenNotInAllowedDestinations() public {
        _authorize(agent, _policyWithVaultOnly());
        uint256 amount = 100 * ONE_USDC;
        _fundAndApprove(agent, amount);

        uint256[] memory empty = new uint256[](0);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.InvalidDestination.selector);
        gateway.depositTo(
            keccak256("order-2"),
            amount,
            uint64(block.timestamp + 60),
            keccak256("idem-2"),
            address(router),
            empty
        );
    }

    /// @dev AC2: An agent with an open allowedDestinations list (empty array) can
    ///      route to either the pinned vault or the router.
    function test_depositTo_openDestinations_allowsVaultAndRouter() public {
        _authorize(agent, _policyOpenDestinations());
        uint256 amount = 50 * ONE_USDC;
        _fundAndApprove(agent, 2 * amount);

        uint256[] memory empty = new uint256[](0);

        // Route to router.
        vm.prank(agent);
        gateway.depositTo(
            keccak256("order-3a"),
            amount,
            uint64(block.timestamp + 60),
            keccak256("idem-3a"),
            address(router),
            empty
        );

        // Route to vault.
        vm.prank(agent);
        gateway.depositTo(
            keccak256("order-3b"),
            amount,
            uint64(block.timestamp + 60),
            keccak256("idem-3b"),
            address(vault),
            empty
        );

        // shareReceiver got vault shares from the pinned vault deposit.
        assertEq(vault.balanceOf(shareReceiver), amount, "pinned vault shares");
    }

    // ─── AC3: invalid destination revert ─────────────────────────────────────

    /// @dev AC3: Destination that is neither a registered vault nor the router
    ///      reverts with InvalidDestination.
    function test_depositTo_revertsOnArbitraryDestination() public {
        _authorize(agent, _policyOpenDestinations());
        uint256 amount = 10 * ONE_USDC;
        _fundAndApprove(agent, amount);

        address rando = makeAddr("rando-not-a-vault");
        uint256[] memory empty = new uint256[](0);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.InvalidDestination.selector);
        gateway.depositTo(
            keccak256("order-4"),
            amount,
            uint64(block.timestamp + 60),
            keccak256("idem-4"),
            rando,
            empty
        );
    }

    /// @dev AC3: When router is address(0) (no router configured), attempting to
    ///      call depositTo with any destination that is not the pinned vault reverts.
    function test_depositTo_revertsWhenRouterNotConfigured() public {
        // Deploy a gateway without a router.
        RobotMoneyGateway noRouterGateway = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(0)
        );

        address[] memory empty = new address[](0);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: empty
        });
        vm.prank(depositor);
        noRouterGateway.authorizeAgent(agent, p);

        usdc.mint(agent, 10 * ONE_USDC);
        vm.prank(agent);
        usdc.approve(address(noRouterGateway), 10 * ONE_USDC);

        uint256[] memory emptyMin = new uint256[](0);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.InvalidDestination.selector);
        noRouterGateway.depositTo(
            keccak256("order-5"),
            10 * ONE_USDC,
            uint64(block.timestamp + 60),
            keccak256("idem-5"),
            address(router),
            emptyMin
        );
    }

    // ─── AC4: AgentDepositRouted event ────────────────────────────────────────

    /// @dev Helper: search recorded logs for AgentDepositRouted and return the log
    ///      index if found, or type(uint256).max if not found.
    function _findRoutedEvent(Vm.Log[] memory logs) internal view returns (uint256) {
        bytes32 routedSig = keccak256(
            "AgentDepositRouted(bytes32,bytes32,address,address,address,uint256,uint256[],uint64)"
        );
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == routedSig && logs[i].emitter == address(gateway)) {
                return i;
            }
        }
        return type(uint256).max;
    }

    /// @dev AC4: AgentDepositRouted event includes router address and per-leg share
    ///      amounts when routing through the router.
    function test_depositTo_router_emitsAgentDepositRoutedEvent() public {
        _authorize(agent, _policyWithRouter());
        uint256 amount = 200 * ONE_USDC;
        _fundAndApprove(agent, amount);

        bytes32 orderId = keccak256("order-evt");
        bytes32 idem = keccak256("idem-evt");
        uint256[] memory emptyMin = new uint256[](0);

        bytes32 expectedPaymentId =
            keccak256(abi.encode(block.chainid, address(gateway), agent, orderId, amount, idem));

        vm.recordLogs();
        vm.prank(agent);
        gateway.depositTo(
            orderId, amount, uint64(block.timestamp + 60), idem, address(router), emptyMin
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 idx = _findRoutedEvent(logs);
        assertTrue(idx != type(uint256).max, "AgentDepositRouted event not emitted");

        // Indexed: paymentId, orderId, agent
        assertEq(logs[idx].topics[1], expectedPaymentId, "paymentId");
        assertEq(logs[idx].topics[2], orderId, "orderId");
        assertEq(address(uint160(uint256(logs[idx].topics[3]))), agent, "agent");

        _assertRoutedEventData(logs[idx].data, amount);
    }

    /// @dev Decode and assert non-indexed fields of an AgentDepositRouted log.
    function _assertRoutedEventData(bytes memory data, uint256 expectedAmount) internal view {
        (
            address logShareReceiver,
            address logRouter,
            uint256 logAmount,
            uint256[] memory logSharesPerLeg,
            uint64 logWindowId
        ) = abi.decode(data, (address, address, uint256, uint256[], uint64));

        assertEq(logShareReceiver, shareReceiver, "shareReceiver");
        assertEq(logRouter, address(router), "router address");
        assertEq(logAmount, expectedAmount, "amount");
        assertEq(logSharesPerLeg.length, 2, "2 legs");
        assertEq(logSharesPerLeg[0], 120 * ONE_USDC, "vaultA leg 60%");
        assertEq(logSharesPerLeg[1], 80 * ONE_USDC, "vaultB leg 40%");
        assertEq(logWindowId, uint64(block.timestamp / gateway.WINDOW_SECONDS()), "windowId");
    }

    // ─── AC5: single-vault path unaffected ───────────────────────────────────

    /// @dev AC5: The original `deposit()` call to the pinned vault still works
    ///      correctly when a router is configured.
    function test_deposit_singleVault_unaffectedByRouter() public {
        address[] memory empty = new address[](0);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: empty
        });
        _authorize(agent, p);

        uint256 amount = 100 * ONE_USDC;
        _fundAndApprove(agent, amount);

        bytes32 orderId = keccak256("order-sv");
        bytes32 idem = keccak256("idem-sv");

        vm.prank(agent);
        (bytes32 paymentId, uint256 sharesMinted) =
            gateway.deposit(orderId, amount, uint64(block.timestamp + 60), idem);

        assertTrue(paymentId != bytes32(0));
        assertEq(sharesMinted, amount, "1:1 vault shares");
        assertEq(vault.balanceOf(shareReceiver), amount, "shares to shareReceiver");
        assertEq(usdc.balanceOf(address(gateway)), 0, "no usdc residual");
    }

    /// @dev AC5: depositTo with destination=vault routes correctly to the pinned
    ///      vault and emits AgentDeposit (not AgentDepositRouted).
    function test_depositTo_vaultDestination_routesToPinnedVault() public {
        address[] memory destinations = new address[](1);
        destinations[0] = address(vault);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: destinations
        });
        _authorize(agent, p);

        uint256 amount = 100 * ONE_USDC;
        _fundAndApprove(agent, amount);

        uint256[] memory emptyMin = new uint256[](0);
        bytes32 orderId = keccak256("order-vd");
        bytes32 idem = keccak256("idem-vd");

        vm.prank(agent);
        bytes32 paymentId = gateway.depositTo(
            orderId, amount, uint64(block.timestamp + 60), idem, address(vault), emptyMin
        );

        assertTrue(paymentId != bytes32(0));
        assertEq(vault.balanceOf(shareReceiver), amount, "shares to shareReceiver");
        assertEq(usdc.balanceOf(address(gateway)), 0, "no usdc residual");
    }

    // ─── Common preflight check propagation ──────────────────────────────────

    /// @dev depositTo enforces zero-amount check.
    function test_depositTo_revertsOnZeroAmount() public {
        _authorize(agent, _policyWithRouter());
        uint256[] memory empty = new uint256[](0);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.InvalidAmount.selector);
        gateway.depositTo(
            keccak256("o"), 0, uint64(block.timestamp + 60), keccak256("i"), address(router), empty
        );
    }

    /// @dev depositTo enforces deadline too far.
    function test_depositTo_revertsOnDeadlineTooFar() public {
        _authorize(agent, _policyWithRouter());
        _fundAndApprove(agent, 10 * ONE_USDC);
        uint256[] memory empty = new uint256[](0);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.DeadlineTooFar.selector);
        gateway.depositTo(
            keccak256("o"),
            10 * ONE_USDC,
            uint64(block.timestamp + 601),
            keccak256("i"),
            address(router),
            empty
        );
    }

    /// @dev depositTo enforces expired policy.
    function test_depositTo_revertsOnExpiredPolicy() public {
        IGateway.AgentPolicy memory p = _policyWithRouter();
        p.validUntil = uint64(block.timestamp + 100);
        _authorize(agent, p);
        _fundAndApprove(agent, 10 * ONE_USDC);

        vm.warp(block.timestamp + 200);
        uint256[] memory empty = new uint256[](0);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.AgentPolicyExpired.selector);
        gateway.depositTo(
            keccak256("o"),
            10 * ONE_USDC,
            uint64(block.timestamp + 60),
            keccak256("i"),
            address(router),
            empty
        );
    }

    /// @dev depositTo enforces the paused check.
    function test_depositTo_revertsWhenPaused() public {
        _authorize(agent, _policyWithRouter());
        _fundAndApprove(agent, 10 * ONE_USDC);
        vm.prank(pauser);
        gateway.pause();

        uint256[] memory empty = new uint256[](0);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.PausedError.selector);
        gateway.depositTo(
            keccak256("o"),
            10 * ONE_USDC,
            uint64(block.timestamp + 60),
            keccak256("i"),
            address(router),
            empty
        );
    }

    /// @dev depositTo enforces per-payment cap.
    function test_depositTo_revertsOnPerPaymentCapExceeded() public {
        _authorize(agent, _policyWithRouter());
        _fundAndApprove(agent, MAX_PER_PAYMENT + 1);

        uint256[] memory empty = new uint256[](0);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.AmountExceedsPerPaymentCap.selector);
        gateway.depositTo(
            keccak256("o"),
            MAX_PER_PAYMENT + 1,
            uint64(block.timestamp + 60),
            keccak256("i"),
            address(router),
            empty
        );
    }

    /// @dev depositTo enforces deadline bounds.
    function test_depositTo_revertsOnExpiredDeadline() public {
        _authorize(agent, _policyWithRouter());
        _fundAndApprove(agent, 10 * ONE_USDC);

        uint256[] memory empty = new uint256[](0);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.DeadlineExpired.selector);
        gateway.depositTo(
            keccak256("o"),
            10 * ONE_USDC,
            uint64(block.timestamp - 1),
            keccak256("i"),
            address(router),
            empty
        );
    }

    /// @dev depositTo enforces idempotency.
    function test_depositTo_revertsOnReplay() public {
        _authorize(agent, _policyWithRouter());
        _fundAndApprove(agent, 200 * ONE_USDC);

        bytes32 orderId = keccak256("order-rp");
        bytes32 idem = keccak256("idem-rp");
        uint256 amount = 100 * ONE_USDC;
        uint256[] memory emptyMin = new uint256[](0);

        vm.prank(agent);
        gateway.depositTo(
            orderId, amount, uint64(block.timestamp + 60), idem, address(router), emptyMin
        );

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.PaymentIdAlreadyUsed.selector);
        gateway.depositTo(
            orderId, amount, uint64(block.timestamp + 60), idem, address(router), emptyMin
        );
    }

    /// @dev depositTo enforces window cap.
    function test_depositTo_revertsOnWindowCapExceeded() public {
        IGateway.AgentPolicy memory p = _policyWithRouter();
        p.maxPerWindow = 2 * MAX_PER_PAYMENT;
        _authorize(agent, p);
        _fundAndApprove(agent, 5 * MAX_PER_PAYMENT);

        uint256[] memory emptyMin = new uint256[](0);
        vm.prank(agent);
        gateway.depositTo(
            keccak256("o1"),
            MAX_PER_PAYMENT,
            uint64(block.timestamp + 60),
            keccak256("i1"),
            address(router),
            emptyMin
        );
        vm.prank(agent);
        gateway.depositTo(
            keccak256("o2"),
            MAX_PER_PAYMENT,
            uint64(block.timestamp + 60),
            keccak256("i2"),
            address(router),
            emptyMin
        );

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.WindowCapExceeded.selector);
        gateway.depositTo(
            keccak256("o3"),
            1,
            uint64(block.timestamp + 60),
            keccak256("i3"),
            address(router),
            emptyMin
        );
    }

    /// @dev depositTo requires AGENT_ROLE.
    function test_depositTo_revertsForUnauthorizedCaller() public {
        bytes32 agentRole = gateway.AGENT_ROLE();
        uint256[] memory empty = new uint256[](0);
        _fundAndApprove(stranger, 10 * ONE_USDC);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, agentRole
            )
        );
        gateway.depositTo(
            keccak256("o"),
            10 * ONE_USDC,
            uint64(block.timestamp + 60),
            keccak256("i"),
            address(router),
            empty
        );
    }

    // ─── Coverage: custody invariants and fee-on-transfer in depositTo ─────────

    /// @dev `depositTo` router path: post-call USDC custody invariant — a router
    ///      that under-pulls USDC leaves the gateway holding leftover stablecoin.
    function test_depositTo_routerPath_revertsOnUsdcCustodyInvariant() public {
        // Deploy gateway with an underpull router.
        UnderPullRouter underPullRouter = new UnderPullRouter(address(usdc));
        RobotMoneyGateway gw = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(underPullRouter)
        );
        address[] memory routerDests = new address[](1);
        routerDests[0] = address(underPullRouter);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: routerDests
        });
        vm.prank(depositor);
        gw.authorizeAgent(agent, p);

        usdc.mint(agent, 100 * ONE_USDC);
        vm.prank(agent);
        usdc.approve(address(gw), 100 * ONE_USDC);

        uint256[] memory emptyMin = new uint256[](0);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.ShareCustodyInvariantViolated.selector);
        gw.depositTo(
            keccak256("o"),
            100 * ONE_USDC,
            uint64(block.timestamp + 60),
            keccak256("i"),
            address(underPullRouter),
            emptyMin
        );
    }

    /// @dev `depositTo` detects fee-on-transfer tokens just like `deposit`.
    function test_depositTo_revertsOnFeeOnTransferToken() public {
        // Build a fresh stack: fee-on-transfer usdc, matching vault, gateway with router.
        FeeOnTransferUSDC fotUsdc = new FeeOnTransferUSDC();
        MockVault fotVault = new MockVault(address(fotUsdc));
        VaultRegistry fotRegistry = new VaultRegistry(admin);
        RouterMockVault fotVaultA = new RouterMockVault(address(fotUsdc), "FOT Vault A", "fA");
        vm.prank(admin);
        fotRegistry.registerVault(
            address(fotVaultA),
            VaultRegistry.VaultMetadata({name: "FOT A", asset: address(fotUsdc), registeredAt: 0})
        );
        PortfolioRouter fotRouter =
            new PortfolioRouter(address(fotUsdc), address(fotRegistry), admin);
        address[] memory fvaults = new address[](1);
        fvaults[0] = address(fotVaultA);
        uint256[] memory fbps = new uint256[](1);
        fbps[0] = 10_000;
        vm.prank(admin);
        fotRouter.setWeights(fvaults, fbps);

        RobotMoneyGateway fotGateway = new RobotMoneyGateway(
            IERC20(address(fotUsdc)), IERC4626(address(fotVault)), admin, pauser, address(fotRouter)
        );

        address[] memory routerDests = new address[](1);
        routerDests[0] = address(fotRouter);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: routerDests
        });
        vm.prank(depositor);
        fotGateway.authorizeAgent(agent, p);

        fotUsdc.mint(agent, 200 * ONE_USDC);
        vm.prank(agent);
        fotUsdc.approve(address(fotGateway), 200 * ONE_USDC);

        uint256[] memory emptyMin = new uint256[](0);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.FeeOnTransferDetected.selector);
        fotGateway.depositTo(
            keccak256("o"),
            100 * ONE_USDC,
            uint64(block.timestamp + 60),
            keccak256("i"),
            address(fotRouter),
            emptyMin
        );
    }

    /// @dev `depositTo` vault path: pre-call share custody invariant — gateway must
    ///      hold zero shares of the destination vault before the call.
    function test_depositTo_vaultPath_revertsOnPreCallShareCustody() public {
        _authorize(agent, _policyOpenDestinations());
        _fundAndApprove(agent, 100 * ONE_USDC);

        // Seed the gateway with vault shares before the deposit.
        deal(address(vault), address(gateway), 1, true);

        uint256[] memory emptyMin = new uint256[](0);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.ShareCustodyInvariantViolated.selector);
        gateway.depositTo(
            keccak256("o"),
            100 * ONE_USDC,
            uint64(block.timestamp + 60),
            keccak256("i"),
            address(vault),
            emptyMin
        );
    }

    /// @dev `depositTo` vault path: post-call share custody invariant —
    ///      a vault that leaks shares back to the gateway trips the invariant.
    function test_depositTo_vaultPath_revertsOnPostCallShareCustody() public {
        // Use a share-leaking vault.
        ShareLeakVault leaky = new ShareLeakVault(address(usdc));
        RobotMoneyGateway gw = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(leaky)), admin, pauser, address(0)
        );
        address[] memory empty = new address[](0);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: empty
        });
        vm.prank(depositor);
        gw.authorizeAgent(agent, p);

        usdc.mint(agent, 100 * ONE_USDC);
        vm.prank(agent);
        usdc.approve(address(gw), 100 * ONE_USDC);

        uint256[] memory emptyMin = new uint256[](0);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.ShareCustodyInvariantViolated.selector);
        gw.depositTo(
            keccak256("o"),
            100 * ONE_USDC,
            uint64(block.timestamp + 60),
            keccak256("i"),
            address(leaky),
            emptyMin
        );
    }

    /// @dev `depositTo` vault path: post-call USDC custody invariant — a vault that
    ///      under-pulls USDC leaves the gateway holding leftover stablecoin.
    function test_depositTo_vaultPath_revertsOnPostCallUsdcCustody() public {
        UnderPullVault underPull = new UnderPullVault(address(usdc));
        RobotMoneyGateway gw = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(underPull)), admin, pauser, address(0)
        );
        address[] memory empty = new address[](0);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: empty
        });
        vm.prank(depositor);
        gw.authorizeAgent(agent, p);

        usdc.mint(agent, 100 * ONE_USDC);
        vm.prank(agent);
        usdc.approve(address(gw), 100 * ONE_USDC);

        uint256[] memory emptyMin = new uint256[](0);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.ShareCustodyInvariantViolated.selector);
        gw.depositTo(
            keccak256("o"),
            100 * ONE_USDC,
            uint64(block.timestamp + 60),
            keccak256("i"),
            address(underPull),
            emptyMin
        );
    }
}
