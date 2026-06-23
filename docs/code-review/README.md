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
