#!/usr/bin/env python3
"""Issue #1646 - governance docs drift guards (widened by issue #1698).

1. Every `security-model` section reference (`security-model.md` section N or
   N.M, written with the section sign or the word "section") in docs/, contracts/
   and .github/ must match a heading in docs/technical/security-model.md.
2. docs/technical/governance-decisions.md, docs/prd.md and
   docs/architecture.md keep one governance model (the Safe, through the
   timelock, applies consensus receipts through the weight setter's
   `applyReceipt`; no voting by anyone) and none of the removed lifecycle,
   call-path or voting text. Issue #1698 deleted RouterGovernance's
   propose/vote/execute path, so no canonical doc may describe it as present,
   as "today's bytecode", or as deleted later.
3. docs/operations/manual-admin-actions.md names the IC policy, the consensus
   receipt and the basket vaults in the timelock handover.

`--self-test` builds a throwaway tree, plants each banned phrase in prd.md and
architecture.md, drops each required phrase, and expects the guard to fire; it
also expects a compliant tree to pass. Set CHECK_REPO_ROOT to run the real check
against another tree.

Wired into .github/workflows/suite-13-doc-checks.yml.
"""
from __future__ import annotations

import os
import re
import sys
import tempfile
from pathlib import Path

SECURITY = Path("docs/technical/security-model.md")
GOVERNANCE = Path("docs/technical/governance-decisions.md")
PRD = Path("docs/prd.md")
ARCHITECTURE = Path("docs/architecture.md")
MANUAL = Path("docs/operations/manual-admin-actions.md")

# The three canonical docs that state the router-weight governance model.
MODEL_DOCS = (GOVERNANCE, PRD, ARCHITECTURE)

REF = re.compile(r"security-model(?:\.md)?[`)\]]*,?\s*(?:§|[Ss]ection\s)(\d+(?:\.\d+)?)")
SKIP_PARTS = {"node_modules", "lib", ".git", "code-review", "target"}

# Removed lifecycle and call-path text (issue #1646). Checked in
# governance-decisions.md only, where it once lived.
GOVERNANCE_ONLY_BANNED = (
    "renounceRole(ADMIN_ROLE, admin)",
    "createProposal",
    "cadenceWindow,   //",
    "voteTallies(uint256",
    "retains `ADMIN_ROLE` as an emergency override",
    "sole `ADMIN_ROLE` holder",
    "admin-assigned",
    "setVotingPower",
)

# RouterGovernance voting residue (issue #1698). Matched case-insensitively in
# every model doc. Each entry is a phrase that only a doc describing the deleted
# propose/vote/execute path, or the pre-1698 two-call batch, would contain.
VOTING_RESIDUE = (
    "RouterGovernance.propose",
    "exist in the deployed test bytecode",
    "will be deleted before the final deployment",
    "today's bytecode",
    "today's `RouterGovernance` bytecode",
    "nobody holds a voter key",
    "voter addresses are held by nobody",
    "RouterGovernance votes",
    "allocation-weight votes",
    "governance votes",
    "-> active vote ->",
    "proposes router weights",
)

# The model every doc must keep stating.
REQUIRED = (
    ("There is no voting by token holders or anyone else", "the no-voting governance model"),
    ("apply-receipt", "the apply-receipt weight path"),
    ("applyReceipt", "the one-call applyReceipt weight setter"),
)

VOTING_POWER = re.compile(
    r"voting power (is|are) (derived|weighted|assigned) (from|by) (RM|token|`?ADMIN_ROLE)"
)


def repo_root() -> Path:
    override = os.environ.get("CHECK_REPO_ROOT")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parents[2]


def headings(root: Path) -> set[str]:
    found = set()
    for line in (root / SECURITY).read_text().splitlines():
        m = re.match(r"#{2,4}\s+(\d+(?:\.\d+)?)\.?\s", line)
        if m:
            found.add(m.group(1))
    return found


def check_refs(root: Path, errors: list[str]) -> None:
    have = headings(root)
    me = Path(__file__).resolve()
    for base in ("docs", "contracts", ".github"):
        if not (root / base).is_dir():
            continue
        for path in (root / base).rglob("*"):
            if not path.is_file() or path.suffix not in {".md", ".sol", ".mdx", ".sh", ".yml", ".py"}:
                continue
            if SKIP_PARTS & set(path.relative_to(root).parts) or path.resolve() == me:
                continue
            try:
                text = path.read_text()
            except UnicodeDecodeError:
                continue
            for m in REF.finditer(text):
                if m.group(1) not in have:
                    errors.append(f"{path.relative_to(root)}: security-model section {m.group(1)} has no heading")


def check_model_doc(root: Path, rel: Path, errors: list[str]) -> None:
    path = root / rel
    if not path.is_file():
        errors.append(f"{rel} is missing")
        return
    text = path.read_text()
    folded = text.lower()
    if rel == GOVERNANCE:
        for banned in GOVERNANCE_ONLY_BANNED:
            if banned in text:
                errors.append(f"{rel.name} still contains removed text: {banned}")
    for banned in VOTING_RESIDUE:
        if banned.lower() in folded:
            errors.append(f"{rel.name} still describes RouterGovernance voting (issue #1698): {banned}")
    for needle, what in REQUIRED:
        if needle not in text:
            errors.append(f"{rel.name} lost {what}")
    if VOTING_POWER.search(text):
        errors.append(f"{rel.name} describes a voting-power model")


def check_governance(root: Path, errors: list[str]) -> None:
    for rel in MODEL_DOCS:
        check_model_doc(root, rel, errors)


def check_manual(root: Path, errors: list[str]) -> None:
    text = (root / MANUAL).read_text()
    for needle in ("InvestmentCommitteePolicy", "ConsensusRecommendationReceipt", "basket vaults"):
        if needle not in text:
            errors.append(f"manual-admin-actions.md handover lacks: {needle}")


def run(root: Path) -> list[str]:
    errors: list[str] = []
    check_refs(root, errors)
    check_governance(root, errors)
    check_manual(root, errors)
    return errors


# ── self-test ────────────────────────────────────────────────────────────────

COMPLIANT_MODEL = (
    "# Governance\n\n"
    "There is no voting by token holders or anyone else. The Safe schedules\n"
    "govern row `apply-receipt`: one `applyReceipt` call releases the receipt\n"
    "and applies its weights. See security-model.md §4.\n"
)


def _write_tree(root: Path) -> None:
    for rel, body in (
        (SECURITY, "# Security model\n\n## 4. Admin authority\n"),
        (MANUAL, "InvestmentCommitteePolicy, ConsensusRecommendationReceipt and the basket vaults.\n"),
        (GOVERNANCE, COMPLIANT_MODEL),
        (PRD, COMPLIANT_MODEL),
        (ARCHITECTURE, COMPLIANT_MODEL),
    ):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(body)


def self_test() -> int:
    cases = 0
    failures = 0

    def expect(name: str, root: Path, want_fail: bool, needle: str = "") -> None:
        nonlocal cases, failures
        cases += 1
        errors = run(root)
        fired = bool(errors) and (not needle or any(needle in e for e in errors))
        if want_fail != fired:
            failures += 1
            print(f"SELF-TEST FAIL: {name}: errors={errors}", file=sys.stderr)
        else:
            print(f"ok: {name}")

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _write_tree(root)
        expect("compliant tree passes", root, want_fail=False)

        for rel in (PRD, ARCHITECTURE):
            for banned in VOTING_RESIDUE:
                _write_tree(root)
                (root / rel).write_text(COMPLIANT_MODEL + f"\nLegacy: {banned} here.\n")
                expect(f"{rel.name} planted '{banned}' fails", root, want_fail=True, needle=rel.name)
            # Case-folded: a capitalised sentence start must still fire.
            _write_tree(root)
            (root / rel).write_text(COMPLIANT_MODEL + "\nOn Today's Bytecode the batch is two calls.\n")
            expect(f"{rel.name} capitalised residue fails", root, want_fail=True, needle=rel.name)
            for needle, _ in REQUIRED:
                _write_tree(root)
                (root / rel).write_text(COMPLIANT_MODEL.replace(needle, "X"))
                expect(f"{rel.name} without '{needle}' fails", root, want_fail=True, needle=rel.name)
            _write_tree(root)
            (root / rel).write_text(COMPLIANT_MODEL + "\nThe voting power is derived from RM balances.\n")
            expect(f"{rel.name} voting-power model fails", root, want_fail=True, needle=rel.name)
            _write_tree(root)
            (root / rel).unlink()
            expect(f"{rel.name} missing fails", root, want_fail=True, needle=rel.name)

        _write_tree(root)
        (root / GOVERNANCE).write_text(COMPLIANT_MODEL + "\ncreateProposal\n")
        expect("governance-decisions.md removed call-path text fails", root, want_fail=True)

        # The committee's own tilt vocabulary is not RouterGovernance voting.
        _write_tree(root)
        (root / PRD).write_text(
            COMPLIANT_MODEL
            + "\nCommittee agents submit signed per-vault votes; `committee vote-submit`.\n"
        )
        expect("committee vote wording passes", root, want_fail=False)

    if cases == 0:
        print("SELF-TEST FAIL: zero cases ran", file=sys.stderr)
        return 1
    print(f"{cases} cases, {failures} failures")
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    errors = run(repo_root())
    for e in errors:
        print(f"FAIL: {e}")
    if errors:
        return 1
    print("governance docs checks OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
