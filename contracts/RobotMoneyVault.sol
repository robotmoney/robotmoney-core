// SPDX-License-Identifier: MIT
// Canonical: docs/prd.md §5.1 — Treasury (pooled USDC, share token, pause, shutdown)
// (See also: docs/prd.md §7 — Trust)
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IStrategyAdapter} from "./interfaces/IStrategyAdapter.sol";

/// @title RobotMoneyVault
/// @notice Multi-adapter ERC-4626 USDC vault on Base. Dynamic equal-weight target across active
///         adapters. On-chain trustless pricing. Atomic deposit-to-yield AND withdraw — both
///         single-transaction, standard ERC-4626. Exit fee applied on withdrawal.
///         Yearn V3-inspired security: 2 roles + hardcoded floors.
///
/// Deployed: 0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd (Base mainnet)
/// Compiler: v0.8.24+commit.e11b9ed9, optimized 200 runs, EVM Cancun
contract RobotMoneyVault is ERC4626, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ─── Roles ─────────────────────────────────────────────────────────

    /// @notice Role that can manage adapters, set parameters, and rebalance.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    /// @notice Role that can pause and perform emergency withdrawals.
    ///         Asymmetric with unpause by design: a compromised emergency key can
    ///         only halt the vault (DoS), not restart it. Unpause is restricted to
    ///         `ADMIN_ROLE` so that resuming operations is deliberate and requires
    ///         the higher-trust role — mirroring the gateway's `PAUSER_ROLE` /
    ///         `ADMIN_ROLE` asymmetry documented in `AccessRoles.sol`.
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");
    /// @notice Role for automated keeper rebalancing (not granted at launch).
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    // ─── Immutable bytecode constants — no role can change ─────────────

    /// @notice Absolute ceiling on exit fee (100 bps = 1%).
    uint256 public constant MAX_EXIT_FEE_BPS = 100;
    /// @notice Maximum number of strategy adapters the vault can hold.
    uint256 public constant MAX_ADAPTERS = 20;
    /// @notice Basis-points denominator (10 000 = 100%).
    uint16 public constant MAX_BPS = 10000;
    /// @notice Keeper can never move more than 50% of TVL in a single rebalance call.
    uint16 public constant MAX_REBALANCE_BPS_CEILING = 5000;
    /// @notice Minimum enforced interval between rebalance calls (1 hour).
    uint256 public constant MIN_REBALANCE_INTERVAL_FLOOR = 1 hours;

    // ─── Adapter registry ──────────────────────────────────────────────

    struct AdapterInfo {
        IStrategyAdapter adapter;
        uint16 capBps; // max allocation % out of MAX_BPS — also acts as ramp control
        bool active;
    }
    /// @notice Ordered registry of all strategy adapters (active and inactive).
    AdapterInfo[] public adapters;

    // ─── Configurable params ──────────────────────────────────────────

    /// @notice Maximum total assets under management; deposits revert above this.
    uint256 public tvlCap;
    /// @notice Maximum USDC that a single deposit may contribute.
    uint256 public perDepositCap;
    /// @notice Exit fee in basis points charged on withdrawals.
    uint256 public exitFeeBps;
    /// @notice Recipient of collected exit fees.
    address public feeRecipient;

    /// @notice Whether the vault has been permanently shut down. Irreversible.
    bool public shutdown;

    // ─── Rebalance throttling ──

    /// @notice Maximum fraction of TVL a keeper may move in one rebalance call (bps).
    uint16 public maxRebalanceBpsPerCall;
    /// @notice Minimum time between consecutive rebalance calls (seconds).
    uint256 public minRebalanceInterval;
    /// @notice Timestamp of the most recent completed rebalance.
    uint256 public lastRebalanceAt;

    // ─── Events ────────────────────────────────────────────────────────

    /// @notice Emitted when a new strategy adapter is registered.
    /// @param index   Registry index of the new adapter.
    /// @param adapter Address of the registered adapter contract.
    /// @param capBps  Maximum allocation cap in basis points.
    event AdapterAdded(uint256 indexed index, address indexed adapter, uint16 capBps);
    /// @notice Emitted when an adapter is deactivated (normal removal).
    /// @param index   Registry index of the removed adapter.
    /// @param adapter Address of the deactivated adapter contract.
    event AdapterRemoved(uint256 indexed index, address indexed adapter);
    /// @notice Emitted when an adapter's allocation cap is updated.
    /// @param index  Registry index of the adapter.
    /// @param oldBps Previous cap in basis points.
    /// @param newBps New cap in basis points.
    event AdapterCapUpdated(uint256 indexed index, uint16 oldBps, uint16 newBps);
    /// @notice Emitted when an adapter is force-removed without withdrawing assets (emergency).
    /// @param index      Registry index of the force-removed adapter.
    /// @param adapter    Address of the adapter contract.
    /// @param lossAmount Estimated assets lost due to force removal.
    event AdapterForceRemoved(uint256 indexed index, address indexed adapter, uint256 lossAmount);
    /// @notice Emitted when USDC is allocated from the vault into an adapter.
    /// @param index   Registry index of the target adapter.
    /// @param adapter Address of the target adapter contract.
    /// @param amount  Amount of USDC allocated (6-decimal units).
    event Allocated(uint256 indexed index, address indexed adapter, uint256 amount);
    /// @notice Emitted when USDC is pulled from an adapter back to the vault.
    /// @param index   Registry index of the source adapter.
    /// @param adapter Address of the source adapter contract.
    /// @param amount  Amount of USDC pulled (6-decimal units).
    event Pulled(uint256 indexed index, address indexed adapter, uint256 amount);
    /// @notice Emitted at the end of a successful rebalance call.
    /// @param totalMoved Total USDC redistributed across adapters (6-decimal units).
    event Rebalanced(uint256 totalMoved);
    /// @notice Emitted when the per-call rebalance cap is updated.
    /// @param oldBps Previous cap in basis points.
    /// @param newBps New cap in basis points.
    event MaxRebalanceBpsUpdated(uint16 oldBps, uint16 newBps);
    /// @notice Emitted when the minimum rebalance interval is updated.
    /// @param oldInterval Previous minimum interval in seconds.
    /// @param newInterval New minimum interval in seconds.
    event MinRebalanceIntervalUpdated(uint256 oldInterval, uint256 newInterval);
    /// @notice Emitted when an exit fee is charged on a withdrawal.
    /// @param owner      Share owner who initiated the withdrawal.
    /// @param receiver   Address that received the net USDC.
    /// @param grossAssets Gross USDC value of redeemed shares.
    /// @param fee        Exit fee charged (grossAssets × exitFeeBps / MAX_BPS).
    /// @param netAssets  Net USDC transferred to receiver (grossAssets − fee).
    event ExitFeeCharged(
        address indexed owner,
        address indexed receiver,
        uint256 grossAssets,
        uint256 fee,
        uint256 netAssets
    );
    /// @notice Emitted when the TVL cap is updated.
    /// @param oldCap Previous TVL cap (6-decimal USDC units).
    /// @param newCap New TVL cap (6-decimal USDC units).
    event TvlCapUpdated(uint256 oldCap, uint256 newCap);
    /// @notice Emitted when the per-deposit cap is updated.
    /// @param oldCap Previous per-deposit cap (6-decimal USDC units).
    /// @param newCap New per-deposit cap (6-decimal USDC units).
    event PerDepositCapUpdated(uint256 oldCap, uint256 newCap);
    /// @notice Emitted when the exit fee is updated.
    /// @param oldBps Previous exit fee in basis points.
    /// @param newBps New exit fee in basis points.
    event ExitFeeUpdated(uint256 oldBps, uint256 newBps);
    /// @notice Emitted when the fee recipient address is updated.
    /// @param oldRecipient Previous fee recipient address.
    /// @param newRecipient New fee recipient address.
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    /// @notice Emitted when the emergency withdrawal flow is triggered (all adapters).
    event EmergencyWithdrawCalled();
    /// @notice Emitted per-adapter during an emergency withdrawal.
    /// @param index   Registry index of the adapter.
    /// @param adapter Address of the adapter contract.
    /// @param amount  Amount withdrawn (0 on failure or empty balance).
    /// @param success Whether the adapter's withdraw call succeeded.
    event EmergencyWithdrawAdapterCalled(
        uint256 indexed index, address indexed adapter, uint256 amount, bool success
    );
    /// @notice Emitted when the vault is permanently shut down.
    event Shutdown();
    /// @notice Emitted when a deposit cannot be fully routed into adapters (e.g. all caps are full).
    /// @param amount USDC that remains idle in the vault after both routing passes.
    event UnroutedDeposit(uint256 amount);

    // ─── Errors ────────────────────────────────────────────────────────

    /// @notice Deposit would push total managed assets above `tvlCap`.
    error TVLCapExceeded();
    /// @notice A single deposit exceeds the per-deposit cap.
    error PerDepositCapExceeded();
    /// @notice `rescueToken` refused because the token is the vault's own asset (USDC).
    error CannotRescueAsset();
    /// @notice Constructor or admin call passed `address(0)` where a real address is required.
    error ZeroAddress();
    /// @notice Operation rejected because the vault has been permanently shut down.
    error VaultShutdown();
    /// @notice Exit-fee bps argument exceeds `MAX_EXIT_FEE_BPS` (1%).
    error InvalidFee();
    /// @notice Generic admin parameter validation failure (zero/out-of-range value).
    error InvalidParam();
    /// @notice Adapter cap bps is zero or above `MAX_BPS`.
    error InvalidCap();
    /// @notice Allocation to a single adapter would exceed its configured `capBps`.
    error ExceedsAdapterCap();
    /// @notice Adapter registry already holds `MAX_ADAPTERS`; cannot add another.
    error MaxAdaptersReached();
    /// @notice Provided adapter index is out of range or refers to an inactive entry.
    error AdapterNotFound();
    /// @notice Cannot remove an adapter while it still custodies assets — withdraw first.
    error AdapterNotEmpty();
    /// @notice Deposit/rebalance attempted while no adapter is active.
    error NoActiveAdapters();
    /// @notice Keeper called `rebalance()` before `minRebalanceInterval` elapsed since `lastRebalanceAt`.
    error RebalanceTooSoon();
    /// @notice Caller lacks `KEEPER_ROLE` (or `ADMIN_ROLE` where the rebalancer path also accepts it).
    error UnauthorizedRebalancer();

    // ─── Constructor ──────────────────────────────────────────────────

    constructor(
        IERC20 _asset,
        uint256 _tvlCap,
        uint256 _perDepositCap,
        uint256 _exitFeeBps,
        address _feeRecipient,
        address _admin
    ) ERC4626(_asset) ERC20("Robot Money USDC", "rmUSDC") {
        if (_feeRecipient == address(0) || _admin == address(0)) {
            revert ZeroAddress();
        }
        if (_exitFeeBps > MAX_EXIT_FEE_BPS) revert InvalidFee();

        tvlCap = _tvlCap;
        perDepositCap = _perDepositCap;
        exitFeeBps = _exitFeeBps;
        feeRecipient = _feeRecipient;

        maxRebalanceBpsPerCall = 2500; // 25%
        minRebalanceInterval = 12 hours;

        _setRoleAdmin(ADMIN_ROLE, ADMIN_ROLE);
        _setRoleAdmin(EMERGENCY_ROLE, ADMIN_ROLE);
        _setRoleAdmin(KEEPER_ROLE, ADMIN_ROLE);

        _grantRole(ADMIN_ROLE, _admin);
        _grantRole(EMERGENCY_ROLE, _admin);
        // KEEPER_ROLE intentionally NOT granted
    }

    /// @notice Returns the decimal precision used by this vault's share token (6, matching USDC).
    ///
    /// @dev Share token precision is fixed at 6 so that external tools (wallets, explorers,
    ///      integrators) always see a consistent denomination regardless of the internal
    ///      virtual-share scale chosen for inflation protection.
    ///
    ///      Raw-share scale note (for integrators):
    ///      The ERC-4626 virtual-share offset is 18 (see `_decimalsOffset`).  OpenZeppelin's
    ///      `_convertToShares` formula is:
    ///        shares = assets × (totalSupply + 10^18) / (totalAssets + 1)
    ///      For a fresh vault this yields `1e6 USDC → 1e24 raw shares`.  Because `decimals()`
    ///      returns 6, a user interface rendering `balanceOf(user) / 1e6` would display
    ///      `1e18` rmUSDC for a 1 USDC seed deposit.  This is intentional: the inflated share
    ///      count is what makes donation-based price manipulation economically infeasible.
    ///      Once the vault accumulates real TVL the share price converges to 1 rmUSDC ≈ 1 USDC
    ///      (in 6-decimal terms) and the raw count no longer dominates the display.
    function decimals() public pure override(ERC4626) returns (uint8) {
        return 6;
    }

    /// @notice Returns the ERC-4626 virtual-share decimal offset used to resist first-depositor
    ///         share-price inflation attacks.
    ///
    /// @dev Returning 18 configures OpenZeppelin's ERC-4626 virtual shares to `10^18` and
    ///      virtual assets to `1`.  With this setting the economic cost of a donation-based
    ///      inflation attack scales as `10^18` — orders of magnitude beyond any realistic
    ///      attacker budget — while legitimate depositors receive economically fair shares at
    ///      all TVL levels.
    ///
    ///      Raw-share scale (fresh vault, decimals() == 6, _decimalsOffset() == 18):
    ///        previewDeposit(1e6)  → 1e24 raw shares  (= 1e18 rmUSDC in 6-decimal display)
    ///        previewMint(1e24)    → 1e6 USDC
    ///        previewRedeem(1e24)  → ~1e6 USDC (minus exit fee if any)
    ///        previewWithdraw(1e6) → ~1e24 raw shares
    ///
    ///      Integrators MUST NOT assume raw shares equal asset amounts.  Always use
    ///      `convertToShares` / `convertToAssets` for on-chain math, or read `decimals()` and
    ///      divide accordingly in off-chain display logic.
    ///
    ///      See: docs/security-model.md — ERC-4626 Inflation Attack Mitigation
    function _decimalsOffset() internal pure override returns (uint8) {
        return 18;
    }

    // ─── totalAssets ──────────────────────────────────────────────────

    /// @notice Sum of USDC held directly in the vault (idle) plus all active adapter balances.
    /// @dev Idle USDC can accumulate via direct transfers or when `_routeDeposit` cannot place
    ///      all assets (e.g. all adapter caps are exhausted). Including it here prevents NAV
    ///      understatement and the associated TVL-cap bypass / share-price dilution described
    ///      in docs/code-reviews/code-review-codex-20260508-1522.md — Finding 2.
    function totalAssets() public view override returns (uint256) {
        uint256 sum = IERC20(asset()).balanceOf(address(this)); // include idle vault balance
        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (adapters[i].active) sum += adapters[i].adapter.totalAssets();
        }
        return sum;
    }

    // ─── Deposit (atomic deposit-to-yield) ────────────────────────────

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        whenNotPaused
        nonReentrant
    {
        if (shutdown) revert VaultShutdown();
        if (assets > perDepositCap) revert PerDepositCapExceeded();
        if (totalAssets() + assets > tvlCap) revert TVLCapExceeded();
        if (_activeAdapterCount() == 0) revert NoActiveAdapters();

        super._deposit(caller, receiver, assets, shares);
        _routeDeposit(assets);
    }

    function _routeDeposit(uint256 amount) internal {
        // slither-disable-next-line incorrect-equality
        // Justification: `amount == 0` is a safe early-return guard, not a
        // balance-sensitive strict equality that reentrancy could manipulate.
        if (amount == 0) return;

        // `totalAssets()` now includes the idle vault balance (the deposited USDC already sits
        // in the vault at this point), so it already accounts for `amount`. Do NOT add `amount`
        // again — that would double-count it.
        uint256 totalAfter = totalAssets();
        uint256 targetBps = _targetBpsFor();
        uint256 remaining = amount;
        uint256 len = adapters.length;

        // Pass 1: fill toward min(equal target, capBps)
        for (uint256 i = 0; i < len && remaining > 0; i++) {
            if (!adapters[i].active) continue;
            uint256 effectiveTarget =
                adapters[i].capBps < targetBps ? adapters[i].capBps : targetBps;
            uint256 currentBalance = adapters[i].adapter.totalAssets();
            uint256 targetBalance = (totalAfter * effectiveTarget) / MAX_BPS;
            if (currentBalance >= targetBalance) continue;
            uint256 deficit = targetBalance - currentBalance;
            uint256 allocation = deficit < remaining ? deficit : remaining;
            _allocateTo(i, allocation);
            remaining -= allocation;
        }

        // Pass 2: spread leftover into adapters with absolute cap headroom
        if (remaining > 0) {
            for (uint256 i = 0; i < len && remaining > 0; i++) {
                if (!adapters[i].active) continue;
                uint256 currentBalance = adapters[i].adapter.totalAssets();
                uint256 capBalance = (totalAfter * adapters[i].capBps) / MAX_BPS;
                if (currentBalance >= capBalance) continue;
                uint256 headroom = capBalance - currentBalance;
                uint256 allocation = headroom < remaining ? headroom : remaining;
                _allocateTo(i, allocation);
                remaining -= allocation;
            }
        }

        // Any USDC still unrouted (e.g. all adapter caps exhausted) stays idle in the vault.
        // Emit an event so off-chain monitors can detect and react (e.g. trigger rebalance).
        if (remaining > 0) emit UnroutedDeposit(remaining);
    }

    function _allocateTo(uint256 i, uint256 amount) internal {
        IERC20(asset()).safeTransfer(address(adapters[i].adapter), amount);
        adapters[i].adapter.deploy(amount);
        emit Allocated(i, address(adapters[i].adapter), amount);
    }

    // ─── Synchronous withdraw / redeem ────────────────────────────────

    /// @notice Estimate net USDC returned when redeeming `shares` (after exit fee).
    /// @param shares Number of rmUSDC shares to simulate redeeming.
    function previewRedeem(uint256 shares) public view override returns (uint256) {
        uint256 grossAssets = _convertToAssets(shares, Math.Rounding.Floor);
        return _grossToNet(grossAssets);
    }

    /// @notice Estimate shares required to receive exactly `assets` USDC net (after exit fee).
    /// @param assets Target net USDC to receive.
    function previewWithdraw(uint256 assets) public view override returns (uint256) {
        uint256 grossAssets = _netToGross(assets);
        return _convertToShares(grossAssets, Math.Rounding.Ceil);
    }

    function _grossToNet(uint256 gross) internal view returns (uint256) {
        return gross - gross.mulDiv(exitFeeBps, MAX_BPS);
    }

    function _netToGross(uint256 net) internal view returns (uint256) {
        if (exitFeeBps == 0) return net;
        return net.mulDiv(MAX_BPS, MAX_BPS - exitFeeBps, Math.Rounding.Ceil);
    }

    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override whenNotPaused nonReentrant {
        if (caller != owner) {
            _spendAllowance(owner, caller, shares);
        }

        uint256 grossAssets = _convertToAssets(shares, Math.Rounding.Floor);
        uint256 fee = grossAssets - assets;

        _pullProportional(grossAssets);

        // slither-disable-next-line reentrancy-no-eth
        // Justification: `_withdraw` is `nonReentrant`; the `_burn` after
        // external adapter calls is safe because reentry is blocked by the OZ guard.
        _burn(owner, shares);

        if (fee > 0) {
            IERC20(asset()).safeTransfer(feeRecipient, fee);
            emit ExitFeeCharged(owner, receiver, grossAssets, fee, assets);
        }
        IERC20(asset()).safeTransfer(receiver, assets);

        emit Withdraw(caller, receiver, owner, assets, shares);
    }

    function _pullProportional(uint256 assetsNeeded) internal {
        if (assetsNeeded == 0) return;

        uint256 totalInAdapters = 0;
        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (adapters[i].active) totalInAdapters += adapters[i].adapter.totalAssets();
        }
        if (totalInAdapters == 0) revert NoActiveAdapters();
        if (assetsNeeded > totalInAdapters) assetsNeeded = totalInAdapters;

        uint256 remaining = assetsNeeded;
        uint256 lastActiveIdx = type(uint256).max;

        for (uint256 i = 0; i < len && remaining > 0; i++) {
            if (!adapters[i].active) continue;
            lastActiveIdx = i;
            uint256 adapterBalance = adapters[i].adapter.totalAssets();
            uint256 pull = (assetsNeeded * adapterBalance) / totalInAdapters;
            if (pull > remaining) pull = remaining;
            if (pull == 0) continue;
            uint256 actual = adapters[i].adapter.withdraw(pull);
            remaining -= actual;
            emit Pulled(i, address(adapters[i].adapter), actual);
        }

        if (remaining > 0 && lastActiveIdx != type(uint256).max) {
            uint256 actual = adapters[lastActiveIdx].adapter.withdraw(remaining);
            emit Pulled(lastActiveIdx, address(adapters[lastActiveIdx].adapter), actual);
        }
    }

    // ─── Adapter management ──────────────────────────────────────────

    /// @notice Register a new strategy adapter. Restricted to `ADMIN_ROLE`.
    /// @param adapter_ Address of the `IStrategyAdapter`-compatible contract.
    /// @param capBps_  Maximum allocation cap in basis points (1–10 000).
    function addAdapter(address adapter_, uint16 capBps_) external onlyRole(ADMIN_ROLE) {
        if (adapter_ == address(0)) revert ZeroAddress();
        if (capBps_ == 0 || capBps_ > MAX_BPS) revert InvalidCap();
        if (_activeAdapterCount() >= MAX_ADAPTERS) revert MaxAdaptersReached();
        adapters.push(
            AdapterInfo({adapter: IStrategyAdapter(adapter_), capBps: capBps_, active: true})
        );
        emit AdapterAdded(adapters.length - 1, adapter_, capBps_);
    }

    /// @notice Deactivate an adapter. The adapter must hold zero assets. Restricted to `ADMIN_ROLE`.
    /// @param index Registry index of the adapter to remove.
    function removeAdapter(uint256 index) external onlyRole(ADMIN_ROLE) {
        if (index >= adapters.length || !adapters[index].active) revert AdapterNotFound();
        if (adapters[index].adapter.totalAssets() > 0) revert AdapterNotEmpty();
        adapters[index].active = false;
        emit AdapterRemoved(index, address(adapters[index].adapter));
    }

    /// @notice Update the allocation cap for an existing adapter. Restricted to `ADMIN_ROLE`.
    /// @param index     Registry index of the adapter.
    /// @param newCapBps New maximum allocation cap in basis points (1–10 000).
    function setAdapterCap(uint256 index, uint16 newCapBps) external onlyRole(ADMIN_ROLE) {
        if (index >= adapters.length || !adapters[index].active) revert AdapterNotFound();
        if (newCapBps == 0 || newCapBps > MAX_BPS) revert InvalidCap();
        uint16 old = adapters[index].capBps;
        adapters[index].capBps = newCapBps;
        emit AdapterCapUpdated(index, old, newCapBps);
    }

    // ─── Rebalance ────────────────────────────────────────────────────

    /// @notice Keeper-triggered equal-weight rebalance. Callable by `ADMIN_ROLE` or `KEEPER_ROLE`.
    ///         Pulls excess from over-weight adapters and re-routes into under-weight adapters.
    ///         Subject to `minRebalanceInterval` and `maxRebalanceBpsPerCall` throttles.
    function rebalance() external nonReentrant {
        if (!hasRole(ADMIN_ROLE, msg.sender) && !hasRole(KEEPER_ROLE, msg.sender)) {
            revert UnauthorizedRebalancer();
        }
        if (block.timestamp < lastRebalanceAt + minRebalanceInterval) revert RebalanceTooSoon();
        if (_activeAdapterCount() == 0) revert NoActiveAdapters();

        uint256 targetBps = _targetBpsFor();
        uint256 totalAssetsCached = totalAssets();
        uint256 maxMovePerCall = (totalAssetsCached * maxRebalanceBpsPerCall) / MAX_BPS;
        uint256 totalMoved = 0;

        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (!adapters[i].active) continue;
            if (totalMoved >= maxMovePerCall) break;
            uint256 currentBalance = adapters[i].adapter.totalAssets();
            uint256 targetBalance = (totalAssetsCached * targetBps) / MAX_BPS;
            if (currentBalance <= targetBalance) continue;
            uint256 excess = currentBalance - targetBalance;
            uint256 pull =
                (totalMoved + excess > maxMovePerCall) ? (maxMovePerCall - totalMoved) : excess;
            if (pull == 0) continue;
            uint256 actual = adapters[i].adapter.withdraw(pull);
            totalMoved += actual;
            emit Pulled(i, address(adapters[i].adapter), actual);
        }

        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (idle > 0) _routeDeposit(idle);

        // slither-disable-next-line reentrancy-eth
        // Justification: `rebalance` is `nonReentrant`; the state write after
        // external calls is safe because reentry is blocked by the OZ guard.
        lastRebalanceAt = block.timestamp;
        emit Rebalanced(totalMoved);
    }

    /// @notice Admin-specified precision rebalance: sets each adapter to an explicit target balance.
    ///         Restricted to `ADMIN_ROLE`.
    /// @param targetBalances Target USDC balance for each adapter (must match `adapters.length`).
    function adminRebalance(uint256[] calldata targetBalances)
        external
        onlyRole(ADMIN_ROLE)
        nonReentrant
    {
        if (targetBalances.length != adapters.length) revert InvalidParam();
        uint256 len = adapters.length;
        uint256 totalMoved = 0;

        for (uint256 i = 0; i < len; i++) {
            if (!adapters[i].active) continue;
            uint256 current = adapters[i].adapter.totalAssets();
            if (current > targetBalances[i]) {
                uint256 excess = current - targetBalances[i];
                uint256 actual = adapters[i].adapter.withdraw(excess);
                totalMoved += actual;
                emit Pulled(i, address(adapters[i].adapter), actual);
            }
        }

        uint256 idle = IERC20(asset()).balanceOf(address(this));
        if (idle > 0) {
            for (uint256 i = 0; i < len && idle > 0; i++) {
                if (!adapters[i].active) continue;
                uint256 current = adapters[i].adapter.totalAssets();
                if (current < targetBalances[i]) {
                    uint256 deficit = targetBalances[i] - current;
                    uint256 allocation = deficit < idle ? deficit : idle;
                    _allocateTo(i, allocation);
                    idle -= allocation;
                }
            }
        }

        lastRebalanceAt = block.timestamp;
        emit Rebalanced(totalMoved);
    }

    /// @notice Update the per-call rebalance cap. Restricted to `ADMIN_ROLE`.
    /// @param newBps New cap in basis points (1–5 000; must not exceed `MAX_REBALANCE_BPS_CEILING`).
    function setMaxRebalanceBpsPerCall(uint16 newBps) external onlyRole(ADMIN_ROLE) {
        if (newBps == 0 || newBps > MAX_REBALANCE_BPS_CEILING) revert InvalidParam();
        uint16 old = maxRebalanceBpsPerCall;
        maxRebalanceBpsPerCall = newBps;
        emit MaxRebalanceBpsUpdated(old, newBps);
    }

    /// @notice Update the minimum interval between rebalance calls. Restricted to `ADMIN_ROLE`.
    /// @param newInterval New minimum interval in seconds (must be ≥ `MIN_REBALANCE_INTERVAL_FLOOR`).
    function setMinRebalanceInterval(uint256 newInterval) external onlyRole(ADMIN_ROLE) {
        if (newInterval < MIN_REBALANCE_INTERVAL_FLOOR) revert InvalidParam();
        uint256 old = minRebalanceInterval;
        minRebalanceInterval = newInterval;
        emit MinRebalanceIntervalUpdated(old, newInterval);
    }

    // ─── Emergency ────────────────────────────────────────────────────

    /// @notice Pause all deposits and withdrawals. Restricted to `EMERGENCY_ROLE`.
    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    /// @notice Resume deposits and withdrawals. Restricted to `ADMIN_ROLE`.
    ///         Intentionally asymmetric: pausing is fast and unilateral (`EMERGENCY_ROLE`);
    ///         unpausing is deliberate and requires the higher-trust admin role.
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Pause the vault and attempt to withdraw all assets from every active adapter.
    ///         Uses `try/catch` so a failed adapter does not block others. Restricted to `EMERGENCY_ROLE`.
    function emergencyWithdraw() external onlyRole(EMERGENCY_ROLE) nonReentrant {
        _pause();
        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (!adapters[i].active) continue;
            uint256 balance = adapters[i].adapter.totalAssets();
            if (balance == 0) continue;
            try adapters[i].adapter.withdraw(balance) returns (uint256 actual) {
                emit EmergencyWithdrawAdapterCalled(i, address(adapters[i].adapter), actual, true);
            } catch {
                emit EmergencyWithdrawAdapterCalled(i, address(adapters[i].adapter), 0, false);
            }
        }
        emit EmergencyWithdrawCalled();
    }

    /// @notice Pause the vault and withdraw all assets from a single adapter. Restricted to `EMERGENCY_ROLE`.
    /// @param index Registry index of the adapter to drain.
    function emergencyWithdrawAdapter(uint256 index)
        external
        onlyRole(EMERGENCY_ROLE)
        nonReentrant
    {
        if (index >= adapters.length) revert AdapterNotFound();
        _pause();
        uint256 balance = adapters[index].adapter.totalAssets();
        if (balance == 0) {
            emit EmergencyWithdrawAdapterCalled(index, address(adapters[index].adapter), 0, true);
            return;
        }
        try adapters[index].adapter.withdraw(balance) returns (uint256 actual) {
            emit EmergencyWithdrawAdapterCalled(
                index, address(adapters[index].adapter), actual, true
            );
        } catch {
            emit EmergencyWithdrawAdapterCalled(index, address(adapters[index].adapter), 0, false);
        }
    }

    /// @notice Force-remove an adapter without withdrawing its assets (last-resort action).
    ///         Assets in the adapter are treated as lost. Restricted to `EMERGENCY_ROLE`.
    /// @param index Registry index of the adapter to force-remove.
    function forceRemoveAdapter(uint256 index) external onlyRole(EMERGENCY_ROLE) {
        if (index >= adapters.length || !adapters[index].active) revert AdapterNotFound();
        uint256 lossAmount = adapters[index].adapter.totalAssets();
        adapters[index].active = false;
        emit AdapterForceRemoved(index, address(adapters[index].adapter), lossAmount);
    }

    /// @notice Permanently shut down the vault: set `shutdown = true` and zero the TVL cap.
    ///         Irreversible. Restricted to `EMERGENCY_ROLE`.
    function shutdownVault() external onlyRole(EMERGENCY_ROLE) {
        shutdown = true;
        tvlCap = 0;
        emit Shutdown();
    }

    // ─── Param setters ────────────────────────────────────────────────

    /// @notice Update the TVL cap. Restricted to `ADMIN_ROLE`.
    /// @param newCap New maximum total assets in 6-decimal USDC units.
    function setTvlCap(uint256 newCap) external onlyRole(ADMIN_ROLE) {
        uint256 old = tvlCap;
        tvlCap = newCap;
        emit TvlCapUpdated(old, newCap);
    }

    /// @notice Update the per-deposit cap. Restricted to `ADMIN_ROLE`.
    /// @param newCap New maximum single-deposit amount in 6-decimal USDC units.
    function setPerDepositCap(uint256 newCap) external onlyRole(ADMIN_ROLE) {
        uint256 old = perDepositCap;
        perDepositCap = newCap;
        emit PerDepositCapUpdated(old, newCap);
    }

    /// @notice Update the exit fee. Restricted to `ADMIN_ROLE`.
    /// @param newBps New exit fee in basis points (0–`MAX_EXIT_FEE_BPS`).
    function setExitFeeBps(uint256 newBps) external onlyRole(ADMIN_ROLE) {
        if (newBps > MAX_EXIT_FEE_BPS) revert InvalidFee();
        uint256 old = exitFeeBps;
        exitFeeBps = newBps;
        emit ExitFeeUpdated(old, newBps);
    }

    /// @notice Update the fee recipient address. Restricted to `ADMIN_ROLE`.
    /// @param newRecipient New address to receive collected exit fees.
    function setFeeRecipient(address newRecipient) external onlyRole(ADMIN_ROLE) {
        if (newRecipient == address(0)) revert ZeroAddress();
        address old = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(old, newRecipient);
    }

    /// @notice Rescue accidentally-sent ERC-20 tokens (cannot rescue USDC or vault shares).
    ///         Restricted to `ADMIN_ROLE`.
    /// @param token ERC-20 token to rescue (must not be the vault asset or vault share token).
    /// @param to    Recipient address for the rescued tokens.
    function rescueTokens(address token, address to) external onlyRole(ADMIN_ROLE) {
        if (token == asset()) revert CannotRescueAsset();
        if (token == address(this)) revert CannotRescueAsset();
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, balance);
    }

    // ─── Internal helpers ─────────────────────────────────────────────

    function _targetBpsFor() internal view returns (uint256) {
        uint256 active = _activeAdapterCount();
        return active == 0 ? 0 : MAX_BPS / active;
    }

    function _activeAdapterCount() internal view returns (uint256) {
        uint256 count = 0;
        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (adapters[i].active) count++;
        }
        return count;
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice Total number of adapters in the registry (active and inactive).
    function adapterCount() external view returns (uint256) {
        return adapters.length;
    }

    /// @notice Whether the vault has been permanently shut down.
    function isShutdown() external view returns (bool) {
        return shutdown;
    }

    /// @notice Detailed information about a single adapter entry.
    /// @param index         Registry index of the adapter.
    /// @return adapterAddr  Address of the adapter contract.
    /// @return capBps       Maximum allocation cap in basis points.
    /// @return active       Whether the adapter is currently active.
    /// @return currentBalance Live USDC value held by the adapter.
    /// @return targetBps    Current equal-weight target in basis points.
    function getAdapterInfo(uint256 index)
        external
        view
        returns (
            address adapterAddr,
            uint16 capBps,
            bool active,
            uint256 currentBalance,
            uint256 targetBps
        )
    {
        AdapterInfo memory info = adapters[index];
        return (
            address(info.adapter),
            info.capBps,
            info.active,
            info.adapter.totalAssets(),
            info.active ? _targetBpsFor() : 0
        );
    }

    /// @notice Compute current vs. target balances and signed drift for every adapter.
    /// @return currentBalances Live USDC values for each adapter (6-decimal units).
    /// @return targetBalances  Equal-weight target USDC values for each adapter.
    /// @return drifts          Signed difference (current − target) per adapter.
    function getAdapterDrift()
        external
        view
        returns (
            uint256[] memory currentBalances,
            uint256[] memory targetBalances,
            int256[] memory drifts
        )
    {
        uint256 len = adapters.length;
        currentBalances = new uint256[](len);
        targetBalances = new uint256[](len);
        drifts = new int256[](len);

        uint256 total = totalAssets();
        uint256 targetBps = _targetBpsFor();

        for (uint256 i = 0; i < len; i++) {
            if (!adapters[i].active) continue;
            currentBalances[i] = adapters[i].adapter.totalAssets();
            targetBalances[i] = (total * targetBps) / MAX_BPS;
            drifts[i] = int256(currentBalances[i]) - int256(targetBalances[i]);
        }
    }

    /// @notice Whether `minRebalanceInterval` has elapsed since the last rebalance.
    function isRebalanceAvailable() external view returns (bool) {
        return block.timestamp >= lastRebalanceAt + minRebalanceInterval;
    }

    /// @notice Timestamp at which the next rebalance call will be permitted.
    function nextRebalanceAt() external view returns (uint256) {
        return lastRebalanceAt + minRebalanceInterval;
    }

    /// @notice Number of currently active strategy adapters.
    function activeAdapterCount() external view returns (uint256) {
        return _activeAdapterCount();
    }

    /// @notice Equal-weight target allocation per active adapter in basis points.
    function currentTargetBps() external view returns (uint256) {
        return _targetBpsFor();
    }
}
