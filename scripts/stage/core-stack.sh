#!/usr/bin/env bash
# One verb per stage-deployment job for the core stack (chain 918453).
#
# A thin, stable surface over deploy-core-stack.sh and fusion-ceremony.sh, so a
# caller (the devops runbooks, an operator at a terminal) names WHAT it wants
# and this repo owns HOW. Every mutating verb is safe to repeat, and every one
# has a read-only partner that says whether its goal already holds — that pair
# is exactly a runbook step's `run` and `check`. The wrapped scripts are
# unchanged; nothing here re-implements what they do.
#
# Usage (run from the repo root on the stage host):
#   core-stack.sh chain up        [--ref REF] [--timeout SECS] [--out-dir DIR]
#   core-stack.sh chain down      [--out-dir DIR]
#   core-stack.sh chain status    [--ref REF]
#   core-stack.sh governance preflight [--out-dir DIR]
#   core-stack.sh governance ensure    [--out-dir DIR]
#   core-stack.sh governance verify    [--record FILE] [--out-dir DIR]
#   core-stack.sh dapp up         [--out-dir DIR]
#   core-stack.sh dapp status
#   core-stack.sh rmpc check
#   core-stack.sh record show     [--record FILE] [--out-dir DIR] [--path]
#
# Verbs:
#   chain up      boot the full-stack devnet (`deploy-core-stack.sh smoke`, which
#                 always rebuilds rmpc from this checkout first), detached, and
#                 wait for its endpoint summary. A no-op when `chain status`
#                 already passes for --ref. Refuses (exit 66) while an earlier
#                 harness process is still alive: `chain down` first.
#   chain down    stop the harness and the dapp stack (`deploy-core-stack.sh
#                 down`). A no-op against a stack that is already down.
#   chain status  the chain answers 918453, at least one container is healthy,
#                 and target/debug/rmpc was built from --ref (default HEAD).
#                 Live state only; never a log file.
#   governance preflight  the booted chain is one the ceremony can run on:
#                 every summary contract has code, no receipt fixtures, the
#                 deployer key derives the summary's admin, quorum is readable.
#                 Each mirrors a `die` in fusion-ceremony.sh, named in advance.
#   governance ensure     `fusion-ceremony.sh ensure`: provision the Safe, the
#                 TimelockController and the ceremony keys only when the record
#                 on disk is not live on this chain; then verify.
#   governance verify     `fusion-ceremony.sh verify --record`: the on-chain
#                 governance topology, read from the chain, not the record.
#   dapp up       `deploy-core-stack.sh up`: the pinned-image dapp stack from
#                 the record. Not needed after `chain up`, whose --full-stack
#                 harness already runs the dapp; kept for the prebuilt path.
#   dapp status   rpc, explorer-api /health and the dapp answer, once.
#   rmpc check    both signing binaries rebuild_rmpc builds are present, and
#                 answer the exit-code contract downstream steps rely on.
#   record show   print the live ceremony record (or --path: its path) after
#                 checking it carries every field the cross-repo contract names.
#
# Output: results on stdout, progress on stderr. A read-only verb that fails
# prints one line `<class>: <detail>` on stdout, so a caller can tell WHICH
# precondition failed without parsing prose.
#
# Exit codes: 0 ok / satisfied; 1 not satisfied (a status/check verb's honest
# "no"); 3 required tool missing; 64 usage; 65 bad input (record, summary);
# 66 an action failed. Codes from the wrapped scripts pass through unchanged.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT"

DEPLOY="$HERE/deploy-core-stack.sh"
CEREMONY="$HERE/fusion-ceremony.sh"
RMPC="$REPO_ROOT/target/debug/rmpc"
RMPC_IMPORT="$REPO_ROOT/target/debug/rmpc-keystore-import"
CAST="${CAST:-cast}"

OUT_DIR="/opt/fusion-stage"
RPC_URL="http://127.0.0.1:18545"
CHAIN_ID_HEX="0xe03b5"          # 918453
REF=""
RECORD=""
TIMEOUT_SECS=1800               # the harness's own worst case; callers add headroom
PATH_ONLY=0

# root's non-login shell on the stage host resolves neither cargo nor cast.
# Prepended here, once, so no caller has to carry a PATH workaround of its own.
export PATH="$HOME/.cargo/bin:$HOME/.foundry/bin:$PATH"

usage() { awk 'NR > 1 { if (!/^#/) exit; print }' "$0" >&2; exit 64; }
info() { echo "==> [core-stack] $*" >&2; }
fail() { echo "FAIL: [core-stack] $1" >&2; exit "${2:-66}"; }
# A read-only verb's "no": one classed line on stdout, exit 1.
unsatisfied() { echo "$1: $2"; exit 1; }

NOUN="${1:-}"; [[ $# -gt 0 ]] && shift
VERB="${1:-}"; [[ $# -gt 0 ]] && shift
while (( $# )); do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --record) RECORD="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --timeout) TIMEOUT_SECS="$2"; shift 2 ;;
    --path) PATH_ONLY=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[[ "$TIMEOUT_SECS" =~ ^[1-9][0-9]*$ ]] || { echo "--timeout must be a positive integer" >&2; usage; }

SUMMARY="$OUT_DIR/core-smoke.log"
PID_FILE="$OUT_DIR/core-smoke.pid"
RECORD="${RECORD:-$OUT_DIR/fusion-stage-record.json}"

need() { command -v "$1" >/dev/null 2>&1 || fail "required tool '$1' not on PATH" 3; }

# The candidate commit: --ref resolved branch -> tag -> raw commit, the same
# three-way order the devops pin step checks out with, so a branch target (dev)
# resolves here exactly as it did there.
candidate_commit() {
  local ref="${REF:-HEAD}"
  git rev-parse --verify --quiet "refs/remotes/origin/${ref}^{commit}" \
    || git rev-parse --verify --quiet "refs/tags/${ref}^{commit}" \
    || git rev-parse --verify --quiet "${ref}^{commit}" \
    || true
}

rpc_chain_id() {
  curl -fsS --max-time 3 -X POST "$RPC_URL" \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' 2>/dev/null \
    | jq -r '.result // empty' 2>/dev/null || true
}

# ─── chain ────────────────────────────────────────────────────────────────────
# Three facts, all required, so "something healthy is running" is never read as
# "the RIGHT candidate is healthy". Returns the classed line rather than exiting,
# so `chain up` can ask the same question without ending the script.
chain_status_line() {
  local got healthy want built
  got="$(rpc_chain_id)"
  [[ -n "$got" ]] || { echo "rpc-unreachable: nothing answering eth_chainId at $RPC_URL"; return 1; }
  [[ "$got" == "$CHAIN_ID_HEX" ]] || { echo "wrong-chain: $RPC_URL answers $got, want $CHAIN_ID_HEX"; return 1; }
  healthy="$(docker ps --filter health=healthy --format '{{.Names}}' 2>/dev/null | wc -l | tr -d ' ' || true)"
  [[ "$healthy" -ge 1 ]] || { echo "no-healthy-container: docker reports no healthy container"; return 1; }
  want="$(candidate_commit)"
  [[ -n "$want" ]] || { echo "ref-unresolved: '${REF:-HEAD}' is not a branch, tag or commit in this checkout"; return 1; }
  [[ -x "$RMPC" ]] || { echo "rmpc-missing: $RMPC"; return 1; }
  built="$("$RMPC" build-info 2>/dev/null | jq -r '.commit // empty' 2>/dev/null || true)"
  [[ "$built" == "$want" ]] || { echo "candidate-mismatch: rmpc built from '${built:-unknown}', candidate is $want"; return 1; }
  echo "ok: chain $CHAIN_ID_HEX, $healthy healthy container(s), rmpc built from $want"
}

chain_status() { need curl; need jq; need docker; local line rc=0; line="$(chain_status_line)" || rc=$?; echo "$line"; exit "$rc"; }

harness_alive() {
  local pid
  [[ -f "$PID_FILE" ]] || return 1
  pid="$(cat "$PID_FILE")"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

chain_up() {
  need curl; need jq; need docker
  if chain_status_line >/dev/null; then
    info "the candidate is already up and healthy; starting nothing"
    chain_status_line
    return 0
  fi
  harness_alive && fail "an earlier harness (pid $(cat "$PID_FILE")) is still running but unhealthy; run \`core-stack.sh chain down\` first" 66
  mkdir -p "$OUT_DIR"
  # Truncated here, by this boot, so the summary grep below can only ever match
  # this boot's output — never one a previous run left behind.
  : >"$SUMMARY"
  # The harness stays attached until signalled, so it is detached here and its
  # readiness polled, rather than left to block the caller.
  nohup stdbuf -oL -eL bash "$DEPLOY" smoke --out-dir "$OUT_DIR" >"$SUMMARY" 2>&1 </dev/null &
  echo $! >"$PID_FILE"
  info "harness pid $(cat "$PID_FILE"), log $SUMMARY; waiting up to ${TIMEOUT_SECS}s for the endpoint summary"
  local deadline=$(( $(date +%s) + TIMEOUT_SECS ))
  while (( $(date +%s) < deadline )); do
    if grep -q -- '--- end endpoint summary ---' "$SUMMARY"; then
      info "endpoint summary printed"
      local line rc=0
      line="$(chain_status_line)" || rc=$?
      echo "$line"
      (( rc == 0 )) || fail "the harness printed its summary but the stack is not the healthy candidate: $line" 66
      return 0
    fi
    harness_alive || { tail -150 "$SUMMARY" >&2; fail "the harness exited before printing its endpoint summary" 66; }
    sleep 3
  done
  tail -150 "$SUMMARY" >&2
  fail "no endpoint summary within ${TIMEOUT_SECS}s" 66
}

chain_down() { exec bash "$DEPLOY" down --out-dir "$OUT_DIR"; }

# ─── governance ───────────────────────────────────────────────────────────────
# The ceremony's own preconditions on the chain, each enforced inside
# fusion-ceremony.sh by a bare `die` well into a run. Asserted here, before
# `ensure` spends anything, each with its own class.
governance_preflight() {
  need jq
  grep -q -- '--- end endpoint summary ---' "$SUMMARY" 2>/dev/null \
    || unsatisfied summary-incomplete "$SUMMARY is absent or carries no end-of-summary marker"
  # summary_address (fusion-ceremony.sh): last key=value line wins.
  addr() { awk -F= -v k="$1" '$1 == k { v = $2 } END { print v }' "$SUMMARY"; }
  # Its own class, ahead of the per-contract loop: `cast code` against a dead
  # RPC returns empty exactly like a codeless address does.
  "$CAST" chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 \
    || unsatisfied rpc-unreachable "nothing answering at $RPC_URL"
  local key a n d k q
  for key in gateway_addr vault_addr registry_addr router_addr \
             governance_addr ic_policy_addr consensus_receipt_addr; do
    a="$(addr "$key")"
    [[ "$a" =~ ^0x[0-9a-fA-F]{40}$ ]] || unsatisfied summary-malformed "$key is not address-shaped ('$a')"
    [[ -n "$("$CAST" code "$a" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]0x')" ]] \
      || unsatisfied no-code "$key $a has no code on $RPC_URL — the summary is from an older boot"
  done
  # `call` swallows reverts, so an unreadable receipt store is its own class
  # rather than being blamed on the --no-receipt-fixtures boot flag.
  n="$("$CAST" call "$(addr consensus_receipt_addr)" 'receiptCount()(uint256)' --rpc-url "$RPC_URL" 2>/dev/null | awk '{print $1; exit}' || true)"
  [[ "$n" =~ ^[0-9]+$ ]] || unsatisfied receipt-unreadable "receiptCount() returned '$n' from $(addr consensus_receipt_addr)"
  [[ "$n" == "0" ]] || unsatisfied receipt-fixtures-present "receiptCount()=$n, so this boot lost --no-receipt-fixtures"
  # repo_deployer_key: the ceremony signs as the address DERIVED from the repo
  # constant, and dies if that is not the summary's admin_addr.
  k="$(sed -n '/pub const DEPLOYER_PRIVATE_KEY_HEX/{n;p}' testing/smoke-test/src/lib.rs | tr -d ' ";')"
  d="$("$CAST" wallet address --private-key "$k" 2>/dev/null | tr 'A-Z' 'a-z' || true)"
  [[ -n "$d" && "$d" == "$(addr admin_addr | tr 'A-Z' 'a-z')" ]] \
    || unsatisfied deployer-mismatch "DEPLOYER_PRIVATE_KEY_HEX derives '$d', summary admin_addr is '$(addr admin_addr)'"
  # Readability only: the VALUE is ceremony-set.
  q="$("$CAST" call "$(addr governance_addr)" 'quorumThreshold()(uint256)' --rpc-url "$RPC_URL" 2>/dev/null | awk '{print $1; exit}' || true)"
  [[ "$q" =~ ^[0-9]+$ ]] || unsatisfied governance-unreadable "quorumThreshold() returned '$q'"
  echo "ok: the booted chain meets every ceremony precondition"
}

governance_ensure() { exec bash "$CEREMONY" ensure --out-dir "$OUT_DIR" --summary "$SUMMARY" --rpc-url "$RPC_URL"; }

governance_verify() {
  [[ -f "$RECORD" ]] || unsatisfied record-missing "$RECORD does not exist — run \`core-stack.sh governance ensure\`"
  exec bash "$CEREMONY" verify --record "$RECORD" --rpc-url "$RPC_URL"
}

# ─── dapp ─────────────────────────────────────────────────────────────────────
dapp_up() { exec bash "$DEPLOY" up --out-dir "$OUT_DIR"; }

dapp_status() {
  need curl; need jq
  local got
  got="$(rpc_chain_id)"
  [[ "$got" == "$CHAIN_ID_HEX" ]] || unsatisfied rpc-unready "$RPC_URL answers '${got:-nothing}', want $CHAIN_ID_HEX"
  curl -fsS --max-time 3 http://127.0.0.1:18546/health >/dev/null 2>&1 || unsatisfied explorer-unready "explorer-api /health on 18546 does not answer"
  curl -fsS --max-time 3 http://127.0.0.1:5173/ >/dev/null 2>&1 || unsatisfied dapp-unready "the dapp on 5173 does not answer"
  echo "ok: rpc, explorer-api and dapp all answer"
}

# ─── rmpc ─────────────────────────────────────────────────────────────────────
# Everything about the signing path that is a property of the freshly built
# candidate. Not a full `self-check --config`: that needs an operator config, a
# keystore and a passphrase, which the ceremony mints, not the build.
rmpc_check() {
  local rc
  [[ -x "$RMPC" ]] || unsatisfied missing-binary "$RMPC"
  [[ -x "$RMPC_IMPORT" ]] || unsatisfied missing-binary "$RMPC_IMPORT"
  "$RMPC" self-check --help >/dev/null 2>&1 \
    || unsatisfied missing-subcommand "this rmpc has no self-check — the candidate predates it"
  # 3 is "config/keystore could not load", distinct from 2, "a preflight rule
  # refused" (self_check.rs EXIT_STARTUP_FAIL / EXIT_PREFLIGHT_FAIL).
  rc=0; "$RMPC" self-check -c /nonexistent/rmpc.toml >/dev/null 2>&1 || rc=$?
  [[ "$rc" == 3 ]] || unsatisfied startup-exit-drift "self-check on a missing config exited $rc, want 3"
  # 2 is bad input (bin/rmpc_keystore_import.rs); proves it links and runs.
  rc=0; "$RMPC_IMPORT" >/dev/null 2>&1 || rc=$?
  [[ "$rc" == 2 ]] || unsatisfied import-exit-drift "rmpc-keystore-import with no argv exited $rc, want 2"
  echo "ok: rmpc and rmpc-keystore-import answer their exit-code contracts"
}

# ─── record ───────────────────────────────────────────────────────────────────
# The fields the cross-repo contract names. A record missing one is refused
# rather than printed, so a reader never builds on a partial topology.
record_show() {
  need jq
  [[ -f "$RECORD" ]] || fail "record not found: $RECORD" 65
  jq -e . "$RECORD" >/dev/null 2>&1 || fail "record is not valid JSON: $RECORD" 65
  local field
  for field in .chain_id .run_id .core_tag .core_sha .generated_at .min_delay .deployer \
               .addresses.gateway .addresses.vault .addresses.registry .addresses.router \
               .addresses.governance .addresses.consensus_receipt .addresses.timelock \
               .addresses.safe .addresses.emergency \
               .vault_addresses.rmUSDC .vault_addresses.rmPROTO .vault_addresses.rmAGENT .vault_addresses.rmRWA \
               .ephemeral.submitter .ephemeral.approver .ephemeral.voters .ephemeral.emergency; do
    jq -e "$field // empty" "$RECORD" >/dev/null 2>&1 || fail "record $RECORD has no $field" 65
  done
  [[ "$(jq -r .chain_id "$RECORD")" == "918453" ]] || fail "record chain_id $(jq -r .chain_id "$RECORD") is not 918453" 65
  if (( PATH_ONLY )); then echo "$RECORD"; else jq . "$RECORD"; fi
}

case "$NOUN $VERB" in
  "chain up") chain_up ;;
  "chain down") chain_down ;;
  "chain status") chain_status ;;
  "governance preflight") governance_preflight ;;
  "governance ensure") governance_ensure ;;
  "governance verify") governance_verify ;;
  "dapp up") dapp_up ;;
  "dapp status") dapp_status ;;
  "rmpc check") rmpc_check ;;
  "record show") record_show ;;
  *) usage ;;
esac
