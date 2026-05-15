#!/usr/bin/env bash
# Canonical: docs/walkthroughs/openclaw-config.md §Long-running task
# Issue: #114.
#
# Bounded long-running monitor test:
#
# - Builds rmpc.
# - Points the harness at the fork-anvil RPC URL configured by the
#   `fork-e2e-rust` setup (env var `RMPC_FORK_RPC_URL`). If the secret
#   is missing, prints a loud-but-clean SKIP — same convention as
#   `.github/workflows/fork-e2e.yml`.
# - Runs the harness with N iterations against a real Base mainnet
#   fork, asserting every captured stdout block parses as JSON with a
#   non-zero `chain_id` field.
#
# Exits 0 on success or on missing-RPC skip. Non-zero on any iteration
# failure or schema drift.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=testing/openclaw-config/_lib.sh
source "${SCRIPT_DIR}/_lib.sh"

ITERATIONS="${RMPC_MONITOR_ITERATIONS:-3}"
INTERVAL="${RMPC_MONITOR_INTERVAL_SECS:-1}"

# Outcome file location (read by the CI workflow's assert step). CI sets
# OPENCLAW_OUTCOME_DIR to keep generated artifacts out of the source checkout.
OUTCOME_DIR="${OPENCLAW_OUTCOME_DIR:-${SCRIPT_DIR}/artifacts/long-running}"
mkdir -p "$OUTCOME_DIR"
OUTCOME_FILE="${OUTCOME_DIR}/outcome.txt"

if [[ -z "${RMPC_FORK_RPC_URL:-}" ]]; then
    echo "SKIP: RMPC_FORK_RPC_URL not set; skipping bounded long-running test."
    echo "      Set the secret to actually exercise the OpenClaw harness against Base fork."
    printf 'outcome=skipped\nreason=RMPC_FORK_RPC_URL not set\n' > "$OUTCOME_FILE"
    exit 0
fi

ensure_rmpc_built

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Base mainnet, real RobotMoneyVault address (matches
# testing/fork-e2e-rust/src/addresses.rs).
CFG="$TMP/rmpc.toml"
cat >"$CFG" <<EOF
chain_id              = 8453
rpc_url               = "$RMPC_FORK_RPC_URL"
gateway_address       = "0x000000000000000000000000000000000000dEaD"
usdc_address          = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
vault_address         = "0x4F83837cC2BB7E5b7DA89cf36c52A7D3F6b49DDD"
gateway_runtime_hash  = "0x0000000000000000000000000000000000000000000000000000000000000000"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "${TMP}/keystore.json"
EOF

OUT="$TMP/stdout.log"
ERR="$TMP/stderr.log"

set +e
RMPC_CONFIG="$CFG" RMPC_NETWORK=fork \
RMPC_MONITOR_COMMAND="get-vault" \
RMPC_MONITOR_ITERATIONS="$ITERATIONS" \
RMPC_MONITOR_INTERVAL_SECS="$INTERVAL" \
    "$HARNESS" >"$OUT" 2>"$ERR"
rc=$?
set -e

if [[ $rc -ne 0 ]]; then
    echo "FAIL: harness exited $rc" >&2
    sed 's/^/  stderr: /' "$ERR" >&2
    printf 'outcome=fail\nreason=harness exited %d\n' "$rc" > "$OUTCOME_FILE"
    exit 1
fi

# Each iteration prints one JSON envelope to stdout. Use python to
# split on `}\n{` boundaries — the harness prints one banner line + N
# JSON blobs; we strip the first non-JSON line before splitting.
set +e
python3 - "$OUT" "$ITERATIONS" <<'PY'
import json, sys, re
path, want = sys.argv[1], int(sys.argv[2])
data = open(path).read()
# Strip the harness banner + completion lines (start with "openclaw-harness:").
json_text = "\n".join(
    line for line in data.splitlines()
    if not line.startswith("openclaw-harness:")
)
# Split into top-level JSON objects: simplest approach — use raw_decode in a loop.
dec = json.JSONDecoder()
i, envs = 0, []
n = len(json_text)
while i < n:
    while i < n and json_text[i].isspace():
        i += 1
    if i >= n: break
    obj, end = dec.raw_decode(json_text, i)
    envs.append(obj)
    i = end
if len(envs) != want:
    print(f"FAIL: expected {want} JSON envelopes, got {len(envs)}", file=sys.stderr)
    sys.exit(1)
for k, e in enumerate(envs, 1):
    cid = e.get("chain_id")
    if not isinstance(cid, int) or cid <= 0:
        print(f"FAIL: envelope {k} has bad chain_id: {cid!r}", file=sys.stderr)
        sys.exit(1)
print(f"OK: {len(envs)} envelopes parsed, chain_id sane in all of them.")
PY
py_rc=$?
set -e

if [[ $py_rc -ne 0 ]]; then
    printf 'outcome=fail\nreason=JSON envelope validation failed\n' > "$OUTCOME_FILE"
    exit 1
fi

printf 'outcome=pass\nreason=%d clean iterations of get-vault\n' "$ITERATIONS" > "$OUTCOME_FILE"
echo "PASS: bounded long-running monitor completed $ITERATIONS clean iterations."
