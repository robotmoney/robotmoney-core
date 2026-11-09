// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4 (one vault), §5.1 (receipt to plan), §5.3 (step),
//            §5.4 (who calls), §5.6 (parameters), §6 (contract changes), §7 (RB-1, RB-3, RB-8)
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {BaseFixture} from "./BaseFixture.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {GovernedUUPS} from "../../lib/GovernedUUPS.sol";
import {ConsensusRecommendationReceipt} from "../../ConsensusRecommendationReceipt.sol";
import {AaveV3Adapter} from "../../adapters/AaveV3Adapter.sol";
import {CompoundV3Adapter} from "../../adapters/CompoundV3Adapter.sol";
import {MorphoAdapter} from "../../adapters/MorphoAdapter.sol";
import {UniswapV3SwapAdapter} from "../../adapters/UniswapV3SwapAdapter.sol";

import {RobotMoneyFund} from "./src/RobotMoneyFund.sol";
import {Rebalancer} from "./src/Rebalancer.sol";
import {RebalanceGovernance} from "./src/RebalanceGovernance.sol";
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
    NUM_SLEEVES,
    SLEEVE_STABLE,
    SLEEVE_PROTOCOL,
    SLEEVE_RWA,
    BPS
} from "./src/FundTypes.sol";

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
/// @notice One-vault experiment (plan Step 2.1). Deploys the full prototype on the real Base fixture state and
///         gives every prototype test the same helpers. Production wiring, in miniature:
///
///         - `timelock`: an OpenZeppelin `TimelockController` with a small non-zero delay. This test contract is
///           its only proposer and executor (the Safe stand-in). It ends up holding `ADMIN_ROLE` on the fund,
///           the rebalancer and the governance contract, `TARGET_SETTER_ROLE` on governance, the receipt
///           register's `ADMIN_ROLE` (INV-3), and the upgrade authority of every proxy (RB-1).
///         - `receipts`: the real `ConsensusRecommendationReceipt` behind its ERC-1967 proxy. `submitter` holds
///           `RECEIPT_SUBMITTER_ROLE`; `governance` holds only `RECEIPT_RELEASER_ROLE` (RB-8). Both grants run
///           through the timelock, the only path the register allows.
///         - `fund`: `RobotMoneyFund` behind its proxy (§4) with six assets on real venues (§4.1):
///           stable sleeve: Aave V3, Compound V3, Moonwell (MorphoAdapter), each a production lending adapter
///           bound to the fund; protocol sleeve: wETH and cbBTC; RWA sleeve: deSPXA, all three on their Uniswap
///           V3 fee-500 USDC pools through one vault-agnostic `UniswapV3SwapAdapter`.
///         - `rebalancer` (holds the fund's `REBALANCER_ROLE`, §5.3) and `governance` (holds `GOVERNANCE_ROLE`,
///           §5.1). `keeper` holds `KEEPER_ROLE` (§5.4). `emergency` holds the fund's `EMERGENCY_ROLE`.
///
///         Parameters are the §5.6 suggested starts. Slippage bounds are derived from each pool's fee, so they
///         stay strictly above it (§5.6 last paragraph).
///
///         Tests never hard-code market prices or amounts out: they assert relationships, because the fixture
///         pin moves at re-record time.
abstract contract PrototypeHarness is BaseFixture {
    using Math for uint256;

    // ─── Real Base addresses (third-party-addresses.json, config/rwa-assets.json) ──────────────────────

    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant CBBTC = 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf;
    address internal constant DESPXA = 0x9c5C365e764829876243d0b289733B9D2b729685;
    address internal constant WETH_POOL = 0xd0b53D9277642d899DF5C87A3966A349A798F224;
    address internal constant CBBTC_POOL = 0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef;
    address internal constant DESPXA_POOL = 0xD08f1fb797BfaCdeD23323178672557034c64CfA;
    address internal constant ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant AAVE_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;
    address internal constant AAVE_A_USDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB;
    address internal constant COMET = 0xb125E6687d4313864e53df431d5425969c15Eb2F;
    address internal constant MOONWELL = 0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca;
    uint24 internal constant POOL_FEE = 500;

    // ─── Fund asset indices (stable for the fund's life, §4.1) ─────────────────────────────────────────

    uint256 internal constant IDX_AAVE = 0;
    uint256 internal constant IDX_COMET = 1;
    uint256 internal constant IDX_MOONWELL = 2;
    uint256 internal constant IDX_WETH = 3;
    uint256 internal constant IDX_CBBTC = 4;
    uint256 internal constant IDX_DESPXA = 5;
    uint256 internal constant N_ASSETS = 6;

    // ─── Parameters (§5.6 suggested starts; fund guards as the vault families deploy them) ────────────

    /// @dev Small but non-zero, so every governed call really waits in the timelock.
    uint256 internal constant TIMELOCK_DELAY = 60;
    uint32 internal constant TWAP_WINDOW = 1_800;
    uint256 internal constant TVL_CAP = 10_000_000e6;
    uint256 internal constant PER_DEPOSIT_CAP = 1_000_000e6;
    uint256 internal constant EXIT_FEE_BPS = 10;
    /// @dev Deposit / redeem swap floor. Above every pool fee (5 bps) with room for deSPXA's thin pool.
    uint256 internal constant MAX_SLIPPAGE_BPS = 200;
    /// @dev ORA-4 band. Above every pool fee.
    uint256 internal constant NAV_DEVIATION_BPS = 200;
    /// @dev ADP ramp control: no single lending venue above 60% of NAV.
    uint16 internal constant LENDING_CAP_BPS = 6_000;

    uint64 internal constant PLAN_DURATION = 7 days;
    uint16 internal constant COST_BUDGET_BPS = 30;
    uint32 internal constant KEEPER_GRACE = 6 hours;
    uint32 internal constant MAX_OVERRUN = 7 days;
    uint16 internal constant MAX_STEP_COST_BPS = 50;
    uint16 internal constant TOLERANCE_BPS = 50;
    uint128 internal constant MIN_STEP_USDC = 100e6;

    uint128 internal constant LENDING_MAX_STEP_USDC = 500_000e6;
    uint128 internal constant MAJOR_MAX_STEP_USDC = 50_000e6;
    uint128 internal constant DESPXA_MAX_STEP_USDC = 2_000e6;
    /// @dev Per-step slippage room above the pool fee for wETH and cbBTC (fee 5 bps → 50 bps floor).
    uint256 internal constant MAJOR_SLIPPAGE_OVER_FEE_BPS = 45;

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

    AaveV3Adapter internal aaveAdapter;
    CompoundV3Adapter internal cometAdapter;
    MorphoAdapter internal moonwellAdapter;
    UniswapV3SwapAdapter internal swapAdapter;

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
        vm.label(DESPXA, "deSPXA");

        _deployTimelock();
        _deployReceipts();
        _deployFund();
        _addAssets();
        _deployRebalancer();
        _deployGovernance();
        _wireRoles();
        _handOverToTimelock();
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

    /// @dev §4.1: stable sleeve = three lending venues (intra 40/30/30), protocol sleeve = wETH and cbBTC
    ///      (50/50), RWA sleeve = deSPXA (100%). The agent sleeve has no asset and is pinned to 0.
    function _addAssets() private {
        aaveAdapter = new AaveV3Adapter(AAVE_POOL, USDC, AAVE_A_USDC, address(fund));
        cometAdapter = new CompoundV3Adapter(COMET, USDC, address(fund));
        moonwellAdapter = new MorphoAdapter(MOONWELL, USDC, address(fund));
        swapAdapter = new UniswapV3SwapAdapter(ROUTER);
        vm.label(address(aaveAdapter), "aaveAdapter");
        vm.label(address(cometAdapter), "cometAdapter");
        vm.label(address(moonwellAdapter), "moonwellAdapter");
        vm.label(address(swapAdapter), "swapAdapter");

        fund.setAdapterCodeHashAllowed(address(aaveAdapter).codehash, true);
        fund.setAdapterCodeHashAllowed(address(cometAdapter).codehash, true);
        fund.setAdapterCodeHashAllowed(address(moonwellAdapter).codehash, true);
        fund.setAdapterCodeHashAllowed(address(swapAdapter).codehash, true);

        assertEq(fund.addAsset(_lending(address(aaveAdapter), 4_000)), IDX_AAVE, "aave index");
        assertEq(fund.addAsset(_lending(address(cometAdapter), 3_000)), IDX_COMET, "comet index");
        assertEq(fund.addAsset(_lending(address(moonwellAdapter), 3_000)), IDX_MOONWELL, "moonwell index");
        assertEq(fund.addAsset(_basket(SLEEVE_PROTOCOL, WETH, WETH_POOL, 5_000)), IDX_WETH, "weth index");
        assertEq(fund.addAsset(_basket(SLEEVE_PROTOCOL, CBBTC, CBBTC_POOL, 5_000)), IDX_CBBTC, "cbbtc index");
        assertEq(fund.addAsset(_basket(SLEEVE_RWA, DESPXA, DESPXA_POOL, 10_000)), IDX_DESPXA, "despxa index");
    }

    function _lending(address adapter, uint16 intraBps) private pure returns (AssetConfig memory) {
        return AssetConfig({
            kind: AssetKind.Lending,
            sleeve: SLEEVE_STABLE,
            active: true,
            intraBps: intraBps,
            capBps: LENDING_CAP_BPS,
            adapter: adapter,
            token: address(0),
            pool: address(0),
            poolFee: 0,
            twapWindow: 0,
            venue: Venue.V3
        });
    }

    function _basket(uint8 sleeve, address token, address pool, uint16 intraBps)
        private
        view
        returns (AssetConfig memory)
    {
        return AssetConfig({
            kind: AssetKind.Basket,
            sleeve: sleeve,
            active: true,
            intraBps: intraBps,
            capBps: 0,
            adapter: address(swapAdapter),
            token: token,
            pool: pool,
            poolFee: POOL_FEE,
            twapWindow: TWAP_WINDOW,
            venue: Venue.V3
        });
    }

    /// @dev §5.6 suggested starts. `stepInterval` is the longest TWAP window (or 30 min). Per-asset slippage is
    ///      pool-fee aware: wETH and cbBTC sit `MAJOR_SLIPPAGE_OVER_FEE_BPS` above their fee, deSPXA (thin pool)
    ///      at the fund ceiling; lending withdrawals are 1:1 so 0.
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
        for (uint256 i = IDX_AAVE; i <= IDX_MOONWELL; ++i) {
            rebalancer.setAssetStepParams(i, AssetStepParams(LENDING_MAX_STEP_USDC, 0));
        }
        uint16 majorSlip = uint16(Math.min(fund.poolFeeBps(IDX_WETH) + MAJOR_SLIPPAGE_OVER_FEE_BPS, ceiling));
        rebalancer.setAssetStepParams(IDX_WETH, AssetStepParams(MAJOR_MAX_STEP_USDC, majorSlip));
        majorSlip = uint16(Math.min(fund.poolFeeBps(IDX_CBBTC) + MAJOR_SLIPPAGE_OVER_FEE_BPS, ceiling));
        rebalancer.setAssetStepParams(IDX_CBBTC, AssetStepParams(MAJOR_MAX_STEP_USDC, majorSlip));
        rebalancer.setAssetStepParams(IDX_DESPXA, AssetStepParams(DESPXA_MAX_STEP_USDC, uint16(ceiling)));
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

    /// @dev Fund plan roles bound once by the deployer admin (self-administered afterwards, RB-1); receipt roles
    ///      through the timelock (the register's only admin).
    function _wireRoles() private {
        RobotMoneyFund f = RobotMoneyFund(address(fund));
        f.bindRebalanceRoles(address(governance), address(rebalancer));

        address[] memory targets = new address[](2);
        uint256[] memory values = new uint256[](2);
        bytes[] memory payloads = new bytes[](2);
        targets[0] = address(receipts);
        targets[1] = address(receipts);
        payloads[0] = abi.encodeCall(receipts.grantRole, (receipts.RECEIPT_SUBMITTER_ROLE(), submitter));
        payloads[1] = abi.encodeCall(receipts.grantRole, (receipts.RECEIPT_RELEASER_ROLE(), address(governance)));
        timelockExecuteBatch(targets, values, payloads);
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
    }

    function _proxy(address impl, bytes memory initData) private returns (address) {
        return address(new ERC1967Proxy(impl, initData));
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

    /// @notice Fund `user` with `amount` USDC and deposit it into the fund for `user`. Returns the shares minted.
    function deposit(address user, uint256 amount) internal returns (uint256 shares) {
        fundUsdc(user, amount);
        vm.startPrank(user);
        IERC20(USDC).approve(address(fund), amount);
        shares = fund.deposit(amount, user);
        vm.stopPrank();
    }

    // ═════════════════════════════════════════════════════════════════════════════════════════════════
    //  Helpers: governance (§5.1)
    // ═════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Record a well-formed consensus receipt for the sleeve vector `bps` ([agent, stable, protocol,
    ///         rwa]) as the submitter. The payload is a canonical JSON string naming the four receipt buckets;
    ///         `digest = keccak256(payload)` (kept in `receiptPayload[id]`), and `id` comes from the register's
    ///         own `computeReceiptId`. Warps 1 s when needed so every receipt's `recordedAt` is strictly later
    ///         than the previous one (governance refuses an older-or-equal receipt).
    function recordReceipt(uint16[4] memory bps) internal returns (bytes32 id, bytes32 digest) {
        if (uint64(block.timestamp) <= _lastRecordedAt) vm.warp(uint256(_lastRecordedAt) + 1);
        uint256 n = ++_receiptNonce;
        string memory session = string.concat("proto-session-", vm.toString(n));
        string memory payload = string.concat(
            '{"buckets":{"agent_tokens":',
            vm.toString(uint256(bps[0])),
            ',"conservative_defi_yield":',
            vm.toString(uint256(bps[1])),
            ',"protocol_tokens":',
            vm.toString(uint256(bps[2])),
            ',"real_world_assets":',
            vm.toString(uint256(bps[3])),
            '},"session_id":"',
            session,
            '","subject_id":"rmFUND"}'
        );
        id = receipts.computeReceiptId(session, "rmFUND");
        digest = keccak256(bytes(payload));
        receiptPayload[id] = payload;
        vm.prank(submitter);
        receipts.recordReceipt(id, digest, string.concat("https://example.invalid/receipts/", session));
        _lastRecordedAt = uint64(block.timestamp);
    }

    /// @notice Apply a recorded receipt through the timelock (schedule, warp `TIMELOCK_DELAY`, execute), the
    ///         only path RB-1 allows. Returns the opened plan id.
    function applyReceiptViaTimelock(bytes32 id, bytes32 digest, uint16[4] memory bps)
        internal
        returns (uint256 planId)
    {
        (uint8[] memory sleeves, uint256[] memory weights) = sleeveArrays(bps);
        timelockExecute(address(governance), abi.encodeCall(governance.applyReceipt, (id, digest, sleeves, weights)));
        planId = fund.currentPlanId();
    }

    /// @notice Record a receipt for `bps` and apply it through the timelock. Returns the plan id.
    function recordAndApply(uint16[4] memory bps) internal returns (uint256 planId) {
        (bytes32 id, bytes32 digest) = recordReceipt(bps);
        planId = applyReceiptViaTimelock(id, digest, bps);
    }

    /// @notice Open a receipt-less plan (`governance.setTarget`, ADMIN) through the timelock.
    function setTargetViaTimelock(uint16[4] memory bps, PlanParams memory params) internal returns (uint256 planId) {
        (uint8[] memory sleeves, uint256[] memory weights) = sleeveArrays(bps);
        timelockExecute(address(governance), abi.encodeCall(governance.setTarget, (sleeves, weights, params)));
        planId = fund.currentPlanId();
    }

    /// @notice The parallel (sleeve id, weight) arrays `applyReceipt` / `setTarget` take for `bps`.
    function sleeveArrays(uint16[4] memory bps) internal pure returns (uint8[] memory ids, uint256[] memory w) {
        ids = new uint8[](NUM_SLEEVES);
        w = new uint256[](NUM_SLEEVES);
        for (uint256 i; i < NUM_SLEEVES; ++i) {
            ids[i] = uint8(i);
            w[i] = bps[i];
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
    ///         Paused or Superseded). Skips (cooldown, ORA-4, nothing to trade, ...) count as calls.
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
            vm.prank(keeper);
            (bool did,) = rebalancer.step();
            ++calls;
            if (did) ++executed;
            status = fund.planStatus();
        }
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

    /// @notice Actual TWAP weight per sleeve [agent, stable, protocol, rwa] and of idle USDC, in bps of NAV,
    ///         computed from `fund.portfolioValues()` (per-sleeve floor of the summed value, so it does not
    ///         compound per-asset rounding).
    function sleeveWeightsBps() internal view returns (uint256[4] memory bps, uint256 idleBps) {
        (uint256 nav, uint256 idle, uint256[] memory values) = fund.portfolioValues();
        if (nav == 0) return (bps, 0);
        uint256[4] memory sums;
        AssetConfig[] memory cfgs = fund.assetConfigs();
        for (uint256 i; i < values.length; ++i) {
            sums[cfgs[i].sleeve] += values[i];
        }
        for (uint256 s; s < NUM_SLEEVES; ++s) {
            bps[s] = sums[s] * BPS / nav;
        }
        idleBps = idle * BPS / nav;
    }

    /// @notice A canonical sleeve vector [agent 0, stable, protocol, rwa].
    function sleeveVec(uint16 stable, uint16 protocol, uint16 rwa) internal pure returns (uint16[4] memory v) {
        v[1] = stable;
        v[2] = protocol;
        v[3] = rwa;
    }
}
