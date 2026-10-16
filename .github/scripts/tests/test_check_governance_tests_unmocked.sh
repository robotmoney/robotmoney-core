#!/usr/bin/env bash
# Self-test for check_governance_tests_unmocked.sh: the real tree passes, each forbidden shape fails.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
guard="$here/../check_governance_tests_unmocked.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

bash "$guard" >/dev/null || { echo "FAIL: real tree rejected"; exit 1; }

# Every rule names a file of the real tree. A rule for a deleted test can never fire there: the
# clients/dapp/tests/e2e/governance.spec.ts rule outlived its spec (issue 1698) until QA plan v1 L1.
real="$(git -C "$here" rev-parse --show-toplevel)"
n=0
while IFS= read -r file; do
  n=$((n + 1))
  [ -f "$real/$file" ] || { echo "FAIL: a rule names $file, which does not exist: delete the dead rule"; exit 1; }
done < <(sed -nE "s/^  '([^:']+)::.*/\1/p" "$guard")
[ "$n" -gt 0 ] || { echo "FAIL: no rule was read from $guard"; exit 1; }

mkdir -p "$tmp/clients/rust-payment-client/tests" "$tmp/scripts/fusion"
f="$tmp/clients/rust-payment-client/tests/cli_get_timelock.rs"
printf 'fn t() {}\n' > "$f"
bash "$guard" "$tmp" >/dev/null || { echo "FAIL: clean file rejected"; exit 1; }
printf 'use mockito::Matcher;\n' > "$f"
if bash "$guard" "$tmp" >/dev/null 2>&1; then echo "FAIL: mockito accepted"; exit 1; fi
printf 'const SAFE: Address = address!("0000000000000000000000000000000000005afe");\n' > "$f"
if bash "$guard" "$tmp" >/dev/null 2>&1; then echo "FAIL: fake Safe accepted"; exit 1; fi
printf 'fn t() {}\n' > "$f"
printf 'cast --from "$FUSION_RELEASE_ADDRESS"\n' > "$tmp/scripts/fusion/devnet-acceptance.sh"
if bash "$guard" "$tmp" >/dev/null 2>&1; then echo "FAIL: EOA release probe accepted"; exit 1; fi
rm -f "$tmp/scripts/fusion/devnet-acceptance.sh"
mkdir -p "$tmp/testing/fork-e2e-rust/tests"
k="$tmp/testing/fork-e2e-rust/tests/rmpc_get_timelock_fork.rs"
printf 'fn t() { let fx = Fixture::new(); }\n' > "$k"
bash "$guard" "$tmp" >/dev/null || { echo "FAIL: clean fork test rejected"; exit 1; }
printf 'if skip_if_no_fork() { return; }\n' > "$k"
if bash "$guard" "$tmp" >/dev/null 2>&1; then echo "FAIL: fork-skip accepted"; exit 1; fi
echo "ok: check_governance_tests_unmocked self-test"
