#!/usr/bin/env bash
# form-vote.sh — form a committee-vote JSON from regime + vault inputs.
#
# Canonical docs: plugins/robotmoney-committee/skills/robotmoney-committee/SKILL.md
# Vote schema:    schemas/committee-vote.json
#
# Usage:
#   form-vote.sh --regime <REGIME> --vault <ADDR> --current-weight-bps <BPS> \
#                --agent-id <ID> --rationale-uri <URI> \
#                --prompt-hash <0x...64hex> --inputs-digest <0x...64hex>
#
# Outputs a single committee-vote JSON (schema_version 1.0) to stdout.
# Exits 0 on success, 1 on invalid arguments.
#
# Tilt heuristic (published default — operators may replace with proprietary logic):
#   risk_on  → overweight,  current_bps + 1000 (capped 10000), confidence 70
#   neutral  → neutral,     current_bps (unchanged),            confidence 50
#   risk_off → underweight, current_bps - 1000 (floor 0),       confidence 70

set -euo pipefail

# ---------- argument parsing ----------

REGIME=""
VAULT=""
CURRENT_WEIGHT_BPS=""
AGENT_ID=""
RATIONALE_URI=""
PROMPT_HASH=""
INPUTS_DIGEST=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --regime)
      REGIME="${2:?--regime requires a value}"
      shift 2
      ;;
    --vault)
      VAULT="${2:?--vault requires a value}"
      shift 2
      ;;
    --current-weight-bps)
      CURRENT_WEIGHT_BPS="${2:?--current-weight-bps requires a value}"
      shift 2
      ;;
    --agent-id)
      AGENT_ID="${2:?--agent-id requires a value}"
      shift 2
      ;;
    --rationale-uri)
      RATIONALE_URI="${2:?--rationale-uri requires a value}"
      shift 2
      ;;
    --prompt-hash)
      PROMPT_HASH="${2:?--prompt-hash requires a value}"
      shift 2
      ;;
    --inputs-digest)
      INPUTS_DIGEST="${2:?--inputs-digest requires a value}"
      shift 2
      ;;
    *)
      echo "form-vote.sh: unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

# ---------- required-argument validation ----------

for var_name in REGIME VAULT CURRENT_WEIGHT_BPS AGENT_ID RATIONALE_URI PROMPT_HASH INPUTS_DIGEST; do
  if [[ -z "${!var_name}" ]]; then
    echo "form-vote.sh: missing required argument: --$(echo "$var_name" | tr '[:upper:]_' '[:lower:]-' | sed 's/-b-p-s/-bps/g')" >&2
    exit 1
  fi
done

# ---------- regime validation ----------

case "$REGIME" in
  risk_on|neutral|risk_off)
    ;;
  *)
    echo "form-vote.sh: invalid regime '$REGIME'; expected one of: risk_on neutral risk_off" >&2
    exit 1
    ;;
esac

# ---------- vault address validation ----------

if ! [[ "$VAULT" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "form-vote.sh: invalid vault address '$VAULT'; expected 0x-prefixed 20-byte hex" >&2
  exit 1
fi

# ---------- current-weight-bps validation ----------

if ! [[ "$CURRENT_WEIGHT_BPS" =~ ^[0-9]+$ ]] || [[ "$CURRENT_WEIGHT_BPS" -lt 0 ]] || [[ "$CURRENT_WEIGHT_BPS" -gt 10000 ]]; then
  echo "form-vote.sh: invalid current-weight-bps '$CURRENT_WEIGHT_BPS'; expected integer in [0, 10000]" >&2
  exit 1
fi

# ---------- hash format validation ----------

if ! [[ "$PROMPT_HASH" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "form-vote.sh: invalid prompt-hash '$PROMPT_HASH'; expected 0x-prefixed 32-byte hex (64 hex chars)" >&2
  exit 1
fi

if ! [[ "$INPUTS_DIGEST" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "form-vote.sh: invalid inputs-digest '$INPUTS_DIGEST'; expected 0x-prefixed 32-byte hex (64 hex chars)" >&2
  exit 1
fi

# ---------- tilt formation ----------

case "$REGIME" in
  risk_on)
    STANCE="overweight"
    TARGET_WEIGHT_BPS=$(( CURRENT_WEIGHT_BPS + 1000 ))
    [[ $TARGET_WEIGHT_BPS -gt 10000 ]] && TARGET_WEIGHT_BPS=10000
    CONFIDENCE=70
    ;;
  neutral)
    STANCE="neutral"
    TARGET_WEIGHT_BPS="$CURRENT_WEIGHT_BPS"
    CONFIDENCE=50
    ;;
  risk_off)
    STANCE="underweight"
    TARGET_WEIGHT_BPS=$(( CURRENT_WEIGHT_BPS - 1000 ))
    [[ $TARGET_WEIGHT_BPS -lt 0 ]] && TARGET_WEIGHT_BPS=0
    CONFIDENCE=70
    ;;
esac

TIMESTAMP=$(date -u +%s)

# ---------- emit vote JSON ----------

jq -n \
  --arg schema_version "1.0" \
  --arg agent_id "$AGENT_ID" \
  --arg vault "$VAULT" \
  --arg stance "$STANCE" \
  --argjson target_weight_bps "$TARGET_WEIGHT_BPS" \
  --argjson confidence "$CONFIDENCE" \
  --arg rationale_uri "$RATIONALE_URI" \
  --arg prompt_hash "$PROMPT_HASH" \
  --arg inputs_digest "$INPUTS_DIGEST" \
  --argjson timestamp "$TIMESTAMP" \
  '{
    schema_version:    $schema_version,
    agent_id:          $agent_id,
    vault:             $vault,
    stance:            $stance,
    target_weight_bps: $target_weight_bps,
    confidence:        $confidence,
    rationale_uri:     $rationale_uri,
    prompt_hash:       $prompt_hash,
    inputs_digest:     $inputs_digest,
    timestamp:         $timestamp
  }'
