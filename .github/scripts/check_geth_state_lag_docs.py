#!/usr/bin/env python3
"""Drift-catcher for the Geth read-after-write state-lag canonical doc.

The Geth devnet smoke-test harness has a recurring failure class -- a confirmed
write receipt does not imply readable state, so a dependent read can observe
pre-write state. It is fixed by polling the dependent read until it settles, in
three helpers in ``testing/smoke-test/src/lib.rs``:

  - ``erc20_allowance``        (the read half of the allowance poll)
  - ``approve_and_confirm``    (approve, then poll allowance until visible)
  - ``wait_for_vault_registered`` (poll listVaults() until the vault appears)

This guard enforces two invariants so the class cannot silently lose its
documentation again:

  (A) The canonical doc ``docs/testing/geth-state-lag.md`` exists and carries a
      read-after-write / state-lag section heading.
  (B) Each of the three helpers carries, inside its own ``///`` doc-comment
      block, a back-link to the canonical doc path ``docs/testing/...``.

This is a doc-symbol / back-link guard, not a source reconciler: it fails red if
the doc heading is removed or any helper drops its back-link, so a future edit
cannot silently sever the code from its canonical documentation.

Run ``--self-test`` to confirm the guard fires when the heading or a back-link is
absent (so a silent regression in the guard itself is caught).

Exit 0 when both invariants hold, non-zero otherwise.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

DOC = Path("docs/testing/geth-state-lag.md")
SMOKE = Path("testing/smoke-test/src/lib.rs")

# A markdown heading line that names the read-after-write / state-lag class.
HEADING_RE = re.compile(
    r"^#{1,6}\s.*(read-after-write|state-lag).*$",
    re.IGNORECASE | re.MULTILINE,
)

# Helpers that must each carry a back-link to the canonical doc path in their
# own doc-comment block.
HELPERS = ("erc20_allowance", "approve_and_confirm", "wait_for_vault_registered")

# The back-link substring the helper doc-comments must contain.
BACKLINK = "docs/testing/geth-state-lag.md"


def doc_comment_block(source: str, fn_name: str) -> str | None:
    """Return the contiguous ``///`` doc-comment block immediately preceding the
    definition of ``fn fn_name(``, or ``None`` if the fn is not found."""
    lines = source.splitlines()
    def_re = re.compile(rf"^\s*(pub\s+)?fn\s+{re.escape(fn_name)}\s*\(")
    for i, line in enumerate(lines):
        if def_re.match(line):
            block: list[str] = []
            j = i - 1
            while j >= 0 and lines[j].lstrip().startswith("///"):
                block.append(lines[j])
                j -= 1
            return "\n".join(reversed(block))
    return None


def check(root: Path) -> list[str]:
    """Return a list of failure messages (empty = both invariants hold)."""
    failures: list[str] = []

    doc_path = root / DOC
    if not doc_path.is_file():
        failures.append(f"{DOC} not found")
    else:
        text = doc_path.read_text(encoding="utf-8")
        if not HEADING_RE.search(text):
            failures.append(
                f"no read-after-write / state-lag section heading in {DOC}"
            )

    smoke_path = root / SMOKE
    if not smoke_path.is_file():
        failures.append(f"{SMOKE} not found")
    else:
        source = smoke_path.read_text(encoding="utf-8")
        for fn in HELPERS:
            block = doc_comment_block(source, fn)
            if block is None:
                failures.append(f"helper fn '{fn}' not found in {SMOKE}")
            elif BACKLINK not in block:
                failures.append(
                    f"'{fn}' doc-comment in {SMOKE} is missing the canonical-doc "
                    f"back-link '{BACKLINK}'"
                )
    return failures


def self_test() -> int:
    """Confirm the guard fires when the heading or a back-link is absent."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / DOC).parent.mkdir(parents=True, exist_ok=True)
        (root / SMOKE).parent.mkdir(parents=True, exist_ok=True)

        # Doc without the required heading.
        (root / DOC).write_text("# Some unrelated title\n\nno heading here\n", "utf-8")
        # Source with the helpers but no back-links.
        (root / SMOKE).write_text(
            "/// no back-link\n"
            "pub fn erc20_allowance() {}\n"
            "/// no back-link\n"
            "fn approve_and_confirm() {}\n"
            "/// no back-link\n"
            "fn wait_for_vault_registered() {}\n",
            "utf-8",
        )
        failures = check(root)
        # Expect: 1 heading failure + 3 missing back-links = 4.
        if len(failures) != 1 + len(HELPERS):
            print(
                "SELF-TEST FAIL: guard did not flag every seeded defect; "
                f"flagged {len(failures)}, expected {1 + len(HELPERS)}",
                file=sys.stderr,
            )
            for f in failures:
                print(f"  - {f}", file=sys.stderr)
            return 1

        # And confirm the guard PASSES when both invariants hold.
        (root / DOC).write_text(
            "# Geth Read-After-Write State-Lag\n\n## Read-after-write state-lag\n",
            "utf-8",
        )
        (root / SMOKE).write_text(
            f"/// link: {BACKLINK}\npub fn erc20_allowance() {{}}\n"
            f"/// link: {BACKLINK}\nfn approve_and_confirm() {{}}\n"
            f"/// link: {BACKLINK}\nfn wait_for_vault_registered() {{}}\n",
            "utf-8",
        )
        ok = check(root)
        if ok:
            print(
                "SELF-TEST FAIL: guard flagged a compliant fixture:",
                file=sys.stderr,
            )
            for f in ok:
                print(f"  - {f}", file=sys.stderr)
            return 1

    print("SELF-TEST OK: guard fires for missing heading/back-links, passes when present.")
    return 0


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


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()

    failures = check(repo_root())
    if failures:
        print("FAIL: Geth state-lag doc/back-link invariants violated:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1

    print(
        "OK: read-after-write state-lag section present in "
        f"{DOC} and all {len(HELPERS)} helper back-links present in {SMOKE}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
