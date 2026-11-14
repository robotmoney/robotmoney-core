// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.5 (asset admission), §5.9.3 checks 2, 5 and 9, §6
//            (adapter row: exact-output swap with a price limit, venue rate per unit);
//            docs/technical/one-vault-timed-flows-eng-plan.md E3, E15, E16, §3.3
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IBasketSwapAdapter} from "../../../../interfaces/IBasketSwapAdapter.sol";
import {IStrategyAdapter} from "../../../../interfaces/IStrategyAdapter.sol";

/// @title IExactOutSwapAdapter
/// @notice The swap adapter test copies of step 3d (`src/adapters/`, owned by the `queue` agent): the production
///         exact-input swap and TWAP, plus an exact-output swap whose `maxAmountIn` is the per-swap price limit of
///         the pro-rata purchase (proposal §5.9.3 check 9). The production adapters do not change (eng plan §3.3).
interface IExactOutSwapAdapter is IBasketSwapAdapter {
    /// @notice Buy exactly `amountOut` of `tokenOut` for at most `maxAmountIn` of `tokenIn`, paid to `recipient`.
    ///         Pulls `maxAmountIn` from the caller, sends the unused input back to the caller, and resets its
    ///         allowance to the venue to 0. Reverts if the venue needs more than `maxAmountIn` or the deadline passed.
    /// @param fee      Venue parameter, as `swap` (V3: fee pips; Aerodrome: tick spacing).
    /// @return amountIn The input actually spent (≤ `maxAmountIn`).
    function swapExactOut(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountOut,
        uint256 maxAmountIn,
        address recipient,
        uint256 deadline
    ) external returns (uint256 amountIn);
}

/// @title ILendingRateAdapter
/// @notice The lending adapter test copies of step 3d (E15, check 5): the production `IStrategyAdapter` plus the
///         venue's OWN exchange rate per unit, scaled by 1e18 (Aave: the reserve's normalized income; Compound V3:
///         the supply index; a Morpho / ERC-4626 vault: `convertToAssets(1 share)` scaled). It is a property of
///         the venue, not of the fund's position: a gift to the adapter, a deposit or a rebalance step does not
///         move it.
interface ILendingRateAdapter is IStrategyAdapter {
    function ratePerUnit() external view returns (uint256 rate1e18);
}

/// @title IChainlinkAggregator
/// @notice The Chainlink `AggregatorV3Interface` subset FeedLib reads (E16). Feeds on Base at the fixture pin are
///         listed in the scaffold plan §4.
interface IChainlinkAggregator {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}
