# 06 — Remediation Status

- **Date:** 2026-11-23 (second pass the same day)
- **Branch:** `adhoc/20261122-233507-safety-review-090`
- **Base:** `dev` at `6c25fd8ce` (contracts identical to tag `contracts-0.9.0`)
- **Ledger:** `docs/audits.md`, section SR-1121 (one row per finding)
- **Proof tests:** `contracts/test/prototype/SafetyReview090.t.sol`, `contracts/test/DelistClaimScaling.t.sol`,
  `contracts/test/ProposerFloorTimelockExecutorFloor.t.sol`, and the keeper scripts' anvil self-tests
- **Supporting tables:** `07-supporting-matrices.md` (loop bounds, transfer sinks, reentrancy additions, lending
  adapter functions, invariant coverage)

This is an internal review. The one-vault contracts still need an external audit before they hold user funds on 8453.

## How this page was checked

The first pass fixed the findings and wrote this page. A second pass then had five independent reviewers read each
finding against the code, without the first pass's conclusions. They found that several findings were only partly
fixed, that one fix added a new problem, and that this page overstated three things. The second pass fixed what it
confirmed. The tables below describe the code after both passes. The section "Second pass" lists what changed, and
"Not fixed" lists what is still open.

A test marked **proved** was run against the old code and failed there. A test not marked that way passes now but was
not run against the old code.

## Contract findings

| Finding | What changed | Test |
|---|---|---|
| Settle gas attack (MISSED-01, Critical) | Round enrollment runs in bounded batches: 32 enrollments, 256 visits and 4,000,000 gas a call. One owner holds at most 16 open requests a side. A request that names another owner meets the minimum. Ended notices return 16 a call. The pending-work scan stops after 256 ids and answers "work". The settle walk passes dead ids and empty epochs without spending its look budget, at most 256 a side a call. The walk's start hint survives a parameter change, and its cursor is found by bisection. Anyone may send an expired deposit back to its owner. | `test_MISSED01_dustRedeemFloodCannotBrickSettle` (**proved**: 300 one-wei requests put `settle` over the 2^24 gas cap), `test_MISSED01_cancelledDepositFloodCannotBrickSettle` (**proved**: 4,000 cancelled deposits put `checkSettle` itself over the cap), `test_MISSED01_ownerOpenRequestCapAndNoThirdPartyDust`, `test_MISSED01_anyoneSendsAnExpiredDepositBackToItsOwner` |
| Delist claim precision (MISSED-02) | The accumulator scale ran out on very long sales: one claimer lost 0.1 % at 600 partial steps. A claim book that starts empty now runs on a 1e48 scale. A book that was open at the upgrade keeps the 1e30 scale it was written in until it empties, so the upgrade needs no operator rule. Lending claim epochs get the same treatment (1e54 for a new epoch, 1e36 for one that had accrued). | `DelistClaimScaling.t.sol`: the 1,000-step sale (**proved** by replaying the arithmetic at 1e30: 92 of 1,000 claimers short), `test_MISSED02_openLegacyBookKeepsItsScaleAcrossTheUpgrade`. The lending scale has no test of its own. |
| Shutdown then restore (MISSED-03) | A new redemption enrollment first releases the owner's wind-down escrow from the old cycle. `restore` runs the pool-share check. A request made after a restore, in the epoch the shutdown happened in, is enrolled. | `test_MISSED03_shutdownRestoreLeavesNoPhantomQueuedShares`, `test_MISSED03_restoreRunsThePoolShareCheck`, `test_MISSED03_requestAfterRestoreInTheSameEpochIsSettled` (**proved**) |
| Blocked fee recipient (MISSED-04) | Every USDC fee push tries the transfer. A refused fee stays with the holders and emits `FeeNotPaid`. `FundExclusionLedger.claimTo(id, to)` pays the caller's own recovery to another address. | `test_MISSED04_blacklistedFeeRecipientDoesNotBlockExits` (the net redemption path only), the `claimTo` assertions in `Attacks.t.sol` (A19) |
| Rebalancer blocked by an in-sale dead feed (MISSED-05) | `Rebalancer._decide` masks in-sale assets out of the feed check. | `test_MISSED05_deadFeedOfInSaleAssetDoesNotBlockRebalance` |
| Sub-minimum deposit remainder (MISSED-06) | The settle walk returns a remainder below `minRequestUsdc` to its owner as USDC credit. It never reaches `mintInKind` (RB-14). | `test_MISSED06_subMinimumDepositRemainderSettles`, `test_RB14_*` |
| Delisting edge cases (MISSED-08) | After shutdown a delisting claim leaves in kind through `settleClaim`, and the last claimer takes the whole remainder. A sale opened with no price gets its start value at the first priced step. Dust worth nothing closes an in-sale asset. | `test_MISSED08_*`, `test_MISSED08_inKindExitsLeaveNoOrphanTokens` |
| Liquidity clamp, TestMachine #16 and #17 (MISSED-09) | A lending sell leg is clamped to the venue's `availableLiquidity`. A venue that cannot pay out the minimum step is backed off, so the next step trades other legs. An in-kind exit fee rounds up. Two receipts recorded in the same second both stay applicable. | `test_MISSED09_lendingSellLegIsClampedToVenueLiquidity`, `test_MISSED09_frozenLendingVenueDoesNotHoldTheOtherLegs` (**proved**), `test_TM16_*`, `test_TM17_*` |
| Zero floor on a dead-feed unwind (AGY-01) | `emergencyUnwind(index, minUsdcOut)`. A non-zero `minUsdcOut` is the floor, even below the feed. With `minUsdcOut == 0` the floor is the feed price less `delistBandBps`, and a dead feed then reverts. A stale price is never a floor. | `test_AGY01_AGY03_deadFeedUnwindNeedsAFloorAndFreesTheFund`, `test_AGY01_namedFloorStandsWhenAFreshFeedLagsTheMarket` (**proved**) |
| Timelock executor can drop to zero (AGY-02) | `ProposerFloorTimelock` floors `EXECUTOR_ROLE` and refuses a timelock born with no executor. New deployments only: the live Deploy 4 timelock keeps its code. The govern tool refuses a row that removes the last executor of any timelock, the live one included. | `ProposerFloorTimelockExecutorFloor.t.sol`, `publish-contracts/tests/govern.test.ts` |
| Unwound asset stays active (AGY-03) | An emptied basket asset is deactivated by the unwind. An emptied lending asset whose rate read fails no longer stops deposits (Check 5 skips it). | `test_AGY01_AGY03_*`. The lending case has no test. |
| Plan cannot converge (AGY-05) | Idle's end target is `10 000 − Σ endBps`. The freed weight waits in USDC until the Safe sets a new target. | `test_AGY05_planConvergesAfterAnAssetLeavesIt` (**proved**: the old code's plan expired) |
| Removed-asset custody (AGY-07) | `reabsorbRemovedAsset(index, minUsdcOut)` sells the unowed balance of a removed basket asset into idle USDC, never while a slot with that token is active or in sale. Re-listing an asset reuses its clean old slot. | `test_AGY07_*` |
| Target setter can drop to zero (AGY-08) | `RebalanceGovernance` floors `TARGET_SETTER_ROLE`. The one-shot fund bindings stay immutable (RB-1, E1). | `test_AGY08_*` |
| Adapter vetting (AGY-09) | New exposure (rebalance steps, `mintInKind` purchases) needs an allowed code hash. The fund vets every basket adapter before a step reads its TWAP. `isFixedFeePool` is trusted only for allowed code. An allowed proxy hash cannot be un-marked. Valuation and exits keep the old rule: see behaviour change 8 for what a revoke stops. | `test_AGY09_*` (a direct adapter only) |
| Freeze hold mark (AGY-10) | A match's hold end is the longest hold enrolled in any deposit bucket that still has basis. A bucket leaves within `maxRoll` epochs, so a long hold from before a `minHold` cut stops counting then. A bucket with no mark falls back to the all-time maximum. | `test_AGY10_matchHoldFollowsItsOwnDeposits` (the pool-empties case only) |
| Share-price check during a sale (AGY-11) | The check takes an in-sale asset off both sides at every settlement of the sale: its value now off the current price, its recorded value off the reference. With no recorded value it stays on both sides. An unpriced slot clears its record. | `test_AGY11_delistBeforeFirstRecordedValueDoesNotTripCheck6`, `test_AGY11_secondSettlementDuringADelistingDoesNotTripCheck6` (**proved**) |
| Empty deposit bucket (AGY-12) | A deposit bucket with no basis is not work. | `test_AGY12_*` |
| Canonical pool (AGY-13) | `isFixedFeePool` requires the router's factory to have made the pool: its CREATE2 address for the pool's own tokens and fee, or the factory's `getPool` answer. | `test_AGY13_*` |

> Deploy 4 (0.10.0, decision D10-6): the fund keeps its 0.9.0 `FundExclusionLedger` (0xe3Ae6802fFA11EAdd4888a4D6F15844a56bc7D12). `claimTo` is not live on Deploy 4 until a later release replaces the ledger. The fee-push fix is fund code and is live after the 0.10.0 upgrade.

## Off-chain, CI and documentation findings

| Finding | What changed |
|---|---|
| Keeper scripts (MISSED-07) | Share delivery takes owners from every deposit request and asks the queue's `maxDeposit`, which counts unsynced match fills. It keeps the owners it has read in a state file, so a tick reads only new requests. The keeper sends `step()` when `previewStep` reads `Concluded`. It repeats `settle()` in one tick while `checkSettle()` reads Ok (at most 16 calls), and looks at 16 requests a call. The self-tests cover the Concluded step, a ten-request round, the state file and a match-filled deposit. |
| Coverage skip (MISSED-09) | A separate one-vault coverage job instruments the fund sources with the prototype suite and gates line coverage (`.github/workflows/onevault-coverage.yml`, job `forge-onevault-coverage`, after every merge to dev and nightly). The gated list holds the one-vault sources with code that the main coverage job skips, the five one-vault adapters included, plus `FeeTransfer`. It has a total floor and a per-file floor. |
| Non-proxied swap adapter (MISSED-09) | `DeployFund.s.sol` deploys the swap adapter as an ADR-0019 proxy, allows both code hashes and marks the proxy. The fund verifier checks every active basket adapter's code hash, reads the proxy mark from storage, and compares the proxy's implementation with the manifest. |
| Unwired fund checks (MISSED-09) | `require-tests.ts` has a `fund` suite (runner, verifier, role scan, evidence, migrations), required in `core-stages`. These are unit tests on a fake chain. |
| Upgrade front-run (MISSED-09) | The v0.9.0 upgrade runbook states the rule for a future in-place queue upgrade: pause the queue, then confirm no escrow is pending and no request is open, then schedule. |
| Synthetic-only migration tests (MISSED-09) | Real Base state is proven by the Twin rehearsal on the stage host and by the Deploy 4 mainnet upgrade record. This branch's own storage changes are append-only, and its two scale changes keep the old scale for open books, with a test for the delisting one. |
| TestMachine #18 (MISSED-09) | A donated balance blocks `deactivateAsset` as before. The single-asset unwind sells it and deactivates the asset, when the pool can still trade. |
| RS-1019-14 (MISSED-09) | It concerns the retired `RouterGovernance`. The one-vault `RebalanceGovernance` already holds the narrow `RECEIPT_RELEASER_ROLE`. The legacy ledger row stays open until a live role read on Base. |
| Product canon (AGY-15) | `docs/prd.md` carries the staged one-vault amendments in their step 3f form, the withdrawal passages included. See "Not fixed" for what the PRD still says about the four-vault product. |
| Keeper account 1-of-N (AGY-04) | The contract is unchanged. The deploy script takes exactly one owner, and it must be a contract. The fund sheet applies the one-owner rule whenever owners are given. The verifier checks any contract keeper on chain: exactly one owner, the Safe. Deploy 4 uses a direct keeper key. |
| Band extraction (AGY-06) | Not changed. See "Owner decisions". |
| Reentrancy and accounting (AGY-14) | No vector, the code this branch added included. Chapters 00 to 04 now carry the corrections chapter 05 listed. Chapter 07 adds the inherited mutators and the lending adapters' open functions. |

## Second pass: what the independent check changed

1. **Settle gas attack was not closed.** `hasPendingForRound` scanned every deposit id of an epoch before each
   settlement, cancelled ones included. One address could create and cancel a few thousand deposits and put
   `checkSettle` and `settle` over the gas cap. The scan is now bounded. The settle walk also crawled dead ids 16 a
   call. It now passes them free, 256 a call.
2. **The lending clamp added a head-of-line block.** A venue with no liquidity made every step a skip with no
   backoff, so the plan's other legs never ran. The venue is now backed off.
3. **The delisting scale needed an operator rule that nothing enforced.** The rule was also too weak: a claim not yet
   collected from a closed sale would have paid nothing. The scale is now kept per claim book.
4. **The in-kind delisting exit could leave a token unit with no claim behind it.** The last claimer now takes the
   remainder.
5. **A real bug that predates this branch.** The share-price check tripped on the second settlement of any delisting
   of an asset larger than the per-epoch move limit. It stalled settlement for the sale.
6. **A slow failure in the settle walk.** `setFlowParams` reset the walk's start to epoch 0, and the list of epochs
   only grows. On a queue with about a year of activity the next settlement would have scanned every epoch.
7. **The keeper sheet rule had two bypasses**, and nothing checked that the one owner was the Safe.
8. **This page was wrong in three places.** It named the wrong workflow file. It said a revoked adapter hash never
   blocks valuation or exits, which is false for a proxied adapter. It said chapter 03 had been corrected.

## Behaviour changes operators must know

1. **A round with more than 8 requests takes extra keeper calls.** The first calls only enroll and return 0. The keeper script repeats `settle()` inside one tick while `checkSettle()` reads Ok.
2. **The single-asset unwind has a new signature.** `emergencyUnwind(uint256 index, uint256 minUsdcOut)`. Pass 0 to use the feed floor. A non-zero value replaces the feed floor, so check it against the market before scheduling. With a dead feed a non-zero value is required.
3. **An emptied basket asset is deactivated by the unwind.** Do not call `deactivateAsset` after it. A later target leaves that asset out until it is re-listed, which reuses its slot.
4. **A refused fee is kept, not retried.** Watch for `FeeNotPaid` and rotate `feeRecipient` through the timelock.
5. **One owner holds at most 16 open requests a side.** A dapp that opens many small requests per user must merge them.
6. **A deposit remainder below `minRequestUsdc` comes back as USDC credit** in the round that would have net-settled it. Raising `minRequestUsdc` also returns older remainders below the new minimum.
7. **A restore must fit the pools.** If the pools have thinned, pick a lower cap.
8. **What a revoked adapter code hash stops.** For a direct adapter it stops new positions only: valuation, unwinds and delisting sales still run. For a proxied adapter (the swap adapter `DeployFund.s.sol` now deploys) a revoke of the proxy hash or the implementation hash stops valuation and exits through it too (ADR-0019). Replace the asset's adapter or allow the hash again to resume.
9. **Anyone can return an expired deposit.** `withdrawExpired(id)` sends the USDC to the request's owner, whoever calls it.
10. **A smart-account keeper has one owner, the Safe.**
11. **A frozen lending venue is skipped for one cooldown at a time.** The plan trades its other legs meanwhile.
12. **After an unwind that loses value, a live plan sells healthy assets into USDC** to reach idle's end target. Set a new target if that is not wanted.

## Not fixed

Each line names what is still open and why.

- **Live Deploy 4 timelock (AGY-02).** It runs old code with no on-chain executor floor. Only the govern tool guards it.
- **Dead pool (AGY-07, TestMachine #18).** A removed or in-sale asset whose pool can no longer trade cannot be sold or closed. Its tokens stay in the fund.
- **Oversized exit (AGY-01).** The single-asset unwind still sells the whole position in one swap. `minUsdcOut` is a total fixed at scheduling, so in-kind exits during the timelock delay can make a tight floor revert.
- **Sybil dust (MISSED-01).** Many addresses can still each open a one-wei whole-balance redemption. Every call stays under the gas cap, and the cost is extra keeper calls.
- **Owner sync debt (MISSED-01).** An owner with 16 deposits matched over several rounds and never synced makes the fill of that owner expensive. The deposit side of that settlement then fails softly (`SideFailed`). The share-delivery keeper syncs owners every tick, which clears it.
- **Refused claim owner (MISSED-04, chapter 07 OP-3).** `settleClaim` pays only the claim's owner. An owner USDC refuses keeps a lending claim open until they call `claimPosition` with another address, and an open lending claim blocks steps out of that venue.
- **In-kind delisting exit and a token blocklist (MISSED-08).** The token leg goes to the owner with a hard transfer.
- **Adapter vetting edges (AGY-09).** The queue's fixed-fee check vets the adapter's own hash, not a proxy's implementation. Revoking, un-marking and re-allowing a proxy hash (three timelock calls) leaves its proxies vetted as direct adapters.
- **Slot reuse (AGY-07).** The rebalancer's per-index step cap survives a slot reuse. Set it when re-listing.
- **Epoch change (chapter 07 OP-2).** After a change of `epochLength`, `checkSettle` can run out of gas until the epoch in progress ends. Only the timelock can cause it, and it clears by itself.
- **Reward tokens (chapter 07 OP-4).** The lending adapters cannot collect a reward token. None is paid today.
- **Tests still missing.** `redeemInKind` with a refused fee recipient. The lending claim scale. The emptied lending asset in Check 5. A hold mark under steady inflow. A two-slot reabsorb. Three invariants (RB-23, RB-28, RB-36) assert counters nothing writes (chapter 07 OP-5). `DeployFundTimelock.s.sol` has no direct test.
- **Chapter 05 section 2.1.** The nine patches chapter 05 calls broken are not rewritten in chapters 01 to 03. The code does not use them.

## Owner decisions

- **Band (AGY-06).** The 90 bps band stays in the code. The engineering plan the owner asked to be implemented keeps it. `docs/technical/one-vault-release-090-gate-options.md` still lists accepting the G8 result or tightening the band as an open choice, so the ruling itself is not on record.
- **PRD.** D2 (a stable-only vault beside the fund) and D8 (who writes per-asset weights) keep their old text. Section 11 still describes four vaults with synchronous redemption, and the Portfolio Router is still named outside sections 2 and 9. The amendments file gives no instruction for those passages. The amendments file also calls its own text "proposed, for the owner's review".
- **External audit.** Still required.

## Contract size after the changes

| Contract | Runtime bytes | Headroom under EIP-170 |
|---|---:|---:|
| `RobotMoneyFund` | 24,559 | 17 |
| `Rebalancer` | 23,816 | 760 |
| `FlowQueue` | 22,380 | 2,196 |

The storage layout gate passes against `dev` and against the v0.8.0 baseline. The layout changes are append-only:
`enrollPos` and `depBucketMaxMinHold` at the end of `FlowState`, `delistWideScale` at the end of `FundState`, and
`wide` at the end of `LendingClaimEpoch` (a struct held only in a mapping).
