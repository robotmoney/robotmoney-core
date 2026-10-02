// SPDX-License-Identifier: MIT
// Canonical: docs/plans/one-deployment-scheme.md (robotmoney/devops), core S3 (issue 1485), core 1493
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CoreStages} from "./helpers/CoreStages.sol";

/// @notice Fork regression: the stack the split stages build takes a router deposit and a router
///         withdraw through the gateway against the real Base venues and real USDC. It is the
///         in-process twin of scripts/deploy/assert-core-router.ts. Run through
///         scripts/devnet/run-golden-forge-forks.sh (pinned fixture) or with FORK_RPC_URL set to
///         an archive node. `setUp` reverts when no fork resolves, so it never silent-skips.
contract CoreStagesFork is Test {
    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 internal constant FORK_BLOCK = 52082423;

    address internal admin = makeAddr("admin");
    address internal pauser = makeAddr("pauser");
    address internal agent = makeAddr("agent");
    address internal shareReceiver = makeAddr("shareReceiver");

    CoreStages internal stages;
    CoreStages.Stack internal s;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string("http://127.0.0.1:8545"));
        vm.createSelectFork(rpc);
        if (bytes(vm.envOr("FORK_RPC_URL", string(""))).length != 0) vm.rollFork(FORK_BLOCK);
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
            .withdrawFromRouter(bytes32("wd-order"), vaults, shares, minAssets, deadline, bytes32("wd-idem"));
        assertGe(
            IERC20(BASE_USDC).balanceOf(shareReceiver) - before,
            (amount * 9_999) / 10_000,
            "USDC returned within one bps"
        );
    }
}
