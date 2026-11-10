// SPDX-License-Identifier: MIT
// Canonical: docs/prd.md §11.5 — Hard Assets Vault (rmHARD)
//            docs/adr/ADR-0018-hard-assets-vault-fourth-router-vault.md (PAXG on its Aero CL USDC pool, core 2008)
// (See also: docs/architecture.md §4.1 — Vault Family; docs/audits.md)
// Audit status: see the audit-scope ledger in docs/audits.md. A thin subclass of BasketVault,
// not separately audited, under the same bucket-B/C economic-audit gate as rmRWA.
pragma solidity ^0.8.24;

import {BasketVault} from "./BasketVault.sol";
import {BasketViews, IBasketVaultViews} from "../lib/BasketViews.sol";

/// @title HardAssetsVault
/// @notice The rmHARD vault. A plain `BasketVault` row set: no oracle, no staleness halt, no
///         custom adapter. Each asset is priced from its own pool TWAP through an existing swap
///         adapter, exactly as the other basket vaults price theirs. The launch row is PAXG
///         (Paxos Gold, 18 decimals) on its Aero (Aerodrome Slipstream) CL USDC pool, traded and
///         priced through the existing `AerodromeSwapAdapter` (config/hard-assets.json).
///
///         ISSUER FREEZE RISK. Paxos can freeze, wipe or pause PAXG at any address at any time.
///         A freeze of the vault makes swaps revert, which blocks deposits and withdrawals until
///         Paxos lifts it. Holders keep their shares. `pauseDeposits()` surfaces the state to new
///         depositors. It never blocks a redeem. This vault never calls an issuer
///         primary-redemption path. Entry and exit are secondary-market swaps only.
///
///         The vault inherits every control of `BasketVault`: caps, slippage floors, TWAP
///         cardinality and liquidity checks on `addAsset`, the adapter code-hash allowlist,
///         pause and emergency unwind. It adds only a name, a symbol and an asset cap.
contract HardAssetsVault is BasketVault {
    uint256 private constant _MAX_ASSETS = 10;
    uint256 private constant _DEFAULT_SLIPPAGE_BPS = 100; // 1%

    /// @notice Atomic proxy initialization (the ERC1967Proxy constructor calls it).
    /// @param p The per-instance basket arguments.
    /// @param upgradeTimelock_ The Safe-controlled timelock: the only upgrade and freeze authority.
    /// @param upgradeMode_ The release mode. `Undeclared` reverts.
    function initialize(InitParams calldata p, address upgradeTimelock_, UpgradeMode upgradeMode_)
        external
        initializer
    {
        __BasketVault_init("Robot Money Hard Assets", "rmHARD", _DEFAULT_SLIPPAGE_BPS, p);
        __GovernedUUPS_init(upgradeTimelock_, upgradeMode_);
    }

    function maxAssets() public pure override returns (uint256) {
        return _MAX_ASSETS;
    }

    /// @notice Token, pool, fee tier, active flag and held balance for every basket row.
    ///         Same shape as `RwaBasketVault.shortlist()` and `ProtocolAssetVault.shortlist()`.
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
