#!/usr/bin/env python3
"""Withdrawals are never frozen: pause-semantics guard (core 1494, issue #1518).

Owner decision 2026-10-05: "We do not ever freeze withdrawals." A pause stops
new deposits only, and the names say so: `pauseDeposits()` /
`unpauseDeposits()` / `depositsPaused()`, events `DepositsPaused` /
`DepositsUnpaused`, error `DepositsArePaused`, registry
`VaultStatus.DepositsPaused`, gateway `DEPOSIT_PAUSER_ROLE`. The withdrawal
pause (`withdrawalsPaused`) is deleted.

This guard fails when a tracked source or doc file:

  1. uses an old name: bare `pause()` / `unpause()` / `paused()`, an ABI or
     viem call naming `pause` / `unpause` / `paused`, `EnforcedPause`,
     `ExpectedPause`, `PAUSER_ROLE`, `withdrawalsPaused` (any case of the first
     letter), `VaultStatus.Paused` / `VaultStatus::Paused`, or OpenZeppelin
     `Pausable` in Solidity; or
  2. says a withdrawal can be paused: "withdrawals paused", "freeze
     withdrawals", "halts withdrawals" and their inflections. A line that
     negates the claim ("never", "not", "no", "cannot", ...) is fine.

Allow-list:

  * v1 lines. The deployed v1 vault keeps its old code. A line that names v1
    (the word `v1`) may use the old names.
  * Dated history (code reviews, the audits ledger, ADRs, scout reports,
    sprint logs). The original text is not rewritten. Such a file may keep
    old wording only if it carries the dated note: it must contain both
    `2026-10-05` and `1494`.
  * A line carrying the marker `pause-guard: allow` (for a third-party
    contract's own pause, such as USDC's).

Exit 0 on success, 1 on any violation. No network access. Run with
`--self-test` to confirm every rule fires and every allowance holds.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

SCANNED_SUFFIXES = {
    ".sol", ".md", ".mdx", ".rs", ".ts", ".tsx", ".js", ".mjs", ".py", ".sh",
    ".yml", ".yaml", ".json", ".toml", ".txt", ".html",
}

# Paths never scanned: vendored code, generated forge docs (regenerated from
# NatSpec, which is scanned), lock files, binary-ish fixtures, this guard.
EXCLUDED_PREFIXES = (
    "lib/",
    "contracts/doc/",
    "testing/fixtures/fork-state/",
    ".github/scripts/check_pause_semantics.py",
)
EXCLUDED_NAMES = {"Cargo.lock", "bun.lock", "bun.lockb", "package-lock.json", "yarn.lock"}

# Dated history: the original text stays; the file must carry the dated note.
HISTORY_PREFIXES = (
    "docs/code-review/",
    "docs/audits.md",
    "docs/adr/",
)
HISTORY_NOTE_MARKERS = ("2026-10-05", "1494")

ALLOW_MARKER = "pause-guard: allow"
V1_LINE = re.compile(r"\bv1\b", re.IGNORECASE)

OLD_NAMES: list[tuple[str, re.Pattern[str]]] = [
    ("bare pause()/unpause()/paused()", re.compile(r"(?<![\w.$])(?:un)?pause(?:d)?\(\)")),
    ("member call .pause()/.unpause()/.paused()", re.compile(r"\.(?:un)?pause(?:d)?\(")),
    (
        "ABI or viem name pause/unpause/paused",
        re.compile(r"""(?:functionName|"name")\s*:\s*["'](?:un)?pause(?:d)?["']"""),
    ),
    ("EnforcedPause/ExpectedPause", re.compile(r"\b(?:Enforced|Expected)Pause\b")),
    ("PAUSER_ROLE (now DEPOSIT_PAUSER_ROLE)", re.compile(r"\bPAUSER_ROLE\b")),
    ("withdrawalsPaused (deleted)", re.compile(r"[wW]ithdrawalsPaused")),
    ("VaultStatus.Paused (now DepositsPaused)", re.compile(r"VaultStatus(?:\.|::)Paused\b")),
    (
        "event Paused/Unpaused (now DepositsPaused/DepositsUnpaused)",
        re.compile(r"\bevent\s+(?:Un)?Paused\s*\(|(?<![A-Za-z])(?:Un)?Paused\(address"),
    ),
    (
        "gateway PausedError/NotPaused, router VaultPausedForRedeem",
        re.compile(r"\b(?:PausedError|NotPaused|VaultPausedForRedeem)\b"),
    ),
]
SOL_ONLY: list[tuple[str, re.Pattern[str]]] = [
    ("OpenZeppelin Pausable", re.compile(r"\bPausable\b")),
]

FREEZE_WORDING = re.compile(
    r"\bwithdrawals?\s+(?:are\s+|is\s+|stay\s+|remain\s+)?(?:paused|frozen)\b"
    r"|\bfreez(?:e|es|ing)\s+(?:all\s+)?(?:\w+\s+)?withdrawals?\b"
    r"|\bhalt(?:s|ed|ing)?\s+(?:all\s+)?(?:deposits\s+and\s+)?withdrawals?\b"
    r"|\bpaus(?:e|es|ed|ing)\s+(?:all\s+)?(?:deposits\s+and\s+)?withdrawals?\b",
    re.IGNORECASE,
)
NEGATION = re.compile(
    r"\b(?:never|not|no|cannot|can't|nothing|none|neither|nor|without|isn't|aren't|won't)\b",
    re.IGNORECASE,
)


def _tracked_files(root: Path) -> list[str]:
    out = subprocess.run(
        ["git", "ls-files"], cwd=root, check=True, capture_output=True, text=True
    ).stdout
    return [p for p in out.splitlines() if p]


def _in_scope(rel: str) -> bool:
    if rel.startswith(EXCLUDED_PREFIXES):
        return False
    name = rel.rsplit("/", 1)[-1]
    if name in EXCLUDED_NAMES:
        return False
    return Path(rel).suffix in SCANNED_SUFFIXES


def scan_text(rel: str, text: str) -> list[str]:
    """Violations for one file's text (empty == pass)."""
    is_history = rel.startswith(HISTORY_PREFIXES)
    if is_history and all(m in text for m in HISTORY_NOTE_MARKERS):
        return []
    rules = OLD_NAMES + (SOL_ONLY if rel.endswith(".sol") else [])
    found: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        if ALLOW_MARKER in line or V1_LINE.search(line):
            continue
        for label, pattern in rules:
            if pattern.search(line):
                found.append(f"{rel}:{lineno}: old name ({label}): {line.strip()}")
        if FREEZE_WORDING.search(line) and not NEGATION.search(line):
            found.append(f"{rel}:{lineno}: says a withdrawal can be paused: {line.strip()}")
    if found and is_history:
        found.append(
            f"{rel}: dated history keeps its text, but it must carry a dated "
            f"2026-10-05 note naming core 1494"
        )
    return found


def scan(root: Path, files: list[str] | None = None) -> list[str]:
    violations: list[str] = []
    for rel in files if files is not None else _tracked_files(root):
        if not _in_scope(rel):
            continue
        path = root / rel
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        violations.extend(scan_text(rel, text))
    return violations


def report(violations: list[str]) -> int:
    if not violations:
        print("OK: no old pause names and no claim that a withdrawal can be paused.")
        return 0
    print(f"FAIL: {len(violations)} pause-semantics violation(s) (core 1494):")
    for v in violations:
        print(f"  {v}")
    print(
        "\nA pause stops deposits only. Use pauseDeposits()/unpauseDeposits()/"
        "depositsPaused(), DepositsPaused/DepositsUnpaused, DepositsArePaused, "
        "VaultStatus.DepositsPaused and DEPOSIT_PAUSER_ROLE. Lines about the v1 "
        "vault must say v1; dated history needs a dated 2026-10-05 note."
    )
    return 1


# (relative path, text, expected violation count)
SELF_TEST_CASES: list[tuple[str, str, int]] = [
    ("contracts/A.sol", "function pause() external {}\n", 1),
    ("contracts/A.sol", "vault.unpause();\n", 1),
    ("contracts/A.sol", "if (gateway.paused()) revert X();\n", 1),
    ("contracts/A.sol", "import {Pausable} from \"oz/Pausable.sol\";\n", 1),
    ("docs/x.md", "Pausable is fine in prose outside Solidity.\n", 0),
    ("contracts/A.sol", "bytes32 r = keccak256(\"PAUSER_ROLE\");\n", 1),
    ("contracts/A.sol", "bytes32 r = DEPOSIT_PAUSER_ROLE;\n", 0),
    ("contracts/A.sol", "error EnforcedPause();\n", 1),
    ("clients/a.rs", "let p = vault.withdrawalsPaused().call().await?;\n", 1),
    ("contracts/A.sol", "status == VaultRegistry.VaultStatus.Paused\n", 1),
    ("contracts/A.sol", "status == VaultRegistry.VaultStatus.DepositsPaused\n", 0),
    ("clients/a.ts", "functionName: 'paused',\n", 1),
    ("clients/a.json", '{"name": "pause", "type": "function"}\n', 1),
    ("contracts/A.sol", "vault.pauseDeposits(); vault.depositsPaused();\n", 0),
    ("contracts/A.sol", "event Paused(address indexed by);\n", 1),
    ("services/a.rs", 'paused: keccak256(b"Paused(address)"),\n', 1),
    ("services/a.rs", 'd: keccak256(b"DepositsPaused(address)"),\n', 0),
    ("contracts/A.sol", "revert PausedError();\n", 1),
    ("contracts/A.sol", "revert DepositsNotPaused();\n", 0),
    ("docs/x.md", "An emergency pause halts deposits and withdrawals.\n", 1),
    ("docs/x.md", "Withdrawals are paused until the admin unpauses.\n", 1),
    ("docs/x.md", "The key can freeze withdrawals for 48 hours.\n", 1),
    ("docs/x.md", "A pause never freezes withdrawals.\n", 0),
    ("docs/x.md", "No role can halt withdrawals.\n", 0),
    ("docs/x.md", "The v1 vault's pause() also froze withdrawals; never call it.\n", 0),
    ("docs/x.md", "USDC paused() is Circle's own switch. pause-guard: allow\n", 0),
    ("docs/adr/ADR-9.md", "pause() halts deposits and withdrawals.\n", 3),
    (
        "docs/adr/ADR-9.md",
        "pause() halts deposits and withdrawals.\n\n> Note 2026-10-05 (core 1494): superseded.\n",
        0,
    ),
    ("lib/oz/Pausable.sol", "function pause() {}\n", 0),
]


def self_test() -> int:
    failures = 0
    for rel, text, expected in SELF_TEST_CASES:
        got = len(scan_text(rel, text)) if _in_scope(rel) else 0
        if got != expected:
            failures += 1
            print(f"SELF-TEST FAIL: {rel!r} {text!r}: expected {expected}, got {got}")
    # End to end through scan() on a throwaway tree, so the file walk and the
    # exclusions are exercised too.
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "contracts").mkdir()
        (root / "lib").mkdir()
        (root / "contracts/Bad.sol").write_text("function unpause() external {}\n")
        (root / "contracts/Good.sol").write_text("function unpauseDeposits() external {}\n")
        (root / "lib/Vendor.sol").write_text("function unpause() external {}\n")
        got = scan(root, ["contracts/Bad.sol", "contracts/Good.sol", "lib/Vendor.sol"])
        if len(got) != 1 or "Bad.sol" not in got[0]:
            failures += 1
            print(f"SELF-TEST FAIL: tree scan expected one Bad.sol violation, got {got}")
    total = len(SELF_TEST_CASES) + 1
    if failures:
        print(f"SELF-TEST FAILED: {failures} of {total} cases")
        return 1
    print(f"SELF-TEST OK: {total} cases")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--self-test", action="store_true", help="exercise every rule")
    args = parser.parse_args()
    if args.self_test:
        return self_test()
    return report(scan(REPO_ROOT))


if __name__ == "__main__":
    sys.exit(main())
