# Design Review 0.8.0 — Pass 3: Adversarial Critique of Pass 2

**Target branch:** `docs/onevault-netted-forward-priced-flows`, design text at `decef7c99`.
**Scope:** The Pass 2 review in this folder (`00` to `05`), checked against the design documents. Design documents only, as in Pass 2. No code was read.
**Date:** 2026-11-14.
**Status:** Final draft. This chapter supersedes the severities and recommendations of `01` to `05` wherever they differ. `00-executive-summary.md` carries the final index.

---

## 1. Method

Pass 3 read the executive summary, the whole of `02`, and every Critical and High finding in `01`, `03` and `04`. It checked each claim against the cited text of `one-vault-rebalancer-proposal.md`, `one-vault-timed-flows-eng-plan.md`, `one-vault-prd-amendments.md`, ADR-0004 and `smart-contract-invariants.md`. Medium and Low findings were checked where they touch a High finding. The rest keep their Pass 2 rating and are marked "not re-checked".

Each finding gets one disposition:

- **Confirmed.** The defect is in the design text as cited.
- **Corrected.** The problem is real, but its size, cause or fix is wrong.
- **Defeated.** The design text already answers it, or the cited facts are wrong.
- **Merged.** The same root cause is counted under another ID.

Two rules for severity were applied evenly:

- **Critical** means the design is unsound and no contained fix is known.
- **High** means value moves wrongly, or users are stuck, if the design is built as written, and a contained spec fix exists.

Under those rules no finding is Critical. Pass 2's two Critical findings are real and are High.

---

## 2. Dispositions of the Pass 2 Critical and High findings

### FLOW-01 — Confirmed defect, corrected severity (High) and corrected fix

**Confirmed.** Step 8a caps `D` and `R` at what is left of each side's cap (`proposal.md` L1106). Step 8b divides by those capped values and applies the fraction to every locked request (L1109, RB-23 L1508). With 1M USDC of locked deposits, 500k of shares to redeem, caps of 500k and `S = 1`, the deposit fraction is 100%. That books 1M of matched shares against 500k escrowed. The arithmetic in Pass 2 is right.

**Corrected severity.** This is an arithmetic error in a formula, not a design flaw. The conservation test the plan already calls for (eng plan §8.3, RB-24) fails on it at once. High.

**Corrected fix.** The minimal fix is the denominator:

- `M = min( min(R_locked, capR / S), min(D_locked, capD) / S )`
- redemption fraction `M / R_locked`, deposit fraction `M × S / D_locked`

That conserves shares and USDC, keeps `M × S` inside the deposit cap and `M` inside the redemption cap, and keeps the match O(1).

**Defeated part: the FIFO-prefix recommendation.** Pass 2 recommends matching only the oldest prefix of requests, and says this "completely closes" the over-asking vector of `§19.2 L2908`. Two problems:

1. It reverses an owner-approved rule without saying so. D27 and RB-23 state that nobody is matched ahead of anybody else (L1138, L1508, D27 L1902). Pass 2 cites the step 3d ordering rule (`§5.9.2 item 4`), which step 3f replaced for the match.
2. It does not close the vector. It moves it from size to time. Under a prefix rule the scarce match goes to whoever holds the oldest rolled request. One actor can hold that position by keeping a large early request alive until it expires, then filing another.

Which allocation is better is an owner decision, not a fix. The insolvency is fixed by the denominator alone. Over-asking stays the open item it already was (`§19.2`, `§21.4`).

### FLOW-02 — Confirmed core, corrected severity (High), corrected scope, simpler fix

**Confirmed core.** Step 8d books each request's share of the match only "when it is next touched" (L1118). RB-22 requires the queue to report every change of an owner's queued shares to the exclusion ledger before it happens (L1477). The two contradict. If a lending adapter is revoked after a match and before both owners touch their requests, the ledger can credit the matched shares to the redeemer who already left. The depositor who bought them gets no recovery. This is the most important finding in the review.

**Corrected scope.** The "multi-round overwrite" half assumes the queue keeps one slot for `S` and the fractions. The design does not say that. Each round is its own record. The real gap is narrower: a redemption request never expires (D25), so resolving it round by round is unbounded. It needs running per-side accumulators, as Pass 2 recommends. Deposits roll at most `maxRoll` rounds, so per-round hold and freeze records for them stay bounded.

**Simpler fix than a cohort-aware ledger.** The ledger already works lazily. It reads an owner's balance at the first checkpoint after an exclusion opens, or else the current balance (`10-recovery-and-accounting.md` of review 0.7.0). It is correct if two things hold:

1. The queue's view of each owner's queued shares (`queuedSharesOf`) resolves every booked match, from the running accumulators, before any touch.
2. No match happens while an exclusion is open. The design already requires this: an excluded lending asset stops deposits, and a stop means no match (L1085, RB-28 L1531).

With both, an owner's balance cannot change through a match between the exclusion and the owner's next checkpoint. The redeemer's later checkpoint reads zero and the depositor's reads the matched shares. A cohort-aware ledger, Pass 2's alternative, also works but changes a contract the design otherwise keeps.

The same rule covers the escrow released at a wind-down, which the queue still holds and still attributes to its owner until withdrawn.

> **Erratum (2026-11-14, found while writing the fix into the design).** The two conditions above are not enough. An exclusion's claims stay open after the exclusion itself ends. Matches then resume. An owner who has not been checkpointed since the exclusion opened can then be read at a balance that a later match changed. The ledger must read each owner's queued shares as they stood when the exclusion opened: it stores the queue's match indexes at that moment and reads positions at them. That is the index-aware ledger that Pass 2 recommended, and Pass 2 was right to ask for it. The design adopts it (`proposal.md` §5.11.4, D32, RB-22, §22.3).

### FLOW-03, OPS-02, SAFE-02 (part 2) — Merged into one root cause, R1 (High)

All three are the same defect: the emergency key's `pauseDeposits` is the only fast protection for depositors who are locked after a cutoff, and the cooldown of RB-32 can switch it off.

- FLOW-03 and OPS-02 show it for the wind-down notice of D29.
- SAFE-02 part 2 shows it for a lending venue whose trouble becomes known after the cutoff.
- New finding P3-01 (§3) shows a third trigger.

**Defeated part of the fixes.** Every fix Pass 2 offers for the wind-down runs through the timelock. A Safe pause of deposits, or a `windDownPending` state set by the Safe, executes after the same delay as `shutdown`. It protects nobody during the notice. Raising `maxPause` above `timelockDelay + epochLength` helps only when the key can still pause, which is exactly what the cooldown prevents.

**Fix that works.** Choose one, as an owner decision:

- **(a) Recommended.** `pauseDeposits` keeps its self-ending (D29) but has no cooldown. A compromised key can then hold deposits stopped until the Safe revokes it. That only delays: depositors can cancel, and redeemers settle net through the pools and pay pool costs instead of matching. The cooldown stays on `pauseQueue` and `pauseRebalance`.
- **(b)** The Safe gets a direct deposit stop that does not go through the timelock. That is a delay-only power, but it departs from the rule that the Safe acts only through the timelock, and it needs its own role under DEP-03.

### SAFE-02 — Corrected (merged into R1 for its valid part)

The valid part is R1. The rest:

- **Defeated: "asymmetric forced matching".** A depositor loses the same amount whether matched or minted. Matched, they buy existing shares at `S`. Minted, they buy a pro-rata slice that includes the impaired venue at face. The match changes who receives the depositor's money, not what the depositor loses. The residual is the one `§5.11.4` already records (L1100). What hurts the depositor is the lock after the cutoff, which is R1.
- **Defeated fix: a hot-key per-venue exclusion.** Excluding an adapter removes it from NAV and opens recovery (ADP-2, `smart-contract-invariants.md` L276). That moves value between holders over time. `v0.8.0-onevault` deliberately limits the hot key to delays (`§5.6`). Option (a) of R1 gives the needed protection without it.
- **Defeated fix: "route deposits away from the illiquid venue".** That breaks the pro-rata purchase that keeps holders safe by construction (`§5.9.1`, RB-13).

### SAFE-08 — Confirmed (High); the single home of the D30 gap

Confirmed. The delisted-slice claim of D30 is one sentence (`§4.5` rule 5, E42). Nothing says those claims leave `heldBalance`, NAV, the caps or the proportion check. Nothing says how each keeper sale's USDC is split. The eng plan says `sellForFlow` is unchanged (eng plan L444) while D30 changes it. The interaction of `step()` with open lending claims (RB-21, "neither is paid first") is also unspecified. ARCH-03 and ARCH-05 repeat this gap. It is counted once, here.

### ARCH-03 — Corrected to Medium (residual after dedup)

Its D30 part is SAFE-08. Its RB-22 part is FLOW-02. What remains is the EIP-170 headroom and a stale `§6.1`. `RobotMoneyFund` at 23,237 B and `FundAdminLib` at 23,406 B leave about 1.2 to 1.3 KB. Step 3f adds to both. The plan already makes a size build its first work package (eng plan §8.4, step 1). The risk is real and tracked. Medium.

### ARCH-05 — Corrected to Medium

Its D30 part is SAFE-08. The four undefined parameters are already recorded open (`§21.4`). A dead feed halts every settlement until the Safe acts through the timelock. That is the stuck-fund case the owner accepted under D24. The design should say so for this trigger in plain words. Medium.

### FLOW-04 — Corrected to Medium

- **Confirmed part.** "When the stop ends" (`§5.11.3` item 8) is undefined for the two round-time causes: a venue that cannot pay and a pool fee the band cannot pay. Fix: the round records "deposits stopped" at its first call. A deposit kept out by that round may cancel until the close of the epoch then open.
- **Corrected part.** The proof that the continuation rule is dead code holds only for a full-length `pauseDeposits`. The same rule serves the four other causes, and the two round-time causes end within a round. When a deposit does expire during a pause, its owner withdraws the USDC and loses nothing. That half is Low.

### SAFE-01 — Corrected to Medium, with a corrected fix

- **Confirmed part.** RB-30 bans steps from an epoch's close until its round ends (L1537). A paused or blocked queue rolls one round into the next with no gap. Steps then stop for as long as settlement does. The rebalancer becomes hostage to queue liveness.
- **Confirmed part.** Five places still say "settlement window" (`proposal.md` L1258, L1275, eng plan L437, L483, L535) where RB-30 means the whole round.
- **Corrected severity.** No value moves. A plan and a delisting sale are delayed for as long as the queue is blocked. A blocked queue from a feed failure also blocks steps through their own feed checks. Medium.
- **Defeated part of the fix.** "Allow `step()` after a failed `settle()` check" cannot be read from state: a failed check reverts and records nothing.
- **Fix that works.** Invert the rule. The first `settle` call of a round requires that no step ran in the `settleWindow` before it. Steps are free at every other time, including during a pause. The keeper, who runs both, schedules around it. Net calls after the first keep their own per-swap limits, so a step that moves a pool under them can only make a net call fail.

### OPS-01 — Corrected to Medium

- **Defeated: the "contradiction".** A multisig is one address. "One keeper" (DEP-03) and "preferably a multisig" (D20) agree.
- **Confirmed: the replacement delay.** Replacing a lost or broken keeper is a grant of `KEEPER_ROLE` through the timelock, at least 48 hours. During that time nothing settles and no request can leave after its cutoff. The owner accepted that liveness rests on the keeper (D20), but not this delay.
- **Fix adopted.** Make the single `KEEPER_ROLE` holder a team-controlled smart account with rotatable bot keys, as Pass 2 recommends. Bot keys then rotate without the timelock. DEP-03's read-back must then check that account's configuration too.

### OPS-04 — Corrected to Medium

- **Corrected: the fee-hike strand.** The scenario needs a pool whose fee can change. The fixture's launch pools for wETH and cbBTC are Uniswap V3 (`proposal.md` L1633), whose fee is fixed per pool. It stands for any asset on a pool with an adjustable fee, which the asset diagram allows through the Aerodrome adapter (L130). Rule 6 re-reads the fee each round, so deposits stop safely. Net redemptions on that pool then fail their sale limit until the Safe acts. Medium, for future assets.
- **Caution on its fix.** Turning the failing slice into a D30-style claim builds on the mechanism that SAFE-08 shows is unspecified. Specify D30 first.
- **Merged.** Its role-exclusivity part is ARCH-08. Its gating part is already required by `§5.11.9` ("no step 3f gate is scored until both are fixed").

---

## 3. New findings

### P3-01 — High (root R1): an adapter revoke has the same public-notice shape as a wind-down

Revoking a lending adapter goes through the timelock, so it is public for the delay before it executes. When it executes, the venue leaves NAV (ADP-2) and deposits stop (RB-28). Before it executes, nothing stops:

- redeemers who read the schedule match out at the venue's face value;
- depositors locked before the schedule buy at face and cannot cancel;
- net deposits supply new USDC into the venue being removed, pro rata.

A revoke is most likely exactly when a venue is in trouble. The wind-down pairing rule of D29 covers `shutdown` only. **Fix:** extend the rule to every scheduled adapter revoke, and give it a lever that works, which is R1.

### P3-02 — Medium: Pass 2's fixes for FLOW-05 and SAFE-01 must be adopted together

FLOW-05 asks that a round stay open until the next epoch closes, so the keeper can retry a failed net call. Under RB-30 as written, a round that lasts until the next epoch closes bans steps for the whole epoch. Adopted alone, FLOW-05 stops the rebalancer whenever any request is locked. It is safe only with the inverted rule of SAFE-01 above.

---

## 4. Other dispositions

| ID | Pass 2 | Pass 3 | Reason |
| --- | --- | --- | --- |
| ARCH-01 | Medium | Low, confirmed | Missing baseline captions and forward links. Wording only. |
| ARCH-02 | Medium | Medium, confirmed | The hold is still "one day" in `§1` L61 and `§9` L1612. That misleads a reader of the summary. |
| ARCH-04 | Defeated | Defeated, agreed | |
| ARCH-06 | Medium | Low, confirmed | ADR-0004 L218 still says "single Safe signer can cancel", against its own amendment. The amendment governs. |
| ARCH-07 | Low | Low, agreed | |
| ARCH-08 | Medium | Medium, confirmed | Internal roles need the same exclusivity read-back. Absorbs OPS-04's role part. |
| ARCH-09 | Low | Low, agreed | G6 is not run. |
| FLOW-05 | Medium | Medium, confirmed | Adopt only with SAFE-01's corrected fix (P3-02). |
| FLOW-06 | Medium | Low, corrected | Share dust is rounding units. Burning it is cleaner, but the amount is dust. |
| FLOW-07 | Medium | Medium, confirmed | "Blend the price per side" is still in eng plan L435 and L530. It instructs implementers wrongly. |
| FLOW-08 | Medium | Medium, confirmed | The last-block cancel was already open in `§21.2`. |
| FLOW-09 | Defeated | Defeated, agreed | |
| FLOW-10 | Low | Low, confirmed | PRD amendment row 1 says "after the next settlement" and "48 hours". The design says "when that round ends" and `maxRoll` epochs. |
| SAFE-03 | Medium | Low, corrected | Defeated part: there is no separate TWAP window. Check 3 takes its slices from the last `settleWindow` (L721), so `settleWindow ≥ TWAP window` is an identity. The `§5.9.5` phrase "12 of 5 min each" invites the misreading and should say "slice length = `settleWindow / slices`". Surviving part: no weight cap on basket assets, an open owner item (`§21.4`). |
| SAFE-04 | Defeated | Defeated, agreed | |
| SAFE-05 | Medium | Low, corrected | Scenario B is already fixed and tested: R-F1 masks an asset whose depth cap is below `minStepUsdc` (`proposal.md` L2159). Scenario A needs an over-weight that five sub-100-USDC legs cannot clear, which needs a fund under about 100k USDC. It matters for a rehearsal only. |
| SAFE-06 | Low/Medium | Low, corrected | Wording gaps in `§5.3` and `§5.5`. The built rebalancer was measured over 10,620 step attempts (`§14`), so the prose, not the behaviour, is in question. |
| SAFE-07 | Medium | Low, corrected | A step whose limit cannot be met because feed and TWAP disagree is skipped. That is the stricter-price rule of `§5.10` working as meant. Pass 2's fix, `maxStepSlippageBps > refBandBps + fee + margin`, loosens the step's protection. The doc should state the relation, not change it. |
| SAFE-09 | Medium | Medium, confirmed | Already recorded open (`§19.2`, "a lending rate that jumps"). |
| SAFE-10 | Low | Low, corrected | No harm shown. The share-price breaker guards flows. A step has its own cost budget and feed checks. The doc should say the omission is deliberate. |
| OPS-03 | Medium | Medium | Not re-checked. |
| OPS-05 | Low | Low, agreed | |
| OPS-06 | Medium | Medium, confirmed | Already recorded open (`§20.4`, D8). |
| OPS-07 | Low | Low, agreed | |
| OPS-08 | Low | Low | Not re-checked. |

---

## 5. Root causes

Pass 2 counted 10 High findings. They describe four distinct problems. The pause cooldown appears three times. The delisted-slice gap appears three times.

| Root | Severity | Findings | One-line fix |
| --- | --- | --- | --- |
| R1. The only fast protection for locked depositors can be switched off | High | FLOW-03, OPS-02, SAFE-02, P3-01 | No cooldown on `pauseDeposits`; pair every wind-down and adapter revoke with it |
| R2. Lazy match booking against the loss-recovery ledger | High | FLOW-02 | Per-side match indexes; the ledger stores them when an exclusion opens and reads positions at them (see the erratum in §2) |
| R3. Match fraction uses capped totals | High | FLOW-01 | Divide by the uncapped locked totals |
| R4. Delisted-slice and lending-claim accounting unspecified | High | SAFE-08 (ARCH-03, ARCH-05 parts) | Specify claim units, NAV exclusion, proceeds split and `step()` rules |
| R5. Steps tied to queue liveness and round length | Medium | SAFE-01, FLOW-05, P3-02 | First call of a round requires no step in the prior `settleWindow`; steps free otherwise |
| R6. Keeper replacement takes the timelock | Medium | OPS-01 | Keeper smart account with rotatable bot keys |
| R7. Deposit-stop lifecycle undefined for round-time causes | Medium | FLOW-04 | Round records the stop at its first call |
| R8. Size headroom | Medium | ARCH-03 residual | Size build first, as planned |
| R9. Role exclusivity read-back incomplete | Medium | ARCH-08, OPS-04 part | Extend E47 to internal roles and the keeper account |
| R10. Pools with adjustable fees | Medium | OPS-04 residual | Specify D30 first, then reuse it for a failing pool |

---

## 6. Method notes on Pass 2

1. **Built behaviour was graded from prose.** SAFE-05, SAFE-06 and SAFE-07 reason about the rebalancer, which is built and measured. The evidence log already answers part of each (`§14`). Findings about built behaviour should cite the log, not only the design text.
2. **Fixes were not checked against owner decisions.** The FIFO prefix reverses D27. The hot-key exclusion reverses the `v0.8.0-onevault` role split. Every wind-down fix ran through the timelock it was meant to get ahead of.
3. **Fixes were not checked against each other.** FLOW-05 and SAFE-01 interact (P3-02).
4. **Duplicates inflated the count.** The executive summary should index root causes, not IDs.

---

## 7. Verdict

> **Update, 2026-11-14.** The design has since been revised against this review. `one-vault-rebalancer-proposal.md` §22 maps each root cause to the change that answers it and lists the fixes it did not take. Nothing there is built or tested.

The core of step 3f survives three reviews: the whole match booked once at the TWAP NAV, the pro-rata net trade, the cutoff, and the Safe-only wind-down. No finding shows it unsound.

The spec still has four High defects (R1 to R4). Each is a contained spec edit. Implementation of `v0.9.0-onevault` should wait until they are written into the design, with owner decisions on R1 (which lever) and FLOW-01 (pro rata by size or by time).
