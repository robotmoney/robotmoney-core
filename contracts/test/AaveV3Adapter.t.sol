// SPDX-License-Identifier: MIT
// Canonical: none — Foundry unit tests for contracts/adapters/AaveV3Adapter.sol
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AaveV3Adapter} from "../adapters/AaveV3Adapter.sol";
import {IPositionAdapter} from "../interfaces/IPositionAdapter.sol";
import {TestERC20} from "./helpers/TestERC20.sol";

/// @dev Minimal Aave V3 Pool mock. `supply` pulls USDC from the caller via
///      `transferFrom` (consuming the adapter's allowance, like the real pool)
///      and credits the caller's aToken balance 1:1. `withdraw` burns aTokens
///      and returns USDC to `to`.
contract MockAavePool {
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

contract AaveV3AdapterTest is Test {
    TestERC20 internal usdc;
    TestERC20 internal aToken;
    MockAavePool internal pool;
    AaveV3Adapter internal adapter;

    address internal vault = makeAddr("vault");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant ONE_USDC = 1e6;

    function setUp() public {
        usdc = new TestERC20();
        aToken = new TestERC20();
        pool = new MockAavePool(address(usdc), address(aToken));
        adapter = new AaveV3Adapter(address(pool), address(usdc), address(aToken), vault);
    }

    function test_deploy_movesUsdcIntoPool() public {
        uint256 amount = 100 * ONE_USDC;
        usdc.mint(vault, amount);
        vm.prank(vault);
        usdc.transfer(address(adapter), amount);

        vm.prank(vault);
        adapter.deploy(amount);

        assertEq(usdc.balanceOf(address(pool)), amount, "pool received USDC");
        assertEq(aToken.balanceOf(address(adapter)), amount, "adapter holds aTokens");
        assertEq(usdc.balanceOf(address(adapter)), 0, "no idle USDC on adapter");
    }

    /// @notice ADP-5 / NC-12: `deploy` uses `forceApprove(_, amount)` then
    ///         `forceApprove(_, 0)`, so the adapter's USDC allowance to the Aave
    ///         pool is exactly zero after the call — no residual approval lingers.
    function test_ADP5_deployZeroesAllowance() public {
        uint256 amount = 100 * ONE_USDC;
        usdc.mint(vault, amount);
        vm.prank(vault);
        usdc.transfer(address(adapter), amount);

        vm.prank(vault);
        adapter.deploy(amount);

        assertEq(
            usdc.allowance(address(adapter), address(pool)),
            0,
            "ADP-5: residual allowance must be zero after deploy"
        );
    }

    function test_deploy_revertsForNonVault() public {
        vm.prank(stranger);
        vm.expectRevert(IPositionAdapter.OnlyVault.selector);
        adapter.deploy(100 * ONE_USDC);
    }
}
