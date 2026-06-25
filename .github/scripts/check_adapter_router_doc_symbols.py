#!/usr/bin/env python3
"""Drift-catcher for adapter/router contract-surface symbols in canonical docs.

Two contract-surface capabilities shipped in the Azimuth security-remediation
batch must remain documented in their canonical technical docs:

  (A) The MorphoAdapter governance-configurable exposure cap — the token
      ``maxExposure`` must appear in ``docs/technical/adapter-architecture.md``
      together with the ``setMaxExposure`` setter, the ``ExposureCapExceeded``
      revert, and the ``convertToAssets`` live-balance check.
  (B) The PortfolioRouter per-leg transfer failure path — the named error
      ``UsdcLegTransferFailed`` must appear in
      ``docs/technical/smart-contracts.md`` together with the
      ``usdcBalanceBefore`` donation-DoS snapshot.

This is a doc-symbol guard, not a source reconciler: it fails red if any
required symbol is removed from its canonical doc, so a future edit cannot
silently drop the documented contract surface.

Run ``--self-test`` to confirm the guard fires when a required symbol is
absent (so a silent regression in the guard itself is caught).

Exit 0 on success, non-zero on missing symbols.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ADAPTER_DOC = Path("docs/technical/adapter-architecture.md")
CONTRACTS_DOC = Path("docs/technical/smart-contracts.md")

# (doc path, required substring) pairs. Every pair must be present.
REQUIRED = [
    (ADAPTER_DOC, "maxExposure"),
    (ADAPTER_DOC, "setMaxExposure"),
    (ADAPTER_DOC, "ExposureCapExceeded"),
    (ADAPTER_DOC, "convertToAssets"),
    (CONTRACTS_DOC, "UsdcLegTransferFailed"),
    (CONTRACTS_DOC, "usdcBalanceBefore"),
]


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


def check(root: Path) -> list[str]:
    """Return a list of failure messages (empty = all symbols present)."""
    failures: list[str] = []
    cache: dict[Path, str | None] = {}
    for doc, needle in REQUIRED:
        if doc not in cache:
            path = root / doc
            cache[doc] = path.read_text(encoding="utf-8") if path.is_file() else None
        text = cache[doc]
        if text is None:
            failures.append(f"{doc} not found")
        elif needle not in text:
            failures.append(f"'{needle}' missing from {doc}")
    return failures


def self_test() -> int:
    """Confirm the guard fires against docs that lack the required symbols."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / ADAPTER_DOC).parent.mkdir(parents=True, exist_ok=True)
        # Write docs that deliberately omit every required symbol.
        (root / ADAPTER_DOC).write_text("no symbols here\n", encoding="utf-8")
        (root / CONTRACTS_DOC).write_text("no symbols here\n", encoding="utf-8")
        failures = check(root)
        if len(failures) != len(REQUIRED):
            print(
                "SELF-TEST FAIL: guard did not flag all missing symbols; "
                f"flagged {len(failures)} of {len(REQUIRED)}",
                file=sys.stderr,
            )
            for f in failures:
                print(f"  - {f}", file=sys.stderr)
            return 1
    print("SELF-TEST OK: guard fires for every missing required symbol.")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()

    root = repo_root()
    failures = check(root)
    if failures:
        print("FAIL: required adapter/router doc symbols are missing:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1

    print(
        f"OK: all {len(REQUIRED)} required adapter/router doc symbols are present "
        f"in their canonical docs."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
