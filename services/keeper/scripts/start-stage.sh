#!/usr/bin/env bash
# Canonical: docs/operations/stage-keeper-runbook.md; docs/technical/one-vault-rebalancer-proposal.md §8.1.5.
# Stage launcher for the keeper service (no systemd). Reads the keystore password on stdin, keeps it only in this
# supervisor's memory, and pipes it to the service on stdin. Restarts the service 15 s after any exit except 2
# (bad config). Stops the old keeper script first. The password never touches disk or a command line.
set -u
if [[ "${1:-}" == --run ]]; then
  P="$PW"; unset PW
  cd "$HOME/robotmoney-keeper/services/keeper" || exit 1
  trap 'kill "$child" 2>/dev/null; wait "$child"; exit 0' TERM INT
  while :; do
    printf %s "$P" | bun src/cli.ts --config "$HOME/robotmoney-keeper/keeper.toml" & child=$!
    wait "$child"; rc=$?
    echo "keeper exited rc=$rc at $(date -u +%FT%TZ)"
    [[ $rc == 2 ]] && exit 2
    sleep 15 & wait $!
  done
fi
cd "$HOME/robotmoney-keeper" || exit 1
if pkill -f '^bash onevault-keeper\.sh'; then
  for i in 1 2 3 4 5; do pgrep -f '^bash onevault-keeper' >/dev/null || break; sleep 1; done
  pkill -KILL -f '^bash onevault-keeper\.sh' || true
fi
pkill -f '^bash .*start-service\.sh --run' || true
IFS= read -r PW || [[ -n "${PW:-}" ]] || exit 1
export PW
exec setsid nohup bash "$0" --run >>service.log 2>&1 </dev/null &
