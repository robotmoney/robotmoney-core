// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4 (target architecture), §4.1-§4.4 (asset targets, NAV,
//            deposits, redemptions), §5.1 (plan open), §5.3 (executeStep), §5.5 (plan states), §6 (contract
//            changes), §6.1 (size), §7 (RB-1, RB-3, RB-4, RB-5, RB-6, RB-7); step 3d: §4.5, §5.9.4, §5.9.6, §7 (RB-13,
//            RB-17, RB-21, RB-22); docs/technical/one-vault-timed-flows-eng-plan.md E1 to E4, E9, E13 to E15, E19,
//            E20, E23
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {
    ERC4626Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {GovernedUUPS} from "../../../lib/GovernedUUPS.sol";
import {AdminFloorAccessControlCounter} from "../../../lib/AdminFloorAccessControlCounter.sol";
import {ForeignTokenQuarantine} from "../../../lib/ForeignTokenQuarantine.sol";
import {RobotMoneyVaultOps} from "../../../lib/RobotMoneyVaultOps.sol";
import {
    AssetConfig,
    BPS,
    FundInitParams,
    Plan,
    PlanParams,
    PlanStatus,
    Roles,
    StepOrder,
    StepResult
} from "./FundTypes.sol";
import {IRobotMoneyFund} from "./interfaces/IRobotMoneyFund.sol";
import {IFlowQueue} from "./interfaces/IFlowQueue.sol";
import {FundState, FundStorage} from "./lib/FundStorage.sol";
import {FundValuationLib} from "./lib/FundValuationLib.sol";
import {FundFlowsLib} from "./lib/FundFlowsLib.sol";
import {FundAdminLib} from "./lib/FundAdminLib.sol";
import {FundPositionLib} from "./lib/FundPositionLib.sol";
import {FundDelistLib} from "./lib/FundDelistLib.sol";

/// @title RobotMoneyFund
/// @notice The one vault (§4): an ERC-4626 over USDC, share `rmFUND`, behind `GovernedUUPS` (ADR-0014). It holds
///         a flat list of Lending adapters and Basket tokens, one persistent target weight per asset, and one
///         rebalance plan at a time. No sleeve or category is stored or read (§4.1, RB-9). It is the union of
///         `RobotMoneyVault` (cap allocator, ADP-2 exclusion, `ExclusionLedger`) and `BasketVault` (TWAP NAV,
///         ORA-4, realized-delta mint, proportional sell, `redeemInKind`, emergency unwind), plus the plan state
///         and `executeStep`.
///
///         Authority (RB-1, RB-3):
///         - GOVERNANCE_ROLE (RebalanceGovernance): `setTargetAndOpenPlan`.
///         - REBALANCER_ROLE (Rebalancer): `executeStep`, `concludePlan`.
///           Both are self-administered and granted exactly once by `bindRebalanceRoles`, so no ADMIN_ROLE
///           holder can hand either to another address (the router's WEIGHT_SETTER_ROLE model).
///         - EMERGENCY_ROLE (hot key): the pauses only, `pauseRebalance` and `pauseDeposits`. A pause only
///           delays; one key cannot end the fund or sell its holdings (owner, 2026-11-13).
///         - ADMIN_ROLE (timelock): assets, caps, fees, guards, `resumePlan`, `extendBudget`, `closePlan`,
///           `unpauseDeposits`, `shutdown`, `restore`, `emergencyUnwind`, and every role grant. `shutdown`
///           and `emergencyUnwind` are governed (Safe + timelock delay, owner 2026-11-13): each ends the
///           fund's deposits or sells every holding, so no single hot key holds them. ADMIN carries no upgrade power: only
///           `upgradeTimelock()` upgrades or freezes the proxy.
///         - `redeemInKind` is never gated by plan state or a pause. It reverts `InKindClosed` unless the fund is in
///           wind-down (E29, RB-26). The fund's own `redeem` is closed (E2).
///
///         Size (§6.1, G1): value-moving and validation logic lives in the delegatecall-linked
///         `FundValuationLib`, `FundFlowsLib`, `FundAdminLib` and (step 3d) `FundPositionLib`, which in turn link the existing
///         `TwapTickMath`, `BasketSwaps`, `BasketAssetConfigGuard` and `RobotMoneyVaultOps` (ledger creation).
///         The fund keeps ERC-4626 accounting, roles, plan transitions and lifecycle flags.
///
///         Custody (INV-1): no function sends a protocol asset to a caller-supplied address except the
///         ERC-4626 `receiver` of the caller's own (or allowance-approved) redemption. Swaps pay the fund; USDC
///         leaves only to an allowlisted adapter, the fixed exit-fee recipient, or the exclusion ledger.
contract RobotMoneyFund is
    ERC4626Upgradeable,
    AdminFloorAccessControlCounter,
    ReentrancyGuardUpgradeable,
    GovernedUUPS,
    IRobotMoneyFund
{
    // ─── Roles (FundTypes.Roles) ─────────────────────────────────────────────

    bytes32 public constant ADMIN_ROLE = Roles.ADMIN_ROLE;
    bytes32 public constant EMERGENCY_ROLE = Roles.EMERGENCY_ROLE;
    bytes32 public constant GOVERNANCE_ROLE = Roles.GOVERNANCE_ROLE;
    bytes32 public constant REBALANCER_ROLE = Roles.REBALANCER_ROLE;
    /// @notice The FlowQueue's authority (E1): `mintInKind`, `sellForFlow`, `ledgerCheckpoint`. Bound once.
    bytes32 public constant FLOW_ROLE = Roles.FLOW_ROLE;

    // ═════════════════════════════════════════════════════════════════════════
    //  Initializer (ADR-0014)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Atomic proxy initialization. Validates the BasketVault / RobotMoneyVault parameter ceilings,
    ///         grants ADMIN_ROLE (self-administered) and EMERGENCY_ROLE; GOVERNANCE_ROLE and REBALANCER_ROLE
    ///         are self-administered and bound once later (`bindRebalanceRoles`: the governance and rebalancer
    ///         proxies take the fund address at their own initialization). Creates the fund's `ExclusionLedger` (ADP-2, core 1820) through the
    ///         linked `RobotMoneyVaultOps.createLedger`, so the ledger names this proxy as its only writer.
    function initialize(
        FundInitParams calldata p,
        address upgradeTimelock,
        GovernedUUPS.UpgradeMode mode
    ) external initializer {
        FundDelistLib.initFlows(_s(), p);
        __ERC20_init(p.name, p.symbol);
        __ERC4626_init(IERC20(p.usdc));
        __AccessControl_init();
        __ReentrancyGuard_init();
        __GovernedUUPS_init(upgradeTimelock, mode);

        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _setRoleAdmin(EMERGENCY_ROLE, ADMIN_ROLE);
        _setRoleAdmin(GOVERNANCE_ROLE, GOVERNANCE_ROLE);
        _setRoleAdmin(REBALANCER_ROLE, REBALANCER_ROLE);
        _setRoleAdmin(FLOW_ROLE, FLOW_ROLE);
        _grantRole(ADMIN_ROLE, p.admin);
        _grantRole(EMERGENCY_ROLE, p.emergency);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  ERC-4626 share scale and NAV (§4.2)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice 6, as both vault families (the 10^18 virtual offset makes raw share counts large).
    function decimals() public pure override(ERC4626Upgradeable) returns (uint8) {
        return 6;
    }

    /// @dev 18: the vault families' inflation-attack offset (security-model.md).
    function _decimalsOffset() internal pure override returns (uint8) {
        return 18;
    }

    /// @notice Idle USDC + Σ counted Lending holders' part + Σ active Basket balance × TWAP (§4.2). Never reads
    ///         spot. An excluded Lending adapter (ADP-2) and the position claims of past in-kind exits are not
    ///         counted. Step 3d (E19, §5.9.6): reverts `FeedUnhealthy(index, status)` while a feed is unhealthy (the
    ///         feeds of settlement check 2), and so do `convertToShares` and `convertToAssets`, which read it. A client
    ///         reads `lastGoodNav` then.
    function totalAssets() public view override returns (uint256) {
        return FundValuationLib.navChecked(_s());
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  ERC-4626 entry points (step 3d, E2, proposal §5.9.6): the fund is the share token, not the entry point
    //
    //  The step 3c deposit path (realized TWAP NAV delta mint, deficit-first routing) and the synchronous
    //  `redeem` are removed from the live fund (D10, D11). The frozen baseline under
    //  contracts/test/prototype/baseline/ keeps them. Requests and claims go through the FlowQueue.
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Closed (E2): reverts `UseFlowQueue(flowQueue())`. Deposit through `FlowQueue.requestDeposit`.
    function deposit(uint256, address) public view override returns (uint256) {
        _useQueue();
    }

    /// @notice Closed (E2): reverts `UseFlowQueue(flowQueue())`.
    function mint(uint256, address) public view override returns (uint256) {
        _useQueue();
    }

    /// @notice Closed (E2): reverts `UseFlowQueue(flowQueue())`. Redeem through `FlowQueue.requestRedeem`. In a
    ///         wind-down `redeemInKind` also exits.
    function redeem(uint256, address, address) public view override returns (uint256) {
        _useQueue();
    }

    /// @notice Reverts `UseFlowQueue`: no synchronous price exists for a timed flow (ERC-7540 previews revert).
    ///         `FlowQueue.quoteDeposit` gives the worst case instead (E21).
    function previewDeposit(uint256) public view override returns (uint256) {
        _useQueue();
    }

    /// @notice Reverts `UseFlowQueue` (see `previewDeposit`).
    function previewMint(uint256) public view override returns (uint256) {
        _useQueue();
    }

    /// @notice Reverts `UseFlowQueue` (see `previewDeposit`; `FlowQueue.quoteRedeem`).
    function previewRedeem(uint256) public view override returns (uint256) {
        _useQueue();
    }

    /// @notice 0: the fund's own `deposit` is closed (ERC-4626 requires 0 for a disabled path, never a revert).
    function maxDeposit(address) public pure override returns (uint256) {
        return 0;
    }

    /// @notice 0 (see `maxDeposit`).
    function maxMint(address) public pure override returns (uint256) {
        return 0;
    }

    /// @notice 0: the fund's own `redeem` is closed. `redeemInKind` opens only in wind-down (E29).
    function maxRedeem(address) public pure override returns (uint256) {
        return 0;
    }

    /// @dev Revert `UseFlowQueue` naming the bound queue (address(0) before `bindFlowRole`).
    function _useQueue() private view {
        revert UseFlowQueue(_s().flowQueue);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  In-kind exit (§4.4, §5.9.4, RB-6, RB-13)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Oracle-free, swap-free exit of last resort (§4.4): pro-rata idle and Lending USDC as one leg,
    ///         plus each active Basket token, each net of the exit fee. Open only in wind-down (E29, RB-26), never gated by a pause.
    ///         Asserts the proportion check (check 10, RB-13) inside `FundFlowsLib.payInKind`; pays the lending part in USDC up to
    ///         the period's in-kind allowance and the rest as claims on a share of each position (E9, E20, RB-21);
    ///         refuses a zero `receiver` and survives a venue whose value read reverts (E23). The queue no longer calls it (E29).
    ///         A holder calls it for their own shares, or an approved caller does, and claims are keyed to `receiver`.
    function redeemInKind(uint256 shares, address receiver, address owner) external nonReentrant {
        if (!_s().shutdown) revert InKindClosed();
        if (shares == 0) return;
        address caller = _msgSender();
        if (caller != owner) _spendAllowance(owner, caller, shares);
        uint256 supplyBefore = totalSupply();
        _burn(owner, shares);
        FundFlowsLib.payInKind(_s(), receiver, owner, shares, supplyBefore);
        emit RedeemedInKind(owner, receiver, shares);
    }

    /// @inheritdoc IRobotMoneyFund
    /// @dev Pays only `msg.sender`'s own claim, to the address it names (as an ERC-4626 receiver, INV-1).
    function claimDeferred(uint256 index, address to) external returns (uint256) {
        return _flowAction(FundFlowsLib.FLOW_CLAIM_DEFERRED, index, to);
    }

    function deferredOf(uint256 index, address account) external view returns (uint256) {
        return _s().deferredOf[index][account];
    }

    function deferredTotal(uint256 index) external view returns (uint256) {
        return _s().deferredTotal[index];
    }

    /// @notice Not offered (§4.4): the fund holds inexact positions. Redeem through the FlowQueue.
    function withdraw(uint256, address, address) public pure override returns (uint256) {
        revert RedeemOnly();
    }

    /// @notice Not offered (§4.4).
    function previewWithdraw(uint256) public pure override returns (uint256) {
        revert RedeemOnly();
    }

    /// @notice 0: `withdraw` is not offered (ERC-4626 requires 0 for a disabled path).
    function maxWithdraw(address) public pure override returns (uint256) {
        return 0;
    }

    /// @dev core 1820: once an exclusion record exists, report both pre-change balances to the ledger before
    ///      every mint, burn and transfer, so each holder's claim stays fixed at its balance at exclusion. The
    ///      ledger (`FundExclusionLedger`) reads `ledgerBalanceOf`, so a share the FlowQueue holds counts for its
    ///      owner; the queue checkpoints that owner first through `ledgerCheckpoint` (E13, RB-22).
    ///      E14: the seed shares the fund holds for itself never move (`SeedSharesLocked`). No fund path transfers
    ///      or burns them; this makes that a checked rule rather than an absence.
    function _update(address from, address to, uint256 value) internal override {
        if (from == address(this)) revert SeedSharesLocked();
        RobotMoneyVaultOps.Exclusions storage x = RobotMoneyVaultOps.exclusions();
        if (x.snapshots) x.ledger.checkpoint(from, to);
        super._update(from, to, value);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Step 3d: timed flows (proposal §4.3 to §4.5, §5.9; eng plan E1 to E23)
    //
    //  Real (fund-core, scaffold plan §7.2): `bindFlowRole`, `seed`, `mintInKind`, `sellForFlow`,
    //  `ledgerCheckpoint`, `ledgerBalanceOf`, `heldBalances`, the getters and the two fund-held setters.
    //  Real (fund-extras, §7.4): position units and claims (`positionClaimOf`, `claimPosition`, `positionUnits`),
    //  the in-kind allowance (`setInKindAllowance`, `inKindAllowance`), `lastGoodNav`. No stub is left in the fund.
    // ═════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IRobotMoneyFund
    function bindFlowRole(address queue) external onlyRole(ADMIN_ROLE) {
        FundState storage s = _s();
        if (s.flowRoleBound) revert FlowRoleAlreadyBound();
        if (queue == address(0)) revert ZeroAddress();
        s.flowRoleBound = true;
        s.flowQueue = queue;
        _grantRole(FLOW_ROLE, queue);
        emit FlowRoleBound(queue);
    }

    function flowQueue() external view returns (address) {
        return _s().flowQueue;
    }

    /// @inheritdoc IRobotMoneyFund
    /// @dev Body in `FundFlowsLib.seed`; the shares are minted to the fund itself and never move (`_update`).
    function seed(uint256 usdc)
        external
        onlyRole(ADMIN_ROLE)
        nonReentrant
        returns (uint256 shares)
    {
        shares = FundFlowsLib.seed(_s(), _msgSender(), usdc, totalSupply());
        _mint(address(this), shares);
    }

    /// @inheritdoc IRobotMoneyFund
    /// @dev Body in `FundFlowsLib.mintInKind`, which buys the slice and asserts check 10 against
    ///      `supply + sharesOut`; the mint here moves no asset, so the check still holds after it.
    function mintInKind(uint256 sharesOut, uint256 maxUsdc, uint256[] calldata maxUsdcPerLeg)
        external
        onlyRole(FLOW_ROLE)
        nonReentrant
        returns (uint256 usdcSpent)
    {
        address caller = _msgSender();
        usdcSpent =
            FundFlowsLib.mintInKind(_s(), caller, sharesOut, maxUsdc, maxUsdcPerLeg, totalSupply());
        _mint(caller, sharesOut);
    }

    /// @inheritdoc IRobotMoneyFund
    /// @dev Burn first (before any external call), then `FundFlowsLib.sellForFlow` sells the slice, pays and
    ///      asserts check 10 against `supplyBefore − shares`.
    function sellForFlow(uint256 shares, uint256[] calldata minUsdcPerLeg)
        external
        returns (uint256 usdcOut)
    {
        FundFlowsLib.SellFlowCtx memory ctx;
        ctx.shares = shares;
        return _sellForFlow(ctx, minUsdcPerLeg);
    }

    /// @inheritdoc IRobotMoneyFund
    function sellForFlowGross(uint256 shares, uint256[] calldata minUsdcPerLeg, uint256 claimFeeBps)
        external
        returns (uint256 grossUsdcOut)
    {
        FundFlowsLib.SellFlowCtx memory ctx;
        ctx.shares = shares;
        ctx.feeBps = claimFeeBps;
        ctx.grossOnly = claimFeeBps != type(uint256).max;
        return _sellForFlow(ctx, minUsdcPerLeg);
    }

    /// @inheritdoc IRobotMoneyFund
    function sellForFlowBatch(
        uint256 shares,
        uint256[] calldata minUsdcPerLeg,
        address[] calldata owners,
        uint256[] calldata ownerShares,
        uint16[] calldata ownerFeeBps
    ) external returns (uint256 grossUsdcOut) {
        FundFlowsLib.SellFlowCtx memory ctx;
        ctx.shares = shares;
        ctx.grossOnly = true;
        ctx.batch = true;
        ctx.owners = owners;
        ctx.ownerShares = ownerShares;
        ctx.ownerFeeBps = ownerFeeBps;
        return _sellForFlow(ctx, minUsdcPerLeg);
    }

    function _sellForFlow(FundFlowsLib.SellFlowCtx memory ctx, uint256[] calldata minUsdcPerLeg)
        private
        onlyRole(FLOW_ROLE)
        nonReentrant
        returns (uint256)
    {
        if (ctx.batch) _validateSellBatch(ctx);
        ctx.caller = _msgSender();
        uint256 supplyBefore = totalSupply();
        if (supplyBefore == 0) revert NotSeeded();
        ctx.supplyBefore = supplyBefore;
        _burn(ctx.caller, ctx.shares);
        return FundFlowsLib.sellForFlow(_s(), ctx, minUsdcPerLeg);
    }

    function _validateSellBatch(FundFlowsLib.SellFlowCtx memory ctx) private pure {
        uint256 len = ctx.owners.length;
        if (len == 0 || ctx.ownerShares.length != len || ctx.ownerFeeBps.length != len) {
            revert InvalidParam();
        }
        uint256 sum;
        for (uint256 k; k < len; ++k) {
            if (ctx.owners[k] == address(0)) revert ZeroAddress();
            if (ctx.ownerFeeBps[k] > BPS) revert InvalidParam();
            sum += ctx.ownerShares[k];
        }
        if (sum != ctx.shares) revert InvalidParam();
    }

    /// @inheritdoc IRobotMoneyFund
    function positionClaimOf(uint256 index, address account)
        external
        view
        returns (uint256, uint256)
    {
        return FundPositionLib.claimOf(_s(), index, account);
    }

    /// @inheritdoc IRobotMoneyFund
    function positionUnits(uint256 index)
        external
        view
        returns (uint256 totalUnits, uint256 claimUnits)
    {
        FundState storage s = _s();
        return (s.positionUnits[index], s.positionClaimTotal[index]);
    }

    /// @inheritdoc IRobotMoneyFund
    /// @dev Pays only `msg.sender`'s own claim, to the address it names (as `claimDeferred`, INV-1).
    function claimPosition(uint256 index, address to) external returns (uint256) {
        return _flowAction(FundFlowsLib.FLOW_CLAIM_POSITION, index, to);
    }

    /// @inheritdoc IRobotMoneyFund
    /// @dev The ledger's own `checkpoint(account, 0)`: stores `account`'s `ledgerBalanceOf` as it stands now, once
    ///      per record, before the queue changes it. A no-op until the first record opens (`snapshots`).
    function ledgerCheckpoint(address account) external onlyRole(FLOW_ROLE) {
        RobotMoneyVaultOps.Exclusions storage x = RobotMoneyVaultOps.exclusions();
        if (x.snapshots) x.ledger.checkpoint(account, address(0));
    }

    /// @inheritdoc IRobotMoneyFund
    function ledgerBalanceOf(address account) external view returns (uint256) {
        address q = _s().flowQueue;
        if (account == q) return 0;
        uint256 bal = balanceOf(account);
        return q == address(0) ? bal : bal + IFlowQueue(q).queuedSharesOf(account);
    }

    /// @inheritdoc IRobotMoneyFund
    function heldBalances() external view returns (uint256 idle, uint256[] memory held) {
        return FundValuationLib.heldBalances(_s());
    }

    /// @inheritdoc IRobotMoneyFund
    function lastGoodNav() external view returns (uint256, uint64) {
        return FundValuationLib.lastGoodNav(_s());
    }

    /// @inheritdoc IRobotMoneyFund
    function setInKindAllowance(uint16 bps, uint128 floorUsdc, uint32 period)
        external
        onlyRole(ADMIN_ROLE)
    {
        FundPositionLib.setInKindAllowance(_s(), bps, floorUsdc, period);
    }

    /// @inheritdoc IRobotMoneyFund
    function inKindAllowance() external view returns (uint16, uint128, uint32, uint256) {
        return FundPositionLib.inKindAllowance(_s());
    }

    function minSeedUsdc() external view returns (uint256) {
        return _s().minSeedUsdc;
    }

    function poolShareBps() external view returns (uint16) {
        return _s().poolShareBps;
    }

    /// @inheritdoc IRobotMoneyFund
    function setMinSeedUsdc(uint256 newMin) external {
        _adminOp(FundAdminLib.ADMIN_SET_MIN_SEED_USDC, newMin, address(0));
    }

    /// @inheritdoc IRobotMoneyFund
    function setPoolShareBps(uint16 newBps) external {
        _adminOp(FundAdminLib.ADMIN_SET_POOL_SHARE_BPS, newBps, address(0));
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Plan (§5.1, §5.3, §5.5)
    // ═════════════════════════════════════════════════════════════════════════

    /// @inheritdoc IRobotMoneyFund
    function setTargetAndOpenPlan(
        address[] calldata assets,
        uint256[] calldata bps,
        PlanParams calldata params,
        bytes32 receiptId
    ) external onlyRole(GOVERNANCE_ROLE) returns (uint256 planId) {
        return FundAdminLib.openPlan(_s(), assets, bps, params, receiptId);
    }

    /// @inheritdoc IRobotMoneyFund
    function executeStep(StepOrder calldata order)
        external
        onlyRole(REBALANCER_ROLE)
        nonReentrant
        returns (StepResult memory)
    {
        return FundFlowsLib.executeStep(_s(), order);
    }

    /// @inheritdoc IRobotMoneyFund
    function concludePlan(PlanStatus to) external onlyRole(REBALANCER_ROLE) {
        _plan(FundAdminLib.PlanOp.Conclude, uint256(to));
    }

    /// @inheritdoc IRobotMoneyFund
    function pauseRebalance() external onlyRole(EMERGENCY_ROLE) {
        _plan(FundAdminLib.PlanOp.Pause, 0);
    }

    /// @inheritdoc IRobotMoneyFund
    function resumePlan() external onlyRole(ADMIN_ROLE) {
        _plan(FundAdminLib.PlanOp.Resume, 0);
    }

    /// @inheritdoc IRobotMoneyFund
    function bindRebalanceRoles(address governance, address rebalancer)
        external
        onlyRole(ADMIN_ROLE)
    {
        FundState storage s = _s();
        if (s.rolesBound) revert RolesAlreadyBound();
        if (governance == address(0) || rebalancer == address(0)) revert ZeroAddress();
        s.rolesBound = true;
        s.rebalancer = rebalancer;
        _grantRole(GOVERNANCE_ROLE, governance);
        _grantRole(REBALANCER_ROLE, rebalancer);
        emit RebalanceRolesBound(governance, rebalancer);
    }

    /// @inheritdoc IRobotMoneyFund
    function extendBudget(uint256 addedUsdc) external onlyRole(ADMIN_ROLE) {
        _plan(FundAdminLib.PlanOp.Extend, addedUsdc);
    }

    /// @inheritdoc IRobotMoneyFund
    function closePlan() external onlyRole(ADMIN_ROLE) {
        _plan(FundAdminLib.PlanOp.Close, 0);
    }

    /// @dev Every plan transition (§5.5) runs in `FundAdminLib.planOp` through this one call site (step 3d size
    ///      budget, §6.1). The role is checked by the caller above.
    function _plan(FundAdminLib.PlanOp op, uint256 arg) private {
        FundAdminLib.planOp(_s(), op, arg);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Views (§5.3 inputs for the Rebalancer, §5.7 previews)
    // ═════════════════════════════════════════════════════════════════════════

    function assetCount() external view returns (uint256) {
        return _s().assets.length;
    }

    function assetConfig(uint256 index) external view returns (AssetConfig memory) {
        return _s().assets[index];
    }

    function assetConfigs() external view returns (AssetConfig[] memory) {
        return _s().assets;
    }

    function idleUsdc() external view returns (uint256) {
        return _viewUint(FundValuationLib.VIEW_IDLE_USDC, 0);
    }

    function assetValue(uint256 index) external view returns (uint256) {
        return _viewUint(FundValuationLib.VIEW_ASSET_VALUE, index);
    }

    function portfolioValues()
        external
        view
        returns (uint256 nav, uint256 idle, uint256[] memory values)
    {
        return FundValuationLib.portfolio(_s());
    }

    function assetUsdcValue(uint256 index, uint256 tokenAmount) external view returns (uint256) {
        return FundValuationLib.usdcValue(_s(), index, tokenAmount);
    }

    function assetTokenValue(uint256 index, uint256 usdcAmount) external view returns (uint256) {
        return FundValuationLib.tokenValue(_s(), index, usdcAmount);
    }

    /// @inheritdoc IRobotMoneyFund
    /// @dev Also NOT ok for an excluded Lending asset (ADP-2): it can neither take nor return USDC.
    function marketCheck(uint256 index) external view returns (bool ok, uint256 deviationBps) {
        return FundValuationLib.marketCheck(_s(), index);
    }

    function poolFeeBps(uint256 index) external view returns (uint256) {
        return _viewUint(FundValuationLib.VIEW_POOL_FEE_BPS, index);
    }

    function maxTwapWindow() external view returns (uint32) {
        return uint32(_viewUint(FundValuationLib.VIEW_MAX_TWAP_WINDOW, 0));
    }

    function maxPoolFeeBps() public view returns (uint256 maxBps) {
        return _viewUint(FundValuationLib.VIEW_MAX_POOL_FEE_BPS, 0);
    }

    function navDeviationGuardBps() external view returns (uint256) {
        return _s().navDeviationGuardBps;
    }

    function maxSlippageBps() external view returns (uint256) {
        return _s().maxSlippageBps;
    }

    function plan() external view returns (Plan memory p) {
        p = _s().plan;
        p.status = PlanStatus(_viewUint(FundValuationLib.VIEW_PLAN_STATUS, 0));
    }

    function currentPlanId() external view returns (uint256) {
        return _s().plan.id;
    }

    function planStatus() external view returns (PlanStatus) {
        return PlanStatus(_viewUint(FundValuationLib.VIEW_PLAN_STATUS, 0));
    }

    function lastStepAt() external view returns (uint64) {
        return _s().lastStepAt;
    }

    function targetBps() external view returns (uint16[] memory) {
        return _s().targetBps;
    }

    function pathTarget(uint256 t) external view returns (uint256[] memory bps, uint256 idleBps) {
        return FundValuationLib.pathTarget(_s(), t);
    }

    function currentWeightsBps() external view returns (uint256[] memory bps, uint256 idleBps) {
        return FundValuationLib.currentWeightsBps(_s());
    }

    function depositsPaused() external view returns (bool) {
        FundState storage s = _s();
        return
            s.depositsPaused
                || (s.depositsPausedUntil != 0 && block.timestamp < s.depositsPausedUntil);
    }

    function depositsPausedUntil() external view returns (uint64) {
        return _s().depositsPausedUntil;
    }

    function lastStateStopEndedAt() external view returns (uint64) {
        return _s().lastStateStopEndedAt;
    }

    function isShutdown() external view returns (bool) {
        return _s().shutdown;
    }

    function hasAssetInSale() external view returns (bool) {
        return _viewUint(FundValuationLib.VIEW_HAS_ASSET_IN_SALE, 0) != 0;
    }

    function isAssetInSale(uint256 index) external view returns (bool) {
        return _s().inSale[index];
    }

    function saleFallbackPrice(uint256 index) external view returns (uint256) {
        return _s().saleFallbackPrice[index];
    }

    function rebalancer() external view returns (address) {
        return _s().rebalancer;
    }

    function minPoolDepthUsdc() external view returns (uint256) {
        return _s().minPoolDepthUsdc;
    }

    function feeMarginBps() external view returns (uint256) {
        return _s().feeMarginBps;
    }

    function delistBandBps() external view returns (uint256) {
        return _s().delistBandBps;
    }

    function delistBudgetBps() external view returns (uint256) {
        return _s().delistBudgetBps;
    }

    function maxBasketBps() external view returns (uint256) {
        return _s().maxBasketBps;
    }

    function maxPause() external view returns (uint32) {
        return uint32(_viewUint(FundValuationLib.VIEW_MAX_PAUSE, 0));
    }

    function rebalancePausedUntil() external view returns (uint64) {
        return _s().rebalancePausedUntil;
    }

    function rebalancePauseCooldownUntil() external view returns (uint64) {
        return _s().rebalancePauseCooldownUntil;
    }

    function positionClaimTotal(uint256 index) external view returns (uint256) {
        return _s().positionClaimTotal[index];
    }

    /// @inheritdoc IRobotMoneyFund
    function config()
        external
        view
        returns (uint256 tvlCap, uint256 perDepositCap, uint256 exitFeeBps, address feeRecipient)
    {
        FundState storage s = _s();
        return (s.tvlCap, s.perDepositCap, s.exitFeeBps, s.feeRecipient);
    }

    /// @inheritdoc IRobotMoneyFund
    function adapterCodeHashAllowed(bytes32 codeHash) external view returns (bool) {
        return _s().codeHashAllowed[codeHash];
    }

    /// @inheritdoc IRobotMoneyFund
    /// @dev The ledger is the core 1820 `ExclusionLedger`, created by `RobotMoneyVaultOps.createLedger`.
    function exclusionLedger() external view returns (address) {
        return address(RobotMoneyVaultOps.exclusions().ledger);
    }

    /// @inheritdoc IRobotMoneyFund
    function openExclusionOf(uint256 index) external view returns (uint256) {
        return RobotMoneyVaultOps.exclusions().openExclusionOf[index];
    }

    /// @inheritdoc IRobotMoneyFund
    /// @dev Also read by the `ExclusionLedger`.
    function quarantineAddress() external pure returns (address) {
        return ForeignTokenQuarantine.QUARANTINE;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Admin: assets (ADMIN_ROLE; frozen while a plan is live)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Allow or revoke an adapter runtime code hash (ADP-2 / NC-2). Revoking excludes every active
    ///         Lending asset that runs it: its balance leaves NAV and an exclusion record opens with a snapshot
    ///         of the share supply, so anything later recovered belongs to the holders of that moment (core
    ///         1820). Re-allowing drains the adapter into its record, closes it, and the empty entry counts
    ///         again. Basket assets are not touched retroactively (as on BasketVault).
    /// @dev Deliberately NOT frozen by a live plan: excluding a bad adapter must never wait for a plan to end.
    ///      Indices are untouched, so plan arrays stay aligned.
    function setAdapterCodeHashAllowed(bytes32 codeHash, bool allowed)
        external
        onlyRole(ADMIN_ROLE)
        nonReentrant
    {
        if (codeHash == bytes32(0)) revert InvalidParam();
        _s().codeHashAllowed[codeHash] = allowed;
        emit AdapterCodeHashAllowedSet(codeHash, allowed);
        FundAdminLib.syncExclusions(_s(), totalSupply(), allowed);
    }

    /// @inheritdoc IRobotMoneyFund
    function addAsset(AssetConfig calldata c)
        external
        onlyRole(ADMIN_ROLE)
        returns (uint256 index)
    {
        return FundAdminLib.addAsset(_s(), c);
    }

    /// @inheritdoc IRobotMoneyFund
    function deactivateAsset(uint256 index) external {
        _adminOp(FundAdminLib.ADMIN_DEACTIVATE_ASSET, index, address(0));
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Admin: caps, fees, guards
    // ═════════════════════════════════════════════════════════════════════════

    function setTvlCap(uint256 newCap) external {
        _adminOp(FundAdminLib.ADMIN_SET_TVL_CAP, newCap, address(0));
    }

    function setPerDepositCap(uint256 newCap) external {
        _adminOp(FundAdminLib.ADMIN_SET_PER_DEPOSIT_CAP, newCap, address(0));
    }

    function setExitFeeBps(uint256 newBps) external {
        _adminOp(FundAdminLib.ADMIN_SET_EXIT_FEE_BPS, newBps, address(0));
    }

    function setFeeRecipient(address newRecipient) external {
        _adminOp(FundAdminLib.ADMIN_SET_FEE_RECIPIENT, 0, newRecipient);
    }

    /// @notice ≤ 500 and strictly above every active Basket pool fee (§5.6: a floor at or below the pool fee
    ///         would fail every swap; BasketVault L-17).
    function setMaxSlippageBps(uint256 newBps) external {
        _adminOp(FundAdminLib.ADMIN_SET_MAX_SLIPPAGE_BPS, newBps, address(0));
    }

    /// @notice 0 (ORA-4 off), or strictly above every active Basket pool fee and ≤ 2 000.
    function setNavDeviationGuardBps(uint256 newBps) external {
        _adminOp(FundAdminLib.ADMIN_SET_NAV_DEV_GUARD_BPS, newBps, address(0));
    }

    function setMinPoolDepthUsdc(uint256 newMin) external {
        _adminOp(FundAdminLib.ADMIN_SET_MIN_POOL_DEPTH_USDC, newMin, address(0));
    }

    function setFeeMarginBps(uint256 newBps) external {
        _adminOp(FundAdminLib.ADMIN_SET_FEE_MARGIN_BPS, newBps, address(0));
    }

    function setDelistBandBps(uint256 newBps) external {
        _adminOp(FundAdminLib.ADMIN_SET_DELIST_BAND_BPS, newBps, address(0));
    }

    function setDelistBudgetBps(uint256 newBps) external {
        _adminOp(FundAdminLib.ADMIN_SET_DELIST_BUDGET_BPS, newBps, address(0));
    }

    function setMaxBasketBps(uint256 newBps) external {
        _adminOp(FundAdminLib.ADMIN_SET_MAX_BASKET_BPS, newBps, address(0));
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Lifecycle & Delisting (§6, §5.11.5, E29, E38, E39, E50, E53, E54)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Block deposit and mint via self-expiring emergency pause (renewable, no cooldown, E39).
    function pauseDeposits() external {
        _adminOp(FundAdminLib.ADMIN_PAUSE_DEPOSITS, 0, address(0));
    }

    function unpauseDeposits() external {
        _adminOp(FundAdminLib.ADMIN_UNPAUSE_DEPOSITS, 0, address(0));
    }

    /// @notice Enter WindDown (`shutdown = true`, `tvlCap = 0`), pause live plan, and notify queue to checkpoint &
    ///         release escrow. `redeemInKind` opens. ADMIN_ROLE only.
    function shutdown() external {
        _adminOp(FundAdminLib.ADMIN_SHUTDOWN, 0, address(0));
    }

    /// @notice Reverse `shutdown` with a fresh non-zero cap at or above `perDepositCap` (BasketVault.restoreVault).
    function restore(uint256 newTvlCap) external {
        _adminOp(FundAdminLib.ADMIN_RESTORE, newTvlCap, address(0));
    }

    /// @notice Pause deposits, move every holding to idle USDC (`FundFlowsLib.flowAction`), and pause live plan.
    function emergencyUnwind() external {
        _flowAction(FundFlowsLib.FLOW_EMERGENCY_UNWIND, 0, address(0));
    }

    /// @inheritdoc IRobotMoneyFund
    function emergencyUnwind(uint256 index) external returns (uint256 recoveredUsdc) {
        return _flowAction(FundFlowsLib.FLOW_EMERGENCY_UNWIND_ASSET, index, address(0));
    }

    /// @inheritdoc IRobotMoneyFund
    function delistAsset(uint256 index) external {
        _adminOp(FundAdminLib.ADMIN_DELIST_ASSET, index, address(0));
    }

    /// @inheritdoc IRobotMoneyFund
    function executeDelistStep(uint256 index, uint256 maxUsdcNotional)
        external
        onlyRole(REBALANCER_ROLE)
        nonReentrant
        returns (bool executed, uint256 tokensSold, uint256 usdcReceived)
    {
        return FundFlowsLib.executeDelistStep(_s(), index, maxUsdcNotional);
    }

    /// @inheritdoc IRobotMoneyFund
    function settleClaim(uint256 index, address owner) external returns (uint256 netUsdc) {
        return _flowAction(FundFlowsLib.FLOW_SETTLE_CLAIM, index, owner);
    }

    /// @notice Permissionless: send a non-protected token's whole balance to the fixed quarantine address
    ///         (INV-1/INV-2; no caller-chosen destination). Protected (`ProtectedToken`): USDC, the share token,
    ///         every asset token (active or not), and every Lending adapter address (an adapter that is itself
    ///         a share token).
    function sweepForeignToken(address token) external {
        _flowAction(FundFlowsLib.FLOW_SWEEP_FOREIGN, 0, token);
    }

    // ─── Consolidated DELEGATECALL dispatchers & Storage ─────────────────────

    function _viewUint(uint8 op, uint256 index) private view returns (uint256) {
        return FundValuationLib.viewUint(_s(), op, index);
    }

    function _adminOp(uint8 op, uint256 val, address addr) private nonReentrant {
        _checkRole(op == FundAdminLib.ADMIN_PAUSE_DEPOSITS ? EMERGENCY_ROLE : ADMIN_ROLE);
        FundAdminLib.adminOp(_s(), op, val, addr, _msgSender());
    }

    function _flowAction(uint8 op, uint256 index, address addr)
        private
        nonReentrant
        returns (uint256)
    {
        if (
            op == FundFlowsLib.FLOW_EMERGENCY_UNWIND
                || op == FundFlowsLib.FLOW_EMERGENCY_UNWIND_ASSET
        ) {
            _checkRole(ADMIN_ROLE);
        }
        return FundFlowsLib.flowAction(_s(), op, index, addr, _msgSender());
    }

    function _s() private pure returns (FundState storage) {
        return FundStorage.layout();
    }
}
