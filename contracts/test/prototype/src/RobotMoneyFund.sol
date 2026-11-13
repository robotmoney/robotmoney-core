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
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {GovernedUUPS} from "../../../lib/GovernedUUPS.sol";
import {AdminFloorAccessControlCounter} from "../../../lib/AdminFloorAccessControlCounter.sol";
import {ForeignTokenQuarantine} from "../../../lib/ForeignTokenQuarantine.sol";
import {RobotMoneyVaultOps} from "../../../lib/RobotMoneyVaultOps.sol";
import {
    AssetConfig,
    FundInitParams,
    Plan,
    PlanParams,
    PlanStatus,
    Roles,
    StepOrder,
    StepResult,
    BPS,
    MIN_MIN_SEED_USDC,
    MAX_MIN_SEED_USDC,
    MAX_POOL_SHARE_BPS
} from "./FundTypes.sol";
import {IRobotMoneyFund} from "./interfaces/IRobotMoneyFund.sol";
import {IFlowQueue} from "./interfaces/IFlowQueue.sol";
import {FundState, FundStorage} from "./lib/FundStorage.sol";
import {FundValuationLib} from "./lib/FundValuationLib.sol";
import {FundFlowsLib} from "./lib/FundFlowsLib.sol";
import {FundAdminLib} from "./lib/FundAdminLib.sol";
import {FundPositionLib} from "./lib/FundPositionLib.sol";

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
///         - EMERGENCY_ROLE (hot key): `pauseRebalance`, `pauseDeposits`, `shutdown`, `emergencyUnwind`.
///         - ADMIN_ROLE (timelock): assets, caps, fees, guards, `resumePlan`, `extendBudget`, `closePlan`,
///           `unpauseDeposits`, `restore`, and every role grant. ADMIN carries no upgrade power: only
///           `upgradeTimelock()` upgrades or freezes the proxy.
///         - `redeem` and `redeemInKind` are never gated by plan state, pause or shutdown (RB-6).
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
    using Math for uint256;

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
        if (
            p.usdc == address(0) || p.feeRecipient == address(0) || p.admin == address(0)
                || p.emergency == address(0)
        ) {
            revert ZeroAddress();
        }
        if (
            p.exitFeeBps > FundStorage.MAX_EXIT_FEE_BPS
                || p.maxSlippageBps > FundStorage.MAX_SLIPPAGE_BPS || p.maxSlippageBps == 0
                || p.navDeviationGuardBps > FundStorage.MAX_NAV_DEVIATION_BPS
        ) revert InvalidParam();
        __ERC20_init(p.name, p.symbol);
        __ERC4626_init(IERC20(p.usdc));
        __AccessControl_init();
        __ReentrancyGuard_init();
        __GovernedUUPS_init(upgradeTimelock, mode);

        FundState storage s = _s();
        s.usdc = p.usdc;
        s.tvlCap = p.tvlCap;
        s.perDepositCap = p.perDepositCap;
        s.exitFeeBps = p.exitFeeBps;
        s.feeRecipient = p.feeRecipient;
        s.maxSlippageBps = p.maxSlippageBps;
        s.navDeviationGuardBps = p.navDeviationGuardBps;

        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _setRoleAdmin(EMERGENCY_ROLE, ADMIN_ROLE);
        _setRoleAdmin(GOVERNANCE_ROLE, GOVERNANCE_ROLE);
        _setRoleAdmin(REBALANCER_ROLE, REBALANCER_ROLE);
        _setRoleAdmin(FLOW_ROLE, FLOW_ROLE);
        _grantRole(ADMIN_ROLE, p.admin);
        _grantRole(EMERGENCY_ROLE, p.emergency);

        // Step 3d defaults the fund holds (minSeedUsdc, poolShareBps, the in-kind allowance), then the ledger.
        FundAdminLib.initFlows(s, p.usdc);
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

    /// @notice Closed (E2): reverts `UseFlowQueue(flowQueue())`. Redeem through `FlowQueue.requestRedeem`, or
    ///         exit at once in kind with `redeemInKind`.
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

    /// @notice 0: the fund's own `redeem` is closed. `redeemInKind` stays open.
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
    ///         plus each active Basket token, each net of the exit fee. Never gated (RB-6). Step 3d: asserts the
    ///         proportion check (check 10, RB-13) inside `FundFlowsLib.payInKind`; pays the lending part in USDC up to
    ///         the period's in-kind allowance and the rest as claims on a share of each position (E9, E20, RB-21);
    ///         refuses a zero `receiver` and survives a venue whose value read reverts (E23). The FlowQueue calls it
    ///         with `owner == queue` and `receiver` = the request's owner for escrowed shares (`exitInKind`,
    ///         `takeReturn`); then `caller == owner`, so no allowance is spent, and claims are keyed to `receiver`.
    function redeemInKind(uint256 shares, address receiver, address owner) external nonReentrant {
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
    function claimDeferred(uint256 index, address to) external nonReentrant returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        return FundFlowsLib.claimDeferred(_s(), index, _msgSender(), to);
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
        onlyRole(FLOW_ROLE)
        nonReentrant
        returns (uint256 usdcOut)
    {
        address caller = _msgSender();
        uint256 supplyBefore = totalSupply();
        if (supplyBefore == 0) revert NotSeeded();
        _burn(caller, shares);
        return FundFlowsLib.sellForFlow(_s(), caller, shares, minUsdcPerLeg, supplyBefore);
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
    function claimPosition(uint256 index, address to) external nonReentrant returns (uint256) {
        return FundPositionLib.claimPosition(_s(), index, _msgSender(), to);
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
    function setMinSeedUsdc(uint256 newMin) external onlyRole(ADMIN_ROLE) {
        if (newMin < MIN_MIN_SEED_USDC || newMin > MAX_MIN_SEED_USDC) revert InvalidParam();
        _s().minSeedUsdc = newMin;
        emit MinSeedUsdcSet(newMin);
    }

    /// @inheritdoc IRobotMoneyFund
    function setPoolShareBps(uint16 newBps) external onlyRole(ADMIN_ROLE) {
        FundAdminLib.setLimit(_s(), true, newBps);
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
        return IERC20(_s().usdc).balanceOf(address(this));
    }

    function assetValue(uint256 index) external view returns (uint256) {
        return FundValuationLib.assetValue(_s(), index);
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
        return FundValuationLib.poolFeeBps(_s(), index);
    }

    function maxTwapWindow() external view returns (uint32) {
        return FundValuationLib.maxTwapWindow(_s());
    }

    function maxPoolFeeBps() public view returns (uint256 maxBps) {
        (maxBps,) = FundValuationLib.maxPoolFeeBps(_s());
    }

    function navDeviationGuardBps() external view returns (uint256) {
        return _s().navDeviationGuardBps;
    }

    function maxSlippageBps() external view returns (uint256) {
        return _s().maxSlippageBps;
    }

    function plan() external view returns (Plan memory) {
        return _s().plan;
    }

    function currentPlanId() external view returns (uint256) {
        return _s().plan.id;
    }

    function planStatus() external view returns (PlanStatus) {
        return _s().plan.status;
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
        return _s().depositsPaused;
    }

    function isShutdown() external view returns (bool) {
        return _s().shutdown;
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
    function deactivateAsset(uint256 index) external onlyRole(ADMIN_ROLE) {
        FundAdminLib.deactivateAsset(_s(), index);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Admin: caps, fees, guards
    // ═════════════════════════════════════════════════════════════════════════

    function setTvlCap(uint256 newCap) external onlyRole(ADMIN_ROLE) {
        FundAdminLib.setLimit(_s(), false, newCap);
    }

    function setPerDepositCap(uint256 newCap) external onlyRole(ADMIN_ROLE) {
        _s().perDepositCap = newCap;
    }

    function setExitFeeBps(uint256 newBps) external onlyRole(ADMIN_ROLE) {
        if (newBps > FundStorage.MAX_EXIT_FEE_BPS) revert InvalidParam();
        _s().exitFeeBps = newBps;
    }

    function setFeeRecipient(address newRecipient) external onlyRole(ADMIN_ROLE) {
        if (newRecipient == address(0)) revert ZeroAddress();
        _s().feeRecipient = newRecipient;
    }

    /// @notice ≤ 500 and strictly above every active Basket pool fee (§5.6: a floor at or below the pool fee
    ///         would fail every swap; BasketVault L-17).
    function setMaxSlippageBps(uint256 newBps) external onlyRole(ADMIN_ROLE) {
        if (newBps > FundStorage.MAX_SLIPPAGE_BPS) revert InvalidParam();
        FundValuationLib.requireAboveFees(_s(), newBps);
        _s().maxSlippageBps = newBps;
    }

    /// @notice 0 (ORA-4 off), or strictly above every active Basket pool fee and ≤ 2 000.
    function setNavDeviationGuardBps(uint256 newBps) external onlyRole(ADMIN_ROLE) {
        if (newBps > FundStorage.MAX_NAV_DEVIATION_BPS) revert InvalidParam();
        if (newBps != 0) FundValuationLib.requireAboveFees(_s(), newBps);
        _s().navDeviationGuardBps = newBps;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Lifecycle (§6: both vault families)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Block deposit and mint. Redeems stay open (core 1494, RB-6).
    function pauseDeposits() external onlyRole(EMERGENCY_ROLE) {
        _setDepositsPaused(true);
    }

    function unpauseDeposits() external onlyRole(ADMIN_ROLE) {
        _setDepositsPaused(false);
    }

    /// @notice Deposits closed and `tvlCap` 0 until ADMIN `restore`. Redeems stay open.
    function shutdown() external onlyRole(EMERGENCY_ROLE) {
        FundState storage s = _s();
        s.shutdown = true;
        s.tvlCap = 0;
        emit Shutdown();
    }

    /// @notice Reverse `shutdown` with a fresh non-zero cap at or above `perDepositCap` (BasketVault.restoreVault).
    function restore(uint256 newTvlCap) external onlyRole(ADMIN_ROLE) {
        FundState storage s = _s();
        if (!s.shutdown || newTvlCap == 0 || s.perDepositCap > newTvlCap) revert InvalidParam();
        s.shutdown = false;
        s.tvlCap = newTvlCap;
        emit Restored(newTvlCap);
    }

    /// @notice Pause deposits, move every holding to idle USDC (`FundFlowsLib.emergencyUnwind`: Lending drained
    ///         tolerant of failure, excluded adapters drained into their exclusion record, Basket sold under the
    ///         TWAP floor), and pause an Open or Halted plan so the Rebalancer stops (it would otherwise buy
    ///         back, including after a queued `extendBudget` lands).
    /// @dev Differs from BasketVault: there is no configured per-token floor or override path. A Basket leg
    ///      whose TWAP read fails is skipped and stays held; holders still exit it through `redeemInKind`.
    function emergencyUnwind() external onlyRole(EMERGENCY_ROLE) nonReentrant {
        _setDepositsPaused(true);
        uint256 recovered = FundFlowsLib.emergencyUnwind(_s());
        _plan(FundAdminLib.PlanOp.UnwindPause, 0);
        emit EmergencyUnwound(recovered);
    }

    /// @notice Permissionless: send a non-protected token's whole balance to the fixed quarantine address
    ///         (INV-1/INV-2; no caller-chosen destination). Protected (`ProtectedToken`): USDC, the share token,
    ///         every asset token (active or not), and every Lending adapter address (an adapter that is itself
    ///         a share token).
    function sweepForeignToken(address token) external nonReentrant {
        FundFlowsLib.sweepForeign(_s(), token, _msgSender());
    }

    function _setDepositsPaused(bool paused) private {
        FundState storage s = _s();
        if (s.depositsPaused == paused) return;
        s.depositsPaused = paused;
        if (paused) emit DepositsPaused(_msgSender());
        else emit DepositsUnpaused(_msgSender());
    }

    // ─── Storage ─────────────────────────────────────────────────────────────

    function _s() private pure returns (FundState storage) {
        return FundStorage.layout();
    }
}
