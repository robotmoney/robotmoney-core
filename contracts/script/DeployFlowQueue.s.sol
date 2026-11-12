// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9 (timed flows), §5.9.5 (working defaults);
//            PrototypeHarness.sol (_deployQueue, defaultFlowParams).
// Deploy 4 (owner exception 2026-11-12): the one-vault prototype through the real deploy tool, as a rehearsal.
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";

import {FlowQueue} from "../test/prototype/src/FlowQueue.sol";
import {FlowParams, FlowQueueInit} from "../test/prototype/src/FlowTypes.sol";
import {Roles} from "../test/prototype/src/FundTypes.sol";
import {FundSystemBase} from "./FundSystemBase.sol";

/// @title DeployFlowQueue
/// @notice The `queue` stage (Deploy 4): `FlowQueue` behind its ERC-1967 proxy, after the fund and its assets (its
///         initializer checks `legBandBps` above the fund's largest pool fee). Initialized with the deployer as ADMIN_ROLE
///         until the handover, EMERGENCY_ADDRESS as EMERGENCY_ROLE, KEEPER_ADDRESS as KEEPER_ROLE (settle is keeper
///         first), the USDC / USD feed and the sequencer uptime feed, every flow parameter from the sheet (FLOW_*), and the
///         predicted fund-system timelock as its only upgrade authority. The wiring stage binds the fund's FLOW_ROLE to it.
///
///         Required env vars (no defaults): ADMIN_ADDRESS, FUND_ADDRESS, EMERGENCY_ADDRESS, KEEPER_ADDRESS, the eighteen
///         FLOW_* names below, SAFE_ADDRESS, TIMELOCK_MIN_DELAY, UPGRADE_MODE, DEPLOYMENT_OUT.
contract DeployFlowQueue is FundSystemBase {
    /// @notice Manifest file name the stage driver gives DEPLOYMENT_OUT (scripts/deploy/stage-table.json).
    string public constant MANIFEST_FILE = "queue.json";

    struct Deployed {
        address queue;
        address queueImplementation;
        UpgradeConfig upgrade;
    }

    /// @notice Forge broadcast entrypoint.
    function run() external returns (Deployed memory d) {
        _requireExpectedChain("");
        FlowQueueInit memory p = _readInit();
        d.upgrade = _readUpgradeConfig("");
        _envStringRequired("DEPLOYMENT_OUT");
        require(p.emergency != msg.sender, "EMERGENCY_ADDRESS == deployer EOA");

        vm.startBroadcast();
        d.queueImplementation = address(new FlowQueue());
        d.queue = _deployProxy(
            d.queueImplementation, abi.encodeCall(FlowQueue.initialize, (p, d.upgrade.timelock, d.upgrade.mode))
        );
        vm.stopBroadcast();

        FlowQueue q = FlowQueue(d.queue);
        require(q.hasRole(Roles.ADMIN_ROLE, p.admin), "queue: deployer lacks ADMIN_ROLE");
        require(q.hasRole(Roles.EMERGENCY_ROLE, p.emergency), "queue: emergency key lacks EMERGENCY_ROLE");
        require(q.hasRole(Roles.KEEPER_ROLE, p.keeper), "queue: keeper lacks KEEPER_ROLE");
        require(q.upgradeTimelock() == d.upgrade.timelock, "queue: upgradeTimelock");
        require(keccak256(abi.encode(q.flowParams())) == keccak256(abi.encode(p.params)), "queue: flow params");
        require(_implementationOf(d.queue) == d.queueImplementation, "queue: implementation slot");
        _writeDeploymentJson(d, p);
    }

    function _readInit() internal view returns (FlowQueueInit memory p) {
        p.fund = _envContract("FUND_ADDRESS");
        p.usdc = BASE_USDC;
        p.admin = _envNonZeroAddress("ADMIN_ADDRESS");
        p.emergency = _envNonZeroAddress("EMERGENCY_ADDRESS");
        p.keeper = _envNonZeroAddress("KEEPER_ADDRESS");
        require(p.keeper != p.admin, "KEEPER_ADDRESS == ADMIN_ADDRESS: the keeper is its own key");
        p.usdcFeed = FEED_USDC;
        p.usdcFeedMaxAge = DAY_FEED_MAX_AGE;
        p.sequencerFeed = FEED_SEQUENCER;
        p.params = _readFlowParams();
    }

    /// @dev Every field from the sheet. The queue's initializer holds the hard bounds (FlowTypes.sol) and refuses a value
    ///      outside them; the casts here only refuse a value that does not fit the field.
    function _readFlowParams() internal view returns (FlowParams memory f) {
        f.epochLength = uint32(_envUintMax("FLOW_EPOCH_LENGTH", type(uint32).max));
        f.settleWindow = uint32(_envUintMax("FLOW_SETTLE_WINDOW", type(uint32).max));
        f.minHold = uint32(_envUintMax("FLOW_MIN_HOLD", type(uint32).max));
        f.keeperGrace = uint32(_envUintMax("FLOW_KEEPER_GRACE", type(uint32).max));
        f.maxEpochFlowBps = uint16(_envUintMax("FLOW_MAX_EPOCH_FLOW_BPS", type(uint16).max));
        f.epochFlowFloorUsdc = uint128(_envUintMax("FLOW_EPOCH_FLOOR_USDC", type(uint128).max));
        f.maxSharePriceMoveBps = uint16(_envUintMax("FLOW_MAX_SHARE_PRICE_MOVE_BPS", type(uint16).max));
        f.maxRoll = uint16(_envUintMax("FLOW_MAX_ROLL", type(uint16).max));
        f.minRequestUsdc = uint128(_envUintMax("FLOW_MIN_REQUEST_USDC", type(uint128).max));
        f.maxFreeze = uint32(_envUintMax("FLOW_MAX_FREEZE", type(uint32).max));
        f.slices = uint8(_envUintMax("FLOW_SLICES", type(uint8).max));
        f.quorum = uint8(_envUintMax("FLOW_QUORUM", type(uint8).max));
        f.dispersionBps = uint16(_envUintMax("FLOW_DISPERSION_BPS", type(uint16).max));
        f.refBandBps = uint16(_envUintMax("FLOW_REF_BAND_BPS", type(uint16).max));
        f.legBandBps = uint16(_envUintMax("FLOW_LEG_BAND_BPS", type(uint16).max));
        f.sequencerGrace = uint32(_envUintMax("FLOW_SEQUENCER_GRACE", type(uint32).max));
        f.usdcPegBandBps = uint16(_envUintMax("FLOW_USDC_PEG_BAND_BPS", type(uint16).max));
        f.maxLendRateGrowthBps = uint16(_envUintMax("FLOW_MAX_LEND_RATE_GROWTH_BPS", type(uint16).max));
    }

    function _writeDeploymentJson(Deployed memory d, FlowQueueInit memory p) internal {
        string memory outPath = _envStringRequired("DEPLOYMENT_OUT");
        string memory obj = "queue_deployment";
        vm.serializeUint(obj, "chain_id", block.chainid);
        vm.serializeAddress(obj, "queue", d.queue);
        vm.serializeAddress(obj, "queue_implementation", d.queueImplementation);
        vm.serializeAddress(obj, "fund", p.fund);
        vm.serializeAddress(obj, "keeper", p.keeper);
        vm.serializeAddress(obj, "emergency", p.emergency);
        vm.serializeUint(obj, "min_hold", p.params.minHold);
        vm.serializeUint(obj, "min_request_usdc", p.params.minRequestUsdc);
        vm.serializeUint(obj, "epoch_flow_floor_usdc", p.params.epochFlowFloorUsdc);
        vm.serializeAddress(obj, "upgrade_timelock", d.upgrade.timelock);
        string memory json = vm.serializeString(obj, "upgrade_mode", upgradeModeName(d.upgrade.mode));
        vm.writeJson(json, outPath);
        console2.log("Wrote queue deployment JSON to", outPath);
    }
}
