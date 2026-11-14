// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.5 (asset admission), §5.9.3 check 5 (lending rate);
//            docs/technical/one-vault-timed-flows-eng-plan.md E15, §3.3
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {MorphoAdapter} from "../../../../adapters/MorphoAdapter.sol";
import {ILendingRateAdapter} from "../interfaces/IFlowAdapters.sol";

/// @title MorphoRateAdapter
/// @notice Test copy of the production `MorphoAdapter` (step 3d, E15): every production function is inherited
///         unchanged; `ratePerUnit()` is added. The venue is an ERC-4626 vault (Moonwell Flagship USDC, MetaMorpho).
contract MorphoRateAdapter is MorphoAdapter, ILendingRateAdapter {
    /// @notice The vault's share or asset decimals make the 1e18 scale impossible.
    error UnsupportedDecimals(uint8 shareDecimals, uint8 assetDecimals);

    constructor(address morphoVault_, address usdc_, address vault_)
        MorphoAdapter(morphoVault_, usdc_, vault_)
    {}

    /// @inheritdoc ILendingRateAdapter
    /// @dev USDC units per whole vault share, scaled so that 1 whole asset per whole share reads 1e18:
    ///      `convertToAssets(10 ** (shareDecimals + 18 − assetDecimals))`, the vault's own rounding (DOWN).
    ///      MetaMorpho values its markets with interest accrued to now and does not count a donation of USDC
    ///      or of its shares to this adapter, so a gift does not move it.
    function ratePerUnit() external view returns (uint256 rate1e18) {
        uint8 sd = IERC20Metadata(address(MORPHO_VAULT)).decimals();
        uint8 ad = IERC20Metadata(USDC).decimals();
        if (uint256(sd) + 18 < ad || uint256(sd) + 18 - ad > 60) {
            revert UnsupportedDecimals(sd, ad);
        }
        rate1e18 = MORPHO_VAULT.convertToAssets(10 ** (uint256(sd) + 18 - ad));
    }
}
