#!/usr/bin/env bash
# Single-command bring-up for the full-stack k3d devnet.
#
# Canonical: docs/technical/full-stack-devnet.md §"k3d single-command bring-up"
# Issue:     #146.
#
# Steps:
#   1. Create (or reuse) a k3d cluster with the same host port surface as
#      docker-compose.full-stack.yaml (8545/5432/8080/5173).
#   2. Build the three custom images (explorer-indexer, explorer-api,
#      dapp) and `k3d image import` them. (No gateway-deployer image —
#      the fork-state fixture already contains the deployed contracts.)
#   3. Create namespace, then create the `fork-state` and
#      `deployment-artifact` ConfigMaps + `postgres-credentials` Secret
#      with REAL data. This MUST happen before step 4 so the anvil-fork
#      pod boots once with real state — booting against placeholder data
#      and then `rollout restart`ing produces a CrashLoopBackOff race
#      that wedges the deployment (kubelet exponential backoff +
#      RollingUpdate maxUnavailable=0 with replicas=1).
#   4. Apply the kustomize tree at deploy/k3d/.
#   5. Wait for anvil-fork rollout, then roll out indexer + api + dapp.
#   6. Poll `explorer-api /health` from the host until 200.
#
# This script never contacts an upstream RPC. The fork-state fixture is
# refreshed offline by `scripts/devnet/snapshot-fork.sh`.
#
# Optional env (with defaults):
#   K3D_CLUSTER_NAME     cluster name (default rm-devnet)
#   POSTGRES_PASSWORD    devnet password (default rmoney_dev)
#
# Idempotent: re-running reuses an existing cluster, re-imports images,
# and re-applies manifests.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

CLUSTER_NAME="${K3D_CLUSTER_NAME:-rm-devnet}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-rmoney_dev}"

FIXTURE_STATE="testing/fixtures/fork-state/CURRENT.anvil-state"
FIXTURE_MANIFEST="testing/fixtures/fork-state/CURRENT.json"
DEPLOY_ARTIFACT="deployments/full-stack.json"

if [ ! -s "$FIXTURE_STATE" ] || [ ! -s "$FIXTURE_MANIFEST" ]; then
  echo "ERROR: fork-state fixture missing at $FIXTURE_STATE" >&2
  echo "       run: bash scripts/devnet/snapshot-fork.sh" >&2
  exit 1
fi
if [ ! -s "$DEPLOY_ARTIFACT" ]; then
  echo "ERROR: deployment artifact missing at $DEPLOY_ARTIFACT" >&2
  echo "       run: bash scripts/devnet/snapshot-fork.sh" >&2
  exit 1
fi

for tool in k3d kubectl docker; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool '$tool' not on PATH" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# 1. Cluster.
# ---------------------------------------------------------------------------
if k3d cluster list --no-headers 2>/dev/null | awk '{print $1}' | grep -qx "$CLUSTER_NAME"; then
  echo "[k3d-up] reusing existing cluster '$CLUSTER_NAME'"
else
  echo "[k3d-up] creating cluster '$CLUSTER_NAME'"
  # Publish the four host ports through klipper-lb (k3d serverlb).
  k3d cluster create "$CLUSTER_NAME" \
    --port "8545:8545@loadbalancer" \
    --port "5432:5432@loadbalancer" \
    --port "8080:8080@loadbalancer" \
    --port "5173:5173@loadbalancer" \
    --wait \
    --timeout 120s
fi

kubectl config use-context "k3d-${CLUSTER_NAME}" >/dev/null

# ---------------------------------------------------------------------------
# 2. Build + import images.
# ---------------------------------------------------------------------------
echo "[k3d-up] building images"
docker build --tag rm-explorer-indexer:k3d --file services/explorer-indexer/Dockerfile .
docker build --tag rm-explorer-api:k3d     --file clients/explorer-api/Dockerfile     .
docker build --tag rm-dapp:k3d             --file clients/dapp/Dockerfile             .

echo "[k3d-up] importing images into k3d"
k3d image import \
  rm-explorer-indexer:k3d \
  rm-explorer-api:k3d \
  rm-dapp:k3d \
  --cluster "$CLUSTER_NAME"

# ---------------------------------------------------------------------------
# 3. Seed namespace + real-data ConfigMaps/Secrets BEFORE the manifest
#    apply, so the anvil-fork pod boots once with real fork state.
# ---------------------------------------------------------------------------
kubectl get namespace robotmoney >/dev/null 2>&1 || \
  kubectl create namespace robotmoney

echo "[k3d-up] uploading fork-state fixture as ConfigMap (size=$(wc -c < "$FIXTURE_STATE") bytes)"
kubectl create configmap fork-state \
  --namespace robotmoney \
  --from-file="CURRENT.anvil-state=$FIXTURE_STATE" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "[k3d-up] uploading deployment artifact as ConfigMap"
kubectl create configmap deployment-artifact \
  --namespace robotmoney \
  --from-file="full-stack.json=$DEPLOY_ARTIFACT" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic postgres-credentials \
  --namespace robotmoney \
  --from-literal="POSTGRES_PASSWORD=$POSTGRES_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

# ---------------------------------------------------------------------------
# 4. Apply the rest of the kustomize tree. The fork-state ConfigMap is
#    already populated with real data, so the anvil-fork pod boots once
#    with the real state instead of the placeholder.
# ---------------------------------------------------------------------------
echo "[k3d-up] applying manifests"
kubectl apply -k deploy/k3d/

# ---------------------------------------------------------------------------
# 5. Wait for anvil-fork to roll out, then roll out indexer + api + dapp.
#    On rollout-status timeout for any of these, dump enough diagnostics
#    (pods, describe, current+previous logs across all containers
#    including initContainers, namespace events) for CI logs to root-
#    cause the failure without re-running locally.
# ---------------------------------------------------------------------------
dump_deployment_diagnostics() {
  local deploy="$1"
  local label="$2"
  echo "[k3d-up] === $deploy diagnostics ===" >&2
  kubectl -n robotmoney get pods -l "$label" -o wide >&2 || true
  kubectl -n robotmoney describe deployment/"$deploy" >&2 || true
  for pod in $(kubectl -n robotmoney get pods -l "$label" -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
    echo "[k3d-up] === pod $pod describe ===" >&2
    kubectl -n robotmoney describe pod "$pod" >&2 || true
    echo "[k3d-up] === pod $pod logs (all containers, last 200 lines) ===" >&2
    kubectl -n robotmoney logs "$pod" --all-containers --tail=200 >&2 || true
    echo "[k3d-up] === pod $pod previous logs (all containers, last 200 lines) ===" >&2
    kubectl -n robotmoney logs "$pod" --all-containers --previous --tail=200 >&2 || true
  done
  echo "[k3d-up] === recent namespace events ===" >&2
  kubectl -n robotmoney get events --sort-by=.lastTimestamp 2>&1 | tail -80 >&2 || true
}

wait_rollout_or_dump() {
  local deploy="$1"
  local label="$2"
  local timeout="${3:-180s}"
  echo "[k3d-up] waiting for $deploy rollout"
  if ! kubectl -n robotmoney rollout status "deployment/$deploy" --timeout="$timeout"; then
    echo "[k3d-up] $deploy rollout did not complete; capturing diagnostics" >&2
    dump_deployment_diagnostics "$deploy" "$label"
    # Also dump postgres on indexer failure since the initContainer
    # blocks on it.
    if [ "$deploy" = "explorer-indexer" ]; then
      dump_deployment_diagnostics postgres app=postgres
    fi
    exit 1
  fi
}

wait_rollout_or_dump anvil-fork       app=anvil-fork       300s
wait_rollout_or_dump explorer-indexer app=explorer-indexer 180s
wait_rollout_or_dump explorer-api     app=explorer-api     180s
wait_rollout_or_dump dapp             app=dapp             180s

# ---------------------------------------------------------------------------
# 6. Poll explorer-api /health from the host.
# ---------------------------------------------------------------------------
echo "[k3d-up] polling http://127.0.0.1:8080/health"
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/health >/dev/null; then
    echo "[k3d-up] explorer-api healthy after ${i}s"
    echo "[k3d-up] devnet ready"
    echo "  anvil-fork    http://127.0.0.1:8545"
    echo "  postgres      127.0.0.1:5432"
    echo "  explorer-api  http://127.0.0.1:8080"
    echo "  dapp          http://127.0.0.1:5173"
    exit 0
  fi
  sleep 2
done

echo "[k3d-up] explorer-api did not become healthy within 120s" >&2
kubectl -n robotmoney get pods -o wide >&2 || true
echo "[k3d-up] === explorer-api logs (last 200 lines) ===" >&2
kubectl -n robotmoney logs deployment/explorer-api --tail=200 >&2 || true
echo "[k3d-up] === explorer-indexer logs (last 200 lines) ===" >&2
kubectl -n robotmoney logs deployment/explorer-indexer --tail=200 >&2 || true
echo "[k3d-up] === recent namespace events ===" >&2
kubectl -n robotmoney get events --sort-by=.lastTimestamp 2>&1 | tail -50 >&2 || true
exit 1
