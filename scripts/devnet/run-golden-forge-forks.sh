#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
STATE="$ROOT/testing/fixtures/fork-state/CURRENT.anvil-state"
RESULTS="$(mktemp)"
ANVIL_LOG="$(mktemp)"

cleanup() {
  if [[ -n "${ANVIL_PID:-}" ]]; then kill "$ANVIL_PID" 2>/dev/null || true; fi
  rm -f "$RESULTS" "$ANVIL_LOG"
}
trap cleanup EXIT

[[ -s "$STATE" ]] || { echo "fork fixture missing or empty: $STATE" >&2; exit 1; }
"$ROOT/scripts/devnet/check-fork-manifest.sh"

anvil --load-state "$STATE" --host 127.0.0.1 --port 8545 --silent >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 60); do
  cast block-number --rpc-url http://127.0.0.1:8545 >/dev/null 2>&1 && break
  kill -0 "$ANVIL_PID" 2>/dev/null || { cat "$ANVIL_LOG" >&2; exit 1; }
  sleep 1
done
cast block-number --rpc-url http://127.0.0.1:8545 >/dev/null

unset FORK_RPC_URL RMPC_FORK_RPC_URL
if ! forge test --json "$@" >"$RESULTS"; then
  jq . "$RESULTS" >&2 || cat "$RESULTS" >&2
  exit 1
fi
COUNT="$(jq '[.. | objects | select(has("status"))] | length' "$RESULTS")"
[[ "$COUNT" -gt 0 ]] || { echo "zero fork tests executed" >&2; cat "$RESULTS" >&2; exit 1; }
echo "executed $COUNT fork tests"
