#!/usr/bin/env bash
# Canonical: docs/operations/base-sepolia-deployment.md §Step 1 — Preflight guards
# Implements: issue #1303 acceptance criterion 4 — EIP-170 size and env-default
#             guards (#865, #864 classes) checked against the exact broadcast
#             artifacts BEFORE any transaction is sent.
#
# Runs BEFORE the ceremony broadcasts anything. Checks:
#   1. EIP-170 / EIP-3860 size gate — every contract the ceremony deploys must
#      have runtime bytecode <= 24576 bytes and creation (init) bytecode
#      <= 49152 bytes, measured from the exact `forge build` artifacts in out/.
#      Contracts whose runtime sits within SIZE_WARN_MARGIN of the EIP-170 cap
#      are reported loudly (the #1298 growth risk) but do not fail the gate.
#   2. Env-default guard — EXECUTION_DELAY and TIMELOCK_MIN_DELAY must not be
#      left at the unsafe `0` default (the #864 revert class), and
#      QUORUM_THRESHOLD must be non-zero (router-governance-handoff-runbook §1.1:
#      quorum 0/1 is hollow separate-body control).
#
# Usage:
#   preflight-guards.sh [--contract NAME ...]
#
# Exit codes: 0 = all guards pass; non-zero = a hard guard failed and the
# ceremony MUST NOT proceed. No transaction is ever sent by this script.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$REPO_ROOT/out"

# EIP-170 hard limit on deployed (runtime) code size, in bytes.
EIP170_RUNTIME_LIMIT=24576
# EIP-3860 hard limit on creation (init) code size, in bytes.
EIP3860_INITCODE_LIMIT=49152
# Report (but do not fail) when runtime code is within this many bytes of EIP-170.
SIZE_WARN_MARGIN=1000

# The ceremony's runtime set: every contract a deploy script in the ceremony
# creates. Sourced from docs/operations/base-sepolia-deployment.md.
CEREMONY_CONTRACTS=(
  "RobotMoneyVault"
  "AaveV3Adapter"
  "CompoundV3Adapter"
  "MorphoAdapter"
  "RobotMoneyGateway"
  "VaultRegistry"
  "PortfolioRouter"
  "RouterGovernance"
  "InvestmentCommitteePolicy"
  "ConsensusRecommendationReceipt"
  "TimelockController"
  # The #865 class: the two vault families that have busted the EIP-170 limit
  # before, and sit near it today — the size gate must run against the exact
  # bytecode the testnet deploy would broadcast even if this ceremony does not
  # deploy them itself.
  "RwaVault"
  "AgentTokenVault"
)

fail() {
  echo "FAIL: [preflight] $*" >&2
  exit 1
}

warn() {
  echo "WARN: [preflight] $*" >&2
}

# ─── 1. Hard env-default guard (#864 class) ──────────────────────────────────
for var in EXECUTION_DELAY TIMELOCK_MIN_DELAY QUORUM_THRESHOLD; do
  if [[ -n "${!var:-}" ]] && [[ "${!var}" == "0" ]]; then
    fail "${var}=0 is the unsafe env-default hazard (#864) — set a non-zero value before the ceremony"
  fi
done
if [[ -n "${EXECUTION_DELAY:-}" ]] && [[ "$EXECUTION_DELAY" =~ ^[0-9]+$ ]] \
  && [[ "$EXECUTION_DELAY" -lt 3600 ]]; then
  warn "EXECUTION_DELAY=${EXECUTION_DELAY} < RouterGovernance.MIN_EXECUTION_DELAY (3600); the constructor will revert ExecutionDelayBelowMinimum"
fi
echo "OK: [preflight] env-default guard: EXECUTION_DELAY=${EXECUTION_DELAY:-unset} QUORUM_THRESHOLD=${QUORUM_THRESHOLD:-unset} TIMELOCK_MIN_DELAY=${TIMELOCK_MIN_DELAY:-unset}"

# ─── 2. EIP-170 / EIP-3860 size gate against the exact artifacts ─────────────
command -v python3 >/dev/null 2>&1 || fail "python3 not on PATH"
command -v forge >/dev/null 2>&1 || fail "forge not on PATH"

# Rebuild so the gate measures the EXACT bytecode the ceremony will broadcast —
# a stale out/ produced by an earlier commit would otherwise report old sizes.
echo "[preflight] forge build (fresh artifacts for the size gate)"
if ! build_out="$(forge build 2>&1)"; then
  echo "$build_out" >&2
  fail "forge build failed — cannot measure broadcast bytecode"
fi

python3 - "$EIP170_RUNTIME_LIMIT" "$EIP3860_INITCODE_LIMIT" "$SIZE_WARN_MARGIN" \
  "$REPO_ROOT/out" "${CEREMONY_CONTRACTS[@]}" <<'PYEOF'
import json, sys
runtime_limit = int(sys.argv[1])
initcode_limit = int(sys.argv[2])
warn_margin = int(sys.argv[3])
out_dir = sys.argv[4]
names = sys.argv[5:]

def artifact_path(name):
    return f"{out_dir}/{name}.sol/{name}.json"

hard_fail = False
near_limit = []
print("[preflight] EIP-170 runtime limit:", runtime_limit, "EIP-3860 initcode limit:", initcode_limit)
for name in names:
    path = artifact_path(name)
    try:
        with open(path) as fh:
            data = json.load(fh)
    except FileNotFoundError:
        print(f"FAIL: [preflight] artifact missing for {name}: {path}")
        hard_fail = True
        continue
    except json.JSONDecodeError as exc:
        print(f"FAIL: [preflight] artifact unreadable for {name}: {exc}")
        hard_fail = True
        continue
    create = len(data["bytecode"]["object"]) // 2
    runtime = len(data["deployedBytecode"]["object"]) // 2
    flags = []
    if runtime > runtime_limit:
        flags.append(f"EIP-170 VIOLATION runtime={runtime}")
        hard_fail = True
    if create > initcode_limit:
        flags.append(f"EIP-3860 VIOLATION initcode={create}")
        hard_fail = True
    if runtime > runtime_limit - warn_margin and runtime <= runtime_limit:
        near_limit.append((name, runtime, runtime_limit - runtime))
    status = "OK" if not flags else "FAIL"
    print(f"  {status:4s} {name:30s} create={create:6d} runtime={runtime:6d} {' '.join(flags)}".rstrip())

for name, runtime, margin in near_limit:
    print(f"WARN: [preflight] {name} runtime {runtime} is {margin} bytes under the EIP-170 cap; the #1298 growth trend makes this a real breakage risk — no new code without a size plan")

if hard_fail:
    sys.exit(1)
print("OK: [preflight] all ceremony artifacts within EIP-170/EIP-3860 hard limits")
PYEOF

echo "OK: [preflight] size + env-default guards passed"
