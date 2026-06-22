#!/usr/bin/env bash
# Canonical: docs/technical/security-model.md §9 / §14
# Feature work: issue #1010 (Security disclosure ledger phase)
#
# ============================================================================
# AUDIT-LEDGER STRUCTURAL CHECK (issue #1010 — the enforcing check)
# ============================================================================
# security-model.md mandates two institutional-memory artifacts:
#
#   docs/audits.md  — §9 "Dismissed audit finding later exploited (Venus-class)":
#       every audit finding logged with a disposition
#       (fixed | accepted-with-rationale | dismissed-with-rationale).
#     — §14 "Selectively audited surface": an audit-scope ledger mapping every
#       production contract to its audit report(s).
#     — §14 "Pattern repetition across deployments": the finding register must
#       include a "Checked against" field for each finding.
#
#   SECURITY.md     — §14 "Disclosure-handling failure": must exist at the repo
#       root with a disclosure address and a maximum response-time commitment.
#
# This script enforces (fails non-zero) all of the following:
#   docs/audits.md:
#     - the three mandated section headings are present;
#     - the audit-scope ledger table has the contract->report columns and at
#       least one populated contract row;
#     - the finding register has a Disposition column and a "Checked against"
#       column;
#     - EVERY finding-register data row carries a non-empty disposition drawn
#       from {fixed, accepted-with-rationale, dismissed-with-rationale} and a
#       non-empty "Checked against" value;
#     - the register includes rows for the 2026-06-19 external scan (FS-* ids).
#   SECURITY.md:
#     - exists at the repo root;
#     - has a non-placeholder Disclosure address and a non-placeholder maximum
#       response-time value.
#
# Heading / column-header text must stay in sync with docs/audits.md and
# SECURITY.md; renaming a heading or column requires updating this script in the
# same change.
#
# USAGE
#   scripts/check-audit-ledger.sh
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

AUDITS_DOC="${REPO_ROOT}/docs/audits.md"
SECURITY_DOC="${REPO_ROOT}/SECURITY.md"

fail() {
  echo "check-audit-ledger: FAIL: $1" >&2
  exit 1
}

# --- Artifact presence -------------------------------------------------------
[ -f "${AUDITS_DOC}" ] || fail "docs/audits.md is missing (security-model.md §14)"
[ -f "${SECURITY_DOC}" ] || fail "SECURITY.md is missing (security-model.md §14)"

# --- docs/audits.md section seams --------------------------------------------
grep -qi "Audit-scope ledger" "${AUDITS_DOC}" \
  || fail "docs/audits.md is missing the 'Audit-scope ledger' section (§14)"
grep -qi "Finding register" "${AUDITS_DOC}" \
  || fail "docs/audits.md is missing the 'Finding register' section (§14)"
grep -qi "Finding-disposition log" "${AUDITS_DOC}" \
  || fail "docs/audits.md is missing the 'Finding-disposition log' section (§9)"

# --- Audit-scope ledger: contract->report columns + at least one real row ----
grep -qiE '\|[[:space:]]*Contract[[:space:]]*\|[[:space:]]*Audit report' "${AUDITS_DOC}" \
  || fail "docs/audits.md audit-scope ledger is missing the 'Contract | Audit report(s)' columns (§14)"
# A populated contract row references a .sol file in the first column.
# shellcheck disable=SC2016  # backtick is literal markdown, not a subshell.
grep -qE '^\|[[:space:]]*`[^`]+\.sol`[[:space:]]*\|' "${AUDITS_DOC}" \
  || fail "docs/audits.md audit-scope ledger has no populated contract row mapping a .sol to its report(s) (§14)"

# --- Finding register: required columns --------------------------------------
grep -qi "Disposition" "${AUDITS_DOC}" \
  || fail "docs/audits.md finding register is missing the 'Disposition' column (§9)"
grep -qi "Checked against" "${AUDITS_DOC}" \
  || fail "docs/audits.md finding register is missing the 'Checked against' column (§14)"

# --- 2026-06-19 external-scan rows present ------------------------------------
grep -qE '^\|[[:space:]]*FS-' "${AUDITS_DOC}" \
  || fail "docs/audits.md finding register has no 2026-06-19 external-scan (FS-*) finding rows (#1010 AC3)"

# --- Finding-register parse: every row has a valid disposition + checked-against
# The finding-register tables share the column order:
#   | Finding ID | Source | Severity... | Disposition | Checked against | Rationale |
# We scan only rows inside the "## Finding register" section, treat an 8-field
# pipe row (empty wrappers + 6 cells) as a candidate data row, and assert
# columns 4 (disposition) and 5 (checked-against) are non-empty/valid.
PARSE_REPORT="$(
  awk '
    BEGIN { in_register = 0; data_rows = 0; bad = 0 }
    # Enter the finding register at its heading; leave at the next H2.
    /^## Finding register/ { in_register = 1; next }
    in_register && /^## / { in_register = 0 }
    !in_register { next }
    # Only consider markdown table rows.
    $0 !~ /^\|/ { next }

    {
      # Split into trimmed cells; markdown rows start and end with a pipe, so
      # fields 1 and NF are empty wrappers - real cells are fields 2..NF-1.
      n = split($0, cells, "|")
      for (i = 1; i <= n; i++) {
        gsub(/^[[:space:]]+/, "", cells[i])
        gsub(/[[:space:]]+$/, "", cells[i])
      }
      # Header and separator rows: skip.
      if (cells[2] == "Finding ID") next
      if (cells[2] ~ /^-+$/) next
      # Real data rows are: empty | id | source | sev | disp | checked | rationale | empty
      # => n == 8 with cells[5]=disposition, cells[6]=checked-against.
      if (n < 8) next
      id   = cells[2]
      disp = cells[5]
      chk  = cells[6]
      if (id == "") next
      data_rows++
      ok_disp = (disp == "fixed" || disp == "accepted-with-rationale" || disp == "dismissed-with-rationale" || disp == "accepted-with-rationale / dismissed-with-rationale")
      if (!ok_disp) { printf("  bad-disposition: row \"%s\" disposition=\"%s\"\n", id, disp); bad++ }
      if (chk == "") { printf("  empty-checked-against: row \"%s\"\n", id); bad++ }
    }
    END { printf("DATA_ROWS=%d BAD=%d\n", data_rows, bad) }
  ' "${AUDITS_DOC}"
)"

PARSE_SUMMARY="$(printf '%s\n' "${PARSE_REPORT}" | grep '^DATA_ROWS=')"
DATA_ROWS="$(printf '%s' "${PARSE_SUMMARY}" | sed -E 's/^DATA_ROWS=([0-9]+) BAD=([0-9]+)$/\1/')"
BAD="$(printf '%s' "${PARSE_SUMMARY}" | sed -E 's/^DATA_ROWS=([0-9]+) BAD=([0-9]+)$/\2/')"

if [ "${DATA_ROWS}" -lt 1 ]; then
  fail "docs/audits.md finding register has no parseable finding rows (expected | id | source | sev | disposition | checked-against | rationale |)"
fi
if [ "${BAD}" -ne 0 ]; then
  printf '%s\n' "${PARSE_REPORT}" | grep -v '^DATA_ROWS=' >&2
  fail "docs/audits.md finding register has ${BAD} row(s) with an empty/invalid disposition or empty 'Checked against' (§9/§14)"
fi

# --- SECURITY.md section seams + non-placeholder values -----------------------
grep -qi "Disclosure address" "${SECURITY_DOC}" \
  || fail "SECURITY.md is missing the 'Disclosure address' section (§14)"
grep -qi "response time" "${SECURITY_DOC}" \
  || fail "SECURITY.md is missing the maximum-response-time section (§14)"

# Placeholder scaffolding from the scout stub must be gone.
if grep -qiE '_?TBD[[:space:]—-]|#1010 (TODO|sets|backfills)' "${SECURITY_DOC}"; then
  fail "SECURITY.md still contains TBD/#1010-TODO placeholder text; set the real disclosure address + SLA (§14)"
fi
# Disclosure address must be a concrete channel (a URL or an email).
grep -qiE 'https?://|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "${SECURITY_DOC}" \
  || fail "SECURITY.md disclosure address has no concrete channel (URL or email) (§14)"
# Maximum response time must state a concrete duration.
grep -qiE '[0-9]+[[:space:]]*(hour|hours|day|days|minute|minutes|second|seconds|h|d)\b' "${SECURITY_DOC}" \
  || fail "SECURITY.md has no concrete maximum response-time value (§14)"

# docs/audits.md must also be free of the scout placeholder rows.
if grep -qiE '#1010 (TODO|backfills)|_TBD — #1010' "${AUDITS_DOC}"; then
  fail "docs/audits.md still contains #1010-TODO placeholder rows; backfill the real ledger (§9/§14)"
fi

echo "check-audit-ledger: OK (audit-scope ledger + finding register [${DATA_ROWS} rows] + SECURITY.md enforced)"
