# Smart-Contract Holistic Review — 2026-06-18

**Scope:** All production Solidity in `contracts/` (excluding `contracts/test/`,
`contracts/script/` helpers, and generated `contracts/doc/`): core vault
(`RobotMoneyVault`, `RmToken`), router/governance (`PortfolioRouter`,
`RouterGovernance`, `VaultRegistry`), gateway (`RobotMoneyGateway`, `AccessRoles`),
adapters (`AaveV3Adapter`, `CompoundV3Adapter`, `MorphoAdapter`,
`AerodromeSwapAdapter`, `UniswapV4SwapAdapter`, `ChronicleOracleAdapter`,
`UniswapV3PoolSlot0Stub`), specialty vaults (`BasketVault`, `AgentTokenVault`,
`ProtocolAssetVault`, `RwaVault`), and the externalized `lib/TickMath` library.

**HEAD commit:** `126e7ae49a1e62e5dcf25eda45edafc0438436bf` (branch `dev`).

**Prior audit:** [`docs/code-review/smart-contract-vulnerability-audit-20260609.md`](./smart-contract-vulnerability-audit-20260609.md).

**Method — three layers plus adversarial verification:**

1. **Layer 1 — Remediation verification.** Every finding from the 2026-06-09 audit
   (H-1, M-1..M-10, L-1..L-17, I-1..I-10) was independently re-checked against HEAD:
   the fix code was read line-by-line, the inverse/round-trip math re-derived where
   relevant, and the pinning regression test located. Every status that the first
   reviewer marked `partial` or `reproduces` was **double-checked** by a second
   independent reviewer pass (`double_checked` in the evidence set).
2. **Layer 2 — Delta audit.** `git diff 595535f5..HEAD` over production source was
   reviewed file-by-file to find what changed since the post-#836 security
   remediation, and each change was audited for new defects (TickMath
   externalization, PassthroughAdapter removal, EXECUTION_DELAY default, RM/ROBOTMONEY
   rename).
3. **Layer 3 — Fresh review + static analysis.** A new adversarial pass over the
   full surface, plus a Slither 0.11.5 run (`filter_paths lib/,contracts/test/,contracts/script/`)
   with full Medium triage. Every fresh candidate finding was put through an
   adversarial refutation step; only survivors are reported, and several were
   severity-adjusted **down** during refutation.

---

## Headline verdict

The 2026-06-09 remediation effort landed cleanly. Every High and Medium finding is
**closed in code with a pinning regression test**, except **M-10**, whose
snapshot-manipulation half is fully fixed and tested while its `setWeights`-bypass
half is an explicitly-documented, multisig+timelock-gated, accepted privileged-admin
property rather than a separable bug. The protocol's core defenses — 1e18 decimals
offset, TWAP-over-spot NAV, USDC custody invariants, `nonReentrant` coverage,
allowance zeroing, dual adapter/router eligibility checks, codehash + no-delegatecall
guards, and now symmetric mint/deposit slippage haircuts, a true sliding-window rate
limiter, oracle value-sanity bounds, caller-bound commit/reveal, and snapshot-based
voting — are present and tested. The residual surface is **not** an unauthenticated
fund-drain: what remains is one EMERGENCY-key liveness asymmetry (L-3), a missing
router-level redemption floor (L-8), governance-liveness brick risk on last-admin
loss (L-10), and a set of Info-level gas/hygiene items, several of which are
admin-gated or accepted-by-design. Posture is **good and materially improved** over
06-09; the items below are tractable hardening, not blockers to the documented
trust model — but L-3, L-8, and L-10 are in-trust-model and should be fixed before
any mainnet custody of third-party funds.

---

## Layer 1 — Remediation verification

Status legend: **closed** (fix present + correct), **partial** (fixed in code but a
documented residue remains), **reproduces** (defect still present at HEAD).

| ID | Title | Status | Regression test pins it | Test ref |
|----|-------|--------|-------------------------|----------|
| H-1 | `mint()` slippage bypass | **closed** | yes | `BasketVault.t.sol::test_previewMint_grossesUpBySlippage` (L1389), `..._notCheaperThanDeposit_dilutionPrevented` (L1409) |
| M-1 | Oracle zero/degenerate price | **closed** | yes | `RwaVault.t.sol::test_adapter_rejectsZeroNavPrice` (+ below/above MIN/MAX, both directions) |
| M-2 | `withdraw(maxWithdraw)` reverts w/ exit fee | **closed** | yes | `RobotMoneyVault4626Conformance.t.sol::RobotMoneyVault4626ConformanceWithFee` |
| M-3 | `forceRemoveAdapter` arbitrage window | **closed** | yes | `RobotMoneyVault.t.sol::test_forceRemoveAdapter_pausesDeposits` |
| M-4 | RWA unwind bypasses staleness gate | **closed** | yes | `RwaVault.t.sol::test_emergencyUnwind_revertsOnStaleFeed` (L616), `..._withOverride_...` (L629) |
| M-5 | `redeemFor` confused deputy | **closed** | yes | `PortfolioRouter.t.sol::test_redeemFor_unauthorizedCaller_reverts` |
| M-6 | Window cap burst across anchor | **closed** | yes | `RobotMoneyGateway.t.sol::test_deposit_rollingWindow_blocksBoundaryBurst` (L1165) + fuzz (L1297) |
| M-7 | Commit/reveal front-run via open `authorizeAgent` | **closed** | yes | `RobotMoneyGateway.t.sol::test_authorizeAgent_frontRunProtection` (L333) |
| M-8 | `withdraw(assets)` 4626 exactness | **closed** | yes | `BasketVault.t.sol::test_withdrawAndPreviewWithdraw_revertRedeemOnly` |
| M-9 | No execution-delay minimum | **closed** | yes | `RouterGovernance.t.sol::test_setExecutionDelay_revertsOnBelowMin` (L865) + constructor guard (L858) |
| **M-10** | Admin-controlled governance / no vote snapshot | **partial** ⚠ | snapshot half: yes; bypass half: **no (by deploy convention)** | `RouterGovernance.t.sol::test_vote_revertsIfPowerGrantedAfterProposal` (snapshot half); `DeployTimelock.t.sol:134-135` (bypass gating, not enforcement) |
| L-1 | max-* non-zero while paused | **closed** | yes | `RobotMoneyVault.t.sol::test_fullPause_blocksDepositsAndWithdrawals` |
| L-2 | `_pullProportional` sweep/clamp DoS | **closed** | yes | `RobotMoneyVault.t.sol::test_withdraw_sweepCoversLastAdapterShortfall` (L411), `..._revertsWithInsufficientAdapterLiquidity_...` (L379) |
| **L-3** | Irreversible `shutdownVault` on EMERGENCY_ROLE | **reproduces** ⚠ | **no** | — |
| L-4 | Allowlist revocation bricks deposits | **closed** | yes | `RobotMoneyVault.t.sol::test_deposit_skipsAdapterAfterApprovalRevoked_fundsStayIdle` (L337) |
| L-5 | Swap deadline hardcoded to `block.timestamp` | **closed** | yes | `BasketVault.t.sol::test_AerodromeSwapAdapter_swap_forwardsCallerDeadline` |
| L-6 | UniswapV4 unchecked `uint128` cast | **closed** | yes | `BasketVault.t.sol::test_UniswapV4SwapAdapter_swap_revertsOnUint128MinAmountOutOverflow` (L2445) |
| L-7 | Unchecked router return-array indexing | **closed** | yes (structural rewrite) | `BasketVault.t.sol::test_AerodromeSwapAdapter_swap_revertsOnSlippage` |
| **L-8** | `redeemFor` no slippage floor / deadline | **reproduces** ⚠ | **no** | — |
| **L-9** | `setWeights` accepts duplicate vaults | **partial** | **no** | — (admin-gated; accepted) |
| **L-10** | Self-administered ADMIN_ROLE, brick on last-admin loss | **reproduces** ⚠ | **no** | — |
| **L-11** | `rescueUsdc` arbitrary-recipient admin sweep | **reproduces** | **no** | — (accepted-by-design) |
| L-12 | `withdrawFromRouter` payment-id prefix | **closed** | yes | `GatewayRouter.t.sol::test_withdrawFromRouter_paymentIdUsesOpWithdrawRouterPrefix` |
| L-13 | Gateway `withdraw` pulls from agent | **closed** (WONTFIX-by-design, documented) | yes | `RobotMoneyGateway.t.sol::test_withdraw_happyPath_burnsSharesSendsUsdcToRecipient` |
| L-14 | Role separation ignores DEFAULT_ADMIN_ROLE | **closed** | yes | `AccessRoles.t.sol::test_grantAgent_revertsIfAlreadyDefaultAdmin` |
| L-15 | Removed BasketVault assets unrescuable | **closed** | yes | `BasketVault.t.sol::test_rescueTokens_succeedsForInactiveBasketAsset` |
| L-16 | `maxDeposit`/`maxMint` ignore caps/shutdown/pause | **closed** | yes | `BasketVault.t.sol::test_maxDeposit_zeroWhenPaused` (+ shutdown/noAssets/headroom/perDepositCap) |
| L-17 | `setMaxSlippageBps(0)` bricks | **closed** | yes | `BasketVault.t.sol::test_setMaxSlippageBps_revertsBelowPoolFeeFloor` |
| **I-1** | Adapter array never compacted (gas creep) | **partial** ⚠ | **no** | — |
| I-2 | Exit-fee dust floors to zero | **closed** (accepted-by-design) | n/a | — |
| **I-3** | `MorphoAdapter` ignores `type(uint256).max` sentinel | **reproduces** ⚠ | **no (test is false-positive)** | — |
| **I-4** | `RmToken` approve race / infinite-allowance | **reproduces** (accepted, devnet token) | **no** | — |
| **I-5** | `UniswapV3PoolSlot0Stub` no chain-id guard | **partial** (demo-only, fail-closed at vault) | **no** | — |
| **I-6** | UniswapV4 adapter no FoT balance-delta check | **reproduces** (admin-curated input) | **no** | — |
| **I-7** | `VaultRegistry` stores `asset` without 4626 cross-check | **partial** (admin-only, not a safety input) | **no** | — |
| **I-8** | `AgentPolicy` arrays unbounded | **unclear** (owner-self-DoS, out of trust model) | **no** | — |
| I-9 | `MockVault` not production-reachable | **closed** | yes | `RobotMoneyGateway.t.sol::test_constructor_revertsOnAssetMismatch` |
| I-10 | Hardcoded WAD*1e12 scaling undocumented | **closed** (doc-level guard added) | yes | `RwaVault.t.sol` scaling + `UnknownPricePair` revert tests |

### Loud call-outs

**Still reproduces (in-trust-model, no regression test):**

- **L-3 — `shutdownVault()` is irreversible and gated by the lower-trust EMERGENCY_ROLE.**
  `RobotMoneyVault.sol:875-879` sets `shutdown=true` / `tvlCap=0` with no reset
  anywhere in the contract. This *contradicts the vault's own documented trust model*
  (L33-34): the pause/unpause asymmetry exists precisely so a compromised hot
  (EMERGENCY) key can only DoS, never permanently brick, with ADMIN holding recovery.
  `shutdownVault` breaks that — the same hot key permanently bricks the deposit path
  (`_deposit` reverts on `shutdown`, `maxDeposit` returns 0) with no ADMIN un-shutdown.
  This is **in the trust model, not an accepted admin-only risk.**
- **L-8 — `redeemFor` has no `minAssetsOut`/`minAssetsPerLeg` and no `deadline`.**
  `PortfolioRouter.sol:495` / loop L536-537 redeem each leg with zero floor check,
  while the deposit path *does* enforce a per-leg floor (L626-628). The asymmetry is
  real and reachable by any user or by the gateway acting for a depositor — not
  admin-only. BasketVault's per-asset TWAP unwind bound is a per-vault NAV protection,
  not a caller-specified router-level redemption floor.
- **L-10 — Self-administered single ADMIN_ROLE with no last-admin floor.**
  `PortfolioRouter.sol:39,227-228` (mirrored in `RouterGovernance.sol:249-250`,
  `VaultRegistry.sol:169-170`): plain OZ `AccessControl`, `ADMIN_ROLE` self-administered,
  one holder seeded, no `DEFAULT_ADMIN_ROLE` backstop. OZ `renounceRole` is public and
  unguarded; if the sole admin renounces or loses keys, every config path
  (`setWeights`, caps, `rescueUsdc`, voting) bricks permanently. Genuine
  governance-liveness risk in the trust model.

**Partial (fixed-in-code with documented residue):**

- **M-10 — `setWeights`-bypass half.** Snapshot-based voting is fully fixed and
  tested. But `PortfolioRouter.setWeights` (L239-242) is gated only by
  `onlyRole(ADMIN_ROLE)` with no requirement that the call originate from the
  propose/vote/delay path; `DeployTimelock.s.sol:189-198` grants router admin to the
  TimelockController (not to RouterGovernance). So weights can be set via
  Safe→Timelock, bypassing the vote — a documented, accepted privileged-admin (MVP)
  property gated behind multisig+timelock, **not** in-code enforcement and **not**
  pinned by an enforcement test.
- **I-1 — Adapter array never compacted.** `removeAdapter`/`forceRemoveAdapter` only
  flag `active=false`; the add-gate counts active slots, so add→remove→add churn grows
  `adapters.length` unbounded. `totalAssets()` runs on every deposit, so the per-op
  gas cost is borne by ordinary users, not just admin. `MAX_ADAPTERS=20` caps active
  adapters but not array length. No compaction was added.

**Closed-but-untested (verify-only, no dedicated regression test):**

- **I-2** (exit-fee dust → zero) and **I-4** (RmToken approve race / infinite-allowance)
  are accepted-by-design with no pinning test.
- **L-7 secondary site** — the `ChronicleOracleAdapter` `EmptyRouterAmounts` guard has
  no dedicated unit test, though the named finding location (AerodromeSwapAdapter) is
  closed by structural rewrite and is test-covered.
- **M-2 caveat** — the a16z conformance suite asserts `maxWithdraw()` itself does not
  revert under fee=100, but no test does an explicit
  `withdraw(vault.maxWithdraw(owner))` on a funded position at non-zero fee.

**Reproduces but out-of-trust-model / accepted (no action required for trust model):**
I-3, I-4, I-5, I-6, I-7, I-8, L-9, L-11 — each is either admin-gated, demo/devnet-only,
fail-closed at the consumer, or owner-self-inflicted. See Layer 1 table notes; carried
into Layer 3 only where a concrete hardening check is warranted.

---

## Layer 2 — Delta audit since #836

`git diff 595535f5..HEAD` over `contracts/` (production source only) yields a small,
well-contained set of changes. Each was audited.

### 2.1 TickMath externalization (EIP-170 fix, commit 833ba033)

The only non-doc production-source change is a **single-token visibility change**:
`getSqrtRatioAtTick` went from `internal pure` to `public pure`
(`contracts/lib/TickMath.sol:32`). The body was verified **byte-for-byte against
canonical Uniswap v3-core**: the `absTick > MAX_TICK` bounds check (symmetric MIN/MAX),
all 19 mantissa multipliers (L36-57), the `tick>0` inversion (L59), and the round-up
downcast (L63) all match. **Math correctness holds; the computed result is identical
before and after.** (Info — no defect.)

The visibility change does, however, alter **call semantics**: the math is no longer
inlined into each vault's bytecode but `DELEGATECALL`ed to a separately-deployed,
deploy-time-linked TickMath library address, on the NAV/`totalAssets()` path
(`BasketVault.sol:341→653→676`). This is a **Low** delta finding — see L3-D1 below.

### 2.2 PassthroughAdapter / USE_PASSTHROUGH_ADAPTER removal (#917, cc0b1049)

Confirmed **fully removed from the production deploy path.** `Deploy.s.sol::run()`
wires exactly the three real adapters (Aave V3 / Compound V3 / Morpho) at cap-bps
3334/3333/3333 with no branch; there is no `USE_PASSTHROUGH_ADAPTER` env read and no
`passthroughMode` field anywhere in the `Params`/`Deployed` structs.
`contracts/adapters/PassthroughAdapter.sol` is deleted. Its test-only replacement
`NoYieldTestAdapter` is imported only under `contracts/test/`. The CI grep-guard
`check_no_passthrough_adapter.py` (suite-13) passes. **Positive result: the
previously-flagged escape hatch is eliminated; the mainnet deploy surface matches what
was audited.** Residual env-var/chain-id branches all live in demo/devnet scripts and
are chain-id-gated off Base mainnet (`DeployAgentTokenVault.s.sol:155` selects real
config on `chainid==8453`). One Info doc-drift item remains — see L3-D2 below.

### 2.3 EXECUTION_DELAY deploy-default raised to MIN (#867, 24e7da77)

Pure script-default change (`DeployRouterGovernance.s.sol` `DEFAULT_EXECUTION_DELAY`
`0 → 3600`). The substantive 1-hour floor is enforced **on-chain** at
`RouterGovernance.sol:244` (constructor) and `:278` (setter); a sub-floor env value
reverts `ExecutionDelayBelowMinimum()` at construction — the timelock **cannot be
deployed neutralized.** Defense-in-depth confirmed. (Info — no defect.)

### 2.4 RM/ROBOTMONEY rename (#873, 8362b415)

`git diff` of `contracts/RmToken.sol` and `DeployRmToken.s.sol` is **empty.** The
rename is a symbol-string change (`'ROBOTMONEY' → 'RM'`) in the agent-token basket
shortlist, config, tests, and docs only. **No change to mint authority, fixed supply,
or access control** — RmToken still mints once to `initialHolder` with no `mint()`
function and no role surface. (Info — pure label change.)

---

## Layer 3 — New findings (post adversarial refutation)

Only findings that survived the adversarial refutation step are listed. Fresh
candidates that were refuted, or down-rated during refutation, are reflected in the
severities below (two fresh candidates were adjusted **down to Info**).

**De-duplication note:** the Slither divide-before-multiply / incorrect-equality /
uninitialized-local / unused-return clusters were triaged as known-safe and are **not**
re-listed as separate findings; they fold into S-1. No Slither item overlaps a fresh
manual finding, so there is no double-counting.

### Severity summary

| # | Title | Severity | File |
|---|-------|----------|------|
| L3-D1 | Public-library externalization moves NAV math to a deploy-time-linked DELEGATECALL target | Low | `vaults/BasketVault.sol:676`, `lib/TickMath.sol:32` |
| L3-F1 | BasketVault per-leg sell flooring can make `redeem` proceeds dip below `previewRedeem` | Info | `vaults/BasketVault.sol:567-602` |
| L3-F2 | `revokeAgent` leaves rolling-window / paymentId state uncleared; recycled agent inherits stale budget | Info | `gateway/RobotMoneyGateway.sol:468-479` |
| L3-D2 | Stale natspec lists `Passthrough` in the current production adapter set | Info | `script/AdapterBytecodeGuard.sol:17` |
| S-1 | Slither pass: 0 High, 0 true-positive Medium on production code | Info | `slither.config.json` |

### L3-D1 (Low). Public-library externalization moves the NAV/`totalAssets()` math onto a deploy-time-linked DELEGATECALL target

**File:** `contracts/vaults/BasketVault.sol:676` (via `lib/TickMath.sol:32`). **Novel; delta finding.**

Making `getSqrtRatioAtTick` `public` means the four vaults (RwaVault, AgentTokenVault,
ProtocolAssetVault, and any BasketVault subclass) now `DELEGATECALL` a standalone
deployed TickMath library whose address is patched into a bytecode placeholder
(`__$...$__`) at link time, instead of inlining the math. This sits directly on the
NAV path — `totalAssets()` (`:341`) → `_twapQuote` (`:653`) →
`TickMath.getSqrtRatioAtTick` (`:676`) — which gates deposits, withdrawal minimums,
and the TVL-cap check (`:366`).

**Impact:** In normal forge-managed deployment the linking is automatic and correct
(forge auto-deploys+links public libraries during broadcast), so production impact is
negligible. Because the function is `pure`, it reads no caller storage, so there is no
storage-collision/state-tamper risk from the delegatecall itself. The residual
exposure is **operational/availability**: a future hand-rolled or non-forge deploy, or
an ABI/library-hash mismatch, could link a wrong/zero address and either brick all NAV
reads (DoS on deposits/withdrawals) or — only if linked to malicious code — corrupt
TWAP pricing. `DeployDemoExtraVaults.s.sol:400,429` rely on forge auto-linking with no
explicit `--libraries` pin. The `VaultCodeSizeGuard` test asserts code size but does
not assert the linked library is the canonical bytecode.

**Recommendation:** Pin the TickMath library address explicitly in the deploy
scripts/foundry config, **or** add a post-deploy invariant that the linked library's
runtime code hash equals the audited TickMath artifact. Add a deploy-time check that a
representative `totalAssets()`/quote call succeeds and returns a sane value for each of
the four vaults. This converts the implicit forge auto-link trust into an explicit,
verifiable on-chain check.

### L3-F1 (Info). BasketVault per-leg `sellAmount` flooring can make actual `redeem` proceeds fall below `previewRedeem`

**File:** `contracts/vaults/BasketVault.sol:567-602` (`_sellProportional`) vs `452-458` (`previewRedeem`). **Novel.**

`previewRedeem(shares)` applies the slippage haircut once against the **aggregate**
`totalAssets()`. `_sellProportional` instead floors the per-leg sell amount
independently for each asset (`sellAmount = bal.mulDiv(shares, supplyBefore)`, L583)
and skips legs that floor to 0 (L584). In the adversarial corner where every swap
returns exactly its `minUsdcOut` floor, the sum of per-leg floored proceeds can be
strictly below the aggregate preview, so the ERC-4626 `redeem >= previewRedeem` floor
is **not strictly provable** across all multi-asset / low-decimal / small-share inputs.

**Adversarial verdict (not refuted, confirmed Info):** the mechanism is mathematically
real and the cited code matches. But the loss is **dust-bounded** — at most the USDC
value of one smallest token unit per leg. 18-decimal tokens contribute ~0; the only
realistic contributor in the configured baskets is 8-decimal cbBTC (~$0.0006/leg),
keeping the worst realistic 15-asset total well under one cent. `_decimalsOffset()=18`
keeps the discarded proportion bounded to one base unit per leg regardless of redeemer
size. The shortfall stays in the vault and accrues to remaining holders — no drain, no
attacker benefit, economically irrational to chase. It is **already
documented/accepted**: `docs/technical/basket-vault-gap-report.md:91`, the inline
comment at `BasketVault.sol:533`, and ADR-0007 (cited at L442-451) all disclose
`previewRedeem` as a documented worst-case floor. Distinct from M-8 (which was about
`previewWithdraw`/`withdraw` exactness).

**Recommendation:** Add a multi-asset, low-decimal property/fuzz test asserting
`actual redeem net >= previewRedeem` across `1..maxAssets` and small share fractions.
If violations appear, either compute `previewRedeem` from the same per-leg floored sell
amounts it will execute, or subtract a per-leg truncation allowance from the published
floor so it is provably `<=` realized proceeds.

### L3-F2 (Info). `revokeAgent` leaves rolling-window, mirror-struct, and paymentId state uncleared; a recycled agent address inherits a stale budget

**File:** `contracts/gateway/RobotMoneyGateway.sol:468-479`. **Novel.**

`revokeAgent` deletes only `agents[agent]`/`agentOwner[agent]` and revokes
`AGENT_ROLE`. It does not clear the rolling-window accounting
(`_depositWindowEntries/Head/Total`, withdraw equivalents), the mirror structs
(`agentDepositWindow`/`agentWithdrawWindow`), or `usedPaymentIds`. Because an agent
address is reusable once released (`_authorizeAgentInternal` only checks
`agentOwner==0`; pinned by `test_revokeAgent_then_authorizeAgent_by_different_owner`),
a new owner re-claiming the same address inherits the prior owner's outstanding window
totals and consumed payment-id tuples.

**Adversarial verdict (not refuted, confirmed Info — adjusted down from Low):** the
carryover is strictly in the **conservative (restrictive)** direction — it can only
shrink the new owner's effective budget or block an exact-tuple replay, never grant
extra spend. No fund loss, no over-spend, no authority-boundary breach. It is
**self-healing**: `_pruneWindow` ages entries out within `WINDOW_SECONDS` (1 day). The
trigger is narrow (re-claiming the exact released address, which is uncommon since
agents are normally fresh keys, with recent prior-owner spend within the same day). Net:
a transient, self-healing, surprising-but-safe UX/isolation wart that contradicts the
"sole authority over her own agent" isolation property at the margin.

**Recommendation:** In `revokeAgent` (and/or `_authorizeAgentInternal` on fresh
authorize), reset the per-agent rolling-window state and clear the mirror structs.
`usedPaymentIds` carryover is benign once the window reset is in place. Add a test:
revoke → re-authorize same address by a new owner → assert a full-cap deposit succeeds.

### L3-D2 (Info). Stale natspec lists `Passthrough` in the current production adapter set

**File:** `contracts/script/AdapterBytecodeGuard.sol:17`. **Novel; delta finding.**

The library docstring still reads "The current production set (Aave V3, Compound V3,
Morpho, Passthrough) is direct-deployed…". PassthroughAdapter was deleted in #917; the
actual set is Aave V3 / Compound V3 / Morpho. Documentation-only — no code path
references the adapter, and the CI grep-guard does not catch it because its
`FORBIDDEN_TOKENS` are the exact strings `PassthroughAdapter`/`USE_PASSTHROUGH_ADAPTER`,
whereas this comment uses the bare word `Passthrough`. The generated mirror at
`contracts/doc/.../library.AdapterBytecodeGuard.md:16` carries the same stale text.

**Recommendation:** Update the natspec to `(Aave V3, Compound V3, Morpho)`, regenerate
forge doc, and optionally extend the grep-guard to also catch the bare `Passthrough`
substring so doc drift is caught automatically.

### S-1 (Info). Slither pass — 0 High, 0 true-positive Medium on production code

**Tool:** Slither 0.11.5, `slither . --config-file slither.config.json` (filters
`lib/`, `contracts/test/`, `contracts/script/`). **108 contracts, 101 detectors, 299
results.** By impact: **0 High;** Medium = divide-before-multiply (4),
incorrect-equality (19), uninitialized-local (15), unused-return (14); Low = calls-loop
(194), reentrancy-events (2), timestamp (17); Informational = naming-convention (23) and
misc. The `fail_on=high` gate passes.

Every Medium hit on production code was triaged and is a known-safe pattern:

- **divide-before-multiply** (`BasketVault.sol:378,1022`, `RobotMoneyVault.sol:686`) —
  intentional remainder-preserving integer arithmetic; the first active asset absorbs
  the dust, no value lost/created.
- **incorrect-equality** (19 hits) — `==0` zero-amount/zero-supply guards, enum/sentinel
  comparisons, and the Uniswap `OracleLibrary` negative-tick `delta % window != 0`
  rounding correction (`BasketVault.sol:653`). None gate fund movement on an
  attacker-donatable balance equality.
- **uninitialized-local** (15 hits) — zero-default numeric accumulators and
  field-populated memory structs (`args`, `found`) read only after population.
- **unused-return** (14 hits) — ERC-4626 deposit/withdraw share returns that are
  re-derived from balance deltas (MorphoAdapter measures pre/post + `WithdrawShortfall`
  revert), and intentional tuple destructuring (`getVault` status, `observe()`
  tickCumulatives, `addAsset` revert-side-effect probes).

**Recommendation:** No action required from the static pass. Optionally add targeted
`// slither-disable` annotations to keep future runs noise-free.

#### Proposed Foundry invariants

These are the concrete property tests recommended by the fresh pass to lock down the
residual surface (each is a reproducible automated check, no manual acceptance):

1. **BasketVault redeem floor (L3-F1):** fuzz `1..maxAssets` assets at low decimals and
   small share fractions; assert `actualRedeemNet >= previewRedeem(shares)`.
2. **Gateway agent-recycle isolation (L3-F2):** revoke an agent that recently
   deposited/withdrew, re-authorize the same address by a different owner, assert the
   new owner gets a full window budget and unused payment-ids.
3. **TickMath link integrity (L3-D1):** post-deploy, assert
   `extcodehash(linkedTickMath) == audited artifact hash` and that one
   `totalAssets()` call returns a sane (non-reverting, in-range) value for each of the
   four vaults.
4. **Router redemption floor (L-8):** once a `minAssetsPerLeg`/`deadline` param is
   added, fuzz that `redeemFor` reverts when realized proceeds fall below the
   caller-supplied floor or the deadline has passed.
5. **Last-admin floor (L-10):** assert that the final `ADMIN_ROLE` holder cannot
   `renounceRole`/`revokeRole` itself to zero holders across PortfolioRouter,
   RouterGovernance, and VaultRegistry.
6. **Shutdown recoverability (L-3):** once an ADMIN un-shutdown path exists, assert
   EMERGENCY can `shutdownVault` and ADMIN can restore deposits.

---

## Recommended next actions (prioritized by severity)

All items below are phrased as concrete, reproducible automated checks. No manual
acceptance items.

### Low (in-trust-model; fix before mainnet custody of third-party funds)

1. **L-3 — Make `shutdownVault` ADMIN-recoverable.** Add an ADMIN-gated un-shutdown
   (or remove `tvlCap=0` permanence) so the lower-trust EMERGENCY key cannot
   permanently brick the deposit path. **Check:** test that EMERGENCY `shutdownVault`
   then ADMIN restore re-opens deposits (`maxDeposit > 0`, `deposit` succeeds).
2. **L-8 — Add `minAssetsPerLeg` + `deadline` to `PortfolioRouter.redeemFor`.**
   Mirror the deposit-side floor (L626-628). **Check:** fuzz test asserting `redeemFor`
   reverts `SlippageExceeded`/`DeadlineExpired` when realized per-leg proceeds fall
   below the caller floor or `block.timestamp > deadline`.
3. **L-10 — Add a last-admin floor across PortfolioRouter / RouterGovernance /
   VaultRegistry.** Either migrate to a two-step `Ownable2Step`/DEFAULT_ADMIN_ROLE
   backstop or override `renounceRole`/`revokeRole` to forbid dropping to zero ADMIN
   holders. **Check:** test asserting the sole admin cannot renounce/revoke itself to
   an admin-count of zero.
4. **L3-D1 — Pin/verify the linked TickMath address on deploy.** **Check:** post-deploy
   assertion `extcodehash(linkedTickMath) == auditedHash` plus a sane-value
   `totalAssets()` probe for each of the four vaults.

### Info (hygiene / hardening; no exploitable trust-model impact)

5. **M-10 residue / L-9 — Optional:** dedup the `setWeights`/`setDefaultWeights`/
   `propose` vault vectors (reject repeated addresses) and document the Safe→Timelock
   weight-set path as the accepted bypass. **Check:** test asserting `setWeights` with a
   duplicate vault reverts.
6. **I-1 — Add adapter-array compaction** (swap-and-pop on remove) so `adapters.length`
   cannot grow unbounded under churn. **Check:** gas/length test asserting array length
   stays bounded across N add→remove→add cycles.
7. **L3-F1 / L3-F2 / proposed invariants 1–2** — land the redeem-floor and
   agent-recycle property tests above.
8. **L3-D2 — Fix the stale `Passthrough` natspec** and extend the grep-guard to the bare
   substring. **Check:** the existing CI grep-guard, extended, passes.
9. **I-3 — `MorphoAdapter` sentinel:** either implement `type(uint256).max` →
   `redeem(balanceOf(this),…)` or remove the "withdraw all" claim from
   `IStrategyAdapter.sol:13`; and replace the false-positive test fixture
   (`MorphoAdapter.t.sol:60-74` fakes the sentinel) with one over a real-ERC-4626 mock.
   **Check:** a test passing the sentinel through the base (non-faking) mock.
10. **I-5 — Add the `block.chainid` guard** to `UniswapV3PoolSlot0Stub` (or keep relying
    on the BasketVault `MIN_POOL_CARDINALITY`/`observe()` fail-closed gate and document
    the demo-only constraint). **Check:** constructor revert on mainnet chain-id.

---

## Disclaimer

This is an **internal holistic review** by the project's own audit tooling. It
re-verifies prior remediations, audits the delta since the last security pass, and
performs a fresh adversarial + static-analysis sweep — but it is **not a substitute for
an independent external smart-contract audit.** Coverage is bounded by the reviewed HEAD
(`126e7ae4`), the production-source scope stated above, and the time-boxed nature of an
internal pass. Before any mainnet deployment custodying third-party funds, commission a
reputable external audit and a public review period, and re-run this verification
against the exact deployed bytecode and library linkage.
