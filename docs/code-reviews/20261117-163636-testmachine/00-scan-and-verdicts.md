# Scan and verdicts

**Scan:** TestMachine automated scan, `robotmoney/robotmoney-core`, finished
`2026-11-17T03:48:00.730421Z`. Critical 0 · High 0 · Medium 0 · Low 19 · Info 4 · Total 23.

**Reviewed source:** `d4a43e6d21efed208816698d2b32f0decea45451` (the `release-0.9.0` review pin; the branch later advanced to `da7594306` with fund upgrade-library tooling changes only).
The audit's quoted snippets match this commit; its cited line numbers drift by a
few lines because the code was extracted into libraries (e.g. `BasketSwaps.sol`).

## Verdict summary

| Verdict | Count | Findings |
| --- | --- | --- |
| **REJECTED** (false premise / not reproducible) | 2 | #21, #23 |
| **REPRODUCED** (behaviour genuinely present and reachable) | 12 | #6, #9, #10, #11, #12, #13, #15, #16, #17, #18, #19, #22 |
| **PARTIAL** (real code observation, but bounded / by-design / overstated) | 9 | #1, #2, #3, #4, #5, #7, #8, #14, #20 |

## Disposition table

| # | Finding (short) | Severity | Verdict |
| --- | --- | --- | --- |
| 1 | Stale V4 recorder quarantines removed-asset balance | low | PARTIAL |
| 2 | Deposit availability queries router, not receiver | low | PARTIAL |
| 3 | Deposit floors not bound to previewed vault vector | low | PARTIAL |
| 4 | Deposits front-run inactive-asset recovery | low | PARTIAL |
| 5 | Zero TVL-cap sentinel disables deposits | low | PARTIAL |
| 6 | Exact Morpho pulls block redemptions | low | REPRODUCED |
| 7 | Idle allocation bypasses rebalance movement cap | low | PARTIAL |
| 8 | Keeper rebalance targets ignore adapter caps | low | PARTIAL |
| 9 | Morpho illiquidity omitted from deposit-health gate | low | REPRODUCED |
| 10 | Pause-only venue checks miss liquidity failures | low | REPRODUCED |
| 11 | Pre-swap TVL check does not cap favorable NAV | low | REPRODUCED |
| 12 | Pro-rata rounding locks exclusion recoveries | low | REPRODUCED (intentional) |
| 13 | Redeemer allowance reusable across redemptions | low | REPRODUCED |
| 14 | Router deposits ignore routing feature flag | low | PARTIAL |
| 15 | Single-unit basket legs skipped on redemption | low | REPRODUCED (known) |
| 16 | Split in-kind redemptions avoid exit fees | low | REPRODUCED |
| 17 | Same-block receipts mutually exclusive | low | REPRODUCED |
| 18 | Token donations prevent asset deactivation | low | REPRODUCED (accepted) |
| 19 | V4 recorder commits transient spot tick | low | REPRODUCED (mechanic) |
| 20 | Gateway deposit ignores share floor | info | PARTIAL |
| 21 | Permissionless recording shortens sell anchor | info | REJECTED |
| 22 | Reverting health probes treated as withdrawable | info | REPRODUCED |
| 23 | User floor forces removed asset into quarantine | info | REJECTED |

## Reading the result

Of the 12 REPRODUCED findings, four are already recorded upstream as accepted or
known design residues — #12 (dust retention), #15 (dust skip), #18 (FS-VLT-26),
and #19 (documented ≤10 ticks/s recorder drag). Six are pinned by in-repo tests
(#1, #6, #12, #17, #19, #23). No Critical/High/Medium finding was reproduced;
the two outright rejections (#21, #23) both rest on a false premise about the
shipped configuration or Solidity semantics.

## Second-review cross-check

A second security review of the same pin promoted one medium, non-blocking
`TEST_COVERAGE_GAP` and four advisories. All five were independently verified and
confirmed; the fund-timelock gap survives in a narrower form than stated (an
on-chain readback of `EXECUTOR_ROLE` exists in the fund verifier, but no CI job runs
it). See [chapter 5](04-cross-review-addendum.md) for evidence, corrections to the
second review, and reconciliation with findings #1, #13, #14, #17, #19 and #23.
No verdict among the 23 changes.
