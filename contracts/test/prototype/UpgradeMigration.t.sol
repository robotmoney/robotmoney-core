// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md (a reinitializer runs inside `upgradeToAndCall`);
//            docs/technical/one-vault-timed-flows-eng-plan.md §3.1 (FlowQueue state), E8, E13, E17
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {stdError} from "forge-std/StdError.sol";
import {GovernedUpgrade} from "../../lib/GovernedUUPS.sol";
import {FlowMigrateLib} from "../../lib/FlowMigrateLib.sol";
import {FundMigrateLib} from "../../lib/FundMigrateLib.sol";
import {FundStorage} from "../../lib/FundStorage.sol";
import {FlowQueue} from "../../FlowQueue.sol";
import {RobotMoneyFund} from "../../RobotMoneyFund.sol";
import {Rebalancer} from "../../Rebalancer.sol";
import {FundExclusionLedger} from "../../FundExclusionLedger.sol";
import {IFundEvents, StepParams} from "../../FundTypes.sol";
import {
    Claim,
    FlowBooks,
    FlowParams,
    IFlowEvents,
    Request,
    RequestKind,
    RequestStatus,
    Settlement
} from "../../FlowTypes.sol";
import {FlowQueueFixesBase} from "./FlowQueueFixes.t.sol";

/// @dev What a 0.8.0 Rebalancer looks like to the fund's migration: code at the address, no `lastBasketStepAt()`.
contract LegacyRebalancerStub {
    function stepParams() external pure returns (uint256) {
        return 0;
    }
}

/// @title UpgradeMigrationTest
/// @notice The in-place upgrade of a contracts 0.8.0 deployment to 0.9.0 (`FlowQueue.migrateV090`,
///         `RobotMoneyFund.migrateV090`, `Rebalancer.migrateV090`).
///
///         Trunk holds no 0.8.0 code, so the 0.8.0 state is built on the harness's fresh 0.9.0 deployment by writing the
///         0.8.0 storage layout with `vm.store`, the shape Deploy 4 had at its upgrade: closed requests, three unclaimed
///         deposit claims of one owner, a delivered claim, a paid redemption claim, a USDC credit, one dust share, an
///         epoch number in `oldestEpoch`, the three new queue parameters and the five new fund parameters at 0,
///         `fund.rebalancer` at 0, and the Rebalancer's step parameters in the six-member layout. Each migration then
///         runs the way the release runs it: `upgradeToAndCall(newImplementation, migrateV090(...))` from the upgrade
///         timelock.
///
///         Slot math. Both state structs sit at their ERC-7201 base (`FlowStorage.SLOT`, `FundStorage.SLOT`); a member
///         `m` of the struct is at `base + m`, a mapping entry at `keccak256(abi.encode(key, base + m))`, an array's
///         element `i` at `keccak256(slotOfLength) + i`. Member numbers (solc storage layout of `FlowState` and
///         `FundState`):
///
///         FlowState: 7 `params` slot 3 (usdcPegBandBps, maxLendRateGrowthBps, then cancelBuffer at byte 4, maxPause at
///         byte 8, matchBandBps at byte 12), 9 `requests`, 10 `requestCount`, 12 `oldestEpoch`, 13 `claims`,
///         14 `claimCount`, 15 `claimsOf`, 17 `settlements`, 18 `settlementCount`, 19 `usdcCredit`, 21 `queuedShares`,
///         27 `totalPendingUsdc`, 29 `totalHeldShares`, 31 `totalCreditUsdc`, 33 `epochOpen`, 36 `requestClaims`,
///         38 `dustShares`, 39 and 40 `sideIds` (deposit, redeem), 41 and 42 `sideOpen`, 43 to 46 `cursors`, 65 `depCycle`, 68 `depCycleFactor`, 75 `redCycle`, 77 `redCycles`.
///         FundState: 35 `minPoolDepthUsdc`, 36 `feeMarginBps, delistBandBps, delistBudgetBps, maxBasketBps` (two bytes
///         each from byte 0), 54 `rebalancer`.
///         Rebalancer (plain storage): slot 1 `_stepParams`.
///         FundExclusionLedger (plain storage): slot 0 `exclusionCount`, slot 3 `heldUsdc`.
///
///         0.8.0 struct layouts written here (from the 0.8.0 sources, commit fa7c47182):
///         - `Request`: slot 0 owner (20 bytes), kind (byte 20), epoch (bytes 21 to 28); 1 amount; 2 remaining;
///           3 limit; 4 closed.
///         - `Settlement`: slot 0 time (8 bytes), settler; 1 depositBoundPrice; 2 redeemBoundPrice; 3 usdcIn;
///           4 sharesMinted; 5 sharesBurned; 6 usdcOut; 7 frozenUntil (bytes 0 to 7), returnAllowed (byte 8),
///           holdEndsAt (bytes 9 to 16).
///         - `Claim` (unchanged in 0.9.0): slot 0 requestId; 1 owner, kind (byte 20), settlementId (bytes 21 to 28);
///           2 unlockAt; 3 shares; 4 usdc; 5 claimed; 6 sharesClaimed.
///         - `StepParams`: stepInterval (bytes 0 to 3), keeperGrace (4 to 7), maxOverrun (8 to 11), maxStepCostBps
///           (12 to 13), toleranceBps (14 to 15), minStepUsdc (16 to 31).
///
///         Every write is read back through a getter before the migration runs (`_assertLegacyShape`), so a wrong slot
///         fails the test instead of passing on an untouched 0.9.0 state.
contract UpgradeMigrationTest is FlowQueueFixesBase {
    uint256 internal constant FLOW =
        0x5ca698e4220eb646640b8313725773ea79d9bb0180fc107a75b91aa030545000;
    uint256 internal constant FUND =
        0x1f474ae58db9fb6ccfa907fed2f1bf5577ac55e97dddcd5c18f25868bd856c00;

    /// @dev One 0.8.0 deposit claim's shares (Deploy 4: 998591985300725976373313 each).
    uint256 internal constant S = 998_591_985_300_725_976_373_313;
    uint256 internal constant CLAIM_USDC = 1_000e6;
    uint256 internal constant REDEEMED_SHARES = 500_000e18;
    uint256 internal constant REDEEMED_USDC = 499e6;
    uint256 internal constant CREDIT_USDC = 1_390;
    /// @dev A 0.8.0 price limit whose low byte is 0: read as a 0.9.0 request it says `closed = false`.
    uint256 internal constant LIMIT = 1_050_000_000_000_000_000;
    uint256 internal constant DEP_BOUND = 1_010_000_000_000_000_000;
    uint256 internal constant RED_BOUND = 990_000_000_000_000_000;
    uint32 internal constant LEGACY_KEEPER_GRACE = 21_600;

    uint32 internal constant NEW_CANCEL_BUFFER = 900;
    uint32 internal constant NEW_MAX_PAUSE = 259_200;
    uint16 internal constant NEW_MATCH_BAND_BPS = 10;

    /// @dev How many epochs before the current one the 0.8.0 requests were made.
    uint64 internal legacyEpochsAgo = 20;
    uint64 internal legacyEpoch;
    uint64 internal t1;
    uint64 internal t2;
    uint64 internal t3;
    StepParams internal stepParamsBefore;
    address internal oldLedger;

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Building the 0.8.0 state
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _flow(uint256 member) internal pure returns (bytes32) {
        return bytes32(FLOW + member);
    }

    function _entry(uint256 key, uint256 member) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(key, FLOW + member)));
    }

    function _entry(address key, uint256 member) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(key, FLOW + member)));
    }

    function _q(uint256 slot, uint256 value) internal {
        vm.store(address(queue), bytes32(slot), bytes32(value));
    }

    function _qLoad(uint256 slot) internal view returns (uint256) {
        return uint256(vm.load(address(queue), bytes32(slot)));
    }

    function _writeArray(uint256 lengthSlot, uint256[] memory ids) internal {
        _q(lengthSlot, ids.length);
        uint256 first = uint256(keccak256(abi.encode(lengthSlot)));
        for (uint256 k; k < ids.length; ++k) {
            _q(first + k, ids[k]);
        }
    }

    function _legacyRequest(
        uint256 id,
        address owner,
        RequestKind kind,
        uint256 amount,
        uint256 remaining,
        uint256 limit,
        bool closed
    ) internal {
        uint256 base = _entry(id, 9);
        _q(
            base,
            uint256(uint160(owner)) | (uint256(uint8(kind)) << 160) | (uint256(legacyEpoch) << 168)
        );
        _q(base + 1, amount);
        _q(base + 2, remaining);
        _q(base + 3, limit);
        _q(base + 4, closed ? 1 : 0);
    }

    function _legacySettlement(
        uint256 id,
        uint64 time,
        uint256[6] memory amounts,
        uint64 frozenUntil,
        bool returnAllowed,
        uint64 holdEndsAt
    ) internal {
        uint256 base = _entry(id, 17);
        _q(base, uint256(time) | (uint256(uint160(keeper)) << 64));
        for (uint256 k; k < 6; ++k) {
            _q(base + 1 + k, amounts[k]);
        }
        _q(
            base + 7,
            uint256(frozenUntil) | (uint256(returnAllowed ? 1 : 0) << 64)
                | (uint256(holdEndsAt) << 72)
        );
    }

    function _legacyClaim(
        uint256 id,
        uint256 requestId,
        RequestKind kind,
        uint64 settlementId,
        uint64 unlockAt,
        uint256[4] memory amounts
    ) internal {
        uint256 base = _entry(id, 13);
        _q(base, requestId);
        _q(
            base + 1,
            uint256(uint160(alice)) | (uint256(uint8(kind)) << 160) | (uint256(settlementId) << 168)
        );
        _q(base + 2, unlockAt);
        for (uint256 k; k < 4; ++k) {
            _q(base + 3 + k, amounts[k]);
        }
        uint256[] memory one = new uint256[](1);
        one[0] = id;
        _writeArray(_entry(requestId, 36), one);
    }

    /// @dev The queue as 0.8.0 left it (see the contract note). The shares and the USDC the books name are really
    ///      there: `deal` gives the queue `3 × S + 1` shares and raises the supply by as much (0.003 % of the seed's
    ///      shares, which the fund holds locked, E14; no holder has shares to move before a first deposit).
    function _buildLegacyQueue() internal {
        legacyEpoch = queue.currentEpoch() - legacyEpochsAgo;
        t1 = uint64(block.timestamp - 5 days);
        t2 = uint64(block.timestamp - 4 days);
        t3 = uint64(block.timestamp - 3 days);

        // Requests 1 to 4: filled deposits. 5: a filled redemption. 6: a redemption 0.8.0 emptied without setting
        // `closed`.
        for (uint256 id = 1; id <= 4; ++id) {
            _legacyRequest(id, alice, RequestKind.Deposit, CLAIM_USDC, 0, LIMIT, true);
        }
        _legacyRequest(5, alice, RequestKind.Redeem, REDEEMED_SHARES, 0, RED_BOUND, true);
        _legacyRequest(6, alice, RequestKind.Redeem, REDEEMED_SHARES, 0, RED_BOUND, false);
        _q(FLOW + 10, 6);
        // Their epoch's id lists per side, and the open counts request 6 still holds.
        uint256[] memory deposits = new uint256[](4);
        for (uint256 k; k < 4; ++k) {
            deposits[k] = k + 1;
        }
        uint256[] memory redeems = new uint256[](2);
        redeems[0] = 5;
        redeems[1] = 6;
        _writeArray(_entry(uint256(legacyEpoch), 39), deposits);
        _writeArray(_entry(uint256(legacyEpoch), 40), redeems);
        _q(_entry(uint256(legacyEpoch), 42), 1);
        _q(_entry(uint256(legacyEpoch), 33), 1);

        // Settlement 2 keeps the stale `returnAllowed` 0.8.0 left behind when a freeze ran out.
        _legacySettlement(1, t1, [DEP_BOUND, 0, CLAIM_USDC, S, 0, 0], 0, false, t1 + 3_600);
        _legacySettlement(2, t2, [DEP_BOUND, 0, CLAIM_USDC, S, 0, 0], t2 + 100, true, t2 + 3_600);
        _legacySettlement(
            3,
            t3,
            [DEP_BOUND, RED_BOUND, 2 * CLAIM_USDC, 2 * S, REDEEMED_SHARES, REDEEMED_USDC],
            0,
            false,
            t3 + 3_600
        );
        _q(FLOW + 18, 3);

        // Claims 1 to 3: unclaimed deposit shares, out of their hold. 4: delivered. 5: a paid redemption.
        _legacyClaim(1, 1, RequestKind.Deposit, 1, t1 + 3_600, [S, CLAIM_USDC, 0, 0]);
        _legacyClaim(2, 2, RequestKind.Deposit, 2, t2 + 3_600, [S, CLAIM_USDC, 0, 0]);
        _legacyClaim(3, 3, RequestKind.Deposit, 3, t3 + 3_600, [S, CLAIM_USDC, 0, 0]);
        _legacyClaim(4, 4, RequestKind.Deposit, 3, t3 + 3_600, [S, CLAIM_USDC, S, 0]);
        _legacyClaim(
            5,
            5,
            RequestKind.Redeem,
            3,
            t3,
            [REDEEMED_SHARES, REDEEMED_USDC, REDEEMED_USDC, REDEEMED_SHARES]
        );
        _q(FLOW + 14, 5);
        uint256[] memory ids = new uint256[](5);
        for (uint256 k; k < 5; ++k) {
            ids[k] = k + 1;
        }
        _writeArray(_entry(alice, 15), ids);

        // The books: held shares in the 0.8.0 per-owner mapping only, a USDC credit, one dust share.
        _q(FLOW + 29, 3 * S);
        _q(_entry(alice, 21), 3 * S);
        _q(_entry(alice, 19), CREDIT_USDC);
        _q(FLOW + 31, CREDIT_USDC);
        _q(FLOW + 38, 1);
        deal(address(fund), address(queue), 3 * S + 1, true);
        fundUsdc(address(queue), CREDIT_USDC);

        // The walk: an epoch number where 0.9.0 keeps an index, and cursors into 0.8.0 lists.
        _q(FLOW + 12, 0x1448c);
        _q(FLOW + 43, uint256(legacyEpoch) | (uint256(2) << 64));
        _q(FLOW + 46, uint256(legacyEpoch) | (uint256(1) << 64));

        // The three parameters 0.9.0 added read 0 (the low four bytes of the slot are 0.8.0 members and stay).
        _q(FLOW + 7, _qLoad(FLOW + 7) & 0xffffffff);

        // 0.8.0 never ran the match-cycle initialization of the 0.9.0 `initialize`.
        _q(FLOW + 65, 0);
        _q(_entry(uint256(1), 68), 0);
        _q(FLOW + 75, 0);
        _q(_entry(uint256(1), 77), 0);
    }

    function _buildLegacyFund() internal {
        vm.store(address(fund), bytes32(FUND + 35), bytes32(0));
        vm.store(address(fund), bytes32(FUND + 36), bytes32(0));
        vm.store(address(fund), bytes32(FUND + 54), bytes32(0));
        oldLedger = fund.exclusionLedger();
    }

    function _buildLegacyRebalancer() internal {
        stepParamsBefore = rebalancer.stepParams();
        vm.store(
            address(rebalancer), bytes32(uint256(1)), bytes32(_legacyStepWord(stepParamsBefore))
        );
    }

    function _legacyStepWord(StepParams memory p) internal pure returns (uint256) {
        return uint256(p.stepInterval) | (uint256(LEGACY_KEEPER_GRACE) << 32)
            | (uint256(p.maxOverrun) << 64) | (uint256(p.maxStepCostBps) << 96)
            | (uint256(p.toleranceBps) << 112) | (uint256(p.minStepUsdc) << 128);
    }

    /// @dev An invested fund, then the 0.8.0 state on all three proxies.
    function _buildLegacy() internal {
        _invest();
        _buildLegacyQueue();
        _buildLegacyFund();
        _buildLegacyRebalancer();
        _assertLegacyShape();
    }

    /// @dev Every write above, read through the 0.9.0 getters: the right slots were hit, and the state shows the
    ///      hazards the migration is for.
    function _assertLegacyShape() internal view {
        assertEq(queue.requestCount(), 6, "legacy: requestCount");
        assertEq(queue.claimCount(), 5, "legacy: claimCount");
        assertEq(queue.settlementCount(), 3, "legacy: settlementCount");
        FlowBooks memory b = queue.books();
        assertEq(b.heldShares, 3 * S, "legacy: totalHeldShares");
        assertEq(b.creditUsdc, CREDIT_USDC, "legacy: totalCreditUsdc");
        assertEq(b.dustShares, 1, "legacy: dustShares");
        assertEq(b.pendingUsdc + b.escrowShares, 0, "legacy: nothing in escrow");
        _assertBooks("legacy");
        (uint256 credit,) = queue.creditOf(alice);
        assertEq(credit, CREDIT_USDC, "legacy: usdcCredit");
        uint256[] memory epochIds = queue.epochRequests(legacyEpoch);
        assertEq(epochIds.length, 6, "legacy: the epoch lists all six requests");
        for (uint256 k; k < 6; ++k) {
            assertEq(epochIds[k], k + 1, "legacy: sideIds");
        }

        Claim memory c = queue.getClaim(2);
        assertEq(c.owner, alice, "legacy claim: owner");
        assertEq(c.requestId, 2, "legacy claim: request");
        assertEq(c.settlementId, 2, "legacy claim: settlement");
        assertEq(c.shares, S, "legacy claim: shares");
        assertEq(c.claimed, 0, "legacy claim: unclaimed");

        // The 0.8.0 request read as a 0.9.0 one: the limit lands on six members, `closed` on `expiresAt`.
        Request memory r = queue.getRequest(1);
        assertEq(r.owner, alice, "legacy request: owner");
        assertEq(r.epoch, legacyEpoch, "legacy request: epoch");
        assertEq(r.amount, CLAIM_USDC, "legacy request: amount");
        assertFalse(r.closed, "the limit's low byte reads as closed = false");
        assertEq(r.expiresAt, 1, "the 0.8.0 closed flag reads as expiresAt = 1");
        // The 0.8.0 settlement read as a 0.9.0 one: every member after slot 0 is one slot off.
        Settlement memory st = queue.getSettlement(3);
        assertEq(st.time, t3, "legacy settlement: time");
        assertEq(st.settler, keeper, "legacy settlement: settler");
        assertEq(st.matchedShares, DEP_BOUND, "the deposit bound price reads as matchedShares");
        assertEq(st.usdcIn, 2 * S, "sharesMinted reads as usdcIn");
        assertEq(st.holdEndsAt, 0, "holdEndsAt reads 0");

        FlowParams memory p = queue.flowParams();
        assertEq(p.cancelBuffer, 0, "legacy: cancelBuffer 0");
        assertEq(p.maxPause, 0, "legacy: maxPause 0");
        assertEq(p.matchBandBps, 0, "legacy: matchBandBps 0");
        assertEq(p.usdcPegBandBps, 50, "legacy: the old members of the slot are kept");
        assertEq(p.maxLendRateGrowthBps, 10, "legacy: the old members of the slot are kept");
        (uint64 cursorEpoch, uint256 cursorIndex) = queue.settleCursor(true, RequestKind.Deposit);
        assertEq(cursorEpoch, legacyEpoch, "legacy: a stale cursor");
        assertEq(cursorIndex, 2, "legacy: a stale cursor");
        assertEq(queue.queuedSharesOf(alice), 0, "hazard 2: 0.9.0 does not see the held shares");

        assertEq(fund.minPoolDepthUsdc(), 0, "legacy: minPoolDepthUsdc 0");
        assertEq(fund.feeMarginBps(), 0, "legacy: feeMarginBps 0");
        assertEq(fund.delistBandBps(), 0, "legacy: delistBandBps 0");
        assertEq(fund.delistBudgetBps(), 0, "legacy: delistBudgetBps 0");
        assertEq(fund.maxBasketBps(), 0, "legacy: maxBasketBps 0");
        assertEq(fund.rebalancer(), address(0), "legacy: fund.rebalancer 0");

        // The six-member slot read as five members: `keeperGrace` lands on `maxOverrun`.
        StepParams memory sp = rebalancer.stepParams();
        assertEq(sp.stepInterval, stepParamsBefore.stepInterval, "legacy: stepInterval is in place");
        assertEq(sp.maxOverrun, LEGACY_KEEPER_GRACE, "legacy: keeperGrace reads as maxOverrun");
        assertTrue(sp.minStepUsdc != stepParamsBefore.minStepUsdc, "legacy: minStepUsdc is shifted");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Running the migrations
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _queueData() internal pure returns (bytes memory) {
        return abi.encodeCall(
            FlowQueue.migrateV090, (NEW_CANCEL_BUFFER, NEW_MAX_PAUSE, NEW_MATCH_BAND_BPS)
        );
    }

    function _fundData() internal view returns (bytes memory) {
        return abi.encodeCall(RobotMoneyFund.migrateV090, (address(rebalancer)));
    }

    function _upgradeRebalancer() internal {
        address impl = address(new Rebalancer());
        vm.prank(address(timelock));
        rebalancer.upgradeToAndCall(impl, abi.encodeCall(Rebalancer.migrateV090, ()));
    }

    function _upgradeFund() internal {
        address impl = address(new RobotMoneyFund());
        bytes memory data = _fundData();
        vm.prank(address(timelock));
        RobotMoneyFund(address(fund)).upgradeToAndCall(impl, data);
    }

    function _upgradeQueue() internal {
        address impl = address(new FlowQueue());
        vm.prank(address(timelock));
        queue.upgradeToAndCall(impl, _queueData());
    }

    /// @dev The release's order: Rebalancer, fund, queue.
    function _upgradeAll() internal {
        _upgradeRebalancer();
        _upgradeFund();
        _upgradeQueue();
    }

    function _expectQueueRefuses(bytes memory err) internal {
        address impl = address(new FlowQueue());
        bytes memory data = _queueData();
        vm.prank(address(timelock));
        vm.expectRevert(err);
        queue.upgradeToAndCall(impl, data);
    }

    function _expectFundRefuses(address rebalancer_, bytes memory err) internal {
        address impl = address(new RobotMoneyFund());
        bytes memory data = abi.encodeCall(RobotMoneyFund.migrateV090, (rebalancer_));
        vm.prank(address(timelock));
        vm.expectRevert(err);
        RobotMoneyFund(address(fund)).upgradeToAndCall(impl, data);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  The hazards without a migration
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Audit hazard 1: on 0.9.0 code with no migration a 0.8.0 deposit claim cannot be delivered. The owner's
    ///         held balance is 0 in the mapping 0.9.0 reads, so the subtraction panics (0x11).
    function test_withoutTheMigrationALegacyDepositClaimPanics() public fixtureCovered {
        _buildLegacy();
        assertEq(queue.maxMint(alice), 3 * S, "the claims look deliverable");
        vm.expectRevert(stdError.arithmeticError);
        queue.mint(S, alice);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  The migrated state
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice The queue after its migration: held shares are the owner's, the 0.8.0 claims deliver in full, the
    ///         credit and the dust leave, and the books balance at every step.
    function test_queue_legacyClaimsDeliverInFull() public fixtureCovered {
        _buildLegacy();
        _upgradeAll();

        assertEq(queue.queuedSharesOf(alice), 3 * S, "queuedSharesOf includes the held shares");
        assertEq(fund.ledgerBalanceOf(alice), 3 * S, "the ledger counts them for the owner");
        assertEq(queue.books().heldShares, 3 * S, "totalHeldShares is unchanged");
        assertEq(queue.maxMint(alice), 3 * S, "all three claims are deliverable");
        assertEq(
            queue.claimableDepositRequest(1, alice),
            CLAIM_USDC,
            "ERC-7540 claimable of a 0.8.0 request"
        );
        _assertBooks("migrated");

        queue.mint(S, alice);
        assertEq(fund.balanceOf(alice), S, "one claim delivered");
        assertEq(queue.queuedSharesOf(alice), 2 * S, "the rest stays queued");
        queue.mint(2 * S, alice);
        assertEq(fund.balanceOf(alice), 3 * S, "every 0.8.0 deposit claim delivered in full");
        assertEq(queue.queuedSharesOf(alice), 0, "nothing left queued");
        assertEq(queue.books().heldShares, 0, "nothing left held");
        assertEq(queue.maxMint(alice), 0, "nothing left to deliver");
        for (uint256 id = 1; id <= 4; ++id) {
            Claim memory c = queue.getClaim(id);
            assertEq(c.claimed, c.shares, "claim used up");
        }
        _assertBooks("delivered");

        uint256 before = IERC20(USDC).balanceOf(alice);
        vm.prank(alice);
        (uint256 usdc, uint256 shares) = queue.withdrawCredit();
        assertEq(usdc, CREDIT_USDC, "the 0.8.0 USDC credit is paid");
        assertEq(shares, 0, "no share credit");
        assertEq(IERC20(USDC).balanceOf(alice) - before, CREDIT_USDC, "paid to the owner");

        (uint256 sweptUsdc, uint256 sweptShares) = queue.sweep();
        assertEq(sweptUsdc, 0, "no USDC above the books");
        assertEq(sweptShares, 1, "the dust share goes to the fund");
        assertEq(fund.balanceOf(address(queue)), 0, "the queue holds no share");
        _assertBooks("swept");
    }

    /// @notice `getRequest`, `requestStatus` and `getSettlement` of the 0.8.0 entries after the migration: the members
    ///         both versions have keep their values, the new ones are neutral, `era` is 0.
    function test_queue_legacyRequestsAndSettlementsReadSane() public fixtureCovered {
        _buildLegacy();
        _upgradeAll();

        for (uint256 id = 1; id <= 6; ++id) {
            Request memory r = queue.getRequest(id);
            bool deposit = id <= 4;
            assertEq(r.owner, alice, "owner");
            assertEq(
                uint8(r.kind), uint8(deposit ? RequestKind.Deposit : RequestKind.Redeem), "kind"
            );
            assertEq(r.epoch, legacyEpoch, "epoch");
            assertEq(r.amount, deposit ? CLAIM_USDC : REDEEMED_SHARES, "amount");
            assertEq(r.remaining, 0, "remaining");
            assertTrue(r.closed, "closed");
            assertEq(r.exitFeeBps, 0, "exitFeeBps");
            assertEq(r.minHold, 0, "minHold");
            assertEq(r.maxRoll, 0, "maxRoll");
            assertEq(r.createdAt, 0, "createdAt");
            assertEq(r.expiryEpoch, legacyEpoch, "expiryEpoch");
            assertEq(r.expiresAt, deposit ? 0 : type(uint64).max, "expiresAt");
            assertEq(r.noticeRound, 0, "noticeRound");
            assertEq(r.era, 0, "era");
            assertFalse(r.enrolled, "enrolled");
            assertEq(
                r.matchCycle + r.normBasis + r.entryCumScaled + r.entryUnmatchedFactor
                    + r.nextMatchId,
                0,
                "match members"
            );
            assertEq(uint8(queue.requestStatus(id)), uint8(RequestStatus.Closed), "status");
            assertEq(queue.pendingDepositRequest(id, alice), 0, "nothing pending");
            assertEq(queue.pendingRedeemRequest(id, alice), 0, "nothing pending");
        }

        Settlement memory s1 = queue.getSettlement(1);
        assertEq(s1.time, t1, "time");
        assertEq(s1.settler, keeper, "settler");
        assertEq(s1.matchedShares + s1.matchedUsdc + s1.matchSharePrice, 0, "no match in 0.8.0");
        assertEq(s1.usdcIn, CLAIM_USDC, "usdcIn");
        assertEq(s1.sharesMinted, S, "sharesMinted");
        assertEq(s1.sharesBurned, 0, "sharesBurned");
        assertEq(s1.usdcOut, 0, "usdcOut");
        assertEq(s1.frozenUntil, 0, "frozenUntil");
        assertEq(s1.freezeSetAt, 0, "freezeSetAt");
        assertEq(s1.holdEndsAt, t1 + 3_600, "holdEndsAt");

        Settlement memory s2 = queue.getSettlement(2);
        assertEq(s2.frozenUntil, t2 + 100, "a freeze that ran out keeps its end");
        assertEq(s2.holdEndsAt, t2 + 3_600, "holdEndsAt");

        Settlement memory s3 = queue.getSettlement(3);
        assertEq(s3.time, t3, "time");
        assertEq(s3.usdcIn, 2 * CLAIM_USDC, "usdcIn");
        assertEq(s3.sharesMinted, 2 * S, "sharesMinted");
        assertEq(s3.sharesBurned, REDEEMED_SHARES, "sharesBurned");
        assertEq(s3.usdcOut, REDEEMED_USDC, "usdcOut");
        assertEq(s3.holdEndsAt, t3 + 3_600, "holdEndsAt");

        // Request 6, which 0.8.0 emptied without closing, no longer counts as open in its epoch.
        assertEq(_qLoad(_entry(uint256(legacyEpoch), 42)), 0, "sideOpen of the redeem side");
        assertEq(_qLoad(_entry(uint256(legacyEpoch), 33)), 0, "epochOpen");

        // Past its hold, so a 0.8.0 settlement cannot be frozen (audit hazard 11).
        vm.prank(emergency);
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.FreezeOutsideHold.selector, 1));
        queue.freezeSettlement(1);
    }

    /// @notice The three queue parameters, the walk reset, and the queue's `reinitializer(2)` version.
    function test_queue_paramsAndWalkAreSet() public fixtureCovered {
        _buildLegacy();
        FlowParams memory beforeParams = queue.flowParams();
        _upgradeAll();

        FlowParams memory p = queue.flowParams();
        assertEq(p.cancelBuffer, NEW_CANCEL_BUFFER, "cancelBuffer");
        assertEq(p.maxPause, NEW_MAX_PAUSE, "maxPause");
        assertEq(p.matchBandBps, NEW_MATCH_BAND_BPS, "matchBandBps");
        assertEq(queue.cancelBuffer(), NEW_CANCEL_BUFFER, "cancelBuffer view");
        assertEq(queue.maxPause(), NEW_MAX_PAUSE, "maxPause view");
        beforeParams.cancelBuffer = NEW_CANCEL_BUFFER;
        beforeParams.maxPause = NEW_MAX_PAUSE;
        beforeParams.matchBandBps = NEW_MATCH_BAND_BPS;
        assertEq(
            keccak256(abi.encode(p)),
            keccak256(abi.encode(beforeParams)),
            "no other parameter moved"
        );

        assertEq(_qLoad(FLOW + 12), 0, "oldestEpoch is an index again");
        for (uint256 k = 43; k <= 46; ++k) {
            assertEq(_qLoad(FLOW + k), 0, "cursor cleared");
        }
        (uint64 cursorEpoch, uint256 cursorIndex) = queue.settleCursor(true, RequestKind.Deposit);
        assertEq(cursorEpoch, 0, "cursor epoch");
        assertEq(cursorIndex, 0, "cursor index");
        assertEq(_initializedVersion(address(queue)), 2, "the queue is at version 2");

        // A pause now lasts `maxPause` (it ended at once while the parameter read 0).
        vm.prank(emergency);
        queue.pauseQueue();
        assertTrue(queue.queuePaused(), "paused");
        assertEq(queue.queuePausedUntil(), block.timestamp + NEW_MAX_PAUSE, "for maxPause");
    }

    /// @notice The fund after its migration: the five parameters, a new ledger bound to the fund, `rebalancer`.
    function test_fund_paramsLedgerAndRebalancerAreSet() public fixtureCovered {
        _buildLegacy();
        _upgradeAll();

        assertEq(
            fund.minPoolDepthUsdc(), FundStorage.DEFAULT_MIN_POOL_DEPTH_USDC, "minPoolDepthUsdc"
        );
        assertEq(fund.minPoolDepthUsdc(), 2_000_000e6, "minPoolDepthUsdc value");
        assertEq(fund.feeMarginBps(), 20, "feeMarginBps");
        assertEq(fund.delistBandBps(), 300, "delistBandBps");
        assertEq(fund.delistBudgetBps(), 300, "delistBudgetBps");
        assertEq(fund.maxBasketBps(), 10_000, "maxBasketBps");
        assertEq(fund.rebalancer(), address(rebalancer), "rebalancer");
        assertEq(_initializedVersion(address(fund)), 2, "the fund is at version 2");

        address ledger = fund.exclusionLedger();
        assertTrue(ledger != oldLedger, "the ledger is replaced");
        assertGt(ledger.code.length, 0, "the new ledger has code");
        assertEq(FundExclusionLedger(ledger).VAULT(), address(fund), "bound to the fund");
        assertEq(address(FundExclusionLedger(ledger).USDC()), USDC, "pays USDC");
        assertEq(FundExclusionLedger(ledger).exclusionCount(), 0, "no record");
        assertEq(FundExclusionLedger(ledger).heldUsdc(), 0, "no money");
        // Same code as a ledger a fresh 0.9.0 fund creates (same immutables: this fund and USDC).
        assertEq(ledger.codehash, oldLedger.codehash, "the 0.9.0 FundExclusionLedger");
    }

    /// @notice The Rebalancer after its migration: the five members read what the six-member slot held, `keeperGrace`
    ///         is gone, and the bytes above `minStepUsdc` are clear.
    function test_rebalancer_stepParamsReadCorrectly() public fixtureCovered {
        _buildLegacy();
        _upgradeAll();

        StepParams memory sp = rebalancer.stepParams();
        assertEq(sp.stepInterval, stepParamsBefore.stepInterval, "stepInterval");
        assertEq(sp.maxOverrun, stepParamsBefore.maxOverrun, "maxOverrun");
        assertEq(sp.maxStepCostBps, stepParamsBefore.maxStepCostBps, "maxStepCostBps");
        assertEq(sp.toleranceBps, stepParamsBefore.toleranceBps, "toleranceBps");
        assertEq(sp.minStepUsdc, stepParamsBefore.minStepUsdc, "minStepUsdc");
        assertEq(sp.maxOverrun, MAX_OVERRUN, "the harness value, not keeperGrace");
        assertEq(
            uint256(vm.load(address(rebalancer), bytes32(uint256(1)))) >> 224, 0, "top bytes clear"
        );
        assertEq(_initializedVersion(address(rebalancer)), 2, "the Rebalancer is at version 2");
    }

    /// @notice Deploy 4's own numbers: `(1800, 21600, 604800, 50, 50, 1000000)` becomes
    ///         `(1800, 604800, 50, 50, 1000000)`.
    function test_rebalancer_deploy4Values() public fixtureCovered {
        uint256 word = uint256(1_800) | (uint256(21_600) << 32) | (uint256(604_800) << 64)
            | (uint256(50) << 96) | (uint256(50) << 112) | (uint256(1_000_000) << 128);
        vm.store(address(rebalancer), bytes32(uint256(1)), bytes32(word));
        _upgradeRebalancer();
        StepParams memory sp = rebalancer.stepParams();
        assertEq(sp.stepInterval, 1_800, "stepInterval");
        assertEq(sp.maxOverrun, 604_800, "maxOverrun");
        assertEq(sp.maxStepCostBps, 50, "maxStepCostBps");
        assertEq(sp.toleranceBps, 50, "toleranceBps");
        assertEq(sp.minStepUsdc, 1_000_000, "minStepUsdc");
    }

    /// @notice The whole system works after the three migrations: a new request (the queue's seventh) settles in a
    ///         new settlement (the fourth), which asks the migrated Rebalancer for its last basket step, and delivers.
    function test_aNewRequestSettlesAfterTheMigrations() public fixtureCovered {
        _buildLegacy();
        _upgradeAll();
        coverageCheckpoint();

        uint256 id = openDepositRequest(bob, 5_000e6);
        assertEq(id, 7, "ids continue after the 0.8.0 requests");
        assertEq(queue.getRequest(id).era, 0, "the new request is in the era of the old ones");
        settleUntilFilled(id);
        assertEq(uint8(queue.requestStatus(id)), uint8(RequestStatus.Closed), "the request filled");
        assertEq(queue.settlementCount(), 4, "one new settlement, after the 0.8.0 ones");
        assertEq(queue.getSettlement(3).usdcIn, 2 * CLAIM_USDC, "the 0.8.0 settlement is untouched");
        coverageCheckpoint();

        uint256 got = deliverAfterHold(bob);
        assertGt(got, 0, "bob's shares are delivered");
        // The 0.8.0 claims are still whole and still alice's.
        assertEq(queue.queuedSharesOf(alice), 3 * S, "alice's held shares are untouched");
        queue.mint(3 * S, alice);
        assertEq(fund.balanceOf(alice), 3 * S, "and they deliver in full");
        _assertBooks("after a 0.9.0 settlement");
    }

    /// @notice A 0.9.0 request made in the epoch of the 0.8.0 requests shares their id lists, so the round's
    ///         enrollment and walk pass over them. Migrated, they read closed and are left alone; the new request
    ///         fills.
    function test_aNewRequestInTheEpochOfLegacyRequestsSettles() public fixtureCovered {
        legacyEpochsAgo = 0;
        _buildLegacy();
        _upgradeAll();
        coverageCheckpoint();

        uint256 id = openDepositRequest(bob, 5_000e6);
        assertEq(queue.getRequest(id).epoch, legacyEpoch, "the same epoch");
        uint256[] memory epochIds = queue.epochRequests(legacyEpoch);
        assertEq(epochIds.length, 7, "one list for the old and the new");
        settleUntilFilled(id);
        assertEq(
            uint8(queue.requestStatus(id)), uint8(RequestStatus.Closed), "the new request filled"
        );
        for (uint256 old = 1; old <= 6; ++old) {
            Request memory r = queue.getRequest(old);
            assertTrue(r.closed, "the 0.8.0 request stays closed");
            assertFalse(r.enrolled, "and is never enrolled");
            assertEq(
                r.normBasis + r.matchCycle + r.remaining, 0, "and holds nothing in a match pool"
            );
        }
        assertEq(queue.queuedSharesOf(alice), 3 * S, "alice's held shares are untouched");
        queue.mint(3 * S, alice);
        assertEq(fund.balanceOf(alice), 3 * S, "and they deliver in full");
        _assertBooks("after a round over a shared epoch");
    }

    /// @notice A 0.8.0 settlement that is frozen at the upgrade keeps its freeze: its claim waits for the freeze to
    ///         end, the others deliver (audit hazard 11).
    function test_queue_aFrozenLegacySettlementStaysFrozen() public fixtureCovered {
        _buildLegacy();
        uint64 frozenUntil = uint64(block.timestamp + 1 days);
        uint64 holdEnd = uint64(block.timestamp + 1 hours);
        _q(_entry(uint256(1), 17) + 7, uint256(frozenUntil) | (uint256(holdEnd) << 72));
        _q(_entry(uint256(1), 13) + 2, holdEnd);
        _upgradeAll();

        Settlement memory s1 = queue.getSettlement(1);
        assertEq(s1.frozenUntil, frozenUntil, "frozenUntil");
        assertEq(s1.holdEndsAt, holdEnd, "holdEndsAt");
        assertEq(queue.queuedSharesOf(alice), 3 * S, "all three are held for the owner");
        assertEq(queue.maxMint(alice), 2 * S, "the frozen claim is not deliverable");
        vm.expectRevert(
            abi.encodeWithSelector(IFlowEvents.NotEnoughClaimable.selector, 3 * S, 2 * S)
        );
        queue.mint(3 * S, alice);

        vm.warp(holdEnd + 1);
        assertEq(queue.maxMint(alice), 2 * S, "out of its hold, still frozen");
        vm.warp(frozenUntil);
        assertEq(queue.maxMint(alice), 3 * S, "the freeze ended by itself");
        queue.mint(3 * S, alice);
        assertEq(fund.balanceOf(alice), 3 * S, "delivered in full");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Preconditions
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice An open 0.8.0 request refuses the queue's migration: by the books, and by the request itself.
    function test_queue_refusesAnOpenLegacyRequest() public fixtureCovered {
        _buildLegacy();
        _upgradeRebalancer();
        _upgradeFund();

        // A pending deposit: its USDC is in the books.
        _legacyRequest(6, alice, RequestKind.Deposit, CLAIM_USDC, CLAIM_USDC, LIMIT, false);
        _q(FLOW + 27, CLAIM_USDC);
        _expectQueueRefuses(
            abi.encodeWithSelector(FlowMigrateLib.LegacyEscrowOpen.selector, CLAIM_USDC, 0)
        );
        // A pending redemption.
        _q(FLOW + 27, 0);
        _q(FLOW + 28, 7);
        _expectQueueRefuses(abi.encodeWithSelector(FlowMigrateLib.LegacyEscrowOpen.selector, 0, 7));
        // Books that say nothing is pending do not hide an open request.
        _q(FLOW + 28, 0);
        _expectQueueRefuses(abi.encodeWithSelector(FlowMigrateLib.LegacyRequestOpen.selector, 6));

        // Closed again, the same state migrates.
        _legacyRequest(6, alice, RequestKind.Redeem, REDEEMED_SHARES, 0, RED_BOUND, true);
        _upgradeQueue();
        assertEq(queue.queuedSharesOf(alice), 3 * S, "migrated");
    }

    /// @notice The held shares of the claims must add up to the books.
    function test_queue_refusesAHeldSharesMismatch() public fixtureCovered {
        _buildLegacy();
        _q(FLOW + 29, 3 * S + 5);
        _expectQueueRefuses(
            abi.encodeWithSelector(FlowMigrateLib.HeldSharesMismatch.selector, 3 * S, 3 * S + 5)
        );
    }

    /// @notice A request or settlement that is not in the 0.8.0 layout refuses the migration, and so does 0.9.0 round
    ///         state: the migration never rewrites what 0.9.0 wrote.
    function test_queue_refusesStateThatIsNotLegacy() public fixtureCovered {
        _buildLegacy();
        // A 0.9.0 `expiresAt` where 0.8.0 has `closed`.
        uint256 r3 = _entry(uint256(3), 9);
        _q(r3 + 4, block.timestamp);
        _expectQueueRefuses(abi.encodeWithSelector(FlowMigrateLib.NotLegacyRequest.selector, 3));
        // A 0.9.0 match member beyond the 0.8.0 struct.
        _q(r3 + 4, 1);
        _q(r3 + 6, 1);
        _expectQueueRefuses(abi.encodeWithSelector(FlowMigrateLib.NotLegacyRequest.selector, 3));
        _q(r3 + 6, 0);
        // A 0.9.0 ninth settlement slot.
        uint256 s2 = _entry(uint256(2), 17);
        _q(s2 + 8, 1);
        _expectQueueRefuses(abi.encodeWithSelector(FlowMigrateLib.NotLegacySettlement.selector, 2));
        _q(s2 + 8, 0);
        // A wind-down era.
        _q(FLOW + 60, 1);
        _expectQueueRefuses(abi.encodeWithSelector(FlowMigrateLib.WindDownEraStarted.selector, 1));
        _q(FLOW + 60, 0);
        // An active epoch.
        _q(FLOW + 62, 1);
        _expectQueueRefuses(abi.encodeWithSelector(FlowMigrateLib.QueueAlreadyActive.selector, 1));
    }

    /// @notice A 0.8.0 freeze with in-kind returns allowed is still running: 0.9.0 has no such exit.
    function test_queue_refusesALiveReturnAllowedFreeze() public fixtureCovered {
        _buildLegacy();
        uint256 slot = _entry(uint256(1), 17) + 7;
        _q(
            slot,
            uint256(block.timestamp + 1 days) | (uint256(1) << 64)
                | (uint256(block.timestamp + 1 hours) << 72)
        );
        _expectQueueRefuses(abi.encodeWithSelector(FlowMigrateLib.LegacyReturnAllowed.selector, 1));
    }

    /// @notice Each new queue parameter is held to the bound `setFlowParams` holds it to.
    function test_queue_refusesParamsOutOfBounds() public fixtureCovered {
        _buildLegacy();
        address impl = address(new FlowQueue());
        uint32 epochLength = queue.flowParams().epochLength;
        bytes[3] memory data = [
            abi.encodeCall(FlowQueue.migrateV090, (epochLength, NEW_MAX_PAUSE, NEW_MATCH_BAND_BPS)),
            abi.encodeCall(
                FlowQueue.migrateV090, (NEW_CANCEL_BUFFER, 48 hours, NEW_MATCH_BAND_BPS)
            ),
            abi.encodeCall(FlowQueue.migrateV090, (NEW_CANCEL_BUFFER, NEW_MAX_PAUSE, 0))
        ];
        for (uint256 k; k < 3; ++k) {
            vm.prank(address(timelock));
            vm.expectRevert(
                abi.encodeWithSelector(IFlowEvents.FlowParamOutOfBounds.selector, 18 + k)
            );
            queue.upgradeToAndCall(impl, data[k]);
        }
        uint16 aboveRefBand = queue.flowParams().refBandBps + 1;
        vm.prank(address(timelock));
        vm.expectRevert(abi.encodeWithSelector(IFlowEvents.FlowParamOutOfBounds.selector, 20));
        queue.upgradeToAndCall(
            impl,
            abi.encodeCall(FlowQueue.migrateV090, (NEW_CANCEL_BUFFER, NEW_MAX_PAUSE, aboveRefBand))
        );
    }

    /// @notice The old ledger must be empty: no record, no recovery money.
    function test_fund_refusesANonEmptyOldLedger() public fixtureCovered {
        _buildLegacy();
        _upgradeRebalancer();

        vm.store(oldLedger, bytes32(uint256(0)), bytes32(uint256(1)));
        assertEq(FundExclusionLedger(oldLedger).exclusionCount(), 1, "slot 0 is exclusionCount");
        _expectFundRefuses(
            address(rebalancer),
            abi.encodeWithSelector(FundMigrateLib.OldLedgerNotEmpty.selector, oldLedger, 1, 0)
        );
        vm.store(oldLedger, bytes32(uint256(0)), bytes32(0));
        vm.store(oldLedger, bytes32(uint256(3)), bytes32(uint256(25e6)));
        assertEq(FundExclusionLedger(oldLedger).heldUsdc(), 25e6, "slot 3 is heldUsdc");
        _expectFundRefuses(
            address(rebalancer),
            abi.encodeWithSelector(FundMigrateLib.OldLedgerNotEmpty.selector, oldLedger, 0, 25e6)
        );
        assertEq(fund.exclusionLedger(), oldLedger, "the ledger is not replaced");
        assertEq(fund.maxBasketBps(), 0, "nothing was written");

        vm.store(oldLedger, bytes32(uint256(3)), bytes32(0));
        _upgradeFund();
        assertTrue(fund.exclusionLedger() != oldLedger, "an empty ledger is replaced");
    }

    /// @notice The fund's migration refuses a Rebalancer still on 0.8.0 code (no `lastBasketStepAt()`), and any
    ///         address that is not the `REBALANCER_ROLE` holder.
    function test_fund_refusesARebalancerThatIsNotUpgradedOrNotTheHolder() public fixtureCovered {
        _buildLegacy();

        _expectFundRefuses(
            stranger, abi.encodeWithSelector(FundMigrateLib.NotTheRebalancer.selector, stranger)
        );
        _expectFundRefuses(
            address(0), abi.encodeWithSelector(FundMigrateLib.NotTheRebalancer.selector, address(0))
        );

        // The role holder with 0.8.0-like code: the proxy address answers, but not `lastBasketStepAt()`.
        bytes memory real = address(rebalancer).code;
        vm.etch(address(rebalancer), address(new LegacyRebalancerStub()).code);
        _expectFundRefuses(
            address(rebalancer),
            abi.encodeWithSelector(
                FundMigrateLib.RebalancerNotUpgraded.selector, address(rebalancer)
            )
        );
        assertEq(fund.rebalancer(), address(0), "fund.rebalancer is not written");

        vm.etch(address(rebalancer), real);
        _upgradeRebalancer();
        _upgradeFund();
        assertEq(fund.rebalancer(), address(rebalancer), "the upgraded Rebalancer is accepted");
    }

    /// @notice A step-parameter slot that does not decode to values inside the hard bounds refuses the Rebalancer's
    ///         migration. A slot already in the 0.9.0 layout is such a slot.
    function test_rebalancer_refusesASlotThatIsNotLegacy() public fixtureCovered {
        // The fresh harness Rebalancer holds the 0.9.0 layout.
        address impl = address(new Rebalancer());
        bytes memory data = abi.encodeCall(Rebalancer.migrateV090, ());
        vm.prank(address(timelock));
        vm.expectRevert(IFundEvents.StepParamOutOfBounds.selector);
        rebalancer.upgradeToAndCall(impl, data);

        // A 0.8.0 slot with a tolerance of 0.
        StepParams memory p = rebalancer.stepParams();
        p.toleranceBps = 0;
        vm.store(address(rebalancer), bytes32(uint256(1)), bytes32(_legacyStepWord(p)));
        vm.prank(address(timelock));
        vm.expectRevert(IFundEvents.StepParamOutOfBounds.selector);
        rebalancer.upgradeToAndCall(impl, data);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Who may run it, and how often
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Only the upgrade timelock runs a migration: a proxy upgraded with no data stays closed to everyone
    ///         else, the role admins included.
    function test_onlyTheUpgradeTimelockMigrates() public fixtureCovered {
        _buildLegacy();
        address[3] memory callers = [stranger, keeper, emergency];
        for (uint256 k; k < callers.length; ++k) {
            bytes memory err =
                abi.encodeWithSelector(GovernedUpgrade.NotUpgradeTimelock.selector, callers[k]);
            vm.startPrank(callers[k]);
            vm.expectRevert(err);
            queue.migrateV090(NEW_CANCEL_BUFFER, NEW_MAX_PAUSE, NEW_MATCH_BAND_BPS);
            vm.expectRevert(err);
            RobotMoneyFund(address(fund)).migrateV090(address(rebalancer));
            vm.expectRevert(err);
            rebalancer.migrateV090();
            vm.stopPrank();
        }
        assertEq(_initializedVersion(address(queue)), 1, "the queue is still at version 1");
        assertEq(_initializedVersion(address(fund)), 1, "the fund is still at version 1");
        assertEq(
            _initializedVersion(address(rebalancer)), 1, "the Rebalancer is still at version 1"
        );
    }

    /// @notice Each migration runs once: a second call reverts `InvalidInitialization`, directly and inside another
    ///         upgrade, and the implementations themselves are locked.
    function test_aSecondMigrationReverts() public fixtureCovered {
        _buildLegacy();
        _upgradeAll();

        vm.startPrank(address(timelock));
        vm.expectRevert(GovernedUpgrade.InvalidInitialization.selector);
        queue.migrateV090(NEW_CANCEL_BUFFER, NEW_MAX_PAUSE, NEW_MATCH_BAND_BPS);
        vm.expectRevert(GovernedUpgrade.InvalidInitialization.selector);
        RobotMoneyFund(address(fund)).migrateV090(address(rebalancer));
        vm.expectRevert(GovernedUpgrade.InvalidInitialization.selector);
        rebalancer.migrateV090();
        vm.stopPrank();

        _expectQueueRefuses(abi.encodeWithSelector(GovernedUpgrade.InvalidInitialization.selector));
        _expectFundRefuses(
            address(rebalancer),
            abi.encodeWithSelector(GovernedUpgrade.InvalidInitialization.selector)
        );
        address impl = address(new Rebalancer());
        vm.prank(address(timelock));
        vm.expectRevert(GovernedUpgrade.InvalidInitialization.selector);
        rebalancer.upgradeToAndCall(impl, abi.encodeCall(Rebalancer.migrateV090, ()));

        // An upgrade with no data still works after the migration (the runbook's upgrade lifecycle).
        vm.prank(address(timelock));
        rebalancer.upgradeToAndCall(impl, "");

        // The implementation contracts: locked at construction.
        FlowQueue queueImpl = new FlowQueue();
        vm.expectRevert(GovernedUpgrade.InvalidInitialization.selector);
        queueImpl.migrateV090(NEW_CANCEL_BUFFER, NEW_MAX_PAUSE, NEW_MATCH_BAND_BPS);
        Rebalancer rebalancerImpl = new Rebalancer();
        vm.expectRevert(GovernedUpgrade.InvalidInitialization.selector);
        rebalancerImpl.migrateV090();
        RobotMoneyFund fundImpl = new RobotMoneyFund();
        vm.expectRevert();
        fundImpl.migrateV090(address(rebalancer));
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  A fresh 0.9.0 deployment
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice A deployment through `initialize` needs no migration and is not changed by the entry points being
    ///         there: every value a migration writes is already set, the flows run, and a queue with 0.9.0 requests
    ///         refuses the migration even from the timelock.
    function test_aFreshDeploymentIsUnaffected() public fixtureCovered {
        assertEq(_initializedVersion(address(queue)), 1, "queue version");
        assertEq(_initializedVersion(address(fund)), 1, "fund version");
        assertEq(_initializedVersion(address(rebalancer)), 1, "Rebalancer version");
        assertEq(fund.rebalancer(), address(rebalancer), "bindRebalanceRoles wrote rebalancer");
        assertEq(fund.maxBasketBps(), 10_000, "initialize wrote maxBasketBps");
        assertEq(fund.minPoolDepthUsdc(), 2_000_000e6, "initialize wrote minPoolDepthUsdc");
        assertEq(fund.feeMarginBps(), 20, "initialize wrote feeMarginBps");
        assertEq(fund.delistBandBps(), 300, "initialize wrote delistBandBps");
        assertEq(fund.delistBudgetBps(), 300, "initialize wrote delistBudgetBps");
        FlowParams memory p = queue.flowParams();
        assertEq(p.cancelBuffer, 900, "initialize wrote cancelBuffer");
        assertEq(p.maxPause, 72 hours, "initialize wrote maxPause");
        assertEq(p.matchBandBps, 10, "initialize wrote matchBandBps");
        assertEq(
            rebalancer.stepParams().maxOverrun, MAX_OVERRUN, "initialize wrote the step parameters"
        );

        _invest();
        uint256 shares = _holder(alice, 5_000e6);
        assertGt(shares, 0, "a deposit runs end to end");
        assertEq(queue.queuedSharesOf(alice), 0, "delivered");
        coverageCheckpoint();

        // A queue that ran rounds under 0.9.0 is never rewritten, with or without an open request.
        _expectQueueRefuses(abi.encodeWithSelector(FlowMigrateLib.QueueAlreadyActive.selector, 1));
        uint256 id = openDepositRequest(bob, 1_000e6);
        _expectQueueRefuses(
            abi.encodeWithSelector(FlowMigrateLib.LegacyEscrowOpen.selector, 1_000e6, 0)
        );
        assertEq(
            uint8(queue.requestStatus(id)), uint8(RequestStatus.Pending), "the request is untouched"
        );
        assertEq(_initializedVersion(address(queue)), 1, "nothing ran");
    }

    /// @dev OpenZeppelin `Initializable` version of a proxy (erc7201:openzeppelin.storage.Initializable, low 8 bytes).
    function _initializedVersion(address proxy) internal view returns (uint64) {
        return uint64(uint256(vm.load(proxy, GovernedUpgrade.INITIALIZABLE_STORAGE)));
    }
}
