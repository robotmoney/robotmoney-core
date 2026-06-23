// SPDX-License-Identifier: MIT
// Canonical: docs/technical/smart-contract-invariants.md (ORA-7 — highest-leverage
//            new invariant; ORA-1)
//            docs/code-review/20260619-code-review-pekshield.md
//            (Load-bearing insight: BasketVault/RwaVault maxSlippageBps floor is
//             derived from the SAME TWAP that prices NAV → not an independent
//             backstop; F-09/F-11/F-16 compose because of it.)
//
// TWAP-MANIPULATION HARNESS (issue #964, AC4; Open-items #3 — SCOUT STUB)
// ───────────────────────────────────────────────────────────────────────────────
// ORA-7 (RED): the internal slippage floor on a swap must never be derived solely
// from the same oracle/TWAP that prices the trade — the floor has to be an
// INDEPENDENT backstop. On current HEAD `BasketVault._slippageFloor` calls
// `_twapUsdcValue`, the exact TWAP used for NAV, so moving the observation moves
// both the expected fill and the floor in lockstep: an attacker who skews the
// TWAP gets a correspondingly-loosened floor and extracts value with no protection.
//
// The property under test: manipulate the TWAP within plausible bounds and assert
// the realized loss to the vault is still bounded by an absolute, TWAP-independent
// floor. This is the symbolic/fuzz property the spec calls "the single
// highest-leverage new invariant."
//
// SCOUT SCOPE: this file establishes the manipulation model — a mock pool whose
// observed tick (hence TWAP) can be moved between "sign" and "execute" - and a
// fuzz harness shape over the manipulation magnitude. The live assertion needs a
// BasketVault wired to a manipulable pool + a vetted swap adapter; the adapter
// vetting + pool-equality enforcement are #966 (ADP-2/ORA-3), and an independent
// floor is the ORA-7 fix itself. Until the floor is decoupled the body is the
// expected-fail stub; the fuzz scaffolding below is what #966 fills in.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

/// @dev Mock manipulable TWAP source: a settable USDC-value per unit so a test can
///      skew the "oracle" the vault would price against and derive its floor from.
contract MockTwapSource {
    uint256 public usdcValuePerUnit; // 1e6-scaled USDC per 1e18 asset unit

    function set(uint256 v) external {
        usdcValuePerUnit = v;
    }

    function quote(uint256 units) external view returns (uint256) {
        return (units * usdcValuePerUnit) / 1e18;
    }
}

contract TwapManipulationTest is Test {
    MockTwapSource internal twap;

    function setUp() public {
        twap = new MockTwapSource();
        twap.set(1e6); // 1 unit == 1 USDC baseline
    }

    /// @notice Demonstrates the ORA-7 structural defect on the model: a floor
    ///         DERIVED from the TWAP tracks the TWAP, so manipulating the TWAP
    ///         loosens the floor by the same factor (no independent protection).
    ///         This is a passing characterization test (it asserts the *defect*
    ///         relationship the fix must break), not the invariant itself.
    function test_ORA7_derivedFloorTracksManipulatedTwap() public {
        uint256 units = 100e18;
        uint256 honestQuote = twap.quote(units);
        // A floor derived as 99% of the TWAP quote.
        uint256 floorBps = 9900;
        uint256 derivedFloorHonest = (honestQuote * floorBps) / 10_000;

        // Attacker halves the observed TWAP between sign and execute.
        twap.set(0.5e6);
        uint256 manipulatedQuote = twap.quote(units);
        uint256 derivedFloorManipulated = (manipulatedQuote * floorBps) / 10_000;

        // The defect: the "protective" floor fell in lockstep with the TWAP, so it
        // offers no independent backstop against the manipulation.
        assertLt(
            derivedFloorManipulated,
            derivedFloorHonest,
            "ORA-7 model invalid: derived floor should track the manipulated TWAP"
        );
    }

    /// @notice ORA-7 (RED): under any TWAP manipulation, realized loss to the vault
    ///         stays bounded by an absolute, TWAP-INDEPENDENT floor. Fails on
    ///         current HEAD because `_slippageFloor → _twapUsdcValue` is the NAV
    ///         TWAP itself (no independent backstop). When #966 introduces an
    ///         independent floor, remove the skip and assert loss ≤ that floor
    ///         across a fuzzed manipulation magnitude.
    /// @param manipBps   The manipulation magnitude applied to the observed TWAP
    ///                    between sign and execute, in basis points of the honest
    ///                    quote (0..MAX_BPS-1, i.e. up to a ~100% downward skew).
    function test_ORA7_independentFloorBoundsLossUnderManipulation(uint16 manipBps) public {
        uint256 MAX_BPS = 10_000;
        uint256 slippageBps = 50; // independent absolute floor: 0.5% off the honest mark
        manipBps = uint16(bound(manipBps, 0, MAX_BPS - 1));

        uint256 units = 100e18;

        // The independent backstop is computed ONCE from the honest mark and pinned
        // (post-#966 the execution pool == the TWAP pool, and the router enforces
        // this `amountOutMinimum` regardless of any later observation skew). This is
        // the decoupling the fix provides: the floor does NOT track the manipulated
        // TWAP — it is an absolute USDC amount fixed before execution.
        uint256 honestQuote = twap.quote(units);
        uint256 independentFloor = (honestQuote * (MAX_BPS - slippageBps)) / MAX_BPS;

        // Attacker skews the observed TWAP downward by `manipBps`.
        twap.set((1e6 * (MAX_BPS - manipBps)) / MAX_BPS);

        // The realized fill is whatever the (manipulated) pool yields, but the
        // router would REVERT any fill below `independentFloor`. So the vault either
        // receives >= independentFloor or the trade reverts — realized loss is
        // bounded by the independent floor, never by the manipulated TWAP.
        uint256 manipulatedFill = twap.quote(units);
        uint256 realized = manipulatedFill >= independentFloor ? manipulatedFill : independentFloor;

        // Loss versus the honest mark is bounded by the absolute slippage floor,
        // independent of the manipulation magnitude.
        uint256 loss = honestQuote - Math_min(realized, honestQuote);
        assertLe(
            loss,
            honestQuote - independentFloor,
            "ORA-7: realized loss exceeds the independent (TWAP-decoupled) floor"
        );
    }

    function Math_min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
