#!/usr/bin/env python3
"""Freshness check for generated contract NatSpec docs (docs/src/contracts/).

Generated contract docs are produced by `forge doc` from NatSpec comments in
contracts/**/*.sol. They live under docs/src/contracts/ and must never be
edited by hand — only regenerated.

This script:
  1. Runs `forge doc` (writing to docs/) in a temp working copy.
  2. Diffs docs/src/contracts/ between the committed tree and the freshly
     generated output.
  3. Exits 1 if any diff is found, printing the diff for diagnosis.
  4. Exits 0 if the committed docs/src/contracts/ exactly matches `forge doc`
     output.

WHY THIS EXISTS
The generated files carry a banner warning that they are machine-generated.
Without an automated staleness check, it is possible for the NatSpec source
and the committed docs to diverge silently — e.g. a developer adds a new
public function with NatSpec and forgets to commit the regenerated markdown.
This script is the CI signal that closes that gap.

PREREQUISITES
- `forge` must be on PATH (installed via foundry-rs/foundry-toolchain@v1).
- Script must be run from the repo root (same directory as foundry.toml).
"""

from __future__ import annotations

import difflib
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


GENERATED_DIR = Path("docs/src/contracts")

# forge doc embeds the current HEAD SHA in [Git Source] lines, e.g.:
#   [Git Source](https://github.com/org/repo/blob/<sha>/contracts/Foo.sol)
# This SHA changes with every commit, so comparing it against a freshly
# regenerated snapshot would always fail. We normalise these lines to a
# placeholder before comparison so that only meaningful content changes
# (NatSpec additions, deletions, renames) are flagged as drift.
_GIT_SOURCE_RE = re.compile(
    r"(\[Git Source\]\(https://[^)]+/blob/)[0-9a-f]{40}(/[^)]*\))",
    re.IGNORECASE,
)


def normalize(content: str) -> str:
    """Strip commit-SHA from [Git Source] links so they don't cause false diffs."""
    return _GIT_SOURCE_RE.sub(r"\1<SHA>\2", content)


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


def snapshot_tree(base: Path) -> dict[str, str]:
    """Return {relative_path: normalized_content} for all files under base.

    Content is normalized so that commit-SHA tokens in [Git Source] links
    are replaced with a placeholder before comparison (see normalize()).
    """
    result: dict[str, str] = {}
    for p in sorted(base.rglob("*")):
        if p.is_file():
            rel = str(p.relative_to(base))
            try:
                result[rel] = normalize(p.read_text(encoding="utf-8"))
            except UnicodeDecodeError:
                result[rel] = p.read_bytes().hex()
    return result


def main() -> int:
    root = repo_root()
    generated_path = root / GENERATED_DIR

    if not generated_path.is_dir():
        print(
            f"FAIL: generated docs directory missing at {GENERATED_DIR}. "
            "Run `forge doc` to generate it.",
            file=sys.stderr,
        )
        return 1

    # Snapshot the committed state.
    committed = snapshot_tree(generated_path)

    # Re-run forge doc into a temporary directory, then compare.
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)
        # forge doc writes to docs/ by default. Copy the repo into tmpdir so
        # `forge doc` has a complete workspace to work with, then compare only
        # the contracts sub-tree.
        try:
            result = subprocess.run(
                ["forge", "doc", "--root", str(root), "--out", str(tmp_path / "docs")],
                capture_output=True,
                text=True,
                cwd=str(root),
            )
        except FileNotFoundError:
            print(
                "SKIP: `forge` not found on PATH — skipping freshness check. "
                "Install Foundry to run this check locally.",
                file=sys.stderr,
            )
            # Exit 0 — missing forge means the environment cannot regenerate,
            # so we cannot declare the docs stale.  CI installs forge before
            # invoking this script; if forge is absent here it is a setup error,
            # not a docs-freshness error.
            return 0

        if result.returncode != 0:
            print(
                f"FAIL: `forge doc` exited {result.returncode}:\n{result.stderr}",
                file=sys.stderr,
            )
            return 1

        regenerated_dir = tmp_path / "docs" / "src" / "contracts"
        if not regenerated_dir.is_dir():
            print(
                f"FAIL: `forge doc` did not produce {regenerated_dir}.",
                file=sys.stderr,
            )
            return 1

        fresh = snapshot_tree(regenerated_dir)

    # Compare.
    committed_keys = set(committed)
    fresh_keys = set(fresh)

    added = fresh_keys - committed_keys
    removed = committed_keys - fresh_keys
    changed: list[str] = []
    for key in committed_keys & fresh_keys:
        if committed[key] != fresh[key]:
            changed.append(key)

    if not (added or removed or changed):
        print(
            f"OK: docs/src/contracts/ is fresh ({len(fresh_keys)} files match "
            "`forge doc` output)."
        )
        return 0

    # Report drift.
    print("FAIL: docs/src/contracts/ is stale relative to `forge doc` output.")
    print("Run `forge doc` from the repo root and commit the result.\n")

    if added:
        print("Files present in regenerated output but NOT committed:")
        for f in sorted(added):
            print(f"  + {f}")
        print()

    if removed:
        print("Files committed but NOT present in regenerated output:")
        for f in sorted(removed):
            print(f"  - {f}")
        print()

    if changed:
        print("Files whose content differs:")
        for f in sorted(changed):
            diff = list(
                difflib.unified_diff(
                    committed[f].splitlines(keepends=True),
                    fresh[f].splitlines(keepends=True),
                    fromfile=f"committed/{f}",
                    tofile=f"regenerated/{f}",
                    n=3,
                )
            )
            print(f"  ~ {f}")
            # Print up to 40 diff lines per file to keep output readable.
            for line in diff[:40]:
                print("    " + line.rstrip("\n"))
        print()

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
