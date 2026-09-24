#!/usr/bin/env bash
# Offline self-test for scripts/stage/core-stack.sh (C-21: a gate is not
# evidence until it has been shown to fail). Every verb runs against a scratch
# git checkout whose deploy-core-stack.sh, fusion-ceremony.sh and rmpc are
# stubs, and whose curl / docker / cast are fakes answering from files under
# $FAKE. Each read-only verb must pass on the baseline and must fail with its
# named class when exactly one fact is broken; each mutating verb must call the
# wrapped script with the arguments the contract promises, and nothing else.
# Touches no network, no docker daemon and no chain.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../core-stack.sh"
command -v jq >/dev/null || { echo "selftest needs jq" >&2; exit 2; }
WORK="$(mktemp -d)"
# A stub harness stays attached (exec sleep), exactly like the real one, so
# every one a test starts is killed through the pid file it wrote.
reap() { if [[ -f "$WORK/out/core-smoke.pid" ]]; then kill "$(cat "$WORK/out/core-smoke.pid")" 2>/dev/null || true; fi; }
trap 'reap; rm -rf "$WORK"' EXIT

# The expected executed-assertion floor: a truncated file that stops early must
# not print a green summary. Raise it with every assertion added.
MIN_EXPECTED_ASSERTIONS=52

REPO="$WORK/repo"; FAKE="$WORK/fake"; BIN="$WORK/bin"; OUT="$WORK/out"
mkdir -p "$REPO/scripts/stage" "$REPO/target/debug" "$REPO/testing/smoke-test/src" "$FAKE" "$BIN" "$OUT" "$WORK/home"
cp "$SCRIPT" "$REPO/scripts/stage/core-stack.sh"

a() { printf '0x%040x' "$1"; }
DEPLOYER=$(a 10)

# ─── stubs for the wrapped scripts: record argv, behave as $FAKE says ────────
cat >"$REPO/scripts/stage/deploy-core-stack.sh" <<'STUB'
#!/usr/bin/env bash
echo "deploy $*" >>"$FAKE/calls"
case "$1" in
  smoke)
    case "$(cat "$FAKE/smoke_mode" 2>/dev/null || echo ok)" in
      ok)
        # The stack is up by the time the summary prints, as with the harness.
        echo 0xe03b5 >"$FAKE/chain"; echo rm-indexer >"$FAKE/healthy"
        cat "$FAKE/summary"
        exec sleep 300 ;;
      die) echo "harness exploded"; exit 1 ;;
      hang) exec sleep 300 ;;
    esac ;;
esac
exit "$(cat "$FAKE/deploy_rc" 2>/dev/null || echo 0)"
STUB
cat >"$REPO/scripts/stage/fusion-ceremony.sh" <<'STUB'
#!/usr/bin/env bash
echo "ceremony $*" >>"$FAKE/calls"
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
cat >"$BIN/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
[[ "$1" == ps ]] && { cat "$FAKE/healthy" 2>/dev/null || true; exit 0; }
exit 0
FAKE_DOCKER
cat >"$BIN/cast" <<'FAKE_CAST'
#!/usr/bin/env bash
case "$1" in
  chain-id) [[ -f "$FAKE/chain" ]] || exit 1; echo 918453 ;;
  code) [[ "$(cat "$FAKE/nocode" 2>/dev/null)" == "$2" ]] && echo 0x || echo 0x6080604052 ;;
  call)
    case "$3" in
      'receiptCount()(uint256)') cat "$FAKE/receipts" 2>/dev/null || echo 0 ;;
      'quorumThreshold()(uint256)') cat "$FAKE/quorum" 2>/dev/null || echo "1 [1e0]" ;;
      *) exit 1 ;;
    esac ;;
  wallet) cat "$FAKE/derived" ;;
  *) exit 1 ;;
esac
FAKE_CAST
chmod +x "$BIN"/* "$REPO/scripts/stage/"*.sh "$REPO/target/debug/"*

git -C "$REPO" init -q
git -C "$REPO" -c user.email=t@t -c user.name=t add -A
git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm base
git -C "$REPO" tag v9.9.9-rc.1
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"

write_summary() {
  {
    echo "--- endpoint summary ---"
    echo "chain_id=918453"
    local i=1 key
    for key in gateway_addr vault_addr registry_addr router_addr governance_addr ic_policy_addr consensus_receipt_addr; do
      echo "$key=$(a "$i")"; i=$((i + 1))
    done
    echo "admin_addr=$DEPLOYER"
    echo "--- end endpoint summary ---"
  } >"$1"
}

# Baseline: a healthy chain running the candidate, every ceremony precondition
# met, the dapp stack answering, a complete record on disk.
baseline() {
  reap
  rm -rf "$FAKE" "$OUT"; mkdir -p "$FAKE" "$OUT"
  echo 0xe03b5 >"$FAKE/chain"
  echo rm-indexer >"$FAKE/healthy"
  echo "$HEAD_SHA" >"$FAKE/rmpc_commit"
  echo "$DEPLOYER" >"$FAKE/derived"
  : >"$FAKE/explorer"; : >"$FAKE/dapp"
  write_summary "$FAKE/summary"
  cp "$FAKE/summary" "$OUT/core-smoke.log"
  jq -n --arg d "$DEPLOYER" --arg x "$(a 1)" '{
    chain_id: 918453, run_id: "20260924T000000Z", core_tag: "v9.9.9-rc.1", core_sha: "abc",
    generated_at: "2026-09-24T00:00:00Z", min_delay: 120, deployer: $d,
    addresses: {gateway: $x, vault: $x, registry: $x, router: $x, governance: $x,
                consensus_receipt: $x, timelock: $x, safe: $x, emergency: $x},
    vault_addresses: {rmUSDC: $x, rmPROTO: $x, rmAGENT: $x, rmRWA: $x},
    ephemeral: {submitter: $x, approver: $x, voters: [$x, $x], emergency: $x}}' >"$OUT/fusion-stage-record.json"
}

run() {
  set +e
  env HOME="$WORK/home" PATH="$BIN:$PATH" FAKE="$FAKE" CAST="$BIN/cast" \
    "$REPO/scripts/stage/core-stack.sh" "$@" --out-dir "$OUT" >"$WORK/stdout" 2>"$WORK/stderr"
  RC=$?
  set -e
}
run_bare() {  # no --out-dir, for the usage paths
  set +e
  env HOME="$WORK/home" PATH="$BIN:$PATH" FAKE="$FAKE" CAST="$BIN/cast" \
    "$REPO/scripts/stage/core-stack.sh" "$@" >"$WORK/stdout" 2>"$WORK/stderr"
  RC=$?
  set -e
}

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "ok   $1"; }
flunk() { FAILED=$((FAILED + 1)); echo "FAIL $1"; sed 's/^/     | /' "$WORK/stdout" "$WORK/stderr" | tail -6; }
expect_rc() { local want="$1" name="$2"; [[ "$RC" == "$want" ]] && pass "$name" || flunk "$name: exit $RC, want $want"; }
# A read-only verb's "no" is exit 1 AND the named class on stdout.
expect_class() {
  local class="$1" name="$2"
  if [[ "$RC" == 1 ]] && grep -q "^$class: " "$WORK/stdout"; then pass "$name is refused as $class"
  else flunk "$name: exit $RC, stdout lacks '$class:'"; fi
}
calls() { cat "$FAKE/calls" 2>/dev/null || true; }

echo "--- usage ---"
baseline; run_bare; expect_rc 64 "no verb is a usage error"
baseline; run_bare chain sideways; expect_rc 64 "an unknown verb is a usage error"
baseline; run_bare chain up --timeout 0; expect_rc 64 "a zero --timeout is a usage error"

echo "--- chain status ---"
baseline; run chain status; expect_rc 0 "the healthy candidate passes"
grep -q "^ok: " "$WORK/stdout" && pass "a pass prints one ok: line" || flunk "no ok: line on a pass"
baseline; run chain status --ref v9.9.9-rc.1; expect_rc 0 "--ref resolves a tag to the same commit"
baseline; rm "$FAKE/chain"; run chain status; expect_class rpc-unreachable "a dead rpc"
baseline; echo 0x1 >"$FAKE/chain"; run chain status; expect_class wrong-chain "a chain that is not 918453"
baseline; rm "$FAKE/healthy"; run chain status; expect_class no-healthy-container "no healthy container"
baseline; echo deadbeef >"$FAKE/rmpc_commit"; run chain status; expect_class candidate-mismatch "an rmpc built from another commit"
baseline; run chain status --ref no-such-ref; expect_class ref-unresolved "a --ref this checkout cannot resolve"

echo "--- chain up ---"
baseline; run chain up; expect_rc 0 "chain up on an already-healthy candidate succeeds"
[[ -z "$(calls)" ]] && pass "and starts nothing" || flunk "chain up on a healthy candidate called: $(calls)"

baseline; rm "$FAKE/chain" "$FAKE/healthy"; rm "$OUT/core-smoke.log"; echo ok >"$FAKE/smoke_mode"
run chain up --timeout 30; expect_rc 0 "chain up boots the harness and waits for its summary"
grep -q "^deploy smoke --out-dir $OUT$" "$FAKE/calls" && pass "it launched deploy-core-stack.sh smoke" || flunk "no smoke call: $(calls)"
[[ -s "$OUT/core-smoke.pid" ]] && pass "it recorded the harness pid" || flunk "no pid file"
grep -q -- '--- end endpoint summary ---' "$OUT/core-smoke.log" && pass "the summary landed in the log it polls" || flunk "summary not in $OUT/core-smoke.log"
kill "$(cat "$OUT/core-smoke.pid")" 2>/dev/null || true

baseline; rm "$FAKE/chain" "$FAKE/healthy"; echo die >"$FAKE/smoke_mode"
run chain up --timeout 30; expect_rc 66 "a harness that dies before its summary fails the verb"
grep -q "harness exploded" "$WORK/stderr" && pass "and its log tail is shown" || flunk "no log tail on stderr"

baseline; rm "$FAKE/chain" "$FAKE/healthy"; echo hang >"$FAKE/smoke_mode"
run chain up --timeout 4; expect_rc 66 "a harness that never prints its summary times out"
live_pid="$(cat "$OUT/core-smoke.pid")"
run chain up --timeout 4; expect_rc 66 "chain up refuses while an unhealthy harness is still alive"
grep -q "chain down" "$WORK/stderr" && pass "and says to run chain down" || flunk "refusal does not name chain down"
kill "$live_pid" 2>/dev/null || true

echo "--- chain down ---"
baseline; run chain down; expect_rc 0 "chain down succeeds"
grep -q "^deploy down --out-dir $OUT$" "$FAKE/calls" && pass "it calls deploy-core-stack.sh down" || flunk "no down call: $(calls)"
baseline; echo 66 >"$FAKE/deploy_rc"; run chain down; expect_rc 66 "a failing down passes its exit code through"

echo "--- governance preflight ---"
baseline; run governance preflight; expect_rc 0 "a chain meeting every ceremony precondition passes"
baseline; head -3 "$FAKE/summary" >"$OUT/core-smoke.log"; run governance preflight; expect_class summary-incomplete "a summary with no end marker"
baseline; rm "$FAKE/chain"; run governance preflight; expect_class rpc-unreachable "a dead rpc"
baseline; sed -i 's/^router_addr=.*/router_addr=0xnope/' "$OUT/core-smoke.log"; run governance preflight; expect_class summary-malformed "a malformed summary address"
baseline; a 4 >"$FAKE/nocode"; run governance preflight; expect_class no-code "a summary contract with no code"
baseline; echo "garbage" >"$FAKE/receipts"; run governance preflight; expect_class receipt-unreadable "an unreadable receipt store"
baseline; echo 3 >"$FAKE/receipts"; run governance preflight; expect_class receipt-fixtures-present "a receipt store holding fixtures"
baseline; a 99 >"$FAKE/derived"; run governance preflight; expect_class deployer-mismatch "a deployer key that is not the summary admin"
baseline; echo "" >"$FAKE/quorum"; run governance preflight; expect_class governance-unreadable "an unreadable quorum"

echo "--- governance ensure / verify ---"
baseline; run governance ensure; expect_rc 0 "governance ensure succeeds"
grep -q "^ceremony ensure --out-dir $OUT --summary $OUT/core-smoke.log --rpc-url http://127.0.0.1:18545$" "$FAKE/calls" \
  && pass "it calls fusion-ceremony.sh ensure with the out dir, summary and rpc" || flunk "wrong ensure call: $(calls)"
baseline; run governance verify; expect_rc 0 "governance verify succeeds"
grep -q "^ceremony verify --record $OUT/fusion-stage-record.json --rpc-url http://127.0.0.1:18545$" "$FAKE/calls" \
  && pass "it verifies the live record, not the committed one" || flunk "wrong verify call: $(calls)"
baseline; echo 1 >"$FAKE/ceremony_rc"; run governance verify; expect_rc 1 "a failing verify passes its exit code through"
baseline; rm "$OUT/fusion-stage-record.json"; run governance verify; expect_class record-missing "verify with no record"

echo "--- dapp ---"
baseline; run dapp status; expect_rc 0 "rpc, explorer and dapp answering passes"
baseline; rm "$FAKE/explorer"; run dapp status; expect_class explorer-unready "a silent explorer"
baseline; run dapp up; grep -q "^deploy up --out-dir $OUT$" "$FAKE/calls" && pass "dapp up calls deploy-core-stack.sh up" || flunk "wrong dapp up call: $(calls)"

echo "--- rmpc check ---"
baseline; run rmpc check; expect_rc 0 "both binaries answering their contracts passes"
baseline; rm "$REPO/target/debug/rmpc-keystore-import"; run rmpc check; expect_class missing-binary "a missing import helper"
git -C "$REPO" checkout -q -- target/debug/rmpc-keystore-import
baseline; : >"$FAKE/no_selfcheck"; run rmpc check; expect_class missing-subcommand "an rmpc with no self-check"
baseline; echo 2 >"$FAKE/selfcheck_rc"; run rmpc check; expect_class startup-exit-drift "self-check exiting 2 on a missing config"

echo "--- record show ---"
baseline; run record show; expect_rc 0 "a complete record is shown"
[[ "$(jq -r .chain_id "$WORK/stdout" 2>/dev/null)" == 918453 ]] && pass "as the record's JSON" || flunk "stdout is not the record"
baseline; run record show --path; [[ "$(cat "$WORK/stdout")" == "$OUT/fusion-stage-record.json" ]] && pass "--path prints only its path" || flunk "--path printed $(cat "$WORK/stdout")"
baseline; jq 'del(.addresses.safe)' "$OUT/fusion-stage-record.json" >"$WORK/r" && mv "$WORK/r" "$OUT/fusion-stage-record.json"
run record show; expect_rc 65 "a record with no safe address is refused"
baseline; rm "$OUT/fusion-stage-record.json"; run record show; expect_rc 65 "a missing record is refused"

echo "core-stack selftest: $PASSED passed, $FAILED failed"
echo "CORE_STACK_SELFTESTS_EXECUTED=$PASSED"
(( FAILED == 0 )) || exit 1
(( PASSED >= MIN_EXPECTED_ASSERTIONS )) || { echo "only $PASSED assertions executed, floor is $MIN_EXPECTED_ASSERTIONS" >&2; exit 1; }
