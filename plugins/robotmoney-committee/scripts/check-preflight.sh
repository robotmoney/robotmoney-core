#!/usr/bin/env bash
# check-preflight.sh — preflight guards before rmpc committee vote-submit.
#
# Canonical docs: plugins/robotmoney-committee/skills/robotmoney-committee/SKILL.md
#
# Runs three preflight guards in order, aborting before any on-chain write:
#   1. MissingICConfig   — ic_contract_address absent from the rmpc TOML config
#   2. RationaleURIUnreachable — the rationale_uri is not reachable (HTTP error)
#   3. AgentNotRegistered — rmpc returns that error on vote-submit
#
# Usage:
#   check-preflight.sh --config <TOML_PATH> --rationale-uri <URI>
#                      [--rmpc <RMPC_PATH>]
#
# Flags:
#   --config <path>        Path to the rmpc TOML config file (required).
#   --rationale-uri <uri>  The rationale_uri that must be reachable (required).
#   --rmpc <path>          Path to the rmpc binary (default: rmpc in PATH).
#
# Exit codes:
#   0   All preflight guards passed (safe to call rmpc committee vote-submit).
#   2   MissingICConfig — ic_contract_address not found in config.
#   3   RationaleURIUnreachable — URI returned a non-200 or timed out.
#   4   AgentNotRegistered — rmpc returned AgentNotRegistered (from dry-run).
#   1   Usage or unexpected error.
#
# Guard 3 (AgentNotRegistered) is checked via a dry-run invocation of
# rmpc committee vote-submit with --dry-run. If rmpc does not support --dry-run,
# that guard is skipped and the error surfaces at actual submission time.

set -euo pipefail

# ---------- argument parsing ----------

CONFIG_PATH=""
RATIONALE_URI=""
RMPC_BIN="${RMPC:-rmpc}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config)
      CONFIG_PATH="${2:?--config requires a path}"
      shift 2
      ;;
    --rationale-uri)
      RATIONALE_URI="${2:?--rationale-uri requires a URI}"
      shift 2
      ;;
    --rmpc)
      RMPC_BIN="${2:?--rmpc requires a path}"
      shift 2
      ;;
    *)
      echo "check-preflight.sh: unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$CONFIG_PATH" ]]; then
  echo "check-preflight.sh: --config is required" >&2
  exit 1
fi

if [[ -z "$RATIONALE_URI" ]]; then
  echo "check-preflight.sh: --rationale-uri is required" >&2
  exit 1
fi

# ---------- guard 1: MissingICConfig ----------

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "check-preflight.sh: config file not found: $CONFIG_PATH" >&2
  exit 1
fi

# Parse ic_contract_address from the TOML config using grep (no toml parser required).
# Matches: ic_contract_address = "0x..." (with optional whitespace around =)
IC_ADDR=$(grep -E '^\s*ic_contract_address\s*=' "$CONFIG_PATH" \
            | sed -E 's/^\s*ic_contract_address\s*=\s*"?([^"]+)"?\s*$/\1/' \
            | head -1 || true)

if [[ -z "$IC_ADDR" ]]; then
  echo "check-preflight.sh: MissingICConfig — ic_contract_address is absent from $CONFIG_PATH" >&2
  exit 2
fi

# ---------- guard 2: RationaleURIUnreachable ----------

# Use curl to verify the URI returns HTTP 200.
HTTP_STATUS=$(curl --silent --output /dev/null --write-out "%{http_code}" \
                   --max-time 10 --head "$RATIONALE_URI" 2>/dev/null || echo "000")

if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "check-preflight.sh: RationaleURIUnreachable — $RATIONALE_URI returned HTTP $HTTP_STATUS (expected 200)" >&2
  exit 3
fi

# ---------- guard 3: AgentNotRegistered (dry-run) ----------

# Attempt a dry-run to detect AgentNotRegistered before the real write.
# If rmpc is not available or does not support --dry-run, skip this guard.
if command -v "$RMPC_BIN" &>/dev/null; then
  set +e
  RMPC_OUTPUT=$("$RMPC_BIN" committee vote-submit \
    --config "$CONFIG_PATH" \
    --dry-run \
    --pretty 2>&1)
  set -e

  if echo "$RMPC_OUTPUT" | grep -q "AgentNotRegistered"; then
    echo "check-preflight.sh: AgentNotRegistered — the configured signing address is not a registered committee agent" >&2
    echo "$RMPC_OUTPUT" >&2
    exit 4
  fi
fi

# ---------- all guards passed ----------

echo "check-preflight.sh: all preflight guards passed"
exit 0
