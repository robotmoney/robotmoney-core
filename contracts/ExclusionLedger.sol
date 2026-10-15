// SPDX-License-Identifier: MIT
// Canonical: docs/architecture.md §4.1 — Vault Family (RobotMoneyVault), ADP-2 adapter exclusion
// Implements: core issue 1820 (pro-rata exclusion recovery), review finding E2
// (See also: contracts/RobotMoneyVault.sol — `setAdapterAllowed`, `_syncExclusions`;
//  docs/adr/ADR-0010-unified-vault-architecture.md §5 — the rejected `revokedIdle` carve-out)
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ForeignTokenQuarantine} from "./lib/ForeignTokenQuarantine.sol";
import {IStrategyAdapter} from "./interfaces/IStrategyAdapter.sol";

/// @dev The one vault read the ledger needs besides `balanceOf`: the governed sweep target.
interface IExclusionLedgerVault {
    function quarantineAddress() external view returns (address);
}

/// @title ExclusionLedger
/// @notice The exclusion record of one `RobotMoneyVault`. When the vault excludes an
///         adapter from NAV (ADP-2: eligibility revoked while the entry is active), the vault
///         opens a record here with a snapshot of its share supply. Every USDC later recovered
///         from that adapter is moved here instead of into vault idle, and belongs pro rata to
///         the holders at the moment of exclusion (owner decision 2026-10-13, core 1820:
///         "we can't take funds from innocent users").
///
///         - A holder who exits during the exclusion is paid at the reduced NAV and KEEPS the
///           claim. A holder who stays gets the same per-share recovery.
///         - Shares minted or received after the exclusion carry no claim, and the vault's
///           share price never rises from a recovery.
///         - The claim is `recoveredUsdc * balanceAt(holder, id) / snapshotSupply`, floored.
///           It can be claimed any number of times as more recovery arrives. Rounding dust
///           stays here. No one can sweep unclaimed USDC: a claim never expires.
///
///         The vault creates this contract through `ExclusionLedgerFactory` in its initializer and is its only writer
///         (`open`, `credit`, `finalize`, `checkpoint`). `claim` is permissionless and always
///         pays the holder, never the caller.
///
///         Per-holder entitlement uses lazy balance checkpoints (the OZ v4 `ERC20Snapshot`
///         pattern): once a record exists, the vault reports every share balance change here
///         first, and the first change after record `id` stores the balance as it stood at
///         `id`. `balanceAt` reads that checkpoint, or the live balance when the holder has not
///         moved since. No off-chain input is needed.
///
///         Read surface for the indexer and the dapp: `exclusionCount`, `exclusions(id)`,
///         `balanceAt`, `claimable`, `claimableTotal`, `claimed`, `heldUsdc`, and the events
///         `ExclusionOpened`, `ExclusionRecoveryCredited`, `ExclusionFinalized`,
///         `ExclusionClaimed`. The vault exposes the ledger as `RobotMoneyVault.exclusionLedger()`
///         and the open record per registry index as `RobotMoneyVault.openExclusionOf(index)`.
contract ExclusionLedger {
    using SafeERC20 for IERC20;

    /// @notice Which vault path moved recovered USDC into a record.
    enum RecoverySource {
        EmergencyWithdrawAdapter,
        EmergencyWithdraw,
        AdminRebalance,
        Restoration
    }

    /// @notice Why a record stopped accepting recovery.
    /// @dev `Restored`: eligibility came back and the residual balance was realised into the
    ///      record first. `Removed`: `removeAdapter` on the drained entry. `ForceRemoved`:
    ///      `forceRemoveAdapter`; whatever was not recovered is a loss borne by the snapshot
    ///      holders only.
    enum FinalizeReason {
        Restored,
        Removed,
        ForceRemoved
    }

    /// @notice One exclusion record.
    /// @param adapterIndex   Vault registry index of the excluded adapter.
    /// @param adapter        Excluded adapter address.
    /// @param openedBlock    Block in which the record opened (the snapshot block).
    /// @param openedAt       Timestamp of that block.
    /// @param finalized      True once no further recovery can be credited.
    /// @param snapshotSupply Vault `totalSupply()` at the snapshot. Claims divide by this.
    /// @param adapterValue   Adapter's self-reported `totalAssets()` at exclusion (0 when the
    ///                       read reverted). Informational: the adapter is no longer trusted.
    /// @param recoveredUsdc  USDC credited so far.
    /// @param claimedUsdc    USDC paid out so far.
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

    /// @dev Balance of one holder as it stood at snapshot `id`.
    struct Checkpoint {
        uint48 id;
        uint208 balance;
    }

    /// @notice The vault this ledger belongs to (its only writer, and the share token).
    address public immutable VAULT;
    /// @notice The vault's asset. Recovered value is held and paid in it.
    IERC20 public immutable USDC;

    /// @notice Number of records ever opened. Ids run 1..exclusionCount; 0 means "none".
    uint256 public exclusionCount;
    /// @notice Record by id.
    mapping(uint256 id => Exclusion) public exclusions;
    /// @notice USDC paid to `holder` from record `id` so far.
    mapping(uint256 id => mapping(address holder => uint256 amount)) public claimed;
    /// @notice USDC this ledger owes across all records (recovered minus claimed).
    uint256 public heldUsdc;

    mapping(address holder => Checkpoint[]) private _checkpoints;

    /// @notice A record opened: `adapter` left NAV and its future recovery belongs to the
    ///         holders of `snapshotSupply` shares at this block.
    /// @param exclusionId    New record id.
    /// @param adapterIndex   Vault registry index of the excluded adapter.
    /// @param adapter        Excluded adapter address.
    /// @param snapshotSupply Vault share supply at the snapshot.
    /// @param adapterValue   Adapter's self-reported value at exclusion (informational).
    event ExclusionOpened(
        uint256 indexed exclusionId,
        uint256 indexed adapterIndex,
        address indexed adapter,
        uint256 snapshotSupply,
        uint256 adapterValue
    );
    /// @notice USDC recovered from the excluded adapter was credited to a record.
    /// @param exclusionId   Record id.
    /// @param source        Vault path that recovered it.
    /// @param amount        USDC credited by this call.
    /// @param recoveredUsdc Record total after this credit.
    event ExclusionRecoveryCredited(
        uint256 indexed exclusionId,
        RecoverySource indexed source,
        uint256 amount,
        uint256 recoveredUsdc
    );
    /// @notice A record stopped accepting recovery. It stays claimable forever.
    /// @param exclusionId   Record id.
    /// @param reason        Why it closed.
    /// @param recoveredUsdc Final recovered total.
    event ExclusionFinalized(
        uint256 indexed exclusionId, FinalizeReason indexed reason, uint256 recoveredUsdc
    );
    /// @notice A holder was paid from a record.
    /// @param exclusionId Record id.
    /// @param holder      Snapshot holder that received the USDC.
    /// @param amount      USDC paid by this call.
    event ExclusionClaimed(uint256 indexed exclusionId, address indexed holder, uint256 amount);
    /// @notice USDC above `heldUsdc` (a direct donation) was returned to the vault's idle NAV.
    /// @param amount USDC returned.
    event ExclusionSurplusReturned(uint256 amount);

    /// @notice Caller is not the vault.
    error OnlyVault();
    /// @notice `credit` or `finalize` named a record that is unknown or already finalized.
    /// @param exclusionId The record id.
    error ExclusionNotOpen(uint256 exclusionId);

    modifier onlyVault() {
        if (msg.sender != VAULT) revert OnlyVault();
        _;
    }

    /// @param vault_ The vault this ledger belongs to: its only writer. `ExclusionLedgerFactory.create`
    ///               passes its caller, the vault proxy, during the vault's initializer (ADR-0014 §9).
    /// @param usdc_  The vault's asset.
    constructor(address vault_, IERC20 usdc_) {
        VAULT = vault_;
        USDC = usdc_;
    }

    // ─── Vault-only writes ────────────────────────────────────────────

    /// @notice Open a record and take its snapshot. Vault only.
    /// @dev Reads the adapter's self-reported value for the record (0 if the read reverts):
    ///      a failing adapter must never block its own exclusion.
    /// @param adapterIndex   Vault registry index of the excluded adapter.
    /// @param adapter        Excluded adapter address.
    /// @param snapshotSupply Vault `totalSupply()` now.
    /// @return id The new record id. It is also the new current snapshot id.
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
        emit ExclusionOpened(id, adapterIndex, adapter, snapshotSupply, adapterValue);
    }

    /// @notice Credit `amount` USDC, already transferred here by the vault, to record `id`.
    ///         Vault only.
    /// @param id     Open record id.
    /// @param amount USDC the vault just moved here.
    /// @param source Vault path that recovered it.
    function credit(uint256 id, uint256 amount, RecoverySource source) external onlyVault {
        Exclusion storage e = exclusions[id];
        if (id == 0 || id > exclusionCount || e.finalized) revert ExclusionNotOpen(id);
        uint256 recovered = e.recoveredUsdc + amount;
        e.recoveredUsdc = recovered;
        heldUsdc += amount;
        emit ExclusionRecoveryCredited(id, source, amount, recovered);
    }

    /// @notice Close record `id` to further recovery. It stays claimable. Vault only.
    /// @param id     Open record id.
    /// @param reason Why it closes.
    function finalize(uint256 id, FinalizeReason reason) external onlyVault {
        Exclusion storage e = exclusions[id];
        if (id == 0 || id > exclusionCount || e.finalized) revert ExclusionNotOpen(id);
        e.finalized = true;
        emit ExclusionFinalized(id, reason, e.recoveredUsdc);
    }

    /// @notice Record pre-change share balances. The vault calls this from `_update` before
    ///         every mint, burn and transfer once a record exists, so `balanceOf` still reads
    ///         the balances as they stood before the change. Vault only.
    /// @param from Share sender (zero on mint).
    /// @param to   Share receiver (zero on burn).
    function checkpoint(address from, address to) external onlyVault {
        uint256 current = exclusionCount;
        if (from != address(0)) _checkpoint(from, current);
        if (to != address(0)) _checkpoint(to, current);
    }

    // ─── Claims ───────────────────────────────────────────────────────

    /// @notice Pay `holder` everything it can claim from record `id` now. Permissionless: the
    ///         USDC always goes to `holder`. Returns 0 (no transfer, no event) when nothing is
    ///         owed.
    /// @param id     Record id.
    /// @param holder Snapshot holder to pay.
    /// @return amount USDC paid.
    function claim(uint256 id, address holder) public returns (uint256 amount) {
        amount = claimable(id, holder);
        if (amount == 0) return 0;
        claimed[id][holder] += amount;
        exclusions[id].claimedUsdc += amount;
        heldUsdc -= amount;
        emit ExclusionClaimed(id, holder, amount);
        USDC.safeTransfer(holder, amount);
    }

    /// @notice `claim` over every record. Permissionless; pays `holder`.
    /// @param holder Snapshot holder to pay.
    /// @return total USDC paid across all records.
    function claimAll(address holder) external returns (uint256 total) {
        uint256 n = exclusionCount;
        for (uint256 id = 1; id <= n; id++) {
            total += claim(id, holder);
        }
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice Vault shares `holder` held when record `id` opened.
    /// @param holder Account to read.
    /// @param id     Record id (= snapshot id).
    /// @return Share balance at the snapshot (0 for an unknown id).
    function balanceAt(address holder, uint256 id) public view returns (uint256) {
        if (id == 0 || id > exclusionCount) return 0;
        Checkpoint[] storage cps = _checkpoints[holder];
        // First checkpoint written at or after snapshot `id`: it holds the balance as it stood
        // at `id`, because nothing moved between `id` and that write.
        uint256 lo = 0;
        uint256 hi = cps.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (cps[mid].id < id) lo = mid + 1;
            else hi = mid;
        }
        if (lo == cps.length) return IERC20(VAULT).balanceOf(holder);
        return cps[lo].balance;
    }

    /// @notice USDC `holder` can claim from record `id` now.
    /// @param id     Record id.
    /// @param holder Account to read.
    /// @return amount `recoveredUsdc * balanceAt / snapshotSupply` (floor) minus what was paid.
    function claimable(uint256 id, address holder) public view returns (uint256 amount) {
        Exclusion storage e = exclusions[id];
        uint256 supply = e.snapshotSupply;
        if (supply == 0) return 0;
        uint256 owed = Math.mulDiv(e.recoveredUsdc, balanceAt(holder, id), supply);
        uint256 paid = claimed[id][holder];
        return owed > paid ? owed - paid : 0;
    }

    /// @notice USDC `holder` can claim across every record now.
    /// @param holder Account to read.
    /// @return total Sum of `claimable(id, holder)` over all records.
    function claimableTotal(address holder) external view returns (uint256 total) {
        uint256 n = exclusionCount;
        for (uint256 id = 1; id <= n; id++) {
            total += claimable(id, holder);
        }
    }

    // ─── Stray tokens ─────────────────────────────────────────────────

    /// @notice Return USDC above `heldUsdc` (a direct donation, never a record's money) to the
    ///         vault, where it is idle NAV for all holders (INV-2). Permissionless.
    /// @return amount USDC returned.
    function returnSurplus() external returns (uint256 amount) {
        uint256 bal = USDC.balanceOf(address(this));
        uint256 held = heldUsdc;
        if (bal <= held) return 0;
        amount = bal - held;
        emit ExclusionSurplusReturned(amount);
        USDC.safeTransfer(VAULT, amount);
    }

    /// @notice Sweep a foreign token to the vault's governed quarantine address (INV-1/INV-2).
    ///         Permissionless. The vault asset and the vault share token are protected.
    /// @param token Foreign ERC-20 to sweep.
    function sweepForeignToken(address token) external {
        if (token == address(USDC) || token == VAULT) {
            revert ForeignTokenQuarantine.TokenIsProtected(token);
        }
        ForeignTokenQuarantine.sweep(
            token, IExclusionLedgerVault(VAULT).quarantineAddress(), msg.sender
        );
    }

    // ─── Internal ─────────────────────────────────────────────────────

    /// @dev Store `account`'s pre-change vault balance as its balance at snapshot `current`,
    ///      once per snapshot. A later change in the same snapshot is not a snapshot balance.
    function _checkpoint(address account, uint256 current) private {
        Checkpoint[] storage cps = _checkpoints[account];
        uint256 n = cps.length;
        if (n != 0 && cps[n - 1].id >= current) return;
        uint256 balance = IERC20(VAULT).balanceOf(account);
        cps.push(Checkpoint({id: SafeCast.toUint48(current), balance: SafeCast.toUint208(balance)}));
    }
}
