// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0005-basketvault-multi-dex-routing.md (2026-10-08 amendment) — TEST FIXTURE ONLY.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManagerV4, IUnlockCallbackV4} from "../../interfaces/IPoolManagerV4.sol";
import {TwapTickMath} from "../../lib/TwapTickMath.sol";

/// @dev Unit-test stand-in for the Uniswap V4 PoolManager. It mirrors the real contract where the adapter and
///      the recorder depend on it: the `_pools` mapping at storage slot 6 (so `extsload` of
///      `keccak256(abi.encode(id, 6))` returns the packed slot0 and `+3` the liquidity), the unlock lock, the
///      `sync` / `settle` / `take` delta accounting, and the revert when a delta is left unsettled. Pricing is a
///      fixed-tick quote (`TwapTickMath.priceFromTick`) minus the pool fee, and every swap moves the tick by
///      `impactTicks`. The real PoolManager is exercised by `UniswapV4SwapAdapterFork.t.sol` against live Base.
contract MockV4PoolManager {
    error AlreadyUnlocked();
    error ManagerLocked();
    error CurrencyNotSettled();
    error PoolNotInitialized();
    error NotExactInput();

    // Slots 0..6 are padding. The real PoolManager keeps `_pools` at slot 6, so pool state lives at
    // `keccak256(abi.encode(id, 6)) + n`. The mock writes that region by hand and keeps its own bookkeeping after slot 6.
    uint256[7] private _pad;
    mapping(bytes32 => bool) public pools;

    bool public unlocked;
    address public locker;
    int256 public impactTicks = 1;
    /// @dev When true `swap` fills only half of the exact input, as a real pool does when the price limit stops it.
    bool public partialFill;
    uint256 public nonzeroDeltas;
    address private _syncedCurrency;
    uint256 private _syncedBalance;
    mapping(address => mapping(address => int256)) public currencyDelta;

    uint256 public swapCount;

    function initializePool(IPoolManagerV4.PoolKey memory key, int24 tick, uint128 liquidity_)
        external
        returns (bytes32 id)
    {
        id = keccak256(abi.encode(key));
        pools[id] = true;
        setTick(id, tick);
        setLiquidity(id, liquidity_);
    }

    function setPartialFill(bool v) external {
        partialFill = v;
    }

    function setImpactTicks(int256 v) external {
        impactTicks = v;
    }

    function setTick(bytes32 id, int24 tick) public {
        // sqrtPriceX96 is any non-zero marker for the mock; slot0 = sqrtPrice | tick << 160 | fees << 184
        bytes32 slot = keccak256(abi.encode(id, uint256(6)));
        uint256 packed = uint256(1 << 96) | (uint256(uint24(tick)) << 160) | (uint256(29100) << 208);
        assembly {
            sstore(slot, packed)
        }
    }

    function setLiquidity(bytes32 id, uint128 liquidity_) public {
        bytes32 slot = bytes32(uint256(keccak256(abi.encode(id, uint256(6)))) + 3);
        assembly {
            sstore(slot, liquidity_)
        }
    }

    function tickOf(bytes32 id) public view returns (int24) {
        bytes32 slot = keccak256(abi.encode(id, uint256(6)));
        uint256 data;
        assembly {
            data := sload(slot)
        }
        return int24(uint24(data >> 160));
    }

    function extsload(bytes32 slot) external view returns (bytes32 value) {
        assembly {
            value := sload(slot)
        }
    }

    // ─── Lock and accounting ─────────────────────────────────────────

    function unlock(bytes calldata data) external returns (bytes memory result) {
        if (unlocked) revert AlreadyUnlocked();
        unlocked = true;
        locker = msg.sender;
        result = IUnlockCallbackV4(msg.sender).unlockCallback(data);
        if (nonzeroDeltas != 0) revert CurrencyNotSettled();
        unlocked = false;
        locker = address(0);
    }

    function _account(address currency, int256 d) private {
        int256 before_ = currencyDelta[locker][currency];
        int256 after_ = before_ + d;
        if (before_ == 0 && after_ != 0) nonzeroDeltas++;
        if (before_ != 0 && after_ == 0) nonzeroDeltas--;
        currencyDelta[locker][currency] = after_;
    }

    function swap(
        IPoolManagerV4.PoolKey memory key,
        IPoolManagerV4.SwapParams memory params,
        bytes calldata
    ) external returns (int256 swapDelta) {
        if (!unlocked) revert ManagerLocked();
        bytes32 id = keccak256(abi.encode(key));
        if (!pools[id]) revert PoolNotInitialized();
        if (params.amountSpecified >= 0) revert NotExactInput();
        uint256 inAmount = uint256(-params.amountSpecified);
        (int128 a0, int128 a1) =
            _quote(id, key, params.zeroForOne, partialFill ? inAmount / 2 : inAmount);
        swapCount++;
        _account(key.currency0, a0);
        _account(key.currency1, a1);
        swapDelta = (int256(a0) << 128) | int256(uint256(uint128(a1)));
    }

    function _quote(
        bytes32 id,
        IPoolManagerV4.PoolKey memory key,
        bool zeroForOne,
        uint256 amountIn
    ) private returns (int128 a0, int128 a1) {
        int24 tick = tickOf(id);
        uint256 out = _out(tick, key, zeroForOne, amountIn);
        // buying currency0 (oneForZero) raises the tick, selling it lowers it
        setTick(id, int24(int256(tick) + (zeroForOne ? -impactTicks : impactTicks)));
        int128 in128 = -int128(int256(amountIn));
        int128 out128 = int128(int256(out));
        (a0, a1) = zeroForOne ? (in128, out128) : (out128, in128);
    }

    function _out(int24 tick, IPoolManagerV4.PoolKey memory key, bool zeroForOne, uint256 amountIn)
        private
        pure
        returns (uint256)
    {
        (address tin, address tout) =
            zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        uint256 gross = TwapTickMath.priceFromTick(tick, tin, tout, amountIn);
        return gross * (1_000_000 - key.fee) / 1_000_000;
    }

    function sync(address currency) external {
        _syncedCurrency = currency;
        _syncedBalance = IERC20(currency).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        address c = _syncedCurrency;
        paid = IERC20(c).balanceOf(address(this)) - _syncedBalance;
        _syncedCurrency = address(0);
        _account(c, int256(paid));
    }

    function take(address currency, address to, uint256 amount) external {
        if (!unlocked) revert ManagerLocked();
        _account(currency, -int256(amount));
        IERC20(currency).transfer(to, amount);
    }
}
