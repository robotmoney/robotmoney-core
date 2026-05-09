// SPDX-License-Identifier: MIT
// Canonical: none — 6-decimal mock USDC test fixture for the gateway/vault e2e
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC
/// @notice 6-decimal ERC20 used as a USDC stand-in by the gateway test suite.
/// @dev Public, permissionless `mint` — this is a TEST FIXTURE only. Do not deploy
///      to mainnet under any circumstance.
contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    /// @notice USDC uses 6 decimals; mirror that for parity with the real token.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint test tokens to any address. No access control by design.
    /// @param to     Recipient of the minted tokens.
    /// @param amount Number of tokens to mint (6-decimal units).
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Burn test tokens from any address. No access control by design.
    /// @param from   Address whose tokens are burned.
    /// @param amount Number of tokens to burn (6-decimal units).
    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}
