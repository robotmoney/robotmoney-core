#!/usr/bin/env bash
# Self-test for scripts/check-audit-ledger.sh (core 1489, S10; issue #1792).
# Clean tree must pass. A shipped contract with no ledger row must fail and be
# named. A ledger row for a missing file must fail. Zero checks run is a failure.
# Review coverage (#1792): a keyed review's finding heading with no register
# row, a register row with no heading, and a new dated review with no key must
# each fail and be named; a verification companion is not a review.
# Source line cites (#1792, QA plan v1 W2): a cite past the end of its file,
# and a cite anchored by `Name.symbol` that lands in another function, must
# each fail and be named.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

ran=0
pass() { ran=$((ran + 1)); echo "ok   $1"; }
bad() { echo "FAIL $1" >&2; exit 1; }

mk_tree() {
  rm -rf "${TMP}/t"
  mkdir -p "${TMP}/t/scripts" "${TMP}/t/docs/code-review"
  cp "${REPO}/scripts/check-audit-ledger.sh" "${TMP}/t/scripts/"
  cp "${REPO}/scripts/check_audit_source_cites.py" "${TMP}/t/scripts/"
  cp "${REPO}/docs/audits.md" "${TMP}/t/docs/"
  cp "${REPO}/SECURITY.md" "${TMP}/t/"
  # The review files the ledger keys, one row per finding heading (#1792).
  cp "${REPO}"/docs/code-review/*.md "${TMP}/t/docs/code-review/"
  # Only the shipped Solidity is needed for the coverage scan.
  (cd "${REPO}" && find contracts -maxdepth 2 -name '*.sol' \
    -not -path 'contracts/test/*' -not -path 'contracts/script/*' \
    -not -path 'contracts/interfaces/*' -not -path 'contracts/doc/*') |
    while IFS= read -r f; do
      mkdir -p "${TMP}/t/$(dirname "${f}")"
      cp "${REPO}/${f}" "${TMP}/t/${f}"
    done
}

mk_tree
bash "${TMP}/t/scripts/check-audit-ledger.sh" >/dev/null 2>&1 || bad "clean tree must exit 0"
pass "clean tree exits 0"

mk_tree
printf '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24;\ncontract NoLedgerRow {}\n' >"${TMP}/t/contracts/vaults/NoLedgerRow.sol"
if out="$(bash "${TMP}/t/scripts/check-audit-ledger.sh" 2>&1)"; then bad "contract with no ledger row must exit non-zero"; fi
grep -q 'vaults/NoLedgerRow.sol' <<<"${out}" || bad "failure must name vaults/NoLedgerRow.sol"
pass "new contract with no ledger row fails and is named"

mk_tree
rm "${TMP}/t/contracts/lib/BpsMath.sol"
if out="$(bash "${TMP}/t/scripts/check-audit-ledger.sh" 2>&1)"; then bad "ledger row for a deleted contract must exit non-zero"; fi
grep -q 'lib/BpsMath.sol' <<<"${out}" || bad "failure must name lib/BpsMath.sol"
pass "ledger row for a missing file fails"

mk_tree
rm -rf "${TMP}/t/contracts"
if bash "${TMP}/t/scripts/check-audit-ledger.sh" >/dev/null 2>&1; then bad "zero shipped contracts must exit non-zero"; fi
pass "zero shipped contracts fails"

mk_tree
sed -i 's/Basis-point math exercised through/Basis-point math shared with RwaVault, exercised through/' "${TMP}/t/docs/audits.md"
grep -q 'shared with RwaVault' "${TMP}/t/docs/audits.md" || bad "test setup: planted text missing"
if out="$(bash "${TMP}/t/scripts/check-audit-ledger.sh" 2>&1)"; then bad "a ledger row naming RwaVault must exit non-zero"; fi
grep -q 'RwaVault' <<<"${out}" || bad "failure must name RwaVault"
pass "ledger row naming a deleted contract fails"

mk_tree
printf '\n/// @dev Planted: mirrors the RwaVault floor.\n' >>"${TMP}/t/contracts/lib/BpsMath.sol"
if out="$(bash "${TMP}/t/scripts/check-audit-ledger.sh" 2>&1)"; then bad "a source header naming RwaVault must exit non-zero"; fi
grep -q 'contracts/lib/BpsMath.sol' <<<"${out}" || bad "failure must name contracts/lib/BpsMath.sol"
pass "source comment naming a deleted contract fails"

# --- Review coverage: one register row per finding heading (#1792) -----------
REVIEW="${TMP}/t/docs/code-review/20261012-security-review.md"

mk_tree
grep -q '^| SR-1012-4 |' "${TMP}/t/docs/audits.md" || bad "test setup: row SR-1012-4 missing"
sed -i '/^| SR-1012-4 |/d' "${TMP}/t/docs/audits.md"
if out="$(bash "${TMP}/t/scripts/check-audit-ledger.sh" 2>&1)"; then bad "a finding heading with no register row must exit non-zero"; fi
grep -q 'no register row SR-1012-4' <<<"${out}" || bad "failure must name SR-1012-4"
pass "review finding heading with no register row fails and is named"

mk_tree
printf '\n### 10. Low — planted finding\n\nPlanted by the self-test.\n' >>"${REVIEW}"
if out="$(bash "${TMP}/t/scripts/check-audit-ledger.sh" 2>&1)"; then bad "a new finding heading with no row must exit non-zero"; fi
grep -q 'no register row SR-1012-10' <<<"${out}" || bad "failure must name SR-1012-10"
pass "new finding heading in a keyed review fails until it has a row"

mk_tree
sed -i '/^| SR-1012-9 |/a | SR-1012-11 | SR-1012 | Low | fixed | RobotMoneyVault | — | Planted stale row |' "${TMP}/t/docs/audits.md"
grep -q '^| SR-1012-11 |' "${TMP}/t/docs/audits.md" || bad "test setup: planted row missing"
if out="$(bash "${TMP}/t/scripts/check-audit-ledger.sh" 2>&1)"; then bad "a register row with no heading must exit non-zero"; fi
grep -q 'register row SR-1012-11 has no finding heading' <<<"${out}" || bad "failure must name SR-1012-11"
pass "register row with no finding heading fails and is named"

mk_tree
printf '# Planted review\n\n## Findings\n\n### 1. Low — planted\n' \
  >"${TMP}/t/docs/code-review/20991231-code-review-planted.md"
if out="$(bash "${TMP}/t/scripts/check-audit-ledger.sh" 2>&1)"; then bad "a dated review with no ledger key must exit non-zero"; fi
grep -q 'review has no ledger key: docs/code-review/20991231-code-review-planted.md' <<<"${out}" \
  || bad "failure must name the unkeyed review"
pass "new dated review with no ledger key fails and is named"

mk_tree
printf '# Planted verification\n\n### 1. Low — planted\n' \
  >"${TMP}/t/docs/code-review/20991231-code-review-planted-verification.md"
bash "${TMP}/t/scripts/check-audit-ledger.sh" >/dev/null 2>&1 \
  || bad "a verification companion is not a review and must not need a key"
pass "verification companion needs no ledger key"

# --- Source line cites (#1792, QA plan v1 W2) ----------------------------------
mk_tree
sed -i '/^| SR-1012-5 |/s/RobotMoneyVault.sol:1150-1155/RobotMoneyVault.sol:9150-9155/' "${TMP}/t/docs/audits.md"
grep -q 'RobotMoneyVault.sol:9150-9155' "${TMP}/t/docs/audits.md" || bad "test setup: planted cite missing"
if out="$(bash "${TMP}/t/scripts/check-audit-ledger.sh" 2>&1)"; then bad "a source cite past the end of its file must exit non-zero"; fi
grep -q 'RobotMoneyVault.sol:9150-9155' <<<"${out}" || bad "failure must name the cite"
pass "source cite past the end of its file fails and is named"

mk_tree
sed -i '/^| SR-1012-5 |/s/RobotMoneyVault.sol:1150-1155/RobotMoneyVault.sol:1-2/' "${TMP}/t/docs/audits.md"
grep -q 'RobotMoneyVault.sol:1-2' "${TMP}/t/docs/audits.md" || bad "test setup: planted cite missing"
if out="$(bash "${TMP}/t/scripts/check-audit-ledger.sh" 2>&1)"; then bad "an anchored cite outside its symbol must exit non-zero"; fi
grep -q 'RobotMoneyVault.forceRemoveAdapter' <<<"${out}" || bad "failure must name the anchor symbol"
pass "source cite anchored by Name.symbol outside that symbol fails and is named"

[ "${ran}" -ge 13 ] || bad "fewer than 13 checks ran"
echo "check-audit-ledger.test: ${ran} checks passed"
