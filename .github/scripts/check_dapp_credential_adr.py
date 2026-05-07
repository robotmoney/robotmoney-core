#!/usr/bin/env python3
"""Drift-catcher for the dapp-credential ADR (issue #59) and its downstream consumers.

Replaces two manual review items previously on issue #59:

  (A) "Reviewer confirms record exists and answers each scope item." —
      we assert that `docs/technical/dapp-credential-decisions.md`
      contains a heading addressing every scope item the issue body
      enumerates (credential model, custody, calldata preview, config
      export). Case-insensitive substring match against `## ` and
      `### ` headings.

  (B) "Reviewer confirms downstream the human-dapp work implementation
      issue follows the recorded model." — we assert that the
      downstream issue's body references the ADR path
      `docs/technical/dapp-credential-decisions.md` in its
      `## Canonical docs` section. The downstream issue list is
      hardcoded with a comment so this script remains hermetic; the
      list mirrors the human-dapp implementation issue filed against
      `docs/implementation-plan.md` §12.

Mirrors `.github/scripts/check_explorer_adr.py` (ADR #56 / issues #57,
#58). The script exits 0 on success, non-zero on any drift, and prints
a human-readable diagnosis.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

# --- Configuration -----------------------------------------------------

ADR_PATH = Path("docs/technical/dapp-credential-decisions.md")
PLAN_PATH = Path("docs/implementation-plan.md")

# Scope items from issue #59 body. Each entry is (label, list of
# substrings; ALL must appear within a single heading line, case
# insensitive). Headings are matched against any `## ` or `### ` line in
# the ADR.
SCOPE_ITEMS: list[tuple[str, list[str]]] = [
    ("Credential model decision", ["credential model"]),
    ("Key-custody boundary", ["custody"]),
    ("Calldata-preview UX", ["calldata preview"]),
    ("rmpc config export format", ["config export"]),
]

# Downstream issues that consume this ADR. Sourced from the human-dapp
# implementation issue filed against `docs/implementation-plan.md` §12
# (issue #59's parent phase).
#
#   #60 — dapp: human implementation
#
# Each must reference the ADR path in its `## Canonical docs` section.
DOWNSTREAM_ISSUES: list[int] = [60]

REPO = "lucky-tensor/robotmoney-skills"

ADR_REFERENCE_NEEDLE = "docs/technical/dapp-credential-decisions.md"


# --- Helpers -----------------------------------------------------------


def repo_root() -> Path:
    """Locate repo root via `git rev-parse`. Fall back to CWD."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
        )
        return Path(out.stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError):
        return Path.cwd()


def adr_headings(adr_text: str) -> list[str]:
    """Return every `## `/`### ` heading line, lowercased and stripped."""
    return [
        line.strip().lower()
        for line in adr_text.splitlines()
        if line.startswith("## ") or line.startswith("### ")
    ]


def check_scope_coverage(adr_text: str) -> list[str]:
    """Return a list of scope items the ADR fails to cover."""
    headings = adr_headings(adr_text)
    missing: list[str] = []
    for label, needles in SCOPE_ITEMS:
        ok = any(all(n in h for n in needles) for h in headings)
        if not ok:
            missing.append(label)
    return missing


def fetch_issue_body(issue: int) -> str | None:
    """Return issue body via `gh`, or None if the lookup fails."""
    try:
        out = subprocess.run(
            [
                "gh",
                "issue",
                "view",
                str(issue),
                "--repo",
                REPO,
                "--json",
                "body",
                "-q",
                ".body",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return out.stdout
    except FileNotFoundError:
        print(
            "WARN: `gh` not on PATH; skipping downstream issue check. "
            "On CI this should never happen — the workflow installs `gh`.",
            file=sys.stderr,
        )
        return None
    except subprocess.CalledProcessError as e:
        print(
            f"WARN: `gh issue view {issue}` failed: {e.stderr.strip()}",
            file=sys.stderr,
        )
        return None


def canonical_docs_section(body: str) -> str | None:
    """Return the `## Canonical docs` section body, or None if absent."""
    m = re.search(
        r"^##\s+Canonical docs\s*$(.*?)(?=^##\s|\Z)",
        body,
        re.MULTILINE | re.DOTALL,
    )
    if not m:
        return None
    return m.group(1)


def check_downstream_alignment() -> list[str]:
    """Return list of failure messages for downstream issues missing the ADR."""
    failures: list[str] = []
    for issue in DOWNSTREAM_ISSUES:
        body = fetch_issue_body(issue)
        if body is None:
            # `gh` unavailable or fetch failed — treat as skip on dev
            # machines but as a hard failure on CI (CI sets CI=true).
            if (
                subprocess.run(
                    ["sh", "-c", "test -n \"$CI\""], check=False
                ).returncode
                == 0
            ):
                failures.append(
                    f"issue #{issue}: could not fetch body via `gh` (CI requires this check)"
                )
            continue
        section = canonical_docs_section(body)
        if section is None:
            failures.append(
                f"issue #{issue}: no `## Canonical docs` section found"
            )
            continue
        if ADR_REFERENCE_NEEDLE not in section:
            failures.append(
                f"issue #{issue}: `## Canonical docs` does not reference "
                f"`{ADR_REFERENCE_NEEDLE}`"
            )
    return failures


# --- Main --------------------------------------------------------------


def main() -> int:
    root = repo_root()
    adr_path = root / ADR_PATH
    if not adr_path.is_file():
        print(f"FAIL: ADR missing at {adr_path}", file=sys.stderr)
        return 1
    adr_text = adr_path.read_text(encoding="utf-8")

    plan_path = root / PLAN_PATH
    if not plan_path.is_file():
        print(f"FAIL: implementation-plan missing at {plan_path}", file=sys.stderr)
        return 1
    if ADR_REFERENCE_NEEDLE not in plan_path.read_text(encoding="utf-8"):
        print(
            f"FAIL: {PLAN_PATH} does not cross-link to {ADR_REFERENCE_NEEDLE}",
            file=sys.stderr,
        )
        return 1

    failed = False

    # (A) ADR scope coverage.
    missing_scope = check_scope_coverage(adr_text)
    if missing_scope:
        failed = True
        print("FAIL: ADR is missing headings for scope items:", file=sys.stderr)
        for m in missing_scope:
            print(f"  - {m}", file=sys.stderr)
    else:
        print(f"OK: ADR covers all {len(SCOPE_ITEMS)} scope items.")

    # (B) Downstream alignment.
    downstream_failures = check_downstream_alignment()
    if downstream_failures:
        failed = True
        print("FAIL: downstream dapp issues do not reference the ADR:", file=sys.stderr)
        for f in downstream_failures:
            print(f"  - {f}", file=sys.stderr)
    else:
        print(
            f"OK: all {len(DOWNSTREAM_ISSUES)} downstream issues reference the ADR."
        )

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
