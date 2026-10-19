#!/usr/bin/env bash
# scripts/runbook/cast-send.sh: `cast send` for the contract QA runbook (docs/runbooks/contract-qa/), failing on a mined revert.
#   bash scripts/runbook/cast-send.sh <cast send arguments>
# `cast send` with --gas-limit skips the estimate, so a reverting call is mined with status 0 and cast still exits 0. This wrapper asks
# for the JSON receipt and exits 1 unless its status is 0x1. A send cast refuses itself (a failed estimate) keeps cast's exit code.
# With --json, cast writes that refusal (e.g. "insufficient funds") to stdout, so the wrapper repeats it on stderr before it exits.
# After a mined send it waits until the RPC reads the receipt's block on three reads in a row: a load-balanced RPC (mainnet.base.org) can answer
# the step's next read from a node behind the send (Deploy 3 P6.10 read 0 shares right after its deposit was mined).
set -uo pipefail
out="$(cast send "$@" --json)"
rc=$?
if [ "$rc" -ne 0 ]; then
  [ -n "$out" ] && printf '%s\n' "$out" >&2
  echo "cast-send: cast send exited $rc" >&2
  exit "$rc"
fi
printf '%s\n' "$out"
status="$(printf '%s' "$out" | jq -r '.status // empty' 2>/dev/null)"
if [ "$status" != "0x1" ]; then
  echo "cast-send: the transaction was mined with status ${status:-unknown}, not 0x1" >&2
  exit 1
fi
block="$(printf '%s' "$out" | jq -r '.blockNumber // empty' 2>/dev/null)"
[ -n "$block" ] || exit 0
rpc=()
prev=""
for a in "$@"; do { [ "$prev" = "--rpc-url" ] || [ "$prev" = "-r" ]; } && rpc=(--rpc-url "$a"); prev="$a"; done
want=$((block)); seen=0
for _ in $(seq 1 60); do
  head="$(cast block-number "${rpc[@]}" 2>/dev/null)"
  if [ -n "$head" ] && [ "$head" -ge "$want" ]; then seen=$((seen + 1)); [ "$seen" -ge 3 ] && exit 0; else seen=0; fi
  sleep 1
done
echo "cast-send: the RPC did not read block $want three times in a row within 60 s of the receipt" >&2
exit 1
