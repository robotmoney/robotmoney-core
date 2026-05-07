#!/usr/bin/env bash
# Stress harness for issue #89.
#
# Runs `cargo test -p rust-payment-client --lib
# nonce::tests::racing_threads_only_one_winner` 100 times in
# succession. Exits non-zero on the first failure so CI surfaces
# a single bad iteration loudly. The matching CI job lives in
# .github/workflows/e2e-rust-ci.yml ("nonce-race-stress").
#
# Override iteration count via $RMPC_NONCE_STRESS_ITERS for ad-hoc
# investigation; defaults to 100 to satisfy the issue #89 AC.
#
# Note: AC text says `cargo test -p rmpc …`. The Cargo *package* is
# `rust-payment-client`; `rmpc` is the binary name. We invoke by
# package so the test binary is selected unambiguously.

set -euo pipefail

ITERS="${RMPC_NONCE_STRESS_ITERS:-100}"
TEST_NAME="nonce::tests::racing_threads_only_one_winner"
PKG="rust-payment-client"

# Locate repo root. Works whether invoked from repo root or from
# .github/scripts/.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CRATE_DIR="$REPO_ROOT/clients/rust-payment-client"

cd "$CRATE_DIR"

echo "stress_nonce_race: iters=$ITERS test=$TEST_NAME pkg=$PKG"

# Build the test binary once so the per-iteration loop is a pure
# execution loop (no recompile noise, no flaky build). We pass
# `--no-run` to compile then re-invoke `cargo test` with
# `--no-fail-fast` disabled so any failure exits the script.
cargo test -p "$PKG" --lib "$TEST_NAME" --no-run --quiet

failures=0
for i in $(seq 1 "$ITERS"); do
  if ! cargo test -p "$PKG" --lib "$TEST_NAME" --quiet -- --exact >/tmp/nonce_stress_iter.log 2>&1; then
    failures=$((failures + 1))
    echo "FAIL iteration $i:"
    cat /tmp/nonce_stress_iter.log
    exit 1
  fi
done

echo "stress_nonce_race: $ITERS / $ITERS passed"
exit 0
