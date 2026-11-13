// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §10 step 3 (rebalance simulation: the market model),
//            §10 step 3e (the rules of the rerun: the §4.5 list, no deSPXA, the JUMP moves wETH);
//            docs/technical/one-vault-timed-flows-eng-plan.md §4.1 (A2, A6, A9, A10 "need the sim's arbitrage model"),
//            §4.4 (timed-flow sim)
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {TickMath} from "../../../lib/TickMath.sol";
import {SimLib} from "./SimLib.sol";

interface ISimMarketPool {
    function token0() external view returns (address);
    function liquidity() external view returns (uint128);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory, uint160[] memory);
}

interface ISimMarketRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256);
}

/// @title SimMarket
/// @notice The market of the rebalance simulation, for the two basket pools of the §4.5 list (wETH, cbBTC), as a
///         harness-neutral mixin: the timed-flow sim (`TimedFlowSim.t.sol`, live harness) and the sim attacks
///         (`AttackSim.t.sol`, both harnesses) share it. It is the step 3 model of `RebalanceSim.t.sol` without
///         deSPXA, line for line where the two overlap, so a seed draws the same walk, noise and arbitrage for wETH
///         and cbBTC as the synchronous sim does (pool index b = 0 wETH, b = 1 cbBTC, as there):
///
///         - a zero-drift reference walk per pool, ref *= exp(sigma × z) once per slot, sigma = the pool's own
///           30-minute mean-tick difference stdev at the pin, scaled by sqrt(3/2) (`RebalanceSim._sigma`, review R4);
///         - noise: 1 or 2 seeded price-limited swaps per pool per slot, each moving the price u × 10 bps;
///         - an arbitrageur that closes a seeded fraction a in [0.5, 1) of each pool's gap to the reference once per
///           slot with a price-limited swap (a = 1 on a scripted jump). wETH and cbBTC trade 24/7 against deep outside
///           venues, so its inventory is unlimited (as in step 3).
///
///         Step 3e rule for the JUMP scenarios (proposal §10 step 3e): the scripted jump moves the wETH reference by
///         the size and at the slot the step 3 sim moved deSPXA (`_mkWalkAndArb(jump = true, ...)`).
///
///         Determinism: every draw is `SimLib.draw(seed, slot, tag, asset)`. Nothing reads gasleft or vm.random*.
abstract contract SimMarket is Test {
    using Math for uint256;

    // ─── Real Base addresses (the same in both harnesses; prefixed so they never clash with theirs) ──────

    address internal constant MK_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant MK_WETH = 0x4200000000000000000000000000000000000006;
    address internal constant MK_CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address internal constant MK_WETH_POOL = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    address internal constant MK_CBBTC_POOL = 0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef;
    address internal constant MK_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    uint24 internal constant MK_POOL_FEE = 500;

    // ─── Model constants (RebalanceSim.t.sol, unchanged) ────────────────────────────────────────────────

    uint256 internal constant MK_N = 2;
    uint32 internal constant MK_SIGMA_WINDOW = 1_800;
    uint256 internal constant MK_FALLBACK_SIGMA_MILLITICKS = 10_000;
    uint256 internal constant MK_SIGMA_DIFF_SCALE_E4 = 12_247;
    uint256 internal constant MK_ARB_BUDGET_USDC = 100_000_000e6;

    // ─── State ──────────────────────────────────────────────────────────────────────────────────────────

    uint256 internal mkSeed;
    /// @dev The slot index the draws are keyed by (`slotIndex` in RebalanceSim).
    uint256 internal mkSlot;
    address[2] internal mkPools;
    address[2] internal mkTokens;
    bool[2] internal mkUsdc0;
    /// @dev The reference walk, in milli-ticks of the pool's own price (token1 per token0).
    int256[2] internal mkRefMilli;
    int256[2] internal mkP0Tick;
    uint256[2] internal mkSigma;
    uint256[2] internal mkSigmaN;
    uint256[2] internal mkDepth10Bps;
    uint256[2] internal mkPinL;
    /// @dev Timestamp of the scripted jump (0 until it happened).
    uint256 internal mkJumpAt;

    /// @dev Credit `amount` USDC to `to` (the harness's `fundUsdc`). The arbitrageur and the noise trader mint their
    ///      input, as in step 3.
    function _mkFundUsdc(address to, uint256 amount) internal virtual;

    // ─── Setup at the pin ───────────────────────────────────────────────────────────────────────────────

    /// @notice Read sigma, the 30-minute mean tick (the walk's start), the depth and the liquidity of both pools now.
    ///         Call at the pin, before any warp: sigma comes from the pool's observation ring.
    function _mkInit(uint256 seed_) internal {
        mkSeed = seed_;
        mkPools = [MK_WETH_POOL, MK_CBBTC_POOL];
        mkTokens = [MK_WETH, MK_CBBTC];
        for (uint256 b; b < MK_N; ++b) {
            ISimMarketPool p = ISimMarketPool(mkPools[b]);
            mkUsdc0[b] = p.token0() == MK_USDC;
            (mkSigma[b], mkSigmaN[b]) = _mkSigmaOf(p);
            int256 mean = _mkMeanTick(p, MK_SIGMA_WINDOW);
            mkP0Tick[b] = mean;
            mkRefMilli[b] = mean * 1000;
            (uint160 sp,,,,,,) = p.slot0();
            mkPinL[b] = p.liquidity();
            mkDepth10Bps[b] = SimLib.depth10Bps(p.liquidity(), sp, mkUsdc0[b]);
        }
    }

    /// @dev `RebalanceSim._sigma` for a 24/7 asset: the stdev of 30-minute mean-tick changes over the longest
    ///      lookback the ring holds (ladder 48, 24, 12, 8, 4), times sqrt(3/2).
    function _mkSigmaOf(ISimMarketPool p) internal view returns (uint256 sigma, uint256 intervals) {
        uint256[5] memory ladder = [uint256(48), 24, 12, 8, 4];
        for (uint256 r; r < ladder.length; ++r) {
            uint256 n = ladder[r];
            uint32[] memory ago = new uint32[](n + 1);
            for (uint256 j; j <= n; ++j) {
                ago[j] = uint32((n - j) * MK_SIGMA_WINDOW);
            }
            try p.observe(ago) returns (int56[] memory c, uint160[] memory) {
                int256[] memory m = new int256[](n);
                for (uint256 j; j < n; ++j) {
                    m[j] =
                        (int256(c[j + 1]) - int256(c[j])) * 1000 / int256(uint256(MK_SIGMA_WINDOW));
                }
                return (SimLib.stdevOfDiffs(m) * MK_SIGMA_DIFF_SCALE_E4 / 10_000, n);
            } catch {}
        }
        return (MK_FALLBACK_SIGMA_MILLITICKS, 0);
    }

    function _mkMeanTick(ISimMarketPool p, uint32 window) internal view returns (int256) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        (int56[] memory c,) = p.observe(ago);
        int256 d = int256(c[1]) - int256(c[0]);
        int256 t = d / int256(uint256(window));
        if (d < 0 && d % int256(uint256(window)) != 0) --t;
        return t;
    }

    // ─── Time ───────────────────────────────────────────────────────────────────────────────────────────

    /// @notice Warp to `t` and roll one block per 2 seconds (Base), as RebalanceSim does. `t` must not lie behind.
    function _mkAt(uint256 t) internal {
        uint256 now_ = vm.getBlockTimestamp();
        require(t >= now_, "sim: time runs forward");
        uint256 dt = t - now_;
        vm.warp(t);
        vm.roll(vm.getBlockNumber() + dt / 2);
    }

    // ─── Market events ──────────────────────────────────────────────────────────────────────────────────

    /// @notice RebalanceSim `_noise` for wETH and cbBTC (same draws: asset key b × 2 + j).
    function _mkNoise() internal {
        for (uint256 b; b < MK_N; ++b) {
            uint256 n = 1 + SimLib.draw(mkSeed, mkSlot, SimLib.TAG_NOISE_N, b) % 2;
            for (uint256 j; j < n; ++j) {
                uint256 a = b * 2 + j;
                bool buy = SimLib.draw(mkSeed, mkSlot, SimLib.TAG_NOISE_DIR, a) % 2 == 0;
                uint256 u = SimLib.unit(mkSeed, mkSlot, SimLib.TAG_NOISE_SIZE, a);
                if (u < SimLib.ONE / 100) continue;
                (uint160 sp,,,,,,) = ISimMarketPool(mkPools[b]).slot0();
                bool up = mkUsdc0[b] ? !buy : buy;
                uint256 move = u * 5 / 10_000;
                uint256 f = up ? SimLib.ONE + move : SimLib.ONE - move;
                _mkSwapToLimit(b, up, uint160(uint256(sp).mulDiv(f, SimLib.ONE)));
            }
        }
    }

    /// @notice One walk step of each reference, then the arbitrageur (RebalanceSim `_arb` without deSPXA). On the
    ///         jump slot (`jump`), wETH's reference also moves by `usdJumpMilli` milli-ticks of its USD price and the
    ///         arbitrageur closes the whole gap (a = 1), as step 3 did for deSPXA (§10 step 3e).
    function _mkWalkAndArb(bool jump, int256 usdJumpMilli) internal {
        for (uint256 b; b < MK_N; ++b) {
            int256 z = SimLib.normal(mkSeed, mkSlot, SimLib.TAG_WALK, b);
            mkRefMilli[b] += int256(mkSigma[b]) * z / int256(SimLib.ONE);
            uint256 a = SimLib.ONE / 2 + SimLib.unit(mkSeed, mkSlot, SimLib.TAG_ARB, b) / 2;
            if (jump && b == 0) {
                mkRefMilli[b] += mkUsdc0[b] ? -usdJumpMilli : usdJumpMilli;
                a = SimLib.ONE;
                mkJumpAt = vm.getBlockTimestamp();
            }
            _mkArbTo(b, a);
        }
    }

    /// @notice The arbitrageur closes the fraction `a` (1e18 = all) of pool b's gap to its reference.
    function _mkArbTo(uint256 b, uint256 a) internal {
        (, int24 tick,,,,,) = ISimMarketPool(mkPools[b]).slot0();
        int256 cur = int256(tick) * 1000;
        int256 tgt = cur + (mkRefMilli[b] - cur) * int256(a) / int256(SimLib.ONE);
        int24 tt = int24(tgt / 1000);
        if (tt == tick) return;
        _mkSwapToLimit(b, tt > tick, TickMath.getSqrtRatioAtTick(tt));
    }

    /// @dev `up`: pool price (token1 per token0) rises, so token1 goes in. A price-limited exact-input swap from
    ///      this contract with a generous minted input; the pool sizes it. Returns the input spent and the output.
    function _mkSwapToLimit(uint256 b, bool up, uint160 limit)
        internal
        returns (uint256 spent, uint256 got)
    {
        bool usdcIn = up ? !mkUsdc0[b] : mkUsdc0[b];
        address tokenIn = usdcIn ? MK_USDC : mkTokens[b];
        address tokenOut = usdcIn ? mkTokens[b] : MK_USDC;
        uint256 amt =
            usdcIn ? MK_ARB_BUDGET_USDC : _mkTokenForUsdc(b, MK_ARB_BUDGET_USDC, _mkSpotSqrt(b));
        uint256 bal = IERC20(tokenIn).balanceOf(address(this));
        if (bal < amt) {
            if (usdcIn) _mkFundUsdc(address(this), amt - bal);
            else deal(tokenIn, address(this), amt);
        }
        uint256 inBefore = IERC20(tokenIn).balanceOf(address(this));
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).approve(MK_ROUTER, amt);
        ISimMarketRouter(MK_ROUTER)
            .exactInputSingle(
                ISimMarketRouter.ExactInputSingleParams(
                    tokenIn, tokenOut, MK_POOL_FEE, address(this), amt, 0, limit
                )
            );
        spent = inBefore - IERC20(tokenIn).balanceOf(address(this));
        got = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
    }

    // ─── Prices ─────────────────────────────────────────────────────────────────────────────────────────

    /// @notice The reference tick (milli-ticks truncated, as RebalanceSim `_refSqrt`).
    function _mkRefTick(uint256 b) internal view returns (int24) {
        return int24(mkRefMilli[b] / 1000);
    }

    function _mkRefSqrt(uint256 b) internal view returns (uint160) {
        return TickMath.getSqrtRatioAtTick(_mkRefTick(b));
    }

    function _mkSpotSqrt(uint256 b) internal view returns (uint160 sp) {
        (sp,,,,,,) = ISimMarketPool(mkPools[b]).slot0();
    }

    /// @notice USDC units for `amount` token units of pool b at sqrt price `sqrtP`.
    function _mkUsdcFor(uint256 b, uint256 amount, uint160 sqrtP) internal view returns (uint256) {
        return SimLib.spotUsdc(amount, sqrtP, mkUsdc0[b]);
    }

    /// @notice Token units of pool b for `usdc` at sqrt price `sqrtP` (the inverse of `_mkUsdcFor`).
    function _mkTokenForUsdc(uint256 b, uint256 usdc, uint160 sqrtP)
        internal
        view
        returns (uint256)
    {
        if (mkUsdc0[b]) {
            return Math.mulDiv(Math.mulDiv(usdc, sqrtP, SimLib.Q96), sqrtP, SimLib.Q96);
        }
        return Math.mulDiv(Math.mulDiv(usdc, SimLib.Q96, sqrtP), SimLib.Q96, sqrtP);
    }

    /// @notice Signed bps of `a` against `b`: (a − b) × 1e4 / b.
    function _mkBps(uint256 a, uint256 b) internal pure returns (int256) {
        if (b == 0) return 0;
        return (int256(a) - int256(b)) * 10_000 / int256(b);
    }
}
