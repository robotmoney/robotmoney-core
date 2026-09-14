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

All eleven rows are now robotmoney-frontend's bytes. Two of them (the T24
envelope fixture and the R27 unknown-field vector) were `pending_frontend_adoption`
at `v0.4.0-rc.9` — core-authored, so self-referential — and the frontend has
since landed byte-identical copies, so the manifest is re-vendored at
`c8c85ec0` and those rows are real cross-repo comparisons. `--regenerate` now
REFUSES to self-pin: a fixture the frontend does not carry is an error, not a
`pending` row, so the self-referential shape cannot be reintroduced by running
the tool.

PROCESS CONTROL — THE RESIDUAL THIS CHECK DOES NOT CLOSE
--------------------------------------------------------
READ THIS BEFORE TRUSTING A GREEN FROM THIS SCRIPT.

**The vendored manifest is NOT authenticated at check time.** Nothing in CI
contacts robotmoney-frontend. `frontend_commit` is a string in a JSON file in
this repo, and the sha256 column beside it is a string in the same file. So a
single commit that drifts a fixture AND edits its matching row in
`shared-fixtures/vendored/robotmoney-frontend.manifest.json` exits 0 and prints
"ok: 11 shared fixtures are byte-identical to robotmoney-frontend". That is
demonstrated, not hypothetical: `VERIFY/R4-core-refuter2.md` DEFECT 1 and
`VERIFY/T24-refuter2.md` ATTACK B each performed it.

This is stated plainly rather than papered over. §9A R4 permits "the other
repo's manifest vendored at a pinned commit", and a vendored manifest is a
real, large improvement over the self-referential
`consensus-receipt.anchor-digest.json` it replaced (a ONE-SIDED fixture edit —
by far the likelier accident — is caught). What it is not is a cryptographic
control, and a green from this script must not be cited as one.

**The control that does hold is HUMAN REVIEW OF THE MANIFEST DIFF.** Stated
exactly: this repository has NO `.github/CODEOWNERS` file at the time of
writing (`ls .github/CODEOWNERS` -> absent), so the control today is ordinary
pull-request review, and it is only as strong as whether the reviewer performs
the re-derivation below. Making it a named control needs one line in a
CODEOWNERS file that does not yet exist:

    /shared-fixtures/vendored/   @<the team that owns cross-repo releases>

Adding it is the outstanding follow-up; it is named here rather than asserted,
because claiming an enforcement that is not configured is the same false green
this whole check exists to close.

**WHAT A RE-VENDOR MUST DO — every clause is load-bearing:**

1. Land the coordinated change in robotmoney-frontend FIRST, and let it merge.
   Re-vendoring from an unmerged branch pins bytes that may never exist.
2. Re-vendor ONLY by running this script against a real checkout:
     check_cross_repo_fixture_drift.py --regenerate \
       --frontend <robotmoney-frontend checkout> --frontend-ref <full commit sha>
   Never hand-edit a `sha256`, a `byte_length` or `frontend_commit`. The sha
   column is OUTPUT, never input.
3. Use a full 40-character COMMIT SHA as `--frontend-ref`, never a branch name
   and never a tag. Branches move and tags can be re-pointed; a commit sha is
   the only ref that pins bytes.
4. The checkout must be a clean `git` checkout of the upstream repository —
   `--regenerate` reads via `git show <ref>:<path>`, so a dirty worktree cannot
   leak in, but a fork or a rewritten history can. Confirm the remote.
5. Commit the manifest change in the SAME commit as the core fixture change it
   accompanies, and say in the message which upstream PR landed the other half.
   A manifest-only commit, or a fixture-only commit, is the shape of the bypass.
6. A row `--regenerate` refuses (the frontend does not carry the file) is an
   ERROR. Do not re-add `pending_frontend_adoption` by hand. Either wait for the
   frontend, or add the file to `core_only_not_shared` because it is not shared.

**WHAT A REVIEWER MUST DO:** for every changed row, independently re-derive the
hash from the upstream repo and compare:

    git -C <robotmoney-frontend> show <frontend_commit>:contract/src/__fixtures__/<file> \
      | sha256sum

If that does not reproduce the `sha256` in the diff, the manifest is forged or
stale — reject it. Do not take the author's word, and do not take this script's
exit code: it cannot make this check.

Closing the residual for real needs a CI step that re-fetches robotmoney-frontend
at `frontend_commit` and re-runs `--regenerate` to a zero diff. That requires
cross-repo read credentials in core's CI, which this branch does not have.
Tracked in docs/development/cross-repo-fixture-vendoring.md.

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
    missing: list[str] = []
    for row in manifest["files"]:
        name = str(row["file"])
        blob = subprocess.run(
            ["git", "-C", str(frontend), "show", f"{ref}:{FRONTEND_FIXTURE_DIR}/{name}"],
            capture_output=True,
        )
        if blob.returncode != 0:
            # REFUSE TO SELF-PIN.
            # This branch used to fall back to core's OWN bytes and flag the row
            # `pending_frontend_adoption`. That made the row self-referential,
            # and VERIFY/T24-refuter2.md ATTACK B turned it into a working
            # bypass: drift the fixture, patch its row, exit 0, and still print
            # "ok: 11 shared fixtures are byte-identical to robotmoney-frontend".
            # A manifest whose whole purpose is to hold bytes THIS repo does not
            # author cannot have rows this repo authors. A fixture with no
            # counterpart in the other repo is an ERROR: either it is not shared
            # (list it in `core_only_not_shared`) or the other repo has not
            # landed it yet and the re-vendor is premature.
            missing.append(name)
            continue
        payload = blob.stdout
        files.append({
            "file": name,
            "byte_length": len(payload),
            "sha256": sha256_hex(payload),
        })
    if missing:
        listed = "\n".join(f"  - {FRONTEND_FIXTURE_DIR}/{n}" for n in missing)
        raise SystemExit(
            "re-vendor REFUSED: robotmoney-frontend @ "
            f"{ref} ({commit[:12]}) does not carry:\n{listed}\n\n"
            "Pinning core's own bytes for those rows would make this manifest "
            "self-referential, which is the exact bypass it exists to close "
            "(edit the fixture and its row in one commit -> exit 0). Either the "
            "frontend has not landed its copy yet (wait, and re-vendor at the "
            "commit that has it), or the fixture is not shared at all (add it to "
            "`core_only_not_shared`)."
        )

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
