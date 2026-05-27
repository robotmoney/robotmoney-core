#!/usr/bin/env python3
"""Freshness check for generated contract NatSpec docs (contracts/doc/src/contracts/).

Generated contract docs are produced by `forge doc` from NatSpec comments in
contracts/**/*.sol. They live under contracts/doc/src/contracts/ and must never be
edited by hand — only regenerated.

This script:
  1. Runs `forge doc` (writing to contracts/doc/) in a temp working copy.
  2. Diffs contracts/doc/src/contracts/ between the committed tree and the freshly
     generated output.
  3. Exits 1 if any diff is found, printing the diff for diagnosis.
  4. Exits 0 if the committed contracts/doc/src/contracts/ exactly matches `forge doc`
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

import argparse
import difflib
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


GENERATED_DIR = Path("contracts/doc/src/contracts")

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


def compare_trees(
    committed: dict[str, str], fresh: dict[str, str]
) -> tuple[set[str], set[str], list[str]]:
    """Return (added, removed, changed) drift sets between two snapshots.

    ``added``   = files in ``fresh`` but not ``committed`` (regenerator
                  produced a new doc file the tree never committed — e.g. a
                  newly added .sol contract whose docs were not regenerated).
    ``removed`` = files in ``committed`` but not ``fresh`` (a contract was
                  deleted but its doc page was not).
    ``changed`` = files present in both whose normalized content differs
                  (e.g. an added public function or NatSpec edit).
    """
    committed_keys = set(committed)
    fresh_keys = set(fresh)
    added = fresh_keys - committed_keys
    removed = committed_keys - fresh_keys
    changed: list[str] = []
    for key in committed_keys & fresh_keys:
        if committed[key] != fresh[key]:
            changed.append(key)
    return added, removed, changed


def self_test() -> int:
    """Confirm the drift comparator fires for added/removed/changed files.

    This is the codified version of issue #450's dry-run acceptance: it
    guarantees that if a future PR introduces a new public Solidity surface
    without regenerating ``contracts/doc/src/contracts/``, the freshness gate will
    detect the drift. Three synthetic scenarios are checked — added file,
    removed file, and content-changed file (the case that fires when a new
    ``function`` line appears in a contract's NatSpec output).
    """
    base = {"a.md": "alpha\n", "b.md": "beta\n"}

    # Scenario 1: regenerated output has a brand-new doc file.
    added, removed, changed = compare_trees(base, {**base, "c.md": "gamma\n"})
    assert added == {"c.md"} and not removed and not changed, (
        f"self-test added-file scenario failed: {added=} {removed=} {changed=}"
    )

    # Scenario 2: regenerated output is missing a doc file the tree committed.
    added, removed, changed = compare_trees(base, {"a.md": "alpha\n"})
    assert removed == {"b.md"} and not added and not changed, (
        f"self-test removed-file scenario failed: {added=} {removed=} {changed=}"
    )

    # Scenario 3: a file's content differs (the "added public function" case).
    added, removed, changed = compare_trees(
        base, {"a.md": "alpha\nnew function\n", "b.md": "beta\n"}
    )
    assert changed == ["a.md"] and not added and not removed, (
        f"self-test changed-file scenario failed: {added=} {removed=} {changed=}"
    )

    # Scenario 4: identical trees must not report drift.
    added, removed, changed = compare_trees(base, dict(base))
    assert not (added or removed or changed), (
        f"self-test no-drift scenario falsely reported: {added=} {removed=} {changed=}"
    )

    # Scenario 5: [Git Source] SHA normalization must not be flagged as drift.
    sha_a = (
        "[Git Source](https://github.com/org/repo/blob/"
        "0123456789abcdef0123456789abcdef01234567/contracts/Foo.sol)\n"
    )
    sha_b = (
        "[Git Source](https://github.com/org/repo/blob/"
        "fedcba9876543210fedcba9876543210fedcba98/contracts/Foo.sol)\n"
    )
    assert normalize(sha_a) == normalize(sha_b), (
        "self-test sha-normalization failed — comparator would flag every PR"
    )

    print("OK: freshness-check self-test passed (4 drift scenarios + SHA norm).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--self-test",
        action="store_true",
        help=(
            "Run unit-level sanity checks on the drift comparator instead of "
            "invoking forge doc. Used by CI to confirm the gate would fire on "
            "added/removed/changed generated files (issue #450)."
        ),
    )
    args = parser.parse_args()

    if args.self_test:
        return self_test()

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
    added, removed, changed = compare_trees(committed, fresh)

    if not (added or removed or changed):
        print(
            f"OK: contracts/doc/src/contracts/ is fresh ({len(fresh)} files match "
            "`forge doc` output)."
        )
        return 0

    # Report drift.
    print("FAIL: contracts/doc/src/contracts/ is stale relative to `forge doc` output.")
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
