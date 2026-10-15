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
3. Every other Markdown file under docs/ carries none of that voting residue
   either (a phrase is matched with every whitespace run collapsed to one space,
   so a phrase that Markdown wraps across lines still fires), and does not describe the pre-1698 two-call `apply-receipt` batch
   (release plus `setDefaultWeights`). Before this widening the gate read only
   the three model docs, so it printed OK while security-model.md,
   smart-contracts.md and about a dozen other docs still said voting existed
   (QA plan v1 C1, completeness critic). Dated review artifacts (docs/code-review/) and
   the QA plan, which quotes the residue as its work list, are records and are
   not read.
4. docs/operations/manual-admin-actions.md names the IC policy, the consensus
   receipt and the basket vaults in the timelock handover.
5. Every `architecture.md` section reference (section sign or the word
   "section", N, N.M or N.M.K) in docs/, contracts/ and .github/ matches a
   heading in docs/architecture.md (QA plan v1 W4). security-model.md cited
   an architecture section 15 that never existed (review finding F7). A
   reference to the sibling repo's architecture (`robotmoney-frontend` named
   within ARCH_FOREIGN_WINDOW characters before it) and the records are not read.
6. docs/architecture.md keeps its guardrails section: a level-2 heading that
   names Guardrails, then `### Invariants` and `### Negative Invariants`
   under it, each with at least one bullet. The audit-guardrails review reads
   that section and stops when it is missing (QA plan v1 W4, finding F12).

`--self-test` builds a throwaway tree, plants each banned phrase in prd.md,
architecture.md and a non-model doc, drops each required phrase, cites an
architecture section with no heading, removes each part of the guardrails
section, and expects the guard to fire; it also expects a compliant tree,
residue planted in the skipped record paths, and a sibling-repo architecture
reference, to pass. Set CHECK_REPO_ROOT to run the real check against
another tree.

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

# Every Markdown file under DOCS_ROOT is read for VOTING_RESIDUE (QA plan v1 C1).
# These are records, not statements of the current model: dated review
# artifacts, and the QA plan that lists the residue as work to do.
DOCS_ROOT = Path("docs")
RESIDUE_RECORDS = (
    Path("docs/code-review"),
    Path("docs/development/qa-plan-v1.md"),
)

REF = re.compile(r"security-model(?:\.md)?[`)\]]*,?\s*(?:§|[Ss]ection\s)(\d+(?:\.\d+)?)")
# QA plan v1 W4: an architecture.md section reference, `architecture.md` §8 or
# architecture §4.2.1. A match preceded by the sibling repo's name within the
# window cites robotmoney-frontend's own architecture.md and is skipped.
ARCH_REF = re.compile(r"architecture(?:\.md)?[`)\]]*,?\s*(?:§\s?|[Ss]ection\s)(\d+(?:\.\d+)*)")
ARCH_FOREIGN = "robotmoney-frontend"
ARCH_FOREIGN_WINDOW = 200
GUARDRAILS_HEADING = re.compile(r"^##\s+(?:\d+\.\s+)?Guardrails\b", re.MULTILINE)
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
    # The pre-1698 two-call batch (releaseReceipt plus setDefaultWeights). The
    # apply-receipt operation is now one applyReceipt call.
    "`apply-receipt` batch",
    "apply-receipt batch",
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


def fold(text: str) -> str:
    """Lower-cased, with every whitespace run (a line wrap and its indent included)
    collapsed to one space: "today's\n  bytecode" matches "today's bytecode"."""
    return re.sub(r"\s+", " ", text).lower()


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


def arch_headings(root: Path) -> set[str]:
    found = set()
    for line in (root / ARCHITECTURE).read_text().splitlines():
        m = re.match(r"#{2,4}\s+(\d+(?:\.\d+)*)\.?\s", line)
        if m:
            found.add(m.group(1))
    return found


def check_arch_refs(root: Path, errors: list[str]) -> None:
    """Every architecture.md section reference resolves to a heading (QA plan v1 W4)."""
    if not (root / ARCHITECTURE).is_file():
        return  # check_model_doc reports the missing file
    have = arch_headings(root)
    me = Path(__file__).resolve()
    for base in ("docs", "contracts", ".github"):
        if not (root / base).is_dir():
            continue
        for path in (root / base).rglob("*"):
            if not path.is_file() or path.suffix not in {".md", ".sol", ".mdx", ".sh", ".yml", ".py"}:
                continue
            rel = path.relative_to(root)
            if SKIP_PARTS & set(rel.parts) or path.resolve() == me or is_record(rel):
                continue
            try:
                text = path.read_text()
            except UnicodeDecodeError:
                continue
            for m in ARCH_REF.finditer(text):
                if ARCH_FOREIGN in text[max(0, m.start() - ARCH_FOREIGN_WINDOW):m.start()]:
                    continue
                if m.group(1) not in have:
                    line = text.count("\n", 0, m.start()) + 1
                    errors.append(f"{rel}:{line}: architecture section {m.group(1)} has no heading")


def check_guardrails(root: Path, errors: list[str]) -> None:
    """architecture.md keeps a Guardrails section with both invariant lists (QA plan v1 W4)."""
    path = root / ARCHITECTURE
    if not path.is_file():
        return
    text = path.read_text()
    m = GUARDRAILS_HEADING.search(text)
    if not m:
        errors.append("architecture.md has no '## Guardrails' section heading")
        return
    nxt = re.search(r"^##\s", text[m.end():], re.MULTILINE)
    body = text[m.end(): m.end() + nxt.start()] if nxt else text[m.end():]
    for sub in ("Invariants", "Negative Invariants"):
        s = re.search(rf"^###\s+{sub}\s*$", body, re.MULTILINE)
        if not s:
            errors.append(f"architecture.md Guardrails section lacks '### {sub}'")
            continue
        rest = body[s.end():]
        stop = re.search(r"^###\s", rest, re.MULTILINE)
        if not re.search(r"^- \S", rest[: stop.start()] if stop else rest, re.MULTILINE):
            errors.append(f"architecture.md Guardrails '### {sub}' has no bullet")


def check_model_doc(root: Path, rel: Path, errors: list[str]) -> None:
    path = root / rel
    if not path.is_file():
        errors.append(f"{rel} is missing")
        return
    text = path.read_text()
    folded = fold(text)
    if rel == GOVERNANCE:
        for banned in GOVERNANCE_ONLY_BANNED:
            if banned in text:
                errors.append(f"{rel.name} still contains removed text: {banned}")
    for banned in VOTING_RESIDUE:
        if fold(banned) in folded:
            errors.append(f"{rel.name} still describes RouterGovernance voting (issue #1698): {banned}")
    for needle, what in REQUIRED:
        if needle not in text:
            errors.append(f"{rel.name} lost {what}")
    if VOTING_POWER.search(text):
        errors.append(f"{rel.name} describes a voting-power model")


def check_governance(root: Path, errors: list[str]) -> None:
    for rel in MODEL_DOCS:
        check_model_doc(root, rel, errors)


def is_record(rel: Path) -> bool:
    return any(rel == r or r in rel.parents for r in RESIDUE_RECORDS)


def check_residue_everywhere(root: Path, errors: list[str]) -> None:
    """VOTING_RESIDUE in any other doc under docs/ (the model docs are read by check_model_doc)."""
    docs = root / DOCS_ROOT
    if not docs.is_dir():
        return
    for path in sorted(docs.rglob("*.md")):
        rel = path.relative_to(root)
        if rel in MODEL_DOCS or is_record(rel):
            continue
        try:
            folded = fold(path.read_text())
        except UnicodeDecodeError:
            continue
        for banned in VOTING_RESIDUE:
            if fold(banned) in folded:
                errors.append(f"{rel} still describes RouterGovernance voting (issue #1698): {banned}")


def check_manual(root: Path, errors: list[str]) -> None:
    text = (root / MANUAL).read_text()
    for needle in ("InvestmentCommitteePolicy", "ConsensusRecommendationReceipt", "basket vaults"):
        if needle not in text:
            errors.append(f"manual-admin-actions.md handover lacks: {needle}")


def run(root: Path) -> list[str]:
    errors: list[str] = []
    check_refs(root, errors)
    check_governance(root, errors)
    check_residue_everywhere(root, errors)
    check_manual(root, errors)
    check_arch_refs(root, errors)
    check_guardrails(root, errors)
    return errors


# ── self-test ────────────────────────────────────────────────────────────────

COMPLIANT_MODEL = (
    "# Governance\n\n"
    "There is no voting by token holders or anyone else. The Safe schedules\n"
    "govern row `apply-receipt`: one `applyReceipt` call releases the receipt\n"
    "and applies its weights. See security-model.md §4.\n"
)

# architecture.md in the throwaway tree: the model text, numbered sections and
# the guardrails section (QA plan v1 W4).
COMPLIANT_ARCHITECTURE = (
    COMPLIANT_MODEL
    + "\n## 4. On-Chain Architecture\n\n### 4.2 Portfolio Router\n\n#### 4.2.1 Eligible\n\n"
    "## 8. Guardrails (Security Constraints)\n\n"
    "### Invariants\n\n- Vaults enforce caps before accepting deposits.\n\n"
    "### Negative Invariants\n\n- Explorer data is never a signing source of truth.\n\n"
    "## 9. Vendor Selections\n"
)


def _write_tree(root: Path) -> None:
    for rel, body in (
        (SECURITY, "# Security model\n\n## 4. Admin authority\n"),
        (MANUAL, "InvestmentCommitteePolicy, ConsensusRecommendationReceipt and the basket vaults.\n"),
        (GOVERNANCE, COMPLIANT_MODEL),
        (PRD, COMPLIANT_MODEL),
        (ARCHITECTURE, COMPLIANT_ARCHITECTURE),
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
            # architecture.md keeps its guardrails section in every case, so only the planted
            # defect can make the case fire (QA plan v1 W4).
            base = COMPLIANT_ARCHITECTURE if rel == ARCHITECTURE else COMPLIANT_MODEL
            for banned in VOTING_RESIDUE:
                _write_tree(root)
                (root / rel).write_text(base + f"\nLegacy: {banned} here.\n")
                expect(f"{rel.name} planted '{banned}' fails", root, want_fail=True, needle=rel.name)
            # Case-folded: a capitalised sentence start must still fire.
            _write_tree(root)
            (root / rel).write_text(base + "\nOn Today's Bytecode the batch is two calls.\n")
            expect(f"{rel.name} capitalised residue fails", root, want_fail=True, needle=rel.name)
            # Whitespace-collapsed: a phrase Markdown wraps across lines must still fire.
            _write_tree(root)
            (root / rel).write_text(base + "\nThese tables index events of today's\n  bytecode only.\n")
            expect(f"{rel.name} line-wrapped residue fails", root, want_fail=True, needle=rel.name)
            for needle, _ in REQUIRED:
                _write_tree(root)
                (root / rel).write_text(base.replace(needle, "X"))
                expect(f"{rel.name} without '{needle}' fails", root, want_fail=True, needle=rel.name)
            _write_tree(root)
            (root / rel).write_text(base + "\nThe voting power is derived from RM balances.\n")
            expect(f"{rel.name} voting-power model fails", root, want_fail=True, needle=rel.name)
            _write_tree(root)
            (root / rel).unlink()
            expect(f"{rel.name} missing fails", root, want_fail=True, needle=rel.name)

        # Every other doc under docs/ is read for the residue (QA plan v1 C1).
        other = Path("docs/technical/smart-contracts.md")
        for banned in VOTING_RESIDUE:
            _write_tree(root)
            (root / other).parent.mkdir(parents=True, exist_ok=True)
            (root / other).write_text(f"# Contracts\n\nLegacy: {banned} here.\n")
            expect(f"{other.name} planted '{banned}' fails", root, want_fail=True, needle=str(other))
        # A phrase wrapped across two lines (and indented, as in a list item) still fires:
        # docs/technical/multi-vault-explorer-decisions.md once split "today's\n  bytecode".
        for wrapped in ("today's\n  bytecode", "governance\nvotes", "RouterGovernance.propose"):
            _write_tree(root)
            (root / other).write_text(f"# Contracts\n\n- the tables index events of {wrapped}\n  that never fire.\n")
            expect(f"{other.name} line-wrapped {wrapped!r} fails", root, want_fail=True, needle=str(other))
        # _write_tree rewrites only its own files, so remove the planted doc before the next case.
        (root / other).unlink()
        # The records are not read: a dated review and the QA plan may quote the residue.
        for record in (Path("docs/code-review/20261012-security-review.md"), Path("docs/development/qa-plan-v1.md")):
            _write_tree(root)
            (root / record).parent.mkdir(parents=True, exist_ok=True)
            (root / record).write_text("RouterGovernance.propose exist in the deployed test bytecode\n")
            expect(f"{record} residue passes", root, want_fail=False)
            (root / record).unlink()

        _write_tree(root)
        (root / GOVERNANCE).write_text(COMPLIANT_MODEL + "\ncreateProposal\n")
        expect("governance-decisions.md removed call-path text fails", root, want_fail=True)

        # Architecture section references resolve (QA plan v1 W4, finding F7).
        sm = root / SECURITY
        for ref in ("`docs/architecture.md` §8", "architecture §4.2.1", "architecture.md section 4"):
            _write_tree(root)
            sm.write_text(sm.read_text() + f"\nSee {ref}.\n")
            expect(f"security-model cites {ref} passes", root, want_fail=False)
        for ref in ("`docs/architecture.md` §15", "architecture §4.7", "architecture.md`\n§9.3"):
            _write_tree(root)
            sm.write_text(sm.read_text() + f"\nThis section maps onto {ref}.\n")
            expect(f"security-model cites dangling {ref!r} fails", root, want_fail=True, needle="has no heading")
        _write_tree(root)
        adr = root / "docs/adr/ADR-0012-dual-curve-identity-policy.md"
        adr.parent.mkdir(parents=True, exist_ok=True)
        adr.write_text("`robotmoney-frontend/docs/architecture.md`\n§9.3 and §9.5.1 promise anchoring.\n")
        expect("sibling-repo architecture reference passes", root, want_fail=False)
        adr.unlink()
        _write_tree(root)
        plan = root / "docs/development/qa-plan-v1.md"
        plan.parent.mkdir(parents=True, exist_ok=True)
        plan.write_text("W4: no architecture §15.\n")
        expect("dangling architecture reference in a record passes", root, want_fail=False)
        plan.unlink()

        # The guardrails section stays (QA plan v1 W4, finding F12).
        arch = root / ARCHITECTURE
        for name, old, new in (
            ("no Guardrails heading", "## 8. Guardrails (Security Constraints)", "## 8. Security Constraints"),
            ("no Invariants list", "### Invariants\n", "### Rules\n"),
            ("no Negative Invariants list", "### Negative Invariants\n", "### Prohibitions\n"),
            ("empty Negative Invariants list", "- Explorer data is never a signing source of truth.\n", ""),
        ):
            _write_tree(root)
            arch.write_text(arch.read_text().replace(old, new))
            expect(f"architecture.md {name} fails", root, want_fail=True, needle="Guardrails")

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
