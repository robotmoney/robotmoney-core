#!/usr/bin/env python3
"""Regression assertion for stale canonical-header patterns (issue #823).

Two stale patterns introduced by the cleanup in issue #793 are guarded:

  (A) RETIRED_PHRASE — the malformed parenthetical that calls the live
      Plan tracking issue #109 "retired" must not appear in any active
      source, test, build, or metadata file.  It was a mechanical artefact
      of the issue #793 cleanup pass.

  (B) IMPL_PLAN_HEADER — no Canonical/Implements/See-also header in an
      active source file may target docs/implementation-plan.md.  That
      file was deleted; all canonical references must now point to
      docs/architecture.md, Plan tracking issue #109, or another live doc.

Historical prose that *describes* docs/implementation-plan.md as having
been retired is explicitly allowed — pattern (B) only fires on structured
header lines starting with the canonical keywords.

Exit 0 when both assertions pass, non-zero otherwise, with a human-readable
list of offending files and lines.

No network access required.  Run from the repository root.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# File extensions to scan.  Keep this list in sync with the acceptance
# criterion in issue #823 (plus a few extras the issue did not name but
# that carry the same header convention).
SCANNED_EXTENSIONS: tuple[str, ...] = (
    ".rs",
    ".sol",
    ".ts",
    ".tsx",
    ".js",
    ".py",
    ".sh",
    ".toml",
    ".yml",
)

# (A) Exact phrase that must not appear anywhere in scanned files.
# Built from parts so this file does not trigger its own assertion.
RETIRED_PHRASE = "(" + "retired Plan tracking issue #109" + ")"

# (B) Regex that matches a structured canonical-header line targeting the
#     deleted docs/implementation-plan.md.  A "structured header line" is
#     one that starts (after optional comment-prefix characters) with one
#     of the canonical keywords followed by a colon or space.
#     The pattern explicitly excludes lines that reference docs/implementation-plan.md
#     in a historical "(formerly ...)" clause, which is the accepted form from issue #793.
IMPL_PLAN_HEADER_RE = re.compile(
    r"(?:Canonical|Implements|See[- ]also)\s*:\s*(?!Plan\s+tracking)docs/implementation-plan\.md",
    re.IGNORECASE,
)

# Directories to skip entirely (generated output, build artefacts, etc.).
EXCLUDED_DIRS: frozenset[str] = frozenset(
    {
        ".git",
        "target",
        "out",
        "cache",
        "node_modules",
        ".pnpm-store",
        "contracts/doc",          # forge doc output — machine-generated
        "contracts/lib",          # vendored Foundry libraries
    }
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def repo_root() -> Path:
    """Return the repo root via git, falling back to CWD."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
        )
        return Path(result.stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError):
        return Path.cwd()


def iter_source_files(root: Path):
    """Yield every source file under *root* that matches SCANNED_EXTENSIONS
    or is an extensionless Dockerfile or docker-compose* file."""
    for path in root.rglob("*"):
        # Skip excluded directories in-place so rglob does not descend.
        if any(excl in path.parts for excl in EXCLUDED_DIRS):
            continue
        if not path.is_file():
            continue
        # Check if file matches by extension.
        if path.suffix in SCANNED_EXTENSIONS:
            yield path
        # Check for extensionless Dockerfile or docker-compose* files.
        elif path.name == "Dockerfile" or path.name.startswith("docker-compose"):
            yield path


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


def check_retired_phrase(root: Path) -> list[str]:
    """Return a list of 'path:line: text' strings for each occurrence of
    RETIRED_PHRASE."""
    hits: list[str] = []
    for fpath in iter_source_files(root):
        try:
            text = fpath.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            if RETIRED_PHRASE in line:
                rel = fpath.relative_to(root)
                hits.append(f"{rel}:{lineno}: {line.rstrip()}")
    return hits


def check_impl_plan_header(root: Path) -> list[str]:
    """Return a list of 'path:line: text' strings for each Canonical/
    Implements/See-also header that still references
    docs/implementation-plan.md."""
    hits: list[str] = []
    for fpath in iter_source_files(root):
        try:
            text = fpath.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            if IMPL_PLAN_HEADER_RE.search(line):
                rel = fpath.relative_to(root)
                hits.append(f"{rel}:{lineno}: {line.rstrip()}")
    return hits


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    root = repo_root()
    failed = False

    # (A) Retired-phrase check.
    retired_hits = check_retired_phrase(root)
    if retired_hits:
        failed = True
        print(
            f"FAIL (A): found {len(retired_hits)} occurrence(s) of the malformed "
            f"phrase '{RETIRED_PHRASE}':",
            file=sys.stderr,
        )
        for hit in retired_hits:
            print(f"  {hit}", file=sys.stderr)
        print(
            "  Fix: remove the parenthetical — Plan tracking issue #109 is the "
            "live plan, not a retired artefact.",
            file=sys.stderr,
        )
    else:
        print(
            f"OK (A): no occurrences of '{RETIRED_PHRASE}' in scanned files."
        )

    # (B) Stale canonical-header check.
    impl_plan_hits = check_impl_plan_header(root)
    if impl_plan_hits:
        failed = True
        print(
            f"FAIL (B): found {len(impl_plan_hits)} Canonical/Implements/See-also "
            "header(s) that still target the deleted docs/implementation-plan.md:",
            file=sys.stderr,
        )
        for hit in impl_plan_hits:
            print(f"  {hit}", file=sys.stderr)
        print(
            "  Fix: update the header to reference docs/architecture.md (with the "
            "relevant §section), Plan tracking issue #109, or another live doc.",
            file=sys.stderr,
        )
    else:
        print(
            "OK (B): no active Canonical/Implements/See-also header targets "
            "docs/implementation-plan.md."
        )

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
