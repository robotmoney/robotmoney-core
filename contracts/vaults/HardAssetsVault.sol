// SPDX-License-Identifier: MIT
// Canonical: docs/prd.md §11.5 — Hard Assets Vault (rmHARD)
//            docs/adr/ADR-0018-hard-assets-vault-fourth-router-vault.md (PAXG on its Aero CL USDC pool, core 2008)
// (See also: docs/architecture.md §4.1 — Vault Family; docs/audits.md)
// Audit status: see the audit-scope ledger in docs/audits.md. A thin subclass of BasketVault,
// not separately audited, under the same bucket-B/C economic-audit gate as rmRWA.
pragma solidity ^0.8.24;

import {BasketVault} from "./BasketVault.sol";
import {BasketViews, IBasketVaultViews} from "../lib/BasketViews.sol";
import {BasketAssetConfigGuard} from "../lib/BasketAssetConfigGuard.sol";

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
///         pause and emergency unwind. It adds a name, a symbol, an asset cap and one entry point:
///
///         `addAssetWithTwapWindow` (ADR-0018). `BasketVault.addAsset` vets a pool for
///         `DEFAULT_TWAP_WINDOW` (1800 s), which needs a 901-slot observation ring (`window / 2 s + 1`).
///         PAXG's Aero pool has a 900-slot ring, and the vault fits the pool as it is: it never changes
///         third-party pool state. This entry point sets the asset's TWAP window first (bounded like
///         `setTwapWindow`) and then runs the same `BasketAssetConfigGuard.addAsset` for that window: the
///         window-derived cardinality floor and `observe([window, 0])`, unchanged. PAXG uses 1798 s, which
///         a 900-slot ring covers at 2 s blocks. NAV, slippage floors and the dust check read the same
///         window (`effectiveTwapWindow`). `BasketVault` itself is unchanged, so rmPROTO and rmRWA keep
///         their bytecode and the 901-slot floor.
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

    /// @notice `addAsset` with the asset's own TWAP window: sets `twapWindow[token_] = window_` (bounded by
    ///         `[MIN_TWAP_WINDOW, MAX_TWAP_WINDOW]`, as `setTwapWindow`), then registers the asset through the same
    ///         guard as `BasketVault.addAsset`, which vets the pool for `window_`. ADMIN_ROLE only. Atomic: a pool that
    ///         does not serve the window reverts the whole call, and the window is not left behind.
    /// @param token_   ERC-20 token address.
    /// @param pool_    DEX pool pairing `token_` with USDC.
    /// @param swapFee_ Venue parameter (fee tier, or tick spacing for Aerodrome).
    /// @param adapter_ Swap and TWAP adapter (code hash allowlisted), or zero for the built-in V3 path.
    /// @param venue_   DEX venue selector.
    /// @param window_  The asset's TWAP window in seconds.
    function addAssetWithTwapWindow(
        address token_,
        address pool_,
        uint24 swapFee_,
        address adapter_,
        Venue venue_,
        uint32 window_
    ) external onlyRole(ADMIN_ROLE) {
        if (token_ == address(0) || pool_ == address(0)) revert ZeroAddress();
        if (assets.length >= maxAssets()) revert MaxAssetsReached();
        if (window_ < MIN_TWAP_WINDOW || window_ > MAX_TWAP_WINDOW) {
            revert InvalidTwapWindow(window_);
        }
        uint32 old = twapWindow[token_];
        twapWindow[token_] = window_;
        emit TwapWindowUpdated(token_, old, window_);
        BasketAssetConfigGuard.addAsset(
            _guardAssets(),
            BasketAssetConfigGuard.AssetInfo({
                token: token_,
                pool: pool_,
                swapFee: swapFee_,
                active: true,
                adapter: adapter_,
                venue: BasketAssetConfigGuard.Venue(uint8(venue_))
            }),
            adapterCodeHashAllowed[adapter_.codehash],
            address(_USDC),
            window_,
            MIN_POOL_LIQUIDITY
        );
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
