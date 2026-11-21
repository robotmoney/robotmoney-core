// SPDX-License-Identifier: MIT
// Canonical: none — lending-venue test doubles that refuse a supply (security round 2) or shut
// withdrawals too (security round 3)
// (See also: contracts/adapters/AaveV3Adapter.sol, MorphoAdapter.sol, CompoundV3Adapter.sol —
//  `deploy(uint256)` hands a refused supply back to the vault)
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestERC20} from "./TestERC20.sol";

/// @dev 1:1 Aave V3 Pool with a reserve supply cap. `supply` reverts "27" (`RESERVE_INACTIVE`)
///      while inactive, "29" (`RESERVE_PAUSED`) while paused, "28" (`RESERVE_FROZEN`) while frozen
///      and "51" (`SUPPLY_CAP_EXCEEDED`) for an amount above `headroom`, in the order of Aave's
///      `ValidationLogic.validateSupply`. `withdraw` reverts "27" / "29" as `validateWithdraw`
///      does, and a frozen reserve still pays. A withdrawal frees headroom again.
///      `getConfiguration` reports the active (56), frozen (57) and paused (60) bits.
contract CappedAavePool {
    IERC20 public immutable usdc;
    TestERC20 public immutable aToken;
    uint256 public headroom;
    bool public frozen;
    bool public paused;
    bool public inactive;

    constructor(address usdc_, address aToken_, uint256 headroom_) {
        usdc = IERC20(usdc_);
        aToken = TestERC20(aToken_);
        headroom = headroom_;
    }

    function setHeadroom(uint256 headroom_) external {
        headroom = headroom_;
    }

    function setFrozen(bool frozen_) external {
        frozen = frozen_;
    }

    /// @dev Aave's guardian `setReservePause`: supply and withdraw both revert "29".
    function setPaused(bool paused_) external {
        paused = paused_;
    }

    function setInactive(bool inactive_) external {
        inactive = inactive_;
    }

    function getConfiguration(address asset) external view returns (uint256 data) {
        require(asset == address(usdc), "wrong asset");
        if (!inactive) data |= 1 << 56;
        if (frozen) data |= 1 << 57;
        if (paused) data |= 1 << 60;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(asset == address(usdc), "wrong asset");
        require(!inactive, "27");
        require(!paused, "29");
        require(!frozen, "28");
        require(amount <= headroom, "51");
        headroom -= amount;
        usdc.transferFrom(msg.sender, address(this), amount);
        aToken.mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(asset == address(usdc), "wrong asset");
        require(!inactive, "27");
        require(!paused, "29");
        uint256 out = amount == type(uint256).max ? aToken.balanceOf(msg.sender) : amount;
        aToken.burn(msg.sender, out);
        headroom += out;
        usdc.transfer(to, out);
        return out;
    }
}

/// @dev 1:1 MetaMorpho with a total supply-queue cap. `maxDeposit` reports `headroom`, and
///      `deposit` reverts `AllCapsReached` above it, as MetaMorpho does once every market cap in
///      its supply queue is full.
contract CappedMetaMorpho is ERC20 {
    IERC20 public immutable asset;
    uint256 public headroom;

    error AllCapsReached();

    constructor(address asset_, uint256 headroom_) ERC20("Capped MetaMorpho", "cmmUSDC") {
        asset = IERC20(asset_);
        headroom = headroom_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function setHeadroom(uint256 headroom_) external {
        headroom = headroom_;
    }

    function maxDeposit(address) external view returns (uint256) {
        return headroom;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        if (assets > headroom) revert AllCapsReached();
        headroom -= assets;
        asset.transferFrom(msg.sender, address(this), assets);
        shares = assets;
        _mint(receiver, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner)
        external
        returns (uint256 shares)
    {
        shares = assets;
        _burn(owner, shares);
        headroom += assets;
        asset.transfer(receiver, assets);
    }

    function convertToAssets(uint256 shares_) external pure returns (uint256) {
        return shares_;
    }
}

/// @dev 1:1 Compound V3 Comet whose pause guardian pauses supply (`isSupplyPaused`) and withdraw
///      (`isWithdrawPaused`) separately: the paused call reverts `Paused`, as Comet does.
contract PausableComet {
    IERC20 public immutable usdc;
    mapping(address => uint256) public balanceOf;
    bool public isSupplyPaused;
    bool public isWithdrawPaused;

    error Paused();

    constructor(address usdc_) {
        usdc = IERC20(usdc_);
    }

    function setSupplyPaused(bool paused_) external {
        isSupplyPaused = paused_;
    }

    function setWithdrawPaused(bool paused_) external {
        isWithdrawPaused = paused_;
    }

    function supply(address asset, uint256 amount) external {
        require(asset == address(usdc), "wrong asset");
        if (isSupplyPaused) revert Paused();
        usdc.transferFrom(msg.sender, address(this), amount);
        balanceOf[msg.sender] += amount;
    }

    function withdraw(address asset, uint256 amount) external {
        require(asset == address(usdc), "wrong asset");
        if (isWithdrawPaused) revert Paused();
        uint256 bal = balanceOf[msg.sender];
        uint256 out = amount == type(uint256).max ? bal : amount;
        require(out <= bal, "insufficient");
        balanceOf[msg.sender] = bal - out;
        usdc.transfer(msg.sender, out);
    }
}
