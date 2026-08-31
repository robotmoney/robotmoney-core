#!/usr/bin/env bash
# Guard exercise for .github/scripts/check_cargo_test_target_coverage.py
#
# Canonical: .github/scripts/check_cargo_test_target_coverage.py
# Issue: #1282
#
# WHY THIS EXISTS
# The coverage checker's job is to be RED when a tests/*.rs file is executed by
# no workflow. On `dev`, after the triage in #1282, it sees exactly one tree:
# the real one, in the one arrangement that passes. Every branch that matters --
# a dark target, an allowlist entry with no reason, a stale entry, an entry
# naming a file that no longer exists, `--no-run` mistaken for execution, a
# `--lib` run mistaken for integration coverage, and a `--test <name>` credited
# to the wrong package -- is unreachable in CI. A guard whose failure paths
# never execute is a guard nobody has checked, and this checker's entire value
# is in those paths.
#
# THE PACKAGE-SCOPING CASE IS THE REASON THIS FILE WAS WRITTEN AND NOT ASSUMED.
# suite-05 runs `--test governance` from `testing/fork-e2e-rust`. A name-only
# match credits `testing/smoke-test/tests/governance.rs` for that run, and that
# file has never executed anywhere. A checker with that bug reports a clean tree
# while the hole it exists to find is still open -- a false GREEN, invisible
# from the passing side.
#
# Every case is a throwaway synthetic workspace in a temp dir: a root
# Cargo.toml, two member crates, a tests/ file each, and a workflow. No cargo
# build, no network, no Docker. The final case is the negative self-test the
# issue's test plan asks for: a synthetic tests/*.rs file dropped into THIS
# repository's real tree, asserted to turn the checker red, then removed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CHECKER="${REPO_ROOT}/.github/scripts/check_cargo_test_target_coverage.py"

if [[ ! -f "$CHECKER" ]]; then
  echo "FATAL: checker not found at $CHECKER" >&2
  exit 2
fi

# A case that stops being REACHED is indistinguishable from one that passes, so
# the count of assertions actually executed is asserted too. Raise this together
# with any case you add; lowering it is how coverage disappears quietly.
MIN_EXPECTED_ASSERTIONS=16

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# make_tree <workflow-run-body> -> prints the synthetic repo path
#
# The tree always contains two crates, `alpha` and `beta`, each with one
# integration target of the SAME name (`shared`) plus one of its own. The
# duplicated name is deliberate: it is what makes the package-scoping cases
# meaningful. The workflow body is dropped verbatim into a single step's `run:`.
make_tree() {
  local body="$1"
  local dir
  dir="$(mktemp -d "${WORKDIR}/tree.XXXXXX")"

  cat > "${dir}/Cargo.toml" <<'EOF'
[workspace]
resolver = "2"
members = [
    "crates/alpha",
    "crates/beta",
]
EOF

  local pkg
  for pkg in alpha beta; do
    mkdir -p "${dir}/crates/${pkg}/tests"
    cat > "${dir}/crates/${pkg}/Cargo.toml" <<EOF
[package]
name = "${pkg}"
version = "0.1.0"
edition = "2021"
EOF
    echo "// synthetic" > "${dir}/crates/${pkg}/tests/shared.rs"
    echo "// synthetic" > "${dir}/crates/${pkg}/tests/only_${pkg}.rs"
  done

  mkdir -p "${dir}/.github/workflows"
  {
    echo "name: synthetic"
    echo "on: [push]"
    echo "jobs:"
    echo "  t:"
    echo "    runs-on: ubuntu-latest"
    echo "    steps:"
    printf '%s\n' "$body"
  } > "${dir}/.github/workflows/synthetic.yml"

  echo "$dir"
}

# run_checker <tree> -> exit code in $STATUS, combined output in $OUTPUT
STATUS=0
OUTPUT=""
run_checker() {
  set +e
  OUTPUT="$(python3 "$CHECKER" --repo-root "$1" 2>&1)"
  STATUS=$?
  set -e
}

# expect <tree> <expected-status> <description> [substring-that-must-appear]
expect() {
  local tree="$1" want="$2" desc="$3" needle="${4:-}"
  run_checker "$tree"
  if [[ "$STATUS" -ne "$want" ]]; then
    fail "$desc (expected exit ${want}, got ${STATUS})"
    printf '%s\n' "$OUTPUT" | sed 's/^/    | /'
    return
  fi
  if [[ -n "$needle" ]] && ! grep -qF "$needle" <<<"$OUTPUT"; then
    fail "$desc (exit ${want} correct, but output never mentioned '${needle}')"
    printf '%s\n' "$OUTPUT" | sed 's/^/    | /'
    return
  fi
  pass "$desc"
}

# allow <tree> <content> — write the allowlist for a tree
allow() { printf '%s\n' "$2" > "${1}/.github/cargo-test-target-allowlist.txt"; }

# ---------------------------------------------------------------------------
# 1. Baseline: every target named. The checker must be GREEN, or every red
#    below proves nothing.
# ---------------------------------------------------------------------------
ALL_NAMED='      - run: |
          cargo test -p alpha --test shared --test only_alpha
          cargo test -p beta --test shared --test only_beta'
T="$(make_tree "$ALL_NAMED")"
expect "$T" 0 "baseline: all four targets named -> green" "DARK (nothing runs them):     0"

# ---------------------------------------------------------------------------
# 2. THE CORE CASE: a target no workflow names must be RED and must be named
#    in the output. This is the negative self-test in synthetic form.
# ---------------------------------------------------------------------------
T="$(make_tree '      - run: cargo test -p alpha --test shared --test only_alpha')"
expect "$T" 1 "un-executed target -> red" "beta::only_beta"

# ---------------------------------------------------------------------------
# 3. Allowlist with a reason clears it; the same entry without a reason does
#    not. An allowlist row nobody justified is indistinguishable from the
#    oversight this checker exists to catch.
# ---------------------------------------------------------------------------
allow "$T" '# devnet-bound, tracked by issue #9999
beta::shared
# also devnet-bound
beta::only_beta'
expect "$T" 0 "allowlist entries with preceding-comment reasons -> green"

allow "$T" 'beta::shared  # inline reason: devnet-bound
beta::only_beta  # inline reason: devnet-bound'
expect "$T" 0 "allowlist entries with inline reasons -> green"

allow "$T" 'beta::shared
beta::only_beta'
expect "$T" 1 "allowlist entry with no reason -> red" "has no reason"

# A comment separated from its entry by a blank line is NOT adjacent, and must
# not be accepted as that entry's reason.
allow "$T" '# devnet-bound, tracked by issue #9999

beta::shared
# a real reason
beta::only_beta'
expect "$T" 1 "comment separated by a blank line is not adjacent -> red" "has no reason"

# ---------------------------------------------------------------------------
# 4. Stale and orphan entries. A stale row (the target IS executed now) and an
#    orphan row (the file is gone) both hide the next real gap behind noise.
# ---------------------------------------------------------------------------
T="$(make_tree "$ALL_NAMED")"
allow "$T" '# stale: alpha::shared is executed by the synthetic workflow
alpha::shared'
expect "$T" 1 "stale allowlist entry -> red" "stale"

allow "$T" '# orphan: no such file
alpha::deleted_long_ago'
expect "$T" 1 "orphan allowlist entry -> red" "does not exist"

# ---------------------------------------------------------------------------
# 5. `--no-run` COMPILES and does not execute. Crediting it would recreate the
#    exact silent skip this checker exists to expose: a green job whose test
#    binary was built and never run.
# ---------------------------------------------------------------------------
T="$(make_tree '      - run: |
          cargo test -p alpha --no-run
          cargo test -p beta --no-run')"
expect "$T" 1 "cargo test --no-run is not execution -> red" "alpha::shared"

# ---------------------------------------------------------------------------
# 6. `--lib` builds no integration target. suite-06 runs exactly this, and its
#    own header says so; a checker that counted it would call the whole rmpc
#    tests/ directory covered.
# ---------------------------------------------------------------------------
T="$(make_tree '      - run: |
          cargo test -p alpha --lib
          cargo test -p beta --lib')"
expect "$T" 1 "cargo test --lib gives no integration coverage -> red" "alpha::only_alpha"

# ---------------------------------------------------------------------------
# 7. A bare `cargo test -p <pkg>` (and `--tests`) DOES run every integration
#    target of that package. The checker must credit it, or it would demand
#    hand-naming forever and push people back into the hole.
# ---------------------------------------------------------------------------
T="$(make_tree '      - run: |
          cargo test -p alpha
          cargo test -p beta --tests')"
expect "$T" 0 "bare cargo test -p and --tests cover the whole package -> green"

# ---------------------------------------------------------------------------
# 8. PACKAGE SCOPING — the false-green case.
#    `--test shared` run from crates/alpha covers alpha::shared ONLY. beta has
#    a file of the same name and it is still dark.
# ---------------------------------------------------------------------------
T="$(make_tree '      - working-directory: crates/alpha
        run: cargo test --test shared --test only_alpha
      - run: cargo test -p beta --test only_beta')"
expect "$T" 1 "same-named target in another package is not credited -> red" "beta::shared"

# working-directory resolution itself must work, or case 8 would pass for the
# wrong reason (nothing credited at all).
T="$(make_tree '      - working-directory: crates/alpha
        run: cargo test --test shared --test only_alpha
      - working-directory: crates/beta
        run: cargo test --test shared --test only_beta')"
expect "$T" 0 "working-directory resolves the package -> green"

# --manifest-path resolves it too (suite-07 uses this form).
T="$(make_tree '      - run: |
          cargo test --manifest-path crates/alpha/Cargo.toml --test shared --test only_alpha
          cargo test --manifest-path crates/beta/Cargo.toml --test shared --test only_beta')"
expect "$T" 0 "--manifest-path resolves the package -> green"

# ---------------------------------------------------------------------------
# 9. Matrix expansion. suite-05, suite-07 and suite-14 all name their targets
#    through `${{ matrix.* }}`; a checker blind to that would report a third of
#    the repository dark and be switched off within a week.
# ---------------------------------------------------------------------------
# shellcheck disable=SC2016  # `${{ matrix.b }}` must reach the YAML unexpanded.
T="$(make_tree '      - run: cargo test -p alpha --test ${{ matrix.b }}
      - run: cargo test -p beta --test ${{ matrix.b }}')"
python3 - "$T" <<'PYEOF'
import sys, pathlib
wf = pathlib.Path(sys.argv[1]) / ".github/workflows/synthetic.yml"
text = wf.read_text()
text = text.replace("    runs-on: ubuntu-latest", """    runs-on: ubuntu-latest
    strategy:
      matrix:
        b: [shared, only_alpha, only_beta]""", 1)
wf.write_text(text)
PYEOF
expect "$T" 0 "matrix axis values expand into --test names -> green"

# The `include:` matrix form (suite-05) carries whole flag strings, not names.
# shellcheck disable=SC2016  # `${{ matrix.cargo_tests }}` must reach the YAML unexpanded.
T="$(make_tree '      - working-directory: crates/alpha
        run: cargo test ${{ matrix.cargo_tests }}
      - run: cargo test -p beta --test shared --test only_beta')"
python3 - "$T" <<'PYEOF'
import sys, pathlib
wf = pathlib.Path(sys.argv[1]) / ".github/workflows/synthetic.yml"
text = wf.read_text()
text = text.replace("    runs-on: ubuntu-latest", """    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - group: one
            cargo_tests: --test shared --test only_alpha""", 1)
wf.write_text(text)
PYEOF
expect "$T" 0 "matrix include: entries expand into --test flags -> green"

# ---------------------------------------------------------------------------
# 10. THE NEGATIVE SELF-TEST ON THE REAL TREE (issue #1282 test plan).
#     A synthetic tests/*.rs file added to a real workspace member must turn
#     the checker red on this repository as it actually stands.
# ---------------------------------------------------------------------------
SYNTHETIC="${REPO_ROOT}/crates/rmpc-logging/tests/synthetic_dark.rs"
if [[ -e "$SYNTHETIC" ]]; then
  echo "FATAL: ${SYNTHETIC} already exists; refusing to clobber it" >&2
  exit 2
fi
cleanup_synthetic() { rm -f "$SYNTHETIC"; rm -rf "$WORKDIR"; }
trap cleanup_synthetic EXIT
cat > "$SYNTHETIC" <<'EOF'
// Temporary file written by test_check_cargo_test_target_coverage.sh and
// deleted by its trap. If you are reading this in a commit, the self-test
// crashed between creating and removing it -- delete the file.
#[test]
fn synthetic() {}
EOF

expect "$REPO_ROOT" 1 "real tree + one synthetic dark target -> red" "rmpc-logging::synthetic_dark"
rm -f "$SYNTHETIC"
trap 'rm -rf "$WORKDIR"' EXIT

# And the real tree without it must be green, so the case above is attributable
# to the synthetic file and not to a pre-existing hole.
expect "$REPO_ROOT" 0 "real tree as committed -> green"

# ---------------------------------------------------------------------------
echo
echo "assertions executed: $((PASS + FAIL)) (pass=${PASS} fail=${FAIL})"
if [[ $((PASS + FAIL)) -lt $MIN_EXPECTED_ASSERTIONS ]]; then
  echo "FATAL: only $((PASS + FAIL)) assertions ran, expected at least ${MIN_EXPECTED_ASSERTIONS}." >&2
  echo "       A case that stopped being reached is a case that stopped protecting anything." >&2
  exit 1
fi
if [[ $FAIL -ne 0 ]]; then
  echo "FATAL: ${FAIL} assertion(s) failed." >&2
  exit 1
fi
echo "OK: the coverage checker fails on every path it is supposed to fail on."
