#!/usr/bin/env bash
# Shared helpers for testing/openclaw-config tests.
#
# - REPO_ROOT: absolute path to the repo root.
# - HARNESS:   absolute path to openclaw_harness.sh.
# - ensure_rmpc_built: build rmpc once per test run (no-op if up-to-date).
# - write_minimal_config <path>: write a parseable rmpc.toml for read-only
#   commands, pinned at the local Geth devnet defaults.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HARNESS="${REPO_ROOT}/testing/openclaw-config/openclaw_harness.sh"

ensure_rmpc_built() {
    cargo build --quiet \
        --manifest-path "${REPO_ROOT}/clients/rust-payment-client/Cargo.toml" \
        --bin rmpc
}

# Write a minimal rmpc.toml that loads cleanly. Field set per
# `clients/rust-payment-client/src/config.rs`. The signer block is
# present (config loader requires it) but read commands never invoke
# the signer.
write_minimal_config() {
    local cfg_path="$1"
    local rpc_url="${2:-http://127.0.0.1:8545}"
    local chain_id="${3:-31337}"
    local keystore="${cfg_path%.toml}.keystore.json"
    local zeros
    zeros="$(printf '0%.0s' {1..64})"
    cat >"$cfg_path" <<EOF
chain_id              = ${chain_id}
rpc_url               = "${rpc_url}"
gateway_address       = "0x000000000000000000000000000000000000dEaD"
usdc_address          = "0x0000000000000000000000000000000000000001"
vault_address         = "0x0000000000000000000000000000000000000002"
gateway_runtime_hash  = "0x${zeros}"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "${keystore}"
EOF
}
