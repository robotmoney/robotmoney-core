// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0005-basketvault-multi-dex-routing.md (2026-10-08 amendment: Uniswap V4 venue)
//            docs/adr/ADR-0001-mvp-agent-token-shortlist.md (2026-10-08: RM on the V4 RM/USDC 2.91% pool)
//            docs/technical/smart-contract-invariants.md (ADP-2, ADP-5, ORA-1, ORA-3)
//
// Concrete Uniswap V4 venue executor behind the IBasketSwapAdapter seam. It swaps through the real V4
// PoolManager (`unlock` then `swap` with a full PoolKey, then `sync` / transfer / `settle` and `take`),
// and prices through the permissionless `UniswapV4PriceRecorder` because a hookless V4 pool keeps no
// observations. The adapter is recovered from the adapter deleted by core PR 1505 (commit 4383ac9f) and
// rewritten: that one reverted on fee 29100, derived tickSpacing from a standard table and called a router
// shape that matches no canonical V4 contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IBasketSwapAdapter} from "../interfaces/IBasketSwapAdapter.sol";
import {IPoolManagerV4, IUnlockCallbackV4} from "../interfaces/IPoolManagerV4.sol";
import {IUniswapV4PriceRecorder} from "../interfaces/IUniswapV4PriceRecorder.sol";
import {TwapTickMath} from "../lib/TwapTickMath.sol";

/// @title UniswapV4SwapAdapter
/// @notice BasketVault swap adapter for ONE hookless Uniswap V4 pool, bound at construction to the pool's full
///         `PoolKey` and to its price recorder.
///
/// @dev TRUST AND AUTHORITY
///      - The adapter holds no balance between calls and has no owner or setter. Any caller may call `swap`:
///        it pulls `amountIn` from `msg.sender` and pays `recipient`, so a stranger can only spend their own
///        tokens. The vault pins the pool, the fee and the codehash (ADP-2).
///      - `unlockCallback` answers only the PoolManager, and only while a `swap` of this adapter is open
///        (`_open`). `swap` is non-reentrant. A token that calls back into `swap` mid-settle reverts.
///      - The PoolKey is explicit and immutable: tokens sorted, hooks zero, the pool id equal to the
///        recorder's `POOL_ID` (the hash of that very key), the recorder on the same PoolManager. A caller
///        cannot supply a different key, fee or tick spacing: `swap` accepts only the configured pair and fee.
///
///      SWAP FLOW. `swap` pulls `amountIn`, pokes the recorder (`record()`, before the trade so the pool tick
///      the trade moves is not the one recorded), opens `PoolManager.unlock`, and in the callback runs an
///      exact-input `PoolManager.swap` with a price limit at the pool edge (the `minAmountOut` floor is the real
///      slippage bound), `sync`s the input currency, transfers the input to the PoolManager, `settle`s, then
///      `take`s the output to `recipient`. The PoolManager reverts the unlock if any delta is left non-zero.
///
///      PRICE. `twapPrice` accepts only `pool == RECORDER` and returns the recorder's time-weighted tick
///      price (the recorder reverts when stale: deposits and USDC redeems fail closed, `redeemInKind` needs no
///      price). `amountIn` and `minAmountOut` above uint128 revert (audit 2026-06-09, L-6).
contract UniswapV4SwapAdapter is IBasketSwapAdapter, IUnlockCallbackV4 {
    using SafeERC20 for IERC20;

    // ─── Immutables ───────────────────────────────────────────────────

    /// @notice Uniswap V4 PoolManager (Base: 0x498581fF718922c3f8e6A244956aF099B2652b2b).
    IPoolManagerV4 public immutable POOL_MANAGER;
    /// @notice The price recorder for the same pool. The only `pool` `twapPrice` accepts.
    IUniswapV4PriceRecorder public immutable RECORDER;
    address public immutable CURRENCY0;
    address public immutable CURRENCY1;
    uint24 public immutable POOL_FEE;
    int24 public immutable TICK_SPACING;
    /// @notice The pool id: `keccak256(abi.encode(poolKey))`.
    bytes32 public immutable POOL_ID;

    /// @dev V4 `TickMath.MIN_SQRT_PRICE + 1` and `MAX_SQRT_PRICE - 1`: the widest legal price limits.
    uint160 private constant MIN_SQRT_PRICE_LIMIT = 4_295_128_739 + 1;
    uint160 private constant MAX_SQRT_PRICE_LIMIT =
        1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342 - 1;

    // ─── State ────────────────────────────────────────────────────────

    /// @dev 1 idle, 2 inside `swap`. Guards re-entry and the callback.
    uint256 private _open = 1;

    // ─── Errors ───────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroWindow();
    /// @dev The PoolKey given to the constructor is not a hookless, sorted key for the recorder's pool.
    error InvalidPoolKey();
    /// @dev The key does not pair the expected quote token (USDC) with a second token.
    error PoolKeyDoesNotPairQuote(address quote);
    /// @dev `tokenIn` / `tokenOut` / `fee` / `pool` is not the configured pool.
    error PoolTokenMismatch();
    error FeeMismatch(uint24 given, uint24 configured);
    error PoolIsNotRecorder(address pool, address recorder);
    error DeadlineExpired(uint256 deadline, uint256 nowTs);
    /// @dev Output below the caller's floor.
    error SlippageExceeded(uint256 amountOut, uint256 minAmountOut);
    error NotPoolManager();
    error NotOpen();
    error Reentrant();

    // ─── Constructor ─────────────────────────────────────────────────

    /// @param poolManager_ Uniswap V4 PoolManager.
    /// @param key_         The pool's full PoolKey. `hooks` must be zero and the currencies sorted.
    /// @param recorder_    `UniswapV4PriceRecorder` for the same key. Its pool id, PoolManager and tokens must equal the key's.
    /// @param quote_       The quote token (USDC). One side of the key must be it.
    constructor(
        address poolManager_,
        IPoolManagerV4.PoolKey memory key_,
        address recorder_,
        address quote_
    ) {
        if (poolManager_ == address(0) || recorder_ == address(0) || quote_ == address(0)) {
            revert ZeroAddress();
        }
        if (key_.hooks != address(0)) revert InvalidPoolKey();
        if (key_.currency0 == address(0) || key_.currency0 >= key_.currency1) {
            revert InvalidPoolKey();
        }
        if (key_.currency0 != quote_ && key_.currency1 != quote_) {
            revert PoolKeyDoesNotPairQuote(quote_);
        }
        bytes32 id = keccak256(abi.encode(key_));
        IUniswapV4PriceRecorder rec = IUniswapV4PriceRecorder(recorder_);
        if (
            address(rec.POOL_MANAGER()) != poolManager_ || rec.POOL_ID() != id
                || rec.token0() != key_.currency0 || rec.token1() != key_.currency1
                || rec.fee() != key_.fee || rec.tickSpacing() != key_.tickSpacing
                || rec.hooks() != address(0)
        ) revert InvalidPoolKey();
        POOL_MANAGER = IPoolManagerV4(poolManager_);
        RECORDER = rec;
        CURRENCY0 = key_.currency0;
        CURRENCY1 = key_.currency1;
        POOL_FEE = key_.fee;
        TICK_SPACING = key_.tickSpacing;
        POOL_ID = id;
    }

    // ─── IBasketSwapAdapter ───────────────────────────────────────────

    /// @inheritdoc IBasketSwapAdapter
    /// @dev `fee` must equal the configured pool fee (the vault passes its registered `swapFee`). Tokens are pulled
    ///      from `msg.sender` (BasketVault approves exactly `amountIn` first and clears the approval after, ADP-5).
    ///      The caller-chosen `deadline` is enforced here because V4 swap params carry none (audit 2026-06-09, L-5).
    function swap(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        uint256 deadline
    ) external returns (uint256 amountOut) {
        if (_open != 1) revert Reentrant();
        if (tokenIn == address(0) || tokenOut == address(0) || recipient == address(0)) {
            revert ZeroAddress();
        }
        if (block.timestamp > deadline) revert DeadlineExpired(deadline, block.timestamp);
        bool zeroForOne = _direction(tokenIn, tokenOut);
        if (fee != POOL_FEE) revert FeeMismatch(fee, POOL_FEE);
        if (amountIn == 0) return 0;
        uint128 amountIn128 = SafeCast.toUint128(amountIn);
        SafeCast.toUint128(minAmountOut);

        _open = 2;
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        // Poke the recorder before the trade. Same-block calls are a no-op.
        RECORDER.record();

        bytes memory result = POOL_MANAGER.unlock(
            abi.encode(zeroForOne, tokenIn, tokenOut, amountIn128, minAmountOut, recipient)
        );
        _open = 1;
        amountOut = abi.decode(result, (uint256));
    }

    /// @inheritdoc IUnlockCallbackV4
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        if (_open != 2) revert NotOpen();
        (
            bool zeroForOne,
            address tokenIn,
            address tokenOut,
            uint128 amountIn,
            uint256 minAmountOut,
            address recipient
        ) = abi.decode(data, (bool, address, address, uint128, uint256, address));

        int256 delta = POOL_MANAGER.swap(
            IPoolManagerV4.PoolKey({
                currency0: CURRENCY0,
                currency1: CURRENCY1,
                fee: POOL_FEE,
                tickSpacing: TICK_SPACING,
                hooks: address(0)
            }),
            IPoolManagerV4.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(uint256(amountIn)),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT
            }),
            ""
        );

        // BalanceDelta packs amount0 (high 128 bits) and amount1 (low 128 bits).
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        int128 owed = zeroForOne ? amount0 : amount1; // negative: the PoolManager is owed this
        int128 got = zeroForOne ? amount1 : amount0; // positive: the PoolManager owes this
        // Exact input: the whole amountIn is owed and the output is positive.
        if (owed != -int128(amountIn) || got <= 0) revert SlippageExceeded(0, minAmountOut);
        uint256 amountOut = uint256(uint128(got));
        if (amountOut < minAmountOut) revert SlippageExceeded(amountOut, minAmountOut);

        // Settle the input: sync, transfer, settle. Then take the output.
        POOL_MANAGER.sync(tokenIn);
        IERC20(tokenIn).safeTransfer(address(POOL_MANAGER), amountIn);
        POOL_MANAGER.settle();
        POOL_MANAGER.take(tokenOut, recipient, amountOut);
        return abi.encode(amountOut);
    }

    /// @inheritdoc IBasketSwapAdapter
    /// @dev `pool` must be the recorder. Arithmetic-mean tick over `[window, 0]` from the recorder's snapshots
    ///      (never live spot), converted to an amount by the shared `TwapTickMath`. Reverts when the recorder is
    ///      stale or holds less than `window` seconds of history.
    function twapPrice(
        address pool,
        address baseToken,
        address quoteToken,
        uint256 baseAmount,
        uint32 window
    ) external view returns (uint256 quoteAmount) {
        if (pool == address(0) || baseToken == address(0) || quoteToken == address(0)) {
            revert ZeroAddress();
        }
        if (pool != address(RECORDER)) revert PoolIsNotRecorder(pool, address(RECORDER));
        if (window == 0) revert ZeroWindow();
        if (baseAmount == 0) return 0;
        _direction(baseToken, quoteToken);

        int24 meanTick = TwapTickMath.meanTick(pool, window);
        quoteAmount = TwapTickMath.priceFromTick(meanTick, baseToken, quoteToken, baseAmount);
    }

    // ─── Internals ────────────────────────────────────────────────────

    /// @dev Require {tokenIn, tokenOut} to be exactly the pool's two currencies. Returns zeroForOne.
    function _direction(address tokenIn, address tokenOut) private view returns (bool zeroForOne) {
        if (tokenIn == CURRENCY0 && tokenOut == CURRENCY1) return true;
        if (tokenIn == CURRENCY1 && tokenOut == CURRENCY0) return false;
        revert PoolTokenMismatch();
    }
}
