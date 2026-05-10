#!/usr/bin/env bash
# Canonical: clients/dapp/tests/e2e/fork-roundtrip.spec.ts (issue #85).
#
# Boots the full fork-roundtrip harness:
#
#   1. Spawns a local anvil (no fork URL needed — gateway is fresh).
#   2. Deploys MockUSDC + MockVault + RobotMoneyGateway via
#      `forge script Deploy.s.sol`. Anvil account[0] is admin,
#      account[2] is pauser, account[1] is agent (matches the
#      addresses hard-coded in fork-roundtrip.spec.ts).
#   3. Builds rmpc + rmpc-keystore-import, mints a keystore for
#      account[1] (the agent EOA), and writes an rmpc.toml that
#      points at the deployed gateway.
#   4. Exports ROUNDTRIP_* env vars so Playwright can find everything,
#      then runs `pnpm test:e2e -- fork-roundtrip.spec.ts`.
#
# Cleanup: kills anvil on EXIT regardless of test result.
#
# Exit codes:
#   0  — Playwright suite passed.
#   non-zero — propagated from the failing step.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DAPP_DIR="$REPO_ROOT/clients/dapp"
RMPC_DIR="$REPO_ROOT/clients/rust-payment-client"

# Anvil pre-funded accounts (deterministic mnemonic).
ADMIN_ADDRESS="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"   # account[0]
ADMIN_PRIVKEY="REDACTED_PRIVATE_KEY"
AGENT_ADDRESS="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"   # account[1]
AGENT_PRIVKEY="REDACTED_PRIVATE_KEY"
PAUSER_ADDRESS="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"  # account[2]
SHARE_RECEIVER="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"  # account[2] (reused)

ANVIL_PORT="${ROUNDTRIP_ANVIL_PORT:-8545}"
RPC_URL="http://127.0.0.1:${ANVIL_PORT}"
WORK_DIR="${ROUNDTRIP_WORK_DIR:-$(mktemp -d -t rmpc-fork-roundtrip.XXXXXX)}"
mkdir -p "$WORK_DIR"
DEPLOYMENT_JSON="$WORK_DIR/deployment.json"
RMPC_CONFIG="$WORK_DIR/rmpc.toml"
KEYSTORE_PATH="$WORK_DIR/keystore.json"
RMPC_PASSPHRASE="${ROUNDTRIP_RMPC_PASSPHRASE:-rmpc-fork-roundtrip-test}"
ANVIL_LOG="$WORK_DIR/anvil.log"
ANVIL_PID=""

cleanup() {
    if [[ -n "$ANVIL_PID" ]] && kill -0 "$ANVIL_PID" 2>/dev/null; then
        kill "$ANVIL_PID" || true
    fi
    # Keep WORK_DIR around if KEEP_WORK=1 or if an explicit dir was provided — useful for post-mortem.
    if [[ "${ROUNDTRIP_KEEP_WORK:-0}" != "1" && -z "${ROUNDTRIP_WORK_DIR:-}" ]]; then
        rm -rf "$WORK_DIR"
    else
        echo "fork-roundtrip: WORK_DIR retained at $WORK_DIR"
    fi
}
trap cleanup EXIT

require_bin() {
    local b="$1"
    command -v "$b" >/dev/null 2>&1 || {
        echo "fork-roundtrip: required binary '$b' not on PATH" >&2
        exit 12
    }
}

require_bin anvil
require_bin forge
require_bin cargo
require_bin pnpm

# ---- 1. Boot anvil --------------------------------------------------
echo "fork-roundtrip: booting anvil on $RPC_URL"
anvil --silent --port "$ANVIL_PORT" >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 30); do
    if curl -sf -X POST -H 'content-type: application/json' \
        --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' \
        "$RPC_URL" >/dev/null; then
        break
    fi
    sleep 1
done

# ---- 2. Deploy gateway ----------------------------------------------
echo "fork-roundtrip: deploying gateway via forge script"
pushd "$REPO_ROOT" >/dev/null
DEPLOYMENT_OUT="$DEPLOYMENT_JSON" \
ADMIN_ADDRESS="$ADMIN_ADDRESS" \
PAUSER_ADDRESS="$PAUSER_ADDRESS" \
AGENT_ADDRESS="$AGENT_ADDRESS" \
SHARE_RECEIVER_ADDRESS="$SHARE_RECEIVER" \
    forge script contracts/script/Deploy.s.sol:Deploy \
    --rpc-url "$RPC_URL" \
    --private-key "$ADMIN_PRIVKEY" \
    --broadcast \
    --skip-simulation \
    >"$WORK_DIR/forge.log" 2>&1 || {
        echo "fork-roundtrip: forge deploy failed; log:" >&2
        cat "$WORK_DIR/forge.log" >&2
        exit 13
    }
popd >/dev/null

GATEWAY_ADDRESS="$(jq -r '.gateway' "$DEPLOYMENT_JSON")"
USDC_ADDRESS="$(jq -r '.usdc' "$DEPLOYMENT_JSON")"
VAULT_ADDRESS="$(jq -r '.vault' "$DEPLOYMENT_JSON")"
GATEWAY_RUNTIME_HASH="$(jq -r '.gateway_runtime_hash' "$DEPLOYMENT_JSON")"
CHAIN_ID="$(jq -r '.chain_id' "$DEPLOYMENT_JSON")"

echo "fork-roundtrip: gateway=$GATEWAY_ADDRESS hash=$GATEWAY_RUNTIME_HASH"

# Deploy.s.sol calls authorizeAgent in its broadcast block, leaving the
# agent ALREADY authorized. The Playwright spec begins by re-asserting
# authorize via the dapp UI, so we revoke here first to put the agent
# in a known-not-authorized state before the test starts.
cast send "$GATEWAY_ADDRESS" "revokeAgent(address)" "$AGENT_ADDRESS" \
    --rpc-url "$RPC_URL" \
    --private-key "$ADMIN_PRIVKEY" \
    >"$WORK_DIR/cast-revoke.log" 2>&1 || {
        echo "fork-roundtrip: pre-test revoke failed; log:" >&2
        cat "$WORK_DIR/cast-revoke.log" >&2
        exit 14
    }

# ---- 3. Build rmpc + import keystore --------------------------------
echo "fork-roundtrip: building rmpc + rmpc-keystore-import"
# rust-payment-client is a workspace member; cargo puts artifacts in the
# workspace-root target/, not the per-crate target/.
cargo build --quiet --manifest-path "$REPO_ROOT/Cargo.toml" \
    --bin rmpc --bin rmpc-keystore-import

RMPC_BIN="$REPO_ROOT/target/debug/rmpc"
KEYSTORE_BIN="$REPO_ROOT/target/debug/rmpc-keystore-import"

echo "fork-roundtrip: minting keystore at $KEYSTORE_PATH"
RMPC_IMPORT_PRIVKEY_HEX="$AGENT_PRIVKEY" \
RMPC_KEYSTORE_PASSPHRASE="$RMPC_PASSPHRASE" \
    "$KEYSTORE_BIN" "$KEYSTORE_PATH" >/dev/null

cat >"$RMPC_CONFIG" <<EOF
chain_id              = $CHAIN_ID
rpc_url               = "$RPC_URL"
gateway_address       = "$GATEWAY_ADDRESS"
usdc_address          = "$USDC_ADDRESS"
vault_address         = "$VAULT_ADDRESS"
gateway_runtime_hash  = "$GATEWAY_RUNTIME_HASH"
max_fee_per_gas_cap   = 100000000000

[signer]
allow_software_fallback = true
keystore_path           = "$KEYSTORE_PATH"

[log]
level = "warn"
dir   = "$WORK_DIR/logs"
EOF

# ---- 4. Run Playwright with all the wiring --------------------------
echo "fork-roundtrip: running Playwright spec"
pushd "$DAPP_DIR" >/dev/null
# Force CI=1 so Playwright uses the build+preview server: it boots
# faster and more deterministically than `vite dev` (which spends
# tens of seconds on first-request compilation against the wagmi/viem
# tree and reliably blows past the 180s webServer timeout on
# contributor laptops).
CI=1 \
ROUNDTRIP_ENABLED=1 \
ROUNDTRIP_RPC_URL="$RPC_URL" \
ROUNDTRIP_GATEWAY_ADDRESS="$GATEWAY_ADDRESS" \
ROUNDTRIP_RMPC_BIN="$RMPC_BIN" \
ROUNDTRIP_RMPC_CONFIG="$RMPC_CONFIG" \
ROUNDTRIP_RMPC_PASSPHRASE="$RMPC_PASSPHRASE" \
VITE_USE_MOCK_WALLET=true \
VITE_FORK_RPC_URL="$RPC_URL" \
VITE_GATEWAY_ADDRESS="$GATEWAY_ADDRESS" \
VITE_VAULT_ADDRESS="$VAULT_ADDRESS" \
VITE_ENV_CLASS=fork \
VITE_GATEWAY_EXPECTED_CODE_HASH="$GATEWAY_RUNTIME_HASH" \
    pnpm exec playwright test tests/e2e/fork-roundtrip.spec.ts "$@"
popd >/dev/null
