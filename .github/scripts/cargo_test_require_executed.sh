#!/usr/bin/env bash
# Run `cargo test` and FAIL LOUDLY if zero tests were actually executed.
#
# WHY THIS EXISTS (issue #1105 — test-coverage-policy invariant 2)
# Plain `cargo test` exits 0 when zero tests are collected (e.g. a test binary
# that silently no-ops because its Postgres / devnet resource was unavailable,
# or a `--test <name>` filter that matched nothing). Exit 0 is then mistaken for
# "tested" when nothing ran — a silent-skip false green. This wrapper parses the
# libtest summary lines (`test result: ok. N passed; ...`), sums the executed
# count across all test binaries, and exits non-zero unless N > 0. It makes
# "no tests collected" RED, which is the whole point of wiring a test into CI.
#
# USAGE
#   cargo_test_require_executed.sh <cargo test args...>
# e.g.
#   cargo_test_require_executed.sh -p explorer-api --test committee_api --test regime_api -- --nocapture
#
# Reference: skills/_shared/test-coverage-policy.md (invariant 2: Exit 0 != tested).
#
# OPTIONAL: REQUIRED MARKERS (issue #1371 / #1437)
# "N > 0 tests passed" proves *something* ran, not that a *specific* test did.
# When a binary mixes a devnet test with hermetic ones (full_stack_demo_tvl),
# the hermetic tests alone keep N > 0 even if the devnet test silently skipped
# or was deleted. Set REQUIRE_EXECUTED_MARKERS to a newline-separated list of
# fixed strings; each must appear verbatim in the cargo output or the run is
# RED. Tests print such a marker only on the success path of a real assertion,
# so a skip, an early return, or a dropped assertion all fail here. Blank lines
# are ignored; an unset/empty variable leaves the guard's behaviour unchanged.
# Self-test: .github/scripts/tests/test_cargo_test_require_executed.sh.

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "ERROR: cargo_test_require_executed.sh requires cargo test arguments" >&2
  exit 2
fi

# Stream output to the console while also capturing it for the executed-count
# guard. `set -o pipefail` ensures a cargo failure (test failure / compile
# error) still propagates as a non-zero exit from the pipeline below.
LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

set +e
cargo test "$@" 2>&1 | tee "$LOG"
CARGO_STATUS="${PIPESTATUS[0]}"
set -e

if [ "$CARGO_STATUS" -ne 0 ]; then
  echo "ERROR: cargo test exited ${CARGO_STATUS} — see output above." >&2
  exit "$CARGO_STATUS"
fi

# Sum the "N passed" counts across every "test result:" summary line. One line
# is emitted per test binary; a binary that collected zero tests reports
# "0 passed". If the resource was absent and the binary failed to set up, cargo
# would have exited non-zero above; this guard additionally catches the case
# where a binary ran but exercised nothing.
PASSED_TOTAL="$(
  grep -E '^test result:' "$LOG" \
    | sed -E 's/.*ok\. ([0-9]+) passed.*/\1/' \
    | awk '{ sum += $1 } END { print sum + 0 }'
)"

# Also count summary lines so a completely empty run (no test binaries built /
# selected at all) is caught — grep would yield no lines and PASSED_TOTAL=0.
RESULT_LINES="$(grep -cE '^test result:' "$LOG" || true)"

echo "executed-test-guard: ${RESULT_LINES} test binary result line(s), ${PASSED_TOTAL} test(s) passed"

if [ "${PASSED_TOTAL}" -le 0 ]; then
  echo "ERROR: zero tests executed (no-tests-collected). A green run with 0 tests" >&2
  echo "       is a silent skip, not coverage. The selected test(s) did not run —" >&2
  echo "       likely the required resource (Postgres testcontainer / devnet) was" >&2
  echo "       absent or the --test filter matched nothing. Failing loudly." >&2
  echo "       Reference: skills/_shared/test-coverage-policy.md (invariant 2)." >&2
  exit 1
fi

MISSING=0
if [ -n "${REQUIRE_EXECUTED_MARKERS:-}" ]; then
  while IFS= read -r marker; do
    # Trim surrounding whitespace so YAML block-scalar indentation is harmless.
    marker="$(printf '%s' "$marker" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
    [ -z "$marker" ] && continue
    if grep -qF -- "$marker" "$LOG"; then
      echo "executed-test-guard: required marker present: ${marker}"
    else
      echo "ERROR: required marker absent from cargo test output: ${marker}" >&2
      MISSING=$((MISSING + 1))
    fi
  done <<< "${REQUIRE_EXECUTED_MARKERS}"
fi

if [ "${MISSING}" -gt 0 ]; then
  echo "ERROR: ${MISSING} required marker(s) missing. The test(s) that print them" >&2
  echo "       did not reach their success path — skipped, returned early, or the" >&2
  echo "       assertion was removed. A non-zero pass count from other tests in" >&2
  echo "       the same binary does not stand in for them. Failing loudly." >&2
  exit 1
fi
