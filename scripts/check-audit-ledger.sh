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
#     - the register includes rows for the 2026-06-19 external scan (FS-* ids);
#     - every review under docs/code-review/ dated REVIEW_KEY_FROM (2026-10-12)
#       or later is keyed in REVIEW_KEYS, and each keyed review's numbered
#       finding heading `### N.` has a register row `<KEY>-N`, with no
#       `<KEY>-N` row left over for a heading that does not exist (issue #1792);
#     - every `Name.sol:N` source cite exists and, when anchored by a
#       `Name.symbol` before it in the row, is in or names that symbol
#       (scripts/check_audit_source_cites.py, issue #1792).
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

# --- Contract coverage: every shipped .sol has a ledger row (S10, core 1489) ---
# Shipped Solidity = contracts/*.sol + contracts/{adapters,gateway,vaults,lib}/*.sol
# (the audit-scope ledger comment in docs/audits.md defines the same set).
# Interfaces, scripts, tests and the generated doc mirror are excluded.
# shellcheck disable=SC2016  # backticks are literal markdown.
LEDGER_ROWS="$(
  sed -nE 's/^\|[[:space:]]*`([^`]+\.sol)`[[:space:]]*\|.*/\1/p' \
    "${AUDITS_DOC}" | sort -u
)"
SHIPPED=""
for f in "${REPO_ROOT}"/contracts/*.sol \
         "${REPO_ROOT}"/contracts/adapters/*.sol \
         "${REPO_ROOT}"/contracts/gateway/*.sol \
         "${REPO_ROOT}"/contracts/vaults/*.sol \
         "${REPO_ROOT}"/contracts/lib/*.sol; do
  [ -f "${f}" ] || continue
  SHIPPED="${SHIPPED}${f#"${REPO_ROOT}"/contracts/}"$'\n'
done
SHIPPED="$(printf '%s' "${SHIPPED}" | sed '/^$/d' | sort -u)"
[ -n "${SHIPPED}" ] || fail "no shipped contracts found under contracts/ (zero checks would run)"

MISSING="$(comm -23 <(printf '%s\n' "${SHIPPED}") <(printf '%s\n' "${LEDGER_ROWS}"))"
if [ -n "${MISSING}" ]; then
  printf '%s\n' "${MISSING}" | sed 's/^/  no audit-scope ledger row: /' >&2
  fail "shipped contract(s) with no row in the docs/audits.md audit-scope ledger; add a row or a documented exception (§14)"
fi
STALE_ROWS="$(comm -13 <(printf '%s\n' "${SHIPPED}") <(printf '%s\n' "${LEDGER_ROWS}") | grep -v '^$' || true)"
if [ -n "${STALE_ROWS}" ]; then
  printf '%s\n' "${STALE_ROWS}" | sed 's/^/  ledger row for a file that does not exist: /' >&2
  fail "audit-scope ledger names contract(s) that are not shipped; remove the row (§14)"
fi

# --- Source header vs ledger reconciliation ----------------------------------
# A source header that claims "not audited" must have a ledger row whose Status
# is not a bare "Audited" with an empty exception.
RECON_BAD=0
while IFS= read -r rel; do
  [ -n "${rel}" ] || continue
  if head -30 "${REPO_ROOT}/contracts/${rel}" | grep -qiE '^//.*not audited'; then
    row="$(grep -E "^\|[[:space:]]*\`${rel//\//\\/}\`" "${AUDITS_DOC}" | head -1 || true)"
    if printf '%s' "${row}" | grep -qE '\|[[:space:]]*Audited[[:space:]]*\|[[:space:]]*—[[:space:]]*\|[[:space:]]*$'; then
      echo "  header says 'not audited' but ledger says Audited with no exception: ${rel}" >&2
      RECON_BAD=$((RECON_BAD + 1))
    fi
  fi
done <<< "${SHIPPED}"
[ "${RECON_BAD}" -eq 0 ] || fail "${RECON_BAD} source header(s) contradict the audit-scope ledger (§14)"
# --- Deleted names (core 1492) -------------------------------------------------
# The retired Chronicle-priced RWA vault and its adapters are deleted. The audit-scope
# ledger table must carry no row for them, and no shipped source may name them in a
# comment. The finding register keeps them as history, so it is not scanned.
DELETED_NAMES_RE='(RwaVault|ChronicleOracleAdapter|DeSpxaAssetPositionAdapter|UniswapV4Asset[A-Za-z]*Adapter|IPositionAdapter)\b'
LEDGER_TABLE="$(awk '/^## Audit-scope ledger/ { on = 1; next } /^## / { on = 0 } on && /^\|/' "${AUDITS_DOC}")"
if printf '%s\n' "${LEDGER_TABLE}" | grep -qE "${DELETED_NAMES_RE}"; then
  printf '%s\n' "${LEDGER_TABLE}" | grep -E "${DELETED_NAMES_RE}" | sed 's/^/  ledger row names deleted code: /' >&2
  fail "audit-scope ledger table names deleted contracts (core 1492); remove the row"
fi
DELETED_IN_SOURCE=0
while IFS= read -r rel; do
  [ -n "${rel}" ] || continue
  if grep -nE "${DELETED_NAMES_RE}" "${REPO_ROOT}/contracts/${rel}" >/dev/null 2>&1; then
    grep -nE "${DELETED_NAMES_RE}" "${REPO_ROOT}/contracts/${rel}" | sed "s|^|  contracts/${rel}:|" >&2
    DELETED_IN_SOURCE=$((DELETED_IN_SOURCE + 1))
  fi
done <<< "${SHIPPED}"
[ "${DELETED_IN_SOURCE}" -eq 0 ] || fail "${DELETED_IN_SOURCE} shipped source file(s) name deleted contracts (core 1492)"
SHIPPED_COUNT="$(printf '%s\n' "${SHIPPED}" | wc -l | tr -d ' ')"

# --- Review coverage: one register row per finding heading (issue #1792) ------
# The 2026-10-12 security review sat in docs/code-review/ with nine findings and
# no ledger row for any of them, while three older rows contradicted its source
# checks (finding 9). A review numbers its findings as `### N. <title>`
# headings. Each review in REVIEW_KEYS ("<file> <KEY>" per line) needs a
# finding-register row `<KEY>-N` for every heading N, and a `<KEY>-N` row with
# no heading N is stale. Every review .md dated REVIEW_KEY_FROM or later must be
# keyed, so a new review cannot land without its rows. README.md and
# `*-verification.md` companions are not reviews. Older reviews keep their
# grouped or per-ID rows and are not keyed.
REVIEW_DIR="${REPO_ROOT}/docs/code-review"
REVIEW_KEY_FROM=20261012
REVIEW_KEYS='20261012-security-review.md SR-1012
20261015-review-security-claude.md SR-1015
20261019-code-review-internal-claude-opus-5-5-system-split.md SS-1019
20261019-code-review-internal-claude-opus-5-5-ic-policy-removal.md IC-1019
20261019-code-review-internal-claude-opus-5-5-rmpc-scope.md RS-1019'
[ -d "${REVIEW_DIR}" ] || fail "docs/code-review/ is missing; the ledger keys its reviews (issue #1792)"

REGISTER_IDS="$(
  awk '/^## Finding register/ { on = 1; next } on && /^## / { on = 0 } on && /^\|/' "${AUDITS_DOC}" \
    | sed -nE 's/^\|[[:space:]]*([^|[:space:]]+)[[:space:]]*\|.*/\1/p' | sort -u
)"
KEYED_FILES="$(awk 'NF { print $1 }' <<< "${REVIEW_KEYS}")"
COVERAGE_BAD=0
HEADINGS_CHECKED=0

for f in "${REVIEW_DIR}"/*.md; do
  [ -f "${f}" ] || continue
  base="$(basename "${f}")"
  case "${base}" in
    README.md | *-verification.md) continue ;;
    # A measurement note with no numbered findings (V4 recorder sampling, issue 1793,
    # PR 1824): its residual risks are dispositioned in the V4 adapter rows, not per heading.
    20261014-code-review-internal-claude-v4-sampling-economics.md) continue ;;
  esac
  day="${base%%-*}"
  [[ "${day}" =~ ^[0-9]{8}$ ]] || continue
  [ "${day}" -ge "${REVIEW_KEY_FROM}" ] || continue
  if ! grep -qxF "${base}" <<< "${KEYED_FILES}"; then
    echo "  review has no ledger key: docs/code-review/${base} (add it to REVIEW_KEYS and a register row per finding heading)" >&2
    COVERAGE_BAD=$((COVERAGE_BAD + 1))
  fi
done

while read -r review key; do
  [ -n "${review}" ] || continue
  path="${REVIEW_DIR}/${review}"
  if [ ! -f "${path}" ]; then
    echo "  REVIEW_KEYS names a review that does not exist: docs/code-review/${review}" >&2
    COVERAGE_BAD=$((COVERAGE_BAD + 1))
    continue
  fi
  if ! grep -qF "${review}" "${AUDITS_DOC}"; then
    echo "  docs/audits.md never names keyed review ${review} (${key})" >&2
    COVERAGE_BAD=$((COVERAGE_BAD + 1))
  fi
  nums="$(sed -nE 's/^###[[:space:]]+([0-9]+)\.[[:space:]].*/\1/p' "${path}" | sort -u)"
  if [ -z "${nums}" ]; then
    echo "  keyed review has no numbered finding heading (### N.): docs/code-review/${review}" >&2
    COVERAGE_BAD=$((COVERAGE_BAD + 1))
    continue
  fi
  while read -r n; do
    HEADINGS_CHECKED=$((HEADINGS_CHECKED + 1))
    if ! grep -qxF "${key}-${n}" <<< "${REGISTER_IDS}"; then
      echo "  finding heading '### ${n}.' in ${review} has no register row ${key}-${n}" >&2
      COVERAGE_BAD=$((COVERAGE_BAD + 1))
    fi
  done <<< "${nums}"
  rows="$(sed -nE "s/^${key}-([0-9]+)\$/\\1/p" <<< "${REGISTER_IDS}" | sort -u)"
  stale="$(comm -23 <(printf '%s\n' "${rows}" | sed '/^$/d') <(printf '%s\n' "${nums}"))"
  if [ -n "${stale}" ]; then
    while read -r n; do
      echo "  register row ${key}-${n} has no finding heading '### ${n}.' in ${review}" >&2
      COVERAGE_BAD=$((COVERAGE_BAD + 1))
    done <<< "${stale}"
  fi
done <<< "${REVIEW_KEYS}"

[ "${HEADINGS_CHECKED}" -gt 0 ] || fail "no review finding heading was checked (zero checks would run)"
[ "${COVERAGE_BAD}" -eq 0 ] || fail "${COVERAGE_BAD} review heading(s) or file(s) out of step with the finding register (issue #1792)"

# --- Source line cites (issue #1792, QA plan v1 W2) ---------------------------
# Each re-dispositioned row cites a source line. QA plan P1 moved the vault,
# router and gateway bodies into linked libraries and every cite went stale
# (some past the end of the file) with nothing failing. The helper checks each
# `Name.sol:N` cite in docs/audits.md exists and, when the row names
# `Name.symbol` before it, that the line is in or names that symbol. Its
# self-test runs first, so a helper that stopped firing fails here.
python3 "${SCRIPT_DIR}/check_audit_source_cites.py" --self-test >/dev/null \
  || fail "check_audit_source_cites.py --self-test failed (the source-cite rule no longer fires)"
CITES_REPORT="$(CHECK_REPO_ROOT="${REPO_ROOT}" python3 "${SCRIPT_DIR}/check_audit_source_cites.py" 2>&1)" || {
  printf '%s\n' "${CITES_REPORT}" | sed 's/^/  /' >&2
  fail "docs/audits.md cites a source line that does not exist or does not hold the named symbol (issue #1792)"
}

echo "check-audit-ledger: OK (${SHIPPED_COUNT} shipped contracts all have ledger rows; finding register [${DATA_ROWS} rows] + ${HEADINGS_CHECKED} review finding headings + source line cites + SECURITY.md enforced)"
