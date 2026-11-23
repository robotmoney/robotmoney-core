#!/usr/bin/env bash
# Canonical: docs/operations/stage-keeper-runbook.md
# Self-test for scripts/ops/start-stage-keeper.sh (core issue 2049). It runs the launcher against a stub keeper in a
# temp KEEPER_DIR and checks that it passes the stdin password as KEEPER_PASSWORD, writes it to no file, and leaves
# exactly one keeper running after a restart. No chain, key or network is used.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LAUNCHER="$REPO_ROOT/scripts/ops/start-stage-keeper.sh"
WORK="$(mktemp -d)"
DIR="$WORK/onevault-keeper"
mkdir -p "$DIR"
cleanup() {
    pkill -f "^bash onevault-keeper\.sh" 2>/dev/null || true
    rm -rf "$WORK"
}
trap cleanup EXIT

if pgrep -f "^bash onevault-keeper\.sh" >/dev/null; then
    echo "FAIL: a keeper is already running on this machine; the launcher would stop it"
    exit 1
fi

# The stub records whether it got the password and in what form, then idles like the real loop.
cat >"$DIR/onevault-keeper.sh" <<'STUB'
[[ "${KEEPER_PASSWORD:-}" == "$(cat "$PWD/expected")" ]] && echo "password-ok" >>"$PWD/stub.out"
[[ -z "${KEEPER_PASSWORD_FILE:-}" ]] && echo "no-password-file" >>"$PWD/stub.out"
while :; do sleep 1; done
STUB
# The expected password lives outside the install dir under test, in a file the stub reads by path.
printf 'stub-test-password' >"$WORK/expected"
ln -s "$WORK/expected" "$DIR/expected"

PASS=0
FAIL=0
check() {
    if eval "$2"; then echo "PASS: $1"; PASS=$((PASS + 1)); else echo "FAIL: $1"; FAIL=$((FAIL + 1)); fi
}
count() { pgrep -f "^bash onevault-keeper\.sh" | wc -l; }

printf 'stub-test-password' | KEEPER_DIR="$DIR" bash "$LAUNCHER" >"$WORK/run1.out" 2>&1
sleep 1
check "the launcher starts one keeper" '[[ "$(count)" == "1" ]] && grep -q "started pid" "$WORK/run1.out"'
check "the keeper gets the stdin password as KEEPER_PASSWORD" 'grep -q "password-ok" "$DIR/stub.out"'
check "the keeper gets no KEEPER_PASSWORD_FILE" 'grep -q "no-password-file" "$DIR/stub.out"'
check "the launcher wrote no file holding the password" '! grep -rqF "stub-test-password" "$DIR" --exclude=expected'
check "the password is on no command line" '! pgrep -af "stub-test-password" | grep -v pgrep | grep -q .'

printf 'stub-test-password\n' | KEEPER_DIR="$DIR" bash "$LAUNCHER" >"$WORK/run2.out" 2>&1
sleep 1
check "a restart leaves exactly one keeper" '[[ "$(count)" == "1" ]]'

# shellcheck disable=SC2034 # read by the check string
KEEPER_DIR="$DIR" bash "$LAUNCHER" </dev/null >"$WORK/run3.out" 2>&1 && RC=0 || RC=$?
check "no password on stdin exits 1" '[[ "$RC" == "1" ]] && grep -q "no password on stdin" "$WORK/run3.out"'

echo "passed=$PASS failed=$FAIL"
[[ $PASS -gt 0 && $FAIL -eq 0 ]]
