// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9 (hardened flows), §5.9.6 (the vault interface), §6
//            (FlowQueue row), §6.1 (size), §7 (RB-10 to RB-18, RB-20 to RB-22);
//            docs/technical/one-vault-timed-flows-eng-plan.md E1, E2, E7, E8, E10 to E13, E17, E18, E20 to E22, §3.1
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {AdminFloorAccessControl} from "../../../lib/AdminFloorAccessControl.sol";
import {GovernedUUPS} from "../../../lib/GovernedUUPS.sol";
import {Roles} from "./FundTypes.sol";
import {
    FlowBooks,
    FlowParams,
    FlowQueueInit,
    Quote,
    Request,
    RequestStatus,
    Claim,
    Settlement,
    SettleCheck,
    SettleContext,
    Fill,
    RequestKind,
    MIN_EPOCH_LENGTH,
    MAX_EPOCH_LENGTH,
    MIN_SETTLE_WINDOW,
    MAX_SETTLE_WINDOW,
    MIN_HOLD,
    MAX_HOLD,
    MIN_FLOW_KEEPER_GRACE,
    MAX_FLOW_KEEPER_GRACE,
    MAX_EPOCH_FLOW_BPS,
    MAX_EPOCH_FLOW_FLOOR_USDC,
    MAX_SHARE_PRICE_MOVE_BPS,
    MAX_ROLL,
    MAX_MIN_REQUEST_USDC,
    MIN_FREEZE,
    MAX_FREEZE,
    MIN_SLICES,
    MAX_SLICES,
    MIN_SLICE_SECONDS,
    MAX_DISPERSION_BPS,
    MAX_REF_BAND_BPS,
    MAX_LEG_BAND_BPS,
    MAX_SEQUENCER_GRACE,
    MAX_USDC_PEG_BAND_BPS,
    MAX_LEND_RATE_GROWTH_BPS,
    FlowLevers,
    MAX_BASKET_CALL_BPS,
    DEFAULT_BASKET_CALL_BPS,
    LEG_PRICE_STRICTER,
    LEG_PRICE_FEED_ONLY
} from "./FlowTypes.sol";
import {IFlowQueue} from "./interfaces/IFlowQueue.sol";
import {IRobotMoneyFundFull} from "./interfaces/IRobotMoneyFund.sol";
import {FlowEpochs, FlowState, FlowStorage, WalkCursor} from "./lib/FlowStorage.sol";
import {FlowCheckLib} from "./lib/FlowCheckLib.sol";
import {FlowClaimLib} from "./lib/FlowClaimLib.sol";
import {FlowSettleLib} from "./lib/FlowSettleLib.sol";

/// @title FlowQueue
/// @notice The entry point for timed deposits and redemptions of the one fund (E1, E2). See `IFlowQueue`.
///
///         Built by the `queue` agent (scaffold plan §7.3, 2026-11-11). This contract holds roles, the reentrancy
///         lock, the parameters and the getters; the logic lives in three linked libraries so the queue stays
///         under EIP-170, 24,576 bytes (G1):
///         - `FlowCheckLib`: checks 1 to 7 of §5.9.3, the bound prices (E12), `checkSettle`, the quotes (E21).
///         - `FlowSettleLib`: `settle` (walk, caps, eligibility) and the two sides (checks 8 to 12), each side in
///           its own self-call (`settleRedeemSide`, `settleDepositSide`) so a failed side changes no state.
///         - `FlowClaimLib`: requests, cancel, in-kind exit, expiry, credits, claims, the freeze, the sweep.
///         Every function here and in those libraries is implemented, and so is every fund function they call
///         (scaffold report §8.1).
///
///         Runs behind its own ERC-1967 proxy (`GovernedUUPS`), under the same upgrade timelock as the fund (E1).
contract FlowQueue is AdminFloorAccessControl, ReentrancyGuardUpgradeable, GovernedUUPS, IFlowQueue {
    // ─── Roles (FundTypes.Roles) ─────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = Roles.ADMIN_ROLE;
    bytes32 public constant EMERGENCY_ROLE = Roles.EMERGENCY_ROLE;
    bytes32 public constant KEEPER_ROLE = Roles.KEEPER_ROLE;

    // ═════════════════════════════════════════════════════════════════════════
    //  Initializer
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Atomic proxy initialization. ADMIN_ROLE is self-administered; EMERGENCY_ROLE and KEEPER_ROLE are
    ///         administered by ADMIN_ROLE. The fund must later `bindFlowRole(address(this))`.
    function initialize(FlowQueueInit calldata p, address upgradeTimelock_, UpgradeMode upgradeMode_)
        external
        initializer
    {
        __AccessControlEnumerable_init();
        __ReentrancyGuard_init();
        __GovernedUUPS_init(upgradeTimelock_, upgradeMode_);
        if (
            p.fund == address(0) || p.usdc == address(0) || p.admin == address(0) || p.emergency == address(0)
                || p.usdcFeed == address(0) || p.sequencerFeed == address(0)
        ) revert ZeroAddress();
        if (p.usdcFeedMaxAge == 0) revert FlowParamOutOfBounds(type(uint256).max);
        FlowState storage s = _s();
        s.fund = p.fund;
        s.usdc = p.usdc;
        s.usdcFeed = p.usdcFeed;
        s.usdcFeedMaxAge = p.usdcFeedMaxAge;
        s.sequencerFeed = p.sequencerFeed;
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _setRoleAdmin(EMERGENCY_ROLE, ADMIN_ROLE);
        _setRoleAdmin(KEEPER_ROLE, ADMIN_ROLE);
        _grantRole(ADMIN_ROLE, p.admin);
        _grantRole(EMERGENCY_ROLE, p.emergency);
        if (p.keeper != address(0)) _grantRole(KEEPER_ROLE, p.keeper);
        _setFlowParams(p.params);
        // The owner's decided default levers (2026-11-12): the 5 bps per-call basket cap, limits from the stricter
        // of TWAP and feed. ADMIN may change them later through `setFlowLevers`.
        FlowLevers memory l = FlowLevers({basketCallBps: DEFAULT_BASKET_CALL_BPS, legPriceMode: LEG_PRICE_STRICTER});
        s.levers = l;
        emit FlowLeversSet(l);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Requests and price-free exits (FlowClaimLib)
    // ═════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IFlowQueue
    function requestDeposit(uint256 usdc, uint256 maxUsdcPerShare, address owner)
        external
        nonReentrant
        returns (uint256)
    {
        return FlowClaimLib.requestDeposit(_s(), usdc, maxUsdcPerShare, owner);
    }

    /// @inheritdoc IFlowQueue
    function requestRedeem(uint256 shares, uint256 minUsdcPerShare, address owner)
        external
        nonReentrant
        returns (uint256)
    {
        return FlowClaimLib.requestRedeem(_s(), shares, minUsdcPerShare, owner);
    }

    /// @inheritdoc IFlowQueue
    function cancel(uint256 requestId) external nonReentrant {
        FlowClaimLib.cancel(_s(), requestId);
    }

    /// @inheritdoc IFlowQueue
    function exitInKind(uint256 requestId) external nonReentrant {
        FlowClaimLib.exitInKind(_s(), requestId);
    }

    /// @inheritdoc IFlowQueue
    function withdrawExpired(uint256 requestId) external nonReentrant returns (uint256) {
        return FlowClaimLib.withdrawExpired(_s(), requestId);
    }

    /// @inheritdoc IFlowQueue
    function withdrawCredit() external nonReentrant returns (uint256, uint256) {
        return FlowClaimLib.withdrawCredit(_s());
    }

    /// @inheritdoc IFlowQueue
    function sweep() external nonReentrant returns (uint256, uint256) {
        return FlowClaimLib.sweep(_s());
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Settlement (FlowCheckLib, FlowSettleLib)
    // ═════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IFlowQueue
    /// @dev `maxUsdc` limits each side separately: the deposit USDC and the redemption value at the feeds.
    function settle(uint256 maxRequests, uint256 maxUsdc) external nonReentrant returns (uint256) {
        return FlowSettleLib.settle(_s(), maxRequests, maxUsdc, hasRole(KEEPER_ROLE, msg.sender));
    }

    /// @inheritdoc IFlowQueue
    function checkSettle() external view returns (SettleCheck check, uint256 index) {
        (check, index,,) = FlowCheckLib.preTrade(_s(), msg.sender, hasRole(KEEPER_ROLE, msg.sender));
    }

    /// @notice Self-call of `settle` for the redemption side (FlowSettleLib note). Only the queue may call it.
    function settleRedeemSide(uint256 settlementId, Fill[] calldata fills, SettleContext calldata c) external {
        if (msg.sender != address(this)) revert OnlySelf();
        FlowSettleLib.redeemSide(_s(), settlementId, fills, c);
    }

    /// @notice Self-call of `settle` for the deposit side. Only the queue may call it.
    function settleDepositSide(uint256 settlementId, Fill[] calldata fills, SettleContext calldata c) external {
        if (msg.sender != address(this)) revert OnlySelf();
        FlowSettleLib.depositSide(_s(), settlementId, fills, c);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Claims (FlowClaimLib)
    // ═════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IFlowQueue
    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        (shares,) = FlowClaimLib.deliver(_s(), receiver, assets, false);
    }

    /// @inheritdoc IFlowQueue
    function mint(uint256 shares, address receiver) external nonReentrant returns (uint256 assets) {
        (, assets) = FlowClaimLib.deliver(_s(), receiver, shares, true);
    }

    /// @inheritdoc IFlowQueue
    function redeem(uint256 shares, address receiver, address owner) external nonReentrant returns (uint256) {
        return FlowClaimLib.redeemClaims(_s(), shares, receiver, owner);
    }

    /// @notice Not offered (§5.9.6).
    function withdraw(uint256, address, address) external pure returns (uint256) {
        revert RedeemOnly();
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Emergency powers
    // ═════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IFlowQueue
    function freezeSettlement(uint256 id) external onlyRole(EMERGENCY_ROLE) nonReentrant {
        FlowClaimLib.freeze(_s(), id);
    }

    /// @inheritdoc IFlowQueue
    function releaseSettlement(uint256 id) external onlyRole(ADMIN_ROLE) nonReentrant {
        FlowClaimLib.release(_s(), id);
    }

    /// @inheritdoc IFlowQueue
    function allowReturn(uint256 id) external onlyRole(ADMIN_ROLE) nonReentrant {
        FlowClaimLib.allowReturn(_s(), id);
    }

    /// @inheritdoc IFlowQueue
    function takeReturn(uint256 claimId) external nonReentrant {
        FlowClaimLib.takeReturn(_s(), claimId);
    }

    /// @notice EMERGENCY_ROLE. Pause requests and settlement (cancel, in-kind exit and withdrawals stay open).
    /// @dev Under the one reentrancy lock like every other entry point (eng plan §3.1).
    function pause() external onlyRole(EMERGENCY_ROLE) nonReentrant {
        FlowState storage s = _s();
        if (s.paused) return;
        s.paused = true;
        emit QueuePaused(msg.sender);
    }

    /// @notice ADMIN_ROLE.
    function unpause() external onlyRole(ADMIN_ROLE) nonReentrant {
        FlowState storage s = _s();
        if (!s.paused) return;
        s.paused = false;
        emit QueueUnpaused(msg.sender);
    }

    /// @notice ADMIN_ROLE (timelock), inside the hard bounds of FlowTypes. Under the reentrancy lock, so no callback
    ///         inside a settlement can change the parameters that settlement reads.
    /// @dev No change can stall settlement or orphan a request (step 3 finish plan §3.1 item 3). A new `epochLength`
    ///      applies from the end of the epoch in progress; every open epoch keeps its own end and its index
    ///      (`FlowEpochs`), so open requests settle at the end of their own windows and expire after `maxRoll`
    ///      epochs as before. Any change also resets the walk (the oldest-epoch hint and every cursor), so a larger
    ///      `maxRoll` cannot leave a revived request behind a stale position (`FlowSettleLib.applyParams`).
    function setFlowParams(FlowParams calldata params) external onlyRole(ADMIN_ROLE) nonReentrant {
        _setFlowParams(params);
    }

    /// @dev Hard bounds (eng plan §2). `field` in `FlowParamOutOfBounds` is the struct position, 0-based. The
    ///      combination rules refuse values that would stop every settlement: `quorum` above `slices`, a window
    ///      that does not split into whole slices of at least `MIN_SLICE_SECONDS`, and a window plus grace that
    ///      ends after a request expires (field 7, see below).
    function _setFlowParams(FlowParams memory p) private {
        if (p.epochLength < MIN_EPOCH_LENGTH || p.epochLength > MAX_EPOCH_LENGTH) revert FlowParamOutOfBounds(0);
        if (p.settleWindow < MIN_SETTLE_WINDOW || p.settleWindow > MAX_SETTLE_WINDOW) revert FlowParamOutOfBounds(1);
        if (p.minHold < MIN_HOLD || p.minHold > MAX_HOLD) revert FlowParamOutOfBounds(2);
        if (p.keeperGrace < MIN_FLOW_KEEPER_GRACE || p.keeperGrace > MAX_FLOW_KEEPER_GRACE) {
            revert FlowParamOutOfBounds(3);
        }
        if (p.maxEpochFlowBps == 0 || p.maxEpochFlowBps > MAX_EPOCH_FLOW_BPS) revert FlowParamOutOfBounds(4);
        if (p.epochFlowFloorUsdc > MAX_EPOCH_FLOW_FLOOR_USDC) revert FlowParamOutOfBounds(5);
        if (p.maxSharePriceMoveBps == 0 || p.maxSharePriceMoveBps > MAX_SHARE_PRICE_MOVE_BPS) {
            revert FlowParamOutOfBounds(6);
        }
        // A request of epoch e can settle from `(e + 1) × L + W` (anyone from `+ keeperGrace`) and expires at
        // `(e + maxRoll + 1) × L`. Unless `W + keeperGrace < maxRoll × L`, a queue with no keeper would let every
        // request expire before anyone may settle it.
        if (
            p.maxRoll == 0 || p.maxRoll > MAX_ROLL
                || uint256(p.settleWindow) + p.keeperGrace >= uint256(p.maxRoll) * p.epochLength
        ) revert FlowParamOutOfBounds(7);
        if (p.minRequestUsdc == 0 || p.minRequestUsdc > MAX_MIN_REQUEST_USDC) revert FlowParamOutOfBounds(8);
        if (p.maxFreeze < MIN_FREEZE || p.maxFreeze > MAX_FREEZE) revert FlowParamOutOfBounds(9);
        if (
            p.slices < MIN_SLICES || p.slices > MAX_SLICES || p.settleWindow % p.slices != 0
                || p.settleWindow / p.slices < MIN_SLICE_SECONDS
        ) revert FlowParamOutOfBounds(10);
        if (p.quorum == 0 || p.quorum > p.slices) revert FlowParamOutOfBounds(11);
        if (p.dispersionBps == 0 || p.dispersionBps > MAX_DISPERSION_BPS) revert FlowParamOutOfBounds(12);
        if (p.refBandBps == 0 || p.refBandBps > MAX_REF_BAND_BPS) revert FlowParamOutOfBounds(13);
        // `legBandBps` must also be above every basket pool fee (§5.9.5), read from the fund now. An asset added
        // later with a higher fee is not re-checked here (scaffold gap, noted in the queue agent's notes).
        if (
            p.legBandBps == 0 || p.legBandBps > MAX_LEG_BAND_BPS
                || p.legBandBps <= IRobotMoneyFundFull(_s().fund).maxPoolFeeBps()
        ) revert FlowParamOutOfBounds(14);
        if (p.sequencerGrace > MAX_SEQUENCER_GRACE) revert FlowParamOutOfBounds(15);
        if (p.usdcPegBandBps == 0 || p.usdcPegBandBps > MAX_USDC_PEG_BAND_BPS) revert FlowParamOutOfBounds(16);
        if (p.maxLendRateGrowthBps == 0 || p.maxLendRateGrowthBps > MAX_LEND_RATE_GROWTH_BPS) {
            revert FlowParamOutOfBounds(17);
        }
        FlowSettleLib.applyParams(_s(), p);
        emit FlowParamsSet(p);
    }

    /// @notice ADMIN_ROLE (timelock). The attack-finding levers of step 3 finish plan §3.2 (`FlowLevers`), appended
    ///         by `levers` 2026-11-12. `initialize` sets the decided defaults (`DEFAULT_BASKET_CALL_BPS`, stricter-of-both);
    ///         all zero is the design as §5.9 first wrote it. Under the reentrancy lock like
    ///         `setFlowParams`. Changes nothing else: no cursor, epoch or reference moves.
    function setFlowLevers(FlowLevers calldata l) external onlyRole(ADMIN_ROLE) nonReentrant {
        if (l.basketCallBps > MAX_BASKET_CALL_BPS) revert FlowLeverOutOfBounds(0);
        if (l.legPriceMode > LEG_PRICE_FEED_ONLY) revert FlowLeverOutOfBounds(1);
        _s().levers = l;
        emit FlowLeversSet(l);
    }

    /// @notice The attack-finding levers in force (from `initialize`: the 5 bps per-call cap, stricter-of-both).
    function flowLevers() external view returns (FlowLevers memory) {
        return _s().levers;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Views
    // ═════════════════════════════════════════════════════════════════════════

    function share() external view returns (address) {
        return _s().fund;
    }

    function asset() external view returns (address) {
        return _s().usdc;
    }

    function flowParams() external view returns (FlowParams memory) {
        return _s().params;
    }

    function feeds() external view returns (address usdcFeed, uint32 usdcFeedMaxAge, address sequencerFeed) {
        FlowState storage s = _s();
        return (s.usdcFeed, s.usdcFeedMaxAge, s.sequencerFeed);
    }

    function paused() external view returns (bool) {
        return _s().paused;
    }

    /// @notice The epoch in progress (`FlowEpochs.current`: indices only grow, also across a new `epochLength`).
    function currentEpoch() external view returns (uint64) {
        return FlowEpochs.current(_s());
    }

    /// @notice When `epoch`'s settlement window ends: its own end (`FlowEpochs.endOf`) plus `settleWindow`.
    function settleableAt(uint64 epoch) external view returns (uint64) {
        FlowState storage s = _s();
        return uint64(FlowEpochs.endOf(s, epoch) + s.params.settleWindow);
    }

    function getRequest(uint256 requestId) external view returns (Request memory) {
        return _s().requests[requestId];
    }

    function requestStatus(uint256 requestId) external view returns (RequestStatus) {
        return FlowClaimLib.status(_s(), requestId);
    }

    function getClaim(uint256 claimId) external view returns (Claim memory) {
        return _s().claims[claimId];
    }

    function getSettlement(uint256 settlementId) external view returns (Settlement memory) {
        return _s().settlements[settlementId];
    }

    function epochRequests(uint64 epoch) external view returns (uint256[] memory) {
        return FlowClaimLib.epochRequests(_s(), epoch);
    }

    function requestCount() external view returns (uint256) {
        return _s().requestCount;
    }

    function claimCount() external view returns (uint256) {
        return _s().claimCount;
    }

    function settlementCount() external view returns (uint256) {
        return _s().settlementCount;
    }

    function creditOf(address owner) external view returns (uint256 usdc, uint256 shares) {
        FlowState storage s = _s();
        return (s.usdcCredit[owner], s.shareCredit[owner]);
    }

    function periodFlow(uint256 period) external view returns (uint256 depositUsdc, uint256 redeemUsdc) {
        FlowState storage s = _s();
        return (s.depositUsed[period], s.redeemUsed[period]);
    }

    /// @notice Reads `queuedShares`, which every change of an owner's escrowed or held shares must keep exact
    ///         (E13, RB-22). The fund's `ledgerBalanceOf` reads this.
    function queuedSharesOf(address account) external view returns (uint256) {
        return _s().queuedShares[account];
    }

    /// @inheritdoc IFlowQueue
    function settleCursor(bool keeperClass, RequestKind kind) external view returns (uint64 epoch, uint256 index) {
        WalkCursor storage at = _s().cursors[keeperClass ? 0 : 1][uint8(kind)];
        return (at.epoch, at.index);
    }

    /// @inheritdoc IFlowQueue
    function books() external view returns (FlowBooks memory b) {
        FlowState storage s = _s();
        b.pendingUsdc = s.totalPendingUsdc;
        b.owedUsdc = s.totalOwedUsdc;
        b.creditUsdc = s.totalCreditUsdc;
        b.dustUsdc = s.dustUsdc;
        b.escrowShares = s.totalEscrowShares;
        b.heldShares = s.totalHeldShares;
        b.creditShares = s.totalCreditShares;
        b.dustShares = s.dustShares;
    }

    /// @inheritdoc IFlowQueue
    function quoteDeposit(uint256 usdc) external view returns (Quote memory) {
        return FlowCheckLib.quoteDeposit(_s(), usdc);
    }

    /// @inheritdoc IFlowQueue
    function quoteRedeem(uint256 shares) external view returns (Quote memory) {
        return FlowCheckLib.quoteRedeem(_s(), shares);
    }

    function pendingDepositRequest(uint256 requestId, address controller) external view returns (uint256) {
        return FlowClaimLib.pending(_s(), requestId, controller, RequestKind.Deposit);
    }

    function claimableDepositRequest(uint256 requestId, address controller) external view returns (uint256) {
        return FlowClaimLib.claimable(_s(), requestId, controller, RequestKind.Deposit);
    }

    function pendingRedeemRequest(uint256 requestId, address controller) external view returns (uint256) {
        return FlowClaimLib.pending(_s(), requestId, controller, RequestKind.Redeem);
    }

    function claimableRedeemRequest(uint256 requestId, address controller) external view returns (uint256) {
        return FlowClaimLib.claimable(_s(), requestId, controller, RequestKind.Redeem);
    }

    function maxDeposit(address owner) external view returns (uint256 assets) {
        (assets,,) = FlowClaimLib.maxClaims(_s(), owner);
    }

    function maxMint(address owner) external view returns (uint256 shares) {
        (, shares,) = FlowClaimLib.maxClaims(_s(), owner);
    }

    function maxRedeem(address owner) external view returns (uint256 shares) {
        (,, shares) = FlowClaimLib.maxClaims(_s(), owner);
    }

    /// @notice ERC-7540: previews revert for asynchronous flows. Use `quoteDeposit` / `quoteRedeem` (E21).
    function previewDeposit(uint256) external pure returns (uint256) {
        revert PreviewNotSupported();
    }

    function previewMint(uint256) external pure returns (uint256) {
        revert PreviewNotSupported();
    }

    function previewRedeem(uint256) external pure returns (uint256) {
        revert PreviewNotSupported();
    }

    function previewWithdraw(uint256) external pure returns (uint256) {
        revert PreviewNotSupported();
    }

    // ─── Storage ─────────────────────────────────────────────────────────────

    function _s() private pure returns (FlowState storage) {
        return FlowStorage.layout();
    }
}
