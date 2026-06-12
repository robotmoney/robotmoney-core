// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.1 — Vault Family (basket vault base)
// (See also: docs/technical/basket-vault-gap-report.md — router-eligibility checklist;
//            docs/development/single-production-codebase.md — router-eligibility is
//            registry state set by governance, not a per-environment code variant.)
// Production-readiness for Portfolio Router weighting is expressed as
// `VaultRegistry.isRouterEligible(vault)` — ADMIN_ROLE flips the flag once
// audit / oracle hardening is complete. The same contract ships into every
// environment; only the registry flag's value differs.
// NAV and emergency-unwind minimums derive from a TWAP oracle via the per-asset
// swap adapter's `twapPrice()` method over an admin-configurable per-asset window;
// `slot0` is never read on hot paths. See issue #451 and
// docs/technical/security-model.md §5. Multi-DEX venue abstraction added per
// docs/technical/real-four-vault-demo-seams.md §3 (issue #553). Per-asset
// venue selector (Venue enum) added per issue #555.
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
import {IBasketSwapAdapter} from "../interfaces/IBasketSwapAdapter.sol";
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

    /// @notice DEX venue selector for a basket asset.
    ///         Recorded on AssetInfo so off-chain tooling and governance can
    ///         inspect which DEX each asset is wired to without parsing the
    ///         opaque adapter address.
    ///         V3       — Uniswap V3 via the built-in SWAP_ROUTER (adapter = address(0)).
    ///         V4       — Uniswap V4 via a UniswapV4SwapAdapter.
    ///         Aerodrome — Aerodrome CL pool via an AerodromeSwapAdapter.
    enum Venue {
        V3,
        V4,
        Aerodrome
    }

    struct AssetInfo {
        address token;
        address pool; // DEX pool pairing token with USDC (venue-specific)
        uint24 swapFee; // Fee parameter forwarded to the adapter (e.g. Uniswap V3 fee tier)
        bool active;
        /// @dev Swap + TWAP adapter for this asset. address(0) falls back to the
        ///      default Uniswap V3 path via SWAP_ROUTER, preserving backward compat.
        address adapter;
        /// @notice DEX venue this asset is wired to.
        ///         Mirrors the adapter choice in a human-readable form so governance
        ///         and monitoring tooling can inspect the venue without decoding the
        ///         adapter address.
        Venue venue;
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

    event AssetAdded(
        uint256 indexed index,
        address indexed token,
        address pool,
        uint24 swapFee,
        address adapter,
        Venue venue
    );
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
    /// @dev Emitted on every deposit, recording the equal-weight allocation applied
    ///      to the depositor's inflow. Satisfies the event-stream cost-disclosure
    ///      requirement from docs/architecture.md §8 and ADR-0003.
    ///      `bpsWeights` contains the basis-point weight for each element of `assets`
    ///      (10_000 / n for each active asset, with the remainder allocated to the first).
    event WeightSnapshot(
        address indexed depositor, address[] assets, uint256[] bpsWeights, uint256 timestamp
    );

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
    /// @dev Raised when `setMaxSlippageBps` is called with a value below the
    ///      pool-fee floor of the active basket. A slippage bound below the fee
    ///      tier makes every swap's `amountOutMinimum` unsatisfiable (the fee
    ///      alone consumes more than the allowance), bricking deposits and
    ///      withdrawals (audit 2026-06-09, L-17).
    error SlippageBelowPoolFeeFloor(uint256 requestedBps, uint256 floorBps);
    /// @dev Raised when ADMIN_ROLE attempts to set a TWAP window outside the
    ///      `[MIN_TWAP_WINDOW, MAX_TWAP_WINDOW]` range. Surfaces a typed error
    ///      rather than a generic `InvalidParam` so off-chain governance
    ///      tooling can pin-point the failure mode.
    error InvalidTwapWindow(uint32 window);
    /// @dev Raised by the `rebalance()` stub. Global vault rebalancing is not
    ///      implemented in the MVP. The selector is reserved for Phase B.
    ///      See docs/adr/ADR-0003-basketvault-rebalancing-model.md.
    error NotImplemented();
    /// @dev Raised by addAsset() when the pool's observation cardinality is
    ///      below the minimum required to service TWAP reads over
    ///      `DEFAULT_TWAP_WINDOW`. Cardinality=1 (the Uniswap default) means
    ///      `observe()` reverts with "OLD" for any non-zero secondsAgo, which
    ///      permanently breaks totalAssets(), deposits, and withdrawals for
    ///      every asset in the basket. Call
    ///      `pool.increaseObservationCardinalityNext(required)` before adding
    ///      the asset, then wait until the pool has accumulated enough
    ///      observations to cover the full window before depositing.
    error InsufficientPoolCardinality(address pool, uint16 required, uint16 actual);
    /// @dev Raised by addAsset() when the pool's in-range liquidity (as
    ///      returned by `IUniswapV3Pool.liquidity()`) is below
    ///      `MIN_POOL_LIQUIDITY`. Thin pools cannot guarantee synchronous
    ///      withdrawal at the TWAP-derived slippage bound — a core router-
    ///      eligibility requirement (gap-report §1). Provide depth before
    ///      registering the asset.
    error InsufficientPoolLiquidity(address pool, uint128 required, uint128 actual);
    /// @dev Raised by withdraw() and previewWithdraw(). BasketVault cannot
    ///      guarantee ERC-4626 exactness for proportional-swap exits — use
    ///      redeem() instead, which returns actual swap proceeds.
    error RedeemOnly();

    // ─── Constructor ─────────────────────────────────────────────────

    /// @param admin_              Receives ADMIN_ROLE (cold/multisig key for
    ///                            parameter changes). Must not be address(0).
    /// @param emergencyResponder_ Receives EMERGENCY_ROLE (hot key for rapid
    ///                            unwind/shutdown). Must not be address(0).
    ///                            May equal admin_ as a conscious choice
    ///                            (e.g. in test environments), but operators
    ///                            SHOULD use distinct addresses in production
    ///                            so a single key compromise cannot both alter
    ///                            parameters and trigger an emergency unwind.
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
        address admin_,
        address emergencyResponder_
    ) ERC4626(usdc_) ERC20(name_, symbol_) {
        if (
            address(usdc_) == address(0) || address(swapRouter_) == address(0)
                || feeRecipient_ == address(0) || admin_ == address(0)
                || emergencyResponder_ == address(0)
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
        _grantRole(EMERGENCY_ROLE, emergencyResponder_);
    }

    /// @notice Subclasses declare the maximum number of assets in the basket.
    function maxAssets() public view virtual returns (uint256);

    // ─── Production-readiness gate ────────────────────────────────────
    //
    // BasketVault NAV and emergency-unwind minimums derive from a Uniswap V3
    // TWAP (arithmetic-mean tick over the configured per-asset window) via
    // `IUniswapV3Pool.observe()`. `slot0` is not consulted on hot paths, so
    // a flash-loan / sandwich that distorts the spot price within a single
    // block cannot move NAV by more than (window / 1) × (block time / window).
    //
    // Production-readiness for Portfolio Router weighting is *not* expressed
    // on this contract. It is registry state — VaultRegistry.isRouterEligible(
    // vault) — set by ADMIN_ROLE on the registry once the subclass author
    // has certified pool observation cardinality, liquidity floor, and per-
    // asset TWAP window off-chain. This satisfies the single-production-
    // codebase principle (docs/development/single-production-codebase.md):
    // the same contract ships into test, demo, and mainnet; only the
    // registry flag's value differs across environments. See issue #475 for
    // the history.

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
    /// @dev Marked `virtual` so subclasses (e.g. RwaVault) can inject oracle-freshness
    ///      checks before delegating to this base implementation.
    function totalAssets() public view virtual override returns (uint256) {
        uint256 sum = _USDC.balanceOf(address(this));
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            uint256 bal = IERC20(assets[i].token).balanceOf(address(this));
            if (bal > 0) {
                sum += _twapUsdcValue(assets[i].pool, assets[i].token, assets[i].adapter, bal);
            }
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
        _routeDeposit(caller, usdcAmount);
    }

    /// @dev Splits usdcAmount equally across active assets, swapping each portion via the
    ///      per-asset swap adapter (Aerodrome or Uniswap V3 default).
    ///      The first active asset absorbs any indivisible remainder.
    ///      Emits a WeightSnapshot event recording the equal-weight allocation applied.
    function _routeDeposit(address caller, uint256 usdcAmount) internal {
        uint256 n = _activeAssetCount();
        if (n == 0 || usdcAmount == 0) return;

        uint256 perAsset = usdcAmount / n;
        uint256 remainder = usdcAmount - perAsset * n;
        uint256 len = assets.length;
        bool firstActive = true;

        // Build WeightSnapshot arrays for the active asset set.
        address[] memory snapshotAssets = new address[](n);
        uint256[] memory snapshotWeights = new uint256[](n);
        uint256 baseWeightBps = MAX_BPS / n;
        uint256 remainderWeightBps = MAX_BPS - baseWeightBps * n;
        uint256 snapshotIdx = 0;

        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            uint256 swapIn = firstActive ? perAsset + remainder : perAsset;
            snapshotAssets[snapshotIdx] = assets[i].token;
            snapshotWeights[snapshotIdx] =
                firstActive ? baseWeightBps + remainderWeightBps : baseWeightBps;
            snapshotIdx++;
            firstActive = false;
            if (swapIn == 0) continue;

            uint256 minOut = _twapTokenValue(
                    assets[i].pool, assets[i].token, assets[i].adapter, swapIn
                ) * (MAX_BPS - maxSlippageBps) / MAX_BPS;

            uint256 amountOut = _executeSwap(
                assets[i].adapter,
                address(_USDC),
                assets[i].token,
                assets[i].swapFee,
                swapIn,
                minOut,
                address(this)
            );
            emit Swapped(address(_USDC), assets[i].token, swapIn, amountOut);
        }

        emit WeightSnapshot(caller, snapshotAssets, snapshotWeights, block.timestamp);
    }

    // ─── Withdraw / redeem ────────────────────────────────────────────

    /// @notice Worst-case floor of USDC received when redeeming `shares`.
    ///
    ///         The floor is: TWAP NAV × (1 − maxSlippageBps) × (1 − exitFeeBps).
    ///
    ///         This satisfies the ERC-4626 guarantee that `redeem(s, ...)` returns
    ///         at least `previewRedeem(s)` because:
    ///         1. `totalAssets()` is TWAP-priced (not slot0), so NAV is
    ///            manipulation-resistant.
    ///         2. `maxSlippageBps` is the worst-case slippage passed as
    ///            `amountOutMinimum` to the Uniswap V3 router. Actual swap
    ///            proceeds are always ≥ that floor (or the swap reverts).
    ///         3. The exit fee is deducted on the same proceeds in `_withdraw`.
    ///
    ///         Documented as a floor, not an exact quote — actual proceeds will
    ///         typically exceed this value when swap depth is healthy.
    ///         See docs/technical/basket-vault-gap-report.md §3, §5.
    ///
    ///         Drawdown redemption policy (ADR-0007): this vault uses a NAV-haircut
    ///         model. Depositors always redeem at the current per-share NAV, which
    ///         already reflects any drawdown via this slippage-adjusted floor.
    ///         Drawdown losses are borne pro-rata by the redeeming depositor; there
    ///         is NO forced sale and NO withdrawal queue. The `maxSlippageBps`
    ///         floor acts as the bounded-slippage / minimum-haircut cap: a
    ///         redemption that cannot clear within that bound reverts rather than
    ///         settling at a sandwiched, catastrophic price. ERC-4626 only
    ///         guarantees `redeem >= previewRedeem`, not `previewRedeem >= deposit`.
    ///         See docs/adr/ADR-0007-basket-vault-drawdown-redemption-policy.md.
    function previewRedeem(uint256 shares) public view override returns (uint256) {
        uint256 gross = _convertToAssets(shares, Math.Rounding.Floor);
        // Apply slippage floor: worst-case swap proceeds = TWAP NAV * (1 - maxSlippageBps).
        uint256 afterSlippage = gross.mulDiv(MAX_BPS - maxSlippageBps, MAX_BPS);
        // Apply exit fee on the slippage-adjusted proceeds.
        return afterSlippage - afterSlippage.mulDiv(exitFeeBps, MAX_BPS);
    }

    /// @notice Worst-case shares estimate for a deposit of `assets_` USDC.
    ///
    ///         The floor is computed by discounting the deposited USDC by
    ///         `maxSlippageBps` before converting to shares. This reflects that
    ///         the Uniswap V3 router guarantees at least
    ///         `amountOutMinimum = TWAP × (1 − maxSlippageBps)` tokens will be
    ///         acquired per leg. The resulting share count represents the minimum
    ///         shares a depositor can expect; actual shares may be higher when
    ///         swap depth is healthy.
    ///
    ///         Documented as a floor, not an exact quote.
    ///         See docs/technical/basket-vault-gap-report.md §3.
    function previewDeposit(uint256 assets_) public view override returns (uint256) {
        // Discount the effective deposit by the worst-case slippage so the
        // share conversion reflects the actual token value the vault captures.
        uint256 effectiveAssets = assets_.mulDiv(MAX_BPS - maxSlippageBps, MAX_BPS);
        return _convertToShares(effectiveAssets, Math.Rounding.Floor);
    }

    /// @notice Worst-case assets required to mint `shares`.
    ///
    ///         Grosses up the raw NAV by `MAX_BPS / (MAX_BPS - maxSlippageBps)` so that
    ///         after the on-chain swap applies the same `maxSlippageBps` haircut, the vault
    ///         captures the full proportional NAV. Without this override, `mint()` would
    ///         undercharge relative to `deposit()`, allowing a permissionless value leak
    ///         onto existing holders (see docs/code-review/smart-contract-vulnerability-audit-20260609.md H-1).
    ///
    ///         Rounded up (Ceil) so the vault is never shortchanged.
    function previewMint(uint256 shares) public view override returns (uint256) {
        uint256 grossAssets = _convertToAssets(shares, Math.Rounding.Ceil);
        return grossAssets.mulDiv(MAX_BPS, MAX_BPS - maxSlippageBps, Math.Rounding.Ceil);
    }

    /// @notice Maximum USDC that can be deposited given current vault state.
    ///         Returns 0 when the vault is paused or shut down, when no basket
    ///         asset is active, or when the TVL cap is reached; otherwise
    ///         min(perDepositCap, TVL-cap headroom). Overrides the OZ default
    ///         (`type(uint256).max`) for ERC-4626 conformance: max* views MUST
    ///         return 0 when deposits are disabled (audit 2026-06-09, L-16).
    function maxDeposit(address) public view override returns (uint256) {
        if (paused() || shutdown) return 0;
        if (_activeAssetCount() == 0) return 0;
        if (tvlCap == type(uint256).max && perDepositCap == type(uint256).max) {
            return type(uint256).max;
        }
        uint256 current = totalAssets();
        if (current >= tvlCap) return 0;
        uint256 headroom = tvlCap - current;
        return perDepositCap < headroom ? perDepositCap : headroom;
    }

    /// @notice Maximum shares that can be minted given current vault state.
    ///         Derived from `maxDeposit` through the slippage-discounted share
    ///         conversion (`previewDeposit`) so the implied asset charge of
    ///         `mint(maxMint(receiver))` stays within the deposit caps
    ///         (audit 2026-06-09, L-16).
    function maxMint(address receiver) public view override returns (uint256) {
        uint256 assets_ = maxDeposit(receiver);
        if (assets_ == type(uint256).max) return type(uint256).max;
        return previewDeposit(assets_);
    }

    /// @notice BasketVault cannot guarantee ERC-4626 withdraw exactness because
    ///         the actual USDC delivered depends on proportional swap execution
    ///         and variable on-chain slippage. Use `redeem()` instead — the ERC-4626
    ///         redeem guarantee (actual ≥ previewRedeem) is enforced at the swap level.
    function previewWithdraw(uint256) public view override returns (uint256) {
        revert RedeemOnly();
    }

    /// @dev Performs a proportional-swap withdrawal. The `assets` parameter
    ///      is intentionally unused because the actual USDC received depends on
    ///      swap execution. Callers MUST NOT use `withdraw()` — use `redeem()` instead.
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

            uint256 minUsdcOut = _twapUsdcValue(
                    assets[i].pool, assets[i].token, assets[i].adapter, sellAmount
                ) * (MAX_BPS - maxSlippageBps) / MAX_BPS;

            uint256 received = _executeSwap(
                assets[i].adapter,
                assets[i].token,
                address(_USDC),
                assets[i].swapFee,
                sellAmount,
                minUsdcOut,
                address(this)
            );
            emit Swapped(assets[i].token, address(_USDC), sellAmount, received);
            usdcOut += received;
        }
    }

    // ─── TWAP pricing ─────────────────────────────────────────────────

    /// @dev Returns the USDC value of `tokenAmount` tokens, priced via the
    ///      adapter's TWAP (or the built-in Uniswap V3 path when adapter is address(0)).
    function _twapUsdcValue(address pool, address token, address adapter, uint256 tokenAmount)
        internal
        view
        returns (uint256)
    {
        if (adapter != address(0)) {
            uint32 window = effectiveTwapWindow(token);
            return
                IBasketSwapAdapter(adapter)
                    .twapPrice(pool, token, address(_USDC), tokenAmount, window);
        }
        return _twapQuote(pool, token, address(_USDC), tokenAmount);
    }

    /// @dev Returns the estimated token amount for `usdcAmount` USDC, priced
    ///      via the adapter's TWAP (or the built-in Uniswap V3 path when adapter is address(0)).
    function _twapTokenValue(address pool, address token, address adapter, uint256 usdcAmount)
        internal
        view
        returns (uint256)
    {
        if (adapter != address(0)) {
            uint32 window = effectiveTwapWindow(token);
            return
                IBasketSwapAdapter(adapter)
                    .twapPrice(pool, address(_USDC), token, usdcAmount, window);
        }
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

    /// @notice Minimum observation cardinality required on the Uniswap V3 pool
    ///         when registering an asset via addAsset(). A cardinality of 1
    ///         (the Uniswap deployment default) means observe() can only return
    ///         the single stored slot and always reverts with "OLD" for any
    ///         non-zero secondsAgo, which would permanently break totalAssets(),
    ///         deposits, and withdrawals for the entire basket.
    uint16 public constant MIN_POOL_CARDINALITY = 2;

    /// @notice Minimum in-range Uniswap V3 pool liquidity required when
    ///         registering an asset via addAsset(). Pools below this floor
    ///         cannot absorb vault-sized trades without exceeding the
    ///         configured slippage bound, which would leave depositors unable
    ///         to exit synchronously — a blocking router-eligibility gap
    ///         (basket-vault-gap-report.md §1). Callers must seed pool depth
    ///         before calling addAsset.
    ///
    ///         The value of 1e6 is a conservative floor that rejects completely
    ///         empty or dust-seeded pools while being easy for integration tests
    ///         to satisfy with a small seed. Production operators are expected
    ///         to seed pools well above this floor before activating assets.
    uint128 public constant MIN_POOL_LIQUIDITY = 1e6;

    /// @notice Register a new basket asset. Restricted to ADMIN_ROLE.
    /// @param token_    ERC-20 token address.
    /// @param pool_     DEX pool pairing `token_` with USDC (either token0 or token1).
    ///                  For the Uniswap V3 default path, this is the V3 pool address.
    ///                  For Aerodrome, this is the CL pool address used for TWAP reads.
    /// @param swapFee_  Fee parameter forwarded to the adapter (Uniswap V3 fee tier;
    ///                  unused by Aerodrome adapters but kept for interface uniformity).
    /// @param adapter_  Swap+TWAP adapter address implementing `IBasketSwapAdapter`.
    ///                  Pass `address(0)` to use the built-in Uniswap V3 default path
    ///                  (venue = V3). For V4 or Aerodrome, pass the deployed adapter
    ///                  address and the corresponding `venue_`.
    /// @param venue_    DEX venue selector. Must match the adapter type:
    ///                  `Venue.V3` with `adapter_=address(0)`,
    ///                  `Venue.V4` with a `UniswapV4SwapAdapter`,
    ///                  `Venue.Aerodrome` with an `AerodromeSwapAdapter`.
    ///                  Stored on `AssetInfo` so governance tooling can inspect
    ///                  the venue without decoding the adapter address.
    /// @dev Reverts with InsufficientPoolCardinality when the pool's current
    ///      observationCardinality is below MIN_POOL_CARDINALITY. Callers must
    ///      invoke pool.increaseObservationCardinalityNext(n) and wait for the
    ///      cardinality to be populated before calling addAsset.
    function addAsset(
        address token_,
        address pool_,
        uint24 swapFee_,
        address adapter_,
        Venue venue_
    ) external onlyRole(ADMIN_ROLE) {
        if (token_ == address(0) || pool_ == address(0)) revert ZeroAddress();
        if (assets.length >= maxAssets()) revert MaxAssetsReached();
        // Verify pool actually pairs this token with USDC.
        // For Uniswap V3 pools and Aerodrome CL pools, token0/token1 are standard.
        address t0 = IUniswapV3Pool(pool_).token0();
        address t1 = IUniswapV3Pool(pool_).token1();
        if (!((t0 == token_ && t1 == address(_USDC)) || (t1 == token_ && t0 == address(_USDC)))) {
            revert PoolTokenMismatch();
        }
        // Verify that the pool has sufficient observation cardinality to service
        // TWAP reads. Cardinality=1 causes observe() to revert with "OLD" for
        // any non-zero secondsAgo, which would lock ALL vault withdrawals.
        // slot0 returns observationCardinality as the fourth value.
        (,,, uint16 observationCardinality,,,) = IUniswapV3Pool(pool_).slot0();
        if (observationCardinality < MIN_POOL_CARDINALITY) {
            revert InsufficientPoolCardinality(pool_, MIN_POOL_CARDINALITY, observationCardinality);
        }
        // Verify that the pool has sufficient in-range liquidity to absorb
        // vault-sized trades within the configured slippage bound. Thin pools
        // break the synchronous-redemption guarantee (gap-report §1).
        uint128 poolLiquidity = IUniswapV3Pool(pool_).liquidity();
        if (poolLiquidity < MIN_POOL_LIQUIDITY) {
            revert InsufficientPoolLiquidity(pool_, MIN_POOL_LIQUIDITY, poolLiquidity);
        }
        assets.push(
            AssetInfo({
                token: token_,
                pool: pool_,
                swapFee: swapFee_,
                active: true,
                adapter: adapter_,
                venue: venue_
            })
        );
        emit AssetAdded(assets.length - 1, token_, pool_, swapFee_, adapter_, venue_);
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

    /// @dev Pause only when not already paused. Silently no-ops when the
    ///      contract is already paused so that the common incident sequence
    ///      pause() → emergencyUnwind() does not revert with EnforcedPause.
    function _pauseIfNotPaused() internal {
        if (!paused()) _pause();
    }

    /// @notice Pause and swap all basket assets back to USDC using live TWAP-derived floors.
    /// @dev The effective per-leg floor is max(TWAP-derived, configured minUsdcOut), so the
    ///      admin-set value acts as a secondary lower bound while the live TWAP guards against
    ///      stale configuration being exploited by a sandwich attacker.
    ///      Reverts when any router leg cannot satisfy its effective floor.
    function emergencyUnwind() public virtual onlyRole(EMERGENCY_ROLE) nonReentrant {
        _pauseIfNotPaused();
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            AssetInfo memory assetInfo = assets[i];
            uint256 bal = IERC20(assetInfo.token).balanceOf(address(this));
            if (bal == 0) continue;
            uint256 twapFloor = _twapUsdcValue(
                    assetInfo.pool, assetInfo.token, assetInfo.adapter, bal
                ) * (MAX_BPS - maxSlippageBps) / MAX_BPS;
            uint256 configuredMin = emergencyUnwindGuard[assetInfo.token].minUsdcOut;
            uint256 effectiveFloor = twapFloor > configuredMin ? twapFloor : configuredMin;
            _emergencyUnwindAsset(assetInfo, effectiveFloor);
        }
    }

    /// @notice Explicit high-risk emergency unwind for tokens whose guard permits overrides.
    /// @dev Emits before each swap so off-chain operators can distinguish override use.
    ///      Even on the override path, swap outputs are bounded by an upper-loss
    ///      cap derived from the admin-configured `minUsdcOut` reference floor:
    ///      `appliedFloor = minUsdcOut * (MAX_BPS - maxLossBps) / MAX_BPS`.
    ///      Additionally a live TWAP floor (max(TWAP-derived, appliedFloor)) is applied
    ///      as a secondary guard to prevent sandwich exploitation of a stale `minUsdcOut`.
    ///      Swaps whose realized USDC output is below the effective floor revert with
    ///      `EmergencyUnwindLossCapExceeded`, preventing catastrophic loss even when
    ///      override is enabled.
    function emergencyUnwindWithOverride(address[] calldata tokens)
        public
        virtual
        onlyRole(EMERGENCY_ROLE)
        nonReentrant
    {
        _pauseIfNotPaused();
        uint256 len = tokens.length;
        for (uint256 i = 0; i < len; i++) {
            EmergencyUnwindGuard memory guard = emergencyUnwindGuard[tokens[i]];
            if (!guard.overrideAllowed) revert EmergencyUnwindOverrideDisabled();
            AssetInfo memory assetInfo = _activeAssetForToken(tokens[i]);
            uint256 bal = IERC20(assetInfo.token).balanceOf(address(this));
            if (bal == 0) continue;
            uint256 appliedFloor = guard.minUsdcOut * (MAX_BPS - guard.maxLossBps) / MAX_BPS;
            uint256 twapFloor = _twapUsdcValue(
                    assetInfo.pool, assetInfo.token, assetInfo.adapter, bal
                ) * (MAX_BPS - maxSlippageBps) / MAX_BPS;
            uint256 effectiveFloor = twapFloor > appliedFloor ? twapFloor : appliedFloor;
            emit EmergencyUnwindOverrideUsed(
                assetInfo.token, bal, guard.minUsdcOut, effectiveFloor, msg.sender
            );
            _emergencyUnwindAssetWithCap(assetInfo, effectiveFloor);
        }
    }

    function shutdownVault() external onlyRole(EMERGENCY_ROLE) {
        shutdown = true;
        tvlCap = 0;
        emit Shutdown();
    }

    /// @notice Recover accidentally sent ERC-20 tokens (not USDC or active basket assets). ADMIN_ROLE.
    /// @dev Inactive (removed) basket entries are deliberately rescuable: `totalAssets`
    ///      and `_sellProportional` skip them, so any balance that reappears after
    ///      `removeAsset` would otherwise be permanently stranded (audit 2026-06-09, L-15).
    function rescueTokens(address token, address to) external onlyRole(ADMIN_ROLE) {
        if (token == address(_USDC)) revert CannotRescueUsdc();
        if (to == address(0)) revert ZeroAddress();
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (assets[i].active && token == assets[i].token) revert AssetInBasket();
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

    /// @notice Update the worst-case slippage bound used for swap floors and previews.
    /// @dev Bounded above by `MAX_SLIPPAGE_BPS` and below by `minSlippageFloorBps()`
    ///      (the highest active asset's pool fee tier in bps) so a single admin write
    ///      cannot set an unsatisfiable `amountOutMinimum` and brick all swaps
    ///      (audit 2026-06-09, L-17).
    function setMaxSlippageBps(uint256 newBps) external onlyRole(ADMIN_ROLE) {
        if (newBps > MAX_SLIPPAGE_BPS) revert InvalidParam();
        uint256 floorBps = minSlippageFloorBps();
        if (newBps < floorBps) revert SlippageBelowPoolFeeFloor(newBps, floorBps);
        emit MaxSlippageUpdated(maxSlippageBps, newBps);
        maxSlippageBps = newBps;
    }

    /// @notice Lower bound accepted by `setMaxSlippageBps`: the highest pool fee
    ///         tier among active basket assets, expressed in basis points
    ///         (`swapFee` is in hundredths of a bip, e.g. 3000 → 30 bps).
    ///         Returns 0 when no asset is active (nothing can brick).
    function minSlippageFloorBps() public view returns (uint256 floorBps) {
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            uint256 feeBps = uint256(assets[i].swapFee) / 100;
            if (feeBps > floorBps) floorBps = feeBps;
        }
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
    ///                         `docs/technical/security-model.md`).
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

    // ─── Rebalancing (ADR-0003) ───────────────────────────────────────

    /// @notice Reserved for Phase B: global vault rebalance.
    /// @dev Not implemented in MVP. Reverts with `NotImplemented()`.
    ///      Eventual signature (subject to Phase B ADR):
    ///        rebalance(uint256 maxSlippageBps, uint256 deadline)
    ///        -> (uint256[] swapAmounts, uint256[] gasEstimates)
    ///      See docs/adr/ADR-0003-basketvault-rebalancing-model.md
    // solhint-disable-next-line no-unused-vars
    function rebalance(uint256, uint256) external pure {
        revert NotImplemented();
    }

    /// @notice Pre-execution cost preview: shows how `usdcAmount` would be allocated
    ///         across active basket assets at current TWAP prices.
    ///         Returns parallel arrays of `(assets, amountsOut)` for active assets only.
    ///         This satisfies the cost-preview requirement in docs/architecture.md §8.
    ///         See docs/adr/ADR-0003-basketvault-rebalancing-model.md.
    function previewDepositWeights(uint256 usdcAmount)
        external
        view
        returns (address[] memory activeAssets, uint256[] memory amountsOut)
    {
        uint256 n = _activeAssetCount();
        activeAssets = new address[](n);
        amountsOut = new uint256[](n);
        if (n == 0 || usdcAmount == 0) return (activeAssets, amountsOut);

        uint256 perAsset = usdcAmount / n;
        uint256 remainder = usdcAmount - perAsset * n;
        uint256 len = assets.length;
        uint256 idx = 0;
        bool firstActive = true;

        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            uint256 swapIn = firstActive ? perAsset + remainder : perAsset;
            firstActive = false;
            activeAssets[idx] = assets[i].token;
            amountsOut[idx] = swapIn > 0
                ? _twapTokenValue(assets[i].pool, assets[i].token, assets[i].adapter, swapIn)
                : 0;
            idx++;
        }
    }

    /// @notice Per-depositor realized weight vector.
    ///         Returns each active asset's share of the depositor's pro-rata vault
    ///         holdings, expressed in basis points (0–10_000), where 10_000 = 100%.
    ///         A depositor with no shares gets all-zero weights.
    ///         See docs/adr/ADR-0003-basketvault-rebalancing-model.md.
    function realizedWeights(address depositor)
        external
        view
        returns (address[] memory activeAssets, uint256[] memory bpsWeights)
    {
        uint256 n = _activeAssetCount();
        activeAssets = new address[](n);
        bpsWeights = new uint256[](n);
        if (n == 0) return (activeAssets, bpsWeights);

        uint256 depositorShares = balanceOf(depositor);
        uint256 supply = totalSupply();
        if (depositorShares == 0 || supply == 0) return (activeAssets, bpsWeights);

        // Compute the depositor's pro-rata USDC value for each active asset.
        uint256 len = assets.length;
        uint256 idx = 0;
        uint256 totalValue = 0;
        uint256[] memory values = new uint256[](n);

        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            uint256 bal = IERC20(assets[i].token).balanceOf(address(this));
            uint256 depositorBal = bal.mulDiv(depositorShares, supply);
            uint256 val = depositorBal > 0
                ? _twapUsdcValue(assets[i].pool, assets[i].token, assets[i].adapter, depositorBal)
                : 0;
            activeAssets[idx] = assets[i].token;
            values[idx] = val;
            totalValue += val;
            idx++;
        }

        // Convert to basis points.
        if (totalValue > 0) {
            for (uint256 j = 0; j < n; j++) {
                bpsWeights[j] = values[j].mulDiv(MAX_BPS, totalValue);
            }
        }
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
        uint256 received = _executeSwap(
            assetInfo.adapter,
            assetInfo.token,
            address(_USDC),
            assetInfo.swapFee,
            bal,
            minUsdcOut,
            address(this)
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
        uint256 received = _executeSwap(
            assetInfo.adapter,
            assetInfo.token,
            address(_USDC),
            assetInfo.swapFee,
            bal,
            appliedFloor,
            address(this)
        );
        if (received < appliedFloor) {
            revert EmergencyUnwindLossCapExceeded(assetInfo.token, received, appliedFloor);
        }
        emit Swapped(assetInfo.token, address(_USDC), bal, received);
    }

    // slither-disable-end reentrancy-balance

    // ─── Swap execution helper ────────────────────────────────────────

    /// @dev Routes a swap through the per-asset adapter when set, or falls back
    ///      to the immutable Uniswap V3 SWAP_ROUTER.  Centralises approval
    ///      management: forceApprove before the call, clear after.
    ///
    ///      Deadline note (audit 2026-06-09, L-5): adapters take an explicit
    ///      caller-chosen `deadline` instead of hardcoding `block.timestamp`.
    ///      This vault's entry points are standard ERC-4626 (no deadline
    ///      parameter), and every swap executes synchronously inside the
    ///      caller's transaction, so the vault pins the deadline to the current
    ///      block — equivalent protection to a tx-level deadline. External
    ///      integrators calling adapters directly MUST supply a real deadline.
    function _executeSwap(
        address adapter,
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient
    ) internal returns (uint256 amountOut) {
        if (adapter != address(0)) {
            // Adapter pulls `tokenIn` from this contract via transferFrom.
            IERC20(tokenIn).forceApprove(adapter, amountIn);
            amountOut = IBasketSwapAdapter(adapter)
                .swap(tokenIn, tokenOut, fee, amountIn, minAmountOut, recipient, block.timestamp);
            IERC20(tokenIn).forceApprove(adapter, 0);
        } else {
            // Default Uniswap V3 path (backward-compatible).
            IERC20(tokenIn).forceApprove(address(SWAP_ROUTER), amountIn);
            amountOut = SWAP_ROUTER.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: recipient,
                    amountIn: amountIn,
                    amountOutMinimum: minAmountOut,
                    sqrtPriceLimitX96: 0
                })
            );
            IERC20(tokenIn).forceApprove(address(SWAP_ROUTER), 0);
        }
    }
}
