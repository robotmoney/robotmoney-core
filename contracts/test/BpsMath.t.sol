// SPDX-License-Identifier: MIT
// Canonical: docs/code-review/smart-contract-holistic-review-20260618.md §1
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {BpsMath} from "../lib/BpsMath.sol";

/// @title BpsMathTest
/// @notice Pinning regression tests for the extracted basis-points denominator.
///         Asserts the shared constant equals the pre-extraction literal 10000
///         and that representative fee / slippage / weight arithmetic produces
///         the same results when computed against `BpsMath.BPS_DENOMINATOR` as
///         it did against the per-file `BPS_DENOMINATOR` / `MAX_BPS` literals.
contract BpsMathTest is Test {
    using Math for uint256;

    /// @dev Hard-coded reference value from the prior inline literals.
    uint256 internal constant REFERENCE_BPS = 10_000;

    /// @notice The shared denominator equals the pre-extraction literal.
    function test_denominator_equals10000() public pure {
        assertEq(BpsMath.BPS_DENOMINATOR, REFERENCE_BPS, "shared BPS denominator must be 10000");
    }

    /// @notice The narrowing `uint16` cast used by RobotMoneyVault.MAX_BPS is
    ///         exact: `uint16(BpsMath.BPS_DENOMINATOR)` round-trips to 10000 with
    ///         no truncation, so the vault's public constant is unchanged.
    function test_uint16Narrowing_isExact() public pure {
        uint16 narrowed = uint16(BpsMath.BPS_DENOMINATOR);
        assertEq(uint256(narrowed), REFERENCE_BPS, "uint16 narrowing must not truncate");
    }

    /// @notice Fee math: a 50 bps exit fee on 1,000,000 units yields 5,000 units,
    ///         identical whether the denominator is the literal or the shared constant.
    function test_feeMath_matchesLiteral() public pure {
        uint256 gross = 1_000_000;
        uint256 feeBps = 50; // 0.50%
        uint256 viaLiteral = gross.mulDiv(feeBps, REFERENCE_BPS);
        uint256 viaShared = gross.mulDiv(feeBps, BpsMath.BPS_DENOMINATOR);
        assertEq(viaShared, viaLiteral, "fee mulDiv must match literal");
        assertEq(viaShared, 5_000, "50 bps of 1e6 == 5000");
    }

    /// @notice Slippage floor: net = gross * (BPS - slippageBps) / BPS.
    function test_slippageMath_matchesLiteral() public pure {
        uint256 gross = 1_000_000;
        uint256 slippageBps = 300; // 3%
        uint256 viaLiteral = gross.mulDiv(REFERENCE_BPS - slippageBps, REFERENCE_BPS);
        uint256 viaShared =
            gross.mulDiv(BpsMath.BPS_DENOMINATOR - slippageBps, BpsMath.BPS_DENOMINATOR);
        assertEq(viaShared, viaLiteral, "slippage mulDiv must match literal");
        assertEq(viaShared, 970_000, "3% slippage floor of 1e6 == 970000");
    }

    /// @notice Weight math: equal-weight split of N assets uses BPS / N with the
    ///         remainder folded back, exactly as the vaults compute target weights.
    function test_weightMath_matchesLiteral() public pure {
        uint256 n = 3;
        uint256 baseWeightLiteral = REFERENCE_BPS / n;
        uint256 remainderLiteral = REFERENCE_BPS - baseWeightLiteral * n;
        uint256 baseWeightShared = BpsMath.BPS_DENOMINATOR / n;
        uint256 remainderShared = BpsMath.BPS_DENOMINATOR - baseWeightShared * n;
        assertEq(baseWeightShared, baseWeightLiteral, "base weight must match literal");
        assertEq(remainderShared, remainderLiteral, "remainder must match literal");
        assertEq(baseWeightShared, 3_333, "10000/3 == 3333");
        assertEq(remainderShared, 1, "10000 - 3333*3 == 1");
        // The three weights plus the remainder sum back to exactly BPS.
        assertEq(baseWeightShared * n + remainderShared, REFERENCE_BPS, "weights sum to 10000");
    }

    /// @notice Gross-up math (BasketVault/RobotMoneyVault redeem path):
    ///         net.mulDiv(BPS, BPS - feeBps, Ceil) must match the literal.
    function test_grossUpMath_matchesLiteral() public pure {
        uint256 net = 994_000;
        uint256 feeBps = 60;
        uint256 viaLiteral = net.mulDiv(REFERENCE_BPS, REFERENCE_BPS - feeBps, Math.Rounding.Ceil);
        uint256 viaShared = net.mulDiv(
            BpsMath.BPS_DENOMINATOR, BpsMath.BPS_DENOMINATOR - feeBps, Math.Rounding.Ceil
        );
        assertEq(viaShared, viaLiteral, "gross-up mulDiv must match literal");
    }
}
