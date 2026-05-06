#!/usr/bin/env python3
"""Enforce 100% line + branch coverage on contracts/gateway/RobotMoneyGateway.sol.

Reads an lcov report (default: lcov.info) and fails (exit 1) if any line or
branch in RobotMoneyGateway.sol is uncovered, EXCEPT for branches explicitly
marked unreachable below.

The single allowed exception is the defensive `!p.active` check at line 203 of
RobotMoneyGateway.sol — unreachable through the public API because
`authorizeAgent` enforces `p.active==true` and `revokeAgent` deletes the policy
together with `AGENT_ROLE`. Documented inline in the contract.
"""

from __future__ import annotations

import sys
from pathlib import Path

GATEWAY_PATH_SUFFIX = "contracts/gateway/RobotMoneyGateway.sol"

# Marker comment placed on the line immediately before any `if (...) revert ...`
# whose missing branch is documented as logically unreachable. Any BRDA whose
# source line is preceded by this marker is allowed to remain uncovered.
COVERAGE_EXEMPT_MARKER = "coverage:unreachable"


def _exempt_branch_lines(source_path: Path) -> set[int]:
    """Return line numbers of any `if (...) revert ...` whose preceding line
    contains COVERAGE_EXEMPT_MARKER."""
    exempt: set[int] = set()
    if not source_path.exists():
        return exempt
    lines = source_path.read_text().splitlines()
    for idx, line in enumerate(lines):
        if COVERAGE_EXEMPT_MARKER in line:
            # Mark the next non-blank source line as exempt.
            for j in range(idx + 1, len(lines)):
                if lines[j].strip():
                    exempt.add(j + 1)  # 1-indexed
                    break
    return exempt


def main(argv: list[str]) -> int:
    lcov_path = Path(argv[1] if len(argv) > 1 else "lcov.info")
    if not lcov_path.exists():
        print(f"lcov file not found: {lcov_path}", file=sys.stderr)
        return 2

    repo_root = Path(__file__).resolve().parents[2]
    exempt_lines = _exempt_branch_lines(repo_root / GATEWAY_PATH_SUFFIX)
    if exempt_lines:
        print(f"  [info] exempt branch source lines: {sorted(exempt_lines)}")

    in_target = False
    uncovered_lines: list[int] = []
    uncovered_branches: list[tuple[int, int, int]] = []

    for raw in lcov_path.read_text().splitlines():
        line = raw.strip()
        if line.startswith("SF:"):
            in_target = line.endswith(GATEWAY_PATH_SUFFIX)
            continue
        if line == "end_of_record":
            in_target = False
            continue
        if not in_target:
            continue
        if line.startswith("DA:"):
            # DA:<line>,<hits>
            ln_str, hits_str = line[3:].split(",", 1)
            if hits_str.strip() == "0":
                uncovered_lines.append(int(ln_str))
        elif line.startswith("BRDA:"):
            # BRDA:<line>,<block>,<branch>,<taken|->
            parts = line[5:].split(",")
            if len(parts) != 4:
                continue
            ln, block, branch, taken = parts
            if taken.strip() in ("-", "0"):
                ln_i = int(ln)
                tup = (ln_i, int(block), int(branch))
                if ln_i in exempt_lines:
                    print(f"  [allowed] uncovered branch {tup} (coverage:unreachable)")
                    continue
                uncovered_branches.append(tup)

    ok = True
    if uncovered_lines:
        ok = False
        print("Uncovered lines in RobotMoneyGateway.sol:", uncovered_lines, file=sys.stderr)
    if uncovered_branches:
        ok = False
        print(
            "Uncovered branches in RobotMoneyGateway.sol:",
            uncovered_branches,
            file=sys.stderr,
        )

    if not ok:
        print("FAIL: RobotMoneyGateway.sol coverage gap.", file=sys.stderr)
        return 1

    print("OK: RobotMoneyGateway.sol at 100% line + branch coverage "
          "(modulo documented unreachable branches).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
