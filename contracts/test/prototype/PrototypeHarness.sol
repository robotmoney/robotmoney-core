// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4 (one vault), §4.5 (asset admission), §5.1 (receipt to
//            plan), §5.3 (step), §5.4 (who calls), §5.6 (parameters), §5.9 (timed flows: §5.9.2 epoch, §5.9.3
//            settlement, §5.9.5 defaults), §6 (contract changes), §7 (RB-1, RB-3, RB-8, RB-10 to RB-22);
//            docs/technical/one-vault-timed-flows-eng-plan.md E1 to E3, E8, E10, E13 to E16, E20
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {BaseFixture} from "./BaseFixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {GovernedUUPS} from "../../lib/GovernedUUPS.sol";
import {TwapTickMath} from "../../lib/TwapTickMath.sol";
import {ConsensusRecommendationReceipt} from "../../ConsensusRecommendationReceipt.sol";

import {RobotMoneyFund} from "./src/RobotMoneyFund.sol";
import {Rebalancer} from "./src/Rebalancer.sol";
import {RebalanceGovernance} from "./src/RebalanceGovernance.sol";
import {FlowQueue} from "./src/FlowQueue.sol";
import {AaveV3RateAdapter} from "./src/adapters/AaveV3RateAdapter.sol";
import {CompoundV3RateAdapter} from "./src/adapters/CompoundV3RateAdapter.sol";
import {MorphoRateAdapter} from "./src/adapters/MorphoRateAdapter.sol";
import {UniswapV3ExactOutSwapAdapter} from "./src/adapters/UniswapV3ExactOutSwapAdapter.sol";
import {IRobotMoneyFundFull} from "./src/interfaces/IRobotMoneyFund.sol";
import {
    AssetConfig,
    AssetKind,
    AssetStepParams,
    FundInitParams,
    PlanParams,
    PlanStatus,
    SkipReason,
    StepParams,
    Venue,
    Roles,
    BPS
} from "./src/FundTypes.sol";
import {Claim, FlowParams, FlowQueueInit, Request, RequestKind, SettleCheck} from "./src/FlowTypes.sol";
import {PlanMath} from "./src/PlanMath.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";

interface IHarnessSwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256);
}

interface IHarnessV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

/// @title PrototypeHarness
/// @notice One-vault experiment, step 3d (timed flows). Deploys the full prototype on the real Base fixture state and
///         gives every live prototype test the same helpers. Production wiring, in miniature:
///
///         - `timelock`: an OpenZeppelin `TimelockController` with a small non-zero delay. This test contract is
///           its only proposer and executor (the Safe stand-in). It ends up holding `ADMIN_ROLE` on the fund, the
///           queue, the rebalancer and the governance contract, `TARGET_SETTER_ROLE` on governance, the receipt
///           register's `ADMIN_ROLE` (INV-3), and the upgrade authority of every proxy (RB-1).
///         - `receipts`: the real `ConsensusRecommendationReceipt` behind its ERC-1967 proxy (RB-8).
///         - `fund`: `RobotMoneyFund` behind its proxy, with the §4.5 asset list: three lending venues (Aave V3,
///           Moonwell through the Morpho adapter, Compound V3) through the step 3d rate adapter copies (E15, check
///           5), and wETH and cbBTC on their Uniswap V3 fee-500 USDC pools through the exact-output swap adapter copy
///           (E3, checks 8 and 9), each with its real Chainlink feed address and `maxFeedAge` (E15, E16). deSPXA is
///           not listed (§4.5 rule 1: no live feed).
///         - `queue`: the `FlowQueue` behind its proxy (E1), holding the fund's `FLOW_ROLE` (bound once), with the
///           §5.9.5 defaults, the USDC / USD feed and the sequencer uptime feed. `keeper` holds its `KEEPER_ROLE`,
///           `emergency` its `EMERGENCY_ROLE`.
///         - The fund is seeded once (E14) with `SEED_USDC`, minted to the fund itself.
///         - `rebalancer` (fund `REBALANCER_ROLE`) and `governance` (fund `GOVERNANCE_ROLE`) as in step 3c.
///
///         Feeds. Each real feed address gets a `MockAggregator` (vm.etch) before any asset is added, because
///         `addAsset` refuses an unhealthy feed (E15). The basket feeds start at the pool's own price at the pin
///         (`slot0`), which is what the slice-median TWAP of check 3 extrapolates to once the window lies after the
///         pin, so check 4 (TWAP within `refBandBps` of the feed) passes in a quiet market. `refreshFeeds` re-stamps
///         every feed at `block.timestamp` with its stored price; `setFeedPrice` changes a stored price.
///
///         Compound V3. The replay fixture lacks Comet's extension delegate, so `CompoundV3RateAdapter.ratePerUnit`
///         reverts in replay and `addAsset` refuses it (requests.md, queue and fund-extras entries). The harness
///         lists Compound only when that account has code (`cometListed`): on the recorder's fork and in replay
///         after the re-record it is listed; in replay before it, the fund runs on four assets. Compound is the LAST
///         asset (`IDX_COMET = 4`) so the other indices never move. Vectors are always five wide; a vector must
///         give Compound 0 while it is not listed.
///
///         Fixture coverage. The fund and the adapters are created from the same deployer nonces as in the step 3c
///         harness the fixture was recorded with (timelock 1, receipts 2-3, fund 4-5, the four adapters 6-9), so each
///         venue slot keyed by the fund or an adapter address is the recorded one. Forge counts every top-level call
///         of this contract in its nonce, so nothing may call out between those creations. The queue is new: its
///         slots (its USDC balance, for one) miss until the re-record.
///
///         Tests never hard-code market prices or amounts out: they assert relationships, because the fixture pin
///         moves at re-record time.
abstract contract PrototypeHarness is BaseFixture {
    using Math for uint256;

    // ─── Real Base addresses (third-party-addresses.json, config/rwa-assets.json) ──────────────────────

    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address internal constant WETH_POOL = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    address internal constant CBBTC_POOL = 0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef;
    address internal constant ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant AAVE_A_USDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;
    address internal constant COMET = 0xb125E6687d4313864e53df431d5425969c15Eb2F;
    /// @dev Comet's extension delegate (`COMET.extensionDelegate()` at the pin). `totalsBasic()` lives there.
    address internal constant COMET_EXTENSION = 0x0d4Bd55A755134950027cE1F43190A354e648e20;
    address internal constant MOONWELL = 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca;
    uint24 internal constant POOL_FEE = 500;

    // ─── Chainlink on Base (scaffold plan §4, each answered `description()` at the pin) ─────────────────

    address internal constant FEED_ETH = 0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70;
    address internal constant FEED_CBBTC = 0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D;
    address internal constant FEED_USDC = 0x7e860098F58bBFC8648a4311b374B1D669a2bc6B;
    address internal constant FEED_SEQUENCER = 0xBCF85224fc0756B9Fa45aA7892530B47e10b6433;
    /// @dev `maxFeedAge` = heartbeat + 5 minutes (§5.9.5): ETH / USD 20 min, cbBTC / USD and USDC / USD 24 h.
    uint32 internal constant ETH_FEED_MAX_AGE = 1_500;
    uint32 internal constant DAY_FEED_MAX_AGE = 86_700;

    // ─── Fund asset indices (stable for the fund's life, §4.1). Compound is last: see the contract note ──

    uint256 internal constant IDX_AAVE = 0;
    uint256 internal constant IDX_MOONWELL = 1;
    uint256 internal constant IDX_WETH = 2;
    uint256 internal constant IDX_CBBTC = 3;
    uint256 internal constant IDX_COMET = 4;
    /// @dev Width of every target vector. `fund.assetCount()` is 5 when Compound is listed, else 4.
    uint256 internal constant N_ASSETS = 5;

    // ─── Receipt bucket labels (§4.1: off-chain only, never on chain) ─────────────────────────────────

    uint256 internal constant BUCKET_AGENT = 0;
    uint256 internal constant BUCKET_STABLE = 1;
    uint256 internal constant BUCKET_PROTOCOL = 2;
    uint256 internal constant BUCKET_RWA = 3;
    uint256 internal constant N_BUCKETS = 4;

    // ─── Parameters (§5.6 suggested starts; fund guards as the vault families deploy them) ────────────

    /// @dev Small but non-zero, so every governed call really waits in the timelock.
    uint256 internal constant TIMELOCK_DELAY = 60;
    uint32 internal constant TWAP_WINDOW = 1_800;
    uint256 internal constant TVL_CAP = 10_000_000e6;
    uint256 internal constant PER_DEPOSIT_CAP = 1_000_000e6;
    uint256 internal constant EXIT_FEE_BPS = 10;
    /// @dev Swap floor of the rebalance step and the emergency unwind. Above every pool fee (5 bps).
    uint256 internal constant MAX_SLIPPAGE_BPS = 200;
    /// @dev ORA-4 band. Above every pool fee.
    uint256 internal constant NAV_DEVIATION_BPS = 200;
    /// @dev ADP ramp control: no single lending venue above 60% of NAV.
    uint16 internal constant LENDING_CAP_BPS = 6_000;
    /// @dev E14: the seed, minted to the fund itself (at least `minSeedUsdc`, 10 000 USDC).
    uint256 internal constant SEED_USDC = 100_000e6;

    uint64 internal constant PLAN_DURATION = 7 days;
    uint16 internal constant COST_BUDGET_BPS = 30;
    uint32 internal constant KEEPER_GRACE = 6 hours;
    uint32 internal constant MAX_OVERRUN = 7 days;
    uint16 internal constant MAX_STEP_COST_BPS = 50;
    uint16 internal constant TOLERANCE_BPS = 50;
    uint128 internal constant MIN_STEP_USDC = 100e6;

    uint128 internal constant LENDING_MAX_STEP_USDC = 500_000e6;
    uint128 internal constant MAJOR_MAX_STEP_USDC = 50_000e6;
    /// @dev Per-step slippage room above the pool fee for wETH and cbBTC (fee 5 bps → 50 bps floor).
    uint256 internal constant MAJOR_SLIPPAGE_OVER_FEE_BPS = 45;

    /// @dev `settle(maxRequests, ·)` of the helpers: the queue's own per-call ceiling (FlowSettleLib).
    uint256 internal constant SETTLE_MAX_REQUESTS = 256;

    // ─── Actors ────────────────────────────────────────────────────────────────────────────────────────

    address internal keeper = makeAddr("keeper");
    address internal submitter = makeAddr("receiptSubmitter");
    address internal emergency = makeAddr("emergency");
    address internal feeRecipient = makeAddr("feeRecipient");

    // ─── Deployed system ───────────────────────────────────────────────────────────────────────────────

    TimelockController internal timelock;
    ConsensusRecommendationReceipt internal receipts;
    IRobotMoneyFundFull internal fund;
    Rebalancer internal rebalancer;
    RebalanceGovernance internal governance;
    FlowQueue internal queue;

    AaveV3RateAdapter internal aaveAdapter;
    CompoundV3RateAdapter internal cometAdapter;
    MorphoRateAdapter internal moonwellAdapter;
    UniswapV3ExactOutSwapAdapter internal swapAdapter;

    /// @dev Compound V3 is in the fund's asset list (see the contract note). Set in `setUp`.
    bool internal cometListed;

    /// @dev Stored price of each feed (8 decimals) that `refreshFeeds` writes. The sequencer's `startedAt` is fixed
    ///      at setUp (up for a day by then), so it stays past `sequencerGrace` whatever the test warps.
    mapping(address feed => int256 price8) internal feedPrice8;
    uint256 internal sequencerUpSince;

    /// @dev Canonical payload string of each receipt `recordReceipt` made (its digest is keccak256 of it).
    mapping(bytes32 receiptId => string payload) internal receiptPayload;

    uint256 private _receiptNonce;
    uint256 private _saltNonce;
    uint64 private _lastRecordedAt;

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Deploy
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    function setUp() public virtual override {
        super.setUp();
        vm.label(USDC, "USDC");
        vm.label(WETH, "WETH");
        vm.label(CBBTC, "cbBTC");
        vm.label(FEED_ETH, "feedEthUsd");
        vm.label(FEED_CBBTC, "feedCbbtcUsd");
        vm.label(FEED_USDC, "feedUsdcUsd");
        vm.label(FEED_SEQUENCER, "feedSequencer");
        cometListed = COMET_EXTENSION.code.length != 0;

        // The creation order fixes the deployer nonces; see the contract note before reordering.
        _deployTimelock();
        _deployReceipts();
        _deployFund();
        _deployAdapters();
        _placeFeeds();
        _addAssets();
        _deployRebalancer();
        _deployGovernance();
        _deployQueue();
        _wireRoles();
        _seed();
        _beforeHandover();
        _handOverToTimelock();
    }

    /// @dev Runs while this contract is still every deployer admin, right before the timelock handover. No-op by
    ///      default.
    function _beforeHandover() internal virtual {}

    /// @dev Whether setUp binds the fund's FLOW_ROLE to the queue. A test that plays the queue itself (fund-core's
    ///      unit test) returns false and binds itself.
    function _bindQueueAtSetUp() internal virtual returns (bool) {
        return true;
    }

    /// @dev USDC the deployer admin seeds the fund with at setUp (E14). 0: no seed (a test of `seed` itself).
    function _seedUsdc() internal virtual returns (uint256) {
        return SEED_USDC;
    }

    function _deployTimelock() private {
        address[] memory proposers = new address[](1);
        proposers[0] = address(this);
        address[] memory executors = new address[](1);
        executors[0] = address(this);
        timelock = new TimelockController(TIMELOCK_DELAY, proposers, executors, address(0));
        vm.label(address(timelock), "timelock");
    }

    /// @dev The receipt register's ADMIN_ROLE is the timelock's alone from initialization (INV-3).
    function _deployReceipts() private {
        address impl = address(new ConsensusRecommendationReceipt());
        receipts = ConsensusRecommendationReceipt(
            _proxy(
                impl,
                abi.encodeCall(
                    ConsensusRecommendationReceipt.initialize,
                    (address(timelock), address(timelock), GovernedUUPS.UpgradeMode.Upgradeable)
                )
            )
        );
        vm.label(address(receipts), "receipts");
    }

    /// @dev This contract is the deployer admin until `_handOverToTimelock`, as the stage scripts are.
    function _deployFund() private {
        FundInitParams memory p = FundInitParams({
            usdc: USDC,
            name: "Robot Money Fund",
            symbol: "rmFUND",
            tvlCap: TVL_CAP,
            perDepositCap: PER_DEPOSIT_CAP,
            exitFeeBps: EXIT_FEE_BPS,
            feeRecipient: feeRecipient,
            maxSlippageBps: MAX_SLIPPAGE_BPS,
            navDeviationGuardBps: NAV_DEVIATION_BPS,
            admin: address(this),
            emergency: emergency
        });
        address impl = address(new RobotMoneyFund());
        fund = IRobotMoneyFundFull(
            _proxy(
                impl,
                abi.encodeCall(
                    RobotMoneyFund.initialize, (p, address(timelock), GovernedUUPS.UpgradeMode.Upgradeable)
                )
            )
        );
        vm.label(address(fund), "fund");
    }

    /// @dev A mock aggregator at each real feed address (E16), before any asset is added (E15 refuses an unhealthy
    ///      feed). The basket feeds start at the pool's own price at the pin; USDC at 1; the sequencer up for a day.
    ///      `vm.etch` of the runtime code uses no deployer nonce.
    function _placeFeeds() private {
        bytes memory code = type(MockAggregator).runtimeCode;
        vm.etch(FEED_ETH, code);
        vm.etch(FEED_CBBTC, code);
        vm.etch(FEED_USDC, code);
        vm.etch(FEED_SEQUENCER, code);
        feedPrice8[FEED_ETH] = int256(poolPrice8(WETH_POOL, WETH));
        feedPrice8[FEED_CBBTC] = int256(poolPrice8(CBBTC_POOL, CBBTC));
        feedPrice8[FEED_USDC] = 1e8;
        sequencerUpSince = block.timestamp - 1 days;
        refreshFeeds();
    }

    /// @dev The four adapters, right after the fund and before any call from this contract (forge counts each
    ///      top-level call in the deployer nonce), in the step 3c order (aave, comet, moonwell, swap), so they get
    ///      the step 3c addresses (nonces 6 to 9) the fixture's venue slots are keyed by. Compound's adapter is
    ///      created even when it is not listed, to keep that order.
    function _deployAdapters() private {
        aaveAdapter = new AaveV3RateAdapter(AAVE_POOL, USDC, AAVE_A_USDC, address(fund));
        cometAdapter = new CompoundV3RateAdapter(COMET, USDC, address(fund));
        moonwellAdapter = new MorphoRateAdapter(MOONWELL, USDC, address(fund));
        swapAdapter = new UniswapV3ExactOutSwapAdapter(ROUTER);
        vm.label(address(aaveAdapter), "aaveAdapter");
        vm.label(address(cometAdapter), "cometAdapter");
        vm.label(address(moonwellAdapter), "moonwellAdapter");
        vm.label(address(swapAdapter), "swapAdapter");
    }

    /// @dev §4.5: three lending venues and two basket tokens, each feed already healthy (`_placeFeeds`).
    function _addAssets() private {
        fund.setAdapterCodeHashAllowed(address(aaveAdapter).codehash, true);
        fund.setAdapterCodeHashAllowed(address(moonwellAdapter).codehash, true);
        fund.setAdapterCodeHashAllowed(address(swapAdapter).codehash, true);

        assertEq(fund.addAsset(lendingConfig(address(aaveAdapter))), IDX_AAVE, "aave index");
        assertEq(fund.addAsset(lendingConfig(address(moonwellAdapter))), IDX_MOONWELL, "moonwell index");
        assertEq(fund.addAsset(basketConfig(WETH, WETH_POOL, FEED_ETH, ETH_FEED_MAX_AGE)), IDX_WETH, "weth index");
        assertEq(
            fund.addAsset(basketConfig(CBBTC, CBBTC_POOL, FEED_CBBTC, DAY_FEED_MAX_AGE)), IDX_CBBTC, "cbbtc index"
        );
        if (cometListed) {
            fund.setAdapterCodeHashAllowed(address(cometAdapter).codehash, true);
            assertEq(fund.addAsset(lendingConfig(address(cometAdapter))), IDX_COMET, "comet index");
        }
    }

    /// @notice A lending asset config (E15: a rate adapter, no feed, `maxFeedAge` 0).
    function lendingConfig(address adapter) internal pure returns (AssetConfig memory) {
        return AssetConfig({
            kind: AssetKind.Lending,
            active: true,
            capBps: LENDING_CAP_BPS,
            adapter: adapter,
            token: address(0),
            pool: address(0),
            poolFee: 0,
            twapWindow: 0,
            venue: Venue.V3,
            feed: address(0),
            maxFeedAge: 0
        });
    }

    /// @notice A basket asset config on the exact-output swap adapter copy, with its feed and `maxFeedAge` (E15).
    function basketConfig(address token, address pool, address feed, uint32 maxFeedAge)
        internal
        view
        returns (AssetConfig memory)
    {
        return AssetConfig({
            kind: AssetKind.Basket,
            active: true,
            capBps: 0,
            adapter: address(swapAdapter),
            token: token,
            pool: pool,
            poolFee: POOL_FEE,
            twapWindow: TWAP_WINDOW,
            venue: Venue.V3,
            feed: feed,
            maxFeedAge: maxFeedAge
        });
    }

    /// @dev §5.6 suggested starts. `stepInterval` is the longest TWAP window (or 30 min). Per-asset slippage is
    ///      pool-fee aware: wETH and cbBTC sit `MAJOR_SLIPPAGE_OVER_FEE_BPS` above their fee; lending withdrawals
    ///      are 1:1 so 0.
    function _deployRebalancer() private {
        uint32 interval = uint32(Math.max(30 minutes, fund.maxTwapWindow()));
        StepParams memory sp = StepParams({
            stepInterval: interval,
            keeperGrace: KEEPER_GRACE,
            maxOverrun: MAX_OVERRUN,
            maxStepCostBps: MAX_STEP_COST_BPS,
            toleranceBps: TOLERANCE_BPS,
            minStepUsdc: MIN_STEP_USDC
        });
        address impl = address(new Rebalancer());
        rebalancer = Rebalancer(
            _proxy(
                impl,
                abi.encodeCall(
                    Rebalancer.initialize,
                    (address(fund), address(this), keeper, sp, address(timelock), GovernedUUPS.UpgradeMode.Upgradeable)
                )
            )
        );
        vm.label(address(rebalancer), "rebalancer");

        uint256 ceiling = fund.maxSlippageBps();
        rebalancer.setAssetStepParams(IDX_AAVE, AssetStepParams(LENDING_MAX_STEP_USDC, 0));
        rebalancer.setAssetStepParams(IDX_MOONWELL, AssetStepParams(LENDING_MAX_STEP_USDC, 0));
        if (cometListed) rebalancer.setAssetStepParams(IDX_COMET, AssetStepParams(LENDING_MAX_STEP_USDC, 0));
        uint16 majorSlip = uint16(Math.min(fund.poolFeeBps(IDX_WETH) + MAJOR_SLIPPAGE_OVER_FEE_BPS, ceiling));
        rebalancer.setAssetStepParams(IDX_WETH, AssetStepParams(MAJOR_MAX_STEP_USDC, majorSlip));
        majorSlip = uint16(Math.min(fund.poolFeeBps(IDX_CBBTC) + MAJOR_SLIPPAGE_OVER_FEE_BPS, ceiling));
        rebalancer.setAssetStepParams(IDX_CBBTC, AssetStepParams(MAJOR_MAX_STEP_USDC, majorSlip));
    }

    function _deployGovernance() private {
        address impl = address(new RebalanceGovernance());
        governance = RebalanceGovernance(
            _proxy(
                impl,
                abi.encodeCall(
                    RebalanceGovernance.initialize,
                    (
                        address(fund),
                        address(receipts),
                        address(this),
                        PlanParams(PLAN_DURATION, COST_BUDGET_BPS),
                        address(timelock),
                        GovernedUUPS.UpgradeMode.Upgradeable
                    )
                )
            )
        );
        vm.label(address(governance), "governance");
    }

    /// @dev The queue after the fund and its assets: `initialize` checks `legBandBps` above `fund.maxPoolFeeBps()`.
    function _deployQueue() private {
        FlowQueueInit memory p = FlowQueueInit({
            fund: address(fund),
            usdc: USDC,
            admin: address(this),
            emergency: emergency,
            keeper: keeper,
            usdcFeed: FEED_USDC,
            usdcFeedMaxAge: DAY_FEED_MAX_AGE,
            sequencerFeed: FEED_SEQUENCER,
            params: defaultFlowParams()
        });
        address impl = address(new FlowQueue());
        queue = FlowQueue(
            _proxy(impl, abi.encodeCall(FlowQueue.initialize, (p, address(timelock), GovernedUUPS.UpgradeMode.Upgradeable)))
        );
        vm.label(address(queue), "queue");
    }

    /// @notice The §5.9.5 working defaults (FlowParams holds all but `poolShareBps`, `minSeedUsdc` and the feeds'
    ///         ages). The fund's in-kind allowance defaults (500 bps, 250 000 USDC, 6 h) equal the cap values here
    ///         (coordinator ruling 6), so the harness does not set it.
    function defaultFlowParams() internal pure returns (FlowParams memory) {
        return FlowParams({
            epochLength: 6 hours,
            settleWindow: 1 hours,
            minHold: 24 hours,
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
            maxLendRateGrowthBps: 10
        });
    }

    /// @dev Fund plan roles and FLOW_ROLE bound once by the deployer admin (self-administered afterwards, RB-1, E1);
    ///      receipt roles through the timelock (the register's only admin).
    function _wireRoles() private {
        RobotMoneyFund f = RobotMoneyFund(address(fund));
        f.bindRebalanceRoles(address(governance), address(rebalancer));
        if (_bindQueueAtSetUp()) f.bindFlowRole(address(queue));

        address[] memory targets = new address[](2);
        uint256[] memory values = new uint256[](2);
        bytes[] memory payloads = new bytes[](2);
        targets[0] = address(receipts);
        targets[1] = address(receipts);
        payloads[0] = abi.encodeCall(receipts.grantRole, (receipts.RECEIPT_SUBMITTER_ROLE(), submitter));
        payloads[1] = abi.encodeCall(receipts.grantRole, (receipts.RECEIPT_RELEASER_ROLE(), address(governance)));
        timelockExecuteBatch(targets, values, payloads);
    }

    /// @dev E14: the deployer admin seeds once, at zero supply. The seed stays idle until a plan moves it.
    function _seed() private {
        uint256 usdc = _seedUsdc();
        if (usdc == 0) return;
        fundUsdc(address(this), usdc);
        IERC20(USDC).approve(address(fund), usdc);
        fund.seed(usdc);
    }

    /// @dev Stage-script handover: the timelock gains every admin role, then the deployer renounces its own.
    function _handOverToTimelock() private {
        RobotMoneyFund f = RobotMoneyFund(address(fund));
        f.grantRole(Roles.ADMIN_ROLE, address(timelock));
        f.renounceRole(Roles.ADMIN_ROLE, address(this));

        rebalancer.grantRole(Roles.ADMIN_ROLE, address(timelock));
        rebalancer.renounceRole(Roles.ADMIN_ROLE, address(this));

        governance.grantRole(Roles.ADMIN_ROLE, address(timelock));
        governance.grantRole(Roles.TARGET_SETTER_ROLE, address(timelock));
        governance.renounceRole(Roles.ADMIN_ROLE, address(this));
        governance.renounceRole(Roles.TARGET_SETTER_ROLE, address(this));

        queue.grantRole(Roles.ADMIN_ROLE, address(timelock));
        queue.renounceRole(Roles.ADMIN_ROLE, address(this));
    }

    function _proxy(address impl, bytes memory initData) private returns (address) {
        return address(new ERC1967Proxy(impl, initData));
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers: feeds (E16; plan §9 "time in replay")
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Re-stamp every mock feed at `block.timestamp` with its stored price (USDC at its stored peg, the
    ///         sequencer up since setUp). Call after a warp: the ETH feed's `maxFeedAge` is 25 minutes, and the
    ///         fund's `totalAssets` and the convert views revert on a stale feed (E19).
    function refreshFeeds() internal {
        uint256 t = block.timestamp;
        MockAggregator(FEED_ETH).setRound(8, feedPrice8[FEED_ETH], t, t);
        MockAggregator(FEED_CBBTC).setRound(8, feedPrice8[FEED_CBBTC], t, t);
        MockAggregator(FEED_USDC).setRound(8, feedPrice8[FEED_USDC], t, t);
        MockAggregator(FEED_SEQUENCER).setRound(0, 0, sequencerUpSince, t);
    }

    /// @notice Set the stored USD price (8 decimals) of basket asset `index`'s feed and write it now.
    function setFeedPrice(uint256 index, uint256 price8) internal {
        address feed = fund.assetConfig(index).feed;
        require(feed != address(0), "setFeedPrice: not a basket asset");
        feedPrice8[feed] = int256(price8);
        MockAggregator(feed).setRound(8, int256(price8), block.timestamp, block.timestamp);
    }

    /// @notice Set the stored USDC / USD price (8 decimals) and write it now.
    function setUsdcFeedPrice(uint256 price8) internal {
        feedPrice8[FEED_USDC] = int256(price8);
        MockAggregator(FEED_USDC).setRound(8, int256(price8), block.timestamp, block.timestamp);
    }

    /// @notice Set every listed basket feed to its pool's current price. A test calls this after the fund's own
    ///         trades moved a pool: it models an outside market that has caught up with the pool (the feed and the
    ///         pool agree again), never a pushed pool, so check 4 then compares like with like.
    function alignFeedsToPools() internal {
        setFeedPrice(IDX_WETH, poolPrice8(WETH_POOL, WETH));
        setFeedPrice(IDX_CBBTC, poolPrice8(CBBTC_POOL, CBBTC));
    }

    /// @notice USD price (8 decimals, with USDC at 1) of one whole `token` at `pool`'s current tick (`slot0`): the
    ///         price the slice-median TWAP of check 3 reads once its window lies after the pool's last observation.
    function poolPrice8(address pool, address token) internal view returns (uint256) {
        (, int24 tick,,,,,) = IHarnessV3Pool(pool).slot0();
        uint256 unit = 10 ** IERC20Metadata(token).decimals();
        uint256 usdc6 = TwapTickMath.priceFromTick(tick, token, USDC, unit);
        return usdc6 * 100;
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers: money
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Add `amount` USDC to `to`'s balance (real FiatToken balance slot: mapping at slot 9, balance in
    ///         the low 255 bits; the same write `scripts/devnet/twin-fork.ts fund-usdc` makes).
    function fundUsdc(address to, uint256 amount) internal {
        uint256 before = IERC20(USDC).balanceOf(to);
        bytes32 slot = keccak256(abi.encode(to, uint256(9)));
        vm.store(USDC, slot, bytes32(before + amount));
        assertEq(IERC20(USDC).balanceOf(to), before + amount, "fundUsdc");
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers: timed flows (§5.9.2, E8, E10)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Fund `user` with `usdc` and open a deposit request for it with the limit `maxUsdcPerShare`
    ///         (PRICE_SCALE units). The user approves the queue and is the caller and the owner.
    function openDepositRequest(address user, uint256 usdc, uint256 maxUsdcPerShare) internal returns (uint256 id) {
        fundUsdc(user, usdc);
        vm.startPrank(user);
        IERC20(USDC).approve(address(queue), usdc);
        id = queue.requestDeposit(usdc, maxUsdcPerShare, user);
        vm.stopPrank();
    }

    /// @notice `user` approves the queue for `shares` and opens a redemption request with the limit
    ///         `minUsdcPerShare` (PRICE_SCALE units, after the exit fee).
    function openRedeemRequest(address user, uint256 shares, uint256 minUsdcPerShare) internal returns (uint256 id) {
        vm.startPrank(user);
        IERC20(address(fund)).approve(address(queue), shares);
        id = queue.requestRedeem(shares, minUsdcPerShare, user);
        vm.stopPrank();
    }

    /// @notice Warp to the end of request `id`'s settlement window (no-op if that time has passed).
    function warpToSettleable(uint256 id) internal {
        Request memory r = queue.getRequest(id);
        warpForward(queue.settleableAt(r.epoch));
    }

    /// @notice Warp to `t` if it lies ahead.
    function warpForward(uint256 t) internal {
        if (t > block.timestamp) vm.warp(t);
    }

    /// @notice Refresh the feeds, then settle as the keeper until no epoch with an open request is settleable
    ///         (check 1 `Window`) or two calls in a row record nothing (every request left is skipped or capped).
    ///         Any failed check reverts here with the queue's `SettleBlocked`, so a test sees why.
    /// @return settled Settlements recorded.
    function settleAll() internal returns (uint256 settled) {
        refreshFeeds();
        uint256 idle;
        for (uint256 k; k < 16 && idle < 2; ++k) {
            // One keeper call per block, as on chain (Base: a block every 2 s): the per-call basket cap
            // (`FlowLevers.basketCallBps`, on by default) is a budget per block, and check 5 allows a venue's rate
            // no growth at all with no time elapsed.
            vm.roll(block.number + 1);
            if (k != 0) vm.warp(block.timestamp + 2);
            vm.prank(keeper);
            (SettleCheck check,) = queue.checkSettle();
            if (check == SettleCheck.Window) break;
            vm.prank(keeper);
            uint256 id = queue.settle(SETTLE_MAX_REQUESTS, type(uint256).max);
            if (id == 0) {
                ++idle;
            } else {
                ++settled;
                idle = 0;
            }
        }
    }

    /// @notice The whole deposit path for `user`: request `usdc` with no price limit, wait for the window, settle
    ///         (period after period while the flow cap leaves part of it pending, E20), wait out the hold, and
    ///         deliver every unlocked share to the user. Refreshes the feeds at the end so the fund's views read.
    ///         Returns the shares the user received.
    function deposit(address user, uint256 usdc) internal returns (uint256 shares) {
        uint256 id = openDepositRequest(user, usdc, type(uint256).max);
        settleUntilFilled(id);
        shares = deliverAfterHold(user);
    }

    /// @notice Warp to request `id`'s window, then settle, moving one `epochLength` (one cap period) at a time
    ///         until the request is filled. Fails if it is not filled within `maxRoll` periods (it would expire).
    function settleUntilFilled(uint256 id) internal {
        warpToSettleable(id);
        uint256 periods = queue.flowParams().maxRoll;
        for (uint256 k; k < periods; ++k) {
            settleAll();
            if (queue.getRequest(id).closed) return;
            vm.warp(block.timestamp + queue.flowParams().epochLength);
        }
        revert("settleUntilFilled: request still pending after maxRoll periods");
    }

    /// @notice Warp past the hold of every deposit claim `user` has (the latest unlock time), then deliver all of
    ///         them. Returns the shares delivered (0 if none). Anyone may trigger delivery (E8); the harness does.
    function deliverAfterHold(address user) internal returns (uint256 shares) {
        uint256 n = queue.claimCount();
        uint256 latest;
        for (uint256 c = 1; c <= n; ++c) {
            Claim memory cl = queue.getClaim(c);
            if (cl.kind == RequestKind.Deposit && cl.owner == user && cl.shares > cl.claimed && cl.unlockAt > latest) {
                latest = cl.unlockAt;
            }
        }
        if (latest == 0) return 0;
        warpForward(latest);
        refreshFeeds();
        uint256 deliverable = queue.maxMint(user);
        if (deliverable == 0) return 0;
        uint256 before = fund.balanceOf(user);
        queue.mint(deliverable, user);
        shares = fund.balanceOf(user) - before;
    }

    /// @notice The whole redemption path for `user`: request `shares` with no price limit, wait for the window,
    ///         settle (period after period under the cap), and take the settled USDC to the user. Returns the USDC
    ///         paid. The feeds are fresh at return (`settleAll` refreshed them in this block).
    function redeem(address user, uint256 shares) internal returns (uint256 usdc) {
        uint256 id = openRedeemRequest(user, shares, 0);
        settleUntilFilled(id);
        uint256 claimable = queue.maxRedeem(user);
        if (claimable == 0) return 0;
        uint256 before = IERC20(USDC).balanceOf(user);
        vm.prank(user);
        queue.redeem(claimable, user, user);
        usdc = IERC20(USDC).balanceOf(user) - before;
    }

    /// @notice Open a 1-day plan to `v` through the timelock and step it until it ends, so the seed (and anything
    ///         else idle) is spread over the assets. Refreshes the feeds at the end.
    function investFund(uint16[5] memory v) internal returns (uint256 planId) {
        planId = setTargetViaTimelock(v, PlanParams(1 days, COST_BUDGET_BPS));
        stepUntilDone(120);
        refreshFeeds();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers: governance (§5.1)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Record a well-formed schema 1.1 consensus receipt for the per-asset vector `v` (index-aligned to
    ///         the fund's asset list) as the submitter. The payload is a canonical JSON string with the four
    ///         bucket `weights` (the audit field, each the sum of its labelled assets) and the `assets` list
    ///         (stable key, bucket label, weight) of the listed assets. `digest = keccak256(payload)` (kept in
    ///         `receiptPayload[id]`), and `id` comes from the register's own `computeReceiptId`. Warps 1 s when
    ///         needed so every receipt's `recordedAt` is strictly later than the previous one.
    function recordReceipt(uint16[5] memory v) internal returns (bytes32 id, bytes32 digest) {
        if (uint64(block.timestamp) <= _lastRecordedAt) vm.warp(uint256(_lastRecordedAt) + 1);
        uint256 n = ++_receiptNonce;
        string memory session = string.concat("proto-session-", vm.toString(n));
        string memory payload = string.concat(
            '{"assets":', _assetsJson(v), ',"session_id":"', session, '","subject_id":"rmFUND","weights":', _bucketsJson(v), "}"
        );
        id = receipts.computeReceiptId(session, "rmFUND");
        digest = keccak256(bytes(payload));
        receiptPayload[id] = payload;
        vm.prank(submitter);
        receipts.recordReceipt(id, digest, string.concat("https://example.invalid/receipts/", session));
        _lastRecordedAt = uint64(block.timestamp);
    }

    function _assetsJson(uint16[5] memory v) private view returns (string memory out) {
        string[5] memory keys = ["aave-v3-usdc", "morpho-usdc", "weth", "cbbtc", "compound-v3-usdc"];
        string[4] memory labels = ["agent_tokens", "conservative_defi_yield", "protocol_tokens", "real_world_assets"];
        out = "[";
        for (uint256 i; i < listedAssets(); ++i) {
            out = string.concat(
                out,
                i == 0 ? "" : ",",
                '{"asset":"',
                keys[i],
                '","sleeve":"',
                labels[assetBucket(i)],
                '","weight_bps":',
                vm.toString(uint256(v[i])),
                "}"
            );
        }
        out = string.concat(out, "]");
    }

    function _bucketsJson(uint16[5] memory v) private pure returns (string memory) {
        uint256[4] memory b = bucketsOf(v);
        return string.concat(
            '{"agent_tokens":',
            vm.toString(b[BUCKET_AGENT]),
            ',"conservative_defi_yield":',
            vm.toString(b[BUCKET_STABLE]),
            ',"protocol_tokens":',
            vm.toString(b[BUCKET_PROTOCOL]),
            ',"real_world_assets":',
            vm.toString(b[BUCKET_RWA]),
            "}"
        );
    }

    /// @notice Apply a recorded receipt through the timelock (schedule, warp `TIMELOCK_DELAY`, execute), the
    ///         only path RB-1 allows. Returns the opened plan id.
    function applyReceiptViaTimelock(bytes32 id, bytes32 digest, uint16[5] memory v)
        internal
        returns (uint256 planId)
    {
        (address[] memory assets, uint256[] memory weights) = assetArrays(v);
        timelockExecute(address(governance), abi.encodeCall(governance.applyReceipt, (id, digest, assets, weights)));
        planId = fund.currentPlanId();
    }

    /// @notice Record a receipt for `v` and apply it through the timelock. Returns the plan id.
    function recordAndApply(uint16[5] memory v) internal returns (uint256 planId) {
        (bytes32 id, bytes32 digest) = recordReceipt(v);
        planId = applyReceiptViaTimelock(id, digest, v);
    }

    /// @notice Open a receipt-less plan (`governance.setTarget`, ADMIN) through the timelock.
    function setTargetViaTimelock(uint16[5] memory v, PlanParams memory params) internal returns (uint256 planId) {
        (address[] memory assets, uint256[] memory weights) = assetArrays(v);
        timelockExecute(address(governance), abi.encodeCall(governance.setTarget, (assets, weights, params)));
        planId = fund.currentPlanId();
    }

    /// @notice The asset id a target vector uses for fund asset `index` (`PlanMath.assetId`: the token for a
    ///         basket asset, the adapter for a lending asset).
    function assetIdOf(uint256 index) internal view returns (address) {
        return PlanMath.assetId(fund.assetConfig(index));
    }

    /// @notice Number of assets in the fund's list: 5 with Compound, 4 without (see the contract note).
    function listedAssets() internal view returns (uint256) {
        return cometListed ? N_ASSETS : N_ASSETS - 1;
    }

    /// @notice The parallel (asset id, weight) arrays `applyReceipt` / `setTarget` / `previewPlan` take for the
    ///         index-aligned vector `v`. Every listed asset is listed, zeros included (§4.1). While Compound is not
    ///         listed, `v[IDX_COMET]` must be 0.
    function assetArrays(uint16[5] memory v) internal view returns (address[] memory ids, uint256[] memory w) {
        uint256 n = listedAssets();
        if (n < N_ASSETS) require(v[IDX_COMET] == 0, "assetArrays: Compound is not listed in this fixture");
        ids = new address[](n);
        w = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            ids[i] = assetIdOf(i);
            w[i] = v[i];
        }
    }

    /// @notice An explicit per-asset vector in index order [aave, moonwell, wETH, cbBTC, comet].
    function assetVec(uint16 aave, uint16 moonwell, uint16 weth, uint16 cbbtc, uint16 comet)
        internal
        pure
        returns (uint16[5] memory v)
    {
        v = [aave, moonwell, weth, cbbtc, comet];
    }

    /// @notice A per-asset vector written as bucket totals (stable + protocol = 10 000; the agent and real-world
    ///         buckets are 0 on this list, §4.5): lending 40 / 30 / 30 over Aave, Moonwell and Compound (40 / 60
    ///         over Aave and Moonwell while Compound is not listed), wETH and cbBTC 50 / 50. The bucket's last asset
    ///         takes the rounding remainder. A test-side helper, not a contract rule (§11 D8).
    function bucketVec(uint16 stable, uint16 protocol) internal view returns (uint16[5] memory v) {
        v[IDX_AAVE] = uint16(uint256(stable) * 4_000 / BPS);
        if (cometListed) {
            v[IDX_MOONWELL] = uint16(uint256(stable) * 3_000 / BPS);
            v[IDX_COMET] = stable - v[IDX_AAVE] - v[IDX_MOONWELL];
        } else {
            v[IDX_MOONWELL] = stable - v[IDX_AAVE];
        }
        v[IDX_WETH] = uint16(uint256(protocol) * 5_000 / BPS);
        v[IDX_CBBTC] = protocol - v[IDX_WETH];
    }

    /// @notice Whether fund asset `index` is a basket asset (wETH, cbBTC).
    function isBasketIndex(uint256 index) internal pure returns (bool) {
        return index == IDX_WETH || index == IDX_CBBTC;
    }

    /// @notice The receipt bucket label of fund asset `index` (test-side table, §4.1).
    function assetBucket(uint256 index) internal pure returns (uint256) {
        return isBasketIndex(index) ? BUCKET_PROTOCOL : BUCKET_STABLE;
    }

    /// @notice Bucket totals [agent, stable, protocol, rwa] of the per-asset vector `v` (the audit sums).
    function bucketsOf(uint16[5] memory v) internal pure returns (uint256[4] memory b) {
        for (uint256 i; i < N_ASSETS; ++i) {
            b[assetBucket(i)] += v[i];
        }
    }

    /// @notice Schedule `data` on `target` in the timelock as the Safe stand-in, warp the delay, execute.
    ///         Reverts with the target's revert data when the call fails.
    function timelockExecute(address target, bytes memory data) internal {
        bytes32 salt = bytes32(++_saltNonce);
        timelock.schedule(target, 0, data, bytes32(0), salt, TIMELOCK_DELAY);
        vm.warp(block.timestamp + TIMELOCK_DELAY);
        timelock.execute(target, 0, data, bytes32(0), salt);
    }

    /// @notice Batch form of `timelockExecute`.
    function timelockExecuteBatch(address[] memory targets, uint256[] memory values, bytes[] memory payloads)
        internal
    {
        bytes32 salt = bytes32(++_saltNonce);
        timelock.scheduleBatch(targets, values, payloads, bytes32(0), salt, TIMELOCK_DELAY);
        vm.warp(block.timestamp + TIMELOCK_DELAY);
        timelock.executeBatch(targets, values, payloads, bytes32(0), salt);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers: stepping (§5.3, §5.4)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Keeper loop: up to `maxSteps` times, warp `rebalancer.effectiveStepInterval()` and call
    ///         `step()` as the keeper. Stops early once the plan is no longer Open (Converged, Expired, Halted,
    ///         Paused or Superseded). Skips (cooldown, ORA-4, nothing to trade, ...) count as calls. In replay it
    ///         runs the fixture coverage check every 16 calls (`coverageCheckpoint`), so one state-diff decode never
    ///         holds a whole plan.
    /// @return executed Steps that traded.
    /// @return calls    `step()` calls made.
    /// @return status   The plan status at return.
    function stepUntilDone(uint256 maxSteps)
        internal
        returns (uint256 executed, uint256 calls, PlanStatus status)
    {
        status = fund.planStatus();
        while (calls < maxSteps && status == PlanStatus.Open) {
            vm.warp(block.timestamp + rebalancer.effectiveStepInterval());
            // Step 3e: every step reads the feeds. A live feed keeps its round fresh, so re-stamp each mock at its
            // stored price after the warp (requests H-1 and step3e item 1, applied by the coordinator before wave 2).
            refreshFeeds();
            vm.prank(keeper);
            (bool did,) = rebalancer.step();
            ++calls;
            if (did) ++executed;
            if (calls % 16 == 0) coverageCheckpoint();
            status = fund.planStatus();
        }
    }

    /// @notice Replay only: run the fixture coverage check on what was recorded so far and restart the recording,
    ///         with gas metering paused. The decode of a long phase's state diff is the fixture's own bookkeeping
    ///         (as `BaseFixture`'s index is), not code under test, and can cost more gas than a test has. Do not call
    ///         it while metering is already paused: it resumes metering.
    function coverageCheckpoint() internal {
        if (!fixtureCheck) return;
        vm.pauseGasMetering();
        _fixtureCheckpoint();
        vm.resumeGasMetering();
    }

    /// @notice One keeper `step()` now, with no warp.
    function keeperStep() internal returns (bool executed, SkipReason reason) {
        vm.prank(keeper);
        return rebalancer.step();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers: market
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Arbitrage-sized trade on a token/USDC V3 `pool` through SwapRouter02, from this contract.
    ///         `buy`: spend `usdcAmount` USDC on the token (token price up). `!buy`: sell the amount of token
    ///         worth `usdcAmount` at the pool's current spot (token price down); the token is minted with
    ///         `deal`. Returns the amount out.
    function movePrice(address pool, uint256 usdcAmount, bool buy) internal returns (uint256 out) {
        IHarnessV3Pool p = IHarnessV3Pool(pool);
        address t0 = p.token0();
        address token = t0 == USDC ? p.token1() : t0;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        if (buy) {
            fundUsdc(address(this), usdcAmount);
            (tokenIn, tokenOut, amountIn) = (USDC, token, usdcAmount);
        } else {
            amountIn = spotTokenForUsdc(pool, usdcAmount);
            deal(token, address(this), IERC20(token).balanceOf(address(this)) + amountIn);
            (tokenIn, tokenOut) = (token, USDC);
        }
        IERC20(tokenIn).approve(ROUTER, amountIn);
        out = IHarnessSwapRouter02(ROUTER).exactInputSingle(
            IHarnessSwapRouter02.ExactInputSingleParams(tokenIn, tokenOut, p.fee(), address(this), amountIn, 0, 0)
        );
    }

    /// @notice Token amount worth `usdcAmount` at `pool`'s current spot (slot0), raw units.
    function spotTokenForUsdc(address pool, uint256 usdcAmount) internal view returns (uint256) {
        IHarnessV3Pool p = IHarnessV3Pool(pool);
        (uint160 sqrtP,,,,,,) = p.slot0();
        uint256 q96 = 1 << 96;
        // price = token1 per token0 = sqrtP² / 2^192.
        if (p.token0() == USDC) return usdcAmount.mulDiv(sqrtP, q96).mulDiv(sqrtP, q96);
        return usdcAmount.mulDiv(q96, sqrtP).mulDiv(q96, sqrtP);
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers: weights
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Actual TWAP weight per asset (index-aligned) and of idle USDC, in bps of NAV, rounded down
    ///         (`fund.currentWeightsBps()`).
    function assetWeightsBps() internal view returns (uint256[] memory bps, uint256 idleBps) {
        return fund.currentWeightsBps();
    }

    /// @notice Actual TWAP weight per receipt bucket [agent, stable, protocol, rwa] and of idle USDC, in bps of
    ///         NAV, from `fund.portfolioValues()` grouped by the test-side `assetBucket` labels (per-bucket floor
    ///         of the summed value, so it does not compound per-asset rounding).
    function bucketWeightsBps() internal view returns (uint256[4] memory bps, uint256 idleBps) {
        (uint256 nav, uint256 idle, uint256[] memory values) = fund.portfolioValues();
        if (nav == 0) return (bps, 0);
        uint256[4] memory sums;
        for (uint256 i; i < values.length; ++i) {
            sums[assetBucket(i)] += values[i];
        }
        for (uint256 b; b < N_BUCKETS; ++b) {
            bps[b] = sums[b] * BPS / nav;
        }
        idleBps = idle * BPS / nav;
    }
}
