#!/usr/bin/env bash
# Self-test for .github/scripts/check_no_router_governance_voting.sh
#
# Canonical: .github/scripts/check_no_router_governance_voting.sh
# Issue: #1698
#
# Builds throwaway git trees. Asserts the guard is green on a clean tree that
# uses the surviving surface (applyReceipt, the router's weight-setter
# rotation, the timelock's own execute) and red on each planted form of the
# deleted voting path: a doc or comment naming RouterGovernance.propose, an
# alloy proposeCall, a human-readable propose signature, a RouterGovernance ABI
# JSON with a vote entry, and a TS object ABI with a vote entry. A planted line
# outside clients/ stays green (scope). Also checks the workflow wires both
# scripts. The real tree is checked by the guard's own workflow step, not here.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
GUARD="$REPO_ROOT/.github/scripts/check_no_router_governance_voting.sh"
WORKFLOW="$REPO_ROOT/.github/workflows/suite-13-doc-checks.yml"
cases=0
failures=0

make_tree() {
  local d
  d="$(mktemp -d)"
  mkdir -p "$d/clients/rmpc/src" "$d/clients/rmpc/abi" "$d/clients/dapp/src" "$d/docs"
  cat >"$d/clients/rmpc/src/apply.rs" <<'EOF'
//! The Safe applies a receipt with `RouterGovernance.applyReceipt` through the timelock.
let data = RouterGovernance::applyReceiptCall { receiptId, payloadDigest, vaults, bps }.abi_encode();
let rot = PortfolioRouter::proposeWeightSetterRotationCall { target }.abi_encode();
let w = RouterGovernance::currentWeightsCall {}.abi_encode();
EOF
  cat >"$d/clients/rmpc/abi/RouterGovernance.json" <<'EOF'
[
  { "type": "function", "name": "applyReceipt", "inputs": [] },
  { "type": "function", "name": "currentWeights", "inputs": [] }
]
EOF
  cat >"$d/clients/dapp/src/timelock.ts" <<'EOF'
// RouterGovernance admin calls go through the timelock.
export const timelockAbi = [
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt)",
  { type: "function", name: "execute", inputs: [] },
];
EOF
  echo "# clean" >"$d/docs/other.md"
  git -C "$d" init -q
  git -C "$d" add -A
  echo "$d"
}

run_guard() { CHECK_REPO_ROOT="$1" bash "$GUARD" >/dev/null 2>&1; }

expect() { # name want(0|nonzero) tree
  cases=$((cases + 1))
  local rc=0
  run_guard "$3" || rc=$?
  if { [[ $2 == 0 ]] && [[ $rc -ne 0 ]]; } || { [[ $2 != 0 ]] && [[ $rc -eq 0 ]]; }; then
    echo "FAIL: $1 (exit $rc)" >&2
    failures=$((failures + 1))
  else
    echo "ok: $1"
  fi
}

plant() { # tree path line
  printf '%s\n' "$3" >>"$1/$2"
  git -C "$1" add -A
}

t="$(make_tree)"
expect "clean tree passes" 0 "$t"
rm -rf "$t"

t="$(make_tree)"
plant "$t" clients/dapp/src/timelock.ts '// 2. RouterGovernance.propose(current router weights)'
expect "planted RouterGovernance.propose comment fails" 1 "$t"
rm -rf "$t"

t="$(make_tree)"
mkdir -p "$t/clients/rmpc/docs"
# shellcheck disable=SC2016 # the backticks are literal Markdown
plant "$t" clients/rmpc/docs/governance.md 'Draft a `RouterGovernance.vote(proposalId)` call.'
expect "planted RouterGovernance.vote in a client doc fails" 1 "$t"
rm -rf "$t"

t="$(make_tree)"
plant "$t" clients/rmpc/src/apply.rs 'let calldata = RouterGovernance::proposeCall { vaults, bps }.abi_encode();'
expect "planted alloy proposeCall fails" 1 "$t"
rm -rf "$t"

t="$(make_tree)"
plant "$t" clients/rmpc/src/apply.rs 'let id = RouterGovernance::currentProposalIdCall {}.abi_encode();'
expect "planted deleted read currentProposalIdCall fails" 1 "$t"
rm -rf "$t"

t="$(make_tree)"
plant "$t" clients/dapp/src/timelock.ts '  "function propose(address[] vaults, uint256[] bps) returns (uint256)",'
expect "planted human-readable propose signature fails" 1 "$t"
rm -rf "$t"

t="$(make_tree)"
cat >"$t/clients/rmpc/abi/RouterGovernance.json" <<'EOF'
[
  { "type": "function", "name": "applyReceipt", "inputs": [] },
  { "type": "function", "name": "vote", "inputs": [] }
]
EOF
git -C "$t" add -A
expect "RouterGovernance ABI JSON with a vote entry fails" 1 "$t"
rm -rf "$t"

t="$(make_tree)"
plant "$t" clients/dapp/src/timelock.ts '  { type: "function", name: "vote", inputs: [{ name: "proposalId", type: "uint256" }] },'
expect "TS object ABI with a vote entry beside RouterGovernance fails" 1 "$t"
rm -rf "$t"

t="$(make_tree)"
# shellcheck disable=SC2016 # the backticks are literal Markdown
plant "$t" docs/other.md 'History: `RouterGovernance.propose` was deleted by issue 1698.'
expect "a line outside clients/ is out of scope" 0 "$t"
rm -rf "$t"

# Workflow wires both scripts.
for s in check_no_router_governance_voting.sh test_check_no_router_governance_voting.sh; do
  cases=$((cases + 1))
  if grep -q "$s" "$WORKFLOW"; then
    echo "ok: workflow runs $s"
  else
    echo "FAIL: workflow missing $s" >&2
    failures=$((failures + 1))
  fi
done

if [[ $cases -eq 0 ]]; then
  echo "FAIL: zero cases ran" >&2
  exit 1
fi
echo "$cases cases, $failures failures"
[[ $failures -eq 0 ]]
