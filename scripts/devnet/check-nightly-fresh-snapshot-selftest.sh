#!/usr/bin/env bash
# Selftest for nightly job (b), suite-29-nightly-fresh-snapshot.yml (core 1496).
# Offline and fast: yq, grep, bun, a localhost stub. No chain, no network, no secret.
#
# It fails when:
#   - suite 5, 7, 8, 10, 11b, 14 or 26 is missing from the workflow (negative control on a temp copy);
#   - the workflow references a secret other than GITHUB_TOKEN, or a keyed or archive RPC URL;
#   - check-nightly-fresh-snapshot.ts accepts a manifest without block number, hash or timestamp,
#     or one whose block timestamp is more than one hour old;
#   - it accepts a stubbed failing, cancelled, skipped or missing suite result;
#   - the final step of the results job is not `git diff --exit-code` over the fixture paths;
#   - snapshot-fork retries do not survive a stub HTTP 429 (snapshot-fork-selftest.ts).
# shellcheck disable=SC2016  # the stub workflow text contains literal ${{ }}
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
WF=.github/workflows/suite-29-nightly-fresh-snapshot.yml
CHECK=scripts/devnet/check-nightly-fresh-snapshot.ts
for t in yq jq bun; do command -v "$t" >/dev/null || { echo "selftest needs $t" >&2; exit 2; }; done
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
PASS=0
ok() { PASS=$((PASS + 1)); echo "ok   - $1"; }
bad() { echo "FAIL - $1" >&2; exit 1; }

# The suites the issue names: workflow file for each.
declare -A SUITE_FILE=(
  [5]=suite-05-fork-integration.yml [7]=suite-07-rmpc-integration.yml [8]=suite-08-explorer-indexer.yml
  [10]=suite-10-dapp-e2e.yml [11b]=suite-11b-opencode-headless.yml [14]=suite-14-smoke-test.yml
  [26]=suite-26-fusion-devnet-acceptance.yml
)

# Prints one line per missing suite.
missing_suites() { # missing_suites WORKFLOW
  local s
  for s in 5 7 8 10 11b 14 26; do
    local want="./.github/workflows/${SUITE_FILE[$s]}"
    yq -e ".jobs[] | select(.uses == \"$want\")" "$1" >/dev/null 2>&1 || echo "suite $s ($want)"
  done
}

# ── 1. every suite is in the workflow ─────────────────────────────────────────
[[ -z "$(missing_suites "$WF")" ]] || bad "the workflow is missing: $(missing_suites "$WF")"
ok "suites 5, 7, 8, 10, 11b, 14 and 26 are all called by $WF"
for s in 5 7 8 10 11b 14 26; do
  yq -e ".jobs[] | select(.uses == \"./.github/workflows/${SUITE_FILE[$s]}\") | .with.fresh_snapshot == true" "$WF" >/dev/null \
    || bad "suite $s is not called with fresh_snapshot: true"
done
ok "every suite runs against the fresh snapshot (fresh_snapshot: true)"
for s in 5 7 8 10 11b 14 26; do
  key="$(yq -r ".jobs | to_entries[] | select(.value.uses == \"./.github/workflows/${SUITE_FILE[$s]}\") | .key" "$WF")"
  yq -e ".jobs.results.needs | contains([\"$key\"])" "$WF" >/dev/null || bad "the results job does not wait for $key"
done
ok "the results job needs every suite job"
for s in 5 7 8 10 11b 14 26; do
  key="$(yq -r ".jobs | to_entries[] | select(.value.uses == \"./.github/workflows/${SUITE_FILE[$s]}\") | .key" "$WF")"
  yq "del(.jobs.\"$key\")" "$WF" >"$WORK/without-$s.yml"
  out="$(missing_suites "$WORK/without-$s.yml")"
  [[ "$out" == *"suite $s "* ]] || bad "removing suite $s from the workflow was not detected"
done
ok "removing any one of the seven suites is detected (negative control)"
{ yq -e '.on | has("schedule")' "$WF" && yq -e '.on | has("workflow_dispatch")' "$WF"; } >/dev/null || bad "the workflow needs schedule and workflow_dispatch"
ok "the workflow has a nightly schedule and workflow_dispatch"

# ── 2. no secret, no keyed or archive RPC ─────────────────────────────────────
# Comments describe what the workflow does NOT use, so judge only the live lines.
live="$(grep -v '^[[:space:]]*#' "$WF")"
scan() { # scan TEXT: prints each violation
  local text="$1" s
  while IFS= read -r s; do
    [[ -z "$s" || "$s" == GITHUB_TOKEN ]] || echo "secret other than GITHUB_TOKEN: secrets.$s"
  done < <(grep -oE 'secrets\.[A-Za-z0-9_]+' <<<"$text" | sed 's/^secrets\.//' | sort -u)
  grep -oiE '(alchemy|infura|quicknode|quiknode|ankr|drpc|chainstack|blastapi|llamarpc|nodereal|getblock|tenderly)[A-Za-z0-9./_-]*' <<<"$text" | sed 's/^/keyed or archive RPC: /' || true
  grep -oE 'RMPC_FORK_RPC_URL|BASE_RPC_URL|ARCHIVE_RPC[A-Z_]*' <<<"$text" | sed 's/^/RPC variable: /' || true
  grep -oE 'https?://[^ "]*[?/][A-Za-z0-9_-]{24,}' <<<"$text" | sed 's/^/RPC URL with a key: /' || true
}
[[ -z "$(scan "$live")" ]] || bad "the workflow carries: $(scan "$live")"
ok "the workflow references no secret other than GITHUB_TOKEN and no keyed or archive RPC"
[[ -n "$(scan "$live"$'\n''env: { X: ${{ secrets.ALCHEMY_KEY }} }')" ]] || bad "a stub secret was not detected"
[[ -n "$(scan "$live"$'\n''url: https://base-mainnet.g.alchemy.com/v2/abc')" ]] || bad "a stub keyed RPC URL was not detected"
[[ -z "$(scan "$live"$'\n''t: ${{ secrets.GITHUB_TOKEN }}')" ]] || bad "GITHUB_TOKEN must be allowed"
ok "the scanner flags a stub secret and a stub keyed RPC URL and allows GITHUB_TOKEN (negative control)"

# ── 3. the manifest check ─────────────────────────────────────────────────────
NOW=1790000000
manifest() { # manifest FILE TIMESTAMP [drop-field]
  jq -n --argjson ts "$2" '{block_number: 48896605, block_hash: ("0x" + ("ab" * 32)), block_timestamp: $ts}' |
    { if [[ -n "${3:-}" ]]; then jq "del(.$3)"; else cat; fi; } >"$1"
}
run_check() { bun "$CHECK" --now "$NOW" "$@" >"$WORK/out" 2>&1 && return 0 || return 1; }
manifest "$WORK/fresh.json" $((NOW - 600))
run_check --manifest "$WORK/fresh.json" || bad "a fresh manifest was rejected: $(cat "$WORK/out")"
ok "a manifest with block number, hash and a timestamp 10 minutes old passes"
manifest "$WORK/old.json" $((NOW - 3601))
run_check --manifest "$WORK/old.json" && bad "a manifest more than one hour old was accepted"
grep -q "older than" "$WORK/out" || bad "the stale failure did not say why: $(cat "$WORK/out")"
ok "a manifest whose block is 3601 seconds old fails"
manifest "$WORK/edge.json" $((NOW - 3600))
run_check --manifest "$WORK/edge.json" || bad "a manifest exactly one hour old was rejected"
ok "a manifest exactly one hour old still passes (the limit is over one hour)"
for f in block_number block_hash block_timestamp; do
  manifest "$WORK/no-$f.json" $((NOW - 60)) "$f"
  run_check --manifest "$WORK/no-$f.json" && bad "a manifest without $f was accepted"
done
ok "a manifest missing block_number, block_hash or block_timestamp fails"
jq '.block_hash = "0x1234"' "$WORK/fresh.json" >"$WORK/short-hash.json"
run_check --manifest "$WORK/short-hash.json" && bad "a manifest with a short block hash was accepted"
ok "a manifest whose block hash is not 32 bytes fails"
run_check --manifest "$WORK/does-not-exist.json" && bad "a missing manifest was accepted"
ok "a missing manifest fails"

# ── 4. the suite results gate ────────────────────────────────────────────────
mkdir -p "$WORK/results"
for s in 5 7 8 10 11b 14 26; do jq -n --arg s "$s" '{suite: $s, result: "success"}' >"$WORK/results/suite-$s.json"; done
run_check --manifest "$WORK/fresh.json" --suite-results "$WORK/results" || bad "seven passing suites were rejected: $(cat "$WORK/out")"
ok "seven successful suite results pass"
for outcome in failure cancelled skipped; do
  jq --arg r "$outcome" '.result = $r' "$WORK/results/suite-14.json" >"$WORK/r.json"; mv "$WORK/r.json" "$WORK/results/suite-14.json"
  run_check --manifest "$WORK/fresh.json" --suite-results "$WORK/results" && bad "a $outcome suite 14 result was accepted"
  grep -q "suite 14" "$WORK/out" || bad "the $outcome failure did not name suite 14"
done
ok "a stubbed failure, cancelled or skipped suite exits non-zero and names the suite"
jq '.result = "success"' "$WORK/results/suite-14.json" >"$WORK/r.json"; mv "$WORK/r.json" "$WORK/results/suite-14.json"
rm "$WORK/results/suite-26.json"
run_check --manifest "$WORK/fresh.json" --suite-results "$WORK/results" && bad "a missing suite 26 result was accepted"
grep -q "suite 26" "$WORK/out" || bad "the missing result did not name suite 26"
ok "a missing suite result exits non-zero and names the suite"
# The workflow must call exactly this gate with the results directory.
yq -e '.jobs.results.steps[] | select(.run | test("check-nightly-fresh-snapshot.ts")) | .run | test("--suite-results")' "$WF" >/dev/null \
  || bad "the results job does not run the gate with --suite-results"
ok "the results job runs the gate with --suite-results"

# ── 5. nothing is committed ───────────────────────────────────────────────────
last="$(yq -r '.jobs.results.steps[-1].run' "$WF")"
[[ "$last" == *"git diff --exit-code"* && "$last" == *testing/fixtures/fork-state* && "$last" == *testing/ethereum-testnet/config* ]] \
  || bad "the final step of the results job is not git diff --exit-code over the fixture paths: $last"
ok "the final step of the results job is git diff --exit-code over testing/fixtures/fork-state and testing/ethereum-testnet/config"
if grep -nE 'git (add|commit|push)' <<<"$live" >/dev/null; then bad "the workflow commits or pushes"; fi
ok "the workflow never runs git add, commit or push"

# ── 6. HTTP 429 retry, and no Deploy.s.sol, and the 429 / contents selftest ──
bun scripts/devnet/snapshot-fork-selftest.ts >"$WORK/429.log" 2>&1 || { cat "$WORK/429.log" >&2; bad "snapshot-fork-selftest.ts failed (429 retry, no Deploy.s.sol)"; }
grep -q 'retries HTTP 429 until it succeeds' "$WORK/429.log" || bad "the 429 retry assertion did not run"
ok "the snapshot tooling retries a stub HTTP 429 and then succeeds"

echo "nightly fresh snapshot selftest: $PASS checks passed"
