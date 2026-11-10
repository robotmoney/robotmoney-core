#!/usr/bin/env python3
"""Four-vault reference invariant (issue #479, inverted by #1912, restored by core 2008, ADR-0018).

Until 2026-10-22 the deployed set was four Active vaults (rmUSDC, rmPROTO,
rmAGENT, rmRWA). ADR-0017 retired rmAGENT and the router routed across three
vaults. ADR-0018 adds rmHARD (Robot Money Hard Assets, PAXG) in the retired
rmAGENT slot, so the router routes across four vaults again: rmUSDC, rmPROTO,
rmRWA and rmHARD, and a new deployment has four vault stages. Product- and
architecture-level docs must not claim a three-vault deployed or catalog shape
as the current one, or the dapp, the public allocation surface, and the docs
drift apart.

This drift-catcher greps the in-scope docs for phrases that assert a
three-vault shape and fails if any unallowlisted hit is found. Historical
contexts (the v0.6.0 three-vault line between ADR-0017 and ADR-0018, the
retired rmAGENT, the ADRs) are allowlisted by substring.

Scope:
  - docs/prd.md
  - docs/architecture.md
  - docs/development/*.md

Exit 0 on success, non-zero on any unallowlisted hit, with a human-readable
diagnosis. No network access required.
"""

from __future__ import annotations

import glob
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# Files in scope for the invariant.
SCOPE_GLOBS = [
    "docs/prd.md",
    "docs/architecture.md",
    "docs/development/*.md",
]

# Phrases (case-insensitive regexes) that assert a three-vault deployed or
# catalog shape. We target the count phrasings, not every occurrence of the word
# "three", to avoid false positives on unrelated prose.
FORBIDDEN = [
    re.compile(r"\bthree[\s-]+vaults?\b", re.IGNORECASE),
    re.compile(r"\bthree registered vaults?\b", re.IGNORECASE),
    re.compile(r"\bthree active vaults?\b", re.IGNORECASE),
    re.compile(r"\bthree demo vaults?\b", re.IGNORECASE),
    re.compile(r"\bset of three vaults?\b", re.IGNORECASE),
    re.compile(r"\ball three (?:vaults?|legs?)\b", re.IGNORECASE),
]

# Allowlist of substrings: a line containing any of these is a historical /
# retired-vault / pinned-release context and may mention a three-vault shape.
ALLOWLIST_SUBSTRINGS = [
    "adr-0017",  # the three-vault decision ADR-0018 supersedes in part, and every line that cites it
    "retired",  # the retired rmAGENT and its withdraw-only state
    "retire-vault",  # the govern row that retires it
    "v0.6.0",  # the three-vault release line
    "historical",
    "#465",  # verbatim title of the closed demo-seeding issue
]


# Dated QA planning records written while the deployed set was four vaults: history.
EXCLUDED = {"docs/development/qa-plan-v1.md", "docs/development/qa-merge-deferred.md"}


def in_scope_files() -> list[Path]:
    files: list[Path] = []
    for pattern in SCOPE_GLOBS:
        for match in glob.glob(str(REPO_ROOT / pattern)):
            files.append(Path(match))
    return sorted(p for p in set(files) if str(p.relative_to(REPO_ROOT)) not in EXCLUDED)


def line_is_allowlisted(line: str) -> bool:
    low = line.lower()
    return any(sub.lower() in low for sub in ALLOWLIST_SUBSTRINGS)


def main() -> int:
    violations: list[str] = []
    for path in in_scope_files():
        rel = path.relative_to(REPO_ROOT)
        for lineno, line in enumerate(path.read_text().splitlines(), start=1):
            if line_is_allowlisted(line):
                continue
            for rx in FORBIDDEN:
                if rx.search(line):
                    violations.append(f"{rel}:{lineno}: {line.strip()}")
                    break

    if violations:
        print(
            "FAIL: found three-vault references that contradict the four-vault "
            "deployed set (core 2008, ADR-0018).\n"
            "The router routes across rmUSDC, rmPROTO, rmRWA and rmHARD; rmAGENT is "
            "retired (withdraw-only).\n"
            "If a hit is a legitimate historical or retired-vault context, add an "
            "allowlist substring in .github/scripts/check_four_vault_references.py.\n"
        )
        for v in violations:
            print(f"  {v}")
        return 1

    print(
        f"OK: {len(in_scope_files())} in-scope docs contain no contradicting "
        "three-vault references."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
