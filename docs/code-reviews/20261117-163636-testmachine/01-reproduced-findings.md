# Reproduced findings

Findings where the described behaviour is genuinely present and reachable at
`d4a43e6d2`. Exact source lines are given (audit line numbers drift slightly).
A note in parentheses flags findings already accepted/known upstream.

## #6 — Exact Morpho pulls can block redemptions despite other liquid adapters

`MorphoAdapter.withdraw` (`MorphoAdapter.sol:147-163`) calls
`MORPHO_VAULT.withdraw(amount, ...)` with no `maxWithdraw` clamp and no try/catch;
`_withdrawFrom` (`RobotMoneyVaultOps.sol:927-934`) calls `adpt.withdraw(pull)`
with no catch, so pass 1 (`:415-467`) aborts before pass 2 or other adapters.
`totalAssets()` counts the full position at `convertToAssets` face value (`:197`).
Pinned by `test_illiquidAdapterEmergencyDrainKeepsExitersAndStayersAtParity`: a
3,000 USDC redeem reverts while 4,000 USDC sits liquid in other adapters. Only
mitigation is privileged `EMERGENCY_ROLE` exclusion. Upstream MetaMorpho is not
vendored; the liquidity premise is protocol knowledge.

## #9 — Morpho illiquidity omitted from the deposit-health gate

`anyActiveBlocked` (`RobotMoneyVaultOps.sol:202-206`) treats a failed/missing
`venueWithdrawable()` staticcall as healthy. `MorphoAdapter` (`MorphoAdapter.sol:25`)
does not implement `IVenueHealthAdapter`, so it is always treated healthy;
`RobotMoneyVault.sol:685-693` gates deposits on this. Refused MetaMorpho
allocations are returned idle (`:119-128`), enabling the described socialisation.

## #10 — Pause-only venue checks miss liquidity-driven failures

`AaveV3Adapter.venueWithdrawable` (`AaveV3Adapter.sol:121-124`) checks only
active/paused config bits; `CompoundV3Adapter.venueWithdrawable`
(`CompoundV3Adapter.sol:115-117`) checks only `isWithdrawPaused()`. Both can be
active/unpaused yet cash-constrained at high utilisation, leaving deposits open.
Existing tests only exercise pause flags. Upstream sources not vendored.

## #11 — Pre-swap TVL check does not cap favorable realized NAV

`BasketVault.sol:633` checks `tvlCap` against nominal `usdcAmount`; post-swap
`realizedDelta` (`:654`) is minted with only a lower slippage floor (`:653-655`)
and no upper bound. The ORA-4 spot/TWAP deviation guard is a no-op at threshold 0
(`TwapTickMath.sol:107`, `BasketViews.sol:117`). Depositing nominal headroom can
leave `totalAssets() > tvlCap`.

## #12 — Pro-rata rounding can permanently lock exclusion recoveries (intentional)

`ExclusionLedger.sol:227-229,260-268,306-313,330-337`:
`heldUsdc = Σcredits − Σ floor-rounded claims`. Once all holders claim, sub-unit
dust remains with `claimable == 0` and `returnSurplus` returns 0. The arithmetic is
correct but NatSpec (`:34`: "Rounding dust stays here… a claim never expires")
and tests (`RobotMoneyVault.t.sol:1108-1125`) treat it as intentional; impact is
≤1–2 atomic units.

## #13 — Redeemer authorization allowance is reusable

`PortfolioRouter.sol:1069` checks holder→caller allowance; `:1077`
`vault.redeem(...)` consumes holder→router allowance (the router is `msg.sender`).
No `_spendAllowance` on the share token exists in the redeem path. A caller with a
small reusable allowance can repeatedly redeem against a larger standing
holder→router approval, redirecting proceeds to `assetRecipient`. Precondition:
the explicitly discouraged standing router approval (NatSpec `:948-960`).

## #15 — Single-unit basket legs skipped during full redemption (known)

`BasketVault.sol:917-920` burns before `_sellProportional`; `:953-964` skips a leg
when `sellAmount == 1` because `_slippageFloor(sellAmount - 1) == 0`. No underflow
(zero is skipped earlier); skipped active tokens remain counted in NAV and cannot
be reabsorbed (`BasketSwaps.sol:165`). After a full redeem, supply can be 0 with
orphaned value that a next depositor captures. No dedicated test covers that
orphan-capture path. Known dust-skip behaviour (`docs/technical/smart-contract-invariants.md:122`); the
capture is a transfer, not free profit for a single actor.

## #16 — Split in-kind redemptions avoid per-leg exit fees

`BasketAssetConfigGuard.sol:303-307` floors the exit fee per leg per call
(`MAX_EXIT_FEE_BPS = 100`) with no cumulative accounting or minimum. Onboarding
(`:106-128`) does not constrain decimals/atomic value, so splitting into chunks
whose leg amount is `< 10_000 / exitFeeBps` pays zero fee while withdrawing a
material position. Analogous stable-vault issue FS-VLT-23 is accepted; no
equivalent acceptance exists for this path.

## #17 — Same-block receipts mutually exclusive

`ConsensusRecommendationReceipt.sol:167` stamps `recordedAt = block.timestamp`;
`RouterGovernance.sol:191-193` requires strictly `>` with no tie-breaker or batch
path. Directly pinned at the pin by the same-second refusal test.
Citation updated after the fix: the finding 17 remediation replaced that test with
`RouterGovernanceApplyReceipt.t.sol::test_applyReceipt_sameRecordedAtAppliesInIssuanceOrder`
and `RouterGovernanceApplyReceipt.t.sol::test_applyReceipt_sameRecordedAtRefusesEarlierIssuance`.

## #18 — Token donations prevent asset deactivation (accepted)

`BasketVault.sol:1164-1166` → `BasketAssetConfigGuard.sol:231-241` reverts
`AssetStillHeld` when a donated balance has ≥1 post-slippage USDC unit. Cleanup
(`emergencyUnwind`, `BasketVault.sol:1299-1303`) is a separate EMERGENCY_ROLE
entrypoint and active assets cannot use `reabsorbRemovedAsset` (`BasketSwaps.sol:165`).
Already accepted as FS-VLT-26 (`docs/audits.md:291`, "confirmed, minor").

## #19 — V4 recorder commits a transient spot tick (mechanic)

`UniswapV4PriceRecorder.sol:151-179,293-335`: `record()` clamps the live tick
(≤600/record) and stores it as `lastTick`; one-write-per-timestamp blocks restoring
it and `observe()` extrapolates with the poisoned tick for the following interval.
Pinned by `SecurityReviewRevisionAssessment.t.sol::test_assessment_transientTickPersistsForFullWindowWithoutHonestRecord`.
The ≤10 ticks/s drag and ORA-4 guard (`BasketViews.sol:113-117`) bound the claimed
overmint; the test file explicitly does not establish economic exploitability.

## #22 — Reverting/malformed health probes treated as withdrawable

`RobotMoneyVaultOps.sol:204` returns blocked only on
`ok && data.length == 32 && decoded == 0`; reverts/malformed data fall through as
healthy. `IVenueHealthAdapter.sol:7-9` documents the opposite ("reads a missing or
reverting view as true"), while `RobotMoneyVaultOps.sol:188-189` documents
fail-open — a direct doc/implementation contradiction gating real deposits via
`RobotMoneyVault.sol:691-693`.
