#!/usr/bin/env python3
"""ADR-0004 must not state the single-signer cancel policy (core 1521).

Owner decision 2026-10-05: the timelock canceller is the Safe only, acting at its
threshold (2 or more signatures), and the executor is open. ADR-0004 once said any
single Safe signer may cancel. This check fails if either removed phrase returns.

Exit 0 when neither phrase appears, non-zero with a diagnosis otherwise. No network.
"""

from __future__ import annotations

import sys
from pathlib import Path

ADR = Path(__file__).resolve().parents[2] / "docs/adr/ADR-0004-agent-token-shortlist-governance.md"
REMOVED = ["Any Safe signer (unilaterally)", "any one Safe signer may call"]


def main() -> int:
    text = ADR.read_text(encoding="utf-8")
    hits = [p for p in REMOVED if p in text]
    for p in hits:
        print(f"ERROR: {ADR.name} contains the removed single-signer cancel phrase: {p!r}")
    if hits:
        return 1
    print("OK: ADR-0004 has no single-signer cancel phrase")
    return 0


if __name__ == "__main__":
    sys.exit(main())
