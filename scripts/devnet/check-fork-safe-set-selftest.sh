#!/usr/bin/env bash
# Offline behaviour self-test for scripts/devnet/check-fork-safe-set.sh.
#
# Canonical: docs/technical/governance-isomorphism.md §4.1 R3.
# Issue: #1447.
#
# R3 exists because the two Safe contracts the fixture carried were there by
# accident; a guard that is never exercised would be the same accident one
# level up. Drives the helper against state files built from the committed
# fixture's five Safe accounts (read only, never written) — no network, no
# Docker:
#
#   all five canonical, singletons locked    -> exit 0
#   SafeL2 absent                            -> exit 14, names SafeL2
#   MultiSend present, no code               -> exit 14, names MultiSend
#   SafeL2 carrying other code (the L1 one)  -> exit 14, names its code hash
#   one byte of the factory's code changed   -> exit 14, names its code hash
#   SafeL2 singleton unlocked (no slot 4)    -> exit 14, names the lock
#   L1 singleton slot 4 = 2, not 1           -> exit 14, names the lock
#   not a dump-state file                    -> exit 2
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="$REPO_ROOT/scripts/devnet/check-fork-safe-set.sh"
FIXTURE="$REPO_ROOT/testing/fixtures/fork-state/CURRENT.anvil-state"

WORKDIR="$(mktemp -d -t fork-safe-set-selftest.XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

FAILURES=0
ALL='["0x41675c099f32341bf84bfc5382af534df5c7461a","0x29fcb43b46531bca003ddc8fcb67ffe91900c762","0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67","0xfd0732dc9e303f09fcef3a7388ad10a83459ec99","0x38869bf66a61cf6bdb996a6ae40d5853fd43b526"]'
L1=0x41675c099f32341bf84bfc5382af534df5c7461a
L2=0x29fcb43b46531bca003ddc8fcb67ffe91900c762
FACTORY=0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67
SLOT4=0x0000000000000000000000000000000000000000000000000000000000000004

# The five real accounts, code and storage as the committed fixture has them.
jq --argjson all "$ALL" '{accounts: (.accounts | with_entries(select(.key as $k | $all | index($k))))}' \
  "$FIXTURE" >"$WORKDIR/base.json"

# write_state <path> <jq-filter-applied-to-the-five-account-state>
write_state() {
  jq "$2" "$WORKDIR/base.json" > "$1"
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
run_case "all five canonical, singletons locked" 0 "all 5 canonical Safe contracts present" "$WORKDIR/full.json"

write_state "$WORKDIR/no-l2.json" "del(.accounts[\"$L2\"])"
run_case "SafeL2 absent" 14 "SafeL2 singleton" "$WORKDIR/no-l2.json"

write_state "$WORKDIR/empty-multisend.json" '.accounts["0x38869bf66a61cf6bdb996a6ae40d5853fd43b526"].code = "0x"'
run_case "MultiSend code-less" 14 "MultiSend" "$WORKDIR/empty-multisend.json"

# Present and non-empty is what the old gate checked; the wrong contract passed it.
write_state "$WORKDIR/l2-wrong-code.json" ".accounts[\"$L2\"].code = .accounts[\"$L1\"].code"
run_case "SafeL2 carrying the L1 singleton's code" 14 "not the canonical v1.4.1 code hash" "$WORKDIR/l2-wrong-code.json"

write_state "$WORKDIR/factory-flipped.json" ".accounts[\"$FACTORY\"].code |= (.[0:-2] + (if .[-2:] == \"00\" then \"01\" else \"00\" end))"
run_case "one byte of the factory's code changed" 14 "SafeProxyFactory $FACTORY hashes to" "$WORKDIR/factory-flipped.json"

write_state "$WORKDIR/l2-unlocked.json" ".accounts[\"$L2\"].storage = {}"
run_case "SafeL2 singleton unlocked" 14 "SafeL2 singleton $L2 is unlocked" "$WORKDIR/l2-unlocked.json"

write_state "$WORKDIR/l1-slot4-2.json" ".accounts[\"$L1\"].storage[\"$SLOT4\"] = \"0x0000000000000000000000000000000000000000000000000000000000000002\""
run_case "L1 singleton threshold slot 2, not 1" 14 "Safe singleton (L1) $L1 is unlocked" "$WORKDIR/l1-slot4-2.json"

echo '{"not":"a dump"}' > "$WORKDIR/garbage.json"
run_case "not a dump-state file" 2 "not a readable anvil" "$WORKDIR/garbage.json"

if [ "$FAILURES" -gt 0 ]; then
  echo "check-fork-safe-set selftest: $FAILURES failure(s)" >&2
  exit 1
fi
echo "check-fork-safe-set selftest: all cases passed"
