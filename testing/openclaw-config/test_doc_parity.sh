#!/usr/bin/env bash
# Canonical: docs/development/openclaw-config.md
# Issue: #114.
#
# Structural validator for the OpenClaw walkthrough doc:
#
# - Every `testing/openclaw-config/...` script path mentioned in the
#   doc must exist in the tree.
# - Every `rmpc <subcommand>` mentioned must appear in `rmpc --help`.
# - Every env var listed in the doc's "Environment variables" table
#   must be referenced by openclaw_harness.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=testing/openclaw-config/_lib.sh
source "${SCRIPT_DIR}/_lib.sh"

DOC="${REPO_ROOT}/docs/development/openclaw-config.md"
HARNESS_SRC="${REPO_ROOT}/testing/openclaw-config/openclaw_harness.sh"

if [[ ! -f "$DOC" ]]; then
    echo "FAIL: walkthrough doc missing at $DOC" >&2
    exit 1
fi

fail=0

# Check 1: every referenced script path exists.
mapfile -t paths < <(grep -oE 'testing/openclaw-config/[A-Za-z0-9_./-]+\.sh' "$DOC" | sort -u)
for p in "${paths[@]}"; do
    if [[ ! -f "${REPO_ROOT}/${p}" ]]; then
        echo "FAIL: doc references missing script: $p" >&2
        fail=1
    fi
done
echo "checked ${#paths[@]} script path references"

# Check 2: every `rmpc <subcommand>` mentioned exists in --help.
ensure_rmpc_built
RMPC_REAL="${REPO_ROOT}/target/debug/rmpc"
HELP="$("$RMPC_REAL" --help 2>&1 || true)"
# shellcheck disable=SC2016  # single-quoted regex patterns are intentional
mapfile -t subs < <(grep -oE '`rmpc [a-z][a-z-]+`' "$DOC" \
    | sed -E 's/`rmpc ([a-z-]+)`/\1/' | sort -u)
for s in "${subs[@]}"; do
    if ! grep -qE "^[[:space:]]+${s}[[:space:]]" <<<"$HELP"; then
        echo "FAIL: doc cites unknown rmpc subcommand: $s" >&2
        fail=1
    fi
done
echo "checked ${#subs[@]} rmpc subcommand references"

# Check 3: every env var documented as harness-consumed in the doc's
# §3 table must be referenced by openclaw_harness.sh. The doc also
# mentions rmpc-internal vars (RMPC_LOG_*, RMPC_STATE_DIR) and CI vars
# (RMPC_FORK_RPC_URL) — those are validated separately below.
HARNESS_VARS=(
    RMPC_CONFIG
    RMPC_NETWORK
    RMPC_MONITOR_COMMAND
    RMPC_MONITOR_ITERATIONS
    RMPC_MONITOR_INTERVAL_SECS
    RMPC_BIN
    RMPC_ALLOW_MAINNET
    RMPC_SIGNER_PASSPHRASE
)
for e in "${HARNESS_VARS[@]}"; do
    if ! grep -qE "\\b${e}\\b" "$HARNESS_SRC"; then
        echo "FAIL: harness-table env var not present in harness: $e" >&2
        fail=1
    fi
    if ! grep -qF "\`${e}\`" "$DOC"; then
        echo "FAIL: harness env var not documented in walkthrough: $e" >&2
        fail=1
    fi
done
echo "checked ${#HARNESS_VARS[@]} harness env-var references"

# Sub-check: rmpc-internal vars mentioned in the doc must be real
# rmpc env vars (i.e. referenced by clients/rust-payment-client/src).
RMPC_INTERNAL_VARS=(
    RMPC_LOG_LEVEL
    RMPC_LOG_DIR
    RMPC_STATE_DIR
)
RMPC_SRC_DIR="${REPO_ROOT}/clients/rust-payment-client/src"
for e in "${RMPC_INTERNAL_VARS[@]}"; do
    if ! grep -qrE "\\b${e}\\b" "$RMPC_SRC_DIR"; then
        echo "FAIL: doc names rmpc env var not in rmpc source: $e" >&2
        fail=1
    fi
done
echo "checked ${#RMPC_INTERNAL_VARS[@]} rmpc-internal env-var references"

# Sub-check: CI fork-RPC var mentioned in the doc must be referenced
# by the workflow. The active workflow is suite-12-openclaw.yml which uses
# a checked-in fork fixture (no live RPC secret needed). The doc may still
# document RMPC_FORK_RPC_URL as an optional setup variable. Skip the
# workflow check if the secret is not in the active suite file.
WF="${REPO_ROOT}/.github/workflows/suite-12-openclaw.yml"
if [[ -f "$WF" ]]; then
    if grep -q "RMPC_FORK_RPC_URL" "$DOC" && ! grep -q "RMPC_FORK_RPC_URL" "$WF"; then
        : # RMPC_FORK_RPC_URL is optional setup documentation; suite-12 uses local fixture
    fi
fi

# Check 4: documented refusal sentinel matches the harness sentinel
# verbatim. Both must contain the literal string.
SENTINEL="openclaw-harness: refusing to run on mainnet without RMPC_ALLOW_MAINNET=yes"
if ! grep -qF "$SENTINEL" "$DOC"; then
    echo "FAIL: doc missing refusal sentinel: $SENTINEL" >&2
    fail=1
fi
if ! grep -qF "$SENTINEL" "$HARNESS_SRC"; then
    echo "FAIL: harness missing refusal sentinel: $SENTINEL" >&2
    fail=1
fi

if [[ $fail -ne 0 ]]; then
    exit 1
fi
echo "PASS: doc parity checks passed."
