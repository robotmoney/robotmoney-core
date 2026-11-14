# One-vault experiment: cost considerations

Status: report, 2026-11-11. Part of the one-vault experiment
(`docs/technical/one-vault-rebalancer-proposal.md`). It explains the G4 result
(§13, §14) and the other costs the design creates. It changes no gate,
threshold or cost definition.

**Update, 2026-11-11.** The numbers below are the step 3 results, with
deSPXA in the fund. The owner has since approved an asset rule (proposal
§4.5, D12) under which deSPXA leaves the fund until it has an independent
price feed. Deposits also stopped filling deficits (D11). Step 3e reruns G4
and G5 on the new asset list with cost booked against outside feeds, which
is the fix §4 below asks for. This report stays as the record of step 3.

Every number here comes from the rebalance sim (`contracts/test/prototype/sim/`)
at Base pin 55462550. The sim replays real Base state with no RPC. Scores come
from `bun contracts/test/prototype/sim/score-sim.ts`. "Plan" means one receipt
glided to its target over the plan duration. "bps" means bps of the plan's
turnover unless a row says otherwise.

## 1. Summary

- **G4 fails.** The default parameters give a median cost of 17.02 bps.
  The worst plan costs 82.63 bps. The limits are 15 and 30.
- **The fee and impact of each trade are small.** At the pre-trade pool price
  the median cost is 5.48 bps, and the worst plan is 9.13 bps.
- **Most of the cost is the fund's own price impact that stays in the pool.**
  The fund buys more than arbitrage can absorb. This is worst for deSPXA
  while the S&P 500 is closed, because no one can mint or redeem it then.
- **The fund outgrows its pools.** At 5M USDC the median rises to 21.52 bps
  (SEQ). A full move into the basket at 5M does not finish in time (EXT-PROBE).
- **The contract under-reports its own cost.** Its on-chain `costSpent`
  shows a 5.68 bps median, about a third of the true cost. The per-plan
  budget therefore does not cap the real cost.
- **Neither tuning nor an auction fixes it.** Longer plans give 17.76 bps.
  The auction gives a 28.72 bps median.
- **Gas is a separate, smaller cost.** One keeper call uses about 1.36M gas.
  About 1M of that goes to deciding the step.

## 2. How cost is measured

The scorer prints four readings for each plan. The contract books a fifth,
`costSpent`. G4 is scored on the headline, which is the larger of the arrival
and reference readings. The definitions were fixed before the scored run.

| Reading | What it counts | Default median / worst (bps) | G4 limits 15 / 30 |
| --- | --- | --- | --- |
| **Headline** (`costBps`) | The larger of arrival and reference, over turnover | 17.02 / 82.63 | Fail |
| Arrival | Each step valued at the pool price just before it: fee, impact and rounding. Plus flow losses. | 5.48 / 9.13 | Pass |
| Reference | Each step valued at the model's fair price (the reference walk) | 17.02 / 82.63 | Fail |
| Per traded | The headline, over notional traded instead of turnover | 18.21 / 91.92 | Fail |
| On-chain `costSpent` | What the Rebalancer books, valued at TWAP | 5.68 / 8.69 | Pass |

Read the arrival and reference rows together. The arrival cost is what a step
pays at the moment it trades. The reference cost also counts the premium the
fund leaves behind. When the fund buys, the pool price rises above fair value.
Arbitrage closes only part of that gap before the next step. The next step buys
at the raised price again. The fund ends up holding tokens it paid too much for.
Holders lose that premium. The arrival reading cannot see it.

So the arrival reading is not the right measure of what holders pay. The
headline takes the larger of the two. Here that is the reference reading, so
G4 is in effect scored on it, which is correct.

## 3. Where the cost comes from

### 3.1 By scenario (default parameters)

| Scenario | Median (bps) | Worst (bps) | What it shows |
| --- | --- | --- | --- |
| SEQ-1M (historical receipts, 1M USDC) | 12.54 | 26.50 | The normal case passes at 1M. |
| SEQ-5M (same receipts, 5M USDC) | 21.52 | 59.19 | Cost grows with fund size. |
| EXT-1M (all stable to all basket, and back) | 22.93 | 44.20 | Buying the basket is the expensive direction. |
| JUMP-UP-1M (deSPXA jumps up mid-plan) | 19.62 | 21.76 | A price jump adds cost. |
| JUMP-DOWN-1M (deSPXA jumps down mid-plan) | 64.62 | 82.63 | The pool leaves its LP range. Steps fail. One plan expires. |
| EXT-PROBE-5M (capacity probe, not scored) | 51.02 | 92.31 | Neither plan finishes in its window. |

### 3.2 Buying costs more than selling

In EXT the fund moves from all stable to all basket (receipt X), then back
(receipt G). Over the 3 seeds:

- **Buying the basket (X):** 38.03, 38.17 and 44.20 bps.
- **Selling it back (G):** 6.31, 6.14 and 7.83 bps.

Arrival cost is about 6 bps in both directions. The whole gap is the premium
left in the pools while the fund keeps buying.

### 3.3 deSPXA is the main source

deSPXA tracks the S&P 500. In US market hours an arbitrageur can mint and
redeem it with the issuer, so the pool price stays close to fair. Outside
those hours (about 80% of the week) no one can mint or redeem. An arbitrageur
can then only sell back what it bought earlier. The fund's buying stays in the
price until the market opens.

The fund is also large next to the deSPXA pool:

- **EXT-1M:** at one point the fund held 69% to 147% as much deSPXA as the
  pool held.
- **EXT-PROBE-5M:** up to 275%.
- **One JUMP-UP seed:** 3,851%.

A fund that holds more of a token than its only pool cannot rebalance it
cheaply.

### 3.4 Price jumps and LP range

In JUMP-DOWN the deSPXA price falls 10% in the middle of a plan. The pool's
price leaves the range where its recorded LPs hold liquidity. Trades then fail
their price floors, and steps are skipped:

- **Blocked steps:** 27.0%, 61.3% and 13.5% of steps over the 3 seeds.
- **One plan expired** before it reached its target.

The sim holds LP positions fixed, so this may overstate the cost. Real LPs
move their ranges after a big move. The step 3c model of LPs moving their range
brings JUMP-DOWN's worst plan from 82.63 to 39.86 bps. That model's 6-hour lag
and its depth are guesses (§14).

Without the 5 plans that left their LP range, G4 still fails: median 15.12 bps,
worst 59.19 bps. The range problem makes the worst case worse. It is not the
cause of the failure.

## 4. On-chain cost accounting under-reports

The Rebalancer books each step's cost against the TWAP into `costSpent`. It
checks that sum against `costBudgetBps`. In the sim:

| | Median (bps) | Worst (bps) |
| --- | --- | --- |
| On-chain `costSpent` | 5.68 | 8.69 |
| Real cost (headline) | 17.02 | 82.63 |

The TWAP follows the pool, and the pool carries the fund's own premium. So the
contract sees roughly the arrival cost and misses the premium. This has three
effects:

- The per-plan budget never fires on the real cost. The highest plan used 29%
  of its budget.
- The dapp and indexer would show holders a cost about 3 times lower than
  they paid at the median. In the worst plan they would show about 10 times
  lower.
- §5.7's "bounded and visible" claim holds only for arrival cost. It does not
  hold for the cost holders actually bear.

A fix would value cost against a price the fund cannot move. One option is an
outside oracle for the basket assets. Another is a TWAP window much longer than
a plan. Either is a design change, and the experiment has not tested it.

## 5. Levers tried

| Lever | Median / worst (bps) | Effect |
| --- | --- | --- |
| Default (7-day plan, 30-min steps) | 17.02 / 82.63 | Scored result |
| Tuned (21-day plan, 33 USDC minimum step) | 17.76 / 83.40 | No better. EXT improves to 14.02. JUMP and SEQ get worse. Blocked steps rise to 7.35%. |
| Dutch auction executor | 28.72 / 61.71 | A lower worst plan, a higher median. The solver's margin and gas per leg dominate small steps. Blocked steps reach 10.63%. |
| LP range re-centre model (default steps) | 17.20 / 59.19 | G5 passes. G4 does not change much. This is a sensitivity, not a measurement. |

The tuned set was chosen on a projection. Spreading the same buying over 21
days was expected to cut the premium to a median of about 8.4 bps. That did not
happen. Longer plans keep the fund in the market for more closed-market hours.
They also put more plans through an LP range exit (14 against 5). Without
those plans, the tuned median is 15.73 bps. That is still over 15.

## 6. Gas

Gas is not a gate. The owner dropped G2 on 2026-11-09. It is still a running
cost for whoever runs the keeper. These numbers come from one profiled test
(JUMP-UP-1M seed 0, default parameters, about 335 keeper calls):

| Item | Gas per keeper call (approx.) |
| --- | --- |
| `step()`, all of it | 1.36M |
| The decision part (legs, path, checks) | 0.98M (measured through `previewStep`, which runs the same decision) |

At the pin's base fee (0.005 gwei), a 7-day plan with a call every 30 minutes
uses about 456M gas, or about 0.0023 ETH. That leaves out the L1 data fee. A
keeper that calls even when nothing will trade still pays the decision cost.

The decision cost is high because each call values every asset through the
pool TWAPs more than once. Caching the valuation per call would cut it. That is
a contract change, and it is not part of the experiment.

## 7. What this means for the decision

- **G4 is a real fail, not a measurement artefact.** The arrival reading
  passes. It leaves out a cost that holders bear.
- **The cost sits in the basket legs, and mostly in deSPXA.** A one-vault fund
  makes every holder share the cost of rebalancing basket assets that trade in
  thin pools. ADR-0003 refused to socialize exactly this cost.
- **The cost grows with fund size.** The 1M result is near the line (SEQ-1M
  passes). The 5M result is not. A fund that grows past a few million USDC
  makes this worse.
- **Before G4 could pass, the experiment would need to test one of these:**
  - Cap each basket asset's target at a share of its pool's depth.
  - Trade deSPXA only in US market hours.
  - Keep the basket out of the shared fund. This is D2's separate-vault
    direction.

  Each is a design change, not a parameter change. None was in scope for
  step 3.
- **If the design goes forward, fix the cost accounting first.** Holders must
  see the cost they pay. A budget that misses two thirds of it is not a bound.

## 8. Sources

- Scored runs: `out/prototype/{default,tuned,auction,default-lprecenter,auction-lprecenter}`.
  Each has a `sim.json` written by `score-sim.ts`. They are not committed (`out/` is ignored).
- Evidence rows: `one-vault-rebalancer-proposal.md` §14, G4 and G5.
- Cost definitions: header of `contracts/test/prototype/sim/score-sim.ts`.
- Model and parameters: the contract note at the top of
  `contracts/test/prototype/sim/RebalanceSim.t.sol`.
- To reproduce: `PROTO_SIM=1 PROTO_SIM_RUN=default forge test --match-path 'contracts/test/prototype/sim/*'`,
  then the scorer. This takes about 1 minute on an idle 8-core machine.
