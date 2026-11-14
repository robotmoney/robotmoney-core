# Design Review 0.8.0 — One-Vault Netted Forward-Priced Flows

**Target Branch:** `docs/onevault-netted-forward-priced-flows` (commit `decef7c99`)  
**Scope:** Design documents only (`docs/technical/*`, `docs/adr/*`, `docs/code-reviews/0.7.0/*`). All implementation code (`.sol`, `.rs`, `.ts`) was intentionally excluded.  
**Revision Status:** Pass 2 Verified — incorporates expanded accounting/liveness proofs, corrected weighting/timing math, and explicit tracking of defeated Pass-1 findings.  
**Date:** 2026-11-14

---

## Overview

This directory contains the independent, Pass-2-verified design review of the `v0.8.0-onevault` / Step 3f (`v0.9.0-onevault`) single-vault netted forward-priced flows architecture. Across four domain reviews (`01`–`04`) and one cross-cutting synthesis (`05`), **37 finding IDs** were evaluated:

- **34 Active Findings:** **`2 Critical`** (`FLOW-01`, `FLOW-02`), **`10 High`**, **`14 Medium`**, and **`8 Low`** *(including `SAFE-06` rated `Low / Medium`, `ARCH-07` rated `Low (Tracked Open Work)`, and `ARCH-09` rated `Low / Open Question`)*.
- **3 Defeated Findings:** **`ARCH-04`** and **`FLOW-09`** (defeated by explicit ERC-7575 split & 7-row departures disclosure in `§5.9.6`) and **`SAFE-04`** (defeated by explicit owner policy acceptance under `D18`, `D20`, `D24` in `§5.11.7`, `§18.4`, `§19.2`), alongside defeated Pass-1 sub-parts (`ARCH-03` `deSPXA`, `SAFE-06` Part 2 reachability, `SAFE-10` Parts 1 & 3, `FLOW-10` band exposure, and `OPS-01` permissionless `keeperGrace` fallback).
- **6 Compounding Failure Chains:** Documented in [`05-cross-cutting-contradictions-and-gaps.md`](./05-cross-cutting-contradictions-and-gaps.md) and summarized in [`00-executive-summary.md`](./00-executive-summary.md).

Pass 2 verification specifically: (a) expanded critical proofs (`FLOW-01` cap-denominator insolvency + FIFO-prefix solution, `FLOW-02` Step 8d lazy touch vs `RB-22` `ExclusionLedger` misattribution, `FLOW-04` `RB-31` + `RB-32` dead-code continuation proof, `ARCH-03`/`ARCH-05`/`SAFE-08` `D30` delisted-asset slice-claim gaps, `ARCH-08` internal-role `DEP-03` exclusivity gaps, and `OPS-04` `RUN-01` 48h redemption strand); (b) corrected Pass-1 math and scope errors (`SAFE-03` launch-weight skew `4.5 bps` at 5% basket weight & default `settleWindow == TWAP_window`, `SAFE-06` halt reachability, and `v0.8.0-onevault` baseline attribution in `ARCH-01`/`ARCH-02`/`OPS-05`); and (c) preserved explicit disposition records for all defeated findings.

---

## Recommended Reading Order

| Order | File | Purpose & Contents |
| :---: | --- | --- |
| 1 | [`README.md`](./README.md) | Package overview, Pass 2 scope, severity totals, and reading order (this file). |
| 2 | [`00-executive-summary.md`](./00-executive-summary.md) | Overall NO-GO verdict, Pass-2 5-pillar scorecard, defeated/corrected summary, 37-ID findings index (`34 active` / `3 defeated`), top 6 chains, roadmap, and open owner decisions. |
| 3 | [`05-cross-cutting-contradictions-and-gaps.md`](./05-cross-cutting-contradictions-and-gaps.md) | Systemic risk map, defeated findings & corrected Pass-1 claims, deduplicated themes (`T1`–`T7`), 6 compounding failure chains with architectural resolutions, and owner trade-offs. |
| 4 | [`01-architecture-and-coherence.md`](./01-architecture-and-coherence.md) | `ARCH-01`–`09` (`2 High, 4 Medium, 2 Low, 1 Defeated`): `v0.8.0` vs Step 3f baseline scoping, `D30` slice-claim & `RB-19`/`RB-22`/`§8.2` gaps, `ARCH-04` defeated, EIP-170 ceiling, `DEP-03` internal roles, `ADR-0004` & PRD `§5 (L91)`. |
| 5 | [`02-flows-pricing-and-honesty.md`](./02-flows-pricing-and-honesty.md) | `FLOW-01`–`10` (`2 Critical, 2 High, 4 Medium, 1 Low, 1 Defeated`): `FLOW-01` cap insolvency & FIFO prefix, `FLOW-02` lazy accounting & `ExclusionLedger` (`RB-22`) failure, `FLOW-03` `RB-32` deadlock, `FLOW-04` `RB-31`+`RB-32` dead code, `FLOW-09` defeated, and customer honesty. |
| 6 | [`03-rebalancer-economics-and-safety.md`](./03-rebalancer-economics-and-safety.md) | `SAFE-01`–`10` (`3 High, 4 Medium, 1 Low/Med, 1 Low, 1 Defeated`): `RB-30` rollover starvation, `D21` locked-depositor impairment, `SAFE-03` corrected `4.5 bps` math & `settleWindow` bound, `SAFE-04` defeated (`D18`/`D20`/`D24`), `D23`/`D30` claims (`SAFE-08`), and `§7` invariant gaps. |
| 7 | [`04-operations-and-reliability.md`](./04-operations-and-reliability.md) | `OPS-01`–`08` (`3 High, 2 Medium, 3 Low`): `D20` multisig vs `DEP-03` keeper contradiction, `RB-32` wind-down cooldown deadlock, Step 3f `RUN-01` 48h redemption strand (`OPS-04`), 0.7.0 verification gates (`DEP-01`–`03`, `SIM-01`–`02`), and off-chain coupling. |
