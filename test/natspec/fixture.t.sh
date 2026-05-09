#!/usr/bin/env bash
# test/natspec/fixture.t.sh
#
# Fixture test for the NatSpec coverage gate.
#
# USAGE:
#   bash test/natspec/fixture.t.sh fail   — assert gate exits non-zero when NatSpec is missing
#   bash test/natspec/fixture.t.sh pass   — assert gate exits 0 when NatSpec is present
#
# HOW IT WORKS
# 1. Creates a temporary copy of an in-scope contract (MockUSDC.sol).
# 2. Injects a bare public function (no NatSpec) or a documented one.
# 3. Runs scripts/natspec/check.sh against the temp file.
# 4. Asserts the expected exit code.
# 5. Cleans up the temp file unconditionally.
#
# This test proves that the CI gate actually enforces the NatSpec rule —
# it would be worthless if a gate that always exits 0 were accepted.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHECKER="${REPO_ROOT}/scripts/natspec/check.sh"
SOURCE_TEMPLATE="${REPO_ROOT}/contracts/gateway/MockUSDC.sol"

MODE="${1:-}"
if [[ "$MODE" != "fail" && "$MODE" != "pass" ]]; then
  echo "Usage: $0 fail|pass" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Build a temp file that is a copy of MockUSDC with an extra function appended
# ---------------------------------------------------------------------------
TMPFILE="$(mktemp /tmp/NatSpecFixture_XXXXXX.sol)"
trap 'rm -f "$TMPFILE"' EXIT

cp "$SOURCE_TEMPLATE" "$TMPFILE"

if [[ "$MODE" == "fail" ]]; then
  # Append a bare public function — NatSpec checker must flag this.
  # Strip the final closing brace and re-add it after the new function.
  # We use head -n -1 to remove the last line (the closing `}`) and then append.
  CONTENT=$(head -n -1 "$TMPFILE")
  printf '%s\n' "$CONTENT" > "$TMPFILE"
  cat >> "$TMPFILE" <<'SOL'

    function noDocs() external pure returns (uint256) { return 42; }
}
SOL

  echo "=== Fixture mode: FAIL (bare function, no @notice) ==="
  echo "Expect: non-zero exit from scripts/natspec/check.sh"

  # Run the checker against only the temp file (bypass the scope list)
  if bash "$CHECKER" "$TMPFILE" 2>&1; then
    echo "FAIL: checker returned 0 — gate did NOT catch missing NatSpec" >&2
    exit 1
  else
    echo "PASS: checker returned non-zero — gate correctly rejected missing NatSpec"
  fi

else
  # MODE == pass
  # Append a fully-documented public function.
  CONTENT=$(head -n -1 "$TMPFILE")
  printf '%s\n' "$CONTENT" > "$TMPFILE"
  cat >> "$TMPFILE" <<'SOL'

    /// @notice Example fixture function with complete NatSpec.
    /// @return value Always returns 42 (fixture only).
    function withDocs() external pure returns (uint256 value) { return 42; }
}
SOL

  echo "=== Fixture mode: PASS (documented function) ==="
  echo "Expect: zero exit from scripts/natspec/check.sh"

  if bash "$CHECKER" "$TMPFILE" 2>&1; then
    echo "PASS: checker returned 0 — gate correctly accepted complete NatSpec"
  else
    echo "FAIL: checker returned non-zero — gate rejected a fully-documented function" >&2
    exit 1
  fi
fi
