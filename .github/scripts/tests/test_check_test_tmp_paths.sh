#!/usr/bin/env bash
# Self-test for check_test_tmp_paths.py: the real tree passes, each way to share a file fails.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
guard="$here/../check_test_tmp_paths.py"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

python3 "$guard" >/dev/null || { echo "FAIL: real tree rejected"; exit 1; }

expect_fail() {
  if python3 "$guard" "$tmp" >/dev/null 2>&1; then echo "FAIL: $1 accepted"; exit 1; fi
}

printf 'contract A { function t() public { string memory p = claimTmpPath(vm, "a-one"); } }\ncontract B { function t() public { string memory p = uniqueTmpPath(vm, "b-one"); } }\ncontract C { function _prefix() internal pure returns (string memory) { return "RM_C_"; } function s() public { uniqueTmpPath(vm, string.concat("c", _prefix())); } }\n' > "$tmp/ok.sol"
python3 "$guard" "$tmp" >/dev/null || { echo "FAIL: clean tree rejected"; exit 1; }

# Mutation 1: a second contract reuses a tag.
printf 'contract D { function t() public { string memory p = claimTmpPath(vm, "a-one"); } }\n' > "$tmp/dup.sol"
expect_fail "a shared claimTmpPath tag"
rm "$tmp/dup.sol"

# Mutation 2: a fixed /tmp name (the old flake).
printf 'contract D { function t() public { string memory p = "/tmp/1476-run-entrypoint-manifest.json"; } }\n' > "$tmp/fixed.sol"
expect_fail "a fixed /tmp name"
rm "$tmp/fixed.sol"

# Mutation 3: a fixed file under /deployments.
printf 'contract D { string p = string.concat(vm.projectRoot(), "/deployments/test-x.json"); }\n' > "$tmp/dep.sol"
expect_fail "a fixed /deployments name"
rm "$tmp/dep.sol"

# Mutation 4: a shared-base tag without the per-contract prefix.
printf 'contract D { function t() public { uniqueTmpPath(vm, tagVar); } }\n' > "$tmp/pre.sol"
expect_fail "a uniqueTmpPath tag without _prefix()"
rm "$tmp/pre.sol"

# Mutation 5: two contracts return the same _prefix().
printf 'contract D { function _prefix() internal pure returns (string memory) { return "RM_C_"; } }\n' > "$tmp/pfx.sol"
expect_fail "a shared _prefix()"
rm "$tmp/pfx.sol"

# Mutation 6: removing a literal path.
printf 'contract D { function t() public { vm.removeFile("/x"); } }\n' > "$tmp/rm.sol"
expect_fail "a literal removeFile"
rm "$tmp/rm.sol"

# Mutation 7: the real tree with the old shared prefix restored.
cp -r "$here/../../../contracts/test" "$tmp/real"
python3 - "$tmp/real/DeployTimelock.t.sol" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
s = s.replace('"RM_REVIEW_R04_FLOOR_"', '"RM_1476_RUN_ENTRYPOINT_"', 1)
open(p, "w").write(s)
PY
if python3 "$guard" "$tmp/real" >/dev/null 2>&1; then echo "FAIL: mutated real tree accepted"; exit 1; fi
echo "ok: check_test_tmp_paths self-test"
