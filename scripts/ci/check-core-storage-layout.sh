#!/usr/bin/env bash
# Storage-layout gate for every proxied core contract (issue 1808; generalizes the gateway gate of issue 1476).
#
# Canonical: docs/technical/contract-upgradeability-plan.md (Mechanism and authority: "Pin and validate that layout for
#            every upgrade; append-only layout discipline alone is insufficient when inheritance or library linking
#            changes"), docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md.
#
# Each core contract runs behind its own ERC-1967 proxy. A new implementation is upgrade-safe only if it reads the
# proxy's existing storage the way the old one wrote it. This gate compares, per contract, the live layout with a
# committed snapshot and fails on ANY difference, so a layout change is always a reviewed snapshot update:
#
#   storage     (label, slot, offset, type) of every sequential state variable (`forge inspect <C> storageLayout`),
#               AST ids stripped from type names;
#   structs     the same four fields for every member of every struct stored in that layout;
#   libraries   the externally linked libraries the runtime code DELEGATECALLs (a library that operates on storage
#               through a pointer argument is part of the layout surface);
#   namespaces  the ERC-7201 namespaces in the inheritance chain (`@custom:storage-location erc7201:<id>`), each with
#               its struct members as declared in source. OpenZeppelin's own namespaces are pinned through the
#               submodule commits below; GovernedUUPS's namespace is Robot Money's own.
#
# A shared pins file records the commits of the two OpenZeppelin submodules: bumping either moves code that owns
# proxy storage (ERC20, ERC4626, AccessControl, ReentrancyGuard, Initializable), so it fails until re-snapshotted.
#
# Baselines (issue 1835). The committed snapshots live in the same tree as the code, so a change can reorder storage
# and regenerate them with --write in one commit. The baseline check closes that: the live layout must also EXTEND,
# append-only, the snapshot committed at each baseline: every storage row, every member of every stored struct and
# of every ERC-7201 namespace at the same position with the same type, no linked library dropped. New rows and
# members may only follow the old ones. A baseline that ships no GovernedUUPS proxy has no proxy layout to keep.
#   --baseline <ref>  a git ref, e.g. the base commit of a pull request (CI: HEAD^1 of the PR merge commit)
#   --releases        every production `release/*` tag (rehearsal tags excluded) that ships GovernedUUPS proxies
#
# Usage (repo root, after `forge build`):
#   scripts/ci/check-core-storage-layout.sh              compare every contract against its snapshot
#   scripts/ci/check-core-storage-layout.sh [--baseline <ref>]... [--releases]
#                                                        the same, and extend every baseline append-only
#   scripts/ci/check-core-storage-layout.sh --write      rewrite every snapshot (review the diff)
#   scripts/ci/check-core-storage-layout.sh --selftest   prove the gate fails on mutated snapshots
#
# Exit codes: 0 identical; 1 a layout differs; 2 tooling or input error.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SNAPSHOT_DIR="${SNAPSHOT_DIR:-$REPO_ROOT/contracts/test/fixtures/storage-layout}"
FORGE="${FORGE:-forge}"
PINS="$SNAPSHOT_DIR/pins.json"

# contract:source — the ten proxied core contracts (docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md).
CONTRACTS=(
  "RobotMoneyVault:contracts/RobotMoneyVault.sol"
  "ProtocolAssetVault:contracts/vaults/ProtocolAssetVault.sol"
  "AgentTokenVault:contracts/vaults/AgentTokenVault.sol"
  "RwaBasketVault:contracts/vaults/RwaBasketVault.sol"
  "VaultRegistry:contracts/VaultRegistry.sol"
  "PortfolioRouter:contracts/PortfolioRouter.sol"
  "RobotMoneyGateway:contracts/gateway/RobotMoneyGateway.sol"
  "InvestmentCommitteePolicy:contracts/gateway/InvestmentCommitteePolicy.sol"
  "ConsensusRecommendationReceipt:contracts/gateway/ConsensusRecommendationReceipt.sol"
  "RouterGovernance:contracts/RouterGovernance.sol"
)

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

# The ERC-7201 namespaces declared in `files` (one JSON object: id -> [member declarations]).
namespaces_of() {
  local f
  for f in "$@"; do
    awk '
      /@custom:storage-location erc7201:/ { match($0, /erc7201:[A-Za-z0-9_.]+/); id = substr($0, RSTART + 8, RLENGTH - 8); want = 1; next }
      want && /struct [A-Za-z0-9_]+ *\{/ { inside = 1; next }
      inside && /^ *\}/ { inside = 0; want = 0; next }
      inside {
        line = $0; sub(/\/\/.*/, "", line); gsub(/^ +| +$/, "", line); gsub(/ +/, " ", line)
        if (line != "" && line !~ /^(\/\*|\*)/) print id "\t" line
      }' "$REPO_ROOT/$f"
  done | jq -R -s 'split("\n") | map(select(length > 0) | split("\t")) | group_by(.[0]) | map({key: .[0][0], value: map(.[1])}) | from_entries'
}

# The Solidity sources the contract's artifact was compiled from that belong to its inheritance chain.
inheritance_sources() {
  local name="$1" src="$2" artifact
  artifact="$REPO_ROOT/out/$(basename "$src")/$name.json"
  [[ -s "$artifact" ]] || { echo "check-core-storage-layout: missing artifact $artifact (run forge build)" >&2; return 2; }
  # metadata.sources lists every file of the compilation unit; keep Robot Money's and the upgradeable bases.
  jq -r '.metadata.sources | keys[]' "$artifact" \
    | grep -E '^(contracts/|lib/openzeppelin-contracts-upgradeable/)' || true
}

normalized_live() {
  local name="$1" src="$2" raw artifact libs ns
  raw="$(cd "$REPO_ROOT" && "$FORGE" inspect "$name" storageLayout --json)" \
    || { echo "check-core-storage-layout: forge inspect $name failed" >&2; return 2; }
  artifact="$REPO_ROOT/out/$(basename "$src")/$name.json"
  [[ -s "$artifact" ]] || { echo "check-core-storage-layout: missing artifact $artifact (run forge build)" >&2; return 2; }
  libs="$(jq -c '[.deployedBytecode.linkReferences | to_entries[] | .key as $f | .value | keys[] | "\($f):\(.)"] | sort' "$artifact")"
  # shellcheck disable=SC2046
  ns="$(namespaces_of $(inheritance_sources "$name" "$src"))"
  jq -S --argjson libs "$libs" --argjson ns "$ns" "$NORMALIZE + {libraries: \$libs, namespaces: \$ns}" <<<"$raw" \
    || { echo "check-core-storage-layout: could not normalize $name" >&2; return 2; }
}

live_pins() {
  local oz ozu
  oz="$(git -C "$REPO_ROOT" ls-tree HEAD lib/openzeppelin-contracts | awk '{print $3}')"
  ozu="$(git -C "$REPO_ROOT" ls-tree HEAD lib/openzeppelin-contracts-upgradeable | awk '{print $3}')"
  [[ -n "$oz" && -n "$ozu" ]] || { echo "check-core-storage-layout: cannot read the OpenZeppelin submodule commits" >&2; return 2; }
  jq -n -S --arg oz "$oz" --arg ozu "$ozu" '{"lib/openzeppelin-contracts": $oz, "lib/openzeppelin-contracts-upgradeable": $ozu}'
}

# compare <label> <live-file> <snapshot-file>: 0 identical, 1 differs, 2 input error.
compare() {
  local label="$1" live="$2" snap="$3"
  [[ -s "$snap" ]] || { echo "check-core-storage-layout: snapshot missing or empty: $snap" >&2; return 2; }
  if diff -u <(jq -S . "$snap") <(jq -S . "$live"); then
    echo "check-core-storage-layout: $label matches $(basename "$snap")"
    return 0
  fi
  echo "check-core-storage-layout: $label differs from the committed snapshot $snap" >&2
  echo "  A proxied contract's storage may only change through a reviewed snapshot update (--write)." >&2
  return 1
}

# extends <label> <live-file> <baseline-file> <baseline-name>: 0 when the live layout extends the baseline
# append-only, 1 when it moves, retypes or removes anything the baseline holds, 2 input error.
extends() {
  local label="$1" live="$2" base="$3" ref="$4" bad
  [[ -s "$base" ]] || { echo "check-core-storage-layout: the snapshot of $label at $ref is empty" >&2; return 2; }
  bad="$(jq -r --slurpfile b "$base" '
    def ext($old; $new): ($old | length) <= ($new | length) and $new[:($old | length)] == $old;
    . as $l | $b[0] as $o
    | (if ext($o.storage // []; $l.storage // []) then empty else "storage: a variable moved, was retyped or removed" end),
      (($o.structs // {}) | to_entries[] | select(ext(.value; $l.structs[.key] // []) | not) | "struct \(.key): a member moved, was retyped or removed"),
      (($o.namespaces // {}) | to_entries[] | select(ext(.value; $l.namespaces[.key] // []) | not) | "namespace \(.key): a member moved, was retyped or removed"),
      ((($o.libraries // []) - ($l.libraries // []))[] | "library \(.) is no longer linked")' "$live")" \
    || { echo "check-core-storage-layout: cannot compare $label with $ref" >&2; return 2; }
  if [[ -z "$bad" ]]; then
    echo "check-core-storage-layout: $label extends the layout of $ref"
    return 0
  fi
  echo "check-core-storage-layout: $label does not extend the layout committed at $ref:" >&2
  sed 's/^/  /' <<<"$bad" >&2
  echo "  A proxy deployed from $ref keeps that storage. Regenerating the snapshot does not move it." >&2
  return 1
}

# The production release tags that ship GovernedUUPS proxies (rehearsal tags never deploy a production proxy).
released_proxy_tags() {
  local t
  git -C "$REPO_ROOT" tag -l 'release/*' | grep -v -- 'rehearsal' | while read -r t; do
    if git -C "$REPO_ROOT" cat-file -e "$t:contracts/lib/GovernedUUPS.sol" 2>/dev/null; then echo "$t"; fi
  done
}

# baseline_check <ref> <live-dir>: every contract's live layout against the snapshot committed at <ref>.
baseline_check() {
  local ref="$1" dir="$2" rc=0 entry name rel
  git -C "$REPO_ROOT" rev-parse --verify --quiet "$ref^{commit}" >/dev/null \
    || { echo "check-core-storage-layout: baseline $ref is not a commit here (fetch it)" >&2; return 2; }
  if ! git -C "$REPO_ROOT" cat-file -e "$ref:contracts/lib/GovernedUUPS.sol" 2>/dev/null; then
    echo "check-core-storage-layout: $ref ships no GovernedUUPS proxy: no proxy layout to keep"
    return 0
  fi
  rel="${SNAPSHOT_DIR#"$REPO_ROOT"/}"
  for entry in "${CONTRACTS[@]}"; do
    name="${entry%%:*}"
    if ! git -C "$REPO_ROOT" cat-file -e "$ref:$rel/$name.json" 2>/dev/null; then
      echo "check-core-storage-layout: $name has no snapshot at $ref: a new proxy, nothing to keep"
      continue
    fi
    git -C "$REPO_ROOT" show "$ref:$rel/$name.json" >"$WORK/baseline.json"
    extends "$name storage layout" "$dir/$name.json" "$WORK/baseline.json" "$ref" || rc=$?
    [[ "$rc" == 2 ]] && return 2
  done
  return "$rc"
}

command -v jq >/dev/null || { echo "check-core-storage-layout: jq is required" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

BASELINES=()
if [[ "${1:-}" == "--baseline" || "${1:-}" == "--releases" ]]; then
  while (( $# > 0 )); do
    case "$1" in
      --baseline) [[ -n "${2:-}" ]] || { echo "--baseline needs a git ref" >&2; exit 2; }; BASELINES+=("$2"); shift 2 ;;
      --releases) mapfile -t -O "${#BASELINES[@]}" BASELINES < <(released_proxy_tags)
                  (( ${#BASELINES[@]} > 0 )) || echo "check-core-storage-layout: no production release ships GovernedUUPS proxies yet"
                  shift ;;
      *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
  done
  set -- ""
fi

case "${1:-}" in
  "")
    rc=0
    live_pins >"$WORK/pins.json"
    compare "OpenZeppelin pins" "$WORK/pins.json" "$PINS" || rc=1
    for entry in "${CONTRACTS[@]}"; do
      name="${entry%%:*}"; src="${entry#*:}"
      normalized_live "$name" "$src" >"$WORK/$name.json"
      [[ "$(jq '.storage | length' "$WORK/$name.json")" -gt 0 ]] \
        || { echo "check-core-storage-layout: $name has an empty layout" >&2; exit 2; }
      compare "$name storage layout" "$WORK/$name.json" "$SNAPSHOT_DIR/$name.json" || rc=1
    done
    for ref in "${BASELINES[@]}"; do
      brc=0
      baseline_check "$ref" "$WORK" || brc=$?
      [[ "$brc" == 2 ]] && exit 2
      [[ "$brc" == 0 ]] || rc=1
    done
    exit "$rc"
    ;;
  --write)
    mkdir -p "$SNAPSHOT_DIR"
    live_pins >"$PINS"
    for entry in "${CONTRACTS[@]}"; do
      name="${entry%%:*}"; src="${entry#*:}"
      normalized_live "$name" "$src" >"$SNAPSHOT_DIR/$name.json"
      echo "check-core-storage-layout: wrote $SNAPSHOT_DIR/$name.json"
    done
    echo "check-core-storage-layout: wrote $PINS"
    ;;
  --selftest)
    name="RobotMoneyGateway"; src="contracts/gateway/RobotMoneyGateway.sol"
    normalized_live "$name" "$src" >"$WORK/live.json"
    fails=0
    expect() {
      local label="$1" want="$2" rc=0
      compare "$name" "$WORK/live.json" "$WORK/snap.json" >"$WORK/out" 2>&1 || rc=$?
      if [[ "$rc" == "$want" ]]; then
        echo "ok   $label (exit $rc)"
      else
        echo "FAIL $label: exit $rc, wanted $want"; cat "$WORK/out"; fails=$((fails + 1))
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
    jq '.libraries += ["contracts/lib/Extra.sol:Extra"]' "$WORK/live.json" >"$WORK/snap.json"
    expect "a changed library link fails" 1
    jq '.namespaces["robotmoney.storage.GovernedUUPS"] |= reverse' "$WORK/live.json" >"$WORK/snap.json"
    expect "a reordered ERC-7201 namespace fails" 1
    : >"$WORK/snap.json"
    expect "an empty snapshot is an error" 2
    # Issue 1835: a change that reorders storage AND regenerates the in-tree snapshot passes the snapshot compare,
    # and the baseline (the snapshot committed before the change) still fails the gate.
    gate() {
      local label="$1" want="$2" rc=0
      { compare "$name" "$WORK/new.json" "$WORK/snap.json" && extends "$name" "$WORK/new.json" "$WORK/live.json" base; } >"$WORK/out" 2>&1 || rc=$?
      if [[ "$rc" == "$want" ]]; then
        echo "ok   $label (exit $rc)"
      else
        echo "FAIL $label: exit $rc, wanted $want"; cat "$WORK/out"; fails=$((fails + 1))
      fi
    }
    jq '.storage |= ([.[1], .[0]] + .[2:])' "$WORK/live.json" >"$WORK/new.json"
    cp "$WORK/new.json" "$WORK/snap.json"
    gate "reordered storage with a regenerated snapshot fails against the baseline" 1
    jq '.storage[3].type = "t_uint256"' "$WORK/live.json" >"$WORK/new.json"
    cp "$WORK/new.json" "$WORK/snap.json"
    gate "a retyped variable with a regenerated snapshot fails against the baseline" 1
    jq '.namespaces["robotmoney.storage.GovernedUUPS"] |= reverse' "$WORK/live.json" >"$WORK/new.json"
    cp "$WORK/new.json" "$WORK/snap.json"
    gate "a reordered namespace with a regenerated snapshot fails against the baseline" 1
    jq '.libraries |= .[1:]' "$WORK/live.json" >"$WORK/new.json"
    cp "$WORK/new.json" "$WORK/snap.json"
    gate "a dropped library link with a regenerated snapshot fails against the baseline" 1
    jq '.storage += [{label: "appended", slot: "999", offset: 0, type: "t_uint256"}]
        | .namespaces["robotmoney.storage.GovernedUUPS"] += ["uint256 appended;"]' "$WORK/live.json" >"$WORK/new.json"
    cp "$WORK/new.json" "$WORK/snap.json"
    gate "an appended variable and namespace member extend the baseline" 0
    cp "$WORK/live.json" "$WORK/new.json"
    : >"$WORK/snap.json"
    if extends "$name" "$WORK/new.json" "$WORK/snap.json" base >"$WORK/out" 2>&1; then
      echo "FAIL an empty baseline snapshot passed"; fails=$((fails + 1))
    else
      echo "ok   an empty baseline snapshot is an error"
    fi
    # The live layout must see the namespaces the proxy depends on.
    for id in robotmoney.storage.GovernedUUPS openzeppelin.storage.AccessControl \
      openzeppelin.storage.ReentrancyGuard openzeppelin.storage.Initializable; do
      if jq -e --arg id "$id" '.namespaces[$id] | length > 0' "$WORK/live.json" >/dev/null; then
        echo "ok   namespace $id is in the gateway layout"
      else
        echo "FAIL namespace $id is missing from the gateway layout"; fails=$((fails + 1))
      fi
    done
    # Every committed snapshot must itself be in the normalized shape.
    for entry in "${CONTRACTS[@]}"; do
      n="${entry%%:*}"
      if jq -e '(.storage | length) > 0 and (.structs | type) == "object" and (.libraries | type) == "array" and (.namespaces | length) > 0' \
        "$SNAPSHOT_DIR/$n.json" >/dev/null 2>&1; then
        echo "ok   committed snapshot $n.json is normalized"
      else
        echo "FAIL committed snapshot $n.json is missing or not normalized"; fails=$((fails + 1))
      fi
    done
    if (( fails > 0 )); then
      echo "check-core-storage-layout selftest: $fails case(s) failed" >&2
      exit 1
    fi
    echo "check-core-storage-layout selftest: all cases passed"
    ;;
  -h|--help) sed -n '2,30p' "$0" ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac
