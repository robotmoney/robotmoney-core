#!/usr/bin/env bash
# Canonical: docs/walkthroughs/openclaw-config.md §Mainnet gate
# Issue: #114.
#
# Asserts the OpenClaw harness refuses to run with RMPC_NETWORK=mainnet
# unless the explicit RMPC_ALLOW_MAINNET=yes toggle is set, and that the
# documented refusal sentinel appears on stderr.
#
# This test does NOT require an RPC fixture or the rmpc binary — the
# refusal happens before any rmpc invocation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=testing/openclaw-config/_lib.sh
source "${SCRIPT_DIR}/_lib.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CFG="$TMP/rmpc.toml"
write_minimal_config "$CFG"

REFUSAL_SENTINEL="openclaw-harness: refusing to run on mainnet without RMPC_ALLOW_MAINNET=yes"

# Case 1: mainnet without toggle → refuses with documented sentinel + exit 10.
set +e
out_err="$(env -u RMPC_ALLOW_MAINNET \
    RMPC_CONFIG="$CFG" RMPC_NETWORK=mainnet \
    "$HARNESS" 2>&1 >/dev/null)"
rc=$?
set -e

if [[ $rc -ne 10 ]]; then
    echo "FAIL: expected exit 10, got $rc" >&2
    echo "stderr: $out_err" >&2
    exit 1
fi
if ! grep -qF "$REFUSAL_SENTINEL" <<<"$out_err"; then
    echo "FAIL: refusal sentinel missing from stderr" >&2
    echo "stderr: $out_err" >&2
    exit 1
fi

# Case 2: mainnet with the wrong toggle value → still refuses.
set +e
out_err="$(RMPC_CONFIG="$CFG" RMPC_NETWORK=mainnet RMPC_ALLOW_MAINNET=true \
    "$HARNESS" 2>&1 >/dev/null)"
rc=$?
set -e
if [[ $rc -ne 10 ]]; then
    echo "FAIL: RMPC_ALLOW_MAINNET=true must NOT bypass; expected exit 10, got $rc" >&2
    exit 1
fi

# Case 3: fork mode (default) does NOT refuse — it proceeds past the
# gate. We deliberately point at a non-existent rmpc binary so we can
# confirm the gate passed without needing a real fork RPC: a successful
# gate-pass produces exit 12 ("rmpc binary not found"), not 10.
set +e
out_err="$(RMPC_BIN="/nonexistent/rmpc" \
    RMPC_CONFIG="$CFG" RMPC_NETWORK=fork \
    "$HARNESS" 2>&1 >/dev/null)"
rc=$?
set -e
if [[ $rc -ne 12 ]]; then
    echo "FAIL: fork mode must pass the mainnet gate; expected exit 12 (binary missing), got $rc" >&2
    echo "stderr: $out_err" >&2
    exit 1
fi

echo "PASS: mainnet gate enforced; fork mode passes the gate."
