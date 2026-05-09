// SPDX-License-Identifier: MIT
// Canonical: none — minimal ERC-4626 mock vault test fixture
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockVault
/// @notice Minimal `IERC4626`-shaped vault for gateway tests. Mints `rmUSDC`
///         shares 1:1 against deposited USDC. Just enough surface for the
///         gateway's `vault.deposit()` call to succeed and for tests to assert
///         share routing.
/// @dev Out of scope: yield, fees, withdraw/redeem, fee-on-transfer support,
///      proxy upgradeability. This contract is a TEST FIXTURE only.
contract MockVault is ERC20 {
    using SafeERC20 for IERC20;

    error ZeroAmount();
    error ZeroReceiver();

    /// @notice Underlying asset, pinned at construction.
    IERC20 public immutable assetToken;

    /// @notice ERC-4626-shaped Deposit event so off-chain indexers / tests
    ///         can watch share routing.
    event Deposit(address indexed sender, address indexed receiver, uint256 assets, uint256 shares);

    constructor(address asset_) ERC20("Mock Robot Money USDC", "rmUSDC") {
        assetToken = IERC20(asset_);
    }

    /// @notice Match the underlying USDC's 6 decimals (mirrors ERC-4626 default).
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice ERC-4626 `asset()` accessor.
    function asset() external view returns (address) {
        return address(assetToken);
    }

    /// @notice Total assets currently held by the vault.
    function totalAssets() external view returns (uint256) {
        return assetToken.balanceOf(address(this));
    }

    /// @notice ERC-4626-style deposit. Pulls `assets` USDC from `msg.sender`
    ///         via `transferFrom`, mints `shares == assets` to `receiver`.
    /// @param  assets Amount of USDC (6 decimals) to deposit.
    /// @param  receiver Recipient of the freshly minted `rmUSDC` shares.
    /// @return shares Amount of `rmUSDC` minted (1:1 with assets).
    function deposit(uint256 assets, address receiver) external virtual returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroReceiver();

        assetToken.safeTransferFrom(msg.sender, address(this), assets);
        shares = assets; // 1:1 by construction
        _mint(receiver, shares);

        emit Deposit(msg.sender, receiver, assets, shares);
    }
}
