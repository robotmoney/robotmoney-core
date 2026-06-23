# Azimuth AZ-0623 Contract Remediation — Dev Scout

> Scout issue: #1072
> Phase: Azimuth contract remediation
> Canonical docs:
>   - `docs/code-review/20260623-code-review-testmachine-azimuth.md`
>   - `docs/audits.md`

---

## 1. Hot-file ownership map

Three contract files are touched by nine remediation issues. This section maps
which issue owns which line ranges so parallel PRs can be sequenced without
creating merge conflicts.

### 1a. `contracts/gateway/RobotMoneyGateway.sol` (1410 lines)

| Issue | Finding | Primary mutation site | Lines (approx.) |
|-------|---------|----------------------|-----------------|
| #1055 | AZ-GW-1: shareReceiver consent check in `_authorizeAgentInternal` | Add consent revert inside `_validatePolicy` (L664–677) and/or add named error declaration section (L50–100) | L615–677, error decl block |
| #1062 | AZ-GW-3: empty `allowedSourceVaults` falls through to pinned-vault enforcement | Change condition at L1247–1258 from `if (slen > 0) { ... }` to always-enforce pinned-vault when `slen == 0` | L1245–1258 |

**Conflict analysis:** The two regions are non-overlapping. #1055 modifies the
authorization path (L615–677); #1062 modifies the router-withdrawal source-vault
check (L1245–1258). No structural overlap exists.

**Safe merge order for `RobotMoneyGateway.sol`:**

Both issues may land in parallel since their edit regions are disjoint. If both
PRs are open simultaneously, either can merge first. No serialization required.

However, the logical dependency ordering to preserve correctness:
- #1055 (AZ-GW-1) is rated Critical/mainnet-blocking — land first in plan order.
- #1062 (AZ-GW-3) is Medium/mainnet-blocking — land second.

---

### 1b. `contracts/vaults/BasketVault.sol` (1530 lines)

| Issue | Finding | Primary mutation site | Lines (approx.) |
|-------|---------|----------------------|-----------------|
| #1059 | FS-VLT-19 / AZ-REG-1: implement `IRetirableVault` in BasketVault | Add `retire()` / `unretire()` functions (new code, no existing function to modify). Closest anchor: after L1086 (`_setDepositsPaused` at end of pause/unpause block). Also: `VaultRegistry.sol` L286–292 (setVaultStatus try/catch change) | L1076–1090 region + new functions |
| #1060 | AZ-BSK-1 / AZ-BSK-2: credit realized NAV not slippage floor + override ERC4626 return values | Modify `_deposit` credit logic at L530–535; add `deposit()` and `redeem()` overrides (new functions) | L527–538, new override functions |
| #1064 | AZ-BSK-3: deposit NAV must exclude inactive adapters | Add `_eligibleAdapterNAV()` internal view; modify `_deposit` credit calculation at L531 to use it instead of `totalAssets()` | L527–538 (same region as #1060) |
| #1065 | AZ-BSK-5: add slippage floor to `reabsorbRemovedAsset` | Change function signature at L1023; add `minUsdcOut` enforcement before swap | L1023–1054 |

**Conflict analysis:**

- #1060 and #1064 both touch `_deposit` at L527–538 — **these CONFLICT** and
  must not run in parallel on the same branch. They must serialize.
- #1059 and #1065 each touch disjoint regions but are architecturally coupled:
  `retire()` hooks may interact with `depositsPaused` state that #1064 reads.
- #1065 only modifies `reabsorbRemovedAsset` (L1023+) — disjoint from L527–538.

**Safe merge order for `BasketVault.sol`:**

```
#1059  → (no dep)  — retire/unretire + VaultRegistry hook propagation
#1060  → #1059     — BSK-1/BSK-2 credit fix + ERC4626 return-value overrides
  ↳ #1060 must merge BEFORE #1064 (both touch _deposit L527–538)
#1064  → #1060     — BSK-3 exclusion-NAV isolation (extend _deposit modification)
#1065  → (no dep)  — BSK-5 reabsorb slippage (disjoint region; can land any time)
```

Recommended sequential order: `#1059 → #1060 → #1064`, with `#1065` able to
land in parallel with any of them.

**Critical serialization constraint:** #1060 and #1064 MUST NOT merge
simultaneously. #1064 extends the same `_deposit` credit logic that #1060
restructures. #1060 must land and be rebased against before #1064's PR is
opened or merged.

---

## 2. `contracts/VaultRegistry.sol` changes (issue #1059 co-owner)

Issue #1059 (FS-VLT-19 / AZ-REG-1) also modifies `VaultRegistry.sol`:
- `setVaultStatus` at L286–292: changes `try IRetirableVault(vault).retire() {}
  catch {}` from a silent-swallow to revert propagation.

No other AZ-0623 issue touches `VaultRegistry.sol`. No conflict.

---

## 3. Forge test baseline — attack paths (mainnet-blocking findings)

These are the 6 mainnet-blocking findings from the AZ-0623 scan. No forge test
currently exercises these specific attack paths. The tests listed below do NOT
yet exist; they will be added by the corresponding fix issues.

### AZ-GW-1 — Arbitrary shareReceiver drain (Critical)

**Current state:** No test checks that `revealAuthorization` with
`policy.shareReceiver != msg.sender` reverts. The existing
`test_authorizeAgent_permissionless` (RobotMoneyGateway.t.sol:329) and
`test_authorizeAgent_frontRunProtection` (L371) test the commit/reveal flow
but do not assert that an attacker-supplied `shareReceiver` (pointing to a
victim) is rejected.

**Verification:** The `_authorizeAgentInternal` function at L615 stores
`agentOwner[agent] = msg.sender` and `agents[agent] = p` without checking
`p.shareReceiver == msg.sender`. No consent gate exists at HEAD.

**Test to add (by #1055):** In `RobotMoneyGateway.t.sol`:
```
test_revealAuthorization_revertsWhenShareReceiverNotMsgSender
test_revealAuthorization_succeeds_whenShareReceiverIsMsgSender
```

### AZ-BSK-1 / AZ-BSK-2 — Deposit credits floor not realized NAV (High)

**Current state:** No test verifies the credit path where `realizedDelta >
slippageFloor`. The existing `BasketVault.t.sol` deposit tests set up
conditions where delta and floor align or delta < floor. No test checks that
OZ `deposit()` return value equals actual minted shares (not preview).

**Verification:** `BasketVault._deposit` at L530–532 caps credit at the
slippage floor: `credit = usdcAmount.mulDiv(MAX_BPS - maxSlippageBps, MAX_BPS);
if (realizedDelta < credit) credit = realizedDelta;`. When `realizedDelta >
credit`, the surplus stays in vault for existing holders.

**Test to add (by #1060):** In `BasketVault.t.sol`:
```
test_deposit_creditsRealizedDeltaNotSlippageFloor_whenNAVExceedsFloor
test_deposit_returnsActualMintedShares_notPreviewDepositEstimate
test_redeem_returnsActualWithdrawnAssets_notPreviewRedeemEstimate
```

### AZ-RTR-2 — Donated USDC DoS (High)

**Current state:** The existing `CustodyInvariantGuard.t.sol` tests the
absolute-zero custody invariant but does not test that pre-existing USDC dust
on the router blocks subsequent legitimate deposits.

**Verification:** `PortfolioRouter.sol:818` checks
`if (usdc.balanceOf(address(this)) != 0) revert UsdcCustodyInvariantViolated()`.
`PortfolioRouter.sol:412` forbids sweeping USDC. No carve-out exists for
pre-existing dust.

**Test to add (by the PortfolioRouter fix issue):** In `PortfolioRouter.t.sol`:
```
test_depositFor_revertsWhenRouterHasDonatedUsdcDust
test_sweepForeignToken_revertsForUsdc
```

### AZ-GW-3 — Empty allowedSourceVaults bypass (Medium)

**Current state:** `test_withdrawFromRouter_allowedSourceVaults_rejectsUnlisted`
(GatewayRouter.t.sol:1729) tests the non-empty list path only. No test checks
that an empty `allowedSourceVaults` array restricts to the pinned vault.

**Verification:** `RobotMoneyGateway.sol:1247–1258` skips the source-vault
check entirely when `slen == 0`. A withdrawal with an empty allowlist and any
caller-supplied vault succeeds.

**Test to add (by #1062):** In `GatewayRouter.t.sol` or `RobotMoneyGateway.t.sol`:
```
test_withdrawFromRouter_emptyAllowedSourceVaults_restrictsToPinnedVault
test_withdrawFromRouter_emptyAllowedSourceVaults_revertsForNonPinnedVault
```

### FS-VLT-19 / AZ-REG-1 — BasketVault retire hook missing (Medium)

**Current state:** No test exercises `VaultRegistry.retire(basketVaultAddress)`.
`VaultRegistry.t.sol` tests `retire()` only against `RobotMoneyVault` subclasses
that implement `IRetirableVault`. A call against `BasketVault` would low-level
revert at the interface call (L237) and `setVaultStatus` would silently swallow
it (L290–292).

**Verification:** `contracts/vaults/BasketVault.sol` has no `retire()` or
`unretire()` function. `VaultRegistry.sol:290–292` wraps `retire()` in
`try ... {} catch {}`.

**Test to add (by #1059):** In `VaultRegistry.t.sol` and `BasketVault.t.sol`:
```
test_retire_basketVault_succeeds
test_setVaultStatus_propagatesRevertOnRetireHookFailure
test_basketVault_retire_setsDepositsPaused
test_basketVault_unretire_clearsDepositsPaused
```

### AZ-BSK-3 — Exclusion-window NAV isolation missing (Medium)

**Current state:** No test verifies that deposits during an adapter exclusion
window mint shares at an active-only NAV, nor that adapter re-inclusion does not
give new depositors the recovery value.

**Verification:** `BasketVault._deposit` at L531 calls `totalAssets() - taBefore`
which includes all adapter balances — both active and inactive (though the
`totalAssets()` loop at L448 already skips inactive via `if (!assets[i].active)
continue`). The issue is actually that excluded-eligibility adapters at the
`RobotMoneyVault` layer have a separate gap; the BasketVault gap is that the
deposit-path NAV doesn't distinguish eligible vs. active-but-ineligible state
during an exclusion window.

**Test to add (by #1064):** In `BasketVault.t.sol`:
```
test_deposit_duringAdapterExclusion_doesNotCaptureRecovery
test_totalAssets_includesFullBasketNAV_unchanged
```

---

## 4. Compile-safe stubs assessment

No compile-safe stubs are required for this phase. The six fix issues (#1055,
#1059, #1060, #1062, #1064, #1065) each touch non-overlapping file regions
(with the #1060/#1064 exception documented in §1b above). Each issue can be
developed on its own branch without stubs because:

- `RobotMoneyGateway.sol` regions are disjoint between #1055 and #1062.
- `VaultRegistry.sol` is only touched by #1059.
- `BasketVault.sol` regions are disjoint for #1059, #1065; #1060/#1064
  must serialize rather than add stubs to avoid compile-time conflicts.

The only pre-condition for parallel development is that #1064 branches from
the merged HEAD of #1060 (or rebases onto it), not that both be open
simultaneously.

---

## 5. Integration risks discovered

1. **#1060 ↔ ERC4626 conformance tests:** Overriding `BasketVault.deposit()`
   and `BasketVault.redeem()` to return actual amounts (not preview) may break
   `RobotMoneyVault4626Conformance.t.sol` or `ERC4626PreconditionChecks.t.sol`.
   The fix for #1060 must verify these suites pass. (Note: 4 pre-existing
   failures in conformance tests at HEAD are `testFail*` pattern removals, not
   related to this change.)

2. **#1059 ↔ VaultRegistry admin role:** `retire()` and `unretire()` in
   `BasketVault` should be gated by the same role as `RobotMoneyVault`. Verify
   that `ADMIN_ROLE` (not `EMERGENCY_ROLE`) controls `unretire()` — consistent
   with `VaultRegistry.reactivate()` being ADMIN-gated.

3. **#1065 ↔ existing callers of `reabsorbRemovedAsset`:** Changing the
   function signature from `reabsorbRemovedAsset(uint256 index)` to
   `reabsorbRemovedAsset(uint256 index, uint256 minUsdcOut)` is an ABI-
   breaking change. No existing test or production call site outside
   `BasketVault.t.sol` uses this function, but the forge-doc mirror
   (`contracts/doc/`) will need regeneration.

4. **#1055 ↔ `authorizeAgent` (admin path):** The admin-gated `authorizeAgent`
   (L608) also calls `_authorizeAgentInternal`. If #1055 adds a
   `shareReceiver != msg.sender` revert inside `_validatePolicy` or
   `_authorizeAgentInternal`, the admin path would also be affected. The issue
   spec says the consent check is only required for permissionless commit/reveal.
   The fix must scope the consent guard to the `revealAuthorization` path only
   (e.g., add a `requireConsent` bool parameter to `_authorizeAgentInternal`, or
   add the check in `revealAuthorization` directly before calling the internal).

5. **#1062 ↔ `withdrawFromRouter` test coverage:** The current
   `test_withdrawFromRouter_happyPath` (GatewayRouter.t.sol:1466) uses an empty
   `allowedSourceVaults` array. If #1062 enforces pinned-vault restriction for
   empty lists, this test will need to be updated to either use the actual pinned
   vault or add the vault to the allowlist.

---

## 6. Forge build and test baseline (at scout HEAD)

At HEAD `35f28b3b` (dev branch), before any AZ-0623 remediation lands:

```
forge build  → exit 0, no new errors (warnings only: unsafe-typecast in test files)
forge test   → 920 passing, 4 failing (pre-existing: testFail* pattern removed in
               RobotMoneyVault4626Conformance.t.sol — unrelated to AZ findings)
```

No new forge build errors introduced by this scout. No forge test regressions
introduced by this scout (scout is docs-only — no contract changes).
