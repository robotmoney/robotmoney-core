#!/usr/bin/env bash
# Supervise the Fusion watchdog process and page when it is not proving that it
# is watching (issue #1378). systemd alone covers a dead supervisor PID; it
# cannot tell a quiet market from a watchdog that is crash-looping, hung on an
# RPC/DB call, or exited at startup on an invalid pauser key -- all of which
# are silent by construction, because the watchdog's healthy output in a calm
# market is no output at all.
#
# Two independent signals, both evaluated every POLL_SECS whether or not the
# child is currently alive (a child that exits within one poll used to be
# restarted forever without ever being checked):
#   - watchdog_exited      the child exited; paged immediately with its status.
#   - watchdog_cursor_stale `watchdog-liveness` exit 1: watchdog_cursor.updated_at
#                          (refreshed by every successful poll, quiet or not) is
#                          older than STALE_SECS, or there is no cursor at all.
#   - watchdog_liveness_unknown  any other non-zero exit: DB unreachable, bad
#                          arguments, or the checker binary is missing. Unknown
#                          is paged, never read as health.
# Each kind pages at most once per STALE_SECS so a crash loop is one page per
# window, not one per restart.
#
# Canonical: docs/architecture.md §5.6; runbook docs/operations/watchdog-liveness.md.
# Tested by scripts/stage/test-fusion-watchdog-supervisor.sh (suite 20).
#
# Required environment is deliberately supplied by a systemd EnvironmentFile,
# never interpolated into this script or a command line (both the watchdog and
# watchdog-liveness read WATCHDOG_DATABASE_URL from the environment):
#   WATCHDOG_BIN, WATCHDOG_CONFIG, WATCHDOG_DATABASE_URL,
#   WATCHDOG_CHAIN_ID, WATCHDOG_ALERT_WEBHOOK
# Optional:
#   WATCHDOG_LIVENESS_BIN (default: watchdog-liveness beside WATCHDOG_BIN),
#   WATCHDOG_POLL_INTERVAL_SECS (12), WATCHDOG_CURSOR_STALE_SECS (180),
#   WATCHDOG_RESTART_SECS (5)
set -euo pipefail

: "${WATCHDOG_BIN:?missing WATCHDOG_BIN}"
: "${WATCHDOG_CONFIG:?missing WATCHDOG_CONFIG}"
: "${WATCHDOG_DATABASE_URL:?missing WATCHDOG_DATABASE_URL}"
: "${WATCHDOG_CHAIN_ID:?missing WATCHDOG_CHAIN_ID}"
: "${WATCHDOG_ALERT_WEBHOOK:?missing WATCHDOG_ALERT_WEBHOOK}"
export WATCHDOG_DATABASE_URL

LIVENESS_BIN="${WATCHDOG_LIVENESS_BIN:-$(dirname "$WATCHDOG_BIN")/watchdog-liveness}"
POLL_SECS="${WATCHDOG_POLL_INTERVAL_SECS:-12}"
STALE_SECS="${WATCHDOG_CURSOR_STALE_SECS:-180}"
RESTART_SECS="${WATCHDOG_RESTART_SECS:-5}"

[[ "$POLL_SECS" =~ ^[1-9][0-9]*$ && "$STALE_SECS" =~ ^[1-9][0-9]*$ && "$RESTART_SECS" =~ ^[1-9][0-9]*$ ]] || {
  echo "fusion-watchdog-supervisor: interval values must be positive integers" >&2; exit 64;
}
[[ "$WATCHDOG_CHAIN_ID" =~ ^[1-9][0-9]*$ ]] || {
  echo "fusion-watchdog-supervisor: WATCHDOG_CHAIN_ID must be a positive integer" >&2; exit 64;
}

child=""
sleeper=""
stop() {
  [[ -n "$sleeper" ]] && kill "$sleeper" 2>/dev/null || true
  [[ -n "$child" ]] && kill "$child" 2>/dev/null || true
  [[ -n "$child" ]] && wait "$child" 2>/dev/null || true
  exit 0
}
trap stop INT TERM

declare -A last_paged=()
page() {
  local kind="$1" detail="$2" now
  now="$(date +%s)"
  if [[ -n "${last_paged[$kind]:-}" ]] && (( now - ${last_paged[$kind]} < STALE_SECS )); then
    return 0
  fi
  last_paged[$kind]="$now"
  # The detail is JSON-embedded: keep it to a safe character set and bounded.
  detail="$(printf '%s' "$detail" | tr -c 'A-Za-z0-9 _.:=,/()-' ' ' | cut -c1-240)"
  echo "fusion-watchdog-supervisor: paging ${kind}: ${detail}" >&2
  # Never print the webhook response: it may include receiver diagnostics.
  curl --fail --silent --show-error --max-time 15 -H 'content-type: application/json' \
    --data "{\"kind\":\"${kind}\",\"chain_id\":${WATCHDOG_CHAIN_ID},\"source\":\"fusion-watchdog-supervisor\",\"detail\":\"${detail}\"}" \
    "$WATCHDOG_ALERT_WEBHOOK" >/dev/null || echo "fusion-watchdog-supervisor: ${kind} page delivery failed" >&2
}

check_liveness() {
  local out rc=0
  out="$("$LIVENESS_BIN" --chain-id "$WATCHDOG_CHAIN_ID" --max-age-secs "$STALE_SECS" 2>&1)" || rc=$?
  case "$rc" in
    0) ;;
    1) page watchdog_cursor_stale "${out:-watchdog liveness stale}" ;;
    *) page watchdog_liveness_unknown "rc=${rc} ${out:-no output from ${LIVENESS_BIN}}" ;;
  esac
}

start_child() {
  "$WATCHDOG_BIN" --config "$WATCHDOG_CONFIG" --chain-id "$WATCHDOG_CHAIN_ID" --poll-interval-secs "$POLL_SECS" &
  child="$!"
}

# The first check waits one staleness window: a supervisor (re)start after a
# long outage must give the new child time to poll before judging the cursor.
# A child that dies at startup is still paged immediately as watchdog_exited.
supervisor_started="$(date +%s)"
restart_at=0
start_child
while true; do
  sleep "$POLL_SECS" & sleeper="$!"; wait "$sleeper" || true; sleeper=""
  now="$(date +%s)"

  if [[ -n "$child" ]] && ! kill -0 "$child" 2>/dev/null; then
    status=0; wait "$child" || status=$?
    child=""
    restart_at=$(( now + RESTART_SECS ))
    echo "fusion-watchdog-supervisor: watchdog exited with status ${status}; restarting in ${RESTART_SECS}s" >&2
    page watchdog_exited "watchdog exited with status ${status}; supervisor restarting it"
  fi
  # Judge liveness BEFORE restarting: a child that died during this poll must
  # be checked in its dead state, not masked by a replacement that has not had
  # a chance to fail yet.
  if (( now - supervisor_started >= STALE_SECS )); then
    check_liveness
  fi

  if [[ -z "$child" ]] && (( now >= restart_at )); then
    start_child
  fi
done
