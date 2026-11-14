# Design Review 0.8.0 — Netted Forward-Priced Flows, Share Pricing & Customer Honesty

**Worktree:** `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/design-review-0.8.0`  
**Scope:** Design documents only (implementation code `.sol`, `.rs`, `.ts` excluded by instruction).

---

## 1. Scope & Documents Reviewed

| Document | Sections & Lines | Role in Review |
| --- | --- | --- |
| `docs/technical/one-vault-rebalancer-proposal.md` | §4.2 (L218–234), §5.6 (L517–566), §5.8 (L586–598), §5.9 (L599–909), §5.11 (L937–1376), §6 (L1377–1393), §7 RB-22–RB-34 (L1477–1553), §11 D16–D30 (L1891–1905), §15–§21 (L2192–3085) | Primary specification for Step 3d (v0.8.0) and Step 3f (v0.9.0) timed flows, invariants, `ExclusionLedger` obligations, and decision/review history (D16–D30). |
| `docs/technical/research/vault-share-pricing-models.md` | Full document (L1–98) | Comparative research on quantity-based vs NAV-based pricing, slippage allocation, and historical exploit patterns. |
| `docs/technical/one-vault-timed-flows-eng-plan.md` | §1–§2 (L1–91), §8 (L370–562) | Engineering plan mapping §5.9 (E1–E23) and §5.11 (E24–E51) into contract and test specifications. |
| `docs/technical/one-vault-prd-amendments.md` | Full document (L1–119) | Cross-checked for customer-facing promises, disclosures, and Step 3f PRD amendments (§5). |

---

## 2. State Machine & Flow Math Analysis

### 2.1 Epoch, Round, and Wind-Down Lifecycle (Step 3f vs Step 3d)

1. **Step 3d (`v0.8.0-onevault`, `§5.9`, E1–E23):**
   - Requests carry per-request price limits; `quoteDeposit` / `quoteRedeem` return worst-case protocol bounds.
   - No netting between deposits and redemptions; each side settles pro rata by quantity against the fund.
   - `cancel` is open until filled; `exitInKind` and `redeemInKind` are always open (for unlocked shares) regardless of queue pause or feed outages.
   - `settle` and `step` are keeper-first with `keeperGrace` fallback to permissionless callers.

2. **Step 3f (`v0.9.0-onevault`, `§5.11`, D16–D30, E24–E51):**
   - **Open Epoch (`[t_0, t_0 + epochLength)`):** Users call `requestDeposit(usdc, owner)` or `requestRedeem(shares, owner)` with no price limit (D17). `cancel` is open.
   - **Epoch Close & Settlement Window (`[t_close, t_close + settleWindow)`):** Requests are locked (RB-25). No `settle` runs and no `step` runs (RB-30).
   - **Round (`[t_close + settleWindow, next_epoch_close]` or until net side completes/fails):**
     - `KEEPER_ROLE` only calls `settle(maxRequests, maxUsdc)` (D20).
     - Pre-trade checks 1–7 run on every `settle` call; a failed check reverts with no state change.
     - On the first passing `settle` call of the round, the **venue liquidity test** (D21) and **whole match** (D27) execute in O(1) at TWAP NAV `S` (if deposits are not stopped).
     - Subsequent `settle` calls in the round process only the remaining **net side** (FIFO, oldest first) up to `maxRequests`, `maxUsdc`, `basketCallBps`, and remaining flow/TVL caps.
   - **Hold & Freeze:** Matched and minted deposit shares sit in the queue until `settle time + minHold` (1 hour default, D4-11). `EMERGENCY_ROLE` can call `freezeSettlement` once per `maxFreeze` (7 days default).
   - **Wind-Down (`shutdown`):** Only the Safe through the timelock can start or end wind-down (D24). Settlement and rebalancing stop, pending escrow is released, holds/freezes are waived, and `redeemInKind` opens.

### 2.2 Netting, Cap, and Rounding Math Analysis

In `one-vault-rebalancer-proposal.md §5.11.4 (L1104–1122)`:
- **Step 8a (`L1106–1108`):** $D = \min(D_{\text{total}}, \text{cap}_D)$ and $R = \min(R_{\text{total}}, \text{cap}_R / S)$, with $M = \min(R, D / S)$.
- **Step 8b (`L1109–1112`):** Stores $S$, redemption match fraction $f_R = M / R$, and deposit match fraction $f_D = (M \times S) / D$. `"Every locked request of a side is matched by that same fraction."`
- **Step 8d (`L1118–1120`):** `"Each request's own part follows from the stored fraction when it is next touched. The queue calls the ledger hook for an owner before that owner's shares move (RB-22)."`
- **Math & Accounting Gaps Identified:**
  1. **Cap/Denominator Insolvency & FIFO/Dilution Failure (`FLOW-01`, Critical):** Originating in `§21.1` Row 3 (`L3027`), Step 8a caps $D$ and $R$ at $\text{cap}_D$ and $\text{cap}_R / S$, while Step 8b still divides by those capped $D, R$ and applies the resulting fraction to *every* locked request ($D_{\text{total}}, R_{\text{total}}$). When $D_{\text{total}} = 1\text{M USDC}$, $R_{\text{total}} = 500\text{k shares}$, $\text{cap}_D = \text{cap}_R = 500\text{k}$, and $S = 1$, $f_D = 100\%$ allocates **$1\text{M shares}$** against only **$500\text{k shares}$** escrowed ($500\text{k}$-share queue insolvency + $2\times$ `RB-29` breach). Switching the denominator to $D_{\text{total}}$ ($f_D = 50\%$) fixes conservation, but forces early FIFO depositors to roll 50% when a late whale submits $500\text{k}$ at epoch end (`§19.2 L2908`). Restricting the match pool to the **oldest FIFO prefix** summing to $\text{cap}_D$ and $\text{cap}_R / S$ (splitting only the boundary request) solves conservation, `RB-29`, FIFO fairness, and whale dilution together.
  2. **Multi-Round Lazy Evaluation & `ExclusionLedger` (`RB-22`) Contradiction (`FLOW-02`, Critical):** Rolling untouched requests across multiple rounds overwrites single-round `S` and `f` storage, and a single scalar accumulator cannot separate per-round `minHold` unlock timestamps or `freezeSettlement(id)` boundaries. Worse, deferring `ExclusionLedger` hooks (`RB-22`) until lazy touch in Step 8d (`L1118–1120`) means an asset exclusion snapshot at $t_{\text{excl}} > t_1$ still credits matched shares from Round 1 ($t_1$) to **Redeemer R** instead of **Depositor D** if neither touched their request before $t_{\text{excl}}$. Cohort/epoch tracking inside `FlowQueue` with an aggregate queue ledger account (or a round-index-aware `ExclusionLedger`) is required.
  3. **Dust Accounting (`FLOW-06`, Medium):** Sweeping share dust from `FlowQueue` to `RobotMoneyFund` without burning it leaves unowned shares inside `totalSupply`, slightly depressing `NAV / totalSupply`.

### 2.3 Coherence Check: D16–D30 vs §5.11 and Engineering Plan §8

Decisions D16–D30 are reflected across `§5.11` and `one-vault-timed-flows-eng-plan.md §8`, with the following specific discrepancies and open items:
- **Stale "Blend the price per side" (`FLOW-07`):** Both `one-vault-timed-flows-eng-plan.md §8.2 (L435)` (`"Blend the price per side"`) and `§8.4 Work Package 3 (L530)` (`"The match and the blended price (E24, E27, E28)"`) contradict `§8.1 E27 (L395)`, `§5.11.4 (L1141–1142)`, and `§21.1 (L3028)` (D27), which specify that each net call gets that call's own realized price.
- **Runbook vs Protocol Cooldown Conflict (`FLOW-03`):** D24/D29's `maxPause` cooldown (`RB-32`) can block `EMERGENCY_ROLE` from calling `pauseDeposits` when the Safe schedules `shutdown` under the D29 runbook rule.
- **Transient Stop Lifecycle & Dead-Code Post-Pause Continuation (`FLOW-04`):** D28's rule for cancelling locked deposits during a stop is underspecified for transient round-time stops (D21 venue illiquidity and `RB-33` pool fee > band), and `RB-31` (`maxRoll × epochLength <= timelockDelay`) + `RB-32` (`maxPause >= timelockDelay`) together guarantee that 100% of locked deposits expire before a full `maxPause` `pauseDeposits` (or timelock-gated `unpauseDeposits`) ends, making `§5.11.3 item 8 (L1059–1061)` dead code without early unpause or expiry pausing.
- **ERC-7540 Alignment Claim (`FLOW-09 [DEFEATED]`):** `§5.11.6 (L1248)` removes only the first departure row of `§5.9.6 (L840–874)` ("each request takes a limit") while intentionally preserving the remaining six documented departures (`totalAssets` revert, no `controller`/operators, `RedeemOnly`, `minHold`, etc.).
- **Notice Return & Band Exposure (`FLOW-10`):** `§21.2 (L3050)` already records and accepts that long-waiting redemptions still see updated safety bands, leaving only the concrete spec bug in `one-vault-prd-amendments.md §5 (L91)` (`"after the next settlement"` and hardcoded `"48 hours"` vs `§5.11.3 item 7 L1054–1055`'s `"when that round ends"` and `maxRoll × epochLength`).
- **Unresolved Parameters:** `§21.4 (L3071–3072)` and `§8.1 E42 (L409)` note that four Step 3f parameters remain unspecified: the bound and budget of a delisting sale, `minPoolDepthUsdc`, and `feeMarginBps`.

---

## 3. Numbered Findings

### FLOW-01 — Match Fraction Formula Causes Queue Insolvency, Breaches `RB-29`, and Enables Whale Dilution When Queued Volume Exceeds the Cap

- **Severity:** Critical
- **Exact Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md §21.1` Row 3 (`L3027`), `§5.11.4` steps 8a–8b (`L1106–1112`), `§5.11.4` (`L1138–1140, L1144–1145`), `§7 RB-23` (`L1508–1511`), `§7 RB-29` (`L1535–1536`), `§11 D22` (`L1897`), `§19.2` (`L2908`)
  - `docs/technical/one-vault-timed-flows-eng-plan.md §8.1 E27` (`L395`), `§8.1 E28` (`L396`), `§8.1 E35` (`L402`)
- **Problem Description:**
  1. **Origin in `§21.1` Row 3 (`L3027`) + Step 8a/8b Mismatch:** In `proposal.md §21.1` Row 3 (`L3027`), the second review resolved a conflict between matching all locked requests and enforcing flow caps by writing: **`"The totals are taken up to what is left of each side's cap (step 8a)."`** Accordingly, Step 8a (`§5.11.4 L1106–1108`) caps $D$ and $R$:
     $$D = \min(D_{\text{total}}, \text{cap}_D), \qquad R = \min\!\left(R_{\text{total}}, \frac{\text{cap}_R}{S}\right), \qquad M = \min\!\left(R, \frac{D}{S}\right)$$
     However, Step 8b (`§5.11.4 L1109–1112`) was left dividing by those **capped** quantities ($f_R = M / R$ and $f_D = (M \times S) / D$) and applying the resulting fraction to **every** locked request on the side: **`"Every locked request of a side is matched by that same fraction"`** (echoed in `RB-23 L1508–1509` and `E27 L395`, `E35 L402`).
  2. **Numerical Insolvency Proof:** Suppose $S = 1\text{ USDC/share}$, remaining period caps $\text{cap}_D = \text{cap}_R = 500\text{k USDC}$, total locked deposits $D_{\text{total}} = 1\text{M USDC}$, and total locked redemptions $R_{\text{total}} = 500\text{k shares}$. Then:
     - Step 8a computes $D = \min(1\text{M}, 500\text{k}) = 500\text{k USDC}$, $R = \min(500\text{k}, 500\text{k}) = 500\text{k shares}$, and $M = 500\text{k shares}$.
     - Step 8b computes $f_D = (M \times S) / D = 500\text{k} / 500\text{k} = 100\%$ (and $f_R = 100\%$).
     - Applying $f_D = 100\%$ to *"every locked request of a side"* allocates **$1\text{M shares}$** across all locked deposits (requiring $1\text{M USDC}$ matched) when redeemers only escrowed **$500\text{k shares}$** ($M = 500\text{k shares}$). That creates an immediate **$500\text{k}$-share queue insolvency** (later claimers revert on missing shares or overdraft other users' escrowed shares) and a **$2\times$ `RB-29` (`L1535–1536`) flow-cap breach** ($1\text{M USDC}$ of deposit fills against a $500\text{k USDC}$ cap). Symmetrically, when $R_{\text{total}} = 1\text{M shares}$ and $D_{\text{total}} = 500\text{k USDC}$, $f_R = 100\%$ allocates $1\text{M USDC}$ of redemption claims against $500\text{k USDC}$ of deposit escrow.
  3. **Why Dividing by $D_{\text{total}}$ ($f_D = 50\%$) Is Inferior to FIFO-Prefix Matching Within the Cap:** Merely changing the Step 8b denominator to $D_{\text{total}}$ (yielding $f_D = 500\text{k} / 1\text{M} = 50\%$) restores internal conservation ($\sum_i f_D \cdot d_i = M \times S$), **but introduces two major defects**:
     - **FIFO Violation & Forced Roll:** Because matched fills consume the period cap (`D22` `§5.11.4 L1144–1145`, `§11 L1897`, `RB-29 L1535–1536`), $M = 500\text{k}$ exhausts 100% of $\text{cap}_D = 500\text{k}$, leaving **0 cap** for net fills. If an early depositor (Alice) queued $500\text{k USDC}$ at the start of the epoch and a late whale queues $500\text{k USDC}$ before epoch close, dividing by $D_{\text{total}}$ forces Alice to roll 50% ($250\text{k}$) into future epochs despite arriving first within $\text{cap}_D$, breaking the FIFO priority principle of `§5.9.2 item 4 (L679–680)`, `RB-20 (L1473)`, and `RB-31 (L1541–1542)`.
     - **Zero-Cost Whale Dilution (`§19.2 L2908`):** `§19.2 (L2908)` explicitly flags as open: *"A depositor can ask for far more than they want, to take most of a scarce match. The surplus expires at no cost."* With denominator $D_{\text{total}}$, an attacker submitting an oversized late-epoch deposit (e.g., $9.5\text{M USDC}$ before cutoff) captures $95\%$ of the $500\text{k}$ match while diluting Alice to $5\%$ ($25\text{k}$), letting the unfilled surplus roll and expire at zero fee (`§5.11.3 item 7 L1050–1051`).
- **Impact:**
  As specified in `§5.11.4` and `§21.1` Row 3 (`L3027`), `FlowQueue` is strictly insolvent whenever queued volume on either side exceeds one period's flow cap, and breaches `RB-29` by up to $D_{\text{total}} / \text{cap}_D$. Switching to a $D_{\text{total}}$ denominator without cap-prefix truncation leaves FIFO broken and the `§19.2 L2908` whale-dilution griefing vector wide open.
- **Recommendation:**
  1. **Adopt FIFO-prefix matching within the cap:** Restrict the Step 8a–8b match pool to the **oldest FIFO prefix** of locked requests on each side whose cumulative volume sums to $\text{cap}_D$ and $\text{cap}_R / S$ (splitting only the single boundary request that straddles the cap). In the example above ($D_{\text{total}} = 1\text{M}$, $R_{\text{total}} = 500\text{k}$, $\text{cap}_D = \text{cap}_R = 500\text{k}$), only the oldest $500\text{k}$ prefix enters the match ($f_D = 100\%$ on the prefix, $0\%$ on the tail). This simultaneously guarantees queue conservation ($\sum \text{matchedShares}_i = M$ and $\sum \text{matchedUsdc}_j = M \times S$), enforces `RB-29` / `D22`, preserves FIFO priority, and completely closes the `§19.2 L2908` whale-dilution vector.
  2. **Reconcile `RB-23` and `§5.11.4` (`L1110–1111, L1138–1140`):** Narrow `"every locked request of a side"` to `"every locked request inside the FIFO cap-eligible prefix of a side"`, and add an explicit conservation invariant to `RB-24` / `FlowQueue.t.sol` (`eng-plan.md §4.3 L282–283`, `§8.3 L467–468`) asserting $\sum \text{matchedShares}_i \le M$, $\sum \text{matchedUsdc}_j \le M \times S$, and filled volume $\le \text{cap}_D, \text{cap}_R$ when $D_{\text{total}} > \text{cap}_D$ and $R_{\text{total}} \times S > \text{cap}_R$.

---

### FLOW-02 — Lazy O(1) Match Accounting Breaks Multi-Round Rolls, Per-Settlement Holds/Freezes, and `ExclusionLedger` (`RB-22`) Attribution

- **Severity:** Critical
- **Exact Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md §4.2 (L232–233)`, `§5.9.2 item 6 (L689–693)`, `§5.11.3 items 5–7 (L1037–1056)`, `§5.11.4 (L1085)`, `§5.11.4 steps 8b–8d (L1109–1120)`, `§5.11.5 (L1201–1202, L1223–1225)`, `§5.11.9 (L1367–1370)`, `§6 (L1381)`, `§7 RB-22 (L1477–1479)`, `§20.3 (L2993)`
  - `docs/technical/one-vault-timed-flows-eng-plan.md §2 E13 (L63)`, `§2 E17 (L67)`, `§8.1 E35 (L402)`, `§8.1 E49 (L416)`, `§8.3 (L515–517)`
- **Problem Description:**
  1. **Multi-Round Overwrite & Per-Round `minHold` / `freezeSettlement` Separation:**
     `§5.11.4` (`L1109–1120`) and `E35` (`L402`) specify that the match is booked whole in O(1) by storing $S$ and one matched fraction per side, and that `"Each request's own part follows from the stored fraction when it is next touched."` However, unfilled remainders roll across subsequent rounds (`§5.11.3 item 7 L1048–1049`), and a request can remain untouched by `settle` for multiple rounds (whenever `maxRequests` or `maxUsdc` stops the net-side cursor earlier, or whenever a request sits on the smaller matched side where the net cursor does not run at all).
     If `FlowQueue` stores only a single round's $S$ and matched fractions, Round $k+1$ overwrites Round $k$'s values before untouched requests materialize their Round $k$ fills. Furthermore, each round's matched deposit fill has its own `settle time + minHold` unlock timestamp (`§5.9.2 item 6 L689–690`, `§5.11.3 item 6 L1046–1047`) and can be independently targeted by `freezeSettlement(id)` (`§5.11.5 L1223–1225`, `E17 L67`, `E49 L416`). A single scalar accumulator cannot separate Round $k$'s frozen or unlocked shares from Round $k+1$'s still-held shares.
  2. **Fundamental Contradiction Between Step 8d Lazy O(1) Touch Accounting and `ExclusionLedger` (`RB-22`):**
     Step 8d (`§5.11.4 L1118–1120`) states: **`"Each request's own part follows from the stored fraction when it is next touched. The queue calls the ledger hook for an owner before that owner's shares move (RB-22)."`** Meanwhile, `RB-22` (`§7 L1477–1479`) requires: *"The exclusion ledger credits every queued share to its owner. The queue reports each change of an owner's queued shares to the ledger before the change happens."* (See also `§4.2 L232–233`, `§6 L1381`, and `E13 L63`, where `ExclusionLedger` snapshots each owner's checkpointed wallet shares + queued shares when a lending asset is excluded, and `FlowQueue`'s own address holds no entitlement.)
     **Proof of Attribution Failure ($t_1 < t_{\text{excl}} < t_2$):**
     - Suppose Round 1 matches **Redeemer R** and **Depositor D** at time $t_1$ (`Step 8c L1113–1115`: $M$ shares move economically on the queue's books from R's escrow to D's hold, while R is credited $M \times S$ minus exit fee in USDC). Neither R nor D calls `claim` yet, and the net cursor does not touch their requests.
     - At time $t_{\text{excl}} > t_1$, an impaired lending asset is excluded (`§5.11.4 L1085`, `§4.2 L232–233`, `§6 L1381`), snapshotting the `ExclusionLedger` record at $t_{\text{excl}}$.
     - Later, at $t_2 > t_{\text{excl}}$, R and D touch their requests (claiming USDC / shares or rolling in a later round).
     - Because Step 8d deferred calling the `ExclusionLedger` hook until each request was *"next touched"* ($t_2 > t_{\text{excl}}$), at the exclusion snapshot $t_{\text{excl}}$ the `ExclusionLedger` **still recorded Redeemer R as the owner of the matched shares** that had already been economically sold and transferred to **Depositor D** at $t_1$!
     - As a result, **Redeemer R** takes **both** full face-value NAV USDC ($M \times S$) at $t_1$ **and** the post-$t_{\text{excl}}$ `ExclusionLedger` recovery proceeds for shares R no longer owned, while **Depositor D** — who already paid $M \times S$ at $t_1$ and suffered the excluded-asset impairment at $t_{\text{excl}}$ — receives **zero** `ExclusionLedger` recovery for those matched shares. (Indeed, `§5.11.9 L1367–1370` and `§20.3 L2993` explicitly note that Step 3f's intra-queue match transfers and wind-down escrow releases void the earlier `RB-22` conclusion and have not yet been traced.)
- **Impact:**
  1. Untouched rolled requests lose Round $k$ fills, misapply Round $k+1$ prices/fractions to Round $k$ volume, or corrupt `minHold` and `freezeSettlement` per-round boundaries.
  2. Under any impaired-lending-asset exclusion after a match ($t_{\text{excl}} > t_1$) and before lazy request touch ($t_2 > t_{\text{excl}}$), `ExclusionLedger` (`RB-22`) misattributes recovery proceeds from matched buyers (Depositor D) to exited sellers (Redeemer R), breaking loss-recovery parity.
- **Recommendation:**
  1. **Per-round cohort/prefix-product accumulators + per-round hold/freeze separation:** Store per-round match history / prefix-product accumulators (e.g., `remainingFactor[round]`, `cumulativeMatchedSharesPerUnit[round]`, `cumulativeMatchedUsdcPerUnit[round]`) and per-round `settleTime` / `frozen[roundId]` metadata so any request entering at epoch $e$ and touched at round $r$ reconstructs its exact per-round fills, `minHold` unlock dates, and freeze status in $O(1)$ per rolled round without overwriting prior rounds.
  2. **Architectural fix for `ExclusionLedger` (`RB-22`):** Eliminate the incompatibility between lazy O(1) touch accounting and synchronous `beforeBalanceChange` `ExclusionLedger` checkpoints using one of two designs:
     - **Queue cohort tracking + single aggregate `FlowQueue` ledger account:** Register `FlowQueue` as a single aggregate holder in `ExclusionLedger` (replacing `E13 L63`'s *"The queue's own address has no entitlement"*), track share ownership and exclusion snapshots by **epoch/round cohort** inside `FlowQueue`, and distribute `FlowQueue`'s aggregate recovery entitlement to depositors and redeemers based on their **economic ownership at $t_{\text{excl}}$** when they touch/claim; **or**
     - **Round-index-aware `ExclusionLedger`:** Make `ExclusionLedger` natively round/epoch-cohort aware so it resolves an owner's effective queued share balance at any historical snapshot timestamp $t_{\text{excl}}$ using `FlowQueue`'s immutable per-round match records.
     Extend the chosen mechanism to wind-down escrow releases (`§5.11.5 L1201–1202`, `§5.11.9 L1368–1370`) as well.

---

### FLOW-03 — `pauseDeposits` Cooldown (`RB-32`) Can Block the Mandatory `shutdown` + `pauseDeposits` Wind-Down Pairing

- **Severity:** High
- **Exact Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md §5.11.5 (L1190–1197, L1217–1222)`, `§7 RB-32 (L1543–1545)`, `§21.2 (L3045)`
  - `docs/technical/one-vault-timed-flows-eng-plan.md §8.1 E39 (L406)`
- **Problem Description:**
  `§5.11.5 (L1190–1197)` identifies a critical MEV/adverse-selection vector: because `shutdown` must go through the timelock, its scheduling is public for `timelockDelay` (48–72h). Without a deposit stop, redeemers can enter during the notice period and match at NAV against depositors who locked before the announcement. The design relies on a **runbook rule** pairing `shutdown` with `pauseDeposits`.
  However, `RB-32` (`§5.11.5 L1218–1219`, `E39 L406`) enforces that `pauseDeposits` ends after `maxPause` **and cannot be called again for `maxPause`**. If `EMERGENCY_ROLE` previously used `pauseDeposits` for an incident and it expired within the last `maxPause` (72h), `pauseDeposits` is in cooldown and **cannot be called** when the Safe schedules `shutdown`. Additionally, if `maxPause == timelockDelay` (the minimum allowed by `RB-32`), any delay between `EMERGENCY_ROLE` calling `pauseDeposits` and the Safe executing `shutdown` after the timelock expires leaves a window where `pauseDeposits` auto-expires *before* `shutdown` executes.
- **Impact:**
  If `pauseDeposits` is on cooldown or expires before `shutdown` executes, locked depositors cannot cancel and are exposed to adverse matching against informed redeemers during the public `shutdown` notice period.
- **Recommendation:**
  1. Allow `ADMIN_ROLE` (the Safe via the timelock) or a dedicated wind-down-prep action to pause deposits without being blocked by `EMERGENCY_ROLE`'s `RB-32` cooldown (since `RB-32` exists only to limit a compromised `EMERGENCY_ROLE` hot key).
  2. Enforce `maxPause >= timelockDelay + epochLength` (or have `shutdown` scheduling/intent directly set a non-expiring deposit stop) so a pause cannot expire mid-notice.

---

### FLOW-04 — Transient Deposit-Stop Causes Have Undefined `cancel` Lifecycle and `RB-31` + `RB-32` Makes Post-`pauseDeposits` Continuation Dead Code

- **Severity:** High
- **Exact Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md §5.8 (L593)`, `§5.9.5 (L809, L814)`, `§5.11.3 items 7–9 (L1050–1070)`, `§5.11.4 (L1081–1089)`, `§5.11.5 (L1220–1222)`, `§7 RB-25 (L1519–1523)`, `§7 RB-31 (L1540–1542)`, `§7 RB-32 (L1543–1545)`, `§7 RB-33 (L1546–1548)`
  - `docs/technical/one-vault-timed-flows-eng-plan.md §8.1 E36 (L403)`, `§8.1 E39 (L406)`, `§8.1 E40 (L407)`, `§8.1 E41 (L408)`, `§8.1 E51 (L418)`
- **Problem Description:**
  1. **Undefined Start/End Lifecycle for Transient Round-Time Stops (Causes 3 & 5):**
     `§5.11.3 item 8 (L1057–1063)` states that while deposits are stopped, a locked deposit can be cancelled, and: **`"When the stop ends, the deposits that stayed are treated as requests of the epoch that is open at that moment. They can be cancelled until that epoch closes and take part from its round."`**
     `§5.11.4 (L1081–1089)` lists five causes for deposits being stopped, two of which are **transient, round-time checks**:
     - Cause 3 (`L1086`): `"a lending venue cannot pay out, now, its part of this round (D21)"` (which depends on the current round's redemption size $R$ and live venue liquidity);
     - Cause 5 (`L1088–1089`, `RB-33 L1546–1548`): `"a pool's fee has moved to or above what the swap band can pay"`.
     The specification does not define how `cancel` determines whether a stop is active or when it "ends" for Causes 3 and 5:
     - If `cancel` reads a stored flag set by `settle`, a deposit locked in Round 1 cannot cancel until `settle` runs and fails the venue test, and if `settle` is not called again, the flag stays stale even after the venue recovers.
     - If `cancel` reads live venue liquidity / pool fees on-chain, a borrower repaying a lending venue at minute 59 of a 60-minute `settleWindow` would "end the stop" mid-window, shifting those deposits into the *next* open epoch (skipping the current round) or creating a race condition right before `settle`.
  2. **Mathematical Proof That `RB-31` + `RB-32` Makes Post-`pauseDeposits` Continuation (`§5.11.3 item 8 L1059–1061`) Dead Code:**
     - By `RB-31` (`§7 L1542`, `§5.11.3 item 9 L1068–1070`, `E51 L418`):
       $$\text{maxRoll} \times \text{epochLength} \le \text{timelockDelay}$$
       (at launch defaults in `§5.9.5 L809, L814` and `§5.8 L593`: $8 \times 6\text{h} = 48\text{h} \le 48\text{h}$).
     - By `RB-32` (`§7 L1545`, `§5.11.5 L1220–1222`, `E51 L418`):
       $$\text{maxPause} \ge \text{timelockDelay}$$
       (at launch default in `§5.11.5 L1222` and `E39 L406`: $72\text{h} \ge 48\text{h}$).
     - Combining both invariants gives the unconditional ordering:
       $$\text{maxRoll} \times \text{epochLength} \le \text{timelockDelay} \le \text{maxPause}$$
     - Meanwhile, `RB-31` (`§5.11.3 item 9 L1064–1065`, `E41 L408`) fixes each deposit request's `expiry` timestamp at creation (`requestEpochClose + maxRoll × epochLength`), and `§5.11.3 item 7 (L1050–1051)` expires deposits after `maxRoll` epochs so they *"can no longer fill."*
     - Consequently, **100% of locked deposits present when `pauseDeposits` is invoked expire before any full `maxPause` `pauseDeposits` ends** ($t_{\text{expiry}} \le t_{\text{pause}} + \text{maxRoll} \times \text{epochLength} \le t_{\text{pause}} + \text{maxPause}$). Even if `ADMIN_ROLE` intervenes via `unpauseDeposits` (`§5.11.3 item 8 L1061–1063`), `unpauseDeposits` itself must wait $\text{timelockDelay} \ge \text{maxRoll} \times \text{epochLength}$ unless it was already pre-scheduled before the pause. Thus, `§5.11.3 item 8 (L1059–1061)` (*"When the stop ends, the deposits that stayed are treated as requests of the epoch that is open at that moment..."*) is **mathematically unreachable (dead code)** for a full `pauseDeposits` unless either `ADMIN_ROLE` unpauses early or deposit `expiry` pauses/extends while deposits are stopped.
- **Impact:**
  1. Ambiguous `cancel` eligibility during transient stops (Causes 3 and 5) risks either trapping depositors when venues are illiquid or allowing mid-window cancel/epoch-shift races (`RB-25`).
  2. Dead-code continuation semantics for `pauseDeposits` under `RB-31` + `RB-32` leave implementers and users with contradictory expectations about whether locked deposits survive a pause or silently expire mid-pause.
- **Recommendation:**
  1. Explicitly separate **state-based stops** (causes 1, 2, 4: `pauseDeposits`, excluded lending asset, delisting sale) from **round-time skips** (causes 3, 5: venue liquidity test, pool fee check), and define the exact state variable and timestamp recorded when a round skips deposits due to Cause 3 or 5 (e.g., `lastDepositStopEpoch`).
  2. Resolve the `RB-31` + `RB-32` deadline contradiction explicitly: either specify that deposit `expiry` pauses/extends across a deposit stop (with `cancel` remaining open until the post-stop epoch closes per `§5.11.3 item 8` so extended deposits are not trapped across a timelock change), or remove the dead-code post-`pauseDeposits` continuation branch and document that locked deposits expire after `maxRoll × epochLength` during any pause lasting $\ge \text{timelockDelay}$.

---

### FLOW-05 — Ending a Round Immediately on Any Net-Side Call Failure Prevents Retries and Forces a Full Epoch Wait

- **Severity:** Medium
- **Exact Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md §5.11.4 (L1134–1136)`
  - `docs/technical/one-vault-timed-flows-eng-plan.md §8.1 E35 (L402)`
- **Problem Description:**
  `§5.11.4 (L1134–1136)` states: `"If a call fails, the remainder stays pending and the match stands. The round ends when the net side is done, has failed, or the next epoch closes."`
  Because `basketCallBps` (5 bps of pool depth per block) forces large net flows to execute across multiple `settle` calls, a transient per-swap band failure on call $N$ (e.g., spot momentarily outside `legBandBps` in one block) immediately terminates the round. Once the round ends, the keeper cannot retry in the next block; all remaining net requests must wait until the next epoch closes and its `settleWindow` elapses (7 hours at defaults), and the rebalancer is immediately unlocked to `step` (`RB-30`).
- **Impact:**
  Reduces settlement completion rate (`G9`) and increases user wait times by at least `epochLength + settleWindow` (7 hours) on any single-block swap-band miss during multi-call net settlement.
- **Recommendation:**
  Do not end the round on a failed net-side `try/catch` call; keep the round open until the net side completes or the next epoch closes, allowing `KEEPER_ROLE` to retry in subsequent blocks.

---

### FLOW-06 — Unspecified Handling of Swept Share Dust from Match Rounding

- **Severity:** Medium
- **Exact Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md §5.11.4 step 8e (L1121–1122)`
- **Problem Description:**
  Step 8e states: `"Rounding leaves dust on the queue's books, which sweep sends to the fund. A flow user never gains from rounding."`
  While sending USDC dust to `RobotMoneyFund` increases `idleUsdc` (a clean gift to holders), sending **share dust** (fund ERC-20 shares left in `FlowQueue` from rounding down depositor share allocations) to `RobotMoneyFund` is unspecified. If `RobotMoneyFund` merely holds its own shares without burning them (similar to `seed` shares), those shares remain in `totalSupply` in Check 10 and NAV-per-share `S`, permanently locking a tiny fraction of supply rather than retiring it.
- **Impact:**
  Minor accounting ambiguity between `FlowQueue` and `RobotMoneyFund` (and potential interaction with the exclusion ledger hook if `RobotMoneyFund` receives its own shares).
- **Recommendation:**
  Specify that `sweep` sends **USDC dust** to `RobotMoneyFund` (as idle USDC) and **burns** any swept share dust (or transfers it to a zero-entitlement burn/lock sink excluded from `totalSupply` if burning is not desired).

---

### FLOW-07 — Stale "Blend the Price Per Side" Specification in Engineering Plan §8.2 and §8.4 Contradicts D27 / E27

- **Severity:** Medium
- **Exact Citations:**
  - `docs/technical/one-vault-timed-flows-eng-plan.md §8.2 (L435)` (`"Blend the price per side."`) and `§8.4` Work Package 3 (`L530`: `"The match and the blended price (E24, E27, E28)."`) vs `§8.1 E27 (L395)`
  - `docs/technical/one-vault-rebalancer-proposal.md §5.11.4 (L1141–1142)`, `§21.1 (L3028)`
- **Problem Description:**
  `one-vault-rebalancer-proposal.md §21.1 (L3028)` explicitly resolved the ambiguity in "one price per side" via D27 and `RB-23`: `"one matched fraction and one price for the match, and each net call's own realized price."` `§8.1 E27 (L395)` was updated to match this. However, **two places** in `one-vault-timed-flows-eng-plan.md` still carry the superseded `"blend"` language:
  - `§8.2 (L435)` instructs implementers of `FlowSettleLib` to: **`"Blend the price per side."`**
  - `§8.4` Work Package 3 (`L530`) defines the implementation work package as: **`"The match and the blended price (E24, E27, E28)."`**
- **Impact:**
  An engineer implementing `FlowSettleLib` and Work Package 3 from `§8.2` / `§8.4` could implement a blended average price across multiple net calls (which conflicts with `RB-23` and `E27` and is infeasible/complex when earlier calls already settled and recorded claims) instead of per-call realized pricing.
- **Recommendation:**
  Update both `one-vault-timed-flows-eng-plan.md §8.2 (L435)` (replace `"Blend the price per side"` with `"Each net call's fills get that call's realized price (E27)"`) and `§8.4` Work Package 3 (`L530`) (replace `"The match and the blended price (E24, E27, E28)"` with `"The match and per-call net pricing (E24, E27, E28)"`).

---

### FLOW-08 — Customer Honesty: Hidden Slippage Variance, Last-Block Cancel Baiting, and Unamended PRD Promises

- **Severity:** Medium
- **Exact Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md §5.11.3 item 2 (L1027–1030)`, `§5.11.7 (L1278–1294)`, `§21.2 (L3052)`
  - `docs/technical/one-vault-prd-amendments.md §5 (L91–117)`
- **Problem Description:**
  1. **Unquoted Slippage & Execution Variance:** Under Step 3f, `quoteDeposit` and `quoteRedeem` return no price and no slippage bound (`§5.11.3` item 2). A user locking into an epoch cannot know whether they will be **matched** (0 pool fee, 0 swap slippage, up to `refBandBps` TWAP lag) or **net** (full pool fees + price impact + up to `legBandBps` slippage).
  2. **Last-Block Cancel Baiting (`§21.2 L3052`):** Because `cancel` remains open until the last block of the epoch, a large counterparty can signal a 100% match and cancel in the final block, forcing remaining locked users into an unexpected 100% net trade with full swap slippage.
  3. **Incomplete Customer Disclosures & Unamended PRD Promises:** `one-vault-prd-amendments.md §5 (L109–117)` documents four live PRD promises broken by Step 3f that have **no drafted amendment yet** (including `§9 L390`: surfaces `"itemize fees and slippage"`, and `§6/§9`: revoking an agent's policy does not stop already-locked deposit requests). Furthermore, `quoteDeposit` / `quoteRedeem` do not surface the protocol's `legBandBps` / `refBandBps` bounds or the keeper-only liveness dependence (`D20`).
- **Impact:**
  Users face hidden execution-cost variance (0 bps vs `legBandBps + poolFee`), last-block match-baiting, and material divergence between PRD promises and actual Step 3f behavior.
- **Recommendation:**
  1. Close the cancel window a short buffer before epoch close (as noted in `§21.2 L3052`), or disclose pending epoch imbalance in the UI with an explicit warning that match vs. net execution is not guaranteed.
  2. Draft the remaining PRD amendments in `one-vault-prd-amendments.md §5` (especially `§9 L390` slippage itemization and agent-policy revocation) and surface `refBandBps`, `legBandBps`, and keeper/Safe liveness assumptions in the terms view/UI.

---

### FLOW-09 — [DEFEATED] Overstated ERC-7540 Alignment in §5.11.6

- **Severity:** Low `[DEFEATED]`
- **Exact Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md §5.9.6 (L840–874)`, `§5.11.6 (L1248)`
- **Disposition & Rationale (Why Defeated):**
  `one-vault-rebalancer-proposal.md §5.9.6 (L840–874)` already explicitly frames the interface as *"an ERC-4626 vault in shape, with ERC-7540's request and claim flow. It departs from both where safety or size calls for it (owner, 2026-11-11, D13). Each departure is listed, so clients are not surprised"* (`L842–844`), and documents the **full 7-row deliberate departures table** (`L862–873`):
  1. Per-request limits / quote views replacing previews (`L866`);
  2. `cancel`, `exitInKind`, `redeemInKind`, and withdrawal of expired escrow (`L867`);
  3. Post-settlement `minHold` delivery delay (`L868`);
  4. `withdraw` reverting `RedeemOnly` (`L869`);
  5. Direct `deposit`/`mint`/`redeem` on `RobotMoneyFund` reverting and naming `FlowQueue` (`L870`);
  6. `totalAssets` and convert functions reverting when any feed is unhealthy (`L871`);
  7. No `controller`, no `isOperator`/`setOperator`, and requests pulling only from `msg.sender` (`L872`).
  Against that table, `§5.11.6 (L1248)` refers **specifically and only to removing the first departure row**:
  - Removed item: **`"The departure from ERC-7540 'each request takes a limit' (§5.9.6)"`**
  - Explanation: `"A standard request has no limit. The request functions now match the standard's shape."`
  Because `§5.9.6 (L840–874)` transparently documents the remaining departures (rows 4, 6, 7, etc. — while Step 3f also documents removing `exitInKind` and running-fund `redeemInKind` in the same `§5.11.6` table at `L1244`) and `§5.11.6 (L1248)` narrows its claim specifically to removing the limit parameter from requests, the original finding that `§5.11.6` concealed `totalAssets()` reverting or omitted `controller`/operators is **defeated**. (At most, `"shape"` in `L1248` is minor prose shorthand for removing the non-standard limit argument, while row 7 of `§5.9.6` still documents the 2-argument no-operator request signature.)

---

### FLOW-10 — PRD §5 (L91) Specification Bug on Notice Return Timing & Hardcoded 48h (Long-Waiting Band Exposure Already Accepted in §21.2)

- **Severity:** Low
- **Exact Citations:**
  - `docs/technical/one-vault-rebalancer-proposal.md §5.11.3 items 7 & 9 (L1052–1070)`, `§5.11.5 (L1174–1175)`, `§7 RB-25 (L1522–1523)`, `§7 RB-31 (L1540–1542)`, `§11 D25–D26 (L1900–1901)`, `§21.2 (L3050)`
  - `docs/technical/one-vault-timed-flows-eng-plan.md §8.1 E40 (L407)`
  - `docs/technical/one-vault-prd-amendments.md §5 (L91)`
- **Problem Description:**
  1. **Accepted Trade-Off on Long-Waiting Redemption Safety Parameters (`§21.2 L3050`):** While `RB-31` (`§7 L1542`, `§5.11.3 item 9 L1068–1070`) bounds `maxRoll × epochLength <= timelockDelay` so locked *deposits* expire before a timelock parameter change takes effect, redemptions do not expire (`D25`, `L1900`). However, `one-vault-rebalancer-proposal.md §21.2 (L3050)` **already explicitly recorded and accepted** this trade-off:
     > `"Safety parameters move under locked requests. | Low | Partly: RB-31 bounds maxRoll × epochLength by the timelock's delay. A redemption that waits longer still sees new bands."`
     Under `D25` and `D26` (`L1900–1901`), fixed terms (`exitFee`, `minHold`, `expiry`) stay immutable, whereas bands and caps are round-level safety parameters applied dynamically when each round runs.
  2. **Concrete Specification Bug in `one-vault-prd-amendments.md §5 (L91)`:** Row 1 of `§5 (L91)` contains two concrete errors against `§5.11.3 item 7 (L1054–1055)`, `§5.11.5 (L1174–1175)`, `RB-25 (L1522–1523)`, and `E40 (L407)`:
     - **Wrong return trigger (`"after the next settlement"` vs `"when that round ends"`):** `§5 (L91)` states twice (`"get the unfilled shares back after the next settlement"` in *What step 3f does* and `"gets them after the next settlement"` in *Proposed text*), contradicting `§5.11.3 item 7 (L1054–1055)`, which specifies that unfilled shares go back **`"when that round ends"`** — an event that occurs at the next epoch close (`§5.11.4 L1135–1136`) even if no settlement succeeds during a blocked/paused round.
     - **Hardcoded `"48 hours"` instead of `maxRoll × epochLength`:** The *Proposed text* in `§5 (L91)` hardcodes **`"After 48 hours"`** (even though *What step 3f does* in the same row says `"After a fixed number of epochs"`), which will drift out of sync with the actual queue parameter if `ADMIN_ROLE` changes `maxRoll` or `epochLength` within `RB-31`.
- **Impact:**
  Customer-facing PRD text in `one-vault-prd-amendments.md §5 (L91)` misstates when a long-waiting redeemer recovers shares during stalled settlements (`"after the next settlement"` instead of `"when that round ends"`) and hardcodes `48 hours` instead of `maxRoll` epochs. (Safety-band exposure for redemptions waiting past `maxRoll` is an already-accepted residual in `§21.2 L3050`.)
- **Recommendation:**
  Update `one-vault-prd-amendments.md §5 (L91)` (both *What step 3f does* and *Proposed text*) to state `"after maxRoll epochs (48 hours at launch defaults) ... when the open or forming round ends"` rather than `"After 48 hours ... after the next settlement"`.

---

## 4. Summary of Findings

| ID | Severity | Title | Primary Citation |
| --- | --- | --- | --- |
| FLOW-01 | Critical | Match fraction formula causes queue insolvency, breaches `RB-29`, and enables whale dilution when queued volume exceeds cap | `one-vault-rebalancer-proposal.md §5.11.4 (L1106–1112)`, `§21.1 (L3027)` |
| FLOW-02 | Critical | Lazy O(1) match accounting breaks multi-round rolls, per-round holds/freezes, and `ExclusionLedger` (`RB-22`) attribution | `one-vault-rebalancer-proposal.md §5.11.4 (L1109–1120)`, `RB-22 (L1477–1479)` |
| FLOW-03 | High | `pauseDeposits` cooldown (`RB-32`) can block mandatory `shutdown` + `pauseDeposits` wind-down pairing | `one-vault-rebalancer-proposal.md §5.11.5 (L1190–1197)`, `RB-32` |
| FLOW-04 | High | Transient deposit-stop causes have undefined `cancel` lifecycle and `RB-31` + `RB-32` makes post-`pauseDeposits` continuation dead code | `one-vault-rebalancer-proposal.md §5.11.3 (L1057–1070)`, `RB-31`, `RB-32` |
| FLOW-05 | Medium | Ending a round immediately on any net-side call failure prevents retries and forces a full epoch wait | `one-vault-rebalancer-proposal.md §5.11.4 (L1134–1136)` |
| FLOW-06 | Medium | Unspecified handling of swept share dust from match rounding | `one-vault-rebalancer-proposal.md §5.11.4 (L1121–1122)` |
| FLOW-07 | Medium | Stale `"Blend the price per side"` / `"blended price"` spec in Engineering Plan §8.2 & §8.4 WP3 contradicts D27 / E27 | `one-vault-timed-flows-eng-plan.md §8.2 (L435)`, `§8.4 (L530)` |
| FLOW-08 | Medium | Customer honesty: hidden slippage variance, last-block cancel baiting, and unamended PRD promises | `one-vault-prd-amendments.md §5 (L91–117)`, `§21.2 (L3052)` |
| FLOW-09 | Low `[DEFEATED]` | `[DEFEATED]` Overstated ERC-7540 alignment in §5.11.6 (`§5.9.6` documents all 7 departures; `§5.11.6` removes only row 1) | `one-vault-rebalancer-proposal.md §5.9.6 (L840–874)`, `§5.11.6 (L1248)` |
| FLOW-10 | Low | PRD §5 (`L91`) spec bug on notice return timing & hardcoded 48h (long-waiting band exposure accepted in `§21.2 L3050`) | `one-vault-prd-amendments.md §5 (L91)`, `§21.2 (L3050)` |
