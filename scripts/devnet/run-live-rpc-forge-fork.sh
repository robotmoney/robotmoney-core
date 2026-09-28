#!/usr/bin/env bash
# Run one merge-gating live-RPC forge fork suite, and say whether a red result
# is the RPC provider's fault or a real test failure (issue #1239).
#
# Canonical: docs/development/ci-suites.md §1–2 ("Live-RPC fork steps").
#
# Usage:
#   RMPC_FORK_RPC_URL_RAW=<raw secrets.RMPC_FORK_RPC_URL, may be empty> \
#     scripts/devnet/run-live-rpc-forge-fork.sh <label> <forge test args...>
#
# WHY THIS EXISTS
# forge-fork-vault-regressions used to run a bare `forge test` against a live
# Base RPC. Two unrelated causes then showed up as the same red check: a real
# regression in the fork test, and a rate-limited or pruned public endpoint
# (Cloudflare 429, "Archive requests require a personal token", "could not
# instantiate forked environment"). Telling them apart meant reading the raw
# log every time, and PR #1215 lost time treating a real bug as that flake.
#
# WHAT IT DOES
# - Endpoint: the configured RMPC_FORK_RPC_URL when set. When it is unset, the
#   public endpoints from fork-rpc-lib.sh, one per attempt in rotation. A
#   rate-limited public endpoint is therefore retried on a different provider.
# - Classification of a failed run:
#     provider  every failing test failed on an RPC transport/provider error.
#               Retried up to FORK_RPC_ATTEMPTS times, then red with an
#               ::error titled as a provider failure (exit 20).
#     test      at least one failing test failed for another reason. Red at
#               once with an ::error titled as a test failure, never retried,
#               so a real regression cannot be retried into a green (exit 10).
#     harness   forge failed without reporting any failing test and without an
#               RPC signature, e.g. a compile error (exit 30).
# - A green run must have executed at least one test (exit 30 otherwise).
# - Output is redacted: forge prints the full request URL on a transport
#   failure, and a keyed provider URL carries its API key.
#
# Env:
#   RMPC_FORK_RPC_URL_RAW       raw Actions secret value (empty = unset)
#   FORK_RPC_ATTEMPTS           attempts in total (default 3)
#   FORK_RPC_RETRY_DELAY_SECONDS  base backoff; attempt n waits n*base (default 10)
#   FORK_RPC_PUBLIC_ENDPOINTS   override the public fallback list (tests)
#   FORGE_BIN                   forge binary (default forge; tests stub it)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/devnet/fork-rpc-lib.sh
. "$SCRIPT_DIR/fork-rpc-lib.sh"

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <label> <forge test args...>" >&2
  exit 30
fi
LABEL="$1"
shift

ATTEMPTS="${FORK_RPC_ATTEMPTS:-3}"
DELAY="${FORK_RPC_RETRY_DELAY_SECONDS:-10}"
FORGE_BIN="${FORGE_BIN:-forge}"
[[ "$ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || { echo "FORK_RPC_ATTEMPTS must be a positive integer" >&2; exit 30; }
[[ "$DELAY" =~ ^[0-9]+$ ]] || { echo "FORK_RPC_RETRY_DELAY_SECONDS must be a non-negative integer" >&2; exit 30; }

CONFIGURED="${RMPC_FORK_RPC_URL_RAW:-}"
ENDPOINTS=()
if [ -n "$CONFIGURED" ]; then
  # Mask it for the rest of the job as well; the stream redaction below is
  # what the offline test proves, this covers anything printed later.
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::add-mask::$CONFIGURED"
  fi
  ENDPOINTS=("$CONFIGURED")
else
  while IFS= read -r ep; do
    [ -n "$ep" ] && ENDPOINTS+=("$ep")
  done < <(fork_rpc_public_endpoints)
fi
if [ "${#ENDPOINTS[@]}" -eq 0 ]; then
  echo "::error title=Fork RPC harness (issue #1239)::${LABEL}: no fork RPC endpoint resolved" >&2
  exit 30
fi

endpoint_label() {
  # Names the endpoint without printing a configured value.
  if [ -n "$CONFIGURED" ]; then
    echo "the configured RMPC_FORK_RPC_URL"
  else
    echo "public fallback $(fork_rpc_origin "$1") (RMPC_FORK_RPC_URL is unset)"
  fi
}

record() {
  echo "fork-rpc-classification=$1"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "classification=$1" >>"$GITHUB_OUTPUT"
  fi
}

# Classifies a failed forge log. Prints provider, test or harness.
classify_failure() {
  python3 - "$1" <<'PY'
import re, sys

text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
text = re.sub(r"\x1b\[[0-9;]*m", "", text)

# Transport/provider diagnostics only. Kept specific on purpose: a bare "429"
# would match amounts in -vvv traces, and an unrecognised failure must stay a
# test failure rather than be retried away.
PROVIDER = re.compile(
    r"could not instantiate forked environment"
    r"|failed to (?:retrieve|get|fetch)\b[^;\]]*\b(?:chain id|block|account|storage|code|balance|nonce)"
    r"|HTTP error (?:429|5\d\d)"
    r"|\b429 Too Many Requests|too many requests|rate.?limit"
    r"|error code: 10(?:15|20)"
    r"|Archive requests require a personal token"
    r"|state at block #?\d+ is pruned|missing trie node|header not found"
    r"|error sending request|connection (?:refused|reset|closed)"
    r"|operation timed out|request timed out|max retries exceeded"
    r"|FatalExternalError|backend: failed",
    re.IGNORECASE,
)

# A bubbled revert with no reason text of its own -- forge prints only
# "EvmError: Revert" / "EvmError: FatalExternalError" in the [FAIL: ...]
# bracket, with nothing to attach as a reason -- is ambiguous from the
# bracket alone: a genuine no-message revert() and an RPC call that failed
# deep in a call trace (e.g. sharedbackend timing out mid-trace, seen on
# PR #1411's own CI run: "Failed to send/recv `basic` ... Max retries
# exceeded HTTP error 429") render identically there. Attribute it to the
# provider only when the full log also carries an explicit transport
# diagnostic outside the bracket; a real contract bug never prints one.
BARE_REVERT = re.compile(r"^(?:EvmError: )?(?:Revert|FatalExternalError)$")
TRANSPORT_DIAGNOSTIC = re.compile(
    r"sharedbackend.*?(?:Max retries exceeded|failed to send/recv)"
    r"|Max retries exceeded HTTP error \d",
    re.IGNORECASE,
)

# One reason per failing test, including multi-line reasons (forge wraps the
# provider's HTTP diagnostics inside the brackets).
reasons = re.findall(r"\[FAIL(?:: (.*?))?\] [A-Za-z_][A-Za-z0-9_]*\(", text, re.S)
if reasons:
    def is_provider_reason(r):
        if not r:
            return False
        if PROVIDER.search(r):
            return True
        return bool(BARE_REVERT.match(r.strip())) and bool(TRANSPORT_DIAGNOSTIC.search(text))

    if all(is_provider_reason(r) for r in reasons):
        print("provider")
    else:
        print("test")
elif PROVIDER.search(text):
    print("provider")
else:
    print("harness")
PY
}

# Total tests forge reports as passed across the run.
passed_count() {
  python3 - "$1" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
text = re.sub(r"\x1b\[[0-9;]*m", "", text)
m = re.findall(r"(\d+) tests? passed, \d+ failed", text)
if m:
    print(int(m[-1]))
else:
    print(sum(int(n) for n in re.findall(r"Suite result: ok\. (\d+) passed", text)))
PY
}

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
provider_failures=0

for attempt in $(seq 1 "$ATTEMPTS"); do
  ep="${ENDPOINTS[$(( (attempt - 1) % ${#ENDPOINTS[@]} ))]}"
  where="$(endpoint_label "$ep")"
  echo "[live-rpc-fork] ${LABEL}: attempt ${attempt}/${ATTEMPTS} against ${where}"

  set +e
  FORK_RPC_URL="$ep" RMPC_FORK_RPC_URL="$ep" "$FORGE_BIN" test "$@" >"$log" 2>&1
  status=$?
  set -e
  fork_rpc_redact "$ep" <"$log"

  if [ "$status" -eq 0 ]; then
    passed="$(passed_count "$log")"
    if [ "$passed" -lt 1 ]; then
      echo "::error title=Fork test harness (issue #1239)::${LABEL}: forge exited 0 but executed zero tests; a fork suite that runs nothing is not a pass."
      record harness
      exit 30
    fi
    if [ "$provider_failures" -gt 0 ]; then
      echo "::warning title=Fork RPC flake recovered (issue #1239)::${LABEL}: passed on attempt ${attempt}/${ATTEMPTS} after ${provider_failures} RPC provider failure(s). Provision a keyed Base archive RPC as the RMPC_FORK_RPC_URL Actions secret to remove this."
    fi
    echo "[live-rpc-fork] ${LABEL}: ${passed} test(s) passed"
    record passed
    exit 0
  fi

  kind="$(classify_failure "$log")"
  case "$kind" in
    test)
      echo "::error title=Fork test failure, not an RPC failure (issue #1239)::${LABEL}: at least one test failed for a reason other than the RPC provider. Treat it as a real regression; it is not retried."
      record test
      exit 10
      ;;
    harness)
      echo "::error title=Fork test harness failure (issue #1239)::${LABEL}: forge failed without reporting a failing test or an RPC error (compile or configuration problem)."
      record harness
      exit 30
      ;;
    provider)
      provider_failures=$((provider_failures + 1))
      echo "[live-rpc-fork] ${LABEL}: attempt ${attempt}/${ATTEMPTS} failed on the RPC provider (${where})"
      if [ "$attempt" -lt "$ATTEMPTS" ]; then
        wait_s=$((attempt * DELAY))
        [ "$wait_s" -eq 0 ] || sleep "$wait_s"
      fi
      ;;
  esac
done

echo "::error title=Fork RPC provider failure, not a test regression (issue #1239)::${LABEL}: every one of ${ATTEMPTS} attempts failed on the RPC provider (rate limit, pruned state or transport error), never on a test assertion. Re-run, or provision a keyed Base archive RPC as the RMPC_FORK_RPC_URL Actions secret."
record provider
exit 20
