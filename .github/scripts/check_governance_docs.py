#!/usr/bin/env python3
"""Issue #1646 - governance docs drift guards.

1. Every `security-model` section reference (`security-model.md` section N or
   N.M, written with the section sign or the word "section") in docs/, contracts/
   and .github/ must match a heading in docs/technical/security-model.md.
2. docs/technical/governance-decisions.md keeps one voting-power model
   (admin-assigned) and none of the removed lifecycle or call-path text.
3. docs/operations/manual-admin-actions.md names the IC policy, the consensus
   receipt and the basket vaults in the timelock handover.

Wired into .github/workflows/suite-13-doc-checks.yml.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SECURITY = ROOT / "docs/technical/security-model.md"
GOVERNANCE = ROOT / "docs/technical/governance-decisions.md"
MANUAL = ROOT / "docs/operations/manual-admin-actions.md"

REF = re.compile(r"security-model(?:\.md)?[`)\]]*,?\s*(?:§|[Ss]ection\s)(\d+(?:\.\d+)?)")
SKIP_PARTS = {"node_modules", "lib", ".git", "code-review", "target"}


def headings() -> set[str]:
    found = set()
    for line in SECURITY.read_text().splitlines():
        m = re.match(r"#{2,4}\s+(\d+(?:\.\d+)?)\.?\s", line)
        if m:
            found.add(m.group(1))
    return found


def check_refs(errors: list[str]) -> None:
    have = headings()
    for base in ("docs", "contracts", ".github"):
        for path in (ROOT / base).rglob("*"):
            if not path.is_file() or path.suffix not in {".md", ".sol", ".mdx", ".sh", ".yml", ".py"}:
                continue
            if SKIP_PARTS & set(path.relative_to(ROOT).parts) or path == Path(__file__).resolve():
                continue
            try:
                text = path.read_text()
            except UnicodeDecodeError:
                continue
            for m in REF.finditer(text):
                if m.group(1) not in have:
                    errors.append(f"{path.relative_to(ROOT)}: security-model section {m.group(1)} has no heading")


def check_governance(errors: list[str]) -> None:
    text = GOVERNANCE.read_text()
    for banned in (
        "renounceRole(ADMIN_ROLE, admin)",
        "createProposal",
        "cadenceWindow,   //",
        "voteTallies(uint256",
        "retains `ADMIN_ROLE` as an emergency override",
        "sole `ADMIN_ROLE` holder",
    ):
        if banned in text:
            errors.append(f"governance-decisions.md still contains removed text: {banned}")
    if "admin-assigned" not in text:
        errors.append("governance-decisions.md lost the admin-assigned voting-power model")
    if re.search(r"voting power (is|are) (derived|weighted) (from|by) (RM|token)", text):
        errors.append("governance-decisions.md describes a token-based voting-power model")


def check_manual(errors: list[str]) -> None:
    text = MANUAL.read_text()
    for needle in ("InvestmentCommitteePolicy", "ConsensusRecommendationReceipt", "basket vaults"):
        if needle not in text:
            errors.append(f"manual-admin-actions.md handover lacks: {needle}")


def main() -> int:
    errors: list[str] = []
    check_refs(errors)
    check_governance(errors)
    check_manual(errors)
    for e in errors:
        print(f"FAIL: {e}")
    if errors:
        return 1
    print("governance docs checks OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
