#!/usr/bin/env python3
"""Code-review artifact cross-check: .json / .md / -verification.md (issue #1240).

A code-review snapshot's whole value is that its Severity Summary table, its
numbered `#### SEC-*` sections, its machine-readable `.json` companion, and
its `-verification.md` verdicts all agree. Nothing else in CI reads
`docs/code-review/*.json` or cross-checks any of those counts, so drift is
invisible. On PR #1197 (issue #1207) a human compliance pass had to count by
hand and found five separate count/id defects that a green CI had already
blessed three times: a Severity Summary count that was a phrase-count of the
wrong list, a High-severity slot naming the wrong id (double-counting a
Medium and dropping the vault's only `SECURITY_DEPLOY_BLOCKER`), a Low row
whose count was right only by coincidence, an Informational row double
-counting two Low items, and a `-verification.md` header contradicting its
own Verdict Summary table three lines away.

Scope decision (recorded here and in docs/code-review/README.md): the
`.json` companion is new (PR #1197) and only
`docs/code-review/20260728-code-review-internal-kimi.json` has one today.
Every other historical `.md` snapshot predates the `#### SEC-<S>-NNN` /
Severity Summary / `.json` convention entirely (free-form finding headings,
no machine-readable companion) — running these structural checks against
them would be checking a format they never claimed to follow. So this guard
only opens a `.md` (and its optional `-verification.md`) when a sibling
`.json` exists; snapshots without a `.json` are untouched. Rewriting a
historical snapshot to satisfy these checks is out of scope (issue #1240) —
if a *new* dated snapshot with a `.json` companion cannot satisfy these
checks, fix the snapshot, never weaken the rule.

Checks performed for each `<stem>.json` / `<stem>.md` [/ `<stem>-verification.md`]
triple under `docs/code-review/`:

  1. The `.json` parses, and every `findings[]` entry has a non-empty `id`,
     `severity`, and `classification`.
  2. Per severity that the repo's convention renders as `#### SEC-<S>-NNN`
     sections (critical/high/medium), the count of those sections in the
     `.md` equals the count of `.json` entries with that severity.
  3. The Severity Summary table's `Count` column equals the section count
     for a `#### SEC-<S>-NNN` severity, or the row count of the
     Low-Severity Findings table's `L-` rows for the `Low` row.
  4. Each Severity Summary `Key areas` cell holds exactly `Count`
     comma-separated phrases, and no phrase (verbatim) appears in more than
     one severity row — catching a phrase copied into the wrong severity.
  5. Numbered ids are dense and gapless from `001` for every
     `#### SEC-<S>-NNN` severity and for the Low table's `L-NNN` rows.
  6. Every `SEC-<S>-NNN` / `L-NNN` id referenced anywhere else in the `.md`
     (e.g. "Documentation Changes Required") resolves to a real section/row.
  7. When a `-verification.md` exists: every `.json` id appears in it
     exactly once, each `## <SEVERITY> SEVERITY — ...` header's counts
     (`All N CONFIRMED` or `N of M CONFIRMED, K REFUTED`) match the `### `
     subsections actually under it, and the totals match the doc's own
     Verdict Summary table.

Exit 0 on success, non-zero on any violation. No network access. Run with
`--self-test` to confirm every rule above actually fires.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CODE_REVIEW_DIR = "docs/code-review"

# Severities the repo's convention renders as numbered `#### SEC-<S>-NNN`
# subsections (json-backed). Any other severity found in the Severity
# Summary table (e.g. "Low", "Informational") is handled without a
# heading-derived id source — "Low" via its own table (below), anything
# else structurally unverified beyond the phrase-count/duplicate checks.
SEC_LETTER_BY_SEVERITY = {
    "critical": "C",
    "high": "H",
    "medium": "M",
}

SEC_HEADING_RE = re.compile(r"^####\s+SEC-([A-Z]+)-(\d+)\b.*$", re.MULTILINE)
SEC_TOKEN_RE = re.compile(r"\bSEC-[A-Z]+-\d+\b")
LOW_ROW_RE = re.compile(r"^\|\s*(L-\d+)\s*\|", re.MULTILINE)
LOW_TOKEN_RE = re.compile(r"\bL-\d+\b")

SEVERITY_SUMMARY_ROW_RE = re.compile(
    r"^\|\s*([A-Za-z]+)\s*\|\s*(\d+)\s*\|\s*(.*?)\s*\|\s*$", re.MULTILINE
)

VERIFICATION_HEADER_RE = re.compile(
    r"^##\s+([A-Z]+)\s+SEVERITY\s+—\s+(?:"
    r"All\s+(?P<all>\d+)\s+CONFIRMED"
    r"|(?P<confirmed>\d+)\s+of\s+(?P<total>\d+)\s+CONFIRMED(?:,\s*(?P<refuted>\d+)\s+REFUTED)?"
    r")\s*$",
    re.MULTILINE,
)
VERIFICATION_SUBSECTION_RE = re.compile(
    r"^###\s+([\w.\-]+):.*—\s*(CONFIRMED|REFUTED|PARTIALLY CONFIRMED)\s*$",
    re.MULTILINE,
)
VERDICT_SUMMARY_ROW_RE = re.compile(
    r"^\|\s*([A-Z ]+?)\s*\|\s*(\d+)\s*\|", re.MULTILINE
)


def _split_phrases(cell: str) -> list[str]:
    """Split a Key areas cell into its top-level comma-separated phrases.

    Commas nested inside backticks or parentheses are not split points —
    none of the repo's Key areas phrases currently nest a top-level comma
    that way, but this keeps a phrase like "`foo(a, b)`" from being
    miscounted as two phrases.
    """
    if cell.strip() in ("", "—", "-"):
        return []
    phrases: list[str] = []
    depth = 0
    in_backtick = False
    current: list[str] = []
    for ch in cell:
        if ch == "`":
            in_backtick = not in_backtick
            current.append(ch)
        elif ch in "([" and not in_backtick:
            depth += 1
            current.append(ch)
        elif ch in ")]" and not in_backtick:
            depth -= 1
            current.append(ch)
        elif ch == "," and depth == 0 and not in_backtick:
            phrases.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
    tail = "".join(current).strip()
    if tail:
        phrases.append(tail)
    return phrases


def _find_section(text: str, heading_snippet: str) -> str | None:
    """Return the body of the first `##`/`###` section whose heading line
    contains `heading_snippet` (case-insensitive), up to the next heading of
    the same or shallower level."""
    lines = text.splitlines()
    start = None
    start_level = None
    for i, line in enumerate(lines):
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if not m:
            continue
        if start is None:
            if heading_snippet.lower() in m.group(2).lower():
                start = i + 1
                start_level = len(m.group(1))
            continue
        if len(m.group(1)) <= start_level:
            return "\n".join(lines[start:i])
    if start is not None:
        return "\n".join(lines[start:])
    return None


def _dense_gapless(numbers: list[int]) -> bool:
    return sorted(numbers) == list(range(1, len(numbers) + 1))


def _load_json(path: Path) -> tuple[dict | None, list[str]]:
    violations: list[str] = []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return None, [f"{path}: does not parse as JSON: {exc}"]

    findings = data.get("findings")
    if not isinstance(findings, list):
        return None, [f"{path}: top-level `findings` is missing or not a list"]

    for i, entry in enumerate(findings):
        if not isinstance(entry, dict):
            violations.append(f"{path}: findings[{i}] is not an object")
            continue
        for field in ("id", "severity", "classification"):
            value = entry.get(field)
            if not isinstance(value, str) or not value.strip():
                violations.append(
                    f"{path}: findings[{i}] missing non-empty `{field}`"
                )
    return data, violations


def _check_triple(json_path: Path, md_path: Path, verification_path: Path | None) -> list[str]:
    violations: list[str] = []

    data, json_violations = _load_json(json_path)
    violations.extend(json_violations)
    if data is None:
        return violations

    findings = [f for f in data["findings"] if isinstance(f, dict)]
    json_ids_by_severity: dict[str, list[str]] = {}
    for f in findings:
        sev = str(f.get("severity", "")).strip().lower()
        fid = f.get("id")
        if sev and isinstance(fid, str):
            json_ids_by_severity.setdefault(sev, []).append(fid)

    if not md_path.exists():
        violations.append(f"{json_path}: no sibling `.md` file at {md_path}")
        return violations
    md_text = md_path.read_text(encoding="utf-8")

    # --- Section headings: #### SEC-<S>-NNN, grouped by letter ---
    heading_numbers_by_letter: dict[str, list[int]] = {}
    all_heading_tokens: set[str] = set()
    for m in SEC_HEADING_RE.finditer(md_text):
        letter, num = m.group(1), int(m.group(2))
        heading_numbers_by_letter.setdefault(letter, []).append(num)
        all_heading_tokens.add(f"SEC-{letter}-{m.group(2)}")

    # --- Low-Severity Findings table rows: L-NNN ---
    low_section = _find_section(md_text, "Low-Severity Findings") or ""
    low_ids = LOW_ROW_RE.findall(low_section)
    low_numbers = [int(x.split("-")[1]) for x in low_ids]
    all_low_tokens = set(low_ids)

    # --- Check 2 & 5: json-severity section counts + dense/gapless ids ---
    for severity, letter in SEC_LETTER_BY_SEVERITY.items():
        json_count = len(json_ids_by_severity.get(severity, []))
        heading_count = len(heading_numbers_by_letter.get(letter, []))
        if json_count == 0 and heading_count == 0:
            continue
        if json_count != heading_count:
            violations.append(
                f"{md_path}: severity `{severity}` has {json_count} `.json` "
                f"entries but {heading_count} `#### SEC-{letter}-NNN` sections"
            )
        numbers = heading_numbers_by_letter.get(letter, [])
        if numbers and not _dense_gapless(numbers):
            violations.append(
                f"{md_path}: SEC-{letter}-NNN ids are not dense/gapless from "
                f"001: found {sorted(numbers)}"
            )

    if low_numbers and not _dense_gapless(low_numbers):
        violations.append(
            f"{md_path}: Low-Severity Findings L-NNN ids are not dense/"
            f"gapless from 001: found {sorted(low_numbers)}"
        )

    # --- Severity Summary table ---
    summary_section = _find_section(md_text, "Severity Summary")
    if summary_section is None:
        violations.append(f"{md_path}: no `Severity Summary` section found")
        summary_rows: list[tuple[str, int, str]] = []
    else:
        summary_rows = [
            (sev, int(count), key_areas)
            for sev, count, key_areas in SEVERITY_SUMMARY_ROW_RE.findall(summary_section)
            if sev.lower() not in ("severity",) and not set(sev) == {"-"}
        ]

    all_phrases: dict[str, list[tuple[str, str]]] = {}  # phrase -> [(severity, phrase)]
    for sev, count, key_areas in summary_rows:
        sev_lower = sev.strip().lower()
        phrases = _split_phrases(key_areas)

        # Check 3: Count column vs. structural section/row count.
        if sev_lower in SEC_LETTER_BY_SEVERITY:
            letter = SEC_LETTER_BY_SEVERITY[sev_lower]
            heading_count = len(heading_numbers_by_letter.get(letter, []))
            if count != heading_count:
                violations.append(
                    f"{md_path}: Severity Summary `{sev}` Count={count} but "
                    f"{heading_count} `#### SEC-{letter}-NNN` sections exist"
                )
        elif sev_lower == "low":
            if count != len(low_ids):
                violations.append(
                    f"{md_path}: Severity Summary `Low` Count={count} but "
                    f"the Low-Severity Findings table has {len(low_ids)} rows"
                )

        # Check 4: phrase count must equal the declared Count.
        if len(phrases) != count:
            violations.append(
                f"{md_path}: Severity Summary `{sev}` Count={count} but "
                f"Key areas lists {len(phrases)} comma-separated phrase(s)"
            )

        for phrase in phrases:
            all_phrases.setdefault(phrase, []).append((sev, phrase))

    for phrase, occurrences in all_phrases.items():
        severities = sorted({sev for sev, _ in occurrences})
        if len(occurrences) > 1 and len(severities) > 1:
            violations.append(
                f"{md_path}: Key areas phrase {phrase!r} appears under more "
                f"than one severity row: {', '.join(severities)}"
            )

    # --- Check 6: dangling id references anywhere in the .md ---
    for token in sorted(set(SEC_TOKEN_RE.findall(md_text))):
        if token not in all_heading_tokens:
            violations.append(
                f"{md_path}: `{token}` is referenced but no `#### {token}` "
                f"section exists"
            )
    for token in sorted(set(LOW_TOKEN_RE.findall(md_text))):
        if token not in all_low_tokens:
            violations.append(
                f"{md_path}: `{token}` is referenced but no matching row "
                f"exists in the Low-Severity Findings table"
            )

    # --- Check 7: -verification.md, when present ---
    if verification_path is not None and verification_path.exists():
        violations.extend(
            _check_verification(verification_path, findings, json_ids_by_severity)
        )

    return violations


def _check_verification(
    verification_path: Path,
    findings: list[dict],
    json_ids_by_severity: dict[str, list[str]],
) -> list[str]:
    violations: list[str] = []
    text = verification_path.read_text(encoding="utf-8")

    all_json_ids = {f["id"] for f in findings if isinstance(f.get("id"), str)}

    # Every json id must appear as exactly one `### <id>: ... — VERDICT` subsection.
    subsection_ids = [m.group(1) for m in VERIFICATION_SUBSECTION_RE.finditer(text)]
    seen_counts: dict[str, int] = {}
    for sid in subsection_ids:
        seen_counts[sid] = seen_counts.get(sid, 0) + 1
    for jid in sorted(all_json_ids):
        n = seen_counts.get(jid, 0)
        if n != 1:
            violations.append(
                f"{verification_path}: `.json` id `{jid}` appears "
                f"{n} time(s) as a `### <id>: ... — VERDICT` subsection "
                f"(expected exactly 1)"
            )
    extra = set(seen_counts) - all_json_ids
    for sid in sorted(extra):
        violations.append(
            f"{verification_path}: subsection `{sid}` does not match any "
            f"`.json` finding id"
        )

    # Per-severity header vs. actual subsections under that header.
    headers = list(VERIFICATION_HEADER_RE.finditer(text))
    for idx, m in enumerate(headers):
        severity_word = m.group(1)
        body_start = m.end()
        body_end = headers[idx + 1].start() if idx + 1 < len(headers) else len(text)
        body = text[body_start:body_end]

        section_subsections = [
            (sm.group(1), sm.group(2))
            for sm in VERIFICATION_SUBSECTION_RE.finditer(body)
        ]

        if m.group("all") is not None:
            total = confirmed = int(m.group("all"))
            refuted = 0
        else:
            confirmed = int(m.group("confirmed"))
            total = int(m.group("total"))
            refuted = int(m.group("refuted") or 0)

        if len(section_subsections) != total:
            violations.append(
                f"{verification_path}: `{severity_word} SEVERITY` header "
                f"declares {total} finding(s) but {len(section_subsections)} "
                f"`### ` subsection(s) follow it"
            )
        actual_confirmed = sum(1 for _, v in section_subsections if v == "CONFIRMED")
        actual_refuted = sum(1 for _, v in section_subsections if v == "REFUTED")
        if actual_confirmed != confirmed:
            violations.append(
                f"{verification_path}: `{severity_word} SEVERITY` header "
                f"declares {confirmed} CONFIRMED but {actual_confirmed} "
                f"subsection(s) are CONFIRMED"
            )
        if actual_refuted != refuted:
            violations.append(
                f"{verification_path}: `{severity_word} SEVERITY` header "
                f"declares {refuted} REFUTED but {actual_refuted} "
                f"subsection(s) are REFUTED"
            )

    # Cross-check against the doc's own Verdict Summary table.
    verdict_section = _find_section(text, "Verdict Summary")
    if verdict_section is not None:
        verdict_counts = {
            label.strip().upper(): int(count)
            for label, count in VERDICT_SUMMARY_ROW_RE.findall(verdict_section)
        }
        actual_confirmed_all = sum(
            1
            for m in VERIFICATION_SUBSECTION_RE.finditer(text)
            if m.group(2) == "CONFIRMED"
        )
        actual_refuted_all = sum(
            1 for m in VERIFICATION_SUBSECTION_RE.finditer(text) if m.group(2) == "REFUTED"
        )
        actual_partial_all = sum(
            1
            for m in VERIFICATION_SUBSECTION_RE.finditer(text)
            if m.group(2) == "PARTIALLY CONFIRMED"
        )
        expectations = {
            "CONFIRMED": actual_confirmed_all,
            "REFUTED": actual_refuted_all,
            "PARTIALLY CONFIRMED": actual_partial_all,
        }
        for label, actual in expectations.items():
            declared = verdict_counts.get(label)
            if declared is not None and declared != actual:
                violations.append(
                    f"{verification_path}: Verdict Summary table says "
                    f"{label}={declared} but {actual} subsection(s) are "
                    f"{label}"
                )

    return violations


def scan(root: Path) -> list[str]:
    violations: list[str] = []
    review_dir = root / CODE_REVIEW_DIR
    if not review_dir.is_dir():
        return [f"{review_dir}: directory does not exist"]

    for json_path in sorted(review_dir.glob("*.json")):
        stem = json_path.stem
        md_path = review_dir / f"{stem}.md"
        verification_path = review_dir / f"{stem}-verification.md"
        violations.extend(_check_triple(json_path, md_path, verification_path))

    return violations


def report(violations: list[str]) -> int:
    if violations:
        print(
            "FAIL: code-review artifact cross-check (issue #1240) found "
            "disagreement between a .json / .md / -verification.md triple:",
            file=sys.stderr,
        )
        for v in violations:
            print(f"  - {v}", file=sys.stderr)
        print(
            "\nFix the drifted count/id in the .md (or the .json, whichever "
            "is wrong) — never weaken this check to make a snapshot pass.",
            file=sys.stderr,
        )
        return 1

    print(
        "OK: every docs/code-review/*.json companion agrees with its .md "
        "Severity Summary, section ids, and (when present) its "
        "-verification.md verdicts (issue #1240)."
    )
    return 0


def _write(root: Path, rel: str, body: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body, encoding="utf-8")


def _clean_fixture(root: Path) -> None:
    _write(
        root,
        f"{CODE_REVIEW_DIR}/20990101-code-review-internal-selftest.json",
        json.dumps(
            {
                "findings": [
                    {"id": "sf-h-001", "severity": "high", "classification": "X"},
                    {"id": "sf-h-002", "severity": "high", "classification": "X"},
                    {"id": "sf-m-001", "severity": "medium", "classification": "X"},
                ]
            }
        ),
    )
    _write(
        root,
        f"{CODE_REVIEW_DIR}/20990101-code-review-internal-selftest.md",
        """\
## Severity Summary

| Severity | Count | Key areas |
|----------|-------|-----------|
| High | 2 | alpha finding, beta finding |
| Medium | 1 | gamma finding |
| Low | 1 | delta finding |

## Findings

### HIGH

#### SEC-H-001 — alpha

- **Related findings:** none

#### SEC-H-002 — beta

- **Related findings:** SEC-M-001

### MEDIUM

#### SEC-M-001 — gamma

- **Related findings:** SEC-H-002

## Low-Severity Findings (Summary)

| ID | Area | Issue |
|----|------|-------|
| L-001 | x | delta finding |
""",
    )
    _write(
        root,
        f"{CODE_REVIEW_DIR}/20990101-code-review-internal-selftest-verification.md",
        """\
## Verdict Summary

| Verdict | Count |
|---------|-------|
| CONFIRMED | 3 |
| REFUTED | 0 |

## HIGH SEVERITY — All 2 CONFIRMED

### sf-h-001: alpha — CONFIRMED

body

### sf-h-002: beta — CONFIRMED

body

## MEDIUM SEVERITY — All 1 CONFIRMED

### sf-m-001: gamma — CONFIRMED

body
""",
    )


def self_test() -> int:
    # (a) A clean fixture triple must pass with zero violations.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _clean_fixture(root)
        violations = scan(root)
        if violations:
            print("SELF-TEST FAIL: clean fixture was flagged:", file=sys.stderr)
            for v in violations:
                print(f"  - {v}", file=sys.stderr)
            return 1

    # (b) Severity Summary Count disagrees with the section count.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _clean_fixture(root)
        md = root / CODE_REVIEW_DIR / "20990101-code-review-internal-selftest.md"
        md.write_text(md.read_text().replace("| High | 2 |", "| High | 3 |"), encoding="utf-8")
        violations = scan(root)
        if not any("Count=3" in v and "High" in v for v in violations):
            print(
                "SELF-TEST FAIL: Count-vs-section-count mismatch was not flagged.",
                file=sys.stderr,
            )
            return 1

    # (c) A Key areas phrase belonging to a different severity: Medium's
    #     Count stays 1 but a second phrase (borrowed from Low) is appended,
    #     so the phrase-count-vs-Count rule must fire.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _clean_fixture(root)
        md = root / CODE_REVIEW_DIR / "20990101-code-review-internal-selftest.md"
        md.write_text(
            md.read_text().replace(
                "| Medium | 1 | gamma finding |",
                "| Medium | 1 | gamma finding, delta finding |",
            ),
            encoding="utf-8",
        )
        violations = scan(root)
        if not any(
            "Medium" in v and "Key areas lists 2" in v for v in violations
        ):
            print(
                "SELF-TEST FAIL: misattributed Key areas phrase was not flagged.",
                file=sys.stderr,
            )
            return 1

    # (d) A duplicated phrase across two severity rows (both Counts correct).
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _clean_fixture(root)
        md = root / CODE_REVIEW_DIR / "20990101-code-review-internal-selftest.md"
        text = md.read_text()
        text = text.replace(
            "| High | 2 | alpha finding, beta finding |",
            "| High | 2 | alpha finding, delta finding |",
        )
        md.write_text(text, encoding="utf-8")
        violations = scan(root)
        if not any("delta finding" in v and "more than one severity" in v for v in violations):
            print(
                "SELF-TEST FAIL: duplicated Key areas phrase across rows was not flagged.",
                file=sys.stderr,
            )
            return 1

    # (e) A dangling SEC-* reference.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _clean_fixture(root)
        md = root / CODE_REVIEW_DIR / "20990101-code-review-internal-selftest.md"
        md.write_text(
            md.read_text() + "\nSee also (SEC-M-099) for context.\n", encoding="utf-8"
        )
        violations = scan(root)
        if not any("SEC-M-099" in v for v in violations):
            print(
                "SELF-TEST FAIL: dangling SEC-* reference was not flagged.",
                file=sys.stderr,
            )
            return 1

    # (f) A -verification.md header whose N of M disagrees with the actual
    #     subsection count.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _clean_fixture(root)
        vf = (
            root
            / CODE_REVIEW_DIR
            / "20990101-code-review-internal-selftest-verification.md"
        )
        vf.write_text(
            vf.read_text().replace(
                "## MEDIUM SEVERITY — All 1 CONFIRMED",
                "## MEDIUM SEVERITY — 1 of 2 CONFIRMED, 0 REFUTED",
            ),
            encoding="utf-8",
        )
        violations = scan(root)
        if not any(
            "MEDIUM SEVERITY" in v and "declares 2 finding" in v for v in violations
        ):
            print(
                "SELF-TEST FAIL: verification header/subsection count "
                "mismatch was not flagged.",
                file=sys.stderr,
            )
            return 1

    print(
        "SELF-TEST OK: count-vs-section, misattributed/duplicated Key areas "
        "phrases, dangling SEC-* references, and verification header/"
        "subsection mismatches all fire, and a clean fixture passes "
        "(issue #1240)."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run in-process fixtures proving each rule fires, then exit.",
    )
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    return report(scan(REPO_ROOT))


if __name__ == "__main__":
    raise SystemExit(main())
