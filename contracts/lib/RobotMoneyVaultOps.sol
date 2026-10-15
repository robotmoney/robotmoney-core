// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.1 — RobotMoneyVault (emergency levers, drift views)
// (See also: contracts/RobotMoneyVault.sol; issue 1808 — moved out of the vault so the proxied
//            vault, which now carries the upgrade entry points, fits EIP-170)
pragma solidity ^0.8.24;

import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";

/// @title RobotMoneyVaultOps
/// @notice The off-hot-path adapter loops of `RobotMoneyVault`, as an externally linked library:
///         the two emergency drains, the explicit-target pull of `adminRebalance` and the drift
///         view. Its code runs by DELEGATECALL on the vault proxy's own storage, with the
///         vault's `msg.sender`, so every event is logged by the vault. The logic is the code
///         the vault carried inline before issue 1808, unchanged. The deposit and redeem paths
///         stay in the vault.
library RobotMoneyVaultOps {
    /// @dev Layout-identical to `RobotMoneyVault.AdapterInfo`. The vault casts its `adapters`
    ///      storage array to this type (`_opsAdapters`); only the nominal type differs.
    struct AdapterInfo {
        IStrategyAdapter adapter;
        uint16 capBps;
        bool active;
    }

    uint256 internal constant MAX_BPS = 10_000;

    /// @notice Same signatures as the `RobotMoneyVault` events (the vault declares them for its ABI).
    event Pulled(uint256 indexed index, address indexed adapter, uint256 amount);
    event EmergencyWithdrawAdapterCalled(
        uint256 indexed index, address indexed adapter, uint256 amount, bool success
    );

    /// @notice Same selector as `RobotMoneyVault.AdapterNotFound`.
    error AdapterNotFound();

    /// @notice Try to withdraw every active adapter's full balance. A failing adapter is logged
    ///         and skipped, so it never blocks the others.
    function drainAll(AdapterInfo[] storage adapters) external {
        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (!adapters[i].active) continue;
            IStrategyAdapter adpt = adapters[i].adapter;
            address adptAddr = address(adpt);
            uint256 balance;
            try adpt.totalAssets() returns (uint256 reported) {
                balance = reported;
            } catch {
                emit EmergencyWithdrawAdapterCalled(i, adptAddr, 0, false);
                continue;
            }
            if (balance == 0) continue;
            try adpt.withdraw(balance) returns (uint256 actual) {
                emit EmergencyWithdrawAdapterCalled(i, adptAddr, actual, true);
            } catch {
                emit EmergencyWithdrawAdapterCalled(i, adptAddr, 0, false);
            }
        }
    }

    /// @notice Try to withdraw one active adapter's full balance. Reverts `AdapterNotFound` for an
    ///         unknown or inactive index.
    function drainOne(AdapterInfo[] storage adapters, uint256 index) external {
        if (index >= adapters.length || !adapters[index].active) revert AdapterNotFound();
        IStrategyAdapter adpt = adapters[index].adapter;
        uint256 balance;
        try adpt.totalAssets() returns (uint256 reported) {
            balance = reported;
        } catch {
            emit EmergencyWithdrawAdapterCalled(index, address(adpt), 0, false);
            return;
        }
        if (balance == 0) {
            emit EmergencyWithdrawAdapterCalled(index, address(adpt), 0, true);
            return;
        }
        try adpt.withdraw(balance) returns (uint256 actual) {
            emit EmergencyWithdrawAdapterCalled(index, address(adpt), actual, true);
        } catch {
            emit EmergencyWithdrawAdapterCalled(index, address(adpt), 0, false);
        }
    }

    /// @notice Pull every active adapter's balance above `targetBalances[i]` back to the vault.
    /// @return totalMoved The USDC the adapters returned.
    function pullToTargets(AdapterInfo[] storage adapters, uint256[] calldata targetBalances)
        external
        returns (uint256 totalMoved)
    {
        uint256 len = adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (!adapters[i].active) continue;
            uint256 current = adapters[i].adapter.totalAssets();
            if (current > targetBalances[i]) {
                uint256 actual = adapters[i].adapter.withdraw(current - targetBalances[i]);
                totalMoved += actual;
                emit Pulled(i, address(adapters[i].adapter), actual);
            }
        }
    }

    /// @notice Current vs. equal-weight target balance and signed drift for every adapter, with
    ///         the targets of the `activeCount` active adapters partitioning `total` exactly.
    function adapterDrift(AdapterInfo[] storage adapters, uint256 total, uint256 activeCount)
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
        uint256 rank;
        for (uint256 i = 0; i < len; i++) {
            if (!adapters[i].active) continue;
            targetBalances[i] = equalWeightBalance(total, rank, activeCount);
            rank++;
            currentBalances[i] = adapters[i].adapter.totalAssets();
            drifts[i] = int256(currentBalances[i]) - int256(targetBalances[i]);
        }
    }

    /// @notice One adapter entry with its live balance and its equal-weight target in bps.
    ///         Panics on an out-of-range `index`, like the array getter.
    function adapterInfo(AdapterInfo[] storage adapters, uint256 index)
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
        targetBps = 0;
        if (info.active) {
            // Rank among active adapters (registry order) and the active count: the one
            // target definition the allocator, `rebalance()` and the drift view share.
            uint256 len = adapters.length;
            uint256 activeCount;
            uint256 rank;
            for (uint256 i = 0; i < len; i++) {
                if (!adapters[i].active) continue;
                if (i < index) rank++;
                activeCount++;
            }
            targetBps = equalWeightBps(rank, activeCount);
        }
        return (
            address(info.adapter),
            info.capBps,
            info.active,
            info.adapter.totalAssets(),
            targetBps
        );
    }

    /// @notice Share of `MAX_BPS` owed to the `rank`-th (0-based, registry order) of `active`
    ///         equally-weighted adapters. `MAX_BPS / active` alone floors (3333 x 3 = 9999), so
    ///         the `MAX_BPS % active` leftover bps go one each to the lowest ranks and the
    ///         target set sums to exactly `MAX_BPS` (issue #1391). Callers still take
    ///         `min(capBps, targetBps)`.
    function equalWeightBps(uint256 rank, uint256 active) internal pure returns (uint256) {
        if (active == 0) return 0;
        return MAX_BPS / active + (rank < MAX_BPS % active ? 1 : 0);
    }

    /// @notice The `rank`-th active adapter's slice of `total` when `active` adapters split it
    ///         equally, as the difference of two prefix shares so the slices partition `total`
    ///         exactly (issue #1391). Mirrors `RobotMoneyVault._equalWeightBalance`.
    function equalWeightBalance(uint256 total, uint256 rank, uint256 active)
        internal
        pure
        returns (uint256)
    {
        if (active == 0) return 0;
        uint256 base = MAX_BPS / active;
        uint256 extra = MAX_BPS % active;
        uint256 cumBefore = base * rank + (rank < extra ? rank : extra);
        uint256 cumAfter = cumBefore + base + (rank < extra ? 1 : 0);
        return (total * cumAfter) / MAX_BPS - (total * cumBefore) / MAX_BPS;
    }
}
