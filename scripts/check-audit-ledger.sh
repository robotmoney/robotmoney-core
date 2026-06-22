#!/usr/bin/env bash
# Canonical: docs/technical/security-model.md §9 / §14
# Feature work: issue #1010 (Security disclosure ledger phase)
#
# ============================================================================
# DEV-SCOUT STUB (issue #1011) — DO NOT TREAT AS THE ENFORCING CHECK
# ============================================================================
# This is the scout seam for the audit-ledger structural validator. It exists
# so issue #1010 can land the real ledger/SECURITY.md content additively
# against a stable, already-wired entrypoint. In its current scout form it only
# asserts the *presence* of the mandated artifacts and their top-level section
# headings against the placeholder files committed by #1011. It deliberately
# does NOT yet enforce the full mandated structure (per-contract scope rows,
# populated finding-register columns, a real disclosure address, a real SLA);
# backfilling those assertions is #1010's feature work.
#
# WHY THIS SCRIPT EXISTS
# security-model.md mandates two institutional-memory artifacts that have never
# existed in git history (silent regression; tracking issues #645/#643 were
# closed-as-done anyway — also logged as SECURITY-003 in the gap analysis):
#
#   docs/audits.md  — §9 row "Dismissed audit finding later exploited
#       (Venus-class)": every audit finding must be logged with a disposition
#       (fixed | accepted-with-rationale | dismissed-with-rationale).
#     — §14 row "Selectively audited surface": an audit-scope ledger mapping
#       every contract to its audit report(s).
#     — §14 row "Pattern repetition across deployments": the finding register
#       must include a "checked against" field for each finding.
#
#   SECURITY.md     — §14 row "Disclosure-handling failure": must exist at the
#       repo root with a disclosure address and a maximum response-time
#       commitment.
#
# STRUCTURAL ASSERTIONS #1010 MUST ADD (the full enforcing check)
#   docs/audits.md:
#     - an "Audit-scope ledger" table whose rows map each contract under
#       contracts/ to its audit report(s) or an approved documented exception;
#     - a "Finding register" table with, at minimum, columns: finding id,
#       disposition (one of fixed / accepted-with-rationale /
#       dismissed-with-rationale), and "checked against";
#     - the finding-disposition log (§9) cross-referenced from the register.
#   SECURITY.md:
#     - a non-placeholder disclosure address (monitored, on-call rotation);
#     - a non-placeholder maximum response-time SLA value.
#   Data source for backfill: the contract set under contracts/ for the
#   scope-ledger rows, and the external review snapshots under
#   docs/code-reviews/*.md (e.g. gap-analysis-20260607.md, the security-*
#   reviews) for the finding-register seed rows.
#
# OUT OF SCOPE FOR #1011 (the scout): writing real findings/dispositions, real
# disclosure address / SLA values, or wiring this check into CI as a required
# gate. Those are tracked by #1010 and the phase's CI-wiring step.
#
# USAGE
#   scripts/check-audit-ledger.sh
# Exits 0 when the mandated artifacts and their section-heading seams are
# present; non-zero (with a diagnostic) if a seam is missing.
# ============================================================================

set -euo pipefail

# Resolve repo root from this script's location so the check is runnable from
# any working directory (CI, pre-commit hook, or a developer shell).
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

# --- docs/audits.md section seams (scout: presence of headings only) ---------
# Heading text must stay in sync with the placeholder docs/audits.md and with
# the section names in security-model.md §9 / §14.
grep -qi "Audit-scope ledger" "${AUDITS_DOC}" \
  || fail "docs/audits.md is missing the 'Audit-scope ledger' section (§14)"
grep -qi "Finding register" "${AUDITS_DOC}" \
  || fail "docs/audits.md is missing the 'Finding register' section (§14)"
grep -qi "Finding-disposition log" "${AUDITS_DOC}" \
  || fail "docs/audits.md is missing the 'Finding-disposition log' section (§9)"

# --- SECURITY.md section seams (scout: presence of headings only) ------------
grep -qi "Disclosure address" "${SECURITY_DOC}" \
  || fail "SECURITY.md is missing the 'Disclosure address' section (§14)"
grep -qi "response time" "${SECURITY_DOC}" \
  || fail "SECURITY.md is missing the maximum-response-time section (§14)"

echo "check-audit-ledger: OK (scout stub — presence + heading seams only; #1010 backfills enforcement)"
