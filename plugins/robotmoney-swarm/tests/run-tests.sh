#!/usr/bin/env bash
# run-tests.sh — offline CI tests for the robotmoney-swarm plugin.
#
# Canonical docs: plugins/robotmoney-swarm/skills/robotmoney-swarm/SKILL.md
# Vote schema:    schemas/committee-vote.json
#
# Runs without network access. All four acceptance criteria are exercised:
#   AC-1: tilt-formation produces a vote JSON that passes ajv schema validation
#   AC-2: skill aborts before calling rmpc when ic_contract_address is absent
#   AC-3: skill aborts before calling rmpc when rationale_uri is unreachable
#   AC-4: skill aborts and surfaces AgentNotRegistered when rmpc returns that error
#
# TEST-COVERAGE POLICY (loud-skip, never silent-skip; exit 0 != tested)
# Every prerequisite this suite needs — jq, shellcheck, node/npm, python3 — is a
# HARD requirement. When one is absent the suite FAILS; it never prints "SKIP"
# and exits 0, because a suite that silently degrades to zero assertions is a
# false green. The suite also refuses to exit 0 when fewer than
# MIN_EXPECTED_ASSERTIONS assertions actually executed, so a rename (or a CI
# path filter that stops matching this tree) turns the job red instead of green.
#
# Exit code 0 iff all assertions pass AND at least MIN_EXPECTED_ASSERTIONS ran.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"

FORM_VOTE="$PLUGIN_DIR/scripts/form-vote.sh"
CHECK_PREFLIGHT="$PLUGIN_DIR/scripts/check-preflight.sh"
RESTRICTED_GUARD="$SCRIPT_DIR/check-restricted-paths.sh"
FIXTURES="$SCRIPT_DIR/fixtures"
SCHEMA="$REPO_ROOT/schemas/committee-vote.json"

# Issue #1204: core publishes the rmpc release artifacts, so core owns the
# checksum-verified install recipe and the proof that it fails closed. The
# release workflow itself only fires on a tag, so this suite is where that
# behaviour actually executes on a PR.
INSTALL_RMPC="$REPO_ROOT/scripts/release/install-rmpc.sh"
INSTALL_RMPC_SELFTEST="$REPO_ROOT/scripts/release/install-rmpc-selftest.sh"

# Minimum number of assertions this suite must execute for a green result.
# Bump it when you add assertions; never lower it to make a run pass.
# Lowered from 33 to 26 when the swarm-onboarding skill (and its two
# onboarding-specific test sections: the canonical-payload-contract check and
# the stale-committee-spelling guard) was deleted outright — core no longer
# serves onboarding, so there is nothing left to assert about it here.
# Raised from 26 to 27 by issue #1232: the restricted-path coupling guard is now
# two assertions (its self-test, plus the real branch check) instead of one.
# Raised from 27 to 43 by #1204: scripts/release/install-rmpc-selftest.sh
# contributes 15 assertions covering the checksum-verified rmpc install path,
# plus one guard asserting that selftest did not itself shrink.
# Raised from 42 to 46 by #1204: four more assertions keep BOOTSTRAP.md — core's
# *documented* install path, and the one README.md sends an agent to — pointed at
# that verified recipe instead of an unchecked download.
# Raised from 46 to 54 by #1204's security review: the selftest stopped grepping
# release-rmpc.yml for the text of its packaging step and started extracting and
# EXECUTING that step (with sha256sum removed from PATH, which is what a macOS
# runner is) plus a new archive-to-checksum pairing guard, and install-rmpc.sh
# gained a non-https --base-url refusal.
#
# THIS NUMBER AND THE WORKFLOW FLOOR MOVE TOGETHER.
# .github/workflows/suite-17-swarm-plugin.yml re-checks the executed count
# independently, precisely so a silently-lowered MIN_EXPECTED_ASSERTIONS cannot
# buy a green. That second opinion is worth nothing if it trails this number, so
# the two are kept equal — change one, change the other in the same commit.
MIN_EXPECTED_ASSERTIONS=55

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# require_tool — loud-skip guard. A missing prerequisite is a hard failure, not
# a silent skip that would let the suite exit 0 having asserted nothing.
require_tool() {
  local tool="$1" why="$2"
  if ! command -v "$tool" &>/dev/null; then
    echo "FATAL: required tool '$tool' is not installed ($why)." >&2
    echo "       Refusing to skip — install it in the CI job. See" >&2
    echo "       .github/workflows/suite-17-swarm-plugin.yml." >&2
    exit 1
  fi
}

echo "--- prerequisites (hard requirements, never skipped) ---"
require_tool jq         "parses plugin.json and the generated vote JSON"
require_tool shellcheck "statically checks form-vote.sh / check-preflight.sh"
require_tool node       "runs the ajv schema validator"
require_tool npm        "installs ajv + ajv-formats for the validator"
require_tool python3    "serves the local HTTP fixture used by AC-4"
require_tool curl       "probes the fixture HTTP server"
echo "  OK: jq, shellcheck, node, npm, python3, curl all present"

# Shared test inputs
VAULT="0x1111111111111111111111111111111111111111"
AGENT_ID="robotmoney-v1"
RATIONALE_URI="https://gist.github.com/robotmoney/abc123def456"
PROMPT_HASH="0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
INPUTS_DIGEST="0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"

echo "=== robotmoney-swarm tests ==="

# ---------- 1. plugin.json valid JSON with correct name ----------
echo ""
echo "--- test: plugin.json valid JSON and name=robotmoney-swarm ---"
plugin_name=$(jq -r '.name' "$PLUGIN_DIR/plugin.json" 2>/dev/null) || { fail "plugin.json does not parse as JSON"; }
if [[ "$plugin_name" == "robotmoney-swarm" ]]; then
  pass "plugin name is 'robotmoney-swarm'"
else
  fail "plugin name is '$plugin_name', expected 'robotmoney-swarm'"
fi

# ---------- 1b. the plugin ships exactly the one renamed skill ----------
echo ""
echo "--- test: plugin.json declares the swarm skill and it exists on disk ---"
declared_skills=$(jq -r '.skills | sort | join(",")' "$PLUGIN_DIR/plugin.json")
if [[ "$declared_skills" == "robotmoney-swarm" ]]; then
  pass "plugin.json skills are [robotmoney-swarm]"
else
  fail "plugin.json skills are '$declared_skills', expected 'robotmoney-swarm'"
fi

for skill in robotmoney-swarm; do
  if [[ -f "$PLUGIN_DIR/skills/$skill/SKILL.md" ]]; then
    pass "skills/$skill/SKILL.md exists"
  else
    fail "skills/$skill/SKILL.md is missing"
  fi
  fm_name=$(sed -n '2s/^name: //p' "$PLUGIN_DIR/skills/$skill/SKILL.md")
  if [[ "$fm_name" == "$skill" ]]; then
    pass "skills/$skill front-matter name is '$skill'"
  else
    fail "skills/$skill front-matter name is '$fm_name', expected '$skill'"
  fi
done

# ---------- 1c. compat stub still answers at the old committee skill path ----------
# The frontend shipped the old raw URL for the general committee->swarm
# rename; deleting it outright would 404 every already-deployed consumer.
# This stub must keep existing until the deprecation window closes, and must
# point at the new path. (The sibling committee-onboarding stub is gone: it
# pointed at swarm-onboarding, which was deleted outright — no stub, no
# pointer, a plain 404 by design. See docs/technical/mcp-decision.md.)
echo ""
echo "--- test: compat stub exists at the old committee skill path ---"
for old in robotmoney-committee; do
  stub="$REPO_ROOT/plugins/robotmoney-committee/skills/$old/SKILL.md"
  if [[ -f "$stub" ]]; then
    pass "compat stub present at plugins/robotmoney-committee/skills/$old/SKILL.md"
  else
    fail "compat stub MISSING at plugins/robotmoney-committee/skills/$old/SKILL.md"
    continue
  fi
  if grep -q 'plugins/robotmoney-swarm/skills/' "$stub"; then
    pass "compat stub $old points at the robotmoney-swarm replacement path"
  else
    fail "compat stub $old does not name its robotmoney-swarm replacement path"
  fi
done

# ---------- 2. shellcheck ----------
echo ""
echo "--- test: shellcheck form-vote.sh, check-preflight.sh, check-restricted-paths.sh and the rmpc install path ---"
if shellcheck "$FORM_VOTE" "$CHECK_PREFLIGHT" "$RESTRICTED_GUARD" "$INSTALL_RMPC" "$INSTALL_RMPC_SELFTEST"; then
  pass "shellcheck passed"
else
  fail "shellcheck reported issues"
fi

# ---------- AC-1: tilt-formation → valid schema-conformant JSON ----------
echo ""
echo "--- AC-1: tilt-formation produces schema-conformant vote JSON (ajv) ---"

# Install the exact, lockfile-backed AJV dependency tree into a temp directory
# scoped to this test run. Lifecycle scripts are never needed for validation.
AJV_TMP="$(mktemp -d)"
trap 'rm -rf "$AJV_TMP"' EXIT

cp "$PLUGIN_DIR/package.json" "$PLUGIN_DIR/package-lock.json" "$AJV_TMP/"
npm ci --prefix "$AJV_TMP" --ignore-scripts 2>/dev/null 1>/dev/null

# Write the Node.js validator script.
AJV_VALIDATOR="$AJV_TMP/validate.js"
cat > "$AJV_VALIDATOR" <<'VALIDATE_JS'
#!/usr/bin/env node
// validate.js — validate stdin JSON against a JSON Schema draft-07 schema file.
// Usage: node validate.js <schema-path>
// Reads the instance from stdin. Exits 0 if valid, 1 if invalid (errors to stderr).
const fs   = require('fs');
const path = require('path');

const schemaPath = process.argv[2];
if (!schemaPath) {
  process.stderr.write('usage: node validate.js <schema-path>\n');
  process.exit(1);
}

const Ajv      = require('ajv');
const addFormats = require('ajv-formats');

const ajv = new Ajv({ strict: false });
addFormats(ajv);

const schema   = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const instance = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));

const validate = ajv.compile(schema);
const valid    = validate(instance);

if (valid) {
  process.stdout.write('ok: instance is valid\n');
  process.exit(0);
} else {
  process.stderr.write('VALIDATION ERRORS:\n');
  (validate.errors || []).forEach(e => {
    process.stderr.write(`  ${e.instancePath || '(root)'}: ${e.message}\n`);
  });
  process.exit(1);
}
VALIDATE_JS

# Test all three regime stances.
AC1_PASS=true
for REGIME in risk_on neutral risk_off; do
  VOTE_JSON=$("$FORM_VOTE" \
    --regime "$REGIME" \
    --vault "$VAULT" \
    --current-weight-bps 5000 \
    --agent-id "$AGENT_ID" \
    --rationale-uri "$RATIONALE_URI" \
    --prompt-hash "$PROMPT_HASH" \
    --inputs-digest "$INPUTS_DIGEST")

  if echo "$VOTE_JSON" | node "$AJV_VALIDATOR" "$SCHEMA" 1>/dev/null 2>&1; then
    pass "regime=$REGIME vote JSON passes ajv schema validation"
  else
    ERRORS=$(echo "$VOTE_JSON" | node "$AJV_VALIDATOR" "$SCHEMA" 2>&1 || true)
    fail "regime=$REGIME vote JSON FAILED ajv schema validation: $ERRORS"
    AC1_PASS=false
  fi
done

# Verify expected stance values.
VOTE_RISK_ON=$("$FORM_VOTE" --regime risk_on --vault "$VAULT" --current-weight-bps 5000 \
  --agent-id "$AGENT_ID" --rationale-uri "$RATIONALE_URI" \
  --prompt-hash "$PROMPT_HASH" --inputs-digest "$INPUTS_DIGEST")
VOTE_NEUTRAL=$("$FORM_VOTE" --regime neutral --vault "$VAULT" --current-weight-bps 5000 \
  --agent-id "$AGENT_ID" --rationale-uri "$RATIONALE_URI" \
  --prompt-hash "$PROMPT_HASH" --inputs-digest "$INPUTS_DIGEST")
VOTE_RISK_OFF=$("$FORM_VOTE" --regime risk_off --vault "$VAULT" --current-weight-bps 5000 \
  --agent-id "$AGENT_ID" --rationale-uri "$RATIONALE_URI" \
  --prompt-hash "$PROMPT_HASH" --inputs-digest "$INPUTS_DIGEST")

STANCE_ON=$(echo "$VOTE_RISK_ON"  | jq -r '.stance')
STANCE_NE=$(echo "$VOTE_NEUTRAL"  | jq -r '.stance')
STANCE_OF=$(echo "$VOTE_RISK_OFF" | jq -r '.stance')

[[ "$STANCE_ON" == "overweight" ]]  && pass "risk_on → stance=overweight"  || fail "risk_on → stance='$STANCE_ON', expected overweight"
[[ "$STANCE_NE" == "neutral" ]]     && pass "neutral → stance=neutral"     || fail "neutral → stance='$STANCE_NE', expected neutral"
[[ "$STANCE_OF" == "underweight" ]] && pass "risk_off → stance=underweight" || fail "risk_off → stance='$STANCE_OF', expected underweight"

TW_ON=$(echo "$VOTE_RISK_ON"  | jq -r '.target_weight_bps')
TW_NE=$(echo "$VOTE_NEUTRAL"  | jq -r '.target_weight_bps')
TW_OF=$(echo "$VOTE_RISK_OFF" | jq -r '.target_weight_bps')

[[ "$TW_ON" == "6000" ]] && pass "risk_on  target_weight_bps=6000 (5000+1000)" || fail "risk_on  target_weight_bps=$TW_ON, expected 6000"
[[ "$TW_NE" == "5000" ]] && pass "neutral  target_weight_bps=5000 (unchanged)" || fail "neutral  target_weight_bps=$TW_NE, expected 5000"
[[ "$TW_OF" == "4000" ]] && pass "risk_off target_weight_bps=4000 (5000-1000)" || fail "risk_off target_weight_bps=$TW_OF, expected 4000"

# Verify cap at 10000 and floor at 0.
VOTE_CAP=$("$FORM_VOTE" --regime risk_on --vault "$VAULT" --current-weight-bps 9500 \
  --agent-id "$AGENT_ID" --rationale-uri "$RATIONALE_URI" \
  --prompt-hash "$PROMPT_HASH" --inputs-digest "$INPUTS_DIGEST")
TW_CAP=$(echo "$VOTE_CAP" | jq -r '.target_weight_bps')
[[ "$TW_CAP" == "10000" ]] && pass "risk_on cap at 10000 (9500+1000→10000)" || fail "risk_on cap: target_weight_bps=$TW_CAP, expected 10000"

VOTE_FLOOR=$("$FORM_VOTE" --regime risk_off --vault "$VAULT" --current-weight-bps 500 \
  --agent-id "$AGENT_ID" --rationale-uri "$RATIONALE_URI" \
  --prompt-hash "$PROMPT_HASH" --inputs-digest "$INPUTS_DIGEST")
TW_FLOOR=$(echo "$VOTE_FLOOR" | jq -r '.target_weight_bps')
[[ "$TW_FLOOR" == "0" ]] && pass "risk_off floor at 0 (500-1000→0)" || fail "risk_off floor: target_weight_bps=$TW_FLOOR, expected 0"

# ---------- AC-2: abort when ic_contract_address absent ----------
echo ""
echo "--- AC-2: skill aborts before calling rmpc when ic_contract_address absent ---"

MISSING_IC_CONFIG="$FIXTURES/missing-ic-config.toml"
set +e
PREFLIGHT_OUT=$("$CHECK_PREFLIGHT" \
  --config "$MISSING_IC_CONFIG" \
  --rationale-uri "$RATIONALE_URI" 2>&1)
PREFLIGHT_EXIT=$?
set -e

if [[ $PREFLIGHT_EXIT -eq 2 ]]; then
  pass "exited with code 2 (MissingICConfig) when ic_contract_address absent"
else
  fail "expected exit code 2, got $PREFLIGHT_EXIT (output: $PREFLIGHT_OUT)"
fi

if echo "$PREFLIGHT_OUT" | grep -q "MissingICConfig"; then
  pass "error output mentions MissingICConfig"
else
  fail "error output does not mention MissingICConfig: $PREFLIGHT_OUT"
fi

if echo "$PREFLIGHT_OUT" | grep -q "ic_contract_address"; then
  pass "error output mentions ic_contract_address"
else
  fail "error output does not mention ic_contract_address: $PREFLIGHT_OUT"
fi

# ---------- AC-3: abort when rationale_uri unreachable ----------
echo ""
echo "--- AC-3: skill aborts before calling rmpc when rationale_uri unreachable (mocked HTTP error) ---"

# Use a URI that is guaranteed unreachable (loopback port that nothing listens on).
UNREACHABLE_URI="http://127.0.0.1:19999/nonexistent-rationale"

# Override RMPC to a no-op so guard 3 (AgentNotRegistered dry-run) never runs
# and we isolate guard 2 (RationaleURIUnreachable).
FAKE_RMPC="$(mktemp)"
cat > "$FAKE_RMPC" <<'FAKERMPC'
#!/usr/bin/env bash
# Fake rmpc that always exits 0 — used to isolate preflight guard 2.
exit 0
FAKERMPC
chmod +x "$FAKE_RMPC"

set +e
PREFLIGHT_OUT3=$("$CHECK_PREFLIGHT" \
  --config "$FIXTURES/valid-config.toml" \
  --rationale-uri "$UNREACHABLE_URI" \
  --rmpc "$FAKE_RMPC" 2>&1)
PREFLIGHT_EXIT3=$?
set -e

rm -f "$FAKE_RMPC"

if [[ $PREFLIGHT_EXIT3 -eq 3 ]]; then
  pass "exited with code 3 (RationaleURIUnreachable) for unreachable URI"
else
  fail "expected exit code 3, got $PREFLIGHT_EXIT3 (output: $PREFLIGHT_OUT3)"
fi

if echo "$PREFLIGHT_OUT3" | grep -q "RationaleURIUnreachable"; then
  pass "error output mentions RationaleURIUnreachable"
else
  fail "error output does not mention RationaleURIUnreachable: $PREFLIGHT_OUT3"
fi

# ---------- AC-4: abort and surface AgentNotRegistered ----------
echo ""
echo "--- AC-4: skill aborts and surfaces AgentNotRegistered when rmpc returns that error ---"

# Create a fake rmpc that outputs AgentNotRegistered and exits non-zero.
FAKE_RMPC_ANR="$(mktemp)"
cat > "$FAKE_RMPC_ANR" <<'FAKERMPC_ANR'
#!/usr/bin/env bash
# Fake rmpc that returns AgentNotRegistered — used for AC-4 test.
echo '{"error":"AgentNotRegistered","message":"the configured signing address is not a registered committee agent"}' >&2
exit 3
FAKERMPC_ANR
chmod +x "$FAKE_RMPC_ANR"

# Provide a reachable rationale_uri by using an HTTP server fixture.
# We mock it by patching the check-preflight logic: use a special env var
# to skip the HTTP check and jump directly to the rmpc guard.
# Since check-preflight.sh checks for curl return code, we point it at
# a URI that curl can reach: the public loopback (always resolves to localhost).
# We use --resolve to skip actual DNS/network and just test the rmpc guard.
#
# Simpler approach: create a temporary HTTP server on a known port.
# Use python3 -m http.server if available, or nc.
HTTP_PORT=18888
python3 -m http.server "$HTTP_PORT" --directory "$FIXTURES" &>/dev/null &
HTTP_PID=$!
# Give the server a moment to start.
sleep 0.3

# Verify it started.
HTTP_UP=false
for _ in 1 2 3 4 5; do
  if curl --silent --output /dev/null --max-time 1 "http://127.0.0.1:$HTTP_PORT/" 2>/dev/null; then
    HTTP_UP=true
    break
  fi
  sleep 0.2
done

if [[ "$HTTP_UP" == "true" ]]; then
  set +e
  PREFLIGHT_OUT4=$("$CHECK_PREFLIGHT" \
    --config "$FIXTURES/valid-config.toml" \
    --rationale-uri "http://127.0.0.1:$HTTP_PORT/" \
    --rmpc "$FAKE_RMPC_ANR" 2>&1)
  PREFLIGHT_EXIT4=$?
  set -e

  kill "$HTTP_PID" 2>/dev/null || true
  wait "$HTTP_PID" 2>/dev/null || true
  rm -f "$FAKE_RMPC_ANR"

  if [[ $PREFLIGHT_EXIT4 -eq 4 ]]; then
    pass "exited with code 4 (AgentNotRegistered) when rmpc returns that error"
  else
    fail "expected exit code 4, got $PREFLIGHT_EXIT4 (output: $PREFLIGHT_OUT4)"
  fi

  if echo "$PREFLIGHT_OUT4" | grep -q "AgentNotRegistered"; then
    pass "error output mentions AgentNotRegistered"
  else
    fail "error output does not mention AgentNotRegistered: $PREFLIGHT_OUT4"
  fi
else
  kill "$HTTP_PID" 2>/dev/null || true
  rm -f "$FAKE_RMPC_ANR"
  # Loud-skip policy: AC-4 must never silently opt out. python3 is a hard
  # prerequisite (checked above), so a server that will not come up is a real
  # failure of this environment, not a reason to declare the AC untested.
  fail "could not start local HTTP server on port $HTTP_PORT — AC-4 did not execute"
fi

# ---------- #1204: the rmpc install path verifies its checksum before installing ----------
# release-rmpc.yml publishes `<archive>.tar.gz.sha256` alongside every archive,
# but that workflow only runs on a tag push — it never executes on a PR. The
# consuming half (verify, then install; abort loudly on mismatch) lives in
# scripts/release/install-rmpc.sh and is exercised here, on every PR, by its
# offline selftest. Each selftest assertion is folded into this suite's own
# counters so it is covered by MIN_EXPECTED_ASSERTIONS and cannot silently
# vanish.
echo ""
echo "--- #1204: checksum-verified rmpc install (positive + corrupted + substituted) ---"

# Minimum assertions the install selftest must itself contribute. Guards against
# the selftest being gutted while this suite still reports a healthy total.
MIN_INSTALL_SELFTEST_ASSERTIONS=23

if [[ ! -x "$INSTALL_RMPC_SELFTEST" ]]; then
  # Loud-skip policy: a missing selftest is a red suite, never a quiet pass.
  fail "scripts/release/install-rmpc-selftest.sh is missing or not executable — #1204 checksum coverage is gone"
else
  set +e
  INSTALL_SELFTEST_OUT=$("$INSTALL_RMPC_SELFTEST" 2>&1)
  set -e

  INSTALL_SELFTEST_ASSERTIONS=0
  while IFS= read -r selftest_line; do
    case "$selftest_line" in
      PASS:*)
        pass "install-rmpc: ${selftest_line#PASS: }"
        INSTALL_SELFTEST_ASSERTIONS=$((INSTALL_SELFTEST_ASSERTIONS+1))
        ;;
      FAIL:*)
        fail "install-rmpc: ${selftest_line#FAIL: }"
        INSTALL_SELFTEST_ASSERTIONS=$((INSTALL_SELFTEST_ASSERTIONS+1))
        ;;
    esac
  done <<< "$INSTALL_SELFTEST_OUT"

  if [[ $INSTALL_SELFTEST_ASSERTIONS -ge $MIN_INSTALL_SELFTEST_ASSERTIONS ]]; then
    pass "install-rmpc selftest contributed $INSTALL_SELFTEST_ASSERTIONS assertions (>= $MIN_INSTALL_SELFTEST_ASSERTIONS)"
  else
    fail "install-rmpc selftest contributed only $INSTALL_SELFTEST_ASSERTIONS assertions, expected >= $MIN_INSTALL_SELFTEST_ASSERTIONS (output: $INSTALL_SELFTEST_OUT)"
  fi
fi

# ---------- #1204: core's *documented* install path is the verified one ----------
# A verified installer nobody is told to use closes nothing. BOOTSTRAP.md is the
# file README.md points an agent at, and its step 1 used to say "download the
# latest rmpc and place it on PATH" with no integrity check — three steps before
# step 4 creates a signing keystore with that same binary. These assertions keep
# the documented path pointed at scripts/release/install-rmpc.sh, and keep the
# unverified forms from creeping back. suite-17 has no `paths` filter, so a
# Markdown-only edit to BOOTSTRAP.md still runs them.
echo ""
echo "--- #1204: BOOTSTRAP.md documents the checksum-verified rmpc install ---"

BOOTSTRAP_MD="$REPO_ROOT/BOOTSTRAP.md"
if [[ ! -f "$BOOTSTRAP_MD" ]]; then
  # Loud-skip policy: a missing document is a red suite, not a quiet pass.
  fail "BOOTSTRAP.md is missing — core's documented rmpc install path cannot be checked"
else
  if grep -q 'scripts/release/install-rmpc.sh' "$BOOTSTRAP_MD"; then
    pass "BOOTSTRAP.md installs rmpc through the checksum-verified scripts/release/install-rmpc.sh"
  else
    fail "BOOTSTRAP.md no longer routes the rmpc install through scripts/release/install-rmpc.sh — #1204 regression"
  fi

  # The two unverified forms #1204 exists to eliminate: piping a download into
  # tar (unfixable in place — extraction happens before any check could run),
  # and telling the reader to hand-place a downloaded binary on PATH.
  #
  # Backslash continuations are folded away first. This document's own tag
  # lookup is written as `curl ... \` / `| grep ...` across two lines, so a
  # purely line-based grep would also miss a `curl ... \` / `| tar xz` written
  # the same way — the exact shape it most needs to catch.
  if sed -e :a -e '/\\$/N; s/\\\n//; ta' "$BOOTSTRAP_MD" \
       | grep -qEi 'curl[^|]*\|[[:space:]]*tar'; then
    fail "BOOTSTRAP.md pipes a download straight into tar — nothing can verify an archive that is already unpacked"
  else
    pass "BOOTSTRAP.md pipes no download into tar"
  fi

  if grep -qEi 'place it on .?PATH' "$BOOTSTRAP_MD"; then
    fail "BOOTSTRAP.md tells the reader to place a downloaded rmpc on PATH with no integrity check"
  else
    pass "BOOTSTRAP.md documents no hand-placed, unverified rmpc download"
  fi

  if [[ -x "$INSTALL_RMPC" ]]; then
    pass "the installer BOOTSTRAP.md names exists and is executable"
  else
    fail "BOOTSTRAP.md points at scripts/release/install-rmpc.sh but it is missing or not executable"
  fi
fi

# ---------- 3. restricted-path coupling guard ----------
# Assertion (f). Delegated to check-restricted-paths.sh, which (unlike the inline
# version this replaces — issue #1232) resolves a real base commit, fails loudly
# when it cannot, and only fires when the swarm plugin AND a restricted tree
# change together. The self-test runs FIRST and in CI, so a green from the real
# check is only trusted once the guard has been shown able to go red.
echo ""
echo "--- test: restricted-path guard self-test (proves the guard can fail) ---"
if bash "$RESTRICTED_GUARD" --self-test; then
  pass "restricted-path guard fires on a coupling violation and reds out on an unresolvable base"
else
  fail "restricted-path guard self-test failed — the guard is not proven able to fail"
fi

echo ""
echo "--- test: swarm plugin not changed alongside contracts/, crates/, clients/rust-payment-client/, services/ ---"
GUARD_RC=0
bash "$RESTRICTED_GUARD" || GUARD_RC=$?
case "$GUARD_RC" in
  0) pass "no restricted paths modified alongside plugins/robotmoney-swarm/" ;;
  1) fail "plugins/robotmoney-swarm/ was changed together with a restricted path (contracts/, crates/, clients/rust-payment-client/, services/)" ;;
  *) fail "restricted-path guard could not run (exit $GUARD_RC) — it cannot resolve a base commit, so it refuses to report a PASS it cannot justify" ;;
esac

# ---------- summary ----------
# "Exit 0 != tested": a run that asserted nothing is a false green, so the
# executed-assertion count is itself an assertion. This line is the machine
# -readable proof the CI job greps for.
echo ""
TOTAL=$((PASS + FAIL))
echo "=== Results: $PASS passed, $FAIL failed ==="
echo "ROBOTMONEY_SWARM_TESTS_EXECUTED=$TOTAL"

if [[ $TOTAL -lt $MIN_EXPECTED_ASSERTIONS ]]; then
  echo "FATAL: only $TOTAL assertions executed, expected at least $MIN_EXPECTED_ASSERTIONS." >&2
  echo "       Zero (or too few) executed assertions is a false green — failing." >&2
  exit 1
fi

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
