#!/usr/bin/env bash
# Self-test for .github/scripts/check_executed_floors.py (QA plan v1 T5).
#
# The checker is green on the real tree, so its red paths never run in CI unless this file runs
# them. Every case is a synthetic workspace in a temp dir: a root Cargo.toml, one crate with a lib,
# a bin and an integration test, a foundry.toml with two test files, and one workflow per case. No
# cargo, no forge, no network.
#
# Counting cases (the good workflow must pass, so each count below is asserted by it):
#   lib            3: tests::alpha, tests::beta, inner::tests::delta. tests::gamma is #[ignore];
#                  the #[test] in a macro_rules! body and in a doc example are not tests.
#   --exact        1: tests::alpha is found only if the unbalanced braces in a raw string did not
#                  move the module depth (a wrong depth names it fixtures::tests::alpha).
#   bin            1: tests::cli_parses in src/main.rs.
#   --test it      5: one, two, common::from_common (a `mod common;` file), and the two tests
#                  parameterized_e2e!(legs, ...) makes. --skip base_testnet leaves 4.
#   forge fv       4: ATest's test_one, test_two, the invariant_x and invariant_y pair (forge reports a
#                  contract's invariants as one passed test) and the inherited test_inherited.
#                  test_skipped calls vm.skip(true), internal functions are not tests, and the
#                  abstract base does not run on its own.
#   forge Guard    2: GuardTest only. The contract in a comment and in a string are not contracts.
# Failure cases: a floor one low and one high, a call with no floor, a bare forge test, a bare
# cargo test, a missing target, a shell variable in the arguments, a call with no target, and the
# REAL suite 22 workflow with its first floor lowered by one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CHECKER="${ROOT}/.github/scripts/check_executed_floors.py"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

mkdir -p "$T/crates/demo/src" "$T/crates/demo/tests/common" "$T/contracts/test/fv" "$T/wf"
cat > "$T/Cargo.toml" <<'EOF'
[workspace]
members = ["crates/demo"]
EOF
cat > "$T/crates/demo/Cargo.toml" <<'EOF'
[package]
name = "demo"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "democli"
path = "src/main.rs"
EOF
cat > "$T/crates/demo/src/lib.rs" <<'EOF'
pub mod inner;

/// ```ignore
/// #[test]
/// fn doc_example() {}
/// ```
#[macro_export]
macro_rules! make_test {
    ($n:ident) => {
        #[test]
        fn fake_in_macro() {}
    };
}

mod fixtures {
    pub fn json() -> &'static str {
        r#"{"a": {"b": 1}"#
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn alpha() {}

    #[test]
    fn beta() {
        let _ = "}";
        let _ = '{';
    }

    #[test]
    #[ignore]
    fn gamma() {}
}
EOF
cat > "$T/crates/demo/src/inner.rs" <<'EOF'
#[cfg(test)]
mod tests {
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delta() {}
}
EOF
cat > "$T/crates/demo/src/main.rs" <<'EOF'
fn main() {}

#[cfg(test)]
mod tests {
    #[test]
    fn cli_parses() {}
}
EOF
cat > "$T/crates/demo/tests/it.rs" <<'EOF'
mod common;

#[test]
fn one() {}

#[tokio::test]
async fn two() {}

parameterized_e2e!(legs, |network, fx| {
    let _ = (network, fx);
});
EOF
cat > "$T/crates/demo/tests/common/mod.rs" <<'EOF'
#[test]
fn from_common() {}
EOF
cat > "$T/foundry.toml" <<'EOF'
[profile.default]
src = "contracts"
test = "contracts/test"
EOF
cat > "$T/contracts/test/fv/A.t.sol" <<'EOF'
abstract contract BaseSuite {
    function test_inherited() public {}
}

contract ATest is BaseSuite {
    function test_one() public {}
    function test_two() external view {}
    function test_skipped() public {
        vm.skip(true);
    }
    function testHelper() internal {}
    function invariant_x() public {}
    function invariant_y() public {}
}
EOF
cat > "$T/contracts/test/B.t.sol" <<'EOF'
// contract FakeGuard { function test_fake() public {} }
contract GuardTest {
    string constant S = "contract EvilGuard { function test_evil() public {} }";
    function test_b1() public {}
    function test_b2() public {}
}
EOF

cat > "$T/wf/good.yml" <<'EOF'
name: good
on: push
env:
  CARGO_TEST_MIN_EXECUTED: "3"
jobs:
  rust:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - tests: --test it
            floor: 5
          - tests: --test it -- --skip base_testnet
            floor: 4
    steps:
      - name: lib, floor from the workflow env
        run: bash .github/scripts/cargo_test_require_executed.sh -p demo --lib
      - name: exact filter, inline floor
        run: |
          CARGO_TEST_MIN_EXECUTED=1 bash .github/scripts/cargo_test_require_executed.sh \
            -p demo --lib -- --nocapture --exact tests::alpha
      - name: bin, floor from the step env
        working-directory: crates/demo
        env:
          CARGO_TEST_MIN_EXECUTED: "1"
        run: bash ../../.github/scripts/cargo_test_require_executed.sh --bin democli
      - name: integration (${{ matrix.tests }})
        working-directory: crates/demo
        env:
          CARGO_TEST_MIN_EXECUTED: ${{ matrix.floor }}
        run: bash ../../.github/scripts/cargo_test_require_executed.sh ${{ matrix.tests }}
      - name: expected failure
        run: |
          # bare-cargo-test-allowed: this step expects cargo test to FAIL.
          if CI=true cargo test -p demo --test it; then exit 1; fi
      - name: build only
        run: cargo test --no-run
  forge:
    runs-on: ubuntu-latest
    steps:
      - run: FORGE_TEST_MIN_EXECUTED=4 bash .github/scripts/forge_test_require_executed.sh --match-path 'contracts/test/fv/**' -vvv
      - run: |
          FORGE_TEST_MIN_EXECUTED=2 bash .github/scripts/forge_test_require_executed.sh \
            --match-contract 'Guard' -vvv
EOF

one_step() { # file run-line
  printf 'name: case\non: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: %s\n' "$2" > "$T/wf/$1"
}
one_step floor_low.yml "CARGO_TEST_MIN_EXECUTED=2 bash .github/scripts/cargo_test_require_executed.sh -p demo --lib"
one_step floor_high.yml "CARGO_TEST_MIN_EXECUTED=4 bash .github/scripts/cargo_test_require_executed.sh -p demo --lib"
one_step no_floor.yml "bash .github/scripts/cargo_test_require_executed.sh -p demo --lib"
one_step bare_forge.yml "forge test --match-path 'contracts/test/fv/**'"
one_step bare_cargo.yml "cargo test -p demo --lib -- tests::alpha"
one_step missing_target.yml "CARGO_TEST_MIN_EXECUTED=1 bash .github/scripts/cargo_test_require_executed.sh -p demo --test nope"
one_step shell_var.yml "CARGO_TEST_MIN_EXECUTED=1 bash .github/scripts/cargo_test_require_executed.sh -p demo --test \$NAME"
one_step no_target.yml "CARGO_TEST_MIN_EXECUTED=1 bash .github/scripts/cargo_test_require_executed.sh -p demo"
one_step forge_skip_counted.yml "FORGE_TEST_MIN_EXECUTED=5 bash .github/scripts/forge_test_require_executed.sh --match-path 'contracts/test/fv/**'"

FAILS=0
expect() { # name want(zero|nonzero) needle workflow [root]
  local name="$1" want="$2" needle="$3" wf="$4" root="${5:-$T}" got=0 out
  out="$(python3 "$CHECKER" --repo-root "$root" "$wf" 2>&1)" || got=$?
  if { [ "$want" = zero ] && [ "$got" -eq 0 ]; } || { [ "$want" = nonzero ] && [ "$got" -eq 1 ]; }; then
    if [ -n "$needle" ] && ! grep -qF -- "$needle" <<<"$out"; then
      echo "FAIL ${name}: output lacks '${needle}':" >&2
      echo "$out" >&2
      FAILS=$((FAILS + 1))
      return
    fi
    echo "ok   ${name}"
  else
    echo "FAIL ${name}: exit ${got}, wanted ${want}" >&2
    echo "$out" >&2
    FAILS=$((FAILS + 1))
  fi
}

expect "right floors, every counting rule" zero "ok: every executed floor" "$T/wf/good.yml"
expect "floor one below the count is red" nonzero "selects 3 test(s)" "$T/wf/floor_low.yml"
expect "floor one above the count is red" nonzero "selects 3 test(s)" "$T/wf/floor_high.yml"
expect "a call with no floor is red" nonzero "names no floor" "$T/wf/no_floor.yml"
expect "a bare forge test is red" nonzero "outside forge_test_require_executed.sh" "$T/wf/bare_forge.yml"
expect "a bare cargo test is red" nonzero "bare \`cargo test\`" "$T/wf/bare_cargo.yml"
expect "a missing target is red" nonzero "--test nope: no such target" "$T/wf/missing_target.yml"
expect "a shell variable in the arguments is red" nonzero "shell variable" "$T/wf/shell_var.yml"
expect "a call with no target is red" nonzero "names no target" "$T/wf/no_target.yml"
expect "a skipped forge test is not counted" nonzero "selects 4 test(s)" "$T/wf/forge_skip_counted.yml"

# The real suite 22 workflow on the real tree, with its first floor lowered by one.
REAL="${ROOT}/.github/workflows/suite-22-formal-verification.yml"
first="$(grep -oE 'FORGE_TEST_MIN_EXECUTED=[0-9]+' "$REAL" | head -1 | grep -oE '[0-9]+$')"
if [ -z "$first" ]; then
  echo "FAIL real suite 22: no FORGE_TEST_MIN_EXECUTED floor found" >&2
  FAILS=$((FAILS + 1))
else
  sed "0,/FORGE_TEST_MIN_EXECUTED=${first}/s//FORGE_TEST_MIN_EXECUTED=$((first - 1))/" "$REAL" > "$T/wf/suite22-low.yml"
  expect "real suite 22 with a floor one below its count is red" nonzero "selects ${first} test(s)" "$T/wf/suite22-low.yml" "$ROOT"
fi

[ "$FAILS" -eq 0 ] || { echo "test_check_executed_floors: ${FAILS} case(s) failed" >&2; exit 1; }
echo "test_check_executed_floors: all cases passed"
