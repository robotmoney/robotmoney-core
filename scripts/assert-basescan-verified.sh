#!/usr/bin/env bash
# Canonical: docs/technical/security-model.md §8 / §13
#
# WHY THIS SCRIPT EXISTS
# security-model.md §8 row "Verified-source / deployed-bytecode mismatch" states:
#   "All contracts must be verified on BaseScan. The CI deploy pipeline must
#    assert verification before closing the deploy job."
# §13 row "Deploy-key compromise pushes a malicious contract" states:
#   "BaseScan verification must complete within one hour of deploy."
#
# This script polls the BaseScan v2 API's checkverifystatus / getsourcecode
# endpoint for each contract address in the deployment set, retrying on a
# configurable interval until all contracts report isVerified/SourceCode status,
# or until the timeout is reached.  On timeout it logs the unverified addresses
# and exits non-zero, blocking the deploy job.
#
# USAGE
#   BASESCAN_API_KEY=<key> \
#   NETWORK=base              \  # "base" (mainnet) or "base-sepolia"
#   TIMEOUT_SECONDS=3600      \  # default 3600 s (1 h)
#   POLL_INTERVAL_SECONDS=30  \  # default 30 s
#   bash scripts/assert-basescan-verified.sh <addr1> [addr2 ...]
#
# MOCK MODE (for unit tests — no network required)
#   Set MOCK_BASESCAN_VERIFIED=<addr>,<addr>,... to treat those addresses as
#   verified without making a real HTTP call.
#   Set MOCK_BASESCAN_UNVERIFIED=<addr>,<addr>,... to treat those addresses as
#   permanently unverified (drives the timeout path in tests).
#   These two variables are mutually exclusive per-address; UNVERIFIED takes
#   precedence.
#
# NETWORK → BaseScan API base URL
#   base          → https://api.basescan.org/api
#   base-sepolia  → https://api-sepolia.basescan.org/api
#
# EXIT CODES
#   0  — all supplied addresses are verified on BaseScan
#   1  — one or more addresses remain unverified after TIMEOUT_SECONDS
#   2  — usage / configuration error (no addresses supplied, etc.)

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
NETWORK="${NETWORK:-base}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-3600}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-30}"
BASESCAN_API_KEY="${BASESCAN_API_KEY:-}"
MOCK_BASESCAN_VERIFIED="${MOCK_BASESCAN_VERIFIED:-}"
MOCK_BASESCAN_UNVERIFIED="${MOCK_BASESCAN_UNVERIFIED:-}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { echo "[assert-basescan-verified] $*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

usage() {
  cat >&2 <<'EOF'
Usage:
  BASESCAN_API_KEY=<key> [NETWORK=base|base-sepolia] \
    bash scripts/assert-basescan-verified.sh <address> [address ...]

Environment variables:
  BASESCAN_API_KEY       BaseScan API key (required unless MOCK_BASESCAN_VERIFIED is set)
  NETWORK                "base" (mainnet, default) or "base-sepolia"
  TIMEOUT_SECONDS        Total wait budget in seconds (default: 3600)
  POLL_INTERVAL_SECONDS  How long to wait between retries (default: 30)
  MOCK_BASESCAN_VERIFIED     Comma-separated addresses to treat as verified (test mode)
  MOCK_BASESCAN_UNVERIFIED   Comma-separated addresses to treat as unverified (test mode)
EOF
  exit 2
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
if [[ $# -eq 0 ]]; then
  usage
fi

declare -a ADDRESSES=("$@")

# ---------------------------------------------------------------------------
# Resolve API base URL
# ---------------------------------------------------------------------------
case "${NETWORK}" in
  base)
    API_BASE="https://api.basescan.org/api"
    ;;
  base-sepolia)
    API_BASE="https://api-sepolia.basescan.org/api"
    ;;
  *)
    fail "Unknown NETWORK '${NETWORK}'. Use 'base' or 'base-sepolia'."
    ;;
esac

# ---------------------------------------------------------------------------
# Validate API key (only required when not in full-mock mode)
# ---------------------------------------------------------------------------
IS_FULL_MOCK=false
if [[ -n "${MOCK_BASESCAN_VERIFIED}" ]] || [[ -n "${MOCK_BASESCAN_UNVERIFIED}" ]]; then
  IS_FULL_MOCK=true
fi

if [[ "${IS_FULL_MOCK}" == false ]] && [[ -z "${BASESCAN_API_KEY}" ]]; then
  fail "BASESCAN_API_KEY is not set. Export the secret or use MOCK_BASESCAN_VERIFIED for testing."
fi

# ---------------------------------------------------------------------------
# Mock-mode helpers — no HTTP calls
# ---------------------------------------------------------------------------

# Returns 0 if $1 is in a comma-separated list $2.
_in_list() {
  local needle="$1"
  local haystack="$2"
  local item
  IFS=',' read -ra ITEMS <<< "${haystack}"
  for item in "${ITEMS[@]}"; do
    [[ "${item}" == "${needle}" ]] && return 0
  done
  return 1
}

# mock_is_verified <address>
# Returns 0 (verified) or 1 (not yet verified) based on MOCK_* vars.
# Exits 2 if address is not covered by any mock variable.
mock_is_verified() {
  local addr="$1"
  if _in_list "${addr}" "${MOCK_BASESCAN_UNVERIFIED}"; then
    return 1
  fi
  if _in_list "${addr}" "${MOCK_BASESCAN_VERIFIED}"; then
    return 0
  fi
  # Address not covered by any mock — treat as unverified (permissive default).
  return 1
}

# ---------------------------------------------------------------------------
# Live BaseScan API check
# ---------------------------------------------------------------------------

# is_verified_live <address>
# Returns 0 if BaseScan reports the address as source-verified, 1 otherwise.
# Exits with an informative message on HTTP / parse errors.
is_verified_live() {
  local addr="$1"
  local response
  response=$(curl --silent --max-time 30 \
    "${API_BASE}?module=contract&action=getsourcecode&address=${addr}&apikey=${BASESCAN_API_KEY}" \
    2>/dev/null) || {
    log "WARNING: curl failed for ${addr} — treating as unverified"
    return 1
  }

  # BaseScan getsourcecode returns:
  #   {"status":"1","message":"OK","result":[{"SourceCode":"...","ABI":"..."}]}
  # An empty SourceCode string "" means not yet verified.
  # "result" is a string "Contract source code not verified" when unverified on
  # older API versions.
  local source_code
  source_code=$(printf '%s' "${response}" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    result = d.get('result', [])
    if isinstance(result, list) and len(result) > 0:
        src = result[0].get('SourceCode', '')
        print(src)
    else:
        print('')
except Exception:
    print('')
" 2>/dev/null) || source_code=""

  if [[ -n "${source_code}" ]]; then
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Main polling loop
# ---------------------------------------------------------------------------

declare -a UNVERIFIED=("${ADDRESSES[@]}")
declare -a VERIFIED=()

START_TIME=$(date +%s)
log "Asserting BaseScan verification for ${#ADDRESSES[@]} contract(s) on network '${NETWORK}'."
log "Timeout: ${TIMEOUT_SECONDS}s  Poll interval: ${POLL_INTERVAL_SECONDS}s"
for addr in "${ADDRESSES[@]}"; do
  log "  Address: ${addr}"
done

while true; do
  declare -a STILL_UNVERIFIED=()

  for addr in "${UNVERIFIED[@]}"; do
    verified=false
    if [[ "${IS_FULL_MOCK}" == true ]]; then
      mock_is_verified "${addr}" && verified=true || true
    else
      is_verified_live "${addr}" && verified=true || true
    fi

    if [[ "${verified}" == true ]]; then
      log "VERIFIED: ${addr}"
      VERIFIED+=("${addr}")
    else
      STILL_UNVERIFIED+=("${addr}")
    fi
  done

  UNVERIFIED=("${STILL_UNVERIFIED[@]+"${STILL_UNVERIFIED[@]}"}")

  if [[ ${#UNVERIFIED[@]} -eq 0 ]]; then
    log "All ${#ADDRESSES[@]} contract(s) are verified on BaseScan."
    exit 0
  fi

  NOW=$(date +%s)
  ELAPSED=$(( NOW - START_TIME ))
  REMAINING=$(( TIMEOUT_SECONDS - ELAPSED ))

  if [[ ${REMAINING} -le 0 ]]; then
    log "TIMEOUT after ${ELAPSED}s — the following contract(s) are NOT verified on BaseScan:"
    for addr in "${UNVERIFIED[@]}"; do
      log "  UNVERIFIED: ${addr}"
    done
    exit 1
  fi

  log "${#UNVERIFIED[@]} contract(s) still unverified. Retrying in ${POLL_INTERVAL_SECONDS}s (${REMAINING}s remaining)..."
  sleep "${POLL_INTERVAL_SECONDS}"
done
