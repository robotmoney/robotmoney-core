// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4 (target architecture), §4.1-§4.4 (asset targets, NAV,
//            deposits, redemptions), §5.1 (plan open), §5.3 (executeStep), §5.5 (plan states), §6 (contract
//            changes), §6.1 (size), §7 (RB-1, RB-3, RB-4, RB-5, RB-6, RB-7)
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
// FROZEN BASELINE (one-vault scaffold, 2026-11-11): a copy of the step 3c synchronous fund and its tests. Never edit.
// It is the sim's synchronous arm and the target of the baseline attack tests. The live tree is contracts/test/prototype/src.
pragma solidity ^0.8.24;

import {
    ERC4626Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {
    ReentrancyGuardUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {GovernedUUPS} from "../../../../lib/GovernedUUPS.sol";
import {AdminFloorAccessControlCounter} from "../../../../lib/AdminFloorAccessControlCounter.sol";
import {ForeignTokenQuarantine} from "../../../../lib/ForeignTokenQuarantine.sol";
import {RobotMoneyVaultOps} from "../../../../lib/RobotMoneyVaultOps.sol";
import {
    AssetConfig,
    FundInitParams,
    Plan,
    PlanParams,
    PlanStatus,
    Roles,
    StepOrder,
    StepResult,
    BPS
} from "./FundTypes.sol";
import {IRobotMoneyFund} from "./interfaces/IRobotMoneyFund.sol";
import {FundState, FundStorage} from "./lib/FundStorage.sol";
import {FundValuationLib} from "./lib/FundValuationLib.sol";
import {FundFlowsLib} from "./lib/FundFlowsLib.sol";
import {FundAdminLib} from "./lib/FundAdminLib.sol";

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
///         `FundValuationLib`, `FundFlowsLib` and `FundAdminLib`, which in turn link the existing
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

    // ═════════════════════════════════════════════════════════════════════════
    //  Initializer (ADR-0014)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Atomic proxy initialization. Validates the BasketVault / RobotMoneyVault parameter ceilings,
    ///         grants ADMIN_ROLE (self-administered) and EMERGENCY_ROLE; GOVERNANCE_ROLE and REBALANCER_ROLE
    ///         are self-administered and bound once later (`bindRebalanceRoles`: the governance and rebalancer
    ///         proxies take the fund address at their own initialization). Creates the fund's `ExclusionLedger` (ADP-2, core 1820) through the
    ///         linked `RobotMoneyVaultOps.createLedger`, so the ledger names this proxy as its only writer.
    function initialize(FundInitParams calldata p, address upgradeTimelock, GovernedUUPS.UpgradeMode mode)
        external
        initializer
    {
        if (p.usdc == address(0) || p.feeRecipient == address(0) || p.admin == address(0) || p.emergency == address(0))
        {
            revert ZeroAddress();
        }
        if (
            p.exitFeeBps > FundStorage.MAX_EXIT_FEE_BPS || p.maxSlippageBps > FundStorage.MAX_SLIPPAGE_BPS
                || p.maxSlippageBps == 0 || p.navDeviationGuardBps > FundStorage.MAX_NAV_DEVIATION_BPS
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
        _grantRole(ADMIN_ROLE, p.admin);
        _grantRole(EMERGENCY_ROLE, p.emergency);

        RobotMoneyVaultOps.createLedger(IERC20(p.usdc));
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

    /// @notice Idle USDC + Σ counted Lending `adapter.totalAssets()` + Σ active Basket balance × TWAP (§4.2).
    ///         Never reads spot. An excluded Lending adapter (ADP-2) is not counted.
    function totalAssets() public view override returns (uint256) {
        return FundValuationLib.nav(_s());
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Deposit (§4.3)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Deposit `assets` USDC; returns the shares ACTUALLY minted on the realized TWAP NAV delta
    ///         (AZ-BSK-1/-2/-3). See `_depositFlow`.
    function deposit(uint256 assets, address receiver) public override returns (uint256) {
        return _depositFlow(assets, receiver);
    }

    /// @notice Mint at least `shares`: charges `previewMint(shares)` (grossed up by `maxSlippageBps`) and runs
    ///         the deposit path, which mints on the realized delta and may mint more than `shares`. Returns
    ///         the USDC charged.
    function mint(uint256 shares, address receiver) public override returns (uint256 assets) {
        assets = previewMint(shares);
        _depositFlow(assets, receiver);
    }

    /// @dev The one deposit path (§4.3): `FundFlowsLib.deposit` runs the gates (pause, shutdown, per-deposit
    ///      cap, ADP-2 exclusion, ORA-4, TVL cap), pulls and routes the USDC deficit-first, and returns the
    ///      shares for the REALIZED TWAP NAV delta (`DepositBelowSlippageFloor` below the floor; denominator
    ///      `navBefore + 1`, AZ-BSK-1/-3). The fund mints them.
    function _depositFlow(uint256 assets, address receiver) private nonReentrant returns (uint256 shares) {
        address caller = _msgSender();
        shares = FundFlowsLib.deposit(_s(), caller, assets, totalSupply());
        _mint(receiver, shares);
        emit Deposit(caller, receiver, assets, shares);
    }

    /// @notice Floor on shares for `assets` (`BasketVault.previewDeposit`): converts
    ///         `assets × (1 − maxSlippageBps)`. Reverts on ORA-4 (and while a Lending asset is excluded),
    ///         as `deposit` would.
    function previewDeposit(uint256 assets) public view override returns (uint256) {
        FundValuationLib.requireDepositable(_s());
        return _depositFloor(assets);
    }

    /// @notice Worst-case USDC to mint `shares`: the raw NAV grossed up by `1 / (1 − maxSlippageBps)`, rounded
    ///         up (BasketVault H-1: `mint` never undercharges against `deposit`).
    function previewMint(uint256 shares) public view override returns (uint256) {
        uint256 gross = _convertToAssets(shares, Math.Rounding.Ceil);
        return gross.mulDiv(BPS, BPS - _s().maxSlippageBps, Math.Rounding.Ceil);
    }

    /// @notice 0 while paused, shut down or a Lending asset is excluded; else min(perDepositCap, TVL headroom).
    function maxDeposit(address) public view override returns (uint256) {
        FundState storage s = _s();
        if (s.depositsPaused || s.shutdown || FundValuationLib.anyExcluded(s)) return 0;
        uint256 current = totalAssets();
        if (current >= s.tvlCap) return 0;
        uint256 room = s.tvlCap - current;
        return s.perDepositCap < room ? s.perDepositCap : room;
    }

    /// @notice `maxDeposit` through the slippage-discounted share floor (never reverts).
    function maxMint(address receiver) public view override returns (uint256) {
        return _depositFloor(maxDeposit(receiver));
    }

    function _depositFloor(uint256 assets) private view returns (uint256) {
        return _convertToShares(assets.mulDiv(BPS - _s().maxSlippageBps, BPS), Math.Rounding.Floor);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Redeem (§4.4, RB-6)
    // ═════════════════════════════════════════════════════════════════════════

    /// @notice Burn `shares` of `owner` and pay `receiver` the realized pro-rata proceeds of every holding net
    ///         of the exit fee (§4.4). Never gated by plan state, pause or shutdown (RB-6): it reads no plan
    ///         state and no ORA-4 band. Returns the USDC actually paid (AZ-BSK-2).
    /// @dev Burn before any external call (BasketVault `_withdraw` order). `FundFlowsLib.sellProportional`
    ///      withdraws pro rata from each counted Lending adapter (a short fill pays what was realized) and sells
    ///      pro rata of each Basket token under the TWAP × (1 − maxSlippageBps) floor. The exit fee is charged on
    ///      the realized gross only (FEE-2 / NC-11).
    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256) {
        if (shares == 0) return 0;
        address caller = _msgSender();
        if (caller != owner) _spendAllowance(owner, caller, shares);
        uint256 supplyBefore = totalSupply();
        _burn(owner, shares);
        uint256 net = FundFlowsLib.redeemPayout(_s(), owner, receiver, shares, supplyBefore);
        emit Withdraw(caller, receiver, owner, net, shares);
        return net;
    }

    /// @notice Oracle-free, swap-free exit of last resort (§4.4): pro-rata idle and Lending USDC as one leg,
    ///         plus each active Basket token, each net of the exit fee. Never gated (RB-6).
    function redeemInKind(uint256 shares, address receiver, address owner) external nonReentrant {
        if (shares == 0) return;
        address caller = _msgSender();
        if (caller != owner) _spendAllowance(owner, caller, shares);
        uint256 supplyBefore = totalSupply();
        _burn(owner, shares);
        FundFlowsLib.payInKind(_s(), receiver, shares, supplyBefore);
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

    /// @notice Worst case: TWAP gross × (1 − maxSlippageBps) × (1 − exitFeeBps) (BasketVault.previewRedeem).
    function previewRedeem(uint256 shares) public view override returns (uint256) {
        FundState storage s = _s();
        uint256 afterSlip = _convertToAssets(shares, Math.Rounding.Floor).mulDiv(BPS - s.maxSlippageBps, BPS);
        return afterSlip - afterSlip.mulDiv(s.exitFeeBps, BPS);
    }

    /// @notice Not offered (§4.4): the fund holds inexact positions. Use `redeem`.
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
    ///      every mint, burn and transfer, so each holder's claim stays fixed at its balance at exclusion.
    function _update(address from, address to, uint256 value) internal override {
        RobotMoneyVaultOps.Exclusions storage x = RobotMoneyVaultOps.exclusions();
        if (x.snapshots) x.ledger.checkpoint(from, to);
        super._update(from, to, value);
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
        Plan storage p = _s().plan;
        bool timeOk = (to == PlanStatus.Converged && block.timestamp >= p.endTime)
            || (to == PlanStatus.Expired && block.timestamp > p.endTime);
        if (!timeOk) revert InvalidPlanTransition(p.id, p.status, to);
        _move(PlanStatus.Open, to);
    }

    /// @inheritdoc IRobotMoneyFund
    function pauseRebalance() external onlyRole(EMERGENCY_ROLE) {
        PlanStatus st = _s().plan.status;
        _move(st == PlanStatus.Halted ? PlanStatus.Halted : PlanStatus.Open, PlanStatus.Paused);
    }

    /// @inheritdoc IRobotMoneyFund
    function resumePlan() external onlyRole(ADMIN_ROLE) {
        Plan storage p = _s().plan;
        _move(PlanStatus.Paused, p.costSpent > p.costBudget ? PlanStatus.Halted : PlanStatus.Open);
    }

    /// @inheritdoc IRobotMoneyFund
    function bindRebalanceRoles(address governance, address rebalancer) external onlyRole(ADMIN_ROLE) {
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
        Plan storage p = _s().plan;
        PlanStatus st = p.status;
        if (!_isLive(st)) revert InvalidPlanTransition(p.id, st, st);
        uint256 budget = p.costBudget + addedUsdc;
        p.costBudget = budget;
        emit PlanBudgetExtended(p.id, addedUsdc, budget);
        if (st == PlanStatus.Halted && p.costSpent <= budget) _move(PlanStatus.Halted, PlanStatus.Open);
    }

    /// @inheritdoc IRobotMoneyFund
    function closePlan() external onlyRole(ADMIN_ROLE) {
        PlanStatus st = _s().plan.status;
        if (!_isLive(st)) revert InvalidPlanTransition(_s().plan.id, st, PlanStatus.Superseded);
        _move(st, PlanStatus.Superseded);
    }

    /// @dev One plan transition `from → to` (§5.5), with exactly one `PlanStatusChanged`.
    function _move(PlanStatus from, PlanStatus to) private {
        Plan storage p = _s().plan;
        if (p.status != from) revert InvalidPlanTransition(p.id, p.status, to);
        p.status = to;
        emit PlanStatusChanged(p.id, from, to);
    }

    function _isLive(PlanStatus st) private pure returns (bool) {
        return st == PlanStatus.Open || st == PlanStatus.Halted || st == PlanStatus.Paused;
    }

    function _requireNoLivePlan() private view {
        Plan storage p = _s().plan;
        if (_isLive(p.status)) revert PlanLive(p.id);
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

    function portfolioValues() external view returns (uint256 nav, uint256 idle, uint256[] memory values) {
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

    function currentTargetBps() external view returns (uint256[] memory) {
        return FundValuationLib.currentTargetBps(_s());
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
    function config() external view returns (uint256 tvlCap, uint256 perDepositCap, uint256 exitFeeBps, address feeRecipient) {
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
    function setAdapterCodeHashAllowed(bytes32 codeHash, bool allowed) external onlyRole(ADMIN_ROLE) nonReentrant {
        if (codeHash == bytes32(0)) revert InvalidParam();
        _s().codeHashAllowed[codeHash] = allowed;
        emit AdapterCodeHashAllowedSet(codeHash, allowed);
        FundAdminLib.syncExclusions(_s(), totalSupply(), allowed);
    }

    /// @inheritdoc IRobotMoneyFund
    function addAsset(AssetConfig calldata c) external onlyRole(ADMIN_ROLE) returns (uint256 index) {
        _requireNoLivePlan();
        return FundAdminLib.addAsset(_s(), c);
    }

    /// @inheritdoc IRobotMoneyFund
    function deactivateAsset(uint256 index) external onlyRole(ADMIN_ROLE) {
        _requireNoLivePlan();
        FundAdminLib.deactivateAsset(_s(), index);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  Admin: caps, fees, guards
    // ═════════════════════════════════════════════════════════════════════════

    function setTvlCap(uint256 newCap) external onlyRole(ADMIN_ROLE) {
        _s().tvlCap = newCap;
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
        FundState storage s = _s();
        uint256 recovered = FundFlowsLib.emergencyUnwind(s);
        PlanStatus st = s.plan.status;
        if (st == PlanStatus.Open || st == PlanStatus.Halted) _move(st, PlanStatus.Paused);
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
