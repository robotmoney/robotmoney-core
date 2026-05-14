// SPDX-License-Identifier: MIT
// PROTOTYPE — not audited, not for production use.
// TODO before production: replace slot0 pricing with a Uniswap V3 TWAP via observe().
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

/// @title BasketVault
/// @notice Abstract ERC-4626 USDC vault that holds a basket of ERC-20 assets.
///         Deposits are split equally across active basket assets via Uniswap V3
///         single-hop swaps. Withdrawals swap each asset back to USDC proportionally.
///         NAV is denominated in USDC using Uniswap V3 slot0 spot price.
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

    // ─── Asset registry ───────────────────────────────────────────────

    struct AssetInfo {
        address token;
        address pool; // Uniswap V3 pool pairing token with USDC
        uint24 swapFee; // Uniswap V3 fee tier for exactInputSingle swaps
        bool active;
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

    // ─── ERC-4626 share scale ─────────────────────────────────────────

    function decimals() public pure override(ERC4626) returns (uint8) {
        return 6;
    }

    // Large virtual offset makes first-deposit inflation attacks economically infeasible.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 18;
    }

    // ─── totalAssets ─────────────────────────────────────────────────

    /// @notice USDC value of all held assets (idle USDC + spot-priced basket assets).
    function totalAssets() public view override returns (uint256) {
        uint256 sum = _USDC.balanceOf(address(this));
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            uint256 bal = IERC20(assets[i].token).balanceOf(address(this));
            if (bal > 0) sum += _spotUsdcValue(assets[i].pool, assets[i].token, bal);
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

            uint256 minOut = _spotTokenValue(assets[i].pool, assets[i].token, swapIn)
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

            uint256 minUsdcOut = _spotUsdcValue(assets[i].pool, assets[i].token, sellAmount)
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

    // ─── Spot pricing ─────────────────────────────────────────────────

    /// @dev Returns the USDC value of `tokenAmount` tokens, priced via Uniswap V3 slot0.
    ///      PROTOTYPE: slot0 is manipulable. Replace with a TWAP via observe() before production.
    function _spotUsdcValue(address pool, address token, uint256 tokenAmount)
        internal
        view
        returns (uint256)
    {
        return _quote(pool, token, address(_USDC), tokenAmount);
    }

    /// @dev Returns the estimated token amount for `usdcAmount` USDC, priced via slot0.
    function _spotTokenValue(address pool, address token, uint256 usdcAmount)
        internal
        view
        returns (uint256)
    {
        return _quote(pool, address(_USDC), token, usdcAmount);
    }

    /// @dev Overflow-safe spot quote using Uniswap V3 pool slot0 sqrtPriceX96.
    ///      Mirrors the OracleLibrary getQuoteAtTick ratio math without TickMath dependency.
    function _quote(address pool, address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (uint256 amountOut)
    {
        if (amountIn == 0) return 0;
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool).slot0();
        bool zeroForOne = tokenIn < tokenOut;
        uint256 sqrtP = uint256(sqrtPriceX96);

        // Compute ratio in two overflow-safe branches matching OracleLibrary conventions.
        if (sqrtP <= type(uint128).max) {
            uint256 ratioX192 = sqrtP * sqrtP;
            amountOut = zeroForOne
                ? amountIn.mulDiv(ratioX192, 1 << 192)
                : amountIn.mulDiv(1 << 192, ratioX192);
        } else {
            // sqrtP > 2^128: sqrtP*sqrtP would overflow uint256. Use mulDiv to compute
            // sqrtP^2 / 2^64 in 512-bit intermediate arithmetic (OZ Math.mulDiv guarantee).
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
        require(
            (t0 == token_ && t1 == address(_USDC)) || (t1 == token_ && t0 == address(_USDC)),
            "pool/token mismatch"
        );
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

    /// @notice Pause and attempt to swap all basket assets back to USDC. Restricted to EMERGENCY_ROLE.
    function emergencyUnwind() external onlyRole(EMERGENCY_ROLE) nonReentrant {
        _pause();
        uint256 len = assets.length;
        for (uint256 i = 0; i < len; i++) {
            if (!assets[i].active) continue;
            uint256 bal = IERC20(assets[i].token).balanceOf(address(this));
            if (bal == 0) continue;
            try SWAP_ROUTER.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: assets[i].token,
                    tokenOut: address(_USDC),
                    fee: assets[i].swapFee,
                    recipient: address(this),
                    amountIn: bal,
                    amountOutMinimum: 0, // emergency: accept any amount
                    sqrtPriceLimitX96: 0
                })
            ) returns (
                uint256 received
            ) {
                emit Swapped(assets[i].token, address(_USDC), bal, received);
            } catch {}
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
            require(token != assets[i].token, "cannot rescue basket asset");
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
}
