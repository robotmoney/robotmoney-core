// SPDX-License-Identifier: MIT
// Canonical: docs/prd.md §11.4 — RWA / Thematic Vault (rmRWA)
//            robotmoney/devops issue 53 / core issue 1499 — decision 9: rmRWA is a
//            plain basket row with no oracle.
// (See also: docs/architecture.md §4.1 — Vault Family; docs/audits.md)
// Audit status: see the audit-scope ledger in docs/audits.md. A thin subclass of BasketVault,
// not separately audited, under the same bucket-B/C economic-audit gate (exception pending owner).
pragma solidity ^0.8.24;

import {BasketVault} from "./BasketVault.sol";
import {BasketViews, IBasketVaultViews} from "../lib/BasketViews.sol";

/// @title RwaBasketVault
/// @notice The rmRWA vault. A plain `BasketVault` row set: no oracle, no staleness halt, no
///         custom adapter. Each asset is priced from its own Uniswap V3 pool TWAP through the
///         existing `UniswapV3SwapAdapter`, exactly as the other basket vaults price theirs.
///         The launch row is deSPXA on its fee 500 pool (config/rwa-assets.json).
///
///         ISSUER FREEZE RISK. A tokenised-equity issuer may freeze transfers at any time. A
///         freeze makes swaps revert, which blocks deposits and withdrawals until the issuer
///         lifts it. Holders keep their shares. `pauseDeposits()` surfaces the state to new depositors. It never blocks a redeem.
///         This vault never calls an issuer primary-redemption path. Entry and exit are
///         secondary-market swaps only.
///
///         The vault inherits every control of `BasketVault`: caps, slippage floors, TWAP
///         cardinality and liquidity checks on `addAsset`, the adapter code-hash allowlist,
///         pause and emergency unwind. It adds only a name, a symbol and an asset cap.
contract RwaBasketVault is BasketVault {
    uint256 private constant _MAX_ASSETS = 10;
    uint256 private constant _DEFAULT_SLIPPAGE_BPS = 100; // 1%

    /// @dev ADR-0014: no constructor arguments. `BasketVault.initialize` runs once on the proxy and
    ///      takes this kind's name, symbol and starting slippage from here.
    function _kindConfig() internal pure override returns (string memory, string memory, uint256) {
        return ("Robot Money RWA", "rmRWA", _DEFAULT_SLIPPAGE_BPS);
    }

    function maxAssets() public pure override returns (uint256) {
        return _MAX_ASSETS;
    }

    /// @notice Token, pool, fee tier, active flag and held balance for every basket row.
    ///         Same shape as `ProtocolAssetVault.shortlist()` and `AgentTokenVault.shortlist()`.
    function shortlist()
        external
        view
        returns (
            address[] memory tokens,
            address[] memory pools,
            uint24[] memory fees,
            bool[] memory active,
            uint256[] memory balances
        )
    {
        return BasketViews.shortlist(IBasketVaultViews(address(this)));
    }
}
