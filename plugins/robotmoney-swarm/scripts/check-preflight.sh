#!/usr/bin/env bash
# check-preflight.sh — preflight guards before rmpc committee vote-submit.
#
# Canonical docs: plugins/robotmoney-swarm/skills/robotmoney-swarm/SKILL.md
#
# Runs three preflight guards in order, aborting before any on-chain write:
#   1. MissingICConfig   — ic_policy_address absent from the rmpc TOML config
#   2. RationaleURIUnreachable — the rationale_uri is not reachable (HTTP error)
#   3. AgentNotRegistered — the agent does not hold COMMITTEE_AGENT_ROLE on the
#      IC policy, read with `rmpc committee check-agent`
#
# Usage:
#   check-preflight.sh --config <TOML_PATH> --rationale-uri <URI>
#                      [--rmpc <RMPC_PATH>]
#
# Flags:
#   --config <path>        Path to the rmpc TOML config file (required).
#   --rationale-uri <uri>  The rationale_uri that must be reachable (required).
#   --rmpc <path>          Path to the rmpc binary (default: $RMPC, else rmpc
#                          in PATH).
#
# Exit codes:
#   0   All preflight guards passed (safe to call rmpc committee vote-submit).
#   2   MissingICConfig — ic_policy_address not found in config, or not an
#       address.
#   3   RationaleURIUnreachable — URI returned a non-200 or timed out.
#   4   AgentNotRegistered — rmpc read hasRole(COMMITTEE_AGENT_ROLE, agent) as
#       false (rmpc error ErrNotAllowlisted).
#   5   AgentRoleUnreadable — the role could not be read (no rmpc, an rmpc
#       without `committee check-agent`, RPC down, wrong chain). The write is
#       blocked: an unread role is never treated as registered.
#   1   Usage or unexpected error.
#
# Review finding DR-1 (docs/development/qa-plan-v1.md, task U1). This script
# used to grep `ic_contract_address`, a key rmpc does not have (rmpc reads
# `ic_policy_address`, clients/rust-payment-client/src/config.rs), so every
# real config aborted at guard 1. Guard 3 ran `vote-submit --dry-run`, a flag
# that does not exist, and grepped `AgentNotRegistered`, an error rmpc never
# prints (it prints ErrNotAllowlisted); it skipped itself when rmpc was absent.
# So guard 3 passed for every agent. It is now a real role read, and every
# outcome but "role held" stops the write.

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

# Read ic_policy_address the way rmpc does (no toml parser required): a
# top-level key, so the scan stops at the first [table] header. Comment lines
# never match; quotes and a trailing comment are stripped from the value.
IC_ADDR=$(awk '
  /^[ \t]*\[/ { exit }
  /^[ \t]*ic_policy_address[ \t]*=/ {
    sub(/^[^=]*=[ \t]*/, "")
    sub(/[ \t]*#.*$/, "")
    gsub(/"/, "")
    sub(/[ \t\r]+$/, "")
    print
    exit
  }' "$CONFIG_PATH")

if [[ -z "$IC_ADDR" ]]; then
  echo "check-preflight.sh: MissingICConfig — ic_policy_address is absent from $CONFIG_PATH" >&2
  exit 2
fi

if [[ ! "$IC_ADDR" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "check-preflight.sh: MissingICConfig — ic_policy_address in $CONFIG_PATH is not a 0x-prefixed 20-byte address: $IC_ADDR" >&2
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

# ---------- guard 3: AgentNotRegistered (hasRole read) ----------

# `rmpc committee check-agent` reads hasRole(COMMITTEE_AGENT_ROLE(), agent) on
# ic_policy_address at one block. The agent is the keystore's cleartext
# address, the one vote-submit signs as. It signs nothing and needs no
# passphrase. Its exit codes: 0 role held, 2 ErrNotAllowlisted, 3 not read.
# Only a 0 that reports has_role:true lets the write through.
if ! command -v "$RMPC_BIN" &>/dev/null; then
  echo "check-preflight.sh: AgentRoleUnreadable — rmpc not found at '$RMPC_BIN', so COMMITTEE_AGENT_ROLE cannot be read; refusing to continue" >&2
  exit 5
fi

set +e
RMPC_OUTPUT=$("$RMPC_BIN" committee --config "$CONFIG_PATH" check-agent 2>&1)
RMPC_EXIT=$?
set -e

if [[ $RMPC_EXIT -eq 0 ]] && grep -Eq '"has_role":[[:space:]]*true' <<<"$RMPC_OUTPUT"; then
  :
elif [[ $RMPC_EXIT -eq 2 ]] && grep -Eq '"error":[[:space:]]*"ErrNotAllowlisted"' <<<"$RMPC_OUTPUT"; then
  echo "check-preflight.sh: AgentNotRegistered — the configured signing address does not hold COMMITTEE_AGENT_ROLE on the IC policy $IC_ADDR" >&2
  echo "$RMPC_OUTPUT" >&2
  exit 4
else
  echo "check-preflight.sh: AgentRoleUnreadable — rmpc committee check-agent exited $RMPC_EXIT with no role answer; refusing to submit without one" >&2
  if grep -q "unrecognized subcommand" <<<"$RMPC_OUTPUT"; then
    echo "check-preflight.sh: this rmpc predates 'committee check-agent'; install a current one with scripts/release/install-rmpc.sh" >&2
  fi
  echo "$RMPC_OUTPUT" >&2
  exit 5
fi

# ---------- all guards passed ----------

echo "check-preflight.sh: all preflight guards passed"
exit 0
