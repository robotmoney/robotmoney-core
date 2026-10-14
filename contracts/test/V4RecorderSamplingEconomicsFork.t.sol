// SPDX-License-Identifier: MIT
// Canonical: docs/code-review/20261014-code-review-internal-claude-v4-sampling-economics.md (the written severity decision)
//            docs/code-review/20261012-security-review.md ("Open review item: V4 sampling", PR 1787)
//            docs/adr/ADR-0005-basketvault-multi-dex-routing.md (2026-10-08 amendment: V4 venue and price recorder)
//            docs/operations/contract-release-runbooks.md (Recorder keeper, issue 1779)
// Covers core issue 1793: can sampling the V4 recorder distort the rmAGENT NAV profitably?
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ForkSelect} from "./helpers/ForkSelect.sol";
import {BasketVault} from "../vaults/BasketVault.sol";
import {UniswapV4PriceRecorder} from "../adapters/UniswapV4PriceRecorder.sol";
import {UniswapV4SwapAdapter} from "../adapters/UniswapV4SwapAdapter.sol";
import {TwapTickMath} from "../lib/TwapTickMath.sol";

/// @notice Fork test on the Twin chain (a pinned lazy anvil fork of real Base). It drives the DEPLOYED rmAGENT vault, the
///         DEPLOYED price recorder and the live RM/USDC V4 pool, so the pool depth, the ring size (901), the NAV deviation
///         guard (100 bps), the swap bound (500 bps), the per-deposit cap (15 USDC) and the TVL cap (100 USDC) are the
///         production values. With FORK_RPC_URL unset the test skips with a named reason (ForkSelect). With it set, a
///         missing vault or an unreachable endpoint FAILS the test.
///
///         Every scenario runs twice from one snapshot: a BASELINE where the attacker only deposits and redeems, and an
///         ATTACK where the attacker first pushes the pool, samples the recorder, and restores the pool. The attacker
///         profit is the difference of the two end USDC balances, so every swap fee and every price impact of the attack is
///         inside the number. The fork has no arbitrageurs, so every cost here is a LOWER bound on the real cost.
contract V4RecorderSamplingEconomicsForkTest is Test {
    using stdJson for string;

    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant VAULT = 0x22bD48C56c34A2C1C1baC77BD7c4E636a6f10D57;
    address internal constant RECORDER = 0x0aDc14e6521aF213F9DCe5585D530f237831E934;
    address internal constant ADAPTER = 0xC1e35f6281bE5B58f0A0E7Ed012D444D4cf72030;

    /// @dev Keeper cadence from core 1779 (scripts/ops/recorder-keeper.sh INTERVAL_SECS default).
    uint256 internal constant KEEPER_INTERVAL = 240;
    /// @dev Clamp: one record moves the recorded tick by at most 10 ticks per second for at most 60 s.
    int256 internal constant MAX_STEP = 600;

    /// @dev Existing holders' value: the 100 USDC TVL cap less 20 USDC of headroom: a mark up to 25 percent high still leaves room for one maximal deposit.
    uint256 internal constant HOLDER_TVL = 80e6;

    BasketVault internal vault = BasketVault(VAULT);
    UniswapV4PriceRecorder internal rec = UniswapV4PriceRecorder(RECORDER);
    UniswapV4SwapAdapter internal adapter = UniswapV4SwapAdapter(ADAPTER);
    address internal rm;
    uint24 internal poolFee;

    /// @dev Set by `_cycle240`: the attack swaps' own wealth change (fees and impact), and the attacker's mint fairness gap.
    int256 internal lastAttackCost;
    int256 internal lastMintGapBps;

    address internal victim = makeAddr("victim");
    address internal attacker = makeAddr("attacker");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (!ForkSelect.selectOrSkip(rpc)) return;
        assertGt(VAULT.code.length, 0, "the deployed rmAGENT vault must exist at the pin");
        assertGt(RECORDER.code.length, 0, "the deployed recorder must exist at the pin");

        string memory cfg = vm.readFile("config/agent-token-shortlist.json");
        rm = cfg.readAddress(".shortlist[0].token");
        poolFee = uint24(cfg.readUint(".shortlist[0].poolFee"));

        // The production configuration this report is about. A drift fails here, so the report cannot go stale silently.
        assertEq(vault.navDeviationGuardBps(), 100, "production NAV deviation guard is 100 bps");
        assertEq(vault.maxSlippageBps(), 500, "production swap bound is 500 bps");
        assertEq(vault.perDepositCap(), 15e6, "production per-deposit cap is 15 USDC");
        assertEq(vault.tvlCap(), 100e6, "production TVL cap is 100 USDC");
        (,,, uint16 cardinality) = rec.slot0();
        assertEq(uint256(cardinality), 901, "production ring is 901 slots");

        // Honest history: one record a minute for just over a window. The live tick is untouched, so the ring is flat.
        for (uint256 i = 0; i < 32; i++) {
            vm.warp(block.timestamp + 60);
            rec.record();
        }
        // Existing holders: the vault filled to the TVL cap less headroom, so the attacker can still deposit the
        // per-deposit cap. RM is dealt to the vault and shares to the victim at the mark.
        deal(rm, VAULT, vault.assetTokenValue(0, HOLDER_TVL));
        deal(VAULT, victim, HOLDER_TVL * 1e18, true);
    }

    // ─── helpers ─────────────────────────────────────────────────────

    function _liveTick() internal view returns (int24 t) {
        (, t,,) = rec.slot0();
    }

    function _recordedTick() internal view returns (int24 t) {
        (t,,,,) = rec.latest();
    }

    function _swap(address who, address tokenIn, address tokenOut, uint256 amountIn)
        internal
        returns (uint256 out)
    {
        vm.startPrank(who);
        IERC20(tokenIn).approve(ADAPTER, amountIn);
        out = adapter.swap(tokenIn, tokenOut, poolFee, amountIn, 0, who, block.timestamp);
        vm.stopPrank();
    }

    /// @dev Push the live tick by `ticks` (positive buys RM with USDC, negative sells RM). Uses the attacker budget.
    function _push(address who, int256 ticks) internal {
        int256 target = int256(_liveTick()) + ticks;
        // Size a first swap from the pool liquidity: USDC in ~ L * dSqrtP / 2^96, with dSqrtP/sqrtP = ticks / 20000.
        (uint160 sqrtP,,,) = rec.slot0();
        uint256 L = rec.liquidity();
        uint256 mag = uint256(ticks < 0 ? -ticks : ticks);
        uint256 usdcNeeded = (L * uint256(sqrtP) / (1 << 96)) * mag / 20_000;
        usdcNeeded = usdcNeeded * 1_000_000 / (1_000_000 - poolFee);
        for (uint256 i = 0; i < 60; i++) {
            int256 t = int256(_liveTick());
            if (ticks > 0 ? t >= target : t <= target) break;
            uint256 step = i == 0 ? (usdcNeeded * 9 / 10) : (usdcNeeded / 50 + 1);
            if (ticks > 0) _swap(who, USDC, rm, step);
            else _swap(who, rm, USDC, vault.assetTokenValue(0, step));
        }
    }

    /// @dev Trade back until the live tick is within `tolerance` ticks of `tick0`.
    function _restore(address who, int24 tick0, int256 tolerance) internal {
        for (uint256 i = 0; i < 80; i++) {
            int256 gap = int256(_liveTick()) - int256(tick0);
            if (gap <= tolerance && gap >= -tolerance) return;
            (uint160 sqrtP,,,) = rec.slot0();
            uint256 mag = uint256(gap < 0 ? -gap : gap);
            uint256 usdcStep = (rec.liquidity() * uint256(sqrtP) / (1 << 96)) * mag / 20_000;
            usdcStep = usdcStep * 1_000_000 / (1_000_000 - poolFee);
            usdcStep = i < 3 ? usdcStep * 9 / 10 : usdcStep / 2 + 1;
            if (gap > 0) _swap(who, rm, USDC, vault.assetTokenValue(0, usdcStep));
            else _swap(who, USDC, rm, usdcStep);
        }
        revert("restore did not converge");
    }

    /// @dev USDC balance plus RM balance valued at the live pool tick (no liquidation impact: favours the attacker).
    function _wealth(address who) internal view returns (int256) {
        uint256 bal = IERC20(rm).balanceOf(who);
        uint256 rmValue = bal == 0 ? 0 : TwapTickMath.priceFromTick(_liveTick(), rm, USDC, bal);
        return int256(IERC20(USDC).balanceOf(who) + rmValue);
    }

    function _fundAttacker() internal returns (int256 startWealth) {
        deal(USDC, attacker, 2_000e6);
        deal(rm, attacker, vault.assetTokenValue(0, 500e6));
        startWealth = _wealth(attacker);
    }

    function _honestWindow() internal {
        for (uint256 i = 0; i < 32; i++) {
            vm.warp(block.timestamp + 60);
            rec.record();
        }
    }

    function _deposit(address who) internal returns (uint256 shares) {
        uint256 amt = vault.perDepositCap();
        vm.startPrank(who);
        IERC20(USDC).approve(VAULT, amt);
        shares = vault.deposit(amt, who);
        vm.stopPrank();
    }

    function _keeperRecord() internal {
        vm.prank(keeper);
        rec.record();
    }

    function _markErrBps() internal view returns (int256) {
        return int256(vault.totalAssets()) * 10_000 / int256(HOLDER_TVL) - 10_000;
    }

    // ─── Scenario 1: the review's case, no honest record for a full window ──────────────

    /// @notice The review item on the real pool: one sampled push, then nobody records for 1,790 s. Measures the NAV mark
    ///         error the sample leaves and shows the vault paths it breaks.
    function test_fork_noHonestRecord_markIsWrongBySeveralPercentAndDepositsPause() public {
        int24 tick0 = _liveTick();
        _fundAttacker();
        _keeperRecord();
        vm.warp(block.timestamp + 60);
        _push(attacker, MAX_STEP + 60);
        vm.warp(block.timestamp + 60); // the adapter poke already used this timestamp, so the sample needs the next minute
        rec.record(); // the attacker samples the displaced pool: the recorded tick moves by the full clamp
        int256 sampled = int256(_recordedTick()) - int256(tick0);
        _restore(attacker, tick0, 6);

        vm.warp(block.timestamp + 1_790); // just inside the staleness limit, no honest record
        int256 markErr = _markErrBps();
        emit log_named_int("recorded tick displacement (ticks)", sampled);
        emit log_named_int("NAV mark error after 1790 s without an honest record (bps)", markErr);
        assertEq(sampled, MAX_STEP, "one sample moves the recorded tick by the full clamp");
        assertGt(markErr, 400, "without a keeper the mark is wrong by several percent");

        // The wrong mark makes the deposit guard refuse deposits. It pauses deposits and pays nobody.
        deal(USDC, victim, 15e6);
        vm.startPrank(victim);
        IERC20(USDC).approve(VAULT, 15e6);
        vm.expectPartialRevert(TwapTickMath.NavMarketDeviationExceeded.selector);
        vault.deposit(5e6, victim);
        vm.stopPrank();
        // redeemInKind needs no oracle, so a holder can always leave
        uint256 sh = IERC20(VAULT).balanceOf(victim);
        vm.prank(victim);
        vault.redeemInKind(sh / 2, victim, victim);
        assertGt(IERC20(rm).balanceOf(victim), 0, "redeemInKind still pays");
    }

    // ─── Scenario 2: the production cadence ──────────────────────────────────────────────

    /// @dev One keeper cycle with an optional sample. The attacker deposits the per-deposit cap 20 s after the keeper record
    ///      at +240 s, waits for the mark to heal, redeems every share, and the pnl is its wealth change including every attack
    ///      swap. `push` of 0 is the baseline.
    function _cycle240(int256 push, bool deposit) internal returns (int256 pnl, int256 markErr) {
        int24 tick0 = _liveTick();
        int256 w0 = _fundAttacker();
        _keeperRecord();
        if (push != 0) {
            // The attacker pushes in the keeper's own block, so its first sample can land one minute later.
            _push(attacker, push);
            vm.warp(block.timestamp + 60); // the adapter poke used this timestamp: the sample needs the next minute
            rec.record();
            _restore(attacker, tick0, 6);
            lastAttackCost = _wealth(attacker) - w0;
            vm.warp(block.timestamp + (KEEPER_INTERVAL - 60));
        } else {
            vm.warp(block.timestamp + KEEPER_INTERVAL);
        }
        _keeperRecord();
        vm.warp(block.timestamp + 20);
        markErr = _markErrBps();
        uint256 shares;
        if (deposit) {
            uint256 rmBefore = IERC20(rm).balanceOf(VAULT);
            uint256 supplyBefore = IERC20(VAULT).totalSupply();
            shares = _deposit(attacker);
            uint256 rmAdded = IERC20(rm).balanceOf(VAULT) - rmBefore;
            // Fairness: the attacker's share of supply against its share of the RM it put in. Zero means the mark error
            // cancelled out of the mint. Positive means the attacker was minted more than the RM it contributed.
            uint256 supplyAfter = supplyBefore + shares;
            uint256 rmAfter = rmBefore + rmAdded;
            lastMintGapBps =
                (int256(shares * 1e18 / supplyAfter) - int256(rmAdded * 1e18 / rmAfter)) / 1e14;
        }
        _honestWindow();
        if (shares > 0) {
            vm.prank(attacker);
            vault.redeem(shares, attacker, attacker);
        }
        pnl = _wealth(attacker) - w0;
    }

    /// @notice Keeper at 240 s. The attacker samples at the earliest legal moment (pushing in the keeper block, recording 60 s later) with a full
    ///         clamp push in each direction and restores the pool. Both directions lose money against the baseline.
    function test_fork_keeper240s_bestSampleIsNotProfitable() public {
        uint256 snap = vm.snapshotState();
        (int256 base,) = _cycle240(0, true);
        vm.revertToState(snap);
        (int256 up, int256 upErr) = _cycle240(MAX_STEP + 60, true);
        int256 upCost = lastAttackCost;
        int256 upGap = lastMintGapBps;
        vm.revertToState(snap);
        (int256 down, int256 downErr) = _cycle240(-(MAX_STEP + 60), true);
        int256 downCost = lastAttackCost;
        int256 downGap = lastMintGapBps;
        emit log_named_int("baseline pnl (USDC raw)", base);
        emit log_named_int("push UP: NAV mark error at deposit (bps)", upErr);
        emit log_named_int("push UP: pnl minus baseline (USDC raw)", up - base);
        emit log_named_int("push DOWN: NAV mark error at deposit (bps)", downErr);
        emit log_named_int("push DOWN: pnl minus baseline (USDC raw)", down - base);
        emit log_named_int("push UP: attack swap cost (USDC raw)", -upCost);
        emit log_named_int("push DOWN: attack swap cost (USDC raw)", -downCost);
        emit log_named_int(
            "push UP: gross benefit before attack cost (USDC raw)", up - base - upCost
        );
        emit log_named_int(
            "push DOWN: gross benefit before attack cost (USDC raw)", down - base - downCost
        );
        emit log_named_int("push UP: mint fairness gap (bps of supply)", upGap);
        emit log_named_int("push DOWN: mint fairness gap (bps of supply)", downGap);
        // The mark error cancels out of the mint, and even the gross benefit is dust against the attack cost.
        assertLe(
            upGap < 0 ? -upGap : upGap, 2, "UP: the mint stays proportional to the RM contributed"
        );
        assertLe(
            downGap < 0 ? -downGap : downGap,
            2,
            "DOWN: the mint stays proportional to the RM contributed"
        );
        assertLt(up - base - upCost, 100_000, "UP: gross benefit is under 0.10 USDC");
        assertLt(down - base - downCost, 100_000, "DOWN: gross benefit is under 0.10 USDC");
        assertLt(upCost, -1_000_000, "UP: the sample costs more than 1 USDC");
        assertLt(downCost, -1_000_000, "DOWN: the sample costs more than 1 USDC");
        assertLt(up - base, 0, "pushing the mark up loses money");
        assertLt(down - base, 0, "pushing the mark down loses money");
    }

    /// @notice The mark error at the keeper cadence stays below the 100 bps guard and below the redeem floor margin, in both
    ///         directions, so the sample cannot pause deposits either.
    function test_fork_keeper240s_markErrorStaysInsideTheGuard() public {
        uint256 snap = vm.snapshotState();
        (, int256 upErr) = _cycle240(MAX_STEP + 60, false);
        vm.revertToState(snap);
        (, int256 downErr) = _cycle240(-(MAX_STEP + 60), false);
        emit log_named_int("mark error after an UP sample at 240 s (bps)", upErr);
        emit log_named_int("mark error after a DOWN sample at 240 s (bps)", downErr);
        assertLt(upErr, 100, "inside the 100 bps guard");
        assertGt(downErr, -100, "inside the 100 bps guard");
    }
}
