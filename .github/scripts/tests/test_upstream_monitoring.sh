#!/usr/bin/env bash
# Tests for scripts/monitor-venue-liveness.sh, monitor-governance-proposals.sh,
# and monitor-usdc-upgrade.sh.
#
# These tests use MOCK_* environment variables to simulate on-chain conditions
# without requiring a live RPC connection. Each test verifies:
#   - The script emits structured JSON with an "alert" field
#   - The script exits non-zero when an alert fires
#   - The script exits zero when no alert condition is present
#
# Canonical: docs/technical/upstream-monitoring-runbook.md §4

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PASS=0
FAIL=0

pass() { echo "PASS: $1"; (( PASS++ )) || true; }
fail() { echo "FAIL: $1"; (( FAIL++ )) || true; }

run_test() {
    local name="$1"
    shift
    if "$@"; then
        pass "$name"
    else
        fail "$name"
    fi
}

# ---------------------------------------------------------------------------
# venue-liveness tests
# ---------------------------------------------------------------------------

test_compound_paused_fires_alert() {
    local output exit_code
    output=$(MOCK_COMPOUND_PAUSED=1 bash "$REPO_ROOT/scripts/monitor-venue-liveness.sh" 2>/dev/null) && exit_code=$? || exit_code=$?
    if (( exit_code != 0 )) && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['alert'] == True; assert d['venues']['compound_v3']['alert'] == True" 2>/dev/null; then
        return 0
    fi
    echo "  compound paused: exit=$exit_code output=$output" >&2
    return 1
}

test_aave_paused_fires_alert() {
    local output exit_code
    output=$(MOCK_AAVE_PAUSED=1 bash "$REPO_ROOT/scripts/monitor-venue-liveness.sh" 2>/dev/null) && exit_code=$? || exit_code=$?
    if (( exit_code != 0 )) && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['alert'] == True; assert d['venues']['aave_v3']['alert'] == True" 2>/dev/null; then
        return 0
    fi
    echo "  aave paused: exit=$exit_code output=$output" >&2
    return 1
}

test_compound_offline_fires_alert() {
    local output exit_code
    output=$(MOCK_COMPOUND_OFFLINE=1 bash "$REPO_ROOT/scripts/monitor-venue-liveness.sh" 2>/dev/null) && exit_code=$? || exit_code=$?
    if (( exit_code != 0 )) && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['alert'] == True" 2>/dev/null; then
        return 0
    fi
    echo "  compound offline: exit=$exit_code output=$output" >&2
    return 1
}

test_aave_offline_fires_alert() {
    local output exit_code
    output=$(MOCK_AAVE_OFFLINE=1 bash "$REPO_ROOT/scripts/monitor-venue-liveness.sh" 2>/dev/null) && exit_code=$? || exit_code=$?
    if (( exit_code != 0 )) && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['alert'] == True" 2>/dev/null; then
        return 0
    fi
    echo "  aave offline: exit=$exit_code output=$output" >&2
    return 1
}

test_liveness_no_rpc_outputs_valid_json() {
    # Without RPC_URL set, venues return "no-rpc" — this is NOT an alert
    # (we cannot distinguish offline from misconfigured); alert stays false.
    local output exit_code
    output=$(bash "$REPO_ROOT/scripts/monitor-venue-liveness.sh" 2>/dev/null) && exit_code=$? || exit_code=$?
    if (( exit_code == 0 )) && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'alert' in d; assert 'venues' in d" 2>/dev/null; then
        return 0
    fi
    echo "  no-rpc liveness: exit=$exit_code output=$output" >&2
    return 1
}

test_liveness_json_has_runbook_ref() {
    local output
    output=$(MOCK_COMPOUND_PAUSED=1 bash "$REPO_ROOT/scripts/monitor-venue-liveness.sh" 2>/dev/null) || true
    if echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'upstream-monitoring-runbook' in d.get('runbook','')" 2>/dev/null; then
        return 0
    fi
    echo "  runbook ref missing from liveness output" >&2
    return 1
}

# ---------------------------------------------------------------------------
# governance-proposals tests
# ---------------------------------------------------------------------------

test_compound_proposal_fires_alert() {
    local output exit_code
    output=$(MOCK_COMPOUND_PROPOSAL=1 bash "$REPO_ROOT/scripts/monitor-governance-proposals.sh" 2>/dev/null) && exit_code=$? || exit_code=$?
    if (( exit_code != 0 )) && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['alert'] == True; assert d['governance']['compound_v3']['alert'] == True" 2>/dev/null; then
        return 0
    fi
    echo "  compound proposal: exit=$exit_code output=$output" >&2
    return 1
}

test_aave_proposal_fires_alert() {
    local output exit_code
    output=$(MOCK_AAVE_PROPOSAL=1 bash "$REPO_ROOT/scripts/monitor-governance-proposals.sh" 2>/dev/null) && exit_code=$? || exit_code=$?
    if (( exit_code != 0 )) && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['alert'] == True; assert d['governance']['aave_v3']['alert'] == True" 2>/dev/null; then
        return 0
    fi
    echo "  aave proposal: exit=$exit_code output=$output" >&2
    return 1
}

test_governance_no_rpc_outputs_valid_json() {
    local output exit_code
    output=$(bash "$REPO_ROOT/scripts/monitor-governance-proposals.sh" 2>/dev/null) && exit_code=$? || exit_code=$?
    if (( exit_code == 0 )) && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'alert' in d; assert 'governance' in d" 2>/dev/null; then
        return 0
    fi
    echo "  no-rpc governance: exit=$exit_code output=$output" >&2
    return 1
}

test_governance_json_has_runbook_ref() {
    local output
    output=$(MOCK_COMPOUND_PROPOSAL=1 bash "$REPO_ROOT/scripts/monitor-governance-proposals.sh" 2>/dev/null) || true
    if echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'upstream-monitoring-runbook' in d.get('runbook','')" 2>/dev/null; then
        return 0
    fi
    echo "  runbook ref missing from governance output" >&2
    return 1
}

# ---------------------------------------------------------------------------
# usdc-upgrade tests
# ---------------------------------------------------------------------------

test_usdc_upgrade_fires_alert() {
    local output exit_code
    output=$(MOCK_USDC_UPGRADE=1 bash "$REPO_ROOT/scripts/monitor-usdc-upgrade.sh" 2>/dev/null) && exit_code=$? || exit_code=$?
    if (( exit_code != 0 )) && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['alert'] == True; assert d['usdc']['alert'] == True" 2>/dev/null; then
        return 0
    fi
    echo "  usdc upgrade: exit=$exit_code output=$output" >&2
    return 1
}

test_usdc_upgrade_no_rpc_outputs_valid_json() {
    local output exit_code
    output=$(bash "$REPO_ROOT/scripts/monitor-usdc-upgrade.sh" 2>/dev/null) && exit_code=$? || exit_code=$?
    if (( exit_code == 0 )) && echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'alert' in d; assert 'usdc' in d" 2>/dev/null; then
        return 0
    fi
    echo "  no-rpc usdc: exit=$exit_code output=$output" >&2
    return 1
}

test_usdc_json_has_runbook_ref() {
    local output
    output=$(MOCK_USDC_UPGRADE=1 bash "$REPO_ROOT/scripts/monitor-usdc-upgrade.sh" 2>/dev/null) || true
    if echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'upstream-monitoring-runbook' in d.get('runbook','')" 2>/dev/null; then
        return 0
    fi
    echo "  runbook ref missing from usdc output" >&2
    return 1
}

test_usdc_alert_contains_event_type() {
    local output
    output=$(MOCK_USDC_UPGRADE=1 bash "$REPO_ROOT/scripts/monitor-usdc-upgrade.sh" 2>/dev/null) || true
    if echo "$output" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['usdc']['event_type'] != 'none'" 2>/dev/null; then
        return 0
    fi
    echo "  event_type missing from usdc alert output" >&2
    return 1
}

# ---------------------------------------------------------------------------
# Runbook existence check
# ---------------------------------------------------------------------------

test_runbook_exists() {
    if [[ -f "$REPO_ROOT/docs/technical/upstream-monitoring-runbook.md" ]]; then
        return 0
    fi
    echo "  runbook not found at docs/technical/upstream-monitoring-runbook.md" >&2
    return 1
}

test_runbook_has_venue_offline_section() {
    if grep -qi "venue.*offline\|compound.*monitor\|aave.*monitor" "$REPO_ROOT/docs/technical/upstream-monitoring-runbook.md" 2>/dev/null; then
        return 0
    fi
    echo "  runbook missing venue-offline or compound/aave monitor section" >&2
    return 1
}

test_runbook_has_usdc_section() {
    if grep -qi "circle.*monitor\|usdc.*upgrade\|usdc.*monitor" "$REPO_ROOT/docs/technical/upstream-monitoring-runbook.md" 2>/dev/null; then
        return 0
    fi
    echo "  runbook missing usdc upgrade section" >&2
    return 1
}

test_security_model_crosslinks_runbook() {
    if grep -q "upstream-monitoring-runbook" "$REPO_ROOT/docs/technical/security-model.md" 2>/dev/null; then
        return 0
    fi
    echo "  security-model.md does not cross-link upstream-monitoring-runbook" >&2
    return 1
}

# ---------------------------------------------------------------------------
# Run all tests
# ---------------------------------------------------------------------------

echo "=== upstream monitoring tests ==="
echo ""

run_test "venue: compound paused → alert fires"        test_compound_paused_fires_alert
run_test "venue: aave paused → alert fires"            test_aave_paused_fires_alert
run_test "venue: compound offline → alert fires"       test_compound_offline_fires_alert
run_test "venue: aave offline → alert fires"           test_aave_offline_fires_alert
run_test "venue: no-rpc → valid JSON, no alert"        test_liveness_no_rpc_outputs_valid_json
run_test "venue: alert JSON has runbook reference"     test_liveness_json_has_runbook_ref

run_test "governance: compound proposal → alert fires" test_compound_proposal_fires_alert
run_test "governance: aave proposal → alert fires"     test_aave_proposal_fires_alert
run_test "governance: no-rpc → valid JSON, no alert"   test_governance_no_rpc_outputs_valid_json
run_test "governance: alert JSON has runbook reference" test_governance_json_has_runbook_ref

run_test "usdc: upgrade event → alert fires"           test_usdc_upgrade_fires_alert
run_test "usdc: no-rpc → valid JSON, no alert"         test_usdc_upgrade_no_rpc_outputs_valid_json
run_test "usdc: alert JSON has runbook reference"      test_usdc_json_has_runbook_ref
run_test "usdc: alert JSON contains event_type"        test_usdc_alert_contains_event_type

run_test "runbook: file exists"                        test_runbook_exists
run_test "runbook: has venue-offline/compound/aave section" test_runbook_has_venue_offline_section
run_test "runbook: has USDC upgrade section"           test_runbook_has_usdc_section
run_test "security-model: cross-links runbook"        test_security_model_crosslinks_runbook

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if (( FAIL > 0 )); then
    exit 1
fi
