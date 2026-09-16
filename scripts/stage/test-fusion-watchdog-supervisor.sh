#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
bash -n "$ROOT/scripts/stage/fusion-watchdog-supervisor.sh"
bash -n "$ROOT/scripts/stage/install-fusion-watchdog.sh"
grep -q '^Restart=always$' "$ROOT/scripts/stage/fusion-watchdog.service"
grep -q 'watchdog_cursor' "$ROOT/scripts/stage/fusion-watchdog-supervisor.sh"
grep -q 'watchdog_cursor_stale' "$ROOT/scripts/stage/fusion-watchdog-supervisor.sh"
grep -q 'EnvironmentFile=/etc/fusion-watchdog.env' "$ROOT/scripts/stage/fusion-watchdog.service"
echo "fusion watchdog supervisor static checks: PASS"
