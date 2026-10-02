#!/usr/bin/env bash
# One verb per stage job for the core stack on the Twin chain (918453).
#
# This script only wraps BOOT and HEALTH. It deploys nothing and governs
# nothing itself. Stage runs the same runbook as mainnet, "publish contracts"
# (devops, Bun TypeScript), with the Twin chain arguments:
#
#   --chain 918453 --rpc <twin rpc> --sheet <stage sheet> --signer keystore \
#   --environment stage --core-sha <sha>
#
# The smoke harness (`cargo run -p smoke-test -- --full-stack`) boots the Twin
# chain, funds fresh rehearsal keystores and calls publish contracts. A fresh
# keystore set is minted on every boot, so a redeploy from a new SHA never
# reuses a deployer. The deploy, the real Safe handover, the verifier and the
# stage 13 govern matrix all run through publish contracts and the Safe SDK
# tool. Voting power, quorum, agent registration and weights are govern rows
# executed through the real Safe and the timelock, never set by a deployer.
#
# Usage (run from the repo root on the stage host):
#   core-stack.sh chain up        [--ref REF] [--timeout SECS] [--out-dir DIR]
#   core-stack.sh chain down      [--out-dir DIR]
#   core-stack.sh chain status    [--ref REF] [--out-dir DIR]
#   core-stack.sh publish args    [--out-dir DIR]              # print the argument list
#   core-stack.sh publish run     [--out-dir DIR]              # publish contracts, resumes
#   core-stack.sh governance preflight [--out-dir DIR]
#   core-stack.sh governance ensure    [--out-dir DIR]         # publish contracts govern
#   core-stack.sh governance verify    [--out-dir DIR]         # publish contracts verify
#   core-stack.sh governance release --receipt-id ID [--out-dir DIR]
#   core-stack.sh parity labels   --mainnet FILE [--out-dir DIR]  # stage vs mainnet verifier labels
#   core-stack.sh parity sheet    --production FILE               # stage vs production sheet
#   core-stack.sh dapp status
#   core-stack.sh rmpc check
#   core-stack.sh record write    [--record FILE] [--out-dir DIR]
#   core-stack.sh record show     [--record FILE] [--out-dir DIR] [--path]
#
# Needed in the environment for chain up and the publish/governance verbs:
#   PUBLISH_CONTRACTS_DIR  the devops publish-contracts directory (src/cli.ts)
#   STAGE_SHEET            the stage sheet: parameter lines only
#
# --ref resolves branch (origin/REF) -> tag -> commit. With no --ref, or
# --ref HEAD, the candidate is this checkout's own HEAD.
#
# Verbs:
#   chain up      rebuild rmpc from this checkout, then boot the full-stack
#                 harness, detached in its own process group, and wait for its
#                 endpoint summary. The summary prints only after publish
#                 contracts finished inside the harness. The harness boots from
#                 the checkout, so --ref must resolve to HEAD (exit 65
#                 otherwise). A no-op when `chain status` already passes.
#                 Refuses (exit 66) while an earlier harness is still alive.
#   chain down    clear the boot stamp, stop the harness's process group
#                 (SIGINT, then SIGTERM) and the dapp stack.
#   chain status  the chain answers 918453, a container of the harness's
#                 robotmoney-dapp compose project is healthy, target/debug/rmpc
#                 was built from --ref, and the boot stamp names that same
#                 commit and a harness that is still running. Live state only.
#   publish args  print the publish contracts argument list for this boot.
#   publish run   publish contracts `publish` against the booted chain with the
#                 harness's sheet and keystores. The driver adopts what exists
#                 and skips finished stages.
#   governance preflight  the booted chain is one publish contracts can drive:
#                 summary complete, chain id 918453, the canonical Safe v1.4.1
#                 set present, four vault manifests, the Safe and the timelock
#                 have code, the keystore directory exists.
#   governance ensure   publish contracts `govern`: the stage 13 matrix through
#                 the real Safe and the timelock. Every row prints a tx hash and
#                 receipt status; any row without status 1 fails this verb.
#   governance verify   publish contracts `verify`: the one verifier.
#   governance release  one govern row, `release-receipt`, for a recorded
#                 consensus receipt.
#   parity labels  run the verifier on the booted chain, save its output as
#                 $OUT_DIR/verify-labels.txt and run label-diff.ts against the
#                 mainnet verifier output FILE. Any difference exits non-zero.
#   parity sheet  run sheet-diff.ts on the stage sheet (STAGE_SHEET or the
#                 harness summary's sheet_path) against the production sheet.
#                 Only parameter lines may differ.
#   dapp status   rpc, explorer-api /health and the dapp answer, once.
#   rmpc check    both signing binaries are present and answer the exit-code
#                 contract downstream steps rely on.
#   record write  derive the cross-repo record from the manifests, the sheet and
#                 the chain. Nothing in it is typed by hand.
#   record show   print the record after checking every field the cross-repo
#                 contract names has the shape that contract gives it.
#
# Output: results on stdout, progress on stderr. A read-only verb that fails
# prints one line `<class>: <detail>` on stdout, so a caller can tell WHICH
# precondition failed without parsing prose.
#
# Exit codes: 0 ok / satisfied; 1 not satisfied (a status/check verb's honest
# "no"); 3 required tool missing; 64 usage; 65 bad input (record, summary, ref);
# 66 an action failed. Codes from publish contracts pass through unchanged.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
cd "$REPO_ROOT"

RMPC="$REPO_ROOT/target/debug/rmpc"
RMPC_IMPORT="$REPO_ROOT/target/debug/rmpc-keystore-import"
CAST="${CAST:-cast}"
BUN="${BUN:-bun}"

OUT_DIR="/opt/fusion-stage"
RPC_URL="http://127.0.0.1:18545"
CHAIN_ID="918453"
CHAIN_ID_HEX="0xe03b5"
ENVIRONMENT="stage"
REF=""
RECORD=""
RECEIPT_ID=""
MAINNET_FILE=""
PRODUCTION_FILE=""
TIMEOUT_SECS=3600               # boot plus a full publish contracts run
PATH_ONLY=0
# Internal: `record show --list-required-fields` is the schema-drift guard's
# only consumer (see RECORD_REQUIRED_FIELDS below).
LIST_REQUIRED_FIELDS=0
# Seconds between readiness polls while `chain up` waits. Overridable so the
# offline self-test does not spend minutes sleeping.
POLL_SECS="${CORE_STACK_POLL_SECS:-3}"

# The harness's dapp stack: its compose project and the run-identity label every
# one of its services carries.
DAPP_PROJECT="robotmoney-dapp"
TESTNET_LABEL="com.robotmoney.testnet=1"
DAPP_COMPOSE="$REPO_ROOT/testing/ethereum-testnet/config/docker-compose.dapp.yaml"

# Canonical Safe v1.4.1 on the Twin chain: publish contracts needs all three.
SAFE_L2_SINGLETON="0x29fcB43b46531BcA003ddC8FCB67FFE91900C762"
SAFE_PROXY_FACTORY="0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"
SAFE_FALLBACK_HANDLER="0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99"

# root's non-login shell on the stage host resolves neither cargo, cast nor bun.
export PATH="$HOME/.cargo/bin:$HOME/.foundry/bin:$HOME/.bun/bin:$PATH"

usage() { awk 'NR > 1 { if (!/^#/) exit; print }' "$0" >&2; exit 64; }
info() { echo "==> [core-stack] $*" >&2; }
fail() { echo "FAIL: [core-stack] $1" >&2; exit "${2:-66}"; }
# A read-only verb's "no": one classed line on stdout, exit 1.
unsatisfied() { echo "$1: $2"; exit 1; }
value_of() { [[ $# -ge 2 && -n "$2" ]] || { echo "$1 needs a value" >&2; usage; }; }

NOUN="${1:-}"; [[ $# -gt 0 ]] && shift
VERB="${1:-}"; [[ $# -gt 0 ]] && shift
while (( $# )); do
  case "$1" in
    --ref) value_of "$@"; REF="$2"; shift 2 ;;
    --record) value_of "$@"; RECORD="$2"; shift 2 ;;
    --out-dir) value_of "$@"; OUT_DIR="$2"; shift 2 ;;
    --timeout) value_of "$@"; TIMEOUT_SECS="$2"; shift 2 ;;
    --receipt-id) value_of "$@"; RECEIPT_ID="$2"; shift 2 ;;
    --mainnet) value_of "$@"; MAINNET_FILE="$2"; shift 2 ;;
    --production) value_of "$@"; PRODUCTION_FILE="$2"; shift 2 ;;
    --path) PATH_ONLY=1; shift ;;
    --list-required-fields) LIST_REQUIRED_FIELDS=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[[ "$TIMEOUT_SECS" =~ ^[1-9][0-9]*$ ]] || { echo "--timeout must be a positive integer" >&2; usage; }
[[ "$POLL_SECS" =~ ^[1-9][0-9]*$ ]] || POLL_SECS=3

SUMMARY="$OUT_DIR/core-smoke.log"
# "PID START": the harness pid and its start time (/proc/PID/stat field 22), so
# a pid the kernel has since handed to another process is never mistaken for it.
PID_FILE="$OUT_DIR/core-smoke.pid"
# Written by `chain up` only after the booted stack checked out.
STAMP="$OUT_DIR/core-stack.stamp"
LOCK="$OUT_DIR/.core-stack.lock"
RECORD="${RECORD:-$OUT_DIR/fusion-stage-record.json}"

need() { command -v "$1" >/dev/null 2>&1 || fail "required tool '$1' not on PATH" 3; }
need_env() { [[ -n "${!1:-}" ]] || fail "$1 is not set: $2" 65; }

# The candidate commit. No --ref (or HEAD) is this checkout's HEAD, never
# origin/HEAD. Otherwise branch -> tag -> raw commit.
candidate_commit() {
  if [[ -z "$REF" || "$REF" == HEAD ]]; then
    git rev-parse --verify --quiet 'HEAD^{commit}' || true
    return 0
  fi
  git rev-parse --verify --quiet "refs/remotes/origin/${REF}^{commit}" \
    || git rev-parse --verify --quiet "refs/tags/${REF}^{commit}" \
    || git rev-parse --verify --quiet "${REF}^{commit}" \
    || true
}

rpc_chain_id() {
  curl -fsS --max-time 3 -X POST "$RPC_URL" \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' 2>/dev/null \
    | jq -r '.result // empty' 2>/dev/null || true
}

# /proc/PID/stat field 22 (start time) of a live process; a zombie counts as gone.
proc_start_time() {
  local stat
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  stat="${stat##*) }"
  [[ "${stat%% *}" != Z ]] || return 1
  awk '{ print $20 }' <<<"$stat"
}

# Prints the pid of the live harness the pid file names, or returns 1.
harness_pid() {
  local pid="" start="" rest="" now
  [[ -f "$PID_FILE" ]] || return 1
  read -r pid start rest <"$PID_FILE" || true
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  now="$(proc_start_time "$pid")" || return 1
  if [[ -n "$start" ]]; then
    [[ "$now" == "$start" ]] || return 1
  else
    tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -Eq 'smoke-test' || return 1
  fi
  echo "$pid"
}

# One writer at a time per out dir.
take_lock() {
  need flock
  mkdir -p "$OUT_DIR"
  exec 9>"$LOCK"
  flock -n 9 || fail "another chain up / chain down holds $LOCK; wait for it, or stop it first" 66
}

# key=value lines from the harness summary; the last one wins.
summary_value() { awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); v = $0 } END { print v }' "$SUMMARY" 2>/dev/null || true; }

# ─── publish contracts: the one runbook ──────────────────────────────────────
# The argument list is the same on every target. Only the values differ.
publish_args() { # publish_args VERB
  local sha
  sha="$(candidate_commit)"
  [[ -n "$sha" ]] || fail "cannot resolve the candidate commit" 65
  printf '%s\n' "$1" --chain "$CHAIN_ID" --rpc "$RPC_URL" --sheet "$(summary_value sheet_path)" \
    --signer keystore --environment "$ENVIRONMENT" --core-sha "$sha"
}

publish_contracts() { # publish_contracts VERB [extra args...]
  local verb="$1"; shift
  need "$BUN"
  need_env PUBLISH_CONTRACTS_DIR "point it at the devops publish-contracts directory"
  [[ -f "$PUBLISH_CONTRACTS_DIR/src/cli.ts" ]] || fail "$PUBLISH_CONTRACTS_DIR/src/cli.ts not found" 65
  local sheet keydir pwfile mdir
  sheet="$(summary_value sheet_path)"; keydir="$(summary_value key_dir)"
  pwfile="$(summary_value password_file)"; mdir="$(summary_value manifest_dir)"
  [[ -f "$sheet" && -d "$keydir" && -f "$pwfile" && -d "$mdir" ]] \
    || fail "the harness summary names no usable sheet, keystore directory or manifest directory: boot with \`chain up\`" 65
  local -a args
  mapfile -t args < <(publish_args "$verb")
  REHEARSAL_KEY_DIR="$keydir" REHEARSAL_PASSWORD_FILE="$pwfile" PUBLISH_MANIFEST_DIR="$mdir" \
    "$BUN" "$PUBLISH_CONTRACTS_DIR/src/cli.ts" "${args[@]}" "$@"
}

# ─── rmpc, always rebuilt from the checkout ──────────────────────────────────
# Not a conditional check: a stale binary silently invalidates a whole run.
rebuild_rmpc() {
  need cargo
  info "rebuilding rmpc from $(git describe --tags --always 2>/dev/null || echo 'this checkout')"
  cargo build -p rust-payment-client --bin rmpc --bin rmpc-keystore-import \
    || fail "rmpc rebuild failed; refusing to run against whatever binary was already there" 66
}

# ─── chain ────────────────────────────────────────────────────────────────────
chain_facts_line() {
  local want="$1" got healthy built
  got="$(rpc_chain_id)"
  [[ -n "$got" ]] || { echo "rpc-unreachable: nothing answering eth_chainId at $RPC_URL"; return 1; }
  [[ "$got" == "$CHAIN_ID_HEX" ]] || { echo "wrong-chain: $RPC_URL answers $got, want $CHAIN_ID_HEX"; return 1; }
  healthy="$(docker ps --filter health=healthy \
      --filter "label=com.docker.compose.project=$DAPP_PROJECT" --filter "label=$TESTNET_LABEL" \
      --format '{{.Names}}' 2>/dev/null | sed '/^$/d' | wc -l | tr -d ' ' || true)"
  [[ "$healthy" -ge 1 ]] || { echo "no-healthy-container: no healthy container in compose project $DAPP_PROJECT"; return 1; }
  [[ -x "$RMPC" ]] || { echo "rmpc-missing: $RMPC"; return 1; }
  built="$("$RMPC" build-info 2>/dev/null | jq -r '.commit // empty' 2>/dev/null || true)"
  [[ "$built" == "$want" ]] || { echo "candidate-mismatch: rmpc built from '${built:-unknown}', candidate is $want"; return 1; }
  echo "ok: chain $CHAIN_ID_HEX, $healthy healthy $DAPP_PROJECT container(s), rmpc built from $want"
}

# boot-mismatch is a CHAIN fact (the running chain was booted from another
# commit: `chain down` + `chain up`). candidate-mismatch is a BUILD-ARTIFACT
# fact (rmpc was rebuilt for something else since): rebuild rmpc only.
stamp_line() {
  local want="$1" commit pid start now
  [[ -f "$STAMP" ]] || { echo "not-booted: no completed \`chain up\` stamp at $STAMP"; return 1; }
  commit="$(jq -r '.commit // empty' "$STAMP" 2>/dev/null || true)"
  pid="$(jq -r '.pid // empty' "$STAMP" 2>/dev/null || true)"
  start="$(jq -r '.start_time // empty' "$STAMP" 2>/dev/null || true)"
  [[ "$commit" == "$want" ]] || { echo "boot-mismatch: the running chain was booted from '${commit:-unknown}', candidate is $want"; return 1; }
  [[ "$pid" =~ ^[0-9]+$ && -n "$start" ]] || { echo "not-booted: $STAMP is malformed"; return 1; }
  now="$(proc_start_time "$pid" || true)"
  [[ "$now" == "$start" ]] || { echo "harness-gone: the harness that booted this chain (pid $pid) is no longer running"; return 1; }
  echo "ok: booted from $commit by harness pid $pid"
}

chain_status_line() {
  local want line
  want="$(candidate_commit)"
  [[ -n "$want" ]] || { echo "ref-unresolved: '${REF:-HEAD}' is not a branch, tag or commit in this checkout"; return 1; }
  line="$(stamp_line "$want")" || { echo "$line"; return 1; }
  chain_facts_line "$want"
}

chain_status() { need curl; need jq; need docker; local line rc=0; line="$(chain_status_line)" || rc=$?; echo "$line"; exit "$rc"; }

write_stamp() {
  jq -n --arg commit "$1" --argjson pid "$2" --arg start "$3" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{commit: $commit, pid: $pid, start_time: $start, booted_at: $at}' >"$STAMP.tmp"
  mv "$STAMP.tmp" "$STAMP"
}

chain_up() {
  need curl; need jq; need docker
  need_env PUBLISH_CONTRACTS_DIR "the harness calls publish contracts: point it at the devops publish-contracts directory"
  need_env STAGE_SHEET "the harness needs the stage sheet (parameter lines only)"
  local want head pid start line rc
  want="$(candidate_commit)"
  [[ -n "$want" ]] || fail "--ref '${REF:-HEAD}' is not a branch, tag or commit in this checkout" 65
  head="$(git rev-parse --verify --quiet 'HEAD^{commit}' || true)"
  [[ "$want" == "$head" ]] \
    || fail "--ref '${REF:-HEAD}' is $want, but this checkout is at ${head:-nothing}: check the ref out first" 65
  take_lock
  if chain_status_line >/dev/null; then
    info "the candidate is already up and healthy; starting nothing"
    chain_status_line
    return 0
  fi
  if pid="$(harness_pid)"; then
    fail "an earlier harness (pid $pid) is still running but is not the healthy candidate; run \`core-stack.sh chain down\` first" 66
  fi
  rm -f "$STAMP" "$PID_FILE"
  # Truncated before the harness exists; the harness only appends.
  : >"$SUMMARY"
  rebuild_rmpc
  # Detached, in its own process group (set -m), so `chain down` can signal the
  # harness and every child at once. fd 9 (the lock) is closed for it.
  # The Twin chain is the harness default backend (geth). No fork, no anvil.
  set -m
  nohup stdbuf -oL -eL cargo run -p smoke-test -- \
    --full-stack \
    --rpc-port 18545 \
    --explorer-port 18546 \
    --dapp-port 5173 \
    --public-rpc-url https://stage-rpc.robotmoney-labs.dev \
    --public-explorer-url https://stage-explorer.robotmoney-labs.dev \
    --public-dapp-url https://stage-dapp.robotmoney-labs.dev \
    --no-receipt-fixtures >>"$SUMMARY" 2>&1 </dev/null 9>&- &
  pid=$!
  set +m
  if ! start="$(proc_start_time "$pid")"; then
    tail -150 "$SUMMARY" >&2
    fail "the harness exited as soon as it started" 66
  fi
  echo "$pid $start" >"$PID_FILE"
  info "harness pid $pid, log $SUMMARY; waiting up to ${TIMEOUT_SECS}s for the endpoint summary"
  local deadline=$(( $(date +%s) + TIMEOUT_SECS ))
  while (( $(date +%s) < deadline )); do
    if ! harness_pid >/dev/null; then
      rm -f "$PID_FILE"
      tail -150 "$SUMMARY" >&2
      fail "the harness exited before printing its endpoint summary" 66
    fi
    if grep -q -- '--- end endpoint summary ---' "$SUMMARY"; then
      info "endpoint summary printed"
      rc=0; line="$(chain_facts_line "$want")" || rc=$?
      (( rc == 0 )) || fail "the harness printed its summary but the stack is not the healthy candidate: $line" 66
      write_stamp "$want" "$pid" "$start"
      rc=0; line="$(chain_status_line)" || rc=$?
      if (( rc != 0 )); then
        rm -f "$STAMP"
        fail "the harness printed its summary but the stack is not the healthy candidate: $line" 66
      fi
      echo "$line"
      return 0
    fi
    sleep "$POLL_SECS"
  done
  tail -150 "$SUMMARY" >&2
  fail "no endpoint summary within ${TIMEOUT_SECS}s; the harness (pid $pid) is still running: \`core-stack.sh chain down\` stops it" 66
}

SMOKE_INT_GRACE_SECS="${SMOKE_INT_GRACE_SECS:-60}"
SMOKE_TERM_GRACE_SECS="${SMOKE_TERM_GRACE_SECS:-30}"

# signal_and_wait <SIG> <secs> <target>: true once nothing in <target> is left.
signal_and_wait() {
  kill -"$1" -- "$3" 2>/dev/null || true
  for _attempt in $(seq 1 "$2"); do
    kill -0 -- "$3" 2>/dev/null || return 0
    sleep 1
  done
  ! kill -0 -- "$3" 2>/dev/null
}

stop_harness() {
  local pid="" start="" rest="" stat live_start pgrp target
  [[ -f "$PID_FILE" ]] || return 0
  read -r pid start rest <"$PID_FILE" || true
  stat=""
  if [[ "$pid" =~ ^[0-9]+$ ]]; then stat="$(cat "/proc/$pid/stat" 2>/dev/null || true)"; fi
  stat="${stat##*) }"
  if [[ -z "$stat" || "${stat%% *}" == Z ]]; then
    info "pid file names no running process; clearing it"
    rm -f "$PID_FILE"; return 0
  fi
  live_start="$(awk '{ print $20 }' <<<"$stat")"
  pgrp="$(awk '{ print $3 }' <<<"$stat")"
  if [[ -n "$start" && "$start" != "$live_start" ]]; then
    info "pid $pid now belongs to another process; not signalling it"
    rm -f "$PID_FILE"; return 0
  fi
  if [[ -z "$start" ]] && ! tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -Eq 'smoke-test'; then
    info "pid $pid is not the smoke harness; not signalling it"
    rm -f "$PID_FILE"; return 0
  fi
  target="$pid"
  [[ "$pgrp" == "$pid" ]] && target="-$pid"
  info "stopping the smoke harness (pid $pid; signalling $target)"
  signal_and_wait INT "$SMOKE_INT_GRACE_SECS" "$target" \
    || { info "the harness ignored SIGINT for ${SMOKE_INT_GRACE_SECS}s; sending SIGTERM"
         signal_and_wait TERM "$SMOKE_TERM_GRACE_SECS" "$target"; } \
    || fail "core smoke harness (pid $pid) survived SIGINT and SIGTERM" 66
  rm -f "$PID_FILE"
}

chain_down() {
  take_lock
  # The stamp goes first: from here on nothing vouches for the running chain.
  rm -f "$STAMP"
  stop_harness
  # The compose file's `:?` guards interpolate even for `down`.
  env INDEXER_GATEWAY=teardown INDEXER_VAULT=teardown VITE_GATEWAY_ADDRESS=teardown \
      VITE_VAULT_ADDRESS=teardown VITE_GATEWAY_EXPECTED_CODE_HASH=teardown \
      COMPOSE_PROFILES=receipt-fixtures \
    docker compose --project-name "$DAPP_PROJECT" -f "$DAPP_COMPOSE" down \
    || fail "dapp stack down failed" 66
  info "down done"
}

# ─── publish ──────────────────────────────────────────────────────────────────
publish_verb() {
  case "$VERB" in
    args) need jq; publish_args publish ;;
    run) publish_contracts publish; manifest_count_check ;;
    *) usage ;;
  esac
}

# After a publish run every one of the four vaults has a manifest: rmUSDC in
# core.json and one vault-<key>.json each for rmPROTO, rmAGENT and rmRWA.
manifest_count_check() {
  local mdir key n=0
  mdir="$(summary_value manifest_dir)"
  [[ -f "$mdir/core.json" ]] && n=$((n + 1))
  for key in rmPROTO rmAGENT rmRWA; do
    [[ -f "$mdir/vault-$key.json" ]] && n=$((n + 1))
  done
  [[ "$n" == 4 ]] || fail "publish contracts wrote $n of 4 vault manifests in $mdir (rmUSDC, rmPROTO, rmAGENT, rmRWA)" 66
  info "four vault manifests present in $mdir"
}

# ─── governance ───────────────────────────────────────────────────────────────
# What publish contracts needs from the booted chain, each with its own class.
governance_preflight() {
  need jq
  need "$CAST"
  grep -q -- '--- end endpoint summary ---' "$SUMMARY" 2>/dev/null \
    || unsatisfied summary-incomplete "$SUMMARY is absent or carries no end-of-summary marker"
  has_code() { [[ -n "$("$CAST" code "$1" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]0x')" ]]; }
  local chain name key a mdir n
  chain="$("$CAST" chain-id --rpc-url "$RPC_URL" 2>/dev/null)" \
    || unsatisfied rpc-unreachable "nothing answering at $RPC_URL"
  [[ "$chain" == "$CHAIN_ID" ]] || unsatisfied wrong-chain "$RPC_URL is chain '$chain', stage runs only on $CHAIN_ID"
  for name in "SafeL2 singleton:$SAFE_L2_SINGLETON" "SafeProxyFactory:$SAFE_PROXY_FACTORY" \
              "CompatibilityFallbackHandler:$SAFE_FALLBACK_HANDLER"; do
    has_code "${name#*:}" \
      || unsatisfied safe-set-missing "canonical ${name%%:*} ${name#*:} has no code: this chain lacks the Safe v1.4.1 set"
  done
  for key in gateway_addr vault_addr registry_addr router_addr governance_addr \
             ic_policy_addr consensus_receipt_addr safe_addr timelock_addr; do
    a="$(summary_value "$key")"
    [[ "$a" =~ ^0x[0-9a-fA-F]{40}$ ]] || unsatisfied summary-malformed "$key is not address-shaped ('$a')"
    has_code "$a" || unsatisfied no-code "$key $a has no code on $RPC_URL: the summary is from an older boot"
  done
  mdir="$(summary_value manifest_dir)"
  [[ -d "$mdir" ]] || unsatisfied manifests-missing "manifest_dir '${mdir:-none}' is not a directory"
  n="$(find "$mdir" -maxdepth 1 -name 'vault-*.json' | wc -l | tr -d ' ')"
  [[ -f "$mdir/core.json" && "$n" -ge 3 ]] \
    || unsatisfied vault-manifests-missing "want core.json (rmUSDC) plus three vault-*.json manifests in $mdir, found $n"
  [[ -d "$(summary_value key_dir)" ]] \
    || unsatisfied keys-discarded "the rehearsal keystores ($(summary_value key_dir)) are gone, so nobody can drive the Safe; rebuild the stack (chain down, chain up)"
  echo "ok: the booted chain meets every publish contracts precondition"
}

# The govern matrix prints one JSON line per row: {"row","txHash","status"}.
# Any row without a 32-byte tx hash and receipt status 1 fails this verb.
govern_run() { # govern_run [extra args...]
  local out rc=0
  out="$(publish_contracts govern "$@")" || rc=$?
  printf '%s\n' "$out"
  (( rc == 0 )) || return "$rc"
  printf '%s\n' "$out" | "$BUN" "$HERE/govern-rows.ts" >&2 \
    || fail "a govern row has no tx hash or receipt status 1" 66
}

governance_verb() {
  case "$VERB" in
    preflight) governance_preflight ;;
    ensure) govern_run ;;
    verify) publish_contracts verify ;;
    release)
      [[ -n "$RECEIPT_ID" ]] || { echo "release needs --receipt-id" >&2; usage; }
      govern_run --row release-receipt --receipt-id "$RECEIPT_ID" ;;
    *) usage ;;
  esac
}

# ─── parity: stage must equal mainnet except for parameters ──────────────────
# Both checks run the real tools on real output: the verifier's own output from
# the booted chain, and the sheet the harness used.
parity_verb() {
  need "$BUN"
  case "$VERB" in
    labels)
      [[ -n "$MAINNET_FILE" && -f "$MAINNET_FILE" ]] || { echo "parity labels needs --mainnet FILE (the mainnet verifier output)" >&2; usage; }
      local saved="$OUT_DIR/verify-labels.txt" rc=0
      publish_contracts verify >"$saved" || rc=$?
      (( rc == 0 )) || { cat "$saved" >&2; fail "the verifier did not pass on the stage chain (exit $rc)" "$rc"; }
      "$BUN" "$HERE/label-diff.ts" "$saved" "$MAINNET_FILE" ;;
    sheet)
      [[ -n "$PRODUCTION_FILE" && -f "$PRODUCTION_FILE" ]] || { echo "parity sheet needs --production FILE" >&2; usage; }
      local sheet="${STAGE_SHEET:-$(summary_value sheet_path)}"
      [[ -f "$sheet" ]] || fail "no stage sheet: set STAGE_SHEET or boot with \`chain up\`" 65
      "$BUN" "$HERE/sheet-diff.ts" "$sheet" "$PRODUCTION_FILE" ;;
    *) usage ;;
  esac
}

# ─── dapp ─────────────────────────────────────────────────────────────────────
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
rmpc_check() {
  local rc
  [[ -x "$RMPC" ]] || unsatisfied missing-binary "$RMPC"
  [[ -x "$RMPC_IMPORT" ]] || unsatisfied missing-binary "$RMPC_IMPORT"
  "$RMPC" self-check --help >/dev/null 2>&1 \
    || unsatisfied missing-subcommand "this rmpc has no self-check: the candidate predates it"
  rc=0; "$RMPC" self-check -c /nonexistent/rmpc.toml >/dev/null 2>&1 || rc=$?
  [[ "$rc" == 3 ]] || unsatisfied startup-exit-drift "self-check on a missing config exited $rc, want 3"
  rc=0; "$RMPC_IMPORT" >/dev/null 2>&1 || rc=$?
  [[ "$rc" == 2 ]] || unsatisfied import-exit-drift "rmpc-keystore-import with no argv exited $rc, want 2"
  echo "ok: rmpc and rmpc-keystore-import answer their exit-code contracts"
}

# ─── record ───────────────────────────────────────────────────────────────────
# The cross-repo record contract (devops docs/plans/core-runbook-verbs.md, "The
# record"), field by field. A record that breaks it is refused rather than
# printed. Exit 65, with one classed line on stdout.
record_bad() { echo "$1: $2"; exit 65; }

RV=""
record_get() {
  RV="$(jq -r "($1) // empty | if type == \"string\" then . else tojson end" "$RECORD" 2>/dev/null || true)"
  [[ -n "$RV" ]] || record_bad record-field-missing "$RECORD has no ${2:-$1}"
}
record_addr() {
  record_get "$1" "${2:-$1}"
  [[ "$RV" =~ ^0x[0-9a-fA-F]{40}$ && ! "$RV" =~ ^0x0{40}$ ]] \
    || record_bad record-field-malformed "${2:-$1} is not a non-zero address ('$RV')"
}

# The exhaustive required-field set. `record show --list-required-fields` prints
# this array as JSON so schemas/fusion-stage-record.schema.json's `required`
# array can be diffed against it (the drift guard).
RECORD_REQUIRED_FIELDS=(
  .chain_id .run_id .core_tag .core_sha .generated_at .min_delay .deployer
  .addresses.gateway .addresses.vault .addresses.registry .addresses.router .addresses.governance
  .addresses.consensus_receipt .addresses.ic_policy .addresses.timelock .addresses.safe .addresses.emergency
  .code_hashes.gateway
  .vault_addresses.rmUSDC .vault_addresses.rmPROTO .vault_addresses.rmAGENT .vault_addresses.rmRWA
  .ephemeral.submitter .ephemeral.approver .ephemeral.voters .ephemeral.emergency
  .ephemeral.keystore_dir .ephemeral.safe_signers
)

record_list_required_fields() {
  printf '%s\n' "${RECORD_REQUIRED_FIELDS[@]}" | jq -R . | jq -s .
}

# Derive the record from the manifests, the sheet and the chain. The roster is
# what the key helper minted. The voters are the sheet's VOTER_ADDRESSES: their
# voting power is set by govern rows through the real Safe, never by a deployer.
record_write() {
  need jq; need "$CAST"
  local mdir sheet sha tag delay gw hash tl owners voters
  mdir="$(summary_value manifest_dir)"; sheet="$(summary_value sheet_path)"
  [[ -d "$mdir" && -f "$sheet" ]] || fail "the harness summary names no manifest directory or sheet: boot with \`chain up\`" 65
  sha="$(summary_value core_sha)"
  tag="$(git describe --tags --always "$sha" 2>/dev/null || echo "$sha")"
  gw="$(jq -r '.gateway' "$mdir/core.json")"
  tl="$(jq -r '.timelock' "$mdir/timelock.json")"
  delay="$("$CAST" call "$tl" 'getMinDelay()(uint256)' --rpc-url "$RPC_URL" | awk '{print $1; exit}')"
  hash="$("$CAST" keccak "$("$CAST" code "$gw" --rpc-url "$RPC_URL")")"
  sheet_get() { sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$1=[\"']?([^\"'#]*)[\"']?.*$/\2/p" "$sheet" | tail -1 | tr -d ' '; }
  owners="$(sheet_get SAFE_OWNERS)"; voters="$(sheet_get VOTER_ADDRESSES)"
  jq -n \
    --argjson chain "$CHAIN_ID" --arg run_id "$(basename "$(dirname "$mdir")")-$(date -u +%Y%m%dT%H%M%SZ)" \
    --arg tag "$tag" --arg sha "$sha" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson delay "$delay" \
    --arg deployer "$(summary_value deployer_addr)" --arg hash "$hash" \
    --arg keydir "$(summary_value key_dir)" --arg owners "$owners" --arg voters "$voters" \
    --arg emergency "$(sheet_get EMERGENCY_ADDRESS)" --arg agent "$(sheet_get AGENT_ADDRESS)" \
    --slurpfile core "$mdir/core.json" --slurpfile reg "$mdir/registry.json" --slurpfile rtr "$mdir/router.json" \
    --slurpfile gov "$mdir/governance.json" --slurpfile ic "$mdir/ic-policy.json" \
    --slurpfile tlk "$mdir/timelock.json" --slurpfile safe "$mdir/safe.json" \
    --slurpfile proto "$mdir/vault-rmPROTO.json" --slurpfile agentv "$mdir/vault-rmAGENT.json" \
    --slurpfile rwa "$mdir/vault-rmRWA.json" '
    ($owners | split(",")) as $o |
    {
      chain_id: $chain, run_id: $run_id, core_tag: $tag, core_sha: $sha, generated_at: $at,
      generated_by: "scripts/stage/core-stack.sh record write (publish contracts manifests)",
      min_delay: $delay, deployer: $deployer,
      addresses: {
        gateway: $core[0].gateway, vault: $core[0].vault, registry: $reg[0].registry, router: $rtr[0].router,
        governance: $gov[0].governance, consensus_receipt: $ic[0].consensus_receipt, ic_policy: $ic[0].policy,
        timelock: $tlk[0].timelock, safe: $safe[0].safe, emergency: $emergency
      },
      code_hashes: { gateway: $hash },
      vault_addresses: { rmUSDC: $core[0].vault, rmPROTO: $proto[0].vault, rmAGENT: $agentv[0].vault, rmRWA: $rwa[0].vault },
      ephemeral: {
        submitter: $agent, approver: $o[0], voters: ($voters | split(",")), emergency: $emergency,
        keystore_dir: $keydir,
        safe_signers: [ {role: "approver", address: $o[0]}, {role: "approver-b", address: $o[1]}, {role: "approver-c", address: $o[2]} ]
      }
    }' >"$RECORD.tmp"
  mv "$RECORD.tmp" "$RECORD"
  info "wrote $RECORD"
}

record_show() {
  need jq
  (( LIST_REQUIRED_FIELDS )) && { record_list_required_fields; return 0; }
  [[ -f "$RECORD" ]] || record_bad record-missing "$RECORD does not exist"
  jq -e 'type == "object"' "$RECORD" >/dev/null 2>&1 || record_bad record-unparseable "$RECORD is not a JSON object"
  local rfield
  for rfield in "${RECORD_REQUIRED_FIELDS[@]}"; do record_get "$rfield"; done
  local field role approver=""
  record_get .chain_id
  [[ "$RV" == "$CHAIN_ID" ]] || record_bad record-wrong-chain "chain_id is '$RV', not $CHAIN_ID"
  for field in .run_id .core_tag .generated_at .ephemeral.keystore_dir; do record_get "$field"; done
  record_get .core_sha
  [[ "$RV" =~ ^[0-9a-f]{40}$ ]] || record_bad record-field-malformed ".core_sha is not a 40-hex commit ('$RV')"
  record_get .min_delay
  [[ "$RV" =~ ^[1-9][0-9]*$ ]] || record_bad record-field-malformed ".min_delay is not a positive number of seconds ('$RV')"
  for field in .deployer \
               .addresses.gateway .addresses.vault .addresses.registry .addresses.router \
               .addresses.governance .addresses.consensus_receipt .addresses.ic_policy \
               .addresses.timelock .addresses.safe .addresses.emergency \
               .vault_addresses.rmUSDC .vault_addresses.rmPROTO .vault_addresses.rmAGENT .vault_addresses.rmRWA \
               .ephemeral.submitter .ephemeral.approver .ephemeral.emergency \
               '.ephemeral.voters[0]' '.ephemeral.voters[1]'; do
    record_addr "$field"
  done
  record_get .code_hashes.gateway
  [[ "$RV" =~ ^0x[0-9a-fA-F]{64}$ && ! "$RV" =~ ^0x0{64}$ ]] \
    || record_bad record-field-malformed ".code_hashes.gateway is not a non-zero bytes32 ('$RV')"
  # The real 2-of-3 Safe: the three owner keys, each an address, with the
  # approver (the relayer every Safe call is sent from) among them.
  for role in approver approver-b approver-c; do
    record_addr "first(.ephemeral.safe_signers[]? | select(.role == \"$role\") | .address)" \
      ".ephemeral.safe_signers $role"
    [[ "$role" == approver ]] && approver="$RV"
  done
  record_get .ephemeral.approver
  [[ "$(tr '[:upper:]' '[:lower:]' <<<"$approver")" == "$(tr '[:upper:]' '[:lower:]' <<<"$RV")" ]] \
    || record_bad record-field-malformed ".ephemeral.approver $RV is not the approver Safe signer $approver"
  if (( PATH_ONLY )); then echo "$RECORD"; else jq . "$RECORD"; fi
}

case "$NOUN" in
  chain)
    case "$VERB" in up) chain_up ;; down) chain_down ;; status) chain_status ;; *) usage ;; esac ;;
  publish) publish_verb ;;
  governance) governance_verb ;;
  parity) parity_verb ;;
  dapp) if [[ "$VERB" == status ]]; then dapp_status; else usage; fi ;;
  rmpc) if [[ "$VERB" == check ]]; then rmpc_check; else usage; fi ;;
  record)
    case "$VERB" in write) record_write ;; show) record_show ;; *) usage ;; esac ;;
  *) usage ;;
esac
