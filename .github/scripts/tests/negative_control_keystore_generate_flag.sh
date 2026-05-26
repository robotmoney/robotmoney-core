#!/usr/bin/env bash
# Canonical: docs/testing/headless-opencode-tests.md (issue #469).
#
# Negative control: prove the broken
#     rmpc-keystore-import -- --generate
# invocation that issue #469 removed cannot silently come back.
#
# rmpc-keystore-import has NO --generate flag. argv[1] is the OUTPUT
# keystore path. The binary REQUIRES $RMPC_IMPORT_PRIVKEY_HEX and
# $RMPC_KEYSTORE_PASSPHRASE in env. On success it prints a bare 0x-address
# (NOT JSON). The historical workflow step
#
#     cargo run ... --bin rmpc-keystore-import -- --generate > agent.json
#     AGENT=$(jq -r '.address' agent.json)
#
# is broken in three independent ways:
#   1. Without $RMPC_IMPORT_PRIVKEY_HEX set, the binary exits 2 before
#      anything is written.
#   2. argv[1]="--generate" is treated as the keystore output PATH, not
#      a flag. It would try to write to a file literally called
#      "--generate" relative to the CWD.
#   3. The captured stdout is a bare address, not JSON, so `jq -r .address`
#      always fails.
#
# This script reproduces the old invocation and asserts ALL THREE failure
# signals fire. If any one of them disappears (e.g. someone adds a real
# --generate flag without updating the workflow's structured five-step
# onboarding flow), this control trips and forces an explicit decision.
#
# Exits 0 iff the broken invocation still fails as expected (negative
# control intact). Exits non-zero if any failure signal stops firing.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

# Build (or no-op if cached) the binary first so we don't conflate a build
# failure with the negative-control signal.
cargo build --release \
  --manifest-path clients/rust-payment-client/Cargo.toml \
  --bin rmpc-keystore-import >/dev/null 2>&1

BIN="${REPO_ROOT}/target/release/rmpc-keystore-import"
if [ ! -x "$BIN" ]; then
  echo "FAIL: $BIN not built" >&2
  exit 1
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR" "$REPO_ROOT/--generate"' EXIT
cd "$TMPDIR"

# Reproduce the historical broken invocation: no PRIVKEY env, argv[1]=--generate.
unset RMPC_IMPORT_PRIVKEY_HEX || true
unset RMPC_KEYSTORE_PASSPHRASE || true

set +e
STDOUT="$("$BIN" --generate 2>"$TMPDIR/stderr")"
EXIT_CODE=$?
set -e

# Signal 1: exit code is non-zero (binary refused the call).
if [ "$EXIT_CODE" -eq 0 ]; then
  echo "FAIL: rmpc-keystore-import -- --generate exited 0; negative control broken" >&2
  echo "      A new code path may have introduced an unsupported --generate flag." >&2
  echo "      Either remove it or update the suite-11b onboarding step in" >&2
  echo "      .github/workflows/suite-11b-opencode-headless.yml." >&2
  exit 1
fi

# Signal 2: stderr mentions the missing PRIVKEY env var (proves argv was not
# parsed as a flag; the binary reached the env-check).
if ! grep -q "RMPC_IMPORT_PRIVKEY_HEX" "$TMPDIR/stderr"; then
  echo "FAIL: expected stderr to reference RMPC_IMPORT_PRIVKEY_HEX, got:" >&2
  cat "$TMPDIR/stderr" >&2
  exit 1
fi

# Signal 3: the stdout is NOT valid JSON containing .address (so the old
# `jq -r .address` would always fail).
if echo "$STDOUT" | jq -e '.address' >/dev/null 2>&1; then
  echo "FAIL: stdout is now parseable as JSON with .address; negative control broken" >&2
  exit 1
fi

echo "OK: rmpc-keystore-import -- --generate still fails as expected (exit $EXIT_CODE)"
echo "OK: stderr references RMPC_IMPORT_PRIVKEY_HEX"
echo "OK: stdout is not JSON-with-.address"
