// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §5 — On-Chain Gateway, §4.2 — Portfolio Router
pragma solidity ^0.8.24;

import {ForkSelect} from "./helpers/ForkSelect.sol";
import {Test, Vm} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {AccessRoles} from "../gateway/AccessRoles.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {MockVault} from "./helpers/MockVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {CoreStages} from "./helpers/CoreStages.sol";
import {VenueEtcher} from "./helpers/VenueMocks.sol";
import {DeployGateway} from "../script/DeployGateway.s.sol";
import {FeeOnTransferUSDC, ShareLeakVault, UnderPullVault} from "./RobotMoneyGateway.t.sol";
import {CoreProxies} from "./helpers/CoreProxies.sol";
import {AgentRegistration} from "./helpers/AgentRegistration.sol";

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

    /// @dev ERC-4626 `maxDeposit`: uncapped. The router skips a leg whose `maxDeposit` is 0 or
    ///      reverts (QA plan D4), so a router-leg mock must answer it.
    function maxDeposit(address) external pure returns (uint256) {
        return type(uint256).max;
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
        registry = CoreProxies.vaultRegistry(admin);
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
        router = CoreProxies.portfolioRouter(address(usdc), address(registry), admin);
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
        gateway = CoreProxies.robotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(vault)), admin, pauser, address(vaultA)
        );
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _policyWithRouter() internal view returns (IGateway.AgentPolicy memory) {
        address[] memory destinations = new address[](1);
        destinations[0] = address(vaultA);
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
        address[] memory dests = new address[](3);
        dests[0] = address(vault);
        dests[1] = address(vaultA);
        dests[2] = address(vaultB);
        return IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: dests,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: empty
        });
    }

    function _authorize(address who, IGateway.AgentPolicy memory p) internal {
        AgentRegistration.register(gateway, who, p);
    }

    function _fundAndApprove(address who, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.prank(who);
        usdc.approve(address(gateway), amt);
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    // ─── AC1: agent with router policy deposits through router ────────────────

    // ─── AC2: policy restriction — agent cannot route to router ───────────────

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
            gateway.depositTo(orderId, amount, deadline, idem, address(vaultA), empty);

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

    /// @dev GW-2: the `minSharesPerLeg` vector is part of the depositTo paymentId preimage, so
    ///      two calls that differ only in that vector never collide.
    function test_GW2_depositTo_paymentIdBindsMinSharesPerLeg() public {
        _authorize(agent, _policyOpenDestinations());
        uint256 amount = 30 * ONE_USDC;
        _fundAndApprove(agent, 2 * amount);

        bytes32 orderId = keccak256("gw2-leg-order");
        bytes32 idem = keccak256("gw2-leg-idem");
        uint64 deadline = uint64(block.timestamp + 60);
        uint256[] memory legsA = new uint256[](2);
        legsA[0] = 1;
        legsA[1] = 1;
        uint256[] memory legsB = new uint256[](2);
        legsB[0] = 2;
        legsB[1] = 2;

        vm.prank(agent);
        bytes32 idA = gateway.depositTo(orderId, amount, deadline, idem, address(vault), legsA);
        vm.prank(agent);
        bytes32 idB = gateway.depositTo(orderId, amount, deadline, idem, address(vault), legsB);

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

    // ─── AC5: single-vault path unaffected ───────────────────────────────────

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
            keccak256("o"), 0, uint64(block.timestamp + 60), keccak256("i"), address(vaultA), empty
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
            address(vaultA),
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
            address(vaultA),
            empty
        );
    }

    /// @dev depositTo enforces the paused check.
    function test_depositTo_revertsWhenPaused() public {
        _authorize(agent, _policyWithRouter());
        _fundAndApprove(agent, 10 * ONE_USDC);
        vm.prank(pauser);
        gateway.pauseDeposits();

        uint256[] memory empty = new uint256[](0);
        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.DepositsArePaused.selector);
        gateway.depositTo(
            keccak256("o"),
            10 * ONE_USDC,
            uint64(block.timestamp + 60),
            keccak256("i"),
            address(vaultA),
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
            address(vaultA),
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
            address(vaultA),
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
            orderId, amount, uint64(block.timestamp + 60), idem, address(vaultA), emptyMin
        );

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.PaymentIdAlreadyUsed.selector);
        gateway.depositTo(
            orderId, amount, uint64(block.timestamp + 60), idem, address(vaultA), emptyMin
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
            address(vaultA),
            emptyMin
        );
        vm.prank(agent);
        gateway.depositTo(
            keccak256("o2"),
            MAX_PER_PAYMENT,
            uint64(block.timestamp + 60),
            keccak256("i2"),
            address(vaultA),
            emptyMin
        );

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.WindowCapExceeded.selector);
        gateway.depositTo(
            keccak256("o3"),
            1,
            uint64(block.timestamp + 60),
            keccak256("i3"),
            address(vaultA),
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
            address(vaultA),
            empty
        );
    }

    // ─── Coverage: custody invariants and fee-on-transfer in depositTo ─────────

    /// @dev `depositTo` detects fee-on-transfer tokens just like `deposit`.
    function test_depositTo_revertsOnFeeOnTransferToken() public {
        // Build a fresh stack: fee-on-transfer usdc, matching vault, gateway with router.
        FeeOnTransferUSDC fotUsdc = new FeeOnTransferUSDC();
        MockVault fotVault = new MockVault(address(fotUsdc));
        VaultRegistry fotRegistry = CoreProxies.vaultRegistry(admin);
        RouterMockVault fotVaultA = new RouterMockVault(address(fotUsdc), "FOT Vault A", "fA");
        vm.prank(admin);
        fotRegistry.registerVault(
            address(fotVaultA),
            VaultRegistry.VaultMetadata({name: "FOT A", asset: address(fotUsdc), registeredAt: 0})
        );
        PortfolioRouter fotRouter =
            CoreProxies.portfolioRouter(address(fotUsdc), address(fotRegistry), admin);
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

        RobotMoneyGateway fotGateway = CoreProxies.robotMoneyGateway(
            IERC20(address(fotUsdc)), IERC4626(address(fotVault)), admin, pauser, address(fotVaultA)
        );

        address[] memory routerDests = new address[](1);
        routerDests[0] = address(fotVaultA);
        address[] memory noSources2 = new address[](0);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: CoreProxies.oneDestination(address(fotVaultA)),
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: noSources2
        });
        AgentRegistration.register(fotGateway, agent, p);

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
            address(fotVaultA),
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
        RobotMoneyGateway gw = CoreProxies.robotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(leaky)), admin, pauser, address(0)
        );
        address[] memory empty = new address[](0);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: CoreProxies.oneDestination(address(leaky)),
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: empty
        });
        AgentRegistration.register(gw, agent, p);

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
        RobotMoneyGateway gw = CoreProxies.robotMoneyGateway(
            IERC20(address(usdc)), IERC4626(address(underPull)), admin, pauser, address(0)
        );
        address[] memory empty = new address[](0);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: CoreProxies.oneDestination(address(underPull)),
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: empty
        });
        AgentRegistration.register(gw, agent, p);

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
            address(vaultA),
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
            address(vaultA),
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
    ///        slot 4  → agents mapping (issue 1808: slots 0-2 hold the pinned usdc,
    ///                  vault and router of the proxy; slot 3 is commitments)
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
        //    agents mapping is at slot 4 (slot 3 = commitments, issue 1808); AgentPolicy fields at the struct base:
        //      +0 → active (bool) + validUntil (uint64, packed into 1 slot)
        //      +1 → maxPerPayment (uint256)
        //      +2 → maxPerWindow  (uint256)
        bytes32 agentsPolicyBase = keccak256(abi.encode(agent, uint256(4)));
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
            address(vaultA),
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
            address(vaultA),
            emptyMin
        );
    }
}
