#!/usr/bin/env python3
"""Guard: the false-green shape catalogue exists, is well-formed, and its
citations resolve (issue #1272).

WHY THIS GUARD EXISTS
----------------------
During a graded loop session the coordinator retyped a catalogue of known
false-green CI shapes into each reviewer dispatch as prose. It grew from six
shapes to seven mid-session with no record, and nobody could check
afterwards which shapes a given review actually considered. Persisting the
catalogue at `docs/development/false-green-shapes.md` only fixes that if the
file stays honest: every section keeps the four parts a citation depends on,
and every workflow path / issue number it names still resolves.

FIVE INVARIANTS
----------------
(A) EXISTENCE. `docs/development/false-green-shapes.md` exists.
(B) STRUCTURE. Every `##` section (a shape) contains all four required `###`
    subsections: Name, Mechanism, Instance, Detecting check. There are at
    least MIN_SHAPES such sections.
(C) WORKFLOW PATHS RESOLVE. Every `.github/workflows/*.yml` path cited
    anywhere in the file exists on disk.
(D) ISSUE NUMBERS RESOLVE. Every `#<number>` cited anywhere in the file
    names a real GitHub issue (checked via `gh issue view`, injectable for
    the self-test so it needs no network).
(E) BACK-LINK. `docs/development/ci-suites.md` links to the catalogue by
    path, so a reader at the point ci-suites.md discusses CI truthfulness
    can reach the catalogue rather than finding it restated inline.

Every invariant increments an assertion counter, INCLUDING the existence
check, so a missing file still reports a non-zero assertion count (one
failed assertion) rather than passing vacuously with zero.

Run ``--self-test`` to confirm the guard fires on each defect shape (missing
file, a section missing a subsection, fewer than MIN_SHAPES sections, a
dangling workflow path, a dangling issue number, a ci-suites.md with no
back-link) before trusting a green run against the real repo.

Exit 0 when all invariants hold, non-zero otherwise.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

CATALOGUE_REL = "docs/development/false-green-shapes.md"
CI_SUITES_REL = "docs/development/ci-suites.md"
MIN_SHAPES = 7
REQUIRED_SUBSECTIONS = ("Name", "Mechanism", "Instance", "Detecting check")

# A markdown link whose target names the catalogue file, e.g.
# `[false-green-shapes.md](./false-green-shapes.md)` or a `#anchor` variant.
CATALOGUE_LINK_RE = re.compile(r"\]\([^)]*false-green-shapes\.md[^)]*\)")

# `## <title>` at the start of a line marks one shape section. Excludes `###`
# (subsections) because `re.MULTILINE` `^## ` would also match a `###` line's
# first two characters if not anchored on a following non-`#` char.
SECTION_RE = re.compile(r"^## (?!#)(.+?)\s*$", re.MULTILINE)
SUBSECTION_RE = re.compile(r"^### (.+?)\s*$", re.MULTILINE)

# A workflow path mention. Deliberately requires a real filename character
# class so a bare "`.github/workflows/`" prose mention (no filename) is not
# miscounted as a citation.
WORKFLOW_PATH_RE = re.compile(r"\.github/workflows/[\w.\-]+\.ya?ml")

# `#1235`-style issue references. Requires the `#` be immediately followed by
# 2-6 digits with no leading space, so a `## `/`### ` heading marker (which is
# always followed by a space) can never match.
ISSUE_RE = re.compile(r"#(\d{2,6})\b")


def repo_root() -> Path:
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


def parse_sections(text: str) -> list[tuple[str, str]]:
    """Split the catalogue body into (title, body) pairs, one per `##`
    section. `body` runs until the next `##` heading or end of file."""
    matches = list(SECTION_RE.finditer(text))
    sections: list[tuple[str, str]] = []
    for i, m in enumerate(matches):
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        sections.append((m.group(1), text[start:end]))
    return sections


def section_subsections(body: str) -> set[str]:
    return {m.group(1) for m in SUBSECTION_RE.finditer(body)}


def gh_issue_resolves(number: int) -> bool:
    """True iff `gh issue view <number>` succeeds against this repo."""
    try:
        subprocess.run(
            ["gh", "issue", "view", str(number), "--json", "number"],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return True
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return False


def check_catalogue(
    root: Path, resolve_issue=gh_issue_resolves
) -> tuple[list[str], int]:
    """Run all four invariants. Returns (failures, assertion_count)."""
    failures: list[str] = []
    assertions = 0

    # (A) EXISTENCE -- always counted, even on failure, so a missing file
    # reports one failed assertion rather than zero.
    assertions += 1
    catalogue = root / CATALOGUE_REL
    if not catalogue.is_file():
        failures.append(f"{CATALOGUE_REL} does not exist")
        return failures, assertions

    text = catalogue.read_text(encoding="utf-8")

    # (B) STRUCTURE
    sections = parse_sections(text)
    assertions += 1
    if len(sections) < MIN_SHAPES:
        failures.append(
            f"only {len(sections)} shape sections found, expected at least "
            f"{MIN_SHAPES}"
        )
    for title, body in sections:
        assertions += 1
        present = section_subsections(body)
        missing = [s for s in REQUIRED_SUBSECTIONS if s not in present]
        if missing:
            failures.append(
                f"section '{title}' is missing required subsection(s): "
                f"{', '.join(missing)}"
            )

    # (C) WORKFLOW PATHS RESOLVE
    workflow_paths = sorted(set(WORKFLOW_PATH_RE.findall(text)))
    for path in workflow_paths:
        assertions += 1
        if not (root / path).is_file():
            failures.append(f"cited workflow path does not exist: {path}")

    # (D) ISSUE NUMBERS RESOLVE
    issue_numbers = sorted({int(n) for n in ISSUE_RE.findall(text)})
    for number in issue_numbers:
        assertions += 1
        if not resolve_issue(number):
            failures.append(f"cited issue does not resolve: #{number}")

    # (E) BACK-LINK -- ci-suites.md must link to the catalogue rather than
    # restating a shape inline.
    assertions += 1
    ci_suites = root / CI_SUITES_REL
    if not ci_suites.is_file():
        failures.append(f"{CI_SUITES_REL} does not exist")
    else:
        ci_suites_text = ci_suites.read_text(encoding="utf-8")
        if not CATALOGUE_LINK_RE.search(ci_suites_text):
            failures.append(
                f"{CI_SUITES_REL} does not link to {CATALOGUE_REL}"
            )

    return failures, assertions


# --------------------------------------------------------------------------- #
# Self-test
# --------------------------------------------------------------------------- #


def _good_body(name: str) -> str:
    return (
        f"### Name\n`{name}`\n\n"
        "### Mechanism\nSomething silently proves nothing.\n\n"
        "### Instance\n`.github/workflows/ci.yml` (issue #1)\n\n"
        "### Detecting check\nA self-test.\n\n"
    )


def _seed_compliant(root: Path) -> None:
    (root / "docs" / "development").mkdir(parents=True, exist_ok=True)
    (root / ".github" / "workflows").mkdir(parents=True, exist_ok=True)
    (root / ".github" / "workflows" / "ci.yml").write_text(
        "name: ci\non: [pull_request]\n", encoding="utf-8"
    )

    body = "# Catalogue\n\nIntro prose.\n\n---\n\n"
    for i in range(MIN_SHAPES):
        body += f"## Shape {i}\n\n{_good_body(f'shape-{i}')}---\n\n"
    (root / CATALOGUE_REL).write_text(body, encoding="utf-8")

    (root / CI_SUITES_REL).write_text(
        "# CI Suite Inventory\n\n"
        "See [false-green-shapes.md](./false-green-shapes.md) for the catalogue.\n",
        encoding="utf-8",
    )


def _always_true(_: int) -> bool:
    return True


def _only_one_resolves(n: int) -> bool:
    return n == 1


def self_test() -> int:
    import tempfile

    ok = 0

    # (1) COMPLIANT FIXTURE -- must pass every invariant, and report a
    #     positive assertion count.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _seed_compliant(root)
        failures, assertions = check_catalogue(root, resolve_issue=_always_true)
        if failures or assertions <= 0:
            print(
                "SELF-TEST FAIL [compliant fixture]: a well-formed catalogue "
                f"was flagged or reported no assertions: {failures!r}, "
                f"assertions={assertions}",
                file=sys.stderr,
            )
            ok = 1
        else:
            print(f"  self-test OK: compliant fixture passes ({assertions} assertions)")

    # (2) MISSING FILE -- must fail, AND must report a non-zero assertion
    #     count rather than passing vacuously.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        failures, assertions = check_catalogue(root, resolve_issue=_always_true)
        if not failures or assertions <= 0:
            print(
                "SELF-TEST FAIL [missing file]: absence of the catalogue was "
                f"not flagged, or reported zero assertions: {failures!r}, "
                f"assertions={assertions}",
                file=sys.stderr,
            )
            ok = 1
        else:
            print(
                f"  self-test OK: a missing catalogue fails loudly "
                f"({assertions} assertion(s), not zero)"
            )

    # (3) TOO FEW SHAPES.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _seed_compliant(root)
        body = "# Catalogue\n\n---\n\n" + f"## Only one\n\n{_good_body('only-one')}"
        (root / CATALOGUE_REL).write_text(body, encoding="utf-8")
        failures, _ = check_catalogue(root, resolve_issue=_always_true)
        if not any("shape sections found" in f for f in failures):
            print(
                "SELF-TEST FAIL [too few shapes]: a catalogue with only one "
                "section was not flagged.",
                file=sys.stderr,
            )
            ok = 1
        else:
            print("  self-test OK: fewer than MIN_SHAPES sections fires")

    # (4) MISSING SUBSECTION.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _seed_compliant(root)
        text = (root / CATALOGUE_REL).read_text(encoding="utf-8")
        text = text.replace("### Detecting check\nA self-test.\n\n", "", 1)
        (root / CATALOGUE_REL).write_text(text, encoding="utf-8")
        failures, _ = check_catalogue(root, resolve_issue=_always_true)
        if not any("Detecting check" in f for f in failures):
            print(
                "SELF-TEST FAIL [missing subsection]: a section missing "
                "'Detecting check' was not flagged.",
                file=sys.stderr,
            )
            ok = 1
        else:
            print("  self-test OK: a section missing a required subsection fires")

    # (5) DANGLING WORKFLOW PATH.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _seed_compliant(root)
        text = (root / CATALOGUE_REL).read_text(encoding="utf-8")
        text = text.replace(
            "`.github/workflows/ci.yml`", "`.github/workflows/does-not-exist.yml`"
        )
        (root / CATALOGUE_REL).write_text(text, encoding="utf-8")
        failures, _ = check_catalogue(root, resolve_issue=_always_true)
        if not any("does-not-exist.yml" in f for f in failures):
            print(
                "SELF-TEST FAIL [dangling workflow path]: a nonexistent "
                "workflow path was not flagged.",
                file=sys.stderr,
            )
            ok = 1
        else:
            print("  self-test OK: a dangling workflow path fires")

    # (6) DANGLING ISSUE NUMBER.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _seed_compliant(root)
        text = (root / CATALOGUE_REL).read_text(encoding="utf-8")
        text = text.replace("(issue #1)", "(issue #999999)", 1)
        (root / CATALOGUE_REL).write_text(text, encoding="utf-8")
        failures, _ = check_catalogue(root, resolve_issue=_only_one_resolves)
        if not any("#999999" in f for f in failures):
            print(
                "SELF-TEST FAIL [dangling issue]: an issue number that does "
                "not resolve was not flagged.",
                file=sys.stderr,
            )
            ok = 1
        else:
            print("  self-test OK: a dangling issue number fires")

    # (7) MISSING BACK-LINK -- ci-suites.md exists but does not link to the
    #     catalogue.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _seed_compliant(root)
        (root / CI_SUITES_REL).write_text(
            "# CI Suite Inventory\n\nNo mention of the catalogue here.\n",
            encoding="utf-8",
        )
        failures, _ = check_catalogue(root, resolve_issue=_always_true)
        if not any("does not link to" in f for f in failures):
            print(
                "SELF-TEST FAIL [missing back-link]: a ci-suites.md with no "
                "link to the catalogue was not flagged.",
                file=sys.stderr,
            )
            ok = 1
        else:
            print("  self-test OK: a ci-suites.md missing the catalogue link fires")

    if ok == 0:
        print(
            "SELF-TEST PASS: the guard fires on a missing file (with a "
            "non-zero assertion count), too few shapes, a missing "
            "subsection, a dangling workflow path, a dangling issue "
            "number, and a missing ci-suites.md back-link, and passes a "
            "compliant fixture."
        )
    return ok


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()

    root = repo_root()
    failures, assertions = check_catalogue(root)
    if failures:
        print("FAIL: false-green shape catalogue check failed:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        print(f"CHECK_FALSE_GREEN_CATALOGUE_ASSERTIONS={assertions}", file=sys.stderr)
        return 1

    print(
        f"OK: {CATALOGUE_REL} exists, every section carries all four "
        f"required subsections, and every cited workflow path and issue "
        f"number resolves ({assertions} assertions)."
    )
    print(f"CHECK_FALSE_GREEN_CATALOGUE_ASSERTIONS={assertions}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
