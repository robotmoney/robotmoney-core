#!/usr/bin/env python3
"""Drift-catcher for the source-doc reconciliation ADR (issue #92).

Replaces manual review for the acceptance criteria on issue #92:

  (A) "Every contradiction flagged in `docs/papers/open-questions.md`
      has a corresponding ADR section." — we parse every `### N.M ...`
      heading under `## 1. Cross-document contradictions` in
      open-questions.md and assert the ADR
      (`docs/technical/source-doc-reconciliation.md`) has a heading
      that starts with the same `N.M`.

  (B) "Each contradicting source doc contains a link back to the ADR
      section." — we assert each of the three frozen source papers
      (whitepaper, plan v4, PRD) and `open-questions.md` itself
      reference `docs/technical/source-doc-reconciliation.md`.

  (C) "ADR exists, has a header per question, and includes
      'Decision' + 'Rejected alternatives'." — we assert each `## 1.M`
      ADR section contains the bold-token markers
      `**Decision.**` and either `**Rejected alternatives` (regular
      contradictions) or `**Rejected alternatives (interim` (deferred
      questions). This catches an ADR section being added with no
      content.

  (D) "Implementation plan cross-links the ADR." — we assert
      `docs/implementation-plan.md` contains the ADR path.

The script exits 0 on success, non-zero on any drift, and prints a
human-readable diagnosis. It does not require network access.

Equivalent name `check_open_questions_adrs.py` mentioned in issue #92
maps to this script — there is one validator per ADR drift-catcher in
this repo and this is it for issue #92.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

# --- Configuration -----------------------------------------------------

ADR_PATH = Path("docs/technical/source-doc-reconciliation.md")
OPEN_QUESTIONS_PATH = Path("docs/papers/open-questions.md")
PLAN_PATH = Path("docs/implementation-plan.md")

SOURCE_PAPERS: list[Path] = [
    Path("docs/papers/Robot-Money-Whitepaper-v01.md"),
    Path("docs/papers/robot_money_plan_v4.md"),
    Path("docs/papers/robot_money_prd.md"),
]

ADR_REFERENCE_NEEDLE = "docs/technical/source-doc-reconciliation.md"

# Heading under which contradiction subsections live in
# open-questions.md. The validator extracts every `### N.M ...` until
# the next `## ` heading.
CONTRADICTIONS_SECTION_HEADING = "## 1. Cross-document contradictions"


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


def extract_contradiction_numbers(open_questions_text: str) -> list[str]:
    """Return ['1.1', '1.2', ...] for every `### N.M` under §1."""
    # Slice from the §1 heading to the next `## ` heading.
    start = open_questions_text.find(CONTRADICTIONS_SECTION_HEADING)
    if start < 0:
        return []
    rest = open_questions_text[start + len(CONTRADICTIONS_SECTION_HEADING):]
    next_h2 = re.search(r"^##\s+\S", rest, re.MULTILINE)
    if next_h2:
        rest = rest[: next_h2.start()]
    nums: list[str] = []
    for m in re.finditer(r"^###\s+(\d+\.\d+)\b", rest, re.MULTILINE):
        nums.append(m.group(1))
    return nums


def adr_section_for(adr_text: str, num: str) -> str | None:
    """Return the body of the ADR's `## {num}` section, or None.

    Match is anchored to a `## {num}` heading line. The section ends at
    the next `## ` heading or end of file.
    """
    pattern = re.compile(
        rf"^##\s+{re.escape(num)}\b(.*?)(?=^##\s|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    m = pattern.search(adr_text)
    return m.group(1) if m else None


def section_has_required_markers(body: str) -> list[str]:
    """Return list of missing markers in an ADR section body."""
    missing: list[str] = []
    if "**Decision.**" not in body:
        missing.append("**Decision.** marker")
    # Either the regular or the deferred-question rejected-alternatives marker.
    if (
        "**Rejected alternatives.**" not in body
        and "**Rejected alternatives (interim" not in body
    ):
        missing.append("**Rejected alternatives.** marker")
    return missing


# --- Main --------------------------------------------------------------


def main() -> int:
    root = repo_root()

    adr_path = root / ADR_PATH
    oq_path = root / OPEN_QUESTIONS_PATH

    # Both files were intentionally removed in the multi-vault product-direction
    # commit (f3a3268): open-questions.md was folded into prd.md and the ADR was
    # superseded. When neither source file exists the contradiction-ADR workflow
    # no longer applies; treat as a no-op rather than a hard failure.
    if not oq_path.is_file() and not adr_path.is_file():
        print(
            "OK: open-questions.md and source-doc-reconciliation.md both absent "
            "— contradiction-ADR workflow superseded; check skipped."
        )
        return 0

    if not adr_path.is_file():
        print(f"FAIL: ADR missing at {adr_path}", file=sys.stderr)
        return 1
    adr_text = adr_path.read_text(encoding="utf-8")

    if not oq_path.is_file():
        print(f"FAIL: open-questions missing at {oq_path}", file=sys.stderr)
        return 1
    oq_text = oq_path.read_text(encoding="utf-8")

    plan_path = root / PLAN_PATH
    if not plan_path.is_file():
        print(f"FAIL: implementation-plan missing at {plan_path}", file=sys.stderr)
        return 1
    plan_text = plan_path.read_text(encoding="utf-8")

    failed = False

    # (A) Every §1 contradiction has an ADR section.
    nums = extract_contradiction_numbers(oq_text)
    if not nums:
        print(
            f"FAIL: no `### N.M` contradiction headings found under "
            f"'{CONTRADICTIONS_SECTION_HEADING}' in {OPEN_QUESTIONS_PATH}",
            file=sys.stderr,
        )
        return 1

    missing_sections: list[str] = []
    incomplete_sections: list[tuple[str, list[str]]] = []
    for num in nums:
        body = adr_section_for(adr_text, num)
        if body is None:
            missing_sections.append(num)
            continue
        miss = section_has_required_markers(body)
        if miss:
            incomplete_sections.append((num, miss))

    if missing_sections:
        failed = True
        print(
            f"FAIL: ADR is missing `## N.M` sections for these "
            f"contradictions in {OPEN_QUESTIONS_PATH}:",
            file=sys.stderr,
        )
        for n in missing_sections:
            print(f"  - §{n}", file=sys.stderr)

    if incomplete_sections:
        failed = True
        print(
            "FAIL: ADR sections exist but are missing required markers:",
            file=sys.stderr,
        )
        for n, miss in incomplete_sections:
            for m in miss:
                print(f"  - §{n}: {m}", file=sys.stderr)

    if not (missing_sections or incomplete_sections):
        print(f"OK: ADR covers all {len(nums)} §1 contradictions.")

    # (B) Source papers and open-questions reference the ADR.
    # Source papers may be absent when they are intentionally gitignored
    # (kept local-only per issue #147); skip the backlink check for those.
    backlink_targets: list[Path] = SOURCE_PAPERS + [OPEN_QUESTIONS_PATH]
    missing_backlinks: list[str] = []
    checked: list[Path] = []
    for rel in backlink_targets:
        p = root / rel
        if not p.is_file():
            print(f"NOTE: {rel} not present locally — skipping backlink check.")
            continue
        checked.append(rel)
        if ADR_REFERENCE_NEEDLE not in p.read_text(encoding="utf-8"):
            missing_backlinks.append(str(rel))
    if missing_backlinks:
        failed = True
        print(
            f"FAIL: these documents do not cross-link to "
            f"`{ADR_REFERENCE_NEEDLE}`:",
            file=sys.stderr,
        )
        for f in missing_backlinks:
            print(f"  - {f}", file=sys.stderr)
    else:
        print(
            f"OK: all {len(checked)} present source/companion docs "
            f"reference the ADR."
        )

    # (D) Implementation plan cross-links the ADR.
    if ADR_REFERENCE_NEEDLE not in plan_text:
        failed = True
        print(
            f"FAIL: {PLAN_PATH} does not reference `{ADR_REFERENCE_NEEDLE}`.",
            file=sys.stderr,
        )
    else:
        print(f"OK: {PLAN_PATH} references the ADR.")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
