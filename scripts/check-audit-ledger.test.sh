#!/usr/bin/env bash
# Self-test for scripts/check-audit-ledger.sh (core 1489, S10).
# Clean tree must pass. A shipped contract with no ledger row must fail and be
# named. A ledger row for a missing file must fail. Zero checks run is a failure.
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
  mkdir -p "${TMP}/t/scripts" "${TMP}/t/docs"
  cp "${REPO}/scripts/check-audit-ledger.sh" "${TMP}/t/scripts/"
  cp "${REPO}/docs/audits.md" "${TMP}/t/docs/"
  cp "${REPO}/SECURITY.md" "${TMP}/t/"
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

[ "${ran}" -ge 4 ] || bad "fewer than 4 checks ran"
echo "check-audit-ledger.test: ${ran} checks passed"
