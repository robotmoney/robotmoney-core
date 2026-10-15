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
#   enums       the members, in declaration order, of every enum that layout can hold, keyed by the enum's type
#               label. `forge inspect` gives an enum type no member list, and a stored enum is the index of its
#               member, so an inserted or reordered member reinterprets every stored value while the storage rows
#               stay identical. The members are read from the enum's definition in the contract's own sources
#               (security review 2026-10-15, review-security-046, ported from the QA branch's layout gate);
#   libraries   the externally linked libraries the runtime code DELEGATECALLs (a library that operates on storage
#               through a pointer argument is part of the layout surface);
#   namespaces  the ERC-7201 namespaces in the inheritance chain (`@custom:storage-location erc7201:<id>`), each with
#               its struct members as declared in source. OpenZeppelin's own namespaces are pinned through the
#               submodule commits below; GovernedUUPS's namespace is Robot Money's own.
#
# A shared pins file records the commits of the two OpenZeppelin submodules: bumping either moves code that owns
# proxy storage (ERC20, ERC4626, AccessControl, ReentrancyGuard, Initializable), so it fails until re-snapshotted.
#
# Usage (repo root, after `forge build`):
#   scripts/ci/check-core-storage-layout.sh              compare every contract against its snapshot
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

# The members of every `enum Scope.Name` type label in the raw `forge inspect` layout on stdin, read from the
# definitions in `files` (one JSON object: label -> [members]). Fails closed (exit 2): a stored enum with no
# definition in the sources, or one name defined twice with different members, is a tooling error, never an
# unrecorded enum (review-security-046).
enums_of() {
  python3 -c '
import json, re, sys
noise = re.compile(r"//[^\n]*|/\*.*?\*/|\"(?:\\.|[^\"\\\n])*\"|\x27(?:\\.|[^\x27\\\n])*\x27", re.S)
scan = re.compile(
    r"\b(?:abstract\s+contract|contract|library|interface)\s+(\w+)[^{;]*\{"
    r"|\benum\s+(\w+)\s*\{([^{}]*)\}"
    r"|[{}]", re.S)
labels = sorted({t.get("label", "") for t in (json.load(sys.stdin).get("types") or {}).values()
                 if t.get("label", "").startswith("enum ")})
defs = {}
for path in sys.argv[1:]:
    stack = []
    for m in scan.finditer(noise.sub(" ", open(path).read())):
        if m.group(1):
            stack.append(m.group(1))
        elif m.group(2):
            scope = stack[-1] if stack else None
            name = f"{scope}.{m.group(2)}" if scope else m.group(2)
            members = [x.strip() for x in m.group(3).split(",") if x.strip()]
            if name in defs and defs[name] != members:
                sys.exit(f"check-core-storage-layout: enum {name} is defined twice with different members ({path})")
            defs[name] = members
        elif m.group(0) == "{":
            stack.append(None)
        elif stack:
            stack.pop()
out = {}
for label in labels:
    members = defs.get(label[len("enum "):])
    if not members:
        sys.exit(f"check-core-storage-layout: storage type {label!r} has no enum definition in its sources")
    out[label] = members
print(json.dumps(out, sort_keys=True))
' "$@" || return 2
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
  local name="$1" src="$2" raw artifact libs ns enums f
  local -a sources=()
  raw="$(cd "$REPO_ROOT" && "$FORGE" inspect "$name" storageLayout --json)" \
    || { echo "check-core-storage-layout: forge inspect $name failed" >&2; return 2; }
  artifact="$REPO_ROOT/out/$(basename "$src")/$name.json"
  [[ -s "$artifact" ]] || { echo "check-core-storage-layout: missing artifact $artifact (run forge build)" >&2; return 2; }
  libs="$(jq -c '[.deployedBytecode.linkReferences | to_entries[] | .key as $f | .value | keys[] | "\($f):\(.)"] | sort' "$artifact")"
  while IFS= read -r f; do sources+=("$REPO_ROOT/$f"); done < <(inheritance_sources "$name" "$src")
  # shellcheck disable=SC2046
  ns="$(namespaces_of $(inheritance_sources "$name" "$src"))"
  enums="$(enums_of "${sources[@]}" <<<"$raw")" || return 2
  jq -S --argjson libs "$libs" --argjson ns "$ns" --argjson enums "$enums" \
    "$NORMALIZE + {libraries: \$libs, namespaces: \$ns, enums: \$enums}" <<<"$raw" \
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

command -v jq >/dev/null || { echo "check-core-storage-layout: jq is required" >&2; exit 2; }
command -v python3 >/dev/null || { echo "check-core-storage-layout: python3 is required (the enum member scan)" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

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
    jq '.enums["enum Selftest.Status"] = ["A", "B"]' "$WORK/live.json" >"$WORK/live-enum.json"
    jq '.enums["enum Selftest.Status"] = ["B", "A"]' "$WORK/live.json" >"$WORK/snap.json"
    cp "$WORK/live.json" "$WORK/live-plain.json"; cp "$WORK/live-enum.json" "$WORK/live.json"
    expect "a reordered storage enum member fails (review-security-046)" 1
    jq '.enums["enum Selftest.Status"] = ["A", "Inserted", "B"]' "$WORK/live-plain.json" >"$WORK/snap.json"
    expect "an inserted storage enum member fails (review-security-046)" 1
    jq 'del(.enums["enum Selftest.Status"])' "$WORK/live.json" >"$WORK/snap.json"
    expect "a storage enum deleted from the snapshot by hand fails (review-security-047)" 1
    cp "$WORK/live-plain.json" "$WORK/live.json"
    # The enum scan reads the definition the label names, scoped like `forge inspect`'s `enum Scope.Name`.
    printf '%s\n' 'contract Selftest { // enum Fake { X }' '  enum Status { A, /* B, */ B }' '}' >"$WORK/Selftest.sol"
    got="$(enums_of "$WORK/Selftest.sol" <<<'{"types":{"t_enum(Status)1":{"label":"enum Selftest.Status"}}}' || true)"
    if [[ "$got" == '{"enum Selftest.Status": ["A", "B"]}' ]]; then
      echo "ok   the enum scan reads members in declaration order and skips comments"
    else
      echo "FAIL the enum scan read $got"; fails=$((fails + 1))
    fi
    if enums_of "$WORK/Selftest.sol" <<<'{"types":{"t_enum(Gone)1":{"label":"enum Selftest.Gone"}}}' >/dev/null 2>&1; then
      echo "FAIL a stored enum with no definition was not a tooling error"; fails=$((fails + 1))
    else
      echo "ok   a stored enum with no definition is a tooling error"
    fi
    : >"$WORK/snap.json"
    expect "an empty snapshot is an error" 2
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
      if jq -e '(.storage | length) > 0 and (.structs | type) == "object" and (.libraries | type) == "array" and (.namespaces | length) > 0 and (.enums | type) == "object"' \
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
  -h|--help) sed -n '2,34p' "$0" ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac
