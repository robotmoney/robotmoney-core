// SPDX-License-Identifier: MIT
// Canonical: none -- Foundry unit tests that probe the redeem out-of-gas mechanism (core 1482).
// No fork. The adapters are gas-metered stubs (a real MetaMorpho/Aave/Compound needs a fork).
// Findings are documented in docs/technical/redeem-gas-1482.md.
//
// What the suite establishes, on the real RobotMoneyVault code:
//   1. The 63/64 rule: an adapter called right after the 400k floor check receives at least
//      about 393k gas (probe adapter records gasleft() on entry).
//   2. The vault cannot silently under-pay: an adapter that swallows its own inner
//      out-of-gas and under-delivers makes the vault revert with a typed error. A bisect
//      estimate over that stub lands on a limit that fully pays, and one gas less does not.
//   3. The guard has a limit: an adapter that needs more than the floor forwards makes the
//      call fail with an untyped revert in a window of gas limits above the floor. The
//      failure landscape is non-monotone: typed guard, untyped window, typed tail guard, success.
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {GasUSDC, GasBurningAdapter} from "./RobotMoneyVaultRedeemGas.t.sol";

/// @dev Burns `cost` in `withdraw`, records the gas it was entered with.
contract ProbeAdapter is IStrategyAdapter {
    using SafeERC20 for IERC20;

    IERC20 public immutable USDC;
    address public immutable VAULT;
    uint256 public cost;
    uint256 public readCost;
    uint256 public entryGas;
    /// @dev When true the burn runs in a self-call whose failure is swallowed (a callee that
    ///      tolerates inner failure, which the real adapters do not do).
    bool public tolerant;

    constructor(address usdc_, address vault_) {
        USDC = IERC20(usdc_);
        VAULT = vault_;
    }

    function configure(uint256 cost_, bool tolerant_) external {
        configure(cost_, tolerant_, 0);
    }

    function configure(uint256 cost_, bool tolerant_, uint256 readCost_) public {
        readCost = readCost_;
        cost = cost_;
        tolerant = tolerant_;
    }

    function work() external view {
        uint256 start = gasleft();
        while (start - gasleft() < cost) {}
    }

    function deploy(uint256) external {}

    function withdraw(uint256 amount) external returns (uint256 actual) {
        require(msg.sender == VAULT, "only vault");
        entryGas = gasleft();
        if (tolerant) {
            (bool ok,) = address(this).call(abi.encodeCall(this.work, ()));
            if (!ok) return 0;
        } else {
            this.work();
        }
        uint256 bal = USDC.balanceOf(address(this));
        actual = amount > bal ? bal : amount;
        if (actual > 0) USDC.safeTransfer(VAULT, actual);
    }

    function totalAssets() external view returns (uint256) {
        uint256 start = gasleft();
        while (start - gasleft() < readCost) {}
        return USDC.balanceOf(address(this));
    }

    function sweepForeignToken(address) external {}

    function harvestRewards() external {}
}

contract RobotMoneyVaultRedeemGasMechanismTest is Test {
    uint256 internal constant ONE = 1e6;
    bytes4 internal constant INSUFFICIENT_GAS =
        bytes4(keccak256("InsufficientGas(uint256,uint256)"));
    bytes4 internal constant INSUFFICIENT_LIQ =
        bytes4(keccak256("InsufficientAdapterLiquidity(uint256,uint256)"));

    GasUSDC internal usdc;
    RobotMoneyVault internal vault;
    ProbeAdapter internal probe;
    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");

    function setUp() public {
        usdc = new GasUSDC();
        vault = new RobotMoneyVault(
            IERC20(address(usdc)), 1_000_000_000 * ONE, 100_000_000 * ONE, 0, admin, admin, admin
        );
        probe = new ProbeAdapter(address(usdc), address(vault));
        vm.startPrank(admin);
        vault.setAdapterAllowed(address(probe), true);
        vault.setAdapterCodeHashAllowed(address(probe).codehash, true);
        vault.addAdapter(address(probe), 10_000);
        vm.stopPrank();
        usdc.mint(alice, 1_000_000 * ONE);
        vm.startPrank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(3_000 * ONE, alice);
        vm.stopPrank();
    }

    function _redeem(uint256 gasLimit, uint256 shares)
        internal
        returns (bool ok, bytes memory ret)
    {
        vm.prank(alice);
        (ok, ret) = address(vault).call{gas: gasLimit}(
            abi.encodeCall(vault.redeem, (shares, alice, alice))
        );
    }

    function _sel(bytes memory ret) internal pure returns (bytes4 sel) {
        if (ret.length < 4) return bytes4(0);
        assembly {
            sel := mload(add(ret, 32))
        }
    }

    /// @dev True when `ret` is `InsufficientGas` raised by a guard that sits before the adapter
    ///      call (entry or per-adapter floor), not the tail floor after it.
    function _preAdapterGuard(bytes memory ret) internal pure returns (bool) {
        if (_sel(ret) != INSUFFICIENT_GAS || ret.length != 68) return false;
        uint256 required;
        assembly {
            required := mload(add(ret, 68))
        }
        return required != 150_000;
    }

    /// @dev Smallest gas limit whose failure is not a pre-adapter `InsufficientGas` (the guard stops
    ///      firing). Restores state.
    function _guardCrossing(uint256 shares) internal returns (uint256) {
        uint256 snap = vm.snapshotState();
        uint256 lo = 21_000;
        uint256 hi = 8_000_000;
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) / 2;
            (bool ok, bytes memory ret) = _redeem(mid, shares);
            vm.revertToState(snap);
            snap = vm.snapshotState();
            if (ok || !_preAdapterGuard(ret)) hi = mid;
            else lo = mid;
        }
        return hi;
    }

    /// @notice Claim 1: the adapter is entered with at least floor*63/64 minus call overhead.
    function test_forwardedGas_respectsFloorTimes6364() public {
        // Reads cost 450k each (pessimistic): the read prefix is about 1.35M, so the 400k
        // per-adapter floor binds, not the 1.6M entry floor.
        probe.configure(0, false, 450_000);
        uint256 shares = vault.balanceOf(alice) / 2;
        uint256 gc = _guardCrossing(shares);
        emit log_named_uint("guard crossing gas limit", gc);
        uint256 minEntry = type(uint256).max;
        uint256 snap = vm.snapshotState();
        for (uint256 g = gc; g <= gc + 60_000; g += 997) {
            (bool ok,) = _redeem(g, shares);
            if (ok) {
                uint256 e = probe.entryGas();
                if (e < minEntry) minEntry = e;
            }
            vm.revertToState(snap);
            snap = vm.snapshotState();
        }
        emit log_named_uint("min adapter entry gas over successful runs", minEntry);
        // The check needs gasleft >= 400_000 and the call forwards 63/64 of what is left
        // after the check: 393_750 less a few thousand of call-site overhead.
        assertGe(minEntry, 385_000, "adapter entered below the 63/64 floor");
        assertLe(minEntry, 420_000, "sweep never reached the tight end");
    }

    /// @notice Claim 2: a callee that swallows inner failure cannot make the vault under-pay.
    ///         Every sweep point is success (full payout), InsufficientGas or
    ///         InsufficientAdapterLiquidity. The bisect estimate pays in full, estimate-1 does not.
    function test_tolerantAdapter_neverSilentUnderpay() public {
        probe.configure(250_000, true);
        uint256 shares = vault.balanceOf(alice) / 2;
        uint256 expected = vault.previewRedeem(shares);
        uint256 snap = vm.snapshotState();
        bool seenSuccess;
        for (uint256 g = 1_190_000; g <= 1_700_000; g += 3_001) {
            uint256 before = usdc.balanceOf(alice);
            (bool ok, bytes memory ret) = _redeem(g, shares);
            if (ok) {
                assertEq(usdc.balanceOf(alice) - before, expected, "silent under-payment");
                seenSuccess = true;
            } else {
                assertFalse(seenSuccess, "success then failure: non-monotone");
                bytes4 s = _sel(ret);
                assertTrue(s == INSUFFICIENT_GAS || s == INSUFFICIENT_LIQ, "opaque or untyped");
            }
            vm.revertToState(snap);
            snap = vm.snapshotState();
        }
        assertTrue(seenSuccess, "sweep never succeeded");

        uint256 lo = 21_000;
        uint256 hi = 3_000_000;
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) / 2;
            (bool ok2,) = _redeem(mid, shares);
            vm.revertToState(snap);
            snap = vm.snapshotState();
            if (ok2) hi = mid;
            else lo = mid;
        }
        uint256 b4 = usdc.balanceOf(alice);
        (bool atEst,) = _redeem(hi, shares);
        assertTrue(atEst, "estimate does not execute");
        assertEq(usdc.balanceOf(alice) - b4, expected, "estimate under-pays");
        emit log_named_uint("bisect estimate (tolerant stub)", hi);
    }

    /// @notice Claim 3: the guard is a floor, not a proof. An adapter that needs more than the
    ///         floor forwards fails with an untyped revert (empty data, or FailedInnerCall from a
    ///         starved token transfer) in a window of limits just above
    ///         the guard crossing.
    /// forge-config: default.gas_limit = 9223372036854775807
    function test_guardLimit_adapterNeedingMoreThanFloorFailsOpaque() public {
        uint256 shares = vault.balanceOf(alice) / 2;

        probe.configure(100_000, false, 450_000);
        assertEq(_countOpaque(shares), 0, "cheap adapter must never fail opaque");

        probe.configure(450_000, false, 450_000);
        uint256 opaqueBig = _countOpaque(shares);
        emit log_named_uint("opaque failures, adapter needing 450k", opaqueBig);
        assertGt(opaqueBig, 0, "expected an opaque window above the floor");
    }

    function _countOpaque(uint256 shares) internal returns (uint256 n) {
        uint256 gc = _guardCrossing(shares);
        uint256 snap = vm.snapshotState();
        for (uint256 g = gc; g <= gc + 200_000; g += 1_999) {
            (bool ok, bytes memory ret) = _redeem(g, shares);
            if (!ok) {
                bytes4 sl = _sel(ret);
                if (sl != INSUFFICIENT_GAS && sl != INSUFFICIENT_LIQ) n++;
            }
            vm.revertToState(snap);
            snap = vm.snapshotState();
        }
    }
}
