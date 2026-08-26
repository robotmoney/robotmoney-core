#!/usr/bin/env bash
# check-tracked-path-charset.sh — repo-wide tracked-filename charset guard.
#
# Canonical docs: docs/development/ci-suites.md §13 (job `tracked-path-charset`)
#                 CLAUDE.md § Filenames
# Feature work:   issue #1252 (decision comment), origin issue #1232 / PR #1234
#
# ============================================================================
# WHAT THIS GUARD ASSERTS
# ============================================================================
# Every path tracked by git in this repository is written using the printable
# ASCII bytes 0x20-0x7e, excluding the two quoting bytes `"` (0x22) and `\`
# (0x5c).
#
# That is exactly the set git's `core.quotePath` machinery would C-quote:
# non-ASCII bytes, control bytes (tab, newline, DEL), the double quote and the
# backslash. A path outside that set is emitted by `git ls-files`,
# `git diff --name-only`, `git status` and friends as a *quoted* string —
#
#     "contracts/caf\303\251.sol"
#
# — with a leading `"`. Every anchored path regex in this repo then stops
# matching, silently. That is not hypothetical: issue #1252 reproduced it
# against the restricted-path coupling guard added by PR #1234, where a branch
# touching `plugins/robotmoney-swarm/**` together with `contracts/café.sol`
# exited 0 and reported no violation, while the same branch with the file
# renamed to `contracts/plain.sol` correctly exited 1.
#
# ============================================================================
# WHY REJECT THE FILENAME INSTEAD OF TEACHING EVERY PARSER TO SURVIVE IT
# ============================================================================
# The parsers' assumption — that tracked paths are plain ASCII — is *correct
# for this repo*. It simply was not enforced, so each parser silently depended
# on a convention nothing checked. Teaching one parser to unquote a path we
# would reject on sight in review leaves the convention unenforced and the next
# parser exposed.
#
# Enforcing it costs no migration. At the time this guard landed:
#
#     $ git ls-files | LC_ALL=C grep -cP '[^\x20-\x7e]'
#     0
#
# So this pins the state the repo is already in and closes the class rather
# than one instance. (Issue #1252's decision comment; it supersedes that
# issue's original body, which proposed the parser-side fix.)
#
# ============================================================================
# WHY THE MATCH IS PURE BASH — NO grep -P, NO grep -z, NO tr RANGES
# ============================================================================
# The obvious spelling is `git ls-files -z | LC_ALL=C grep -zqP '[^\x20-\x7e]'`.
# Both of those grep flags are non-POSIX extensions, and this repo has shipped
# nine defects whose shape is "a check that silently did nothing":
#
#   - `grep -P` is absent from any GNU grep built --disable-perl-regexp, and
#     from busybox grep.
#   - `-z` is worse than absent elsewhere: under ugrep — which some contributor
#     environments install *as* `grep` — `-z` means `--decompress`, not
#     `--null-data`. The same command line then means something entirely
#     different from what it means on a GNU-grep runner, with no error.
#
# So the byte test is done by bash itself, against a literal 93-character
# allowed-set string, with `LC_ALL=C` so ranges and string lengths are byte
# semantics. It shells out to nothing, takes no flags, and therefore has no
# flag that can be unsupported. `git ls-files -z` is the only external
# dependency, and the self-test drives it end to end.
#
# ============================================================================
# WHY THE SELF-TEST RUNS FIRST, ALWAYS
# ============================================================================
# A guard that cannot fail is a green light. The default invocation runs the
# negative self-test *before* the real scan and refuses to scan at all if the
# self-test does not go red on its fixtures — so no caller, in CI or on a
# laptop, can obtain a PASS from this script without the script first proving,
# on that machine, that it is able to emit a FAIL. This is the same shape as
# `scripts/validate-seam-map --self-test` and
# `plugins/robotmoney-swarm/tests/check-restricted-paths.sh --self-test`.
#
# Nothing here is silenced. An input this script cannot trust — not a git work
# tree, or a work tree with zero tracked files — exits 2 with a named reason
# rather than printing a PASS it cannot justify.
#
# Usage:
#   check-tracked-path-charset.sh              self-test, then scan this repo
#   check-tracked-path-charset.sh --self-test  prove the guard can go red, then stop
#   check-tracked-path-charset.sh --check-only scan without the self-test
#   check-tracked-path-charset.sh --repo DIR   scan DIR instead of this repo
#
# Exit codes:
#   0  every tracked path is within the allowed byte set
#   1  at least one tracked path is outside it (the paths are named)
#   2  the guard could not run (not a work tree, empty listing, bad usage,
#      or the self-test failed)
set -euo pipefail

# Byte semantics, not locale semantics: ${#s}, ${s:i:1} and pattern ranges must
# count bytes so that a multi-byte UTF-8 sequence cannot be folded into a single
# "character" that happens to compare equal to something allowed.
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The allowed bytes, spelled out literally: 0x20-0x7e minus `"` (0x22) and
# `\` (0x5c). Written as a literal rather than a range so that no bracket-range
# collation rule, in any locale, can widen or narrow it. Length is asserted
# below — a fat-finger that drops or adds a byte is a hard error, not a quietly
# different guard.
ALLOWED=' !#$%&'"'"'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~'
ALLOWED_COUNT=93  # (0x7e - 0x20 + 1) - 2

if [[ ${#ALLOWED} -ne $ALLOWED_COUNT ]]; then
  echo "ERROR: the allowed-byte set is ${#ALLOWED} bytes, expected ${ALLOWED_COUNT}." >&2
  echo "       Someone edited ALLOWED without editing ALLOWED_COUNT. Refusing to run" >&2
  echo "       a charset guard whose charset is not the one it documents." >&2
  exit 2
fi

# path_is_allowed — 0 when every byte of "$1" is in ALLOWED, 1 otherwise.
# Deleting every allowed byte must leave the empty string.
path_is_allowed() {
  [[ -z "${1//["$ALLOWED"]/}" ]]
}

# evaluate_listing — reads a NUL-delimited path list from the file named by $1.
# Returns 0 when every path is allowed, 1 when any is not (naming them).
# Exits 2 when the listing is empty, which is never a legitimate input: an empty
# listing is the shape a broken `git ls-files` takes, and it must not buy a PASS.
evaluate_listing() {
  local listing="$1" path count=0 bad=()

  while IFS= read -r -d '' path; do
    count=$((count + 1))
    path_is_allowed "$path" || bad+=("$path")
  done <"$listing"

  if [[ $count -eq 0 ]]; then
    echo "ERROR: the tracked-path listing is empty." >&2
    echo "       A charset guard over zero paths is vacuously green, which is the" >&2
    echo "       exact failure mode this repo keeps shipping — so it fails instead." >&2
    exit 2
  fi

  if [[ ${#bad[@]} -gt 0 ]]; then
    echo "ERROR: ${#bad[@]} tracked path(s) contain a byte outside the allowed set." >&2
    echo "       Allowed: printable ASCII 0x20-0x7e, excluding \" and \\." >&2
    echo "       Anything else is C-quoted by git, which breaks every anchored" >&2
    echo "       path regex in this repo (issue #1252). Rename the file(s):" >&2
    # %q renders non-printable bytes as $'\303\251' rather than dumping raw
    # bytes into the CI log.
    printf '         %q\n' "${bad[@]}" >&2
    return 1
  fi

  echo "PASS: all ${count} tracked paths use printable ASCII (no quoting bytes)."
  return 0
}

# scan_repo — list the tracked paths of the work tree at $1 and evaluate them.
scan_repo() {
  local root="$1" listing

  if ! git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "ERROR: ${root} is not a git work tree." >&2
    echo "       The tracked-path charset guard has no input it can trust — failing" >&2
    echo "       loudly rather than reporting a PASS." >&2
    exit 2
  fi

  listing="$(mktemp)"
  # -z is git's own NUL-delimited output: raw bytes, never quoted, one path per
  # NUL. core.quotePath is forced off as well so the setting cannot matter.
  if ! git -C "$root" -c core.quotePath=false ls-files -z >"$listing"; then
    rm -f "$listing"
    echo "ERROR: git ls-files failed in ${root} — the guard cannot determine its input." >&2
    exit 2
  fi

  local rc=0
  evaluate_listing "$listing" || rc=$?
  rm -f "$listing"
  return "$rc"
}

# ---------------------------------------------------------------------------
# self-test
# ---------------------------------------------------------------------------

# fixture_repo — build a throwaway git work tree at $1 tracking the paths given
# in $2.. . Only `git add` is used, so no commit and no user identity is needed;
# `git ls-files` reads the index. The fixture lives under mktemp -d, never
# inside this repository, so a fixture filename can never become a tracked path
# here (which would make the guard fail on itself).
fixture_repo() {
  local dir="$1" rel
  shift
  mkdir -p "$dir"
  git -C "$dir" init -q
  for rel in "$@"; do
    mkdir -p "$dir/$(dirname "$rel")"
    : >"$dir/$rel"
  done
  git -C "$dir" add -A -- . >/dev/null 2>&1
}

# run_scan — run scan_repo in a subshell so its `exit 2` cannot kill the
# self-test, capturing combined output. Echoes the exit code.
SELF_TEST_OUT=""
run_scan() {
  local rc=0
  SELF_TEST_OUT="$( ( scan_repo "$1" ) 2>&1 )" || rc=$?
  return "$rc"
}

self_test() {
  local ok=0 tmp rc

  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $tmp now, at trap-install time
  trap "rm -rf '$tmp'" EXIT

  # (1) NEGATIVE FIXTURE — the reproduction from issue #1252 verbatim: a tracked
  #     path with a non-ASCII byte. This is the case the guard exists for, and
  #     it drives the whole pipeline (git ls-files -z -> bash byte test), so a
  #     `git ls-files` that stopped emitting raw bytes would be caught here too.
  echo "[self-test] a tracked non-ASCII path (contracts/café.sol) must FAIL"
  fixture_repo "$tmp/non-ascii" 'contracts/plain.sol' $'contracts/caf\xc3\xa9.sol'
  rc=0
  run_scan "$tmp/non-ascii" || rc=$?
  if [[ $rc -eq 1 ]] && [[ "$SELF_TEST_OUT" == *'contracts/caf'* ]]; then
    echo "[self-test] OK: non-ASCII path rejected and named."
  else
    echo "[self-test] FAIL: non-ASCII path scan exited $rc (expected 1) or did not name" >&2
    echo "           the offending path — the guard cannot detect what it exists to detect." >&2
    printf '%s\n' "$SELF_TEST_OUT" >&2
    ok=1
  fi

  # (2) NEGATIVE FIXTURES — the quoting bytes and the control bytes. git C-quotes
  #     each of these too, so each one breaks an anchored regex exactly the same
  #     way a non-ASCII byte does.
  local label fixture
  local -a cases=(
    'double quote'    $'contracts/a"b.sol'
    'backslash'       'contracts/a\b.sol'
    'tab'             $'contracts/a\tb.sol'
    'newline'         $'contracts/a\nb.sol'
    'DEL (0x7f)'      $'contracts/a\x7fb.sol'
  )
  local i
  for ((i = 0; i < ${#cases[@]}; i += 2)); do
    label="${cases[i]}"
    fixture="${cases[i + 1]}"
    echo "[self-test] a tracked path containing ${label} must FAIL"
    rc=0
    fixture_repo "$tmp/bad-$((i / 2))" 'contracts/plain.sol' "$fixture"
    run_scan "$tmp/bad-$((i / 2))" || rc=$?
    if [[ $rc -eq 1 ]]; then
      echo "[self-test] OK: ${label} rejected."
    else
      echo "[self-test] FAIL: a path containing ${label} scanned as exit $rc, expected 1." >&2
      printf '%s\n' "$SELF_TEST_OUT" >&2
      ok=1
    fi
  done

  # (3) POSITIVE FIXTURE — an ordinary repo must PASS, including every allowed
  #     punctuation byte. A guard that rejects everything is as useless as one
  #     that rejects nothing, and would make the repo unmergeable.
  echo "[self-test] a repo of plain-ASCII paths must PASS"
  fixture_repo "$tmp/clean" \
    'contracts/RobotMoneyVault.sol' \
    'crates/rmpc/src/main.rs' \
    'docs/a-b_c.d/e[f]g{h}~i^j.md'
  rc=0
  run_scan "$tmp/clean" || rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "[self-test] OK: plain-ASCII repo accepted."
  else
    echo "[self-test] FAIL: a plain-ASCII repo was rejected (exit $rc) — the guard is" >&2
    echo "           too strict and would block every PR." >&2
    printf '%s\n' "$SELF_TEST_OUT" >&2
    ok=1
  fi

  # (4) LOUD-SKIP — a directory that is not a work tree must exit 2, never PASS.
  echo "[self-test] a non-git directory must exit 2 (never PASS)"
  mkdir -p "$tmp/not-a-repo"
  rc=0
  run_scan "$tmp/not-a-repo" || rc=$?
  if [[ $rc -eq 2 ]]; then
    echo "[self-test] OK: an untrustworthy input fails loudly."
  else
    echo "[self-test] FAIL: a non-git directory exited $rc, expected 2." >&2
    ok=1
  fi

  # (5) LOUD-SKIP — an empty tracked listing must exit 2. This is the shape the
  #     depth-1-clone defect took in issue #1232: an assertion that ran, over an
  #     input that was silently empty, and printed PASS.
  echo "[self-test] an empty tracked-path listing must exit 2 (never PASS)"
  mkdir -p "$tmp/empty"
  git -C "$tmp/empty" init -q
  rc=0
  run_scan "$tmp/empty" || rc=$?
  if [[ $rc -eq 2 ]]; then
    echo "[self-test] OK: an empty listing fails loudly instead of passing vacuously."
  else
    echo "[self-test] FAIL: an empty tracked listing exited $rc, expected 2 — a vacuous" >&2
    echo "           green is precisely the defect this guard is written against." >&2
    ok=1
  fi

  if [[ $ok -eq 0 ]]; then
    echo "[self-test] PASS: the guard rejects non-ASCII, quoting and control bytes, accepts plain ASCII, and reds out on input it cannot trust."
  fi
  return "$ok"
}

# ---------------------------------------------------------------------------

usage() {
  echo "usage: check-tracked-path-charset.sh [--self-test | --check-only] [--repo DIR]" >&2
}

main() {
  local mode=both root=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --self-test) mode=self-test; shift ;;
      --check-only) mode=check-only; shift ;;
      --repo)
        [[ -n "${2:-}" && -d "$2" ]] || {
          echo "ERROR: --repo needs an existing directory." >&2
          exit 2
        }
        root="$2"
        shift 2
        ;;
      *)
        echo "ERROR: unknown argument: $1" >&2
        usage
        exit 2
        ;;
    esac
  done

  if [[ -z "$root" ]]; then
    root="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
    if [[ -z "$root" ]]; then
      echo "ERROR: cannot locate the repository root from ${SCRIPT_DIR}." >&2
      exit 2
    fi
  fi

  # The self-test runs BEFORE the scan, so this script cannot report a PASS on a
  # machine where it has not just demonstrated that it can report a FAIL.
  if [[ "$mode" == self-test || "$mode" == both ]]; then
    if ! self_test; then
      echo "ERROR: the tracked-path charset guard failed its own self-test." >&2
      echo "       Its verdict on the real repository is worthless until this is fixed," >&2
      echo "       so the scan is not attempted." >&2
      exit 2
    fi
  fi

  if [[ "$mode" == check-only || "$mode" == both ]]; then
    scan_repo "$root"
  fi
}

main "$@"
