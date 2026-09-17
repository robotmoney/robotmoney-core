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
#   deploy-core-stack.sh <smoke|build|up|down|env> [--record FILE] [--tag TAG]
#                          [--out-dir DIR] [--dapp-compose FILE] [--chain-compose FILE]
#                          [--chain anvil|geth]
#
# --chain picks the chain backend, and EVERY action honours it — the stage runs
# one chain, not one per action. `anvil` (the default) is the Fusion acceptance
# backend: the smoke harness owns a host-side Anvil on 18545 whose clock can be
# moved, which is what fusion-ceremony.sh's timelock jumps need; `up`/`build`
# then start no chain compose stack and point the indexer at that host chain.
# `geth` is the original PoS devnet compose stack, whose clock tracks wall time
# 1:1 — G06-G08 cannot run on it, because jump_to refuses to sleep out an hour.
#
# Actions:
#   env        generate $OUT_DIR/dapp.env and $OUT_DIR/dapp.images.override.yaml
#              from --record. No docker action.
#   build      env + build every dapp-stack image from the repo checkout.
#   up         ensure the chain is up, then bring the dapp stack up with the
#              PINNED images (docker compose up --no-build). No rebuild.
#   down       tear the dapp stack down (data volumes preserved).
#   smoke      run the repository's full devnet smoke harness on the canonical
#              stage ports, WITHOUT fixture consensus receipts (acceptance
#              stacks index real frontend receipts only); stays attached until
#              signalled.
#   ceremony   provision the acceptance topology on the running smoke devnet
#              (scripts/stage/fusion-ceremony.sh run): ephemeral submitter /
#              approver / voters, RehearsalSafe, TimelockController handover,
#              on-chain verification, and a GENERATED record at
#              $OUT_DIR/fusion-stage-record.json.
#
# --record defaults to $OUT_DIR/fusion-stage-record.json when the ceremony has
# produced one, otherwise to the committed deployments/timelock-918453.json.
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
# The chain backend every action shares. Anvil is the acceptance default: its
# clock is movable, which is the whole reason the Fusion governance stages can
# run at all (scripts/stage/fusion-ceremony.sh jump_to).
CHAIN_BACKEND="anvil"
# The external docker network docker-compose.dapp.yaml attaches the indexer to.
# In geth mode the chain compose stack creates it; in anvil mode the smoke
# harness does (testing/smoke-test/src/anvil_fixture.rs CHAIN_NET_NAME).
CHAIN_NET="ethereum-testnet_default"
RPC_PORT=18545

fail() { echo "FAIL: [deploy-core-stack] $*" >&2; exit "$2"; }
info() { echo "==> [deploy-core-stack] $*"; }

# The whole leading comment block, so an added action or flag never falls off
# the end of a hardcoded line range.
usage() {
  awk 'NR > 1 { if (!/^#/) exit; print }' "$0" >&2
  exit 64
}

while (( $# )); do
  case "$1" in
    smoke|build|up|down|env|ceremony) ACTION="$1"; shift ;;
    --record) RECORD_PATH="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --dapp-compose) DAPP_COMPOSE="$2"; shift 2 ;;
    --chain-compose) CHAIN_COMPOSE="$2"; shift 2 ;;
    --chain) CHAIN_BACKEND="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[[ -n "$ACTION" ]] || usage
case "$CHAIN_BACKEND" in
  anvil|geth) ;;
  *) echo "--chain must be anvil or geth, got '$CHAIN_BACKEND'" >&2; usage ;;
esac
if [[ -z "$RECORD_PATH" ]]; then
  if [[ -f "$OUT_DIR/fusion-stage-record.json" ]]; then
    RECORD_PATH="$OUT_DIR/fusion-stage-record.json"
  else
    RECORD_PATH="$REPO_ROOT/deployments/timelock-918453.json"
  fi
fi

for tool in jq docker curl; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool '$tool' not on PATH" 3
done

# ─── rmpc, always rebuilt from the pinned checkout ────────────────────────────
# NOT a conditional check. The staged binary and the pinned tag drift silently:
# on 2026-09-16 the binary here had been built three days before the tag commit,
# `rmpc --version` could not discriminate because the rc declared an older
# version, and it derived a different payload digest — so every core-side verdict
# from that run, independent verification and seam checks included, was
# stale-binary output that had to be thrown away and re-proven.
#
# `checks/binary-provenance.ts` in the QA driver only DETECTS that afterwards,
# by mtime and tag-string fingerprints, and refuses the record stage. Detection
# turns the drift into a late, confusing failure. Building here removes it.
#
# Defined here, ABOVE the `smoke` action below, not beside `chain_up` further
# down: `smoke` is the QA driver's actual default invocation (fusion-qa's
# build-remote), and it `exec`s before ever reaching the action dispatch that
# `chain_up`/`up` live in. A definition below that point would never be seen,
# and the "always rebuilt" promise would be true only for the `up` path nobody
# but a prebuilt-image deploy uses.
#
# cargo is incremental, so a checkout that has not moved costs seconds.
rebuild_rmpc() {
  command -v cargo >/dev/null 2>&1 || fail "required tool 'cargo' not on PATH (needed to rebuild rmpc)" 3
  info "rebuilding rmpc from $(git -C "$REPO_ROOT" describe --tags --always 2>/dev/null || echo 'this checkout')"
  (cd "$REPO_ROOT" && cargo build -p rust-payment-client --bin rmpc --bin rmpc-keystore-import) \
    || fail "rmpc rebuild failed; refusing to run against whatever binary was already there" 66
}

if [[ "$ACTION" == "smoke" ]]; then
  command -v cargo >/dev/null 2>&1 || fail "required tool 'cargo' not on PATH" 3
  # This is the driver's actual default path (fusion-qa's build-remote), not
  # `up` — `rebuild_rmpc` living only on `up` would have made the "always
  # rebuilt" promise false for every QA run, which invokes `smoke` directly and
  # never reaches the `up` branch below.
  rebuild_rmpc
  exec cargo run -p smoke-test -- \
    --full-stack \
    --chain "$CHAIN_BACKEND" \
    --rpc-port "$RPC_PORT" \
    --explorer-port 18546 \
    --dapp-port 5173 \
    --public-rpc-url https://stage-rpc.robotmoney-labs.dev \
    --public-explorer-url https://stage-explorer.robotmoney-labs.dev \
    --public-dapp-url https://stage-dapp.robotmoney-labs.dev \
    --no-receipt-fixtures
fi

if [[ "$ACTION" == "ceremony" ]]; then
  exec "$REPO_ROOT/scripts/stage/fusion-ceremony.sh" run --out-dir "$OUT_DIR" \
    --summary "$OUT_DIR/core-smoke.log"
fi

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

# The address a container uses to reach the host-side Anvil. Mirrors
# testing/smoke-test/src/anvil_fixture.rs container_host_addr(): the docker
# bridge gateway is routable from every bridge network on Linux, with
# host.docker.internal as the fallback (made resolvable by the extra_hosts entry
# the override below writes in anvil mode).
container_host_addr() {
  local gw
  if [[ -n "${SMOKE_TEST_ANVIL_HOST_ADDR:-}" ]]; then
    printf '%s' "$SMOKE_TEST_ANVIL_HOST_ADDR"; return 0
  fi
  gw="$(docker network inspect bridge -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null || true)"
  if [[ -n "$gw" ]]; then printf '%s' "$gw"; else printf 'host.docker.internal'; fi
}

# In geth mode the indexer reaches the chain by compose service name over the
# shared chain network. In anvil mode there is no chain container at all: the
# chain is a host process the smoke harness owns, so the indexer has to cross
# the docker bridge to reach it.
if [[ "$CHAIN_BACKEND" == "anvil" ]]; then
  INDEXER_RPC_URL="http://$(container_host_addr):$RPC_PORT"
else
  INDEXER_RPC_URL="http://geth:8545"
fi
info "chain backend $CHAIN_BACKEND; indexer RPC $INDEXER_RPC_URL"

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
INDEXER_RPC_URL=$INDEXER_RPC_URL
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

# In anvil mode the indexer may fall back to host.docker.internal, which Linux
# does not resolve on its own. The override is this script's own file, so the
# extra_hosts entry goes here rather than into the compose file suite-14 pins.
indexer_extra_hosts=""
if [[ "$CHAIN_BACKEND" == "anvil" ]]; then
  indexer_extra_hosts=$'\n    extra_hosts:\n      - "host.docker.internal:host-gateway"'
fi

cat > "$OUT_DIR/dapp.images.override.yaml" <<EOF
# Generated by scripts/stage/deploy-core-stack.sh from $RECORD_PATH (tag $TAG)
# Pin the dapp-stack images to the release tag so no service builds on the
# stage host (AC-ID-05); the images were built on pinza and shipped.
services:
  explorer-migrate:
    image: robotmoney-explorer-indexer:$TAG
  explorer-indexer:
    image: robotmoney-explorer-indexer:$TAG$indexer_extra_hosts
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
  # 18545 is the repo-owned stage ingress contract either way: cloudflared routes
  # the public stage RPC hostname to this host port.
  if [[ "$CHAIN_BACKEND" == "anvil" ]]; then
    # The chain is the smoke harness's host-side Anvil, not a container this
    # script may start. Bringing the geth stack up here would bind the same port
    # and put the dapp on a chain whose clock cannot be moved, so this only
    # checks that the chain the ceremony needs is the one actually listening.
    local rpc_result expected_chain_id
    expected_chain_id="0x$(printf '%x' "$chain_id")"
    rpc_result="$(curl -fsS --max-time 3 -X POST "http://127.0.0.1:$RPC_PORT" \
      -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' 2>/dev/null \
      | jq -r '.result // empty' 2>/dev/null || true)"
    [[ "$rpc_result" == "$expected_chain_id" ]] \
      || fail "no chain answering $expected_chain_id on 127.0.0.1:$RPC_PORT (got '${rpc_result:-nothing}') — with --chain anvil the chain is the smoke harness's own Anvil: start \`deploy-core-stack.sh smoke\` first, or pass --chain geth" 66
    docker network inspect "$CHAIN_NET" >/dev/null 2>&1 \
      || fail "docker network $CHAIN_NET does not exist — the dapp compose stack attaches the indexer to it, and in anvil mode the smoke harness creates it; start \`deploy-core-stack.sh smoke\` first" 66
    info "chain backend anvil: host chain on $RPC_PORT is live, $CHAIN_NET exists; starting no chain containers"
    return 0
  fi
  # The chain ships are idempotent; already-running containers are left alone.
  GETH_RPC_PORT="$RPC_PORT" docker compose --project-name "$CHAIN_PROJECT" -f "$CHAIN_COMPOSE" up -d \
    || fail "chain compose up failed" 66
}

wait_ready() {
  local expected_chain_id rpc_result
  expected_chain_id="0x$(printf '%x' "$chain_id")"
  for _attempt in $(seq 1 120); do
    rpc_result="$(curl -fsS --max-time 3 -X POST "http://127.0.0.1:$RPC_PORT" \
      -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' 2>/dev/null \
      | jq -r '.result // empty' 2>/dev/null || true)"
    if [[ "$rpc_result" == "$expected_chain_id" ]] \
      && curl -fsS --max-time 3 http://127.0.0.1:18546/health >/dev/null 2>&1 \
      && curl -fsS --max-time 3 http://127.0.0.1:5173/ >/dev/null 2>&1; then
      info "stage origins ready (rpc, explorer, dapp)"
      return 0
    fi
    sleep 2
  done
  fail "stage origins did not become ready" 66
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
    rebuild_rmpc
    chain_up
    compose "$DAPP_PROJECT" "$DAPP_COMPOSE" -f "$OUT_DIR/dapp.images.override.yaml" up --no-build -d \
      || fail "dapp stack up failed" 66
    ;;
  down)
    if [[ -f "$OUT_DIR/core-smoke.pid" ]]; then
      smoke_pid="$(cat "$OUT_DIR/core-smoke.pid")"
      if [[ "$smoke_pid" =~ ^[0-9]+$ ]] && kill -0 "$smoke_pid" 2>/dev/null; then
        kill -INT "$smoke_pid"
        for _attempt in $(seq 1 60); do
          kill -0 "$smoke_pid" 2>/dev/null || break
          sleep 1
        done
        kill -0 "$smoke_pid" 2>/dev/null && fail "core smoke harness did not stop" 66
      fi
      rm -f "$OUT_DIR/core-smoke.pid"
    fi
    COMPOSE_PROFILES=receipt-fixtures compose "$DAPP_PROJECT" "$DAPP_COMPOSE" down \
      || fail "dapp stack down failed" 66
    if [[ "$CHAIN_BACKEND" == "anvil" ]]; then
      # The chain is the smoke harness process signalled above; it removes the
      # docker network it created on its way out. There is no chain stack here.
      info "chain backend anvil: the smoke harness owns the chain; no chain compose stack to stop"
    else
      GETH_RPC_PORT="$RPC_PORT" docker compose --project-name "$CHAIN_PROJECT" -f "$CHAIN_COMPOSE" down \
        || fail "chain stack down failed" 66
    fi
    ;;
esac

[[ "$ACTION" == "build" || "$ACTION" == "up" ]] && wait_ready

info "$ACTION done"
