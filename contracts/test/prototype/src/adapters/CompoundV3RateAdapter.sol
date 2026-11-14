// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.5 (asset admission), §5.9.3 check 5 (lending rate);
//            docs/technical/one-vault-timed-flows-eng-plan.md E15, §3.3
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CompoundV3Adapter} from "../../../../adapters/CompoundV3Adapter.sol";
import {ILendingRateAdapter} from "../interfaces/IFlowAdapters.sol";

/// @notice The Comet reads the rate needs (not in the production `IComet`).
interface ICometRate {
    struct TotalsBasic {
        uint64 baseSupplyIndex;
        uint64 baseBorrowIndex;
        uint64 trackingSupplyIndex;
        uint64 trackingBorrowIndex;
        uint104 totalSupplyBase;
        uint104 totalBorrowBase;
        uint40 lastAccrualTime;
        uint8 pauseFlags;
    }

    /// @notice Total supplied base (USDC) with interest accrued to `block.timestamp`.
    function totalSupply() external view returns (uint256);

    /// @notice The stored totals; `totalSupplyBase` is the principal sum.
    function totalsBasic() external view returns (TotalsBasic memory);
}

/// @title CompoundV3RateAdapter
/// @notice Test copy of the production `CompoundV3Adapter` (step 3d, E15): every production function is inherited
///         unchanged; `ratePerUnit()` is added.
contract CompoundV3RateAdapter is CompoundV3Adapter, ILendingRateAdapter {
    /// @notice Comet has no supplied principal, so it has no rate.
    error NoSupplyBase();

    constructor(address comet_, address usdc_, address vault_)
        CompoundV3Adapter(comet_, usdc_, vault_)
    {}

    /// @inheritdoc ILendingRateAdapter
    /// @dev `totalSupply() × 1e18 / totalSupplyBase`, rounded DOWN: Comet's base supply index accrued to now (Comet
    ///      exposes the accrued index only through `totalSupply`). A gift of USDC or cUSDCv3 to this adapter does not
    ///      move it; a supply or withdrawal by anyone moves it only by Comet's own principal rounding (one unit in
    ///      `totalSupplyBase`). Reverts `NoSupplyBase` on an empty market rather than returning a made-up rate.
    function ratePerUnit() external view returns (uint256 rate1e18) {
        uint256 base = ICometRate(address(COMET)).totalsBasic().totalSupplyBase;
        if (base == 0) revert NoSupplyBase();
        rate1e18 = Math.mulDiv(ICometRate(address(COMET)).totalSupply(), 1e18, base);
    }
}
