# Design Review 0.8.0 — One-Vault Netted Forward-Priced Flows

**Target branch:** `docs/onevault-netted-forward-priced-flows` (design text at commit `decef7c99`)
**Scope:** Design documents only (`docs/technical/*`, `docs/adr/*`, `docs/code-reviews/0.7.0/*`). No implementation code.
**Status:** Final draft, Pass 3. Pass 3 is an adversarial critique of Pass 2. Where they differ, Pass 3 governs.
**Date:** 2026-11-14

---

## Overview

This folder reviews step 3f, the design of `v0.9.0-onevault`, on top of the `v0.8.0-onevault` baseline.

- **Pass 1 and Pass 2** produced 37 finding IDs in four domain chapters (`01` to `04`) and a synthesis (`05`).
- **Pass 3** (`06`) checked those findings against the design text. It confirmed some, corrected the size or fix of others, defeated parts, merged duplicates, and added two findings.

**Final count, 39 IDs:** 0 Critical, 7 High, 15 Medium, 14 Low, 3 Defeated.

The 7 High IDs are four distinct problems (R1 to R4 in `00` §3). Each is a contained edit to the spec.

**Verdict:** the core design is sound. Implementation should wait until R1 to R4 are written into the design, with two owner decisions.

---

## Reading order

| Order | File | Contents |
| :---: | --- | --- |
| 1 | [`00-executive-summary.md`](./00-executive-summary.md) | Final verdict, root causes, the full index with Pass 2 and Pass 3 ratings, remediation and owner decisions. |
| 2 | [`06-pass-3-adversarial-critique.md`](./06-pass-3-adversarial-critique.md) | The reasoning behind every Pass 3 disposition, the two new findings, and method notes. |
| 3 | [`02-flows-pricing-and-honesty.md`](./02-flows-pricing-and-honesty.md) | `FLOW-01` to `FLOW-10`. |
| 4 | [`03-rebalancer-economics-and-safety.md`](./03-rebalancer-economics-and-safety.md) | `SAFE-01` to `SAFE-10`. |
| 5 | [`04-operations-and-reliability.md`](./04-operations-and-reliability.md) | `OPS-01` to `OPS-08`. |
| 6 | [`01-architecture-and-coherence.md`](./01-architecture-and-coherence.md) | `ARCH-01` to `ARCH-09`. |
| 7 | [`05-cross-cutting-contradictions-and-gaps.md`](./05-cross-cutting-contradictions-and-gaps.md) | Pass 2 synthesis and failure chains. Superseded by `00` §3 and `06` §5. Kept as the record. |

Chapters `01` to `05` keep their Pass 2 text. Each finding there carries a **Pass 3** note with its final rating.

The design answered this review on 2026-11-14: `docs/technical/one-vault-rebalancer-proposal.md` §22. One Pass 3 fix was corrected while it was written into the design (erratum in `06` §2).
