#!/usr/bin/env bash
# Offline self-test for scripts/stage/core-stack.sh (C-21: a gate is not
# evidence until it has been shown to fail). Every verb runs against a scratch
# git checkout whose fusion-ceremony.sh and rmpc are stubs, whose
# deploy-core-stack.sh is a stub for `smoke`/`up` and the REAL script for
# `down`, and whose curl / docker / cast are fakes answering from files under
# $FAKE. Each read-only verb must pass on the baseline and must fail with its
# named class when exactly one fact is broken; each mutating verb must call the
# wrapped script with the arguments the contract promises, and nothing else.
# Harness processes are real (sleeping) processes, so process groups, start
# times and signals are exercised for real. Touches no network, no docker
# daemon and no chain. Linux only (/proc).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../core-stack.sh"
REAL_DEPLOY="$HERE/../deploy-core-stack.sh"
for tool in jq flock git; do
  command -v "$tool" >/dev/null || { echo "selftest needs $tool" >&2; exit 2; }
done
[[ -d /proc/self ]] || { echo "selftest needs /proc" >&2; exit 2; }
WORK="$(mktemp -d)"
# Every process this test starts (fake harnesses, lock holders, bystanders)
# is listed here, and each is killed with its whole process group at exit.
SPAWNED="$WORK/spawned"
reap() {
  local p
  if [[ -f "$WORK/out/core-smoke.pid" ]]; then
    read -r p _ <"$WORK/out/core-smoke.pid" || true
    [[ "$p" =~ ^[0-9]+$ ]] && echo "$p" >>"$SPAWNED"
  fi
  [[ -f "$SPAWNED" ]] || return 0
  while read -r p; do
    [[ "$p" =~ ^[0-9]+$ ]] || continue
    kill -KILL -- "-$p" 2>/dev/null || true
    kill -KILL "$p" 2>/dev/null || true
  done <"$SPAWNED"
  : >"$SPAWNED"
}
trap 'reap; rm -rf "$WORK"' EXIT

# The expected executed-assertion floor: a truncated file that stops early must
# not print a green summary. Raise it with every assertion added. CI holds its
# own copy (suite-01-02-forge-tests.yml core-stack-selftest).
MIN_EXPECTED_ASSERTIONS=296

REPO="$WORK/repo"; FAKE="$WORK/fake"; BIN="$WORK/bin"; OUT="$WORK/out"
mkdir -p "$REPO/scripts/stage" "$REPO/target/debug" "$REPO/testing/smoke-test/src" "$FAKE" "$BIN" "$OUT" "$WORK/home"
cp "$SCRIPT" "$REPO/scripts/stage/core-stack.sh"
cp "$REAL_DEPLOY" "$REPO/scripts/stage/deploy-core-stack.real.sh"

a() { printf '0x%040x' "$1"; }
DEPLOYER=$(a 10)

# ─── stubs for the wrapped scripts: record argv, behave as $FAKE says ────────
# The stub harness is `bash <stub> smoke`, which then execs a sleep named
# smoke-test: same pid, same start time, same process group, like the real
# harness's exec into cargo. It lists itself in $SPAWNED so it is always reaped.
cat >"$REPO/scripts/stage/deploy-core-stack.sh" <<'STUB'
#!/usr/bin/env bash
echo "deploy $*" >>"$FAKE/calls"
case "$1" in
  smoke)
    echo "$$" >>"$SPAWNED"
    # rebuild_rmpc runs first, whatever the boot then does.
    git -C "$(dirname "$0")/../.." rev-parse HEAD >"$FAKE/rmpc_commit"
    awk '{ sub(/.*\) /, ""); print $3 }' "/proc/$$/stat" >"$FAKE/harness_pgrp"
    case "$(cat "$FAKE/smoke_mode" 2>/dev/null || echo ok)" in
      ok)
        # The stack is up by the time the summary prints, as with the harness.
        echo 0xe03b5 >"$FAKE/chain"; echo dapp-postgres >"$FAKE/healthy"
        cat "$FAKE/summary"
        exec -a smoke-test sleep 300 ;;
      wrongchain)
        echo 0x1 >"$FAKE/chain"; echo dapp-postgres >"$FAKE/healthy"
        cat "$FAKE/summary"
        exec -a smoke-test sleep 300 ;;
      die) echo "harness exploded"; exit 1 ;;
      die-late) sleep 3; echo "harness exploded late"; exit 1 ;;
      hang) exec -a smoke-test sleep 300 ;;
      # Ignores SIGINT, and has a child in its process group, as cargo has.
      stubborn) trap '' INT; sleep 300 & echo $! >"$FAKE/harness_child"; exec -a smoke-test sleep 300 ;;
    esac ;;
  # The real teardown, so its pid-file, process-group and record handling run.
  down) exec bash "$(dirname "$0")/deploy-core-stack.real.sh" "$@" ;;
esac
exit "$(cat "$FAKE/deploy_rc" 2>/dev/null || echo 0)"
STUB
cat >"$REPO/scripts/stage/fusion-ceremony.sh" <<'STUB'
#!/usr/bin/env bash
echo "ceremony $*" >>"$FAKE/calls"
[[ "$1" == verify ]] && echo "PASS  chain id is the record's (918453)"
exit "$(cat "$FAKE/ceremony_rc" 2>/dev/null || echo 0)"
STUB
cat >"$REPO/target/debug/rmpc" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  build-info) printf '{"commit":"%s"}\n' "$(cat "$FAKE/rmpc_commit")" ;;
  self-check)
    [[ "${2:-}" == "--help" ]] && { [[ -f "$FAKE/no_selfcheck" ]] && exit 2; exit 0; }
    exit "$(cat "$FAKE/selfcheck_rc" 2>/dev/null || echo 3)" ;;
  *) exit 2 ;;
esac
STUB
cat >"$REPO/target/debug/rmpc-keystore-import" <<'STUB'
#!/usr/bin/env bash
exit "$(cat "$FAKE/import_rc" 2>/dev/null || echo 2)"
STUB
cat >"$REPO/testing/smoke-test/src/lib.rs" <<'RS'
pub const DEPLOYER_PRIVATE_KEY_HEX: &str =
    "0x00000000000000000000000000000000000000000000000000000000000000aa";
RS

# ─── fakes for curl / docker / cast ──────────────────────────────────────────
cat >"$BIN/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
url=""; for x in "$@"; do [[ "$x" == http* ]] && url="$x"; done
case "$url" in
  *:18545*) [[ -f "$FAKE/chain" ]] || exit 7; printf '{"jsonrpc":"2.0","id":1,"result":"%s"}\n' "$(cat "$FAKE/chain")" ;;
  *:18546/health) [[ -f "$FAKE/explorer" ]] || exit 7; echo ok ;;
  *:5173/) [[ -f "$FAKE/dapp" ]] || exit 7; echo '<html>' ;;
  *) exit 7 ;;
esac
FAKE_CURL
# `docker ps` lists $FAKE/healthy only to a query filtered to the harness's
# compose project and health; an unfiltered query also sees $FAKE/foreign (other
# projects' containers) and $FAKE/unhealthy. Compose calls are logged.
cat >"$BIN/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
case "$1" in
  ps)
    cat "$FAKE/healthy" 2>/dev/null || true
    [[ "$*" == *"label=com.docker.compose.project=robotmoney-dapp"* ]] || cat "$FAKE/foreign" 2>/dev/null || true
    [[ "$*" == *"health=healthy"* ]] || cat "$FAKE/unhealthy" 2>/dev/null || true
    exit 0 ;;
  compose) echo "docker $*" >>"$FAKE/calls"; exit "$(cat "$FAKE/compose_rc" 2>/dev/null || echo 0)" ;;
esac
exit 0
FAKE_DOCKER
cat >"$BIN/cast" <<'FAKE_CAST'
#!/usr/bin/env bash
case "$1" in
  chain-id) [[ -f "$FAKE/chain" ]] || exit 1; cat "$FAKE/chain_dec" 2>/dev/null || echo 918453 ;;
  code) grep -qixF -- "$2" "$FAKE/nocode" 2>/dev/null && echo 0x || echo 0x6080604052 ;;
  call)
    case "$3" in
      'receiptCount()(uint256)') cat "$FAKE/receipts" 2>/dev/null || echo 0 ;;
      'quorumThreshold()(uint256)') cat "$FAKE/quorum" 2>/dev/null || echo "1 [1e0]" ;;
      'hasRole(bytes32,address)(bool)') cat "$FAKE/is_admin" 2>/dev/null || echo true ;;
      *) exit 1 ;;
    esac ;;
  wallet) cat "$FAKE/derived" ;;
  keccak) echo 0xdf8b4c520ffe197c5343c6f5aec59570151ef9a492f2c624fd45ddde6135ec42 ;;
  logs) [[ -f "$FAKE/logs_broken" ]] && exit 1; cat "$FAKE/proxy_logs" 2>/dev/null || echo '[]' ;;
  *) exit 1 ;;
esac
FAKE_CAST
chmod +x "$BIN"/* "$REPO/scripts/stage/"*.sh "$REPO/target/debug/"*

git -C "$REPO" init -q
git -C "$REPO" -c user.email=t@t -c user.name=t add -A
git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm base
git -C "$REPO" tag v9.9.9-rc.1
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
# A second commit that is NOT checked out: origin's default branch, and a tag.
OTHER_SHA="$(git -C "$REPO" -c user.email=t@t -c user.name=t commit-tree -p HEAD -m other "HEAD^{tree}")"
git -C "$REPO" update-ref refs/remotes/origin/main "$OTHER_SHA"
git -C "$REPO" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
git -C "$REPO" update-ref refs/remotes/origin/dev "$HEAD_SHA"
git -C "$REPO" tag v-other "$OTHER_SHA"
# Moves the scratch checkout to a new commit (a new candidate), or back.
advance_head() { git -C "$REPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m next; git -C "$REPO" rev-parse HEAD; }
restore_head() { git -C "$REPO" reset -q --hard "$HEAD_SHA"; }

proc_start() { local s; s="$(cat "/proc/$1/stat")"; s="${s##*) }"; awk '{ print $20 }' <<<"$s"; }
proc_pgrp() { local s; s="$(cat "/proc/$1/stat")"; s="${s##*) }"; awk '{ print $3 }' <<<"$s"; }
alive() { local s; s="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1; s="${s##*) }"; [[ "${s%% *}" != Z ]]; }

# spawn <argv0> [secs]: a detached sleeping process in its own process group,
# named argv0; prints its pid.
# Started from a subshell that exits at once, so it is orphaned to init, which
# reaps it: a process this test kills never lingers as a zombie that
# `kill -0` still answers for.
spawn() {
  local p
  p="$( (set -m; bash -c "exec -a '$1' sleep ${2:-300}" </dev/null >/dev/null 2>&1 & echo $!) )"
  echo "$p" >>"$SPAWNED"
  echo "$p"
}

# A running harness booted from HEAD by a completed `chain up`: its pid file
# and its stamp, both naming a live process.
boot_fake_harness() {
  local p s
  p="$(spawn smoke-test)"; s="$(proc_start "$p")"
  echo "$p $s" >"$OUT/core-smoke.pid"
  jq -n --arg c "$HEAD_SHA" --argjson p "$p" --arg s "$s" \
    '{commit: $c, pid: $p, start_time: $s, booted_at: "2026-09-24T00:00:00Z"}' >"$OUT/core-stack.stamp"
  echo "$p" >"$FAKE/fake_harness"
}

write_summary() {
  {
    echo "--- endpoint summary ---"
    echo "chain_id=918453"
    local i=1 key
    for key in gateway_addr vault_addr registry_addr router_addr governance_addr ic_policy_addr consensus_receipt_addr; do
      echo "$key=$(a "$i")"; i=$((i + 1))
    done
    echo "admin_addr=$DEPLOYER"
    printf 'vault_addresses_json={"rmUSDC":"%s","rmPROTO":"%s","rmAGENT":"%s","rmRWA":"%s"}\n' "$(a 21)" "$(a 22)" "$(a 23)" "$(a 24)"
    echo "--- end endpoint summary ---"
  } >"$1"
}

write_record() {
  jq -n --arg d "$DEPLOYER" --arg sha "$HEAD_SHA" --arg keydir "$OUT/keys/20260924T000000Z" \
    --arg g "$(a 1)" --arg v "$(a 2)" --arg r "$(a 3)" --arg ro "$(a 4)" --arg gov "$(a 5)" \
    --arg ic "$(a 6)" --arg cr "$(a 7)" --arg tl "$(a 8)" --arg safe "$(a 9)" --arg em "$(a 11)" \
    --arg sub "$(a 12)" --arg ap "$(a 13)" --arg apb "$(a 14)" --arg apc "$(a 15)" \
    --arg va "$(a 16)" --arg vb "$(a 17)" --arg eeph "$(a 18)" \
    --arg u "$(a 21)" --arg p "$(a 22)" --arg ag "$(a 23)" --arg rwa "$(a 24)" '{
    chain_id: 918453, run_id: "20260924T000000Z", core_tag: "v9.9.9-rc.1", core_sha: $sha,
    generated_by: "scripts/stage/fusion-ceremony.sh",
    generated_at: "2026-09-24T00:00:00Z", min_delay: 120, deployer: $d,
    addresses: {gateway: $g, vault: $v, registry: $r, router: $ro, governance: $gov, ic_policy: $ic,
                consensus_receipt: $cr, timelock: $tl, safe: $safe, emergency: $em},
    code_hashes: {gateway: "0x\("ab" * 32)", timelock: "0x\("cd" * 32)"},
    vault_addresses: {rmUSDC: $u, rmPROTO: $p, rmAGENT: $ag, rmRWA: $rwa},
    ephemeral: {submitter: $sub, approver: $ap, voters: [$va, $vb], emergency: $eeph, keystore_dir: $keydir,
                safe_signers: [{role: "approver", address: $ap}, {role: "approver-b", address: $apb},
                               {role: "approver-c", address: $apc}]}}' >"$OUT/fusion-stage-record.json"
}

# Baseline: a healthy chain booted from the candidate by a completed chain up,
# every ceremony precondition met, the dapp stack answering, a complete record
# and its keystores on disk.
baseline() {
  reap
  restore_head
  rm -rf "$FAKE" "$OUT"; mkdir -p "$FAKE" "$OUT/keys/20260924T000000Z"
  echo 0xe03b5 >"$FAKE/chain"
  echo dapp-postgres >"$FAKE/healthy"
  echo "$HEAD_SHA" >"$FAKE/rmpc_commit"
  echo "$DEPLOYER" >"$FAKE/derived"
  : >"$FAKE/explorer"; : >"$FAKE/dapp"
  write_summary "$FAKE/summary"
  cp "$FAKE/summary" "$OUT/core-smoke.log"
  write_record
  boot_fake_harness
}
# The same, with nothing running: no harness, no stamp, no chain.
cold() { baseline; reap; rm -f "$OUT/core-stack.stamp" "$OUT/core-smoke.pid" "$FAKE/chain" "$FAKE/healthy"; }
edit_record() { jq "$1" "$OUT/fusion-stage-record.json" >"$WORK/r" && mv "$WORK/r" "$OUT/fusion-stage-record.json"; }
# Holds the out dir's lock until killed.
hold_lock() {
  local p
  p="$( (set -m; bash -c 'exec 8>"$1"; flock 8; exec sleep 60' _ "$OUT/.core-stack.lock" </dev/null >/dev/null 2>&1 & echo $!) )"
  echo "$p" >>"$SPAWNED"
  for _ in $(seq 1 50); do flock -n "$OUT/.core-stack.lock" true 2>/dev/null || break; sleep 0.1; done
}

run() {
  set +e
  env HOME="$WORK/home" PATH="$BIN:$PATH" FAKE="$FAKE" SPAWNED="$SPAWNED" CAST="$BIN/cast" \
    CORE_STACK_POLL_SECS=1 SMOKE_INT_GRACE_SECS=4 SMOKE_TERM_GRACE_SECS=4 \
    "$REPO/scripts/stage/core-stack.sh" "$@" --out-dir "$OUT" >"$WORK/stdout" 2>"$WORK/stderr" </dev/null
  RC=$?
  set -e
}
run_bare() {  # no --out-dir, for the usage paths
  set +e
  env HOME="$WORK/home" PATH="$BIN:$PATH" FAKE="$FAKE" SPAWNED="$SPAWNED" CAST="$BIN/cast" \
    "$REPO/scripts/stage/core-stack.sh" "$@" >"$WORK/stdout" 2>"$WORK/stderr" </dev/null
  RC=$?
  set -e
}

# ─── exit-3 (missing tool): a PATH with the tool genuinely absent ────────────
# Real system utilities core-stack.sh and this rig need, resolved once from
# the real $PATH — jq, git, flock and friends are ordinary base-image tools
# that would otherwise still answer from some system directory even with $BIN
# stripped out, so "absent" has to mean a PATH that carries none of them, not
# just a PATH without our fakes.
SYS_TOOLS=(bash cat mkdir rm mv cp chmod git jq flock tail grep sed awk date \
           sleep kill tr wc seq dirname basename mktemp env stdbuf nohup \
           true false sh readlink pwd printf)
# without_tool NAME: a directory of symlinks covering every real tool this
# script and the harness need (curl/docker/cast from $BIN, everything else
# from the real PATH), minus NAME — so `command -v NAME` genuinely fails
# rather than being shadowed by a fake or found later in some inherited PATH.
without_tool() {
  local omit="$1"
  local dir="$WORK/minpath-$omit" t p
  rm -rf "$dir"; mkdir -p "$dir"
  for t in "${SYS_TOOLS[@]}" curl docker cast; do
    [[ "$t" == "$omit" ]] && continue
    case "$t" in
      curl) p="$BIN/curl" ;;
      docker) p="$BIN/docker" ;;
      cast) p="$BIN/cast" ;;
      *) p="$(command -v "$t" 2>/dev/null)" || continue ;;
    esac
    ln -sf "$p" "$dir/$t"
  done
  echo "$dir"
}
run_without() {  # run_without TOOL NOUN VERB [ARGS...]
  local omit="$1" mp; shift
  mp="$(without_tool "$omit")"
  set +e
  env HOME="$WORK/home" PATH="$mp" FAKE="$FAKE" SPAWNED="$SPAWNED" \
    CORE_STACK_POLL_SECS=1 \
    "$REPO/scripts/stage/core-stack.sh" "$@" --out-dir "$OUT" >"$WORK/stdout" 2>"$WORK/stderr" </dev/null
  RC=$?
  set -e
}

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "ok   $1"; }
flunk() { FAILED=$((FAILED + 1)); echo "FAIL $1"; sed 's/^/     | /' "$WORK/stdout" "$WORK/stderr" | tail -6; }
check() { local name="$1"; shift; if "$@"; then pass "$name"; else flunk "$name"; fi; }
expect_rc() { local want="$1" name="$2"; if [[ "$RC" == "$want" ]]; then pass "$name"; else flunk "$name: exit $RC, want $want"; fi; }
# A read-only verb's "no" is exit 1 (or the given code) AND the named class on
# stdout. The one-stdout-line rule (devops#42, survived mutant
# two_stdout_lines) is checked here too, once, for every call site, rather
# than as a one-off assertion bolted onto a handful of cases: a failing
# read-only verb's stdout is EXACTLY the classed line, so a caller can read it
# without stripping anything a wrapped script printed ahead of it.
expect_class() {
  local class="$1" name="$2" want="${3:-1}"
  if [[ "$RC" == "$want" ]] && grep -q "^$class: " "$WORK/stdout"; then pass "$name is refused as $class"
  else flunk "$name: exit $RC (want $want), stdout lacks '$class:'"; fi
  check "$name prints exactly one stdout line" test "$(wc -l < "$WORK/stdout")" -eq 1
}
calls() { cat "$FAKE/calls" 2>/dev/null || true; }
no_smoke() { ! grep -q '^deploy smoke' "$FAKE/calls" 2>/dev/null; }
stderr_has() { grep -q -- "$1" "$WORK/stderr"; }
lock_free() { flock -n "$OUT/.core-stack.lock" true; }

echo "--- usage ---"
baseline; run_bare; expect_rc 64 "no verb is a usage error"
baseline; run_bare chain sideways; expect_rc 64 "an unknown verb is a usage error"
baseline; run_bare chain up --timeout 0; expect_rc 64 "a zero --timeout is a usage error"
for flag in --ref --record --out-dir --timeout; do
  baseline; run_bare chain status "$flag"; expect_rc 64 "$flag with no value is a usage error"
  check "$flag with no value names the flag instead of crashing" stderr_has "$flag needs a value"
done
# devops#42, survived mutants unknown_flag_ignored / timeout_abc_ok.
baseline; run_bare --bogus; expect_rc 64 "an unrecognized top-level argument is a usage error"
baseline; run_bare chain status --bogus; expect_rc 64 "an unknown flag on a known noun/verb is a usage error"
check "and names the flag instead of silently continuing" stderr_has "unknown argument: --bogus"
baseline; run_bare chain up --timeout abc; expect_rc 64 "a non-numeric --timeout is a usage error"
baseline; run_bare bogus-noun; expect_rc 64 "an unknown noun is a usage error"

echo "--- exit 3: required tool missing ---"
# devops#42, survived mutants status_no_need_docker / up_no_need_docker /
# dapp_status_no_need_curl / need_exits_1. `need` is exit 3, never masqueraded
# as a read-only verb's exit-1 "no" — no stdout classed line is expected here.
baseline; run_without docker chain status; expect_rc 3 "chain status with docker absent"
check "and names docker on stderr" stderr_has "required tool 'docker' not on PATH"
baseline; run_without docker chain up --timeout 5; expect_rc 3 "chain up with docker absent"
check "and names docker on stderr" stderr_has "required tool 'docker' not on PATH"
check "before booting anything" no_smoke
baseline; run_without curl dapp status; expect_rc 3 "dapp status with curl absent"
check "and names curl on stderr" stderr_has "required tool 'curl' not on PATH"
baseline; run_without jq record show; expect_rc 3 "record show with jq absent"
check "and names jq on stderr" stderr_has "required tool 'jq' not on PATH"
# The bug this closes (devops#42 item 5): governance preflight shells out to
# cast for every check it runs. Without an explicit `need "$CAST"` first, a
# missing cast made the first check (`cast chain-id`) fail exactly like a dead
# RPC — rpc-unreachable, exit 1 — misreporting a tool-missing host as a dead
# chain instead of exit 3.
baseline; run_without cast governance preflight; expect_rc 3 "governance preflight with cast absent"
check "and names cast on stderr, not rpc-unreachable on stdout" stderr_has "required tool 'cast' not on PATH"
check "and never misreports it as rpc-unreachable" bash -c "! grep -q '^rpc-unreachable:' '$WORK/stdout'"

echo "--- chain status ---"
baseline; run chain status; expect_rc 0 "the healthy candidate passes"
check "a pass prints one ok: line" grep -q "^ok: " "$WORK/stdout"
baseline; run chain status --ref v9.9.9-rc.1; expect_rc 0 "--ref resolves a tag to the same commit"
baseline; run chain status --ref dev; expect_rc 0 "--ref resolves a branch through origin/"
baseline; run chain status --ref HEAD; expect_rc 0 "--ref HEAD is this checkout's HEAD, not origin/HEAD"
baseline; run chain status --ref v-other; expect_class boot-mismatch "a --ref naming a commit the chain was not booted from"
baseline; rm "$FAKE/chain"; run chain status; expect_class rpc-unreachable "a dead rpc"
baseline; echo 0x1 >"$FAKE/chain"; run chain status; expect_class wrong-chain "a chain that is not 918453"
baseline; rm "$FAKE/healthy"; run chain status; expect_class no-healthy-container "no healthy container"
baseline; rm "$FAKE/healthy"; echo other-app-db >"$FAKE/foreign"; run chain status
expect_class no-healthy-container "a healthy container from another compose project only"
baseline; rm "$FAKE/healthy"; echo dapp-postgres >"$FAKE/unhealthy"; run chain status
expect_class no-healthy-container "an unhealthy harness container only"
baseline; echo deadbeef >"$FAKE/rmpc_commit"; run chain status; expect_class candidate-mismatch "an rmpc built from another commit"
baseline; rm "$REPO/target/debug/rmpc"; run chain status; expect_class rmpc-missing "no rmpc binary"
git -C "$REPO" checkout -q -- target/debug/rmpc
baseline; run chain status --ref no-such-ref; expect_class ref-unresolved "a --ref this checkout cannot resolve"
baseline; rm "$OUT/core-stack.stamp"; run chain status; expect_class not-booted "a healthy chain no chain up completed for"
baseline; echo '{"commit":' >"$OUT/core-stack.stamp"; run chain status; expect_class boot-mismatch "an unreadable stamp"
baseline; kill -KILL -- "-$(cat "$FAKE/fake_harness")"; run chain status; expect_class harness-gone "a stamp whose harness has exited"
baseline; jq '.start_time = "1"' "$OUT/core-stack.stamp" >"$WORK/s" && mv "$WORK/s" "$OUT/core-stack.stamp"
run chain status; expect_class harness-gone "a stamp whose pid now belongs to another process"
# A harness that has exited but whose parent has not reaped it is a zombie:
# /proc still lists it, with its start time, and kill -0 still succeeds.
baseline; zparent="$( (bash -c 'sleep 0 & echo $! >"$1"; exec -a smoke-test sleep 300' _ "$WORK/zpid" </dev/null >/dev/null 2>&1 & echo $!) )"
echo "$zparent" >>"$SPAWNED"
for _ in $(seq 1 50); do [[ -s "$WORK/zpid" ]] && grep -q ') Z ' "/proc/$(cat "$WORK/zpid")/stat" 2>/dev/null && break; sleep 0.1; done
zpid="$(cat "$WORK/zpid")"
jq -n --arg c "$HEAD_SHA" --argjson p "$zpid" --arg s "$(proc_start "$zpid")" '{commit: $c, pid: $p, start_time: $s}' >"$OUT/core-stack.stamp"
run chain status; expect_class harness-gone "a stamp whose harness is a zombie"
# The failure the stamp exists for: the checkout moves to a new candidate,
# chain up rebuilds rmpc from it (rebuild_rmpc runs first) and then fails. The
# old chain is still up and answering, rmpc says the new commit — and it must
# still not pass as the new candidate.
baseline; kill -KILL -- "-$(cat "$FAKE/fake_harness")"; rm -f "$OUT/core-smoke.pid"
new_sha="$(advance_head)"; echo die >"$FAKE/smoke_mode"
run chain up --timeout 20; expect_rc 66 "chain up for a new candidate whose harness dies fails"
check "after rebuilding rmpc for the new candidate" test "$(cat "$FAKE/rmpc_commit")" == "$new_sha"
run chain status; expect_class not-booted "and the old chain does not pass as the new candidate"
# `dapp up` rebuilds rmpc without booting a chain: same shape, no chain up at all.
baseline; new_sha="$(advance_head)"; echo "$new_sha" >"$FAKE/rmpc_commit"
run chain status; expect_class boot-mismatch "an rmpc rebuilt for a new checkout over the old chain"

echo "--- chain up ---"
baseline; run chain up; expect_rc 0 "chain up on an already-healthy candidate succeeds"
check "and starts nothing" test -z "$(calls)"

cold; rm "$OUT/core-smoke.log"; echo ok >"$FAKE/smoke_mode"
run chain up --timeout 30; expect_rc 0 "chain up boots the harness and waits for its summary"
check "it launched deploy-core-stack.sh smoke" grep -q "^deploy smoke --out-dir $OUT$" "$FAKE/calls"
read -r hp hs _ <"$OUT/core-smoke.pid" || true
check "it recorded the harness pid with its start time" test "$hs" == "$(proc_start "$hp" 2>/dev/null)"
check "the harness leads its own process group" test "$(cat "$FAKE/harness_pgrp")" == "$hp"
check "the summary landed in the log it polls" grep -q -- '--- end endpoint summary ---' "$OUT/core-smoke.log"
check "it wrote a stamp naming the candidate and the harness" \
  test "$(jq -r '"\(.commit) \(.pid) \(.start_time)"' "$OUT/core-stack.stamp")" == "$HEAD_SHA $hp $hs"
check "the detached harness does not hold the out dir lock" lock_free
check "it printed the status ok: line" grep -q "^ok: " "$WORK/stdout"
run chain status; expect_rc 0 "chain status accepts the chain it booted"

cold; echo wrongchain >"$FAKE/smoke_mode"
run chain up --timeout 30; expect_rc 66 "a summary over a stack that is not the candidate fails chain up"
check "and writes no stamp" test ! -e "$OUT/core-stack.stamp"
run chain status; expect_class not-booted "and chain status does not pass afterwards" 1

cold; echo die >"$FAKE/smoke_mode"
run chain up --timeout 30; expect_rc 66 "a harness that dies before its summary fails the verb"
check "and its log tail is shown" stderr_has "harness exploded"
check "and the pid file is cleared" test ! -e "$OUT/core-smoke.pid"

# The previous boot's complete summary is still in the log, and every live fact
# holds; this boot's harness dies without printing one. Only a log truncated
# before launch keeps the stale summary from passing as this boot's.
baseline; reap; rm -f "$OUT/core-stack.stamp" "$OUT/core-smoke.pid"; echo die-late >"$FAKE/smoke_mode"
run chain up --timeout 30; expect_rc 66 "a stale summary from an earlier boot is not this boot's"
check "and the log holds only this boot's output" bash -c "! grep -q -- '--- end endpoint summary ---' '$OUT/core-smoke.log'"

cold; echo hang >"$FAKE/smoke_mode"
run chain up --timeout 3; expect_rc 66 "a harness that never prints its summary times out"
check "and its pid file is kept for chain down" test -s "$OUT/core-smoke.pid"
run chain up --timeout 3; expect_rc 66 "chain up refuses while an unhealthy harness is still alive"
check "and says to run chain down" stderr_has "chain down"

cold; bystander="$(spawn smoke-test)"; echo "$bystander 1" >"$OUT/core-smoke.pid"; echo ok >"$FAKE/smoke_mode"
run chain up --timeout 30; expect_rc 0 "chain up is not blocked by a pid file whose pid was recycled"
check "and leaves the process that now has that pid alone" alive "$bystander"

cold; run chain up --ref v-other --timeout 5; expect_rc 65 "chain up for a --ref the checkout is not at is refused"
check "before booting anything" no_smoke
cold; run chain up --ref no-such-ref --timeout 5; expect_rc 65 "chain up for an unresolvable --ref is refused"

cold; hold_lock; run chain up --timeout 5; expect_rc 66 "chain up refuses while another holds the out dir lock"
check "and boots nothing" no_smoke

echo "--- chain down ---"
baseline; hp="$(cat "$FAKE/fake_harness")"; run chain down; expect_rc 0 "chain down succeeds"
check "it calls deploy-core-stack.sh down" grep -q "^deploy down --out-dir $OUT$" "$FAKE/calls"
check "which tears the dapp compose project down" grep -q "^docker compose --project-name robotmoney-dapp .* down$" "$FAKE/calls"
check "the harness is stopped" bash -c "! kill -0 $hp 2>/dev/null || grep -q ' Z ' /proc/$hp/stat"
check "the pid file is cleared" test ! -e "$OUT/core-smoke.pid"
check "the stamp is cleared" test ! -e "$OUT/core-stack.stamp"
run chain down; expect_rc 0 "chain down on a stack already down is a no-op"

cold; echo hang >"$FAKE/smoke_mode"; run chain up --timeout 2
read -r hp _ <"$OUT/core-smoke.pid" || true
run chain down; expect_rc 0 "chain down stops a harness that is still starting"
check "with SIGINT alone" bash -c "! grep -q 'ignored SIGINT' '$WORK/stdout' '$WORK/stderr'"
check "and it is gone" bash -c "! kill -0 $hp 2>/dev/null"

cold; echo stubborn >"$FAKE/smoke_mode"; run chain up --timeout 2
read -r hp _ <"$OUT/core-smoke.pid" || true
run chain down; expect_rc 0 "chain down stops a harness that ignores SIGINT"
check "by escalating to SIGTERM" grep -q 'sending SIGTERM' "$WORK/stdout"
check "and it is gone" bash -c "! kill -0 $hp 2>/dev/null"
check "with the child in its process group" bash -c "! kill -0 $(cat "$FAKE/harness_child") 2>/dev/null"

cold; bystander="$(spawn smoke-test)"; echo "$bystander 1" >"$OUT/core-smoke.pid"
run chain down; expect_rc 0 "chain down with a pid file whose pid was recycled succeeds"
check "without signalling the process that now has that pid" alive "$bystander"
check "and clears the stale pid file" test ! -e "$OUT/core-smoke.pid"

cold; bystander="$(spawn sleep)"; echo "$bystander" >"$OUT/core-smoke.pid"
run chain down; expect_rc 0 "chain down with a bare pid naming some other program succeeds"
check "without signalling it" alive "$bystander"

cold; legacy="$(spawn smoke-test)"; echo "$legacy" >"$OUT/core-smoke.pid"
run chain down; expect_rc 0 "chain down with a bare pid naming the harness succeeds"
check "and stops it" bash -c "! kill -0 $legacy 2>/dev/null"

baseline; echo '{"chain_id":' >"$OUT/fusion-stage-record.json"; run chain down
expect_rc 0 "a corrupt record does not block chain down"
check "and the dapp stack is still torn down" grep -q "^docker compose .* down$" "$FAKE/calls"
baseline; rm "$OUT/fusion-stage-record.json"; run chain down; expect_rc 0 "a missing record does not block chain down"
baseline; echo 1 >"$FAKE/compose_rc"; run chain down; expect_rc 66 "a failing dapp teardown fails chain down"
baseline; hold_lock; run chain down; expect_rc 66 "chain down refuses while another holds the out dir lock"
check "and signals nothing" alive "$(cat "$FAKE/fake_harness")"

echo "--- governance preflight ---"
baseline; run governance preflight; expect_rc 0 "a chain meeting every ceremony precondition passes"
baseline; head -3 "$FAKE/summary" >"$OUT/core-smoke.log"; run governance preflight; expect_class summary-incomplete "a summary with no end marker"
baseline; rm "$FAKE/chain"; run governance preflight; expect_class rpc-unreachable "a dead rpc"
baseline; echo 1 >"$FAKE/chain_dec"; run governance preflight; expect_class wrong-chain "a chain that is not 918453"
for safe_addr in 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99; do
  baseline; echo "$safe_addr" >"$FAKE/nocode"; run governance preflight; expect_class safe-set-missing "a chain without Safe contract $safe_addr"
done
baseline; sed -i 's/^router_addr=.*/router_addr=0xnope/' "$OUT/core-smoke.log"; run governance preflight; expect_class summary-malformed "a malformed summary address"
baseline; sed -i 's/,"rmRWA":"[^"]*"//' "$OUT/core-smoke.log"; run governance preflight; expect_class summary-malformed "a summary vault map missing a bucket"
baseline; a 4 >"$FAKE/nocode"; run governance preflight; expect_class no-code "a summary contract with no code"
baseline; echo "garbage" >"$FAKE/receipts"; run governance preflight; expect_class receipt-unreadable "an unreadable receipt store"
baseline; echo 3 >"$FAKE/receipts"; run governance preflight; expect_class receipt-fixtures-present "a receipt store holding fixtures"
baseline; a 99 >"$FAKE/derived"; run governance preflight; expect_class deployer-mismatch "a deployer key that is not the summary admin"
baseline; echo false >"$FAKE/is_admin"; run governance preflight; expect_class deployer-not-admin "a chain already handed over"
baseline; : >"$FAKE/logs_broken"; run governance preflight; expect_class chain-history-unreadable "unreadable Safe factory logs"
baseline; echo '[{"address":"0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67"}]' >"$FAKE/proxy_logs"; run governance preflight
expect_class chain-used "a chain the factory already created a Safe on"
baseline; echo "" >"$FAKE/quorum"; run governance preflight; expect_class governance-unreadable "an unreadable quorum"

echo "--- governance ensure / verify ---"
baseline; run governance ensure; expect_rc 0 "governance ensure succeeds"
check "it calls fusion-ceremony.sh ensure with the out dir, summary and rpc" \
  grep -q "^ceremony ensure --out-dir $OUT --summary $OUT/core-smoke.log --rpc-url http://127.0.0.1:18545$" "$FAKE/calls"
baseline; echo 65 >"$FAKE/ceremony_rc"; run governance ensure; expect_rc 65 "ensure's used-chain refusal (65) passes through"
baseline; run governance verify; expect_rc 0 "governance verify succeeds"
check "it verifies the live record, not the committed one" \
  grep -q "^ceremony verify --record $OUT/fusion-stage-record.json --rpc-url http://127.0.0.1:18545$" "$FAKE/calls"
check "and keeps verify's own check lines" grep -q "^PASS  chain id" "$WORK/stdout"
baseline; echo 1 >"$FAKE/ceremony_rc"; run governance verify; expect_class governance-unverified "a failing verify"
baseline; echo 1 >"$FAKE/ceremony_rc"; rm -rf "$OUT/keys"; run governance verify
expect_class keys-discarded "a failing verify whose ceremony keystores are gone"
baseline; echo 66 >"$FAKE/ceremony_rc"; run governance verify; expect_rc 66 "verify's other exit codes pass through"
baseline; rm "$OUT/fusion-stage-record.json"; run governance verify; expect_class record-missing "verify with no record"

echo "--- dapp ---"
baseline; run dapp status; expect_rc 0 "rpc, explorer and dapp answering passes"
baseline; rm "$FAKE/chain"; run dapp status; expect_class rpc-unready "a dead rpc"
baseline; echo 0x1 >"$FAKE/chain"; run dapp status; expect_class rpc-unready "an rpc on another chain"
baseline; rm "$FAKE/explorer"; run dapp status; expect_class explorer-unready "a silent explorer"
baseline; rm "$FAKE/dapp"; run dapp status; expect_class dapp-unready "a silent dapp"
baseline; run dapp up; expect_rc 0 "dapp up over the chain chain up booted from this checkout succeeds"
check "it calls deploy-core-stack.sh up" grep -q "^deploy up --out-dir $OUT$" "$FAKE/calls"
baseline; advance_head >/dev/null; run dapp up; expect_rc 65 "dapp up over a chain booted from another commit is refused"
check "before rebuilding anything" bash -c "! grep -qs '^deploy up' '$FAKE/calls'"
baseline; rm "$OUT/core-stack.stamp"; run dapp up; expect_rc 65 "dapp up with no completed chain up is refused"

echo "--- rmpc check ---"
baseline; run rmpc check; expect_rc 0 "both binaries answering their contracts passes"
baseline; rm "$REPO/target/debug/rmpc"; run rmpc check; expect_class missing-binary "a missing rmpc"
git -C "$REPO" checkout -q -- target/debug/rmpc
baseline; rm "$REPO/target/debug/rmpc-keystore-import"; run rmpc check; expect_class missing-binary "a missing import helper"
git -C "$REPO" checkout -q -- target/debug/rmpc-keystore-import
baseline; : >"$FAKE/no_selfcheck"; run rmpc check; expect_class missing-subcommand "an rmpc with no self-check"
baseline; echo 2 >"$FAKE/selfcheck_rc"; run rmpc check; expect_class startup-exit-drift "self-check exiting 2 on a missing config"
baseline; echo 0 >"$FAKE/import_rc"; run rmpc check; expect_class import-exit-drift "an import helper exiting 0 on no argv"
baseline; echo 1 >"$FAKE/import_rc"; run rmpc check; expect_class import-exit-drift "an import helper exiting 1 on no argv"

echo "--- record show ---"
baseline; run record show; expect_rc 0 "a complete record is shown"
check "as the record's JSON" test "$(jq -r .chain_id "$WORK/stdout" 2>/dev/null)" == 918453
baseline; run record show --path; check "--path prints only its path" test "$(cat "$WORK/stdout")" == "$OUT/fusion-stage-record.json"
baseline; rm "$OUT/fusion-stage-record.json"; run record show; expect_class record-missing "a missing record" 65
baseline; echo '{"chain_id":' >"$OUT/fusion-stage-record.json"; run record show; expect_class record-unparseable "a record that is not JSON" 65
baseline; edit_record '.chain_id = 1'; run record show; expect_class record-wrong-chain "a record for chain 1" 65
baseline; edit_record '.chain_id = "918453x"'; run record show; expect_class record-wrong-chain "a record whose chain_id is not 918453" 65
# Every field the contract requires, deleted one at a time.
for field in .chain_id .run_id .core_tag .core_sha .generated_at .min_delay .deployer \
             .addresses.gateway .addresses.vault .addresses.registry .addresses.router .addresses.governance \
             .addresses.consensus_receipt .addresses.ic_policy .addresses.timelock .addresses.safe .addresses.emergency \
             .code_hashes.gateway \
             .vault_addresses.rmUSDC .vault_addresses.rmPROTO .vault_addresses.rmAGENT .vault_addresses.rmRWA \
             .ephemeral.submitter .ephemeral.approver .ephemeral.voters .ephemeral.emergency \
             .ephemeral.keystore_dir .ephemeral.safe_signers; do
  baseline; edit_record "del($field)"; run record show; expect_class record-field-missing "a record with no $field" 65
done
baseline; edit_record '.ephemeral.voters |= .[0:1]'; run record show; expect_class record-field-missing "a record with one voter" 65
for role in approver approver-b approver-c; do
  baseline; edit_record ".ephemeral.safe_signers |= map(select(.role != \"$role\"))"; run record show
  expect_class record-field-missing "a record whose Safe signers lack $role" 65
done
baseline; edit_record ".addresses.safe = \"$(a 0)\""; run record show; expect_class record-field-malformed "a zero Safe address" 65
baseline; edit_record '.addresses.router = "0xnope"'; run record show; expect_class record-field-malformed "a non-address router" 65
baseline; edit_record ".vault_addresses.rmRWA = \"$(a 0)\""; run record show; expect_class record-field-malformed "a zero vault address" 65
baseline; edit_record '.ephemeral.safe_signers[1].address = "nope"'; run record show; expect_class record-field-malformed "a Safe signer that is not an address" 65
baseline; edit_record ".ephemeral.approver = \"$(a 77)\""; run record show; expect_class record-field-malformed "an approver that is not a Safe signer" 65
baseline; edit_record '.code_hashes.gateway = "0x\("00" * 32)"'; run record show; expect_class record-field-malformed "a zero gateway code hash" 65
baseline; edit_record '.code_hashes.gateway = "0x1234"'; run record show; expect_class record-field-malformed "a gateway code hash that is not a bytes32" 65
baseline; edit_record '.core_sha = "abc"'; run record show; expect_class record-field-malformed "a core_sha that is not a commit" 65
baseline; edit_record '.min_delay = 0'; run record show; expect_class record-field-malformed "a zero min_delay" 65
baseline; edit_record ".addresses.safe = \"$(a 0)\""; run record show --path; check "--path is refused with the record" test "$RC" == 65

echo "--- record schema drift guard ---"
# devops#42 item 1: schemas/fusion-stage-record.schema.json's `required` array
# and record_show's own RECORD_REQUIRED_FIELDS (exposed via the undocumented
# `record show --list-required-fields`) must be the same list, read from each
# side, so the schema file and the verb's validation cannot silently drift
# apart. This does not check either one is "right" — the per-field cases above
# already do that — only that the two stay equal.
SCHEMA="$HERE/../../../schemas/fusion-stage-record.schema.json"
check "the schema file is valid JSON" bash -c "jq -e . '$SCHEMA' >/dev/null"
baseline; run record show --list-required-fields
expect_rc 0 "record show --list-required-fields succeeds without a record on disk"
check "and its field list is a JSON array" bash -c "jq -e 'type == \"array\" and length > 0' '$WORK/stdout' >/dev/null"
check "schemas/fusion-stage-record.schema.json's required array equals record show's own field list" \
  bash -c "diff <(jq -cS . '$WORK/stdout') <(jq -cS '.required' '$SCHEMA') >/dev/null"

echo "core-stack selftest: $PASSED passed, $FAILED failed"
echo "CORE_STACK_SELFTESTS_EXECUTED=$PASSED"
(( FAILED == 0 )) || exit 1
(( PASSED >= MIN_EXPECTED_ASSERTIONS )) || { echo "only $PASSED assertions executed, floor is $MIN_EXPECTED_ASSERTIONS" >&2; exit 1; }
