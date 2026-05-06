// SPDX-License-Identifier: MIT
// Canonical: docs/prd.md §5.2 — Bucket A (stable yield, multi-venue)
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {IAavePool} from "../interfaces/IAavePool.sol";

/// @title AaveV3Adapter
/// @notice Strategy adapter that supplies USDC to Aave V3 Pool on Base.
/// @dev aTokens are rebasing — `A_TOKEN.balanceOf(this)` returns live underlying with accrued interest.
///      Aave's `Pool.withdraw` sends USDC directly to the `to` address (we pass VAULT) — clean, no hop.
///      Deployed: 0x218695bdab0fe4f8d0a8ee590bc6f35820fc0bea (Base mainnet)
///      Compiler: v0.8.24+commit.e11b9ed9, optimized 200 runs, EVM Cancun
contract AaveV3Adapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    IERC20   public immutable USDC;
    IERC20   public immutable A_TOKEN;     // aBasUSDC — balanceOf returns live USDC
    IAavePool public immutable POOL;
    address  public immutable VAULT;

    error OnlyVault();
    error ZeroAddress();
    error WithdrawShortfall(uint256 requested, uint256 actual);
    error CannotRescueProtectedToken();

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    constructor(address pool_, address usdc_, address aToken_, address vault_) {
        if (pool_ == address(0) || usdc_ == address(0) || aToken_ == address(0) || vault_ == address(0)) {
            revert ZeroAddress();
        }
        POOL    = IAavePool(pool_);
        USDC    = IERC20(usdc_);
        A_TOKEN = IERC20(aToken_);
        VAULT   = vault_;
    }

    function deploy(uint256 amount) external onlyVault {
        USDC.safeIncreaseAllowance(address(POOL), amount);
        POOL.supply(address(USDC), amount, address(this), 0);
        uint256 remaining = USDC.allowance(address(this), address(POOL));
        if (remaining > 0) {
            USDC.forceApprove(address(POOL), 0);
        }
    }

    function withdraw(uint256 amount) external onlyVault returns (uint256) {
        uint256 actual = POOL.withdraw(address(USDC), amount, VAULT);
        if (amount != type(uint256).max && actual < amount) {
            revert WithdrawShortfall(amount, actual);
        }
        return actual;
    }

    function totalAssets() external view returns (uint256) {
        return A_TOKEN.balanceOf(address(this));
    }

    function rescueTokens(address token, address to) external onlyVault {
        if (token == address(USDC) || token == address(A_TOKEN)) revert CannotRescueProtectedToken();
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, balance);
    }
}
