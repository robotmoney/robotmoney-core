# 06 — Remediation Status

- **Date:** 2026-11-23
- **Branch:** `adhoc/20261122-233507-safety-review-090`
- **Base:** `dev` at `6c25fd8ce` (contracts identical to tag `contracts-0.9.0`)
- **Ledger:** `docs/audits.md`, section SR-1121 (one row per finding)
- **Proof tests:** `contracts/test/prototype/SafetyReview090.t.sol`, `contracts/test/DelistClaimScaling.t.sol`,
  `contracts/test/ProposerFloorTimelockExecutorFloor.t.sol`, and the keeper scripts' anvil self-tests

Each contract fix has a test that failed on the old code (checked by reverting the fix) and passes now. This is an
internal review: the one-vault contracts still need an external audit before they hold user funds on 8453.

## Contract findings

| Finding | What changed | Test |
|---|---|---|
| Settle gas attack (MISSED-01, Critical) | Round enrollment runs in bounded batches: 32 enrollments and 256 visits a call. A heavy enrollment ends its call, so the booking and the walk get their own call. Ended notices return 16 a call. One owner holds at most 16 open requests a side. A request that names another owner meets the minimum. | `test_MISSED01_*` (old code: 300 one-wei requests put `settle` over the 2^24 per-tx gas cap) |
| Delist claim precision (MISSED-02) | Claim units were fair. The accumulator scale ran out on very long sales: one claimer lost 0.1 % at 600 partial steps. `DELIST_ACC_SCALE` is now 1e48, and every claimer is paid within 0.01 % over 1 000 steps. | `DelistClaimScaling.t.sol` |
| Shutdown then restore (MISSED-03) | A new redemption enrollment first releases the owner's wind-down escrow from the old cycle, so released shares are not counted twice. `restore` runs the pool-share check. | `test_MISSED03_*` |
| Blocked fee recipient (MISSED-04) | Every USDC fee push tries the transfer. A refused fee stays with the holders and emits `FeeNotPaid`. | `test_MISSED04_*` |
| Rebalancer blocked by an in-sale dead feed (MISSED-05) | `Rebalancer._decide` masks in-sale assets out of the feed check. | `test_MISSED05_*` |
| Sub-minimum deposit remainder (MISSED-06) | The settle walk returns a remainder below `minRequestUsdc` to its owner as USDC credit. It never reaches `mintInKind` (RB-14). | `test_MISSED06_*`, `test_RB14_*` |
| Delisting edge cases (MISSED-08) | After shutdown a delisting claim leaves in kind through `settleClaim`. A sale opened with no price gets its start value at the first priced step. Dust worth nothing closes an in-sale asset. | `test_MISSED08_*` |
| Liquidity clamp, TestMachine #16 and #17 (MISSED-09) | A lending sell leg is clamped to the venue's `availableLiquidity`. An in-kind exit fee rounds up. Two receipts recorded in the same second both stay applicable. | `test_MISSED09_*`, `test_TM16_*`, `test_TM17_*` |
| Zero floor on a dead-feed unwind (AGY-01) | `emergencyUnwind(index, minUsdcOut)`. The floor is the larger of the feed floor and `minUsdcOut`. A dead feed needs a non-zero `minUsdcOut`. A stale price is never a floor. | `test_AGY01_AGY03_*` |
| Timelock executor can drop to zero (AGY-02) | `ProposerFloorTimelock` floors `EXECUTOR_ROLE` and refuses a timelock born with no executor. New deployments only: the live Deploy 4 timelock keeps its code. | `ProposerFloorTimelockExecutorFloor.t.sol` |
| Unwound asset stays active (AGY-03) | An emptied basket asset is deactivated by the unwind, as a closed delisting sale is. | `test_AGY01_AGY03_*` |
| Plan cannot converge (AGY-05) | Idle's end target is `10 000 − Σ endBps`. The freed weight waits in USDC until the Safe sets a new target. | `test_AGY05_*` (old code: plan Expired) |
| Removed-asset custody (AGY-07) | `reabsorbRemovedAsset(index, minUsdcOut)` sells the unowed balance of a removed basket asset into idle USDC, never while a slot with that token is active or in sale. Re-listing an asset reuses its clean old slot. | `test_AGY07_*` |
| Target setter can drop to zero (AGY-08) | `RebalanceGovernance` floors `TARGET_SETTER_ROLE`. The one-shot fund bindings stay immutable (RB-1, E1). | `test_AGY08_*` |
| Adapter vetting (AGY-09) | New exposure (rebalance steps, `mintInKind` purchases) needs an allowed code hash. Valuation and exits keep the old rule, so a revoke never blocks NAV or an exit. The fund vets every basket adapter before a step reads its TWAP. `isFixedFeePool` is trusted only for allowed code. An allowed proxy hash cannot be un-marked. | `test_AGY09_*` |
| Freeze hold mark (AGY-10) | A match's hold end is the longest hold enrolled in its own deposit cycle, reset when the pool empties. | `test_AGY10_*` |
| First settlement after an upgrade (AGY-11) | An in-sale asset with no recorded value stays on both sides of Check 6. An unpriced slot clears its record. | `test_AGY11_*` |
| Empty deposit bucket (AGY-12) | A deposit bucket with no basis is not work. | `test_AGY12_*` |
| Canonical pool (AGY-13) | `isFixedFeePool` requires the router's factory to have made the pool: its CREATE2 address for the pool's own tokens and fee, or the factory's `getPool` answer. | `test_AGY13_*` |

## Off-chain, CI and documentation findings

| Finding | What changed |
|---|---|
| Keeper scripts (MISSED-07) | Share delivery takes owners from every deposit request and asks the queue's `maxDeposit`, which counts unsynced match fills. The old parser read `claimCount` with a second `[0]` ("10" became "1") and failed on the `cast` 1.8 JSON envelope. The keeper sends `step()` when `previewStep` reads `Concluded`. Both anvil self-tests pass. |
| Coverage skip (MISSED-09) | The forge coverage job skips the one-vault sources to stay under its memory ceiling. A separate one-vault coverage job now instruments them with the prototype suite (`.github/workflows/suite-01-02-forge-tests.yml`, job `forge-onevault-coverage`). |
| Non-proxied swap adapter (MISSED-09) | `DeployFund.s.sol` deploys the swap adapter as an ADR-0019 proxy, allows both code hashes and marks the proxy. The fund verifier checks every active basket adapter's code hash, and a proxy's implementation. |
| Unwired fund checks (MISSED-09) | `require-tests.ts` has a `fund` suite (runner, verifier, role scan, evidence, migrations), required in `core-stages`. |
| Upgrade front-run (MISSED-09) | The v0.9.0 upgrade runbook states the rule for any future in-place queue upgrade: pause the queue before scheduling it. |
| Synthetic-only migration tests (MISSED-09) | Real Base state is proven by the Twin rehearsal on the stage host and by the Deploy 4 mainnet upgrade record. Recording live state into CI fixtures needs an RPC this repo does not use. |
| TestMachine #18 (MISSED-09) | A donated balance no longer traps an asset: the single-asset unwind sells it and deactivates the asset (AGY-03). |
| RS-1019-14 (MISSED-09) | It concerns the retired `RouterGovernance`. The one-vault `RebalanceGovernance` already holds the narrow `RECEIPT_RELEASER_ROLE`. Closing the legacy row needs a live role read on Base. |
| Product canon (AGY-15) | `docs/prd.md` carries the staged one-vault amendments in their step 3f form. Two points stay with the owner and keep their old text: a stable-only vault beside the fund (D2), and who writes per-asset weights (D8). `docs/audits.md` records this review (SR-1121). |
| Keeper account 1-of-N (AGY-04) | The fund sheet refuses a smart-account keeper with more than one owner: its one owner is the team Safe, whose threshold is the quorum. Deploy 4 uses a direct keeper key. |
| Band extraction (AGY-06) | Accepted by the owner: a 50 bps band drops first-call completion from 99.40 % to 84.02 %. The 90 bps band stays. |
| Reentrancy and accounting (AGY-14) | No vector. Chapter 05 corrects the chapter's constants and call-graph details. |

## Behaviour changes operators must know

1. **A round with more than 8 requests takes extra keeper calls.** The first calls only enroll and return 0. The keeper keeps calling while `checkSettle()` reads Ok. A flood of N requests clears in about N / 32 calls.
2. **The single-asset unwind has a new signature.** `emergencyUnwind(uint256 index, uint256 minUsdcOut)`. With a healthy feed pass 0 to keep the feed floor. With a dead feed pass a real floor.
3. **An emptied basket asset is deactivated by the unwind.** Do not call `deactivateAsset` after it. A later target leaves that asset out until it is re-listed, which reuses its slot.
4. **A refused fee is kept, not retried.** Watch for `FeeNotPaid` and rotate `feeRecipient` through the timelock.
5. **One owner holds at most 16 open requests a side.** A dapp that opens many small requests per user must merge them.
6. **A deposit remainder below `minRequestUsdc` comes back as USDC credit** in the round that would have net-settled it. Raising `minRequestUsdc` also returns older remainders below the new minimum.
7. **A restore must fit the pools.** If the pools have thinned, pick a lower cap.
8. **A revoked adapter code hash stops new positions only.** Valuation, unwinds and delisting sales still run through it.
9. **Upgrade rule for the delisting scale.** `DELIST_ACC_SCALE` changed from 1e30 to 1e48. Upgrade a live fund only while no asset is in sale (`hasAssetInSale() == false`).
10. **A smart-account keeper has one owner, the Safe.**

## Contract size after the changes

| Contract | Runtime bytes | Headroom under EIP-170 |
|---|---:|---:|
| `RobotMoneyFund` | 24,484 | 92 |
| `Rebalancer` | 23,754 | 822 |
| `FlowQueue` | 22,380 | 2,196 |

The storage layout gate passes against the v0.8.0 baseline. The layout changes are two members appended to
`FlowState`: `enrollPos` (slot 84) and `depCycleMaxMinHold` (slot 85).
