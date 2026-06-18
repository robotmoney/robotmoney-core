#!/usr/bin/env python3
"""Passthrough-removal invariant (issue #912).

The `PassthroughAdapter` test escape hatch and its `USE_PASSTHROUGH_ADAPTER`
deploy flag were removed from the production deploy surface: the adapter
compiled into the production artifact set (`foundry.toml` `src = "contracts"`)
and was reachable from `Deploy.s.sol::run()` via an unguarded env read, so a
stray env var could have deployed a no-yield 1:1 adapter to mainnet.

This guard greps the tracked source tree for either banned token and fails on
any hit outside a small allowlist of historical review / scout documents that
intentionally record the (now-removed) surface. It is the CI grep-guard called
for in the issue test plan.

Exit 0 on success, non-zero on any unallowlisted hit. No network access.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# The two banned tokens. After issue #912 neither may appear in live source.
FORBIDDEN_TOKENS = ("USE_PASSTHROUGH_ADAPTER", "PassthroughAdapter")

# Allowlisted paths: historical code-review snapshots and the scout seam map
# legitimately quote the removed surface, and this guard names the tokens in
# its own docstring/data. These are NOT live source.
ALLOWLIST_PATHS = {
    ".github/scripts/check_no_passthrough_adapter.py",
    "docs/technical/testcode-removal-seams.md",
    "docs/code-reviews/gap-analysis-20260607.md",
    "docs/code-review/smart-contract-vulnerability-audit-20260609.md",
    "docs/code-reviews/security-review-20260612.md",
}


def tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files"],
        cwd=str(REPO_ROOT),
        check=True,
        capture_output=True,
        text=True,
    )
    return [line for line in out.stdout.splitlines() if line]


def main() -> int:
    hits: list[str] = []
    for rel in tracked_files():
        if rel in ALLOWLIST_PATHS:
            continue
        path = REPO_ROOT / rel
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            for token in FORBIDDEN_TOKENS:
                if token in line:
                    hits.append(f"{rel}:{lineno}: {line.strip()}")

    if hits:
        print(
            "FAIL: passthrough-removal invariant (issue #912) violated — the "
            "following tracked, non-allowlisted files still reference the "
            "removed PassthroughAdapter / USE_PASSTHROUGH_ADAPTER surface:",
            file=sys.stderr,
        )
        for h in hits:
            print(f"  {h}", file=sys.stderr)
        print(
            "\nThe test-only no-yield adapter now lives at "
            "contracts/test/helpers/NoYieldTestAdapter.sol and the deploy script "
            "wires only the three real adapters. Remove the reference or, for a "
            "genuine historical-review doc, add its path to ALLOWLIST_PATHS.",
            file=sys.stderr,
        )
        return 1

    print(
        "OK: no PassthroughAdapter / USE_PASSTHROUGH_ADAPTER references in "
        "tracked source (issue #912)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
