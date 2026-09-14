#!/usr/bin/env bash
# The ONE INV-4 witness reader, shared by every Fusion acceptance harness (T10).
#
# WHY THIS FILE EXISTS
# --------------------
# `devnet-acceptance.sh` built each reading as
#   out="proposals=$("$CAST_BIN" call … 2>&1 | tr -d '[:space:]')"
# — stderr folded INTO the compared value and the exit status thrown away by the
# pipe. `assert_witnesses_unchanged` then only diffed two snapshots, so with a
# `cast` that failed every read the blocker INV-4 assertion recorded PASS with
# the detail "no allocation-state witness moved": ten failed reads, one green
# gate. A typo'd or stale FUSION_ROUTER_ADDRESS read as proof.
# `cross-repo-acceptance.sh` got the error handling right and the SCOPE wrong:
# only `totalAssets`, no `totalSupply`, and none of the accrual reasoning.
#
# THE RULES THIS FILE ENFORCES
#   1. FOUR quantities, always: RouterGovernance.currentProposalId,
#      PortfolioRouter.getWeights, and per mapped vault totalAssets AND
#      totalSupply. AC-CORE-04 names vault balances, router weights and proposal
#      count; totalSupply is what separates a share-price move from a deposit.
#   2. NO `2>&1` anywhere near a compared value. Error text must never be able to
#      become a witness that compares equal to another error text.
#   3. Every `cast call`'s exit status is checked. A read that did not answer
#      emits the $INV4_UNREADABLE_SENTINEL line and returns non-zero; callers
#      MUST treat that as a FAILED assertion, never as "nothing moved".
#
# Usage:
#   source lib/inv4.sh
#   snap="$(inv4_witnesses "$CAST_BIN" "$RPC" "$GOV" "$ROUTER" "${VAULTS[@]}")" || :
#   inv4_unreadable "$snap" && <record a FAILURE>

# A snapshot carrying this token is NOT a reading. It is the absence of one.
INV4_UNREADABLE_SENTINEL="INV4_WITNESS_UNREADABLE"

# Carried with the comparison so a one-unit drift on a yield-bearing vault is
# diagnosed rather than mistaken for a signalling-path asset movement. rmUSDC on
# devnet 918453 was measured moving 1000004 -> 1000008 over ~50 idle minutes with
# no receipt within a thousand blocks. The criterion is NOT softened: the
# comparison stays exact equality and the WINDOW is what narrows, to bracket the
# write stages only.
# shellcheck disable=SC2034  # consumed by the sourcing harnesses, not by this file
INV4_ACCRUAL_NOTE="NOTE: a mapped vault with a yield adapter accrues on its own. If the ONLY movement is a small totalAssets/totalSupply drift on a yield-bearing vault, attribute it before calling it an INV-4 breach; proposal count and router weights cannot drift and any movement there is real."

# _inv4_read <cast-bin> <rpc-url> <target> <signature>
# Echoes the whitespace-stripped value on stdout. Returns the failing exit status
# of `cast` and echoes NOTHING when the read did not answer. stderr is left
# alone so the operator sees the real transport error.
_inv4_read() {
  local cast="$1" rpc="$2" target="$3" sig="$4" out rc=0
  out="$("$cast" call "$target" "$sig" --rpc-url "$rpc")" || rc=$?
  (( rc == 0 )) || return "$rc"
  printf '%s' "$out" | tr -d '[:space:]'
}

# inv4_witnesses <cast-bin> <rpc-url> <governance> <router> <vault>...
# stdout: one `key=value` line per witness. Returns 0 only when EVERY read
# answered; otherwise prints a single sentinel line naming the unreadable
# witness and returns non-zero.
inv4_witnesses() {
  local cast="$1" rpc="$2" gov="$3" router="$4"
  shift 4
  local out="" v val rc

  if ! val="$(_inv4_read "$cast" "$rpc" "$gov" 'currentProposalId()(uint256)')"; then
    rc=$?
    printf '%s witness=proposals target=%s exit=%s\n' "$INV4_UNREADABLE_SENTINEL" "$gov" "$rc"
    return 1
  fi
  out+="proposals=$val"$'\n'

  if ! val="$(_inv4_read "$cast" "$rpc" "$router" 'getWeights()(address[],uint256[])')"; then
    rc=$?
    printf '%s witness=weights target=%s exit=%s\n' "$INV4_UNREADABLE_SENTINEL" "$router" "$rc"
    return 1
  fi
  out+="weights=$val"$'\n'

  for v in "$@"; do
    v="${v// /}"
    [[ -n "$v" ]] || continue
    if ! val="$(_inv4_read "$cast" "$rpc" "$v" 'totalAssets()(uint256)')"; then
      rc=$?
      printf '%s witness=totalAssets target=%s exit=%s\n' "$INV4_UNREADABLE_SENTINEL" "$v" "$rc"
      return 1
    fi
    out+="assets:$v=$val"$'\n'
    if ! val="$(_inv4_read "$cast" "$rpc" "$v" 'totalSupply()(uint256)')"; then
      rc=$?
      printf '%s witness=totalSupply target=%s exit=%s\n' "$INV4_UNREADABLE_SENTINEL" "$v" "$rc"
      return 1
    fi
    out+="supply:$v=$val"$'\n'
  done

  printf '%s' "$out"
}

# inv4_unreadable <snapshot>  — true when the snapshot is an absence, not a reading.
inv4_unreadable() {
  [[ "$1" == *"$INV4_UNREADABLE_SENTINEL"* || -z "${1//[[:space:]]/}" ]]
}
