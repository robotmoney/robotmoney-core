# Design Review: Rebalancer Economics, Oracles & Smart Contract Safety

> **Pass 3 final draft (2026-11-14).** The severities in this chapter are Pass 2's. Each finding carries its Pass 3 rating. `00-executive-summary.md` §4 and `06-pass-3-adversarial-critique.md` govern.

**Reviewer Scope:** Rebalancer economics, oracle/TWAP/feed design, DEX/lending execution, flow-vs-rebalance interaction, and §7 invariants (design documents only; implementation code ignored).  
**Target Worktree:** `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/design-review-0.8.0`

---

## 1. Scope & Documents Reviewed

1. **`docs/technical/one-vault-rebalancer-proposal.md`**
   - §4.2 (L218–233): NAV model (`idle USDC`, 1:1 lending adapters, basket TWAP).
   - §4.5 (L288–386): Asset admission rules 1–6 (D12, D19, RUN-01, delisting rule 5, lending adapter honesty, deSPXA removal).
   - §5.1–§5.8 (L388–597): Receipt-to-plan lifecycle, linear glide path, `step()` execution, keeper/grace access, plan states, governed parameters & roles, cost disclosure, and threat model.
   - §5.9.3–§5.9.7 (L700–908): Pre-trade/post-trade checks 1–12, exits, working defaults, vault interface departures, and flow costs (referenced by §5.10 and §5.11).
   - §5.10 (L910–935): Step 3e/3f rebalance layers (feed health, stricter price limit, feed-based cost accounting, round-open step ban).
   - §5.11 (L937–1375): Step 3f netted, forward-priced flows, match booking, net settlement, wind-down, time-bounded emergency powers, cost/open risks, `v0.8.0-onevault` reconciliation, and `0.7.0` requirements.
   - §7 (L1416–1552): New invariants (`RB-1` to `RB-34`, including step 3f revisions).
   - §10 (L1812–1814), §11 (L1869–1905), §13 (L1934–2003), §14 (L2005–2190), §18.4 (L2818–2835), §19 (L2873–2949), §21 (L3013–3085): `A27`, working defaults (`D1`–`D30`), gate rules, evidence log, owner revisions, and adversarial review records.
2. **`docs/technical/one-vault-cost-report.md`** (L1–215): Step 3 simulation cost analysis (arrival vs reference cost, `costSpent` under-reporting, deSPXA illiquidity, LP range exits, Dutch auction comparison, gas profile).
3. **`docs/technical/one-vault-timed-flows-eng-plan.md`**
   - §1–§7 (L1–368): Step 3d engineering plan as built (`FlowQueue.sol`, `RobotMoneyFund.sol`, `E1`–`E23`, adversarial tests `A1`–`A19`, invariants, sim, work packages, risks, out-of-scope).
   - §8 (L370–562): Step 3f (`v0.9.0-onevault`) delta plan (`E24`–`E51`, contract changes, test changes, work packages, risks).

---

## 2. Attack & Failure-Mode Analysis

### 2.1 MEV, Front-Running & Sandwich Exposure
- **Public Target Telegraphing:** Receipts are public for at least the 48-hour timelock delay on Base (`8453`) before a plan opens (`one-vault-rebalancer-proposal.md` §5.8 L593). The design explicitly accepts this risk and relies on the linear glide path + `maxStepUsdc` + `stepDepthBps` (5 bps of time-weighted pool depth) to limit per-step impact.
- **Cost Socialization & Under-Reporting (Step 3c vs 3e):** The step 3 simulation (`one-vault-cost-report.md` §1 L23–34, §4 L125–145) proved that buying into thin pools leaves a persistent premium in the pool that arbitrageurs do not fully close between 30-minute steps, causing real cost (17.02 bps median, 82.63 bps worst) to exceed G4 limits (15/30 bps) while TWAP-booked `costSpent` under-reported it by 3x–10x. Step 3e (§5.10 L920–921) fixes the accounting by booking cost against the outside feed, and §4.5 (L378–383) removes tokenized equities (`deSPXA`).
- **Dutch Auction Rejected:** Testing a Dutch auction executor (`one-vault-cost-report.md` §5 L157) worsened median cost to 28.72 bps (vs 17.02 bps) and increased blocked steps to 10.63% because solver margins and per-leg gas dominated small step sizes.
- **Step 3f Timing Separation & Missing `settleWindow >= TWAP_window` Bound:** `RB-30` (`§7 L1537–1539`) blocks `Rebalancer.step()` at `epochClose`, and `settle()` cannot run until `epochClose + settleWindow` (`1h` at defaults, `§5.9.5 L809`). Because the TWAP window is also `12 × 5 min = 1h` (`§5.9.5 L817`), at default parameters the entire 60-minute TWAP window observed by `settle()` occurs **during `settleWindow` while `step()` is already blocked by `RB-30`** (leaving only un-arbitraged residual spot decay across `settleWindow`). However, neither `§7` nor `E51` (`one-vault-timed-flows-eng-plan.md §8.1 L418`) enforces `settleWindow >= TWAP_window`: if governance lowers `settleWindow` below 60 minutes, pre-close `step()` calls pushing pools up to `97 bps` from the feed (`§5.9.5 L818`, `§5.10 L930–932`) fall directly inside `settle()`'s TWAP window and trip Check 4 (`refBandBps = 90 bps`) or lean `S` (see **SAFE-03**).

### 2.2 Oracle, TWAP & Feed Design
- **Two-Layer Guard vs Match Pricing (Corrected Weighting Math):** Basket assets use a 60-minute pool TWAP (`12 × 5`-minute slices, `quorum = 9`, `dispersionBps = 100`, `§5.9.5 L817`) guarded by Chainlink feeds (`refBandBps = 90` bps, `legBandBps = 100` bps, `usdcPegBandBps = 50` bps, `maxSharePriceMoveBps = 1,000` bps/epoch). Under step 3f, `S` is the NAV per share of the **entire fund** (`§4.2 L221–224`). At launch weights (`§19.4 L2935–2937`), 95% of the fund is lending (valued 1:1 in USDC) and 5% is basket assets, so holding a pool TWAP `90 bps` off its feed across the entire 5% basket sleeve moves `S` by at most $90\text{ bps} \times 5\% = 4.5\text{ bps}$ ($225 per epoch at a $500k cap on a $10M fund, matching `§21.3 L3056–3057`), and a single `step()` moves `S` by only ~1–2.25 bps. However, no invariant caps total basket weight (`§21.4 L3075–3077`), so future receipts raising basket weight toward 100% scale maximum match-price skew `refBandBps × basketWeight` toward 90 bps (**SAFE-03**), while `maxLendRateGrowthBps = 10 bps/day` (`§5.9.5 L823`) creates false-positive Check 5 settlement DoS (**SAFE-09**).
- **Liveness Coupling (Owner-Accepted Multisig Wind-Down):** Because `redeemInKind` is restricted to wind-down under step 3f (`§5.11.5 L1177–1206`, `D18 L1893`), any prolonged Chainlink feed outage, sequencer downtime > 1h, USDC depeg > 50 bps, or >10% single-epoch market move traps holders until feeds recover or the Safe executes a 48-hour timelocked `shutdown` (`D24 L1899`, `§5.11.7 L1270–1274`). This policy was explicitly accepted by the owner in `§18.4 item 1 (L2823–2829)` and `§19.2 Row 2 (L2897)` (see **SAFE-04 [DEFEATED]**; single-key keeper operational SPOF risk is tracked in `OPS-01`).

### 2.3 Lending Adapters & Partial Execution
- **Venue Test vs Bad Debt:** `§5.11.4 (L1100–1102)` explicitly leaves unmarked, unreflected venue losses as a residual risk carried by every fund holder. However, when an impaired venue retains $\ge 5\%$ residual liquidity (`maxEpochFlowBps = 500`, `§5.9.5 L811`), D21's round-liquidity test (`§5.11.4 L1093–1100`) passes, forcing **locked depositors** (`RB-25`) into face-value matching against fast/informed redeemers—especially when `RB-32` cooldown blocks `EMERGENCY_ROLE` from calling `pauseDeposits` and no per-venue `excludeVenue` lever exists (see **SAFE-02**).
- **Deferred Claims (`D23`/`RB-21` Units & `D30` Delisted Slices) vs Fund & Rebalancer:** Step 3f relies on two deferred claim systems: shared lending position units (`D23`, `RB-21`, `RB-34`) and delisted-asset slice claims (`D30`, `§4.5 Rule 5 L337–342`, `E42 L409`). Neither `step()` withdrawal splits against `RB-21` claim units (`RB-19`), nor held-balance/NAV/`sellForFlow` exclusions and USDC proceeds-splitting for `D30` delisted-asset slice claims (`timed-flows-eng-plan.md §8.2 L441–444`), are specified (see **SAFE-08**).

### 2.4 Rebalancer / Flow Interaction
- **Zero-Block Round Rollover Starvation & Step 3f Scope Contradiction (`RB-30`):** Because a round with blocked or rolled requests ends only at the *next* epoch close (`§5.11.4 L1135–1136`), rolled requests (`D25`) immediately open the next round with **zero blocks** in between, starving `Rebalancer.step()` and `D30` delisting sales for 48h or indefinitely (or across `pauseQueue`). Moreover, Step 3f documents contradict themselves between banning `[epochClose, roundEnd]` (`§5.10 L928–929`, `RB-30 L1537–1538`, `E42 L409`) and banning only `"inside a settlement window"` (`§5.11.6 L1258`, `timed-flows-eng-plan.md §8.2 L437`, `§8.3 L483`) (see **SAFE-01**).
- **Check 6 Asymmetry on `step()`:** While `one-vault-timed-flows-eng-plan.md` §1–§7 explicitly represents Step 3d (`L1`, `L18–22`) and `§8` (`L370–562`) represents the Step 3f delta, `proposal.md §5.10 (L915–916)` omits Check 6 (`maxSharePriceMoveBps`, `L730–732`) on `step()`, creating asymmetric circuit-breaker enforcement during >10%/epoch dislocations (see **SAFE-10**).

---

## 3. Invariant Gap Analysis (§7)

Reviewing `one-vault-rebalancer-proposal.md` §7 (L1416–1552) against step 3e/3f requirements and `one-vault-timed-flows-eng-plan.md`:

1. **Missing Conservation Invariant:** `one-vault-timed-flows-eng-plan.md` §4.3 (L282–283) requires proving that queue USDC + queue shares + fund holdings match all booked requests, fills, refunds, payouts, and deferred claims (`D23`/`D30`). No whole-system conservation invariant exists in §7.
2. **Missing Zero-Supply / Seed Inflation Guard:** `RB-13` (L1451–1453) asserts `amount after × supply before ≥ amount before × supply after`. When `supply before == 0`, this reduces to `0 ≥ 0` and provides no protection against first-depositor / donation share-inflation attacks. The `seed` invariant (`minSeedUsdc`, single-use at zero supply, non-transferable seed shares per `timed-flows-eng-plan.md` §4.2 L260–261) is absent from §7.
3. **Stale `§5.5` Budget-Halt Transition & Zero-Cost Halt Edge Case (`RB-4` vs `§5.3` vs `§5.5`):** `RB-4` (L1427–1430) states a plan never spends more than its budget, and `§5.3 step 8` (L468–472) caps a step's cost at `budgetLeft` and halts when `newBudgetLeft < lastStepCost` (which is reachable whenever a step spends more than half of prior `budgetLeft`). However, `§5.3 step 8` misses the `budgetLeft == 0 && lastStepCost == 0` case (e.g., zero-NAV plans per `§14 L2016`), `§5.5` (L501) still depicts the stale pre-2026-11-12 transition `costSpent > costBudget` (unreachable when cost is capped at `budgetLeft`), and `§5.3 step 7` (L466) / `RB-4` lacks an explicit `0` floor on `navBefore - navAfter` (see **SAFE-06**).
4. **Incomplete Pause-Exit Coverage in `RB-15 (3f)`:** `RB-15 (3f)` (L1496–1498) states that `"Expired escrow can be withdrawn also while the queue is paused,"` dropping `RB-15 (3d)`'s guarantee (L1457–1459) that `cancel` works while the queue is paused. A `pauseQueue` should not block `cancel` of open-epoch requests or stopped-deposit cancellations (`RB-25` L1519–1523).
5. **Missing Claim-Unit & Delisted-Slice Claim Isolation in `RB-19` and `RB-34`:** `RB-19` (L1470–1471) neither permits `Rebalancer.step()` to settle pro-rata `RB-21`/`D23` lending claim-unit splits in the same call nor accommodates single-asset `D30` delisting steps (which skip `§5.10` feed checks and split/credit USDC proceeds with claim holders). Meanwhile, `RB-34` (L1549–1552) excludes only lending position units from NAV, caps, and the venue test—no invariant in `§7` excludes `D30` delisted-asset slice claims (`§4.5 Rule 5 L337–342`) from `RobotMoneyFund` held balances, NAV/`S`, flow caps, or `sellForFlow`, or bounds their USDC proceeds split (see **SAFE-08**).
6. **Stale `RB-5`, `RB-30` Scope Contradiction, and Omitted Check 6 in `§5.10`:** `RB-5` (L1431–1433) combines `§5.3 step 2`'s ORA-4 check (`L447–449`) with `§5.10`'s Step 3e checks (`checks 2 and 4 of §5.9.3`, `L915–916`), omitting Check 6 (`maxSharePriceMoveBps`, `L730–732`, **SAFE-10**) and omitting `D30` delisting steps' exemption from `§5.10` feed checks (`§4.5 L331–335`), while `RB-30` (`L1537–1539`, banning `[epochClose, roundEnd]`) contradicts `§5.11.6` (`L1258`) and `timed-flows-eng-plan.md §8.2 (L437)` / `§8.3 (L483)` (which scope the ban to `"a settlement window"`, **SAFE-01**).
7. **Missing Exit-Fee Accounting Invariant:** `RB-24` (L1512–1518) states USDC moves from depositors' escrow to redeemers' claims and the fee recipient, and `§5.11.4` (L1116–1117) requires the exit fee to be identical on matched and sold shares, but `§7` lacks an invariant bounding the fee and enforcing exact fee-plus-claim conservation.
8. **Missing `settleWindow >= TWAP_window` Parameter Bound & Basket Weight Cap:** Neither `§7` nor `E51` (`timed-flows-eng-plan.md §8.1 L418`) enforces `settleWindow >= slices × sliceLength` (60 min at defaults), which `RB-30` silently relies on to prevent pre-close `step()` trades from entering `settle()`'s TWAP window; and no invariant in `§7` caps total basket weight (`§21.4 L3075–3077`), leaving maximum match-price skew `refBandBps × basketWeight` unbounded (**SAFE-03**).
9. **Missing `maxStepSlippageBps` Consistency Bound:** `RB-33` (L1546–1548) and `§4.5 Rule 6` (L346–360) validate `poolFee + feeMarginBps < legBandBps` for the queue, but `§7` and `§5.6` (L529, L537–539) impose no matching bound ensuring `maxStepSlippageBps > refBandBps + poolFee + feeMarginBps` under `§5.10` (L917–919)'s `min/max(TWAP, feed)` anchor (**SAFE-07**).

---

## 4. Numbered Findings

### SAFE-01 — `RB-30` Zero-Block Rollover Starvation, `pauseQueue` Coupling & Step 3f Scope Contradiction

> **Pass 3:** Medium (was High). The coupling is real; no value moves. Five places say "settlement window" where RB-30 means the round. The fix below cannot work as written: a failed `settle` check reverts and records nothing. Working fix: the first call of a round requires no step in the prior `settleWindow`; steps are free otherwise. Root R5. See `06`.
- **Severity:** High
- **Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md` §4.5 Rule 5 (`L335–336`), §5.9.5 (`epochLength = 6h`, `settleWindow = 1h`, `maxRoll = 8`, `L809`, `L814`), §5.10 (`L927–932`), §5.11.3 items 5 & 7 (`L1037–1056`), §5.11.4 (`L1135–1136`), §5.11.6 (`L1258`), §5.11.7 (`L1275–1276`), §7 `RB-30` (`L1537–1539`), §11 `D25` (`L1900`), `D30` (`L1905`), §13 (`L1996–1997`)
  - `docs/technical/one-vault-timed-flows-eng-plan.md` §8.1 `E42` (`L409`), §8.2 (`L437`), §8.3 (`L483`)
- **Problem Description:**
  Under step 3f, `RB-30` prohibits `Rebalancer.step()` (including `D30` delisting sales, `§4.5 L335–336`) from running during an open round. Three compounding flaws arise:
  1. **Zero-block round rollover starvation:** Under `§5.11.3 item 5 (L1037–1038)`, a round opens when an epoch closes and takes every locked request (new and rolled). Under `§5.11.3 item 7 (L1048–1056)` and `§5.11.4 (L1135–1136)`, if a round cannot settle (e.g., Check 5 lending-rate block, Check 6 breaker, feed/USDC failure, or `pauseQueue`) or leaves rolled requests past caps, the round ends only when *"the next epoch closes."* At that exact timestamp, those rolled requests immediately open Round $k+1$ with **zero blocks** between Round $k$ ending and Round $k+1$ opening. This starves `Rebalancer.step()` and `D30` delisting sales continuously for `maxRoll × epochLength = 48 hours` while deposits roll—and **indefinitely** while any redemption request rolls under `D25` (including after a redemption owner gives notice mid-round under `§5.11.3 item 7 L1052–1055`).
  2. **`pauseQueue` cross-coupling:** If `EMERGENCY_ROLE` calls `pauseQueue` (`maxPause = 72h`, `§5.11.5 L1222`), Check 1 (`§5.9.3 L713`) prevents settlement, locking rounds back-to-back with zero gap and unintentionally halting `Rebalancer.step()` and delisting sales even though `pauseRebalance` is supposed to be an independent lever.
  3. **Internal Step 3f contradiction:** `proposal.md §5.10 (L928–929)`, `§7 RB-30 (L1537–1538)`, and `timed-flows-eng-plan.md §8.1 E42 (L409)` define the ban as **`[epochClose, roundEnd]`**, whereas `proposal.md §5.11.6 (L1258)`, `§5.11.7 (L1275–1276)`, `§13 (L1996–1997)`, `timed-flows-eng-plan.md §8.2 (L437)`, and `§8.3 (L483)` define it as **`"inside a settlement window"`** (`[epochClose, epochClose + settleWindow)`).
- **Impact:**
  Rolling `D25` redemptions, failed settlement checks, or a `pauseQueue` call can starve `Rebalancer.step()` and `D30` delisting sales for 48 hours or indefinitely, preventing convergence before `endTime + maxOverrun` (`Expired`) and leaving delisted assets unsold, while implementers face contradictory Step 3f specifications.
- **Recommendation:**
  Because `settleWindow` (`1h`) is when the 60-minute TWAP forms, block `Rebalancer.step()` strictly during **`[epochClose, firstSettleCallOrRoundAbort]`**, and explicitly allow `step()` if `pauseQueue` is active or after a failed `settle()` check until the next `epochClose` (unless `pauseRebalance` is active). Reconcile `§5.10`, `§5.11.6`, `§5.11.7`, `§7 RB-30`, `§13`, and `timed-flows-eng-plan.md §8.1–§8.3` to this single definition.

---

### SAFE-02 — Lending Venue Impairment & Asymmetric Forced Matching on Locked Depositors (D21 / RB-32)

> **Pass 3:** High, narrowed and merged into root R1. "Asymmetric forced matching" is defeated: a depositor loses the same amount matched or minted; the match changes only who receives the money. The valid core is the lock after the cutoff, protected only by a pause the cooldown can switch off. Defeated fixes: a hot-key venue exclusion moves value (ADP-2) against the v0.8.0 role split; routing deposits away breaks the pro-rata purchase. See `06`.
- **Severity:** High
- **Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md` §4.2 (`L221–224`), §4.5 (`L362–372`), §5.6 (`L547–548`), §5.9.5 (`maxEpochFlowBps = 500`, `L811`), §5.11.3 item 3 (`L1031–1035`), §5.11.4 (`L1081–1102`, `L1144–1148`), §5.11.5 (`L1218–1219`), §7 `RB-25` (`L1519–1523`), `RB-28` (`L1531–1534`), `RB-32` (`L1543–1545`), §11 `D21` (`L1896`), `D28` (`L1903`)
- **Problem Description:**
  `§5.11.4 (L1100–1102)` explicitly acknowledges: *"A loss that a venue has not marked and that does not show in its liquidity stays a residual. Every holder of the fund carries that same risk."* However, this symmetry fails for **locked depositors** relative to informed/fast redeemers when an impaired venue retains $\ge 5\%$ residual liquidity (`maxEpochFlowBps = 500`, `§5.9.5 L811`):
  1. **Asymmetric Forced Matching Against Locked Depositors:** Under `§4.2 (L222)` and `§5.11.4 (L1093–1100)`, `S` counts each lending position 1:1 at the venue's reported amount and stops deposits/matching only if any venue *"cannot pay out, now, its part of this round's redemptions"* ($\le 5\%$ of NAV per round, or `epochFlowFloorUsdc`). When a venue suffers observable bad debt or collateral impairment before marking down its exchange rate—yet still holds $\ge 5\%$ residual withdrawable cash—D21's test **passes**. Fast/informed holders queue `requestRedeem` before `epochClose`; meanwhile, depositors who entered earlier in that epoch (or rolled across epochs) are locked at `epochClose` (`§5.11.3 item 3 L1031–1035`, `RB-25`) and cannot cancel unless deposits are stopped (`D28`). Matching executes at un-haircutted face-value `S`, paying fast redeemers 100% face value out of locked depositors' cash while transferring impaired shares into depositors' `minHold`.
  2. **`RB-32` Cooldown Blocks Emergency Defense & Missing Per-Venue Lever:** `EMERGENCY_ROLE` holds no per-venue `excludeVenue` emergency lever (`§5.6 L548`; `ADMIN_ROLE` changes require the 48h timelock). Its only immediate defense is `pauseDeposits` (`§5.11.4 L1084`), which is **blocked on-chain** if `pauseDeposits` is in its `RB-32` cooldown (`maxPause` = 72h after a prior pause expired, `§5.11.5 L1218–1219`, `§7 RB-32 L1543–1545`), leaving locked depositors unprotected against adverse matching.
  3. **Honesty Assumption & False-Positive Total Freeze:** `§4.5 (L368–372)` acknowledges contracts cannot enforce that an adapter's available-liquidity view never overstates. Conversely, transient 100% utilization on a healthy venue freezes *all* deposits and *all* matching across the entire fund.
- **Impact:**
  Fast/informed redeemers can extract face-value USDC specifically from locked depositors whenever an impaired venue retains $\ge 5\%$ residual liquidity—especially when `RB-32` blocks `EMERGENCY_ROLE` from calling `pauseDeposits` and no per-venue exclusion lever exists. During normal high-utilization spikes on a healthy venue, the entire fund's deposit and match pipeline halts.
- **Recommendation:**
  Add an `EMERGENCY_ROLE` per-venue `excludeVenue` / venue-deposit-stop lever (or bad-debt / utilization / rate-drop sanity check) to D21—exempt from `pauseDeposits`'s `RB-32` cooldown or on a dedicated per-venue guard—so an impaired venue retaining partial liquidity cannot force locked depositors into face-value matching. For healthy high-utilization venues, consider allowing deposits/matching to proceed if target weight for that venue is 0 or if deposits route away from the illiquid venue.

---

### SAFE-03 — Missing `settleWindow >= TWAP_window` Parameter Bound & Unbounded Basket Weight Skew

> **Pass 3:** Low (was Medium). The bound is an identity: check 3 takes its slices from the last `settleWindow`. Reword `§5.9.5` as "slice length = `settleWindow / slices`". The basket weight cap stays an open owner item. See `06`.
- **Severity:** Medium *(downgraded from `High` after correcting Pass 1 weighting math and `settleWindow` timing errors)*
- **Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md` §4.2 (`L218–225`), §4.5 (`L296–304`), §5.9.3 checks 3–4 (`L720–725`), §5.9.5 (`L809`, `L811`, `L817–818`), §5.10 (`L930–932`), §5.11.2 (`L1012–1020`), §5.11.4 (`L1074–1076`, `L1104–1122`), §7 `RB-30` (`L1537–1539`), §19.4 (`L2935–2937`), §21.2 (`L3036`), §21.3 (`L3056–3057`), §21.4 (`L3075–3077`)
  - `docs/technical/one-vault-timed-flows-eng-plan.md` §2 `E6` (`L56`), §8.1 `E51` (`L418`)
- **Problem Description:**
  *Correction of Pass 1 errors:*
  1. **Weighting math error:** Pass 1 claimed that a 90 bps pool TWAP skew moves `S` by `85–90 bps` (an error of 20×). `S` is the NAV per share of the **entire fund** (`§4.2 L221–224`). At launch weights (`§19.4 L2935–2937`), 95% of the fund is lending (valued 1:1 in USDC) and 5% is basket assets, so a 90 bps TWAP skew across the entire 5% basket sleeve moves `S` by at most $90\text{ bps} \times 5\% = 4.5\text{ bps}$ ($225 per epoch at a $500k cap on a $10M fund, matching `§21.3 L3056–3057`), and a single `Rebalancer.step()` moves `S` by only ~1–2.25 bps.
  2. **`settleWindow` vs `TWAP_window` timing error:** Pass 1 claimed a `step()` in the final 30–60 minutes before `epochClose` falls inside `settle()`'s 60-minute TWAP window. In fact, `RB-30 (L1537–1539)` blocks `step()` at `epochClose`, and `settle()` cannot run until `epochClose + settleWindow` (`1 hour` at defaults, `§5.9.5 L809`). Because the TWAP window is also `12 × 5 min = 1 hour` (`§5.9.5 L817`), at default parameters the entire 60-minute TWAP window observed by `settle()` occurs **during `settleWindow` while `step()` is already blocked by `RB-30`**.

  *Surviving design flaws:*
  1. **Missing Parameter Bound (`settleWindow >= TWAP_window`):** The timing protection above silently relies on `settleWindow >= slices × sliceLength` (60 min at defaults), yet neither `§7` nor `E51` (`one-vault-timed-flows-eng-plan.md §8.1 L418`) enforces `settleWindow >= TWAP_window`. (Note also that `§5.9.3 check 3 L721` / `E6 L56` describe `slices` equal slices *"over the last `settleWindow`"*, whereas `§5.9.5 L817` fixes `12 of 5 min each`.) If governance lowers `settleWindow` below 60 minutes, pre-close `step()` calls pushing pools up to `97 bps` from the feed (`§5.9.5 L818`, `§5.10 L930–932`) fall directly inside `settle()`'s TWAP window and trip Check 4 (`refBandBps = 90 bps`) or skew `S` (and shrinking slice durations below 5 minutes weakens manipulation cost).
  2. **Unbounded Basket Weight (`§21.4 L3075–3077`):** No invariant in `§7` or `§4.5` caps total basket weight (`§4.5 Rule 3` only bounds an asset against pool depth, not fraction of NAV). If future receipts raise total basket weight from 5% toward 100%, maximum match-price skew `refBandBps × basketWeight` scales linearly from `4.5 bps` up toward `90 bps`.
- **Impact:**
  Governance lowering `settleWindow` below `TWAP_window` re-introduces self-inflicted Check 4 settlement DoS and pre-close `step()` skew into `S`, while basket-heavy receipts scale match-price transfer exposure toward `refBandBps` (90 bps).
- **Recommendation:**
  1. Enforce `settleWindow >= slices × sliceLength` (`>= 60 min` / `longest TWAP window`) in `FlowParams` parameter bounds (`E51`, `§7`) and reconcile `§5.9.3 check 3` / `E6` with `§5.9.5 L817`.
  2. Decide whether to add an explicit total basket weight cap in `§4.1` / `§7` (or a tighter match-only `refBandBps` per `one-vault-timed-flows-eng-plan.md §8.5 L547–548`) before applying receipts with high basket allocation.

---

### SAFE-04 — `[DEFEATED BY OWNER DECISION (D18, D20, D24)]` Loss of Exit Liveness Under Step 3f During Feed/USDC Outage or Multisig/Timelock Delay

> **Pass 3:** Defeated by owner decision. Agreed. See `06`.
- **Status / Severity:** **`[DEFEATED BY OWNER DECISION (D18, D20, D24)]`** *(Originally rated `High` in Pass 1 / `Critical` by §19 reviewer; explicitly evaluated and rejected by the owner)*
- **Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md` §5.11.5 (`L1177–1213`), §5.11.7 (`L1270–1274`), §7 `RB-20 (3f)` (`L1506`), `RB-26` (`L1524–1525`), `RB-27` (`L1526–1530`), §11 `D18` (`L1893`), `D20` (`L1895`), `D24` (`L1899`), §18.4 item 1 (`L2823–2829`), §19.1 Rule 1 (`L2882–2885`), §19.2 Row 2 (`L2897`)
  - `docs/code-reviews/design-review-0.8.0/04-operations-and-reliability.md` `OPS-01` (L54–61)
- **Disposition Explanation (Why Defeated):**
  Pass 1 flagged that restricting `redeemInKind` to wind-down (`D18`), removing `keeperGrace` (`D20`), and requiring Safe + 48h timelock execution for `shutdown` (`D24`) blocks all exits during prolonged oracle/USDC outages or keeper failures, and proposed restoring `keeperGrace` or adding a permissionless wind-down / `redeemInKind` trigger after `maxRoll` blocked epochs.
  On verification, **this exact finding (rated `Critical` by the §19 reviewer) and both proposed fixes were explicitly evaluated and rejected by the owner:**
  - **`§18.4 item 1 (L2823–2829)`:** Overruled the first draft's 54-hour in-kind exit bound for expired redemptions, deciding that a running fund has **no** in-kind exit and a holder waits until settlement resumes or the fund is shut down.
  - **`§19.1 Rule 1 (L2882–2885)` & `D20 (L1895)`:** Established that the keeper is a non-adversarial team-operated account and intentionally removed `keeperGrace`.
  - **`§19.2 Row 2 (L2897)` & `D24 (L1899)`:** Recorded the §19 reviewer's Critical finding (*"A fund that normal stress can stop (a USDC depeg, a market faster than the TWAP) has no exit except a wind-down that a role must start"*) and explicitly **rejected** the permissionless trigger after `maxRoll` blocked epochs: *"Accepted by the owner (D24, 2026-11-14): a multisig winds the fund down. The reviewer's fix, a trigger anyone can call after `maxRoll` blocked epochs, is not adopted."*
  - **`§5.11.7 (L1270–1274)`:** Explicitly accepts this governance trade-off: *"No outsider can force a wind-down, and no holder can force one either. This is the one place where a holder's exit depends on people. The owner accepts it."*
- **Operational Scope Note (`OPS-01`):**
  All recommendations to add permissionless wind-down triggers or restore `keeperGrace` are **removed** as overruled by owner decisions `D18`, `D20`, and `D24`. The distinct *operational single-point-of-failure* risk of a single team keeper EOA crashing, losing keys, or depleting gas (separate from the owner-accepted multisig wind-down policy) is addressed in `OPS-01` (`04-operations-and-reliability.md` L54–61) via a team-operated Keeper Safe / smart account with hot-standby session-key rotation and automated gas monitoring.

---

### SAFE-05 — Glide-Path Plan Convergence Deadlock (`minStepUsdc` + `toleranceBps` + `stepDepthBps`)

> **Pass 3:** Low (was Medium). Scenario B is already fixed and tested (R-F1, `proposal.md` L2159). Scenario A needs a fund under about 100k USDC. See `06`.
- **Severity:** Medium
- **Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md` §5.3 steps 3–4 (`L450–459`), §5.5 (`L498–510`), §5.6 (`L527–528`, `L532`), §14 (`L2159 R-F1`)
- **Problem Description:**
  In `Rebalancer.step()`:
  1. `notional = min(overweight, underweight, cap[asset])`, and any deviation below `minStepUsdc` (100 USDC) is ignored (§5.3 step 4 L455–459).
  2. A plan converges only when `endTime` is reached AND **every** asset is within `toleranceBps` (50 bps) (§5.5 L499, L507).
  3. §5.6 (L527) states: `"An asset whose cap falls below minStepUsdc is skipped, so it never stalls the rest of the plan."` (And `§14 L2159 R-F1` indicates the step 3 prototype added leg-pick masking for `DepthCap`, though `§5.3` and the convergence condition in `§5.5` were not updated.)
  Two deadlock scenarios arise:
  - **Scenario A (Split Underweight Dust):** One asset is overweight by > `toleranceBps` (e.g., 400 USDC on a 50,000 USDC fund = 80 bps), while 5 other assets are each underweight by 80 USDC (`< minStepUsdc = 100 USDC`). Because `min(overweight, underweight)` = 80 < 100, **every step is skipped**, yet the overweight asset never falls within `toleranceBps`.
  - **Scenario B (Skipped Illiquid Asset):** If an asset's `cap[asset]` falls below `minStepUsdc` and is skipped, `§5.3 step 3` does not specify filtering it out of leg selection (stalling all other assets if it is the most overweight/underweight), AND even when filtered, it can never reach `toleranceBps`, preventing the plan from reaching `Converged` until `endTime + maxOverrun` (`Expired`).
- **Impact:**
  Plans stall in `Open` state until `Expired`, leaving the portfolio off-target.
- **Recommendation:**
  Explicitly specify filtering assets with `cap[asset] < minStepUsdc` out of leg selection in `§5.3 step 3`, and either allow convergence when no executable step exists above `minStepUsdc` (or size `minStepUsdc` relative to `toleranceBps * TVL` / allow dust-clearing final steps when only one pair remains outside `toleranceBps`).

---

### SAFE-06 — Rebalancer Cost Accounting Bugs (`navBefore - navAfter` Floor, `§5.5` Stale Halt Label / `0 < 0` Edge Case, Dynamic Turnover)

> **Pass 3:** Low. Prose gaps about built, measured behaviour (`§14`). See `06`.
- **Severity:** Low / Medium *(downgraded from `Medium` after correcting Part 2)*
- **Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md` §5.3 steps 7–8 (`L466–472`), §5.5 (`L501`), §5.6 (`costBudgetBps`, `L531`), §5.10 (`L920–921`), §14 (`L2016`, `L2171 B-F5`)
- **Problem Description:**
  1. **Signed vs Unsigned `cost`:** `§5.3 step 7 (L466)` computes `cost = navBefore - navAfter` (against the outside feed in step 3e). If a rebalance step executes at a favorable price relative to the feed (e.g., buying when pool < feed), `navAfter > navBefore`. Unsigned subtraction underflows and reverts, blocking profitable rebalance steps; signed subtraction reduces `costSpent`, masking real losses on other steps.
  2. **Stale `§5.5` Halt Condition & Zero-Cost Edge Case *(correcting Pass 1)*:** Pass 1 erroneously claimed that halting before exceeding `costBudget` is "unreachable." In fact, `§5.3 step 8 (L468–470)` caps a step's cost at `budgetLeft`, subtracts `cost` from `budgetLeft`, and then checks *"When the budget left is below the cost of the step just taken, the plan moves to `Halted`"* (`newBudgetLeft < lastStepCost`, matching `§14 L2171 B-F5`). That transition **is reachable** whenever a step spends more than half of the prior `budgetLeft` (e.g., prior `budgetLeft = 100`, `lastStepCost = 60` yields `newBudgetLeft = 40 < 60` $\implies$ `Halted`). The two real issues remaining in Part 2 are:
     - **(a)** `§5.5 (L501)`'s diagram still uses the old pre-2026-11-12 label `costSpent > costBudget` (which cannot trigger once step cost is capped at `budgetLeft`); and
     - **(b)** the `lastStepCost == 0` when `budgetLeft == 0` edge case (e.g., a plan opened at zero NAV with `costBudget == 0` per `§14 L2016`, or a zero-cost step after exhaustion): strict comparison `newBudgetLeft < lastStepCost` evaluates `0 < 0` as `false` unless written as `newBudgetLeft == 0 || newBudgetLeft < lastStepCost`.
  3. **Dynamic TVL vs Snapshotted `costBudget`:** `costBudgetBps` is `"30 bps of plan turnover"` (`§5.6 L531`). If `costBudget` is snapshotted in USDC at `startTime`, large net deposits during a 7-day plan increase actual USDC turnover without increasing `costBudget`, prematurely halting healthy plans (as seen in `§14 L2019` where `SEQ-5M d05` halted on cost budget).
- **Impact:**
  Spurious reverts (or masked cost) on favorable trades, a stale `§5.5` state label and `0 < 0` zero-budget halt edge case, or premature plan halts during fund inflows.
- **Recommendation:**
  Floor per-step `cost` at `0` (`cost = navBefore > navAfter ? navBefore - navAfter : 0`) so favorable trades neither revert nor offset prior losses; update `§5.5 (L501)` to match `§5.3 step 8` and enforce `newBudgetLeft == 0 || newBudgetLeft < lastStepCost`; and document whether `costBudget` scales with net flows or stays fixed at `startTime`.

---

### SAFE-07 — Purchase Slippage Bound vs `refBandBps` Deadlock & Missing `maxStepSlippageBps` Check in `RB-33`

> **Pass 3:** Low (was Medium). A skip when feed and TWAP disagree is the stricter-price rule of `§5.10` working as meant. The proposed fix loosens the step's protection. State the relation instead. See `06`.
- **Severity:** Medium
- **Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md` §4.5 Rule 6 (`L346–360`), §5.6 (`L529`, `L537–539`), §5.9.5 (`refBandBps = 90`, `L818`), §5.10 (`L917–919`), §7 `RB-33` (`L1546–1548`)
  - `docs/technical/one-vault-cost-report.md` §6 (`L172–175`)
- **Problem Description:**
  1. **Step 3e `min/max(TWAP, feed)` anchor vs `refBandBps`:** `§5.10 (L917–919)` requires a purchase in `step()` to pay at most `min(TWAP, feed) * (1 + maxStepSlippageBps)` (and a sale to receive at least `max(TWAP, feed) * (1 - maxStepSlippageBps)`). However, `§5.9.5 (L818)` sets `refBandBps = 90` bps, so a pool's TWAP and spot can legitimately sit up to +90 bps above the Chainlink feed (or −90 bps below on a sale). If `maxStepSlippageBps` is set below `refBandBps + poolFee` (e.g., 50 bps, and `§5.6 L529` gives no default), then whenever `spot ≈ TWAP` is 51–90 bps from the feed on the unfavorable side, `step()`'s swap bound sits inside the pool's actual price and every step reverts.
  2. **`§4.5 Rule 6` / `RB-33` omits `maxStepSlippageBps`:** `§4.5 Rule 6 (L346–360)` and `RB-33 (L1546–1548)` only check `poolFee + feeMarginBps < legBandBps` (the *queue*'s swap band) and **never check `maxStepSlippageBps`** (the *rebalancer*'s band). Similarly, `§5.6 (L529, L537–539)` only forbids `maxStepSlippageBps <= poolFee` from the pre-Step-3e TWAP-only design, ignoring that Step 3e anchors `step()` to `min(TWAP, feed)` / `max(TWAP, feed)` rather than TWAP alone.
- **Impact:**
  An asset or parameter change can satisfy `RB-33` and `§5.6 L537–539` while silently causing frequent `step()` reverts during legitimate `refBandBps` dispersion, slowing convergence and wasting keeper gas (~0.98M–1.36M gas per call per `one-vault-cost-report.md` §6 L172–175).
- **Recommendation:**
  Require `maxStepSlippageBps > refBandBps + poolFee + feeMarginBps`, extend `§4.5 Rule 6` (`RB-33`) and `§5.6 L537–539` to validate `maxStepSlippageBps` alongside `legBandBps` (including when pool fees change), and document a concrete starting default in `§5.6`.

---

### SAFE-08 — Unspecified Deferred-Claim Interactions: `D23`/`RB-21` Lending Units & `D30` Delisted-Asset Slice Claims

> **Pass 3:** High. Confirmed. The single home of the D30 gap, which ARCH-03 and ARCH-05 repeat. Root R4. See `06`.
- **Severity:** High *(upgraded from `Medium`)*
- **Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md` §4.2 (`L221–224`), §4.5 Rule 5 (`L331–344`, esp. `L337–342`), §5.3 step 6 (`L463–465`), §5.10 (`L922–923`), §5.11.4 (`L1077–1079`, `L1151–1157`), §7 `RB-19` (`L1470–1471`), `RB-21` (`L1475–1476`), `RB-34` (`L1549–1552`), §11 `D23` (`L1898`), `D30` (`L1905`)
  - `docs/technical/one-vault-timed-flows-eng-plan.md` §3.2 (`L123–124`), §8.1 `E42` (`L409`), `E50` (`L417`), §8.2 (`L438`, `L441–444`)
- **Problem Description:**
  Step 3f introduces **two** deferred claim mechanisms for redemptions, and both have critical specification gaps across `RobotMoneyFund`, `FlowQueue`, and `Rebalancer.step()`:
  1. **`D23` / `RB-21` / `RB-34` lending position-unit claims vs. `Rebalancer.step()` withdrawals (`RB-19`):**
     Under `§5.11.4 (L1151–1157)`, if a lending venue cannot fully pay a net redemption, redeemers receive position-unit claims (`RB-21`), and *"Claim holders and the fund own the position together, by units. What the venue pays later is split between them by units, in the same call. Neither is paid first."* While `§5.11.4 (L1077–1079)` and `RB-34 (L1550–1552)` exclude claim holders' units from NAV, caps, and the venue test, the spec does **not** define what happens when `Rebalancer.step()` withdraws from that adapter (`§5.3 step 6 L463–465`):
     - If `step()` withdraws without splitting with claim holders, the fund jumps ahead of claim holders (violating `"Neither is paid first"`).
     - If `step()` *does* split proceeds with claim holders in the same call, `step()`'s realized USDC and claim liabilities change together, which is unaccounted for in `step()` sizing (`§5.3 step 4`), `navAfter` cost accounting (`§5.3 step 7`), and `RB-19` (`L1470–1471`: *"a step changes only its two traded assets and idle USDC"*).
  2. **`D30` / `§4.5` Rule 5 delisted-asset slice claims (`L337–342`, `E42 L409`):**
     Under `§4.5 Rule 5 (L337–342)`, `E42 (L409)`, and `D30 (L1905)`, while a delisted asset is sold out by keeper-only delisting steps, a redemption does not sell its slice of the delisted asset and instead receives *"a claim on that slice instead, paid in USDC as the keeper's sale proceeds come in."* Four critical gaps exist:
     - **Missing NAV / held-balance exclusion (double-counting in `RobotMoneyFund`):** Neither `§4.2` (`L221–224`), `§4.5 Rule 5` (`L337–342`), `§5.11.4` (`L1077–1079`), `RB-34` (`L1549–1552`), nor `E42` (`L409`) excludes delisted-asset slice claims from `RobotMoneyFund`'s `heldBalance` (`timed-flows-eng-plan.md §3.2 L123–124`), NAV / `S`, flow caps, or subsequent `sellForFlow` pro-rata redemptions. (Additionally, `§4.5 L341–342` removes the delisted asset's checks from the round without specifying how the fund's own remaining un-claimed delisted tokens are valued in `S` or Check 6 while being sold down.) Unexcluded claimed tokens are double-counted as fund assets in `RobotMoneyFund`, inflating `S` and letting later redemptions claim slices of tokens already owed to earlier redeemers.
     - **Unspecified USDC proceeds split during keeper delisting steps:** Unlike lending position units (`RB-21`), the spec defines no unit accounting or distribution rule specifying how USDC proceeds from each keeper delisting step (or a single-asset `emergencyUnwind`, `E50 L417`) are split between slice-claim holders and the fund's `idleUsdc`, nor how claim holders pull USDC across incremental sales.
     - **Missing `RB-19` accommodation:** `RB-19 (L1470–1471)` specifies two traded assets, requires `§5.10` feed checks, and forbids balance changes outside those two assets and idle USDC—conflicting with single-asset `D30` delisting steps (which intentionally skip `§5.10` feed checks per `§4.5 L331–335`) and with crediting/segregating USDC proceeds to claim holders in the same call.
     - **Omission from `timed-flows-eng-plan.md §8.2 (L441–444)`:** `§8.2` places *"The sale path of a delisted asset (E42)"* solely under `Rebalancer` (`L438`) while omitting slice-claim accounting in `RobotMoneyFund` / `FundFlowsLib` / `FlowQueue` and explicitly stating **`"`mintInKind` and `sellForFlow` are unchanged."`** (`L444`), directly contradicting `D30`/`E42` which require `sellForFlow` to skip selling the delisted asset and issue a slice claim.
- **Impact:**
  Double-counting of claimed delisted tokens in `RobotMoneyFund` balances/NAV/`sellForFlow`, unallocated or disputed USDC proceeds between slice-claim holders and the fund, priority violations on lending recoveries (`"Neither is paid first"`), and contradictory implementation specs for `FundFlowsLib` and `Rebalancer`.
- **Recommendation:**
  1. For `D23`/`RB-21` lending claims: explicitly specify either that `step()` splits withdrawals from venues with active `RB-21` claim units pro rata by units in the same call (sizing `step()` only on the fund's units and measuring `navAfter` net of claim splits), or that `step()` skips withdrawing from venues with active claim units.
  2. For `D30` delisted-asset slice claims: extend `RB-34`-style unit/held-balance exclusion to delisted-asset slices (excluding claimed tokens from `RobotMoneyFund` `heldBalance`, NAV/`S`, caps, and `sellForFlow`), specify the exact pro-rata USDC proceeds split and pull-claim accounting across keeper delisting steps (and `E50` single-asset `emergencyUnwind`), specify how the fund's own remaining un-claimed delisted balance is treated in `S`, update `RB-19` to accommodate claim splits and single-asset delisting steps, and amend `timed-flows-eng-plan.md §8.2 (L441–444)` so `sellForFlow`, `FundFlowsLib`, and `FlowQueue` implement slice claims.

---

### SAFE-09 — TWAP Quorum Manipulation & `maxLendRateGrowthBps` False-Positive Settlement DoS

> **Pass 3:** Medium. Confirmed; already recorded open in `§19.2`. See `06`.
- **Severity:** Medium
- **Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md` §4.2 (`L221–224`), §5.9.3 checks 5 & 6 (`L726–732`), §5.9.5 (`L811`, `L817–823`), §5.11.1 (`L997`), §5.11.4 (`L1144–1146`), §19.2 (`L2910`), §19.4 (`L2935–2937`), §21.3 (`L3056–3057`), §21.4 (`L3075–3077`)
  - `docs/technical/one-vault-timed-flows-eng-plan.md` §4.2 (`L223`, `L225–226`)
- **Problem Description:**
  1. **TWAP Median & Quorum (Corrected Impact Math):** With `slices = 12` (5 min each) and `quorum = 9` (`§5.9.5 L817`), the median of 9–12 slices can be shifted by holding a pool price for ~25–35 minutes rather than the full 60-minute window. Inside `refBandBps = 90` bps, because `S` weights basket assets by their portfolio share (`§4.2 L221–224`), at launch weights (`§19.4 L2935–2937`: 5% basket / 95% lending) a 90 bps skew across the entire 5% basket sleeve moves `S` by at most $90\text{ bps} \times 5\% = 4.5\text{ bps}$ ($225 per epoch at a $500k cap on a $10M fund, matching `§21.3 L3056–3057`). While this is unprofitable to manipulate against arbitrage and swap fees at 5% basket weight (`A27`), as noted in `SAFE-03` and `§21.4 (L3075–3077)` no invariant caps total basket weight, so manipulation leverage scales toward `90 bps` of `maxEpochFlowBps` if future receipts raise basket allocation substantially.
  2. **Tight `maxLendRateGrowthBps` (`10 bps/day`):** `maxLendRateGrowthBps = 10` bps per day (`§5.9.5 L823`) corresponds to ~36.5% annualized rate growth. On Aave V3, Morpho, or Compound V3, utilization spikes above the kink routinely push supply APYs above 40–50% for a day (>11–14 bps/day), which trips Check 5 (`L726–729`) and **blocks all settlements** for the fund (compounding `SAFE-01` starvation). `§19.2 (L2910)` already flags this (*"A lending rate that jumps blocks settlement for days"*) as **Open**, with excluding the spiking venue from settlement as the stated option.
- **Impact:**
  Frequent false-positive Check 5 settlement blocks during normal DeFi utilization spikes (`maxLendRateGrowthBps`), and rising match-price manipulation leverage if future receipts increase total basket weight well above 5%.
- **Recommendation:**
  Resolve the open `§19.2 (L2910)` option by calibrating `maxLendRateGrowthBps` against historical Aave/Morpho/Compound rate spikes on Base (or excluding/stopping deposits on a spiking venue rather than halting all settlements), and verify via `A27` across both launch weights and elevated basket weights.

---

### SAFE-10 — Check 6 (`maxSharePriceMoveBps`) Asymmetry on `Rebalancer.step()`

> **Pass 3:** Low. No harm shown; state that the omission is deliberate. See `06`.
- **Severity:** Low
- **Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md` §5.3 step 2 (`L447–449`), §5.9.3 check 6 (`L730–732`), §5.10 (`L915–916`)
  - *(Defeated Pass-1 claims verified against `docs/technical/one-vault-timed-flows-eng-plan.md` `L1`, `L18–22`, §3.1 `L114`, §3.4 `L149–154`, §8 `L370–562`, §8.2 `L425`, `L437`)*
- **Problem Description:**
  *(Defeating Pass-1 Parts 1 & 3:)* Pass 1 flagged `one-vault-timed-flows-eng-plan.md §3.4 (L149–154)` (`"Steps keep running during settlement windows"`) and `§3.1 (L114)` (`allowReturn`) as contradicting Step 3f. In fact, `timed-flows-eng-plan.md` explicitly states at `L1` and `L18–22` that `§1–§7` are the **Step 3d plan as it was built**, whereas **`§8 (L370–562)`** is the Step 3f delta (`§8.2 L425` explicitly removes `allowReturn` and `takeReturn`; `§8.2 L437` explicitly updates `Rebalancer.step()` to refuse settlement windows). Parts 1 and 3 are therefore not design contradictions (the Step 3f wording ambiguity inside `§8.2 L437` / `§8.3 L483` itself is addressed in **SAFE-01**).

  *Surviving flaw (Part 2):* `proposal.md §5.10 (L915–916)` runs checks 2 and 4 of `§5.9.3` (feed health and TWAP-vs-feed) on `Rebalancer.step()` alongside `§5.3 step 2`'s ORA-4 check (`L447–449`), but **omits Check 6 (`maxSharePriceMoveBps`, `L730–732`)**. During a >10% single-epoch market move (`maxSharePriceMoveBps = 1,000` bps, `§5.9.5 L813`), `FlowQueue.settle()` halts on Check 6 while `Rebalancer.step()` can keep trading into dislocated/volatile pools whenever ORA-4 (`200 bps` spot vs TWAP) and `refBandBps` (`90 bps` TWAP vs feed) do not simultaneously trip.
- **Impact:**
  Inconsistent circuit-breaker enforcement between `settle()` and `step()` during extreme market dislocations (>10%/epoch move).
- **Recommendation:**
  Evaluate and document in `§5.10` whether `Rebalancer.step()` should also enforce Check 6 (`maxSharePriceMoveBps`), or explicitly state why rebalancing continues during >10%/epoch directional moves as long as Check 2, Check 4, and ORA-4 hold.

---

## 5. Summary of Recommendations

1. **Unblock Rebalancer Liveness & Reconcile `RB-30` (`SAFE-01`):** Narrow `RB-30` from `[epochClose, roundEnd]` to `[epochClose, firstSettleCallOrRoundAbort]` (covering `settleWindow` while the 60m TWAP forms), explicitly allow `step()` when `pauseQueue` is active or after a failed `settle()` check until the next `epochClose`, and align `§5.10`/`RB-30`/`E42` with `§5.11.6`/`§8.2`/`§8.3`.
2. **Protect Locked Depositors Against Impaired Lending Venues (`SAFE-02`):** Add an `EMERGENCY_ROLE` per-venue exclusion / deposit-stop lever (or bad-debt sanity check) to D21 so an impaired venue retaining $\ge 5\%$ residual liquidity cannot force locked depositors into face-value matching even when `pauseDeposits` is blocked by `RB-32` cooldown (while avoiding false-positive halts on healthy high-utilization venues).
3. **Close Deferred-Claim Isolation & Split Gaps (`SAFE-08`):** Specify pro-rata unit splitting (or skipping) when `step()` withdraws from venues with active `D23`/`RB-21` claim units; extend `RB-34`-style held-balance/NAV/cap/`sellForFlow` exclusion to `D30` delisted-asset slice claims (`§4.5 Rule 5`), define the USDC proceeds split during keeper delisting steps (and `E50`), update `RB-19`, and amend `timed-flows-eng-plan.md §8.2 (L441–444)`.
4. **Enforce Parameter Bounds & Fix Rebalancer Math (`SAFE-03`, `SAFE-05`, `SAFE-06`, `SAFE-07`, `SAFE-09`, `SAFE-10`):** Enforce `settleWindow >= slices × sliceLength` (60m), evaluate a total basket weight cap (`§21.4`), require `maxStepSlippageBps > refBandBps + poolFee + feeMarginBps` in `§4.5 Rule 6`/`RB-33`/`§5.6`, filter `cap < minStepUsdc` in `§5.3 step 3` and fix dust-convergence deadlocks, floor `cost` at `0` and align `§5.5` / `budgetLeft == 0` halt checks, resolve `maxLendRateGrowthBps` (`§19.2 L2910`), and document Check 6 behavior on `step()` (`§5.10`).
5. **Acknowledge Owner-Rejected Exit Liveness (`SAFE-04` Defeated):** Do **not** restore `keeperGrace` or add permissionless wind-down triggers (explicitly rejected by the owner under `D18`, `D20`, `D24`, `§18.4 item 1`, `§19.1 Rule 1`, `§19.2 Row 2`, `§5.11.7`); mitigate single-key keeper operational SPOF risk via `OPS-01` (Keeper Safe / smart account).
6. **Close §7 Invariant Gaps:** Add formal whole-system conservation (`§4.3`), zero-supply/`seed` (`E14`), exit-fee conservation, `D23`/`D30` claim-unit and slice-claim isolation (`RB-19`/`RB-34`), `settleWindow >= TWAP_window`, basket weight cap, and `maxStepSlippageBps` consistency invariants to `§7`.
