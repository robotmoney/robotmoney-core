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

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant EMERGENCY_ROLE = keccak256("EMERGENCY_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE"); // not granted at launch

    // ─── Immutable bytecode constants — no role can change ─────────────

    uint256 public constant MAX_EXIT_FEE_BPS = 100; // 1% absolute ceiling
    uint256 public constant MAX_ADAPTERS = 20;
    uint16 public constant MAX_BPS = 10000;
    uint16 public constant MAX_REBALANCE_BPS_CEILING = 5000; // keeper can never move >50% per call
    uint256 public constant MIN_REBALANCE_INTERVAL_FLOOR = 1 hours;

    // ─── Adapter registry ──────────────────────────────────────────────

    struct AdapterInfo {
        IStrategyAdapter adapter;
        uint16 capBps; // max allocation % out of MAX_BPS — also acts as ramp control
        bool active;
    }
    AdapterInfo[] public adapters;

    // ─── Configurable params ──────────────────────────────────────────

    uint256 public tvlCap;
    uint256 public perDepositCap;
    uint256 public exitFeeBps;
    address public feeRecipient;

    bool public shutdown; // irreversible — once true, stays true forever

    // ─── Rebalance throttling ──

    uint16 public maxRebalanceBpsPerCall; // initial: 2500 (25%)
    uint256 public minRebalanceInterval; // initial: 12 hours
    uint256 public lastRebalanceAt;

    // ─── Events ────────────────────────────────────────────────────────

    event AdapterAdded(uint256 indexed index, address indexed adapter, uint16 capBps);
    event AdapterRemoved(uint256 indexed index, address indexed adapter);
    event AdapterCapUpdated(uint256 indexed index, uint16 oldBps, uint16 newBps);
    event AdapterForceRemoved(uint256 indexed index, address indexed adapter, uint256 lossAmount);
    event Allocated(uint256 indexed index, address indexed adapter, uint256 amount);
    event Pulled(uint256 indexed index, address indexed adapter, uint256 amount);
    event Rebalanced(uint256 totalMoved);
    event MaxRebalanceBpsUpdated(uint16 oldBps, uint16 newBps);
    event MinRebalanceIntervalUpdated(uint256 oldInterval, uint256 newInterval);
    event ExitFeeCharged(
        address indexed owner,
        address indexed receiver,
        uint256 grossAssets,
        uint256 fee,
        uint256 netAssets
    );
    event TvlCapUpdated(uint256 oldCap, uint256 newCap);
    event PerDepositCapUpdated(uint256 oldCap, uint256 newCap);
    event ExitFeeUpdated(uint256 oldBps, uint256 newBps);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event EmergencyWithdrawCalled();
    event EmergencyWithdrawAdapterCalled(
        uint256 indexed index, address indexed adapter, uint256 amount, bool success
    );
    event Shutdown();

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

    function decimals() public pure override(ERC4626) returns (uint8) {
        return 6;
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 0;
    }

    // ─── totalAssets ──────────────────────────────────────────────────

    function totalAssets() public view override returns (uint256) {
        uint256 sum = 0;
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

        uint256 totalAfter = totalAssets() + amount;
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
    }

    function _allocateTo(uint256 i, uint256 amount) internal {
        IERC20(asset()).safeTransfer(address(adapters[i].adapter), amount);
        adapters[i].adapter.deploy(amount);
        emit Allocated(i, address(adapters[i].adapter), amount);
    }

    // ─── Synchronous withdraw / redeem ────────────────────────────────

    function previewRedeem(uint256 shares) public view override returns (uint256) {
        uint256 grossAssets = _convertToAssets(shares, Math.Rounding.Floor);
        return _grossToNet(grossAssets);
    }

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

    function addAdapter(address adapter_, uint16 capBps_) external onlyRole(ADMIN_ROLE) {
        if (adapter_ == address(0)) revert ZeroAddress();
        if (capBps_ == 0 || capBps_ > MAX_BPS) revert InvalidCap();
        if (_activeAdapterCount() >= MAX_ADAPTERS) revert MaxAdaptersReached();
        adapters.push(
            AdapterInfo({adapter: IStrategyAdapter(adapter_), capBps: capBps_, active: true})
        );
        emit AdapterAdded(adapters.length - 1, adapter_, capBps_);
    }

    function removeAdapter(uint256 index) external onlyRole(ADMIN_ROLE) {
        if (index >= adapters.length || !adapters[index].active) revert AdapterNotFound();
        if (adapters[index].adapter.totalAssets() > 0) revert AdapterNotEmpty();
        adapters[index].active = false;
        emit AdapterRemoved(index, address(adapters[index].adapter));
    }

    function setAdapterCap(uint256 index, uint16 newCapBps) external onlyRole(ADMIN_ROLE) {
        if (index >= adapters.length || !adapters[index].active) revert AdapterNotFound();
        if (newCapBps == 0 || newCapBps > MAX_BPS) revert InvalidCap();
        uint16 old = adapters[index].capBps;
        adapters[index].capBps = newCapBps;
        emit AdapterCapUpdated(index, old, newCapBps);
    }

    // ─── Rebalance ────────────────────────────────────────────────────

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

    function setMaxRebalanceBpsPerCall(uint16 newBps) external onlyRole(ADMIN_ROLE) {
        if (newBps == 0 || newBps > MAX_REBALANCE_BPS_CEILING) revert InvalidParam();
        uint16 old = maxRebalanceBpsPerCall;
        maxRebalanceBpsPerCall = newBps;
        emit MaxRebalanceBpsUpdated(old, newBps);
    }

    function setMinRebalanceInterval(uint256 newInterval) external onlyRole(ADMIN_ROLE) {
        if (newInterval < MIN_REBALANCE_INTERVAL_FLOOR) revert InvalidParam();
        uint256 old = minRebalanceInterval;
        minRebalanceInterval = newInterval;
        emit MinRebalanceIntervalUpdated(old, newInterval);
    }

    // ─── Emergency ────────────────────────────────────────────────────

    function pause() external onlyRole(EMERGENCY_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(EMERGENCY_ROLE) {
        _unpause();
    }

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

    function forceRemoveAdapter(uint256 index) external onlyRole(EMERGENCY_ROLE) {
        if (index >= adapters.length || !adapters[index].active) revert AdapterNotFound();
        uint256 lossAmount = adapters[index].adapter.totalAssets();
        adapters[index].active = false;
        emit AdapterForceRemoved(index, address(adapters[index].adapter), lossAmount);
    }

    function shutdownVault() external onlyRole(EMERGENCY_ROLE) {
        shutdown = true;
        tvlCap = 0;
        emit Shutdown();
    }

    // ─── Param setters ────────────────────────────────────────────────

    function setTvlCap(uint256 newCap) external onlyRole(ADMIN_ROLE) {
        uint256 old = tvlCap;
        tvlCap = newCap;
        emit TvlCapUpdated(old, newCap);
    }

    function setPerDepositCap(uint256 newCap) external onlyRole(ADMIN_ROLE) {
        uint256 old = perDepositCap;
        perDepositCap = newCap;
        emit PerDepositCapUpdated(old, newCap);
    }

    function setExitFeeBps(uint256 newBps) external onlyRole(ADMIN_ROLE) {
        if (newBps > MAX_EXIT_FEE_BPS) revert InvalidFee();
        uint256 old = exitFeeBps;
        exitFeeBps = newBps;
        emit ExitFeeUpdated(old, newBps);
    }

    function setFeeRecipient(address newRecipient) external onlyRole(ADMIN_ROLE) {
        if (newRecipient == address(0)) revert ZeroAddress();
        address old = feeRecipient;
        feeRecipient = newRecipient;
        emit FeeRecipientUpdated(old, newRecipient);
    }

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

    function adapterCount() external view returns (uint256) {
        return adapters.length;
    }

    function isShutdown() external view returns (bool) {
        return shutdown;
    }

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

    function isRebalanceAvailable() external view returns (bool) {
        return block.timestamp >= lastRebalanceAt + minRebalanceInterval;
    }

    function nextRebalanceAt() external view returns (uint256) {
        return lastRebalanceAt + minRebalanceInterval;
    }

    function activeAdapterCount() external view returns (uint256) {
        return _activeAdapterCount();
    }

    function currentTargetBps() external view returns (uint256) {
        return _targetBpsFor();
    }
}
