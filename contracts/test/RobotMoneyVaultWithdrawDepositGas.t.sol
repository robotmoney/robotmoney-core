// SPDX-License-Identifier: MIT
// Canonical: none -- Foundry tests for core issue 1482, criterion "withdraw and deposit pass the
// same estimate-then-execute test". Fork-free. The redeem path lives in RobotMoneyVaultRedeemGas.t.sol.
// Chain-dependent criteria stay in RobotMoneyVaultRedeemGasForkTest (needs FORK_RPC_URL):
//   FORK_RPC_URL=<base rpc> forge test --match-contract RobotMoneyVaultRedeemGasForkTest
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {GasUSDC, GasBurningAdapter} from "./RobotMoneyVaultRedeemGas.t.sol";

contract RobotMoneyVaultWithdrawDepositGasTest is Test {
    uint256 internal constant ONE = 1e6;
    bytes4 internal constant INSUFFICIENT_GAS =
        bytes4(keccak256("InsufficientGas(uint256,uint256)"));

    GasUSDC internal usdc;
    RobotMoneyVault internal vault;
    GasBurningAdapter[3] internal adapters;
    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");

    function setUp() public {
        usdc = new GasUSDC();
        vault = new RobotMoneyVault(
            IERC20(address(usdc)), 1_000_000_000 * ONE, 100_000_000 * ONE, 0, admin, admin, admin
        );
        uint16[3] memory caps = [uint16(3334), uint16(3333), uint16(3333)];
        for (uint256 i = 0; i < 3; i++) {
            adapters[i] = new GasBurningAdapter(address(usdc), address(vault));
            adapters[i].setCosts(100_000, 100_000);
            vm.startPrank(admin);
            vault.setAdapterAllowed(address(adapters[i]), true);
            vault.setAdapterCodeHashAllowed(address(adapters[i]).codehash, true);
            vault.addAdapter(address(adapters[i]), caps[i]);
            vm.stopPrank();
        }
        usdc.mint(alice, 1_000_000 * ONE);
        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(3_000 * ONE, alice);
        vm.stopPrank();
    }

    function _call(bytes memory data, uint256 gasLimit)
        internal
        returns (bool ok, bytes memory ret)
    {
        vm.prank(alice);
        (ok, ret) = address(vault).call{gas: gasLimit}(data);
    }

    function _estimate(bytes memory data) internal returns (uint256) {
        uint256 snap = vm.snapshotState();
        uint256 lo = 21_000;
        uint256 hi = 25_000_000;
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) / 2;
            (bool ok,) = _call(data, mid);
            vm.revertToState(snap);
            snap = vm.snapshotState();
            if (ok) hi = mid;
            else lo = mid;
        }
        vm.revertToState(snap);
        return hi;
    }

    function _sel(bytes memory ret) internal pure returns (bytes4 sel) {
        assembly {
            sel := mload(add(ret, 32))
        }
    }

    function _setAllCosts(uint256 c) internal {
        for (uint256 i = 0; i < 3; i++) {
            adapters[i].setCosts(c, c + (i * 20_000));
        }
    }

    /// @notice Withdraw below the floor reverts with the typed error, never an opaque failure.
    function test_withdraw_belowFloor_revertsInsufficientGas() public {
        (bool ok, bytes memory ret) =
            _call(abi.encodeCall(vault.withdraw, (500 * ONE, alice, alice)), 300_000);
        assertFalse(ok, "withdraw must not succeed below the floor");
        assertGe(ret.length, 4, "opaque revert: no reason returned");
        assertEq(_sel(ret), INSUFFICIENT_GAS, "expected InsufficientGas");
    }

    /// @notice Every withdraw gas limit either succeeds or reverts InsufficientGas.
    function test_withdraw_gasSweep_neverOpaque() public {
        bytes memory data = abi.encodeCall(vault.withdraw, (400 * ONE, alice, alice));
        uint256 snap = vm.snapshotState();
        bool sawSuccess;
        bool sawGuard;
        for (uint256 g = 200_000; g <= 3_000_000; g += 100_000) {
            (bool ok, bytes memory ret) = _call(data, g);
            if (ok) {
                sawSuccess = true;
            } else {
                sawGuard = true;
                assertGe(ret.length, 4, "opaque failure at gas limit");
                assertEq(_sel(ret), INSUFFICIENT_GAS, "unexpected revert reason");
            }
            vm.revertToState(snap);
            snap = vm.snapshotState();
        }
        assertTrue(sawSuccess, "sweep never reached success");
        assertTrue(sawGuard, "sweep never hit the guard");
    }

    /// @notice Estimate (bisection) then execute withdraw at exactly that limit, over adapter states.
    function test_withdraw_estimateThenExecute_overAdapterStates() public {
        uint256[4] memory costs = [uint256(0), 50_000, 150_000, 300_000];
        for (uint256 c = 0; c < costs.length; c++) {
            _setAllCosts(costs[c]);
            bytes memory data = abi.encodeCall(vault.withdraw, ((500 + c) * ONE, alice, alice));
            uint256 est = _estimate(data);
            uint256 before = usdc.balanceOf(alice);
            (bool ok,) = _call(data, est);
            assertTrue(ok, "withdraw failed at the estimated limit");
            assertEq(
                usdc.balanceOf(alice) - before, (500 + c) * ONE, "withdraw paid the exact amount"
            );
            // Negative: far below the estimate is refused.
            (bool low,) = _call(data, est / 4);
            assertFalse(low, "a quarter of the estimate must not succeed");
            vm.revertToState(vm.snapshotState());
        }
    }

    /// @notice Estimate then execute deposit at exactly that limit, over adapter states.
    function test_deposit_estimateThenExecute_overAdapterStates() public {
        uint256[4] memory costs = [uint256(0), 50_000, 150_000, 300_000];
        for (uint256 c = 0; c < costs.length; c++) {
            _setAllCosts(costs[c]);
            bytes memory data = abi.encodeCall(vault.deposit, ((100 + c) * ONE, alice));
            uint256 est = _estimate(data);
            uint256 sharesBefore = vault.balanceOf(alice);
            (bool ok,) = _call(data, est);
            assertTrue(ok, "deposit failed at the estimated limit");
            assertGt(vault.balanceOf(alice), sharesBefore, "deposit minted shares");
        }
    }

    /// @notice Deposit at any gas limit either succeeds or fails with a reason, never silently.
    function test_deposit_gasSweep_neverSilentPartial() public {
        bytes memory data = abi.encodeCall(vault.deposit, (200 * ONE, alice));
        uint256 snap = vm.snapshotState();
        for (uint256 g = 100_000; g <= 3_000_000; g += 100_000) {
            uint256 sharesBefore = vault.balanceOf(alice);
            uint256 usdcBefore = usdc.balanceOf(alice);
            (bool ok,) = _call(data, g);
            if (!ok) {
                assertEq(vault.balanceOf(alice), sharesBefore, "failed deposit minted shares");
                assertEq(usdc.balanceOf(alice), usdcBefore, "failed deposit took USDC");
            } else {
                assertEq(
                    usdcBefore - usdc.balanceOf(alice), 200 * ONE, "deposit took the wrong amount"
                );
            }
            vm.revertToState(snap);
            snap = vm.snapshotState();
        }
    }
}
