#!/usr/bin/env bash
# Canonical: docs/technical/demo-runbook.md §3.4 (per-failure-case toggles)
# Implements: docs/implementation-plan.md §13 — failure-case demonstrations.
# Issue: #61.
#
# Drives `testing/demo/demo.sh` once per failure case from the ADR §3.4 list
# and asserts the agent's final-report.json outcome line matches the
# documented expected refusal. Each case runs in its own fresh fork (the
# orchestrator script tears down anvil per run).
#
# Skip-clean: when RMPC_FORK_RPC_URL is unset, demo.sh exits 0 and writes
# a `SKIPPED` marker into the run directory. This wrapper treats that
# marker as a successful skip and exits 0 itself with a banner. The
# convention matches .github/workflows/fork-e2e.yml + openclaw-config.yml.
#
# Exit codes:
#   0 — every named failure case produced its documented refusal outcome
#       (or every case skipped clean for lack of RMPC_FORK_RPC_URL).
#   1 — at least one failure case produced an unexpected outcome.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO="${REPO_ROOT}/testing/demo/demo.sh"

# Each entry: <case_id>|<expected substring of outcome line>
# Substrings match runbook §3.4 expected agent behavior wording.
CASES=(
    "unauthorized_agent|not authorized"
    "insufficient_allowance|allowance below deposit amount"
    "paused_gateway|paused"
    "fee_cap|policy cap"
    "code_hash_mismatch|code hash mismatch"
)

skip_count=0
fail_count=0
pass_count=0
total=${#CASES[@]}

for entry in "${CASES[@]}"; do
    case_id="${entry%%|*}"
    expected="${entry#*|}"

    echo
    echo "===== failure case: ${case_id} ====="
    echo "expected outcome substring: '${expected}'"

    run_dir="$(mktemp -d -t demo-fc-${case_id}-XXXXXX)"
    set +e
    RMPC_DEMO_FAILURE_CASE="$case_id" \
    RMPC_DEMO_RUN_DIR="$run_dir" \
        bash "$DEMO"
    rc=$?
    set -e

    if [[ -f "${run_dir}/SKIPPED" ]]; then
        echo "[skip] ${case_id}: RMPC_FORK_RPC_URL unset"
        skip_count=$(( skip_count + 1 ))
        continue
    fi

    if [[ $rc -ne 0 ]]; then
        echo "[fail] ${case_id}: demo.sh exited rc=$rc"
        fail_count=$(( fail_count + 1 ))
        continue
    fi

    report="${run_dir}/final-report.json"
    if [[ ! -s "$report" ]]; then
        echo "[fail] ${case_id}: no final-report.json produced (rc=$rc)"
        fail_count=$(( fail_count + 1 ))
        continue
    fi

    outcome="$(jq -r .outcome "$report" 2>/dev/null || echo "<unparseable>")"
    echo "outcome line: ${outcome}"

    if [[ "$outcome" == *"$expected"* ]]; then
        echo "[pass] ${case_id}"
        pass_count=$(( pass_count + 1 ))
    else
        echo "[fail] ${case_id}: outcome '${outcome}' does not contain '${expected}'"
        fail_count=$(( fail_count + 1 ))
    fi
done

echo
echo "===== summary ====="
echo "total=${total} pass=${pass_count} fail=${fail_count} skip=${skip_count}"

if [[ $skip_count -eq $total ]]; then
    echo "[skip] all failure cases skipped (RMPC_FORK_RPC_URL unset)"
    exit 0
fi

if [[ $fail_count -gt 0 ]]; then
    exit 1
fi
exit 0
