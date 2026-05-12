// SPDX-License-Identifier: MIT
// Canonical: none — minimal ERC-4626 mock vault test fixture
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title MockVault
/// @notice Minimal `IERC4626`-shaped vault for gateway tests. Mints `rmUSDC`
///         shares 1:1 against deposited USDC and redeems 1:1 with no exit fee.
///         Covers the full deposit→redeem round-trip exercised by the dapp e2e
///         (issue #257). This contract is a TEST FIXTURE only.
contract MockVault is ERC20 {
    using SafeERC20 for IERC20;

    /// @notice Deposit amount is zero.
    error ZeroAmount();
    /// @notice Share receiver is the zero address.
    error ZeroReceiver();
    /// @notice Owner has fewer shares than the requested redeem amount.
    error InsufficientShares();

    /// @notice Underlying asset, pinned at construction.
    IERC20 public immutable assetToken;

    /// @notice No exit fee — mock fixture only.
    uint256 public constant exitFeeBps = 0;

    /// @notice ERC-4626-shaped Deposit event.
    /// @param sender   Address that called `deposit` and supplied the assets.
    /// @param receiver Address that received the minted shares.
    /// @param assets   Amount of underlying USDC deposited.
    /// @param shares   Amount of `rmUSDC` shares minted (1:1 with assets).
    event Deposit(address indexed sender, address indexed receiver, uint256 assets, uint256 shares);

    /// @notice ERC-4626-shaped Withdraw event.
    /// @param sender   Address that called `redeem`.
    /// @param receiver Address that received the USDC.
    /// @param owner    Address whose shares were burned.
    /// @param assets   Amount of USDC transferred to receiver.
    /// @param shares   Amount of `rmUSDC` shares burned.
    event Withdraw(
        address indexed sender,
        address indexed receiver,
        address indexed owner,
        uint256 assets,
        uint256 shares
    );

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

    /// @notice ERC-4626-style redeem. Burns `shares` from `owner` and
    ///         transfers `assets == shares` USDC (1:1, no exit fee) to `receiver`.
    /// @param  shares   Amount of `rmUSDC` shares to burn.
    /// @param  receiver Recipient of the redeemed USDC.
    /// @param  owner    Share owner whose balance is debited.
    /// @return assets   Amount of USDC transferred (== shares, 1:1).
    function redeem(uint256 shares, address receiver, address owner)
        external
        virtual
        returns (uint256 assets)
    {
        if (shares == 0) revert ZeroAmount();
        if (receiver == address(0)) revert ZeroReceiver();
        if (balanceOf(owner) < shares) revert InsufficientShares();

        if (owner != msg.sender) {
            _spendAllowance(owner, msg.sender, shares);
        }

        _burn(owner, shares);
        assets = shares; // 1:1 by construction
        assetToken.safeTransfer(receiver, assets);

        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    /// @notice Maximum shares redeemable for `owner` (their full balance).
    /// @param  owner Address to query.
    function maxRedeem(address owner) external view returns (uint256) {
        return balanceOf(owner);
    }

    /// @notice Preview assets returned for redeeming `shares` (1:1, no exit fee).
    /// @param  shares Amount of `rmUSDC` shares to preview.
    function previewRedeem(uint256 shares) external pure returns (uint256) {
        return shares;
    }
}
