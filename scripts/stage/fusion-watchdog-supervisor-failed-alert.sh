#!/usr/bin/env bash
# ExecStart= target for fusion-watchdog-failed.service (issue #1378 review).
#
# This used to be an inline `curl` command with a hand-quoted JSON payload
# written directly into ExecStart=. systemd un-escapes `\"` sequences in a
# unit file's ExecStart= line before exec'ing the command, so the shell that
# ran it saw an unquoted, whitespace-split argument instead of one JSON
# string: curl tried to resolve a stray word from the split payload as a
# hostname and failed with "Could not resolve host". Because that command
# line ended in `|| true`, systemd logged "Finished" and the failure was
# invisible -- the exact "watchdog dies silently" failure mode issue #1378
# exists to close, reproduced in the pager meant to catch it.
#
# Fix: build the payload out-of-line with `jq -n` (each field passed as a
# --arg/--argjson, never string-interpolated into a command line) and let a
# real shell script own quoting end to end.
#
# Reads the same environment fusion-watchdog-supervisor.sh's page() does,
# both populated by /etc/fusion-watchdog.env via EnvironmentFile=:
#   WATCHDOG_ALERT_WEBHOOK (required to actually send; a missing webhook is a
#   safe no-op, not a crash -- the installer already refuses to install
#   without it, but this script must not explode if invoked by hand)
#   WATCHDOG_CHAIN_ID (optional, defaults to 0)
#
# Installed by scripts/stage/install-fusion-watchdog.sh.
# Tested by scripts/stage/tests/test-fusion-watchdog-supervisor-failed-alert.sh.
set -euo pipefail

if [[ -z "${WATCHDOG_ALERT_WEBHOOK:-}" ]]; then
  echo "fusion-watchdog-supervisor-failed-alert: WATCHDOG_ALERT_WEBHOOK not set; nothing to page" >&2
  exit 0
fi

chain_id="${WATCHDOG_CHAIN_ID:-0}"

payload="$(jq -n \
  --arg kind "watchdog_supervisor_failed" \
  --argjson chain_id "$chain_id" \
  --arg source "fusion-watchdog-failed" \
  --arg detail "fusion-watchdog.service failed; systemd stopped restarting it" \
  '{kind: $kind, chain_id: $chain_id, source: $source, detail: $detail}')"

# Deliberately not `|| true`: a failed page here should surface as a failed
# unit in `systemctl status`/the journal, not be swallowed the way the bug
# this replaces swallowed it.
curl --fail --silent --show-error --max-time 15 \
  -H 'content-type: application/json' \
  --data "$payload" \
  "$WATCHDOG_ALERT_WEBHOOK" >/dev/null
