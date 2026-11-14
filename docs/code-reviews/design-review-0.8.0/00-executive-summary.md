# Design Review 0.8.0 — Executive Summary (Final Draft)

**Target branch:** `docs/onevault-netted-forward-priced-flows` (design text at commit `decef7c99`)
**Scope:** Design documents only. No implementation code.
**Status:** Final draft. Pass 3 critique (`06`) applied to the Pass 2 review (`01` to `05`).
**Date:** 2026-11-14

---

> **Update, 2026-11-14.** The design has been revised against this review. `docs/technical/one-vault-rebalancer-proposal.md` §22 maps each root cause below to the change that answers it. One fix in this review was corrected on the way: see the erratum in `06` §2.

## 1. Verdict

**The core of step 3f is sound. Implementation of `v0.9.0-onevault` should wait for four spec edits and two owner decisions.**

What survives three reviews:

- the whole match, booked once at the fund's TWAP NAV, with the feeds as guards;
- the net remainder traded as a pro-rata slice by quantity;
- the cancel cutoff and forward pricing;
- the Safe-only, timelocked wind-down.

No finding shows any of these unsound. Pass 2 rated two findings Critical. Both are real. Both have contained fixes, so both are High here.

What must change before building:

| Root | Problem | Fix |
| --- | --- | --- |
| R1 | The only fast protection for locked depositors, the emergency key's `pauseDeposits`, can be switched off by its cooldown. A scheduled wind-down or adapter revoke is public for 48 hours. | No cooldown on `pauseDeposits`. Pair every scheduled wind-down and adapter revoke with it. |
| R2 | The match is booked lazily, but the loss-recovery ledger needs every change of ownership as it happens. A redeemer who left can collect the recovery on shares they sold. | Per-side match indexes. Ownership changes at the booking. The ledger stores the indexes when an exclusion opens and reads each owner's position at them. (Corrected by the erratum in `06` §2.) |
| R3 | The match fraction divides by totals that were capped. With more queued than the cap, the queue books more shares than are escrowed. | Divide by the uncapped locked totals. |
| R4 | Claims on a delisted asset's slice, and the rebalancer's handling of lending claims, are one sentence each. | Specify claim units, exclusion from NAV and caps, the split of sale proceeds, and the rules for `step()`. |

---

## 2. Scorecard

| Pillar | Rating | Why |
| --- | --- | --- |
| Coherent | Amber | Stale text in five places (the hold, "blend the price", "settlement window"), the D30 claims underspecified, ADR-0004 contradicts its own amendment. |
| Correct | Red | R2 and R3: the match as written misbooks shares and misattributes recovery. Both are spec edits. |
| Safe | Red | R1: locked depositors can lose their only protection during a public 48-hour notice. R4: delisting can double-count. |
| Reliable to operate | Amber | Replacing the keeper takes the timelock (R6). Steps stop whenever the queue does (R5). Both have known fixes. |
| Honest to customers | Amber | No slippage estimate, last-block cancel, PRD amendments still open or misworded. |

---

## 3. Root causes

Pass 2 counted 10 High findings. They are four problems. The pause cooldown appeared three times, and the delisted-slice gap appeared three times. `06` §5 has the reasoning.

| Root | Severity | Findings | One-line fix |
| --- | --- | --- | --- |
| R1 | High | FLOW-03, OPS-02, SAFE-02, P3-01 | No cooldown on `pauseDeposits`; pair every wind-down and adapter revoke with it |
| R2 | High | FLOW-02 | Per-side match indexes; the ledger reads positions at the indexes stored when an exclusion opens |
| R3 | High | FLOW-01 | Divide by the uncapped locked totals |
| R4 | High | SAFE-08 (with ARCH-03 and ARCH-05 parts) | Specify D30 claim units, NAV exclusion, proceeds split and `step()` rules |
| R5 | Medium | SAFE-01, FLOW-05, P3-02 | The first call of a round requires no step in the prior `settleWindow`; steps are free otherwise |
| R6 | Medium | OPS-01 | Keeper is a team smart account with rotatable bot keys |
| R7 | Medium | FLOW-04 | The round records "deposits stopped" at its first call |
| R8 | Medium | ARCH-03 residual | Size build first, as the plan already says |
| R9 | Medium | ARCH-08, OPS-04 part | Extend the role read-back (E47) to internal roles and the keeper account |
| R10 | Medium | OPS-04 residual | Specify D30 first, then reuse it for a pool whose fee can change |

---

## 4. Findings index

Pass 2 ratings are kept for the record. The Pass 3 rating governs. "Not re-checked" means Pass 3 did not test the claim and kept the Pass 2 rating.

| ID | Pass 2 | Pass 3 | Disposition | Root | Summary |
| --- | --- | --- | --- | --- | --- |
| FLOW-01 | Critical | **High** | Confirmed; fix corrected | R3 | Match fraction uses capped totals and over-books shares. Fix is the denominator. The FIFO-prefix fix reverses D27 and does not close over-asking. |
| FLOW-02 | Critical | **High** | Confirmed; scope corrected | R2 | Lazy booking against RB-22 misattributes recovery. "Multi-round overwrite" assumed one storage slot the design does not have. |
| FLOW-03 | High | **High** | Merged | R1 | Cooldown can block the wind-down pairing. Its timelocked fixes protect nobody during the notice. |
| FLOW-04 | High | Medium | Corrected | R7 | Stop lifecycle undefined for round-time causes. The "dead code" half is harmless and Low. |
| FLOW-05 | Medium | Medium | Confirmed | R5 | A round ends on one failed net call. Adopt only with SAFE-01's fix. |
| FLOW-06 | Medium | Low | Corrected | | Share dust is rounding units. |
| FLOW-07 | Medium | Medium | Confirmed | | "Blend the price per side" still in eng plan L435 and L530. |
| FLOW-08 | Medium | Medium | Confirmed | | No slippage estimate, last-block cancel, unamended PRD promises. |
| FLOW-09 | Defeated | Defeated | Agreed | | |
| FLOW-10 | Low | Low | Confirmed | | PRD amendment row 1 says "after the next settlement" and "48 hours". |
| SAFE-01 | High | Medium | Corrected | R5 | Steps stop whenever the queue is blocked. No value moves. Its fix cannot read a reverted check. |
| SAFE-02 | High | **High** | Corrected; merged | R1 | Valid core is the lock after the cutoff with a switchable pause. "Asymmetric matching" defeated: a depositor loses the same matched or minted. Hot-key exclusion and routing-away fixes defeated. |
| SAFE-03 | Medium | Low | Corrected | | The `settleWindow ≥ TWAP window` bound is an identity. No basket weight cap stays an open owner item. |
| SAFE-04 | Defeated | Defeated | Agreed | | |
| SAFE-05 | Medium | Low | Corrected | | Scenario B already fixed (R-F1). Scenario A needs a fund under about 100k USDC. |
| SAFE-06 | Low/Medium | Low | Corrected | | Prose gaps about measured, built behaviour. |
| SAFE-07 | Medium | Low | Corrected | | A skip when feed and TWAP disagree is the stricter-price rule working. The proposed fix loosens it. |
| SAFE-08 | High | **High** | Confirmed | R4 | D30 slice claims and `step()` against lending claims unspecified. |
| SAFE-09 | Medium | Medium | Confirmed | | Already recorded open in `§19.2`. |
| SAFE-10 | Low | Low | Corrected | | No harm shown. Say the omission is deliberate. |
| OPS-01 | High | Medium | Corrected | R6 | No contradiction: a multisig is one address. The 48-hour replacement delay is real. |
| OPS-02 | High | **High** | Merged | R1 | Same as FLOW-03. |
| OPS-03 | Medium | Medium | Not re-checked | | |
| OPS-04 | High | Medium | Corrected | R9, R10 | Launch pools are Uniswap V3, whose fee is fixed. Stands for pools with adjustable fees. |
| OPS-05 | Low | Low | Agreed | | |
| OPS-06 | Medium | Medium | Confirmed | | Already recorded open in `§20.4`. |
| OPS-07 | Low | Low | Agreed | | |
| OPS-08 | Low | Low | Not re-checked | | |
| ARCH-01 | Medium | Low | Confirmed | | Captions and forward links. |
| ARCH-02 | Medium | Medium | Confirmed | | The hold is still "one day" in `§1` L61 and `§9` L1612. |
| ARCH-03 | High | Medium | Corrected | R8 | Its D30 and RB-22 parts are counted under SAFE-08 and FLOW-02. Residual is size headroom. |
| ARCH-04 | Defeated | Defeated | Agreed | | |
| ARCH-05 | High | Medium | Corrected | | D30 part is SAFE-08. Parameters already open. Dead-feed halt is the stuck-fund case accepted under D24. |
| ARCH-06 | Medium | Low | Confirmed | | ADR-0004 L218 against its own amendment. |
| ARCH-07 | Low | Low | Agreed | | |
| ARCH-08 | Medium | Medium | Confirmed | R9 | Internal roles need the exclusivity read-back. |
| ARCH-09 | Low | Low | Agreed | | G6 not run. |
| P3-01 | | **High** | New | R1 | A scheduled adapter revoke is public for 48 hours. Redeemers leave at face, locked depositors buy at face, net deposits fund the venue being removed. |
| P3-02 | | Medium | New | R5 | FLOW-05's fix, adopted alone, stops the rebalancer whenever any request is locked. |

**Totals:** 0 Critical, 7 High, 15 Medium, 14 Low, 3 Defeated, 39 IDs.

---

## 5. Remediation

### Before implementation: spec edits

1. **R3.** Fix the denominators of step 8b. Add a conservation invariant for the match.
2. **R2.** Specify per-side match indexes. Make `queuedSharesOf` resolve every booked match. State in RB-22 that a match changes ownership at booking, and that the ledger stores the indexes when an exclusion opens and reads positions at them.
3. **R1.** Remove the cooldown from `pauseDeposits` (or the alternative in decision 1). Extend the D29 pairing rule to every scheduled adapter revoke.
4. **R4.** Specify D30 claim units, their exclusion from `heldBalance`, NAV, the caps and the proportion check, the split of each sale's proceeds, and what `step()` does with venues that carry lending claims. Fix eng plan §8.2, which says `sellForFlow` is unchanged.
5. **R5.** Replace RB-30 with the inverted rule. Then let a round stay open for retries (FLOW-05).
6. **R7.** Define the stop for round-time causes as recorded at the round's first call.

### Before release

7. **R6.** Make the keeper a team smart account with rotatable bot keys. Add its configuration to the DEP-03 read-back.
8. **R8.** Run the size build first, inclusive of the D30 claims.
9. **R9.** Extend E47 to `FLOW_ROLE`, `REBALANCER_ROLE`, `GOVERNANCE_ROLE`, `TARGET_SETTER_ROLE`, `RECEIPT_SUBMITTER_ROLE` and upgrade authority.
10. **R10.** For any asset on a pool with an adjustable fee, reuse the D30 claim for a pool that fails its band.

### Text

11. Fix the stale hold (ARCH-02), "blend the price" (FLOW-07), "settlement window" for RB-30 (SAFE-01), ADR-0004 L218 (ARCH-06), PRD amendment row 1 (FLOW-10) and the slice wording of `§5.9.5` (SAFE-03).

---

## 6. Owner decisions

1. **R1: which lever protects locked depositors?** (a) No cooldown on `pauseDeposits`, recommended. (b) A direct, untimelocked deposit stop for the Safe.
2. **FLOW-01: how is a scarce match shared?** Pro rata by size, as D27 says now, or oldest first. The insolvency is fixed either way. Oldest first reverses D27 and moves over-asking from size to time.
3. **Already open, unchanged:** a weight cap on basket assets, the four undefined step 3f parameters, the last-block cancel, per-asset weight authority (D8), and on-chain binding of a receipt to its target vector.
