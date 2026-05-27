#!/usr/bin/env bash
# Canonical: docs/development/openclaw-config.md
# Implements: implementation-plan §10 (OpenClaw installation).
# Issue:      #114.
#
# OpenClaw harness wrapper around `rmpc`.
#
# Responsibilities:
#
# - Resolve the rmpc binary path (built from `clients/rust-payment-client`).
# - Enforce the fork-default / mainnet-toggle policy: if `RMPC_NETWORK=mainnet`
#   and `RMPC_ALLOW_MAINNET` is not the literal string `yes`, refuse.
# - Run a bounded read-only monitor loop: repeatedly invoke a configured
#   `rmpc get-*` subcommand, sleeping `RMPC_MONITOR_INTERVAL_SECS` between
#   iterations, exiting 0 after `RMPC_MONITOR_ITERATIONS` successful reads
#   or non-zero on the first read failure.
# - Read the signer passphrase exclusively from `RMPC_SIGNER_PASSPHRASE`
#   environment variable. The harness never echoes the passphrase, never
#   passes it on the command line, and explicitly unsets it before exec'ing
#   `rmpc` for read-only commands (which do not need a signer).
#
# Exit codes:
#   0  — success (all configured iterations succeeded).
#   10 — mainnet-without-toggle refusal (documented sentinel).
#   11 — missing required configuration.
#   12 — rmpc binary not found / not built.
#   20 — read iteration failed.
#
# Documented refusal sentinel (asserted by tests):
#   `openclaw-harness: refusing to run on mainnet without RMPC_ALLOW_MAINNET=yes`
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RMPC_BIN_DEFAULT="${REPO_ROOT}/clients/rust-payment-client/target/debug/rmpc"

usage() {
    cat <<'USAGE'
openclaw-harness: bounded long-running OpenClaw monitor wrapper around rmpc.

Required env:
  RMPC_CONFIG               Path to rmpc TOML config.
  RMPC_NETWORK              One of: fork | devnet | mainnet (default: fork).
  RMPC_MONITOR_COMMAND      rmpc subcommand to loop (default: get-vault).

Optional env:
  RMPC_ALLOW_MAINNET        Must be literal `yes` to run with RMPC_NETWORK=mainnet.
  RMPC_MONITOR_ITERATIONS   How many successful reads before exiting 0 (default: 3).
  RMPC_MONITOR_INTERVAL_SECS  Sleep between reads (default: 1).
  RMPC_BIN                  Override rmpc binary path.
  RMPC_SIGNER_PASSPHRASE    Signer passphrase. Never logged, never argv-passed.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
fi

: "${RMPC_NETWORK:=fork}"
: "${RMPC_MONITOR_COMMAND:=get-vault}"
: "${RMPC_MONITOR_ITERATIONS:=3}"
: "${RMPC_MONITOR_INTERVAL_SECS:=1}"
RMPC_BIN="${RMPC_BIN:-$RMPC_BIN_DEFAULT}"

if [[ -z "${RMPC_CONFIG:-}" ]]; then
    echo "openclaw-harness: RMPC_CONFIG is required" >&2
    exit 11
fi

# Mainnet gate: refuse unless explicit toggle.
if [[ "$RMPC_NETWORK" == "mainnet" && "${RMPC_ALLOW_MAINNET:-}" != "yes" ]]; then
    echo "openclaw-harness: refusing to run on mainnet without RMPC_ALLOW_MAINNET=yes" >&2
    exit 10
fi

if [[ ! -x "$RMPC_BIN" ]]; then
    echo "openclaw-harness: rmpc binary not found or not executable at $RMPC_BIN" >&2
    echo "openclaw-harness: build it first: cargo build --manifest-path clients/rust-payment-client/Cargo.toml --bin rmpc" >&2
    exit 12
fi

# Read-only monitor loop. Read commands do not need the signer. We
# explicitly drop the passphrase from the environment we hand to rmpc
# so a future bug in a read command can't inadvertently log it.
echo "openclaw-harness: network=$RMPC_NETWORK command=$RMPC_MONITOR_COMMAND iterations=$RMPC_MONITOR_ITERATIONS interval=${RMPC_MONITOR_INTERVAL_SECS}s"

i=0
while (( i < RMPC_MONITOR_ITERATIONS )); do
    i=$(( i + 1 ))
    if ! env -u RMPC_SIGNER_PASSPHRASE \
            "$RMPC_BIN" "$RMPC_MONITOR_COMMAND" --config "$RMPC_CONFIG"; then
        echo "openclaw-harness: read iteration $i failed" >&2
        exit 20
    fi
    if (( i < RMPC_MONITOR_ITERATIONS )); then
        sleep "$RMPC_MONITOR_INTERVAL_SECS"
    fi
done

echo "openclaw-harness: completed $RMPC_MONITOR_ITERATIONS iterations cleanly"
exit 0
