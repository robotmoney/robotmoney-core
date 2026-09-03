#!/usr/bin/env bash
# Canonical: docs/operations/base-sepolia-deployment.md — Base Sepolia ceremony
# Implements: issue #1303 — the rehearsal executes the runbook's steps and
#             asserts each step's postcondition; never merely describes them.
#
# This is the single ceremony driver shared by the dry-run (offline golden-fork
# anvil) and the live (real Base Sepolia) rehearsal. It runs the exact
# `forge script` invocations the runbook names, in the runbook's order, and
# checks each step's postcondition with `cast`. Any postcondition failure
# prints the offending `cast` output and exits non-zero — a half-deployed
# stack never reports green.
#
# Ceremony order (dependency-ordered; see the runbook):
#   0. preflight guards (EIP-170/EIP-3860 size + env-default, no tx sent)
#   1. DeployRehearsalSafe          (rehearsal stand-in only — live passes --safe)
#   2. Deploy.s.sol                 core stack: vault + adapters + gateway
#   3. DeployVaultRegistry.s.sol
#   4. DeployPortfolioRouter.s.sol
#   5. DeployRouterGovernance.s.sol         (pinned cadence env)
#   6. DeployInvestmentCommitteePolicy.s.sol  IC + receipt, ONE ceremony,
#                                             BEFORE the timelock handover
#   7. DeployTimelock.s.sol          five-core ADMIN_ROLE handover (INV-3)
#   8. write + validate deployments record
#
# Usage:
#   rehearsal.sh \
#     --rpc-url <url> --chain-id 84532 --deployer-key <hex> \
#     --admin <addr> --pauser <addr> --agent <addr> --share-receiver <addr> \
#     --emergency <addr> [--safe <addr>] --usdc <addr> --receipt-admin <addr> \
#     --out-dir <dir> [--record deployments/base-sepolia.json] [--live]
#
# In --live mode every role address and the Safe must be explicitly provided;
# missing input fails loudly. In dry-run mode (no --live) a rehearsal Safe
# stand-in is deployed and missing role addresses fall back to the well-known
# Anvil dev accounts, because the dry-run operates on a throwaway fork.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

SCRIPT_DIR="$REPO_ROOT/scripts/base-sepolia-rehearsal"
FORGE="forge"
CAST="cast"

RPC_URL=""
CHAIN_ID=""
DEPLOYER_KEY=""
ADMIN_ADDRESS=""
PAUSER_ADDRESS=""
AGENT_ADDRESS=""
SHARE_RECEIVER_ADDRESS=""
EMERGENCY_ADDRESS=""
SAFE_ADDRESS=""
USDC_ADDRESS=""
RECEIPT_ADMIN_ADDRESS=""
OUT_DIR=""
RECORD_PATH=""
LIVE_MODE="false"

# Well-known Anvil dev accounts (dry-run fallbacks; thrown away after the run).
ANVIL_DEFAULT_DEPLOYER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
ANVIL_DEFAULT_PAUSER="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
ANVIL_DEFAULT_AGENT="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
ANVIL_DEFAULT_SHARE_RECEIVER="0x90F79bf6EB2c4f870365E785982E1f101E93b906"
ANVIL_DEFAULT_EMERGENCY="0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"

fail() {
  echo "FAIL: [rehearsal] $*" >&2
  exit 1
}

warn() {
  echo "WARN: [rehearsal] $*" >&2
}

info() {
  echo "==> [rehearsal] $*"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rpc-url) RPC_URL="$2"; shift 2 ;;
    --chain-id) CHAIN_ID="$2"; shift 2 ;;
    --deployer-key) DEPLOYER_KEY="$2"; shift 2 ;;
    --admin) ADMIN_ADDRESS="$2"; shift 2 ;;
    --pauser) PAUSER_ADDRESS="$2"; shift 2 ;;
    --agent) AGENT_ADDRESS="$2"; shift 2 ;;
    --share-receiver) SHARE_RECEIVER_ADDRESS="$2"; shift 2 ;;
    --emergency) EMERGENCY_ADDRESS="$2"; shift 2 ;;
    --safe) SAFE_ADDRESS="$2"; shift 2 ;;
    --usdc) USDC_ADDRESS="$2"; shift 2 ;;
    --receipt-admin) RECEIPT_ADMIN_ADDRESS="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --record) RECORD_PATH="$2"; shift 2 ;;
    --live) LIVE_MODE="true"; shift ;;
    *) fail "unknown argument: $1" ;;
  esac
done

for tool in "$FORGE" "$CAST" jq python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "required tool '$tool' not on PATH"
done

DEPLOYER_ADDRESS="$("$CAST" wallet address "$DEPLOYER_KEY")" || fail "cannot derive deployer address from key"

[[ -n "$RPC_URL" && -n "$CHAIN_ID" && -n "$DEPLOYER_KEY" && -n "$OUT_DIR" ]] \
  || fail "missing required args (--rpc-url/--chain-id/--deployer-key/--out-dir)"

# The broadcaster IS the admin across this ceremony (every deploy script's
# grant→verify postconditions assume msg.sender == admin). Enforce it.
[[ -z "$ADMIN_ADDRESS" ]] && ADMIN_ADDRESS="$DEPLOYER_ADDRESS"
if [[ "$ADMIN_ADDRESS" != "$DEPLOYER_ADDRESS" ]]; then
  if [[ "$LIVE_MODE" == "true" ]]; then
    fail "--admin $ADMIN_ADDRESS != deployer $DEPLOYER_ADDRESS: the ceremony's scripts broadcast as the deployer, which must also be the admin"
  else
    warn "--admin differs from deployer; dry-run proceeds; live mode refuses"
  fi
fi

if [[ "$LIVE_MODE" == "true" ]]; then
  for v in PAUSER_ADDRESS AGENT_ADDRESS SHARE_RECEIVER_ADDRESS EMERGENCY_ADDRESS SAFE_ADDRESS USDC_ADDRESS RECEIPT_ADMIN_ADDRESS; do
    if [[ -z "${!v}" ]]; then
      fail "live mode requires explicit --${v,,} (got empty); refusing to run a live ceremony on defaults"
    fi
  done
  [[ -n "$RECORD_PATH" ]] || fail "live mode requires --record <path>"
else
  [[ -z "$PAUSER_ADDRESS" ]] && PAUSER_ADDRESS="$ANVIL_DEFAULT_PAUSER"
  [[ -z "$AGENT_ADDRESS" ]] && AGENT_ADDRESS="$ANVIL_DEFAULT_AGENT"
  [[ -z "$SHARE_RECEIVER_ADDRESS" ]] && SHARE_RECEIVER_ADDRESS="$ANVIL_DEFAULT_SHARE_RECEIVER"
  [[ -z "$EMERGENCY_ADDRESS" ]] && EMERGENCY_ADDRESS="$ANVIL_DEFAULT_EMERGENCY"
  [[ -z "$USDC_ADDRESS" ]] && USDC_ADDRESS="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  [[ -z "$RECEIPT_ADMIN_ADDRESS" ]] && RECEIPT_ADMIN_ADDRESS="$ADMIN_ADDRESS"
  [[ -z "$RECORD_PATH" ]] && RECORD_PATH=""
fi

# Simple helper: run a forge script step with env, fail with output on error.
run_step() {
  local step_name="$1"; shift
  info "step: $step_name"
  local out
  out="$("$@" 2>&1)" || {
    echo "$out" >&2
    fail "$step_name failed (see output above)"
  }
  echo "$out" | tail -n 20
}

resolve_json() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || fail "expected JSON at $file (missing)"
  jq -r "$key" "$file" || fail "key $key missing from $file"
}

info "chain id: $CHAIN_ID | deployer: $DEPLOYER_ADDRESS | rpc: $RPC_URL"
info "admin=$ADMIN_ADDRESS pauser=$PAUSER_ADDRESS agent=$AGENT_ADDRESS emergency=$EMERGENCY_ADDRESS usdc=$USDC_ADDRESS"
mkdir -p "$OUT_DIR"
CUR="$OUT_DIR/ceremony"
mkdir -p "$CUR"

# ─── 0. Preflight guards: no transaction is sent until these pass ───────────
export EXECUTION_DELAY="${EXECUTION_DELAY:-3600}"
export QUORUM_THRESHOLD="${QUORUM_THRESHOLD:-2}"
export TIMELOCK_MIN_DELAY="${TIMELOCK_MIN_DELAY:-60}"
bash "$SCRIPT_DIR/preflight-guards.sh" || fail "preflight guards did not pass; ceremony aborted before any broadcast"

# ─── 1. Safe (rehearsal stand-in when no --safe was provided) ────────────────
if [[ -z "$SAFE_ADDRESS" ]]; then
  run_step "DeployRehearsalSafe" env \
    "$FORGE" script contracts/script/DeployRehearsalSafe.s.sol:DeployRehearsalSafe \
    --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast --slow -vvv \
    --chain-id "$CHAIN_ID"
  SAFE_ADDRESS="$(jq -r '.transactions[0].contractAddress // empty' \
    "$REPO_ROOT/broadcast/DeployRehearsalSafe.s.sol/$CHAIN_ID/run-latest.json" 2>/dev/null || true)"
fi
[[ -n "$SAFE_ADDRESS" ]] || fail "could not determine the rehearsal Safe address"
info "safe: $SAFE_ADDRESS"

# ─── 2. Core stack ───────────────────────────────────────────────────────────
DEP_OUT="$CUR/deployment.json"
run_step "Deploy (core stack: vault + adapters + gateway, 1,000 USDC seed)" env \
  ADMIN_ADDRESS="$ADMIN_ADDRESS" \
  PAUSER_ADDRESS="$PAUSER_ADDRESS" \
  AGENT_ADDRESS="$AGENT_ADDRESS" \
  SHARE_RECEIVER_ADDRESS="$SHARE_RECEIVER_ADDRESS" \
  USDC_ADDRESS="$USDC_ADDRESS" \
  DEPLOYMENT_OUT="$DEP_OUT" \
  "$FORGE" script contracts/script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast --slow -vvv \
  --chain-id "$CHAIN_ID"

VAULT="$(resolve_json "$DEP_OUT" '.vault')"
GATEWAY="$(resolve_json "$DEP_OUT" '.gateway')"
AAVE="$(resolve_json "$DEP_OUT" '.aave_adapter')"
COMPOUND="$(resolve_json "$DEP_OUT" '.compound_adapter')"
MORPHO="$(resolve_json "$DEP_OUT" '.morpho_adapter')"
info "vault=$VAULT gateway=$GATEWAY"

ADMIN_ROLE="$(cast keccak 'ADMIN_ROLE')"
AGENT_ROLE="$(cast keccak 'AGENT_ROLE')"
EMERGENCY_ROLE="$(cast keccak 'EMERGENCY_ROLE')"
DEFAULT_ADMIN_ROLE="0x0000000000000000000000000000000000000000000000000000000000000000"

# Normalise an address token for comparison (cast JSON may checksum-case it).
lower_addr() { tr 'A-Z' 'a-z' <<<"$1"; }

# Read a single uint256 return as a decimal integer, robust to cast printing
# either a bare decimal or a "0x…" string for large values.
rcall_int() {
  local function_sig="$1" contract="$2"; shift 2
  "$CAST" call --json "$contract" "$function_sig" "$@" --rpc-url "$RPC_URL" | python3 -c '
import json, sys
v = json.load(sys.stdin)[0]
print(int(v, 0) if isinstance(v, str) and v.startswith("0x") else int(v))
'
}

assert_role() {
  local contract="$1" role="$2" holder="$3" expect="$4" label="$5"
  local got
  # NOTE: '.[0] // fallback' would treat a legitimate `false` as missing
  # (false is falsy in jq) — use an explicit null test instead.
  got="$("$CAST" call --json "$contract" "hasRole(bytes32,address)(bool)" "$role" "$holder" \
    --rpc-url "$RPC_URL" | jq -r 'if .[0] == null then "call-failed" else .[0] end')" \
    || fail "hasRole call failed for $label"
  if [[ "$expect" == "true" ]] && [[ "$got" != "true" ]]; then
    fail "$label: expected $holder to hold role $role on $contract, got $got"
  fi
  if [[ "$expect" == "false" ]] && [[ "$got" != "false" ]]; then
    fail "$label: expected $holder NOT to hold role $role on $contract, got $got"
  fi
}

# 99.9% of SEED_DEPOSIT_AMOUNT (contracts/script/Deploy.s.sol), matching the
# tolerance Deploy.s.sol itself asserts post-seed-deposit. SEED_DEPOSIT_AMOUNT
# is temporarily 1 USDC (docs/future/review-usdc-seed.md) — this threshold
# must move with it, including on the eventual revert to 1,000 USDC.
seed_deposit_min=999000
total_assets="$(rcall_int "totalAssets()(uint256)" "$VAULT")"
if (( total_assets < seed_deposit_min )); then
  fail "seed deposit postcondition: vault totalAssets $total_assets < $seed_deposit_min"
fi
info "postcondition OK: vault totalAssets=$total_assets"
assert_role "$GATEWAY" "$ADMIN_ROLE" "$ADMIN_ADDRESS" true "gateway ADMIN_ROLE admin"
assert_role "$GATEWAY" "$AGENT_ROLE" "$AGENT_ADDRESS" true "gateway AGENT_ROLE agent"

# ─── 3. Vault registry ───────────────────────────────────────────────────────
REG_OUT="$CUR/registry.json"
run_step "DeployVaultRegistry" env \
  ADMIN_ADDRESS="$ADMIN_ADDRESS" \
  VAULT_ADDRESS="$VAULT" \
  USDC_ADDRESS="$USDC_ADDRESS" \
  DEPLOYMENT_OUT="$REG_OUT" \
  "$FORGE" script contracts/script/DeployVaultRegistry.s.sol:DeployVaultRegistry \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast --slow -vvv \
  --chain-id "$CHAIN_ID"
REGISTRY="$(resolve_json "$REG_OUT" '.registry')"

vaults_list="$("$CAST" call --json "$REGISTRY" "listVaults()(address[])" --rpc-url "$RPC_URL" | jq -r '.[0][] // empty')"
echo "$vaults_list" | grep -qi "$(lower_addr "$VAULT")" \
  || fail "registry listVaults does not contain vault $VAULT (got: $vaults_list)"
info "postcondition OK: vault registered in $REGISTRY"

# ─── 4. Portfolio router ─────────────────────────────────────────────────────
ROUTER_OUT="$CUR/router.json"
run_step "DeployPortfolioRouter" env \
  ADMIN_ADDRESS="$ADMIN_ADDRESS" \
  REGISTRY_ADDRESS="$REGISTRY" \
  VAULT_ADDRESS="$VAULT" \
  USDC_ADDRESS="$USDC_ADDRESS" \
  DEPLOYMENT_OUT="$ROUTER_OUT" \
  "$FORGE" script contracts/script/DeployPortfolioRouter.s.sol:DeployPortfolioRouter \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast --slow -vvv \
  --chain-id "$CHAIN_ID"
ROUTER="$(resolve_json "$ROUTER_OUT" '.router')"

eligible="$("$CAST" call --json "$REGISTRY" "isRouterEligible(address)(bool)" "$VAULT" \
  --rpc-url "$RPC_URL" | jq -r 'if .[0] == null then "call-failed" else .[0] end')"
[[ "$eligible" == "true" ]] || fail "registry isRouterEligible($VAULT) = $eligible (expected true)"
weights_json="$("$CAST" call --json "$ROUTER" "getWeights()(address[],uint256[])" --rpc-url "$RPC_URL")"
weights_sum="$(echo "$weights_json" | jq '.[1] | add // 0')"
weights_vaults="$(echo "$weights_json" | jq -r '.[0][] // empty')"
(( weights_sum == 10000 )) || fail "router getWeights bps sum $weights_sum != 10000 (got: $weights_json)"
echo "$weights_vaults" | grep -qi "$(lower_addr "$VAULT")" \
  || fail "router getWeights does not weight vault $VAULT (got: $weights_json)"
info "postcondition OK: vault router-eligible; weights sum 10000 bps"

# ─── 5. Router governance (pinned cadence — never the 0-delay default) ───────
GOV_OUT="$CUR/governance.json"
run_step "DeployRouterGovernance" env \
  ADMIN_ADDRESS="$ADMIN_ADDRESS" \
  ROUTER_ADDRESS="$ROUTER" \
  VOTING_PERIOD="${VOTING_PERIOD:-3600}" \
  EXECUTION_DELAY="$EXECUTION_DELAY" \
  QUORUM_THRESHOLD="$QUORUM_THRESHOLD" \
  DEPLOYMENT_OUT="$GOV_OUT" \
  "$FORGE" script contracts/script/DeployRouterGovernance.s.sol:DeployRouterGovernance \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast --slow -vvv \
  --chain-id "$CHAIN_ID"
GOVERNANCE="$(resolve_json "$GOV_OUT" '.governance')"

cadence_json="$("$CAST" call --json "$GOVERNANCE" "cadenceParams()(uint64,uint64,uint256,uint256)" \
  --rpc-url "$RPC_URL")"
exec_delay="$(echo "$cadence_json" | jq '.[1]')"
quorum_onchain="$(echo "$cadence_json" | jq '.[2]')"
[[ "$exec_delay" -ge 3600 ]] || fail "governance executionDelay $exec_delay < MIN_EXECUTION_DELAY 3600 (got: $cadence_json)"
[[ "$quorum_onchain" -gt 0 ]] || fail "governance quorumThreshold on chain is 0 (got: $cadence_json)"
info "postcondition OK: governance executionDelay=$exec_delay quorum=$quorum_onchain (pinned $QUORUM_THRESHOLD)"

# ─── 6. IC policy + consensus receipt — ONE ceremony, BEFORE timelock ────────
IC_OUT="$CUR/ic-policy.json"
run_step "DeployInvestmentCommitteePolicy (IC + receipt, one ceremony)" env \
  ADMIN_ADDRESS="$ADMIN_ADDRESS" \
  GATEWAY_ADDRESS="$GATEWAY" \
  RECEIPT_ADMIN_ADDRESS="$RECEIPT_ADMIN_ADDRESS" \
  DEPLOYMENT_OUT="$IC_OUT" \
  "$FORGE" script contracts/script/DeployInvestmentCommitteePolicy.s.sol:DeployInvestmentCommitteePolicy \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast --slow -vvv \
  --chain-id "$CHAIN_ID"
IC_POLICY="$(resolve_json "$IC_OUT" '.policy')"
RECEIPTS="$(resolve_json "$IC_OUT" '.consensus_receipt')"

ic_wired="$("$CAST" call --json "$GATEWAY" "icPolicy()(address)" --rpc-url "$RPC_URL" | jq -r '.[0] // empty')"
receipt_wired="$("$CAST" call --json "$GATEWAY" "consensusReceipt()(address)" --rpc-url "$RPC_URL" | jq -r '.[0] // empty')"
[[ "$(lower_addr "$ic_wired")" == "$(lower_addr "$IC_POLICY")" ]] \
  || fail "gateway icPolicy()=$ic_wired != $IC_POLICY"
[[ "$(lower_addr "$receipt_wired")" == "$(lower_addr "$RECEIPTS")" ]] \
  || fail "gateway consensusReceipt()=$receipt_wired != $RECEIPTS"
assert_role "$RECEIPTS" "$ADMIN_ROLE" "$RECEIPT_ADMIN_ADDRESS" true "receipt ADMIN_ROLE == configured RECEIPT_ADMIN_ADDRESS"
info "postcondition OK: IC policy + receipt wired into gateway (one ceremony)"

# ─── 7. Timelock handover: five-core INV-3 ───────────────────────────────────
TL_OUT="$CUR/timelock.json"
run_step "DeployTimelock (five-core ADMIN_ROLE handover)" env \
  VAULT_ADDRESS="$VAULT" \
  GATEWAY_ADDRESS="$GATEWAY" \
  REGISTRY_ADDRESS="$REGISTRY" \
  ROUTER_ADDRESS="$ROUTER" \
  GOVERNANCE_ADDRESS="$GOVERNANCE" \
  SAFE_ADDRESS="$SAFE_ADDRESS" \
  EMERGENCY_ADDRESS="$EMERGENCY_ADDRESS" \
  TIMELOCK_MIN_DELAY="$TIMELOCK_MIN_DELAY" \
  DEPLOYMENT_OUT="$TL_OUT" \
  "$FORGE" script contracts/script/DeployTimelock.s.sol:DeployTimelock \
  --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" --broadcast --slow -vvv \
  --chain-id "$CHAIN_ID"
TIMELOCK="$(resolve_json "$TL_OUT" '.timelock')"

for c in "$VAULT" "$GATEWAY" "$REGISTRY" "$ROUTER" "$GOVERNANCE"; do
  assert_role "$c" "$ADMIN_ROLE" "$TIMELOCK" true "INV-3: timelock holds ADMIN_ROLE on $c"
  assert_role "$c" "$ADMIN_ROLE" "$DEPLOYER_ADDRESS" false "INV-3: deployer stripped of ADMIN_ROLE on $c"
done
assert_role "$GATEWAY" "$DEFAULT_ADMIN_ROLE" "$TIMELOCK" true "INV-3: timelock holds gateway DEFAULT_ADMIN_ROLE"
assert_role "$GATEWAY" "$DEFAULT_ADMIN_ROLE" "$DEPLOYER_ADDRESS" false "INV-3: deployer stripped of gateway DEFAULT_ADMIN_ROLE"
assert_role "$VAULT" "$EMERGENCY_ROLE" "$EMERGENCY_ADDRESS" true "vault EMERGENCY_ROLE on emergency key"
assert_role "$VAULT" "$EMERGENCY_ROLE" "$DEPLOYER_ADDRESS" false "deployer stripped of vault EMERGENCY_ROLE"
info "postcondition OK: five-core INV-3 timelock handover verified"

# ─── 8. Record ───────────────────────────────────────────────────────────────
if [[ -n "$RECORD_PATH" ]]; then
  mkdir -p "$(dirname "$RECORD_PATH")"
  python3 - "$RECORD_PATH" "$RPC_URL" "$DEPLOYER_ADDRESS" "$ADMIN_ADDRESS" \
    "$PAUSER_ADDRESS" "$AGENT_ADDRESS" "$SHARE_RECEIVER_ADDRESS" "$USDC_ADDRESS" \
    "$VAULT" "$GATEWAY" "$REGISTRY" "$ROUTER" "$GOVERNANCE" \
    "$AAVE" "$COMPOUND" "$MORPHO" "$TIMELOCK" "$IC_POLICY" "$RECEIPTS" \
    "$SAFE_ADDRESS" "$EMERGENCY_ADDRESS" <<'PYEOF'
import json, sys, datetime
(path, rpc, deployer, admin, pauser, agent, share_receiver, usdc,
 vault, gateway, registry, router, governance,
 aave, compound, morpho, timelock, ic_policy, receipts,
 safe, emergency) = sys.argv[1:]

def address(value):
    return value.lower()

record = {
    "chain_id": 84532,
    "network": "base-sepolia",
    "rehearsal": True,
    "deployed_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "rpc": rpc,
    "deployer": address(deployer),
    "admin": address(admin),
    "pauser": address(pauser),
    "agent": address(agent),
    "share_receiver": address(share_receiver),
    "emergency": address(emergency),
    "safe": address(safe),
    "usdc": address(usdc),
    "vault": address(vault),
    "gateway": address(gateway),
    "registry": address(registry),
    "portfolio_router": address(router),
    "router_governance": address(governance),
    "aave_adapter": address(aave),
    "compound_adapter": address(compound),
    "morpho_adapter": address(morpho),
    "timelock": address(timelock),
    "ic_policy": address(ic_policy),
    "consensus_receipt": address(receipts),
}
with open(path, "w") as fh:
    json.dump(record, fh, indent=2)
    fh.write("\n")
print(f"record written to {path}")
PYEOF
  python3 "$REPO_ROOT/.github/scripts/check_base_sepolia_record.py" "$RECORD_PATH" \
    || fail "record validator rejected $RECORD_PATH"
  info "record validated: $RECORD_PATH"
fi

info "CEREMONY COMPLETE"
info "  vault=$VAULT gateway=$GATEWAY registry=$REGISTRY router=$ROUTER"
info "  governance=$GOVERNANCE timelock=$TIMELOCK ic_policy=$IC_POLICY receipts=$RECEIPTS"
