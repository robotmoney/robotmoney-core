// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0020-in-place-upgrades-run-a-one-time-migration.md (the 0.10.0 migrations);
//            docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md (a reinitializer runs inside `upgradeToAndCall`)
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ForkSelect} from "../helpers/ForkSelect.sol";
import {GovernedUpgrade} from "../../lib/GovernedUUPS.sol";
import {FlowQueue} from "../../FlowQueue.sol";
import {RobotMoneyFund} from "../../RobotMoneyFund.sol";
import {Rebalancer} from "../../Rebalancer.sol";
import {RebalanceGovernance} from "../../RebalanceGovernance.sol";
import {ConsensusRecommendationReceipt} from "../../ConsensusRecommendationReceipt.sol";
import {
    UniswapV3ExactOutSwapAdapterUpgradeable
} from "../../adapters/UniswapV3ExactOutSwapAdapterUpgradeable.sol";

interface IUpgradeable {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
    function upgradeTimelock() external view returns (address);
}

/// @title UpgradeMigrationV0100ForkTest
/// @notice The 0.10.0 in-place upgrade of Deploy 4 on real Base 8453 state: the Twin fork (FORK_RPC_URL, chain 918453)
///         pinned by the run (suite-05 job forge-upgrade-fork). Every proxy is upgraded from the fund timelock in
///         release order (Rebalancer, fund with empty data, queue, governance, receipt, swap adapter), each with
///         `migrateV0100()` but the fund, which has none (EIP-170 headroom). The test asserts version 3, the
///         second-call revert, and that balances, supply and the queue's records are unchanged. Nothing is sent to a
///         live chain: the upgrades run in forge's local copy of the fork.
contract UpgradeMigrationV0100ForkTest is Test {
    // Deploy 4 on Base 8453 (run record ~/tmp/deploy4-v090-8453/manifests, read on chain 2026-11-24).
    address internal constant TIMELOCK = 0x592899400A6c58cb1382D3B7e96931FA43F55c30;
    address internal constant FUND = 0xb2c17a384b6fc03d96D77f39E016aD7b9E34af2B;
    address internal constant QUEUE = 0xbB414D1536Fef6c240e984a24F777ca0958e5439;
    address internal constant REBALANCER = 0x13c1169Da48Bb06E327286971eB3E56c0411A65B;
    address internal constant GOVERNANCE = 0xCD368b5276A4CAdf710C220348f64487F240a192;
    address internal constant RECEIPT = 0xbf756a0B5CBD2f2244c34329e79f9a13d3b0750F;
    address internal constant SWAP_ADAPTER = 0xc0BdeD669301EC505475322C9Ad6DBbA37d120EB;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    function test_deploy4UpgradesTo0100InReleaseOrder() public {
        if (!ForkSelect.selectOrSkip(vm.envOr("FORK_RPC_URL", string("")))) return;
        address[6] memory proxies = [REBALANCER, FUND, QUEUE, GOVERNANCE, RECEIPT, SWAP_ADAPTER];
        for (uint256 k; k < proxies.length; ++k) {
            assertEq(
                IUpgradeable(proxies[k]).upgradeTimelock(), TIMELOCK, "the fund timelock upgrades"
            );
        }
        // Already migrated on chain (after the 0.10.0 release): only the one-shot property is left to prove.
        bool done = _version(QUEUE) >= 3;

        address router = address(UniswapV3ExactOutSwapAdapterUpgradeable(SWAP_ADAPTER).ROUTER());
        address[6] memory impls = [
            address(new Rebalancer()),
            address(new RobotMoneyFund()),
            address(new FlowQueue()),
            address(new RebalanceGovernance()),
            address(new ConsensusRecommendationReceipt()),
            address(new UniswapV3ExactOutSwapAdapterUpgradeable(router))
        ];
        bytes memory mig = abi.encodeWithSignature("migrateV0100()");
        bytes32 before = _snapshot();

        vm.startPrank(TIMELOCK);
        for (uint256 k; k < proxies.length; ++k) {
            bool isFund = proxies[k] == FUND;
            if (done && !isFund) {
                vm.expectRevert(GovernedUpgrade.InvalidInitialization.selector);
                IUpgradeable(proxies[k]).upgradeToAndCall(impls[k], mig);
                continue;
            }
            IUpgradeable(proxies[k]).upgradeToAndCall(impls[k], isFund ? bytes("") : mig);
            if (isFund) {
                assertEq(_version(FUND), 2, "the fund keeps version 2");
                (bool ok,) = FUND.call(mig);
                assertFalse(ok, "the fund has no migrateV0100");
                continue;
            }
            assertEq(_version(proxies[k]), 3, "version 3");
            vm.expectRevert(GovernedUpgrade.InvalidInitialization.selector);
            IUpgradeable(proxies[k]).upgradeToAndCall(impls[k], mig);
        }
        vm.stopPrank();

        assertEq(_snapshot(), before, "balances, supply and the queue's records are unchanged");
        // The queue's invariant reads still answer on the new code.
        FlowQueue(QUEUE).books();
    }

    function _snapshot() internal view returns (bytes32 h) {
        FlowQueue q = FlowQueue(QUEUE);
        h = keccak256(
            abi.encode(
                IERC20(USDC).balanceOf(QUEUE),
                IERC20(USDC).balanceOf(FUND),
                IERC20(FUND).totalSupply(),
                IERC20(FUND).balanceOf(QUEUE),
                q.books()
            )
        );
        for (uint256 id = 1; id <= q.requestCount(); ++id) {
            h = keccak256(abi.encode(h, q.getRequest(id)));
        }
        for (uint256 id = 1; id <= q.settlementCount(); ++id) {
            h = keccak256(abi.encode(h, q.getSettlement(id)));
        }
        for (uint256 id = 1; id <= q.claimCount(); ++id) {
            h = keccak256(abi.encode(h, q.getClaim(id)));
        }
    }

    function _version(address proxy) internal view returns (uint64) {
        return uint64(uint256(vm.load(proxy, GovernedUpgrade.INITIALIZABLE_STORAGE)));
    }
}
