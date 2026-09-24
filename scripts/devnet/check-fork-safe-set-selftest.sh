#!/usr/bin/env bash
# Offline behaviour self-test for scripts/devnet/check-fork-safe-set.sh.
#
# Canonical: docs/technical/governance-isomorphism.md §4.1 R3.
# Issue: #1447.
#
# R3 exists because the two Safe contracts the fixture carried were there by
# accident; a guard that is never exercised would be the same accident one
# level up. Drives the helper against synthetic state files — no network, no
# Docker, the real fixture untouched:
#
#   all five present            -> exit 0
#   SafeL2 absent               -> exit 14, names SafeL2
#   MultiSend present, no code  -> exit 14, names MultiSend
#   not a dump-state file       -> exit 2
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="$REPO_ROOT/scripts/devnet/check-fork-safe-set.sh"

WORKDIR="$(mktemp -d -t fork-safe-set-selftest.XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

FAILURES=0
ALL='["0x41675c099f32341bf84bfc5382af534df5c7461a","0x29fcb43b46531bca003ddc8fcb67ffe91900c762","0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67","0xfd0732dc9e303f09fcef3a7388ad10a83459ec99","0x38869bf66a61cf6bdb996a6ae40d5853fd43b526"]'

# write_state <path> <jq-filter-applied-to-the-full-set>
write_state() {
  jq -n --argjson all "$ALL" "{accounts: (\$all | map({key: ., value: {code: \"0x6080\", storage: {}}}) | from_entries)} | $2" > "$1"
}

# run_case <name> <expected-exit> <expected-substring-or-EMPTY> <state-file>
run_case() {
  local name="$1" want_exit="$2" want_text="$3" state="$4"
  local out rc=0
  out="$("$HELPER" "$state" 2>&1)" || rc=$?
  if [ "$rc" -ne "$want_exit" ]; then
    echo "FAIL [$name]: exit $rc, expected $want_exit" >&2
    echo "$out" | sed 's/^/    /' >&2
    FAILURES=$((FAILURES + 1))
    return
  fi
  if [ -n "$want_text" ] && ! printf '%s' "$out" | grep -qF -- "$want_text"; then
    echo "FAIL [$name]: output did not contain '$want_text'" >&2
    echo "$out" | sed 's/^/    /' >&2
    FAILURES=$((FAILURES + 1))
    return
  fi
  echo "  ok: $name"
}

write_state "$WORKDIR/full.json" '.'
run_case "all five present" 0 "all 5 canonical Safe contracts present" "$WORKDIR/full.json"

write_state "$WORKDIR/no-l2.json" 'del(.accounts["0x29fcb43b46531bca003ddc8fcb67ffe91900c762"])'
run_case "SafeL2 absent" 14 "SafeL2 singleton" "$WORKDIR/no-l2.json"

write_state "$WORKDIR/empty-multisend.json" '.accounts["0x38869bf66a61cf6bdb996a6ae40d5853fd43b526"].code = "0x"'
run_case "MultiSend code-less" 14 "MultiSend" "$WORKDIR/empty-multisend.json"

echo '{"not":"a dump"}' > "$WORKDIR/garbage.json"
run_case "not a dump-state file" 2 "not a readable anvil" "$WORKDIR/garbage.json"

if [ "$FAILURES" -gt 0 ]; then
  echo "check-fork-safe-set selftest: $FAILURES failure(s)" >&2
  exit 1
fi
echo "check-fork-safe-set selftest: all cases passed"
