#!/usr/bin/env bash
# Integration test for scripts/stage/fusion-watchdog-supervisor-failed-alert.sh
# (issue #1378 review).
#
# The OnFailure= unit's old ExecStart= embedded a JSON payload directly in a
# quoted shell command line. systemd un-escapes `\"` before exec'ing
# ExecStart=, so the shell saw the payload unquoted and whitespace-split, and
# curl tried to resolve a stray word from it as a hostname ("Could not
# resolve host") -- the receiver got zero requests, and the command's
# trailing `|| true` hid the failure from systemd.
#
# This test does not grep the unit file for a string: it runs the real,
# installed alert script against a real local HTTP receiver and asserts the
# receiver gets exactly one well-formed request with the fields the pager
# depends on. No Docker, no network beyond loopback, no root.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ALERT_SCRIPT="$ROOT/scripts/stage/fusion-watchdog-supervisor-failed-alert.sh"

bash -n "$ALERT_SCRIPT"
command -v jq >/dev/null || { echo "test-fusion-watchdog-supervisor-failed-alert: jq required" >&2; exit 64; }
command -v python3 >/dev/null || { echo "test-fusion-watchdog-supervisor-failed-alert: python3 required" >&2; exit 64; }
command -v curl >/dev/null || { echo "test-fusion-watchdog-supervisor-failed-alert: curl required" >&2; exit 64; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/fusion-watchdog-failed-alert-test.XXXXXX")"
srv_pid=""
cleanup() { [[ -n "$srv_pid" ]] && kill "$srv_pid" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

# Tiny receiver: records method, content-type, and body of every request it
# gets, one JSON line per request, to $WORK/requests.jsonl. Always answers 200.
cat >"$WORK/receiver.py" <<'PY'
import http.server
import json
import sys
import threading

OUT = sys.argv[1]
PORT = int(sys.argv[2])
lock = threading.Lock()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        body = self.rfile.read(length).decode("utf-8", "replace")
        record = {
            "path": self.path,
            "content_type": self.headers.get("content-type", ""),
            "body": body,
        }
        with lock:
            with open(OUT, "a") as f:
                f.write(json.dumps(record) + "\n")
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *a):
        pass


http.server.HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
PY

PORT=8971
: >"$WORK/requests.jsonl"
python3 "$WORK/receiver.py" "$WORK/requests.jsonl" "$PORT" &
srv_pid=$!

ready=0
for _ in $(seq 1 50); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    exec 3>&- 3<&-
    ready=1
    break
  fi
  sleep 0.1
done
[[ "$ready" -eq 1 ]] || { echo "test-fusion-watchdog-supervisor-failed-alert: receiver never came up" >&2; exit 1; }

fail=0
check() {
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc" >&2; fail=1; fi
}

echo "case: the OnFailure alert script posts one well-formed page"
rc=0
env -i PATH="$PATH" \
  WATCHDOG_ALERT_WEBHOOK="http://127.0.0.1:$PORT/hook" \
  WATCHDOG_CHAIN_ID=918453 \
  bash "$ALERT_SCRIPT" || rc=$?
check "script exits 0" test "$rc" -eq 0
check "receiver got exactly one request" test "$(wc -l <"$WORK/requests.jsonl" | tr -d ' ')" -eq 1

body="$(jq -r '.body' "$WORK/requests.jsonl")"
check "posted to the configured webhook path" bash -c "jq -r '.path' '$WORK/requests.jsonl' | grep -qx /hook"
check "content-type is application/json" bash -c "jq -r '.content_type' '$WORK/requests.jsonl' | grep -qi '^application/json'"
check "body is valid JSON" bash -c "jq -e . >/dev/null 2>&1 <<<'$body'"
check "kind is watchdog_supervisor_failed" bash -c "jq -e '.kind == \"watchdog_supervisor_failed\"' >/dev/null 2>&1 <<<'$body'"
check "chain_id round-tripped as the number 918453, not split off as a URL host" \
  bash -c "jq -e '.chain_id == 918453' >/dev/null 2>&1 <<<'$body'"
check "source is fusion-watchdog-failed" bash -c "jq -e '.source == \"fusion-watchdog-failed\"' >/dev/null 2>&1 <<<'$body'"
check "detail explains systemd gave up restarting the supervisor" \
  bash -c "jq -r '.detail' <<<'$body' | grep -q 'systemd stopped restarting it'"

echo "case: missing webhook is a safe no-op, not a crash"
: >"$WORK/requests.jsonl"
rc=0
env -i PATH="$PATH" WATCHDOG_CHAIN_ID=918453 bash "$ALERT_SCRIPT" || rc=$?
check "exits 0 with no webhook configured" test "$rc" -eq 0
check "no request was sent" test "$(wc -l <"$WORK/requests.jsonl" | tr -d ' ')" -eq 0

echo "case: a failed delivery is a failed script, not a swallowed error"
rc=0
env -i PATH="$PATH" \
  WATCHDOG_ALERT_WEBHOOK="http://127.0.0.1:1/unreachable" \
  WATCHDOG_CHAIN_ID=918453 \
  bash "$ALERT_SCRIPT" || rc=$?
check "script exits non-zero when the POST fails" test "$rc" -ne 0

if [[ "$fail" -ne 0 ]]; then
  echo "fusion watchdog failed-alert script test: FAIL" >&2
  exit 1
fi
echo "fusion watchdog failed-alert script test: PASS"
