// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.1 — Vault Family (basket vault base)
// (See also: docs/technical/basket-vault-gap-report.md — router-eligibility checklist)
// PROTOTYPE base — subclasses must complete production-readiness gating
// (router eligibility, audit, etc.) before deployment to mainnet weight.
// NAV and emergency-unwind minimums derive from a Uniswap V3 TWAP via
// `observe()` over an admin-configurable per-asset window; `slot0` is no
// longer read on hot paths. See issue #451 and docs/security-model.md §5.
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISwapRouter} from "../interfaces/ISwapRouter.sol";
import {IUniswapV3Pool} from "../interfaces/IUniswapV3Pool.sol";
import {TickMath} from "../lib/TickMath.sol";

/// @title BasketVault
/// @notice Abstract ERC-4626 USDC vault that holds a basket of ERC-20 assets.
///         Deposits are split equally across active basket assets via Uniswap V3
///         single-hop swaps. Withdrawals swap each asset back to USDC proportionally.
///         NAV is denominated in USDC using a Uniswap V3 TWAP (time-weighted
///         arithmetic-mean tick) over a per-asset, admin-configurable window.
///
///         Subclasses set the vault name/symbol, max basket size, and default slippage.
abstract contract BasketVault is ERC4626, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ─── Roles ────────────────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");

    // ─── Immutable constants ──────────────────────────────────────────

    uint256 public constant MAX_EXIT_FEE_BPS = 100; // 1%
    uint256 public constant MAX_SLIPPAGE_BPS = 500; // 5% hard ceiling
    uint256 public constant MAX_BPS = 10_000;

    // ─── TWAP oracle config ───────────────────────────────────────────
    //
    // BasketVault prices NAV and swap minimums from a Uniswap V3 TWAP, computed
    // as the arithmetic-mean tick returned by `IUniswapV3Pool.observe()` over
    // the configured per-asset window. Slot0 is never consulted on hot paths.
    //
    // The pool's observation cardinality MUST be large enough to cover the
    // configured window across realistic block intervals; otherwise
    // `observe()` will revert ("OLD") and NAV / unwind reads will fail closed.
    // ADMIN_ROLE is expected to verify cardinality off-chain before raising
    // the per-asset window (the typical sequence is
    // `pool.increaseObservationCardinalityNext(...)` then governance setter).

    /// @notice Minimum permitted TWAP window in seconds. Floors the admin's
    ///         configuration so a single ADMIN_ROLE write cannot collapse the
    ///         oracle to near-spot pricing.
    uint32 public constant MIN_TWAP_WINDOW = 600; // 10 minutes
    /// @notice Maximum permitted TWAP window. Caps observation buffer pressure
    ///         and keeps NAV responsive on slow-moving assets.
    uint32 public constant MAX_TWAP_WINDOW = 86_400; // 24 hours
    /// @notice Default TWAP window applied when an asset is added before
    ///         ADMIN_ROLE has set an explicit per-asset window.
    uint32 public constant DEFAULT_TWAP_WINDOW = 1_800; // 30 minutes

    // ─── Asset registry ───────────────────────────────────────────────

    struct AssetInfo {
        address token;
        address pool; // Uniswap V3 pool pairing token with USDC
        uint24 swapFee; // Uniswap V3 fee tier for exactInputSingle swaps
        bool active;
    }

    struct EmergencyUnwindGuard {
        uint256 minUsdcOut;
        bool overrideAllowed;
        // Maximum acceptable loss (in basis points) versus `minUsdcOut` when the
        // override path is used. The override floor is computed as
        // `minUsdcOut * (MAX_BPS - maxLossBps) / MAX_BPS`. A `maxLossBps` of
        // `MAX_BPS` reproduces the legacy zero-floor behaviour; a value of `0`
        // forbids any loss versus the reference floor.
        uint256 maxLossBps;
    }

    AssetInfo[] public assets;

    // ─── Immutables ───────────────────────────────────────────────────

    ISwapRouter public immutable SWAP_ROUTER;
    IERC20 internal immutable _USDC;

    // ─── Config ───────────────────────────────────────────────────────

    uint256 public tvlCap;
    uint256 public perDepositCap;
    uint256 public exitFeeBps;
    address public feeRecipient;
    uint256 public maxSlippageBps;
    bool public shutdown;
    mapping(address => EmergencyUnwindGuard) public emergencyUnwindGuard;
    /// @notice Per-asset TWAP window in seconds. `0` falls back to
    ///         `DEFAULT_TWAP_WINDOW` so newly registered assets are
    ///         immediately manipulation-resistant; ADMIN_ROLE may raise the
    ///         window per asset within `[MIN_TWAP_WINDOW, MAX_TWAP_WINDOW]`.
    mapping(address => uint32) public twapWindow;

    // ─── Events ───────────────────────────────────────────────────────

    event AssetAdded(uint256 indexed index, address indexed token, address pool, uint24 swapFee);
    event AssetRemoved(uint256 indexed index, address indexed token);
    event Swapped(
        address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut
    );
    event ExitFeeCharged(
        address indexed owner, address indexed receiver, uint256 gross, uint256 fee, uint256 net
    );
    event TvlCapUpdated(uint256 oldCap, uint256 newCap);
    event PerDepositCapUpdated(uint256 oldCap, uint256 newCap);
    event ExitFeeUpdated(uint256 oldBps, uint256 newBps);
    event FeeRecipientUpdated(address oldRecipient, address newRecipient);
    event MaxSlippageUpdated(uint256 oldBps, uint256 newBps);
    event Shutdown();
    event EmergencyTokenRecovered(address indexed token, address indexed to, uint256 amount);
    event EmergencyUnwindGuardSet(
        address indexed token,
        uint256 oldMinUsdcOut,
        uint256 newMinUsdcOut,
        bool overrideAllowed,
        uint256 maxLossBps
    );
    /// @dev Emitted whenever the override path is exercised. `appliedFloor` is the
    ///      `amountOutMinimum` actually passed to the router after the upper-loss
    ///      cap was applied, so off-chain operators can audit how much loss
    ///      versus `minUsdcOut` the EMERGENCY_ROLE accepted on this swap.
    event EmergencyUnwindOverrideUsed(
        address indexed token,
        uint256 amountIn,
        uint256 minUsdcOut,
        uint256 appliedFloor,
        address indexed caller
    );
    /// @dev Emitted when ADMIN_ROLE updates the TWAP window for an asset.
    ///      Off-chain monitors can use the delta between `oldWindow` and
    ///      `newWindow` to detect governance shortening the oracle window.
    event TwapWindowUpdated(address indexed token, uint32 oldWindow, uint32 newWindow);

    // ─── Errors ───────────────────────────────────────────────────────

    error TVLCapExceeded();
    error PerDepositCapExceeded();
    error ZeroAddress();
    error VaultShutdown();
    error InvalidFee();
    error InvalidParam();
    error MaxAssetsReached();
    error AssetNotFound();
    error AssetStillHeld();
    error NoActiveAssets();
    error CannotRescueUsdc();
    error EmergencyUnwindOverrideDisabled();
    error PoolTokenMismatch();
    error AssetInBasket();
    /// @dev Raised when a router swap on the override path returns less USDC than
    ///      the upper-loss cap permits. The cap is configured per-token via
    ///      `setEmergencyUnwindGuard` and bounds the realized loss versus the
    ///      admin-set reference floor `minUsdcOut`.
    error EmergencyUnwindLossCapExceeded(address token, uint256 received, uint256 appliedFloor);
    /// @dev Raised when ADMIN_ROLE attempts to set a TWAP window outside the
    ///      `[MIN_TWAP_WINDOW, MAX_TWAP_WINDOW]` range. Surfaces a typed error
    ///      rather than a generic `InvalidParam` so off-chain governance
    ///      tooling can pin-point the failure mode.
    error InvalidTwapWindow(uint32 window);

    // ─── Constructor ─────────────────────────────────────────────────

    constructor(
        string memory name_,
        string memory symbol_,
        IERC20 usdc_,
        ISwapRouter swapRouter_,
        uint256 tvlCap_,
        uint256 perDepositCap_,
        uint256 exitFeeBps_,
        uint256 initialSlippageBps_,
        address feeRecipient_,
        address admin_
    ) ERC4626(usdc_) ERC20(name_, symbol_) {
        if (
            address(usdc_) == address(0) || address(swapRouter_) == address(0)
                || feeRecipient_ == address(0) || admin_ == address(0)
        ) revert ZeroAddress();
        if (exitFeeBps_ > MAX_EXIT_FEE_BPS) revert InvalidFee();
        if (initialSlippageBps_ > MAX_SLIPPAGE_BPS) revert InvalidParam();

        _USDC = usdc_;
        SWAP_ROUTER = swapRouter_;
        tvlCap = tvlCap_;
        perDepositCap = perDepositCap_;
        exitFeeBps = exitFeeBps_;
        maxSlippageBps = initialSlippageBps_;
        feeRecipient = feeRecipient_;

        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _setRoleAdmin(EMERGENCY_ROLE, ADMIN_ROLE);
        _grantRole(ADMIN_ROLE, admin_);
        _grantRole(EMERGENCY_ROLE, admin_);
    }

    /// @notice Subclasses declare the maximum number of assets in the basket.
    function maxAssets() public view virtual returns (uint256);

    // ─── Production-readiness gate ────────────────────────────────────
    //
    // BasketVault NAV and emergency-unwind minimums derive from a Uniswap V3
    // TWAP (arithmetic-mean tick over the configured per-asset window) via
    // `IUniswapV3Pool.observe()`. `slot0` is not consulted on hot paths, so
    // a flash-loan / sandwich that distorts the spot price within a single
    // block cannot move NAV by more than (window / 1) × (block time / window)
    // — i.e. a single manipulated block adds at most one block-tick to a
    // many-block average. The abstract base still self-declares as a
    // prototype: subclasses must additionally certify their pool's
    // observation cardinality, liquidity floor, and per-asset window before
    // overriding `isPrototype()` to return `false`. This keeps the
    // `PortfolioRouter` gate closed by default and forces subclass authors
    // to acknowledge the TWAP-configuration prerequisites.
    //
    // `isPrototype()` remains the on-chain marker used by `PortfolioRouter`
    // to block accidental inclusion in production router weight vectors
    // (see `PortfolioRouter._requireRouterEligible` and the prototype
    // override surface). See issue #451 and
    // docs/code-reviews/review-codex-20260518-234945.md.

    /// @notice True iff this contract is a prototype that has not completed
    ///         oracle / production-readiness hardening. Defaults to `true`
    ///         at the abstract base; a TWAP-configured, audited subclass may
    ///         override and return `false`. Read by `PortfolioRouter` to
    ///         refuse production router eligibility absent an explicit
    ///         override.
    /// @dev Marked `virtual` so a hardened subclass may opt into production
    ///      router weight after asserting pool-cardinality and per-asset
    ///      TWAP-window prerequisites are satisfied off-chain. The base
    ///      contract intentionally keeps the gate closed.
    function isPrototype() public pure virtual returns (bool) {
        return true;
    }

    // ─── ERC-4626 share scale ─────────────────────────────────────────

    function decimals() public pure override(ERC4626) returns (uint8) {
        return 6;
    }

    // Large virtual offset makes first-deposit inflation attacks economically infeasible.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 18;
    }

    // ─── totalAssets ─────────────────────────────────────────────────

    /// @notice USDC value of all held assets (idle USDC + TWAP-priced basket assets).
    function totalAssets() public view override returns (uint256) {
        uint256 sum = _USDC.balanceOf(address(this));
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            uint256 bal = IERC20(assets[i].token).balanceOf(address(this));
            if (bal > 0) sum += _twapUsdcValue(assets[i].pool, assets[i].token, bal);
        }
        return sum;
    }

    // ─── Deposit ─────────────────────────────────────────────────────

    function _deposit(address caller, address receiver, uint256 usdcAmount, uint256 shares)
        internal
        override
        whenNotPaused
        nonReentrant
    {
        if (shutdown) revert VaultShutdown();
        if (usdcAmount > perDepositCap) revert PerDepositCapExceeded();
        // Pre-swap totalAssets() check; post-swap NAV may differ slightly due to slippage.
        if (totalAssets() + usdcAmount > tvlCap) revert TVLCapExceeded();
        if (_activeAssetCount() == 0) revert NoActiveAssets();

        // Pulls USDC from caller and mints shares.
        super._deposit(caller, receiver, usdcAmount, shares);
        _routeDeposit(usdcAmount);
    }

    /// @dev Splits usdcAmount equally across active assets, swapping each portion via Uniswap V3.
    ///      The first active asset absorbs any indivisible remainder.
    function _routeDeposit(uint256 usdcAmount) internal {
        uint256 n = _activeAssetCount();
        if (n == 0 || usdcAmount == 0) return;

        uint256 perAsset = usdcAmount / n;
        uint256 remainder = usdcAmount - perAsset * n;
        uint256 len = assets.length;
        bool firstActive = true;

        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            uint256 swapIn = firstActive ? perAsset + remainder : perAsset;
            firstActive = false;
            if (swapIn == 0) continue;

            uint256 minOut = _twapTokenValue(assets[i].pool, assets[i].token, swapIn)
                * (MAX_BPS - maxSlippageBps) / MAX_BPS;

            _USDC.safeIncreaseAllowance(address(SWAP_ROUTER), swapIn);
            uint256 amountOut = SWAP_ROUTER.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: address(_USDC),
                    tokenOut: assets[i].token,
                    fee: assets[i].swapFee,
                    recipient: address(this),
                    amountIn: swapIn,
                    amountOutMinimum: minOut,
                    sqrtPriceLimitX96: 0
                })
            );
            emit Swapped(address(_USDC), assets[i].token, swapIn, amountOut);
        }
    }

    // ─── Withdraw / redeem ────────────────────────────────────────────

    /// @notice Estimated USDC received when redeeming `shares` (spot-priced, pre-slippage).
    function previewRedeem(uint256 shares) public view override returns (uint256) {
        uint256 gross = _convertToAssets(shares, Math.Rounding.Floor);
        return gross - gross.mulDiv(exitFeeBps, MAX_BPS);
    }

    /// @notice Estimated shares required to receive `assets_` net USDC (spot-priced, pre-slippage).
    function previewWithdraw(uint256 assets_) public view override returns (uint256) {
        uint256 gross = exitFeeBps == 0
            ? assets_
            : assets_.mulDiv(MAX_BPS, MAX_BPS - exitFeeBps, Math.Rounding.Ceil);
        return _convertToShares(gross, Math.Rounding.Ceil);
    }

    /// @dev Ignores the ERC-4626 `assets` parameter because actual USDC received depends
    ///      on swap execution. Users should use `redeem` for this vault type.
    ///      Actual net may be lower than `previewRedeem` by up to `maxSlippageBps`.
    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256, /* assets — unused; actual determined by swaps */
        uint256 shares
    )
        internal
        override
        whenNotPaused
        nonReentrant
    {
        if (caller != owner) _spendAllowance(owner, caller, shares);

        uint256 supplyBefore = totalSupply();
        _burn(owner, shares);

        uint256 usdcReceived = _sellProportional(shares, supplyBefore);

        uint256 fee = usdcReceived.mulDiv(exitFeeBps, MAX_BPS);
        uint256 net = usdcReceived - fee;

        if (fee > 0) {
            _USDC.safeTransfer(feeRecipient, fee);
        }
        _USDC.safeTransfer(receiver, net);

        emit ExitFeeCharged(owner, receiver, usdcReceived, fee, net);
        emit Withdraw(caller, receiver, owner, net, shares);
    }

    /// @dev Sells `shares / supplyBefore` fraction of each active asset and any idle USDC.
    ///      Returns total USDC collected (swap proceeds + idle USDC proportion).
    function _sellProportional(uint256 shares, uint256 supplyBefore)
        internal
        returns (uint256 usdcOut)
    {
        // Idle USDC proportion owed to this redeemer (captured before swaps change balances).
        uint256 idleBefore = _USDC.balanceOf(address(this));
        if (idleBefore > 0) {
            usdcOut += idleBefore.mulDiv(shares, supplyBefore);
        }

        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            uint256 bal = IERC20(assets[i].token).balanceOf(address(this));
            if (bal == 0) continue;

            uint256 sellAmount = bal.mulDiv(shares, supplyBefore);
            if (sellAmount == 0) continue;

            uint256 minUsdcOut = _twapUsdcValue(assets[i].pool, assets[i].token, sellAmount)
                * (MAX_BPS - maxSlippageBps) / MAX_BPS;

            IERC20(assets[i].token).safeIncreaseAllowance(address(SWAP_ROUTER), sellAmount);
            uint256 received = SWAP_ROUTER.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: assets[i].token,
                    tokenOut: address(_USDC),
                    fee: assets[i].swapFee,
                    recipient: address(this),
                    amountIn: sellAmount,
                    amountOutMinimum: minUsdcOut,
                    sqrtPriceLimitX96: 0
                })
            );
            emit Swapped(assets[i].token, address(_USDC), sellAmount, received);
            usdcOut += received;
        }
    }

    // ─── TWAP pricing ─────────────────────────────────────────────────

    /// @dev Returns the USDC value of `tokenAmount` tokens, priced via the
    ///      Uniswap V3 TWAP arithmetic-mean tick over the asset's window.
    function _twapUsdcValue(address pool, address token, uint256 tokenAmount)
        internal
        view
        returns (uint256)
    {
        return _twapQuote(pool, token, address(_USDC), tokenAmount);
    }

    /// @dev Returns the estimated token amount for `usdcAmount` USDC, priced
    ///      via the Uniswap V3 TWAP arithmetic-mean tick over the asset's window.
    function _twapTokenValue(address pool, address token, uint256 usdcAmount)
        internal
        view
        returns (uint256)
    {
        return _twapQuote(pool, address(_USDC), token, usdcAmount);
    }

    /// @notice TWAP-derived window for `token`. Returns the configured
    ///         per-asset window or `DEFAULT_TWAP_WINDOW` when unset.
    /// @dev Exposed as a view so off-chain monitors and tests can sanity-check
    ///      the effective window without reading the raw mapping fallback.
    function effectiveTwapWindow(address token) public view returns (uint32) {
        uint32 w = twapWindow[token];
        return w == 0 ? DEFAULT_TWAP_WINDOW : w;
    }

    /// @dev Compute the time-weighted-average sqrtPriceX96 for `pool` over the
    ///      per-asset window and forward to the shared sqrtPriceX96 ratio math.
    ///      The non-USDC asset's window governs the read: when quoting
    ///      USDC->token (deposit minimums), the token's window is consulted;
    ///      when quoting token->USDC (NAV, withdrawal minimums) the same
    ///      window applies.
    function _twapQuote(address pool, address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (uint256 amountOut)
    {
        if (amountIn == 0) return 0;
        address basketAsset = tokenIn == address(_USDC) ? tokenOut : tokenIn;
        uint32 window = effectiveTwapWindow(basketAsset);

        // Two observations: `window` seconds ago and now. The arithmetic-mean
        // tick over the window is `(tickCumulatives[1] - tickCumulatives[0]) / window`.
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = 0;
        (int56[] memory tickCumulatives,) = IUniswapV3Pool(pool).observe(secondsAgos);
        int56 delta = tickCumulatives[1] - tickCumulatives[0];
        int24 arithmeticMeanTick = int24(delta / int56(uint56(window)));
        // Match Uniswap OracleLibrary rounding: when delta is negative and not
        // exactly divisible by the window, round toward negative infinity so
        // the mean tick does not bias upward.
        if (delta < 0 && (delta % int56(uint56(window)) != 0)) {
            arithmeticMeanTick--;
        }
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(arithmeticMeanTick);

        bool zeroForOne = tokenIn < tokenOut;
        uint256 sqrtP = uint256(sqrtPriceX96);

        if (sqrtP <= type(uint128).max) {
            uint256 ratioX192 = sqrtP * sqrtP;
            amountOut = zeroForOne
                ? amountIn.mulDiv(ratioX192, 1 << 192)
                : amountIn.mulDiv(1 << 192, ratioX192);
        } else {
            uint256 ratioX128 = Math.mulDiv(sqrtP, sqrtP, 1 << 64);
            amountOut = zeroForOne
                ? amountIn.mulDiv(ratioX128, 1 << 128)
                : amountIn.mulDiv(1 << 128, ratioX128);
        }
    }

    // ─── Asset registry management ────────────────────────────────────

    /// @notice Register a new basket asset. Restricted to ADMIN_ROLE.
    /// @param token_   ERC-20 token address.
    /// @param pool_    Uniswap V3 pool pairing `token_` with USDC (either token0 or token1).
    /// @param swapFee_ Uniswap V3 fee tier (500, 3000, or 10000).
    function addAsset(address token_, address pool_, uint24 swapFee_)
        external
        onlyRole(ADMIN_ROLE)
    {
        if (token_ == address(0) || pool_ == address(0)) revert ZeroAddress();
        if (assets.length >= maxAssets()) revert MaxAssetsReached();
        // Verify pool actually pairs this token with USDC.
        address t0 = IUniswapV3Pool(pool_).token0();
        address t1 = IUniswapV3Pool(pool_).token1();
        if (!((t0 == token_ && t1 == address(_USDC)) || (t1 == token_ && t0 == address(_USDC)))) {
            revert PoolTokenMismatch();
        }
        assets.push(AssetInfo({token: token_, pool: pool_, swapFee: swapFee_, active: true}));
        emit AssetAdded(assets.length - 1, token_, pool_, swapFee_);
    }

    /// @notice Deactivate a basket asset. The vault must hold zero of that token. Restricted to ADMIN_ROLE.
    function removeAsset(uint256 index) external onlyRole(ADMIN_ROLE) {
        if (index >= assets.length || !assets[index].active) revert AssetNotFound();
        if (IERC20(assets[index].token).balanceOf(address(this)) > 0) revert AssetStillHeld();
        assets[index].active = false;
        emit AssetRemoved(index, assets[index].token);
    }

    // ─── Emergency ────────────────────────────────────────────────────

    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Pause and swap all basket assets back to USDC using configured minimum outputs.
    /// @dev Reverts when any router leg cannot satisfy its per-token guard.
    function emergencyUnwind() external onlyRole(EMERGENCY_ROLE) nonReentrant {
        _pause();
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            _emergencyUnwindAsset(assets[i], emergencyUnwindGuard[assets[i].token].minUsdcOut);
        }
    }

    /// @notice Explicit high-risk emergency unwind for tokens whose guard permits overrides.
    /// @dev Emits before each swap so off-chain operators can distinguish override use.
    ///      Even on the override path, swap outputs are bounded by an upper-loss
    ///      cap derived from the admin-configured `minUsdcOut` reference floor:
    ///      `appliedFloor = minUsdcOut * (MAX_BPS - maxLossBps) / MAX_BPS`.
    ///      Swaps whose realized USDC output is below `appliedFloor` revert with
    ///      `EmergencyUnwindLossCapExceeded`, preventing sandwich/manipulation
    ///      from realizing catastrophic loss even when override is enabled.
    function emergencyUnwindWithOverride(address[] calldata tokens)
        external
        onlyRole(EMERGENCY_ROLE)
        nonReentrant
    {
        _pause();
        uint256 len = tokens.length;
        for (uint256 i = 0; i < len; i++) {
            EmergencyUnwindGuard memory guard = emergencyUnwindGuard[tokens[i]];
            if (!guard.overrideAllowed) revert EmergencyUnwindOverrideDisabled();
            AssetInfo memory assetInfo = _activeAssetForToken(tokens[i]);
            uint256 bal = IERC20(assetInfo.token).balanceOf(address(this));
            if (bal == 0) continue;
            uint256 appliedFloor = guard.minUsdcOut * (MAX_BPS - guard.maxLossBps) / MAX_BPS;
            emit EmergencyUnwindOverrideUsed(
                assetInfo.token, bal, guard.minUsdcOut, appliedFloor, msg.sender
            );
            _emergencyUnwindAssetWithCap(assetInfo, appliedFloor);
        }
    }

    function shutdownVault() external onlyRole(EMERGENCY_ROLE) {
        shutdown = true;
        tvlCap = 0;
        emit Shutdown();
    }

    /// @notice Recover accidentally sent ERC-20 tokens (not USDC or basket assets). ADMIN_ROLE.
    function rescueTokens(address token, address to) external onlyRole(ADMIN_ROLE) {
        if (token == address(_USDC)) revert CannotRescueUsdc();
        if (to == address(0)) revert ZeroAddress();
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (token == assets[i].token) revert AssetInBasket();
        }
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, balance);
        emit EmergencyTokenRecovered(token, to, balance);
    }

    // ─── Param setters ────────────────────────────────────────────────

    function setTvlCap(uint256 newCap) external onlyRole(ADMIN_ROLE) {
        emit TvlCapUpdated(tvlCap, newCap);
        tvlCap = newCap;
    }

    function setPerDepositCap(uint256 newCap) external onlyRole(ADMIN_ROLE) {
        emit PerDepositCapUpdated(perDepositCap, newCap);
        perDepositCap = newCap;
    }

    function setExitFeeBps(uint256 newBps) external onlyRole(ADMIN_ROLE) {
        if (newBps > MAX_EXIT_FEE_BPS) revert InvalidFee();
        emit ExitFeeUpdated(exitFeeBps, newBps);
        exitFeeBps = newBps;
    }

    function setFeeRecipient(address newRecipient) external onlyRole(ADMIN_ROLE) {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, newRecipient);
        feeRecipient = newRecipient;
    }

    function setMaxSlippageBps(uint256 newBps) external onlyRole(ADMIN_ROLE) {
        if (newBps > MAX_SLIPPAGE_BPS) revert InvalidParam();
        emit MaxSlippageUpdated(maxSlippageBps, newBps);
        maxSlippageBps = newBps;
    }

    /// @notice Configure per-token minimum USDC output, optional high-risk override
    ///         access, and the upper-loss cap that bounds override-path slippage.
    /// @param token            Active basket asset to configure.
    /// @param minUsdcOut       Admin-set reference floor used as the upper-loss
    ///                         reference on the override path and as the hard
    ///                         minimum on the non-override path.
    /// @param overrideAllowed  Whether the override path may be invoked at all.
    /// @param maxLossBps       Maximum acceptable loss in basis points versus
    ///                         `minUsdcOut` when the override path executes a
    ///                         swap. Must be <= MAX_BPS. A value of `MAX_BPS`
    ///                         (10_000) reproduces the legacy zero-floor
    ///                         behaviour. ADMIN_ROLE is timelock-gated via
    ///                         the existing ADMIN_ROLE pattern (see
    ///                         `docs/security-model.md`).
    function setEmergencyUnwindGuard(
        address token,
        uint256 minUsdcOut,
        bool overrideAllowed,
        uint256 maxLossBps
    ) external onlyRole(ADMIN_ROLE) {
        if (maxLossBps > MAX_BPS) revert InvalidParam();
        _activeAssetForToken(token);
        uint256 oldMin = emergencyUnwindGuard[token].minUsdcOut;
        emergencyUnwindGuard[token] = EmergencyUnwindGuard({
            minUsdcOut: minUsdcOut, overrideAllowed: overrideAllowed, maxLossBps: maxLossBps
        });
        emit EmergencyUnwindGuardSet(token, oldMin, minUsdcOut, overrideAllowed, maxLossBps);
    }

    /// @notice Set the TWAP window in seconds for `token`. ADMIN_ROLE only.
    /// @dev The window must fall inside `[MIN_TWAP_WINDOW, MAX_TWAP_WINDOW]`.
    ///      ADMIN_ROLE is expected to verify off-chain that the pool's
    ///      observation cardinality is large enough to satisfy the requested
    ///      window; otherwise NAV / unwind reads will revert with the pool's
    ///      `"OLD"` error.
    /// @param token   Active basket asset to configure.
    /// @param window  TWAP window in seconds (10 min ≤ window ≤ 24 h).
    function setTwapWindow(address token, uint32 window) external onlyRole(ADMIN_ROLE) {
        if (window < MIN_TWAP_WINDOW || window > MAX_TWAP_WINDOW) {
            revert InvalidTwapWindow(window);
        }
        _activeAssetForToken(token);
        uint32 old = twapWindow[token];
        twapWindow[token] = window;
        emit TwapWindowUpdated(token, old, window);
    }

    // ─── Views ────────────────────────────────────────────────────────

    function assetCount() external view returns (uint256) {
        return assets.length;
    }

    function activeAssetCount() external view returns (uint256) {
        return _activeAssetCount();
    }

    function isShutdown() external view returns (bool) {
        return shutdown;
    }

    // ─── Internal helpers ─────────────────────────────────────────────

    function _activeAssetCount() internal view returns (uint256 count) {
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (assets[i].active) count++;
        }
    }

    function _activeAssetForToken(address token) internal view returns (AssetInfo memory) {
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (assets[i].active && assets[i].token == token) return assets[i];
        }
        revert AssetNotFound();
    }

    function _emergencyUnwindAsset(AssetInfo memory assetInfo, uint256 minUsdcOut) internal {
        uint256 bal = IERC20(assetInfo.token).balanceOf(address(this));
        if (bal == 0) return;
        IERC20(assetInfo.token).safeIncreaseAllowance(address(SWAP_ROUTER), bal);
        uint256 received = SWAP_ROUTER.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: assetInfo.token,
                tokenOut: address(_USDC),
                fee: assetInfo.swapFee,
                recipient: address(this),
                amountIn: bal,
                amountOutMinimum: minUsdcOut,
                sqrtPriceLimitX96: 0
            })
        );
        emit Swapped(assetInfo.token, address(_USDC), bal, received);
    }

    /// @dev Override-path swap helper. Passes `appliedFloor` as the router-level
    ///      `amountOutMinimum` and additionally enforces the cap with a typed
    ///      `EmergencyUnwindLossCapExceeded` revert so off-chain consumers see
    ///      a stable error surface regardless of the underlying router's
    ///      slippage revert format.
    // slither-disable-start reentrancy-balance
    // The caller (`emergencyUnwindWithOverride`) holds the contract-level
    // `nonReentrant` guard, so the pre-call `balanceOf` read cannot be observed
    // by a reentrant call before the swap completes. The post-call comparison
    // against `appliedFloor` uses the router's freshly-returned `received`
    // amount, not the stale `bal`, so the "stale balance used after the call"
    // pattern flagged by slither is a false positive here.
    function _emergencyUnwindAssetWithCap(AssetInfo memory assetInfo, uint256 appliedFloor)
        internal
    {
        uint256 bal = IERC20(assetInfo.token).balanceOf(address(this));
        if (bal == 0) return;
        IERC20(assetInfo.token).safeIncreaseAllowance(address(SWAP_ROUTER), bal);
        uint256 received = SWAP_ROUTER.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: assetInfo.token,
                tokenOut: address(_USDC),
                fee: assetInfo.swapFee,
                recipient: address(this),
                amountIn: bal,
                amountOutMinimum: appliedFloor,
                sqrtPriceLimitX96: 0
            })
        );
        if (received < appliedFloor) {
            revert EmergencyUnwindLossCapExceeded(assetInfo.token, received, appliedFloor);
        }
        emit Swapped(assetInfo.token, address(_USDC), bal, received);
    }
    // slither-disable-end reentrancy-balance
}
