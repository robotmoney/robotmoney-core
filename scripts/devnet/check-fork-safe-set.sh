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
# Reads the --dump-state JSON directly (jq) and hashes code with `cast keccak`,
# so it needs no anvil, no network and no Docker — cheap enough to run first in
# check-fork-manifest.sh (which already needs cast for `cast index`).
#
# Presence is not enough (issue #1447 review): each contract's code must hash
# to the keccak256 pinned below, and both singletons must carry the lock their
# constructor writes (threshold = 1 in storage slot 4, so setup() on the
# singleton itself reverts GS200). Without that slot anyone can call setup()
# on the singleton and own it.
#
# Usage:
#   scripts/devnet/check-fork-safe-set.sh [STATE_FILE]
#     STATE_FILE defaults to testing/fixtures/fork-state/CURRENT.anvil-state.
#
# Exit codes: 0 = every contract present with its pinned code, both singletons
#             locked; 2 = unreadable state file or no cast;
#             14 = one or more Safe contracts absent, code-less, carrying other
#             code than the canonical one, or (singletons) unlocked.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="${1:-$REPO_ROOT/testing/fixtures/fork-state/CURRENT.anvil-state}"
CAST="${CAST:-cast}"

# §2.2, lowercased (the dump keys accounts by lowercase address), with the
# keccak256 of each contract's runtime code. Derived from the committed fixture
# (testing/fixtures/fork-state/CURRENT.anvil-state, Base block 48896605) with
#   cast keccak "$(jq -r '.accounts["<addr>"].code' CURRENT.anvil-state)"
# and cross-checked against `cast codehash <addr>` on anvil loaded from it; the
# fixture's code for these five was read from Base at that block, so these are
# the codehashes Base reports for the canonical v1.4.1 deployments.
# address | name | code keccak256 | singleton (must be locked)
SAFE_SET=(
  "0x41675c099f32341bf84bfc5382af534df5c7461a|Safe singleton (L1)|0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4|singleton"
  "0x29fcb43b46531bca003ddc8fcb67ffe91900c762|SafeL2 singleton|0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff|singleton"
  "0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67|SafeProxyFactory|0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317|"
  "0xfd0732dc9e303f09fcef3a7388ad10a83459ec99|CompatibilityFallbackHandler|0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9|"
  "0x38869bf66a61cf6bdb996a6ae40d5853fd43b526|MultiSend|0x0e4f7fc66550a322d1e7688e181b75e217e662a4f3f4d6a29b22bc61217c4b77|"
)

if ! jq -e '.accounts | type == "object"' "$STATE" >/dev/null 2>&1; then
  echo "ERROR: $STATE is not a readable anvil --dump-state file (no .accounts object)" >&2
  exit 2
fi
if ! command -v "$CAST" >/dev/null 2>&1; then
  echo "ERROR: check-fork-safe-set.sh needs foundry's cast to hash contract code" >&2
  exit 2
fi

bad=0
for entry in "${SAFE_SET[@]}"; do
  IFS='|' read -r addr name want kind <<<"$entry"
  code="$(jq -r --arg a "$addr" '.accounts[$a].code // "0x"' "$STATE")"
  if [ "${#code}" -le 2 ]; then
    echo "ERROR: fixture lacks code for $name $addr (governance-isomorphism.md R2)" >&2
    bad=$((bad + 1))
    continue
  fi
  got="$("$CAST" keccak "$code")"
  if [ "$got" != "$want" ]; then
    echo "ERROR: fixture code for $name $addr hashes to $got, not the canonical v1.4.1 code hash $want" >&2
    bad=$((bad + 1))
    continue
  fi
  if [ "$kind" = singleton ]; then
    # Slot 4 = 1, whatever zero padding the dump used for the key and value.
    if ! jq -e --arg a "$addr" '
        [(.accounts[$a].storage // {}) | to_entries[]
          | select((.key | ltrimstr("0x") | sub("^0+"; "")) == "4")
          | (.value | ltrimstr("0x") | sub("^0+"; ""))] == ["1"]' "$STATE" >/dev/null; then
      echo "ERROR: fixture $name $addr is unlocked: storage slot 4 (threshold) is not 1, so anyone can call setup() on it (on Base it is 1, GS200)" >&2
      bad=$((bad + 1))
      continue
    fi
    echo "[check-fork-safe-set]   ok: $name $addr (code $want, locked)"
  else
    echo "[check-fork-safe-set]   ok: $name $addr (code $want)"
  fi
done

if [ "$bad" -gt 0 ]; then
  echo "ERROR: $bad of ${#SAFE_SET[@]} canonical Safe contracts absent, not canonical, or unlocked in $STATE — regenerate with scripts/devnet/refresh-fork-fixture.sh" >&2
  exit 14
fi
echo "[check-fork-safe-set] OK: all ${#SAFE_SET[@]} canonical Safe contracts present with their pinned code; both singletons locked"
