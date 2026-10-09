// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0001-mvp-agent-token-shortlist.md;
//            docs/adr/ADR-0004-agent-token-shortlist-governance.md;
//            docs/prd.md §11.3 — Agent Token Vault
// Covers issue #481 — seed AgentTokenVault with the canonical MVP six-token
//                      shortlist (equal-weight, admin-curated, Base-only).
// Covers issue #552 — shortlist governance mechanism: timelock + veto window,
//                      addAsset oracle/liquidity gate, unauthorized rejection.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {AgentTokenVault} from "../vaults/AgentTokenVault.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {TestERC20} from "./helpers/TestERC20.sol";
import {SafeGovernance} from "./helpers/SafeGovernance.sol";

/// @dev Uniswap V3 pool mock: token0/token1 reads for addAsset validation plus
///      a flat 1:1 TWAP via observe() (arithmetic-mean tick = 0). One unit of
///      basket token is worth one unit of USDC, which makes equal-weight
///      assertions exact and independent of slot0.
///      setCardinality() allows governance gate-rejection tests to simulate
///      a pool that has not yet grown its observation buffer.
contract MockPool {
    address public immutable token0;
    address public immutable token1;
    uint16 public cardinality = 1000;
    uint128 public poolLiquidity = 1e18; // large default so all existing tests pass unmodified
    uint24 public feeTier; // fee() read by addAsset's ORA-3 equality check

    constructor(address token0_, address token1_, uint24 fee_) {
        token0 = token0_;
        token1 = token1_;
        feeTier = fee_;
    }

    /// @dev ORA-3 / F-09: `addAsset` asserts the pool's `fee()` equals `swapFee_`.
    function fee() external view returns (uint24) {
        return feeTier;
    }

    function setFee(uint24 fee_) external {
        feeTier = fee_;
    }

    function liquidity() external view returns (uint128) {
        return poolLiquidity;
    }

    function setCardinality(uint16 c) external {
        cardinality = c;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (uint160(1 << 96), 0, 0, cardinality, cardinality, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        pure
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiq)
    {
        // tickCumulativeRate = 0 -> arithmetic-mean tick = 0 -> price 1:1.
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiq = new uint160[](secondsAgos.length);
    }

    function observations(uint256) external view returns (uint32, int56, uint160, bool) {
        return (uint32(block.timestamp), 0, 0, true);
    }
}

/// @dev Swap router mock that records the USDC `amountIn` of every USDC->token
///      deposit swap, keyed by output token, so equal-weight allocation can be
///      asserted directly. Returns `amountIn` 1:1 to the recipient.
contract RecordingSwapRouter is ISwapRouter {
    using SafeERC20 for IERC20;

    mapping(address => uint256) public usdcInForToken;

    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256) {
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        usdcInForToken[params.tokenOut] += params.amountIn;
        // 1:1 conversion; mint-free because the pool TWAP is 1:1 and the test
        // pre-funds this router with the output tokens.
        TestERC20(params.tokenOut).mint(params.recipient, params.amountIn);
        return params.amountIn;
    }
}

contract AgentTokenVaultTest is Test {
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant N = 6;

    string[6] internal SYMBOLS = ["JUNO", "RM", "BANKR", "ZYFAI", "GIZA", "DEUS"];

    TestERC20 internal usdc;
    RecordingSwapRouter internal router;
    AgentTokenVault internal vault;
    TestERC20[6] internal tokens;

    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        usdc = new TestERC20();
        router = new RecordingSwapRouter();
        vault = new AgentTokenVault(
            IERC20(address(usdc)),
            ISwapRouter(address(router)),
            10_000_000 * ONE_USDC,
            1_000_000 * ONE_USDC,
            0,
            admin,
            admin,
            admin
        );
        _seedSixTokenShortlist();
    }

    /// @dev Seed the vault with the six MVP tokens, in canonical order, each
    ///      paired with USDC via a 1:1 mock pool — mirrors the deploy seed.
    function _seedSixTokenShortlist() internal {
        for (uint256 i = 0; i < N; i++) {
            tokens[i] = new TestERC20();
            MockPool pool = new MockPool(address(tokens[i]), address(usdc), 10_000);
            vm.prank(admin);
            vault.addAsset(
                address(tokens[i]), address(pool), 10_000, address(0), BasketVault.Venue.V3
            );
        }
    }

    function test_shortlist_seeded_with_six_mvp_tokens() public view {
        (address[] memory t,,,,) = vault.shortlist();
        assertEq(t.length, N, "shortlist holds exactly six MVP tokens");
        for (uint256 i = 0; i < N; i++) {
            assertEq(t[i], address(tokens[i]), "shortlist entry present");
        }
    }

    function test_shortlist_ordering_matches_config() public view {
        // Ordering is load-bearing: the dapp renders shortlist() in array order,
        // which must equal the ADR-0001 / config order (JUNO, RM, ...).
        (address[] memory t,,,,) = vault.shortlist();
        for (uint256 i = 0; i < N; i++) {
            assertEq(t[i], address(tokens[i]), "shortlist ordering matches seed/config order");
        }
    }

    function test_equal_weight_allocation_across_six_tokens() public {
        // 600 USDC across six assets => each leg swaps exactly 100 USDC.
        uint256 deposit = 600 * ONE_USDC;
        usdc.mint(address(this), deposit);
        usdc.approve(address(vault), deposit);
        vault.deposit(deposit, address(this));

        uint256 expectedPerLeg = deposit / N;
        for (uint256 i = 0; i < N; i++) {
            assertEq(
                router.usdcInForToken(address(tokens[i])),
                expectedPerLeg,
                "each shortlist token receives an equal USDC slice at deposit"
            );
        }
    }

    function test_shortlist_mutation_admin_only() public {
        // ADMIN_ROLE may swap a shortlist entry: remove then add.
        TestERC20 replacement = new TestERC20();
        MockPool pool = new MockPool(address(replacement), address(usdc), 10_000);

        vm.prank(admin);
        vault.removeAsset(0); // deactivate JUNO slot (vault holds zero)

        vm.prank(admin);
        vault.addAsset(
            address(replacement), address(pool), 10_000, address(0), BasketVault.Venue.V3
        );

        (address[] memory t,,, bool[] memory active,) = vault.shortlist();
        assertEq(t.length, N + 1, "swap adds a new entry");
        assertFalse(active[0], "removed entry deactivated");
        assertTrue(active[N], "replacement entry active");
        assertEq(t[N], address(replacement), "replacement appended");
    }

    function test_shortlist_mutation_rejected_for_non_admin() public {
        TestERC20 newToken = new TestERC20();
        MockPool pool = new MockPool(address(newToken), address(usdc), 10_000);

        bytes32 adminRole = vault.ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", stranger, adminRole
            )
        );
        vm.prank(stranger);
        vault.addAsset(address(newToken), address(pool), 10_000, address(0), BasketVault.Venue.V3);

        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", stranger, adminRole
            )
        );
        vm.prank(stranger);
        vault.removeAsset(0);
    }

    // ─── Governance constants ──────────────────────────────────────────────

    function test_governance_shortlist_add_delay_is_48h() public view {
        assertEq(vault.SHORTLIST_ADD_DELAY(), 48 hours, "addAsset delay must be 48h per ADR-0004");
    }

    function test_governance_shortlist_remove_delay_is_24h() public view {
        assertEq(
            vault.SHORTLIST_REMOVE_DELAY(), 24 hours, "removeAsset delay must be 24h per ADR-0004"
        );
    }
}

// ─── Governance tests (issue #552 / ADR-0004) ─────────────────────────────────
//
// These tests verify that the production shortlist governance mechanism works
// correctly: shortlist changes must flow through a TimelockController that holds
// ADMIN_ROLE, with mandatory delays and a veto (cancel) path.
//
// The test mirrors the production deployment model:
//   Safe (only proposer, only canceller) → TimelockController (ADMIN_ROLE holder) → AgentTokenVault
//
// Every governed call runs through a real two-signature SafeL2 execTransaction
// (helpers/SafeGovernance.sol). No test pranks the Safe (issue #1644).
//
// Tests cover:
//   - Governed addAsset: timelock-routed, executes after SHORTLIST_ADD_DELAY
//   - Governed removeAsset: timelock-routed, executes after SHORTLIST_REMOVE_DELAY
//   - Pre-delay execution reverts (timelock enforces minimum delay)
//   - Veto: any canceller may cancel a queued shortlist change before execution
//   - Unauthorized rejection: non-admin direct calls revert with AccessControl error

contract AgentTokenVaultGovernanceTest is SafeGovernance {
    uint256 internal constant ONE_USDC = 1e6;

    // Governance timing per ADR-0004.
    uint256 internal constant ADD_DELAY = 48 hours;
    uint256 internal constant REMOVE_DELAY = 24 hours;

    TestERC20 internal usdc;
    RecordingSwapRouter internal router;
    AgentTokenVault internal vault;

    // TimelockController holds ADMIN_ROLE on vault (production model).
    TimelockController internal timelock;

    // A real SafeL2 1.4.1 proxy (SafeFixture) acts as the Safe multisig. It is the ONLY
    // proposer and so the ONLY canceller (issue #1521, security-model.md line 89).
    address internal safe;
    // A Safe owner key acting alone, outside the Safe: it holds no timelock role.
    address internal signer = makeAddr("safe-owner-1");
    address internal stranger = makeAddr("stranger");

    // Two pre-seeded tokens so removeAsset tests have a real asset to remove.
    TestERC20 internal tokenA;
    TestERC20 internal tokenB;
    MockPool internal poolA;
    MockPool internal poolB;

    function setUp() public {
        usdc = new TestERC20();
        router = new RecordingSwapRouter();

        // Deploy the vault with a temporary admin (this contract) so we can
        // transfer ADMIN_ROLE to the timelock during setUp.
        vault = new AgentTokenVault(
            IERC20(address(usdc)),
            ISwapRouter(address(router)),
            10_000_000 * ONE_USDC,
            1_000_000 * ONE_USDC,
            0,
            address(this), // feeRecipient
            address(this), // admin (temporary — transferred to timelock below)
            address(this) // emergencyResponder
        );

        // Seed two tokens so there is a basket to manipulate in governance tests.
        tokenA = new TestERC20();
        tokenB = new TestERC20();
        poolA = new MockPool(address(tokenA), address(usdc), 3000);
        poolB = new MockPool(address(tokenB), address(usdc), 3000);
        vault.addAsset(address(tokenA), address(poolA), 3000, address(0), BasketVault.Venue.V3);
        vault.addAsset(address(tokenB), address(poolB), 3000, address(0), BasketVault.Venue.V3);

        _installSafeSet();
        safe = _newDefaultSafe();
        // Production shape: the Safe is the only proposer and canceller, EXECUTOR_ROLE is open.
        timelock = _newGovTimelock(safe, ADD_DELAY);

        // Transfer ADMIN_ROLE from this contract to the timelock.
        vault.grantRole(vault.ADMIN_ROLE(), address(timelock));
        vault.revokeRole(vault.ADMIN_ROLE(), address(this));

        // Verify the timelock now holds ADMIN_ROLE and this contract does not.
        assertTrue(
            vault.hasRole(vault.ADMIN_ROLE(), address(timelock)), "timelock must hold ADMIN_ROLE"
        );
        assertFalse(
            vault.hasRole(vault.ADMIN_ROLE(), address(this)), "deployer must not hold ADMIN_ROLE"
        );
    }

    // ─── Helper: schedule and execute an addAsset through the timelock ────────

    function _scheduleAddAsset(address token_, address pool_, uint24 fee_, bytes32 salt_)
        internal
        returns (bytes32 opId)
    {
        bytes memory callData = abi.encodeCall(
            BasketVault.addAsset, (token_, pool_, fee_, address(0), BasketVault.Venue.V3)
        );
        opId = _govSchedule(safe, timelock, address(vault), callData, salt_, ADD_DELAY);
    }

    function _executeAddAsset(address token_, address pool_, uint24 fee_, bytes32 salt_) internal {
        bytes memory callData = abi.encodeCall(
            BasketVault.addAsset, (token_, pool_, fee_, address(0), BasketVault.Venue.V3)
        );
        _govExecute(safe, timelock, address(vault), callData, salt_);
    }

    // ─── Helper: schedule and execute a removeAsset through the timelock ──────

    function _scheduleRemoveAsset(uint256 index_, bytes32 salt_) internal returns (bytes32 opId) {
        bytes memory callData = abi.encodeCall(BasketVault.removeAsset, (index_));
        // removeAsset needs only REMOVE_DELAY but the timelock minimum is ADD_DELAY,
        // so we schedule with ADD_DELAY (the timelock won't accept less than its minimum).
        opId = _govSchedule(safe, timelock, address(vault), callData, salt_, ADD_DELAY);
    }

    function _executeRemoveAsset(uint256 index_, bytes32 salt_) internal {
        bytes memory callData = abi.encodeCall(BasketVault.removeAsset, (index_));
        _govExecute(safe, timelock, address(vault), callData, salt_);
    }

    // ─── Governance: addAsset via timelock executes after delay ──────────────

    /// @notice A timelock-routed addAsset queued with the Safe proposer and
    ///         executed after SHORTLIST_ADD_DELAY successfully adds the token.
    function test_governance_timelocked_addAsset_executes_after_delay() public {
        TestERC20 newToken = new TestERC20();
        MockPool newPool = new MockPool(address(newToken), address(usdc), 3000);

        bytes32 salt = keccak256("add-asset-salt-1");
        bytes32 opId = _scheduleAddAsset(address(newToken), address(newPool), 3000, salt);

        // Pre-delay: operation is Waiting — execute must revert.
        assertEq(
            uint256(timelock.getOperationState(opId)),
            uint256(TimelockController.OperationState.Waiting),
            "expected Waiting state before delay"
        );
        _expectExecuteRefused(
            safe,
            timelock,
            address(vault),
            abi.encodeCall(
                BasketVault.addAsset,
                (address(newToken), address(newPool), 3000, address(0), BasketVault.Venue.V3)
            ),
            salt
        );

        // Advance past ADD_DELAY.
        vm.warp(block.timestamp + ADD_DELAY + 1);

        assertEq(
            uint256(timelock.getOperationState(opId)),
            uint256(TimelockController.OperationState.Ready),
            "expected Ready state after delay"
        );

        _executeAddAsset(address(newToken), address(newPool), 3000, salt);

        // Verify token is now in the shortlist.
        (address[] memory tokens,,, bool[] memory active,) = vault.shortlist();
        assertEq(tokens.length, 3, "shortlist should have three entries after addAsset");
        assertEq(tokens[2], address(newToken), "new token appended to shortlist");
        assertTrue(active[2], "new token is active");

        assertEq(
            uint256(timelock.getOperationState(opId)),
            uint256(TimelockController.OperationState.Done),
            "operation must be Done after execution"
        );

        // Replay of the executed operation: exact reasons on both paths.
        _expectExecuteRefused(
            safe,
            timelock,
            address(vault),
            abi.encodeCall(
                BasketVault.addAsset,
                (address(newToken), address(newPool), 3000, address(0), BasketVault.Venue.V3)
            ),
            salt
        );
    }

    // ─── Governance: removeAsset via timelock executes after delay ────────────

    /// @notice A timelock-routed removeAsset queued and executed after the delay
    ///         deactivates the token. Vault must hold zero of the token to remove.
    function test_governance_timelocked_removeAsset_executes_after_delay() public {
        // tokenA is at index 0 and vault holds none (no deposit made).
        bytes32 salt = keccak256("remove-asset-salt-1");
        bytes32 opId = _scheduleRemoveAsset(0, salt);

        // Pre-delay execute reverts.
        _expectExecuteRefused(
            safe, timelock, address(vault), abi.encodeCall(BasketVault.removeAsset, (0)), salt
        );

        vm.warp(block.timestamp + ADD_DELAY + 1);

        _executeRemoveAsset(0, salt);

        (,,, bool[] memory active,) = vault.shortlist();
        assertFalse(active[0], "tokenA should be deactivated after timelock removeAsset");
        assertTrue(active[1], "tokenB should remain active");

        assertEq(
            uint256(timelock.getOperationState(opId)),
            uint256(TimelockController.OperationState.Done),
            "removeAsset operation must be Done"
        );
    }

    // ─── Governance: veto (cancel) stops queued shortlist change ─────────────

    /// @notice Any canceller may cancel a queued addAsset before execution.
    ///         After cancellation the operation cannot be executed.
    function test_governance_veto_cancels_pending_addAsset() public {
        TestERC20 newToken = new TestERC20();
        MockPool newPool = new MockPool(address(newToken), address(usdc), 3000);

        bytes32 salt = keccak256("veto-add-salt-1");
        bytes32 opId = _scheduleAddAsset(address(newToken), address(newPool), 3000, salt);

        assertEq(
            uint256(timelock.getOperationState(opId)),
            uint256(TimelockController.OperationState.Waiting),
            "must be Waiting before veto"
        );

        // A Safe owner acting alone holds no CANCELLER_ROLE: the veto is a Safe quorum act.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                signer,
                timelock.CANCELLER_ROLE()
            )
        );
        vm.prank(signer);
        timelock.cancel(opId);

        // One owner signature is below the 2-of-3 threshold: the Safe refuses (GS020).
        bytes memory cancelCall = abi.encodeCall(timelock.cancel, (opId));
        bytes memory oneSig = _oneOwnerSignature(_safeDigest(safe, address(timelock), cancelCall));
        vm.expectRevert(bytes("GS020"));
        _safeExecWith(safe, address(timelock), cancelCall, oneSig);

        // The Safe, with two signatures, exercises the veto.
        _govCancel(safe, timelock, opId);

        assertEq(
            uint256(timelock.getOperationState(opId)),
            uint256(TimelockController.OperationState.Unset),
            "operation must be Unset after cancellation"
        );

        // Verify token was NOT added to the shortlist.
        (address[] memory tokens,,,,) = vault.shortlist();
        assertEq(tokens.length, 2, "shortlist must not have grown after veto");
    }

    /// @notice The Safe itself (proposer/executor) can also cancel a queued change.
    function test_governance_safe_can_cancel_own_proposal() public {
        TestERC20 newToken = new TestERC20();
        MockPool newPool = new MockPool(address(newToken), address(usdc), 3000);

        bytes32 salt = keccak256("safe-cancel-salt-1");
        bytes32 opId = _scheduleAddAsset(address(newToken), address(newPool), 3000, salt);

        _govCancel(safe, timelock, opId);

        assertEq(
            uint256(timelock.getOperationState(opId)),
            uint256(TimelockController.OperationState.Unset),
            "Safe cancel must unset the operation"
        );
    }

    // ─── Unauthorized rejection ───────────────────────────────────────────────

    /// @notice A stranger cannot call addAsset directly on the vault because
    ///         ADMIN_ROLE is now held by the timelock, not an EOA.
    function test_governance_direct_addAsset_rejected_for_stranger() public {
        TestERC20 newToken = new TestERC20();
        MockPool newPool = new MockPool(address(newToken), address(usdc), 3000);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                vault.ADMIN_ROLE()
            )
        );
        vm.prank(stranger);
        vault.addAsset(address(newToken), address(newPool), 3000, address(0), BasketVault.Venue.V3);
    }

    /// @notice A stranger cannot call removeAsset directly because ADMIN_ROLE is
    ///         held by the timelock.
    function test_governance_direct_removeAsset_rejected_for_stranger() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                vault.ADMIN_ROLE()
            )
        );
        vm.prank(stranger);
        vault.removeAsset(0);
    }

    /// @notice A non-proposer cannot queue a shortlist change via the timelock.
    function test_governance_non_proposer_cannot_schedule_shortlist_change() public {
        TestERC20 newToken = new TestERC20();
        MockPool newPool = new MockPool(address(newToken), address(usdc), 3000);
        bytes memory callData = abi.encodeCall(
            BasketVault.addAsset,
            (address(newToken), address(newPool), 3000, address(0), BasketVault.Venue.V3)
        );

        vm.expectRevert();
        vm.prank(stranger);
        timelock.schedule(address(vault), 0, callData, bytes32(0), keccak256("bad"), ADD_DELAY);
    }

    // ─── addAsset on-chain gate: pool cardinality ─────────────────────────────

    /// @notice addAsset reverts when the pool has insufficient observation
    ///         cardinality (the on-chain component of the ADR-0004 liquidity/oracle gate).
    function test_governance_addAsset_rejects_low_cardinality_pool() public {
        TestERC20 newToken = new TestERC20();
        MockPool lowCardPool = new MockPool(address(newToken), address(usdc), 3000);
        lowCardPool.setCardinality(1); // below the window floor (901)

        bytes memory callData = abi.encodeCall(
            BasketVault.addAsset,
            (address(newToken), address(lowCardPool), 3000, address(0), BasketVault.Venue.V3)
        );

        // Schedule through the timelock.
        bytes32 salt = keccak256("low-card-salt");
        _govSchedule(safe, timelock, address(vault), callData, salt, ADD_DELAY);

        vm.warp(block.timestamp + ADD_DELAY + 1);

        // Execution must revert because the pool cardinality is too low. EXECUTOR_ROLE is open
        // (as in production), so the execute is called directly and the vault's own error is
        // visible. Through the Safe the same revert surfaces as GS013.
        bytes memory viaSafe =
            abi.encodeCall(timelock.execute, (address(vault), 0, callData, bytes32(0), salt));
        bytes memory sigs = _twoOwnerSignatures(_safeDigest(safe, address(timelock), viaSafe));
        vm.expectRevert(bytes(GS013));
        _safeExecWith(safe, address(timelock), viaSafe, sigs);

        vm.expectRevert(
            abi.encodeWithSelector(
                BasketVault.InsufficientPoolCardinality.selector,
                address(lowCardPool),
                uint16(901), // window-derived floor (1800 s / 2 s + 1)
                uint16(1)
            )
        );
        timelock.execute(address(vault), 0, callData, bytes32(0), salt);
    }

    /// @notice addAsset reverts when the pool does not pair the token with USDC.
    function test_governance_addAsset_rejects_wrong_pool_pair() public {
        TestERC20 newToken = new TestERC20();
        TestERC20 notUsdc = new TestERC20();
        // Pool pairs newToken with notUsdc, NOT with USDC.
        MockPool wrongPool = new MockPool(address(newToken), address(notUsdc), 3000);

        bytes memory callData = abi.encodeCall(
            BasketVault.addAsset,
            (address(newToken), address(wrongPool), 3000, address(0), BasketVault.Venue.V3)
        );

        bytes32 salt = keccak256("wrong-pair-salt");
        _govSchedule(safe, timelock, address(vault), callData, salt, ADD_DELAY);

        vm.warp(block.timestamp + ADD_DELAY + 1);

        vm.expectRevert(BasketVault.PoolTokenMismatch.selector);
        timelock.execute(address(vault), 0, callData, bytes32(0), salt);
    }
}
