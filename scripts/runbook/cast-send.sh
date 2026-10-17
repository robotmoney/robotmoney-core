#!/usr/bin/env bash
# scripts/runbook/cast-send.sh: `cast send` for the contract QA runbook (docs/runbooks/contract-qa/), failing on a mined revert.
#   bash scripts/runbook/cast-send.sh <cast send arguments>
# `cast send` with --gas-limit skips the estimate, so a reverting call is mined with status 0 and cast still exits 0. This wrapper asks
# for the JSON receipt and exits 1 unless its status is 0x1. A send cast refuses itself (a failed estimate) keeps cast's exit code.
set -uo pipefail
out="$(cast send "$@" --json)" || exit $?
printf '%s\n' "$out"
status="$(printf '%s' "$out" | jq -r '.status // empty' 2>/dev/null)"
if [ "$status" != "0x1" ]; then
  echo "cast-send: the transaction was mined with status ${status:-unknown}, not 0x1" >&2
  exit 1
fi
