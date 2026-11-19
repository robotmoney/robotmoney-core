// SPDX-License-Identifier: MIT
// Canonical: docs/technical/one-vault-rebalancer-proposal.md §4.2, §5.11.5 (Step 3f index snapshots), §7 RB-22;
//            docs/technical/one-vault-timed-flows-eng-plan.md E13, E52, A19
// Experiment prototype only (contracts/test/prototype/). Not a production contract.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ForeignTokenQuarantine} from "./lib/ForeignTokenQuarantine.sol";
import {IStrategyAdapter} from "./interfaces/IStrategyAdapter.sol";

/// @dev Fund reads needed by the exclusion ledger (E13, E52).
interface IFundLedgerSource {
    function quarantineAddress() external view returns (address);
    /// @dev Wallet shares plus queued shares of `account`; 0 for the FlowQueue itself (RobotMoneyFund).
    function ledgerBalanceOf(address account) external view returns (uint256);
    /// @dev Bound FlowQueue address (`address(0)` before binding).
    function flowQueue() external view returns (address);
}

/// @dev Minimal FlowQueue index-snapshot read surface (E52, RB-22).
interface IFlowQueueSnapshot {
    function currentMatchIndexes()
        external
        view
        returns (uint256[2] memory depIdx, uint256[2] memory redIdx);
    function queuedSharesOfAt(
        address account,
        uint256[2] calldata depIdx,
        uint256[2] calldata redIdx
    ) external view returns (uint256);
}

/// @title FundExclusionLedger
/// @notice Step 3f (E13, E52, RB-22): tracks exclusion recovery pro rata to holders at the moment an
///         ineligible adapter is excluded, including shares held inside `FlowQueue`.
///
///         When `open` records an exclusion `id`, it also snapshots `(depIdx, redIdx)` from `FlowQueue.currentMatchIndexes()`.
///         When `_checkpoint` runs lazily on a later balance or queue mutation, it fills one checkpoint per missed
///         snapshot `id` using `wallet + FlowQueue.queuedSharesOfAt(holder, depIdx[id], redIdx[id])`, ensuring
///         earlier match indexes stay immune to later O(1) whole-match updates between checkpoints.
contract FundExclusionLedger {
    using SafeERC20 for IERC20;

    enum RecoverySource {
        EmergencyWithdrawAdapter,
        EmergencyWithdraw,
        AdminRebalance,
        Restoration
    }

    enum FinalizeReason {
        Restored,
        Removed,
        ForceRemoved
    }

    struct Exclusion {
        uint256 adapterIndex;
        address adapter;
        uint48 openedBlock;
        uint40 openedAt;
        bool finalized;
        uint256 snapshotSupply;
        uint256 adapterValue;
        uint256 recoveredUsdc;
        uint256 claimedUsdc;
    }

    struct Checkpoint {
        uint48 id;
        uint208 balance;
    }

    address public immutable VAULT;
    IERC20 public immutable USDC;

    uint256 public exclusionCount;
    mapping(uint256 id => Exclusion) public exclusions;
    mapping(uint256 id => mapping(address holder => uint256 amount)) public claimed;
    uint256 public heldUsdc;

    // slither-disable-next-line uninitialized-state
    mapping(address holder => Checkpoint[]) private _checkpoints;

    // Step 3f (E52): per-exclusion match index snapshots read from FlowQueue at `open`.
    mapping(uint256 id => uint256[2]) private _depIndexes;
    mapping(uint256 id => uint256[2]) private _redIndexes;

    event ExclusionOpened(
        uint256 indexed exclusionId,
        uint256 indexed adapterIndex,
        address indexed adapter,
        uint256 snapshotSupply,
        uint256 adapterValue
    );
    event ExclusionRecoveryCredited(
        uint256 indexed exclusionId,
        RecoverySource indexed source,
        uint256 amount,
        uint256 recoveredUsdc
    );
    event ExclusionFinalized(
        uint256 indexed exclusionId, FinalizeReason indexed reason, uint256 recoveredUsdc
    );
    event ExclusionClaimed(uint256 indexed exclusionId, address indexed holder, uint256 amount);
    event ExclusionSurplusReturned(uint256 amount);

    error OnlyVault();
    error ExclusionNotOpen(uint256 exclusionId);

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    constructor(address vault_, IERC20 usdc_) {
        VAULT = vault_;
        USDC = usdc_;
    }

    // ─── Vault-only writes ────────────────────────────────────────────

    /// @notice Open a record and snapshot both supply and `FlowQueue` match indexes (E52). Vault only.
    function open(uint256 adapterIndex, address adapter, uint256 snapshotSupply)
        external
        onlyVault
        returns (uint256 id)
    {
        uint256 adapterValue = 0;
        try IStrategyAdapter(adapter).totalAssets() returns (uint256 reported) {
            adapterValue = reported;
        } catch {}
        id = ++exclusionCount;
        exclusions[id] = Exclusion({
            adapterIndex: adapterIndex,
            adapter: adapter,
            openedBlock: SafeCast.toUint48(block.number),
            openedAt: SafeCast.toUint40(block.timestamp),
            finalized: false,
            snapshotSupply: snapshotSupply,
            adapterValue: adapterValue,
            recoveredUsdc: 0,
            claimedUsdc: 0
        });
        address q = _flowQueue();
        if (q != address(0)) {
            (uint256[2] memory depIdx, uint256[2] memory redIdx) =
                IFlowQueueSnapshot(q).currentMatchIndexes();
            _depIndexes[id] = depIdx;
            _redIndexes[id] = redIdx;
        }
        emit ExclusionOpened(id, adapterIndex, adapter, snapshotSupply, adapterValue);
    }

    /// @notice Credit `amount` USDC, already transferred here by the vault, to record `id`. Vault only.
    function credit(uint256 id, uint256 amount, RecoverySource source) external onlyVault {
        Exclusion storage e = exclusions[id];
        if (id == 0 || id > exclusionCount || e.finalized) revert ExclusionNotOpen(id);
        uint256 recovered = e.recoveredUsdc + amount;
        e.recoveredUsdc = recovered;
        heldUsdc += amount;
        emit ExclusionRecoveryCredited(id, source, amount, recovered);
    }

    /// @notice Close record `id` to further recovery. It stays claimable. Vault only.
    function finalize(uint256 id, FinalizeReason reason) external onlyVault {
        Exclusion storage e = exclusions[id];
        if (id == 0 || id > exclusionCount || e.finalized) revert ExclusionNotOpen(id);
        e.finalized = true;
        emit ExclusionFinalized(id, reason, e.recoveredUsdc);
    }

    /// @notice Record pre-change share balances for any missed snapshots up to `exclusionCount`. Vault only.
    function checkpoint(address from, address to) external onlyVault {
        uint256 current = exclusionCount;
        if (current == 0) return;
        address q = _flowQueue();
        if (from != address(0) && from != q) _checkpoint(from, current, q);
        if (to != address(0) && to != q) _checkpoint(to, current, q);
    }

    // ─── Claims ───────────────────────────────────────────────────────

    function claim(uint256 id, address holder) public returns (uint256 amount) {
        amount = claimable(id, holder);
        if (amount == 0) return 0;
        claimed[id][holder] += amount;
        exclusions[id].claimedUsdc += amount;
        heldUsdc -= amount;
        emit ExclusionClaimed(id, holder, amount);
        USDC.safeTransfer(holder, amount);
    }

    function claimAll(address holder) external returns (uint256 total) {
        uint256 n = exclusionCount;
        for (uint256 id = 1; id <= n; id++) {
            total += claim(id, holder);
        }
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice Stored match indexes `(depIdx, redIdx)` captured from `FlowQueue` when exclusion `id` opened.
    function indexSnapshots(uint256 id)
        external
        view
        returns (uint256[2] memory depIdx, uint256[2] memory redIdx)
    {
        return (_depIndexes[id], _redIndexes[id]);
    }

    /// @notice Vault shares `holder` held (wallet + queue at indexed snapshot `id`) when record `id` opened.
    function balanceAt(address holder, uint256 id) public view returns (uint256) {
        if (id == 0 || id > exclusionCount) return 0;
        Checkpoint[] storage cps = _checkpoints[holder];
        uint256 lo = 0;
        uint256 hi = cps.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (cps[mid].id < id) lo = mid + 1;
            else hi = mid;
        }
        if (lo < cps.length) return cps[lo].balance;
        return _balanceAtSnapshot(holder, id, _flowQueue());
    }

    function claimable(uint256 id, address holder) public view returns (uint256 amount) {
        Exclusion storage e = exclusions[id];
        uint256 supply = e.snapshotSupply;
        if (supply == 0) return 0;
        uint256 owed = Math.mulDiv(e.recoveredUsdc, balanceAt(holder, id), supply);
        uint256 paid = claimed[id][holder];
        return owed > paid ? owed - paid : 0;
    }

    function claimableTotal(address holder) external view returns (uint256 total) {
        uint256 n = exclusionCount;
        for (uint256 id = 1; id <= n; id++) {
            total += claimable(id, holder);
        }
    }

    // ─── Stray tokens ─────────────────────────────────────────────────

    function returnSurplus() external returns (uint256 amount) {
        uint256 bal = USDC.balanceOf(address(this));
        uint256 held = heldUsdc;
        if (bal <= held) return 0;
        amount = bal - held;
        emit ExclusionSurplusReturned(amount);
        USDC.safeTransfer(VAULT, amount);
    }

    function sweepForeignToken(address token) external {
        if (token == address(USDC) || token == VAULT) {
            revert ForeignTokenQuarantine.TokenIsProtected(token);
        }
        ForeignTokenQuarantine.sweep(
            token, IFundLedgerSource(VAULT).quarantineAddress(), msg.sender
        );
    }

    // ─── Internal ─────────────────────────────────────────────────────

    function _flowQueue() private view returns (address) {
        try IFundLedgerSource(VAULT).flowQueue() returns (address q) {
            return q;
        } catch {
            return address(0);
        }
    }

    function _balanceAtSnapshot(address account, uint256 id, address q)
        private
        view
        returns (uint256)
    {
        if (account == q && q != address(0)) return 0;
        if (q == address(0)) return IFundLedgerSource(VAULT).ledgerBalanceOf(account);
        uint256 wallet = IERC20(VAULT).balanceOf(account);
        uint256 queued =
            IFlowQueueSnapshot(q).queuedSharesOfAt(account, _depIndexes[id], _redIndexes[id]);
        return wallet + queued;
    }

    function _checkpoint(address account, uint256 current, address q) private {
        Checkpoint[] storage cps = _checkpoints[account];
        uint256 n = cps.length;
        uint256 lastId = n == 0 ? 0 : cps[n - 1].id;
        if (lastId >= current) return;
        for (uint256 id = lastId + 1; id <= current; ++id) {
            uint256 bal = _balanceAtSnapshot(account, id, q);
            cps.push(Checkpoint({id: SafeCast.toUint48(id), balance: SafeCast.toUint208(bal)}));
        }
    }
}
