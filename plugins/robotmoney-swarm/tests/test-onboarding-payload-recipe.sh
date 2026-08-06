#!/usr/bin/env bash
# test-onboarding-payload-recipe.sh — proves the swarm-onboarding SKILL.md
# canonical application-payload recipe (Step 3) actually produces a
# well-formed payload when followed literally, using the REAL rmpc binary.
#
# WHY THIS EXISTS (issue #1193 Finding 2, compliance re-review of PR #1194)
# run-tests.sh's onboarding_contains() checks only that SKILL.md's prose
# CONTAINS certain strings — never that following the recipe those strings
# describe actually works. That gap is exactly how the root-cause bug
# shipped undetected despite "43 passed, 0 failed": `rmpc committee-identity
# show-public-key` and `rmpc committee-identity sign` always print a JSON
# envelope on stdout — e.g. {"ok":true,"public_key":"<base64>"} — never a
# bare value. An earlier revision of the recipe captured that stdout
# straight into a shell variable with no extraction step, so the resulting
# application payload carried the stringified JSON envelope as `publicKey`
# instead of the real base64 key, and likewise for `signature`.
#
# This script builds the real rmpc binary, runs the literal recipe
# (identity create -> show-public-key -> extract -> build canonical
# payload -> sign -> extract) exactly as SKILL.md Step 3 documents, and
# asserts the resulting publicKey/signature fields are well-formed base64
# — the exact property that was broken.
#
# TEST-COVERAGE POLICY (loud-skip, never silent-skip; exit 0 != tested):
# cargo and node are HARD requirements. Absent either, this suite FAILS —
# it never prints "SKIP" and exits 0.
#
# WHY NOT A clients/rust-payment-client/tests/*.rs INTEGRATION TEST:
# run-tests.sh's own "no restricted paths touched" check (below, section 3)
# asserts that a PR touching plugins/robotmoney-swarm/** does NOT also
# modify clients/rust-payment-client/ — so adding a tracked test file there
# is not available to this plugin's changes. Building the binary from its
# existing, unmodified Cargo.toml does not trip that guard (cargo writes
# only to the gitignored target/ directory); only editing tracked files
# under clients/rust-payment-client/ would.
#
# WHAT THIS DOES NOT COVER: actually POSTing to /api/swarm/apply and
# asserting a 201. The server implementing that endpoint lives in the
# separate robotmoney-frontend repository, which is not checked out here
# and has no reachable demo/mock instance in this repo or in this suite's
# CI job — so the live-submission leg of the flow is not locally
# verifiable from robotmoney-core. The base64-format assertions below are
# the part that was actually broken (issue #1193 Finding 1) and are
# exercised in full against the real binary.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"
ONBOARDING_SKILL="$PLUGIN_DIR/skills/swarm-onboarding/SKILL.md"

MIN_EXPECTED_ASSERTIONS=12

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

require_tool() {
  local tool="$1" why="$2"
  if ! command -v "$tool" &>/dev/null; then
    echo "FATAL: required tool '$tool' is not installed ($why)." >&2
    echo "       Refusing to skip — this suite fails closed on a missing" >&2
    echo "       prerequisite rather than silently asserting nothing." >&2
    exit 1
  fi
}

echo "=== swarm-onboarding canonical payload recipe: end-to-end proof (real rmpc) ==="
echo ""
echo "--- prerequisites (hard requirements, never skipped) ---"
require_tool cargo "builds the real rmpc binary this test exercises"
require_tool node  "runs the payload-construction/extraction steps, exactly as SKILL.md documents"
echo "  OK: cargo, node present"

test -f "$ONBOARDING_SKILL" || { echo "FATAL: $ONBOARDING_SKILL not found." >&2; exit 1; }

# ---------- 0. drift guard: the extraction logic run below must match,
# verbatim, what SKILL.md Step 3 documents. If someone edits the skill's
# recipe without updating this test (or vice versa), this fails loudly
# instead of the two silently diverging. ----------
echo ""
echo "--- test: this script's rmpc-output extraction matches SKILL.md verbatim ---"
PUBKEY_EXTRACT_SNIPPET='JSON.parse(require("fs").readFileSync(0,"utf8")).public_key'
SIG_EXTRACT_SNIPPET='JSON.parse(require("fs").readFileSync(0,"utf8")).signature'
if grep -Fq "$PUBKEY_EXTRACT_SNIPPET" "$ONBOARDING_SKILL"; then
  pass "SKILL.md documents the same public_key JSON-extraction expression this test runs"
else
  fail "SKILL.md no longer contains the public_key extraction expression this test runs — recipe and test have drifted"
fi
if grep -Fq "$SIG_EXTRACT_SNIPPET" "$ONBOARDING_SKILL"; then
  pass "SKILL.md documents the same signature JSON-extraction expression this test runs"
else
  fail "SKILL.md no longer contains the signature extraction expression this test runs — recipe and test have drifted"
fi

# ---------- 1. build (or reuse) the real rmpc binary ----------
echo ""
echo "--- build: real rmpc binary ---"
if [[ -n "${RMPC_BIN:-}" ]]; then
  RMPC="$RMPC_BIN"
  echo "  using pre-built rmpc at $RMPC (RMPC_BIN set)"
else
  echo "  cargo build --manifest-path clients/rust-payment-client/Cargo.toml --bin rmpc"
  cargo build --manifest-path "$REPO_ROOT/clients/rust-payment-client/Cargo.toml" --bin rmpc
  RMPC="$REPO_ROOT/target/debug/rmpc"
fi
if [[ -x "$RMPC" ]]; then
  pass "rmpc binary is built and executable at $RMPC"
else
  fail "rmpc binary not found/executable at $RMPC after build"
  echo "FATAL: cannot continue without a working rmpc binary." >&2
  exit 1
fi

# ---------- 2. run the literal recipe in a scratch dir ----------
WORKDIR="$(mktemp -d)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

PASSPHRASE_FOR_TEST="test-onboarding-recipe-$(date +%s)-$$"
export RMPC_COMMITTEE_IDENTITY_PASSPHRASE="$PASSPHRASE_FOR_TEST"

echo ""
echo "--- recipe step: rmpc committee-identity create ---"
if ( cd "$WORKDIR" && "$RMPC" committee-identity --path ./robotmoney-identity.json create >/dev/null ); then
  pass "rmpc committee-identity create succeeded"
else
  fail "rmpc committee-identity create failed"
  exit 1
fi

echo ""
echo "--- regression sentinel: rmpc's raw show-public-key stdout is a JSON envelope, not a bare value ---"
RAW_SHOW_PUBKEY="$(cd "$WORKDIR" && "$RMPC" committee-identity --path ./robotmoney-identity.json show-public-key)"
if [[ "$RAW_SHOW_PUBKEY" == \{*ok*public_key*\} ]]; then
  pass "raw show-public-key stdout is a JSON envelope (confirms issue #1193 Finding 1's premise: a bare capture would be wrong)"
else
  fail "raw show-public-key stdout is not the expected JSON envelope shape: $RAW_SHOW_PUBKEY (if rmpc's output format changed, SKILL.md Step 3 must be re-checked)"
fi

echo ""
echo "--- recipe step: extract publicKey via node (SKILL.md Step 3) ---"
RM_NAME='Nova Desk'
RM_CONTACT='nova@example.com'
RM_PUBLIC_KEY="$(cd "$WORKDIR" && "$RMPC" committee-identity --path ./robotmoney-identity.json show-public-key \
  | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).public_key)')"

if [[ -n "$RM_PUBLIC_KEY" ]]; then
  pass "extracted a non-empty RM_PUBLIC_KEY"
else
  fail "extracted RM_PUBLIC_KEY is empty"
fi

if [[ "$RM_PUBLIC_KEY" != \{* ]]; then
  pass "RM_PUBLIC_KEY is not a JSON blob (does not start with '{')"
else
  fail "RM_PUBLIC_KEY still looks like a JSON blob: $RM_PUBLIC_KEY — the exact issue #1193 Finding 1 bug"
fi

PUBKEY_DECODED_LEN="$(node -e '
const b = Buffer.from(process.argv[1], "base64");
const roundtrip = b.toString("base64") === process.argv[1];
if (!roundtrip) { process.stderr.write("not valid base64 (does not round-trip)\n"); process.exit(1); }
process.stdout.write(String(b.length));
' "$RM_PUBLIC_KEY")"
if [[ "$PUBKEY_DECODED_LEN" == "32" ]]; then
  pass "RM_PUBLIC_KEY is well-formed base64 decoding to 32 bytes (Ed25519 public key length)"
else
  fail "RM_PUBLIC_KEY decodes to $PUBKEY_DECODED_LEN bytes, expected 32 (Ed25519 public key length)"
fi

echo ""
echo "--- recipe step: build the canonical application payload (SKILL.md Step 3 node heredoc) ---"
( cd "$WORKDIR" && RM_NAME="$RM_NAME" RM_CONTACT="$RM_CONTACT" RM_PUBLIC_KEY="$RM_PUBLIC_KEY" node - <<'NODE'
const fs = require('node:fs');
const { RM_NAME: name, RM_CONTACT: contact, RM_LENS: lens, RM_PUBLIC_KEY: publicKey } = process.env;
const payload = { name, contact };
if (lens !== undefined && lens !== '') payload.lens = lens;
payload.publicKey = publicKey;
fs.writeFileSync('./application-payload.bin', JSON.stringify(payload), 'utf8');
NODE
)

PAYLOAD_FILE="$WORKDIR/application-payload.bin"
if [[ -s "$PAYLOAD_FILE" ]]; then
  pass "application-payload.bin was written and is non-empty"
else
  fail "application-payload.bin was not written or is empty"
  exit 1
fi

LAST_BYTE="$(tail -c1 "$PAYLOAD_FILE" | od -An -tx1 | tr -d ' \n')"
if [[ "$LAST_BYTE" != "0a" ]]; then
  pass "application-payload.bin has no trailing newline"
else
  fail "application-payload.bin ends in a newline (0x0a) — rmpc signs exact bytes, so this would produce a signature over the wrong bytes"
fi

PAYLOAD_JSON="$(cat "$PAYLOAD_FILE")"
EXPECTED_PAYLOAD='{"name":"Nova Desk","contact":"nova@example.com","publicKey":"'"$RM_PUBLIC_KEY"'"}'
if [[ "$PAYLOAD_JSON" == "$EXPECTED_PAYLOAD" ]]; then
  pass "application-payload.bin bytes match the documented compact-JSON, no-lens shape exactly (name, contact, publicKey order)"
else
  fail "application-payload.bin does not match the expected canonical shape.
    expected: $EXPECTED_PAYLOAD
    actual:   $PAYLOAD_JSON"
fi

echo ""
echo "--- recipe step: sign the payload and extract signature via node (SKILL.md Step 3) ---"
RM_SIGNATURE="$(cd "$WORKDIR" && "$RMPC" committee-identity --path ./robotmoney-identity.json sign --payload-file ./application-payload.bin \
  | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).signature)')"

if [[ -n "$RM_SIGNATURE" ]]; then
  pass "extracted a non-empty RM_SIGNATURE"
else
  fail "extracted RM_SIGNATURE is empty"
fi

if [[ "$RM_SIGNATURE" != \{* ]]; then
  pass "RM_SIGNATURE is not a JSON blob (does not start with '{')"
else
  fail "RM_SIGNATURE still looks like a JSON blob: $RM_SIGNATURE — the exact issue #1193 Finding 1 bug"
fi

SIG_DECODED_LEN="$(node -e '
const b = Buffer.from(process.argv[1], "base64");
const roundtrip = b.toString("base64") === process.argv[1];
if (!roundtrip) { process.stderr.write("not valid base64 (does not round-trip)\n"); process.exit(1); }
process.stdout.write(String(b.length));
' "$RM_SIGNATURE")"
if [[ "$SIG_DECODED_LEN" == "64" ]]; then
  pass "RM_SIGNATURE is well-formed base64 decoding to 64 bytes (Ed25519 signature length)"
else
  fail "RM_SIGNATURE decodes to $SIG_DECODED_LEN bytes, expected 64 (Ed25519 signature length)"
fi

echo ""
echo "--- verification: signature verifies against the extracted public key over the exact payload bytes ---"
VERIFY_OK="$(node -e '
const nacl_verify = (() => {
  // Minimal Ed25519 verification via Node crypto (supported since Node 12+
  // through the "ed25519" OID / raw key import path added in Node 12+; use
  // the Web Crypto-compatible KeyObject API available in Node 16+).
  const crypto = require("crypto");
  return function verify(pubKeyB64, sigB64, message) {
    const pubKeyRaw = Buffer.from(pubKeyB64, "base64");
    const der = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      pubKeyRaw,
    ]);
    const keyObject = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return crypto.verify(null, message, keyObject, Buffer.from(sigB64, "base64"));
  };
})();
const fs = require("fs");
const message = fs.readFileSync(process.argv[3]);
const ok = nacl_verify(process.argv[1], process.argv[2], message);
process.stdout.write(ok ? "true" : "false");
' "$RM_PUBLIC_KEY" "$RM_SIGNATURE" "$PAYLOAD_FILE")"

if [[ "$VERIFY_OK" == "true" ]]; then
  pass "signature cryptographically verifies against the extracted public key over the exact payload bytes"
else
  fail "signature does NOT verify against the extracted public key over the payload bytes"
fi

# ---------- not covered here, and why ----------
echo ""
echo "--- NOT covered by this suite: POST /api/swarm/apply live submission ---"
echo "  The server implementing /api/swarm/apply lives in the separate"
echo "  robotmoney-frontend repository, not checked out here, and no"
echo "  reachable demo/mock instance exists in this repo or this suite's CI"
echo "  job. The base64-format properties asserted above are the part that"
echo "  was actually broken (issue #1193 Finding 1) and are fully exercised"
echo "  against the real rmpc binary."

# ---------- summary ----------
echo ""
TOTAL=$((PASS + FAIL))
echo "=== Results: $PASS passed, $FAIL failed ==="
echo "ROBOTMONEY_SWARM_ONBOARDING_RECIPE_TESTS_EXECUTED=$TOTAL"

if [[ $TOTAL -lt $MIN_EXPECTED_ASSERTIONS ]]; then
  echo "FATAL: only $TOTAL assertions executed, expected at least $MIN_EXPECTED_ASSERTIONS." >&2
  echo "       Zero (or too few) executed assertions is a false green — failing." >&2
  exit 1
fi

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
