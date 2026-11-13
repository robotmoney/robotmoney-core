// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.4 (redemptions), §5.3 (step), §5.5 (plan lifecycle),
//            §4.1 (per-asset target vector), §7 (RB-1 to RB-9). Development plan Step 2.5 (gate G3), phase 3b.
// Experiment prototype only (contracts/test/prototype/). Not a production test.
// FROZEN BASELINE (one-vault scaffold, 2026-11-11): a copy of the step 3c synchronous fund and its tests. Never edit.
// It is the sim's synchronous arm and the target of the baseline attack tests. The live tree is contracts/test/prototype/src.
pragma solidity ^0.8.24;

import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {BaselineHarness} from "./BaselineHarness.sol";
import {
    Plan,
    PlanParams,
    PlanStatus,
    SkipReason,
    IFundEvents,
    IDLE_INDEX,
    BPS
} from "./src/FundTypes.sol";
import {IRebalanceGovernance} from "./src/interfaces/IRebalanceGovernance.sol";

/// @title Invariants
/// @notice One stateful invariant suite for the one-vault prototype (plan Step 2.5). The test contract is its own
///         handler, so every action runs through the same harness helpers the other prototype tests use (the
///         timelock path, the keeper, real Base venues). Actions: deposit, redeem, redeemInKind, apply a random
///         valid receipt through the timelock, keeper step, warp, price move, and an unauthorized plan-open
///         attempt. Each action records what it saw in ghost variables. The `invariant_*` functions assert:
///
///         - RB-1: no caller other than the timelock opens a plan (unauthorized attempts always revert).
///         - RB-2: `step()` takes no input (the handler calls the zero-argument selector; nothing else exists).
///         - RB-3 / INV-1: every token transfer out of a system address (fund, adapters, rebalancer, governance,
///           receipts) lands on an allowlisted venue, back in the fund, or (in a redemption) on the redeeming
///           holder or the fee recipient. Every pool payout during a fund action goes to the fund.
///         - RB-4: an executed step costs at most `maxStepCostBps` of its notional (TWAP NAV), and a plan's
///           `costSpent` stays within `costBudget` unless the plan is Halted. A Halted plan never steps.
///         - RB-5: no executed step before `lastStepAt + effectiveStepInterval`, and no Basket leg that failed
///           ORA-4 just before the step.
///         - RB-6: `redeemInKind` of a holder's own shares never reverts. `redeem` never reverts while every
///           Basket asset sits well inside its slippage band (plan state never blocks it).
///         - RB-7: an executed step's notional fits inside both legs' distance to `pathTarget(now)`, computed here
///           independently from the plan fields.
///         - RB-8: the receipt contract holds no assets and never calls the fund, the rebalancer or governance.
///         - RB-9: every apply action first sends five refused per-asset vectors for the same receipt, built from
///           the action's valid vector: an unlisted active asset, a duplicate, an unknown asset, a bad sum, and
///           a lending cap breach. Each must revert with its own error, release nothing, and open no plan. The
///           fund's persistent target always names every active asset and sums to 10 000 once a plan opened.
///         - Solvency: shares outstanding imply a positive `totalAssets`. The fund leaves no token allowance
///           standing to any spender it ever approved. The rebalancer and governance hold no assets.
///
///         Fixture coverage: `BaseFixture.fixtureCovered` reads the state-diff recording once, but an invariant
///         campaign interleaves many handler calls with many invariant checks. So in replay this suite also checks
///         coverage per action (`_coverage`), with the same rule as `BaseFixture._assertFixtureCovered`.
///         The fuzz seed is fixed so the record run and every replay make the same call sequences, and so
///         touch the same pool ticks and slots. A random seed would wander onto state the fixture never read.
/// forge-config: default.fuzz.seed = "0x6f6e652d7661756c74"
/// forge-config: default.invariant.dictionary-weight = 0
/// forge-config: default.invariant.runs = 16
/// forge-config: default.invariant.depth = 32
/// forge-config: default.invariant.fail-on-revert = true
contract Invariants is BaselineHarness {
    using Math for uint256;

    bytes32 private constant TRANSFER_SIG = keccak256("Transfer(address,address,uint256)");
    bytes32 private constant APPROVAL_SIG = keccak256("Approval(address,address,uint256)");
    bytes32 private constant STEP_EXECUTED_SIG = keccak256(
        "StepExecuted(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)"
    );
    bytes32 private constant IMPL_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    /// @dev `redeem` is only required to succeed while every Basket asset's spot sits this far inside the
    ///      fund's slippage ceiling: the remaining room covers the pool fee and the pro-rata sale's own impact.
    uint256 private constant REDEEM_MARGIN_BPS = 100;

    address[3] internal holders;
    address internal stranger = makeAddr("stranger");
    address internal receiptImpl;

    // ─── Ghosts (reset with the post-setUp snapshot at the start of every run) ───────────────────────────

    uint256 public ghostRedeemUnexpectedReverts;
    uint256 public ghostInKindReverts;
    uint256 public ghostApplyFailures;
    uint256 public ghostStepReverts;
    uint256 public ghostRb1Violations;
    uint256 public ghostRb4StepCost;
    uint256 public ghostRb4HaltedStepped;
    uint256 public ghostRb4BudgetNotHalted;
    uint256 public ghostRb5Cooldown;
    uint256 public ghostRb5Market;
    uint256 public ghostRb7PastPath;
    uint256 public ghostRb8Calls;
    uint256 public ghostRb9Violations;
    uint256 public ghostInv1Leaks;
    uint256 public ghostRedeemPayoutMismatch;
    /// @dev A keeper `step()` skipped NothingToTrade / BelowMinStep although, computed here independently,
    ///      some eligible holding sat over its path and another under it by at least `minStepUsdc`.
    uint256 public ghostLivenessSkips;
    address public ghostLeakFrom;
    address public ghostLeakTo;

    uint256 public callsDeposit;
    uint256 public callsRedeem;
    uint256 public callsRedeemInKind;
    uint256 public callsApply;
    uint256 public callsRb9Refused;
    uint256 public callsStep;
    uint256 public stepsExecuted;
    uint256 public callsWarp;
    uint256 public callsPrice;

    /// @dev Every (token, spender) the fund ever emitted an Approval for.
    address[] internal approvedToken;
    address[] internal approvedSpender;
    mapping(bytes32 => bool) internal approvalSeen;

    /// @dev Allowed recipients of a system transfer for the action in flight (see `_scanLogs`).
    mapping(address => bool) internal venueOk;
    mapping(address => bool) internal isSystem;
    address internal actionHolder;
    bool internal actionIsMarket;

    // ─── Fixture coverage (replay only; same rule as BaseFixture._assertFixtureCovered) ─────────────────

    mapping(address => bool) private _cvAccount;
    mapping(address => mapping(bytes32 => bool)) private _cvSlot;
    mapping(address => mapping(bytes32 => bool)) private _cvSeen;
    mapping(address => bool) private _cvCreated;
    address public coverageMissAccount;
    bytes32 public coverageMissSlot;
    bool public coverageMiss;

    function setUp() public override {
        super.setUp();
        holders[0] = makeAddr("alice");
        holders[1] = makeAddr("bob");
        holders[2] = makeAddr("carol");
        receiptImpl = address(uint160(uint256(vm.load(address(receipts), IMPL_SLOT))));

        address[8] memory sys = [
            address(fund),
            address(swapAdapter),
            address(aaveAdapter),
            address(cometAdapter),
            address(moonwellAdapter),
            address(rebalancer),
            address(governance),
            address(receipts)
        ];
        for (uint256 i; i < sys.length; ++i) {
            isSystem[sys[i]] = true;
        }
        address[11] memory venues = [
            address(fund),
            address(swapAdapter),
            address(aaveAdapter),
            address(cometAdapter),
            address(moonwellAdapter),
            WETH_POOL,
            CBBTC_POOL,
            DESPXA_POOL,
            AAVE_A_USDC,
            COMET,
            MOONWELL
        ];
        for (uint256 i; i < venues.length; ++i) {
            venueOk[venues[i]] = true;
        }

        // Seed: one holder with an all-idle position, then a plan, so the first steps trade for real.
        deposit(holders[0], 20_000e6);
        recordAndApply(bucketVec(6_000, 3_000, 1_000));
        // A day into the 7-day plan, so the very first steps of a run have real deviations to trade.
        vm.warp(block.timestamp + 1 days);

        if (fixtureCheck) {
            _loadCoverageIndex();
            _coverage(vm.stopAndReturnStateDiff());
        }
        vm.startStateDiffRecording();

        bytes4[9] memory sel = [
            this.act_deposit.selector,
            this.act_redeem.selector,
            this.act_redeemInKind.selector,
            this.act_apply.selector,
            this.act_step.selector,
            this.act_step.selector,
            this.act_warp.selector,
            this.act_movePrice.selector,
            this.act_unauthorizedOpen.selector
        ];
        bytes4[] memory selectors = new bytes4[](sel.length);
        for (uint256 i; i < sel.length; ++i) {
            selectors[i] = sel[i];
        }
        targetContract(address(this));
        targetSelector(FuzzSelector({addr: address(this), selectors: selectors}));
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Handler actions
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Opens the per-action recordings (logs for INV-1 / RB-4..7, state diff for RB-8 and coverage).
    modifier action(address holder, bool market) {
        vm.startStateDiffRecording();
        vm.recordLogs();
        actionHolder = holder;
        actionIsMarket = market;
        _;
        _scanLogs(vm.getRecordedLogs());
        _scanAccesses(vm.stopAndReturnStateDiff());
        actionHolder = address(0);
        actionIsMarket = false;
    }

    /// @notice Deposit `amt` (100 to 20k USDC) for a holder. May revert legitimately (caps, ORA-4, floors).
    function act_deposit(uint256 who, uint256 amt) external action(address(0), false) {
        address h = holders[who % holders.length];
        amt = bound(amt, 100e6, 20_000e6);
        fundUsdc(h, amt);
        vm.startPrank(h);
        IERC20(USDC).approve(address(fund), amt);
        try fund.deposit(amt, h) {
            ++callsDeposit;
        } catch {}
        IERC20(USDC).approve(address(fund), 0);
        vm.stopPrank();
    }

    /// @notice RB-6: a holder redeems a slice of its own shares to itself. Must succeed unless a Basket spot sits
    ///         near the slippage ceiling (a market state, not a plan state). Checks the payout reached the holder.
    function act_redeem(uint256 who, uint256 frac) external {
        address h = holders[who % holders.length];
        uint256 bal = IERC20(address(fund)).balanceOf(h);
        if (bal == 0) return;
        _redeem(h, bound(frac, 1, bal));
    }

    /// @dev `calm` is read inside the `action` recording, so its pool reads are fixture-coverage checked.
    function _redeem(address h, uint256 shares) private action(h, false) {
        bool calm = _marketsCalm();
        uint256 before = IERC20(USDC).balanceOf(h);
        vm.prank(h);
        try fund.redeem(shares, h, h) returns (uint256 net) {
            ++callsRedeem;
            if (IERC20(USDC).balanceOf(h) != before + net) ++ghostRedeemPayoutMismatch;
        } catch {
            if (calm) ++ghostRedeemUnexpectedReverts;
        }
    }

    /// @notice RB-6: `redeemInKind` of a holder's own shares never reverts, whatever the plan or the market.
    function act_redeemInKind(uint256 who, uint256 frac) external {
        address h = holders[who % holders.length];
        uint256 bal = IERC20(address(fund)).balanceOf(h);
        if (bal == 0) return;
        _redeemInKind(h, bound(frac, 1, bal));
    }

    function _redeemInKind(address h, uint256 shares) private action(h, false) {
        vm.prank(h);
        try fund.redeemInKind(shares, h, h) {
            ++callsRedeemInKind;
        } catch {
            ++ghostInKindReverts;
        }
    }

    /// @notice Record a random valid receipt. First send each refused variant of its vector (RB-9), then apply the
    ///         valid vector through the timelock (RB-1's only path). A valid receipt never fails to open a plan.
    function act_apply(uint256 a, uint256 b) external action(address(0), false) {
        uint16 stable = uint16(bound(a, 0, BPS));
        uint16 protocol = uint16(bound(b, 0, BPS - stable));
        uint16 rwa = uint16(BPS - stable - protocol);
        uint16[6] memory v = bucketVec(stable, protocol, rwa);
        (bytes32 id, bytes32 digest) = recordReceipt(v);
        for (uint256 kind; kind < 6; ++kind) {
            _refuseBadVector(id, digest, v, kind);
        }
        uint256 prevId = fund.currentPlanId();
        try this.applyExternal(id, digest, v) {
            ++callsApply;
            if (fund.currentPlanId() != prevId + 1 || fund.planStatus() != PlanStatus.Open) {
                ++ghostApplyFailures;
            }
        } catch {
            ++ghostApplyFailures;
        }
    }

    /// @dev External hop so a failed timelock execution can be caught. Only this contract may call it.
    function applyExternal(bytes32 id, bytes32 digest, uint16[6] memory bps) external {
        require(msg.sender == address(this), "self only");
        applyReceiptViaTimelock(id, digest, bps);
    }

    /// @dev RB-9: send the timelock's `applyReceipt` call for receipt `id` with a refused variant of the valid
    ///      vector `v`, as the timelock (the call the timelock would execute, with no schedule and no warp, so the
    ///      run's time line and pool reads are unchanged). `kind` picks the variant: 0 an active asset left out
    ///      (its weight moved to a basket asset), 1 a duplicate entry, 2 an unknown asset, 3 a sum of 10 001,
    ///      4 a lending target above `capBps`, 5 the valid vector with a wrong payload digest. The call must
    ///      revert with exactly that variant's error, the receipt must stay unreleased, and no plan or applied
    ///      time may change.
    function _refuseBadVector(bytes32 id, bytes32 digest, uint16[6] memory v, uint256 kind)
        private
    {
        address[] memory ids;
        uint256[] memory w;
        bytes memory expected;
        bytes32 sent = digest;
        if (kind == 5) {
            (ids, w) = assetArrays(v);
            sent = keccak256("wrong");
            expected = abi.encodeWithSelector(
                IRebalanceGovernance.PayloadDigestMismatch.selector, id, digest, sent
            );
        } else {
            (ids, w, expected) = _badVector(v, kind);
        }
        uint256 prevId = fund.currentPlanId();
        uint64 prevApplied = governance.lastAppliedRecordedAt();
        vm.prank(address(timelock));
        try governance.applyReceipt(id, sent, ids, w) {
            ++ghostRb9Violations;
        } catch (bytes memory err) {
            if (keccak256(err) != keccak256(expected)) ++ghostRb9Violations;
        }
        if (receipts.isReleased(id) || fund.currentPlanId() != prevId) ++ghostRb9Violations;
        if (governance.lastAppliedRecordedAt() != prevApplied) ++ghostRb9Violations;
        ++callsRb9Refused;
    }

    /// @dev The refused variant `kind` of `v` (see `_refuseBadVector`) and the exact revert data it must raise.
    function _badVector(uint16[6] memory v, uint256 kind)
        private
        view
        returns (address[] memory ids, uint256[] memory w, bytes memory expected)
    {
        (ids, w) = assetArrays(v);
        if (kind == 0) {
            // Leave out deSPXA. Its weight moves to wETH, so the sum stays 10 000 and no cap is hit.
            address[] memory ids5 = new address[](N_ASSETS - 1);
            uint256[] memory w5 = new uint256[](N_ASSETS - 1);
            for (uint256 i; i < N_ASSETS - 1; ++i) {
                ids5[i] = ids[i];
                w5[i] = w[i];
            }
            w5[IDX_WETH] += w[IDX_DESPXA];
            return
                (ids5, w5, abi.encodeWithSelector(IFundEvents.TargetAssetMissing.selector, DESPXA));
        }
        if (kind == 1 || kind == 2) {
            // Append a zero-weight entry: aave again (duplicate), or an address that is no fund asset.
            address extra = kind == 1 ? ids[IDX_AAVE] : stranger;
            address[] memory ids7 = new address[](N_ASSETS + 1);
            uint256[] memory w7 = new uint256[](N_ASSETS + 1);
            for (uint256 i; i < N_ASSETS; ++i) {
                ids7[i] = ids[i];
                w7[i] = w[i];
            }
            ids7[N_ASSETS] = extra;
            bytes4 sel = kind == 1
                ? IFundEvents.TargetAssetDuplicate.selector
                : IFundEvents.TargetAssetNotActive.selector;
            return (ids7, w7, abi.encodeWithSelector(sel, extra));
        }
        if (kind == 3) {
            w[IDX_WETH] += 1;
            return (ids, w, abi.encodeWithSelector(IFundEvents.TargetSumInvalid.selector, BPS + 1));
        }
        // Aave is the first entry, so its cap check fires before the sum check.
        w[IDX_AAVE] = LENDING_CAP_BPS + 1;
        expected = abi.encodeWithSelector(
            IFundEvents.TargetExceedsCap.selector,
            IDX_AAVE,
            uint256(LENDING_CAP_BPS) + 1,
            uint256(LENDING_CAP_BPS)
        );
    }

    /// @notice One keeper `step()` (optionally after one effective interval). Checks RB-4, RB-5 and RB-7 against
    ///         the state just before the call.
    function act_step(bool warpFirst) external {
        if (warpFirst) vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
        _step();
    }

    struct Pre {
        PlanStatus status;
        uint256 readyAt;
        uint256 nav;
        uint256 idle;
        uint256[] values;
        bool[] marketOk;
        Plan plan;
    }

    function _step() private action(address(0), false) {
        Pre memory pre;
        pre.status = fund.planStatus();
        pre.readyAt = uint256(fund.lastStepAt()) + rebalancer.effectiveStepInterval();
        (pre.nav, pre.idle, pre.values) = fund.portfolioValues();
        pre.marketOk = new bool[](N_ASSETS);
        for (uint256 i; i < N_ASSETS; ++i) {
            (pre.marketOk[i],) = fund.marketCheck(i);
        }
        pre.plan = fund.plan();

        ++callsStep;
        bool ready = _independentlyReady(pre);
        vm.prank(keeper);
        try rebalancer.step() returns (bool executed, SkipReason why) {
            if (executed) {
                _checkExecutedStep(pre);
            } else if (
                ready && (why == SkipReason.NothingToTrade || why == SkipReason.BelowMinStep)
            ) {
                ++ghostLivenessSkips;
            }
        } catch {
            ++ghostStepReverts;
        }
        Plan memory p = fund.plan();
        if (p.costSpent > p.costBudget && p.status != PlanStatus.Halted) ++ghostRb4BudgetNotHalted;
    }

    function _checkExecutedStep(Pre memory pre) private {
        ++stepsExecuted;
        if (pre.status != PlanStatus.Open) ++ghostRb4HaltedStepped;
        if (block.timestamp < pre.readyAt) ++ghostRb5Cooldown;

        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        // Re-arm so the action modifier still sees this step's transfers.
        vm.recordLogs();
        _scanLogs(logs);
        for (uint256 k; k < logs.length; ++k) {
            if (logs[k].emitter != address(fund) || logs[k].topics[0] != STEP_EXECUTED_SIG) {
                continue;
            }
            (
                uint256 sellI,
                uint256 buyI,
                uint256 notional,,,,
                uint256 navBefore,
                uint256 navAfter,
                uint256 cost
            ) = abi.decode(
                logs[k].data,
                (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)
            );

            // RB-4: TWAP NAV falls at most maxStepCostBps of the notional, measured by the fund and by us.
            uint256 maxCost = notional.mulDiv(MAX_STEP_COST_BPS, BPS);
            if (cost > maxCost || navBefore != pre.nav || navAfter + maxCost < navBefore) {
                ++ghostRb4StepCost;
            }
            if (fund.totalAssets() + maxCost < pre.nav) ++ghostRb4StepCost;

            // RB-5: no traded Basket asset failed ORA-4 just before the step.
            if (sellI != IDLE_INDEX && !pre.marketOk[sellI]) ++ghostRb5Market;
            if (buyI != IDLE_INDEX && !pre.marketOk[buyI]) ++ghostRb5Market;

            // RB-7: the notional fits between each leg's holding and its pathTarget(now) value.
            uint256 v = sellI == IDLE_INDEX ? pre.idle : pre.values[sellI];
            uint256 t = _pathValue(pre.plan, sellI, block.timestamp, pre.nav);
            if (v < t + notional) ++ghostRb7PastPath;
            if (buyI != IDLE_INDEX) {
                v = pre.values[buyI];
                t = _pathValue(pre.plan, buyI, block.timestamp, pre.nav);
                if (t < v + notional) ++ghostRb7PastPath;
            }
        }
    }

    /// @notice Time passes (1 minute to 2 days): cooldowns lapse, paths advance, plans end or expire.
    function act_warp(uint256 dt) external {
        ++callsWarp;
        vm.warp(block.timestamp + bound(dt, 1 minutes, 2 days));
    }

    /// @notice An outside trader moves a basket pool. wETH both ways (deal verified); cbBTC and deSPXA buys only.
    function act_movePrice(uint256 which, uint256 usdc, bool buy)
        external
        action(address(0), true)
    {
        which = which % 3;
        address pool = which == 0 ? WETH_POOL : which == 1 ? CBBTC_POOL : DESPXA_POOL;
        uint256 hi = which == 2 ? 5_000e6 : 500_000e6;
        usdc = bound(usdc, 100e6, hi);
        if (which != 0) buy = true;
        try this.movePriceExternal(pool, usdc, buy) {
            ++callsPrice;
        } catch {}
    }

    function movePriceExternal(address pool, uint256 usdc, bool buy) external {
        require(msg.sender == address(this), "self only");
        movePrice(pool, usdc, buy);
    }

    /// @notice RB-1: no account but the timelock can set a target or open a plan, by any of the three doors.
    function act_unauthorizedOpen(uint256 who, uint256 a) external action(address(0), false) {
        address[4] memory callers = [stranger, keeper, submitter, holders[who % holders.length]];
        address c = callers[a % callers.length];
        (address[] memory s, uint256[] memory w) = assetArrays(bucketVec(10_000, 0, 0));
        PlanParams memory pp = PlanParams(PLAN_DURATION, COST_BUDGET_BPS);
        uint256 prevId = fund.currentPlanId();

        vm.prank(c);
        try governance.setTarget(s, w, pp) {
            ++ghostRb1Violations;
        } catch {}
        vm.prank(c);
        try governance.applyReceipt(bytes32(a), bytes32(0), s, w) {
            ++ghostRb1Violations;
        } catch {}
        vm.prank(c);
        try fund.setTargetAndOpenPlan(s, w, pp, bytes32(0)) {
            ++ghostRb1Violations;
        } catch {}
        if (fund.currentPlanId() != prevId) ++ghostRb1Violations;
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Invariants
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice RB-1, RB-6, RB-8 and the per-action ghosts: actions that must never fail did not.
    function invariant_mustNotRevert() public fixtureCovered {
        assertEq(ghostInKindReverts, 0, "RB-6: redeemInKind of own shares reverted");
        assertEq(ghostRedeemUnexpectedReverts, 0, "RB-6: redeem reverted in a calm market");
        assertEq(ghostRedeemPayoutMismatch, 0, "redeem: holder did not receive the returned net");
        assertEq(ghostApplyFailures, 0, "valid receipt failed to open a plan through the timelock");
        assertEq(ghostStepReverts, 0, "keeper step() reverted (must skip, not revert)");
        assertEq(ghostRb1Violations, 0, "RB-1: a non-timelock caller opened a plan");
        if (coverageMiss) revert FixtureSlotMiss(coverageMissAccount, coverageMissSlot);
    }

    /// @notice RB-4, RB-5, RB-7 on every executed step; RB-4 budget on every plan.
    function invariant_stepBounds() public fixtureCovered {
        assertEq(ghostRb4StepCost, 0, "RB-4: a step cost more than maxStepCostBps of its notional");
        assertEq(ghostRb4HaltedStepped, 0, "RB-4: a non-Open (Halted) plan stepped");
        assertEq(ghostRb4BudgetNotHalted, 0, "RB-4: budget exceeded without a halt");
        assertEq(ghostRb5Cooldown, 0, "RB-5: a step ran before stepInterval");
        assertEq(ghostRb5Market, 0, "RB-5: a step traded an asset failing ORA-4");
        assertEq(ghostRb7PastPath, 0, "RB-7: a step moved past pathTarget(now)");
        assertEq(
            ghostLivenessSkips,
            0,
            "liveness: a step with a tradeable deviation skipped as nothing to trade"
        );
        Plan memory p = fund.plan();
        assertTrue(
            p.costSpent <= p.costBudget || p.status == PlanStatus.Halted,
            "RB-4: costSpent > costBudget"
        );
    }

    /// @notice RB-9: every refused vector reverted with its own error and released nothing. The fund's persistent
    ///         target names every active asset (inactive assets 0) and sums to 10 000 once a plan has opened.
    function invariant_targetVector() public fixtureCovered {
        assertEq(
            ghostRb9Violations,
            0,
            "RB-9: a refused vector did not revert with its error, or released"
        );
        if (fund.currentPlanId() == 0) return;
        uint16[] memory t = fund.targetBps();
        assertEq(t.length, fund.assetCount(), "RB-9: target is index-aligned to the asset list");
        uint256 sum;
        for (uint256 i; i < t.length; ++i) {
            if (!fund.assetConfig(i).active) {
                assertEq(t[i], 0, "RB-9: inactive asset has a target");
            }
            sum += t[i];
        }
        assertEq(sum, BPS, "RB-9: target does not sum to 10 000");
    }

    /// @notice RB-3 / INV-1: no asset left a system address for a non-holder, non-venue recipient.
    function invariant_noLeak() public fixtureCovered {
        if (ghostInv1Leaks != 0) {
            emit log_named_address("leak from", ghostLeakFrom);
            emit log_named_address("leak to", ghostLeakTo);
        }
        assertEq(ghostInv1Leaks, 0, "INV-1 / RB-3: asset left to a non-holder recipient");
    }

    /// @notice RB-8: the receipt contract never called the fund, rebalancer or governance, and holds nothing.
    function invariant_receiptInert() public fixtureCovered {
        assertEq(
            ghostRb8Calls, 0, "RB-8: receipt contract called the fund, rebalancer or governance"
        );
        _assertHoldsNothing(address(receipts), "RB-8: receipts");
    }

    /// @notice Shares outstanding are backed; the rebalancer and governance hold nothing; no standing allowance.
    function invariant_solvencyAndHygiene() public fixtureCovered {
        if (fund.totalSupply() > 0) {
            assertGt(fund.totalAssets(), 0, "supply > 0 but totalAssets == 0");
        }
        _assertHoldsNothing(address(rebalancer), "rebalancer");
        _assertHoldsNothing(address(governance), "governance");
        for (uint256 i; i < approvedToken.length; ++i) {
            assertEq(
                IERC20(approvedToken[i]).allowance(address(fund), approvedSpender[i]),
                0,
                "fund left an allowance"
            );
        }
        address[4] memory tokens = [USDC, WETH, CBBTC, DESPXA];
        address[5] memory spenders = [
            address(swapAdapter),
            ROUTER,
            address(aaveAdapter),
            address(cometAdapter),
            address(moonwellAdapter)
        ];
        for (uint256 i; i < tokens.length; ++i) {
            for (uint256 j; j < spenders.length; ++j) {
                assertEq(
                    IERC20(tokens[i]).allowance(address(fund), spenders[j]),
                    0,
                    "fund allowance to venue"
                );
            }
        }
    }

    /// @notice Per-run activity summary (shown with -vv). Guards against a vacuous run: handlers may not revert
    ///      outside their own try blocks (`fail-on-revert = true`, so no action is silently dropped), the run
    ///      did something, and `ghostLivenessSkips` (checked in `invariant_stepBounds`) proves a step that had
    ///      a tradeable deviation was never skipped as "nothing to trade", so RB-4/5/7 are exercised whenever
    ///      a step could run.
    function afterInvariant() public fixtureCovered {
        assertGt(
            callsDeposit + callsRedeem + callsRedeemInKind + callsApply + callsStep,
            0,
            "run did nothing"
        );
        emit log_named_string(
            "run",
            string.concat(
                "deposits ",
                vm.toString(callsDeposit),
                ", redeems ",
                vm.toString(callsRedeem),
                ", inKind ",
                vm.toString(callsRedeemInKind),
                ", applies ",
                vm.toString(callsApply),
                ", rb9Refused ",
                vm.toString(callsRb9Refused),
                ", steps ",
                vm.toString(stepsExecuted),
                "/",
                vm.toString(callsStep),
                ", priceMoves ",
                vm.toString(callsPrice)
            )
        );
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Internals
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function _assertHoldsNothing(address who, string memory label) private view {
        address[6] memory tokens = [USDC, WETH, CBBTC, DESPXA, AAVE_A_USDC, address(fund)];
        for (uint256 i; i < tokens.length; ++i) {
            assertEq(IERC20(tokens[i]).balanceOf(who), 0, label);
        }
    }

    /// @dev Independent of `PlanMath.pickLegs`: the plan is Open and before its end (no conclusion pending), the
    ///      cooldown has passed, and among idle and the eligible assets (active, `maxStepUsdc > 0`, not backed
    ///      off, ORA-4 ok) one sits over its path value and one under it, each by at least `minStepUsdc`. Every
    ///      non-zero `maxStepUsdc` is at least `minStepUsdc` (a `setAssetStepParams` bound), so such a step's
    ///      notional is at least `minStepUsdc` and it must not skip NothingToTrade or BelowMinStep.
    function _independentlyReady(Pre memory pre) private view returns (bool) {
        if (pre.status != PlanStatus.Open || block.timestamp < pre.readyAt) return false;
        if (block.timestamp >= pre.plan.endTime) return false;
        uint256 minStep = rebalancer.stepParams().minStepUsdc;
        uint256 t = _pathValue(pre.plan, IDLE_INDEX, block.timestamp, pre.nav);
        uint256 maxOver = pre.idle > t ? pre.idle - t : 0;
        uint256 maxUnder = t > pre.idle ? t - pre.idle : 0;
        for (uint256 i; i < N_ASSETS; ++i) {
            if (!pre.marketOk[i] || rebalancer.assetStepParams(i).maxStepUsdc == 0) continue;
            if (rebalancer.assetBackoffUntil(i) >= block.timestamp || !fund.assetConfig(i).active) {
                continue;
            }
            t = _pathValue(pre.plan, i, block.timestamp, pre.nav);
            uint256 v = pre.values[i];
            if (v > t && v - t > maxOver) maxOver = v - t;
            if (t > v && t - v > maxUnder) maxUnder = t - v;
        }
        return maxOver >= minStep && maxUnder >= minStep;
    }

    /// @dev Every Basket asset's spot within `maxSlippageBps − REDEEM_MARGIN_BPS` of its TWAP.
    function _marketsCalm() private view returns (bool) {
        uint256 room = fund.maxSlippageBps() - REDEEM_MARGIN_BPS;
        for (uint256 i = IDX_WETH; i < N_ASSETS; ++i) {
            (bool ok, uint256 dev) = fund.marketCheck(i);
            if (!ok || dev > room) return false;
        }
        return true;
    }

    /// @dev Independent port of the §5.2 path value: `nav × (start×d + (end−start)×e) / (d × 10 000)`, the
    ///      shrinking side rounded up (toward start). Idle's path ends at 0.
    function _pathValue(Plan memory p, uint256 index, uint256 t, uint256 nav)
        private
        pure
        returns (uint256)
    {
        uint256 e;
        uint256 d;
        if (p.endTime <= p.startTime) {
            (e, d) = (1, 1);
        } else {
            d = p.endTime - p.startTime;
            e = t <= p.startTime ? 0 : Math.min(t - p.startTime, d);
        }
        uint256 s0 = index == IDLE_INDEX ? p.startIdleBps : p.startBps[index];
        uint256 s1 = index == IDLE_INDEX ? 0 : p.endBps[index];
        if (s1 >= s0) return nav.mulDiv(s0 * d + (s1 - s0) * e, d * BPS);
        return nav.mulDiv(s0 * d - (s0 - s1) * e, d * BPS, Math.Rounding.Ceil);
    }

    /// @dev INV-1 / RB-3 over one action's logs. A Transfer out of a system address must land on a venue (or the
    ///      fund), on the redeeming holder, the fee recipient, or address(0) (a venue receipt-token burn). During a
    ///      fund action, a pool pays only the fund. Approvals by the fund are remembered for the allowance check.
    function _scanLogs(VmSafe.Log[] memory logs) private {
        for (uint256 k; k < logs.length; ++k) {
            VmSafe.Log memory l = logs[k];
            if (l.topics.length != 3) continue;
            address from = address(uint160(uint256(l.topics[1])));
            address to = address(uint160(uint256(l.topics[2])));
            if (l.topics[0] == APPROVAL_SIG) {
                if (from != address(fund)) continue;
                bytes32 key = keccak256(abi.encode(l.emitter, to));
                if (!approvalSeen[key]) {
                    approvalSeen[key] = true;
                    approvedToken.push(l.emitter);
                    approvedSpender.push(to);
                }
                continue;
            }
            if (l.topics[0] != TRANSFER_SIG) continue;
            if (isSystem[from]) {
                bool ok = venueOk[to] || to == feeRecipient
                    || (to == actionHolder && actionHolder != address(0))
                    || (to == address(0) && from != address(fund));
                if (!ok) _leak(from, to);
            } else if (
                !actionIsMarket && (from == WETH_POOL || from == CBBTC_POOL || from == DESPXA_POOL)
            ) {
                if (to != address(fund)) _leak(from, to);
            }
        }
    }

    function _leak(address from, address to) private {
        ++ghostInv1Leaks;
        ghostLeakFrom = from;
        ghostLeakTo = to;
    }

    /// @dev RB-8 over one action's state diff (the receipt proxy or its implementation never touches the fund,
    ///      rebalancer or governance), then the fixture coverage check in replay.
    function _scanAccesses(VmSafe.AccountAccess[] memory acc) private {
        for (uint256 i; i < acc.length; ++i) {
            VmSafe.AccountAccess memory x = acc[i];
            if (x.accessor != address(receipts) && x.accessor != receiptImpl) continue;
            if (
                x.account == address(fund) || x.account == address(rebalancer)
                    || x.account == address(governance)
            ) {
                ++ghostRb8Calls;
            }
        }
        if (fixtureCheck) _coverage(acc);
    }

    function _loadCoverageIndex() private {
        // Parsed once, unmetered: a parse per account copies the whole meta file per account (BaseFixture).
        vm.pauseGasMetering();
        string memory meta = vm.readFile(META_PATH);
        address[] memory accounts = vm.parseJsonAddressArray(meta, ".accounts");
        bytes32[][] memory slots = abi.decode(vm.parseJson(meta, ".slots"), (bytes32[][]));
        require(slots.length == accounts.length, "fixture meta: one slot list per account");
        for (uint256 i; i < accounts.length; ++i) {
            _cvAccount[accounts[i]] = true;
            for (uint256 j; j < slots[i].length; ++j) {
                _cvSlot[accounts[i]][slots[i][j]] = true;
            }
        }
        vm.resumeGasMetering();
    }

    /// @dev Same rule as `BaseFixture._assertFixtureCovered`, but records the first miss for the invariant to
    ///      report (a revert inside a handler would be swallowed by `fail-on-revert = false`).
    function _coverage(VmSafe.AccountAccess[] memory acc) private {
        for (uint256 i; i < acc.length; ++i) {
            if (acc[i].kind == VmSafe.AccountAccessKind.Create) {
                _cvCreated[acc[i].account] = true;
                _created[acc[i].account] = true; // BaseFixture's own check never sees this part of the diff
            }
        }
        for (uint256 i; i < acc.length; ++i) {
            VmSafe.AccountAccess memory x = acc[i];
            bool isCall = x.kind == VmSafe.AccountAccessKind.Call
                || x.kind == VmSafe.AccountAccessKind.StaticCall
                || x.kind == VmSafe.AccountAccessKind.DelegateCall;
            if (
                isCall && x.data.length != 0 && !_cvAccount[x.account] && !_cvCreated[x.account]
                    && uint160(x.account) > 0xffff && x.account.code.length == 0
            ) _miss(x.account, bytes32(0));
            for (uint256 j; j < x.storageAccesses.length; ++j) {
                VmSafe.StorageAccess memory s = x.storageAccesses[j];
                if (!_cvAccount[s.account] || _cvCreated[s.account] || _cvSeen[s.account][s.slot]) {
                    continue;
                }
                _cvSeen[s.account][s.slot] = true;
                if (!s.isWrite && !_cvSlot[s.account][s.slot]) _miss(s.account, s.slot);
            }
        }
    }

    function _miss(address account, bytes32 slot) private {
        if (coverageMiss) return;
        coverageMiss = true;
        coverageMissAccount = account;
        coverageMissSlot = slot;
    }
}
