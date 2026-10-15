#!/usr/bin/env python3
"""No "not yet implemented" marker in docs/ cites shipped work (QA plan v1 W1, issue #1817).

WHY THIS GATE EXISTS
--------------------
The canonical docs carried "(not yet implemented: core #1521)" and similar
markers for days after the issues they cite closed: the open timelock
executor (1521), stage 13 as the four vault unpauses (1520), the Twin
rehearsal on every push to dev (1523), the committed frozen counts (1524) and
rmAGENT holding RM (1491). Three more markers ("DeployGateway.s.sol still
authorizes AGENT_ADDRESS ... core issue to be filed", "tracked in the mainnet
plan") named no issue at all, so nothing could notice when PR 1582 (issue
1527) shipped the fix. A reader
of prd.md, architecture.md or security-model.md was told shipped controls did
not exist (review findings F5 and CS-7, 2026-10-14).

A MARKER is "not yet implemented", "not yet committed" or "not yet shipped"
(any case, wrapped over lines or not). Its CLAUSE is the parenthetical that
holds it, or, outside parentheses, the text from the marker to the end of its
sentence. An issue the clause cites is `core #N`, `core N`, `issue N` or
`#N`; a `devops issue N` is another repository and is not read.

RULES
-----
1. SHIPPED (offline). No marker clause cites an issue in SHIPPED, the issues
   this gate knows closed with their work landed.
2. UNTRACKED (offline). No marker clause says its work is "to be filed", "not
   yet filed" or "tracked" somewhere while it cites no issue. A marker must cite
   an issue so rule 4 can see it ship.
3. EXECUTOR (offline, issue #1817 acceptance). `DeployTimelock.s.sol`
   `EXECUTOR_POLICY` is a policy this gate knows, and prd.md, architecture.md
   and security-model.md each state that policy's executor text. No doc under
   docs/ keeps a STALE_PHRASES sentence that explained why the work was not
   done yet.
4. CLOSED (`--verify-issue-state`). Every issue any marker clause cites is
   resolved through `gh issue view`, and a CLOSED one fails. Closing an issue
   without deleting its marker therefore turns this gate red on the next run.
   The flag never falls back to the offline rules: a `gh` failure is an error.

Records are not read: dated review artifacts (docs/code-review/), the archive
(docs/archive/) and the QA plan, which quotes the markers as its work list.

`--self-test` builds a throwaway tree, plants each defect (every SHIPPED issue,
a marker wrapped over lines, a citation before the marker inside its
parenthetical, "not yet committed", an untracked or "tracked" marker that cites
no issue, a closed issue through
a fake resolver, an executor policy the docs do not state, a stale phrase) and
expects the gate to fire; it also expects a compliant tree, an open issue, a
devops issue, a marker that cites nothing, and planted markers in the records,
to pass. It needs no network. Set CHECK_REPO_ROOT to run the real check against
another tree.

Wired into .github/workflows/suite-13-doc-checks.yml (docs/development/ci-suites.md section 13).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable

DOCS_ROOT = Path("docs")
RECORDS = (
    Path("docs/code-review"),
    Path("docs/archive"),
    Path("docs/development/qa-plan-v1.md"),
)

# Issues whose work has landed (all CLOSED as completed). A marker that cites one
# is false today. Add an issue here when its marker is removed, so the marker
# cannot come back without the network half of the gate.
SHIPPED: dict[int, str] = {
    1491: "rmAGENT launches holding RM (closed 2026-10-06)",
    1520: "stage 13 is the four vault unpauses and the deploy-time configuration is set before the handover (closed 2026-10-07)",
    1521: "the timelock executor is open (address(0)) and verified on chain (closed 2026-10-07)",
    1522: "the timelock cannot set active router weights directly (closed 2026-10-07)",
    1523: "the Twin rehearsal of publish, verify and govern runs on every push to dev (closed 2026-10-07)",
    1524: "the release SHA's frozen per-stage counts are committed (closed 2026-10-07)",
    1527: "the deploy authorizes no agent (closed by PR 1582)",
    1676: "the Uniswap V4 swap adapter is restored for RM's venue (closed 2026-10-09)",
}

MARKER = re.compile(r"not\s+yet\s+(?:implemented|committed|shipped)\b", re.IGNORECASE)
UNTRACKED = re.compile(r"to\s+be\s+filed|not\s+yet\s+filed|\btracked\b", re.IGNORECASE)
ISSUE_REF = re.compile(r"(?:\bcore\s+#?|\bissue\s+#?|(?<![\w&/])#)(\d{3,5})\b", re.IGNORECASE)
CLAUSE_LIMIT = 300

# Rule 3. The executor-role policy DeployTimelock records, and the sentence each
# canonical doc must keep for it (whitespace-collapsed, so a wrapped line matches).
TIMELOCK_SCRIPT = Path("contracts/script/DeployTimelock.s.sol")
EXECUTOR_POLICY = re.compile(r'string\s+public\s+constant\s+EXECUTOR_POLICY\s*=\s*"([^"]*)"')
EXECUTOR_TEXT: dict[str, dict[Path, str]] = {
    "open": {
        Path("docs/prd.md"): "any address may execute a ready operation after the delay",
        Path("docs/architecture.md"): "EXECUTOR_ROLE is open (`address(0)`)",
        Path("docs/technical/security-model.md"): "executor is open (`address(0)`)",
    },
}

# Rule 3. The explanations the shipped markers carried. Each one is false today.
STALE_PHRASES = (
    "still sets the Safe as executor",
    "still reads `AGENT_ADDRESS`",
    "still authorizes `AGENT_ADDRESS`",
    "still runs the older per-step matrix",
    "still lists the older 13-row set",
    # QA plan v1 W1 completeness: headless-opencode-tests.md row 5 still said the gateway
    # stage authorizes the generated key. DeployGateway.s.sol reads no AGENT_* input (core 1527).
    "(`DeployGateway.s.sol`) calls `gateway.authorizeAgent",
)

Resolver = Callable[[int], str]


def repo_root() -> Path:
    override = os.environ.get("CHECK_REPO_ROOT")
    if override:
        return Path(override).resolve()
    return Path(__file__).resolve().parents[2]


def is_record(rel: Path) -> bool:
    return any(rel == r or r in rel.parents for r in RECORDS)


def doc_files(root: Path) -> list[Path]:
    docs = root / DOCS_ROOT
    if not docs.is_dir():
        return []
    return [p for p in sorted(docs.rglob("*.md")) if not is_record(p.relative_to(root))]


def flat(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def clause(text: str, start: int, end: int) -> str:
    """The parenthetical around text[start:end], or the rest of its sentence when there is none."""
    open_at = None
    depth = 0
    i = start - 1
    while i >= 0 and start - i <= CLAUSE_LIMIT:
        ch = text[i]
        if ch == "|" or text.startswith("\n\n", i):
            break
        if ch == ")":
            depth += 1
        elif ch == "(":
            if depth == 0:
                open_at = i
                break
            depth -= 1
        i -= 1
    depth = 0
    j = end
    while j < len(text) and j - end <= CLAUSE_LIMIT:
        ch = text[j]
        if ch == "|" or text.startswith("\n\n", j):
            break
        if ch == "(":
            depth += 1
        elif ch == ")":
            if depth == 0 and open_at is not None:
                break
            depth = max(depth - 1, 0)
        elif open_at is None and ch in ".;" and (j + 1 == len(text) or text[j + 1].isspace()):
            break
        j += 1
    return text[open_at if open_at is not None else start : j]


def cited_issues(text: str) -> list[int]:
    found = []
    for m in ISSUE_REF.finditer(text):
        if text[max(0, m.start() - 7) : m.start()].lower().endswith("devops "):
            continue
        found.append(int(m.group(1)))
    return found


def markers(root: Path) -> list[tuple[Path, int, str, list[int]]]:
    """(path, line, clause, cited issues) for every marker in the docs that are read."""
    out = []
    for path in doc_files(root):
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for m in MARKER.finditer(text):
            body = clause(text, m.start(), m.end())
            line = text.count("\n", 0, m.start()) + 1
            out.append((path.relative_to(root), line, flat(body).strip(), cited_issues(body)))
    return out


def check_markers(root: Path, errors: list[str], resolve: Resolver | None) -> tuple[int, int]:
    found = markers(root)
    states: dict[int, str] = {}
    cited = 0
    for rel, line, body, issues in found:
        where = f"{rel}:{line}"
        if UNTRACKED.search(body) and not issues:
            errors.append(f"{where}: marker names no issue ('{body}'). Cite the issue so the gate can see it ship.")
        for n in issues:
            cited += 1
            if n in SHIPPED:
                errors.append(f"{where}: marker cites shipped core #{n} ({SHIPPED[n]}): '{body}'. Delete the marker.")
                continue
            if resolve is None:
                continue
            if n not in states:
                states[n] = resolve(n)
            if states[n] != "OPEN":
                errors.append(f"{where}: marker cites #{n}, which is {states[n]}: '{body}'. Delete the marker or cite the open issue.")
    return len(found), cited


def check_executor(root: Path, errors: list[str]) -> None:
    script = root / TIMELOCK_SCRIPT
    if not script.is_file():
        errors.append(f"{TIMELOCK_SCRIPT} is missing, so the executor policy cannot be read")
        return
    m = EXECUTOR_POLICY.search(script.read_text(encoding="utf-8"))
    if not m:
        errors.append(f"{TIMELOCK_SCRIPT}: no `string public constant EXECUTOR_POLICY = \"...\"` to read")
        return
    policy = m.group(1)
    wanted = EXECUTOR_TEXT.get(policy)
    if wanted is None:
        errors.append(
            f"{TIMELOCK_SCRIPT}: EXECUTOR_POLICY is '{policy}', and this gate only knows the docs text for "
            f"{sorted(EXECUTOR_TEXT)}. Update prd.md, architecture.md, security-model.md and EXECUTOR_TEXT together."
        )
        return
    for rel, needle in wanted.items():
        path = root / rel
        if not path.is_file():
            errors.append(f"{rel} is missing")
        elif needle not in flat(path.read_text(encoding="utf-8")):
            errors.append(f"{rel} does not state the '{policy}' executor of DeployTimelock EXECUTOR_POLICY: {needle}")


def check_stale(root: Path, errors: list[str]) -> None:
    for path in doc_files(root):
        try:
            text = flat(path.read_text(encoding="utf-8"))
        except UnicodeDecodeError:
            continue
        for phrase in STALE_PHRASES:
            if phrase in text:
                errors.append(f"{path.relative_to(root)}: still says '{phrase}', which shipped work made false")


def gh_issue_state(number: int) -> str:
    """OPEN or CLOSED for an issue of this repository, via `gh`. Raises loudly on failure."""
    if shutil.which("gh") is None:
        raise SystemExit(
            "ERROR: --verify-issue-state needs the `gh` CLI and it is not on PATH. It does not fall back to\n"
            "       the offline rules: a closed issue behind a marker is exactly what it is looking for."
        )
    cmd = ["gh", "issue", "view", str(number), "--json", "state"]
    repo = os.environ.get("GITHUB_REPOSITORY")
    if repo:
        cmd += ["--repo", repo]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=60)
    if proc.returncode != 0:
        raise SystemExit(
            f"ERROR: `gh issue view {number}` failed (exit {proc.returncode}).\n"
            f"       stderr: {proc.stderr.strip()}\n"
            "       Set GH_TOKEN/GITHUB_TOKEN, or drop --verify-issue-state to run the offline rules only."
        )
    return json.loads(proc.stdout)["state"].upper()


def run(root: Path, resolve: Resolver | None = None) -> tuple[list[str], int, int]:
    errors: list[str] = []
    found, cited = check_markers(root, errors, resolve)
    check_executor(root, errors)
    check_stale(root, errors)
    return errors, found, cited


# ── self-test ────────────────────────────────────────────────────────────────

COMPLIANT = {
    Path("docs/prd.md"): (
        "# PRD\n\nThe Safe proposes, and any address may\nexecute a ready operation after the delay (core #1521).\n"
        "The dashboard export is not yet implemented (core #9001).\n"
    ),
    Path("docs/architecture.md"): "# Architecture\n\nEXECUTOR_ROLE is open (`address(0)`) so any address executes.\n",
    Path("docs/technical/security-model.md"): "# Security\n\nThe executor is open (`address(0)`).\n",
    TIMELOCK_SCRIPT: 'contract DeployTimelock {\n    string public constant EXECUTOR_POLICY = "open";\n}\n',
}
OTHER = Path("docs/technical/other.md")


def _write_tree(root: Path) -> None:
    if (root / "docs").exists():
        shutil.rmtree(root / "docs")
    for rel, body in COMPLIANT.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(body, encoding="utf-8")


def _plant(root: Path, rel: Path, body: str) -> None:
    (root / rel).parent.mkdir(parents=True, exist_ok=True)
    (root / rel).write_text(body, encoding="utf-8")


def self_test() -> int:
    cases = 0
    failures = 0
    open_only: Resolver = lambda n: "OPEN"
    closed_9002: Resolver = lambda n: "CLOSED" if n == 9002 else "OPEN"

    def expect(name: str, root: Path, want_fail: bool, needle: str = "", resolve: Resolver | None = None) -> None:
        nonlocal cases, failures
        cases += 1
        errors, _, _ = run(root, resolve)
        fired = bool(errors) and (not needle or any(needle in e for e in errors))
        if want_fail != fired:
            failures += 1
            print(f"SELF-TEST FAIL: {name}: errors={errors}", file=sys.stderr)
        else:
            print(f"ok: {name}")

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        _write_tree(root)
        expect("compliant tree passes offline", root, want_fail=False)
        expect("compliant tree passes with an open cited issue", root, want_fail=False, resolve=open_only)
        errors, found, cited = run(root, open_only)
        cases += 1
        if found < 1 or cited < 1:
            failures += 1
            print(f"SELF-TEST FAIL: the compliant marker was not seen (markers={found}, cited={cited})", file=sys.stderr)
        else:
            print("ok: the compliant marker and its open issue are counted")

        # Rule 1, each shipped issue in the plain form.
        for n in sorted(SHIPPED):
            _write_tree(root)
            _plant(root, OTHER, f"# Other\n\nThe feature ships later (not yet implemented: core #{n}).\n")
            expect(f"shipped core #{n} fails", root, want_fail=True, needle=f"core #{n}")
        _write_tree(root)
        _plant(root, OTHER, "# Other\n\nRM on Base at `0x65` (not yet\nimplemented:\ncore #1491). Next line.\n")
        expect("marker wrapped over lines fails", root, want_fail=True, needle="core #1491")
        _write_tree(root)
        _plant(root, OTHER, "# Other\n\nexecutor open (`address(0)`; core #1521, not yet implemented).\n")
        expect("citation before the marker in its parenthetical fails", root, want_fail=True, needle="core #1521")
        _write_tree(root)
        _plant(root, OTHER, "| 12 | the frozen counts (counts not yet committed: core #1524). |\n")
        expect("'not yet committed' in a table cell fails", root, want_fail=True, needle="core #1524")
        _write_tree(root)
        _plant(root, OTHER, "# Other\n\nThe unpause rows are Not Yet Implemented (issue 1520; see the plan).\n")
        expect("'issue N' form, any case, fails", root, want_fail=True, needle="core #1520")

        # Rule 2.
        _write_tree(root)
        _plant(root, OTHER, "# Other\n\nA V4 adapter (not yet implemented; core\nissue to be filed).\n")
        expect("untracked marker fails", root, want_fail=True, needle="names no issue")
        _write_tree(root)
        _plant(root, OTHER, "# Other\n\nThe deploy authorizes no agent (agent removal not yet implemented:\ntracked in the mainnet plan).\n")
        expect("marker 'tracked' with no issue fails", root, want_fail=True, needle="names no issue")
        _write_tree(root)
        _plant(root, OTHER, "# Other\n\nThe export is not yet implemented (tracked in core #9001).\n")
        expect("marker 'tracked' with an open issue passes", root, want_fail=False, resolve=open_only)

        # Rule 4, through a fake resolver.
        _write_tree(root)
        _plant(root, OTHER, "# Other\n\nThe export is not yet implemented (core #9002).\n")
        expect("closed cited issue fails with --verify-issue-state", root, want_fail=True, needle="#9002", resolve=closed_9002)
        expect("closed cited issue passes offline (not in SHIPPED)", root, want_fail=False)
        expect("open cited issue passes with --verify-issue-state", root, want_fail=False, resolve=open_only)

        # Not markers of this repository's shipped work.
        _write_tree(root)
        _plant(root, OTHER, "# Other\n\nThe host is not yet implemented (devops issue 1520).\n")
        expect("devops issue passes", root, want_fail=False, resolve=closed_9002)
        _write_tree(root)
        _plant(root, OTHER, "# Other\n\nStatus: design spec, not yet implemented.\n")
        expect("marker that cites nothing passes", root, want_fail=False)
        _write_tree(root)
        _plant(root, OTHER, "# Other\n\nThe executor ships in core #1521. The export is not yet implemented.\n")
        expect("issue outside the marker's sentence passes", root, want_fail=False)
        for record in (Path("docs/code-review/20261014-review.md"), Path("docs/archive/old.md"), Path("docs/development/qa-plan-v1.md")):
            _write_tree(root)
            _plant(root, record, "Delete (not yet implemented: core #1521; core issue to be filed). still sets the Safe as executor\n")
            expect(f"{record} is a record and passes", root, want_fail=False)

        # Rule 3.
        _write_tree(root)
        _plant(root, TIMELOCK_SCRIPT, 'contract DeployTimelock {\n    string public constant EXECUTOR_POLICY = "safe-only";\n}\n')
        expect("executor policy the docs do not state fails", root, want_fail=True, needle="safe-only")
        _write_tree(root)
        _plant(root, TIMELOCK_SCRIPT, "contract DeployTimelock {}\n")
        expect("unreadable executor policy fails", root, want_fail=True, needle="EXECUTOR_POLICY")
        for rel in EXECUTOR_TEXT["open"]:
            _write_tree(root)
            _plant(root, rel, "# Doc\n\nThe Safe executes.\n")
            expect(f"{rel.name} without the open executor fails", root, want_fail=True, needle=str(rel))
        for phrase in STALE_PHRASES:
            _write_tree(root)
            _plant(root, OTHER, f"# Other\n\n`DeployTimelock` {phrase} today.\n")
            expect(f"stale phrase '{phrase}' fails", root, want_fail=True, needle=phrase)

    if cases == 0:
        print("SELF-TEST FAIL: zero cases ran", file=sys.stderr)
        return 1
    print(f"{cases} cases, {failures} failures")
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    resolve = gh_issue_state if "--verify-issue-state" in argv else None
    errors, found, cited = run(repo_root(), resolve)
    for e in errors:
        print(f"FAIL: {e}")
    if errors:
        return 1
    mode = "issue state verified through gh" if resolve else "offline: SHIPPED list only"
    print(f"shipped-issue marker checks OK: {found} markers, {cited} issue citations ({mode})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
