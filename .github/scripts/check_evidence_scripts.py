#!/usr/bin/env python3
"""Guard: every named evidence script exists AND every test-suite script runs.

WHY THIS GUARD EXISTS (issue #1235)
------------------------------------
Issue #1232 fixed one instance of the "check that proves nothing" family
(shape 4 -- the assertion executes but its input is silently empty). Its
closing comment named two more instances that share a different root cause
and are invisible to any executed-assertion floor:

  Shape 5 -- a named evidence script does not exist. Example:
      docs/development/headless-opencode-tests.md recorded
      `.github/scripts/tests/negative_control_drop_plugin_flag.sh` as the
      closing evidence for gap G11. That file was never written. A guarantee
      was documented as closed by a script that does not exist.

  Shape 6 -- a script exists but no workflow invokes it. Example:
      `.github/scripts/tests/negative_control_keystore_generate_flag.sh`
      existed and was named in the G12 closure text, but no
      `.github/workflows/*.yml` step ran it. It could neither pass nor fail.

TWO INVARIANTS
--------------
(A) EXISTENCE. Every path under `.github/scripts/` that is textually named in
    `docs/**` or `.github/workflows/**` must exist on disk. Only
    `.github/scripts/` is in scope -- see "WHY .github/scripts/ ONLY" below.

(B) REACHABILITY. Every script file directly under `.github/scripts/tests/`
    (the evidence/negative-control home) must be invoked by a non-comment
    line in at least one `.github/workflows/*.yml` file. A script that sits
    there named by a doc but touched by no workflow step contributes zero
    executed coverage.

WHY .github/scripts/ ONLY
--------------------------
The mechanical existence check (A) resolves a referenced path relative to the
repo root. That is only sound when the path is unambiguous. Several
workflow jobs set `working-directory:` (e.g. `clients/dapp`,
`services/watchdog`) and then invoke a script with a path relative to THAT
directory (`bash scripts/audit-deps.sh` really means
`clients/dapp/scripts/audit-deps.sh`). Naively resolving every `scripts/...`
mention against the repo root would make this guard false-red on those --
the opposite failure mode from the one #1235 exists to fix. `.github/scripts/`
is never used as a `working-directory:` value anywhere in this repo (see the
guard's own self-test and `git grep working-directory .github/workflows/`),
so a `.github/scripts/...` mention is always repo-root-relative and safe to
resolve directly.

ALLOW-LIST
----------
Every instance the sweep found when issue #1235 landed was fixed in place
rather than excused, with one exception: `ALLOWLIST_MISSING` carries the path
of the script named in G11's own withdrawal note (the doc explains, in past
tense, that the closure claim was wrong -- it is not asserting the script
exists). `ALLOWLIST_UNINVOKED` is empty. Add an entry ONLY with a comment
stating why that specific path is a deliberate exception -- never to silence
a sweep failure you have not investigated.

Run ``--self-test`` to confirm the guard fires on both seeded defects (a
doc-named script that does not exist, and a tests/ script no workflow
invokes) and that the allow-list mechanism actually suppresses a listed
entry, before trusting a green run against the real repo.

Exit 0 when both invariants hold, non-zero otherwise.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

# Directories swept for textual script-path mentions.
SEARCH_DIRS = ("docs", ".github/workflows")

# Only .github/scripts/... mentions are resolved -- see "WHY .github/scripts/
# ONLY" in the module docstring.
SCRIPT_PATH_RE = re.compile(r"\.github/scripts/[\w./-]+\.(?:sh|py)")

# The evidence/negative-control script home whose reachability (invariant B)
# is checked. Excludes the `fixtures/` subdirectory, which holds data files
# consumed BY the scripts here, not scripts themselves.
TESTS_DIR = ".github/scripts/tests"

WORKFLOWS_DIR = ".github/workflows"

# ---------------------------------------------------------------------------
# Allow-lists -- see module docstring. Both are empty today.
# ---------------------------------------------------------------------------

# Paths exempt from invariant (A): a doc/workflow may name a
# `.github/scripts/...` path that does not exist on disk.
ALLOWLIST_MISSING: frozenset[str] = frozenset(
    {
        # docs/development/headless-opencode-tests.md's G11 closure section
        # names this path ONLY to explain, in past tense, that the closure
        # claim it made was withdrawn (issue #1235) -- it was never written.
        # The doc is not asserting this script exists or runs; it is the
        # historical record of the shape-5 defect the sweep itself found.
        # Removing the path from the doc would erase that record.
        ".github/scripts/tests/negative_control_drop_plugin_flag.sh",
    }
)

# Paths exempt from invariant (B): a `.github/scripts/tests/` script that no
# workflow invokes.
ALLOWLIST_UNINVOKED: frozenset[str] = frozenset()


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


def find_referenced_scripts(root: Path) -> dict[str, set[str]]:
    """Map each `.github/scripts/...` path mentioned in SEARCH_DIRS to the
    set of files (relative to root) that mention it."""
    refs: dict[str, set[str]] = {}
    for base in SEARCH_DIRS:
        base_dir = root / base
        if not base_dir.is_dir():
            continue
        for path in sorted(base_dir.rglob("*")):
            if not path.is_file():
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            rel = str(path.relative_to(root))
            for match in SCRIPT_PATH_RE.finditer(text):
                refs.setdefault(match.group(0), set()).add(rel)
    return refs


def check_missing(
    root: Path, allowlist: frozenset[str] = ALLOWLIST_MISSING
) -> list[str]:
    """Invariant (A). Return one failure message per named script that does
    not exist on disk and is not allow-listed."""
    failures: list[str] = []
    for script_path, referrers in sorted(find_referenced_scripts(root).items()):
        if script_path in allowlist:
            continue
        if not (root / script_path).is_file():
            named_in = ", ".join(sorted(referrers))
            failures.append(
                f"{script_path} is named in {named_in} but does not exist "
                f"(shape 5: a guarantee documented as closed by a script "
                f"that was never written)"
            )
    return failures


def list_tests_dir_scripts(root: Path) -> list[str]:
    """Every .sh/.py file directly under TESTS_DIR, relative to root."""
    tests_dir = root / TESTS_DIR
    if not tests_dir.is_dir():
        return []
    return sorted(
        str(p.relative_to(root))
        for p in tests_dir.iterdir()
        if p.is_file() and p.suffix in (".sh", ".py")
    )


def _non_comment_lines(text: str) -> list[str]:
    return [line for line in text.splitlines() if not line.strip().startswith("#")]


def is_invoked(root: Path, rel_path: str) -> bool:
    """True iff some non-comment line in some workflow file mentions rel_path."""
    workflows_dir = root / WORKFLOWS_DIR
    if not workflows_dir.is_dir():
        return False
    for wf in sorted(workflows_dir.glob("*.yml")):
        try:
            text = wf.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if any(rel_path in line for line in _non_comment_lines(text)):
            return True
    return False


def check_uninvoked(
    root: Path, allowlist: frozenset[str] = ALLOWLIST_UNINVOKED
) -> list[str]:
    """Invariant (B). Return one failure message per tests/ script that no
    workflow invokes and that is not allow-listed."""
    failures: list[str] = []
    for rel_path in list_tests_dir_scripts(root):
        if rel_path in allowlist:
            continue
        if not is_invoked(root, rel_path):
            failures.append(
                f"{rel_path} exists but is invoked by NO workflow "
                f"(shape 6: a script that can neither pass nor fail)"
            )
    return failures


# --------------------------------------------------------------------------- #
# Self-test
# --------------------------------------------------------------------------- #


def _seed_compliant(root: Path) -> None:
    (root / "docs").mkdir(parents=True, exist_ok=True)
    (root / WORKFLOWS_DIR).mkdir(parents=True, exist_ok=True)
    (root / TESTS_DIR).mkdir(parents=True, exist_ok=True)

    real_script = root / TESTS_DIR / "test_real_thing.sh"
    real_script.write_text("#!/usr/bin/env bash\necho ok\n", encoding="utf-8")

    (root / "docs" / "gaps.md").write_text(
        "Closed by `.github/scripts/tests/test_real_thing.sh`.\n",
        encoding="utf-8",
    )
    (root / WORKFLOWS_DIR / "ci.yml").write_text(
        "name: ci\n"
        "on: [pull_request]\n"
        "jobs:\n"
        "  test:\n"
        "    steps:\n"
        "      - run: bash .github/scripts/tests/test_real_thing.sh\n",
        encoding="utf-8",
    )


def self_test() -> int:
    import tempfile

    ok = 0

    # (1) COMPLIANT FIXTURE -- a real, invoked script named in a doc -- must
    #     pass both invariants.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _seed_compliant(root)
        missing = check_missing(root)
        uninvoked = check_uninvoked(root)
        if missing or uninvoked:
            print(
                "SELF-TEST FAIL [compliant fixture]: a real, invoked, "
                "correctly-named script was flagged:",
                file=sys.stderr,
            )
            for f in missing + uninvoked:
                print(f"  - {f}", file=sys.stderr)
            ok = 1
        else:
            print("  self-test OK: compliant fixture passes both invariants")

    # (2) SHAPE 5 -- a doc names a script that does not exist.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _seed_compliant(root)
        (root / "docs" / "gaps.md").write_text(
            "Closed by `.github/scripts/tests/test_never_written.sh`.\n",
            encoding="utf-8",
        )
        missing = check_missing(root)
        if not any("test_never_written.sh" in f for f in missing):
            print(
                "SELF-TEST FAIL [shape 5]: a doc-named nonexistent script "
                "was not flagged.",
                file=sys.stderr,
            )
            ok = 1
        else:
            print("  self-test OK: shape 5 (missing script) fires")
            # Allow-listing the exact path must suppress the failure --
            # proves the allow-list mechanism actually works.
            suppressed = check_missing(
                root, allowlist=frozenset({".github/scripts/tests/test_never_written.sh"})
            )
            if any("test_never_written.sh" in f for f in suppressed):
                print(
                    "SELF-TEST FAIL [shape 5 allow-list]: allow-listing the "
                    "path did not suppress the failure.",
                    file=sys.stderr,
                )
                ok = 1
            else:
                print("  self-test OK: allow-listing a shape-5 entry suppresses it")

    # (3) SHAPE 6 -- a tests/ script exists but no workflow invokes it.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _seed_compliant(root)
        orphan = root / TESTS_DIR / "test_orphan.sh"
        orphan.write_text("#!/usr/bin/env bash\necho never run\n", encoding="utf-8")
        uninvoked = check_uninvoked(root)
        if not any("test_orphan.sh" in f for f in uninvoked):
            print(
                "SELF-TEST FAIL [shape 6]: an uninvoked tests/ script was "
                "not flagged.",
                file=sys.stderr,
            )
            ok = 1
        else:
            print("  self-test OK: shape 6 (uninvoked script) fires")
            suppressed = check_uninvoked(
                root, allowlist=frozenset({".github/scripts/tests/test_orphan.sh"})
            )
            if any("test_orphan.sh" in f for f in suppressed):
                print(
                    "SELF-TEST FAIL [shape 6 allow-list]: allow-listing the "
                    "path did not suppress the failure.",
                    file=sys.stderr,
                )
                ok = 1
            else:
                print("  self-test OK: allow-listing a shape-6 entry suppresses it")

    # (4) A comment-only mention of a tests/ script must NOT count as
    #     invocation -- otherwise a workflow could merely mention a script in
    #     a comment and this guard would wrongly call it reachable.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _seed_compliant(root)
        (root / WORKFLOWS_DIR / "ci.yml").write_text(
            "name: ci\n"
            "on: [pull_request]\n"
            "jobs:\n"
            "  test:\n"
            "    steps:\n"
            "      # See .github/scripts/tests/test_real_thing.sh for details.\n"
            "      - run: echo noop\n",
            encoding="utf-8",
        )
        uninvoked = check_uninvoked(root)
        if not any("test_real_thing.sh" in f for f in uninvoked):
            print(
                "SELF-TEST FAIL [comment-only mention]: a script referenced "
                "only in a workflow comment was wrongly treated as invoked.",
                file=sys.stderr,
            )
            ok = 1
        else:
            print("  self-test OK: a comment-only mention does not count as invocation")

    if ok == 0:
        print(
            "SELF-TEST PASS: the guard fires on both shapes, respects the "
            "allow-list mechanism, and does not mistake a comment for an "
            "invocation."
        )
    return ok


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()

    root = repo_root()
    missing = check_missing(root)
    uninvoked = check_uninvoked(root)
    failures = missing + uninvoked
    if failures:
        print("FAIL: evidence-script sweep found broken guarantees:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1

    referenced = len(find_referenced_scripts(root))
    tested = len(list_tests_dir_scripts(root))
    print(
        f"OK: every named .github/scripts/ path exists ({referenced} referenced), "
        f"and every .github/scripts/tests/ script is invoked by a workflow "
        f"({tested} scripts checked)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
