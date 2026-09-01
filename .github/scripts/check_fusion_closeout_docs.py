#!/usr/bin/env python3
"""Keep Fusion's canonical proposal and architecture closure in sync (#1249)."""
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
PROPOSAL = ROOT / "docs/product/20260623-product-proposal-investment-committee-v0.md"
ARCHITECTURE = ROOT / "docs/architecture.md"

PROPOSAL_REQUIREMENTS = (
    "Status: **Implemented on a local devnet; not publicly deployed.**",
    "#### 2.1 Consensus recommendation receipts — v0.1 implementation scope",
    "### 3.3 Extend for v0.1 (Consensus recommendation receipts — implemented locally)",
    "**6.1 Receipt JSON schema and transport — implemented and pinned (D2).**",
    "**6.2 Release quorum and governance handoff — implemented and pinned (D5/D6).**",
    "**6.3 External-organization attestation — explicitly re-deferred past v0.1.**",
    "**6.4 Judge scope across subjects — implemented and pinned.**",
    "largest-remainder allocation",
)

ARCHITECTURE_REQUIREMENTS = (
    "### 4.9 Consensus Recommendation Receipt Contract",
    "### 5.4 Explorer Indexer and API",
    "consensus_receipts",
    "GET /v1/consensus-receipts",
    "### 7.5 Consensus Recommendation Receipt Contract",
    "tampered or unsupported receipt\ntherefore never reaches the chain.",
)


def missing(path: Path, requirements: tuple[str, ...]) -> list[str]:
    if not path.is_file():
        return [f"missing canonical document: {path.relative_to(ROOT)}"]
    text = path.read_text(encoding="utf-8")
    return [f"{path.relative_to(ROOT)} is missing required Fusion closure text: {item!r}" for item in requirements if item not in text]


def main() -> int:
    failures = missing(PROPOSAL, PROPOSAL_REQUIREMENTS) + missing(ARCHITECTURE, ARCHITECTURE_REQUIREMENTS)
    if failures:
        print("\n".join(f"ERROR: {failure}" for failure in failures), file=sys.stderr)
        return 1
    print("ok: Fusion proposal resolutions and architecture receipt surfaces are closed and cross-referenced")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
