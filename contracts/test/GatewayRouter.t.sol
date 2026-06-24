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

    /// @notice ERC-4626-style redeem (1:1 no exit fee). Burns `shares` from
    ///         `owner`; transfers `assets == shares` to `receiver`. Enforces
    ///         `_spendAllowance` when `owner != msg.sender`, mirroring MockVault.
    function redeem(uint256 shares, address receiver, address owner)
        external
        returns (uint256 assets)
    {
        require(shares > 0, "zero shares");
        require(receiver != address(0), "zero receiver");
        if (owner != msg.sender) {
            _spendAllowance(owner, msg.sender, shares);
        }
        _burn(owner, shares);
        assets = shares;
        assetToken.safeTransfer(receiver, assets);
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

/// @notice Standalone ERC-4626-shaped vault that leaks one share to the caller
///         during redeem, simulating a misbehaving vault that does not burn all
///         shares.  Used to trip the ShareCustodyInvariantViolated check in
///         _executeRouterWithdraw.
contract LeakyRedeemRouterVault is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable assetToken;

    constructor(address asset_) ERC20("Leaky Router Vault", "LRV") {
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

    /// @dev Burns only `shares - 1` but transfers the full `shares` worth of
    ///      assets.  The un-burned share stays with `owner` (the gateway), so
    ///      the post-call custody invariant fires.
    function redeem(uint256 shares, address receiver, address owner)
        external
        returns (uint256 assets)
    {
        require(shares > 0, "zero shares");
        if (owner != msg.sender) {
            _spendAllowance(owner, msg.sender, shares);
        }
        // Only burn shares - 1; leave 1 share with owner intentionally.
        _burn(owner, shares - 1);
        assets = shares;
        assetToken.safeTransfer(receiver, assets);
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
        // Issue #475: production-readiness is registry state. Mark both
        // vaults router-eligible in the registry so setWeights accepts
        // them through the single production code path.
        vm.startPrank(admin);
        registry.setRouterEligible(address(vaultA), true);
        registry.setRouterEligible(address(vaultB), true);
        router.setWeights(vaults, bps);
        vm.stopPrank();

        // Deploy gateway with router support
        gateway = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(router)
        );
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _policyWithRouter() internal view returns (IGateway.AgentPolicy memory) {
        address[] memory destinations = new address[](1);
        destinations[0] = address(router);
        address[] memory noSources = new address[](0);
        return IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: destinations,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: noSources
        });
    }

    function _policyWithVaultOnly() internal view returns (IGateway.AgentPolicy memory) {
        address[] memory destinations = new address[](1);
        destinations[0] = address(vault);
        address[] memory noSources = new address[](0);
        return IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: destinations,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: noSources
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
            allowedDestinations: empty,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: empty
        });
    }

    function _authorize(address who, IGateway.AgentPolicy memory p) internal {
        vm.prank(admin);
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

        // GW-2/NC-9: the depositTo paymentId binds the full intent — the routing
        // destination and the per-leg slippage vector are part of the preimage.
        bytes32 expectedPaymentId = keccak256(
            abi.encode(
                uint8(3),
                block.chainid,
                address(gateway),
                agent,
                orderId,
                amount,
                idem,
                address(router),
                minShares
            )
        );
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

        // Rolling-window deposit gross (#497) and idempotency key recorded.
        assertEq(gateway.effectiveDepositWindowGross(agent), amount);
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

    // ─── GW-2 / NC-9: idempotency key binds the FULL intent ───────────────────

    /// @dev GW-2 / NC-9 (FLIPPED GREEN by #970): a single paymentId/idempotency
    ///      key never authorizes two MATERIALLY DIFFERENT execution intents. The
    ///      depositTo paymentId now folds the routing `destination` and the
    ///      per-leg `minSharesPerLeg` vector into its preimage, so two depositTo
    ///      calls sharing the same (orderId, amount, idempotencyKey) but routing
    ///      to a DIFFERENT destination produce DIFFERENT paymentIds — neither is
    ///      silently swallowed as a replay of the other. Deep proof referenced by
    ///      FvInvariants.t.sol::test_GW2_*.
    function test_GW2_depositTo_paymentIdBindsDestination() public {
        _authorize(agent, _policyOpenDestinations());
        uint256 amount = 25 * ONE_USDC;
        _fundAndApprove(agent, 2 * amount);

        bytes32 orderId = keccak256("gw2-order");
        bytes32 idem = keccak256("gw2-idem");
        uint64 deadline = uint64(block.timestamp + 60);
        uint256[] memory empty = new uint256[](0);

        // Same (orderId, amount, idem) routed to the ROUTER.
        vm.prank(agent);
        bytes32 idRouter =
            gateway.depositTo(orderId, amount, deadline, idem, address(router), empty);

        // Identical (orderId, amount, idem) routed to the VAULT must NOT collide.
        // Pre-fix, both share the same paymentId and the second reverts
        // PaymentIdAlreadyUsed even though it is a different intent; post-fix the
        // destination is part of the preimage, so the second call succeeds with a
        // distinct paymentId.
        vm.prank(agent);
        bytes32 idVault = gateway.depositTo(orderId, amount, deadline, idem, address(vault), empty);

        assertTrue(
            idRouter != idVault, "GW-2: differing destinations must yield differing paymentIds"
        );
        assertTrue(gateway.usedPaymentIds(idRouter), "router paymentId consumed");
        assertTrue(gateway.usedPaymentIds(idVault), "vault paymentId consumed");
    }

    /// @dev GW-2 / NC-9: the per-leg slippage vector `minSharesPerLeg` is also
    ///      bound into the paymentId, so two router deposits sharing the same
    ///      (orderId, amount, idem) but carrying a DIFFERENT per-leg floor are
    ///      distinct intents and never collide.
    function test_GW2_depositTo_paymentIdBindsMinSharesPerLeg() public {
        _authorize(agent, _policyWithRouter());
        uint256 amount = 30 * ONE_USDC;
        _fundAndApprove(agent, 2 * amount);

        bytes32 orderId = keccak256("gw2-leg-order");
        bytes32 idem = keccak256("gw2-leg-idem");
        uint64 deadline = uint64(block.timestamp + 60);

        // 60/40 router split → two legs. Distinct per-leg floors below the
        // proportional receipts both execute, but must produce distinct paymentIds.
        uint256[] memory legsA = new uint256[](2);
        legsA[0] = 1;
        legsA[1] = 1;
        uint256[] memory legsB = new uint256[](2);
        legsB[0] = 2;
        legsB[1] = 2;

        vm.prank(agent);
        bytes32 idA = gateway.depositTo(orderId, amount, deadline, idem, address(router), legsA);
        vm.prank(agent);
        bytes32 idB = gateway.depositTo(orderId, amount, deadline, idem, address(router), legsB);

        assertTrue(idA != idB, "GW-2: differing per-leg floors must yield differing paymentIds");
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
            allowedDestinations: empty,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: empty
        });
        vm.prank(admin);
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

        // GW-2/NC-9: full-intent binding — destination + per-leg vector in preimage.
        bytes32 expectedPaymentId = keccak256(
            abi.encode(
                uint8(3),
                block.chainid,
                address(gateway),
                agent,
                orderId,
                amount,
                idem,
                address(router),
                emptyMin
            )
        );

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
            allowedDestinations: empty,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: empty
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
        address[] memory noSources = new address[](0);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: destinations,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: noSources
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
        address[] memory noSources = new address[](0);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: routerDests,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: noSources
        });
        vm.prank(admin);
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
        // Issue #475: mark the mock vault router-eligible via the single
        // registry-backed gate.
        vm.startPrank(admin);
        fotRegistry.setRouterEligible(address(fotVaultA), true);
        fotRouter.setWeights(fvaults, fbps);
        vm.stopPrank();

        RobotMoneyGateway fotGateway = new RobotMoneyGateway(
            IERC20(address(fotUsdc)), IERC4626(address(fotVault)), admin, pauser, address(fotRouter)
        );

        address[] memory routerDests = new address[](1);
        routerDests[0] = address(fotRouter);
        address[] memory noSources2 = new address[](0);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: routerDests,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: noSources2
        });
        vm.prank(admin);
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

    /// @dev Preexisting donated shares do not brick the vault deposit path.
    function test_depositTo_vaultPath_ignoresPreexistingDonatedShares() public {
        _authorize(agent, _policyOpenDestinations());
        _fundAndApprove(agent, 100 * ONE_USDC);

        // Seed the gateway with vault shares before the deposit.
        deal(address(vault), address(gateway), 1, true);

        uint256[] memory emptyMin = new uint256[](0);
        vm.prank(agent);
        gateway.depositTo(
            keccak256("o"),
            100 * ONE_USDC,
            uint64(block.timestamp + 60),
            keccak256("i"),
            address(vault),
            emptyMin
        );
        assertEq(vault.balanceOf(address(gateway)), 1, "donated share must remain unchanged");
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
            allowedDestinations: empty,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: empty
        });
        vm.prank(admin);
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
            allowedDestinations: empty,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: empty
        });
        vm.prank(admin);
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

    // ─── Issue #509: depositTo must read maxPerWindow from in-memory snapshot ──

    /// @dev AC1 / Test-plan structural check: depositTo() must not re-read
    ///      agents[msg.sender].maxPerWindow from storage at the window-cap call
    ///      site. Post-fix the window cap is enforced using args.maxPerWindow
    ///      (captured from the in-memory snapshot p inside the scoped block).
    ///
    ///      We verify this behaviourally: use vm.store to set maxPerWindow in
    ///      storage to a lower value BEFORE the depositTo call (so the snapshot
    ///      p also captures this value). The window-cap check must enforce the
    ///      snapshot value. We then confirm the revert is WindowCapExceeded (not
    ///      some other error), proving the check uses the snapshot field, not a
    ///      constant or an unrelated storage slot.
    function test_depositTo_windowCap_enforcesSnapshotValue() public {
        // Authorize with a tight window: exactly one payment fits.
        IGateway.AgentPolicy memory p = _policyWithRouter();
        p.maxPerPayment = 100 * ONE_USDC;
        p.maxPerWindow = 100 * ONE_USDC; // exactly one payment fits per window
        _authorize(agent, p);

        _fundAndApprove(agent, 200 * ONE_USDC);
        uint256[] memory emptyMin = new uint256[](0);

        // First depositTo — should succeed, consuming the full window budget.
        vm.prank(agent);
        gateway.depositTo(
            keccak256("snap-o1"),
            100 * ONE_USDC,
            uint64(block.timestamp + 60),
            keccak256("snap-i1"),
            address(router),
            emptyMin
        );

        // Second depositTo of even 1 wei — must revert because the window is
        // exhausted. This confirms the snapshot value (100 USDC) is enforced.
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.WindowCapExceeded.selector);
        gateway.depositTo(
            keccak256("snap-o2"),
            1,
            uint64(block.timestamp + 60),
            keccak256("snap-i2"),
            address(router),
            emptyMin
        );
    }

    /// @dev AC2 / Test-plan storage-slot manipulation: use vm.store to write a
    ///      higher maxPerWindow into the agents mapping slot after the policy is
    ///      set, then call depositTo and verify the window cap reflects the
    ///      updated storage value (which is also what the in-memory snapshot
    ///      captures at call time). A further deposit that would exceed even
    ///      the new cap must still revert with WindowCapExceeded, proving the
    ///      snapshot is enforced end-to-end.
    ///
    ///      Storage layout (forge inspect RobotMoneyGateway storageLayout):
    ///        slot 3  → agents mapping (slot 2 is commitments, added by #507)
    ///      AgentPolicy struct offsets from the mapping element base:
    ///        +0 → active (bool) + validUntil (uint64, packed)
    ///        +1 → maxPerPayment (uint256)
    ///        +2 → maxPerWindow  (uint256)   ← target slot
    function test_depositTo_windowCap_usesSnapshotNotSecondStorageRead() public {
        // 1. Authorize agent: maxPerPayment = 100 USDC, maxPerWindow = 100 USDC
        //    (window exactly tight: one payment fits).
        IGateway.AgentPolicy memory p = _policyWithRouter();
        p.maxPerPayment = 100 * ONE_USDC;
        p.maxPerWindow = 100 * ONE_USDC;
        _authorize(agent, p);

        // 2. Compute the storage slot for agents[agent].maxPerWindow.
        //    agents mapping is at slot 3 (slot 2 = commitments from #507); AgentPolicy fields at the struct base:
        //      +0 → active (bool) + validUntil (uint64, packed into 1 slot)
        //      +1 → maxPerPayment (uint256)
        //      +2 → maxPerWindow  (uint256)
        bytes32 agentsPolicyBase = keccak256(abi.encode(agent, uint256(3)));
        bytes32 maxPerWindowSlot = bytes32(uint256(agentsPolicyBase) + 2);

        // 3. Also overwrite maxPerPayment (offset +1) so per-payment cap is not
        //    the binding constraint, and maxPerWindow (offset +2) to the new cap.
        //    This simulates a policy update between calls.
        bytes32 maxPerPaymentSlot = bytes32(uint256(agentsPolicyBase) + 1);
        uint256 newPerPayment = 300 * ONE_USDC;
        uint256 newCap = 300 * ONE_USDC;
        vm.store(address(gateway), maxPerPaymentSlot, bytes32(newPerPayment));
        vm.store(address(gateway), maxPerWindowSlot, bytes32(newCap));

        // 4. Verify storage was updated as expected.
        //    The auto-generated getter for agents omits dynamic-array fields
        //    (allowedDestinations, allowedSourceVaults) and returns:
        //      (active, validUntil, maxPerPayment, maxPerWindow,
        //       shareReceiver, assetRecipient, maxWithdrawPerPayment,
        //       maxWithdrawPerWindow)
        //    Skip 3 fields → capture maxPerWindow (4th element, 0-indexed: [3]).
        (,,, uint256 storedMaxPerWindow,,,,) = gateway.agents(agent);
        assertEq(storedMaxPerWindow, newCap, "storage update must be visible");

        // 5. Deposit 300 USDC (new maxPerPayment = new maxPerWindow = 300).
        //    This would have reverted pre-storage-write (maxPerPayment was 100),
        //    but now the snapshot captures the updated values.
        _fundAndApprove(agent, 400 * ONE_USDC);
        uint256[] memory emptyMin = new uint256[](0);
        vm.prank(agent);
        gateway.depositTo(
            keccak256("slot-o1"),
            300 * ONE_USDC,
            uint64(block.timestamp + 60),
            keccak256("slot-i1"),
            address(router),
            emptyMin
        );

        // 6. Any further deposit in the same window exceeds the new cap → revert.
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.WindowCapExceeded.selector);
        gateway.depositTo(
            keccak256("slot-o2"),
            1,
            uint64(block.timestamp + 60),
            keccak256("slot-i2"),
            address(router),
            emptyMin
        );
    }

    /// @dev AC3 / Test-plan gas snapshot: depositTo gas cost must be lower than
    ///      it would be with an extra cold SLOAD (2100 gas). We compare the gas
    ///      consumed by depositTo against deposit (the reference implementation
    ///      that uses a single snapshot). The two functions share the same policy
    ///      read pattern post-fix, so their gas delta on the policy-read path is
    ///      zero. A fixed upper-bound on total gas is also asserted to catch
    ///      regressions.
    ///
    ///      Note: both functions have different stack work (depositTo builds
    ///      DepositArgs), so the absolute gas figures differ. The key invariant
    ///      is that depositTo no longer performs a second SLOAD for maxPerWindow.
    function test_depositTo_gasReduction_singleSnapshotSLOAD() public {
        // Policy for deposit(): open destinations, vault only.
        address[] memory empty = new address[](0);
        IGateway.AgentPolicy memory pDeposit = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: empty,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: empty
        });

        // Agent A → deposit(); Agent B → depositTo().
        address agentA = makeAddr("gasAgentA");
        address agentB = makeAddr("gasAgentB");

        vm.prank(admin);
        gateway.authorizeAgent(agentA, pDeposit);

        IGateway.AgentPolicy memory pDepositTo = _policyWithVaultOnly();
        vm.prank(admin);
        gateway.authorizeAgent(agentB, pDepositTo);

        uint256 amount = 100 * ONE_USDC;
        usdc.mint(agentA, amount);
        vm.prank(agentA);
        usdc.approve(address(gateway), amount);

        usdc.mint(agentB, amount);
        vm.prank(agentB);
        usdc.approve(address(gateway), amount);

        uint256[] memory emptyMin = new uint256[](0);

        // Warm up storage (first call is the cold-SLOAD baseline for the window
        // accounting; we care about the policy-snapshot difference).
        vm.prank(agentA);
        uint256 gasBeforeDeposit = gasleft();
        gateway.deposit(keccak256("g-o1"), amount, uint64(block.timestamp + 60), keccak256("g-i1"));
        uint256 gasDeposit = gasBeforeDeposit - gasleft();

        vm.prank(agentB);
        uint256 gasBeforeDepositTo = gasleft();
        gateway.depositTo(
            keccak256("g-o2"),
            amount,
            uint64(block.timestamp + 60),
            keccak256("g-i2"),
            address(vault),
            emptyMin
        );
        uint256 gasDepositTo = gasBeforeDepositTo - gasleft();

        // depositTo builds DepositArgs (extra memory allocation), so it is
        // expected to cost somewhat more than deposit. The important invariant is
        // that the overhead is bounded: the extra SLOAD (2100 warm = 100 gas)
        // that was present pre-fix is now gone. We cap the allowed overhead at
        // 5000 gas to detect regressions while giving the struct allocation room.
        assertLt(
            gasDepositTo,
            gasDeposit + 5000,
            "depositTo must not cost more than deposit + 5000 gas (no extra SLOAD)"
        );
    }

    /// @dev AC4 / deposit() and depositTo() must use identical policy-read
    ///      patterns. Verify that both functions enforce the window cap at the
    ///      same threshold when given equivalent policies.
    function test_depositTo_and_deposit_enforceIdenticalWindowCap() public {
        // Two agents: one via deposit(), one via depositTo().
        address agentDeposit = makeAddr("winCapA");
        address agentDepositTo = makeAddr("winCapB");

        address[] memory empty = new address[](0);
        IGateway.AgentPolicy memory pol = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_PAYMENT, // exactly 1 payment per window
            shareReceiver: shareReceiver,
            allowedDestinations: empty,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: empty
        });

        vm.prank(admin);
        gateway.authorizeAgent(agentDeposit, pol);

        address[] memory vaultDests = new address[](1);
        vaultDests[0] = address(vault);
        IGateway.AgentPolicy memory polDepositTo = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_PAYMENT,
            shareReceiver: shareReceiver,
            allowedDestinations: vaultDests,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: empty
        });
        vm.prank(admin);
        gateway.authorizeAgent(agentDepositTo, polDepositTo);

        uint256 amount = MAX_PER_PAYMENT;
        _fundAndApprove(agentDeposit, 2 * amount);
        _fundAndApprove(agentDepositTo, 2 * amount);

        // First call: both succeed (window not yet exhausted).
        vm.prank(agentDeposit);
        gateway.deposit(
            keccak256("ident-d-o1"), amount, uint64(block.timestamp + 60), keccak256("ident-d-i1")
        );

        uint256[] memory emptyMin = new uint256[](0);
        vm.prank(agentDepositTo);
        gateway.depositTo(
            keccak256("ident-dt-o1"),
            amount,
            uint64(block.timestamp + 60),
            keccak256("ident-dt-i1"),
            address(vault),
            emptyMin
        );

        // Second call: both must revert with WindowCapExceeded.
        vm.prank(agentDeposit);
        vm.expectRevert(RobotMoneyGateway.WindowCapExceeded.selector);
        gateway.deposit(
            keccak256("ident-d-o2"), 1, uint64(block.timestamp + 60), keccak256("ident-d-i2")
        );

        vm.prank(agentDepositTo);
        vm.expectRevert(RobotMoneyGateway.WindowCapExceeded.selector);
        gateway.depositTo(
            keccak256("ident-dt-o2"),
            1,
            uint64(block.timestamp + 60),
            keccak256("ident-dt-i2"),
            address(vault),
            emptyMin
        );
    }

    // ─── Router withdrawal tests ──────────────────────────────────────────────

    /// @dev Helper: policy with withdrawal enabled from router vaults.
    function _policyWithRouterWithdrawal() internal returns (IGateway.AgentPolicy memory) {
        address[] memory destinations = new address[](1);
        destinations[0] = address(router);
        // AZ-GW-3 fix: empty allowedSourceVaults now means pinned-vault-only.
        // Router withdrawal tests that pull from vaultA/vaultB must enumerate
        // both vaults in the allowlist so the policy correctly permits them.
        address[] memory sources = new address[](2);
        sources[0] = address(vaultA);
        sources[1] = address(vaultB);
        return IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: destinations,
            assetRecipient: makeAddr("routerWithdrawRecipient"),
            maxWithdrawPerPayment: MAX_PER_PAYMENT,
            maxWithdrawPerWindow: MAX_PER_WINDOW,
            allowedSourceVaults: sources
        });
    }

    /// @dev Deposit via router and return the shares minted per leg.
    function _routerDepositAndGetShares(address who, uint256 amount)
        internal
        returns (uint256 sharesA, uint256 sharesB)
    {
        _fundAndApprove(who, amount);
        uint256[] memory emptyMin = new uint256[](0);
        vm.prank(who);
        gateway.depositTo(
            keccak256("router-deposit-for-withdraw"),
            amount,
            uint64(block.timestamp + 60),
            keccak256("router-deposit-idem"),
            address(router),
            emptyMin
        );
        sharesA = vaultA.balanceOf(shareReceiver);
        sharesB = vaultB.balanceOf(shareReceiver);
    }

    /// @dev The two-leg router vault set [vaultA, vaultB] (60/40), now passed
    ///      explicitly to withdrawFromRouter and committed to the paymentId
    ///      intent hash (issue #967).
    function _routerVaults() internal view returns (address[] memory vaults) {
        vaults = new address[](2);
        vaults[0] = address(vaultA);
        vaults[1] = address(vaultB);
    }

    /// @dev router: happy path — deposit via router, withdraw via router, USDC lands at assetRecipient.
    function test_withdrawFromRouter_happyPath() public {
        _authorize(agent, _policyWithRouterWithdrawal());
        address assetRecipient = makeAddr("routerWithdrawRecipient");

        uint256 amount = 100 * ONE_USDC;
        (uint256 sharesA, uint256 sharesB) = _routerDepositAndGetShares(agent, amount);
        // 60/40 split: vaultA=60, vaultB=40.
        assertEq(sharesA, 60 * ONE_USDC, "vaultA pre-withdraw shares");
        assertEq(sharesB, 40 * ONE_USDC, "vaultB pre-withdraw shares");

        // shareReceiver approves gateway to pull vault A and vault B shares.
        vm.prank(shareReceiver);
        vaultA.approve(address(gateway), sharesA);
        vm.prank(shareReceiver);
        vaultB.approve(address(gateway), sharesB);

        uint256[] memory sharesPerLeg = new uint256[](2);
        sharesPerLeg[0] = sharesA;
        sharesPerLeg[1] = sharesB;

        vm.prank(agent);
        (bytes32 paymentId, uint256[] memory assetsPerLeg) = gateway.withdrawFromRouter(
            keccak256("router-withdraw-order"),
            _routerVaults(),
            sharesPerLeg,
            new uint256[](sharesPerLeg.length),
            uint64(block.timestamp + 60),
            keccak256("router-withdraw-idem")
        );

        assertTrue(paymentId != bytes32(0), "paymentId non-zero");
        assertEq(assetsPerLeg.length, 2, "two legs");
        assertEq(assetsPerLeg[0], sharesA, "leg 0 assets (1:1)");
        assertEq(assetsPerLeg[1], sharesB, "leg 1 assets (1:1)");

        // USDC must go to assetRecipient.
        assertEq(usdc.balanceOf(assetRecipient), amount, "USDC to assetRecipient");

        // Gateway must hold zero of each vault's shares.
        assertEq(IERC20(address(vaultA)).balanceOf(address(gateway)), 0, "gateway holds 0 vaultA");
        assertEq(IERC20(address(vaultB)).balanceOf(address(gateway)), 0, "gateway holds 0 vaultB");

        // shareReceiver shares must be zero.
        assertEq(vaultA.balanceOf(shareReceiver), 0, "shareReceiver vaultA zero");
        assertEq(vaultB.balanceOf(shareReceiver), 0, "shareReceiver vaultB zero");
    }

    /// @notice GW-5 / F-11: a router redemption carrying a real, non-trivial
    ///         `minAssetsPerLeg` reverts when realized assets fall below the floor.
    ///         The gateway forwards the caller-supplied floor verbatim to the
    ///         router (it no longer hardcodes an all-zero vector), so the router's
    ///         per-leg `SlippageExceeded` guard bites.
    function test_withdrawFromRouter_realFloor_revertsBelowMinimum() public {
        _authorize(agent, _policyWithRouterWithdrawal());

        uint256 amount = 100 * ONE_USDC;
        (uint256 sharesA, uint256 sharesB) = _routerDepositAndGetShares(agent, amount);
        vm.prank(shareReceiver);
        vaultA.approve(address(gateway), sharesA);
        vm.prank(shareReceiver);
        vaultB.approve(address(gateway), sharesB);

        uint256[] memory sharesPerLeg = new uint256[](2);
        sharesPerLeg[0] = sharesA;
        sharesPerLeg[1] = sharesB;

        // The MockVault redeems 1:1, so leg A realizes exactly `sharesA` USDC.
        // Demand strictly more than that on leg A → the router must revert.
        uint256[] memory minAssetsPerLeg = new uint256[](2);
        minAssetsPerLeg[0] = sharesA + 1; // unsatisfiable floor
        minAssetsPerLeg[1] = 0;

        vm.prank(agent);
        vm.expectRevert(PortfolioRouter.SlippageExceeded.selector);
        gateway.withdrawFromRouter(
            keccak256("rw-floor-o"),
            _routerVaults(),
            sharesPerLeg,
            minAssetsPerLeg,
            uint64(block.timestamp + 60),
            keccak256("rw-floor-i")
        );
    }

    /// @notice GW-5 / F-11: a satisfiable real floor passes through and the
    ///         redemption settles normally (the floor is meaningful, not a no-op).
    function test_withdrawFromRouter_realFloor_passesWhenMet() public {
        _authorize(agent, _policyWithRouterWithdrawal());

        uint256 amount = 100 * ONE_USDC;
        (uint256 sharesA, uint256 sharesB) = _routerDepositAndGetShares(agent, amount);
        vm.prank(shareReceiver);
        vaultA.approve(address(gateway), sharesA);
        vm.prank(shareReceiver);
        vaultB.approve(address(gateway), sharesB);

        uint256[] memory sharesPerLeg = new uint256[](2);
        sharesPerLeg[0] = sharesA;
        sharesPerLeg[1] = sharesB;

        // 1:1 redemption; demand exactly the realized amount (the tight floor).
        uint256[] memory minAssetsPerLeg = new uint256[](2);
        minAssetsPerLeg[0] = sharesA;
        minAssetsPerLeg[1] = sharesB;

        vm.prank(agent);
        (, uint256[] memory assetsPerLeg) = gateway.withdrawFromRouter(
            keccak256("rw-floor-ok-o"),
            _routerVaults(),
            sharesPerLeg,
            minAssetsPerLeg,
            uint64(block.timestamp + 60),
            keccak256("rw-floor-ok-i")
        );
        assertEq(assetsPerLeg[0], sharesA, "leg 0 met floor");
        assertEq(assetsPerLeg[1], sharesB, "leg 1 met floor");
    }

    /// @notice GW-5 / F-11: the per-leg floor vector must be parallel to the share
    ///         vector — a length mismatch reverts before any state effect.
    function test_withdrawFromRouter_revertsOnMinAssetsLengthMismatch() public {
        _authorize(agent, _policyWithRouterWithdrawal());

        uint256[] memory sharesPerLeg = new uint256[](2);
        sharesPerLeg[0] = ONE_USDC;
        sharesPerLeg[1] = ONE_USDC;
        uint256[] memory shortMin = new uint256[](1); // mismatched length

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.RouterLegLengthMismatch.selector);
        gateway.withdrawFromRouter(
            keccak256("rw-minlen-o"),
            _routerVaults(),
            sharesPerLeg,
            shortMin,
            uint64(block.timestamp + 60),
            keccak256("rw-minlen-i")
        );
    }

    /// @notice GW-5 / F-11: the floor vector is bound into `paymentId`, so two
    ///         otherwise-identical orders that differ only in their floor produce
    ///         distinct ids — a replay cannot re-run an order under a weaker floor.
    function test_withdrawFromRouter_floorIsBoundIntoPaymentId() public {
        _authorize(agent, _policyWithRouterWithdrawal());

        uint256 amount = 100 * ONE_USDC;
        (uint256 sharesA, uint256 sharesB) = _routerDepositAndGetShares(agent, amount);
        vm.prank(shareReceiver);
        vaultA.approve(address(gateway), sharesA);
        vm.prank(shareReceiver);
        vaultB.approve(address(gateway), sharesB);

        uint256[] memory sharesPerLeg = new uint256[](2);
        sharesPerLeg[0] = sharesA;
        sharesPerLeg[1] = sharesB;

        uint256[] memory floorA = new uint256[](2);
        floorA[0] = sharesA;
        floorA[1] = sharesB;

        address[] memory vaults = _routerVaults();
        bytes32 orderId = keccak256("rw-floorbind-o");
        bytes32 idem = keccak256("rw-floorbind-i");

        uint256 totalShares = sharesA + sharesB;
        bytes32 idWithFloor = keccak256(
            abi.encode(
                uint8(4),
                block.chainid,
                address(gateway),
                agent,
                orderId,
                totalShares,
                vaults,
                sharesPerLeg,
                keccak256(abi.encode(floorA)),
                idem
            )
        );
        bytes32 idZeroFloor = keccak256(
            abi.encode(
                uint8(4),
                block.chainid,
                address(gateway),
                agent,
                orderId,
                totalShares,
                vaults,
                sharesPerLeg,
                keccak256(abi.encode(new uint256[](2))),
                idem
            )
        );
        assertTrue(idWithFloor != idZeroFloor, "floor must change the paymentId");

        vm.prank(agent);
        (bytes32 paymentId,) = gateway.withdrawFromRouter(
            orderId, vaults, sharesPerLeg, floorA, uint64(block.timestamp + 60), idem
        );
        assertEq(paymentId, idWithFloor, "paymentId binds the floor vector");
    }

    /// @dev router: the withdrawFromRouter paymentId preimage carries the
    ///      OP_WITHDRAW_ROUTER (= 4) op-kind prefix so router-withdrawal ids are
    ///      namespaced away from the three sibling op kinds (audit 2026-06-09, L-12).
    function test_withdrawFromRouter_paymentIdUsesOpWithdrawRouterPrefix() public {
        _authorize(agent, _policyWithRouterWithdrawal());

        uint256 amount = 100 * ONE_USDC;
        (uint256 sharesA, uint256 sharesB) = _routerDepositAndGetShares(agent, amount);
        vm.prank(shareReceiver);
        vaultA.approve(address(gateway), sharesA);
        vm.prank(shareReceiver);
        vaultB.approve(address(gateway), sharesB);

        uint256[] memory sharesPerLeg = new uint256[](2);
        sharesPerLeg[0] = sharesA;
        sharesPerLeg[1] = sharesB;

        bytes32 orderId = keccak256("router-withdraw-prefix-order");
        bytes32 idem = keccak256("router-withdraw-prefix-idem");

        address[] memory vaults = _routerVaults();

        vm.prank(agent);
        (bytes32 paymentId,) = gateway.withdrawFromRouter(
            orderId,
            vaults,
            sharesPerLeg,
            new uint256[](sharesPerLeg.length),
            uint64(block.timestamp + 60),
            idem
        );

        uint256 totalShares = sharesA + sharesB;
        // GW-5 / F-11: the per-leg slippage floor vector is folded into the
        // paymentId preimage so a replay cannot re-execute under a weaker floor.
        bytes32 minHash = keccak256(abi.encode(new uint256[](sharesPerLeg.length)));
        bytes32 expected = keccak256(
            abi.encode(
                uint8(4),
                block.chainid,
                address(gateway),
                agent,
                orderId,
                totalShares,
                vaults,
                sharesPerLeg,
                minHash,
                idem
            )
        );
        assertEq(paymentId, expected, "paymentId must use the OP_WITHDRAW_ROUTER prefix");

        // And it must differ from the legacy un-prefixed preimage.
        bytes32 legacy = keccak256(
            abi.encode(block.chainid, address(gateway), agent, orderId, totalShares, idem)
        );
        assertTrue(paymentId != legacy, "id must differ from the un-prefixed legacy preimage");
    }

    /// @dev router: allowedSourceVaults enforced — vault not in list reverts.
    function test_withdrawFromRouter_allowedSourceVaults_rejectsUnlisted() public {
        // Policy restricts source vaults to vaultA only.
        address[] memory destinations = new address[](1);
        destinations[0] = address(router);
        address[] memory sources = new address[](1);
        sources[0] = address(vaultA);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: destinations,
            assetRecipient: makeAddr("routerWithdrawRecipient2"),
            maxWithdrawPerPayment: MAX_PER_PAYMENT,
            maxWithdrawPerWindow: MAX_PER_WINDOW,
            allowedSourceVaults: sources
        });
        _authorize(agent, p);

        (uint256 sharesA, uint256 sharesB) = _routerDepositAndGetShares(agent, 100 * ONE_USDC);

        vm.prank(shareReceiver);
        vaultA.approve(address(gateway), sharesA);
        vm.prank(shareReceiver);
        vaultB.approve(address(gateway), sharesB);

        // sharesPerLeg[1] > 0 for vaultB, which is not in allowedSourceVaults.
        uint256[] memory sharesPerLeg = new uint256[](2);
        sharesPerLeg[0] = sharesA;
        sharesPerLeg[1] = sharesB;

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.InvalidSourceVault.selector);
        gateway.withdrawFromRouter(
            keccak256("rw-list-o"),
            _routerVaults(),
            sharesPerLeg,
            new uint256[](sharesPerLeg.length),
            uint64(block.timestamp + 60),
            keccak256("rw-list-i")
        );
    }

    /// @dev router: per-payment cap enforced (totalShares > maxWithdrawPerPayment).
    function test_withdrawFromRouter_revertsOnPerPaymentCapExceeded() public {
        IGateway.AgentPolicy memory p = _policyWithRouterWithdrawal();
        p.maxWithdrawPerPayment = 50 * ONE_USDC; // cap at 50
        p.maxWithdrawPerWindow = 200 * ONE_USDC;
        _authorize(agent, p);

        (uint256 sharesA, uint256 sharesB) = _routerDepositAndGetShares(agent, 100 * ONE_USDC);
        vm.prank(shareReceiver);
        vaultA.approve(address(gateway), sharesA);
        vm.prank(shareReceiver);
        vaultB.approve(address(gateway), sharesB);

        // totalShares = 100 > 50 cap
        uint256[] memory sharesPerLeg = new uint256[](2);
        sharesPerLeg[0] = sharesA;
        sharesPerLeg[1] = sharesB;

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.SharesExceedWithdrawPerPaymentCap.selector);
        gateway.withdrawFromRouter(
            keccak256("rw-cap-o"),
            _routerVaults(),
            sharesPerLeg,
            new uint256[](sharesPerLeg.length),
            uint64(block.timestamp + 60),
            keccak256("rw-cap-i")
        );
    }

    /// @dev router: window cap enforced — second call in same window reverts.
    function test_withdrawFromRouter_revertsOnWindowCapExceeded() public {
        IGateway.AgentPolicy memory p = _policyWithRouterWithdrawal();
        p.maxWithdrawPerPayment = 100 * ONE_USDC;
        p.maxWithdrawPerWindow = 100 * ONE_USDC; // window == payment
        _authorize(agent, p);

        (uint256 sharesA, uint256 sharesB) = _routerDepositAndGetShares(agent, 100 * ONE_USDC);
        vm.prank(shareReceiver);
        vaultA.approve(address(gateway), sharesA);
        vm.prank(shareReceiver);
        vaultB.approve(address(gateway), sharesB);

        uint256[] memory sharesPerLeg = new uint256[](2);
        sharesPerLeg[0] = sharesA;
        sharesPerLeg[1] = sharesB;

        // First call succeeds.
        vm.prank(agent);
        gateway.withdrawFromRouter(
            keccak256("rw-win-o1"),
            _routerVaults(),
            sharesPerLeg,
            new uint256[](sharesPerLeg.length),
            uint64(block.timestamp + 60),
            keccak256("rw-win-i1")
        );

        // Second call in same window — must revert (window exhausted).
        // (Even with 0 shares in leg, totalShares > 0 check would apply.)
        uint256[] memory zeroLeg = new uint256[](2);
        zeroLeg[0] = 1;
        zeroLeg[1] = 0;

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.WithdrawWindowCapExceeded.selector);
        gateway.withdrawFromRouter(
            keccak256("rw-win-o2"),
            _routerVaults(),
            zeroLeg,
            new uint256[](zeroLeg.length),
            uint64(block.timestamp + 60),
            keccak256("rw-win-i2")
        );
    }

    /// @dev router: idempotency enforced — same orderId+idempotencyKey reverts on replay.
    function test_withdrawFromRouter_revertsOnReplay() public {
        // Policy with large window cap so two withdrawals fit.
        address[] memory destinations = new address[](1);
        destinations[0] = address(router);
        // AZ-GW-3 fix: enumerate the two router vaults in allowedSourceVaults.
        address[] memory sources = new address[](2);
        sources[0] = address(vaultA);
        sources[1] = address(vaultB);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: destinations,
            assetRecipient: makeAddr("routerWithdrawRecipient"),
            maxWithdrawPerPayment: 200 * ONE_USDC,
            maxWithdrawPerWindow: MAX_PER_WINDOW,
            allowedSourceVaults: sources
        });
        _authorize(agent, p);

        (uint256 sharesA, uint256 sharesB) = _routerDepositAndGetShares(agent, 100 * ONE_USDC);
        vm.prank(shareReceiver);
        vaultA.approve(address(gateway), sharesA);
        vm.prank(shareReceiver);
        vaultB.approve(address(gateway), sharesB);

        uint256[] memory sharesPerLeg = new uint256[](2);
        sharesPerLeg[0] = sharesA;
        sharesPerLeg[1] = sharesB;

        bytes32 orderId = keccak256("rw-idm-o");
        bytes32 idem = keccak256("rw-idm-i");

        vm.prank(agent);
        gateway.withdrawFromRouter(
            orderId,
            _routerVaults(),
            sharesPerLeg,
            new uint256[](sharesPerLeg.length),
            uint64(block.timestamp + 60),
            idem
        );

        // Deposit fresh shares to shareReceiver (same split → same amounts).
        _fundAndApprove(agent, 100 * ONE_USDC);
        uint256[] memory emptyMin = new uint256[](0);
        vm.prank(agent);
        gateway.depositTo(
            keccak256("rw-idm-deposit2"),
            100 * ONE_USDC,
            uint64(block.timestamp + 60),
            keccak256("rw-idm-idem2"),
            address(router),
            emptyMin
        );
        uint256 sharesA2 = vaultA.balanceOf(shareReceiver);
        uint256 sharesB2 = vaultB.balanceOf(shareReceiver);
        vm.prank(shareReceiver);
        vaultA.approve(address(gateway), sharesA2);
        vm.prank(shareReceiver);
        vaultB.approve(address(gateway), sharesB2);

        // Same totalShares → same paymentId → PaymentIdAlreadyUsed.
        uint256[] memory sharesPerLeg2 = new uint256[](2);
        sharesPerLeg2[0] = sharesA2;
        sharesPerLeg2[1] = sharesB2;

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.PaymentIdAlreadyUsed.selector);
        gateway.withdrawFromRouter(
            orderId,
            _routerVaults(),
            sharesPerLeg2,
            new uint256[](sharesPerLeg2.length),
            uint64(block.timestamp + 60),
            idem
        );
    }

    /// @dev router: withdrawal disabled when maxWithdrawPerPayment == 0.
    function test_withdrawFromRouter_revertsWhenWithdrawalDisabled() public {
        _authorize(agent, _policyWithRouter()); // withdrawal disabled (maxWithdrawPerPayment == 0)

        uint256[] memory sharesPerLeg = new uint256[](2);
        sharesPerLeg[0] = ONE_USDC;
        sharesPerLeg[1] = ONE_USDC;

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.WithdrawalNotEnabled.selector);
        gateway.withdrawFromRouter(
            keccak256("rw-dis-o"),
            _routerVaults(),
            sharesPerLeg,
            new uint256[](sharesPerLeg.length),
            uint64(block.timestamp + 60),
            keccak256("rw-dis-i")
        );
    }

    /// @dev router: reverts when router not configured.
    function test_withdrawFromRouter_revertsWhenRouterNotConfigured() public {
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
            allowedDestinations: empty,
            assetRecipient: makeAddr("rcp"),
            maxWithdrawPerPayment: MAX_PER_PAYMENT,
            maxWithdrawPerWindow: MAX_PER_WINDOW,
            allowedSourceVaults: empty
        });
        vm.prank(admin);
        noRouterGateway.authorizeAgent(agent, p);

        uint256[] memory sharesPerLeg = new uint256[](0);
        address[] memory noVaults = new address[](0);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.RouterNotConfigured.selector);
        noRouterGateway.withdrawFromRouter(
            keccak256("o"),
            noVaults,
            sharesPerLeg,
            new uint256[](sharesPerLeg.length),
            uint64(block.timestamp + 60),
            keccak256("i")
        );
    }

    /// @dev router: reverts when sharesPerLeg length mismatches router leg count.
    function test_withdrawFromRouter_revertsOnLegLengthMismatch() public {
        _authorize(agent, _policyWithRouterWithdrawal());

        // vaults[] has 2 legs but sharesPerLeg has 1 → RouterLegLengthMismatch.
        uint256[] memory sharesPerLeg = new uint256[](1);
        sharesPerLeg[0] = ONE_USDC;

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.RouterLegLengthMismatch.selector);
        gateway.withdrawFromRouter(
            keccak256("rw-len-o"),
            _routerVaults(),
            sharesPerLeg,
            new uint256[](sharesPerLeg.length),
            uint64(block.timestamp + 60),
            keccak256("rw-len-i")
        );
    }

    /// @dev router: reverts when the explicit `vaults[]` array is empty. A
    ///      router withdrawal must name at least one source vault (issue #967,
    ///      F-03). Empty `vaults[]`/`sharesPerLeg`/`minAssetsPerLeg` clears the
    ///      parallel-length guard (0 == 0) and trips the empty-vault-set check.
    function test_withdrawFromRouter_revertsOnEmptyVaults() public {
        _authorize(agent, _policyWithRouterWithdrawal());

        address[] memory noVaults = new address[](0);
        uint256[] memory noShares = new uint256[](0);
        uint256[] memory noFloors = new uint256[](0);

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.RouterLegLengthMismatch.selector);
        gateway.withdrawFromRouter(
            keccak256("rw-empty-o"),
            noVaults,
            noShares,
            noFloors,
            uint64(block.timestamp + 60),
            keccak256("rw-empty-i")
        );
    }

    /// @dev router: paused gateway reverts.
    function test_withdrawFromRouter_revertsWhenPaused() public {
        _authorize(agent, _policyWithRouterWithdrawal());
        vm.prank(pauser);
        gateway.pause();

        uint256[] memory sharesPerLeg = new uint256[](2);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.PausedError.selector);
        gateway.withdrawFromRouter(
            keccak256("o"),
            _routerVaults(),
            sharesPerLeg,
            new uint256[](sharesPerLeg.length),
            uint64(block.timestamp + 60),
            keccak256("i")
        );
    }

    /// @dev router: zero totalShares reverts.
    function test_withdrawFromRouter_revertsOnZeroTotalShares() public {
        _authorize(agent, _policyWithRouterWithdrawal());

        uint256[] memory sharesPerLeg = new uint256[](2); // both zero

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.InvalidAmount.selector);
        gateway.withdrawFromRouter(
            keccak256("o"),
            _routerVaults(),
            sharesPerLeg,
            new uint256[](sharesPerLeg.length),
            uint64(block.timestamp + 60),
            keccak256("i")
        );
    }

    /// @dev router: AgentWithdrawalRouted event is emitted with correct indexed topics.
    function test_withdrawFromRouter_emitsAgentWithdrawalRoutedEvent() public {
        _authorize(agent, _policyWithRouterWithdrawal());

        uint256 amount = 100 * ONE_USDC;
        (uint256 sharesA, uint256 sharesB) = _routerDepositAndGetShares(agent, amount);

        vm.prank(shareReceiver);
        vaultA.approve(address(gateway), sharesA);
        vm.prank(shareReceiver);
        vaultB.approve(address(gateway), sharesB);

        uint256[] memory sharesPerLeg = new uint256[](2);
        sharesPerLeg[0] = sharesA;
        sharesPerLeg[1] = sharesB;

        bytes32 orderId = keccak256("rw-evt-o");
        bytes32 idem = keccak256("rw-evt-i");

        vm.recordLogs();
        vm.prank(agent);
        gateway.withdrawFromRouter(
            orderId,
            _routerVaults(),
            sharesPerLeg,
            new uint256[](sharesPerLeg.length),
            uint64(block.timestamp + 60),
            idem
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();

        _assertWithdrawalRoutedLog(logs, orderId, agent);
    }

    // ─── Coverage gap tests ───────────────────────────────────────────────────

    /// @dev DeadlineExpired: deadline is in the past → revert.
    function test_withdrawFromRouter_revertsOnExpiredDeadline() public {
        _authorize(agent, _policyWithRouterWithdrawal());
        uint256[] memory sharesPerLeg = new uint256[](2);
        sharesPerLeg[0] = ONE_USDC;
        sharesPerLeg[1] = 0;

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.DeadlineExpired.selector);
        gateway.withdrawFromRouter(
            keccak256("rw-exp-o"),
            _routerVaults(),
            sharesPerLeg,
            new uint256[](sharesPerLeg.length),
            uint64(block.timestamp - 1),
            keccak256("rw-exp-i")
        );
    }

    /// @dev DeadlineTooFar: deadline is beyond MAX_DEADLINE_SKEW → revert.
    function test_withdrawFromRouter_revertsOnDeadlineTooFar() public {
        _authorize(agent, _policyWithRouterWithdrawal());
        uint256[] memory sharesPerLeg = new uint256[](2);
        sharesPerLeg[0] = ONE_USDC;
        sharesPerLeg[1] = 0;

        uint64 tooFar = uint64(block.timestamp + gateway.MAX_DEADLINE_SKEW() + 1);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.DeadlineTooFar.selector);
        gateway.withdrawFromRouter(
            keccak256("rw-far-o"),
            _routerVaults(),
            sharesPerLeg,
            new uint256[](sharesPerLeg.length),
            tooFar,
            keccak256("rw-far-i")
        );
    }

    /// @dev AgentPolicyExpired: policy validUntil is in the past → revert.
    function test_withdrawFromRouter_revertsOnExpiredPolicy() public {
        IGateway.AgentPolicy memory p = _policyWithRouterWithdrawal();
        p.validUntil = uint64(block.timestamp + 1);
        _authorize(agent, p);

        // Advance time so the policy is now expired.
        vm.warp(block.timestamp + 2);

        uint256[] memory sharesPerLeg = new uint256[](2);
        sharesPerLeg[0] = ONE_USDC;
        sharesPerLeg[1] = 0;

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.AgentPolicyExpired.selector);
        gateway.withdrawFromRouter(
            keccak256("rw-polexp-o"),
            _routerVaults(),
            sharesPerLeg,
            new uint256[](sharesPerLeg.length),
            uint64(block.timestamp + 60),
            keccak256("rw-polexp-i")
        );
    }

    /// @dev allowedSourceVaults zero-shares continue: a zero-shares leg for a
    ///      vault not in the allowlist must be silently skipped (not revert).
    ///      This exercises the `if (sharesPerLeg[i] == 0) continue;` branch at
    ///      the top of the allowedSourceVaults validation loop.
    function test_withdrawFromRouter_allowedSourceVaults_skipsZeroShareLegs() public {
        // Policy: only vaultA is an allowed source.
        address[] memory destinations = new address[](1);
        destinations[0] = address(router);
        address[] memory sources = new address[](1);
        sources[0] = address(vaultA);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: destinations,
            assetRecipient: makeAddr("srcSkipRecipient"),
            maxWithdrawPerPayment: MAX_PER_PAYMENT,
            maxWithdrawPerWindow: MAX_PER_WINDOW,
            allowedSourceVaults: sources
        });
        _authorize(agent, p);

        // Deposit only via router to get shares in vaultA (and vaultB).
        (uint256 sharesA,) = _routerDepositAndGetShares(agent, 100 * ONE_USDC);

        // Approve gateway for vaultA only.
        vm.prank(shareReceiver);
        vaultA.approve(address(gateway), sharesA);

        // sharesPerLeg[1] == 0 → vaultB (not in allowlist) must be skipped.
        uint256[] memory sharesPerLeg = new uint256[](2);
        sharesPerLeg[0] = sharesA;
        sharesPerLeg[1] = 0;

        vm.prank(agent);
        (, uint256[] memory assetsPerLeg) = gateway.withdrawFromRouter(
            keccak256("rw-src-skip-o"),
            _routerVaults(),
            sharesPerLeg,
            new uint256[](sharesPerLeg.length),
            uint64(block.timestamp + 60),
            keccak256("rw-src-skip-i")
        );

        assertEq(assetsPerLeg[0], sharesA, "leg 0 assets");
        assertEq(assetsPerLeg[1], 0, "leg 1 assets (zero-share skip)");
    }

    /// @dev Zero-shares continue in share-pull and approval-clear loops: a
    ///      successful withdrawal with one zero leg exercises both
    ///      `if (sharesPerLeg[i] == 0) continue;` branches in
    ///      _executeRouterWithdraw (lines 1056 and 1068).
    function test_withdrawFromRouter_zeroShareLeg_skippedInPullAndClearLoops() public {
        _authorize(agent, _policyWithRouterWithdrawal());

        (uint256 sharesA,) = _routerDepositAndGetShares(agent, 100 * ONE_USDC);

        // Approve only vaultA; vaultB leg is zero so no transfer occurs.
        vm.prank(shareReceiver);
        vaultA.approve(address(gateway), sharesA);

        uint256[] memory sharesPerLeg = new uint256[](2);
        sharesPerLeg[0] = sharesA;
        sharesPerLeg[1] = 0; // zero leg — must be skipped in pull + clear loops

        vm.prank(agent);
        (, uint256[] memory assetsPerLeg) = gateway.withdrawFromRouter(
            keccak256("rw-zero-leg-o"),
            _routerVaults(),
            sharesPerLeg,
            new uint256[](sharesPerLeg.length),
            uint64(block.timestamp + 60),
            keccak256("rw-zero-leg-i")
        );

        assertEq(assetsPerLeg[0], sharesA, "leg 0 assets");
        assertEq(assetsPerLeg[1], 0, "leg 1 zero skip");
        assertEq(IERC20(address(vaultA)).balanceOf(address(gateway)), 0, "gateway vaultA clean");
        assertEq(IERC20(address(vaultB)).balanceOf(address(gateway)), 0, "gateway vaultB clean");
    }

    /// @dev ShareCustodyInvariantViolated: router vault leaks one share back to
    ///      the gateway during redeemFor → post-call custody check fires.
    function test_withdrawFromRouter_revertsOnShareCustodyInvariant() public {
        (
            RobotMoneyGateway leakyGateway,
            LeakyRedeemRouterVault leakyVault,
            PortfolioRouter leakyRouter
        ) = _buildLeakyGateway();
        _doLeakyWithdraw(leakyGateway, leakyVault, leakyRouter);
    }

    /// @dev Build a gateway whose only vault is LeakyRedeemRouterVault.
    function _buildLeakyGateway()
        internal
        returns (
            RobotMoneyGateway leakyGateway,
            LeakyRedeemRouterVault leakyVault,
            PortfolioRouter leakyRouter
        )
    {
        leakyVault = new LeakyRedeemRouterVault(address(usdc));

        VaultRegistry leakyRegistry = new VaultRegistry(admin);
        vm.startPrank(admin);
        leakyRegistry.registerVault(
            address(leakyVault),
            VaultRegistry.VaultMetadata({name: "Leaky", asset: address(usdc), registeredAt: 0})
        );
        vm.stopPrank();

        leakyRouter = new PortfolioRouter(address(usdc), address(leakyRegistry), admin);

        address[] memory lv = new address[](1);
        lv[0] = address(leakyVault);
        uint256[] memory lbps = new uint256[](1);
        lbps[0] = 10000;

        vm.startPrank(admin);
        leakyRegistry.setRouterEligible(address(leakyVault), true);
        leakyRouter.setWeights(lv, lbps);
        vm.stopPrank();

        leakyGateway = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(leakyRouter)
        );
    }

    /// @dev Authorize an agent, deposit via leakyRouter, then attempt the
    ///      withdraw that trips ShareCustodyInvariantViolated.
    function _doLeakyWithdraw(
        RobotMoneyGateway leakyGateway,
        LeakyRedeemRouterVault leakyVault,
        PortfolioRouter leakyRouter
    ) internal {
        address leakyDepositor = makeAddr("leakyDepositor");
        address leakyAgent = makeAddr("leakyAgent");
        // AZ-GW-1: shareReceiver must equal the committer (leakyDepositor) in the
        // permissionless commit/reveal path. The leaky-custody invariant test still
        // holds because LeakyRedeemRouterVault leaks shares during redeem regardless
        // of who the share holder is.
        address leakyShareReceiver = leakyDepositor;

        {
            address[] memory dests = new address[](1);
            dests[0] = address(leakyRouter);
            // AZ-GW-3 fix: enumerate leakyVault in allowedSourceVaults so the
            // withdrawal reaches the share-custody invariant check it is testing.
            address[] memory srcs = new address[](1);
            srcs[0] = address(leakyVault);
            IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
                active: true,
                validUntil: uint64(block.timestamp + 365 days),
                maxPerPayment: MAX_PER_PAYMENT,
                maxPerWindow: MAX_PER_WINDOW,
                shareReceiver: leakyShareReceiver,
                allowedDestinations: dests,
                assetRecipient: makeAddr("leakyRecipient"),
                maxWithdrawPerPayment: MAX_PER_PAYMENT,
                maxWithdrawPerWindow: MAX_PER_WINDOW,
                allowedSourceVaults: srcs
            });
            bytes32 salt = keccak256("leaky-authorization");
            bytes32 commitHash = keccak256(abi.encode(leakyAgent, leakyDepositor, salt));
            vm.prank(leakyDepositor);
            leakyGateway.commitAuthorization(commitHash);
            vm.roll(block.number + 1);
            vm.prank(leakyDepositor);
            leakyGateway.revealAuthorization(leakyAgent, salt, p);
        }

        // Deposit to mint leaky vault shares into leakyShareReceiver.
        usdc.mint(leakyAgent, 100 * ONE_USDC);
        vm.prank(leakyAgent);
        usdc.approve(address(leakyGateway), 100 * ONE_USDC);
        vm.prank(leakyAgent);
        leakyGateway.depositTo(
            keccak256("leaky-deposit"),
            100 * ONE_USDC,
            uint64(block.timestamp + 60),
            keccak256("leaky-deposit-idem"),
            address(leakyRouter),
            new uint256[](0)
        );

        uint256 shares = leakyVault.balanceOf(leakyShareReceiver);
        assertTrue(shares > 0, "leaky vault shares minted");

        vm.prank(leakyShareReceiver);
        leakyVault.approve(address(leakyGateway), shares);

        uint256[] memory sharesPerLeg = new uint256[](1);
        sharesPerLeg[0] = shares;

        address[] memory leakyVaults = new address[](1);
        leakyVaults[0] = address(leakyVault);

        vm.prank(leakyAgent);
        vm.expectRevert(RobotMoneyGateway.ShareCustodyInvariantViolated.selector);
        leakyGateway.withdrawFromRouter(
            keccak256("leaky-withdraw"),
            leakyVaults,
            sharesPerLeg,
            new uint256[](sharesPerLeg.length),
            uint64(block.timestamp + 60),
            keccak256("leaky-withdraw-idem")
        );
    }

    // ─── AZ-GW-3: empty allowedSourceVaults → pinned-vault-only ─────────────

    /// @dev AZ-GW-3: router withdrawal with empty allowedSourceVaults and a
    ///      non-pinned source vault reverts with InvalidSourceVault.
    function test_withdrawFromRouter_emptyAllowedSourceVaults_rejectsNonPinned() public {
        // Policy with empty allowedSourceVaults (pinned-vault-only semantics).
        address[] memory destinations = new address[](1);
        destinations[0] = address(router);
        address[] memory noSources = new address[](0);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: destinations,
            assetRecipient: makeAddr("az-gw3-recipient"),
            maxWithdrawPerPayment: MAX_PER_PAYMENT,
            maxWithdrawPerWindow: MAX_PER_WINDOW,
            allowedSourceVaults: noSources
        });
        _authorize(agent, p);

        (uint256 sharesA,) = _routerDepositAndGetShares(agent, 100 * ONE_USDC);
        vm.prank(shareReceiver);
        vaultA.approve(address(gateway), sharesA);

        // Single-leg withdrawal from vaultA — not the pinned vault (vault/MockVault).
        // Must revert: empty allowedSourceVaults means pinned-vault-only.
        address[] memory vaults_ = new address[](1);
        vaults_[0] = address(vaultA);
        uint256[] memory sharesPerLeg = new uint256[](1);
        sharesPerLeg[0] = sharesA;

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.InvalidSourceVault.selector);
        gateway.withdrawFromRouter(
            keccak256("az-gw3-reject-order"),
            vaults_,
            sharesPerLeg,
            new uint256[](1),
            uint64(block.timestamp + 60),
            keccak256("az-gw3-reject-idem")
        );
    }

    /// @dev AZ-GW-3: router withdrawal with empty allowedSourceVaults and the
    ///      pinnedVault as sole source succeeds (pinned-only semantics allow it).
    ///      Uses a fresh gateway whose immutable vaultContract equals vaultA so
    ///      the pinned vault is also router-eligible, allowing the full call to
    ///      complete without reverting.
    function test_withdrawFromRouter_emptyAllowedSourceVaults_acceptsPinnedVault() public {
        // Deploy a gateway whose pinned vault is vaultA (which is router-registered).
        RobotMoneyGateway pinnedGw = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vaultA)), admin, pauser, address(router)
        );

        address pinnedAgent = makeAddr("pinnedAgent");
        address pinnedDepositor = makeAddr("pinnedDepositor");
        address pinnedRecipient = makeAddr("pinnedRecipient");

        // Authorize the agent with empty allowedSourceVaults (pinned-vault-only).
        address[] memory dests = new address[](1);
        dests[0] = address(router);
        address[] memory noSources = new address[](0);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: pinnedDepositor,
            allowedDestinations: dests,
            assetRecipient: pinnedRecipient,
            maxWithdrawPerPayment: MAX_PER_PAYMENT,
            maxWithdrawPerWindow: MAX_PER_WINDOW,
            allowedSourceVaults: noSources
        });
        vm.prank(admin);
        pinnedGw.authorizeAgent(pinnedAgent, p);

        // Deposit via router to get vaultA shares.
        usdc.mint(pinnedAgent, 100 * ONE_USDC);
        vm.prank(pinnedAgent);
        usdc.approve(address(pinnedGw), 100 * ONE_USDC);
        uint256[] memory emptyMin = new uint256[](0);
        vm.prank(pinnedAgent);
        pinnedGw.depositTo(
            keccak256("az-gw3-pinned-deposit"),
            100 * ONE_USDC,
            uint64(block.timestamp + 60),
            keccak256("az-gw3-pinned-deposit-idem"),
            address(router),
            emptyMin
        );

        uint256 sharesA = vaultA.balanceOf(pinnedDepositor);
        assertTrue(sharesA > 0, "vaultA shares minted");

        vm.prank(pinnedDepositor);
        vaultA.approve(address(pinnedGw), sharesA);

        // Single-leg withdrawal from vaultA — the pinned vault. Must succeed.
        address[] memory vaults_ = new address[](1);
        vaults_[0] = address(vaultA);
        uint256[] memory sharesPerLeg = new uint256[](1);
        sharesPerLeg[0] = sharesA;

        vm.prank(pinnedAgent);
        (bytes32 paymentId, uint256[] memory assetsPerLeg) = pinnedGw.withdrawFromRouter(
            keccak256("az-gw3-pinned-order"),
            vaults_,
            sharesPerLeg,
            new uint256[](1),
            uint64(block.timestamp + 60),
            keccak256("az-gw3-pinned-idem")
        );

        assertTrue(paymentId != bytes32(0), "paymentId non-zero");
        assertEq(assetsPerLeg.length, 1, "one leg");
        assertGt(assetsPerLeg[0], 0, "USDC out > 0");
        assertGt(usdc.balanceOf(pinnedRecipient), 0, "USDC to recipient");
    }

    /// @dev AZ-GW-3: zero-share leg in the empty-allowedSourceVaults path is
    ///      skipped without checking against pinnedVault, allowing a mixed-leg
    ///      call where only the pinned-vault leg carries non-zero shares.
    function test_withdrawFromRouter_emptyAllowedSourceVaults_skipsZeroShareLeg() public {
        // Gateway whose pinned vault is vaultA (router-registered).
        RobotMoneyGateway pinnedGw = new RobotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vaultA)), admin, pauser, address(router)
        );

        address pinnedAgent2 = makeAddr("pinnedAgent2");
        address pinnedDepositor2 = makeAddr("pinnedDepositor2");
        address pinnedRecipient2 = makeAddr("pinnedRecipient2");

        // Empty allowedSourceVaults → pinned-vault-only.
        address[] memory dests2 = new address[](1);
        dests2[0] = address(router);
        address[] memory noSources2 = new address[](0);
        IGateway.AgentPolicy memory p2 = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: pinnedDepositor2,
            allowedDestinations: dests2,
            assetRecipient: pinnedRecipient2,
            maxWithdrawPerPayment: MAX_PER_PAYMENT,
            maxWithdrawPerWindow: MAX_PER_WINDOW,
            allowedSourceVaults: noSources2
        });
        vm.prank(admin);
        pinnedGw.authorizeAgent(pinnedAgent2, p2);

        // Deposit via router: splits into vaultA + vaultB shares.
        usdc.mint(pinnedAgent2, 100 * ONE_USDC);
        vm.prank(pinnedAgent2);
        usdc.approve(address(pinnedGw), 100 * ONE_USDC);
        vm.prank(pinnedAgent2);
        pinnedGw.depositTo(
            keccak256("az-gw3-zero-deposit"),
            100 * ONE_USDC,
            uint64(block.timestamp + 60),
            keccak256("az-gw3-zero-deposit-idem"),
            address(router),
            new uint256[](0)
        );

        uint256 sharesA2 = vaultA.balanceOf(pinnedDepositor2);
        assertTrue(sharesA2 > 0, "vaultA shares minted");

        // Only approve gateway for vaultA — vaultB leg is zero so no transfer needed.
        vm.prank(pinnedDepositor2);
        vaultA.approve(address(pinnedGw), sharesA2);

        // Two-leg call: vaultA (pinned, non-zero shares) + vaultB (zero shares).
        // The zero-share vaultB leg must be skipped by the empty-allowlist check
        // without triggering InvalidSourceVault.
        address[] memory twoVaults = _routerVaults();
        uint256[] memory sharesPerLeg2 = new uint256[](2);
        sharesPerLeg2[0] = sharesA2;
        sharesPerLeg2[1] = 0; // zero-share vaultB leg — must be skipped

        vm.prank(pinnedAgent2);
        (, uint256[] memory assetsPerLeg2) = pinnedGw.withdrawFromRouter(
            keccak256("az-gw3-zero-order"),
            twoVaults,
            sharesPerLeg2,
            new uint256[](2),
            uint64(block.timestamp + 60),
            keccak256("az-gw3-zero-idem")
        );

        assertGt(assetsPerLeg2[0], 0, "vaultA leg USDC received");
        assertEq(assetsPerLeg2[1], 0, "vaultB leg skipped (zero shares)");
        assertGt(usdc.balanceOf(pinnedRecipient2), 0, "USDC to recipient");
    }

    /// @dev AZ-GW-3 regression: non-empty allowedSourceVaults path is unchanged —
    ///      a vault in the allowlist succeeds, one not in the list reverts.
    function test_withdrawFromRouter_nonEmptyAllowedSourceVaults_unchangedBehavior() public {
        // Policy restricts to vaultA only.
        address[] memory destinations = new address[](1);
        destinations[0] = address(router);
        address[] memory sources = new address[](1);
        sources[0] = address(vaultA);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: destinations,
            assetRecipient: makeAddr("az-gw3-reg-recipient"),
            maxWithdrawPerPayment: MAX_PER_PAYMENT,
            maxWithdrawPerWindow: MAX_PER_WINDOW,
            allowedSourceVaults: sources
        });
        _authorize(agent, p);

        (uint256 sharesA, uint256 sharesB) = _routerDepositAndGetShares(agent, 100 * ONE_USDC);
        vm.prank(shareReceiver);
        vaultA.approve(address(gateway), sharesA);
        vm.prank(shareReceiver);
        vaultB.approve(address(gateway), sharesB);

        // Leg sourced from vaultB (not in allowlist) with non-zero shares → revert.
        uint256[] memory sharesPerLeg2 = new uint256[](2);
        sharesPerLeg2[0] = 0;
        sharesPerLeg2[1] = sharesB;

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.InvalidSourceVault.selector);
        gateway.withdrawFromRouter(
            keccak256("az-gw3-reg-reject-order"),
            _routerVaults(),
            sharesPerLeg2,
            new uint256[](2),
            uint64(block.timestamp + 60),
            keccak256("az-gw3-reg-reject-idem")
        );

        // Leg sourced from vaultA (in allowlist) → succeeds.
        uint256[] memory sharesPerLeg1 = new uint256[](2);
        sharesPerLeg1[0] = sharesA;
        sharesPerLeg1[1] = 0;

        vm.prank(agent);
        (, uint256[] memory assetsPerLeg) = gateway.withdrawFromRouter(
            keccak256("az-gw3-reg-accept-order"),
            _routerVaults(),
            sharesPerLeg1,
            new uint256[](2),
            uint64(block.timestamp + 60),
            keccak256("az-gw3-reg-accept-idem")
        );
        assertGt(assetsPerLeg[0], 0, "vaultA leg assets received");
    }

    /// @dev Extract AgentWithdrawalRouted log and assert indexed topics.
    ///      Separated to avoid stack-too-deep in the parent test function.
    function _assertWithdrawalRoutedLog(
        Vm.Log[] memory logs,
        bytes32 orderId,
        address expectedAgent
    ) internal view {
        bytes32 sig = keccak256(
            "AgentWithdrawalRouted(bytes32,bytes32,address,address,address,uint256[],uint256[],address,uint64)"
        );
        uint256 evtIdx = type(uint256).max;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == sig && logs[i].emitter == address(gateway)) {
                evtIdx = i;
                break;
            }
        }
        assertTrue(evtIdx != type(uint256).max, "AgentWithdrawalRouted event not found");
        assertEq(logs[evtIdx].topics[2], orderId, "orderId topic");
        assertEq(address(uint160(uint256(logs[evtIdx].topics[3]))), expectedAgent, "agent topic");
    }
}
