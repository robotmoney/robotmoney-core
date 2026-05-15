#!/usr/bin/env bash
# run-tests.sh — offline CI tests for the regime-classifier plugin.
#
# Canonical docs: plugins/regime-classifier/skills/regime-classifier/SKILL.md
#
# Runs without network access. All tests use fixture files under test/fixtures/.
# Exit code 0 iff all tests pass.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HELPER="$PLUGIN_DIR/scripts/fetch-regime-snapshot.sh"
FIXTURES="$SCRIPT_DIR/fixtures"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "=== regime-classifier tests ==="

# ---------- 1. plugin.json parses and name is correct ----------
echo ""
echo "--- test: plugin.json valid JSON and name=regime-classifier ---"
plugin_name=$(jq -r '.name' "$PLUGIN_DIR/plugin.json" 2>/dev/null) || { fail "plugin.json does not parse as JSON"; }
if [[ "$plugin_name" == "regime-classifier" ]]; then
  pass "plugin name is 'regime-classifier'"
else
  fail "plugin name is '$plugin_name', expected 'regime-classifier'"
fi

# ---------- 2. shellcheck ----------
echo ""
echo "--- test: shellcheck fetch helper ---"
if command -v shellcheck &>/dev/null; then
  if shellcheck "$HELPER"; then
    pass "shellcheck passed"
  else
    fail "shellcheck reported issues"
  fi
else
  echo "  SKIP: shellcheck not available"
fi

# ---------- 3. valid fixture — surfaced fields match expected values ----------
echo ""
echo "--- test: offline valid fixture surfaces expected fields ---"
# Clear any cache that might exist for today so the offline path is clean
UTC_DATE=$(date -u +%Y-%m-%d)
rm -f "/tmp/regime-snapshot-${UTC_DATE}.json"

OUTPUT=$("$HELPER" --offline "$FIXTURES/valid-snapshot.json" --no-cache)
asof=$(echo "$OUTPUT" | jq -r '.asof')
regime=$(echo "$OUTPUT" | jq -r '.regime')
composite=$(echo "$OUTPUT" | jq -r '.composite')
macro_regime=$(echo "$OUTPUT" | jq -r '.macro_regime')
onchain_regime=$(echo "$OUTPUT" | jq -r '.onchain_regime')

[[ "$asof" == "2026-05-14T00:00:00Z" ]] && pass "asof matches" || fail "asof mismatch: $asof"
[[ "$regime" == "neutral" ]]             && pass "regime matches" || fail "regime mismatch: $regime"
[[ "$composite" == "51.3" ]]             && pass "composite matches" || fail "composite mismatch: $composite"
[[ "$macro_regime" == "expansion" ]]     && pass "macro_regime matches" || fail "macro_regime mismatch: $macro_regime"
[[ "$onchain_regime" == "accumulation" ]] && pass "onchain_regime matches" || fail "onchain_regime mismatch: $onchain_regime"

# ---------- 4. malformed fixture — missing 'regime' field exits non-zero ----------
echo ""
echo "--- test: missing 'regime' field exits non-zero and names field ---"
set +e
ERR_OUTPUT=$("$HELPER" --offline "$FIXTURES/missing-regime-snapshot.json" --no-cache 2>&1)
EXIT_CODE=$?
set -e
if [[ $EXIT_CODE -ne 0 ]]; then
  pass "exited non-zero ($EXIT_CODE) for missing 'regime'"
else
  fail "expected non-zero exit for missing 'regime', got 0"
fi
if echo "$ERR_OUTPUT" | grep -q "regime"; then
  pass "error message names the missing field 'regime'"
else
  fail "error message does not mention 'regime': $ERR_OUTPUT"
fi

# ---------- 5. cache hit — second call reads cache (byte-identical output) ----------
echo ""
echo "--- test: second call reads cache (byte-identical output) ---"
# Clear any cache from previous test runs first.
UTC_DATE=$(date -u +%Y-%m-%d)
rm -f "/tmp/regime-snapshot-${UTC_DATE}.json"
# First call: offline fixture populates the cache.
OUTPUT1=$("$HELPER" --offline "$FIXTURES/valid-snapshot.json")
# Second call: no --offline and no --no-cache, so it must read from the
# cache written by the first call.  The live URL is not reachable in CI.
OUTPUT2=$("$HELPER")
if [[ "$OUTPUT1" == "$OUTPUT2" ]]; then
  pass "second call produced byte-identical output (cache hit)"
else
  fail "second call output differs from first (cache miss or re-fetch)"
fi

# ---------- 6. no restricted paths touched ----------
echo ""
echo "--- test: no contracts/, crates/, clients/rust-payment-client/, services/ paths modified ---"
REPO_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"
# Check that none of the restricted paths have been modified by this PR's changes
# We compare against the merge-base with origin/dev
if git -C "$REPO_ROOT" diff --name-only "$(git -C "$REPO_ROOT" merge-base HEAD origin/dev 2>/dev/null || echo HEAD~1)" HEAD 2>/dev/null \
    | grep -qE '^(contracts/|crates/|clients/rust-payment-client/|services/)'; then
  fail "restricted path (contracts/, crates/, clients/rust-payment-client/, services/) was modified"
else
  pass "no restricted paths modified"
fi

# ---------- summary ----------
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
