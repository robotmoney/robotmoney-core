#!/usr/bin/env bash
# Canonical: the one-deployment-scheme plan, core S4 (issue 1486, 1491).
#
# CI gate for the deploy scripts under contracts/script. Exit 1 on any of:
#   - a DEVNET_ variable
#   - a CONFIG_PATH variable
#   - a chain-id branch: `block.chainid ==` or `block.chainid !=` outside the allowlist
# The allowlist holds the two files that key a floor to chain id 8453 (S1): the shared guard and
# the timelock stage. Every other script is one path on every chain.
# Usage: check-no-devnet-config.sh [script-dir]   (default: contracts/script, for the planted-line test)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dir="${1:-$root/contracts/script}"
allow_chain_branch=("ExpectedChainGuard.sol" "DeployTimelock.s.sol")

status=0
while IFS= read -r hit; do
  echo "forbidden devnet input: $hit" >&2
  status=1
done < <(grep -rnE 'DEVNET_|CONFIG_PATH' "$dir" --include='*.sol' || true)

while IFS= read -r hit; do
  file="${hit%%:*}"
  base="$(basename "$file")"
  allowed=0
  for a in "${allow_chain_branch[@]}"; do
    [[ "$base" == "$a" ]] && allowed=1
  done
  if [[ "$allowed" -eq 0 ]]; then
    echo "chain-id branch outside the allowlist: $hit" >&2
    status=1
  fi
done < <(grep -rnE 'block\.chainid[[:space:]]*(==|!=)|(==|!=)[[:space:]]*block\.chainid' "$dir" --include='*.sol' || true)

if [[ "$status" -eq 0 ]]; then
  echo "ok: no DEVNET_, CONFIG_PATH or chain-id branch outside the allowlist under $dir"
fi
exit "$status"
