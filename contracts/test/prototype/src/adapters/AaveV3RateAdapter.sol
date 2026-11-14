// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.5 (asset admission), §5.9.3 check 5 (lending rate);
//            docs/technical/one-vault-timed-flows-eng-plan.md E15, §3.3
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {AaveV3Adapter} from "../../../../adapters/AaveV3Adapter.sol";
import {ILendingRateAdapter} from "../interfaces/IFlowAdapters.sol";

/// @notice The Aave V3 Pool read the rate needs (not in the production `IAavePool`).
interface IAavePoolRate {
    /// @notice The reserve's normalized income: the liquidity index accrued to `block.timestamp`, in ray (1e27).
    ///         One aToken unit supplied at index 1 ray is worth this many underlying units today.
    function getReserveNormalizedIncome(address asset) external view returns (uint256);
}

/// @title AaveV3RateAdapter
/// @notice Test copy of the production `AaveV3Adapter` (step 3d, E15): every production function is inherited
///         unchanged; `ratePerUnit()` is added. The production adapter does not change (eng plan §3.3).
contract AaveV3RateAdapter is AaveV3Adapter, ILendingRateAdapter {
    /// @dev ray (1e27) → 1e18.
    uint256 private constant RAY_TO_WAD = 1e9;

    constructor(address pool_, address usdc_, address aToken_, address vault_)
        AaveV3Adapter(pool_, usdc_, aToken_, vault_)
    {}

    /// @inheritdoc ILendingRateAdapter
    /// @dev The reserve's normalized income (ray) scaled to 1e18, rounded DOWN. It is the venue's own exchange rate:
    ///      a supply, a withdrawal or a gift of aTokens or USDC to this adapter does not move it; only interest
    ///      accrual does (check 5).
    function ratePerUnit() external view returns (uint256 rate1e18) {
        rate1e18 = IAavePoolRate(address(POOL)).getReserveNormalizedIncome(USDC) / RAY_TO_WAD;
    }
}
