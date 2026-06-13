// SPDX-License-Identifier: MIT
// Canonical: Velodrome Slipstream core ICLFactory
pragma solidity ^0.8.24;

interface IAerodromeCLFactory {
    function getPool(address tokenA, address tokenB, int24 tickSpacing)
        external
        view
        returns (address pool);
}

