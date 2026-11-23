#!/usr/bin/env python3
"""Line-coverage gate for the one-vault fund contracts (safety review 0.9.0, MISSED-09).

The forge coverage job skips these sources to stay under its memory ceiling (suite-01-02-forge-tests.yml). The
one-vault coverage job instruments them with the prototype suite instead, and this script reads its lcov report.

It fails when any listed source is absent from the report (an instrumented file that disappears is a silent zero),
or when the combined line coverage of the listed sources falls below the floor. It prints every file's numbers.

Usage: check_onevault_coverage.py <lcov.info> [--min PERCENT]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# The one-vault production sources (contracts/, not tests or scripts).
SOURCES = [
    "contracts/RobotMoneyFund.sol",
    "contracts/Rebalancer.sol",
    "contracts/RebalanceGovernance.sol",
    "contracts/FlowQueue.sol",
    "contracts/FundExclusionLedger.sol",
    "contracts/KeeperAccount.sol",
    "contracts/PlanMath.sol",
    "contracts/lib/FeedLib.sol",
    "contracts/lib/FlowCheckLib.sol",
    "contracts/lib/FlowClaimLib.sol",
    "contracts/lib/FlowMatchLib.sol",
    "contracts/lib/FlowMigrateLib.sol",
    "contracts/lib/FlowSettleLib.sol",
    "contracts/lib/FundAdapterGuard.sol",
    "contracts/lib/FundAdminLib.sol",
    "contracts/lib/FundDelistLib.sol",
    "contracts/lib/FundFlowsLib.sol",
    "contracts/lib/FundMigrateLib.sol",
    "contracts/lib/FundPositionLib.sol",
    "contracts/lib/FundStepLib.sol",
    "contracts/lib/FundValuationLib.sol",
    "contracts/lib/StepFeedLib.sol",
    "contracts/lib/TwapSlicesLib.sol",
]

DEFAULT_MIN = 90.0


def parse(path: Path) -> dict[str, tuple[int, int]]:
    """{source: (lines hit, lines found)} from an lcov file."""
    out: dict[str, tuple[int, int]] = {}
    src, lh, lf = None, 0, 0
    for raw in path.read_text().splitlines():
        if raw.startswith("SF:"):
            src, lh, lf = raw[3:].strip(), 0, 0
        elif raw.startswith("LH:"):
            lh = int(raw[3:])
        elif raw.startswith("LF:"):
            lf = int(raw[3:])
        elif raw == "end_of_record" and src is not None:
            h, f = out.get(src, (0, 0))
            out[src] = (h + lh, f + lf)
            src = None
    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("lcov", type=Path)
    ap.add_argument("--min", type=float, default=DEFAULT_MIN)
    a = ap.parse_args(argv)
    if not a.lcov.is_file():
        print(f"FAIL: no lcov report at {a.lcov}")
        return 1
    data = parse(a.lcov)
    missing = [s for s in SOURCES if s not in data or data[s][1] == 0]
    hit = sum(data[s][0] for s in SOURCES if s in data)
    found = sum(data[s][1] for s in SOURCES if s in data)
    for s in SOURCES:
        h, f = data.get(s, (0, 0))
        pct = 100.0 * h / f if f else 0.0
        print(f"{pct:6.2f}%  {h:5d}/{f:<5d}  {s}")
    total = 100.0 * hit / found if found else 0.0
    print(f"{total:6.2f}%  {hit:5d}/{found:<5d}  one-vault total (floor {a.min:.2f}%)")
    if missing:
        print("FAIL: not instrumented: " + ", ".join(missing))
        return 1
    if total < a.min:
        print(f"FAIL: one-vault line coverage {total:.2f}% is below the floor {a.min:.2f}%")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
