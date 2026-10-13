// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0005-basketvault-multi-dex-routing.md (2026-10-08 amendment)
pragma solidity ^0.8.24;

import {IPoolManagerV4} from "./IPoolManagerV4.sol";

/// @title IUniswapV4PriceRecorder
/// @notice What the V4 swap adapter and the deploy scripts read from the permissionless price recorder.
interface IUniswapV4PriceRecorder {
    function POOL_MANAGER() external view returns (IPoolManagerV4);
    function POOL_ID() external view returns (bytes32);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
    function hooks() external view returns (address);

    /// @notice Record the pool tick if this block has not been recorded yet. Permissionless. Returns whether a snapshot was written.
    function record() external returns (bool recorded);
}
