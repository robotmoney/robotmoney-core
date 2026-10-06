#!/usr/bin/env bash
# Canonical: issue #1487 (S5, one deployment scheme) — one script links a vault to its registry.
# Fails (exit 1) when the name of the set-once registry link call appears under contracts/script or
# scripts anywhere except contracts/script/DeployTimelock.s.sol. Exit 0 when there is no such hit.
# The name is built from parts so this file never matches itself.
# `--selftest` plants a hit in a scratch tree and requires the check to fail on it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
name="set""Registry"
owner="contracts/script/DeployTimelock.s.sol"

# check <base-dir>: print each hit outside the owner, return 1 if there is any.
check() {
  local base="$1" hits
  hits="$(cd "$base" && grep -rInF --exclude-dir=node_modules --exclude-dir=lib --exclude-dir=out \
      --exclude-dir=cache -- "$name" contracts/script scripts 2>/dev/null | grep -v "^$owner:" || true)"
  if [[ -n "$hits" ]]; then
    echo "$hits"
    echo "::error::$name is called outside $owner" >&2
    return 1
  fi
}

if [[ "${1:-}" == "--selftest" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/contracts/script" "$tmp/scripts/stage"
  echo "x.$name(y);" >"$tmp/contracts/script/DeployTimelock.s.sol"
  check "$tmp" >/dev/null 2>&1 || { echo "selftest: the owner file alone must pass" >&2; exit 1; }
  echo "x.$name(y);" >"$tmp/scripts/stage/planted.sh"
  if check "$tmp" >/dev/null 2>&1; then
    echo "selftest: a planted call outside the owner was not caught" >&2
    exit 1
  fi
  echo "selftest ok"
  exit 0
fi

check "$root"
