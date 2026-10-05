// SPDX-License-Identifier: MIT
// Canonical: none -- core issue 1482 root-cause measurement on a Base mainnet fork (read-only RPC).
// See docs/technical/redeem-gas-1482.md.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {DeployVault} from "../script/DeployVault.s.sol";
import {VaultTestParams} from "./helpers/VaultTestParams.sol";

contract RobotMoneyVaultRedeemGasRootCauseTest is Test {
    address internal constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    RobotMoneyVault internal vault;
    DeployVault.Deployed internal dep;
    address internal user = makeAddr("gasUser");
    address internal admin = makeAddr("gasAdmin");
    address internal seedReceiver = makeAddr("gasSeedReceiver");

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        // Skips with a named reason; the CI fork runner fails a run in which nothing executed.
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        deal(USDC_BASE, admin, VaultTestParams.SEED_DEPOSIT_AMOUNT);
        DeployVault.Deployed memory d = new DeployVault()
            .runInProcessWithSeed(
                VaultTestParams.params(admin, USDC_BASE),
                seedReceiver,
                VaultTestParams.SEED_DEPOSIT_AMOUNT
            );
        dep = d;
        vault = d.vault;
        deal(USDC_BASE, user, 10_000 * 1e6);
        vm.startPrank(user);
        IERC20(USDC_BASE).approve(address(vault), type(uint256).max);
        vault.deposit(5_000 * 1e6, user);
        // tiny redeem: every protocol accrues at the current timestamp
        vault.redeem(1e12, user, user);
        vm.stopPrank();
    }

    function _used(uint256 shares) internal returns (uint256 used) {
        vm.prank(user);
        uint256 g = gasleft();
        vault.redeem(shares, user, user);
        used = g - gasleft();
    }

    function _try(uint256 shares, uint256 gasLimit)
        internal
        returns (bool ok, bytes memory ret, uint256 used)
    {
        vm.prank(user);
        uint256 g = gasleft();
        (ok, ret) =
            address(vault).call{gas: gasLimit}(abi.encodeCall(vault.redeem, (shares, user, user)));
        used = g - gasleft();
    }

    /// @dev Smallest passing limit by bisection (what eth_estimateGas does) at the current state.
    function _estimate(uint256 shares) internal returns (uint256) {
        uint256 snap = vm.snapshotState();
        uint256 lo = 21_000;
        uint256 hi = 8_000_000;
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) / 2;
            (bool ok,,) = _try(shares, mid);
            vm.revertToState(snap);
            snap = vm.snapshotState();
            if (ok) hi = mid;
            else lo = mid;
        }
        return hi;
    }

    /// @notice Root cause: a redeem in the same second as the last protocol accrual skips the
    ///         interest accrual. The first redeem in a later block pays for it. The gas
    ///         difference is the whole gap between the estimate and the inclusion.
    function test_rootCause_accrualAddsGasInLaterBlock() public {
        uint256 shares = vault.balanceOf(user) / 10;
        uint256 snap = vm.snapshotState();
        uint256 sameBlock = _used(shares);
        vm.revertToState(snap);
        vm.warp(block.timestamp + 2);
        vm.roll(block.number + 1);
        uint256 nextBlock = _used(shares);
        emit log_named_uint("redeem gas, accrued this block", sameBlock);
        emit log_named_uint("redeem gas, next block (2s later)", nextBlock);
        emit log_named_uint("accrual delta", nextBlock - sameBlock);
        assertGt(nextBlock - sameBlock, 50_000, "no accrual delta: mechanism not reproduced");
    }

    /// @notice The reported failure, reproduced: estimate in the accrued-this-block state,
    ///         include one block later at exactly that limit. Must execute (the gas floors
    ///         lift every limit above the later-block cost). Against a vault without the
    ///         floors this exact sequence reverts with empty data.
    function test_rootCause_estimateThenIncludeNextBlock() public {
        uint256 shares = vault.balanceOf(user) / 10;
        uint256[3] memory gaps = [uint256(2), 1 hours, 1 days];
        uint256 t0 = block.timestamp;
        uint256 n0 = block.number;
        uint256 snap = vm.snapshotState();
        for (uint256 i = 0; i < gaps.length; i++) {
            uint256 est = _estimate(shares);
            vm.warp(t0 + gaps[i]);
            vm.roll(n0 + 1 + gaps[i] / 2);
            (bool ok, bytes memory ret,) = _try(shares, est);
            emit log_named_uint("estimate in accrued-this-block state", est);
            emit log_named_uint("seconds later", gaps[i]);
            emit log_named_uint("return or revert data length", ret.length);
            assertTrue(ok, "redeem failed at the estimated limit in a later block");
            vm.revertToState(snap);
            snap = vm.snapshotState();
            vm.warp(t0);
            vm.roll(n0);
        }
    }

    /// @notice A limit equal to the accrued-this-block cost reverts typed, never empty.
    function test_rootCause_limitAtSameBlockCostRevertsTyped() public {
        uint256 shares = vault.balanceOf(user) / 10;
        uint256 snap = vm.snapshotState();
        uint256 sameBlock = _used(shares);
        vm.revertToState(snap);
        vm.warp(block.timestamp + 2);
        vm.roll(block.number + 1);
        (bool ok, bytes memory ret,) = _try(shares, sameBlock + 5_000);
        assertFalse(ok);
        bytes4 sel;
        assembly {
            sel := mload(add(ret, 32))
        }
        assertEq(sel, RobotMoneyVault.InsufficientGas.selector, "expected typed InsufficientGas");
    }

    function _adapterWithdrawGas(address adapter, uint256 amount) internal returns (uint256 used) {
        vm.prank(address(vault));
        uint256 g = gasleft();
        (bool ok,) = adapter.call(abi.encodeWithSignature("withdraw(uint256)", amount));
        used = g - gasleft();
        require(ok, "adapter withdraw failed");
    }

    /// @notice Per adapter withdraw cost in the later-block state, against the 400k per-adapter
    ///         floor. Moonwell (MetaMorpho) is the heaviest and the closest to the floor.
    function test_rootCause_realAdapterWithdrawGas_laterBlock() public {
        vm.warp(block.timestamp + 2);
        vm.roll(block.number + 1);
        address[3] memory a =
            [address(dep.aaveAdapter), address(dep.compoundAdapter), address(dep.moonwellAdapter)];
        string[3] memory names = ["aave", "compound", "moonwell"];
        uint256 snap = vm.snapshotState();
        for (uint256 i = 0; i < 3; i++) {
            uint256 g = _adapterWithdrawGas(a[i], IStrat(a[i]).totalAssets() / 3);
            emit log_named_uint(string.concat(names[i], " withdraw gas"), g);
            assertLt(g, 400_000, "adapter withdraw exceeds the per-adapter floor");
            vm.revertToState(snap);
            snap = vm.snapshotState();
        }
    }
}

interface IStrat {
    function totalAssets() external view returns (uint256);
}
