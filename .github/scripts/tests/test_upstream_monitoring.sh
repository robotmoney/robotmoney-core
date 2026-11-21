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
# require-rpc preflight tests (suite-18-live-monitoring.yml)
# ---------------------------------------------------------------------------

test_require_rpc_schedule_no_rpc_fails() {
    # The scheduled nightly must fail loudly when BASE_RPC_URL is missing,
    # never report success while running no monitors.
    local output exit_code
    output=$(env -u RPC_URL GITHUB_EVENT_NAME=schedule bash "$REPO_ROOT/scripts/monitor-require-rpc.sh" 2>&1) && exit_code=$? || exit_code=$?
    if (( exit_code != 0 )) && grep -q '^::error::.*BASE_RPC_URL' <<<"$output"; then
        return 0
    fi
    echo "  require-rpc schedule/no-rpc: exit=$exit_code output=$output" >&2
    return 1
}

test_require_rpc_schedule_empty_rpc_fails() {
    local output exit_code
    output=$(RPC_URL="" GITHUB_EVENT_NAME=schedule bash "$REPO_ROOT/scripts/monitor-require-rpc.sh" 2>&1) && exit_code=$? || exit_code=$?
    if (( exit_code != 0 )) && grep -q '^::error::.*BASE_RPC_URL' <<<"$output"; then
        return 0
    fi
    echo "  require-rpc schedule/empty-rpc: exit=$exit_code output=$output" >&2
    return 1
}

test_require_rpc_schedule_with_rpc_passes() {
    local exit_code
    RPC_URL="http://127.0.0.1:1" GITHUB_EVENT_NAME=schedule bash "$REPO_ROOT/scripts/monitor-require-rpc.sh" >/dev/null 2>&1 && exit_code=$? || exit_code=$?
    if (( exit_code == 0 )); then
        return 0
    fi
    echo "  require-rpc schedule/with-rpc: exit=$exit_code" >&2
    return 1
}

test_require_rpc_dispatch_no_rpc_warns_only() {
    local output exit_code
    output=$(env -u RPC_URL GITHUB_EVENT_NAME=workflow_dispatch bash "$REPO_ROOT/scripts/monitor-require-rpc.sh" 2>&1) && exit_code=$? || exit_code=$?
    if (( exit_code == 0 )) && grep -q '^::warning::' <<<"$output"; then
        return 0
    fi
    echo "  require-rpc dispatch/no-rpc: exit=$exit_code output=$output" >&2
    return 1
}

test_live_workflow_runs_require_rpc_preflight() {
    if grep -q 'bash scripts/monitor-require-rpc.sh' "$REPO_ROOT/.github/workflows/suite-18-live-monitoring.yml" 2>/dev/null; then
        return 0
    fi
    echo "  suite-18-live-monitoring.yml does not call scripts/monitor-require-rpc.sh" >&2
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
# Mock JSON-RPC HTTP server helpers (no external network required)
# ---------------------------------------------------------------------------

mkdir -p "$HOME/tmp"
TEST_TMPDIR=$(mktemp -d "$HOME/tmp/upstream-monitor-test.XXXXXX")
MOCK_PID=""

stop_mock_rpc() {
    if [[ -f "${TEST_TMPDIR}/pid" ]]; then
        local pid
        pid=$(cat "${TEST_TMPDIR}/pid" 2>/dev/null || true)
        if [[ -n "$pid" ]]; then
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
        fi
        rm -f "${TEST_TMPDIR}/pid"
    fi
    if [[ -n "${MOCK_PID:-}" ]]; then
        kill "$MOCK_PID" 2>/dev/null || true
        wait "$MOCK_PID" 2>/dev/null || true
        MOCK_PID=""
    fi
}

trap 'stop_mock_rpc; rm -rf "$TEST_TMPDIR"' EXIT

start_mock_rpc() {
    local mode="$1"
    stop_mock_rpc
    rm -f "$TEST_TMPDIR/port" "$TEST_TMPDIR/requests.jsonl"
    python3 - "$mode" "$TEST_TMPDIR/port" "$TEST_TMPDIR/requests.jsonl" <<'PY' >/dev/null 2>&1 &
import http.server
import json
import sys
import threading

mode = sys.argv[1]
port_file = sys.argv[2]
req_file = sys.argv[3]
lock = threading.Lock()
state = {"count": 0}

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8")
        req = json.loads(raw)
        method = req.get("method")
        params = req.get("params", [])

        with lock:
            state["count"] += 1
            call_num = state["count"]
            with open(req_file, "a") as f:
                f.write(json.dumps({"call": call_num, "method": method, "params": params}) + "\n")

        if mode == "http-429-always":
            self._send(429, {"error": "rate limited"})
            return

        if mode == "http-429-then-ok" and call_num <= 2:
            self._send(429, {"error": "rate limited"})
            return

        if method == "eth_blockNumber":
            if mode == "multi-chunk":
                self._send(200, {"jsonrpc": "2.0", "id": 1, "result": "0x64"})
            else:
                self._send(200, {"jsonrpc": "2.0", "id": 1, "result": "0x10"})
            return

        if method == "eth_getLogs":
            if mode == "jsonrpc-error":
                self._send(200, {"jsonrpc": "2.0", "id": 1, "error": {"code": -32005, "message": "limit exceeded"}})
                return
            if mode == "multi-chunk":
                filt = params[0] if params else {}
                from_block = int(filt.get("fromBlock", "0x0"), 16)
                topics = filt.get("topics", [])
                # Return a log on chunk 1 (fromBlock == 0) for Compound/Upgraded,
                # and on chunk 3 (fromBlock == 80) for Aave/AdminChanged.
                if from_block == 0 and topics and topics[0] in (
                    "0x7d84a6263ae0d98d3329bd7b46bb4e8d6f98cd35a7adb45c274c8b7fd5ebd5e0",
                    "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b",
                ):
                    self._send(200, {"jsonrpc": "2.0", "id": 1, "result": [{"logIndex": "0x0"}]})
                elif from_block == 80 and topics and topics[0] in (
                    "0xd272d67d2c8c66de43c1d2515abb064978a5020c1552f5ffde104e3e75de8c9a",
                    "0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f",
                ):
                    self._send(200, {"jsonrpc": "2.0", "id": 1, "result": [{"logIndex": "0x1"}]})
                else:
                    self._send(200, {"jsonrpc": "2.0", "id": 1, "result": []})
                return
            self._send(200, {"jsonrpc": "2.0", "id": 1, "result": []})
            return

        self._send(400, {"error": f"unexpected method {method}"})

    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
with open(port_file, "w") as f:
    f.write(str(server.server_address[1]))
server.serve_forever()
PY
    MOCK_PID=$!
    echo "$MOCK_PID" > "$TEST_TMPDIR/pid"
    local i=0
    while [[ ! -s "$TEST_TMPDIR/port" ]] && (( i < 50 )); do
        sleep 0.05
        (( i++ )) || true
    done
    cat "$TEST_TMPDIR/port"
}

test_governance_jsonrpc_error_fails_loudly() {
    local port output exit_code
    port=$(start_mock_rpc "jsonrpc-error")
    output=$(RPC_URL="http://127.0.0.1:$port" BLOCKS_TO_SCAN=10 bash "$REPO_ROOT/scripts/monitor-governance-proposals.sh" 2>/dev/null) && exit_code=$? || exit_code=$?
    stop_mock_rpc
    if (( exit_code != 0 )) && echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['governance']['compound_v3']['status'] == 'rpc-error'
assert d['governance']['aave_v3']['status'] == 'rpc-error'
" 2>/dev/null; then
        return 0
    fi
    echo "  governance jsonrpc-error: exit=$exit_code output=$output" >&2
    return 1
}

test_usdc_jsonrpc_error_fails_loudly() {
    local port output exit_code
    port=$(start_mock_rpc "jsonrpc-error")
    output=$(RPC_URL="http://127.0.0.1:$port" BLOCKS_TO_SCAN=10 bash "$REPO_ROOT/scripts/monitor-usdc-upgrade.sh" 2>/dev/null) && exit_code=$? || exit_code=$?
    stop_mock_rpc
    if (( exit_code != 0 )) && echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['usdc']['status'] == 'rpc-error'
" 2>/dev/null; then
        return 0
    fi
    echo "  usdc jsonrpc-error: exit=$exit_code output=$output" >&2
    return 1
}

test_governance_multi_chunk_aggregates_logs() {
    local port output exit_code
    port=$(start_mock_rpc "multi-chunk")
    output=$(RPC_URL="http://127.0.0.1:$port" BLOCKS_TO_SCAN=100 LOG_CHUNK_SIZE=40 bash "$REPO_ROOT/scripts/monitor-governance-proposals.sh" 2>/dev/null) && exit_code=$? || exit_code=$?
    stop_mock_rpc
    if (( exit_code != 0 )) && echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['alert'] == True
assert d['governance']['compound_v3']['status'] == 'alert'
assert d['governance']['aave_v3']['status'] == 'alert'
" 2>/dev/null && python3 -c "
import json
reqs = [json.loads(line) for line in open('$TEST_TMPDIR/requests.jsonl') if json.loads(line)['method'] == 'eth_getLogs']
assert len(reqs) == 6, f'expected 6 eth_getLogs chunks, got {len(reqs)}'
for r in reqs:
    to_b = r['params'][0]['toBlock']
    assert to_b.startswith('0x') and to_b != 'latest', f'expected hex toBlock, got {to_b}'
" 2>/dev/null; then
        return 0
    fi
    echo "  governance multi-chunk: exit=$exit_code output=$output" >&2
    return 1
}

test_usdc_multi_chunk_aggregates_logs() {
    local port output exit_code
    port=$(start_mock_rpc "multi-chunk")
    output=$(RPC_URL="http://127.0.0.1:$port" BLOCKS_TO_SCAN=100 LOG_CHUNK_SIZE=40 bash "$REPO_ROOT/scripts/monitor-usdc-upgrade.sh" 2>/dev/null) && exit_code=$? || exit_code=$?
    stop_mock_rpc
    if (( exit_code != 0 )) && echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['alert'] == True
assert d['usdc']['status'] == 'alert:upgraded+admin_changed'
assert d['usdc']['event_type'] == 'upgraded+admin_changed'
" 2>/dev/null; then
        return 0
    fi
    echo "  usdc multi-chunk: exit=$exit_code output=$output" >&2
    return 1
}

test_http_429_retries_and_succeeds() {
    local port output exit_code
    port=$(start_mock_rpc "http-429-then-ok")
    output=$(RPC_URL="http://127.0.0.1:$port" RPC_RETRY_DELAYS="0 0" BLOCKS_TO_SCAN=10 bash "$REPO_ROOT/scripts/monitor-governance-proposals.sh" 2>/dev/null) && exit_code=$? || exit_code=$?
    stop_mock_rpc
    if (( exit_code == 0 )) && echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['alert'] == False
assert d['governance']['compound_v3']['status'] == 'clear'
assert d['governance']['aave_v3']['status'] == 'clear'
" 2>/dev/null && python3 -c "
import json
reqs = [json.loads(line) for line in open('$TEST_TMPDIR/requests.jsonl')]
assert len(reqs) >= 5, f'expected retries + getLogs, got {len(reqs)} requests'
" 2>/dev/null; then
        return 0
    fi
    echo "  http-429-then-ok: exit=$exit_code output=$output" >&2
    return 1
}

test_http_429_exhausted_fails_loudly() {
    local port output exit_code
    port=$(start_mock_rpc "http-429-always")
    output=$(RPC_URL="http://127.0.0.1:$port" RPC_RETRY_DELAYS="0 0" BLOCKS_TO_SCAN=10 bash "$REPO_ROOT/scripts/monitor-usdc-upgrade.sh" 2>/dev/null) && exit_code=$? || exit_code=$?
    stop_mock_rpc
    if (( exit_code != 0 )) && echo "$output" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['usdc']['status'] == 'rpc-error'
" 2>/dev/null && python3 -c "
import json
reqs = [json.loads(line) for line in open('$TEST_TMPDIR/requests.jsonl')]
assert len(reqs) == 3, f'expected 3 attempts (1 + 2 retries), got {len(reqs)}'
" 2>/dev/null; then
        return 0
    fi
    echo "  http-429-always: exit=$exit_code output=$output" >&2
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

run_test "require-rpc: schedule + unset RPC_URL → exit 1 + ::error" test_require_rpc_schedule_no_rpc_fails
run_test "require-rpc: schedule + empty RPC_URL → exit 1 + ::error" test_require_rpc_schedule_empty_rpc_fails
run_test "require-rpc: schedule + RPC_URL set → exit 0"  test_require_rpc_schedule_with_rpc_passes
run_test "require-rpc: dispatch + unset RPC_URL → warn, exit 0" test_require_rpc_dispatch_no_rpc_warns_only
run_test "require-rpc: live workflow calls the preflight" test_live_workflow_runs_require_rpc_preflight

run_test "runbook: file exists"                        test_runbook_exists
run_test "runbook: has venue-offline/compound/aave section" test_runbook_has_venue_offline_section
run_test "runbook: has USDC upgrade section"           test_runbook_has_usdc_section
run_test "security-model: cross-links runbook"        test_security_model_crosslinks_runbook

run_test "governance: JSON-RPC error fails loudly"    test_governance_jsonrpc_error_fails_loudly
run_test "usdc: JSON-RPC error fails loudly"          test_usdc_jsonrpc_error_fails_loudly
run_test "governance: multi-chunk eth_getLogs aggregates" test_governance_multi_chunk_aggregates_logs
run_test "usdc: multi-chunk eth_getLogs aggregates"   test_usdc_multi_chunk_aggregates_logs
run_test "rpc: HTTP 429 retries and recovers"         test_http_429_retries_and_succeeds
run_test "rpc: HTTP 429 exhausted fails loudly"       test_http_429_exhausted_fails_loudly

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if (( FAIL > 0 )); then
    exit 1
fi
