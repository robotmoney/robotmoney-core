#!/usr/bin/env python3
"""Drift-catcher for the dapp browser-keygen security-review ADR (issue #84).

Replaces every reviewer-facing checklist item on issue #84 with three
mechanical checks:

  (A) Heading-per-scope-item — `docs/technical/dapp-browser-keygen-review.md`
      contains a heading addressing each scope item the issue enumerates:
      custody boundary, threat model, key-export UX, fork-vs-mainnet gate,
      and go/no-go conditions. Case-insensitive substring match against
      every `#`-prefixed line in the ADR (covers `## ` and `### ` levels).

  (B) Plan + parent-ADR cross-links — `docs/implementation-plan.md` §12 and
      `docs/technical/dapp-credential-decisions.md` (the parent ADR whose
      §3.1 names this review as the unlock gate) both reference the new
      ADR by path.

  (C) Downstream UI-issue alignment — every issue listed in
      `DOWNSTREAM_ISSUES` references the ADR path in its
      `## Canonical docs` section. The list is empty until the UI
      implementation issue is filed; until then the script no-ops on (C),
      mirroring the pattern in `.github/scripts/check_dapp_credential_adr.py`.

Pattern: mirrors `.github/scripts/check_dapp_credential_adr.py`. Stdlib only,
exits 0 on success and 1 on any documented violation.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

# --- Configuration -----------------------------------------------------

ADR_PATH = Path("docs/technical/dapp-browser-keygen-review.md")
PLAN_PATH = Path("docs/implementation-plan.md")
PARENT_ADR_PATH = Path("docs/technical/dapp-credential-decisions.md")

ADR_REFERENCE_NEEDLE = "docs/technical/dapp-browser-keygen-review.md"

# Scope items from issue #84 body. Each entry is (label, list of
# substrings; ALL must appear within a single heading line, case
# insensitive). Headings are matched against any `#`-prefixed line in
# the ADR.
SCOPE_ITEMS: list[tuple[str, list[str]]] = [
    ("Custody boundary", ["custody boundary"]),
    ("Threat model", ["threat model"]),
    ("Key-export UX", ["key-export ux"]),
    ("Fork-vs-mainnet gate", ["fork", "mainnet"]),
    ("Go/no-go conditions", ["go/no-go"]),
]

# Downstream UI implementation issues that consume this ADR. Empty until
# the follow-on UI implementation issue is filed; once it exists, add its
# number here and the validator will assert its `## Canonical docs`
# section references the ADR path. Consistent with the empty-list no-op
# pattern in `.github/scripts/check_dapp_credential_adr.py`.
DOWNSTREAM_ISSUES: list[int] = []

REPO = "lucky-tensor/robotmoney-skills"


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
    """Return every Markdown heading line, lowercased and stripped."""
    return [
        line.strip().lower()
        for line in adr_text.splitlines()
        if line.lstrip().startswith("#")
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
            "WARN: `gh` not on PATH; skipping downstream issue check.",
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
            # machines but as a hard failure on CI.
            if os.environ.get("CI"):
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

    # (B) Cross-link checks: implementation-plan and parent ADR.
    plan_path = root / PLAN_PATH
    if not plan_path.is_file():
        failed = True
        print(f"FAIL: implementation-plan missing at {plan_path}", file=sys.stderr)
    elif ADR_REFERENCE_NEEDLE not in plan_path.read_text(encoding="utf-8"):
        failed = True
        print(
            f"FAIL: {PLAN_PATH} does not cross-link to {ADR_REFERENCE_NEEDLE}",
            file=sys.stderr,
        )
    else:
        print(f"OK: {PLAN_PATH} cross-links to the ADR.")

    parent_path = root / PARENT_ADR_PATH
    if not parent_path.is_file():
        failed = True
        print(f"FAIL: parent ADR missing at {parent_path}", file=sys.stderr)
    elif ADR_REFERENCE_NEEDLE not in parent_path.read_text(encoding="utf-8"):
        failed = True
        print(
            f"FAIL: {PARENT_ADR_PATH} does not cross-link to {ADR_REFERENCE_NEEDLE}",
            file=sys.stderr,
        )
    else:
        print(f"OK: {PARENT_ADR_PATH} cross-links to the ADR.")

    # (C) Downstream alignment.
    if DOWNSTREAM_ISSUES:
        downstream_failures = check_downstream_alignment()
        if downstream_failures:
            failed = True
            print(
                "FAIL: downstream UI issues do not reference the ADR:",
                file=sys.stderr,
            )
            for f in downstream_failures:
                print(f"  - {f}", file=sys.stderr)
        else:
            print(
                f"OK: all {len(DOWNSTREAM_ISSUES)} downstream issues reference the ADR."
            )
    else:
        print(
            "OK: no downstream UI issues registered yet; downstream check no-ops."
        )

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
