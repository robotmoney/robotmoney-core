// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0017-rmagent-retired-router-uses-three-vaults.md; docs/adr/ADR-0009-vault-retirement-no-assisted-migration.md
// Implements: issue 1912 (the Twin rehearsal of `govern --row retire-vault`, publish-contracts/src/ci/twin-upgrade-lifecycle.ts step 2c)
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice TEST FIXTURE, Twin only. The fourth vault of the retire rehearsal: a router leg that takes USDC 1:1 and pays it back 1:1, and that the registry can retire. It stands in for the live
///         v0.5.0 rmAGENT, so the real registry, the real router, the real Safe and the real timelock run the retire batch against a populated four-vault deployment. The behaviour of the
///         real `AgentTokenVault` after a retire (deposit reverts, redeem and redeemInKind keep paying) is proved by contracts/test/RetireVaultBatch.t.sol; this contract carries only the
///         surface the registry (`retire`, `unretire`, `asset`) and the router (`maxDeposit`, `previewDeposit`, `deposit`) call, plus `redeem`, `retired` and `registry` that the rehearsal reads.
contract RetirableLegVault is ERC20 {
    using SafeERC20 for IERC20;

    /// @notice A deposit while the vault is retired.
    error VaultRetired();
    /// @notice Only the registry halts or reopens deposits.
    error OnlyRegistry();

    IERC20 public immutable assetToken;
    /// @notice The registry that may retire this vault.
    address public immutable registry;
    /// @notice True once the registry retired the vault: deposits stop, withdrawals stay open (ADR-0009).
    bool public retired;

    constructor(address asset_, address registry_)
        ERC20("Robot Money Agent Tokens (retire test)", "rmAGENT-RETIRETEST")
    {
        assetToken = IERC20(asset_);
        registry = registry_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function asset() external view returns (address) {
        return address(assetToken);
    }

    function totalAssets() external view returns (uint256) {
        return assetToken.balanceOf(address(this));
    }

    function maxDeposit(address) external view returns (uint256) {
        return retired ? 0 : type(uint256).max;
    }

    function previewDeposit(uint256 assets) external pure returns (uint256) {
        return assets;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        if (retired) revert VaultRetired();
        assetToken.safeTransferFrom(msg.sender, address(this), assets);
        shares = assets;
        _mint(receiver, shares);
    }

    /// @notice Open in every state: a retired vault stays withdraw-only, never frozen.
    function redeem(uint256 shares, address receiver, address owner)
        external
        returns (uint256 assets)
    {
        if (msg.sender != owner) _spendAllowance(owner, msg.sender, shares);
        _burn(owner, shares);
        assets = shares;
        assetToken.safeTransfer(receiver, assets);
    }

    function retire() external {
        if (msg.sender != registry) revert OnlyRegistry();
        retired = true;
    }

    function unretire() external {
        if (msg.sender != registry) revert OnlyRegistry();
        retired = false;
    }
}
