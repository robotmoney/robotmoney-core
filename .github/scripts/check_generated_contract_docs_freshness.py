#!/usr/bin/env python3
"""Freshness check for generated contract NatSpec docs (contracts/doc/src/pages/contracts/).

Generated contract docs are produced by `forge doc` from NatSpec comments in
contracts/**/*.sol. They live under contracts/doc/src/pages/contracts/ and must
never be edited by hand — only regenerated.

This script:
  1. Runs `forge doc` (writing to contracts/doc/) in a temp working copy.
  2. Diffs contracts/doc/src/pages/contracts/ between the committed tree and the
     freshly generated output.
  3. Exits 1 if any diff is found, printing the diff for diagnosis.
  4. Exits 0 if the committed contracts/doc/src/pages/contracts/ exactly matches
     `forge doc` output.

WHY THIS EXISTS
The generated files carry a banner warning that they are machine-generated.
Without an automated staleness check, it is possible for the NatSpec source
and the committed docs to diverge silently — e.g. a developer adds a new
public function with NatSpec and forgets to commit the regenerated markdown.
This script is the CI signal that closes that gap.

SCOPE
Only the per-contract pages under src/pages/contracts/ are diffed. The vocs
scaffolding forge doc also writes alongside them — package.json,
vocs.config.ts, vocs.sidebar.ts, .gitignore, src/pages/index.mdx,
src/pages/.forge-doc-manifest — is committed (it is required to actually build
the doc site) but intentionally excluded from this freshness comparison. That
mirrors the pre-1.8.0 mdbook tree, where book.toml, book.css, solidity.min.js
and src/SUMMARY.md/README.md were likewise committed but never diffed — only
the per-contract page content was gated on freshness.

PREREQUISITES
- `forge` must be on PATH (installed via foundry-rs/foundry-toolchain@v1).
- The generator version matters: the committed tree is the vocs layout emitted
  by Foundry >= 1.8.0 (issue #1264). Foundry <= 1.7.1 emits the older mdbook
  layout instead and still exits 0, so this script classifies the freshly
  generated output before diffing and refuses to compare a layout it does not
  recognise — including the legacy mdbook layout, which would otherwise look
  like every generated file was added/removed.
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


GENERATED_DIR = Path("contracts/doc/src/pages/contracts")

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


# `forge doc` output layouts. Foundry <= 1.7.1 emits an mdbook site whose
# generated pages live under <out>/src/contracts/. Foundry >= 1.8.0 replaced
# that generator with a vocs site (<out>/src/pages/contracts/**/*.mdx plus
# vocs.config.ts / vocs.sidebar.ts / package.json scaffolding) and still exits
# 0. Without an explicit classification step, "the generator wrote a shape we
# do not understand" (or "wrote the wrong version's shape") is
# indistinguishable from "the docs are fresh" — the failure mode that reddened
# every job in issue #1263. The committed tree is the vocs layout; a fresh
# mdbook layout (stale local Foundry) is therefore also a mismatch, not a
# diffable pair.
LAYOUT_MDBOOK = "mdbook"
LAYOUT_VOCS = "vocs"
LAYOUT_UNKNOWN = "unknown"


def classify_output(out_dir: Path) -> tuple[str, Path | None]:
    """Classify a `forge doc --out <out_dir>` tree.

    Returns ``(layout, generated_root)`` where ``generated_root`` is the
    directory this comparator knows how to diff, or ``None`` when the layout is
    recognised but has no comparable per-contract page directory.
    """
    mdbook_root = out_dir / "src" / "contracts"
    if mdbook_root.is_dir():
        return LAYOUT_MDBOOK, mdbook_root
    vocs_root = out_dir / "src" / "pages" / "contracts"
    if (out_dir / "vocs.config.ts").is_file() or (out_dir / "src" / "pages").is_dir():
        return LAYOUT_VOCS, (vocs_root if vocs_root.is_dir() else None)
    return LAYOUT_UNKNOWN, None


def self_test() -> int:
    """Confirm the drift comparator fires for added/removed/changed files.

    This is the codified version of issue #450's dry-run acceptance: it
    guarantees that if a future PR introduces a new public Solidity surface
    without regenerating ``contracts/doc/src/pages/contracts/``, the freshness gate will
    detect the drift. Three synthetic scenarios are checked — added file,
    removed file, and content-changed file (the case that fires when a new
    ``function`` line appears in a contract's NatSpec output).

    It also covers the *generator* contract (issue #1263): `forge doc` exits 0
    on every release, so classify_output() is the only thing that keeps a
    layout change (mdbook -> vocs in Foundry 1.8.0) from being reported as
    "docs are fresh".
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

    # Scenarios 6-9: the generator contract. `forge doc` exits 0 on every
    # Foundry release, so the only thing standing between a generator-version
    # mismatch and a false "docs are fresh" is classify_output(). Issue #1263.
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)

        # 6: the legacy mdbook layout (Foundry <= 1.7.1) — must be named, not
        # mistaken for the vocs layout this comparator diffs.
        mdbook = tmp / "mdbook"
        (mdbook / "src" / "contracts" / "Vault.sol").mkdir(parents=True)
        (mdbook / "src" / "contracts" / "Vault.sol" / "contract.Vault.md").write_text(
            "# Vault\n"
        )
        layout, root = classify_output(mdbook)
        assert layout == LAYOUT_MDBOOK and root == mdbook / "src" / "contracts", (
            f"self-test mdbook-layout scenario failed: {layout=} {root=}"
        )

        # 7: the vocs layout Foundry >= 1.8.0 emits (issue #1264) — the layout
        # this comparator diffs.
        vocs = tmp / "vocs"
        (vocs / "src" / "pages" / "contracts").mkdir(parents=True)
        (vocs / "src" / "pages" / "contracts" / "contract.Vault.mdx").write_text(
            "# Vault\n"
        )
        (vocs / "vocs.config.ts").write_text("export default {}\n")
        layout, root = classify_output(vocs)
        assert layout == LAYOUT_VOCS and root == vocs / "src" / "pages" / "contracts", (
            f"self-test vocs-layout scenario failed: {layout=} {root=}"
        )

        # 8: a vocs-shaped tree with no contracts/ page directory (e.g. every
        # .sol file failed to render) must be named as vocs but not diffable.
        vocs_empty = tmp / "vocs_empty"
        (vocs_empty / "src" / "pages").mkdir(parents=True)
        (vocs_empty / "vocs.config.ts").write_text("export default {}\n")
        layout, root = classify_output(vocs_empty)
        assert layout == LAYOUT_VOCS and root is None, (
            f"self-test vocs-no-contracts scenario failed: {layout=} {root=}"
        )

        # 9: any other shape (a future generator rewrite) must also refuse to
        # report freshness.
        other = tmp / "other"
        (other / "site").mkdir(parents=True)
        (other / "site" / "index.html").write_text("<html></html>\n")
        layout, root = classify_output(other)
        assert layout == LAYOUT_UNKNOWN and root is None, (
            f"self-test unknown-layout scenario failed: {layout=} {root=}"
        )

    print(
        "OK: freshness-check self-test passed "
        "(4 drift scenarios + SHA norm + 4 generator-layout scenarios)."
    )
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

        out_dir = tmp_path / "docs"
        layout, regenerated_dir = classify_output(out_dir)
        if layout == LAYOUT_MDBOOK:
            print(
                "FAIL: `forge doc` produced the legacy mdbook layout "
                "(Foundry <= 1.7.1), but the committed tree at "
                f"{GENERATED_DIR} is the vocs layout emitted by Foundry >= "
                "1.8.0 (issue #1264).\n"
                "This is a generator-version mismatch, NOT stale docs. "
                "Upgrade your local Foundry install: `foundryup`.",
                file=sys.stderr,
            )
            return 1
        if layout == LAYOUT_UNKNOWN or regenerated_dir is None:
            print(
                f"FAIL: `forge doc` exited 0 but wrote an unrecognised layout to "
                f"{out_dir} (no src/contracts/, no src/pages/contracts/ under a "
                "vocs scaffold). Top-level entries: "
                f"{sorted(p.name for p in out_dir.iterdir()) if out_dir.is_dir() else '<missing>'}.\n"
                "This is a generator-version mismatch, NOT stale docs. See "
                "issues #1263 and #1264.",
                file=sys.stderr,
            )
            return 1

        fresh = snapshot_tree(regenerated_dir)

    # Compare.
    added, removed, changed = compare_trees(committed, fresh)

    if not (added or removed or changed):
        print(
            f"OK: {GENERATED_DIR}/ is fresh ({len(fresh)} files match "
            "`forge doc` output)."
        )
        return 0

    # Report drift.
    print(f"FAIL: {GENERATED_DIR}/ is stale relative to `forge doc` output.")
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
