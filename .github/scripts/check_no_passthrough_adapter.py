#!/usr/bin/env python3
"""Passthrough-removal invariant (issue #912, extended for #921).

The `PassthroughAdapter` test escape hatch and its `USE_PASSTHROUGH_ADAPTER`
deploy flag were removed from the production deploy surface: the adapter
compiled into the production artifact set (`foundry.toml` `src = "contracts"`)
and was reachable from `Deploy.s.sol::run()` via an unguarded env read, so a
stray env var could have deployed a no-yield 1:1 adapter to mainnet.

This guard greps the tracked source tree for either banned token and fails on
any hit outside a small allowlist of historical review / scout documents that
intentionally record the (now-removed) surface. It is the CI grep-guard called
for in the issue test plan.

Issue #921 extends the guard with a second, narrower rule: the bare word
`Passthrough` may no longer appear anywhere under `contracts/` (including the
generated `contracts/doc/` forge-doc mirror). The holistic review (finding
L3-D2) found stale `(... , Passthrough)` natspec in
`contracts/script/AdapterBytecodeGuard.sol` and its generated mirror that the
exact-token rule did not catch. The bare-substring rule is scoped to
`contracts/` so legitimate historical references elsewhere (this guard's own
docstring, the suite-13 workflow step name, review/seam docs) are unaffected.

Exit 0 on success, non-zero on any unallowlisted hit. No network access.
Run with `--self-test` to confirm the bare-substring rule actually fires.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# The two banned exact tokens. After issue #912 neither may appear anywhere in
# tracked source (outside the historical-doc allowlist below).
FORBIDDEN_TOKENS = ("USE_PASSTHROUGH_ADAPTER", "PassthroughAdapter")

# Issue #921: the bare word `Passthrough` is additionally forbidden, but only
# under this prefix. `PassthroughAdapter` is already covered by FORBIDDEN_TOKENS
# above, so a hit here is a *bare* stale reference (e.g. stale natspec listing
# `(Aave V3, Compound V3, Morpho, Passthrough)`).
BARE_TOKEN = "Passthrough"
BARE_TOKEN_SCOPE = "contracts/"

# Allowlisted paths: historical code-review snapshots and the scout seam map
# legitimately quote the removed surface, and this guard names the tokens in
# its own docstring/data. These are NOT live source. (All sit outside
# BARE_TOKEN_SCOPE, so the bare-`Passthrough` rule never reaches them.)
ALLOWLIST_PATHS = {
    ".github/scripts/check_no_passthrough_adapter.py",
    "docs/technical/testcode-removal-seams.md",
    "docs/code-review/20260607-code-review-internal-claude-gap-analysis.md",
    "docs/code-review/20260609-code-review-internal-claude.md",
    "docs/code-review/20260618-code-review-internal-claude.md",
    "docs/code-review/20260612-code-review-internal-claude.md",
}


def tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files"],
        cwd=str(REPO_ROOT),
        check=True,
        capture_output=True,
        text=True,
    )
    return [line for line in out.stdout.splitlines() if line]


def scan(files: list[str], root: Path) -> list[str]:
    """Return a list of `path:lineno: line` hits for any banned reference.

    `files` are paths relative to `root`. Both the exact-token rule (whole
    tree) and the bare-`Passthrough` rule (only under BARE_TOKEN_SCOPE) are
    applied, with ALLOWLIST_PATHS exempt from both.
    """
    hits: list[str] = []
    for rel in files:
        if rel in ALLOWLIST_PATHS:
            continue
        path = root / rel
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError, IsADirectoryError):
            continue
        in_scope = rel.startswith(BARE_TOKEN_SCOPE)
        for lineno, line in enumerate(text.splitlines(), start=1):
            matched = any(token in line for token in FORBIDDEN_TOKENS)
            # The bare-substring rule is independent and `contracts/`-scoped;
            # it catches `Passthrough` even when no exact token is present.
            if not matched and in_scope and BARE_TOKEN in line:
                matched = True
            if matched:
                hits.append(f"{rel}:{lineno}: {line.strip()}")
    return hits


def report(hits: list[str]) -> int:
    if hits:
        print(
            "FAIL: passthrough-removal invariant (issue #912 / #921) violated — "
            "the following tracked, non-allowlisted files still reference the "
            "removed PassthroughAdapter / USE_PASSTHROUGH_ADAPTER surface, or a "
            "bare `Passthrough` under contracts/:",
            file=sys.stderr,
        )
        for h in hits:
            print(f"  {h}", file=sys.stderr)
        print(
            "\nThe test-only no-yield adapter now lives at "
            "contracts/test/helpers/NoYieldTestAdapter.sol and the deploy script "
            "wires only the three real adapters (Aave V3, Compound V3, Morpho). "
            "Remove the reference or, for a genuine historical-review doc, add "
            "its path to ALLOWLIST_PATHS.",
            file=sys.stderr,
        )
        return 1

    print(
        "OK: no PassthroughAdapter / USE_PASSTHROUGH_ADAPTER references in "
        "tracked source, and no bare `Passthrough` under contracts/ "
        "(issue #912 / #921)."
    )
    return 0


def self_test() -> int:
    """Prove the bare-`Passthrough` rule fires for a contracts/ file.

    Builds a synthetic tree with (a) a clean contracts/ file, (b) a contracts/
    file containing a bare `Passthrough` and (c) a non-contracts/ file with a
    bare `Passthrough`. Asserts the bare rule flags (b) but NOT (a) or (c),
    proving the rule is active and correctly scoped.
    """
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        clean = "contracts/Clean.sol"
        dirty = "contracts/Dirty.sol"
        out_of_scope = "docs/history.md"
        for rel, body in (
            (clean, "// Aave V3, Compound V3, Morpho only\n"),
            (dirty, "// (Aave V3, Compound V3, Morpho, Passthrough)\n"),
            (out_of_scope, "Historical note: Passthrough adapter once existed.\n"),
        ):
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(body, encoding="utf-8")

        hits = scan([clean, dirty, out_of_scope], root)
        hit_paths = {h.split(":", 1)[0] for h in hits}

        failures: list[str] = []
        if dirty not in hit_paths:
            failures.append(
                f"expected bare `Passthrough` in {dirty} to be flagged, but it was not"
            )
        if clean in hit_paths:
            failures.append(f"{clean} has no banned reference but was flagged")
        if out_of_scope in hit_paths:
            failures.append(
                f"{out_of_scope} is outside {BARE_TOKEN_SCOPE!r}; the bare rule "
                "must not reach it"
            )

        if failures:
            print("SELF-TEST FAIL:", file=sys.stderr)
            for f in failures:
                print(f"  - {f}", file=sys.stderr)
            return 1

    print(
        "SELF-TEST OK: bare `Passthrough` rule fires for contracts/ files, "
        "leaves clean contracts/ files alone, and is correctly scoped out of "
        "non-contracts/ paths."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run an in-process fixture proving the bare-`Passthrough` rule is "
        "active and `contracts/`-scoped, then exit.",
    )
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    return report(scan(tracked_files(), REPO_ROOT))


if __name__ == "__main__":
    raise SystemExit(main())
