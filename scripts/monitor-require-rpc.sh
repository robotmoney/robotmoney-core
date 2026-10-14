#!/usr/bin/env bash
# Preflight for .github/workflows/suite-18-live-monitoring.yml.
#
# The nightly live monitors (venue liveness, governance proposals, USDC
# upgrade) need the BASE_RPC_URL secret, exposed to the job as RPC_URL. A
# missing secret used to turn every step into a ::warning + exit 0, so the
# scheduled run went green while running nothing. On the schedule event this
# script fails loudly instead; on any other event (workflow_dispatch) it only
# warns, so a manual run without the secret still exercises the mock path.
#
# Canonical: docs/technical/upstream-monitoring-runbook.md §5
# Tested by: .github/scripts/tests/test_upstream_monitoring.sh
set -euo pipefail

if [[ -n "${RPC_URL:-}" ]]; then
    exit 0
fi

if [[ "${GITHUB_EVENT_NAME:-}" == "schedule" ]]; then
    echo "::error::BASE_RPC_URL secret missing; nightly live upstream monitors did not run (see docs/technical/upstream-monitoring-runbook.md §5)"
    exit 1
fi

echo "::warning::BASE_RPC_URL not set — live upstream monitors will be skipped (event: ${GITHUB_EVENT_NAME:-unknown})"
exit 0
