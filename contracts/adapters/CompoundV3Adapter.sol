// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {IComet} from "../interfaces/IComet.sol";

/// @title CompoundV3Adapter
/// @notice Strategy adapter that supplies USDC to Compound V3 (Comet) on Base.
/// @dev Compound V3 is non-ERC-4626. The Comet contract is itself the cUSDCv3 token.
///      `supply` always credits msg.sender. `withdraw` always sends to msg.sender.
///      So this adapter must FORWARD withdrawn USDC to the vault.
///      `COMET.balanceOf(account)` returns live underlying USDC with interest applied.
///      Deployed: 0x8247da22a59fce074c102431048d0ce7294c2652 (Base mainnet)
///      Compiler: v0.8.24+commit.e11b9ed9, optimized 200 runs, EVM Cancun, viaIR=true
contract CompoundV3Adapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    IERC20  public immutable USDC;
    IComet  public immutable COMET;
    address public immutable VAULT;

    error OnlyVault();
    error ZeroAddress();
    error WithdrawShortfall(uint256 requested, uint256 actual);
    error CannotRescueProtectedToken();

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    constructor(address comet_, address usdc_, address vault_) {
        if (comet_ == address(0) || usdc_ == address(0) || vault_ == address(0)) revert ZeroAddress();
        COMET = IComet(comet_);
        USDC  = IERC20(usdc_);
        VAULT = vault_;
    }

    function deploy(uint256 amount) external onlyVault {
        USDC.safeIncreaseAllowance(address(COMET), amount);
        COMET.supply(address(USDC), amount);
        uint256 remaining = USDC.allowance(address(this), address(COMET));
        if (remaining > 0) {
            USDC.forceApprove(address(COMET), 0);
        }
    }

    function withdraw(uint256 amount) external onlyVault returns (uint256) {
        uint256 preBalance  = USDC.balanceOf(address(this));
        COMET.withdraw(address(USDC), amount);
        uint256 postBalance = USDC.balanceOf(address(this));
        uint256 actual      = postBalance - preBalance;

        if (actual > 0) {
            USDC.safeTransfer(VAULT, actual);
        }

        if (amount != type(uint256).max && actual < amount) {
            revert WithdrawShortfall(amount, actual);
        }
        return actual;
    }

    function totalAssets() external view returns (uint256) {
        return COMET.balanceOf(address(this));
    }

    function rescueTokens(address token, address to) external onlyVault {
        if (token == address(USDC) || token == address(COMET)) revert CannotRescueProtectedToken();
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, balance);
    }
}
