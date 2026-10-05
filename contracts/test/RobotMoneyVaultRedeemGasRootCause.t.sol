// SPDX-License-Identifier: MIT
// Canonical: none -- core issue 1482 root-cause measurement on a Base mainnet fork (read-only RPC).
// See docs/technical/redeem-gas-1482.md.
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {DeployVault} from "../script/DeployVault.s.sol";
import {VaultTestParams} from "./helpers/VaultTestParams.sol";
import {ForkSelect} from "./helpers/ForkSelect.sol";
import {CoreStages} from "./helpers/CoreStages.sol";
import {VaultRegistry} from "../VaultRegistry.sol";
import {IGateway} from "../gateway/interfaces/IGateway.sol";

/// @notice Test-local harness: rewrites immediates in deployed runtime bytecode. Used to build the
///         unfixed vault (every gas floor zeroed) and a vault with only the entry floor zeroed,
///         from the exact shipped bytecode, with no test-only code in production contracts.
///         It walks opcodes so PUSH data is never mistaken for an opcode.
library BytecodePatch {
    function patchPush3(bytes memory code, uint24 from, uint24 to)
        internal
        pure
        returns (uint256 n)
    {
        uint256 i;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            if (op >= 0x60 && op <= 0x7f) {
                if (op == 0x62 && i + 3 < code.length) {
                    uint24 v = (uint24(uint8(code[i + 1])) << 16)
                        | (uint24(uint8(code[i + 2])) << 8) | uint24(uint8(code[i + 3]));
                    if (v == from) {
                        code[i + 1] = bytes1(uint8(to >> 16));
                        code[i + 2] = bytes1(uint8(to >> 8));
                        code[i + 3] = bytes1(uint8(to));
                        n++;
                    }
                }
                i += 1 + (op - 0x5f);
            } else {
                i++;
            }
        }
    }
}

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
        if (!ForkSelect.selectOrSkip(rpc)) return;
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

    uint24 internal constant ENTRY_FLOOR = 1_600_000;
    uint24 internal constant ADAPTER_FLOOR = 400_000;
    uint24 internal constant TAIL_FLOOR = 150_000;

    /// @dev Replace the vault's runtime code with the same code, gas floors zeroed as asked.
    ///      Storage and immutables are unchanged (the floors are constants, not storage).
    function _zeroFloors(bool entry, bool midPath) internal {
        bytes memory code = address(vault).code;
        if (entry) {
            assertGt(BytecodePatch.patchPush3(code, ENTRY_FLOOR, 0), 0, "entry floor not found");
        }
        if (midPath) {
            assertGt(BytecodePatch.patchPush3(code, ADAPTER_FLOOR, 0), 0, "adapter floor not found");
            assertGt(BytecodePatch.patchPush3(code, TAIL_FLOOR, 0), 0, "tail floor not found");
        }
        vm.etch(address(vault), code);
    }

    function _laterBlock() internal {
        vm.warp(block.timestamp + 2);
        vm.roll(block.number + 1);
    }

    /// @notice The reported defect, reproduced on the unfixed vault (every gas floor zeroed in the
    ///         shipped bytecode): the estimate from the accrued-this-block state fails one block
    ///         later with EMPTY revert data, the status-0-no-reason symptom of core 1482.
    function test_unfixedVault_estimateFailsOneBlockLaterWithEmptyRevert() public {
        _zeroFloors(true, true);
        uint256 shares = vault.balanceOf(user) / 10;
        uint256 est = _estimate(shares);
        emit log_named_uint("unfixed estimate in accrued-this-block state", est);
        _laterBlock();
        (bool ok, bytes memory ret,) = _try(shares, est);
        assertFalse(ok, "unfixed vault passed: the defect did not reproduce");
        assertEq(ret.length, 0, "expected an empty revert (out of gas in a nested call)");
        uint256 need = _estimate(shares);
        emit log_named_uint("unfixed smallest passing limit one block later", need);
        assertGt(need, est, "later block must need more gas");
    }

    /// @notice The margin under the entry floor. With only the entry floor zeroed, the smallest
    ///         passing limit in the later block is set by the mid-path floors (the 400k check
    ///         before the last adapter call or before a pass-2 rounding pull). It must stay well
    ///         under the entry floor, or the mid-path floor would bind and the estimate would move
    ///         with the accrual state again.
    function test_midPathThreshold_laterBlock_staysUnderEntryFloor() public {
        uint256 shares = vault.balanceOf(user) / 10;
        _zeroFloors(true, false);
        _laterBlock();
        uint256 threshold = _estimate(shares);
        vm.recordLogs();
        vm.prank(user);
        vault.redeem(shares, user, user);
        uint256 pulls;
        bytes32 topic = keccak256("Pulled(uint256,address,uint256)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) pulls++;
        }
        emit log_named_uint("mid-path threshold, later block", threshold);
        emit log_named_uint("margin under the 1.6M entry floor", ENTRY_FLOOR - threshold);
        emit log_named_uint("adapter pulls (3 = pass 1 only, more = pass-2 dust sweep)", pulls);
        assertLe(threshold + 150_000, ENTRY_FLOOR, "mid-path floor within 150k of the entry floor");
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

/// @notice Multi-leg estimate-then-include on the fork (core 1482 review). The core stage stack
///         plus two more vaults built by the same DeployVault script, all on the real Aave,
///         Compound and Moonwell venues. Estimate in the accrued-this-block state, include one
///         block later at exactly that limit, through the router and through the gateway.
contract RobotMoneyRouterRedeemGasRootCauseTest is Test {
    address internal constant USDC_BASE = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal agent = makeAddr("agent");
    address internal shareReceiver = makeAddr("shareReceiver");
    address internal user = makeAddr("routerGasUser");

    CoreStages.Stack internal s;
    address[3] internal vaults;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (!ForkSelect.selectOrSkip(rpc)) return;
        s = new CoreStages().run(admin, pauser, agent, shareReceiver, USDC_BASE);
        vaults[0] = address(s.vault);
        for (uint256 i = 1; i < 3; i++) {
            DeployVault.Deployed memory d =
                new DeployVault().runInProcessWithParams(VaultTestParams.params(admin, USDC_BASE));
            vaults[i] = address(d.vault);
            vm.prank(admin);
            s.registry
                .registerVault(
                    vaults[i],
                    VaultRegistry.VaultMetadata({
                        name: "rmUSDC leg", asset: USDC_BASE, registeredAt: 0
                    })
                );
        }
        address[] memory sources = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            sources[i] = vaults[i];
            _fund(user, vaults[i], address(s.router));
            _fund(shareReceiver, vaults[i], address(s.gateway));
        }
        vm.prank(admin);
        s.gateway
            .setPolicy(
                agent,
                IGateway.AgentPolicy({
                    active: true,
                    validUntil: uint64(block.timestamp + 30 days),
                    maxPerPayment: 1_000_000 * 1e6,
                    maxPerWindow: 1_000_000 * 1e6,
                    shareReceiver: shareReceiver,
                    allowedDestinations: new address[](0),
                    assetRecipient: shareReceiver,
                    maxWithdrawPerPayment: type(uint128).max,
                    maxWithdrawPerWindow: type(uint128).max,
                    allowedSourceVaults: sources
                })
            );
        // Accrue every venue at the current timestamp: the estimate then runs in the cheap state.
        vm.prank(user);
        RobotMoneyVault(vaults[0]).redeem(1e12, user, user);
    }

    function _fund(address holder, address vault, address spender) internal {
        deal(USDC_BASE, holder, IERC20(USDC_BASE).balanceOf(holder) + 5_000 * 1e6);
        vm.startPrank(holder);
        IERC20(USDC_BASE).approve(vault, type(uint256).max);
        RobotMoneyVault(vault).deposit(5_000 * 1e6, holder);
        IERC20(vault).approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    function _legs(address holder, uint256 k)
        internal
        view
        returns (address[] memory vs, uint256[] memory sh)
    {
        vs = new address[](k);
        sh = new uint256[](k);
        for (uint256 i = 0; i < k; i++) {
            vs[i] = vaults[i];
            sh[i] = IERC20(vaults[i]).balanceOf(holder) / 10;
        }
    }

    function _call(bool viaGateway, uint256 k, uint256 gasLimit)
        internal
        returns (bool ok, bytes memory ret)
    {
        if (viaGateway) {
            (address[] memory vs, uint256[] memory sh) = _legs(shareReceiver, k);
            vm.prank(agent);
            (ok, ret) = address(s.gateway).call{gas: gasLimit}(
                abi.encodeCall(
                    s.gateway.withdrawFromRouter,
                    (
                        bytes32("gas-order"),
                        vs,
                        sh,
                        new uint256[](k),
                        uint64(block.timestamp + 300),
                        bytes32("gas-idem")
                    )
                )
            );
        } else {
            (address[] memory vs, uint256[] memory sh) = _legs(user, k);
            vm.prank(user);
            (ok, ret) = address(s.router).call{gas: gasLimit}(
                abi.encodeCall(
                    s.router.redeemFor, (user, user, vs, sh, new uint256[](k), type(uint256).max)
                )
            );
        }
    }

    function _estimate(bool viaGateway, uint256 k) internal returns (uint256) {
        uint256 snap = vm.snapshotState();
        uint256 lo = 21_000;
        uint256 hi = 15_000_000;
        while (lo + 1 < hi) {
            uint256 mid = (lo + hi) / 2;
            (bool ok,) = _call(viaGateway, k, mid);
            vm.revertToState(snap);
            snap = vm.snapshotState();
            if (ok) hi = mid;
            else lo = mid;
        }
        return hi;
    }

    function _includeLater(bool viaGateway, uint256 k) internal {
        uint256 est = _estimate(viaGateway, k);
        vm.warp(block.timestamp + 2);
        vm.roll(block.number + 1);
        uint256 g = gasleft();
        (bool ok, bytes memory ret) = _call(viaGateway, k, est);
        uint256 used = g - gasleft();
        emit log_named_uint("legs", k);
        emit log_named_uint("estimate in accrued-this-block state", est);
        emit log_named_uint("gas used one block later", ok ? used : 0);
        emit log_named_uint("return or revert data length", ret.length);
        assertTrue(ok, "multi-leg redeem failed at the estimate one block later");
    }

    function test_router_estimateThenIncludeNextBlock_1leg() public {
        _includeLater(false, 1);
    }

    function test_gateway_withdrawFromRouter_estimateThenIncludeNextBlock_1leg() public {
        _includeLater(true, 1);
    }

    function test_router_estimateThenIncludeNextBlock_2legs() public {
        _includeLater(false, 2);
    }

    function test_router_estimateThenIncludeNextBlock_3legs() public {
        _includeLater(false, 3);
    }

    function test_gateway_withdrawFromRouter_estimateThenIncludeNextBlock_2legs() public {
        _includeLater(true, 2);
    }

    function test_gateway_withdrawFromRouter_estimateThenIncludeNextBlock_3legs() public {
        _includeLater(true, 3);
    }
}
