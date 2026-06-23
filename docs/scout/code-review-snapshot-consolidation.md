# Code-review Snapshot Consolidation — Dev Scout

> Canonical docs: `docs/code-review/README.md`, `docs/audits.md`
> Phase: Code-review snapshot consolidation
> Scout issue: #1075
> Feature issue: #1045

## 1. Target folder structure at HEAD

`docs/code-review/` already exists and is the single canonical home for
all code-review and audit snapshots. There is **no** `docs/code-reviews/` folder
at HEAD (it does not exist in this branch); the consolidation already happened
at the folder level. All 13 snapshots are present under `docs/code-review/` with
the sortable `YYYYMMDD-code-review-<vendor>.md` naming convention, plus `README.md`.

### Snapshot inventory (all under `docs/code-review/`)

| File | Vendor class |
|---|---|
| `20260508-code-review-internal-claude-sonnet-4-6.md` | internal-claude |
| `20260509-code-review-internal-codex-gpt-5.md` | internal-codex |
| `20260515-code-review-internal-codex.md` | internal-codex |
| `20260518-code-review-internal-codex.md` | internal-codex |
| `20260602-code-review-internal-claude.md` | internal-claude |
| `20260606-code-review-internal-claude.md` | internal-claude |
| `20260607-code-review-internal-claude-gap-analysis.md` | internal-claude |
| `20260609-code-review-internal-claude.md` | internal-claude |
| `20260612-code-review-internal-claude.md` | internal-claude |
| `20260618-code-review-internal-claude.md` | internal-claude |
| `20260619-code-review-internal-claude-scan-verification.md` | internal-claude |
| `20260619-code-review-pekshield.md` | external/pekshield |
| `20260623-code-review-testmachine-azimuth.md` | external/testmachine-azimuth |
| `README.md` | — |

The `README.md` documents the naming convention, internal vs external
classification rules, and the immutability / rename discipline. All filenames
already conform to the YYYYMMDD-code-review-\<vendor\>.md pattern.

## 2. Files targeted for rename in #1045

Issue #1045's scope says "merge docs/code-reviews/ into docs/code-review/ and
rename all 12 snapshots". At HEAD `docs/code-reviews/` does not exist and the
snapshots are already correctly named. #1045 will therefore land as a no-op at
the folder level, but must still:

- Verify no stale references to `docs/code-reviews/` exist anywhere in the tree
  (there are none at HEAD — confirmed by grep).
- Ensure the `docs/code-review/README.md` is present and authoritative (it is).
- Confirm the 2026-06-23 Azimuth scan is present as UNVERIFIED (it is — no
  finding-register row in `docs/audits.md` for AZ-0623 findings yet).

**Risk:** #1045's own description says "14 old basenames" to grep away. At HEAD
all basenames are already in the new format, so the "zero matches" acceptance
criterion should be trivially met. If any branch divergence reintroduces the old
`docs/code-reviews/` path, the existing naming guard will surface it.

## 3. CI guard paths — check_no_passthrough_adapter.py ALLOWLIST_PATHS

File: `.github/scripts/check_no_passthrough_adapter.py` (line 53)

Current `ALLOWLIST_PATHS` set referencing code-review paths:

```python
ALLOWLIST_PATHS = {
    ".github/scripts/check_no_passthrough_adapter.py",
    "docs/technical/testcode-removal-seams.md",
    "docs/code-review/20260607-code-review-internal-claude-gap-analysis.md",
    "docs/code-review/20260609-code-review-internal-claude.md",
    "docs/code-review/20260618-code-review-internal-claude.md",
    "docs/code-review/20260612-code-review-internal-claude.md",
}
```

Four snapshot paths are allowlisted because they quote the banned
passthrough-adapter surface tokens as historical evidence of the removed
implementation (issue #912). These paths are already in the final
`docs/code-review/` prefix — no ALLOWLIST_PATHS update is required by #1045.

**Risk:** if #1045 renames any of these four files, it must update all four
ALLOWLIST_PATHS entries in the same change, or the CI guard will either (a) break
the allowlist exemption — causing false positives — or (b) fail to protect a
legitimately renamed file. The README.md explicitly calls out this constraint.

## 4. Additional Canonical: reference inventory

The following source files carry `Canonical:` pointers to code-review snapshots
that #1045 must keep intact (all paths already in the final naming convention at
HEAD):

### contracts/

| File | Points to |
|---|---|
| `contracts/interfaces/IObservablePool.sol` | `20260618-code-review-internal-claude.md §2` |
| `contracts/lib/TwapTickMath.sol` | `20260618-code-review-internal-claude.md §2` |
| `contracts/lib/BpsMath.sol` | `20260618-code-review-internal-claude.md §1` |
| `contracts/lib/ForeignTokenQuarantine.sol` | `20260618-code-review-internal-claude.md` |
| `contracts/lib/AdminFloorAccessControl.sol` | `20260618-code-review-internal-claude.md` |
| `contracts/test/CustodyInvariantGuard.t.sol` | `20260618-code-review-internal-claude.md` |
| `contracts/test/ConfusedDeputyGuards.t.sol` | `20260602-code-review-internal-claude.md` |
| `contracts/test/TwapTickMath.t.sol` | `20260618-code-review-internal-claude.md §2` |
| `contracts/test/BpsMath.t.sol` | `20260618-code-review-internal-claude.md §1` |

### services/ and testing/

| File | Points to |
|---|---|
| `services/watchdog/src/scan_residual_seams.rs` | `20260619-code-review-internal-claude-scan-verification.md` |
| `services/watchdog/src/scan_remediation_seams.rs` | `20260619-code-review-internal-claude-scan-verification.md` |
| `services/explorer-indexer/migrations/0012_vault_status_events.sql` | `20260619-code-review-internal-claude-scan-verification.md` |
| `services/explorer-indexer/migrations/0013_vote_power_tally.sql` | `20260619-code-review-internal-claude-scan-verification.md` |
| `services/explorer-indexer/tests/account_position_vote_power.rs` | `20260619-code-review-internal-claude-scan-verification.md` |
| `testing/smoke-test/src/fork_manifest.rs` | `20260619-code-review-internal-claude-scan-verification.md` |
| `scripts/check-seam-map-drift.sh` | `20260619-code-review-internal-claude-scan-verification.md` |

### clients/

| File | Points to |
|---|---|
| `clients/dapp/src/components/GovernancePanel.tsx` | `20260619-code-review-internal-claude-scan-verification.md` |
| `clients/rust-payment-client/src/scan_residual_seams.rs` | `20260619-code-review-internal-claude-scan-verification.md` |
| `clients/rust-payment-client/src/scan_remediation_seams.rs` | `20260619-code-review-internal-claude-scan-verification.md` |

### Other CI/scripts

| File | Points to |
|---|---|
| `.github/workflows/suite-22-formal-verification.yml` | `20260619-code-review-pekshield.md` |

All pointers reference paths already in the final `docs/code-review/` prefix.
No path updates are needed by #1045 under the current HEAD state.

## 5. audits.md column ordering

The finding register in `docs/audits.md` column order (as verified by
`scripts/check-audit-ledger.sh`):

```
| Finding ID | Source | Severity | Disposition | Checked against | Remediated by (PR) | Rationale |
```

The `Remediated by (PR)` column is positioned **after** `Checked against`
(column 7), which is the parse assumption hard-coded in `check-audit-ledger.sh`
(disposition = field 5, checked-against = field 6). Issue #1045 must not reorder
these columns.

Issue #1045's acceptance criterion requires every `fixed` row to carry a non-empty
`Remediated by (PR)` cell. At HEAD, the column already exists in the finding
register. The ledger currently maps `AZ-0623` report key to the 2026-06-23
Azimuth scan but carries no finding rows for that scan (UNVERIFIED — intentional
per #1045 scope). The check-audit-ledger.sh script does not assert AZ-0623 rows,
only FS-\* rows.

## 6. Integration risks for #1045

1. **ALLOWLIST_PATHS coupling**: any rename of the four allowlisted snapshot files
   (`20260607-gap-analysis`, `20260609`, `20260612`, `20260618`) must update
   `.github/scripts/check_no_passthrough_adapter.py` in the same commit; failing
   to do so causes the guard to pass incorrectly (missing allowlist) or fail
   (stale path not matched).

2. **check-audit-ledger.sh column sensitivity**: `docs/audits.md` section headings
   and finding-register column headers are asserted by name. Adding, removing, or
   reordering columns requires a corresponding update to the script (and the inline
   comment in `docs/audits.md` that documents the column-position parse rule).

3. **AZ-0623 UNVERIFIED state**: the 2026-06-23 Azimuth scan ships without a
   disposition row in the finding register. Any downstream issue that adds
   disposition rows for AZ-0623 findings must first verify landing status of
   cited remediations against the `dev` branch diff.

4. **scripts/check-seam-map-drift.sh dependency**: this guard asserts that
   `scan_residual_seams.rs` modules across watchdog / explorer-indexer /
   rust-payment-client do not reintroduce present-tense stale-bug wording. Its
   `Canonical:` pointer (`20260619-code-review-internal-claude-scan-verification.md`)
   is the most widely referenced snapshot path in the repo — any rename of this
   file propagates to 9 files plus the drift guard itself.
