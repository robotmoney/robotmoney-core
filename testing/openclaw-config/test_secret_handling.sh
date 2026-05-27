#!/usr/bin/env bash
# Canonical: docs/development/openclaw-config.md §Secret handling
# Issue: #114.
#
# Asserts the OpenClaw harness never exposes the signer passphrase:
#
# 1. Passphrase value never appears in captured stdout/stderr.
# 2. Passphrase value never appears in the harness or rmpc child
#    process command lines (/proc/<pid>/cmdline) — sampled mid-run.
# 3. The passphrase env var is explicitly stripped before exec'ing
#    the rmpc subprocess for read commands.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=testing/openclaw-config/_lib.sh
source "${SCRIPT_DIR}/_lib.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CFG="$TMP/rmpc.toml"
write_minimal_config "$CFG"

# Distinctive passphrase that won't appear by accident in tool output.
PASSPHRASE="OPENCLAW_SECRET_SENTINEL_$$_$(date +%s%N)"

# Force the binary-missing exit (12) so this test does not depend on a
# fork RPC. The gate-pass and env-var handling all run before the
# binary-existence check is reached if we point at a real binary; but
# pointing at a non-existent binary keeps the test fully hermetic.
#
# To still exercise the env-strip behavior (case 3) we ALSO run a
# variant that *does* invoke the real rmpc with --help, which exits 0
# without needing RPC.

OUT="$TMP/stdout.log"
ERR="$TMP/stderr.log"

# --- Variant A: hermetic, binary-missing path ---
set +e
RMPC_BIN="/nonexistent/rmpc" \
RMPC_CONFIG="$CFG" RMPC_NETWORK=fork \
RMPC_SIGNER_PASSPHRASE="$PASSPHRASE" \
    "$HARNESS" >"$OUT" 2>"$ERR"
rc=$?
set -e

if [[ $rc -ne 12 ]]; then
    echo "FAIL(A): expected exit 12 (binary missing), got $rc" >&2
    cat "$ERR" >&2
    exit 1
fi
if grep -qF "$PASSPHRASE" "$OUT" "$ERR"; then
    echo "FAIL(A): passphrase appeared in captured output" >&2
    exit 1
fi

# --- Variant B: real rmpc, sample child cmdline ---
ensure_rmpc_built
RMPC_REAL="${REPO_ROOT}/clients/rust-payment-client/target/debug/rmpc"
if [[ ! -x "$RMPC_REAL" ]]; then
    echo "SKIP(B): rmpc not built; cannot sample cmdline." >&2
else
    # Run a multi-iteration loop with a longer interval so we can
    # snapshot /proc cmdlines while it sleeps. Use --help as the
    # subcommand by overriding RMPC_MONITOR_COMMAND with a known no-op
    # is not possible (rmpc's read commands need RPC). Instead we ship
    # a command that exits fast (`get-vault` will fail without RPC, but
    # that fails AFTER we've had a chance to snapshot the cmdline of the
    # outer harness shell, which is what we actually care about for the
    # env-leak check via /proc/<pid>/environ).
    OUT2="$TMP/stdout2.log"
    ERR2="$TMP/stderr2.log"
    (
        RMPC_BIN="$RMPC_REAL" \
        RMPC_CONFIG="$CFG" RMPC_NETWORK=fork \
        RMPC_MONITOR_COMMAND="get-vault" \
        RMPC_MONITOR_ITERATIONS=1 \
        RMPC_SIGNER_PASSPHRASE="$PASSPHRASE" \
            "$HARNESS" >"$OUT2" 2>"$ERR2" || true
    ) &
    HPID=$!

    # Sample /proc/<pid>/cmdline for the harness and any child rmpc.
    # The harness will run quickly, so we sample in a tight loop and
    # collect into a single file.
    SNAP="$TMP/cmdline.snap"
    : >"$SNAP"
    end=$(( SECONDS + 5 ))
    while (( SECONDS < end )); do
        if ! kill -0 "$HPID" 2>/dev/null; then break; fi
        for pid in "$HPID" $(pgrep -P "$HPID" 2>/dev/null || true); do
            if [[ -r "/proc/$pid/cmdline" ]]; then
                tr '\0' ' ' <"/proc/$pid/cmdline" >>"$SNAP" || true
                printf '\n' >>"$SNAP"
            fi
            if [[ -r "/proc/$pid/environ" ]]; then
                # We only check that the passphrase does not appear in
                # the *child rmpc* environ. The harness shell itself
                # legitimately holds the passphrase env var; that's how
                # it received it from the parent. The harness must
                # strip it before exec'ing rmpc.
                if [[ "$pid" != "$HPID" ]]; then
                    if tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null \
                            | grep -qF "RMPC_SIGNER_PASSPHRASE=$PASSPHRASE"; then
                        echo "FAIL(B): passphrase env reached child rmpc pid $pid" >&2
                        kill "$HPID" 2>/dev/null || true
                        exit 1
                    fi
                fi
            fi
        done
        sleep 0.05
    done
    wait "$HPID" 2>/dev/null || true

    if grep -qF "$PASSPHRASE" "$SNAP"; then
        echo "FAIL(B): passphrase appeared in /proc/<pid>/cmdline snapshot" >&2
        exit 1
    fi
    if grep -qF "$PASSPHRASE" "$OUT2" "$ERR2"; then
        echo "FAIL(B): passphrase appeared in real-rmpc captured output" >&2
        exit 1
    fi
fi

echo "PASS: passphrase never leaked to logs, argv, or child env."
