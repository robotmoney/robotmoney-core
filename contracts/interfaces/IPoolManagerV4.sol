// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0005-basketvault-multi-dex-routing.md (2026-10-08 amendment, Uniswap V4 venue)
//            docs/technical/smart-contract-invariants.md (ORA-1, ORA-3)
pragma solidity ^0.8.24;

/// @title IPoolManagerV4
/// @notice The minimum slice of the Uniswap V4 `PoolManager` (Base: 0x498581fF718922c3f8e6A244956aF099B2652b2b)
///         that the Robot Money V4 swap adapter and price recorder call. Selectors and struct layouts equal
///         the canonical `v4-core` ones: `Currency` is an `address` user-defined value type and `BalanceDelta`
///         is an `int256` that packs `(int128 amount0, int128 amount1)` with amount0 in the upper 128 bits.
///         Declared here instead of importing `v4-core` so the repo keeps its two-submodule footprint.
interface IPoolManagerV4 {
    /// @dev `v4-core` `PoolKey`. `currency0` is the lower address. The pool id is `keccak256(abi.encode(key))`.
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    /// @dev `v4-core` `IPoolManager.SwapParams`. A negative `amountSpecified` is an exact-input swap.
    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Open the lock and call `msg.sender.unlockCallback(data)`. All deltas must net to zero by the end.
    function unlock(bytes calldata data) external returns (bytes memory result);

    /// @notice Swap inside an open lock. Returns the packed `BalanceDelta` owed to (negative) or by (positive) the caller.
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external
        returns (int256 swapDelta);

    /// @notice Snapshot `currency`'s balance before the caller transfers tokens in, so `settle` can measure the payment.
    function sync(address currency) external;

    /// @notice Credit the caller with the tokens transferred in since `sync`.
    function settle() external payable returns (uint256 paid);

    /// @notice Debit the caller's positive delta by sending `amount` of `currency` to `to`.
    function take(address currency, address to, uint256 amount) external;

    /// @notice Read one raw storage slot of the PoolManager.
    function extsload(bytes32 slot) external view returns (bytes32 value);
}

/// @notice The callback `PoolManager.unlock` makes on its caller.
interface IUnlockCallbackV4 {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}
