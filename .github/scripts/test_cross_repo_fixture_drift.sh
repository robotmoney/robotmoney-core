#!/usr/bin/env bash
# Negative + positive self-test for check_cross_repo_fixture_drift.py (§9A R4, C-21).
#
# A green harness is not evidence until the harness itself has been attacked.
# The state this reconstructs is the real one: at v0.4.0-rc.3 eight of the nine
# shared fixtures had drifted away from robotmoney-frontend and core's own
# fixture check exited 0 (see
# fusion-evidence/20260913T-run1/phase3/3.1-core-ci-fixture-check-GREEN-while-drifted.txt).
# This test copies those exact blobs out of the v0.4.0-rc.3 tag into a temp
# directory and requires the new check to FAIL on them.
#
# Usage: .github/scripts/test_cross_repo_fixture_drift.sh   (exit 0 = all passed)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECK="$REPO_ROOT/.github/scripts/check_cross_repo_fixture_drift.py"
DRIFTED_TAG="${DRIFTED_TAG:-v0.4.0-rc.3}"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   — $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL — $*" >&2; }

echo "== positive: the current tree passes =="
if out="$(python3 "$CHECK" 2>&1)"; then
  ok "check_cross_repo_fixture_drift.py exits 0 on the committed fixtures"
else
  bad "the current tree must pass; got:"; printf '%s\n' "$out" >&2
fi

echo "== negative: the v0.4.0-rc.3 drifted state must FAIL =="
if ! git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$DRIFTED_TAG" >/dev/null; then
  bad "$DRIFTED_TAG is not present; the negative test cannot run and is NOT a skip"
else
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  # Every consensus-receipt.* fixture as it stood at the drifted tag, plus the
  # two fixtures added this cycle (rc.3 predates them) so the ONLY difference
  # under test is the drift itself, not a missing-file error.
  while read -r name; do
    git -C "$REPO_ROOT" show "$DRIFTED_TAG:tests/fixtures/$name" >"$TMP/$name" 2>/dev/null \
      || cp "$REPO_ROOT/tests/fixtures/$name" "$TMP/$name"
  done < <(cd "$REPO_ROOT/tests/fixtures" && ls consensus-receipt.*)

  drifted=0
  for name in $(cd "$REPO_ROOT/tests/fixtures" && ls consensus-receipt.*); do
    cmp -s "$TMP/$name" "$REPO_ROOT/tests/fixtures/$name" || drifted=$((drifted+1))
  done
  echo "  reconstructed $DRIFTED_TAG: $drifted fixture(s) differ from the current tree"
  (( drifted >= 8 )) && ok "the reconstruction really is drifted ($drifted files)" \
    || bad "expected at least 8 drifted fixtures at $DRIFTED_TAG, found $drifted"

  out="$(python3 "$CHECK" --fixtures-dir "$TMP" 2>&1)"; rc=$?
  if (( rc != 0 )); then
    ok "the check FAILS on the $DRIFTED_TAG state (exit $rc)"
  else
    bad "the check exited 0 on the $DRIFTED_TAG drifted state — this is the rc.3 false green"
  fi
  # It must name the drifted files, not just exit non-zero.
  for name in consensus-receipt.schema.json consensus-receipt.valid.json; do
    grep -q "$name" <<<"$out" && ok "the failure names $name" || bad "the failure does not name $name"
  done
  printf '%s\n' "$out" | sed 's/^/    | /'
fi

echo
echo "passed: $PASS   failed: $FAIL"
(( FAIL == 0 ))
