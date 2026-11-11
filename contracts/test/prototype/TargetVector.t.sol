// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.1 (per-asset targets, the contract checks),
//            §5.1 (receipt to plan), §10 phase 3b, §7 RB-9
// Experiment prototype only (contracts/test/prototype/). Phase 3b.
pragma solidity ^0.8.24;

import {PrototypeHarness} from "./PrototypeHarness.sol";
import {IFundEvents, AssetConfig, AssetKind, PlanParams, PlanStatus, Venue, BPS} from "./src/FundTypes.sol";
import {IRobotMoneyFund} from "./src/interfaces/IRobotMoneyFund.sol";
import {IRebalanceGovernance} from "./src/interfaces/IRebalanceGovernance.sol";

/// @notice RB-9: a target vector names every active asset exactly once and sums to 10 000. Each refused vector
///         reverts with its own error through all three doors (`applyReceipt`, `setTarget`, `previewPlan`). A
///         refused `applyReceipt` releases nothing, so the same receipt then applies with its valid vector.
contract TargetVectorTest is PrototypeHarness {
    address internal stranger = makeAddr("stranger");

    uint256 private _salt;

    function setUp() public override {
        super.setUp();
    }

    /// @dev The valid vector every test starts from: (60, 30, 10) split over the six assets.
    function _valid() internal pure returns (uint16[6] memory) {
        return bucketVec(6_000, 3_000, 1_000);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  One test per §4.1 check
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev An active asset left out (its weight moved to wETH, so the sum stays 10 000) is refused. An
    ///      explicit 0 is the only way to sell an asset.
    function test_rb9_unlistedActiveAsset_reverts() public fixtureCovered {
        (address[] memory ids, uint256[] memory w) = assetArrays(_valid());
        address[] memory ids5 = new address[](N_ASSETS - 1);
        uint256[] memory w5 = new uint256[](N_ASSETS - 1);
        uint256 k;
        for (uint256 i; i < N_ASSETS; ++i) {
            if (i == IDX_MOONWELL) continue;
            ids5[k] = ids[i];
            w5[k] = w[i];
            ++k;
        }
        w5[IDX_WETH - 1] += w[IDX_MOONWELL];
        _expectRefused(
            ids5, w5, abi.encodeWithSelector(IFundEvents.TargetAssetMissing.selector, address(moonwellAdapter))
        );
    }

    /// @dev The same asset listed twice is refused, even with a zero second weight and a 10 000 sum.
    function test_rb9_duplicateAsset_reverts() public fixtureCovered {
        (address[] memory ids, uint256[] memory w) = assetArrays(_valid());
        (address[] memory ids7, uint256[] memory w7) = _append(ids, w, address(aaveAdapter), 0);
        _expectRefused(
            ids7, w7, abi.encodeWithSelector(IFundEvents.TargetAssetDuplicate.selector, address(aaveAdapter))
        );
    }

    /// @dev A deactivated asset may not be named, not even with weight 0. The vector without it applies.
    function test_rb9_inactiveAsset_reverts() public fixtureCovered {
        timelockExecute(address(fund), abi.encodeCall(fund.deactivateAsset, (IDX_DESPXA)));
        assertFalse(fund.assetConfig(IDX_DESPXA).active, "deSPXA deactivated");

        // (60, 40) with deSPXA listed at 0.
        uint16[6] memory v = bucketVec(6_000, 4_000, 0);
        (address[] memory ids, uint256[] memory w) = assetArrays(v);
        bytes memory err = abi.encodeWithSelector(IFundEvents.TargetAssetNotActive.selector, DESPXA);
        bytes32 rid = _expectRefusedNoApply(ids, w, err);

        // The same receipt applies once deSPXA is left out: an inactive asset is not "missing".
        address[] memory ids5 = new address[](N_ASSETS - 1);
        uint256[] memory w5 = new uint256[](N_ASSETS - 1);
        for (uint256 i; i < N_ASSETS - 1; ++i) {
            ids5[i] = ids[i];
            w5[i] = w[i];
        }
        _applyRaw(rid, ids5, w5);
        assertEq(fund.currentPlanId(), 1, "valid vector opened the plan");
        assertTrue(receipts.isReleased(rid), "released by the valid apply");
        assertEq(fund.targetBps()[IDX_DESPXA], 0, "inactive asset target 0");
    }

    /// @dev An address that is no fund asset is refused with the same error as an inactive one.
    function test_rb9_unknownAsset_reverts() public fixtureCovered {
        (address[] memory ids, uint256[] memory w) = assetArrays(_valid());
        (address[] memory ids7, uint256[] memory w7) = _append(ids, w, stranger, 0);
        _expectRefused(ids7, w7, abi.encodeWithSelector(IFundEvents.TargetAssetNotActive.selector, stranger));
        // A basket asset is named by its token, never by its swap adapter or pool.
        ids[IDX_WETH] = WETH_POOL;
        _expectRefused(ids, w, abi.encodeWithSelector(IFundEvents.TargetAssetNotActive.selector, WETH_POOL));
    }

    /// @dev Weights that sum to anything but 10 000 are refused. A single weight above 10 000 reverts at once.
    function test_rb9_badSum_reverts() public fixtureCovered {
        (address[] memory ids, uint256[] memory w) = assetArrays(_valid());
        w[IDX_WETH] -= 1;
        _expectRefused(ids, w, abi.encodeWithSelector(IFundEvents.TargetSumInvalid.selector, BPS - 1));
        w[IDX_WETH] += 2;
        _expectRefused(ids, w, abi.encodeWithSelector(IFundEvents.TargetSumInvalid.selector, BPS + 1));
        uint256 huge = uint256(type(uint16).max) + 1;
        w[IDX_WETH] = huge;
        _expectRefused(ids, w, abi.encodeWithSelector(IFundEvents.TargetSumInvalid.selector, huge));
    }

    /// @dev A lending target above its `capBps` is refused, even when the vector is otherwise valid.
    function test_rb9_capBreach_reverts() public fixtureCovered {
        uint16 over = LENDING_CAP_BPS + 1;
        uint16[6] memory v = assetVec(over, 0, 0, uint16(BPS - over), 0, 0);
        (address[] memory ids, uint256[] memory w) = assetArrays(v);
        _expectRefused(
            ids,
            w,
            abi.encodeWithSelector(IFundEvents.TargetExceedsCap.selector, IDX_AAVE, over, LENDING_CAP_BPS)
        );
        // At the cap exactly, the same shape applies.
        v = assetVec(LENDING_CAP_BPS, 0, 0, uint16(BPS - LENDING_CAP_BPS), 0, 0);
        assertEq(recordAndApply(v), _planBase + 1, "a target at the cap applies");
    }

    /// @dev Parallel arrays of different length are refused (`InvalidParam`).
    function test_rb9_lengthMismatch_reverts() public fixtureCovered {
        (address[] memory ids, uint256[] memory w) = assetArrays(_valid());
        uint256[] memory w5 = new uint256[](N_ASSETS - 1);
        for (uint256 i; i < w5.length; ++i) {
            w5[i] = w[i];
        }
        _expectRefused(ids, w5, abi.encodeWithSelector(IFundEvents.InvalidParam.selector));
    }

    /// @dev The order of the vector does not matter, and each asset gets exactly its listed weight.
    function test_rb9_anyOrder_setsExactPerAssetTargets() public fixtureCovered {
        uint16[6] memory v = assetVec(2_500, 2_000, 1_500, 1_200, 1_300, 1_500);
        (address[] memory ids, uint256[] memory w) = assetArrays(v);
        address[] memory rIds = new address[](N_ASSETS);
        uint256[] memory rW = new uint256[](N_ASSETS);
        for (uint256 i; i < N_ASSETS; ++i) {
            rIds[i] = ids[N_ASSETS - 1 - i];
            rW[i] = w[N_ASSETS - 1 - i];
        }
        (bytes32 rid, bytes32 digest) = recordReceipt(v);
        _scheduleApply(rid, digest, rIds, rW, "");
        assertEq(uint8(fund.planStatus()), uint8(PlanStatus.Open), "plan open");
        uint16[] memory t = fund.targetBps();
        for (uint256 i; i < N_ASSETS; ++i) {
            assertEq(t[i], v[i], "exact per-asset target");
            assertEq(fund.plan().endBps[i], v[i], "plan end = the vector");
        }
    }

    /// @dev A wrong payload digest is refused before the vector is read. The receipt stays unreleased, no plan
    ///      opens, and the same receipt then applies with its recorded digest.
    function test_applyReceipt_wrongDigest_reverts() public fixtureCovered {
        (bytes32 rid, bytes32 digest) = recordReceipt(_valid());
        bytes32 wrong = keccak256("wrong");
        (address[] memory ids, uint256[] memory w) = assetArrays(_valid());
        uint64 appliedBefore = governance.lastAppliedRecordedAt();
        _scheduleApply(
            rid,
            wrong,
            ids,
            w,
            abi.encodeWithSelector(IRebalanceGovernance.PayloadDigestMismatch.selector, rid, digest, wrong)
        );
        assertFalse(receipts.isReleased(rid), "wrong digest released nothing");
        assertEq(fund.currentPlanId(), 0, "wrong digest opened no plan");
        assertEq(governance.lastAppliedRecordedAt(), appliedBefore, "wrong digest left lastApplied");
        _applyRaw(rid, ids, w);
        assertTrue(receipts.isReleased(rid), "the recorded digest released the receipt");
        assertEq(fund.currentPlanId(), 1, "the recorded digest opened the plan");
    }

    /// @dev An asset the persistent target still weights cannot be deactivated, even with no live plan and no
    ///      holdings. Once a vector names it with 0, it deactivates, and its target stays 0 for deposits.
    function test_deactivate_targetedAsset_reverts() public fixtureCovered {
        recordAndApply(_valid());
        // Close before any step buys deSPXA: no live plan, no holdings, target still 1 000.
        timelockExecute(address(fund), abi.encodeCall(fund.closePlan, ()));
        assertEq(IERC20Like(DESPXA).balanceOf(address(fund)), 0, "no deSPXA bought");
        assertEq(fund.targetBps()[IDX_DESPXA], 1_000, "deSPXA still targeted");
        _timelockExpectRevert(
            address(fund),
            abi.encodeCall(fund.deactivateAsset, (IDX_DESPXA)),
            abi.encodeWithSelector(IRobotMoneyFund.AssetStillTargeted.selector, IDX_DESPXA, uint256(1_000))
        );
        assertTrue(fund.assetConfig(IDX_DESPXA).active, "still active");

        // Name it with 0, close, then deactivate.
        recordAndApply(bucketVec(6_000, 4_000, 0));
        timelockExecute(address(fund), abi.encodeCall(fund.closePlan, ()));
        timelockExecute(address(fund), abi.encodeCall(fund.deactivateAsset, (IDX_DESPXA)));
        assertFalse(fund.assetConfig(IDX_DESPXA).active, "deactivated");
        assertEq(fund.targetBps()[IDX_DESPXA], 0, "inactive asset target 0");
        assertEq(fund.currentTargetBps()[IDX_DESPXA], 0, "deposits route nothing to it");

        deposit(makeAddr("alice"), 1_000e6);
        assertEq(IERC20Like(DESPXA).balanceOf(address(fund)), 0, "deposit bought no deSPXA");
    }

    /// @dev `addAsset` refuses a second active entry with the same asset id, for a Basket token and a Lending
    ///      adapter. After deactivation the same token may be re-added, and a vector naming it maps to the new
    ///      index.
    function test_addAsset_duplicateId_reverts_and_relist_maps_to_new_index() public fixtureCovered {
        AssetConfig memory b = AssetConfig({
            kind: AssetKind.Basket,
            active: true,
            capBps: 0,
            adapter: address(swapAdapter),
            token: DESPXA,
            pool: DESPXA_POOL,
            poolFee: POOL_FEE,
            twapWindow: TWAP_WINDOW,
            venue: Venue.V3
        });
        AssetConfig memory l = AssetConfig({
            kind: AssetKind.Lending,
            active: true,
            capBps: LENDING_CAP_BPS,
            adapter: address(aaveAdapter),
            token: address(0),
            pool: address(0),
            poolFee: 0,
            twapWindow: 0,
            venue: Venue.V3
        });
        bytes memory addB = abi.encodeCall(fund.addAsset, (b));
        _timelockExpectRevert(
            address(fund), addB, abi.encodeWithSelector(IRobotMoneyFund.DuplicateAsset.selector, IDX_DESPXA)
        );
        _timelockExpectRevert(
            address(fund),
            abi.encodeCall(fund.addAsset, (l)),
            abi.encodeWithSelector(IRobotMoneyFund.DuplicateAsset.selector, IDX_AAVE)
        );
        assertEq(fund.assetCount(), N_ASSETS, "no entry added");

        // Genesis target is 0, so deSPXA deactivates. The same token then lists again at a new index.
        timelockExecute(address(fund), abi.encodeCall(fund.deactivateAsset, (IDX_DESPXA)));
        timelockExecute(address(fund), addB);
        uint256 relisted = N_ASSETS;
        assertEq(fund.assetCount(), N_ASSETS + 1, "re-added");
        assertTrue(fund.assetConfig(relisted).active, "new entry active");

        // The vector names deSPXA by its token, so its weight lands on the new index.
        recordAndApply(_valid());
        uint16[] memory t = fund.targetBps();
        assertEq(t.length, N_ASSETS + 1, "target grew with the asset list");
        assertEq(t[IDX_DESPXA], 0, "old inactive entry target 0");
        assertEq(t[relisted], 1_000, "new entry carries the deSPXA weight");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev The refused vector reverts `err` through every door, releases nothing, and the same receipt then
    ///      applies with the valid vector.
    function _expectRefused(address[] memory ids, uint256[] memory w, bytes memory err) internal {
        bytes32 rid = _expectRefusedNoApply(ids, w, err);
        (address[] memory vIds, uint256[] memory vW) = assetArrays(_valid());
        _applyRaw(rid, vIds, vW);
        assertTrue(receipts.isReleased(rid), "the valid vector released the receipt");
        assertEq(fund.currentPlanId(), _planBase + 1, "the valid vector opened the plan");
        // Close it so the next refusal in the same test starts from no live plan and plan id stays countable.
        timelockExecute(address(fund), abi.encodeCall(fund.closePlan, ()));
        _planBase = fund.currentPlanId();
    }

    /// @dev Plans opened before the refusal under test (a test may refuse more than once).
    uint256 private _planBase;

    /// @dev Record a valid receipt, then refuse `(ids, w)` through `applyReceipt` (the timelock path),
    ///      `setTarget` and `previewPlan`. Returns the still-unreleased receipt.
    function _expectRefusedNoApply(address[] memory ids, uint256[] memory w, bytes memory err)
        internal
        returns (bytes32 rid)
    {
        bytes32 digest;
        (rid, digest) = recordReceipt(_valid());
        uint64 appliedBefore = governance.lastAppliedRecordedAt();
        _scheduleApply(rid, digest, ids, w, err);
        assertFalse(receipts.isReleased(rid), "refused vector released nothing");
        assertEq(fund.currentPlanId(), _planBase, "refused vector opened no plan");
        assertEq(governance.lastAppliedRecordedAt(), appliedBefore, "refused vector left lastApplied");

        PlanParams memory pp = PlanParams(PLAN_DURATION, COST_BUDGET_BPS);
        bytes memory data = abi.encodeCall(governance.setTarget, (ids, w, pp));
        bytes32 salt = keccak256(abi.encode("rb9", ++_salt));
        timelock.schedule(address(governance), 0, data, bytes32(0), salt, TIMELOCK_DELAY);
        vm.warp(block.timestamp + TIMELOCK_DELAY);
        vm.expectRevert(err);
        timelock.execute(address(governance), 0, data, bytes32(0), salt);
        assertEq(fund.currentPlanId(), _planBase, "refused setTarget opened no plan");

        vm.expectRevert(err);
        rebalancer.previewPlan(ids, w);
    }

    /// @dev Apply `rid` with `(ids, w)` through the timelock, expecting success.
    function _applyRaw(bytes32 rid, address[] memory ids, uint256[] memory w) internal {
        _scheduleApply(rid, receipts.getReceiptById(rid).payloadDigest, ids, w, "");
    }

    /// @dev Schedule `applyReceipt` on the timelock, wait the delay, execute. A non-empty `err` is the expected
    ///      revert data (the timelock bubbles the target's revert).
    function _scheduleApply(bytes32 rid, bytes32 digest, address[] memory ids, uint256[] memory w, bytes memory err)
        internal
    {
        bytes memory data = abi.encodeCall(governance.applyReceipt, (rid, digest, ids, w));
        bytes32 salt = keccak256(abi.encode("rb9", ++_salt));
        timelock.schedule(address(governance), 0, data, bytes32(0), salt, TIMELOCK_DELAY);
        vm.warp(block.timestamp + TIMELOCK_DELAY);
        if (err.length != 0) vm.expectRevert(err);
        timelock.execute(address(governance), 0, data, bytes32(0), salt);
    }

    /// @dev Schedule `data` on the timelock, wait the delay, and expect the execution to revert with `err`.
    function _timelockExpectRevert(address target, bytes memory data, bytes memory err) internal {
        bytes32 salt = keccak256(abi.encode("rb9-admin", ++_salt));
        timelock.schedule(target, 0, data, bytes32(0), salt, TIMELOCK_DELAY);
        vm.warp(block.timestamp + TIMELOCK_DELAY);
        vm.expectRevert(err);
        timelock.execute(target, 0, data, bytes32(0), salt);
    }

    function _append(address[] memory ids, uint256[] memory w, address id, uint256 bps)
        internal
        pure
        returns (address[] memory ids2, uint256[] memory w2)
    {
        uint256 n = ids.length;
        ids2 = new address[](n + 1);
        w2 = new uint256[](n + 1);
        for (uint256 i; i < n; ++i) {
            ids2[i] = ids[i];
            w2[i] = w[i];
        }
        ids2[n] = id;
        w2[n] = bps;
    }
}

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
}
