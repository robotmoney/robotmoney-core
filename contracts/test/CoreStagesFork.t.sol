// SPDX-License-Identifier: MIT
// Canonical: robotmoney/devops issue 53 / core issue 1499, core S3 (issue 1485), core 1493, core 1777 (docs/technical/deposit-gas-1777.md)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CoreStages} from "./helpers/CoreStages.sol";
import {ForkSelect} from "./helpers/ForkSelect.sol";
import {MockVault} from "./helpers/MockVault.sol";
import {RobotMoneyVault} from "../RobotMoneyVault.sol";
import {PortfolioRouter} from "../PortfolioRouter.sol";
import {VaultRegistry} from "../VaultRegistry.sol";

/// @notice Fork regression: the stack the split stages build takes a router deposit and a router
///         withdraw through the gateway against the real Base venues and real USDC. It is the
///         in-process twin of scripts/deploy/assert-core-router.ts. It runs on the Twin chain
///         (a pinned lazy anvil fork of real Base state): start it with scripts/devnet/twin-fork.ts
///         and set FORK_RPC_URL to its URL. With FORK_RPC_URL unset the test skips with a named reason.
contract CoreStagesFork is Test {
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal agent = makeAddr("agent");
    address internal shareReceiver = makeAddr("shareReceiver");

    CoreStages internal stages;
    CoreStages.Stack internal s;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (!ForkSelect.selectOrSkip(rpc)) return;
        stages = new CoreStages();
        s = stages.run(admin, pauser, agent, shareReceiver, BASE_USDC);
    }

    function test_fork_routerDepositAndWithdraw_throughSplitStageGateway() public {
        uint256 amount = 5 * 1e6;
        deal(BASE_USDC, agent, amount);
        uint64 deadline = uint64(block.timestamp + 300);

        vm.startPrank(agent);
        IERC20(BASE_USDC).approve(address(s.gateway), amount);
        s.gateway
            .depositTo(
                bytes32("dep-order"),
                amount,
                deadline,
                bytes32("dep-idem"),
                address(s.router),
                new uint256[](0)
            );
        vm.stopPrank();

        uint256 minted = s.vault.balanceOf(shareReceiver);
        assertGt(minted, 0, "router deposit minted rmUSDC shares");

        vm.prank(shareReceiver);
        s.vault.approve(address(s.gateway), minted);

        address[] memory vaults = new address[](1);
        vaults[0] = address(s.vault);
        uint256[] memory shares = new uint256[](1);
        shares[0] = minted;
        uint256[] memory minAssets = new uint256[](1);

        uint256 before = IERC20(BASE_USDC).balanceOf(shareReceiver);
        vm.prank(agent);
        s.gateway
            .withdrawFromRouter(
                bytes32("wd-order"), vaults, shares, minAssets, deadline, bytes32("wd-idem")
            );
        assertGe(
            IERC20(BASE_USDC).balanceOf(shareReceiver) - before,
            (amount * 9_999) / 10_000,
            "USDC returned within one bps"
        );
    }

    // ---- Deposit gas floors (core 1777) ------------------------------------------------------

    /// @dev Four-leg router like the live one: the real vault plus three mock vaults. The router
    ///      floor is legs * DEPOSIT_GAS_PER_LEG = 4 * 1,700,000 = 6,800,000.
    function _fourLegRouter() internal {
        address[] memory all = new address[](4);
        all[0] = address(s.vault);
        vm.startPrank(admin);
        for (uint256 i = 1; i < 4; i++) {
            MockVault m = new MockVault(BASE_USDC);
            s.registry
                .registerVault(
                    address(m),
                    VaultRegistry.VaultMetadata({
                        name: "mock leg", asset: BASE_USDC, registeredAt: 0
                    })
                );
            all[i] = address(m);
        }
        // Flip each mock eligible together with the default vector so the registry count and the
        // vector length never disagree (VaultRegistry.migrateEligibility).
        for (uint256 n = 2; n <= 4; n++) {
            address[] memory vaults = new address[](n);
            uint256[] memory bps = new uint256[](n);
            for (uint256 i = 0; i < n; i++) {
                vaults[i] = all[i];
                bps[i] = 2000;
            }
            bps[0] = 10_000 - 2000 * (n - 1);
            s.registry.migrateEligibility(all[n - 1], true, vaults, bps);
        }
        vm.stopPrank();
    }

    function test_fork_routerDeposit_below6p8M_revertsInsufficientGasWithTheFloor() public {
        _fourLegRouter();
        address user = makeAddr("user");
        deal(BASE_USDC, user, 1e6);
        vm.startPrank(user);
        IERC20(BASE_USDC).approve(address(s.router), 1e6);
        uint256[] memory noMin = new uint256[](0);
        (bool ok, bytes memory ret) = address(s.router).call{gas: 6_000_000}(
            abi.encodeCall(PortfolioRouter.deposit, (1e6, noMin))
        );
        vm.stopPrank();
        assertFalse(ok, "deposit at 6M gas reverts");
        assertEq(bytes4(ret), PortfolioRouter.InsufficientGas.selector, "typed InsufficientGas");
        (, uint256 required) = abi.decode(_tail(ret), (uint256, uint256));
        assertEq(required, 6_800_000, "router floor is 6.8M for four legs");
    }

    function test_fork_routerDeposit_at8M_succeeds() public {
        _fourLegRouter();
        address user = makeAddr("user");
        deal(BASE_USDC, user, 1e6);
        vm.startPrank(user);
        IERC20(BASE_USDC).approve(address(s.router), 1e6);
        uint256[] memory noMin = new uint256[](0);
        uint256[] memory minted = s.router.deposit{gas: 8_000_000}(1e6, noMin);
        vm.stopPrank();
        assertEq(minted.length, 4, "four legs minted");
        assertGt(s.vault.balanceOf(user), 0, "rmUSDC leg minted shares");
    }

    function test_fork_vaultDeposit_below1p6M_revertsInsufficientGasWithTheFloor() public {
        address user = makeAddr("user");
        deal(BASE_USDC, user, 1e6);
        vm.startPrank(user);
        IERC20(BASE_USDC).approve(address(s.vault), 1e6);
        (bool ok, bytes memory ret) = address(s.vault).call{gas: 1_500_000}(
            abi.encodeCall(RobotMoneyVault.deposit, (1e6, user))
        );
        vm.stopPrank();
        assertFalse(ok, "vault deposit at 1.5M gas reverts");
        assertEq(bytes4(ret), RobotMoneyVault.InsufficientGas.selector, "typed InsufficientGas");
        (, uint256 required) = abi.decode(_tail(ret), (uint256, uint256));
        assertEq(required, 1_600_000, "vault deposit floor is 1.6M");
    }

    function test_fork_vaultDeposit_at2p5M_succeeds() public {
        address user = makeAddr("user");
        deal(BASE_USDC, user, 1e6);
        vm.startPrank(user);
        IERC20(BASE_USDC).approve(address(s.vault), 1e6);
        uint256 shares = s.vault.deposit{gas: 2_500_000}(1e6, user);
        vm.stopPrank();
        assertGt(shares, 0, "rmUSDC shares minted");
    }

    /// @dev The revert data without its 4-byte selector.
    function _tail(bytes memory ret) internal pure returns (bytes memory out) {
        out = new bytes(ret.length - 4);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = ret[i + 4];
        }
    }
}
