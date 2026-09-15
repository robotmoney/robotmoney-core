#!/usr/bin/env bash
# Repo-owned Fusion acceptance stage driver for the core stack (chain 918453).
#
# Canonical: project-fusion.md §12.8 "Acceptance driver". This script replaces
# the hand-rolled /opt/fusion-stage compose bundle: it regenerates every stack
# input (dapp.env, the image pinning override) from the committed deployment
# record and brings the stack up with the repo's own compose files, so the
# staged stack on rm-core-stage-1 is reproducible from the pinned commit alone.
#
# Deployment-record contract: deployments/timelock-<chain_id>.json is the
# single source of topologically-correct addresses (addresses.*, code_hashes.*,
# vault_addresses.*) after a ceremony. This script REJECTS a record that
# contradicts itself (zero/live address mix, missing required fields) rather
# than forging an env from a stale manifest.
#
# Usage (run from the repo root on the stage host):
#   deploy-core-stack.sh <build|up|down|env> [--record FILE] [--tag TAG]
#                          [--out-dir DIR] [--dapp-compose FILE] [--chain-compose FILE]
#
# Actions:
#   env        generate $OUT_DIR/dapp.env and $OUT_DIR/dapp.images.override.yaml
#              from --record. No docker action.
#   build      env + build every dapp-stack image from the repo checkout.
#   up         ensure the chain is up, then bring the dapp stack up with the
#              PINNED images (docker compose up --no-build). No rebuild.
#   down       tear the dapp stack down (data volumes preserved).
#
# Exit codes: 0 = ok; 64 = usage; 65 = record invalid; 66 = docker action failed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

ACTION=""
RECORD_PATH=""
TAG=""
OUT_DIR="/opt/fusion-stage"
DAPP_COMPOSE="$REPO_ROOT/testing/ethereum-testnet/config/docker-compose.dapp.yaml"
CHAIN_COMPOSE="$REPO_ROOT/testing/ethereum-testnet/config/docker-compose.yaml"
DAPP_PROJECT="robotmoney-dapp"
CHAIN_PROJECT="ethereum-testnet"

fail() { echo "FAIL: [deploy-core-stack] $*" >&2; exit "$2"; }
info() { echo "==> [deploy-core-stack] $*"; }

usage() {
  sed -n '2,30p' "$0" >&2
  exit 64
}

while (( $# )); do
  case "$1" in
    build|up|down|env) ACTION="$1"; shift ;;
    --record) RECORD_PATH="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --dapp-compose) DAPP_COMPOSE="$2"; shift 2 ;;
    --chain-compose) CHAIN_COMPOSE="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[[ -n "$ACTION" ]] || usage
[[ -z "$RECORD_PATH" ]] && RECORD_PATH="$REPO_ROOT/deployments/timelock-918453.json"

for tool in jq docker; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool '$tool' not on PATH" 3
done

# ─── Record validation (fail before any docker action) ───────────────────────
[[ -f "$RECORD_PATH" ]] || fail "deployment record not found: $RECORD_PATH" 65
addr=$(jq -r '.addresses // empty' "$RECORD_PATH") || true
[[ -n "$addr" ]] || fail "record has no .addresses object: $RECORD_PATH" 65

zero="0x0000000000000000000000000000000000000000"
for key in gateway vault registry router governance consensus_receipt timelock safe emergency; do
  v=$(jq -r --arg k "$key" '.addresses[$k] // empty' "$RECORD_PATH")
  if [[ -z "$v" ]]; then
    fail "record .addresses.$key is missing — refuse to stage from an incomplete topology" 65
  elif [[ "$v" == "$zero" ]]; then
    fail "record .addresses.$key is the zero address — the ceremony did not deploy it" 65
  fi
done

gateway_hash=$(jq -r '.code_hashes.gateway // empty' "$RECORD_PATH")
[[ -n "$gateway_hash" && "$gateway_hash" != "$zero" ]] \
  || fail "record .code_hashes.gateway is missing/zero — dapp admin writes depend on it" 65

if [[ -z "$TAG" ]]; then
  # Exact tag first; otherwise fall back to a compose-safe identifier so a
  # build-on-host run (AC-ID-05) from an untagged branch still works.
  TAG="$(git describe --tags --exact-match 2>/dev/null || true)"
  if [[ -z "$TAG" ]]; then
    TAG="$(git branch --show-current 2>/dev/null || true)"
  fi
  if [[ -z "$TAG" ]]; then
    TAG="$(git describe --tags 2>/dev/null || true)"
  fi
  [[ -n "$TAG" ]] || fail "no --tag given and HEAD is unresolvable; pass --tag explicitly" 65
fi

# The 918453 devnet is the only chain this driver stages; cross-check the record.
chain_id=$(jq -r '.chain_id // 0' "$RECORD_PATH")
[[ "$chain_id" == "918453" ]] || fail "record chain_id $chain_id != 918453 (this driver is devnet-only)" 65

# ─── Input generation: dapp.env + image override ─────────────────────────────
mkdir -p "$OUT_DIR"

# Vault-address map for the dapp's applied/not-applied panel and the INV-4
# witnesses. Lowercased to match consensusReceiptApi.ts parseVaultAddressMap.
vault_map="$(jq -c '.vault_addresses | {rmUSDC: (.rmUSDC|ascii_downcase), rmPROTO: (.rmPROTO|ascii_downcase), rmAGENT: (.rmAGENT|ascii_downcase), rmRWA: (.rmRWA|ascii_downcase)}' "$RECORD_PATH")"
[[ "$vault_map" == *"rmUSDC"* && "$vault_map" == *"rmRWA"* ]] \
  || fail "record .vault_addresses is missing rmUSDC/rmRWA — INV-4 witnesses would be hollow" 65

gateway=$(jq -r '.addresses.gateway' "$RECORD_PATH")
vault=$(jq -r '.addresses.vault' "$RECORD_PATH")
registry=$(jq -r '.addresses.registry' "$RECORD_PATH")
router=$(jq -r '.addresses.router' "$RECORD_PATH")
governance=$(jq -r '.addresses.governance' "$RECORD_PATH")
consensus_receipt=$(jq -r '.addresses.consensus_receipt' "$RECORD_PATH")

cat > "$OUT_DIR/dapp.env" <<EOF
# Generated by scripts/stage/deploy-core-stack.sh from $RECORD_PATH
# Record chain_id=$chain_id  tag=$TAG  generated=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Do not hand-edit: the stage is reproducible from the record alone.

# --- ports: the cloudflared ingress routes these exact numbers ---
POSTGRES_PORT=39107
EXPLORER_API_PORT=18546
DAPP_PORT=5173
RECEIPT_FIXTURES_PORT=8097

# --- chain ---
INDEXER_CHAIN_ID=918453
INDEXER_CHAIN_NAME=devnet
EXPLORER_API_CHAIN_ID=918453
INDEXER_RPC_URL=http://geth:8545
FEATURE_FLAGS=4

# --- indexer topology (from the deployment record) ---
INDEXER_GATEWAY=$gateway
INDEXER_VAULT=$vault
INDEXER_REGISTRY=$registry
INDEXER_PORTFOLIO_ROUTER=$router
INDEXER_CONSENSUS_RECEIPT=$consensus_receipt

# --- public endpoints (cloudflared) ---
VITE_DAPP_URL=https://stage-dapp.robotmoney-labs.dev
VITE_EXPLORER_API_URL=https://stage-explorer.robotmoney-labs.dev
VITE_DEVNET_RPC_URL=https://stage-rpc.robotmoney-labs.dev

# --- dapp build args (resolved so the compose :? guards pass even when the
#     image was prebuilt on pinza and shipped) ---
VITE_GATEWAY_ADDRESS=$gateway
VITE_VAULT_ADDRESS=$vault
VITE_GATEWAY_EXPECTED_CODE_HASH=$gateway_hash
VITE_REGISTRY_ADDRESS=$registry
VITE_ROUTER_ADDRESS=$router
VITE_GOVERNANCE_ADDRESS=$governance
VITE_RM_TOKEN_ADDRESS=0x0000000000000000000000000000000000000000
VITE_VAULT_ADDRESSES='$vault_map'
VITE_FAUCET_HARNESS_PRIVATE_KEY=
VITE_FAUCET_DRIP_ETH_WEI=10000000000000000
EOF
info "wrote $OUT_DIR/dapp.env (from record $RECORD_PATH)"

cat > "$OUT_DIR/dapp.images.override.yaml" <<EOF
# Generated by scripts/stage/deploy-core-stack.sh from $RECORD_PATH (tag $TAG)
# Pin the dapp-stack images to the release tag so no service builds on the
# stage host (AC-ID-05); the images were built on pinza and shipped.
services:
  explorer-migrate:
    image: robotmoney-explorer-indexer:$TAG
  explorer-indexer:
    image: robotmoney-explorer-indexer:$TAG
  explorer-api:
    image: robotmoney-explorer-api:$TAG
  dapp:
    image: robotmoney-dapp-dapp:$TAG
EOF
info "wrote $OUT_DIR/dapp.images.override.yaml (tag $TAG)"

[[ "$ACTION" == "env" ]] && exit 0

# ─── Actions ─────────────────────────────────────────────────────────────────
compose() {
  docker compose --project-name "$1" --env-file "$OUT_DIR/dapp.env" -f "$2" "${@:3}"
}

chain_up() {
  # The chain ships are idempotent; already-running containers are left alone.
  docker compose --project-name "$CHAIN_PROJECT" -f "$CHAIN_COMPOSE" up -d \
    || fail "chain compose up failed" 66
}

case "$ACTION" in
  build)
    chain_up
    compose "$DAPP_PROJECT" "$DAPP_COMPOSE" -f "$OUT_DIR/dapp.images.override.yaml" build \
      || fail "dapp stack build failed" 66
    compose "$DAPP_PROJECT" "$DAPP_COMPOSE" -f "$OUT_DIR/dapp.images.override.yaml" up -d \
      || fail "dapp stack up (build) failed" 66
    ;;
  up)
    chain_up
    compose "$DAPP_PROJECT" "$DAPP_COMPOSE" -f "$OUT_DIR/dapp.images.override.yaml" up --no-build -d \
      || fail "dapp stack up failed" 66
    ;;
  down)
    compose "$DAPP_PROJECT" "$DAPP_COMPOSE" down \
      || fail "dapp stack down failed" 66
    ;;
esac

info "$ACTION done"