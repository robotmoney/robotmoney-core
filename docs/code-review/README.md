# Code-review & audit snapshots

This directory holds point-in-time **code-review, audit, and security-scan
snapshots** — both internal (Claude / Codex agent runs) and external (vendor
audits and automated scanners). Each file is an immutable record of what a given
reviewer found at a given commit; dispositions are tracked separately in
[`../audits.md`](../audits.md) (the Audit Ledger).

## Filename pattern

```
YYYYMMDD-code-review-<vendor>.md
```

- **`YYYYMMDD`** — the review date (sortable; newest at the bottom of an `ls`).
- **`code-review`** — fixed literal, so every snapshot groups together.
- **`<vendor>`** — who produced the review:

| Origin | `<vendor>` form | Examples |
|---|---|---|
| **Internal** (an agent/tool we ran) | `internal-<tool>[-<model>]` | `internal-claude`, `internal-claude-sonnet-4-6`, `internal-codex-gpt-5` |
| **External** (third-party firm/scanner) | `<firm>[-<product>]` | `pekshield`, `testmachine-azimuth` |

- **`<model>`** is included when known (e.g. `sonnet-4-6`, `gpt-5`); omit it for
  historical docs where the authoring model was not recorded.
- An optional trailing **descriptor** disambiguates same-date/same-vendor files
  or marks a non-standard artifact type, e.g.
  `…-internal-claude-scan-verification.md` (a verification of an external scan),
  `…-internal-claude-gap-analysis.md`.

## The `.json` companion and CI enforcement (issue #1240)

`YYYYMMDD-code-review-<vendor>.json` is an optional machine-readable
companion to the `.md` of the same name, first landed alongside
`20260728-code-review-internal-kimi.{md,json}` by PR #1197. Its
`findings[]` entries are the source of truth for a severity's count and id
set; the `.md`'s `#### SEC-<S>-NNN` sections, Severity Summary table, and
(when present) `-verification.md` verdicts must all agree with it.

`.github/scripts/check_code_review_artifacts.py`, wired into the
`doc-validators` job of `suite-13-doc-checks.yml`, enforces this
automatically on every PR (that workflow carries no `paths:` filter, so a
docs-only PR is checked too):

1. The `.json` parses, and every `findings[]` entry has a non-empty `id`,
   `severity`, and `classification`.
2. Per severity that renders as `#### SEC-<S>-NNN` sections (critical/high/
   medium), the section count in the `.md` equals the `.json` entry count
   for that severity.
3. The Severity Summary table's `Count` column matches: the section count
   for a `#### SEC-<S>-NNN` severity, or the row count of the
   Low-Severity Findings table's `L-` rows for `Low`.
4. Each `Key areas` cell holds exactly `Count` comma-separated phrases, and
   no phrase (verbatim) appears under more than one severity row.
5. `SEC-<S>-NNN` / `L-NNN` ids are dense and gapless from `001`.
6. Every `SEC-<S>-NNN` / `L-NNN` id referenced anywhere else in the `.md`
   (e.g. "Documentation Changes Required") resolves to a real section/row.
7. When a `-verification.md` exists: every `.json` id appears in it exactly
   once, each `## <SEVERITY> SEVERITY — ...` header's counts match its own
   `### ` subsections, and the totals match the doc's Verdict Summary table.

**Scope decision:** these checks only run against a `<stem>.md` when a
sibling `<stem>.json` exists. Every snapshot older than 20260728 predates
the `.json` convention and the `#### SEC-<S>-NNN` / Severity Summary format
entirely (free-form finding headings, no machine-readable companion) —
checking them against a convention they never claimed to follow would be
noise, not signal. A new dated snapshot that ships a `.json` companion is
expected to satisfy all seven checks; a historical snapshot is never
rewritten to satisfy them (immutable point-in-time record) — if one someday
needs an exemption, it is added to the checker script as an explicit, dated
allowlist entry with a comment, never by weakening a rule.

## Conventions

- **Internal vs external:** "internal" means a review *we* commissioned/ran with
  an AI tool (Claude, Codex), regardless of any persona the tool adopted.
  "External" means a third party's own report (audit firm or automated scanner).
- **External vendors:** a report containing **Chinese-language text** is a
  **PekShield** audit (`pekshield`). Name other firms/scanners by their product
  (e.g. `testmachine-azimuth`).
- **Verifications of external reports** are still authored by the internal tool,
  so they take an `internal-<tool>` vendor with a `-…-verification` descriptor —
  the external source they verify is named in the document's own header/scope.
- **Don't rename or delete a landed snapshot lightly.** These paths are cited as
  `Canonical:` pointers from Solidity/Rust/SQL source, CI scripts
  (`.github/scripts/check_no_passthrough_adapter.py`,
  `scripts/check-seam-map-drift.sh`), and the `../audits.md` ledger. A rename
  must update every reference in the same change.
