// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.9 (hardened flows), §5.11 (Step 3f whole match & timed flows);
//            docs/technical/one-vault-timed-flows-eng-plan.md E1, E2, E7, E8, E10-E13, E17, E18, E20-E22, E24-E42, E49, E51-E55
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {AdminFloorAccessControl} from "./lib/AdminFloorAccessControl.sol";
import {GovernedUUPS} from "./lib/GovernedUUPS.sol";
import {Roles} from "./FundTypes.sol";
import {
    FlowBooks,
    FlowParams,
    FlowQueueInit,
    QueueLiveness,
    Quote,
    Request,
    RequestStatus,
    Claim,
    Settlement,
    SettleCheck,
    SettleContext,
    Fill,
    RequestKind,
    DEFAULT_CANCEL_BUFFER,
    DEFAULT_MAX_PAUSE,
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
import {FlowMatchLib} from "./lib/FlowMatchLib.sol";
import {FlowMigrateLib} from "./lib/FlowMigrateLib.sol";
import {FlowSettleLib} from "./lib/FlowSettleLib.sol";

/// @title FlowQueue
/// @notice The entry point for timed, netted, forward-priced deposits and redemptions of the one fund (Step 3f).
///
///         Holds roles, reentrancy lock, governance parameters, and getters; delegates logic across four linked
///         libraries (`FlowMatchLib`, `FlowCheckLib`, `FlowSettleLib`, `FlowClaimLib`) to stay strictly below EIP-170.
///         Runs behind its own ERC-1967 proxy (`GovernedUUPS`), under the same upgrade timelock as the fund (E1).
contract FlowQueue is
    AdminFloorAccessControl,
    ReentrancyGuardUpgradeable,
    GovernedUUPS,
    IFlowQueue
{
    // ─── Roles (FundTypes.Roles) ─────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = Roles.ADMIN_ROLE;
    bytes32 public constant EMERGENCY_ROLE = Roles.EMERGENCY_ROLE;
    bytes32 public constant KEEPER_ROLE = Roles.KEEPER_ROLE;

    // ═════════════════════════════════════════════════════════════════════════
    //  Initializer
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Atomic proxy initialization. ADMIN_ROLE is self-administered; EMERGENCY_ROLE and KEEPER_ROLE are
    ///         administered by ADMIN_ROLE. The fund must later `bindFlowRole(address(this))`.
    function initialize(
        FlowQueueInit calldata p,
        address upgradeTimelock_,
        UpgradeMode upgradeMode_
    ) external initializer {
        __AccessControlEnumerable_init();
        __ReentrancyGuard_init();
        __GovernedUUPS_init(upgradeTimelock_, upgradeMode_);
        if (
            p.fund == address(0) || p.usdc == address(0) || p.admin == address(0)
                || p.emergency == address(0) || p.usdcFeed == address(0)
                || p.sequencerFeed == address(0)
        ) revert ZeroAddress();
        if (p.usdcFeedMaxAge == 0) revert FlowParamOutOfBounds(type(uint256).max);
        FlowState storage s = _s();
        s.fund = p.fund;
        s.usdc = p.usdc;
        s.usdcFeed = p.usdcFeed;
        s.usdcFeedMaxAge = p.usdcFeedMaxAge;
        s.sequencerFeed = p.sequencerFeed;
        FlowMatchLib.ensureInitialized(s);
        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _setRoleAdmin(EMERGENCY_ROLE, ADMIN_ROLE);
        _setRoleAdmin(KEEPER_ROLE, ADMIN_ROLE);
        _grantRole(ADMIN_ROLE, p.admin);
        _grantRole(EMERGENCY_ROLE, p.emergency);
        if (p.keeper != address(0)) _grantRole(KEEPER_ROLE, p.keeper);
        FlowParams memory fp = p.params;
        if (fp.cancelBuffer == 0) fp.cancelBuffer = DEFAULT_CANCEL_BUFFER;
        if (fp.maxPause == 0) fp.maxPause = DEFAULT_MAX_PAUSE;
        FlowCheckLib.checkFlowParams(_s(), fp);
        FlowSettleLib.applyParams(_s(), fp);
        emit FlowParamsSet(fp);
        FlowLevers memory l =
            FlowLevers({basketCallBps: DEFAULT_BASKET_CALL_BPS, legPriceMode: LEG_PRICE_STRICTER});
        s.levers = l;
        emit FlowLeversSet(l);
    }

    /// @notice The one-time state migration of a queue upgraded in place from contracts 0.8.0 (`FlowMigrateLib`):
    ///         rewrites the 0.8.0 requests and settlements into the 0.9.0 layout, assigns held deposit shares to their
    ///         owners, writes the three new parameters and resets the walk. The upgrade timelock passes it as the data
    ///         of `upgradeToAndCall`; nobody else can run it, and it runs once. Reverts while a 0.8.0 request is open.
    function migrateV090(uint32 cancelBuffer_, uint32 maxPause_, uint16 matchBandBps_)
        external
        reinitializer(2)
    {
        FlowMigrateLib.migrateV090(_s(), cancelBuffer_, maxPause_, matchBandBps_);
    }

    /// @notice The one-time state migration of a queue upgraded in place from contracts 0.9.0 to 0.10.0
    ///         (`FlowMigrateLib.migrateV0100`): checks the 0.9.0 state and gives each live deposit bucket its hold
    ///         mark. The upgrade timelock passes it as the data of `upgradeToAndCall`; nobody else can run it, and it
    ///         runs once.
    function migrateV0100() external reinitializer(3) {
        FlowMigrateLib.migrateV0100(_s());
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Requests and exits (FlowClaimLib, FlowMatchLib)
    // ═════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IFlowQueue
    function requestDeposit(uint256 usdc, address owner) external nonReentrant returns (uint256) {
        return FlowClaimLib.requestDeposit(_s(), usdc, owner);
    }

    /// @inheritdoc IFlowQueue
    function requestDepositWithPermit(
        uint256 usdc,
        address owner,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256) {
        return FlowClaimLib.requestDepositWithPermit(_s(), usdc, owner, deadline, v, r, s);
    }

    /// @inheritdoc IFlowQueue
    function requestRedeem(uint256 shares, address owner) external nonReentrant returns (uint256) {
        return FlowClaimLib.requestRedeem(_s(), shares, owner);
    }

    /// @inheritdoc IFlowQueue
    function cancel(uint256 requestId) external nonReentrant {
        FlowClaimLib.cancel(_s(), requestId);
    }

    /// @inheritdoc IFlowQueue
    function withdrawExpired(uint256 requestId) external nonReentrant returns (uint256) {
        return FlowClaimLib.withdrawExpired(_s(), requestId);
    }

    /// @inheritdoc IFlowQueue
    function giveRedemptionNotice(uint256 requestId) external nonReentrant returns (uint64) {
        return FlowClaimLib.giveRedemptionNotice(_s(), requestId);
    }

    /// @inheritdoc IFlowQueue
    function claimNoticeReturn(uint256 requestId) external nonReentrant returns (uint256) {
        return FlowMatchLib.claimNoticeReturn(_s(), requestId);
    }

    /// @inheritdoc IFlowQueue
    function onShutdown() external nonReentrant {
        FlowState storage s = _s();
        if (msg.sender != s.fund) revert OnlyFund();
        FlowMatchLib.onShutdown(s);
    }

    /// @inheritdoc IFlowQueue
    function releaseWindDown(address owner) external nonReentrant returns (uint256, uint256) {
        return FlowMatchLib.releaseWindDown(_s(), owner);
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
    function settle(uint256 maxRequests, uint256 maxUsdc) external nonReentrant returns (uint256) {
        return FlowSettleLib.settle(_s(), maxRequests, maxUsdc, hasRole(KEEPER_ROLE, msg.sender));
    }

    /// @inheritdoc IFlowQueue
    function checkSettle() external view returns (SettleCheck check, uint256 index) {
        (check, index,,) = FlowCheckLib.preTrade(_s(), msg.sender, hasRole(KEEPER_ROLE, msg.sender));
    }

    /// @notice Self-call of `settle` for the redemption side. Only the queue may call it.
    function settleRedeemSide(uint256 settlementId, Fill[] calldata fills, SettleContext calldata c)
        external
    {
        if (msg.sender != address(this)) revert OnlySelf();
        FlowSettleLib.redeemSide(_s(), settlementId, fills, c);
    }

    /// @notice Self-call of `settle` for the deposit side. Only the queue may call it.
    function settleDepositSide(
        uint256 settlementId,
        Fill[] calldata fills,
        SettleContext calldata c
    ) external {
        if (msg.sender != address(this)) revert OnlySelf();
        FlowSettleLib.depositSide(_s(), settlementId, fills, c);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Claims (FlowClaimLib)
    // ═════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IFlowQueue
    function deposit(uint256 assets, address receiver)
        external
        nonReentrant
        returns (uint256 shares)
    {
        (shares,) = FlowClaimLib.deliver(_s(), receiver, assets, false);
    }

    /// @inheritdoc IFlowQueue
    function mint(uint256 shares, address receiver) external nonReentrant returns (uint256 assets) {
        (, assets) = FlowClaimLib.deliver(_s(), receiver, shares, true);
    }

    /// @inheritdoc IFlowQueue
    function redeem(uint256 shares, address receiver, address owner)
        external
        nonReentrant
        returns (uint256)
    {
        return FlowClaimLib.redeemClaims(_s(), shares, receiver, owner);
    }

    /// @notice Not offered (§5.9.6).
    function withdraw(uint256, address, address) external pure returns (uint256) {
        revert RedeemOnly();
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Emergency powers & Governance
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
    /// @notice Self-expiring pause (`now + maxPause`); reverts `PauseOnCooldown` before `end + maxPause` (E39).
    function pauseQueue() external onlyRole(EMERGENCY_ROLE) nonReentrant {
        FlowState storage s = _s();
        if (
            s.queuePauseLastEnd != 0
                && block.timestamp < uint256(s.queuePauseLastEnd) + s.params.maxPause
        ) {
            revert PauseOnCooldown(uint64(uint256(s.queuePauseLastEnd) + s.params.maxPause));
        }
        uint64 until = uint64(block.timestamp) + s.params.maxPause;
        s.queuePausedUntil = until;
        s.queuePauseLastEnd = until;
        emit QueuePaused(msg.sender, until);
    }

    /// @inheritdoc IFlowQueue
    function unpauseQueue() external onlyRole(ADMIN_ROLE) nonReentrant {
        FlowState storage s = _s();
        if (!s.paused && (s.queuePausedUntil == 0 || block.timestamp >= s.queuePausedUntil)) {
            return;
        }
        s.paused = false;
        s.queuePausedUntil = 0;
        emit QueueUnpaused(msg.sender);
    }

    /// @inheritdoc IFlowQueue
    function setFlowParams(FlowParams calldata params) external onlyRole(ADMIN_ROLE) nonReentrant {
        FlowCheckLib.checkFlowParams(_s(), params);
        FlowSettleLib.applyParams(_s(), params);
        emit FlowParamsSet(params);
    }

    function setFlowLevers(FlowLevers calldata l) external onlyRole(ADMIN_ROLE) nonReentrant {
        if (l.basketCallBps > MAX_BASKET_CALL_BPS) revert FlowLeverOutOfBounds(0);
        if (l.legPriceMode > LEG_PRICE_FEED_ONLY) revert FlowLeverOutOfBounds(1);
        _s().levers = l;
        emit FlowLeversSet(l);
    }

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

    function cancelBuffer() external view returns (uint32) {
        return _s().params.cancelBuffer;
    }

    function maxPause() external view returns (uint32) {
        return _s().params.maxPause;
    }

    function feeds()
        external
        view
        returns (address usdcFeed, uint32 usdcFeedMaxAge, address sequencerFeed)
    {
        FlowState storage s = _s();
        return (s.usdcFeed, s.usdcFeedMaxAge, s.sequencerFeed);
    }

    function queuePaused() external view returns (bool) {
        FlowState storage s = _s();
        return s.paused || (s.queuePausedUntil != 0 && block.timestamp < s.queuePausedUntil);
    }

    function queuePausedUntil() external view returns (uint64) {
        return _s().queuePausedUntil;
    }

    function liveness() external view returns (QueueLiveness memory l) {
        FlowState storage s = _s();
        l.keeperConfigured = getRoleMemberCount(KEEPER_ROLE) != 0;
        l.queuePausedNow =
            s.paused || (s.queuePausedUntil != 0 && block.timestamp < s.queuePausedUntil);
        l.queuePausedUntil = s.queuePausedUntil;
        l.depositsStoppedNow = !FlowCheckLib.depositsOpen(s);
        l.windDownActive = IRobotMoneyFundFull(s.fund).isShutdown();
        l.cancelBuffer = s.params.cancelBuffer;
        l.maxPause = s.params.maxPause;
    }

    function currentEpoch() external view returns (uint64) {
        return FlowEpochs.current(_s());
    }

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

    function periodFlow(uint256 period)
        external
        view
        returns (uint256 depositUsdc, uint256 redeemUsdc)
    {
        FlowState storage s = _s();
        return (s.depositUsed[period], s.redeemUsed[period]);
    }

    /// @inheritdoc IFlowQueue
    function queuedSharesOf(address account) external view returns (uint256) {
        return FlowMatchLib.queuedSharesOf(_s(), account);
    }

    /// @inheritdoc IFlowQueue
    function currentMatchIndexes()
        external
        view
        returns (uint256[2] memory depIdx, uint256[2] memory redIdx)
    {
        return FlowMatchLib.currentMatchIndexes(_s());
    }

    /// @inheritdoc IFlowQueue
    function queuedSharesOfAt(
        address account,
        uint256[2] calldata depIdx,
        uint256[2] calldata redIdx
    ) external view returns (uint256) {
        return FlowMatchLib.queuedSharesOfAt(_s(), account, depIdx, redIdx);
    }

    /// @inheritdoc IFlowQueue
    function settleCursor(bool, RequestKind kind)
        external
        view
        returns (uint64 epoch, uint256 index)
    {
        WalkCursor storage at = _s().cursors[0][uint8(kind)];
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

    function pendingDepositRequest(uint256 requestId, address controller)
        external
        view
        returns (uint256)
    {
        return FlowClaimLib.pending(_s(), requestId, controller, RequestKind.Deposit);
    }

    function claimableDepositRequest(uint256 requestId, address controller)
        external
        view
        returns (uint256)
    {
        return FlowClaimLib.claimable(_s(), requestId, controller, RequestKind.Deposit);
    }

    function pendingRedeemRequest(uint256 requestId, address controller)
        external
        view
        returns (uint256)
    {
        return FlowClaimLib.pending(_s(), requestId, controller, RequestKind.Redeem);
    }

    function claimableRedeemRequest(uint256 requestId, address controller)
        external
        view
        returns (uint256)
    {
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
