#!/usr/bin/env bash
# Assert an Anvil fork-state fixture carries the complete canonical Safe v1.4.1
# contract set.
#
# Canonical: docs/technical/governance-isomorphism.md §2.2 (the addresses),
#            §4.1 R2/R3 (the requirement this enforces).
# Issue: #1447.
#
# Stage and CI both boot `anvil --load-state` from this fixture with no
# `--fork-url`, so an address the fixture does not carry has no code, full stop.
# The governance ceremony creates its Safe through the canonical
# SafeProxyFactory on the SafeL2 singleton; a fixture missing either one cannot
# run it, and R8 forbids any stand-in. This turns that latent ceremony failure
# into a fixture-time one, naming every missing contract.
#
# Reads the --dump-state JSON directly (jq), so it needs no anvil, no network
# and no Docker — cheap enough to run first in check-fork-manifest.sh.
#
# Usage:
#   scripts/devnet/check-fork-safe-set.sh [STATE_FILE]
#     STATE_FILE defaults to testing/fixtures/fork-state/CURRENT.anvil-state.
#
# Exit codes: 0 = every contract present with code; 2 = unreadable state file;
#             14 = one or more Safe contracts absent or code-less.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="${1:-$REPO_ROOT/testing/fixtures/fork-state/CURRENT.anvil-state}"

# §2.2, lowercased: the dump keys accounts by lowercase address.
SAFE_SET=(
  "0x41675c099f32341bf84bfc5382af534df5c7461a|Safe singleton (L1)"
  "0x29fcb43b46531bca003ddc8fcb67ffe91900c762|SafeL2 singleton"
  "0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67|SafeProxyFactory"
  "0xfd0732dc9e303f09fcef3a7388ad10a83459ec99|CompatibilityFallbackHandler"
  "0x38869bf66a61cf6bdb996a6ae40d5853fd43b526|MultiSend"
)

if ! jq -e '.accounts | type == "object"' "$STATE" >/dev/null 2>&1; then
  echo "ERROR: $STATE is not a readable anvil --dump-state file (no .accounts object)" >&2
  exit 2
fi

missing=0
for entry in "${SAFE_SET[@]}"; do
  addr="${entry%%|*}"
  name="${entry#*|}"
  if jq -e --arg a "$addr" '(.accounts[$a].code // "0x") | length > 2' "$STATE" >/dev/null; then
    echo "[check-fork-safe-set]   ok: $name $addr"
  else
    echo "ERROR: fixture lacks code for $name $addr (governance-isomorphism.md R2)" >&2
    missing=$((missing + 1))
  fi
done

if [ "$missing" -gt 0 ]; then
  echo "ERROR: $missing of ${#SAFE_SET[@]} canonical Safe contracts absent from $STATE — regenerate with scripts/devnet/refresh-fork-fixture.sh" >&2
  exit 14
fi
echo "[check-fork-safe-set] OK: all ${#SAFE_SET[@]} canonical Safe contracts present"
