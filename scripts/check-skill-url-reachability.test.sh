#!/usr/bin/env bash
# check-skill-url-reachability.test.sh — HTTP fixture test for
# scripts/check-skill-url-reachability.sh (robotmoney-core#1888).
#
# Canonical: scripts/check-skill-url-reachability.sh (COMPATIBILITY MAPPING).
#
# WHAT IT ASSERTS, with a local fixture HTTP server (no external network):
#   1. mapping: committee stub served (200) and legacy swarm path absent (404)
#      passes;
#   2. the committee stub answering 404 is a hard failure, never a skip;
#   3. the legacy swarm path answering 200 is a hard failure (plugin crept back);
#   4. any other unexpected status (403) on either path is a hard failure;
#   5. an unreachable server is a hard failure;
#   6. a missing curl is a hard failure that names the prerequisite;
#   7. FRONTEND_SKILL_URL serving the committee stub bytes passes, and serving
#      different bytes or 404 fails.
#
# LOUD FAILURE, NEVER SILENT SKIP: python3 and bash are hard prerequisites. The
# last line is SKILL_URL_FIXTURE_TESTS_EXECUTED=<n>, and the script exits
# non-zero when n is below the floor.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/check-skill-url-reachability.sh"
STUB_REL="plugins/robotmoney-committee/skills/robotmoney-committee/SKILL.md"
SWARM_REL="plugins/robotmoney-swarm/skills/robotmoney-swarm/SKILL.md"
MIN_EXPECTED=27

if ! command -v python3 >/dev/null 2>&1; then
  echo "FATAL: python3 is required for the fixture server; refusing to skip." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "FATAL: curl is required to run the monitored script; refusing to skip." >&2
  exit 1
fi
[[ -f "$SCRIPT" ]] || { echo "FATAL: $SCRIPT is missing" >&2; exit 1; }
[[ -f "$REPO_ROOT/$STUB_REL" ]] || { echo "FATAL: committee stub $STUB_REL is missing" >&2; exit 1; }

TMP="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "PASS: $1"; }
fail() { FAILED=$((FAILED + 1)); echo "FAIL: $1" >&2; }

# Server: serves files under DOCROOT; a missing file is 404; a sibling file
# named "<file>.status" (or "<dir>/<name>.status" for a missing file) forces
# that status code.
cat >"$TMP/server.py" <<'PYEOF'
import http.server
import os
import sys

root, portfile = sys.argv[1], sys.argv[2]

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        rel = self.path.split("?")[0].lstrip("/")
        path = os.path.join(root, rel)
        forced = path + ".status"
        if os.path.isfile(forced):
            code = int(open(forced).read().strip())
            self.send_response(code)
            self.end_headers()
            return
        if os.path.isfile(path):
            body = open(path, "rb").read()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
with open(portfile, "w") as f:
    f.write(str(srv.server_address[1]))
srv.serve_forever()
PYEOF

DOCROOT="$TMP/docroot"
mkdir -p "$DOCROOT/$(dirname "$STUB_REL")"
cp "$REPO_ROOT/$STUB_REL" "$DOCROOT/$STUB_REL"
mkdir -p "$DOCROOT/frontend"
cp "$REPO_ROOT/$STUB_REL" "$DOCROOT/frontend/legacy-swarm-skill.md"

python3 "$TMP/server.py" "$DOCROOT" "$TMP/port" &
SERVER_PID=$!
for _ in $(seq 1 50); do
  [[ -s "$TMP/port" ]] && break
  sleep 0.1
done
if [[ ! -s "$TMP/port" ]]; then
  echo "FATAL: fixture server did not start" >&2
  exit 1
fi
PORT="$(cat "$TMP/port")"
BASE="http://127.0.0.1:$PORT"

OUT=""
RC=0
run_script() {
  # run_script <extra env assignments...>; sets OUT and RC.
  RC=0
  OUT="$(env RAW_BASE="$BASE" "$@" bash "$SCRIPT" 2>&1)" || RC=$?
}

expect_rc0() {
  if [[ "$RC" -eq 0 ]]; then pass "$1: exits 0"; else fail "$1: expected exit 0, got $RC ($OUT)"; fi
}
expect_rc_nonzero() {
  if [[ "$RC" -ne 0 ]]; then pass "$1: exits non-zero"; else fail "$1: expected non-zero exit, got 0 ($OUT)"; fi
}
expect_out() {
  if grep -qF -- "$2" <<<"$OUT"; then pass "$1: output contains '$2'"; else fail "$1: output lacks '$2' ($OUT)"; fi
}

# 1. mapping: stub 200, legacy swarm 404.
run_script FRONTEND_SKILL_URL=
expect_rc0 "mapping (stub 200, legacy swarm 404)"
expect_out "mapping" "SKILL_URLS_CHECKED=2"
expect_out "mapping" "SKILL_URLS_FAILED=0"
expect_out "mapping" "200 OK   (expected 200)"
expect_out "mapping" "404 OK   (expected 404)"

# 7a. frontend legacy URL serves the stub bytes.
run_script "FRONTEND_SKILL_URL=$BASE/frontend/legacy-swarm-skill.md"
expect_rc0 "frontend mapping to the stub"
expect_out "frontend mapping to the stub" "SKILL_URLS_CHECKED=3"
expect_out "frontend mapping to the stub" "serves the committee stub"

# 7b. frontend legacy URL serves different bytes.
echo "not the stub" >"$DOCROOT/frontend/other.md"
run_script "FRONTEND_SKILL_URL=$BASE/frontend/other.md"
expect_rc_nonzero "frontend serving different bytes"
expect_out "frontend serving different bytes" "does not serve the committee stub"

# 7c. frontend legacy URL 404s.
run_script "FRONTEND_SKILL_URL=$BASE/frontend/missing.md"
expect_rc_nonzero "frontend legacy URL 404"
expect_out "frontend legacy URL 404" "SKILL_URLS_FAILED=1"

# 3. legacy swarm path answers 200 (the plugin crept back).
mkdir -p "$DOCROOT/$(dirname "$SWARM_REL")"
cp "$REPO_ROOT/$STUB_REL" "$DOCROOT/$SWARM_REL"
run_script FRONTEND_SKILL_URL=
expect_rc_nonzero "legacy swarm path answering 200"
expect_out "legacy swarm path answering 200" "SKILL_URLS_FAILED=1"
rm "$DOCROOT/$SWARM_REL"

# 4a. legacy swarm path answers 403 (not the expected 404).
echo 403 >"$DOCROOT/$SWARM_REL.status"
run_script FRONTEND_SKILL_URL=
expect_rc_nonzero "legacy swarm path answering 403"
expect_out "legacy swarm path answering 403" "SKILL_URLS_FAILED=1"
rm "$DOCROOT/$SWARM_REL.status"

# 4b. committee stub answers 403.
echo 403 >"$DOCROOT/$STUB_REL.status"
run_script FRONTEND_SKILL_URL=
expect_rc_nonzero "committee stub answering 403"
expect_out "committee stub answering 403" "SKILL_URLS_FAILED=1"
rm "$DOCROOT/$STUB_REL.status"

# 2. committee stub is gone: an unexpected 404 is a hard failure.
mv "$DOCROOT/$STUB_REL" "$TMP/stub.bak"
run_script FRONTEND_SKILL_URL=
expect_rc_nonzero "committee stub 404"
expect_out "committee stub 404" "SKILL_URLS_FAILED=1"
expect_out "committee stub 404" "expected 200"
mv "$TMP/stub.bak" "$DOCROOT/$STUB_REL"

# 5. unreachable server: both paths fail (000 matches neither 200 nor 404).
RC=0
OUT="$(RAW_BASE="http://127.0.0.1:1" FRONTEND_SKILL_URL= bash "$SCRIPT" 2>&1)" || RC=$?
expect_rc_nonzero "unreachable server"
expect_out "unreachable server" "SKILL_URLS_FAILED=2"

# 6. missing curl: PATH holds only an empty directory, bash is invoked by path.
mkdir -p "$TMP/emptybin"
BASH_BIN="$(command -v bash)"
RC=0
OUT="$(PATH="$TMP/emptybin" RAW_BASE="$BASE" "$BASH_BIN" "$SCRIPT" 2>&1)" || RC=$?
expect_rc_nonzero "missing curl"
expect_out "missing curl" "curl is not installed"
if grep -q "SKILL_URLS_CHECKED" <<<"$OUT"; then
  fail "missing curl: script went on to check URLs instead of stopping"
else
  pass "missing curl: script stopped before checking any URL"
fi

# The real script's SKILL_PATHS must keep the decided mapping.
if grep -qF "\"200 \$COMMITTEE_STUB\"" "$SCRIPT" && grep -qF "\"404 \$LEGACY_SWARM\"" "$SCRIPT"; then
  pass "script SKILL_PATHS records the decided mapping"
else
  fail "script SKILL_PATHS no longer records the decided mapping"
fi

EXECUTED=$((PASSED + FAILED))
echo ""
echo "=== skill-url fixture tests: $PASSED passed, $FAILED failed ==="
echo "SKILL_URL_FIXTURE_TESTS_EXECUTED=$EXECUTED"

if [[ "$EXECUTED" -lt "$MIN_EXPECTED" ]]; then
  echo "FATAL: only $EXECUTED assertions executed, expected >= $MIN_EXPECTED" >&2
  exit 1
fi
[[ "$FAILED" -eq 0 ]]
