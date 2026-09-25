#!/usr/bin/env bash
# Storage-layout gate for RobotMoneyGateway (issue #1476).
#
# Canonical: docs/technical/smart-contract-invariants.md (gateway storage layout).
#
# The gateway's storage layout is a compatibility surface: every slot, offset
# and type of every state variable, and every member of every storage struct,
# must stay exactly where it is. Changes to the gateway may append state; they
# may not move, retype or remove it. This gate compares the live layout from
# `forge inspect` against the committed snapshot and fails on any difference.
#
# Normalization: `forge inspect` names types with AST ids (for example
# `t_struct(AgentPolicy)4055_storage`) that change whenever any source line
# moves, so the ids are stripped. What remains is (label, slot, offset, type)
# for each state variable, plus the same four fields for each struct member,
# keyed by the struct's id-free type name.
#
# Usage (repo root, after `forge build`):
#   scripts/ci/check-gateway-storage-layout.sh              compare against the snapshot
#   scripts/ci/check-gateway-storage-layout.sh --write      rewrite the snapshot (review the diff)
#   scripts/ci/check-gateway-storage-layout.sh --selftest   prove the gate fails on a mutated snapshot
#
# Exit codes: 0 identical; 1 layout differs; 2 tooling or input error.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SNAPSHOT="${SNAPSHOT:-$REPO_ROOT/contracts/test/fixtures/storage-layout/RobotMoneyGateway.json}"
CONTRACT="RobotMoneyGateway"
FORGE="${FORGE:-forge}"

# jq program: id-free (label, slot, offset, type) for variables and struct members.
NORMALIZE='
  def noid: gsub("\\)[0-9]+"; ")");
  def row: {label, slot, offset, type: (.type | noid)};
  {
    storage: [.storage[] | row],
    structs: ((.types // {}) | to_entries
               | map(select(.value.members != null))
               | map({key: (.key | noid), value: [.value.members[] | row]})
               | from_entries)
  }'

normalized_live() {
  local raw
  raw="$(cd "$REPO_ROOT" && "$FORGE" inspect "$CONTRACT" storageLayout --json)" \
    || { echo "check-gateway-storage-layout: forge inspect $CONTRACT failed" >&2; return 2; }
  jq -S "$NORMALIZE" <<<"$raw" \
    || { echo "check-gateway-storage-layout: could not normalize forge inspect output" >&2; return 2; }
}

# compare <live-normalized-file> <snapshot-file>: 0 identical, 1 differs.
compare() {
  local live="$1" snap="$2"
  [[ -s "$snap" ]] || { echo "check-gateway-storage-layout: snapshot missing or empty: $snap" >&2; return 2; }
  if diff -u <(jq -S . "$snap") <(jq -S . "$live"); then
    echo "check-gateway-storage-layout: $CONTRACT storage layout matches $(basename "$snap") ($(jq '.storage | length' "$live") variables, $(jq '.structs | length' "$live") structs)"
    return 0
  fi
  echo "check-gateway-storage-layout: $CONTRACT storage layout differs from the committed snapshot $snap" >&2
  echo "  State may only be appended; existing slots, offsets and types must not change." >&2
  return 1
}

command -v jq >/dev/null || { echo "check-gateway-storage-layout: jq is required" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

case "${1:-}" in
  "")
    normalized_live >"$WORK/live.json"
    compare "$WORK/live.json" "$SNAPSHOT"
    ;;
  --write)
    mkdir -p "$(dirname "$SNAPSHOT")"
    normalized_live >"$WORK/live.json"
    cp "$WORK/live.json" "$SNAPSHOT"
    echo "check-gateway-storage-layout: wrote $SNAPSHOT"
    ;;
  --selftest)
    normalized_live >"$WORK/live.json"
    fails=0
    expect() {
      local name="$1" want="$2" rc=0
      compare "$WORK/live.json" "$WORK/snap.json" >"$WORK/out" 2>&1 || rc=$?
      if [[ "$rc" == "$want" ]]; then
        echo "ok   $name (exit $rc)"
      else
        echo "FAIL $name: exit $rc, wanted $want"; cat "$WORK/out"; fails=$((fails + 1))
      fi
    }
    cp "$WORK/live.json" "$WORK/snap.json"
    expect "identical layout passes" 0
    jq '.storage[3].slot = "99"' "$WORK/live.json" >"$WORK/snap.json"
    expect "a moved slot fails" 1
    jq '.storage[3].type = "t_uint256"' "$WORK/live.json" >"$WORK/snap.json"
    expect "a retyped variable fails" 1
    jq '.storage |= .[:-1]' "$WORK/live.json" >"$WORK/snap.json"
    expect "an added variable fails against an older snapshot" 1
    jq '.structs |= with_entries(.value |= reverse)' "$WORK/live.json" >"$WORK/snap.json"
    expect "reordered struct members fail" 1
    : >"$WORK/snap.json"
    expect "an empty snapshot is an error" 2
    # The committed snapshot must itself be in the normalized shape.
    if jq -e '(.storage | length) > 0 and (.structs | type) == "object"' "$SNAPSHOT" >/dev/null 2>&1; then
      echo "ok   committed snapshot is normalized"
    else
      echo "FAIL committed snapshot $SNAPSHOT is not in the normalized shape"; fails=$((fails + 1))
    fi
    if (( fails > 0 )); then
      echo "check-gateway-storage-layout selftest: $fails case(s) failed" >&2
      exit 1
    fi
    echo "check-gateway-storage-layout selftest: all cases passed"
    ;;
  -h|--help) sed -n '2,24p' "$0" ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac
