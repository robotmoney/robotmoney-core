// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0010-unified-vault-architecture.md §4 (AssetPositionAdapter);
//            docs/technical/unified-vault-spec.md §4.3 (adapter);
//            docs/technical/unified-vault-open-questions-resolution.md;
//            docs/technical/unified-vault-seam-map.json (contracts/adapters/ entry).
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {IPositionAdapter} from "../interfaces/IPositionAdapter.sol";
import {IBasketSwapAdapter} from "../interfaces/IBasketSwapAdapter.sol";
import {ForeignTokenQuarantine} from "../lib/ForeignTokenQuarantine.sol";
import {BasketAssetConfigGuard} from "../lib/BasketAssetConfigGuard.sol";
import {TwapTickMath} from "../lib/TwapTickMath.sol";

/// @title UniswapV3AssetPositionAdapter
/// @notice The first *inexact* `IPositionAdapter` (ADR-0010 §4): it custodies a
///         single basket token and makes it look like a yield-bearing position to
///         the unified Vault. `deploy` swaps USDC→token, `withdraw` swaps
///         token→USDC (both through the venue-agnostic `IBasketSwapAdapter` seam),
///         `totalAssets()` prices the held token at a configurable TWAP window,
///         and every mutating path is `onlyVault`. This is the extraction target
///         for BasketVault's swap/TWAP/ORA-4 code (seam-map
///         contracts/vaults/BasketVault.sol → contracts/adapters/): the swap
///         executor, the per-asset TWAP window + bounds/fallback, the ORA-4
///         NAV-deviation guard (entry-side inside `deploy`), and the pool-usability
///         constructor preconditions all move here verbatim.
///
/// @dev    `isExact()` is hardcoded `false`: `deploy`/`withdraw` are slippage-priced
///         swaps, and `totalAssets()` is a TWAP mark, NOT a 1:1 redemption claim.
///         The vault reads its own attested `AdapterInfo.isExact` for share-critical
///         branches (spec §2.2, C2); this view is registration cross-check +
///         monitoring only.
///
///         Custody invariants (INV-1/INV-2): `harvestRewards()` is a no-op (spot V3
///         custody has no discrete claimable rewards) and never reverts;
///         `sweepForeignToken` refuses the protected set (USDC + the custodied
///         `TOKEN`) and routes everything else to the fixed quarantine sink — never
///         a caller-supplied recipient, and never the custodied token.
contract UniswapV3AssetPositionAdapter is IPositionAdapter {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ─── Constants (verbatim from BasketVault) ────────────────────────

    uint256 internal constant MAX_BPS = 10_000;

    /// @notice Hard ceiling for the per-swap slippage tolerance (5%). Mirrors
    ///         `BasketVault.MAX_SLIPPAGE_BPS`.
    uint256 public constant MAX_SLIPPAGE_BPS = 500;

    /// @notice TWAP window bounds + default (10 min / 24 h / 30 min), verbatim
    ///         from `BasketVault.{MIN,MAX,DEFAULT}_TWAP_WINDOW`.
    uint32 public constant MIN_TWAP_WINDOW = 600;
    uint32 public constant MAX_TWAP_WINDOW = 86_400;
    uint32 public constant DEFAULT_TWAP_WINDOW = 1_800;

    /// @notice Hard ceiling for `navDeviationGuardBps` (20%), verbatim from
    ///         `BasketVault.MAX_NAV_DEVIATION_BPS`.
    uint256 public constant MAX_NAV_DEVIATION_BPS = 2_000;

    /// @notice Pool-usability floors asserted in the constructor, verbatim from
    ///         `BasketVault.{MIN_POOL_CARDINALITY,MIN_POOL_LIQUIDITY}`.
    uint16 public constant MIN_POOL_CARDINALITY = 2;
    uint128 public constant MIN_POOL_LIQUIDITY = 1e6;

    /// @notice Fixed probe amount used only for the ORA-4 spot-vs-TWAP divergence
    ///         ratio. Decimals cancel in the |spot − twap|/twap ratio, so the
    ///         absolute value is irrelevant as long as it is non-zero.
    uint256 internal constant NAV_DEVIATION_PROBE = 1e18;

    /// @notice The `ADMIN_ROLE` bytes32 queried on `VAULT` for config setters.
    /// @dev Matches `BasketVault.ADMIN_ROLE` / `RobotMoneyVault.ADMIN_ROLE`.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // ─── Immutables ───────────────────────────────────────────────────

    /// @inheritdoc IPositionAdapter
    address public immutable USDC;
    /// @inheritdoc IPositionAdapter
    address public immutable VAULT;
    /// @notice The single basket token this adapter custodies and prices.
    address public immutable TOKEN;
    /// @notice The Uniswap V3 pool pairing `TOKEN` with `USDC` used for TWAP reads.
    address public immutable POOL;
    /// @notice Uniswap fee tier for the execution pool (must resolve to `POOL`).
    uint24 public immutable SWAP_FEE;
    /// @notice Venue executor implementing the `IBasketSwapAdapter` swap+TWAP seam.
    IBasketSwapAdapter public immutable SWAP_ADAPTER;

    // ─── Per-instance config (onlyVaultAdmin) ─────────────────────────

    /// @notice Per-asset TWAP window in seconds. `0` ⇒ `DEFAULT_TWAP_WINDOW`.
    uint32 public twapWindow;
    /// @notice Per-swap slippage tolerance in bps (the min-out floor). Bounded
    ///         above by `MAX_SLIPPAGE_BPS`.
    uint256 public maxSlippageBps;
    /// @notice ORA-4 NAV-deviation guard threshold in bps. `0` disables the guard.
    ///         Bounded above by `MAX_NAV_DEVIATION_BPS`.
    uint256 public navDeviationGuardBps;

    // ─── Errors ───────────────────────────────────────────────────────
    // OnlyVault / SlippageExceeded are inherited from IPositionAdapter and are
    // NOT re-declared here (#1116 frozen surface). NavMarketDeviationExceeded is
    // reverted by the shared TwapTickMath library. Protected-token sweeps revert
    // ForeignTokenQuarantine.TokenIsProtected.

    /// @dev A constructor immutable was the zero address.
    error ZeroAddress();
    /// @dev A config setter received an out-of-range value.
    error InvalidParam();
    /// @dev The caller is not the `VAULT`'s ADMIN_ROLE holder (config setters).
    error OnlyVaultAdmin();

    // ─── Events ───────────────────────────────────────────────────────

    event TwapWindowUpdated(uint32 oldWindow, uint32 newWindow);
    event MaxSlippageUpdated(uint256 oldBps, uint256 newBps);
    event NavDeviationGuardUpdated(uint256 oldBps, uint256 newBps);
    event Deployed(uint256 usdcIn, uint256 valueAdded);
    event Withdrawn(uint256 usdcWanted, uint256 usdcOut);

    // ─── Modifiers ─────────────────────────────────────────────────────

    /// @dev Every mutating position path is `onlyVault` (INV-1 authority binding).
    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    /// @dev Config setters are gated by the VAULT's transitive `ADMIN_ROLE`; the
    ///      adapter carries no independent role tree (seam-map contracts/adapters/).
    modifier onlyVaultAdmin() {
        if (!IAccessControl(VAULT).hasRole(ADMIN_ROLE, msg.sender)) revert OnlyVaultAdmin();
        _;
    }

    // ─── Constructor ────────────────────────────────────────────────────

    /// @param usdc_        USDC token this adapter denominates in.
    /// @param vault_       The single vault this adapter is bound to (INV-1).
    /// @param token_       The basket token custodied and priced.
    /// @param pool_        The Uniswap V3 pool pairing `token_`/`usdc_` (TWAP source).
    /// @param swapFee_     Uniswap fee tier of the execution pool (ORA-3: resolves to `pool_`).
    /// @param swapAdapter_ Venue executor implementing `IBasketSwapAdapter`.
    /// @dev Asserts the pool-usability preconditions (pair match, TWAP cardinality
    ///      + observation history over `DEFAULT_TWAP_WINDOW`, in-range liquidity)
    ///      at construction via the shared `BasketAssetConfigGuard`, and pins the
    ///      execution pool resolved from `swapFee_` to `pool_` (ORA-3).
    constructor(
        address usdc_,
        address vault_,
        address token_,
        address pool_,
        uint24 swapFee_,
        address swapAdapter_
    ) {
        if (
            usdc_ == address(0) || vault_ == address(0) || token_ == address(0)
                || pool_ == address(0) || swapAdapter_ == address(0)
        ) {
            revert ZeroAddress();
        }

        // ORA-3 / F-09: the pool the NAV TWAP is read from must be the pool trades
        // execute against (fee tier for Uniswap V3).
        BasketAssetConfigGuard.requireExecutionPoolMatchesTwap(
            pool_, swapFee_, BasketAssetConfigGuard.Venue.V3
        );
        // Pool usability: pairs token/USDC, enough TWAP cardinality + observation
        // history, and enough in-range liquidity for synchronous redemption.
        BasketAssetConfigGuard.requirePoolUsable(
            pool_, token_, usdc_, DEFAULT_TWAP_WINDOW, MIN_POOL_CARDINALITY, MIN_POOL_LIQUIDITY
        );

        USDC = usdc_;
        VAULT = vault_;
        TOKEN = token_;
        POOL = pool_;
        SWAP_FEE = swapFee_;
        SWAP_ADAPTER = IBasketSwapAdapter(swapAdapter_);

        maxSlippageBps = MAX_SLIPPAGE_BPS;
    }

    // ─── IPositionAdapter: position lifecycle ───────────────────────────

    /// @inheritdoc IPositionAdapter
    /// @dev Choreography: the vault has already `safeTransfer`ed `usdcIn` USDC to
    ///      this adapter. Guards the entry mark with the ORA-4 NAV-deviation check,
    ///      swaps USDC→TOKEN through the venue seam with a TWAP-derived min-out, and
    ///      credits the realized USDC-denominated increase in `totalAssets()`.
    ///      Reverts `SlippageExceeded` when `valueAdded < minValueOut` (no clamp).
    function deploy(uint256 usdcIn, uint256 minValueOut)
        external
        onlyVault
        returns (uint256 valueAdded)
    {
        if (usdcIn == 0) return 0;
        uint32 window = effectiveTwapWindow();

        // ORA-4 / F-10 (entry-side): halt when the executable spot has diverged
        // from the NAV-pricing TWAP beyond the configured threshold — minting the
        // vault's shares against a stale/manipulated mark is the F-16 leak's entry
        // leg. No-op when the guard is disabled (bps == 0).
        TwapTickMath.requireWithinDeviation(
            POOL, TOKEN, USDC, window, NAV_DEVIATION_PROBE, navDeviationGuardBps
        );

        // slither-disable-start reentrancy-balance
        // Justification: `taBefore`/post-swap `totalAssets()` is the standard
        // balance-delta pattern to measure the realized NAV increase the swap
        // delivered. Only the `VAULT` (whose deposit entrypoint is `nonReentrant`
        // at the call site) can call this `onlyVault` function, so re-entry via
        // `SWAP_ADAPTER.swap` is not reachable; USDC/TOKEN are not ERC777 tokens.
        uint256 taBefore = totalAssets();

        // Venue min-out floor = TWAP token estimate haircut by the slippage bound.
        uint256 expectedToken = SWAP_ADAPTER.twapPrice(POOL, USDC, TOKEN, usdcIn, window);
        uint256 minTokenOut = expectedToken.mulDiv(MAX_BPS - maxSlippageBps, MAX_BPS);

        IERC20(USDC).forceApprove(address(SWAP_ADAPTER), usdcIn);
        SWAP_ADAPTER.swap(
            USDC, TOKEN, SWAP_FEE, usdcIn, minTokenOut, address(this), block.timestamp
        );
        IERC20(USDC).forceApprove(address(SWAP_ADAPTER), 0);

        // Credit the realized NAV delta (spec §2.2). taBefore/after are TWAP marks.
        valueAdded = totalAssets() - taBefore;
        // slither-disable-end reentrancy-balance
        if (valueAdded < minValueOut) revert SlippageExceeded();
        emit Deployed(usdcIn, valueAdded);
    }

    /// @inheritdoc IPositionAdapter
    /// @dev Liquidates enough TOKEN to raise `usdcWanted` USDC (TWAP-estimated),
    ///      clamped at the held balance (`type(uint256).max` ⇒ sell all). The
    ///      effective floor is `max(minUsdcOut, adapterInternalFloor)` where the
    ///      internal floor is the slippage-haircut TWAP value of the tokens sold;
    ///      shortfall against the floor reverts `SlippageExceeded`, shortfall
    ///      against `usdcWanted` above the floor clamps. Proceeds are delivered
    ///      straight to `VAULT`.
    function withdraw(uint256 usdcWanted, uint256 minUsdcOut)
        external
        onlyVault
        returns (uint256 usdcOut)
    {
        // slither-disable-start reentrancy-balance
        // Justification: `tokenBal` is the standard held-balance read used to size
        // and clamp the liquidation, and `usdcOut` is the swap's realized proceeds.
        // Only the `VAULT` (whose withdraw entrypoint is `nonReentrant` at the call
        // site) can call this `onlyVault` function, so re-entry via
        // `SWAP_ADAPTER.swap`/`twapPrice` is not reachable; TOKEN/USDC are not
        // ERC777 tokens.
        uint256 tokenBal = IERC20(TOKEN).balanceOf(address(this));
        if (tokenBal == 0) return 0;
        uint32 window = effectiveTwapWindow();

        // How much TOKEN to sell to raise usdcWanted (clamped at balance).
        uint256 tokenToSell;
        if (usdcWanted == type(uint256).max) {
            tokenToSell = tokenBal;
        } else {
            tokenToSell = SWAP_ADAPTER.twapPrice(POOL, USDC, TOKEN, usdcWanted, window);
            if (tokenToSell > tokenBal) tokenToSell = tokenBal;
        }
        if (tokenToSell == 0) return 0;

        // Adapter-internal floor = slippage-haircut TWAP USDC value of tokens sold.
        uint256 twapUsdc = SWAP_ADAPTER.twapPrice(POOL, TOKEN, USDC, tokenToSell, window);
        uint256 internalFloor = twapUsdc.mulDiv(MAX_BPS - maxSlippageBps, MAX_BPS);
        uint256 effectiveFloor = minUsdcOut > internalFloor ? minUsdcOut : internalFloor;

        // Pass the internal floor as the venue amountOutMinimum (defence-in-depth);
        // the composed `effectiveFloor` is enforced below with the canonical
        // SlippageExceeded selector (spec §2.2 floor composition).
        IERC20(TOKEN).forceApprove(address(SWAP_ADAPTER), tokenToSell);
        usdcOut = SWAP_ADAPTER.swap(
            TOKEN, USDC, SWAP_FEE, tokenToSell, internalFloor, VAULT, block.timestamp
        );
        IERC20(TOKEN).forceApprove(address(SWAP_ADAPTER), 0);

        if (usdcOut < effectiveFloor) revert SlippageExceeded();
        // slither-disable-end reentrancy-balance
        emit Withdrawn(usdcWanted, usdcOut);
    }

    // ─── IPositionAdapter: views ────────────────────────────────────────

    /// @inheritdoc IPositionAdapter
    /// @dev TWAP-priced USDC value of the held TOKEN. Returns 0 on a zero balance
    ///      WITHOUT touching the oracle (SUP-5). Spot (`slot0`) is never read here
    ///      (ORA-1): pricing is the arithmetic-mean-tick TWAP over the configured
    ///      window, via the venue seam.
    function totalAssets() public view returns (uint256) {
        uint256 bal = IERC20(TOKEN).balanceOf(address(this));
        if (bal == 0) return 0;
        return SWAP_ADAPTER.twapPrice(POOL, TOKEN, USDC, bal, effectiveTwapWindow());
    }

    /// @inheritdoc IPositionAdapter
    /// @dev Always `false`: swap-priced asset custody is never a 1:1 redemption claim.
    function isExact() external pure returns (bool) {
        return false;
    }

    /// @inheritdoc IPositionAdapter
    /// @dev Spot Uniswap V3 custody has no discrete claimable reward tokens — this
    ///      is a no-op and MUST NOT revert (INV-2). Price appreciation accrues in
    ///      the held TOKEN balance and is already reflected in `totalAssets()`.
    function harvestRewards() external {}

    /// @inheritdoc IPositionAdapter
    /// @dev Protected set: USDC and the custodied `TOKEN` (both stay in NAV and
    ///      accrue pro-rata) — reverts on those (INV-2). There is no venue
    ///      receipt/share token for spot V3 custody. Everything else is swept
    ///      permissionlessly to the fixed quarantine sink (never caller-supplied,
    ///      INV-1).
    function sweepForeignToken(address token) external {
        if (token == USDC || token == TOKEN) {
            revert ForeignTokenQuarantine.TokenIsProtected(token);
        }
        ForeignTokenQuarantine.sweep(token, msg.sender);
    }

    // ─── Config views + setters (onlyVaultAdmin) ────────────────────────

    /// @notice Effective TWAP window: the configured per-asset value or
    ///         `DEFAULT_TWAP_WINDOW` when unset. Mirrors
    ///         `BasketVault.effectiveTwapWindow`.
    function effectiveTwapWindow() public view returns (uint32) {
        uint32 w = twapWindow;
        return w == 0 ? DEFAULT_TWAP_WINDOW : w;
    }

    /// @notice Set the per-asset TWAP window. Must fall in
    ///         `[MIN_TWAP_WINDOW, MAX_TWAP_WINDOW]`.
    function setTwapWindow(uint32 window) external onlyVaultAdmin {
        if (window < MIN_TWAP_WINDOW || window > MAX_TWAP_WINDOW) revert InvalidParam();
        emit TwapWindowUpdated(twapWindow, window);
        twapWindow = window;
    }

    /// @notice Set the per-swap slippage tolerance (min-out floor). Bounded above
    ///         by `MAX_SLIPPAGE_BPS`.
    function setMaxSlippageBps(uint256 newBps) external onlyVaultAdmin {
        if (newBps > MAX_SLIPPAGE_BPS) revert InvalidParam();
        emit MaxSlippageUpdated(maxSlippageBps, newBps);
        maxSlippageBps = newBps;
    }

    /// @notice Set the ORA-4 NAV-deviation guard threshold. `0` disables the
    ///         guard; any non-zero value must be `<= MAX_NAV_DEVIATION_BPS`.
    function setNavDeviationGuardBps(uint256 newBps) external onlyVaultAdmin {
        if (newBps > MAX_NAV_DEVIATION_BPS) revert InvalidParam();
        emit NavDeviationGuardUpdated(navDeviationGuardBps, newBps);
        navDeviationGuardBps = newBps;
    }
}
