// SPDX-License-Identifier: MIT
// Canonical: docs/code-review/confused-deputy-access-control-audit-20260602.md
// Covers: issue #569 — defense-in-depth against confused-deputy / caller-supplied-identity
//         execution (SquidRouterModule class)
//
// This file pins the authority invariants enumerated in the audit artifact so
// they cannot silently regress. Every test asserts one named invariant from the
// audit's §5 list, labeled inline.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {AccessRoles} from "../gateway/AccessRoles.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {MockVault} from "../gateway/MockVault.sol";
import {RobotMoneyGateway} from "../gateway/RobotMoneyGateway.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";

// ─── Minimal mock infrastructure ─────────────────────────────────────────────

/// @dev Uniswap V3 pool stub. token0/token1 are set at construction.
///      observe() returns linear tick cumulative (tick rate 0 → 1:1 price).
///      cardinality is settable so addAsset cardinality checks can be tested.
contract MockPoolForGuards {
    address public immutable token0;
    address public immutable token1;
    uint16 public cardinality;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
        cardinality = 100;
    }

    function setCardinality(uint16 c) external {
        cardinality = c;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        // sqrtPriceX96 = 2^96 → tick 0 → 1:1 price
        return (uint160(1 << 96), 0, 0, cardinality, cardinality, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiq)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiq = new uint160[](secondsAgos.length);
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            int56 t =
                int56(int256(uint256(block.timestamp))) - int56(int256(uint256(secondsAgos[i])));
            tickCumulatives[i] = 0 * t; // tick rate 0 → 1:1 price
        }
    }
}

/// @dev Swap router stub. Returns a configurable amountOut and respects
///      amountOutMinimum, reverting when output would be below the floor.
contract MockSwapRouterForGuards is ISwapRouter {
    using SafeERC20 for IERC20;

    uint256 public amountOut;

    error TooLittleReceived(uint256 got, uint256 minimum);

    function setAmountOut(uint256 v) external {
        amountOut = v;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256) {
        if (amountOut < params.amountOutMinimum) {
            revert TooLittleReceived(amountOut, params.amountOutMinimum);
        }
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
        return amountOut;
    }
}

/// @dev Concrete BasketVault harness (BasketVault is abstract).
contract BasketVaultHarnessForGuards is BasketVault {
    constructor(IERC20 usdc_, ISwapRouter swapRouter_, address admin_, address emergency_)
        BasketVault(
            "GuardHarness",
            "gTEST",
            usdc_,
            swapRouter_,
            type(uint256).max,
            type(uint256).max,
            0, // exitFeeBps
            100, // initialSlippageBps (1%)
            admin_, // feeRecipient
            admin_,
            emergency_
        )
    {}

    function maxAssets() public pure override returns (uint256) {
        return 4;
    }
}

// ─── Gateway authority invariant tests ───────────────────────────────────────

/// @title ConfusedDeputyGuardsTest
/// @notice Pins every authority invariant from the confused-deputy audit. Each
///         test name maps to a numbered invariant in the audit artifact §5.
contract ConfusedDeputyGuardsTest is Test {
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant MAX_PER_PAYMENT = 1_000 * ONE_USDC;
    uint256 internal constant MAX_PER_WINDOW = 5_000 * ONE_USDC;

    TestERC20 internal usdc;
    MockVault internal vault;
    RobotMoneyGateway internal gateway;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal depositor = makeAddr("depositor");
    address internal agent = makeAddr("agent");
    address internal otherDepositor = makeAddr("otherDepositor");
    address internal otherAgent = makeAddr("otherAgent");
    address internal shareReceiver = makeAddr("shareReceiver");
    address internal attacker = makeAddr("attacker");
    address internal attackerReceiver = makeAddr("attackerReceiver");

    function setUp() public {
        usdc = new TestERC20();
        vault = new MockVault(address(usdc));
        gateway = new RobotMoneyGateway(
            IERC20(address(usdc)),
            IERC4626(address(vault)),
            admin,
            pauser,
            address(0) // no router
        );
        vm.warp(1_700_000_000);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _policy(address shareReceiver_) internal view returns (IGateway.AgentPolicy memory) {
        address[] memory empty = new address[](0);
        return IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver_,
            allowedDestinations: empty,
            assetRecipient: address(0),
            maxWithdrawPerPayment: 0,
            maxWithdrawPerWindow: 0,
            allowedSourceVaults: empty
        });
    }

    function _authorize(address owner_, address agent_, IGateway.AgentPolicy memory p) internal {
        vm.prank(owner_);
        gateway.authorizeAgent(agent_, p);
    }

    function _fund(address who, uint256 amt) internal {
        usdc.mint(who, amt);
        vm.prank(who);
        usdc.approve(address(gateway), amt);
    }

    // ─── Invariant 1: deposit shareReceiver bound to policy, not calldata ─────

    /// @notice Deposit sends shares to policy.shareReceiver, not to any address
    ///         the agent caller might supply via calldata or other means.
    ///         There is no `recipient` calldata parameter in deposit() — this test
    ///         confirms shares land at the policy-registered receiver even when a
    ///         different EOA is funding the deposit.
    function test_invariant1_deposit_sharesGoToPolicyReceiver() public {
        _authorize(depositor, agent, _policy(shareReceiver));
        _fund(agent, MAX_PER_PAYMENT);

        uint64 deadline = uint64(block.timestamp + 60);
        vm.prank(agent);
        (, uint256 sharesMinted) =
            gateway.deposit(bytes32("order1"), MAX_PER_PAYMENT, deadline, bytes32("idem1"));

        // Shares land at the policy-registered shareReceiver, never at the agent.
        assertEq(vault.balanceOf(shareReceiver), sharesMinted, "shares at policy shareReceiver");
        assertEq(vault.balanceOf(agent), 0, "agent holds no shares");
        assertEq(vault.balanceOf(attacker), 0, "attacker holds no shares");
    }

    // ─── Invariant 2: withdraw assetRecipient bound to policy, not calldata ───

    /// @notice withdraw() forwards USDC only to policy.assetRecipient. There is
    ///         no calldata receiver parameter the agent can supply.
    function test_invariant2_withdraw_assetsGoToPolicyAssetRecipient() public {
        address assetRecipient = makeAddr("assetRecipient");
        address[] memory empty = new address[](0);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: empty,
            assetRecipient: assetRecipient,
            maxWithdrawPerPayment: MAX_PER_PAYMENT,
            maxWithdrawPerWindow: MAX_PER_WINDOW,
            allowedSourceVaults: empty
        });
        _authorize(depositor, agent, p);

        // Deposit first to have shares.
        _fund(agent, MAX_PER_PAYMENT);
        uint64 dl = uint64(block.timestamp + 60);
        vm.prank(agent);
        (, uint256 sharesMinted) =
            gateway.deposit(bytes32("order1"), MAX_PER_PAYMENT, dl, bytes32("idem1"));

        // The gateway's withdraw() pulls shares from the agent (msg.sender) via
        // transferFrom(agent, gateway, shares). The agent must hold the shares.
        // Transfer shares from shareReceiver → agent first, then agent approves gateway.
        vm.prank(shareReceiver);
        vault.transfer(agent, sharesMinted);
        vm.prank(agent);
        vault.approve(address(gateway), sharesMinted);

        // Give the vault USDC to pay out on redeem (shares == USDC in MockVault).
        usdc.mint(address(vault), sharesMinted);

        // Agent calls withdraw — USDC must flow to assetRecipient, not to agent or attacker.
        dl = uint64(block.timestamp + 60);
        vm.prank(agent);
        (, uint256 assetsOut) =
            gateway.withdraw(bytes32("order2"), sharesMinted, address(vault), dl, bytes32("idem2"));

        assertEq(usdc.balanceOf(assetRecipient), assetsOut, "USDC at policy assetRecipient");
        assertEq(usdc.balanceOf(agent), 0, "agent received no USDC");
        assertEq(usdc.balanceOf(attacker), 0, "attacker received no USDC");
    }

    // ─── Invariant 3: depositTo destination whitelist ────────────────────────

    /// @notice depositTo rejects any destination not in policy.allowedDestinations.
    ///         An attacker cannot redirect funds to an arbitrary vault by
    ///         supplying a foreign destination address.
    function test_invariant3_depositTo_rejectsUnlistedDestination() public {
        // Policy allows only the pinned vault.
        address[] memory allowed = new address[](1);
        allowed[0] = address(vault);
        IGateway.AgentPolicy memory p = _policy(shareReceiver);
        p.allowedDestinations = allowed;
        _authorize(depositor, agent, p);
        _fund(agent, MAX_PER_PAYMENT);

        address foreignVault = makeAddr("foreignVault");
        uint256[] memory minShares = new uint256[](0);
        uint64 dl = uint64(block.timestamp + 60);

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.InvalidDestination.selector);
        gateway.depositTo(
            bytes32("order1"), MAX_PER_PAYMENT, dl, bytes32("idem1"), foreignVault, minShares
        );
    }

    // ─── Invariant 4: withdraw sourceVault pinned to gateway vault ────────────

    /// @notice withdraw() rejects any sourceVault != gateway's pinned vault.
    ///         An attacker cannot supply a foreign vault address to bypass
    ///         the asset-redemption rail.
    function test_invariant4_withdraw_rejectsForeignSourceVault() public {
        address[] memory empty = new address[](0);
        IGateway.AgentPolicy memory p = IGateway.AgentPolicy({
            active: true,
            validUntil: uint64(block.timestamp + 365 days),
            maxPerPayment: MAX_PER_PAYMENT,
            maxPerWindow: MAX_PER_WINDOW,
            shareReceiver: shareReceiver,
            allowedDestinations: empty,
            assetRecipient: makeAddr("assetRecipient"),
            maxWithdrawPerPayment: MAX_PER_PAYMENT,
            maxWithdrawPerWindow: MAX_PER_WINDOW,
            allowedSourceVaults: empty
        });
        _authorize(depositor, agent, p);

        address foreignVault = makeAddr("foreignVault");
        uint64 dl = uint64(block.timestamp + 60);

        vm.prank(agent);
        vm.expectRevert(RobotMoneyGateway.InvalidSourceVault.selector);
        gateway.withdraw(bytes32("order1"), 100, foreignVault, dl, bytes32("idem1"));
    }

    // ─── Invariant 5: setPolicy requires msg.sender == agentOwner ─────────────

    /// @notice A third party cannot update another depositor's agent policy.
    ///         setPolicy must revert with NotAgentOwner when the caller is not
    ///         the recorded agentOwner.
    function test_invariant5_setPolicy_requiresAgentOwner() public {
        _authorize(depositor, agent, _policy(shareReceiver));

        // attacker tries to update the policy to redirect shares to attackerReceiver
        vm.prank(attacker);
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.setPolicy(agent, _policy(attackerReceiver));

        // Original policy is intact: the agentOwner is still the depositor (not the attacker),
        // which proves setPolicy did not execute for the attacker.
        assertEq(
            gateway.agentOwner(agent),
            depositor,
            "agentOwner unchanged after failed setPolicy attack"
        );
    }

    // ─── Invariant 6: revokeAgent requires msg.sender == agentOwner ──────────

    /// @notice A third party cannot revoke another depositor's agent.
    function test_invariant6_revokeAgent_requiresAgentOwner() public {
        _authorize(depositor, agent, _policy(shareReceiver));

        vm.prank(attacker);
        vm.expectRevert(RobotMoneyGateway.NotAgentOwner.selector);
        gateway.revokeAgent(agent);

        // Agent's role is still intact.
        assertTrue(gateway.hasRole(gateway.AGENT_ROLE(), agent), "AGENT_ROLE still held");
    }

    // ─── Invariant 7: authorizeAgent rejects double-registration ─────────────

    /// @notice authorizeAgent on an already-owned agent reverts AgentAlreadyOwned.
    ///         A second caller cannot steal ownership of an existing agent.
    function test_invariant7_authorizeAgent_rejectsDoubleRegistration() public {
        _authorize(depositor, agent, _policy(shareReceiver));

        // Another depositor attempts to re-authorize the same agent address to
        // redirect its shareReceiver.
        vm.prank(otherDepositor);
        vm.expectRevert(RobotMoneyGateway.AgentAlreadyOwned.selector);
        gateway.authorizeAgent(agent, _policy(attackerReceiver));

        // Original owner binding is intact.
        assertEq(gateway.agentOwner(agent), depositor, "agentOwner unchanged");
    }

    // ─── Invariant 7b: agentOwner binding is permanent until revoke ──────────

    /// @notice agentOwner[agent] is set to msg.sender at first authorize and
    ///         can only change via the authorizing depositor calling revokeAgent.
    function test_invariant7b_agentOwner_boundToFirstDepositor() public {
        _authorize(depositor, agent, _policy(shareReceiver));

        assertEq(gateway.agentOwner(agent), depositor, "first depositor is owner");

        // The depositor can revoke and allow a fresh authorization.
        vm.prank(depositor);
        gateway.revokeAgent(agent);

        assertEq(gateway.agentOwner(agent), address(0), "owner cleared after revoke");

        // Now a different depositor can authorize the same agent address.
        vm.prank(otherDepositor);
        gateway.authorizeAgent(agent, _policy(shareReceiver));
        assertEq(gateway.agentOwner(agent), otherDepositor, "new owner after re-authorize");
    }
}

// ─── BasketVault pool/token validation and swap slippage tests ─────────────

/// @title BasketVaultSwapGuardsTest
/// @notice Pins invariants 8–10 from the confused-deputy audit.
contract BasketVaultSwapGuardsTest is Test {
    uint256 internal constant ONE_USDC = 1e6;

    TestERC20 internal usdc;
    TestERC20 internal basketToken;
    MockSwapRouterForGuards internal swapRouter;
    MockPoolForGuards internal pool;
    BasketVaultHarnessForGuards internal vault;

    address internal admin = makeAddr("admin");
    address internal emergency = makeAddr("emergency");
    address internal user = makeAddr("user");

    function setUp() public {
        usdc = new TestERC20();
        basketToken = new TestERC20();
        swapRouter = new MockSwapRouterForGuards();
        pool = new MockPoolForGuards(address(basketToken), address(usdc));
        vault = new BasketVaultHarnessForGuards(
            IERC20(address(usdc)), ISwapRouter(address(swapRouter)), admin, emergency
        );

        // Register the valid pool.
        vm.prank(admin);
        vault.addAsset(address(basketToken), address(pool), 500);

        vm.warp(1_700_000_000);
    }

    // ─── Invariant 8: addAsset rejects mismatched pool ────────────────────────

    /// @notice addAsset reverts PoolTokenMismatch when the supplied pool does not
    ///         pair the basket token with USDC. An attacker-controlled pool that
    ///         pairs a worthless token against the basket token cannot be registered.
    function test_invariant8_addAsset_rejectsPoolWithoutUsdcPairing() public {
        TestERC20 wrongToken = new TestERC20();
        TestERC20 anotherToken = new TestERC20();
        // Pool pairs wrongToken/anotherToken — neither is USDC or the new basket token.
        MockPoolForGuards badPool =
            new MockPoolForGuards(address(wrongToken), address(anotherToken));
        TestERC20 newAsset = new TestERC20();

        vm.prank(admin);
        vm.expectRevert(BasketVault.PoolTokenMismatch.selector);
        vault.addAsset(address(newAsset), address(badPool), 500);
    }

    /// @notice addAsset also rejects a pool that pairs the basket token with the
    ///         wrong second token (not USDC). Prevents substituting a worthless
    ///         token for USDC in the value-extraction rail.
    function test_invariant8b_addAsset_rejectsPoolWithWrongSecondToken() public {
        TestERC20 notUsdc = new TestERC20();
        TestERC20 newAsset = new TestERC20();
        // Pool pairs newAsset/notUsdc — newAsset is present but notUsdc is not USDC.
        MockPoolForGuards badPool = new MockPoolForGuards(address(newAsset), address(notUsdc));

        vm.prank(admin);
        vm.expectRevert(BasketVault.PoolTokenMismatch.selector);
        vault.addAsset(address(newAsset), address(badPool), 500);
    }

    /// @notice addAsset rejects a pool with cardinality < MIN_POOL_CARDINALITY (2).
    ///         A cardinality-1 pool would cause observe() to revert with "OLD",
    ///         permanently breaking TWAP reads and thus all deposits/withdrawals.
    function test_invariant8c_addAsset_rejectsLowCardinalityPool() public {
        TestERC20 newAsset = new TestERC20();
        MockPoolForGuards lowCardPool = new MockPoolForGuards(address(newAsset), address(usdc));
        lowCardPool.setCardinality(1); // below MIN_POOL_CARDINALITY=2

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(
                BasketVault.InsufficientPoolCardinality.selector,
                address(lowCardPool),
                uint16(2),
                uint16(1)
            )
        );
        vault.addAsset(address(newAsset), address(lowCardPool), 500);
    }

    // ─── Invariant 9: deposit slippage floor is non-zero ─────────────────────

    /// @notice Every deposit swap sets amountOutMinimum > 0 (derived from TWAP).
    ///         A router that returns 0 tokens must cause the deposit to revert.
    ///         This pins that there is no zero-slippage deposit path.
    function test_invariant9_deposit_slippageFloorIsNonZero() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        usdc.mint(user, depositAmount);

        // Give the swap router enough basket tokens to cover a successful swap.
        uint256 expectedBasketOut = 990 * ONE_USDC; // TWAP 1:1, 1% slippage → floor ~990
        basketToken.mint(address(swapRouter), expectedBasketOut);
        swapRouter.setAmountOut(expectedBasketOut);

        vm.prank(user);
        usdc.approve(address(vault), depositAmount);

        // Should succeed — router output ≥ TWAP floor.
        vm.prank(user);
        vault.deposit(depositAmount, user);

        assertEq(basketToken.balanceOf(address(vault)), expectedBasketOut, "basket received");
    }

    /// @notice When the router would return 0 tokens (zero amountOut), the deposit
    ///         must revert because amountOutMinimum from the TWAP is > 0.
    function test_invariant9b_deposit_revertsWhenRouterOutputIsZero() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        usdc.mint(user, depositAmount);
        // Router returns 0 — below the TWAP-derived floor.
        swapRouter.setAmountOut(0);

        vm.prank(user);
        usdc.approve(address(vault), depositAmount);

        // Deposit must revert because minOut > 0.
        vm.prank(user);
        vm.expectRevert();
        vault.deposit(depositAmount, user);
    }

    // ─── Invariant 10: withdrawal slippage floor is non-zero ─────────────────

    /// @notice Every withdrawal swap sets amountOutMinimum > 0 (from TWAP).
    ///         A router returning 0 must revert the redeem.
    function test_invariant10_withdraw_slippageFloorIsNonZero() public {
        // First deposit to obtain shares.
        uint256 depositAmount = 1_000 * ONE_USDC;
        uint256 basketOut = 990 * ONE_USDC;
        usdc.mint(user, depositAmount);
        basketToken.mint(address(swapRouter), basketOut);
        swapRouter.setAmountOut(basketOut);

        vm.prank(user);
        usdc.approve(address(vault), depositAmount);
        vm.prank(user);
        uint256 shares = vault.deposit(depositAmount, user);

        // Now attempt to redeem with router returning 0 USDC — should revert.
        swapRouter.setAmountOut(0);

        vm.prank(user);
        vm.expectRevert();
        vault.redeem(shares, user, user);
    }

    /// @notice Withdrawal succeeds when router output satisfies the TWAP-derived
    ///         floor, confirming the floor calculation is correct at non-zero levels.
    function test_invariant10b_withdraw_succeedsAboveTwapFloor() public {
        uint256 depositAmount = 1_000 * ONE_USDC;
        uint256 basketOut = 990 * ONE_USDC;
        usdc.mint(user, depositAmount);
        basketToken.mint(address(swapRouter), basketOut);
        swapRouter.setAmountOut(basketOut);

        vm.prank(user);
        usdc.approve(address(vault), depositAmount);
        vm.prank(user);
        uint256 shares = vault.deposit(depositAmount, user);

        // Redeem: router returns 990 USDC for 990 basket tokens.
        // TWAP floor: 990 basket * 9900 / 10000 = ~980.1. 990 ≥ floor → success.
        uint256 usdcOut = 990 * ONE_USDC;
        usdc.mint(address(swapRouter), usdcOut);
        swapRouter.setAmountOut(usdcOut);

        vm.prank(user);
        uint256 assetsReceived = vault.redeem(shares, user, user);

        assertGt(assetsReceived, 0, "assets received on redeem");
        assertEq(usdc.balanceOf(user), assetsReceived, "USDC at redeemer");
    }
}

// ─── PortfolioRouter runtime eligibility re-check test ───────────────────────

/// @title PortfolioRouterRuntimeEligibilityTest
/// @notice Pins invariant 11: a vault that became ineligible after being weighted
///         cannot receive USDC at deposit time (runtime re-check via
///         _requireRouterEligible inside _executeLegs).
contract PortfolioRouterRuntimeEligibilityTest is Test {
    uint256 internal constant ONE_USDC = 1e6;

    TestERC20 internal usdc;
    VaultRegistry internal registry;
    PortfolioRouter internal router;
    MockVault internal vaultA;

    address internal admin = makeAddr("admin");
    address internal depositor = makeAddr("depositor");

    function setUp() public {
        usdc = new TestERC20();
        registry = new VaultRegistry(admin);
        router = new PortfolioRouter(address(usdc), address(registry), admin);

        vaultA = new MockVault(address(usdc));

        // Register vaultA in the registry.
        vm.startPrank(admin);
        VaultRegistry.VaultMetadata memory meta =
            VaultRegistry.VaultMetadata({name: "VaultA", asset: address(usdc), registeredAt: 0});
        registry.registerVault(address(vaultA), meta);
        registry.setRouterEligible(address(vaultA), true);

        // Set single-vault weights (100%).
        address[] memory vaults = new address[](1);
        vaults[0] = address(vaultA);
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;
        router.setWeights(vaults, bps);
        vm.stopPrank();
    }

    // ─── Invariant 11: runtime eligibility re-check at deposit time ───────────

    /// @notice A vault that loses router-eligibility after being weighted must
    ///         not receive USDC at deposit time. _requireRouterEligible is called
    ///         inside _executeLegs on every leg, blocking ineligible vaults even
    ///         when they are still in the weight vector.
    function test_invariant11_deposit_revertsIfVaultLosesEligibilityAfterWeighting() public {
        uint256 amount = 1_000 * ONE_USDC;
        usdc.mint(depositor, amount);

        // Confirm deposit succeeds while eligible.
        vm.prank(depositor);
        usdc.approve(address(router), amount);
        uint256[] memory minShares = new uint256[](0);
        vm.prank(depositor);
        router.deposit(amount, minShares);

        // Now revoke eligibility — but the weight vector still lists vaultA.
        // The registry guard on setRouterEligible blocks changes when a non-empty
        // default vector is linked; here the router has no linked registry ref,
        // so we can flip the flag directly.
        vm.prank(admin);
        registry.setRouterEligible(address(vaultA), false);

        // Subsequent deposit must revert at runtime eligibility check.
        usdc.mint(depositor, amount);
        vm.prank(depositor);
        usdc.approve(address(router), amount);
        vm.prank(depositor);
        vm.expectRevert(
            abi.encodeWithSelector(PortfolioRouter.VaultNotRouterEligible.selector, address(vaultA))
        );
        router.deposit(amount, minShares);
    }

    /// @notice setWeights rejects a vault that is not router-eligible, preventing
    ///         ineligible vaults from ever entering the weight vector in the first
    ///         place (configuration-time check complements the runtime check).
    function test_invariant11b_setWeights_rejectsIneligibleVault() public {
        MockVault vaultB = new MockVault(address(usdc));

        // Register but do NOT mark router-eligible.
        vm.startPrank(admin);
        VaultRegistry.VaultMetadata memory meta =
            VaultRegistry.VaultMetadata({name: "VaultB", asset: address(usdc), registeredAt: 0});
        registry.registerVault(address(vaultB), meta);
        vm.stopPrank();

        address[] memory vaults = new address[](1);
        vaults[0] = address(vaultB);
        uint256[] memory bps = new uint256[](1);
        bps[0] = 10_000;

        vm.prank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(PortfolioRouter.VaultNotRouterEligible.selector, address(vaultB))
        );
        router.setWeights(vaults, bps);
    }
}
