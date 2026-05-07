#!/usr/bin/env python3
"""Issue #87 — duplicate-explorer-migration guard.

The explorer schema is owned by `services/explorer-indexer/migrations/`
(ADR §3.4). The api crate must not re-introduce a parallel migrations
directory; it consumes the canonical SQL via `include_str!` from the
indexer crate.

This script exits non-zero if any `.sql` file appears under
`clients/explorer-api/migrations/`. The directory may exist as long as
it is empty of `.sql` files (e.g. a `README.md` is fine) but for now we
expect it to be absent entirely.

Wired into `.github/workflows/explorer-schema.yml`.
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
FORBIDDEN_DIR = REPO_ROOT / "clients" / "explorer-api" / "migrations"
CANONICAL_DIR = REPO_ROOT / "services" / "explorer-indexer" / "migrations"
CANONICAL_FILE = CANONICAL_DIR / "0001_minimum_tables.sql"


def main() -> int:
    failures: list[str] = []

    if not CANONICAL_FILE.is_file():
        failures.append(
            f"canonical migration missing: expected {CANONICAL_FILE.relative_to(REPO_ROOT)}"
        )

    if FORBIDDEN_DIR.is_dir():
        stray = sorted(p for p in FORBIDDEN_DIR.rglob("*.sql"))
        if stray:
            for p in stray:
                failures.append(
                    "duplicate explorer migration: "
                    f"{p.relative_to(REPO_ROOT)} (owned by {CANONICAL_FILE.relative_to(REPO_ROOT)})"
                )

    if failures:
        for f in failures:
            print(f"ERROR: {f}", file=sys.stderr)
        print(
            "\nThe explorer schema is canonical in services/explorer-indexer/.\n"
            "clients/explorer-api consumes it via include_str! — do not re-add\n"
            "a parallel migrations file. See issue #87.",
            file=sys.stderr,
        )
        return 1

    print(f"ok: canonical migration present at {CANONICAL_FILE.relative_to(REPO_ROOT)}")
    print(f"ok: no stray .sql under {FORBIDDEN_DIR.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
