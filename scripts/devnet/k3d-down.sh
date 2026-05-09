#!/usr/bin/env bash
# Tear down the full-stack k3d devnet.
#
# Canonical: docs/technical/full-stack-devnet.md §"k3d single-command bring-up"
# Issue:     #146.
#
# Idempotent: succeeds whether or not the cluster exists.
set -euo pipefail

CLUSTER_NAME="${K3D_CLUSTER_NAME:-rm-devnet}"

if ! command -v k3d >/dev/null 2>&1; then
  echo "ERROR: k3d not on PATH" >&2
  exit 1
fi

if k3d cluster list --no-headers 2>/dev/null | awk '{print $1}' | grep -qx "$CLUSTER_NAME"; then
  echo "[k3d-down] deleting cluster '$CLUSTER_NAME'"
  k3d cluster delete "$CLUSTER_NAME"
else
  echo "[k3d-down] cluster '$CLUSTER_NAME' not present; nothing to do"
fi
