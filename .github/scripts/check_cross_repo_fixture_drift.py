#!/usr/bin/env python3
"""Cross-repo shared-fixture drift check (§9A R4, AC-FMT-01).

WHY THIS EXISTS, SEPARATELY FROM check_consensus_receipt_schema.py
------------------------------------------------------------------
`check_consensus_receipt_schema.py` re-hashes the shared fixtures and compares
them against `tests/fixtures/consensus-receipt.anchor-digest.json`. That
manifest is authored **in this repo**, so the check is self-referential: at
`v0.4.0-rc.3` eight of the nine shared fixtures had drifted away from
robotmoney-frontend and the check still exited 0 with
"ok: all 9 cross-repo shared fixtures reproduce their committed sha256"
(`fusion-evidence/20260913T-run1/phase3/3.1-core-ci-fixture-check-GREEN-while-drifted.txt`).
Editing a fixture and its own manifest row in one commit is green by
construction.

This check compares the same bytes against a manifest this repo does **not**
author: `shared-fixtures/vendored/robotmoney-frontend.manifest.json`, generated
from robotmoney-frontend's own `contract/src/__fixtures__/` at a pinned commit
recorded inside it. Changing a fixture here without a coordinated cross-repo
release now fails, because the vendored row can only be moved by re-vendoring
from the other repo at a new pinned commit.

Two of the eleven rows are marked `pending_frontend_adoption`: the envelope and
unknown-field vectors added by T24/R27 were authored here and handed to the
frontend in the same cycle. Those rows are core-authored until the frontend
lands its byte-identical copies and this manifest is re-vendored — the check
says so out loud on every run rather than pretending they are cross-checked.

Usage:
  check_cross_repo_fixture_drift.py [--fixtures-dir DIR] [--manifest FILE]
  check_cross_repo_fixture_drift.py --regenerate --frontend PATH --frontend-ref REF
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FIXTURES = REPO_ROOT / "tests" / "fixtures"
DEFAULT_MANIFEST = REPO_ROOT / "shared-fixtures" / "vendored" / "robotmoney-frontend.manifest.json"
FRONTEND_FIXTURE_DIR = "contract/src/__fixtures__"


def sha256_hex(payload: bytes) -> str:
    return "0x" + hashlib.sha256(payload).hexdigest()


def load_manifest(path: Path) -> dict:
    if not path.is_file():
        raise SystemExit(f"vendored manifest is missing: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def compare(fixtures_dir: Path, manifest: dict) -> tuple[list[str], list[tuple[str, ...]]]:
    """Return (errors, table rows). A row is (file, status, expected, actual)."""
    errors: list[str] = []
    rows: list[tuple[str, ...]] = []
    named = [str(row["file"]) for row in manifest["files"]]

    for row in manifest["files"]:
        name = str(row["file"])
        expected = str(row["sha256"])
        path = fixtures_dir / name
        pending = bool(row.get("pending_frontend_adoption"))
        if not path.is_file():
            rows.append((name, "MISSING", expected, "-"))
            errors.append(f"{name}: named by the vendored frontend manifest but absent from {fixtures_dir}")
            continue
        payload = path.read_bytes()
        actual = sha256_hex(payload)
        if actual != expected:
            rows.append((name, "DRIFTED", expected, actual))
            errors.append(
                f"{name}: sha256 {actual}, robotmoney-frontend @ "
                f"{manifest['frontend_commit'][:12]} has {expected}"
            )
            continue
        if len(payload) != int(row["byte_length"]):
            rows.append((name, "DRIFTED", str(row["byte_length"]), str(len(payload))))
            errors.append(f"{name}: {len(payload)} bytes, vendored manifest records {row['byte_length']}")
            continue
        rows.append((name, "PENDING-FE" if pending else "ok", expected, actual))

    # An EXTRA shared-family fixture is drift too: a file added here and never
    # promoted through the cross-repo release process is exactly the asymmetry
    # this check exists to catch.
    on_disk = sorted(p.name for p in fixtures_dir.glob("consensus-receipt.*"))
    core_only = [str(n) for n in manifest.get("core_only_not_shared", [])]
    for name in on_disk:
        if name not in named and name not in core_only:
            rows.append((name, "EXTRA", "-", sha256_hex((fixtures_dir / name).read_bytes())))
            errors.append(
                f"{name}: present in {fixtures_dir} but named by neither the vendored "
                "frontend manifest nor core_only_not_shared"
            )
    return errors, rows


def print_table(rows: list[tuple[str, ...]], manifest: dict) -> None:
    width = max((len(r[0]) for r in rows), default=10)
    print(f"cross-repo shared fixtures vs robotmoney-frontend @ {manifest['frontend_commit']}"
          f" ({manifest.get('frontend_ref', '?')})")
    print(f"{'fixture'.ljust(width)}  {'status'.ljust(10)}  expected sha256 / actual sha256")
    print("-" * (width + 60))
    for name, status, expected, actual in rows:
        print(f"{name.ljust(width)}  {status.ljust(10)}  {expected}")
        if status in {"DRIFTED", "MISSING", "EXTRA"}:
            print(f"{' '.ljust(width)}  {' '.ljust(10)}  {actual}   <-- on disk")


def regenerate(frontend: Path, ref: str, manifest_path: Path) -> int:
    """Re-vendor from a robotmoney-frontend checkout at a pinned ref."""
    manifest = load_manifest(manifest_path)
    commit = subprocess.run(
        ["git", "-C", str(frontend), "rev-parse", f"{ref}^{{commit}}"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    files = []
    for row in manifest["files"]:
        name = str(row["file"])
        blob = subprocess.run(
            ["git", "-C", str(frontend), "show", f"{ref}:{FRONTEND_FIXTURE_DIR}/{name}"],
            capture_output=True,
        )
        if blob.returncode != 0:
            # Not yet adopted upstream: pin core's own bytes and say so out loud.
            local = (DEFAULT_FIXTURES / name).read_bytes()
            files.append({
                "file": name,
                "byte_length": len(local),
                "sha256": sha256_hex(local),
                "pending_frontend_adoption": True,
                "handed_to_frontend_at": f"{FRONTEND_FIXTURE_DIR}/{name}",
            })
            continue
        payload = blob.stdout
        files.append({
            "file": name,
            "byte_length": len(payload),
            "sha256": sha256_hex(payload),
        })
    manifest["frontend_commit"] = commit
    manifest["frontend_ref"] = ref
    manifest["files"] = files
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"re-vendored {len(files)} rows from {frontend} @ {ref} ({commit})")
    return 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures-dir", type=Path, default=DEFAULT_FIXTURES)
    ap.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    ap.add_argument("--regenerate", action="store_true")
    ap.add_argument("--frontend", type=Path)
    ap.add_argument("--frontend-ref", default="HEAD")
    args = ap.parse_args(argv)

    if args.regenerate:
        if args.frontend is None:
            raise SystemExit("--regenerate needs --frontend PATH")
        return regenerate(args.frontend, args.frontend_ref, args.manifest)

    manifest = load_manifest(args.manifest)
    errors, rows = compare(args.fixtures_dir, manifest)
    print_table(rows, manifest)
    pending = [r[0] for r in rows if r[1] == "PENDING-FE"]
    if pending:
        print(f"\nNOTE: {len(pending)} row(s) are core-authored and not yet cross-checked "
              f"against robotmoney-frontend: {', '.join(pending)}")
    if errors:
        print("\ncross-repo fixture drift:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        print(
            "\nResolve through the cross-repo release process "
            "(docs/product/20260623-product-proposal-investment-committee-v0.md §7.4), "
            "never by editing one side to match the other.",
            file=sys.stderr,
        )
        return 1
    print(f"\nok: {len(rows)} shared fixtures are byte-identical to robotmoney-frontend "
          f"@ {manifest['frontend_commit'][:12]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
