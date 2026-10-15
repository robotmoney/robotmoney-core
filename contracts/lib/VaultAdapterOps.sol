// SPDX-License-Identifier: MIT
// Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §9 (EIP-170 size budget, item 2)
// (See also: contracts/RobotMoneyVault.sol — every caller below; docs/architecture.md §4.1 —
//  Vault Family (RobotMoneyVault); core 1789 (duplicate adapters), core 1788 / 1820 (exclusion),
//  core 1482 / docs/technical/redeem-gas-1482.md (gas floors), issue #1391 (equal-weight targets))
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStrategyAdapter} from "../interfaces/IStrategyAdapter.sol";
import {IExposureCappedAdapter} from "../interfaces/IExposureCappedAdapter.sol";
import {ExclusionLedger} from "../ExclusionLedger.sol";
import {BpsMath} from "./BpsMath.sol";

/// @title VaultAdapterOps
/// @notice The adapter registry of `RobotMoneyVault` and every loop over it that moves USDC:
///         deposit routing, proportional pulls, registry writes, exclusion records, emergency
///         drains and rebalance legs. A CREATE2-linked library: `public` functions run as the vault
///         through `DELEGATECALL`, so `address(this)` is the vault, `Book storage` is the vault's own
///         state, and events are emitted from the vault's address with the vault's signatures.
/// @dev Why it exists (ADR-0014 §9): behind a UUPS proxy the vault also carries the upgrade code
///      and its former constructor as an initializer. These bodies moved out to keep the vault under
///      EIP-170 with the 1,024-byte margin the ADR requires. The vault keeps every role check, every
///      `nonReentrant` guard and every entry gas floor; nothing here is reachable except through
///      the vault. NAV (`totalAssets`) stays in the vault and uses the `internal` helpers below, so
///      the vault and this library share one definition of eligibility and of equal weight.
///
///      `Book` and `AdapterInfo` are declared once, here (ADR-0014 §8). The storage-layout gate pins
///      them through the vault's snapshot: a change to either fails the gate.
///
///      Errors and events below mirror the vault's declarations (same selectors and topics), so a
///      revert or log from here decodes against the vault ABI.
library VaultAdapterOps {
    using SafeERC20 for IERC20;

    /// @notice One strategy-adapter registry entry.
    /// @param adapter The adapter contract.
    /// @param capBps  Max allocation out of 10_000 bps; also acts as ramp control.
    /// @param active  False once removed or force-removed. Inactive entries are never reused.
    struct AdapterInfo {
        IStrategyAdapter adapter;
        uint16 capBps;
        bool active;
    }

    /// @notice The vault's adapter state, one storage struct so each library call takes one reference.
    /// @param adapters        Ordered registry of all strategy adapters (active and inactive).
    /// @param allowed         Exact adapter instances governance approved to receive the vault's USDC.
    /// @param codeHashAllowed Runtime code hashes governance approved for adapter onboarding.
    /// @param openExclusionOf Open exclusion record id per registry index (0 = none, core 1820).
    struct Book {
        AdapterInfo[] adapters;
        mapping(address adapter => bool allowed) allowed;
        mapping(bytes32 codeHash => bool allowed) codeHashAllowed;
        mapping(uint256 index => uint256 exclusionId) openExclusionOf;
    }

    uint256 internal constant MAX_BPS = BpsMath.BPS_DENOMINATOR;

    // ─── Mirrored vault events ────────────────────────────────────────

    event AdapterAdded(uint256 indexed index, address indexed adapter, uint16 capBps);
    event AdapterRemoved(uint256 indexed index, address indexed adapter);
    event AdapterCapUpdated(uint256 indexed index, uint16 oldBps, uint16 newBps);
    event AdapterMaxExposureSet(uint256 indexed index, address indexed adapter, uint256 cap);
    event AdapterForceRemoved(uint256 indexed index, address indexed adapter, uint256 lossAmount);
    event Allocated(uint256 indexed index, address indexed adapter, uint256 amount);
    event Pulled(uint256 indexed index, address indexed adapter, uint256 amount);
    event UnroutedDeposit(uint256 amount);
    event EmergencyWithdrawCalled();
    event EmergencyWithdrawAdapterCalled(
        uint256 indexed index, address indexed adapter, uint256 amount, bool success
    );

    // ─── Mirrored vault errors ────────────────────────────────────────

    error ZeroAddress();
    error InvalidParam();
    error InvalidCap();
    error MaxAdaptersReached();
    error AdapterAlreadyActive(address adapter, uint256 index);
    error AdapterNotFound();
    error AdapterNotEmpty();
    error AdapterNotAllowed(address adapter);
    error AdapterCodeHashNotAllowed(address adapter, bytes32 codeHash);
    error AdapterCompatibilityCheckFailed(address adapter);
    error AdapterAssetMismatch(address adapter, address expected, address actual);
    error AdapterVaultMismatch(address adapter, address expected, address actual);
    error InsufficientAdapterLiquidity(uint256 requested, uint256 available);
    error InsufficientGas(uint256 available, uint256 required);

    // ─── Shared definitions (internal: compiled into the vault too) ───

    /// @dev Entry eligibility: allowlisted address, allowlisted runtime code hash, and the adapter
    ///      reports this vault's asset and this vault (`address(this)`). Never reverts: the NAV
    ///      path must keep working while an adapter misbehaves (ADP-2 / F-14, audit L-4).
    function isEligible(Book storage b, address usdc, address adapter_)
        internal
        view
        returns (bool)
    {
        if (!b.allowed[adapter_]) return false;
        if (!b.codeHashAllowed[adapter_.codehash]) return false;
        (bool usdcOk, bytes memory usdcData) =
            adapter_.staticcall(abi.encodeWithSignature("USDC()"));
        if (!usdcOk || usdcData.length != 32 || abi.decode(usdcData, (address)) != usdc) {
            return false;
        }
        (bool vaultOk, bytes memory vaultData) =
            adapter_.staticcall(abi.encodeWithSignature("VAULT()"));
        if (!vaultOk || vaultData.length != 32 || abi.decode(vaultData, (address)) != address(this))
        {
            return false;
        }
        return true;
    }

    /// @dev Entry `i` may price into NAV and take or return USDC: no open exclusion record
    ///      (core 1820) and currently eligible. Does not check `active`.
    function isUsable(Book storage b, address usdc, uint256 i) internal view returns (bool) {
        return b.openExclusionOf[i] == 0 && isEligible(b, usdc, address(b.adapters[i].adapter));
    }

    /// @dev Entry `i` counts in NAV and takes proportional pulls: active AND usable. The one NAV-side
    ///      check, so `RobotMoneyVault.totalAssets` and `pullFromAdapters` can never drift apart.
    function isCounted(Book storage b, address usdc, uint256 i) internal view returns (bool) {
        return b.adapters[i].active && isUsable(b, usdc, i);
    }

    /// @dev The `rank`-th active adapter's slice of `total` when `active` adapters split it
    ///      equally. `MAX_BPS / active` alone FLOORS (three adapters: 3333, summing to 9999), so the
    ///      `MAX_BPS % active` remainder bps go one each to the lowest ranks, and the slice is the
    ///      DIFFERENCE OF TWO PREFIX SHARES rather than `total * bps / MAX_BPS`, so the slices
    ///      partition `total` exactly (issue #1391). Because they sum to `total` while the adapters
    ///      hold `total - idle`, routing pass 1's deficits always sum to at least the deposit.
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

    /// @dev Number of active registry entries.
    function activeCount(Book storage b) internal view returns (uint256 count) {
        uint256 len = b.adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (b.adapters[i].active) count++;
        }
    }

    // ─── Deposit routing (hot path; the vault holds `nonReentrant`) ───

    /// @dev Scalars one routing call threads through its passes (memory, to stay within the legacy
    ///      code generator's stack reach).
    struct Route {
        address usdc;
        uint256 totalAfter;
        uint256 gasFloor;
        uint256 remaining;
        uint256 capHeadroom;
    }

    /// @notice Route `amount` idle USDC into the adapters. Body of `RobotMoneyVault._routeDepositAt`.
    /// @dev Pass 1 fills each usable active adapter toward `min(equal-weight slice, capBps)`. Pass 2
    ///      spreads the leftover into adapters with absolute `capBps` headroom, and only runs when
    ///      pass 1 saw headroom (see `_routePass2`). Anything still unrouted stays idle in the vault
    ///      and is reported with `UnroutedDeposit`. A quarantined entry, or one under an open
    ///      exclusion record, is skipped rather than reverted on (audit 2026-06-09 L-4, core 1820).
    /// @param totalAfter          NAV including `amount`, which already sits idle in the vault.
    /// @param adapterCallGasFloor The vault's `ADAPTER_CALL_GAS_FLOOR`, checked before each `deploy`.
    function routeDeposit(
        Book storage b,
        address usdc,
        uint256 amount,
        uint256 totalAfter,
        uint256 adapterCallGasFloor
    ) public {
        // slither-disable-next-line incorrect-equality
        if (amount == 0) return;
        Route memory r = Route({
            usdc: usdc,
            totalAfter: totalAfter,
            gasFloor: adapterCallGasFloor,
            remaining: amount,
            capHeadroom: 0
        });
        // Pass-1 `totalAssets()` reads, held as `balance + 1` so 0 means "not read" without
        // shadowing a genuine zero balance. Reused by pass 2 ONLY when pass 1 allocated nothing at
        // all: then nothing but staticcalls happened in between, so the cached reads are exact.
        // The moment pass 1 allocates, every later read is taken fresh — a cached value would be a
        // MODELLED balance, and pass 2's `capBps` headroom check must never be computed from one.
        uint256[] memory cachedBalance = new uint256[](b.adapters.length);
        _routePass1(b, r, cachedBalance);
        if (r.remaining > 0 && r.capHeadroom > 0) {
            // slither-disable-next-line incorrect-equality
            _routePass2(b, r, cachedBalance, r.remaining == amount);
        }
        // Any USDC still unrouted (e.g. all adapter caps exhausted) stays idle in the vault.
        // Emit an event so off-chain monitors can detect and react (e.g. trigger rebalance).
        if (r.remaining > 0) emit UnroutedDeposit(r.remaining);
    }

    /// @dev Pass 1: fill toward `min(equal target, capBps)`, taken on the balances the two bps
    ///      figures denote so the equal-weight slice keeps its exact partition of NAV. Leaves
    ///      `r.remaining` (USDC not placed) and `r.capHeadroom`: the absolute `capBps` headroom over
    ///      the adapters it visited. That scores an allocated adapter as holding
    ///      `currentBalance + allocation`, an UPPER bound on what a share-priced adapter really holds
    ///      (`MorphoAdapter` rounds down), so it is a LOWER bound on real headroom: pass 2 is never
    ///      entered on a false premise.
    function _routePass1(Book storage b, Route memory r, uint256[] memory cachedBalance) private {
        uint256 active = activeCount(b);
        uint256 rank;
        uint256 len = b.adapters.length;
        for (uint256 i = 0; i < len && r.remaining > 0; i++) {
            if (!b.adapters[i].active) continue;
            uint256 shareBalance = equalWeightBalance(r.totalAfter, rank, active);
            rank++;
            if (!isUsable(b, r.usdc, i)) continue;
            cachedBalance[i] = _pass1Leg(b, r, i, shareBalance);
        }
    }

    /// @dev One pass-1 leg: allocate the deficit to `min(shareBalance, capBalance)`, at most
    ///      `r.remaining`. Returns the read balance + 1 when nothing was allocated, else 0.
    function _pass1Leg(Book storage b, Route memory r, uint256 i, uint256 shareBalance)
        private
        returns (uint256 cachedPlusOne)
    {
        // `capBalance` is the same expression pass 2 uses, so an adapter can never be filled past
        // its cap here.
        uint256 capBalance = (r.totalAfter * b.adapters[i].capBps) / MAX_BPS;
        uint256 targetBalance = shareBalance < capBalance ? shareBalance : capBalance;
        uint256 currentBalance = b.adapters[i].adapter.totalAssets();
        if (currentBalance >= targetBalance) {
            if (capBalance > currentBalance) r.capHeadroom += capBalance - currentBalance;
            return currentBalance + 1;
        }
        uint256 deficit = targetBalance - currentBalance;
        uint256 allocation = deficit < r.remaining ? deficit : r.remaining;
        _allocate(b, r.usdc, i, allocation, r.gasFloor);
        r.remaining -= allocation;
        uint256 filled = currentBalance + allocation;
        if (capBalance > filled) r.capHeadroom += capBalance - filled;
    }

    /// @dev Pass 2: spread `r.remaining` into adapters with absolute cap headroom, re-reading and
    ///      re-checking `capBps` against a real balance before placing. Skipped when pass 1 saw
    ///      no headroom: a cap set summing to exactly `MAX_BPS` (devnet 3334/3333/3333) floors to
    ///      slightly LESS than NAV, so a few wei of every deposit are unplaceable, and re-reading
    ///      every adapter to rediscover that was the second round of reads #1391 removed. The
    ///      trade: skipping may leave a few wei of share-rounding dust idle (on a fork pass 2's
    ///      whole contribution to a `capBps`-bound deposit was ONE wei,
    ///      `VaultForkRegressions.test_fork_unroutedDeposit_emitsEventAndStaysIdle`); it stays in
    ///      NAV and the next deposit or `rebalance` routes it.
    function _routePass2(
        Book storage b,
        Route memory r,
        uint256[] memory cachedBalance,
        bool useCache
    ) private {
        uint256 len = b.adapters.length;
        for (uint256 i = 0; i < len && r.remaining > 0; i++) {
            if (!b.adapters[i].active) continue;
            if (!isUsable(b, r.usdc, i)) continue;
            uint256 cached = useCache ? cachedBalance[i] : 0;
            uint256 currentBalance = cached == 0 ? b.adapters[i].adapter.totalAssets() : cached - 1;
            uint256 capBalance = (r.totalAfter * b.adapters[i].capBps) / MAX_BPS;
            if (currentBalance >= capBalance) continue;
            uint256 headroom = capBalance - currentBalance;
            uint256 allocation = headroom < r.remaining ? headroom : r.remaining;
            _allocate(b, r.usdc, i, allocation, r.gasFloor);
            r.remaining -= allocation;
        }
    }

    // ─── Proportional pull (hot path; the vault holds `nonReentrant`) ─

    /// @notice Pull `remainingNeeded` USDC from the counted adapters for a withdrawal. Body of the
    ///         adapter part of `RobotMoneyVault._pullProportional` (the vault applies idle first).
    /// @dev Only counted (active AND usable) adapters are pulled from: a revoked adapter is excluded
    ///      from NAV, so it must be excluded here too or the proportional denominator would not match
    ///      NAV (ADP-2 / F-14). Fails fast with `InsufficientAdapterLiquidity` when the counted
    ///      adapters cannot cover the request (audit 2026-06-09, L-2). Pass 1 pulls proportionally,
    ///      each pull capped at the adapter's reported balance, and the last counted adapter takes the
    ///      flooring remainder (core 1482), so pass 2 runs only when an adapter is short. Pass 2
    ///      sweeps leftovers across all counted adapters at `min(remaining, balance)`. An
    ///      under-delivering adapter reverts `InsufficientAdapterLiquidity`; it is never funded from
    ///      other holders' idle USDC (FEE-2 / NC-11).
    /// @param adapterCallGasFloor The vault's `ADAPTER_CALL_GAS_FLOOR`, checked before each `withdraw`.
    /// @return pulled USDC the adapters actually returned.
    function pullFromAdapters(
        Book storage b,
        address usdc,
        uint256 remainingNeeded,
        uint256 adapterCallGasFloor
    ) public returns (uint256 pulled) {
        uint256 totalInAdapters;
        uint256 len = b.adapters.length;
        uint256 lastCounted = type(uint256).max;
        for (uint256 i = 0; i < len; i++) {
            if (isCounted(b, usdc, i)) {
                totalInAdapters += b.adapters[i].adapter.totalAssets();
                lastCounted = i;
            }
        }
        if (remainingNeeded > totalInAdapters) {
            revert InsufficientAdapterLiquidity(remainingNeeded, totalInAdapters);
        }

        uint256 remaining = remainingNeeded;
        // Pass 1: proportional pulls, each capped at the adapter's reported balance.
        for (uint256 i = 0; i < len && remaining > 0; i++) {
            if (!isCounted(b, usdc, i)) continue;
            IStrategyAdapter adpt = b.adapters[i].adapter;
            uint256 adapterBalance = adpt.totalAssets();
            uint256 pull =
                i == lastCounted ? remaining : (remainingNeeded * adapterBalance) / totalInAdapters;
            if (pull > remaining) pull = remaining;
            if (pull > adapterBalance) pull = adapterBalance;
            if (pull == 0) continue;
            uint256 actual = _withdrawFrom(adpt, i, pull, adapterCallGasFloor);
            pulled += actual;
            remaining = actual >= remaining ? 0 : remaining - actual;
        }

        // Pass 2: sweep rounding leftovers across all counted adapters, capping each pull at
        // min(remaining, balance), so one short adapter cannot DoS a withdrawal others can cover.
        for (uint256 i = 0; i < len && remaining > 0; i++) {
            if (!isCounted(b, usdc, i)) continue;
            IStrategyAdapter adpt = b.adapters[i].adapter;
            uint256 adapterBalance = adpt.totalAssets();
            uint256 pull = adapterBalance < remaining ? adapterBalance : remaining;
            if (pull == 0) continue;
            uint256 actual = _withdrawFrom(adpt, i, pull, adapterCallGasFloor);
            pulled += actual;
            remaining = actual >= remaining ? 0 : remaining - actual;
        }

        // Adapters under-delivered versus their reported balances (a buggy or lying adapter).
        if (remaining > 0) {
            revert InsufficientAdapterLiquidity(remainingNeeded, remainingNeeded - remaining);
        }
    }

    // ─── Registry writes (ADMIN_ROLE checked by the vault) ────────────

    /// @notice Body of `RobotMoneyVault.addAdapter`.
    /// @dev Reverts `AdapterAlreadyActive` when any ACTIVE entry holds `adapter_` (core 1789):
    ///      two active entries count one balance twice in NAV. Inactive entries are skipped, so a
    ///      re-add after removal appends a NEW entry. Then the count cap, then full eligibility.
    function addAdapter(
        Book storage b,
        address usdc,
        address adapter_,
        uint16 capBps_,
        uint256 maxAdapters
    ) public {
        if (adapter_ == address(0)) revert ZeroAddress();
        if (capBps_ == 0 || capBps_ > MAX_BPS) revert InvalidCap();
        uint256 len = b.adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (b.adapters[i].active && address(b.adapters[i].adapter) == adapter_) {
                revert AdapterAlreadyActive(adapter_, i);
            }
        }
        if (activeCount(b) >= maxAdapters) revert MaxAdaptersReached();
        requireEligible(b, usdc, adapter_);
        b.adapters
            .push(AdapterInfo({adapter: IStrategyAdapter(adapter_), capBps: capBps_, active: true}));
        emit AdapterAdded(len, adapter_, capBps_);
    }

    /// @notice Reverting eligibility check with a typed reason for each failure.
    function requireEligible(Book storage b, address usdc, address adapter_) public view {
        if (!b.allowed[adapter_]) revert AdapterNotAllowed(adapter_);
        bytes32 codeHash = adapter_.codehash;
        if (!b.codeHashAllowed[codeHash]) revert AdapterCodeHashNotAllowed(adapter_, codeHash);

        (bool usdcOk, bytes memory usdcData) =
            adapter_.staticcall(abi.encodeWithSignature("USDC()"));
        if (!usdcOk || usdcData.length != 32) revert AdapterCompatibilityCheckFailed(adapter_);
        address reportedAsset = abi.decode(usdcData, (address));
        if (reportedAsset != usdc) revert AdapterAssetMismatch(adapter_, usdc, reportedAsset);

        (bool vaultOk, bytes memory vaultData) =
            adapter_.staticcall(abi.encodeWithSignature("VAULT()"));
        if (!vaultOk || vaultData.length != 32) revert AdapterCompatibilityCheckFailed(adapter_);
        address reportedVault = abi.decode(vaultData, (address));
        if (reportedVault != address(this)) {
            revert AdapterVaultMismatch(adapter_, address(this), reportedVault);
        }
    }

    /// @notice Body of `RobotMoneyVault.removeAdapter`: the entry must be active and empty. Closes
    ///         its open exclusion record, if any (`Removed`, core 1820).
    function removeAdapter(Book storage b, ExclusionLedger ledger, uint256 index) public {
        _requireActive(b, index);
        if (b.adapters[index].adapter.totalAssets() > 0) revert AdapterNotEmpty();
        b.adapters[index].active = false;
        emit AdapterRemoved(index, address(b.adapters[index].adapter));
        _finalize(b, ledger, index, ExclusionLedger.FinalizeReason.Removed);
    }

    /// @notice Body of `RobotMoneyVault.setAdapterCap`.
    function setAdapterCap(Book storage b, uint256 index, uint16 newCapBps) public {
        _requireActive(b, index);
        if (newCapBps == 0 || newCapBps > MAX_BPS) revert InvalidCap();
        uint16 old = b.adapters[index].capBps;
        b.adapters[index].capBps = newCapBps;
        emit AdapterCapUpdated(index, old, newCapBps);
    }

    /// @notice Body of `RobotMoneyVault.setAdapterMaxExposure` (FS-VLT-10). The event comes first:
    ///         the adapter call is the last step, and a revert there undoes both.
    function setAdapterMaxExposure(Book storage b, uint256 index, uint256 cap) public {
        _requireActive(b, index);
        IStrategyAdapter adapter = b.adapters[index].adapter;
        emit AdapterMaxExposureSet(index, address(adapter), cap);
        IExposureCappedAdapter(address(adapter)).setMaxExposure(cap);
    }

    // ─── Exclusion records (core 1820) ────────────────────────────────

    /// @notice Body of `RobotMoneyVault._syncExclusions`. For every active entry: an ineligible
    ///         entry with no open record gets one, with a snapshot of `supply` (skipped while no
    ///         shares exist: there is no holder to protect). When `restore` is set, an eligible entry
    ///         that still has an open record is restored: its whole balance is withdrawn into the
    ///         record, then the record closes (`Restored`) and the now-empty entry counts again. If
    ///         the adapter cannot pay out, the restore reverts `AdapterNotEmpty`. Opening never calls
    ///         the adapter from here (the ledger try/catches its informational `totalAssets()`), so
    ///         excluding is never blocked.
    /// @return opened True when at least one record opened (the vault then turns on checkpoints).
    function syncExclusions(
        Book storage b,
        address usdc,
        ExclusionLedger ledger,
        uint256 supply,
        bool restore
    ) public returns (bool opened) {
        uint256 len = b.adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (!b.adapters[i].active) continue;
            IStrategyAdapter adpt = b.adapters[i].adapter;
            bool eligible = isEligible(b, usdc, address(adpt));
            uint256 id = b.openExclusionOf[i];
            if (id == 0) {
                if (eligible || supply == 0) continue;
                b.openExclusionOf[i] = ledger.open(i, address(adpt), supply);
                opened = true;
            } else if (eligible && restore) {
                (bool ok,,) =
                    _drain(adpt, id, usdc, ledger, ExclusionLedger.RecoverySource.Restoration);
                if (!ok) revert AdapterNotEmpty();
                _finalize(b, ledger, i, ExclusionLedger.FinalizeReason.Restored);
            }
        }
    }

    // ─── Emergency levers (EMERGENCY_ROLE checked by the vault) ───────

    /// @notice Body of `RobotMoneyVault.emergencyWithdraw` after the deposit halt: sync exclusions
    ///         (open only), then drain every active entry, tolerant of a failing adapter.
    /// @return opened True when the sync opened a record.
    function emergencyWithdrawAll(
        Book storage b,
        address usdc,
        ExclusionLedger ledger,
        uint256 supply
    ) public returns (bool opened) {
        opened = syncExclusions(b, usdc, ledger, supply, false);
        uint256 len = b.adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (!b.adapters[i].active) continue;
            _emergencyPull(b, usdc, ledger, i, false);
        }
        emit EmergencyWithdrawCalled();
    }

    /// @notice Body of `RobotMoneyVault.emergencyWithdrawAdapter` after the deposit halt.
    /// @return opened True when the sync opened a record.
    function emergencyWithdrawOne(
        Book storage b,
        address usdc,
        ExclusionLedger ledger,
        uint256 supply,
        uint256 index
    ) public returns (bool opened) {
        _requireActive(b, index);
        opened = syncExclusions(b, usdc, ledger, supply, false);
        _emergencyPull(b, usdc, ledger, index, true);
    }

    /// @notice Body of `RobotMoneyVault.forceRemoveAdapter` after the deposit halt. The entry's
    ///         balance is treated as lost; an open record closes (`ForceRemoved`) and keeps what was
    ///         recovered, so the rest is a loss for the snapshot holders only.
    function forceRemoveAdapter(Book storage b, ExclusionLedger ledger, uint256 index) public {
        _requireActive(b, index);
        IStrategyAdapter adapter = b.adapters[index].adapter;
        b.adapters[index].active = false;
        uint256 lossAmount;
        try adapter.totalAssets() returns (uint256 reported) {
            lossAmount = reported;
        } catch {}
        emit AdapterForceRemoved(index, address(adapter), lossAmount);
        _finalize(b, ledger, index, ExclusionLedger.FinalizeReason.ForceRemoved);
    }

    // ─── Rebalance ────────────────────────────────────────────────────

    /// @notice Pull leg of `RobotMoneyVault.rebalance`: withdraw each usable active adapter's
    ///         excess over its equal-weight target, up to `maxMovePerCall` in total. Never pulls from
    ///         a quarantined entry or one under an open exclusion record (core 1788 / 1820): its
    ///         balance is outside NAV and recovery goes through the governed paths.
    /// @return totalMoved USDC the adapters returned.
    function rebalancePull(
        Book storage b,
        address usdc,
        uint256 totalAssetsCached,
        uint256 maxMovePerCall
    ) public returns (uint256 totalMoved) {
        uint256 active = activeCount(b);
        uint256 rank;
        uint256 len = b.adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (!b.adapters[i].active) continue;
            if (totalMoved >= maxMovePerCall) break;
            uint256 targetBalance = equalWeightBalance(totalAssetsCached, rank, active);
            rank++;
            if (!isUsable(b, usdc, i)) continue;
            IStrategyAdapter adpt = b.adapters[i].adapter;
            uint256 currentBalance = adpt.totalAssets();
            if (currentBalance <= targetBalance) continue;
            uint256 excess = currentBalance - targetBalance;
            uint256 pull =
                (totalMoved + excess > maxMovePerCall) ? (maxMovePerCall - totalMoved) : excess;
            if (pull == 0) continue;
            uint256 actual = adpt.withdraw(pull);
            totalMoved += actual;
            emit Pulled(i, address(adpt), actual);
        }
    }

    /// @notice Pull leg of `RobotMoneyVault.adminRebalance`: restore eligible excluded entries
    ///         first, then withdraw every active entry's excess over `targetBalances[i]`. A pull from
    ///         an entry under an open record is credited to that record (core 1820, E2), so the drain
    ///         cannot hand the excluded value to today's holders.
    /// @return totalMoved USDC the adapters returned.
    /// @return opened     True when the sync opened a record.
    function adminRebalancePull(
        Book storage b,
        address usdc,
        ExclusionLedger ledger,
        uint256 supply,
        uint256[] memory targetBalances
    ) public returns (uint256 totalMoved, bool opened) {
        if (targetBalances.length != b.adapters.length) {
            revert InvalidParam();
        }
        // Restore first: afterwards every entry under an open record is ineligible, so the
        // allocation leg's eligibility revert alone keeps new USDC out of a record's adapter.
        opened = syncExclusions(b, usdc, ledger, supply, true);
        uint256 len = b.adapters.length;
        for (uint256 i = 0; i < len; i++) {
            if (!b.adapters[i].active) continue;
            IStrategyAdapter adpt = b.adapters[i].adapter;
            uint256 current = adpt.totalAssets();
            if (current > targetBalances[i]) {
                uint256 before = IERC20(usdc).balanceOf(address(this));
                uint256 actual = adpt.withdraw(current - targetBalances[i]);
                totalMoved += actual;
                emit Pulled(i, address(adpt), actual);
                _credit(
                    b.openExclusionOf[i],
                    usdc,
                    ledger,
                    before,
                    ExclusionLedger.RecoverySource.AdminRebalance
                );
            }
        }
    }

    /// @notice Allocation leg of `RobotMoneyVault.adminRebalance`: move idle USDC into each active
    ///         entry below `targetBalances[i]`, in registry order, with the full eligibility revert.
    function adminRebalanceAllocate(
        Book storage b,
        address usdc,
        uint256[] memory targetBalances,
        uint256 adapterCallGasFloor
    ) public {
        uint256 idle = IERC20(usdc).balanceOf(address(this));
        uint256 len = b.adapters.length;
        for (uint256 i = 0; i < len && idle > 0; i++) {
            if (!b.adapters[i].active) continue;
            uint256 current = b.adapters[i].adapter.totalAssets();
            if (current < targetBalances[i]) {
                uint256 deficit = targetBalances[i] - current;
                uint256 allocation = deficit < idle ? deficit : idle;
                _allocate(b, usdc, i, allocation, adapterCallGasFloor);
                idle -= allocation;
            }
        }
    }

    // ─── Views ────────────────────────────────────────────────────────

    /// @notice Body of `RobotMoneyVault.getAdapterInfo`.
    function adapterInfo(Book storage b, uint256 index)
        public
        view
        returns (
            address adapterAddr,
            uint16 capBps,
            bool active,
            uint256 currentBalance,
            uint256 targetBps
        )
    {
        AdapterInfo memory info = b.adapters[index];
        return (
            address(info.adapter),
            info.capBps,
            info.active,
            info.adapter.totalAssets(),
            _targetBpsForIndex(b, index)
        );
    }

    /// @notice Body of `RobotMoneyVault.getAdapterDrift` against NAV `total`.
    function adapterDrift(Book storage b, uint256 total)
        public
        view
        returns (
            uint256[] memory currentBalances,
            uint256[] memory targetBalances,
            int256[] memory drifts
        )
    {
        uint256 len = b.adapters.length;
        currentBalances = new uint256[](len);
        targetBalances = new uint256[](len);
        drifts = new int256[](len);
        uint256 active = activeCount(b);
        uint256 rank;
        for (uint256 i = 0; i < len; i++) {
            if (!b.adapters[i].active) continue;
            targetBalances[i] = equalWeightBalance(total, rank, active);
            rank++;
            currentBalances[i] = b.adapters[i].adapter.totalAssets();
            drifts[i] = int256(currentBalances[i]) - int256(targetBalances[i]);
        }
    }

    // ─── Private helpers ──────────────────────────────────────────────

    /// @dev Reverts `AdapterNotFound` unless `index` names an active registry entry.
    function _requireActive(Book storage b, uint256 index) private view {
        if (index >= b.adapters.length || !b.adapters[index].active) revert AdapterNotFound();
    }

    /// @dev `gasleft()` must cover `floor` before an adapter call (core 1482). Measured inside this
    ///      DELEGATECALL frame, which holds 63/64 of the vault's gas, so it is at least as strict as
    ///      the same check in the vault; the vault's entry floors still bind first.
    function _requireGas(uint256 floor) private view {
        uint256 g = gasleft();
        if (g < floor) revert InsufficientGas(g, floor);
    }

    /// @dev Move `amount` USDC into entry `i` and deploy it, with the full eligibility revert.
    // slither-disable-next-line reentrancy-events
    function _allocate(Book storage b, address usdc, uint256 i, uint256 amount, uint256 floor)
        private
    {
        IStrategyAdapter adpt = b.adapters[i].adapter;
        requireEligible(b, usdc, address(adpt));
        IERC20(usdc).safeTransfer(address(adpt), amount);
        _requireGas(floor);
        adpt.deploy(amount);
        emit Allocated(i, address(adpt), amount);
    }

    /// @dev Withdraw `pull` from entry `i` behind the adapter-call gas floor; returns what it paid.
    function _withdrawFrom(IStrategyAdapter adpt, uint256 i, uint256 pull, uint256 floor)
        private
        returns (uint256 actual)
    {
        _requireGas(floor);
        actual = adpt.withdraw(pull);
        emit Pulled(i, address(adpt), actual);
    }

    /// @dev Equal-weight target in bps for the entry at `index` (0 when inactive). The
    ///      `MAX_BPS % active` remainder bps go one each to the lowest ranks (#1391).
    function _targetBpsForIndex(Book storage b, uint256 index) private view returns (uint256) {
        uint256 len = b.adapters.length;
        if (index >= len || !b.adapters[index].active) return 0;
        uint256 active;
        uint256 rank;
        for (uint256 i = 0; i < len; i++) {
            if (!b.adapters[i].active) continue;
            if (i < index) rank++;
            active++;
        }
        return MAX_BPS / active + (rank < MAX_BPS % active ? 1 : 0);
    }

    /// @dev One emergency drain of active entry `i`, tolerant of a failing adapter. Emits
    ///      `EmergencyWithdrawAdapterCalled` per outcome; only the single-adapter lever reports an
    ///      empty adapter. A pull from an entry under an open record is credited to it.
    function _emergencyPull(
        Book storage b,
        address usdc,
        ExclusionLedger ledger,
        uint256 i,
        bool single
    ) private {
        IStrategyAdapter adpt = b.adapters[i].adapter;
        (bool ok, uint256 actual, bool empty) = _drain(
            adpt,
            b.openExclusionOf[i],
            usdc,
            ledger,
            single
                ? ExclusionLedger.RecoverySource.EmergencyWithdrawAdapter
                : ExclusionLedger.RecoverySource.EmergencyWithdraw
        );
        if (empty && !single) return;
        emit EmergencyWithdrawAdapterCalled(i, address(adpt), actual, ok);
    }

    /// @dev Withdraw `adpt`'s whole reported balance, tolerant of a failing adapter, and credit it
    ///      to record `id` when non-zero. `ok` is false when `totalAssets` or `withdraw` reverted
    ///      (then `actual` is 0); `empty` when the adapter reported no balance (nothing is called).
    function _drain(
        IStrategyAdapter adpt,
        uint256 id,
        address usdc,
        ExclusionLedger ledger,
        ExclusionLedger.RecoverySource source
    ) private returns (bool ok, uint256 actual, bool empty) {
        uint256 balance;
        try adpt.totalAssets() returns (uint256 reported) {
            balance = reported;
            ok = true;
        } catch {}
        empty = ok && balance == 0;
        if (!ok || empty) return (ok, actual, empty);
        uint256 before = IERC20(usdc).balanceOf(address(this));
        try adpt.withdraw(balance) returns (uint256 withdrawn) {
            actual = withdrawn;
            _credit(id, usdc, ledger, before, source);
        } catch {
            ok = false;
        }
    }

    /// @dev Move the USDC that arrived since `before` into record `id` (no-op for id 0). The
    ///      balance delta, not the adapter's return value, is what moves: an excluded adapter is
    ///      untrusted, and overstating its return must not take idle USDC.
    function _credit(
        uint256 id,
        address usdc,
        ExclusionLedger ledger,
        uint256 before,
        ExclusionLedger.RecoverySource source
    ) private {
        if (id == 0) return;
        uint256 recovered = IERC20(usdc).balanceOf(address(this)) - before;
        if (recovered == 0) return;
        IERC20(usdc).safeTransfer(address(ledger), recovered);
        ledger.credit(id, recovered, source);
    }

    /// @dev Close entry `i`'s open record, if any. It stays claimable forever.
    function _finalize(
        Book storage b,
        ExclusionLedger ledger,
        uint256 i,
        ExclusionLedger.FinalizeReason reason
    ) private {
        uint256 id = b.openExclusionOf[i];
        if (id == 0) return;
        delete b.openExclusionOf[i];
        ledger.finalize(id, reason);
    }
}
