// SPDX-License-Identifier: MIT
// Canonical: docs/prd.md#112-protocol-asset-vault (issue #531)
// Demo-only stub deployed on the smoke-test devnet to satisfy
// `IUniswapV3Pool.slot0()` for the landing-page price strip.
//
// The devnet is a fresh Geth+Lighthouse chain — Base mainnet pool addresses
// have no bytecode there.  This stub is deployed via
// `DeployDemoUniswapV3Stubs.s.sol` (issue #531) using CREATE2 with fixed
// salts so its address is deterministic and pre-committed in
// `config/dex-pools.json::devnet.pools`.  The deployer only sets
// `sqrtPriceX96` at construction; all other slot0 fields return sensible
// defaults that keep the dapp's price math alive without triggering
// divide-by-zero or overflow.
pragma solidity ^0.8.24;

/// @title UniswapV3PoolSlot0Stub
/// @notice Minimal IUniswapV3Pool stub for the smoke-test devnet price strip.
///         Implements only `slot0()`.  Full Uniswap V3 semantics (swap,
///         mint, burn, observe, flash) are intentionally absent — the dapp
///         only calls `slot0` to derive a mid-price.
///
///         One instance is deployed per price-strip pair:
///           - ETH/USD   (sqrtPriceX96 ≈ $2 500)
///           - wETH/USDC (same price, separate address per dex-pools.json entry)
///           - cbBTC/USDC (sqrtPriceX96 ≈ $60 000)
///           - wSOL/USDC  (sqrtPriceX96 ≈ $150)
///
///         Constructor arguments follow the ABI used by `DeployDemoUniswapV3Stubs`:
///           uint160 sqrtPriceX96 — the fixed square-root price (Q64.96)
///
///         NEVER deploy on a real chain.  Demo/devnet only.
contract UniswapV3PoolSlot0Stub {
    uint160 private immutable _sqrtPriceX96;

    constructor(uint160 sqrtPriceX96) {
        require(sqrtPriceX96 > 0, "sqrtPriceX96 must be > 0");
        _sqrtPriceX96 = sqrtPriceX96;
    }

    /// @notice Returns the fixed slot0 for this stub pool.
    ///         - `sqrtPriceX96`              — set at construction (fixed seed price)
    ///         - `tick`                      — 0 (unused by the dapp price strip)
    ///         - `observationIndex`          — 0
    ///         - `observationCardinality`    — 1 (minimum valid value)
    ///         - `observationCardinalityNext`— 1
    ///         - `feeProtocol`               — 0
    ///         - `unlocked`                  — true
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        )
    {
        return (_sqrtPriceX96, 0, 0, 1, 1, 0, true);
    }
}
