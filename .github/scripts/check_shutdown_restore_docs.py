#!/usr/bin/env python3
"""shutdownVault recoverability docs invariant (issue #923).

PR #920 (commit 543fe062, finding L-10/SR-L5) added
`RobotMoneyVault.restoreVault(uint256 newTvlCap)`, an `ADMIN_ROLE` recovery
path that reverses `shutdownVault()` and re-opens deposits under a fresh TVL
cap (the shutdown/restore trust asymmetry: `EMERGENCY_ROLE` shuts down, the
higher-trust `ADMIN_ROLE` restores). The canonical docs previously described
`shutdownVault` as permanent/irreversible and never mentioned `restoreVault`.

This guard asserts those docs now match the contract:

  1. No "irreversible / permanently disable / permanent shutdown" wording
     remains in docs/technical/smart-contracts.md or
     docs/technical/adapter-architecture.md (these files only discuss
     shutdownVault in that register, so any such match is a stale claim).
  2. `restoreVault` is named in docs/technical/smart-contracts.md.
  3. The adapter-architecture shutdownVault description no longer uses the
     word "permanently".

It is the CI grep-guard called for in the issue #923 test plan. Exit 0 on
success, non-zero on any violation. No network access. Run with `--self-test`
to confirm the stale-wording rule actually fires.
"""

from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

SMART_CONTRACTS_DOC = "docs/technical/smart-contracts.md"
ADAPTER_ARCH_DOC = "docs/technical/adapter-architecture.md"

# Stale-wording rule: in these two docs the only thing described as
# irreversible / permanently-disabled / permanently-shut is the vault
# shutdown, which is now reversible via restoreVault. Any match is stale.
# (Unrelated uses of "permanent" — e.g. a permanently-locked seed deposit or
# the router's all-or-revert invariant — are not "permanently disable/shut"
# nor "irreversible", so this pattern leaves them alone.)
STALE_WORDING = re.compile(
    r"irreversible|permanently\s+(?:disable|shut)|permanent.*shutdown",
    re.IGNORECASE,
)

# The narrower adapter-architecture rule: the bare word "permanently" must not
# appear in that doc at all (its only historical use was on the shutdownVault
# bullet).
PERMANENTLY = re.compile(r"permanently", re.IGNORECASE)

RESTORE_VAULT = "restoreVault"


def _lines(root: Path, rel: str) -> list[str]:
    return (root / rel).read_text(encoding="utf-8").splitlines()


def scan(root: Path) -> list[str]:
    """Return a list of human-readable violation strings (empty == pass)."""
    violations: list[str] = []

    # Rule 1: stale "irreversible/permanent shutdown" wording in either doc.
    for rel in (SMART_CONTRACTS_DOC, ADAPTER_ARCH_DOC):
        for lineno, line in enumerate(_lines(root, rel), start=1):
            if STALE_WORDING.search(line):
                violations.append(
                    f"{rel}:{lineno}: stale irreversible/permanent-shutdown "
                    f"wording — shutdownVault is reversible via restoreVault: "
                    f"{line.strip()}"
                )

    # Rule 2: restoreVault must be documented in the smart-contract reference.
    if not any(RESTORE_VAULT in line for line in _lines(root, SMART_CONTRACTS_DOC)):
        violations.append(
            f"{SMART_CONTRACTS_DOC}: `restoreVault` is not documented — the "
            f"ADMIN_ROLE recovery path that reverses shutdownVault must be "
            f"described in the smart-contract reference."
        )

    # Rule 3: adapter-architecture must not use the word "permanently".
    for lineno, line in enumerate(_lines(root, ADAPTER_ARCH_DOC), start=1):
        if PERMANENTLY.search(line):
            violations.append(
                f"{ADAPTER_ARCH_DOC}:{lineno}: the word `permanently` must not "
                f"appear (shutdownVault is recoverable): {line.strip()}"
            )

    return violations


def report(violations: list[str]) -> int:
    if violations:
        print(
            "FAIL: shutdownVault recoverability docs invariant (issue #923) "
            "violated — the canonical docs no longer match "
            "contracts/RobotMoneyVault.sol, which exposes "
            "restoreVault(uint256 newTvlCap) (ADMIN_ROLE) reversing "
            "shutdownVault():",
            file=sys.stderr,
        )
        for v in violations:
            print(f"  {v}", file=sys.stderr)
        print(
            "\nUpdate the smart-contracts.md / adapter-architecture.md wording "
            "to describe shutdownVault as recoverable, and document "
            "restoreVault in smart-contracts.md.",
            file=sys.stderr,
        )
        return 1

    print(
        "OK: shutdownVault is documented as recoverable, restoreVault is "
        "documented, and no stale irreversible/permanent wording remains "
        "(issue #923)."
    )
    return 0


def self_test() -> int:
    """Prove each rule fires against a deliberately-stale fixture tree."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)

        # (a) A clean tree should pass.
        clean = {
            SMART_CONTRACTS_DOC: (
                "| `shutdownVault()` | EMERGENCY | Halt deposits, recoverable "
                "by ADMIN via `restoreVault`. |\n"
                "`restoreVault(uint256 newTvlCap)` (ADMIN) reverses it.\n"
                "The seed deposit is a permanent operational cost.\n"
            ),
            ADAPTER_ARCH_DOC: (
                "- `shutdownVault()` disables deposits; recoverable via "
                "`restoreVault(newTvlCap)` (ADMIN_ROLE).\n"
            ),
        }
        for rel, body in clean.items():
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(body, encoding="utf-8")
        if scan(root):
            print(
                "SELF-TEST FAIL: clean fixture was flagged:",
                file=sys.stderr,
            )
            for v in scan(root):
                print(f"  - {v}", file=sys.stderr)
            return 1

        # (b) Stale "irreversible" wording must fire (rule 1).
        (root / SMART_CONTRACTS_DOC).write_text(
            "| `shutdown` | `shutdownVault` (EMERGENCY) | **Irreversible** |\n"
            "`restoreVault(uint256 newTvlCap)` documented here.\n",
            encoding="utf-8",
        )
        if not any("Irreversible" in v or "irreversible" in v for v in scan(root)):
            print(
                "SELF-TEST FAIL: stale `Irreversible` wording was not flagged.",
                file=sys.stderr,
            )
            return 1

        # (c) Missing restoreVault must fire (rule 2).
        (root / SMART_CONTRACTS_DOC).write_text(
            "| `shutdownVault()` | EMERGENCY | Halt deposits, recoverable. |\n",
            encoding="utf-8",
        )
        if not any("not documented" in v for v in scan(root)):
            print(
                "SELF-TEST FAIL: missing restoreVault was not flagged.",
                file=sys.stderr,
            )
            return 1

        # (d) The word "permanently" in adapter-architecture must fire (rule 3).
        (root / SMART_CONTRACTS_DOC).write_text(
            "`restoreVault(uint256 newTvlCap)` documented here.\n",
            encoding="utf-8",
        )
        (root / ADAPTER_ARCH_DOC).write_text(
            "- `shutdownVault()` permanently disables deposits.\n",
            encoding="utf-8",
        )
        if not any("permanently" in v for v in scan(root)):
            print(
                "SELF-TEST FAIL: the word `permanently` was not flagged.",
                file=sys.stderr,
            )
            return 1

    print(
        "SELF-TEST OK: stale-wording, missing-restoreVault, and "
        "`permanently` rules all fire, and a clean fixture passes (issue #923)."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run an in-process fixture proving each rule fires, then exit.",
    )
    args = parser.parse_args()

    if args.self_test:
        return self_test()

    return report(scan(REPO_ROOT))


if __name__ == "__main__":
    raise SystemExit(main())
