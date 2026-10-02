#!/usr/bin/env bash
# Canonical: docs/plans/one-deployment-scheme.md (robotmoney/devops), core S5 (issue 1487).
#
# CI gate: setRegistry is called nowhere under contracts/script or scripts except
# DeployTimelock.s.sol. Vault deploy scripts must never link the registry.
# Usage: check-set-registry-owner.sh [root]   (default: repo root, for the planted-line test)
set -euo pipefail

root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
status=0
while IFS= read -r hit; do
  file="${hit%%:*}"
  base="$(basename "$file")"
  [[ "$base" == "DeployTimelock.s.sol" ]] && continue
  [[ "$base" == "check-set-registry-owner.sh" ]] && continue
  echo "setRegistry outside DeployTimelock.s.sol: $hit" >&2
  status=1
done < <(grep -rn 'setRegistry' "$root/contracts/script" "$root/scripts" 2>/dev/null || true)

if [[ "$status" -eq 0 ]]; then
  echo "ok: setRegistry appears only in DeployTimelock.s.sol"
fi
exit "$status"
