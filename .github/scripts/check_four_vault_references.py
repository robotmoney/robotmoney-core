#!/usr/bin/env python3
"""Four-vault reference invariant (issue #479).

PRD §11 names four vault categories — Stable Yield, Protocol Asset, Agent
Token, and RWA/Thematic — and the deployed set now matches: three Active
router vaults plus a non-Active RWA/Thematic placeholder registered in
`VaultRegistry`. Product- and architecture-level docs must not claim a
"three vault" shape that contradicts this, or the dapp, the public allocation
surface, and the docs drift apart.

This drift-catcher greps the in-scope docs for phrases that assert a
three-vault deployed/catalog shape and fails if any unallowlisted hit is
found. Historical and closed-question contexts (e.g. a line that quotes the
verbatim title of the closed seeding issue #465) are allowlisted, because the
acceptance criterion explicitly permits them.

Scope (per issue #479 AC):
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
# catalog shape. We deliberately target the contradicting count phrasings, not
# every occurrence of the word "three", to avoid false positives on unrelated
# prose.
FORBIDDEN = [
    re.compile(r"\bthree[\s-]+vaults?\b", re.IGNORECASE),
    re.compile(r"\bthree registered vaults?\b", re.IGNORECASE),
    re.compile(r"\bthree active vaults?\b", re.IGNORECASE),
    re.compile(r"\bthree demo vaults?\b", re.IGNORECASE),
    re.compile(r"\bset of three vaults?\b", re.IGNORECASE),
]

# Allowlist of substrings: a line containing any of these is a historical /
# closed-question / Router-weight-vector context and is permitted to mention a
# three-vault shape. The Portfolio Router weight vector legitimately holds
# exactly three (Active, Router-eligible) vaults — the RWA placeholder is never
# weighted — so lines that describe the *router weight split* are allowed.
ALLOWLIST_SUBSTRINGS = [
    "#465",  # verbatim title of the closed demo-seeding issue
    "router weight",  # the router weight vector is a legitimate 3-way split
    "weight vector",
    "three-way split",
    "router-split",
]


def in_scope_files() -> list[Path]:
    files: list[Path] = []
    for pattern in SCOPE_GLOBS:
        for match in glob.glob(str(REPO_ROOT / pattern)):
            files.append(Path(match))
    return sorted(set(files))


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
            "deployed set (issue #479).\n"
            "PRD §11 names four vault categories and the deployed set is three "
            "Active vaults plus the non-Active RWA/Thematic placeholder.\n"
            "If a hit is a legitimate historical/closed-question or router "
            "weight-vector context, add an allowlist substring in "
            ".github/scripts/check_four_vault_references.py.\n"
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
