// SPDX-License-Identifier: MIT
// Canonical: the one-deployment-scheme plan, core S3 (issues 1485, 1493)
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {DeployVault} from "../../script/DeployVault.s.sol";
import {TestERC20} from "./TestERC20.sol";

/// @dev Stand-ins for the three EXTERNAL lending venues (Aave V3, Compound V3, Moonwell Flagship
///      USDC). Their runtime code is etched at the real venue addresses the production vault
///      stage uses, so the split stages run unchanged in process and a deposit and a withdraw
///      round trip completes without a fork. Each is 1:1, holds no state in the constructor
///      (the runtime code is copied, storage is not) and takes the USDC address as an immutable.
///      These are venues, not the thing under test: the gateway, router, registry and vault
///      are the production contracts built by the production stage scripts.
contract EtchAavePool {
    IERC20 public immutable usdc;
    TestERC20 public immutable aToken;

    constructor(address usdc_, address aToken_) {
        usdc = IERC20(usdc_);
        aToken = TestERC20(aToken_);
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(asset == address(usdc), "wrong asset");
        usdc.transferFrom(msg.sender, address(this), amount);
        aToken.mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(asset == address(usdc), "wrong asset");
        aToken.burn(msg.sender, amount);
        usdc.transfer(to, amount);
        return amount;
    }
}

contract EtchComet {
    IERC20 public immutable usdc;
    mapping(address => uint256) public balanceOf;

    constructor(address usdc_) {
        usdc = IERC20(usdc_);
    }

    function supply(address asset, uint256 amount) external {
        require(asset == address(usdc), "wrong asset");
        usdc.transferFrom(msg.sender, address(this), amount);
        balanceOf[msg.sender] += amount;
    }

    function withdraw(address asset, uint256 amount) external {
        require(asset == address(usdc), "wrong asset");
        if (amount == type(uint256).max) amount = balanceOf[msg.sender];
        balanceOf[msg.sender] -= amount;
        usdc.transfer(msg.sender, amount);
    }
}

contract EtchErc4626Venue is ERC20 {
    IERC20 public immutable asset;

    constructor(address asset_) ERC20("venue", "v") {
        asset = IERC20(asset_);
    }

    function deposit(uint256 assets, address receiver) external returns (uint256) {
        asset.transferFrom(msg.sender, address(this), assets);
        _mint(receiver, assets);
        return assets;
    }

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256) {
        _burn(owner, assets);
        asset.transfer(receiver, assets);
        return assets;
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256) {
        _burn(owner, shares);
        asset.transfer(receiver, shares);
        return shares;
    }

    function convertToAssets(uint256 shares) external pure returns (uint256) {
        return shares;
    }
}

/// @dev Etches the three venue doubles at the production vault stage's venue addresses.
library VenueEtcher {
    Vm__ private constant vm = Vm__(address(uint160(uint256(keccak256("hevm cheat code")))));

    function etchAll(address usdc) internal {
        DeployVault ref = new DeployVault();
        address aToken = ref.AAVE_V3_A_TOKEN();
        vm.etch(aToken, address(new TestERC20()).code);
        vm.etch(ref.AAVE_V3_POOL(), address(new EtchAavePool(usdc, aToken)).code);
        vm.etch(ref.COMPOUND_V3_COMET(), address(new EtchComet(usdc)).code);
        vm.etch(ref.MOONWELL_FLAGSHIP_USDC(), address(new EtchErc4626Venue(usdc)).code);
    }
}

interface Vm__ {
    function etch(address target, bytes calldata newRuntimeBytecode) external;
}
