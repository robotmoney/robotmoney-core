# Security Audit & Deep Clean — 2026-06-06

Date: 2026-06-06  
Reviewer: Multi-agent automated audit (162 agents, 8 security dimensions)  
Base branch: `dev`  
Commit reviewed: `690ce3eb`  
Scope: full-stack — Solidity contracts, Rust indexer, TypeScript/Vue dapp

---

## Summary

74 confirmed findings across all three layers after adversarial verification pass.
All actionable findings were fixed in this PR. 625 Solidity tests pass (0 new failures),
Rust builds clean with zero Clippy warnings, TypeScript type-checks clean.

---

## Critical / High (5 fixed)

### VAULT-001 — `maxWithdraw`/`maxRedeem` overstate redeemable amounts when exit fee is non-zero
**File:** `contracts/RobotMoneyVault.sol`  
`withdraw(maxWithdraw(owner))` would revert because the fee was not subtracted from the
preview. ERC-4626 §7 requires these functions to return the *maximum amount that would
not cause a revert*.  
**Fix:** overrides now return `previewRedeem(balanceOf(owner))`.

### VAULT-002 — `emergencyUnwind()` fully pauses `BasketVault`, blocking user redemptions
**File:** `contracts/vaults/BasketVault.sol`  
`emergencyUnwind` called `_pause()` (which gated both deposits *and* withdrawals), leaving
users unable to exit after the unwind completed.  
**Fix:** split into `depositsPaused` / `withdrawalsPaused` flags; emergency unwind now sets
deposits-only pause so redemptions remain open.

### GAS-001/002 — Multiple redundant `SLOAD`s per loop iteration in hot paths
**File:** `contracts/RobotMoneyVault.sol`  
`_allocateTo` and `emergencyWithdraw` each re-read `adapters[i].adapter` from storage 3–4×
per iteration.  
**Fix:** cached to a stack-local variable before the loop body.

### FIND-002 — `r.status in [0,1,2]` JS `in` operator checks index keys, not values
**File:** `clients/dapp/src/` (VaultRecord status check)  
The expression `r.status in [0,1,2]` tests whether `r.status` is a valid array *index*
(0, 1, 2), not whether the value is contained in the array. It evaluates `true` for any
integer 0–2, but `false` for all other values including valid enum variants.  
**Fix:** replaced with `[0,1,2].includes(r.status)`.

---

## Medium (31 fixed)

### Access Control
- **AC-002:** `setExecutionDelay` had no minimum floor — added `MIN_EXECUTION_DELAY = 1 hours`
  constant; constructor and setter now revert below it.
- **AC-003:** Constructor granted `EMERGENCY_ROLE` and `ADMIN_ROLE` to the same address — added
  separate `_emergencyResponder` constructor parameter.
- **AC-005:** `twapPrice` returned zero on unkissed Chronicle oracle, bypassing slippage check —
  added `ZeroOraclePrice` revert.

### ERC-4626 Compliance
- `maxDeposit`, `maxMint`, `maxWithdraw`, `maxRedeem`, `previewMint` overrides corrected in
  `RobotMoneyVault` and `BasketVault` to account for fees and caps per the spec.
- `VaultRegistry.registerVault` now verifies the registered asset matches `IERC4626.asset()`.

### Oracle Safety
- **ORA-001:** Chronicle `latestAnswer()` not validated for zero — added revert guard.
- **VAULT-006:** TWAP `observe()` revert blocked `emergencyUnwind()` permanently on low-liquidity
  pools — wrapped in try/catch with slot0 fallback.

### MEV / Governance
- **MEV-001:** Immediate `block.timestamp` deadline on swap calls — deadline parameter added to
  swap interface; callers required to pass explicit future timestamp.
- **GOV-001:** Zero execution delay allowed in `RouterGovernance` — 1-hour floor enforced.

### Rust Indexer
- **RUST-002:** Serial receipt fetching with no concurrency bound — added `eth_getBlockReceipts`
  fast path with bounded-concurrency fallback (semaphore, 10 concurrent).
- **RUST-003:** Unbounded reorg walk-back to genesis — `MAX_REORG_DEPTH = 1000` guard added.
- **RQ-002:** `expect()` panic on TLS misconfiguration in RPC client — returns `Result<Self, _>`.
- **RQ-003/004:** Silent error swallowing in snapshot helpers and U256→i64 overflow —
  `tracing::warn!` on all optional field failures; sentinel stored with warning.
- **RUST-004:** Bit-shift panic in debug builds when `flag_id >= 64` — bounds check added.
- **RUST-005:** `DATABASE_URL` (plaintext password) visible in `--help` — `hide_env_values = true`.

### Frontend
- **RMDA-001:** Router deposit encoded empty `minSharesPerLeg` — 0.5 % slippage floor computed and
  encoded.
- **FIND-005:** Three parallel fire-and-forget faucet drip calls risked nonce conflicts — serialized
  with `await`; re-entry guard added.
- **FIND-007:** Chain ID 918453 hardcoded in two files — both now import `DEVNET_CHAIN_ID` from
  `dexPools`.
- **FIND-008/009:** No user-visible error on approve/deposit/withdraw failures — error blocks added
  to `DepositWithdrawTab`, `RouterDepositTab`, `MultiVaultWithdrawalTab`.

---

## Low / Informational (38 fixed)

Selected items:

| ID | File | Fix |
|----|------|-----|
| RMV-02 | `RobotMoneyVault.sol` | `lastRebalanceAt` write moved before external calls (CEI) |
| RMV-03 | `RobotMoneyVault.sol` | `emergencyWithdrawAdapter` now checks `adapter.active` flag |
| RMV-04 | `RobotMoneyVault.sol` | `rebalance()` uses `isRebalanceAvailable()` (was `<` instead of `<=`) |
| RMV-06 | `RobotMoneyVault.sol` | Constructor validates `tvlCap >= perDepositCap` |
| DELG-004 | `RobotMoneyVault.sol` | `rescueTokens` validates `address(0)` |
| AC-006 | `UniswapV4SwapAdapter.sol` | `SafeCast.toUint128()` replaces silent truncation |
| GAS-010/011 | `BasketVault.sol` | `assets[i]` cached to `AssetInfo memory ai` in inner loops |
| GAS-012 | `RobotMoneyGateway.sol` | Unreachable dead code in `revealAuthorization` removed |
| GAS-013 | various | Redundant `= 0` initializers removed |
| FIND-010 | dapp | Abort guard used `ac.signal.aborted` instead of local `cancelled` flag — fixed |
| FIND-015 | dapp | `isLoading`/`isError` props added to `BalancesPanel` |
| RQ-005/007–010 | explorer-indexer | Unnecessary clones removed, `Debug` derives added, dead `ChainId` struct removed |

---

## Deferred (4 items — require architectural work)

- **RMDA-003:** Cached `VaultRecord.status` may be stale — registry is intentionally metadata-only;
  a live on-chain status sync requires a separate initiative.
- **GOV-003:** Vault eligibility not re-validated at `execute()` — `isProposalStillExecutable()`
  view function added for off-chain operators; on-chain re-check deferred.
- **VAULT-011:** `SHORTLIST_ADD_DELAY` not enforced on-chain — SECURITY INVARIANT NatSpec added;
  on-chain enforcement requires governance upgrade.
- **AC-008:** No two-step admin transfer — NatSpec warning added to `unpause()`; full two-step
  transfer requires interface change and migration.
