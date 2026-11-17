# Audit finding reproduction / rejection report

**Branch:** `audit/reproduce-findings-0.9.0`
**Commit verified:** `d4a43e6d21efed208816698d2b32f0decea45451` (= `release-0.9.0`)
**Date:** 2026-11-17
**Scope:** all 23 findings in `AUDIT_FINDINGS.md` (19 Low + 4 Info)

## Verdict summary

| Verdict | Count | Findings |
|---|---|---|
| **REJECTED** (false premise / not reproducible) | 2 | #21, #23 |
| **REPRODUCED** (behavior genuinely present & reachable) | 12 | #6, #9, #10, #11, #12, #13, #15, #16, #17, #18, #19, #22 |
| **PARTIAL** (real code observation, but bounded / by-design / premise overstated) | 9 | #1, #2, #3, #4, #5, #7, #8, #14, #20 |

Of the 12 REPRODUCED findings, 4 are already recorded in the repo as accepted/known design residues (#12 documented dust retention, #15 documented dust-skip, #18 accepted FS-VLT-26, #19 documented ≤10 ticks/s drag). 6 have in-repo tests that directly encode the behavior (#1, #6, #12, #17, #19, #23).

## Reproduction method

- Full call-path / arithmetic trace of every cited contract at this commit.
- Targeted execution of the in-repo tests that pin or refute each behavior (`forge test`), all passing:
  - `BasketVault.t.sol::test_AZ_BSK5_reabsorbRemovedAsset_revertsSlippageExceeded` → refutes #23
  - `BasketVault.t.sol::test_LIFE6_reabsorbSurvivesDegradedPool` → pins #1's fallback
  - `SecurityReviewRevisionAssessment.t.sol::test_assessment_transientTickPersistsForFullWindowWithoutHonestRecord` → pins #19's mechanic
  - `SecurityReviewPoc.t.sol` / `RobotMoneyVault.t.sol` / `SecurityReviewRecheckVaultPoc.t.sol::test_illiquidAdapterEmergencyDrainKeepsExitersAndStayersAtParity` → pins #6
  - `RouterGovernanceApplyReceipt.t.sol::test_applyReceipt_sameRecordedAtRefused` → pins #17
  - `RecorderSellAnchor.t.sol::test_sellAnchor_youngRecorderUsesItsWholeHistory` → refutes #21's shortened-anchor premise

Audit line numbers drift by a few lines from this commit; quoted snippets match. Exact lines are given below.

---

## REJECTED

### #21 — Permissionless recording can shorten the four-hour sell anchor — REJECTED
The age-based window is real (`BasketViews.sol:213-215`) and the onboarding guard sizes cardinality to only 901 slots (`BasketAssetConfigGuard.sol:136-155`), but the audit conflates that guard minimum with the deployed recorder ring. `DeployUniswapV4PriceRecorder.s.sol:17,37,124` grows the ring to **7,201 slots** and asserts `cardinalityNext == 7_201`. At one record per 2 s Base block, wrapping takes ~4 h, so once warm `oldestObservation()` is ≥ `SELL_ANCHOR_WINDOW` (14,400 s) and the anchor stays at the full four hours. `grow()` is monotone and cannot shrink the ring. `RecorderSellAnchor.t.sol::test_sellAnchor_youngRecorderUsesItsWholeHistory` confirms the short-window case only applies to a deliberately young recorder and is intentional. No attacker-controlled path shortens the shipped anchor to ~30 min.

### #23 — User-supplied reabsorption floor can force a removed asset into quarantine — REJECTED
The premise misreads Solidity `try/catch`. `revert SlippageExceeded()` at `BasketSwaps.sol:170` is inside the **success block** of `try self.emergencyTwapUsdcValue(...)`, not in the external-call expression. Solidity catches only reverts from the external call itself, so a caller-chosen high `minUsdcOut` propagates the revert atomically and never reaches `catch { ForeignTokenQuarantine.sweep(...) }`. Directly refuted by `BasketVault.t.sol:634-656`, which calls `reabsorbRemovedAsset(0, twapFloor + 1)` and expects `SlippageExceeded` (passes). The catch is scoped correctly to oracle unavailability (e.g. `StaleRecorder`, degraded pool).

---

## REPRODUCED

### #6 — Exact Morpho pulls can block redemptions despite other liquid adapters — REPRODUCED
`MorphoAdapter.withdraw` (`MorphoAdapter.sol:147-163`) calls `MORPHO_VAULT.withdraw(amount, ...)` with no `maxWithdraw` clamp. `_withdrawFrom` (`RobotMoneyVaultOps.sol:927-934`) calls `adpt.withdraw(pull)` with no try/catch; pass 1 (`:415-467`) aborts before pass 2 or other adapters. Counted `totalAssets` uses `convertToAssets` (`:197`) at face value. Pinned by `test_illiquidAdapterEmergencyDrainKeepsExitersAndStayersAtParity`: a 3,000 USDC redeem reverts with 4,000 USDC liquid in other adapters. Mitigation is privileged `EMERGENCY_ROLE` exclusion only. (Upstream MetaMorpho not vendored; liquidity premise from protocol knowledge.)

### #9 — Morpho illiquidity omitted from the deposit-health gate — REPRODUCED
`anyActiveBlocked` (`RobotMoneyVaultOps.sol:202-206`) treats a failed/missing `venueWithdrawable()` staticcall as healthy. `MorphoAdapter` (`MorphoAdapter.sol:25`) does not implement `IVenueHealthAdapter`, so it is always treated healthy; `RobotMoneyVault.sol:685-693` gates deposits on this. Refused MetaMorpho allocations are returned idle (`:119-128`), enabling the described socialization. No dedicated PoC test.

### #10 — Pause-only venue checks miss liquidity-driven failures — REPRODUCED (known design limitation)
`AaveV3Adapter.venueWithdrawable` (`AaveV3Adapter.sol:121-124`) checks only active/paused config bits; `CompoundV3Adapter.venueWithdrawable` (`CompoundV3Adapter.sol:115-117`) checks only `isWithdrawPaused()`. Both can be active/unpaused yet cash-constrained at high utilization, leaving deposits open. Tests only exercise pause flags. (Upstream sources not vendored.)

### #11 — Pre-swap TVL check does not cap favorable realized NAV — REPRODUCED
`BasketVault.sol:633` checks `tvlCap` against nominal `usdcAmount`; post-swap `realizedDelta` (`:654`) is minted with only a lower slippage floor (`:653-655`) and no upper bound. The ORA-4 spot/TWAP deviation guard is a no-op at threshold 0 (`TwapTickMath.sol:107`, `BasketViews.sol:117`). A deposit of nominal headroom can leave `totalAssets() > tvlCap`.

### #12 — Pro-rata rounding can permanently lock exclusion recoveries — REPRODUCED (documented/intentional)
`ExclusionLedger.sol:227-229,260-268,306-313,330-337`: `heldUsdc = Σcredits − Σ floor-rounded claims`; once all holders claim, sub-unit dust remains with `claimable == 0` and `returnSurplus` returns 0. Factual state is correct, but NatSpec (`:34`: "Rounding dust stays here… a claim never expires") and tests (`RobotMoneyVault.t.sol:1108-1125`) treat it as intentional; impact ≤1–2 atomic units.

### #13 — Redeemer authorization allowance is reusable — REPRODUCED (with precondition)
`PortfolioRouter.sol:1069` checks holder→caller allowance; `:1077` `vault.redeem(...)` consumes holder→router allowance (router is msg.sender). No `_spendAllowance` on the share token exists in the redeem path. A caller with a small reusable allowance can repeatedly redeem against a larger standing holder→router approval, redirecting proceeds to `assetRecipient`. Precondition: the (explicitly discouraged) standing router approval. No two-allowance PoC exists; docs at `:948-960` acknowledge the risk.

### #15 — Single-unit basket legs can be skipped during full redemption — REPRODUCED (known/documented)
`BasketVault.sol:917-920` burns before `_sellProportional`; `:953-964` skips a leg when `sellAmount == 1` because `_slippageFloor(sellAmount - 1) == 0`. No underflow (zero is skipped earlier); skipped active tokens remain counted in NAV and cannot be reabsorbed (`BasketSwaps.sol:165`). After a full redeem supply can be 0 with orphaned value; a next depositor captures it (`BasketVault.t.sol:2511`). Known dust-skip behavior (`docs/technical/smart-contract-invariants.md:122`); capture is a transfer, not free profit for a single actor.

### #16 — Split in-kind redemptions can avoid per-leg exit fees — REPRODUCED
`BasketAssetConfigGuard.sol:303-307` floors the exit fee per leg per call (`MAX_EXIT_FEE_BPS = 100`); no cumulative accounting or minimum. Onboarding (`BasketAssetConfigGuard.sol:106-128`) does not constrain decimals/atomic value, so splitting into chunks whose leg amount is `< 10_000 / exitFeeBps` pays zero fee while withdrawing a material position. Analogous stable-vault issue FS-VLT-23 is accepted; no equivalent acceptance for this path.

### #17 — Timestamp ordering makes same-block receipts mutually exclusive — REPRODUCED
`ConsensusRecommendationReceipt.sol:167` stamps `recordedAt = block.timestamp`; `RouterGovernance.sol:191-193` requires strictly `>` and has no tie-breaker or batch path. Directly pinned by `RouterGovernanceApplyReceipt.t.sol::test_applyReceipt_sameRecordedAtRefused` (passes): the second same-block receipt is permanently refused.

### #18 — Token donations can prevent asset deactivation — REPRODUCED (accepted FS-VLT-26)
`BasketVault.sol:1164-1166` → `BasketAssetConfigGuard.sol:231-241` reverts `AssetStillHeld` when donated balance has ≥1 post-slippage USDC unit. Cleanup (`emergencyUnwind`, `BasketVault.sol:1299-1303`) is a separate EMERGENCY_ROLE entrypoint; active assets cannot use `reabsorbRemovedAsset` (`BasketSwaps.sol:165`). Already accepted upstream (`docs/audits.md:291`, FS-VLT-26 "confirmed, minor").

### #19 — V4 recorder commits a transient spot tick — REPRODUCED (mechanic; economic overmint bounded)
`UniswapV4PriceRecorder.sol:151-179,293-335`: `record()` clamps the live tick (≤600/record) and stores it as `lastTick`; one-write-per-timestamp blocks restoring it, and `observe()` extrapolates with the poisoned tick for the following interval. Directly pinned by `SecurityReviewRevisionAssessment.t.sol::test_assessment_transientTickPersistsForFullWindowWithoutHonestRecord` (passes). However the ≤10 ticks/s drag and the ORA-4 spot/TWAP guard (`BasketViews.sol:113-117`) bound the claimed overmint; the file header explicitly does not establish economic exploitability.

### #22 — Reverting/malformed venue-health probes treated as withdrawable — REPRODUCED
`RobotMoneyVaultOps.sol:204` returns blocked only on `ok && data.length == 32 && decoded == 0`; reverts/malformed data fall through as healthy. `IVenueHealthAdapter.sol:7-9` documents the opposite ("reads a missing or reverting view as true"), while `RobotMoneyVaultOps.sol:188-189` documents fail-open — a direct doc/implementation contradiction gating real deposits via `RobotMoneyVault.sol:691-693`.

---

## PARTIAL

### #1 — Stale V4 recorder quarantines a removed-asset balance — PARTIAL
Mechanism is real and any caller can trigger it: `reabsorbRemovedAsset` is permissionless (`BasketVault.sol:1195`), the stale-oracle revert is caught by the external self-call `catch` and sweeps the full balance to fixed `QUARANTINE` (`BasketSwaps.sol:164-174`, `ForeignTokenQuarantine.sol:49,75-81`, `UniswapV4PriceRecorder.sol:58,211`). However this is the explicitly documented/test-pinned degraded-oracle safety valve (`BasketVault.sol:1200-1206`; `BasketVault.t.sol::test_LIFE6_reabsorbSurvivesDegradedPool`), the swept balance is already excluded from NAV, and `record()` is permissionless. Real doc inconsistencies (`:1204` says "governed" address but it is a fixed constant; `sweepForeignToken` NatSpec says inactive assets are never quarantined).

### #2 — Deposit availability queries router, not receiver — PARTIAL
`_isDepositable` uses `maxDeposit(address(this))` (`PortfolioRouter.sol:855-869`) while `_executeLeg` deposits to `receiver` (`:1270`). But eligible vaults are the curated family vaults (`isRouterEligible`, `:1359-1374`), whose `maxDeposit` ignores the receiver (`RobotMoneyVault.sol:685`, `BasketVault.sol:860`; router NatSpec `:851-854` says so). Receiver-specific limits are unrealistic here; the second claimed outcome is an all-or-revert, not silent misallocation. No PoC.

### #3 — Deposit slippage floors not bound to previewed vault vector — PARTIAL
Factual gap confirmed (`deposit`/`depositFor` at `:888`/`:914` take no deadline or vector commitment; `_depositTo` snapshots live weights at `:1094`; positional floor at `:1217`; unlike `redeemFor`'s identity binding). Bounded by governance-only weight changes, `LegSkippedWithFloor` (`:1206-1209`), curated vaults, and gateway-side deadline/payment-ID binding. A pure reordering satisfying numeric floors is conceivable but undemonstrated.

### #4 — Deposits front-run recovery of an uncounted inactive balance — PARTIAL
All premises confirmed and executable atomically (`totalAssets` excludes inactive, `:527-538`; deposit mints at reduced NAV, `:631-659`; permissionless reabsorption, `:1195`; successful path credits full balance, `BasketSwaps.sol:171`). But previously documented/accepted-with-rationale (`docs/code-review/20260623-code-review-testmachine-azimuth.md:764-855`) and economically pro-rata: the depositor supplies real capital and captures `D·V/(C+D)`, with slippage floors/fees/deviation guard possibly outweighing net gain.

### #5 — Documented zero TVL-cap sentinel disables deposits — PARTIAL
The stale NatSpec "0 = no cap" (`RobotMoneyVault.sol:430`) and the resulting zero-cap behavior are real, but 0 is intentionally "deposits disabled" (`shutdownVault` sets `tvlCap = 0`, `:1234`; `restoreVault` requires `> 0`, `:1247`). The actual unbounded sentinel is `type(uint256).max` (`_capsUnbounded`, `:711-713`). Deploy tooling forbids zero (`DeployVault.s.sol:278`, `VaultScriptGuards.t.sol:205-209`). A `setTvlCap` setter exists (`:1260-1265`). Documentation hygiene only; no shipped deployment affected.

### #7 — Idle allocation bypasses the per-call rebalance movement cap — PARTIAL
Code fact confirmed (`RobotMoneyVault.sol:1015-1023`; `RobotMoneyVaultOps.sol:747-773`, movement counts only withdrawals), previously flagged as SR-M10. The emergency harm was already fixed (`depositsPaused || shutdown` guards at `:1005-1006`); routing idle is intentional (`RobotMoneyVaultRouteDeposit.t.sol:938-981`) and bounded by capBps/equal-weight ceilings. Idle is already in NAV, so exposure does not increase. Throttle functions as gradualism, not a hard allocation bound.

### #8 — Keeper rebalance targets ignore adapter caps — PARTIAL
No cap clamp in `rebalancePull` (`RobotMoneyVaultOps.sol:747-773`, equal-weight target only); `_ceiling` (`:306-318`) applies to deposits only, and `setAdapterCap` (`:544-550`) only writes storage. But this is a documented equal-weight-by-design rebalancer (FS-VLT-20 accepted "by design, re-converges"; `docs/audits.md:285`), with `adminRebalance` for precise cap enforcement and `KEEPER_ROLE` not granted at launch. A parameter-enforcement gap, not a novel exploitable bug.

### #14 — Router deposits do not enforce the portfolio-routing feature flag — PARTIAL
"No on-chain consumer" is true (`FeatureFlags` used only in its own file and tests). But the flag is explicitly off-chain/UI by design (`FeatureFlags.sol:8-11`; `config/feature-flags.json:14`; ADR-0014 "not deployed, a constants library"); enforcement lives in the Rust indexer/dapp, so there is no on-chain gate to bypass. Residual issue is a documentation ambiguity (`:15` omits "in the dapp").

### #20 — Gateway deposit ignores its caller-supplied share floor — PARTIAL
The missing min-shares assertion is real (`RobotMoneyGateway.sol:575-582,638-650,716-739`), but NatSpec (`:570-574`) states `minSharesPerLeg` is only an idempotency/payment-ID fingerprint (GW-2), never a slippage promise. The gateway deposits a fixed USDC amount to its own receiver; fewer shares is not a protected expectation. Info-severity, documented non-issue.
