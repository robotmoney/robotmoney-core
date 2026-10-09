#!/usr/bin/env bash
# Self-test for check_no_bare_cargo_test.py: bare shapes fail, wrapped and allowed shapes pass,
# and the real workflow tree passes (issue 1656).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
guard="$here/../check_no_bare_cargo_test.py"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fixture() { # name, run-block (already indented under "run:")
  mkdir -p "$tmp/$1"
  printf 'name: f\non: push\npermissions:\n  contents: read\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - name: s\n%s\n' "$2" > "$tmp/$1/f.yml"
}
must_pass() { python3 "$guard" "$tmp/$1" >/dev/null 2>&1 || { echo "FAIL: $1 rejected"; exit 1; }; }
must_fail() { if python3 "$guard" "$tmp/$1" >/dev/null 2>&1; then echo "FAIL: $1 accepted"; exit 1; fi; }

fixture wrapped '        run: |
          CARGO_TEST_MIN_EXECUTED=3 bash .github/scripts/cargo_test_require_executed.sh \
            -p doctests --test opencode_config -- --nocapture'
must_pass wrapped

fixture wrapped_folded '        run: >-
          bash ../../.github/scripts/cargo_test_require_executed.sh
          --release --test a -- --nocapture'
must_pass wrapped_folded

fixture no_target '        run: cargo test --lib -- --nocapture'
must_pass no_target

fixture threads_flag_only '        run: cargo test -p x -- --test-threads=1'
must_pass threads_flag_only

fixture comment_only '        run: |
          # cargo test --test foo is the bare form this guard rejects
          echo ok'
must_pass comment_only

fixture allowed '        run: |
          # bare-cargo-test-allowed: expects red
          cargo test --test foo'
must_pass allowed

fixture bare_inline '        run: cargo test --test foo -- --nocapture'
must_fail bare_inline

fixture bare_package '        run: cargo test -p smoke-test --release --test base_testnet_fixture'
must_fail bare_package

fixture bare_block '        run: |
          echo "::group::x"
          cargo test --test idempotency -- --nocapture
          echo "::endgroup::"'
must_fail bare_block

fixture bare_continued '        run: |
          cargo test --release \
            --test multi -- --nocapture'
must_fail bare_continued

fixture bare_folded '        run: >-
          cargo test --release
          --test multi'
must_fail bare_folded

fixture bare_matrix '        run: cargo test --release --test ${{ matrix.binary }} -- --nocapture'
must_fail bare_matrix

fixture bare_manifest '        run: cargo test --manifest-path a/Cargo.toml --test x=y'
must_fail bare_manifest

python3 "$guard" >/dev/null || { echo "FAIL: real workflow tree rejected"; exit 1; }
echo "ok: check_no_bare_cargo_test self-test"
