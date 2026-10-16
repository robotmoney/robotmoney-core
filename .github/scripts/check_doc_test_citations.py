#!/usr/bin/env python3
"""Every Solidity test a canonical doc cites exists (QA plan v1 W5, issue #1798).

WHY THIS GATE EXISTS
--------------------
docs/technical/redeem-gas-1482.md named
`BasketVaultLivePositionForkTest.test_fork_liveRmprotoPosition_core1778` as the
record of the live rmPROTO numbers (core 1778). That test was dropped before PR
1784 merged, so the doc cited evidence that never existed on dev, and it said
the dust leg was 40 units where the shipped test uses 31 (issue #1798).
smart-contract-invariants.md had the same defect at scale: 18 "Enforced at"
entries cited tests of the rejected ADR-0010 design (review finding F3).
Nothing failed when a cited test disappeared or a cited line moved.

RULES
-----
Citations are read from the Markdown under docs/, records excepted (below).
1. QUALIFIED. `File.t.sol::name`, with or without a path: a test file with that
   basename exists under contracts/ and declares `function name(`, or
   `contract Name` when the name starts upper case. A later `::test_name` in the
   same paragraph (a table row starts a new one) names the file of the last
   qualified cite. A `cli.rs::name` style cite of another file ends that run.
2. CONTRACT. `ContractName.test_name`: a .sol file under contracts/ declares
   `contract ContractName` and `function test_name(`.
3. BARE. A backticked `test_*`, `testFuzz_*`, `testFork_*` or `invariant_*`
   name: a .sol file under contracts/ declares that function, or, for a Rust,
   TypeScript, Python or shell test, the name is a word in a source file
   outside docs/.
4. LINE. `File.t.sol:N` names a test, so line N declares a function: a cite
   that moved fails. `File.t.sol:N-M` names a block, so the file has M lines.
A name that ends in `_` or `*` (`test_FEE2_*`) is a prefix: one declared
function must start with it. A run that reads zero citations fails.

Records are not read: dated review artifacts (docs/code-review/), the archive
(docs/archive/), decision records (docs/adr/: an ADR names the tests its
implementation will add), dated product proposals (docs/product/), the QA plan
(it quotes file:line cites as its work list), and the build spec and research
note written against the rejected ADR-0010 design
(docs/technical/unified-vault-spec.md,
docs/technical/base-tokenized-stocks-research.md).

`--self-test` builds a throwaway tree, plants each defect (a removed test behind
a file, a contract and a bare name, the core 1778 case, a missing test file, a
continuation that names a test of another file, a prefix nothing matches, a
line cite that moved, a range past the end of the file) and expects the gate to
fire; it also expects a compliant tree, a Rust test cited bare, a workflow
`::warning`, and planted defects in the records, to pass. Set CHECK_REPO_ROOT to
run the real check against another tree.

Wired into .github/workflows/suite-13-doc-checks.yml (docs/development/ci-suites.md section 13).
"""
from __future__ import annotations

import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

DOCS_ROOT = Path("docs")
SOURCE_ROOT = Path("contracts")
RECORDS = (
    Path("docs/code-review"),
    Path("docs/archive"),
    Path("docs/adr"),
    Path("docs/product"),
    Path("docs/development/qa-plan-v1.md"),
    Path("docs/technical/unified-vault-spec.md"),
    Path("docs/technical/base-tokenized-stocks-research.md"),
)

# Rule 3 fallback: where a bare non-Solidity test name may live.
CODE_SUFFIXES = {".rs", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".sh"}
SKIP_DIRS = {".git", "node_modules", "target", "dist", "out", "cache", "broadcast", "coverage"}
TOP_SKIP = {"docs", "lib"}  # docs/ cites, the top-level lib/ is vendored forge dependencies

TEST_NAME = r"(?:test|testFuzz|testFork|invariant)_\w*"
TOKEN = re.compile(
    r"(?P<qual>(?:[\w.-]+/)*(?P<qfile>[A-Za-z]\w*\.t\.sol)::(?P<qname>\w+)(?P<qstar>\*)?)"
    r"|(?P<other>[\w.-]+\.[A-Za-z]+::\w+)"
    r"|(?P<cont>(?<![\w.:])::(?P<cname>" + TEST_NAME + r")(?P<cstar>\*)?)"
    r"|(?P<line>(?P<lpath>(?:[\w.-]+/)*)(?P<lfile>[A-Za-z]\w*\.t\.sol):(?P<lstart>\d+)(?:-(?P<lend>\d+))?)"
    r"|(?P<ctr>\b(?P<tcontract>[A-Z]\w*)\.(?P<tname>" + TEST_NAME + r")(?P<tstar>\*)?)"
    r"|(?P<bare>`(?P<bname>" + TEST_NAME + r")(?P<bstar>\*)?(?:\(\))?`)"
)
DECL_FN = re.compile(r"\bfunction\s+(\w+)\s*\(")
DECL_CONTRACT = re.compile(r"\b(?:abstract\s+)?contract\s+(\w+)")
FN_LINE = re.compile(r"^\s*function\s+\w+\s*\(")


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


class Source:
    """The Solidity declarations under contracts/, and a lazy word search over the other code."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.by_name: dict[str, list[tuple[Path, str]]] = {}
        self.functions: set[str] = set()
        self.contract_files: dict[str, list[str]] = {}
        self._code: list[str] | None = None
        src = root / SOURCE_ROOT
        if not src.is_dir():
            return
        for path in sorted(src.rglob("*.sol")):
            if SKIP_DIRS & set(path.relative_to(root).parts):
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            self.by_name.setdefault(path.name, []).append((path.relative_to(root), text))
            self.functions.update(DECL_FN.findall(text))
            for name in DECL_CONTRACT.findall(text):
                self.contract_files.setdefault(name, []).append(text)

    @staticmethod
    def declares(text: str, name: str, prefix: bool) -> bool:
        if name[:1].isupper() and not prefix:
            return name in DECL_CONTRACT.findall(text)
        names = DECL_FN.findall(text)
        return any(n.startswith(name) for n in names) if prefix else name in names

    def code_mentions(self, name: str) -> bool:
        if self._code is None:
            me = Path(__file__).resolve()
            self._code = []
            for dirpath, dirnames, filenames in os.walk(self.root):
                here = Path(dirpath)
                top = here == self.root
                dirnames[:] = [
                    d for d in dirnames
                    if d not in SKIP_DIRS and not (top and (d in TOP_SKIP or d == SOURCE_ROOT.name))
                ]
                for fname in filenames:
                    path = here / fname
                    if path.suffix not in CODE_SUFFIXES or path.resolve() == me:
                        continue
                    try:
                        self._code.append(path.read_text(encoding="utf-8"))
                    except (UnicodeDecodeError, OSError):
                        continue
        word = re.compile(rf"\b{re.escape(name)}\b")
        return any(word.search(text) for text in self._code)


def is_prefix(name: str, star: str | None) -> bool:
    return bool(star) or name.endswith("_")


def check_bare(src: Source, name: str, prefix: bool) -> str | None:
    if prefix:
        if any(f.startswith(name) for f in src.functions):
            return None
        return "no function under contracts/ starts with it"
    if name in src.functions or src.code_mentions(name):
        return None
    return "no .sol file under contracts/ declares it and no source file outside docs/ names it"


def check_doc(root: Path, src: Source, path: Path, errors: list[str]) -> int:
    rel = path.relative_to(root)
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return 0
    seen = 0
    last_file: str | None = None
    for lineno, raw in enumerate(text.splitlines(), start=1):
        if not raw.strip() or raw.lstrip().startswith("|"):
            last_file = None  # a blank line ends a paragraph, a table row starts one
        for m in TOKEN.finditer(raw):
            where = f"{rel}:{lineno}: cites `{m.group(0).strip('`')}`"
            if m.group("other"):
                last_file = None
                continue
            seen += 1
            if m.group("qual"):
                fname, name = m.group("qfile"), m.group("qname")
                last_file = fname
                files = src.by_name.get(fname)
                if not files:
                    errors.append(f"{where}, but no {fname} exists under contracts/")
                elif not any(Source.declares(t, name, is_prefix(name, m.group("qstar"))) for _, t in files):
                    errors.append(f"{where}, but {fname} declares no such test")
            elif m.group("cont"):
                name, prefix = m.group("cname"), is_prefix(m.group("cname"), m.group("cstar"))
                if last_file is None:
                    reason = check_bare(src, name, prefix)
                    if reason:
                        errors.append(f"{where}, but {reason}")
                elif not any(Source.declares(t, name, prefix) for _, t in src.by_name.get(last_file, [])):
                    errors.append(f"{where}, but {last_file} (the file the cite continues) declares no such test")
            elif m.group("line"):
                fname = m.group("lfile")
                want = (m.group("lpath") or "") + fname
                files = src.by_name.get(fname, [])
                exact = [t for p, t in files if p.as_posix().endswith(want)]
                texts = exact or [t for _, t in files]
                if not texts:
                    errors.append(f"{where}, but no {fname} exists under contracts/")
                    continue
                start = int(m.group("lstart"))
                end = int(m.group("lend")) if m.group("lend") else None
                if end is None:
                    ok = any(0 < start <= len(t.splitlines()) and FN_LINE.match(t.splitlines()[start - 1]) for t in texts)
                    if not ok:
                        errors.append(f"{where}, but line {start} of {fname} declares no function (cite the test's own line, or a range)")
                else:
                    ok = any(0 < start <= end <= len(t.splitlines()) for t in texts)
                    if not ok:
                        errors.append(f"{where}, but {fname} has no lines {start}-{end}")
            elif m.group("ctr"):
                contract, name = m.group("tcontract"), m.group("tname")
                prefix = is_prefix(name, m.group("tstar"))
                texts = src.contract_files.get(contract)
                if not texts:
                    errors.append(f"{where}, but no contract {contract} exists under contracts/")
                elif not any(Source.declares(t, name, prefix) for t in texts):
                    errors.append(f"{where}, but the file of {contract} declares no such test")
            elif m.group("bare"):
                reason = check_bare(src, m.group("bname"), is_prefix(m.group("bname"), m.group("bstar")))
                if reason:
                    errors.append(f"{where}, but {reason}")
    return seen


def run(root: Path) -> tuple[list[str], int]:
    errors: list[str] = []
    src = Source(root)
    if not src.by_name:
        errors.append(f"no .sol file under {SOURCE_ROOT}/ (wrong root?)")
        return errors, 0
    seen = sum(check_doc(root, src, path, errors) for path in doc_files(root))
    if seen == 0:
        errors.append("read zero test citations under docs/ (wrong root, or the citation pattern broke)")
    return errors, seen


# ── self-test ────────────────────────────────────────────────────────────────

FOO = (
    "// SPDX-License-Identifier: MIT\n"  # 1
    "pragma solidity ^0.8.24;\n"  # 2
    "contract FooTest {\n"  # 3
    "    function test_a() public {}\n"  # 4
    "    function test_b() public {}\n"  # 5
    "    function testFuzz_c(uint256 x) public {}\n"  # 6
    "    function test_FEE2_onRealized() public {}\n"  # 7
    "}\n"  # 8
)
BAR = "contract BarTest {\n    function test_onlyInBar() public {}\n}\n"
RUST = "#[test]\nfn test_rust_case() {}\n"
COMPLIANT_DOC = (
    "# Doc\n\n"
    "> HOLDS · `FooTest.t.sol::test_a`, `::test_b`, `::testFuzz_c`; `FooTest.t.sol::test_FEE2_*`.\n\n"
    "The fork case is `FooTest.test_a` at `contracts/test/FooTest.t.sol:4`, in [FooTest.t.sol:3-8](x).\n\n"
    "A contract cite `fv/BarTest.t.sol::BarTest`, then `BarTest.t.sol::test_onlyInBar`, `::test_onlyInBar`.\n\n"
    "The rmpc case `test_rust_case` runs in Rust. The bare Solidity name is `test_b`.\n\n"
    "`FooTest.t.sol::test_a`; the CLI cite `cli.rs::run`, then `::test_rust_case`.\n\n"
    "`FooTest.t.sol::test_a` then a workflow `::warning::` line.\n\n"
    "| `FooTest.t.sol::test_a` | row one |\n| `::test_onlyInBar` | a new row reads the bare name |\n"
)
DOC = Path("docs/technical/doc.md")


def _write_tree(root: Path) -> None:
    if (root / "docs").exists():
        shutil.rmtree(root / "docs")
    for rel, body in (
        (Path("contracts/test/FooTest.t.sol"), FOO),
        (Path("contracts/test/fv/BarTest.t.sol"), BAR),
        (Path("clients/rust-payment-client/tests/case.rs"), RUST),
        (DOC, COMPLIANT_DOC),
    ):
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(body, encoding="utf-8")


def _plant(root: Path, rel: Path, body: str) -> None:
    (root / rel).parent.mkdir(parents=True, exist_ok=True)
    (root / rel).write_text(body, encoding="utf-8")


def self_test() -> int:
    cases = 0
    failures = 0

    def expect(name: str, root: Path, want_fail: bool, needle: str = "") -> None:
        nonlocal cases, failures
        cases += 1
        errors, _ = run(root)
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
        cases += 1
        errors, seen = run(root)
        if seen < 17:
            failures += 1
            print(f"SELF-TEST FAIL: the compliant citations were not all read (seen={seen})", file=sys.stderr)
        else:
            print(f"ok: the compliant citations are read ({seen})")

        other = Path("docs/technical/other.md")
        for name, body, needle in (
            ("removed test behind a file", "`FooTest.t.sol::test_gone`", "declares no such test"),
            ("missing test file", "`GoneTest.t.sol::test_a`", "no GoneTest.t.sol"),
            ("continuation naming another file's test", "`FooTest.t.sol::test_a`, `::test_onlyInBar`", "the file the cite continues"),
            ("continuation naming a removed test", "`FooTest.t.sol::test_a`, `::test_gone`", "the file the cite continues"),
            ("core 1778: removed contract-qualified test",
             "`BasketVaultLivePositionForkTest.test_fork_liveRmprotoPosition_core1778` records these numbers.",
             "no contract BasketVaultLivePositionForkTest"),
            ("contract-qualified test of another contract", "`FooTest.test_onlyInBar`", "declares no such test"),
            ("removed bare test", "The case is `test_gone`.", "no .sol file"),
            ("prefix nothing matches", "`FooTest.t.sol::test_zzz_*`", "declares no such test"),
            ("bare prefix nothing matches", "`test_zzz_*`", "starts with it"),
            ("line cite that moved", "`contracts/test/FooTest.t.sol:5`, then `FooTest.t.sol:2`", "line 2 of FooTest.t.sol"),
            ("line cite of a missing file", "`GoneTest.t.sol:4`", "no GoneTest.t.sol"),
            ("range past the end of the file", "[FooTest.t.sol:3-80](x)", "no lines 3-80"),
            ("contract cite that does not exist", "`FooTest.t.sol::GoneTest`", "declares no such test"),
        ):
            _write_tree(root)
            _plant(root, other, f"# Other\n\n{body}\n")
            expect(f"{name} fails", root, want_fail=True, needle=needle)

        _write_tree(root)
        _plant(root, other, "# Other\n\n`FooTest.t.sol::test_a` and\n`::test_b` wrap over a line.\n")
        expect("continuation wrapped over a line passes", root, want_fail=False)

        for record in (
            Path("docs/code-review/20261014-review.md"),
            Path("docs/archive/old.md"),
            Path("docs/adr/ADR-9999-upcoming.md"),
            Path("docs/product/20260101-proposal.md"),
            Path("docs/development/qa-plan-v1.md"),
            Path("docs/technical/unified-vault-spec.md"),
            Path("docs/technical/base-tokenized-stocks-research.md"),
        ):
            _write_tree(root)
            _plant(root, record, "`GoneTest.t.sol::test_gone`, `GoneForkTest.test_gone`, `test_gone`, `FooTest.t.sol:2`\n")
            expect(f"{record} is a record and passes", root, want_fail=False)

        _write_tree(root)
        _plant(root, DOC, "# Doc\n\nNo citations here.\n")
        expect("zero citations read fails", root, want_fail=True, needle="zero test citations")

    print(f"self-test: {cases - failures}/{cases} cases ok")
    return 1 if failures else 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()
    root = repo_root()
    errors, seen = run(root)
    for e in errors:
        print(f"ERROR: {e}", file=sys.stderr)
    if errors:
        print(f"check_doc_test_citations: {len(errors)} citation(s) name no test. Fix the doc or the test.", file=sys.stderr)
        return 1
    print(f"check_doc_test_citations: ok ({seen} test citations under docs/ resolve)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
