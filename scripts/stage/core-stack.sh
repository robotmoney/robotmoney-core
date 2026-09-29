#!/usr/bin/env bash
# One verb per stage-deployment job for the core stack (chain 918453).
#
# A thin, stable surface over deploy-core-stack.sh and fusion-ceremony.sh, so a
# caller (the devops runbooks, an operator at a terminal) names WHAT it wants
# and this repo owns HOW. Every mutating verb is safe to repeat, and every one
# has a read-only partner that says whether its goal already holds — that pair
# is exactly a runbook step's `run` and `check`. Nothing here re-implements
# what the wrapped scripts do.
#
# Usage (run from the repo root on the stage host):
#   core-stack.sh chain up        [--ref REF] [--timeout SECS] [--out-dir DIR]
#   core-stack.sh chain down      [--out-dir DIR]
#   core-stack.sh chain status    [--ref REF] [--out-dir DIR]
#   core-stack.sh governance preflight [--out-dir DIR]
#   core-stack.sh governance ensure    [--out-dir DIR]
#   core-stack.sh governance verify    [--record FILE] [--out-dir DIR]
#   core-stack.sh dapp up         [--out-dir DIR]
#   core-stack.sh dapp status
#   core-stack.sh rmpc check
#   core-stack.sh record show     [--record FILE] [--out-dir DIR] [--path]
#
# --ref resolves branch (origin/REF) -> tag -> commit. With no --ref, or
# --ref HEAD, the candidate is this checkout's own HEAD.
#
# Verbs:
#   chain up      boot the full-stack devnet (`deploy-core-stack.sh smoke`, which
#                 always rebuilds rmpc from this checkout first), detached in its
#                 own process group, and wait for its endpoint summary. The
#                 harness boots from the checkout, so --ref must resolve to HEAD
#                 (exit 65 otherwise). A no-op when `chain status` already passes.
#                 Refuses (exit 66) while an earlier harness is still alive:
#                 `chain down` first. Once the summary is out and the live stack
#                 checks out, it writes the boot stamp `chain status` requires.
#   chain down    clear the boot stamp, then `deploy-core-stack.sh down`: stop the
#                 harness's process group (SIGINT, then SIGTERM) and the dapp
#                 stack. A no-op against a stack that is already down.
#   chain status  the chain answers 918453, a container of the harness's
#                 robotmoney-dapp compose project is healthy, target/debug/rmpc
#                 was built from --ref, and the boot stamp names that same commit
#                 and a harness that is still running. Live state only; never a
#                 log file. rmpc's build-info alone is not enough: `dapp up` and
#                 a failed `chain up` both rebuild rmpc without booting a chain.
#   governance preflight  the booted chain is one `governance ensure` can
#                 provision on: summary complete, chain id 918453, the canonical
#                 Safe v1.4.1 set present, every summary contract has code, no
#                 receipt fixtures, the deployer key derives the summary's admin
#                 and still holds gateway ADMIN_ROLE, no Safe was ever created on
#                 this chain, quorum readable. Each mirrors a refusal in
#                 fusion-ceremony.sh `run`/`ensure`, named in advance.
#   governance ensure     `fusion-ceremony.sh ensure`: provision the Safe, the
#                 TimelockController and the ceremony keys only when the record
#                 on disk is not live on this chain; then verify. A used chain
#                 whose ceremony cannot be driven any more exits 65 (from the
#                 ceremony): reboot it with `chain down` + `chain up`.
#   governance verify     `fusion-ceremony.sh verify --record`: the on-chain
#                 governance topology, read from the chain, not the record. Its
#                 Safe quorum controls sign with the owner keystores, so it fails
#                 once they are discarded. On failure it adds one classed line.
#   dapp up       `deploy-core-stack.sh up`: the pinned-image dapp stack from
#                 the record. Not needed after `chain up`, whose --full-stack
#                 harness already runs the dapp; kept for the prebuilt path. It
#                 rebuilds rmpc from this checkout, so it refuses (exit 65) unless
#                 the running chain was booted by `chain up` from this same HEAD.
#   dapp status   rpc, explorer-api /health and the dapp answer, once.
#   rmpc check    both signing binaries rebuild_rmpc builds are present, and
#                 answer the exit-code contract downstream steps rely on.
#   record show   print the live ceremony record (or --path: its path) after
#                 checking every field the cross-repo contract names has the
#                 shape that contract gives it.
#
# Output: results on stdout, progress on stderr. A read-only verb that fails
# prints one line `<class>: <detail>` on stdout, so a caller can tell WHICH
# precondition failed without parsing prose.
#
# Exit codes: 0 ok / satisfied; 1 not satisfied (a status/check verb's honest
# "no"); 3 required tool missing; 64 usage; 65 bad input (record, summary, ref);
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
CHAIN_ID="918453"
CHAIN_ID_HEX="0xe03b5"
REF=""
RECORD=""
TIMEOUT_SECS=1800               # the harness's own worst case; callers add headroom
PATH_ONLY=0
# Internal, undocumented in the usage banner: `record show --list-required-fields`
# is the schema-drift guard's only consumer (see RECORD_REQUIRED_FIELDS below).
LIST_REQUIRED_FIELDS=0
# Seconds between readiness polls while `chain up` waits. Overridable so the
# offline self-test does not spend minutes sleeping.
POLL_SECS="${CORE_STACK_POLL_SECS:-3}"

# The harness's dapp stack: its compose project (docker-compose.dapp.yaml
# `name:`) and the run-identity label every one of its services carries. Only
# these count as "the harness's containers"; anything else on the host does not.
DAPP_PROJECT="robotmoney-dapp"
TESTNET_LABEL="com.robotmoney.testnet=1"

# Canonical Safe v1.4.1, mirrored from fusion-ceremony.sh (require_safe_set,
# used_chain_evidence). The ceremony refuses a chain without them, and a chain
# whose factory has already created a Safe.
SAFE_L2_SINGLETON="0x29fcB43b46531BcA003ddC8FCB67FFE91900C762"
SAFE_PROXY_FACTORY="0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"
SAFE_FALLBACK_HANDLER="0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99"
PROXY_CREATION_SIG='ProxyCreation(address,address)'

# root's non-login shell on the stage host resolves neither cargo nor cast.
# Prepended here, once, so no caller has to carry a PATH workaround of its own.
export PATH="$HOME/.cargo/bin:$HOME/.foundry/bin:$PATH"

usage() { awk 'NR > 1 { if (!/^#/) exit; print }' "$0" >&2; exit 64; }
info() { echo "==> [core-stack] $*" >&2; }
fail() { echo "FAIL: [core-stack] $1" >&2; exit "${2:-66}"; }
# A read-only verb's "no": one classed line on stdout, exit 1.
unsatisfied() { echo "$1: $2"; exit 1; }
# A flag that takes a value must have one: `--ref` as the last word is a usage
# error, not an unbound-variable crash.
value_of() { [[ $# -ge 2 && -n "$2" ]] || { echo "$1 needs a value" >&2; usage; }; }

NOUN="${1:-}"; [[ $# -gt 0 ]] && shift
VERB="${1:-}"; [[ $# -gt 0 ]] && shift
while (( $# )); do
  case "$1" in
    --ref) value_of "$@"; REF="$2"; shift 2 ;;
    --record) value_of "$@"; RECORD="$2"; shift 2 ;;
    --out-dir) value_of "$@"; OUT_DIR="$2"; shift 2 ;;
    --timeout) value_of "$@"; TIMEOUT_SECS="$2"; shift 2 ;;
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
# Written by `chain up` only after the booted stack checked out; `chain status`
# passes only while it names the candidate and a harness that is still running.
STAMP="$OUT_DIR/core-stack.stamp"
LOCK="$OUT_DIR/.core-stack.lock"
RECORD="${RECORD:-$OUT_DIR/fusion-stage-record.json}"

need() { command -v "$1" >/dev/null 2>&1 || fail "required tool '$1' not on PATH" 3; }

# The candidate commit. No --ref (or HEAD) is this checkout's HEAD, never
# origin/HEAD. Otherwise branch -> tag -> raw commit, the same three-way order
# the devops pin step checks out with, so a branch target (dev) resolves here
# exactly as it did there.
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

# /proc/PID/stat field 22 (start time, in clock ticks since boot) of a live
# process; a zombie counts as gone. The comm field may hold spaces and
# parentheses, so fields are counted after its last ')'.
proc_start_time() {
  local stat
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  stat="${stat##*) }"
  [[ "${stat%% *}" != Z ]] || return 1
  awk '{ print $20 }' <<<"$stat"
}

# Prints the pid of the live harness the pid file names, or returns 1. A pid
# file whose start time no longer matches names a recycled pid, not the harness.
harness_pid() {
  local pid="" start="" rest="" now
  [[ -f "$PID_FILE" ]] || return 1
  read -r pid start rest <"$PID_FILE" || true
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  now="$(proc_start_time "$pid")" || return 1
  if [[ -n "$start" ]]; then
    [[ "$now" == "$start" ]] || return 1
  else
    # A bare pid (written by a launcher that predates the start time): only
    # while that process is still the smoke harness.
    tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -Eq 'deploy-core-stack\.sh smoke|smoke-test' || return 1
  fi
  echo "$pid"
}

# One writer at a time per out dir: two `chain up`s would boot two harnesses on
# the same ports, and a `down` racing an `up` removes the pid file mid-write.
take_lock() {
  need flock
  mkdir -p "$OUT_DIR"
  exec 9>"$LOCK"
  flock -n 9 || fail "another chain up / chain down / dapp up holds $LOCK; wait for it, or stop it first" 66
}

# ─── chain ────────────────────────────────────────────────────────────────────
# The live facts, all required, so "something healthy is running" is never read
# as "the RIGHT candidate is healthy". Returns the classed line rather than
# exiting, so `chain up` can ask the same question without ending the script.
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

# The stamp: which commit the running chain was booted from, and by which
# harness process. Without it, rmpc's build-info would vouch for a chain that a
# later rebuild (a failed `chain up`, `dapp up`) never booted.
#
# boot-mismatch vs. candidate-mismatch (devops#42): these name two different
# facts on purpose and are not merged into one class. boot-mismatch is a
# CHAIN fact: the stamp `chain up` wrote says which commit is actually
# running, and it disagrees with what `--ref` (or HEAD) asks about now — the
# operator's fix is `chain down` + `chain up --ref <the one they want>`.
# candidate-mismatch (chain_facts_line, below) is a BUILD-ARTIFACT fact: the
# stamp and the candidate already agree, but target/debug/rmpc on disk was
# rebuilt for something else since (a failed `chain up`, a bare `dapp up`,
# a stray `cargo build`) without booting a new chain — the fix there is just
# rebuilding rmpc for the candidate, not touching the chain at all. Collapsing
# both into one class would cost the operator exactly the information that
# tells them which of those two unrelated actions to take.
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
  local want head pid start line rc
  want="$(candidate_commit)"
  [[ -n "$want" ]] || fail "--ref '${REF:-HEAD}' is not a branch, tag or commit in this checkout" 65
  head="$(git rev-parse --verify --quiet 'HEAD^{commit}' || true)"
  # The harness boots whatever is checked out; booting it for a ref it is not
  # would spend half an hour on a chain `chain status --ref` can never accept.
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
  # Whatever the stamp vouched for, this boot replaces it; a boot that fails
  # from here on must leave nothing behind that `chain status` would accept.
  rm -f "$STAMP" "$PID_FILE"
  # Truncated here, before the harness exists, and the harness only ever
  # appends: the summary grep below can match only this boot's output, never a
  # summary a previous run left behind.
  : >"$SUMMARY"
  # Detached, in its own process group (set -m), so `chain down` can signal the
  # harness and every child it spawned at once — and so it does not inherit the
  # SIGINT-ignored disposition a non-interactive shell gives background jobs.
  # fd 9 (the lock) is closed for it: the harness must not hold the lock.
  set -m
  nohup stdbuf -oL -eL bash "$DEPLOY" smoke --out-dir "$OUT_DIR" >>"$SUMMARY" 2>&1 </dev/null 9>&- &
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

chain_down() {
  take_lock
  # The stamp goes first: from here on nothing vouches for the running chain,
  # whether or not the teardown below completes.
  rm -f "$STAMP"
  exec bash "$DEPLOY" down --out-dir "$OUT_DIR"
}

# ─── governance ───────────────────────────────────────────────────────────────
# The ceremony's own preconditions on the chain, each enforced inside
# fusion-ceremony.sh by a `die` well into a run. Asserted here, before `ensure`
# spends anything, each with its own class. They describe a FRESH chain, so this
# runs only when provisioning is about to happen, not as a standing check.
governance_preflight() {
  need jq
  # Every check below shells out to cast. Without this, a missing cast makes
  # `"$CAST" chain-id` fail exactly like a dead RPC does (both print nothing
  # on stdout), so the first check below would misreport a tool-missing host
  # as rpc-unreachable: exit 1, not exit 3. Checked explicitly, first.
  need "$CAST"
  grep -q -- '--- end endpoint summary ---' "$SUMMARY" 2>/dev/null \
    || unsatisfied summary-incomplete "$SUMMARY is absent or carries no end-of-summary marker"
  # summary_address (fusion-ceremony.sh): last key=value line wins.
  addr() { awk -F= -v k="$1" '$1 == k { v = $2 } END { print v }' "$SUMMARY"; }
  has_code() { [[ -n "$("$CAST" code "$1" --rpc-url "$RPC_URL" 2>/dev/null | tr -d '[:space:]0x')" ]]; }
  # Its own class, ahead of the code checks: `cast code` against a dead RPC
  # returns empty exactly like a codeless address does.
  local chain
  chain="$("$CAST" chain-id --rpc-url "$RPC_URL" 2>/dev/null)" \
    || unsatisfied rpc-unreachable "nothing answering at $RPC_URL"
  [[ "$chain" == "$CHAIN_ID" ]] || unsatisfied wrong-chain "$RPC_URL is chain '$chain', the ceremony runs only on $CHAIN_ID"
  local name
  for name in "SafeL2 singleton:$SAFE_L2_SINGLETON" "SafeProxyFactory:$SAFE_PROXY_FACTORY" \
              "CompatibilityFallbackHandler:$SAFE_FALLBACK_HANDLER"; do
    has_code "${name#*:}" \
      || unsatisfied safe-set-missing "canonical ${name%%:*} ${name#*:} has no code: this chain lacks the Safe v1.4.1 set"
  done
  local key a n d k q vaults admin_role is_admin
  for key in gateway_addr vault_addr registry_addr router_addr \
             governance_addr ic_policy_addr consensus_receipt_addr admin_addr; do
    a="$(addr "$key")"
    [[ "$a" =~ ^0x[0-9a-fA-F]{40}$ ]] || unsatisfied summary-malformed "$key is not address-shaped ('$a')"
    [[ "$key" == admin_addr ]] && continue
    has_code "$a" || unsatisfied no-code "$key $a has no code on $RPC_URL — the summary is from an older boot"
  done
  vaults="$(awk -F= '$1 == "vault_addresses_json" { sub(/^[^=]*=/, ""); v = $0 } END { print v }' "$SUMMARY")"
  jq -e '.rmUSDC and .rmPROTO and .rmAGENT and .rmRWA' <<<"$vaults" >/dev/null 2>&1 \
    || unsatisfied summary-malformed "vault_addresses_json does not name rmUSDC, rmPROTO, rmAGENT and rmRWA"
  # `call` swallows reverts, so an unreadable receipt store is its own class
  # rather than being blamed on the --no-receipt-fixtures boot flag.
  n="$("$CAST" call "$(addr consensus_receipt_addr)" 'receiptCount()(uint256)' --rpc-url "$RPC_URL" 2>/dev/null | awk '{print $1; exit}' || true)"
  [[ "$n" =~ ^[0-9]+$ ]] || unsatisfied receipt-unreadable "receiptCount() returned '$n' from $(addr consensus_receipt_addr)"
  [[ "$n" == "0" ]] || unsatisfied receipt-fixtures-present "receiptCount()=$n, so this boot lost --no-receipt-fixtures"
  # repo_deployer_key: the ceremony signs as the address DERIVED from the repo
  # constant, and dies if that is not the summary's admin_addr.
  k="$(sed -n '/pub const DEPLOYER_PRIVATE_KEY_HEX/{n;p}' testing/smoke-test/src/lib.rs | tr -d ' ";')"
  d="$("$CAST" wallet address --private-key "$k" 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)"
  [[ -n "$d" && "$d" == "$(addr admin_addr | tr '[:upper:]' '[:lower:]')" ]] \
    || unsatisfied deployer-mismatch "DEPLOYER_PRIVATE_KEY_HEX derives '$d', summary admin_addr is '$(addr admin_addr)'"
  # A deployer without gateway ADMIN_ROLE means the chain was handed over already.
  admin_role="$("$CAST" keccak ADMIN_ROLE 2>/dev/null || true)"
  is_admin="$("$CAST" call "$(addr gateway_addr)" 'hasRole(bytes32,address)(bool)' "$admin_role" "$(addr admin_addr)" --rpc-url "$RPC_URL" 2>/dev/null | awk '{print $1; exit}' || true)"
  [[ "$is_admin" == "true" ]] \
    || unsatisfied deployer-not-admin "the deployer $(addr admin_addr) holds no gateway ADMIN_ROLE (hasRole: '${is_admin:-unreadable}'): this chain was already handed over; reboot it"
  # used_chain_evidence: a factory that already created a Safe here means a
  # ceremony ran on this chain, and `ensure` refuses (65) to provision another.
  n="$("$CAST" logs --rpc-url "$RPC_URL" --from-block 0 --address "$SAFE_PROXY_FACTORY" --json "$PROXY_CREATION_SIG" 2>/dev/null \
    | jq 'length' 2>/dev/null || true)"
  [[ "$n" =~ ^[0-9]+$ ]] || unsatisfied chain-history-unreadable "the SafeProxyFactory's ProxyCreation logs are unreadable, so this chain cannot be shown fresh"
  [[ "$n" == "0" ]] || unsatisfied chain-used "the SafeProxyFactory already created $n Safe(s) on this chain; reboot it (chain down, chain up)"
  # Readability only: the VALUE is ceremony-set.
  q="$("$CAST" call "$(addr governance_addr)" 'quorumThreshold()(uint256)' --rpc-url "$RPC_URL" 2>/dev/null | awk '{print $1; exit}' || true)"
  [[ "$q" =~ ^[0-9]+$ ]] || unsatisfied governance-unreadable "quorumThreshold() returned '$q'"
  echo "ok: the booted chain meets every ceremony precondition"
}

governance_ensure() {
  info "governance_ensure: RPC_URL=$RPC_URL OUT_DIR=$OUT_DIR SUMMARY=$SUMMARY"
  info "governance_ensure: calling: bash $CEREMONY ensure --out-dir $OUT_DIR --summary $SUMMARY --rpc-url $RPC_URL"
  bash "$CEREMONY" ensure --out-dir "$OUT_DIR" --summary "$SUMMARY" --rpc-url "$RPC_URL"
  rc=$?
  info "governance_ensure: ceremony returned $rc"
  return $rc
}

governance_verify() {
  local rc=0 keydir out
  [[ -f "$RECORD" ]] || unsatisfied record-missing "$RECORD does not exist — run \`core-stack.sh governance ensure\`"
  # Captured, not inherited: on success the ceremony's own PASS lines are the
  # caller's evidence and are printed verbatim. On its "no" (rc 1) they move to
  # stderr instead, so stdout still carries exactly the one classed line the
  # one-stdout-line rule promises every failing read-only verb (the survived
  # mutant this closes: two_stdout_lines, PASS/FAIL lines above a classed
  # line).
  out="$(bash "$CEREMONY" verify --record "$RECORD" --rpc-url "$RPC_URL" 2>&1)" || rc=$?
  if (( rc != 1 )); then
    echo "$out"
    exit "$rc"
  fi
  echo "$out" >&2
  # verify's own PASS/FAIL lines are on stderr above; this names the one thing to do.
  keydir="$(jq -r '.ephemeral.keystore_dir // empty' "$RECORD" 2>/dev/null || true)"
  if [[ -z "$keydir" || ! -d "$keydir" ]]; then
    unsatisfied keys-discarded "the ceremony keystores (${keydir:-none named}) are gone, so nobody can drive the Safe; rebuild the stack (chain down, chain up, governance ensure)"
  fi
  unsatisfied governance-unverified "fusion-ceremony.sh verify failed against $RECORD (see FAIL lines on stderr above)"
}

# ─── dapp ─────────────────────────────────────────────────────────────────────
dapp_up() {
  need jq
  local head line
  take_lock
  head="$(git rev-parse --verify --quiet 'HEAD^{commit}' || true)"
  # `up` rebuilds rmpc from this checkout. Onto a chain booted from another
  # commit, that would make rmpc vouch for a candidate the chain is not.
  line="$(stamp_line "$head")" \
    || fail "the running chain is not one \`chain up\` booted from this checkout ($line); run \`core-stack.sh chain up\` first" 65
  exec bash "$DEPLOY" up --out-dir "$OUT_DIR"
}

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
# The cross-repo record contract (devops docs/plans/core-runbook-verbs.md, "The
# record"), field by field. A record that breaks it is refused rather than
# printed, so a reader never builds on a partial topology. Exit 65, with one
# classed line on stdout.
record_bad() { echo "$1: $2"; exit 65; }

# RV: the field's value as text ("" when absent or null; objects and arrays as
# JSON). A global, not a command substitution, so record_bad's exit is the
# script's and not a subshell's.
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

# The record contract's exhaustive required-field set (devops
# docs/plans/core-runbook-verbs.md, "The record"), used two ways: record_show
# checks every one of these for presence below, before any shape check runs,
# and `record show --list-required-fields` prints this same array as JSON so
# schemas/fusion-stage-record.schema.json's `required` array can be diffed
# against it. That is the whole drift guard (devops#42): the schema and this
# array are read from the one place each, and the selftest fails the moment
# they stop matching, rather than the two silently drifting apart.
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

record_show() {
  need jq
  (( LIST_REQUIRED_FIELDS )) && { record_list_required_fields; return 0; }
  [[ -f "$RECORD" ]] || record_bad record-missing "$RECORD does not exist"
  jq -e 'type == "object"' "$RECORD" >/dev/null 2>&1 || record_bad record-unparseable "$RECORD is not a JSON object"
  # Every required field, present, before any shape check runs — see
  # RECORD_REQUIRED_FIELDS above. record_get already dies with
  # record-field-missing on the first absent one.
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
  # The real 2-of-3 Safe (#1474): the three owner keys, each an address, with
  # the approver (the relayer every Safe call is sent from) among them.
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
