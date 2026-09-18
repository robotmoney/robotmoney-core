#!/usr/bin/env bash
# Supervise the Fusion watchdog process and page when it is alive but has
# stopped advancing behind an advancing indexer.  systemd alone covers a dead
# PID; it cannot distinguish that from a live process stuck on an RPC/DB call.
#
# Required environment is deliberately supplied by a systemd EnvironmentFile,
# never interpolated into this script or a command line:
#   WATCHDOG_BIN, WATCHDOG_CONFIG, WATCHDOG_DATABASE_URL,
#   WATCHDOG_CHAIN_ID, WATCHDOG_ALERT_WEBHOOK
set -euo pipefail

: "${WATCHDOG_BIN:?missing WATCHDOG_BIN}"
: "${WATCHDOG_CONFIG:?missing WATCHDOG_CONFIG}"
: "${WATCHDOG_DATABASE_URL:?missing WATCHDOG_DATABASE_URL}"
: "${WATCHDOG_CHAIN_ID:?missing WATCHDOG_CHAIN_ID}"
: "${WATCHDOG_ALERT_WEBHOOK:?missing WATCHDOG_ALERT_WEBHOOK}"

POLL_SECS="${WATCHDOG_POLL_INTERVAL_SECS:-12}"
STALE_SECS="${WATCHDOG_CURSOR_STALE_SECS:-180}"
RESTART_SECS="${WATCHDOG_RESTART_SECS:-5}"

[[ "$POLL_SECS" =~ ^[1-9][0-9]*$ && "$STALE_SECS" =~ ^[1-9][0-9]*$ && "$RESTART_SECS" =~ ^[1-9][0-9]*$ ]] || {
  echo "fusion-watchdog-supervisor: interval values must be positive integers" >&2; exit 64;
}

child=""
stop() { [[ -n "$child" ]] && kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; exit 0; }
trap stop INT TERM

page() {
  # Never print the webhook response: it may include receiver diagnostics.
  curl --fail --silent --show-error --max-time 15 -H 'content-type: application/json' \
    --data "{\"kind\":\"watchdog_cursor_stale\",\"chain_id\":${WATCHDOG_CHAIN_ID},\"source\":\"fusion-watchdog-supervisor\",\"detail\":\"indexer is ahead of watchdog cursor for at least ${STALE_SECS}s\"}" \
    "$WATCHDOG_ALERT_WEBHOOK" >/dev/null || echo "fusion-watchdog-supervisor: stale-cursor page delivery failed" >&2
}

cursor_stale() {
  # A stopped indexer is not a watchdog-cursor incident. Page only when its
  # successful head is ahead AND watchdog_cursor has failed to advance long
  # enough. Missing cursor is stale once an indexed head exists.
  psql "$WATCHDOG_DATABASE_URL" -XAtv ON_ERROR_STOP=1 -c "
    WITH h AS (
      SELECT max(last_indexed_block) AS head FROM indexer_runs
       WHERE chain_id = ${WATCHDOG_CHAIN_ID} AND error IS NULL
    ), c AS (
      SELECT last_processed_block, updated_at FROM watchdog_cursor
       WHERE chain_id = ${WATCHDOG_CHAIN_ID}
    )
    SELECT CASE WHEN h.head IS NOT NULL AND (c.last_processed_block IS NULL OR c.last_processed_block < h.head)
                      AND (c.updated_at IS NULL OR c.updated_at < now() - interval '${STALE_SECS} seconds')
                THEN 'stale' ELSE 'ok' END FROM h LEFT JOIN c ON true;" 2>/dev/null | grep -qx stale
}

while true; do
  "$WATCHDOG_BIN" --config "$WATCHDOG_CONFIG" --chain-id "$WATCHDOG_CHAIN_ID" --poll-interval-secs "$POLL_SECS" &
  child="$!"
  while kill -0 "$child" 2>/dev/null; do
    sleep "$POLL_SECS"
    if cursor_stale; then page; fi
  done
  wait "$child" || true
  echo "fusion-watchdog-supervisor: watchdog exited; restarting in ${RESTART_SECS}s" >&2
  child=""
  sleep "$RESTART_SECS"
done
