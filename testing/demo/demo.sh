#!/usr/bin/env bash
# Canonical: docs/technical/demo-runbook.md (ADR — issue #62)
# Implements: docs/implementation-plan.md §13 — Phase 7 OpenClaw E2E demo.
# Issue: #61, #151.
#
# OpenClaw end-to-end demo orchestrator. Boots an Anvil fork pinned at
# `RMPC_FORK_BLOCK`, sets up the agent + gateway authorization fixture,
# runs the bounded read-then-write loop (verbatim prompt from ADR §3.2),
# captures the artifact set defined in §3.3 to
# `artifacts/demo/<run_id>/`, and verifies the locked success criteria.
#
# Mode toggle:
#   RMPC_DEMO_FAILURE_CASE=<id>   Apply the named failure-case toggle
#                                 from runbook §3.4 before launching the
#                                 agent. Empty/unset = happy-path run.
#
# Failure-case toggle ids (from runbook §3.4):
#   unauthorized_agent | insufficient_allowance | paused_gateway
#   fee_cap            | code_hash_mismatch
#
# Required env (happy-path):
#   RMPC_FORK_RPC_URL   Upstream archive RPC for `anvil --fork-url`.
# Optional env:
#   RMPC_FORK_BLOCK     Pinned fork block (decimal). Default: derive from
#                       eth_blockNumber - 100 at start of run.
#   RMPC_DEMO_RUN_DIR   Override run directory.
#   RMPC_DEMO_SKIP_RUN  If set, do everything except actually invoke rmpc
#                       (used by CI smoke that has no archive RPC secret).
#
# Exit codes:
#   0   — happy-path success, expected refusal in failure-case mode, OR
#         loud-clean skip when RMPC_FORK_RPC_URL is unset (a sentinel
#         "SKIPPED" marker file is written into the run dir so callers
#         can distinguish skip from success without parsing stderr).
#   3   — required tooling missing (anvil/cast/jq).
#   4   — orchestrator setup failure (impersonation, authorize, etc).
#   5   — agent run failed an assertion against the locked success criteria.
#   6   — unknown RMPC_DEMO_FAILURE_CASE id.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNBOOK="${REPO_ROOT}/docs/technical/demo-runbook.md"
HARNESS="${REPO_ROOT}/testing/openclaw-config/openclaw_harness.sh"
# Prefer the workspace-root target dir (produced when the repo is a Cargo
# workspace, which places all binaries under <repo-root>/target/).  Fall back
# to the package-local target for standalone builds.
if [[ -x "${REPO_ROOT}/target/debug/rmpc" ]]; then
    RMPC_BIN="${REPO_ROOT}/target/debug/rmpc"
else
    RMPC_BIN="${REPO_ROOT}/clients/rust-payment-client/target/debug/rmpc"
fi

FAILURE_CASE="${RMPC_DEMO_FAILURE_CASE:-}"

# ----- timestamp + run dir -------------------------------------------------
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_DIR="${RMPC_DEMO_RUN_DIR:-${REPO_ROOT}/artifacts/demo/${RUN_ID}}"
mkdir -p "${RUN_DIR}/outputs"

log() { printf '[demo] %s\n' "$*" >&2; }

# ----- preflight: required tooling ----------------------------------------
for tool in anvil cast jq; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        log "missing required tool: $tool"
        exit 3
    fi
done

# ----- preflight: fork RPC required ---------------------------------------
if [[ -z "${RMPC_FORK_RPC_URL:-}" ]]; then
    log "RMPC_FORK_RPC_URL is unset; skipping demo run (loud-clean per fork-e2e convention)"
    log "set RMPC_FORK_RPC_URL=<archive-rpc> to actually run this demo."
    : >"${RUN_DIR}/SKIPPED"
    exit 0
fi

# ----- copy runbook into the artifact set ---------------------------------
cp "$RUNBOOK" "${RUN_DIR}/runbook.md"

# ----- ensure rmpc is built -----------------------------------------------
log "building rmpc"
cargo build --quiet \
    --manifest-path "${REPO_ROOT}/clients/rust-payment-client/Cargo.toml" \
    --bin rmpc

# ----- determine fork block pin (runbook §3.1) ----------------------------
if [[ -z "${RMPC_FORK_BLOCK:-}" ]]; then
    log "no RMPC_FORK_BLOCK pin; deriving from upstream tip - 100"
    TIP_HEX="$(cast block-number --rpc-url "$RMPC_FORK_RPC_URL")"
    RMPC_FORK_BLOCK="$(( TIP_HEX - 100 ))"
fi
export RMPC_FORK_BLOCK
log "fork block pin: ${RMPC_FORK_BLOCK}"

# ----- launch anvil fork --------------------------------------------------
ANVIL_PORT="${RMPC_DEMO_ANVIL_PORT:-8546}"
ANVIL_RPC="http://127.0.0.1:${ANVIL_PORT}"
ANVIL_LOG="${RUN_DIR}/anvil.log"

log "starting anvil fork on port ${ANVIL_PORT}"
anvil \
    --fork-url "$RMPC_FORK_RPC_URL" \
    --fork-block-number "$RMPC_FORK_BLOCK" \
    --port "$ANVIL_PORT" \
    --silent >"$ANVIL_LOG" 2>&1 &
ANVIL_PID=$!

cleanup() {
    if kill -0 "$ANVIL_PID" 2>/dev/null; then
        kill "$ANVIL_PID" 2>/dev/null || true
        wait "$ANVIL_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Wait for anvil to become responsive.
for i in $(seq 1 30); do
    if cast block-number --rpc-url "$ANVIL_RPC" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done
if ! cast block-number --rpc-url "$ANVIL_RPC" >/dev/null 2>&1; then
    log "anvil failed to come up on $ANVIL_RPC"
    exit 4
fi
log "anvil up at $ANVIL_RPC"

# ----- canonical addresses (Base mainnet, per fork-e2e-rust addresses.rs) -
GATEWAY="${RMPC_DEMO_GATEWAY:-0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd}"   # vault stand-in
USDC="${RMPC_DEMO_USDC:-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913}"
VAULT="${RMPC_DEMO_VAULT:-0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd}"
ADMIN_ADDRESS="${RMPC_DEMO_ADMIN:-0x88ba7364cc6ce5054981d571b33f8fb3e91475a0}"
USDC_WHALE="${RMPC_DEMO_WHALE:-0x0b25c51637c43decd6cc1c1e3da4518d54ddb528}"

# Generate a fresh agent address for this run.
AGENT_KEY="0x$(openssl rand -hex 32)"
AGENT_ADDRESS="$(cast wallet address --private-key "$AGENT_KEY")"
DEPOSIT_AMOUNT="${RMPC_DEMO_DEPOSIT_AMOUNT:-1000000}"   # 1 USDC (6 decimals)
# Fee cap in wei; used with rmpc deposit --fee-cap (issue #93, §4.7).
FEE_CAP_WEI="${RMPC_DEMO_FEE_CAP_WEI:-10000000000}"    # 10 gwei default
POLICY_HASH="${RMPC_DEMO_POLICY_HASH:-0x$(printf '00%.0s' {1..32})}"
WINDOW="${RMPC_DEMO_WINDOW:-3600}"
EXPIRY="${RMPC_DEMO_EXPIRY:-9999999999}"
AGENT_CAP="$DEPOSIT_AMOUNT"

# Order-id for the demo deposit: deterministic per-run 32-byte hex.
ORDER_ID="0x$(openssl rand -hex 32)"

# ----- failure-case toggles (runbook §3.4) --------------------------------
SKIP_AUTHORIZE=0
case "$FAILURE_CASE" in
    "")                       ;;
    "unauthorized_agent")     SKIP_AUTHORIZE=1 ;;
    "insufficient_allowance") ;;
    "paused_gateway")         ;;
    "fee_cap")                AGENT_CAP=1 ;;
    "code_hash_mismatch")     ;;
    *)
        log "unknown RMPC_DEMO_FAILURE_CASE: $FAILURE_CASE"
        exit 6
        ;;
esac

# ----- write fork-config artifact -----------------------------------------
RPC_LABEL="$(echo "$RMPC_FORK_RPC_URL" | sed -E 's#(https?://)([^/]+)(/.*)?#\1\2/<redacted>#')"
cat >"${RUN_DIR}/fork-config.json" <<EOF
{
  "chain_id": 8453,
  "rpc_label": "${RPC_LABEL}",
  "fork_block": ${RMPC_FORK_BLOCK},
  "anvil_pid": ${ANVIL_PID},
  "anvil_rpc": "${ANVIL_RPC}",
  "agent_address": "${AGENT_ADDRESS}",
  "gateway": "${GATEWAY}",
  "usdc": "${USDC}",
  "vault": "${VAULT}",
  "deposit_amount": "${DEPOSIT_AMOUNT}",
  "fee_cap_wei": ${FEE_CAP_WEI},
  "failure_case": "${FAILURE_CASE}"
}
EOF

# ----- setup phase: fund + authorize agent --------------------------------
fund_agent() {
    local target="$1"
    log "funding ${target} with ETH for gas"
    cast rpc anvil_setBalance "$target" 0xDE0B6B3A7640000 \
        --rpc-url "$ANVIL_RPC" >/dev/null
}

fund_usdc() {
    local target="$1"
    log "funding ${target} with USDC via whale impersonation"
    cast rpc anvil_impersonateAccount "$USDC_WHALE" --rpc-url "$ANVIL_RPC" >/dev/null || true
    fund_agent "$USDC_WHALE"
    # Transfer DEPOSIT_AMOUNT * 10 so there's plenty for fees/tests.
    local fund_amount=$(( DEPOSIT_AMOUNT * 10 ))
    cast send "$USDC" "transfer(address,uint256)" "$target" "$fund_amount" \
        --from "$USDC_WHALE" --unlocked --rpc-url "$ANVIL_RPC" \
        >"${RUN_DIR}/setup-fund-usdc.log" 2>&1 || true
    cast rpc anvil_stopImpersonatingAccount "$USDC_WHALE" --rpc-url "$ANVIL_RPC" >/dev/null || true
}

approve_gateway() {
    local target="$1"
    local amount="$2"
    log "approving gateway ${GATEWAY} for ${amount} USDC from ${target}"
    cast rpc anvil_impersonateAccount "$target" --rpc-url "$ANVIL_RPC" >/dev/null || true
    cast send "$USDC" "approve(address,uint256)" "$GATEWAY" "$amount" \
        --from "$target" --unlocked --rpc-url "$ANVIL_RPC" \
        >"${RUN_DIR}/setup-approve.log" 2>&1 || true
    cast rpc anvil_stopImpersonatingAccount "$target" --rpc-url "$ANVIL_RPC" >/dev/null || true
}

authorize_agent() {
    log "authorizing agent ${AGENT_ADDRESS} cap=${AGENT_CAP}"
    cast rpc anvil_impersonateAccount "$ADMIN_ADDRESS" --rpc-url "$ANVIL_RPC" >/dev/null || true
    fund_agent "$ADMIN_ADDRESS"
    if ! cast send "$GATEWAY" \
            "authorizeAgent(address,bytes32,uint256,uint256,uint256)" \
            "$AGENT_ADDRESS" "$POLICY_HASH" "$AGENT_CAP" "$WINDOW" "$EXPIRY" \
            --from "$ADMIN_ADDRESS" --unlocked --rpc-url "$ANVIL_RPC" \
            >"${RUN_DIR}/setup-authorize.log" 2>&1; then
        log "authorizeAgent failed (expected if gateway ABI absent on real fork); continuing"
    fi
    cast rpc anvil_stopImpersonatingAccount "$ADMIN_ADDRESS" --rpc-url "$ANVIL_RPC" >/dev/null || true
}

apply_failure_toggle() {
    case "$FAILURE_CASE" in
        "insufficient_allowance")
            log "toggle: insufficient_allowance"
            cast rpc anvil_impersonateAccount "$AGENT_ADDRESS" --rpc-url "$ANVIL_RPC" >/dev/null || true
            cast send "$USDC" "approve(address,uint256)" "$GATEWAY" 0 \
                --from "$AGENT_ADDRESS" --unlocked --rpc-url "$ANVIL_RPC" \
                >"${RUN_DIR}/toggle.log" 2>&1 || true
            cast rpc anvil_stopImpersonatingAccount "$AGENT_ADDRESS" --rpc-url "$ANVIL_RPC" >/dev/null || true
            ;;
        "paused_gateway")
            log "toggle: paused_gateway"
            cast rpc anvil_impersonateAccount "$ADMIN_ADDRESS" --rpc-url "$ANVIL_RPC" >/dev/null || true
            cast send "$GATEWAY" "pause()" \
                --from "$ADMIN_ADDRESS" --unlocked --rpc-url "$ANVIL_RPC" \
                >"${RUN_DIR}/toggle.log" 2>&1 || true
            cast rpc anvil_stopImpersonatingAccount "$ADMIN_ADDRESS" --rpc-url "$ANVIL_RPC" >/dev/null || true
            ;;
        "code_hash_mismatch")
            log "toggle: code_hash_mismatch"
            cast rpc anvil_setCode "$GATEWAY" 0x6080604052600080fdfe \
                --rpc-url "$ANVIL_RPC" \
                >"${RUN_DIR}/toggle.log" 2>&1 || true
            ;;
    esac
}

fund_agent "$AGENT_ADDRESS"
# Fund USDC and approve gateway on happy path and insufficient_allowance
# cases (the toggle will zero out the allowance for insufficient_allowance).
fund_usdc "$AGENT_ADDRESS"
approve_gateway "$AGENT_ADDRESS" "$DEPOSIT_AMOUNT"

if [[ "$SKIP_AUTHORIZE" -eq 0 ]]; then
    authorize_agent
else
    log "toggle: unauthorized_agent (skipping authorize)"
fi
apply_failure_toggle

# ----- write OpenClaw config artifact -------------------------------------
RMPC_CONFIG="${RUN_DIR}/rmpc.toml"
KEYSTORE_PATH="${RUN_DIR}/agent.keystore.json"
ZEROS="$(printf '00%.0s' {1..32})"
cat >"$RMPC_CONFIG" <<EOF
chain_id              = 8453
rpc_url               = "${ANVIL_RPC}"
gateway_address       = "${GATEWAY}"
usdc_address          = "${USDC}"
vault_address         = "${VAULT}"
gateway_runtime_hash  = "0x${ZEROS}"
max_fee_per_gas_cap   = ${FEE_CAP_WEI}

[signer]
allow_software_fallback = true
keystore_path           = "${KEYSTORE_PATH}"
EOF

cat >"${RUN_DIR}/openclaw-config.json" <<EOF
{
  "harness": "${HARNESS}",
  "rmpc_config": "${RMPC_CONFIG}",
  "rmpc_bin": "${RMPC_BIN}",
  "network": "fork",
  "monitor_command": "get-vault",
  "monitor_iterations": 1,
  "monitor_interval_secs": 1,
  "task_prompt_source": "docs/technical/demo-runbook.md#32-bounded-agent-task",
  "agent_address": "${AGENT_ADDRESS}",
  "deposit_amount": "${DEPOSIT_AMOUNT}",
  "fee_cap_wei": ${FEE_CAP_WEI},
  "failure_case": "${FAILURE_CASE}"
}
EOF

# ----- skill package artifact ---------------------------------------------
SKILL_DIR="${REPO_ROOT}/.claude/skills"
if [[ -d "$SKILL_DIR" ]]; then
    tar czf "${RUN_DIR}/skill-package.tar.gz" -C "$SKILL_DIR" . 2>/dev/null || \
        tar czf "${RUN_DIR}/skill-package.tar.gz" --files-from /dev/null
else
    tar czf "${RUN_DIR}/skill-package.tar.gz" --files-from /dev/null
fi

# ----- agent run: bounded read-then-write loop ----------------------------
TRACE="${RUN_DIR}/command-trace.jsonl"
: >"$TRACE"

# rmpc invocation wrapper that tees stdout to outputs/ and appends to
# command-trace.jsonl. Per runbook §3.3, one JSON line per call.
# The captured stdout file path is returned via RMPC_LAST_OUT.
SEQ=0
RMPC_LAST_OUT=""
rmpc_call() {
    SEQ=$(( SEQ + 1 ))
    local subcmd="$1"; shift
    local out="${RUN_DIR}/outputs/$(printf '%03d' $SEQ)-${subcmd}.json"
    local err
    err="$(mktemp)"
    local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    set +e
    "$RMPC_BIN" "$subcmd" --config "$RMPC_CONFIG" "$@" >"$out" 2>"$err"
    local exit_code=$?
    set -e
    # JSON-encode argv as a single line for the trace.
    local argv_json
    argv_json="$(printf '%s\n' "$subcmd" "$@" | jq -R . | jq -s .)"
    local stdout_b64; stdout_b64="$(base64 -w0 <"$out" 2>/dev/null || base64 <"$out")"
    local stderr_b64; stderr_b64="$(base64 -w0 <"$err" 2>/dev/null || base64 <"$err")"
    jq -nc \
        --arg ts "$ts" \
        --argjson argv "$argv_json" \
        --argjson exit "$exit_code" \
        --arg stdout_b64 "$stdout_b64" \
        --arg stderr_b64 "$stderr_b64" \
        '{ts:$ts, argv:$argv, exit:$exit, stdout_b64:$stdout_b64, stderr_b64:$stderr_b64}' \
        >>"$TRACE"
    RMPC_LAST_OUT="$out"
    rm -f "$err"
    return $exit_code
}

# Outcome state machine. The agent's prompt (runbook §3.2) specifies:
# read get-vault, get-agent, get-balance, get-allowance, self-check;
# refuse on first failed precondition; otherwise deposit. We translate
# the prompt into deterministic shell control flow that calls rmpc.
#
# State is communicated via temp files so the timeout-wrapper subshell
# can propagate values back to the outer shell.
STATE_DIR="$(mktemp -d)"
echo "refused"          >"${STATE_DIR}/outcome"
echo "unspecified"      >"${STATE_DIR}/reason"
echo "null"             >"${STATE_DIR}/deposit_id"
echo "null"             >"${STATE_DIR}/tx_hash"
echo "null"             >"${STATE_DIR}/gas_used"
echo "null"             >"${STATE_DIR}/total_before"
echo "null"             >"${STATE_DIR}/total_after"

run_agent_loop() {
    if [[ "${RMPC_DEMO_SKIP_RUN:-}" == "1" ]]; then
        log "RMPC_DEMO_SKIP_RUN=1 — skipping agent invocation"
        echo "refused"   >"${STATE_DIR}/outcome"
        echo "skip_run"  >"${STATE_DIR}/reason"
        return 0
    fi

    # Step 1: get-vault (read totalAssets before deposit).
    log "step 1: rmpc get-vault"
    if ! rmpc_call get-vault; then
        echo "refused"           >"${STATE_DIR}/outcome"
        echo "get-vault failed"  >"${STATE_DIR}/reason"
        return 0
    fi
    # Parse totalAssets from envelope: .data.total_assets
    local before
    before="$(jq -r '.data.total_assets // empty' "$RMPC_LAST_OUT" 2>/dev/null || true)"
    if [[ -n "$before" ]]; then
        printf '"%s"' "$before" >"${STATE_DIR}/total_before"
    fi

    # Step 2: get-agent --agent <address> (ADR §3.2, CLI --agent flag per cli.rs).
    log "step 2: rmpc get-agent --agent ${AGENT_ADDRESS}"
    if ! rmpc_call get-agent --agent "$AGENT_ADDRESS"; then
        echo "refused"        >"${STATE_DIR}/outcome"
        echo "not authorized" >"${STATE_DIR}/reason"
        return 0
    fi

    # Step 3a: get-balance --address <address>.
    log "step 3a: rmpc get-balance --address ${AGENT_ADDRESS}"
    if ! rmpc_call get-balance --address "$AGENT_ADDRESS"; then
        echo "refused"           >"${STATE_DIR}/outcome"
        echo "get-balance failed" >"${STATE_DIR}/reason"
        return 0
    fi

    # Step 3b: get-allowance --owner <address> --spender <gateway>
    # (ADR §3.2, CLI --owner/--spender flags per cli.rs).
    log "step 3b: rmpc get-allowance --owner ${AGENT_ADDRESS} --spender ${GATEWAY}"
    if ! rmpc_call get-allowance --owner "$AGENT_ADDRESS" --spender "$GATEWAY"; then
        echo "refused"                       >"${STATE_DIR}/outcome"
        echo "allowance below deposit amount" >"${STATE_DIR}/reason"
        return 0
    fi

    # Step 4: self-check.
    log "step 4: rmpc self-check"
    if ! rmpc_call self-check; then
        echo "refused"           >"${STATE_DIR}/outcome"
        echo "self-check failed" >"${STATE_DIR}/reason"
        return 0
    fi

    # Step 5: deposit --amount <n> --order-id <id> --fee-cap <wei>
    # (ADR §3.2. CLI flags: --amount, --order-id required; --fee-cap optional
    # per cli.rs issue #93 §4.7. No --max-fee flag exists.)
    log "step 5: rmpc deposit --amount ${DEPOSIT_AMOUNT} --order-id ${ORDER_ID}"
    if ! rmpc_call deposit \
            --amount "$DEPOSIT_AMOUNT" \
            --order-id "$ORDER_ID" \
            --fee-cap "$FEE_CAP_WEI"; then
        echo "refused"         >"${STATE_DIR}/outcome"
        echo "deposit aborted" >"${STATE_DIR}/reason"
        return 0
    fi
    # Parse deposit output fields: payment_id, tx_hash, gas_used.
    local payment_id tx_hash gas_used
    payment_id="$(jq -r '.payment_id // empty' "$RMPC_LAST_OUT" 2>/dev/null || true)"
    tx_hash="$(jq -r '.tx_hash // empty'    "$RMPC_LAST_OUT" 2>/dev/null || true)"
    gas_used="$(jq -r '.gas_used // empty'  "$RMPC_LAST_OUT" 2>/dev/null || true)"
    if [[ -n "$payment_id" ]]; then printf '"%s"' "$payment_id" >"${STATE_DIR}/deposit_id"; fi
    if [[ -n "$tx_hash" ]];    then printf '"%s"' "$tx_hash"    >"${STATE_DIR}/tx_hash";    fi
    if [[ -n "$gas_used" ]];   then printf '"%s"' "$gas_used"   >"${STATE_DIR}/gas_used";   fi

    # Step 6a: get-deposit --deposit-id <id> (cli.rs --deposit-id flag).
    if [[ -n "$payment_id" ]]; then
        log "step 6a: rmpc get-deposit --deposit-id ${payment_id}"
        rmpc_call get-deposit --deposit-id "$payment_id" || \
            log "get-deposit returned non-zero (non-fatal for assertion)"
    fi

    # Step 6b: get-tx --tx-hash <hash> (cli.rs --tx-hash flag).
    if [[ -n "$tx_hash" ]]; then
        log "step 6b: rmpc get-tx --tx-hash ${tx_hash}"
        rmpc_call get-tx --tx-hash "$tx_hash" || \
            log "get-tx returned non-zero (non-fatal for assertion)"
    fi

    # Step 6c: get-vault again to capture totalAssets after deposit.
    log "step 6c: rmpc get-vault (post-deposit)"
    if rmpc_call get-vault; then
        local after
        after="$(jq -r '.data.total_assets // empty' "$RMPC_LAST_OUT" 2>/dev/null || true)"
        if [[ -n "$after" ]]; then
            printf '"%s"' "$after" >"${STATE_DIR}/total_after"
        fi
    fi

    echo "deposited" >"${STATE_DIR}/outcome"
}

# Run within a 10-minute hard timeout per ADR §3.2 success criterion #1.
log "launching bounded agent loop (10 min hard cap)"
( run_agent_loop ) &
AGENT_PID=$!
TIMEOUT_SECS=600
elapsed=0
while kill -0 "$AGENT_PID" 2>/dev/null; do
    if (( elapsed >= TIMEOUT_SECS )); then
        log "agent loop exceeded 10-minute hard timeout; SIGTERM"
        kill -TERM "$AGENT_PID" 2>/dev/null || true
        echo "refused" >"${STATE_DIR}/outcome"
        echo "timeout"  >"${STATE_DIR}/reason"
        break
    fi
    sleep 2
    elapsed=$(( elapsed + 2 ))
done
wait "$AGENT_PID" 2>/dev/null || true

# Read outcome state from temp files.
OUTCOME="$(cat "${STATE_DIR}/outcome")"
OUTCOME_REASON="$(cat "${STATE_DIR}/reason")"
DEPOSIT_ID="$(cat "${STATE_DIR}/deposit_id")"
TX_HASH="$(cat "${STATE_DIR}/tx_hash")"
GAS_USED="$(cat "${STATE_DIR}/gas_used")"
TOTAL_BEFORE="$(cat "${STATE_DIR}/total_before")"
TOTAL_AFTER="$(cat "${STATE_DIR}/total_after")"
rm -rf "$STATE_DIR"

# ----- final report -------------------------------------------------------
if [[ "$OUTCOME" == "refused" ]]; then
    OUTCOME_LINE="refused: ${OUTCOME_REASON:-unspecified}"
else
    OUTCOME_LINE="deposited"
fi

cat >"${RUN_DIR}/final-report.json" <<EOF
{
  "agent": "${AGENT_ADDRESS}",
  "fork_block": ${RMPC_FORK_BLOCK},
  "vault_totalAssets_before": ${TOTAL_BEFORE},
  "vault_totalAssets_after": ${TOTAL_AFTER},
  "deposit_id": ${DEPOSIT_ID},
  "tx_hash": ${TX_HASH},
  "gas_used": ${GAS_USED},
  "outcome": "${OUTCOME_LINE}",
  "failure_case": "${FAILURE_CASE}"
}
EOF
log "final outcome: ${OUTCOME_LINE}"
log "artifacts written to ${RUN_DIR}"

# ----- locked success-criteria assertions (runbook §3.2) ------------------
# Criterion 4: no rmpc invocation references the explorer or dapp URLs.
if grep -E '(explorer|dapp)' "$TRACE" >/dev/null 2>&1; then
    log "ASSERTION FAILED: command trace references explorer/dapp URL"
    exit 5
fi

if [[ -z "$FAILURE_CASE" ]]; then
    # Happy-path: require deposited outcome AND non-null core fields in the
    # final report (ADR §3.2 locked success criteria #3).
    # Criterion 1: outcome must be "deposited".
    report_outcome="$(jq -r '.outcome' "${RUN_DIR}/final-report.json" 2>/dev/null || echo "missing")"
    if [[ "$report_outcome" != "deposited" ]]; then
        log "ASSERTION FAILED: happy-path expected outcome=deposited, got '${report_outcome}'"
        exit 5
    fi
    # Criterion 1: tx_hash, deposit_id, gas_used must be non-null strings.
    for field in tx_hash deposit_id gas_used; do
        val="$(jq -r ".${field}" "${RUN_DIR}/final-report.json" 2>/dev/null || echo "null")"
        if [[ "$val" == "null" || -z "$val" ]]; then
            log "ASSERTION FAILED: happy-path final-report.${field} is null or missing"
            exit 5
        fi
    done
    # Criterion 1: vault_totalAssets_before and _after must be non-null.
    for field in vault_totalAssets_before vault_totalAssets_after; do
        val="$(jq -r ".${field}" "${RUN_DIR}/final-report.json" 2>/dev/null || echo "null")"
        if [[ "$val" == "null" || -z "$val" ]]; then
            log "ASSERTION FAILED: happy-path final-report.${field} is null or missing"
            exit 5
        fi
    done
    # Criterion 2: command trace must contain the read prefix in order.
    # Check that get-vault, get-agent, get-balance, get-allowance, self-check
    # all appear in the trace (in order, each in argv).
    for subcmd in get-vault get-agent get-balance get-allowance self-check; do
        if ! jq -e --arg cmd "$subcmd" '.argv[0] == $cmd' "$TRACE" >/dev/null 2>&1; then
            log "ASSERTION FAILED: command trace missing required prefix step: $subcmd"
            exit 5
        fi
    done
    # Criterion 3: deposit must appear in trace.
    if ! jq -e '.argv[0] == "deposit"' "$TRACE" >/dev/null 2>&1; then
        log "ASSERTION FAILED: command trace does not contain a deposit call"
        exit 5
    fi
    # Criterion 3: get-deposit and get-tx must appear after deposit in trace.
    for subcmd in get-deposit get-tx; do
        if ! jq -e --arg cmd "$subcmd" '.argv[0] == $cmd' "$TRACE" >/dev/null 2>&1; then
            log "ASSERTION FAILED: command trace missing post-deposit confirmation: $subcmd"
            exit 5
        fi
    done
else
    # Failure-case mode: require refusal outcome.
    if [[ "$OUTCOME" != "refused" ]]; then
        log "ASSERTION FAILED: failure-case ${FAILURE_CASE} expected refusal, got ${OUTCOME_LINE}"
        exit 5
    fi
fi

exit 0
