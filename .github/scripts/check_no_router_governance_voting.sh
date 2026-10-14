#!/usr/bin/env bash
# Guard: no client builds a call to RouterGovernance's deleted voting path.
#
# Canonical: docs/technical/governance-decisions.md §3.3 (no voting)
# Canonical: docs/architecture.md §2.3 (Governance Boundary)
# Issue: #1698
#
# Issue 1698 deleted RouterGovernance.propose, vote and execute, with the voter
# set, voting power, quorum and voting period. The weight setter's one-call
# applyReceipt replaced them. A client that still encodes one of those calls,
# binds their ABI entries, or tells its reader they exist would build calldata
# for a selector the deployed contract does not have. This guard fails when a
# tracked file under clients/ does any of that:
#   1. names a deleted RouterGovernance member, as `RouterGovernance.propose`
#      (TS, docs, comments) or `RouterGovernance::proposeCall` (alloy bindings);
#   2. declares a deleted signature in a human-readable or sol! ABI:
#      `function propose(address[]`, `function vote(uint256`,
#      `function execute(uint256`;
#   3. carries a deleted member in an ABI entry: any RouterGovernance*.json, and
#      any file that names RouterGovernance and lists a `propose` or `vote`
#      entry (TimelockController's `execute` stays legal there).
# Run from any directory. Set CHECK_REPO_ROOT to point at a synthetic tree
# (used by the self-test, .github/scripts/tests/test_check_no_router_governance_voting.sh).
set -euo pipefail

ROOT="${CHECK_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

# Top-level directories the guard covers. Widen by adding one here.
SCOPE=(clients)

DELETED='propose|vote|execute|cancel|activeProposal|proposalState|cadenceParams|currentProposalId|votingPower|proposalVoteSnapshot|quorumThreshold|votingPeriod'
NAMED="RouterGovernance(\\.|::)(${DELETED})([^A-Za-z0-9_]|Call|\$)"
SIGNATURE='function (propose\(address\[\]|vote\(uint256|execute\(uint256)'
ABI_JSON_ENTRY="\"name\"[[:space:]]*:[[:space:]]*\"(${DELETED})\""
ABI_ANY_ENTRY="\"?name\"?[[:space:]]*:[[:space:]]*[\"'](propose|vote)[\"']"
fail=0

report() { # title hits
  if [[ -n "$2" ]]; then
    echo "FAIL: $1:" >&2
    echo "$2" >&2
    fail=1
  fi
}

hits="$(git grep -n -E -e "$NAMED" -e "$SIGNATURE" -- "${SCOPE[@]}" || true)"
report "clients name RouterGovernance's deleted voting path (issue 1698)" "$hits"

# grep -H prints file:line:text, so each hit names its file.
grep_each() { # pattern, then file list on stdin
  local f
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    grep -n -H -E "$1" "$f" || true
  done
  return 0
}

abi_hits="$(git ls-files -- "${SCOPE[@]}" | { grep -E '(^|/)RouterGovernance[^/]*\.json$' || true; } | grep_each "$ABI_JSON_ENTRY")"
report "a RouterGovernance ABI binding still lists a deleted member" "$abi_hits"

obj_hits="$({ git grep -l -i -e 'routergovernance' -e 'router_governance' -- "${SCOPE[@]}" || true; } | grep_each "$ABI_ANY_ENTRY")"
report "a file that names RouterGovernance declares a propose or vote ABI entry" "$obj_hits"

if [[ $fail -ne 0 ]]; then
  echo "The voting path is gone: apply a receipt with RouterGovernance.applyReceipt through the timelock (govern row apply-receipt)." >&2
  exit 1
fi
echo "OK: no client names RouterGovernance's deleted voting path"
