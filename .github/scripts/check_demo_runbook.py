#!/usr/bin/env python3
"""Validate the Phase 7 demo runbook ADR (`docs/technical/demo-runbook.md`).

Two checks, mirroring the test-plan items on issue #62:

  1. Heading-per-scope-item: the runbook must contain a heading
     covering each of the four scope items resolved by issue #62 —
     fork pin, agent task, artifact set, failure toggles.

  2. Drift check: issue #61's `## Canonical docs` section must
     reference `docs/technical/demo-runbook.md`. The check uses
     `gh issue view 61 --json body` when `gh` is available and the
     `GITHUB_TOKEN` / `GH_TOKEN` env is set; otherwise it skips loud-
     clean (prints a notice and exits 0). Skipping local-clean keeps
     the script useful in workflows that lack `gh` while still failing
     CI when the token is present (which it is on `pull_request`).

Pattern: mirrors `.github/scripts/check_gateway_coverage.py` — single
file, stdlib only, exits 0 on success and 1 on any documented
violation.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
RUNBOOK_PATH = REPO_ROOT / "docs" / "technical" / "demo-runbook.md"
RUNBOOK_REL = "docs/technical/demo-runbook.md"

# Each scope item maps to one or more case-insensitive substrings that
# must appear inside a Markdown heading line in the runbook. The
# runbook's §3 numbered subsections satisfy this; the checks here are
# loose enough to survive minor heading edits but tight enough to fail
# loudly if a scope item is dropped.
SCOPE_ITEM_HEADING_KEYWORDS: dict[str, tuple[str, ...]] = {
    "fork pin":        ("fork pin", "fork choice", "block pin"),
    "agent task":      ("agent task", "openclaw prompt", "bounded agent"),
    "artifact set":    ("artifact set", "captured artifact", "artifact"),
    "failure toggles": ("failure", "toggle"),
}

ISSUE_61_NUMBER = "61"


def _heading_lines(markdown: str) -> list[str]:
    return [line.strip() for line in markdown.splitlines() if line.lstrip().startswith("#")]


def check_runbook_headings() -> list[str]:
    if not RUNBOOK_PATH.exists():
        return [f"runbook not found at {RUNBOOK_REL}"]
    text = RUNBOOK_PATH.read_text()
    headings_lower = [h.lower() for h in _heading_lines(text)]
    missing: list[str] = []
    for scope_item, keywords in SCOPE_ITEM_HEADING_KEYWORDS.items():
        if not any(any(kw in h for kw in keywords) for h in headings_lower):
            missing.append(
                f"no heading covers scope item '{scope_item}' "
                f"(looked for any of: {', '.join(keywords)})"
            )
    return missing


REPO = "lucky-tensor/robotmoney-skills"


def _is_ci() -> bool:
    return os.environ.get("CI", "").lower() in ("1", "true", "yes")


def _gh_available_with_token() -> bool:
    if shutil.which("gh") is None:
        return False
    if not (os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")):
        return False
    return True


def check_issue_61_canonical_docs() -> tuple[list[str], bool]:
    """Returns (errors, performed). performed=False means we skipped
    loud-clean because `gh`/token were unavailable. On CI (CI=true) the
    skip is upgraded to a hard failure — same convention as
    `.github/scripts/check_explorer_adr.py`."""
    if not _gh_available_with_token():
        msg = (
            "check_issue_61_canonical_docs: `gh` or token not available; "
            "drift check skipped"
        )
        if _is_ci():
            return [f"{msg} (CI requires this check)"], True
        print(f"  [skip] {msg} (this is OK locally).", file=sys.stderr)
        return [], False
    try:
        result = subprocess.run(
            [
                "gh", "issue", "view", ISSUE_61_NUMBER,
                "--repo", REPO,
                "--json", "body",
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        return [f"failed to fetch issue #{ISSUE_61_NUMBER} via gh: {exc}"], True
    try:
        body = json.loads(result.stdout)["body"] or ""
    except (json.JSONDecodeError, KeyError) as exc:
        return [f"could not parse `gh issue view {ISSUE_61_NUMBER}` output: {exc}"], True

    # Extract the `## Canonical docs` section: from the heading line
    # up to (but not including) the next `## ` heading.
    match = re.search(
        r"^##\s+Canonical docs\s*$(.*?)(?=^##\s|\Z)",
        body,
        flags=re.MULTILINE | re.DOTALL,
    )
    if not match:
        return [f"issue #{ISSUE_61_NUMBER} has no `## Canonical docs` section"], True
    section = match.group(1)
    if RUNBOOK_REL not in section:
        return [
            f"issue #{ISSUE_61_NUMBER} `## Canonical docs` does not "
            f"reference `{RUNBOOK_REL}`. Section was:\n{section.strip()}"
        ], True
    return [], True


def main() -> int:
    errors: list[str] = []

    heading_errors = check_runbook_headings()
    if heading_errors:
        errors.extend(f"[runbook headings] {e}" for e in heading_errors)
    else:
        print(f"OK: {RUNBOOK_REL} has a heading for every scope item.")

    drift_errors, performed = check_issue_61_canonical_docs()
    if drift_errors:
        errors.extend(f"[issue #61 drift] {e}" for e in drift_errors)
    elif performed:
        print(f"OK: issue #{ISSUE_61_NUMBER} `## Canonical docs` references {RUNBOOK_REL}.")

    if errors:
        print("FAIL: demo runbook validator found issues:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
