#!/usr/bin/env bash
# Canonical: docs/operations/contract-release-runbooks.md (Recorder keeper).
# Mandatory real Base state test. All sends target a private local anvil fork.
# Clean room (core 1490, QA plan v1 E10): the rmAGENT vault and its recorder come from the
# Deploy 2 manifests (deployments/8453/deploy-2/agent-token-vault.json), never from a literal.
# DEPLOY_MANIFESTS names another manifest folder; it must sit under deployments/, the only
# folder forge may read (foundry.toml fs_permissions). CI runs this nightly only
# (suite-18-live-monitoring.yml, job recorder-keeper-fork).
set -euo pipefail
: "${BASE_FORK_RPC_URL:?FAIL: BASE_FORK_RPC_URL is required}"
for bin in anvil cast forge python3; do command -v "$bin" >/dev/null || { echo "FAIL: missing $bin"; exit 1; }; done
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'kill "${PID:-}" 2>/dev/null || true; rm -rf "$WORK"' EXIT
MANIFESTS="$(cd "${DEPLOY_MANIFESTS:-$ROOT/deployments/8453/deploy-2}" 2>/dev/null && pwd)" \
    || { echo "FAIL: manifest folder ${DEPLOY_MANIFESTS:-$ROOT/deployments/8453/deploy-2} missing"; exit 1; }
[[ "$MANIFESTS/" == "$ROOT/deployments/"* ]] || { echo "FAIL: $MANIFESTS is not under $ROOT/deployments, which forge cannot read"; exit 1; }
ADDRS="$(python3 - "$MANIFESTS" <<'PYMANIFEST'
import json, os, re, sys
d = sys.argv[1]
def load(name):
    with open(os.path.join(d, name)) as f:
        return json.load(f)
def addr(m, key, name):
    v = m.get(key)
    if not isinstance(v, str) or not re.fullmatch(r"0x[0-9a-fA-F]{40}", v) or int(v, 16) == 0:
        sys.exit(f"FAIL: {name} {key} is not a deployed address: {v!r}")
    return v
agent = load("agent-token-vault.json")
if agent.get("chain_id") != 8453:
    sys.exit(f"FAIL: agent-token-vault.json chain_id is {agent.get('chain_id')!r}, expected 8453")
vault = addr(agent, "vault", "agent-token-vault.json")
recorder = addr(agent, "recorder", "agent-token-vault.json")
if os.path.exists(os.path.join(d, "recorder.json")):
    other = addr(load("recorder.json"), "recorder", "recorder.json")
    if other.lower() != recorder.lower():
        sys.exit(f"FAIL: recorder.json names {other}, agent-token-vault.json names {recorder}")
print(vault, recorder)
PYMANIFEST
)" || { echo "FAIL: cannot read the rmAGENT vault and recorder from $MANIFESTS"; exit 1; }
read -r AGENT_VAULT RECORDER_ADDRESS <<<"$ADDRS"
export RECORDER_ADDRESS
echo "manifests=$MANIFESTS rmAGENT=$AGENT_VAULT recorder=$RECORDER_ADDRESS"
export RPC_URL="http://127.0.0.1:${ANVIL_PORT:-18699}"
PIN="${BASE_FORK_BLOCK:-$(cast block-number --rpc-url "$BASE_FORK_RPC_URL") }"
PIN="${PIN// /}"
echo "Base fork pin=$PIN; upstream reads only, local transactions only"
anvil --fork-url "$BASE_FORK_RPC_URL" --fork-block-number "$PIN" --chain-id 918453 --port "${ANVIL_PORT:-18699}" --silent >"$WORK/anvil.log" 2>&1 &
PID=$!
for _ in $(seq 1 100); do cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 && break; sleep .2; done
[[ "$(cast chain-id --rpc-url "$RPC_URL")" == 918453 ]] || { echo 'FAIL: local fork unavailable'; exit 1; }
[[ "$(cast code "$AGENT_VAULT" --rpc-url "$RPC_URL")" != 0x ]] || { echo 'FAIL: deployed rmAGENT missing'; exit 1; }
[[ "$(cast code "$RECORDER_ADDRESS" --rpc-url "$RPC_URL")" != 0x ]] || { echo 'FAIL: deployed recorder missing'; exit 1; }
printf '%s\n' keeper-fork-test >"$WORK/pw"
chmod 600 "$WORK/pw"
mkdir "$WORK/ks"
cast wallet new "$WORK/ks" keeper --unsafe-password keeper-fork-test >/dev/null 2>&1
export KEEPER_KEYSTORE="$WORK/ks/keeper" KEEPER_PASSWORD_FILE="$WORK/pw"
ADDR="$(cast wallet address --keystore "$KEEPER_KEYSTORE" --password-file "$KEEPER_PASSWORD_FILE")"
cast rpc anvil_setBalance "$ADDR" 0x56BC75E2D63100000 --rpc-url "$RPC_URL" >/dev/null
cat >"$WORK/sleep" <<'SLEEP'
#!/usr/bin/env bash
cast rpc evm_increaseTime "$1" --rpc-url "$RPC_URL" >/dev/null
cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null
SLEEP
chmod +x "$WORK/sleep"
export SLEEP_CMD="$WORK/sleep" CATCHUP_INTERVAL_SECS=120
# Seed a historical recorder tick 1500 ticks behind the real live pool, preserving
# the deployed ring and all pool/vault state. This models an unobserved price move.
# Observation[65535] occupies slots 0..65534; State.lastTick is low int24 at 65535.
STATE="$(cast storage "$RECORDER_ADDRESS" 65535 --rpc-url "$RPC_URL")"
LIVE="$(cast call "$RECORDER_ADDRESS" 'slot0()(uint160,int24,uint16,uint16)' --rpc-url "$RPC_URL" | sed -n 2p | awk '{print $1}')"
SEEDED="$(python3 - "$STATE" "$LIVE" <<'PYSEED'
import sys
word=int(sys.argv[1],16)
tick=int(sys.argv[2])-1500
print('0x'+format((word & ~((1<<24)-1)) | (tick & ((1<<24)-1)), '064x'))
PYSEED
)"
cast rpc anvil_setStorageAt "$RECORDER_ADDRESS" "$(cast to-uint256 65535)" "$SEEDED" --rpc-url "$RPC_URL" >/dev/null
cast rpc evm_increaseTime 172800 --rpc-url "$RPC_URL" >/dev/null
cast rpc evm_mine --rpc-url "$RPC_URL" >/dev/null
[[ "$(cast call "$RECORDER_ADDRESS" 'isFresh()(bool)' --rpc-url "$RPC_URL")" == false ]]
set +e
bash "$ROOT/scripts/ops/recorder-keeper.sh" --once 2>"$WORK/keeper.log"
RC=$?
set -e
cat "$WORK/keeper.log"
[[ "$(grep -c 'deviation .* ticks after' "$WORK/keeper.log")" -ge 3 ]]
[[ $RC == 1 ]]
grep '"alert":"recorder_stale"' "$WORK/keeper.log"
if grep -E 'record_failed|recorder_unreadable|deviation_not_converged' "$WORK/keeper.log"; then exit 1; fi
[[ "$(cast call "$RECORDER_ADDRESS" 'isFresh()(bool)' --rpc-url "$RPC_URL")" == true ]]
cd "$ROOT"
KEEPER_FORK_RPC_URL="$RPC_URL" KEEPER_FORK_MANIFEST="$MANIFESTS/agent-token-vault.json" \
    FOUNDRY_TEST=scripts/ops/integration forge test --match-contract RecorderKeeperDepositTest -vv | tee "$WORK/assertions.log"
grep -q '1 tests passed, 0 failed, 0 skipped (1 total tests)' "$WORK/assertions.log" || { echo 'FAIL: real guard/deposit assertion did not execute'; exit 1; }
