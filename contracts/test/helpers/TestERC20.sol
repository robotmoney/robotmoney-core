// SPDX-License-Identifier: MIT
// Canonical: none — 6-decimal ERC20 test helper for forge unit tests
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestERC20
/// @notice Minimal 6-decimal ERC20 used as a USDC stand-in by forge unit tests.
/// @dev Public, permissionless `mint`/`burn` — TEST FIXTURE ONLY. This contract
///      lives under `contracts/test/` and is never deployed by production
///      scripts. Production deploys bind the gateway to canonical Base USDC
///      via the `USDC_ADDRESS` env var (see `script/Deploy.s.sol`).
contract TestERC20 is ERC20 {
    constructor() ERC20("Test USDC", "tUSDC") {}

    /// @notice USDC uses 6 decimals; mirror that for parity with the real token.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint test tokens to any address. No access control by design.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Burn test tokens from any address. No access control by design.
    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}
