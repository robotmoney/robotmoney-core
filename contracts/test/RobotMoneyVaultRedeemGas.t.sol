// SPDX-License-Identifier: MIT
// Canonical: none -- Foundry tests for core issue 1482 (redeem out of gas at the node estimate).
// Mechanism status: the vault has no try/catch on the redeem path (`_pullProportional` calls
// `adpt.withdraw` directly), so the failure is gas-dependent execution inside an adapter call
// chain. The vault now reverts `InsufficientGas` before any adapter call it cannot finish.
// See docs/technical/redeem-gas-1482.md.
//
// Two suites:
//   RobotMoneyVaultRedeemGasUnitTest -- fork-free, runs anywhere.
//   RobotMoneyVaultRedeemGasForkTest -- skipped without FORK_RPC_URL; estimates, then executes
//                                       at exactly the estimated limit over many adapter states.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {DeployVault} from "../script/DeployVault.s.sol";
import {VaultTestParams} from "./helpers/VaultTestParams.sol";

contract GasUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Lossless adapter whose `withdraw` and `totalAssets` burn a configurable amount of gas,
///      to price them like the live protocol calls (MetaMorpho totalAssets ~201k).
contract GasBurningAdapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDC;
    address public immutable VAULT;
    uint256 public withdrawCost;
    uint256 public readCost;

    constructor(address usdc_, address vault_) {
        USDC = IERC20(usdc_);
        VAULT = vault_;
    }

    function setCosts(uint256 withdrawCost_, uint256 readCost_) external {
        withdrawCost = withdrawCost_;
        readCost = readCost_;
    }

    function _burn(uint256 cost) private view {
        if (cost == 0) return;
        uint256 start = gasleft();
        while (start - gasleft() < cost) {}
    }

    function deploy(uint256) external {
        _burn(withdrawCost);
    }

    function withdraw(uint256 amount) external returns (uint256 actual) {
        require(msg.sender == VAULT, "only vault");
        _burn(withdrawCost);
        uint256 bal = USDC.balanceOf(address(this));
        actual = amount > bal ? bal : amount;
        if (actual > 0) USDC.safeTransfer(VAULT, actual);
    }

    function totalAssets() external view returns (uint256) {
        _burn(readCost);
        return USDC.balanceOf(address(this));
    }

    function sweepForeignToken(address) external {}

    function harvestRewards() external {}
}

contract RobotMoneyVaultRedeemGasUnitTest is Test {
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

    function _redeemWithGas(uint256 gasLimit, uint256 shares)
        internal
        returns (bool ok, bytes memory ret)
    {
        vm.prank(alice);
        (ok, ret) = address(vault).call{gas: gasLimit}(
            abi.encodeCall(vault.redeem, (shares, alice, alice))
        );
    }

    /// @notice Below the floor the vault reverts with the typed error, never silently.
    function test_redeem_belowFloor_revertsInsufficientGas() public {
        uint256 shares = vault.balanceOf(alice) / 2;
        (bool ok, bytes memory ret) = _redeemWithGas(300_000, shares);
        assertFalse(ok);
        assertGe(ret.length, 4, "opaque revert: no reason returned");
        bytes4 sel;
        assembly {
            sel := mload(add(ret, 32))
        }
        assertEq(sel, INSUFFICIENT_GAS, "expected InsufficientGas");
    }

    /// @notice Gas used by a full-gas redeem, measured with gasleft.
    function test_redeem_measuresGasUsed() public {
        uint256 shares = vault.balanceOf(alice) / 2;
        vm.prank(alice);
        uint256 before = gasleft();
        vault.redeem(shares, alice, alice);
        uint256 used = before - gasleft();
        emit log_named_uint("redeem gas used", used);
        assertGt(used, 0);
        assertLt(used, 5_000_000);
    }

    /// @notice Sweep gas limits. Every outcome is success or the typed error. A bare
    ///         revert or out-of-gas (empty return data) fails the test.
    function test_redeem_gasSweep_neverOpaque() public {
        uint256 shares = vault.balanceOf(alice) / 3;
        uint256 snap = vm.snapshotState();
        for (uint256 g = 200_000; g <= 2_000_000; g += 25_000) {
            (bool ok, bytes memory ret) = _redeemWithGas(g, shares);
            if (!ok) {
                assertGe(ret.length, 4, "opaque failure at gas limit");
                bytes4 sel;
                assembly {
                    sel := mload(add(ret, 32))
                }
                assertEq(sel, INSUFFICIENT_GAS, "unexpected revert reason");
            }
            vm.revertToState(snap);
            snap = vm.snapshotState();
        }
    }

    /// @notice Estimate (smallest limit that succeeds, by bisection) then execute at exactly
    ///         that limit, across several adapter cost states.
    function test_redeem_estimateThenExecute_overAdapterStates() public {
        uint256[4] memory costs = [uint256(0), 50_000, 150_000, 300_000];
        for (uint256 c = 0; c < costs.length; c++) {
            for (uint256 i = 0; i < 3; i++) {
                adapters[i].setCosts(costs[c], costs[c] + (i * 20_000));
            }
            uint256 shares = vault.balanceOf(alice) / 4;
            uint256 snap = vm.snapshotState();
            uint256 lo = 21_000;
            uint256 hi = 6_000_000;
            while (lo + 1 < hi) {
                uint256 mid = (lo + hi) / 2;
                (bool ok,) = _redeemWithGas(mid, shares);
                vm.revertToState(snap);
                snap = vm.snapshotState();
                if (ok) hi = mid;
                else lo = mid;
            }
            (bool okAtEstimate,) = _redeemWithGas(hi, shares);
            assertTrue(okAtEstimate, "redeem failed at the estimated limit");
            vm.revertToState(snap);
        }
    }
}

/// @dev Fork suite. Skipped without FORK_RPC_URL. Not part of the fast unit run.
///      Clean room: the test deploys its OWN vault through the real DeployVault stage script
///      (real adapters, real seed) on the Twin chain and never reads a production v1 vault.
contract RobotMoneyVaultRedeemGasForkTest is Test {
    address internal constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    RobotMoneyVault internal vault;
    address internal user = makeAddr("gasUser");
    address internal admin = makeAddr("gasAdmin");
    address internal seedReceiver = makeAddr("gasSeedReceiver");

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        deal(USDC_BASE, admin, VaultTestParams.SEED_DEPOSIT_AMOUNT);
        DeployVault.Deployed memory d = new DeployVault()
            .runInProcessWithSeed(
                VaultTestParams.params(admin, USDC_BASE),
                seedReceiver,
                VaultTestParams.SEED_DEPOSIT_AMOUNT
            );
        vault = d.vault;
        deal(USDC_BASE, user, 10_000 * 1e6);
        vm.startPrank(user);
        IERC20(USDC_BASE).approve(address(vault), type(uint256).max);
        vault.deposit(5_000 * 1e6, user);
        vm.stopPrank();
    }

    function _try(bytes memory data, uint256 gasLimit) internal returns (bool ok) {
        vm.prank(user);
        (ok,) = address(vault).call{gas: gasLimit}(data);
    }

    function _estimate(bytes memory data) internal returns (uint256) {
        uint256 snap = vm.snapshotState();
        uint256 lo = 21_000;
        uint256 hi = 8_000_000;
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) / 2;
            bool ok = _try(data, mid);
            vm.revertToState(snap);
            snap = vm.snapshotState();
            if (ok) hi = mid;
            else lo = mid;
        }
        vm.revertToState(snap);
        return hi;
    }

    /// @notice Over many adapter states (time and block shifts change accrued interest and
    ///         cold/warm state), the estimate must execute at exactly that limit.
    function test_fork_redeem_executesAtExactEstimate_manyStates() public {
        for (uint256 s = 0; s < 24; s++) {
            vm.warp(block.timestamp + 1 hours * (s + 1));
            vm.roll(block.number + 100 * (s + 1));
            uint256 shares = vault.balanceOf(user) / 10 + s;
            bytes memory data = abi.encodeCall(vault.redeem, (shares, user, user));
            uint256 est = _estimate(data);
            uint256 snap = vm.snapshotState();
            assertTrue(_try(data, est), "redeem failed at the exact estimate");
            vm.revertToState(snap);
        }
    }

    function test_fork_withdraw_executesAtExactEstimate() public {
        bytes memory data = abi.encodeCall(vault.withdraw, (100 * 1e6, user, user));
        uint256 est = _estimate(data);
        assertTrue(_try(data, est), "withdraw failed at the exact estimate");
    }

    function test_fork_deposit_executesAtExactEstimate() public {
        bytes memory data = abi.encodeCall(vault.deposit, (100 * 1e6, user));
        uint256 est = _estimate(data);
        assertTrue(_try(data, est), "deposit failed at the exact estimate");
    }

    /// @notice The reported defect shape for deposit: estimate in the accrued-this-block state,
    ///         include later at exactly that limit. Venues accrue interest on the first write in
    ///         a later block, so the deposit may cost more than it did at the estimate.
    function test_fork_deposit_estimateThenIncludeLater() public {
        // Accrue every venue in this block (a tiny deposit writes to the adapters).
        vm.prank(user);
        vault.deposit(10 * 1e6, user);
        bytes memory data = abi.encodeCall(vault.deposit, (100 * 1e6, user));
        uint256[3] memory gaps = [uint256(2), 1 hours, 1 days];
        uint256 t0 = block.timestamp;
        uint256 n0 = block.number;
        uint256 snap = vm.snapshotState();
        for (uint256 i = 0; i < gaps.length; i++) {
            uint256 est = _estimate(data);
            vm.warp(t0 + gaps[i]);
            vm.roll(n0 + 1 + gaps[i] / 2);
            uint256 sharesBefore = vault.balanceOf(user);
            emit log_named_uint("deposit estimate (accrued state)", est);
            emit log_named_uint("deposit smallest passing limit later", _estimate(data));
            assertTrue(_try(data, est), "deposit failed at the estimated limit in a later block");
            assertGt(vault.balanceOf(user), sharesBefore, "deposit minted no shares");

            vm.revertToState(snap);
            snap = vm.snapshotState();
            vm.warp(t0);
            vm.roll(n0);
        }
    }
}
