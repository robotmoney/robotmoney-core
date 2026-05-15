#!/usr/bin/env bash
# fetch-regime-snapshot.sh — fetch and validate the Robot Money regime snapshot.
#
# Canonical docs: plugins/regime-classifier/skills/regime-classifier/SKILL.md
# Snapshot source: https://www.robotmoney.net/data/regime-snapshot.json
#
# Usage:
#   fetch-regime-snapshot.sh [--offline <path>] [--no-cache]
#
# Flags:
#   --offline <path>   Load from a local file instead of fetching the live URL.
#                      Skips network access; cache logic still applies unless
#                      --no-cache is also passed.
#   --no-cache         Force a fresh fetch even if today's cache file exists.
#
# Exit codes:
#   0   Success — surfaced fields written to stdout as JSON.
#   1   Fetch or schema failure — error message written to stderr.
#
# Cache: /tmp/regime-snapshot-YYYY-MM-DD.json  (UTC date, never inside the repo)

set -euo pipefail

SNAPSHOT_URL="https://www.robotmoney.net/data/regime-snapshot.json"
REQUIRED_FIELDS=(asof regime composite macro_regime onchain_regime)
VALID_REGIMES=(risk_off neutral risk_on)

# ---------- argument parsing ----------

OFFLINE_PATH=""
NO_CACHE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --offline)
      OFFLINE_PATH="${2:?--offline requires a path argument}"
      shift 2
      ;;
    --no-cache)
      NO_CACHE=1
      shift
      ;;
    *)
      echo "fetch-regime-snapshot.sh: unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

# ---------- cache path ----------

UTC_DATE=$(date -u +%Y-%m-%d)
CACHE_FILE="/tmp/regime-snapshot-${UTC_DATE}.json"

# ---------- obtain raw JSON ----------

RAW_JSON=""

if [[ $NO_CACHE -eq 0 && -f "$CACHE_FILE" && -z "$OFFLINE_PATH" ]]; then
  # Cache hit (live path only): use today's cached file.
  RAW_JSON=$(cat "$CACHE_FILE")
elif [[ -n "$OFFLINE_PATH" ]]; then
  # Offline mode: read from the provided fixture file.
  if [[ ! -f "$OFFLINE_PATH" ]]; then
    echo "fetch-regime-snapshot.sh: offline file not found: $OFFLINE_PATH" >&2
    exit 1
  fi
  RAW_JSON=$(cat "$OFFLINE_PATH")
  # Write to cache so a subsequent call on the same UTC date gets a cache hit.
  if [[ $NO_CACHE -eq 0 ]]; then
    printf '%s' "$RAW_JSON" > "$CACHE_FILE"
  fi
else
  # Live fetch.
  if ! RAW_JSON=$(curl --silent --show-error --fail --max-time 15 "$SNAPSHOT_URL" 2>&1); then
    echo "fetch-regime-snapshot.sh: failed to fetch snapshot from $SNAPSHOT_URL: $RAW_JSON" >&2
    exit 1
  fi
  # Write to cache.
  printf '%s' "$RAW_JSON" > "$CACHE_FILE"
fi

# ---------- parse check ----------

if ! echo "$RAW_JSON" | jq . > /dev/null 2>&1; then
  echo "fetch-regime-snapshot.sh: snapshot response is not valid JSON" >&2
  exit 1
fi

# ---------- required-field validation ----------

for field in "${REQUIRED_FIELDS[@]}"; do
  value=$(echo "$RAW_JSON" | jq -r --arg f "$field" '.[$f] // empty')
  if [[ -z "$value" ]]; then
    echo "fetch-regime-snapshot.sh: required field missing from snapshot: $field" >&2
    exit 1
  fi
done

# ---------- regime value validation ----------

regime=$(echo "$RAW_JSON" | jq -r '.regime')
valid=0
for v in "${VALID_REGIMES[@]}"; do
  [[ "$regime" == "$v" ]] && valid=1 && break
done
if [[ $valid -eq 0 ]]; then
  echo "fetch-regime-snapshot.sh: invalid regime value '$regime'; expected one of: ${VALID_REGIMES[*]}" >&2
  exit 1
fi

# ---------- composite range validation ----------

composite=$(echo "$RAW_JSON" | jq -r '.composite')
if ! echo "$composite" | grep -qE '^[0-9]+(\.[0-9]+)?$'; then
  echo "fetch-regime-snapshot.sh: composite is not a number: $composite" >&2
  exit 1
fi

# ---------- surface surfaced fields ----------

echo "$RAW_JSON" | jq '{
  asof:                .asof,
  regime:              .regime,
  composite:           .composite,
  composite_percentile:.composite_percentile,
  macro_regime:        .macro_regime,
  onchain_regime:      .onchain_regime,
  macro_index:         .macro_index,
  onchain_index:       .onchain_index,
  bucket_thresholds:   .bucket_thresholds
}'
