#!/usr/bin/env bash
# Static + behavioural tests for the stage watchdog supervisor (issue #1378).
#
# The behavioural cases run the real supervisor script against stub `watchdog`,
# `watchdog-liveness`, and `curl` executables, with one-second intervals, and
# assert on the pages it sends. No Docker, no network, no root. Run by the
# suite-20 watchdog-unit job.
#
#   SUPERVISOR=/path/to/other-supervisor.sh bash scripts/stage/test-fusion-watchdog-supervisor.sh
# runs the behavioural cases against a different supervisor (mutation check).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SUPERVISOR="${SUPERVISOR:-$ROOT/scripts/stage/fusion-watchdog-supervisor.sh}"

# ---- static ----------------------------------------------------------------
bash -n "$ROOT/scripts/stage/fusion-watchdog-supervisor.sh"
bash -n "$ROOT/scripts/stage/install-fusion-watchdog.sh"
grep -q '^Restart=always$' "$ROOT/scripts/stage/fusion-watchdog.service"
grep -q 'EnvironmentFile=/etc/fusion-watchdog.env' "$ROOT/scripts/stage/fusion-watchdog.service"
grep -q 'watchdog-liveness' "$ROOT/scripts/stage/install-fusion-watchdog.sh"
# systemd giving up on the supervisor must page, and the start limit must be in
# [Unit] (systemd ignores StartLimitIntervalSec= under [Service]).
unit_section() { awk -v s="[$2]" '/^\[/{in_s=($0==s)} in_s' "$1"; }
unit_section "$ROOT/scripts/stage/fusion-watchdog.service" Unit | grep -q '^OnFailure=fusion-watchdog-failed.service$'
unit_section "$ROOT/scripts/stage/fusion-watchdog.service" Unit | grep -q '^StartLimitIntervalSec='
unit_section "$ROOT/scripts/stage/fusion-watchdog.service" Unit | grep -q '^StartLimitBurst='
grep -q '^ExecStart=/opt/fusion-stage/fusion-watchdog-supervisor-failed-alert.sh$' "$ROOT/scripts/stage/fusion-watchdog-failed.service"
grep -q 'watchdog_supervisor_failed' "$ROOT/scripts/stage/fusion-watchdog-supervisor-failed-alert.sh"
grep -q 'fusion-watchdog-failed.service' "$ROOT/scripts/stage/install-fusion-watchdog.sh"
grep -q 'fusion-watchdog-supervisor-failed-alert.sh' "$ROOT/scripts/stage/install-fusion-watchdog.sh"
bash -n "$ROOT/scripts/stage/fusion-watchdog-supervisor-failed-alert.sh"
# The OnFailure unit must never again embed a JSON payload in ExecStart=: that
# is the exact defect this file's ExecStart= check above guards against.
! grep -q '"kind"' "$ROOT/scripts/stage/fusion-watchdog-failed.service"
echo "fusion watchdog supervisor static checks: PASS"

# ---- behavioural -----------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fusion-watchdog-supervisor-test.XXXXXX")"
sup_pid=""
cleanup() {
  [[ -n "$sup_pid" ]] && kill "$sup_pid" 2>/dev/null || true
  pkill -f "$WORK/bin/watchdog" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/bin"
# curl stub: record the JSON body of every page, plus a PAGE entry in the
# shared timeline (used by the ordering-mutant case below).
cat >"$WORK/bin/curl" <<'EOF'
#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --data ]]; then
    printf '%s\n' "$2" >>"$STUB_STATE/pages"
    echo "PAGE $(date +%s%N)" >>"$STUB_STATE/timeline"
    shift
  fi
  shift
done
EOF
# watchdog stub: `crash` exits at once every time (invalid-key shape); `run`
# stays up; `crash-once` exits on its first start only, then stays up (used to
# put a liveness check and a restart in the same poll iteration). Every start
# also gets a START entry in the shared timeline.
cat >"$WORK/bin/watchdog" <<'EOF'
#!/usr/bin/env bash
echo "$$ $*" >>"$STUB_STATE/starts"
echo "START $(date +%s%N)" >>"$STUB_STATE/timeline"
mode="$(cat "$STUB_STATE/mode")"
if [[ "$mode" == crash ]]; then exit 1; fi
if [[ "$mode" == crash-once ]]; then
  n=$(( $(cat "$STUB_STATE/start_count" 2>/dev/null || echo 0) + 1 ))
  echo "$n" >"$STUB_STATE/start_count"
  [[ "$n" -eq 1 ]] && exit 1
fi
exec sleep 1000
EOF
# watchdog-liveness stub: exit code comes from a state file.
cat >"$WORK/bin/watchdog-liveness" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$STUB_STATE/liveness_calls"
rc="$(cat "$STUB_STATE/liveness_rc")"
[[ "$rc" == 0 ]] && echo "watchdog liveness healthy" || echo "watchdog liveness stale: age_secs=999" >&2
exit "$rc"
EOF
chmod +x "$WORK/bin/"*

fail=0
count() { [[ -f "$1" ]] && grep -c -- "${2:-}" "$1" || echo 0; }

# run_case NAME MODE LIVENESS_RC SECONDS [extra env...] -> leaves state in $WORK/NAME
run_case() {
  local name="$1" mode="$2" rc="$3" secs="$4"; shift 4
  local st="$WORK/$name"
  mkdir -p "$st"
  echo "$mode" >"$st/mode"; echo "$rc" >"$st/liveness_rc"
  env -i PATH="$WORK/bin:$PATH" HOME="$WORK" STUB_STATE="$st" \
    WATCHDOG_BIN="$WORK/bin/watchdog" WATCHDOG_CONFIG=/dev/null \
    WATCHDOG_DATABASE_URL=postgres://stub WATCHDOG_CHAIN_ID=918453 \
    WATCHDOG_ALERT_WEBHOOK=http://stub.invalid/hook \
    WATCHDOG_POLL_INTERVAL_SECS=1 WATCHDOG_CURSOR_STALE_SECS=3 WATCHDOG_RESTART_SECS=1 \
    "$@" bash "$SUPERVISOR" 2>"$st/stderr" &
  sup_pid="$!"
  sleep "$secs"
  kill -TERM "$sup_pid" 2>/dev/null || true
  wait "$sup_pid" 2>/dev/null || true
  sup_pid=""
}

check() { # check DESCRIPTION CONDITION...
  local desc="$1"; shift
  if "$@"; then echo "  ok   $desc"; else echo "  FAIL $desc" >&2; fail=1; fi
}

echo "case: crash-looping watchdog (exits at startup, no heartbeat)"
run_case crash crash 1 8
st="$WORK/crash"
check "watchdog was restarted (>=2 starts)" test "$(count "$st/starts")" -ge 2
check "exit is paged as watchdog_exited" test "$(count "$st/pages" '"kind":"watchdog_exited"')" -ge 1
check "missing heartbeat is paged as watchdog_cursor_stale" test "$(count "$st/pages" '"kind":"watchdog_cursor_stale"')" -ge 1
check "exit pages are throttled below the restart count" \
  test "$(count "$st/pages" '"kind":"watchdog_exited"')" -lt "$(count "$st/starts")"

echo "case: running watchdog in a quiet market (heartbeat fresh)"
run_case quiet run 0 6
st="$WORK/quiet"
check "no page at all" test "$(count "$st/pages")" -eq 0
check "started exactly once" test "$(count "$st/starts")" -eq 1
check "liveness was actually checked (>=2 calls)" test "$(count "$st/liveness_calls")" -ge 2
check "liveness is checked with the stale window as max age" grep -q -- '--max-age-secs 3' "$st/liveness_calls"
check "database URL never appears on a command line" bash -c "! grep -q 'postgres://' '$st/liveness_calls' '$st/starts'"

echo "case: watchdog alive but heartbeat stale (hung poll loop)"
run_case hung run 1 9
st="$WORK/hung"
check "stale heartbeat is paged" test "$(count "$st/pages" '"kind":"watchdog_cursor_stale"')" -ge 1
check "stale pages are throttled below the check count" \
  test "$(count "$st/pages" '"kind":"watchdog_cursor_stale"')" -lt "$(count "$st/liveness_calls")"
check "a live child is not restarted" test "$(count "$st/starts")" -eq 1
check "page body names the chain" grep -q '"chain_id":918453' "$st/pages"

echo "case: liveness checker missing (never read as healthy)"
run_case nobin run 0 6 WATCHDOG_LIVENESS_BIN="$WORK/bin/does-not-exist"
st="$WORK/nobin"
check "unknown liveness is paged" test "$(count "$st/pages" '"kind":"watchdog_liveness_unknown"')" -ge 1

echo "case: liveness is judged before restarting a child that already died (ordering mutant)"
# supervisor_started=t0; child dies at t0 (crash-once). Iteration at t0+1
# detects the exit and pages watchdog_exited, but is too early for a liveness
# check (STALE_SECS=2) and too early to restart (RESTART_SECS=1 -> restart_at
# = t0+2). Iteration at t0+2 has nothing new to detect (child already ""), so
# it runs ONLY check_liveness (stale -> pages) and then the restart (starts
# the child again, which this time stays up). That iteration is the one that
# proves ordering: the correct supervisor's timeline reads PAGE then START for
# those two events; a mutant that restarts before judging liveness reads
# START then PAGE.
run_case order crash-once 1 4 WATCHDOG_CURSOR_STALE_SECS=2
st="$WORK/order"
check "timeline recorded the initial start, the exit page, the stale page, and the restart" \
  test "$(count "$st/timeline")" -ge 4
line3="$(sed -n '3p' "$st/timeline" | awk '{print $1}')"
line4="$(sed -n '4p' "$st/timeline" | awk '{print $1}')"
check "liveness is checked (PAGE) before the dead child is restarted (START)" \
  bash -c "[[ '$line3' == PAGE && '$line4' == START ]]"

echo "case: SIGTERM stops the child"
run_case term run 0 2
st="$WORK/term"
child_pid="$(awk 'NR==1{print $1}' "$st/starts")"
sleep 0.5
check "child watchdog is gone after supervisor stop" bash -c "! kill -0 '$child_pid' 2>/dev/null"

if [[ "$fail" -ne 0 ]]; then
  echo "fusion watchdog supervisor behavioural checks: FAIL" >&2
  exit 1
fi
echo "fusion watchdog supervisor behavioural checks: PASS"
