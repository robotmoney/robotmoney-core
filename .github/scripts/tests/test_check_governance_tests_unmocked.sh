#!/usr/bin/env bash
# Self-test for check_governance_tests_unmocked.sh: the real tree passes, each forbidden shape fails.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
guard="$here/../check_governance_tests_unmocked.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

bash "$guard" >/dev/null || { echo "FAIL: real tree rejected"; exit 1; }

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
echo "ok: check_governance_tests_unmocked self-test"
