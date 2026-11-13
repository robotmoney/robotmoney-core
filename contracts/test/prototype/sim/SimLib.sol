// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §10 step 3 (rebalance simulation), §13 G4 / G5
// Experiment prototype only (contracts/test/prototype/). Plan Step 3.
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Pure helpers of the rebalance simulation (RebalanceSim.t.sol): seeded draws, the approximate normal,
///         V3 depth and spot conversions. Every draw is a keccak of constants, so a record run and a replay run
///         make identical calls and touch identical pool ticks and slots.
library SimLib {
    uint256 internal constant ONE = 1e18;
    uint256 internal constant Q96 = 1 << 96;
    /// @dev sqrt(3) × 1e18: a sum of 4 U[0,1) has variance 1/3.
    uint256 internal constant SQRT3 = 1_732_050_807_568_877_293;

    // Stream tags (one per kind of draw).
    uint256 internal constant TAG_WALK = 1;
    uint256 internal constant TAG_ARB = 2;
    uint256 internal constant TAG_NOISE_N = 3;
    uint256 internal constant TAG_NOISE_DIR = 4;
    uint256 internal constant TAG_NOISE_SIZE = 5;
    uint256 internal constant TAG_FLOW = 6;
    uint256 internal constant TAG_FLOW_DIR = 7;
    uint256 internal constant TAG_FLOW_SIZE = 8;
    uint256 internal constant TAG_FLOW_WHO = 9;

    /// @notice The run seed: keccak256("rm-sim-v1", scenario, fund size, seed index).
    function seedOf(uint256 scenarioId, uint256 fundUsdc, uint256 k)
        internal
        pure
        returns (uint256)
    {
        return uint256(keccak256(abi.encode("rm-sim-v1", scenarioId, fundUsdc, k)));
    }

    /// @notice One raw draw for (slot, stream, asset).
    function draw(uint256 seed, uint256 slot, uint256 tag, uint256 asset)
        internal
        pure
        returns (uint256)
    {
        return uint256(keccak256(abi.encode(seed, slot, tag, asset)));
    }

    /// @notice U[0,1) in 1e18 fixed point.
    function unit(uint256 seed, uint256 slot, uint256 tag, uint256 asset)
        internal
        pure
        returns (uint256)
    {
        return draw(seed, slot, tag, asset) % ONE;
    }

    /// @notice Approximately N(0,1) in 1e18 fixed point: (sum of 4 uniforms − 2) × sqrt(3).
    function normal(uint256 seed, uint256 slot, uint256 tag, uint256 asset)
        internal
        pure
        returns (int256)
    {
        uint256 h = draw(seed, slot, tag, asset);
        uint256 s;
        for (uint256 j; j < 4; ++j) {
            s += uint256(keccak256(abi.encode(h, j))) % ONE;
        }
        return (int256(s) - int256(2 * ONE)) * int256(SQRT3) / int256(ONE);
    }

    /// @notice USDC notional that moves an in-range V3 pool's price by 10 bps (sqrt price by ~5 bps).
    ///         USDC as token1: Δy = L·ΔsqrtP/2^96. USDC as token0: Δx = L·2^96·Δ(1/sqrtP).
    function depth10Bps(uint128 liquidity, uint160 sqrtP, bool usdcIsToken0)
        internal
        pure
        returns (uint256)
    {
        if (usdcIsToken0) return Math.mulDiv(liquidity, Q96, sqrtP) * 5 / 10_000;
        return Math.mulDiv(liquidity, sqrtP, Q96) * 5 / 10_000;
    }

    /// @notice USDC value of `amount` token units at sqrt price `sqrtP` (raw units both sides).
    function spotUsdc(uint256 amount, uint160 sqrtP, bool usdcIsToken0)
        internal
        pure
        returns (uint256)
    {
        if (usdcIsToken0) return Math.mulDiv(Math.mulDiv(amount, Q96, sqrtP), Q96, sqrtP);
        return Math.mulDiv(Math.mulDiv(amount, sqrtP, Q96), sqrtP, Q96);
    }

    /// @notice Signed USDC value of a signed token delta at spot.
    function spotUsdcSigned(int256 delta, uint160 sqrtP, bool usdcIsToken0)
        internal
        pure
        returns (int256)
    {
        if (delta >= 0) return int256(spotUsdc(uint256(delta), sqrtP, usdcIsToken0));
        return -int256(spotUsdc(uint256(-delta), sqrtP, usdcIsToken0));
    }

    /// @notice Sample standard deviation of the first differences of `xs` (same unit as `xs`).
    function stdevOfDiffs(int256[] memory xs) internal pure returns (uint256) {
        uint256 n = xs.length;
        if (n < 3) return 0;
        int256 mean;
        for (uint256 j = 1; j < n; ++j) {
            mean += xs[j] - xs[j - 1];
        }
        mean /= int256(n - 1);
        uint256 ss;
        for (uint256 j = 1; j < n; ++j) {
            int256 d = xs[j] - xs[j - 1] - mean;
            ss += uint256(d * d);
        }
        return Math.sqrt(ss / (n - 2));
    }

    function pos(int256 x) internal pure returns (uint256) {
        return x > 0 ? uint256(x) : 0;
    }

    function sub(uint256 a, uint256 b) internal pure returns (int256) {
        return int256(a) - int256(b);
    }
}
