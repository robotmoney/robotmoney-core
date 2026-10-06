#!/usr/bin/env bash
# Canonical: issue #1483 (S1, one deployment scheme) — escape hatches deleted, not disabled.
# Fails (exit 1) when a removed deploy-script flag still appears under contracts/ or scripts/.
# Exit 0 when there is no match. The flag names are built from parts so this file never matches itself.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

flags=("SKIP_ROUTER_ADMIN""_GRANT" "ALLOW_SHORT_TIMELOCK""_DELAY")
status=0
for flag in "${flags[@]}"; do
  # contracts/doc is generated from the sources and checked by its own freshness job.
  if grep -rInF --exclude-dir=node_modules --exclude-dir=lib --exclude-dir=out --exclude-dir=cache \
      --exclude-dir=doc -- "$flag" contracts scripts; then
    echo "::error::removed flag $flag still appears under contracts/ or scripts/" >&2
    status=1
  fi
done
exit "$status"
