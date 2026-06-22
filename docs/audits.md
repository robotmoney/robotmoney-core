<!--
  Canonical: docs/technical/security-model.md §9 / §14
  Feature work: issue #1010 (Security disclosure ledger phase)

  DEV-SCOUT STUB (issue #1011) — PLACEHOLDER SCAFFOLD, NOT THE REAL LEDGER.
  This file establishes the mandated section seams so #1010 can backfill the
  real audit-scope ledger and finding register additively. Bodies are TBD on
  purpose; the structural check scripts/check-audit-ledger.sh asserts only the
  presence of these headings in the scout form.

  security-model.md mandates this file (it has never existed in git history;
  tracking issues #645/#643 were closed-as-done anyway — see SECURITY-003 in
  docs/code-reviews/gap-analysis-20260607.md). DO NOT delete a section heading
  without updating scripts/check-audit-ledger.sh in lockstep.
-->

# Robot Money — Audit Ledger

> Canonical requirements: `docs/technical/security-model.md` §9 (finding
> disposition) and §14 (audit-scope ledger, finding register, cross-reference).
> This document is the institutional-memory artifact those sections mandate.
>
> **Status: dev-scout placeholder (issue #1011).** Section headings are present;
> real rows are backfilled by issue #1010.

## Audit-scope ledger

<!--
  §14 row "Selectively audited surface":
    "An audit-scope ledger must be maintained in docs/audits.md mapping every
     contract to its audit report(s). No contract may ship to production
     without a completed audit or an explicit documented exception approved by
     the team."

  #1010 TODO: one row per contract under contracts/. Columns:
    | Contract | Audit report(s) | Status | Exception (if any) |
  Source the contract set from contracts/ at the repo root.
-->

| Contract | Audit report(s) | Status | Exception (if any) |
|---|---|---|---|
| _TBD — #1010 backfills one row per contract under `contracts/`_ | | | |

## Finding register

<!--
  §14 row "Pattern repetition across deployments":
    "Every audit finding must be cross-referenced against all contracts in the
     codebase, not only the audited one. The finding register in docs/audits.md
     must include a 'checked against' field for each finding."

  #1010 TODO: one row per finding. The "Disposition" column must be one of
    fixed | accepted-with-rationale | dismissed-with-rationale (§9). The
    "Checked against" column is mandated by §14. Seed rows from the external
    review snapshots under docs/code-reviews/*.md.
-->

| Finding ID | Source | Severity | Disposition | Checked against | Rationale |
|---|---|---|---|---|---|
| _TBD — #1010 backfills from `docs/code-reviews/*.md`_ | | | | | |

## Finding-disposition log

<!--
  §9 row "Dismissed audit finding later exploited (Venus-class)":
    "Every audit finding must be logged in docs/audits.md with a disposition:
     fixed, accepted-with-rationale, or dismissed-with-rationale. Dismissed
     findings must be reviewed before any major change that touches the
     relevant code path."

  §14 row "Near-miss dismissal":
    "Any finding that is dismissed rather than fixed must be reviewed by a
     second team member and logged with an explicit rationale. Dismissed
     findings must be revisited before any major change to the relevant code
     path."

  #1010 TODO: for each dismissed-with-rationale finding, record the dismissal
  rationale, the second-reviewer sign-off, and the code path to revisit before
  a major change.
-->

| Finding ID | Disposition | Second reviewer | Revisit-before path |
|---|---|---|---|
| _TBD — #1010 backfills dismissed/accepted findings_ | | | |
