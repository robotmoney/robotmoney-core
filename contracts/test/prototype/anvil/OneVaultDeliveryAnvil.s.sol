// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-timed-flows-eng-plan.md E8 (anyone may deliver an unlocked deposit to its owner), E34
//            (settle is keeper-only); scripts/ops/onevault-share-delivery-keeper.sh and its self-test (core issue 2026).
// Experiment prototype only. Deploys the one-vault prototype fund and queue on a plain local anvil chain (no Base fork, no
// upstream RPC): a 6-decimal test USDC, mock feeds, the fund seeded once, and the queue bound to the fund's FLOW_ROLE.
// The self-test reads the addresses from ONEVAULT_ANVIL_OUT. It is never part of a production deploy.
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {GovernedUUPS} from "../../../lib/GovernedUUPS.sol";
import {TestERC20} from "../../helpers/TestERC20.sol";
import {MockAggregator} from "../mocks/MockAggregator.sol";
import {RobotMoneyFund} from "../src/RobotMoneyFund.sol";
import {FlowQueue} from "../src/FlowQueue.sol";
import {FundInitParams} from "../src/FundTypes.sol";
import {
    FlowParams,
    FlowQueueInit,
    DEFAULT_CANCEL_BUFFER,
    DEFAULT_MAX_PAUSE,
    DEFAULT_MATCH_BAND_BPS
} from "../src/FlowTypes.sol";
import {IRobotMoneyFundFull} from "../src/interfaces/IRobotMoneyFund.sol";

/// @title OneVaultDeliveryAnvil
/// @notice Local anvil stack for the share-delivery keeper self-test. Parameters follow PrototypeHarness.
///         Env: KEEPER_ADDRESS (the KEEPER_ROLE holder), EMERGENCY_ADDRESS, ONEVAULT_ANVIL_OUT (a path under ./out/prototype).
contract OneVaultDeliveryAnvil is Script {
    uint256 internal constant TVL_CAP = 10_000_000e6;
    uint256 internal constant PER_DEPOSIT_CAP = 1_000_000e6;
    uint256 internal constant EXIT_FEE_BPS = 10;
    uint256 internal constant MAX_SLIPPAGE_BPS = 200;
    uint256 internal constant NAV_DEVIATION_BPS = 200;
    uint256 internal constant SEED_USDC = 100_000e6;
    uint32 internal constant DAY_FEED_MAX_AGE = 86_700;
    uint256 internal constant TIMELOCK_DELAY = 60;

    struct Stack {
        address deployer;
        address usdc;
        address fund;
        address queue;
        address usdcFeed;
        address sequencerFeed;
        address timelock;
    }

    function run() external {
        address keeper = vm.envAddress("KEEPER_ADDRESS");
        address emergency = vm.envAddress("EMERGENCY_ADDRESS");
        string memory outPath = vm.envString("ONEVAULT_ANVIL_OUT");

        vm.startBroadcast();
        Stack memory a = _deploy(keeper, emergency);
        vm.stopBroadcast();

        _write(a, outPath);
    }

    function _deploy(address keeper, address emergency) internal returns (Stack memory a) {
        a.deployer = msg.sender;

        TestERC20 usdc = new TestERC20();
        a.usdc = address(usdc);

        MockAggregator usdcFeed = new MockAggregator();
        usdcFeed.setRound(8, 1e8, block.timestamp, block.timestamp);
        a.usdcFeed = address(usdcFeed);
        MockAggregator sequencerFeed = new MockAggregator();
        sequencerFeed.setRound(0, 0, block.timestamp - 1 days, block.timestamp);
        a.sequencerFeed = address(sequencerFeed);

        address[] memory proposers = new address[](1);
        proposers[0] = a.deployer;
        address[] memory executors = new address[](1);
        executors[0] = a.deployer;
        a.timelock =
            address(new TimelockController(TIMELOCK_DELAY, proposers, executors, address(0)));

        a.fund = _deployFund(a, emergency);
        a.queue = _deployQueue(a, keeper, emergency);

        IRobotMoneyFundFull(a.fund).bindFlowRole(a.queue);
        usdc.mint(a.deployer, SEED_USDC);
        IERC20(a.usdc).approve(a.fund, SEED_USDC);
        IRobotMoneyFundFull(a.fund).seed(SEED_USDC);
    }

    function _deployFund(Stack memory a, address emergency) internal returns (address) {
        FundInitParams memory fp = FundInitParams({
            usdc: a.usdc,
            name: "Robot Money Fund",
            symbol: "rmFUND",
            tvlCap: TVL_CAP,
            perDepositCap: PER_DEPOSIT_CAP,
            exitFeeBps: EXIT_FEE_BPS,
            feeRecipient: a.deployer,
            maxSlippageBps: MAX_SLIPPAGE_BPS,
            navDeviationGuardBps: NAV_DEVIATION_BPS,
            admin: a.deployer,
            emergency: emergency
        });
        RobotMoneyFund impl = new RobotMoneyFund();
        return address(
            new ERC1967Proxy(
                address(impl),
                abi.encodeCall(
                    RobotMoneyFund.initialize,
                    (fp, a.timelock, GovernedUUPS.UpgradeMode.Upgradeable)
                )
            )
        );
    }

    function _deployQueue(Stack memory a, address keeper, address emergency)
        internal
        returns (address)
    {
        FlowQueueInit memory qp = FlowQueueInit({
            fund: a.fund,
            usdc: a.usdc,
            admin: a.deployer,
            emergency: emergency,
            keeper: keeper,
            usdcFeed: a.usdcFeed,
            usdcFeedMaxAge: DAY_FEED_MAX_AGE,
            sequencerFeed: a.sequencerFeed,
            params: _flowParams()
        });
        FlowQueue impl = new FlowQueue();
        return address(
            new ERC1967Proxy(
                address(impl),
                abi.encodeCall(
                    FlowQueue.initialize, (qp, a.timelock, GovernedUUPS.UpgradeMode.Upgradeable)
                )
            )
        );
    }

    function _write(Stack memory a, string memory outPath) internal {
        string memory body = string.concat(
            "USDC=",
            vm.toString(a.usdc),
            "\n",
            "FUND=",
            vm.toString(a.fund),
            "\n",
            "QUEUE=",
            vm.toString(a.queue),
            "\n"
        );
        body = string.concat(
            body,
            "USDC_FEED=",
            vm.toString(a.usdcFeed),
            "\n",
            "SEQUENCER_FEED=",
            vm.toString(a.sequencerFeed),
            "\n",
            "TIMELOCK=",
            vm.toString(a.timelock),
            "\n",
            "DEPLOYER=",
            vm.toString(a.deployer),
            "\n"
        );
        vm.writeFile(outPath, body);
    }

    /// @dev The §5.9.5 working defaults, as PrototypeHarness.defaultFlowParams.
    function _flowParams() internal pure returns (FlowParams memory) {
        return FlowParams({
            epochLength: 6 hours,
            settleWindow: 1 hours,
            minHold: 1 hours,
            keeperGrace: 6 hours,
            maxEpochFlowBps: 500,
            epochFlowFloorUsdc: 250_000e6,
            maxSharePriceMoveBps: 1_000,
            maxRoll: 8,
            minRequestUsdc: 100e6,
            maxFreeze: 7 days,
            slices: 12,
            quorum: 9,
            dispersionBps: 100,
            refBandBps: 90,
            legBandBps: 100,
            sequencerGrace: 1 hours,
            usdcPegBandBps: 50,
            maxLendRateGrowthBps: 10,
            cancelBuffer: DEFAULT_CANCEL_BUFFER,
            maxPause: DEFAULT_MAX_PAUSE,
            matchBandBps: DEFAULT_MATCH_BAND_BPS
        });
    }
}
