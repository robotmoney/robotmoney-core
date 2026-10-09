#!/usr/bin/env bash
# Self-test for .github/scripts/forge_test_require_executed.sh (issue 1643).
#
# A stub `forge` first on PATH replays a canned transcript. Cases:
#   1. zero-match run (exit 0, "no tests match")  -> red
#   2. tests passed                               -> green
#   3. forge itself fails                         -> red
#   4. floor of 3 with only 2 passed              -> red
#   5. floor of 2 with 2 passed                   -> green
#   6. a planted empty --match-path against the REAL forge -> red (skipped if forge is absent)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
GUARD="${ROOT}/.github/scripts/forge_test_require_executed.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
cat > "$WORK/bin/forge" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "${STUB_OUTPUT}"
exit "${STUB_STATUS:-0}"
STUB
chmod +x "$WORK/bin/forge"

EMPTY=$'Warning: no tests match the provided pattern:\n\tmatch-path: `test/invariant/**`\n'
PASS2=$'Ran 2 tests for contracts/test/X.t.sol:XTest\n[PASS] a()\n[PASS] b()\nSuite result: ok. 2 passed; 0 failed; 0 skipped; finished in 1ms'

FAILS=0
expect() { # name want_exit
  local name="$1" want="$2" got=0
  shift 2
  PATH="$WORK/bin:$PATH" bash "$GUARD" "$@" >/dev/null 2>&1 || got=$?
  if { [ "$want" = zero ] && [ "$got" -eq 0 ]; } || { [ "$want" = nonzero ] && [ "$got" -ne 0 ]; }; then
    echo "ok   ${name}"
  else
    echo "FAIL ${name}: exit ${got}, wanted ${want}" >&2
    FAILS=$((FAILS + 1))
  fi
}

export STUB_OUTPUT="$EMPTY" STUB_STATUS=0
expect "zero-match run is red" nonzero --match-path x
export STUB_OUTPUT="$PASS2"
expect "passing run is green" zero --match-path x
export STUB_STATUS=1
expect "forge failure is red" nonzero --match-path x
export STUB_STATUS=0
FORGE_TEST_MIN_EXECUTED=3 expect "floor above passed count is red" nonzero --match-path x
FORGE_TEST_MIN_EXECUTED=2 expect "floor met is green" zero --match-path x
expect "no args is red" nonzero

if command -v forge >/dev/null 2>&1 && [ -f "${ROOT}/foundry.toml" ]; then
  got=0
  (cd "$ROOT" && bash "$GUARD" --match-path "contracts/test/__planted_empty__.t.sol" >/dev/null 2>&1) || got=$?
  if [ "$got" -ne 0 ]; then echo "ok   planted empty match-path on real forge is red"; else echo "FAIL planted empty match-path was green" >&2; FAILS=$((FAILS + 1)); fi
fi

[ "$FAILS" -eq 0 ] || { echo "test_forge_test_require_executed: ${FAILS} case(s) failed" >&2; exit 1; }
echo "test_forge_test_require_executed: all cases passed"
