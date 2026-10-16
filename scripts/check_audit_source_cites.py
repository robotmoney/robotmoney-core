#!/usr/bin/env python3
"""Every Solidity source line that docs/audits.md cites exists and names what the row says (issue #1792).

Canonical: docs/technical/security-model.md §9 / §14 (the finding register's
"source line" acceptance of issue #1792).

WHY THIS GATE EXISTS
--------------------
QA plan v1 W2 re-dispositioned the 2026-10-12 review rows with a source line
each. QA plan P1 then moved the RobotMoneyVault, PortfolioRouter and
RobotMoneyGateway bodies into linked libraries (ADR-0014 §9), and every cite
went stale: `RobotMoneyVault.sol:1538` and `RobotMoneyGateway.sol:1661` pointed
past the end of the file, and `RobotMoneyVault.sol:1355-1367` named the
`isShutdown` NatSpec instead of `forceRemoveAdapter`. check_doc_test_citations.py
reads `*.t.sol` cites only, so nothing failed.

RULES (docs/audits.md only)
---------------------------
A CITE is a backticked `[path/]Name.sol:RANGES`, where RANGES is `N`, `N-M` or a
comma list of those (`:508,595`, `:439-463,766-778`). Test files (`.t.sol`) are
check_doc_test_citations.py's.

1. EXISTS. A .sol file under contracts/ ends with the cited path, and every line
   number in RANGES is at most its line count, with N <= M in each range.
2. ANCHORED. When a backticked `Name.symbol` with the cite's own `Name` appears
   in the same table row after the previous cite (or the row start) and before
   this cite, one of those symbols must match one of the ranges: the range
   mentions `symbol` as a word, or the nearest `function` or `modifier`
   declaration at or above the range's first line declares `symbol`. So
   "(`RobotMoneyVault.forceRemoveAdapter`, `RobotMoneyVault.sol:1104-1107`)"
   fails the day the function moves and the line lands in another function.

`--self-test` builds a throwaway tree and expects each defect (a missing file, a
line past the end, an inverted range, an anchor in another function, a stale
range in a comma list) to fail, and a compliant tree (an anchored cite inside a
function body, a NatSpec range that holds the declaration, an unanchored cite,
a `.t.sol` cite, an anchor before an earlier cite) to pass. Set CHECK_REPO_ROOT
to run the real check against another tree.

Run by scripts/check-audit-ledger.sh (suite-18 `audit-ledger` job).
"""
from __future__ import annotations

import os
import re
import sys
import tempfile
from pathlib import Path

AUDITS = Path("docs/audits.md")
SOURCE_ROOT = Path("contracts")
# contracts/lib holds our own linked libraries, so it is read; the vendored forge
# dependencies live in the repo-root lib/, outside contracts/.
SKIP_DIRS = {"out", "cache", "broadcast", "node_modules"}

CITE = re.compile(r"`(?P<path>(?:[\w.-]+/)*(?P<name>[A-Za-z]\w*)(?P<sfx>(?:\.s)?\.sol)):(?P<ranges>\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)`")
ANCHOR = re.compile(r"`(?P<name>[A-Z]\w*)\.(?P<symbol>[A-Za-z_]\w*)`")
DECL = re.compile(r"^\s*(?:function|modifier)\s+(\w+)\s*\(")


def repo_root() -> Path:
    override = os.environ.get("CHECK_REPO_ROOT")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parents[1]


def sources(root: Path) -> dict[str, list[tuple[str, list[str]]]]:
    """Basename -> [(repo-relative path, lines)] for every non-test .sol under contracts/."""
    out: dict[str, list[tuple[str, list[str]]]] = {}
    base = root / SOURCE_ROOT
    if not base.is_dir():
        return out
    for path in sorted(base.rglob("*.sol")):
        rel = path.relative_to(root)
        if path.name.endswith(".t.sol") or SKIP_DIRS & set(rel.parts[1:]):
            continue
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        out.setdefault(path.name, []).append((rel.as_posix(), lines))
    return out


def parse_ranges(text: str) -> list[tuple[int, int]]:
    out = []
    for part in text.split(","):
        lo, _, hi = part.partition("-")
        out.append((int(lo), int(hi) if hi else int(lo)))
    return out


def anchored(lines: list[str], ranges: list[tuple[int, int]], symbol: str) -> bool:
    word = re.compile(rf"\b{re.escape(symbol)}\b")
    for lo, hi in ranges:
        if any(word.search(lines[i - 1]) for i in range(lo, hi + 1)):
            return True
        for i in range(lo, 0, -1):
            m = DECL.match(lines[i - 1])
            if m:
                if m.group(1) == symbol:
                    return True
                break
    return False


def check(root: Path) -> tuple[list[str], int]:
    errors: list[str] = []
    path = root / AUDITS
    if not path.is_file():
        return [f"{AUDITS} is missing"], 0
    src = sources(root)
    seen = 0
    for lineno, row in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        prev_end = 0
        for m in CITE.finditer(row):
            seen += 1
            cited = m.group("path")
            where = f"{AUDITS}:{lineno}: cites `{cited}:{m.group('ranges')}`"
            basename = f"{m.group('name')}{m.group('sfx')}"
            files = [(rel, lines) for rel, lines in src.get(basename, []) if rel.endswith(cited)]
            anchors = [a.group("symbol") for a in ANCHOR.finditer(row, prev_end, m.start()) if a.group("name") == m.group("name")]
            prev_end = m.end()
            if not files:
                errors.append(f"{where}, but no {cited} exists under contracts/")
                continue
            ranges = parse_ranges(m.group("ranges"))
            ok = False
            problem = ""
            for rel, lines in files:
                bad = [f"{lo}-{hi}" for lo, hi in ranges if lo < 1 or hi < lo or hi > len(lines)]
                if bad:
                    problem = f"{rel} has {len(lines)} lines, so {', '.join(bad)} does not exist"
                    continue
                if anchors and not any(anchored(lines, ranges, s) for s in anchors):
                    problem = f"no range is in or names {' / '.join(m.group('name') + '.' + s for s in anchors)} in {rel}"
                    continue
                ok = True
                break
            if not ok:
                errors.append(f"{where}: {problem}. Re-read the source and cite the line that holds it.")
    return errors, seen


# ── self-test ────────────────────────────────────────────────────────────────

TELLER_SOL = "\n".join(
    [
        "// SPDX-License-Identifier: MIT",  # 1
        "contract Teller {",  # 2
        "    /// @notice Pay out.",  # 3
        "    function pay(uint256 a) external {",  # 4
        "        uint256 fee = a / 100;",  # 5
        "        send(fee);",  # 6
        "    }",  # 7
        "",  # 8
        "    function other() external {}",  # 9
        "}",  # 10
    ]
)


def _tree(root: Path, audits: str) -> None:
    (root / "contracts" / "lib").mkdir(parents=True, exist_ok=True)
    (root / "contracts" / "test").mkdir(parents=True, exist_ok=True)
    (root / "contracts" / "Teller.sol").write_text(TELLER_SOL, encoding="utf-8")
    (root / "contracts" / "lib" / "Ops.sol").write_text("library Ops {\n    function go() public {}\n}\n", encoding="utf-8")
    (root / "docs").mkdir(exist_ok=True)
    (root / AUDITS).write_text(audits, encoding="utf-8")


def self_test() -> int:
    cases = [
        ("anchored cite inside the function body passes", "| X | (`Teller.pay`, `Teller.sol:5-6`) |\n", False),
        ("NatSpec range that holds the declaration passes", "| X | (`Teller.pay` NatSpec, `Teller.sol:3-4`) |\n", False),
        ("unanchored cite inside the file passes", "| X | the fee (`Teller.sol:5`) |\n", False),
        ("comma list with an anchored range passes", "| X | `Teller.other` (`Teller.sol:5,9`) |\n", False),
        ("library path cite passes", "| X | `Ops.go` (`contracts/lib/Ops.sol:2`) |\n", False),
        ("a .t.sol cite is not read", "| X | `Teller.t.sol:999` |\n", False),
        ("an anchor before the previous cite does not bind", "| X | `Teller.other`, `Teller.sol:9`; the fee (`Teller.sol:5`) |\n", False),
        ("missing file fails", "| X | (`Gone.sol:3`) |\n", True),
        ("line past the end fails", "| X | (`Teller.sol:1538-1585`) |\n", True),
        ("inverted range fails", "| X | (`Teller.sol:6-5`) |\n", True),
        ("anchor in another function fails", "| X | (`Teller.other`, `Teller.sol:5-6`) |\n", True),
        ("stale range in a comma list fails", "| X | `Teller.pay` (`Teller.sol:9,10`) |\n", True),
    ]
    failures = 0
    for name, audits, want_fail in cases:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _tree(root, audits)
            errors, seen = check(root)
            fired = bool(errors)
            if fired != want_fail or (not want_fail and "t.sol" not in audits and seen == 0):
                failures += 1
                print(f"SELF-TEST FAIL: {name}: errors={errors} seen={seen}", file=sys.stderr)
            else:
                print(f"ok: {name}")
    print(f"{len(cases)} cases, {failures} failures")
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    errors, seen = check(repo_root())
    for e in errors:
        print(f"FAIL: {e}")
    if errors:
        return 1
    if seen == 0:
        print(f"FAIL: {AUDITS} cites no Solidity source line (zero checks would run)")
        return 1
    print(f"check_audit_source_cites: ok ({seen} Solidity source cites in {AUDITS} resolve)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
