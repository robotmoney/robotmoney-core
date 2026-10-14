#!/usr/bin/env python3
"""Fail when an executed-test floor differs from the number of tests its call selects.

WHY THIS EXISTS (QA plan v1 T5, follow-up of issues 1643 and 1656)
------------------------------------------------------------------
`cargo test` and `forge test` exit 0 when nothing ran. The workflows therefore run them through
.github/scripts/cargo_test_require_executed.sh and forge_test_require_executed.sh, which fail
below a floor (CARGO_TEST_MIN_EXECUTED, FORGE_TEST_MIN_EXECUTED). A floor protects only what it
counts. The 2026-10-14 review found most suite 8 calls on the default floor of 1 (seven read-path
targets, 49 tests, green with one passing), suite 22 running bare `forge test`, and suite 5's lib
step and Base testnet step on a floor of 1 that the devnet leg met alone. A floor of 1 catches a
filter that matches nothing. It does not catch a test that stopped running.

So in the checked workflows every call of either guard must:
- name its floor: on the command, in the step, job or workflow env, or as a matrix value. The
  default floor of 1 is refused.
- set the floor to the number of tests the call selects, counted from the source. One test fewer
  in a green run is then red. Adding or removing a test means editing the floor in the same change.
And the checked workflows may not run `forge test` outside its guard, nor a bare `cargo test`
that runs tests, unless the run block carries `# bare-cargo-test-allowed:` (a step that expects
cargo test to FAIL; see check_no_bare_cargo_test.py).

HOW TESTS ARE COUNTED
---------------------
cargo: `#[test]` and `#[tokio::test]` functions in the targets the call names (`--lib`,
`--bin NAME`, `--test NAME`), following `mod x;` into its file. `#[ignore]` tests do not run and
are not counted. Comments, string literals and `macro_rules!` bodies are skipped, so a `#[test]`
inside a macro definition or a doc example is not a test. A `parameterized_e2e!(name, ...)` call
(testing/fork-e2e-rust) makes two tests, `name::robot_money_devnet` and `name::base_testnet`.
The libtest arguments after `--` apply as libtest applies them: a positional filter keeps names
that contain it, `--skip` drops names that contain it, and `--exact` turns both into whole-name
matches.
forge: public or external `test*`, `invariant*` and `statefulFuzz*` functions of every
non-abstract contract, inherited ones included, that `--match-path`, `--match-contract` and
`--match-test` (and their `--no-match-*` forms) select. A test whose body calls `vm.skip(true` or
a `_skip*` helper is skipped, and a skipped test is not a passed test, so it is not counted.

A call this script cannot count (an unknown flag, a shell variable, a target that does not exist)
is a failure, not a pass: an uncounted floor is an unchecked floor.

The count is static. A test that returns early still passes, and no floor can see that. The
skip refusals under CI (issues 1643 and 1656, QA plan v1 T5) cover that half.

USAGE
    python3 .github/scripts/check_executed_floors.py [--repo-root DIR] [--list] [WORKFLOW ...]

WORKFLOW is a path to a workflow file. It defaults to suites 5, 8 and 22 under
<repo-root>/.github/workflows. Exit 0 when every floor equals its count, 1 when one does not,
2 on a usage error.
Self-test: .github/scripts/tests/test_check_executed_floors.sh
"""

from __future__ import annotations

import argparse
import os
import re
import shlex
import sys
from pathlib import Path

try:
    import tomllib
except ImportError:  # pragma: no cover - Python < 3.11
    sys.stderr.write("ERROR: Python 3.11 or newer is required (tomllib)\n")
    raise SystemExit(2)

try:
    import yaml
except ImportError:  # pragma: no cover - CI has pyyaml
    sys.stderr.write("ERROR: PyYAML is required (pip install pyyaml)\n")
    raise SystemExit(2)

DEFAULT_WORKFLOWS = (
    "suite-05-fork-integration.yml",
    "suite-08-explorer-indexer.yml",
    "suite-22-formal-verification.yml",
)
# Guard script basename -> the env var that holds its floor.
GUARDS = {
    "cargo_test_require_executed.sh": "CARGO_TEST_MIN_EXECUTED",
    "forge_test_require_executed.sh": "FORGE_TEST_MIN_EXECUTED",
}
MATRIX_REF = re.compile(r"\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}")
BARE_ALLOWED = re.compile(r"^\s*#+\s*bare-cargo-test-allowed:", re.M)
ASSIGNMENT = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
SHELL_OPERATORS = {"&&", "||", ";", "|", "&", "(", ")"}
# parameterized_e2e! (testing/fork-e2e-rust/src/lib.rs) makes one test per network.
PARAMETERIZED_LEGS = ("robot_money_devnet", "base_testnet")

CARGO_VALUE_FLAGS = {
    "-p", "--package", "--manifest-path", "--test", "--bin", "--features", "-F",
    "-j", "--jobs", "--target", "--profile", "--target-dir", "--color",
}
CARGO_PLAIN_FLAGS = {
    "--lib", "--release", "--all-features", "--no-default-features", "--locked", "--frozen",
    "--offline", "-q", "--quiet", "-v", "--verbose", "--no-fail-fast",
}
LIBTEST_VALUE_FLAGS = {"--skip", "--test-threads", "--color", "--format", "--logfile"}
LIBTEST_PLAIN_FLAGS = {
    "--nocapture", "--exact", "--include-ignored", "--ignored", "-q", "--quiet",
    "--show-output", "--test",
}
FORGE_FILTER_FLAGS = {
    "--match-path": "mp", "--mp": "mp",
    "--match-contract": "mc", "--mc": "mc",
    "--match-test": "mt", "--mt": "mt",
    "--no-match-path": "nmp", "--nmp": "nmp",
    "--no-match-contract": "nmc", "--nmc": "nmc",
    "--no-match-test": "nmt", "--nmt": "nmt",
}
FORGE_PLAIN_FLAGS = {"--gas-report", "--summary", "--detailed", "--ffi", "--offline"}
FORGE_VERBOSITY = re.compile(r"^-v{1,5}$")


class Unresolved(Exception):
    """A call this script cannot count. Reported as a failure."""


# ── Rust ──────────────────────────────────────────────────────────────────────

_RAW_STR = re.compile(r'(?:b|c)?r(#*)"')
_CHAR_LIT = re.compile(r"'(?:\\(?:u\{[0-9a-fA-F]*\}|x[0-9a-fA-F]{2}|.)|[^\\'\n])'")


def strip_rust(text: str) -> str:
    """Blank out comments, string literals and char literals.

    A brace inside a string (a JSON fixture in a raw string) or a comment would otherwise move the
    module depth, and a `#[test]` in a doc example would count as a test.
    """
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j == -1 else j
            continue
        if text.startswith("/*", i):
            depth, j = 1, i + 2
            while j < n and depth:
                if text.startswith("/*", j):
                    depth, j = depth + 1, j + 2
                elif text.startswith("*/", j):
                    depth, j = depth - 1, j + 2
                else:
                    j += 1
            out.append(" ")
            i = j
            continue
        prev = text[i - 1] if i else " "
        m = _RAW_STR.match(text, i)
        if m and not (prev.isalnum() or prev == "_"):
            close = '"' + m.group(1)
            j = text.find(close, m.end())
            i = n if j == -1 else j + len(close)
            out.append('""')
            continue
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append('""')
            i = j + 1
            continue
        if c == "'":
            m = _CHAR_LIT.match(text, i)
            if m:
                out.append("''")
                i = m.end()
                continue
        out.append(c)
        i += 1
    return "".join(out)


_RUST_TOKEN = re.compile(
    r"(?P<macro_rules>\bmacro_rules!\s*\w+\s*(?P<macro_open>[({\[]))"
    r"|(?P<param>\bparameterized_e2e!\s*\(\s*(?P<param_name>\w+))"
    r"|(?P<mod>\bmod\s+(?P<mod_name>\w+)\s*(?P<mod_end>[{;]))"
    r"|(?P<attr>#\s*\[\s*(?P<attr_name>tokio::test|test|ignore)\b[^\]]*\])"
    r"|(?P<fn>\bfn\s+(?P<fn_name>\w+))"
    r"|(?P<open>\{)|(?P<close>\})"
)
_CLOSERS = {"(": ")", "{": "}", "[": "]"}


def _matching(text: str, start: int, opener: str) -> int:
    """Index just past the bracket that closes the `opener` at `start`."""
    closer, depth = _CLOSERS[opener], 0
    for j in range(start, len(text)):
        if text[j] == opener:
            depth += 1
        elif text[j] == closer:
            depth -= 1
            if depth == 0:
                return j + 1
    return len(text)


def rust_tests(path: Path, prefix: tuple[str, ...], mod_dir: Path, seen: set[Path]) -> list[tuple[str, bool]]:
    """(test path, ignored) for every test in `path` and the files its `mod x;` items pull in."""
    if path in seen:
        return []
    seen.add(path)
    text = strip_rust(path.read_text(encoding="utf-8"))
    found: list[tuple[str, bool]] = []
    stack: list[tuple[str, int]] = []  # inline modules: (name, depth outside it)
    depth = 0
    pending_test = pending_ignore = False
    pos = 0
    while True:
        m = _RUST_TOKEN.search(text, pos)
        if not m:
            break
        pos = m.end()
        here = prefix + tuple(name for name, _ in stack)
        if m.group("macro_rules"):
            pos = _matching(text, m.start("macro_open"), m.group("macro_open"))
        elif m.group("param"):
            found += [("::".join(here + (m.group("param_name"), leg)), False) for leg in PARAMETERIZED_LEGS]
        elif m.group("mod"):
            name = m.group("mod_name")
            if m.group("mod_end") == "{":
                stack.append((name, depth))
                depth += 1
            else:
                child_dir = mod_dir.joinpath(*(n for n, _ in stack))
                for cand in (child_dir / f"{name}.rs", child_dir / name / "mod.rs"):
                    if cand.is_file():
                        nested = cand.parent if cand.name == "mod.rs" else cand.parent / cand.stem
                        found += rust_tests(cand, here + (name,), nested, seen)
                        break
                else:
                    raise Unresolved(f"{path}: `mod {name};` names no file")
        elif m.group("attr"):
            if m.group("attr_name") == "ignore":
                pending_ignore = True
            else:
                pending_test = True
        elif m.group("fn"):
            if pending_test:
                found.append(("::".join(here + (m.group("fn_name"),)), pending_ignore))
            pending_test = pending_ignore = False
        elif m.group("open"):
            depth += 1
        elif m.group("close"):
            depth -= 1
            while stack and stack[-1][1] == depth:
                stack.pop()
    return found


def load_packages(root: Path) -> dict[str, Path]:
    """Workspace package name -> package directory."""
    manifest = tomllib.loads((root / "Cargo.toml").read_text(encoding="utf-8"))
    members = manifest.get("workspace", {}).get("members", [])
    packages: dict[str, Path] = {}
    for raw in members:
        for member in sorted(root.glob(raw)) if "*" in raw else [root / raw]:
            toml = member / "Cargo.toml"
            if toml.is_file():
                name = tomllib.loads(toml.read_text(encoding="utf-8")).get("package", {}).get("name")
                if name:
                    packages[name] = member
    return packages


def package_targets(pkg_dir: Path) -> tuple[Path | None, dict[str, Path], dict[str, Path]]:
    """(lib root, bin name -> root, test name -> root) for one package, auto-discovery included."""
    manifest = tomllib.loads((pkg_dir / "Cargo.toml").read_text(encoding="utf-8"))
    pkg_name = manifest.get("package", {}).get("name", pkg_dir.name)
    lib = pkg_dir / manifest.get("lib", {}).get("path", "src/lib.rs")
    bins: dict[str, Path] = {}
    if (pkg_dir / "src/main.rs").is_file():
        bins[pkg_name] = pkg_dir / "src/main.rs"
    for f in sorted((pkg_dir / "src/bin").glob("*.rs")):
        bins[f.stem] = f
    for b in manifest.get("bin", []):
        bins[b["name"]] = pkg_dir / b.get("path", f"src/bin/{b['name']}.rs")
    tests: dict[str, Path] = {f.stem: f for f in sorted((pkg_dir / "tests").glob("*.rs"))}
    for t in manifest.get("test", []):
        tests[t["name"]] = pkg_dir / t.get("path", f"tests/{t['name']}.rs")
    return (lib if lib.is_file() else None), bins, tests


def _flag_value(args: list[str], i: int, flag: str) -> tuple[str, int]:
    """Value of the flag at args[i] (`--flag value` or `--flag=value`) and the next index."""
    tok = args[i]
    if "=" in tok and tok.startswith("--"):
        return tok.split("=", 1)[1], i + 1
    if i + 1 >= len(args):
        raise Unresolved(f"{flag} has no value")
    return args[i + 1], i + 2


def count_cargo(args: list[str], workdir: Path, root: Path, packages: dict[str, Path]) -> tuple[int, str]:
    """Number of tests a `cargo test` call with `args` runs, and a short description."""
    if "--" in args:
        cut = args.index("--")
        cargo_args, libtest_args = args[:cut], args[cut + 1 :]
    else:
        cargo_args, libtest_args = args, []
    pkg_dir: Path | None = None
    targets: list[tuple[str, Path]] = []
    want: list[tuple[str, str]] = []  # (kind, name) resolved once the package is known
    i = 0
    while i < len(cargo_args):
        tok = cargo_args[i]
        flag = tok.split("=", 1)[0] if tok.startswith("--") else tok
        if flag in CARGO_VALUE_FLAGS:
            value, i = _flag_value(cargo_args, i, flag)
            if flag in ("-p", "--package"):
                if value not in packages:
                    raise Unresolved(f"-p {value}: no such workspace package")
                pkg_dir = packages[value]
            elif flag == "--manifest-path":
                pkg_dir = (workdir / value).resolve().parent
            elif flag == "--test":
                want.append(("test", value))
            elif flag == "--bin":
                want.append(("bin", value))
            continue
        if flag in CARGO_PLAIN_FLAGS:
            if flag == "--lib":
                want.append(("lib", ""))
            i += 1
            continue
        if tok.startswith("-"):
            raise Unresolved(f"cargo flag {tok} is not one this script can count (name the targets with --lib, --bin or --test)")
        # A positional before `--` is a test-name filter, as after it.
        libtest_args = [tok] + libtest_args
        i += 1
    if pkg_dir is None:
        if (workdir / "Cargo.toml").is_file() and "package" in tomllib.loads((workdir / "Cargo.toml").read_text(encoding="utf-8")):
            pkg_dir = workdir
        else:
            raise Unresolved(f"no package: pass -p or --manifest-path, or run from a package directory (working directory {workdir})")
    if not want:
        raise Unresolved("the call names no target: add --lib, --bin NAME or --test NAME")
    lib, bins, tests = package_targets(pkg_dir)
    for kind, name in want:
        if kind == "lib":
            if lib is None:
                raise Unresolved(f"{pkg_dir.relative_to(root)} has no lib target")
            targets.append(("lib", lib))
        elif kind == "bin":
            if name not in bins:
                raise Unresolved(f"--bin {name}: no such target in {pkg_dir.relative_to(root)}")
            targets.append((f"bin {name}", bins[name]))
        else:
            if name not in tests or not tests[name].is_file():
                raise Unresolved(f"--test {name}: no such target in {pkg_dir.relative_to(root)}")
            targets.append((f"test {name}", tests[name]))

    filters: list[str] = []
    skips: list[str] = []
    exact = ignored_only = include_ignored = False
    i = 0
    while i < len(libtest_args):
        tok = libtest_args[i]
        flag = tok.split("=", 1)[0] if tok.startswith("--") else tok
        if flag in LIBTEST_VALUE_FLAGS:
            value, i = _flag_value(libtest_args, i, flag)
            if flag == "--skip":
                skips.append(value)
            continue
        if flag in LIBTEST_PLAIN_FLAGS:
            exact = exact or flag == "--exact"
            ignored_only = ignored_only or flag == "--ignored"
            include_ignored = include_ignored or flag == "--include-ignored"
            i += 1
            continue
        if tok.startswith("-"):
            raise Unresolved(f"libtest flag {tok} is not one this script can count")
        filters.append(tok)
        i += 1

    def hit(name: str, pattern: str) -> bool:
        return name == pattern if exact else pattern in name

    total = 0
    for _, root_file in targets:
        for name, ignored in rust_tests(root_file, (), root_file.parent, set()):
            if ignored_only and not ignored:
                continue
            if ignored and not (ignored_only or include_ignored):
                continue
            if filters and not any(hit(name, f) for f in filters):
                continue
            if any(hit(name, s) for s in skips):
                continue
            total += 1
    rel = pkg_dir.relative_to(root)
    desc = f"{rel}: " + ", ".join(k for k, _ in targets)
    if filters:
        desc += f"; filters {' '.join(filters)}"
    if skips:
        desc += f"; --skip {' '.join(skips)}"
    return total, desc


# ── Solidity ──────────────────────────────────────────────────────────────────


def strip_solidity(text: str) -> str:
    """Blank out comments and string literals."""
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        if text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j == -1 else j
            continue
        if text.startswith("/*", i):
            j = text.find("*/", i + 2)
            i = n if j == -1 else j + 2
            out.append(" ")
            continue
        c = text[i]
        if c in "\"'":
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if text[j] == "\\" else 1
            out.append(c + c)
            i = j + 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


_SOL_CONTRACT = re.compile(r"\b(abstract\s+)?(contract|interface|library)\s+(\w+)([^{;]*)\{")
_SOL_FUNCTION = re.compile(r"\bfunction\s+(\w+)\s*\(")
_SOL_TEST_NAME = re.compile(r"^(test|invariant|statefulFuzz)")
_SOL_SKIP = re.compile(r"\bvm\s*\.\s*skip\s*\(\s*true\b|\b_skip\w*\s*\(")
_SOL_SKIP_ANY = re.compile(r"\bvm\s*\.\s*skip\s*\(")


class SolContract:
    def __init__(self, name: str, path: str, abstract: bool, bases: list[str], tests: dict[str, bool]):
        self.name, self.path, self.abstract, self.bases, self.tests = name, path, abstract, bases, tests


def _split_bases(header: str) -> list[str]:
    header = header.strip()
    if not header.startswith("is"):
        return []
    parts, depth, cur = [], 0, ""
    for ch in header[2:]:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    return [re.match(r"\s*([\w.]+)", p).group(1).split(".")[-1] for p in parts if p.strip()]


def sol_contracts(path: Path, rel: str) -> list[SolContract]:
    text = strip_solidity(path.read_text(encoding="utf-8"))
    found = []
    for m in _SOL_CONTRACT.finditer(text):
        if m.group(2) != "contract":
            continue
        body_end = _matching(text, m.end() - 1, "{")
        body = text[m.end() : body_end - 1]
        tests: dict[str, bool] = {}
        depth_at = 0
        for f in _SOL_FUNCTION.finditer(body):
            # Only functions declared directly in this contract (not in a nested construct).
            depth_at = body.count("{", 0, f.start()) - body.count("}", 0, f.start())
            if depth_at != 0 or not _SOL_TEST_NAME.match(f.group(1)):
                continue
            sig_end = min((k for k in (body.find("{", f.end()), body.find(";", f.end())) if k != -1), default=-1)
            if sig_end == -1:
                continue
            signature = body[f.end() : sig_end]
            if not re.search(r"\b(public|external)\b", signature):
                continue
            fbody = body[sig_end : _matching(body, sig_end, "{")] if body[sig_end] == "{" else ""
            if _SOL_SKIP_ANY.search(fbody) and not _SOL_SKIP.search(fbody):
                raise Unresolved(f"{rel}: {m.group(3)}.{f.group(1)} calls vm.skip with a condition; this script cannot tell whether it skips")
            tests[f.group(1)] = bool(_SOL_SKIP.search(fbody))
        found.append(SolContract(m.group(3), rel, bool(m.group(1)), _split_bases(m.group(4)), tests))
    return found


def _glob_regex(glob: str) -> re.Pattern[str]:
    """forge's --match-path glob (globset, `*` crosses `/`) as a regex over the root-relative path."""
    out, i = "", 0
    glob = glob[2:] if glob.startswith("./") else glob
    while i < len(glob):
        c = glob[i]
        if glob.startswith("**", i):
            out, i = out + ".*", i + 2
        elif c == "*":
            out, i = out + ".*", i + 1
        elif c == "?":
            out, i = out + ".", i + 1
        elif c == "{":
            j = glob.find("}", i)
            out, i = out + "(?:" + "|".join(re.escape(p) for p in glob[i + 1 : j].split(",")) + ")", j + 1
        else:
            out, i = out + re.escape(c), i + 1
    return re.compile("^" + out + "$")


def forge_source_dirs(root: Path) -> list[Path]:
    """The project's src, test and script dirs from foundry.toml, each scanned once."""
    cfg = tomllib.loads((root / "foundry.toml").read_text(encoding="utf-8")).get("profile", {}).get("default", {})
    dirs = []
    for key, default in (("src", "src"), ("test", "test"), ("script", "script")):
        d = (root / cfg.get(key, default)).resolve()
        if d.is_dir() and d not in dirs:
            dirs.append(d)
    return [d for d in dirs if not any(o in d.parents for o in dirs)]


def count_forge(args: list[str], root: Path, cache: dict) -> tuple[int, str]:
    filters: dict[str, str] = {}
    i = 0
    while i < len(args):
        tok = args[i]
        flag = tok.split("=", 1)[0] if tok.startswith("--") else tok
        if flag in FORGE_FILTER_FLAGS:
            value, i = _flag_value(args, i, flag)
            filters[FORGE_FILTER_FLAGS[flag]] = value
            continue
        if flag in FORGE_PLAIN_FLAGS or FORGE_VERBOSITY.match(tok):
            i += 1
            continue
        raise Unresolved(f"forge flag {tok} is not one this script can count")
    if "contracts" not in cache:
        contracts: list[SolContract] = []
        for d in forge_source_dirs(root):
            for f in sorted(d.rglob("*.sol")):
                contracts += sol_contracts(f, f.relative_to(root).as_posix())
        cache["contracts"] = contracts
    contracts = cache["contracts"]
    by_name: dict[str, list[SolContract]] = {}
    for c in contracts:
        by_name.setdefault(c.name, []).append(c)

    def all_tests(c: SolContract, seen: frozenset[int]) -> dict[str, bool]:
        """Test functions of `c`, inherited ones included (a contract's own definition wins)."""
        if id(c) in seen:
            return {}
        merged: dict[str, bool] = {}
        for base in c.bases:
            found = [t for t in (all_tests(b, seen | {id(c)}) for b in by_name.get(base, [])) if t]
            if len(found) > 1:
                raise Unresolved(f"{c.path}: base contract {base} is defined in more than one file, each with tests")
            for t in found:
                merged.update(t)
        merged.update(c.tests)
        return merged

    mp = _glob_regex(filters["mp"]) if "mp" in filters else None
    nmp = _glob_regex(filters["nmp"]) if "nmp" in filters else None
    total, picked = 0, []
    for c in contracts:
        if c.abstract:
            continue
        if mp and not mp.match(c.path):
            continue
        if nmp and nmp.match(c.path):
            continue
        if "mc" in filters and not re.search(filters["mc"], c.name):
            continue
        if "nmc" in filters and re.search(filters["nmc"], c.name):
            continue
        tests = all_tests(c, frozenset())
        run = [
            t for t, skipped in tests.items()
            if not skipped
            and ("mt" not in filters or re.search(filters["mt"], t))
            and ("nmt" not in filters or not re.search(filters["nmt"], t))
        ]
        if run:
            picked.append(f"{c.name} {len(run)}")
            total += len(run)
    desc = "forge " + " ".join(f"--{k} {v}" for k, v in filters.items()) + ": " + (", ".join(picked) or "nothing")
    return total, desc


# ── Workflows ─────────────────────────────────────────────────────────────────


def matrix_combinations(job: dict) -> list[dict[str, str]]:
    matrix = (job.get("strategy") or {}).get("matrix") or {}
    if not isinstance(matrix, dict):
        return [{}]
    axes = {k: v for k, v in matrix.items() if k not in ("include", "exclude") and isinstance(v, list)}
    combos: list[dict[str, str]] = [{}]
    for key, values in axes.items():
        combos = [dict(c, **{key: str(v)}) for c in combos for v in values]
    includes = [{k: str(v) for k, v in inc.items()} for inc in matrix.get("include") or [] if isinstance(inc, dict)]
    if axes:
        return combos + includes
    return includes or [{}]


def substitute(text: str, combo: dict[str, str]) -> str:
    return MATRIX_REF.sub(lambda m: combo.get(m.group(1), m.group(0)), text)


def logical_lines(script: str) -> list[str]:
    """Join backslash-continued lines and drop comment-only lines."""
    lines, cur = [], ""
    for raw in script.splitlines():
        text = raw.strip()
        if not cur and (not text or text.startswith("#")):
            continue
        cur += (" " if cur else "") + text.rstrip("\\").strip()
        if not raw.rstrip().endswith("\\"):
            lines.append(cur)
            cur = ""
    if cur:
        lines.append(cur)
    return lines


def segments(line: str) -> list[list[str]]:
    """Shell tokens of `line`, split into simple commands at `&&`, `||`, `;` and `|`."""
    lexer = shlex.shlex(line, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    try:
        tokens = list(lexer)
    except ValueError as e:
        raise Unresolved(f"cannot parse the shell line: {e}")
    out, cur = [], []
    for tok in tokens:
        if tok in SHELL_OPERATORS:
            if cur:
                out.append(cur)
            cur = []
        else:
            cur.append(tok)
    if cur:
        out.append(cur)
    return out


def check_workflow(wf: Path, root: Path, packages: dict[str, Path], cache: dict, listing: bool) -> list[str]:
    problems: list[str] = []
    doc = yaml.safe_load(wf.read_text(encoding="utf-8")) or {}
    wf_env = {k: str(v) for k, v in (doc.get("env") or {}).items()}
    for job_id, job in (doc.get("jobs") or {}).items():
        if not isinstance(job, dict) or "steps" not in job:
            continue
        job_env = {k: str(v) for k, v in (job.get("env") or {}).items()}
        job_wd = ((job.get("defaults") or {}).get("run") or {}).get("working-directory", ".")
        for step in job.get("steps") or []:
            run = step.get("run")
            if not isinstance(run, str):
                continue
            step_name = str(step.get("name") or run.splitlines()[0][:60])
            raw_env = {k: str(v) for k, v in (step.get("env") or {}).items()}
            wd_raw = str(step.get("working-directory", job_wd))
            uses_matrix = MATRIX_REF.search(run + " ".join(raw_env.values()) + wd_raw)
            done: set[tuple] = set()
            for combo in matrix_combinations(job) if uses_matrix else [{}]:
                script = substitute(run, combo)
                env = {**wf_env, **job_env, **{k: substitute(v, combo) for k, v in raw_env.items()}}
                workdir = (root / substitute(wd_raw, combo)).resolve()
                key = (script, tuple(sorted(env.items())), str(workdir))
                if key in done:
                    continue
                done.add(key)
                where = f"{wf.name}: job {job_id}, step \"{substitute(step_name, combo)}\""
                problems += check_script(script, env, workdir, root, packages, cache, where, listing)
    return problems


def check_script(script, env, workdir, root, packages, cache, where, listing) -> list[str]:
    problems: list[str] = []
    bare_allowed = bool(BARE_ALLOWED.search(script))
    for line in logical_lines(script):
        try:
            segs = segments(line)
        except Unresolved as e:
            if any(g in line for g in GUARDS) or re.search(r"\b(cargo|forge)\s+test\b", line):
                problems.append(f"{where}: {e}")
            continue
        for seg in segs:
            names = [os.path.basename(t) for t in seg]
            guard_at = next((k for k, nm in enumerate(names) if nm in GUARDS), None)
            if guard_at is None:
                for k in range(len(seg) - 1):
                    if names[k] == "forge" and seg[k + 1] == "test":
                        problems.append(f"{where}: runs `forge test` outside forge_test_require_executed.sh: {' '.join(seg)[:160]}")
                    if names[k] == "cargo" and seg[k + 1] == "test" and "--no-run" not in seg and not bare_allowed:
                        problems.append(f"{where}: runs a bare `cargo test` outside cargo_test_require_executed.sh: {' '.join(seg)[:160]}")
                continue
            guard = names[guard_at]
            var = GUARDS[guard]
            assigns = {}
            for tok in seg[:guard_at]:
                a = ASSIGNMENT.match(tok)
                if a:
                    assigns[a.group(1)] = a.group(2)
            args = seg[guard_at + 1 :]
            call = f"{guard} {' '.join(args)}"[:200]
            try:
                if any("$" in a for a in args):
                    raise Unresolved("an argument holds a shell variable or expression")
                raw_floor = assigns.get(var, env.get(var))
                if raw_floor is None:
                    raise Unresolved(f"names no floor; set {var} to the number of tests the call selects (the default of 1 is refused)")
                raw_floor = raw_floor.strip().strip('"').strip("'")
                if not raw_floor.isdigit():
                    raise Unresolved(f"{var}={raw_floor!r} is not a number")
                floor = int(raw_floor)
                if guard.startswith("cargo"):
                    counted, desc = count_cargo(args, workdir, root, packages)
                else:
                    counted, desc = count_forge(args, root, cache)
            except Unresolved as e:
                problems.append(f"{where}: {call}: {e}")
                continue
            if listing:
                print(f"{where}: {var}={floor}, counted {counted} ({desc})")
            if floor != counted:
                problems.append(
                    f"{where}: {var}={floor} but the call selects {counted} test(s) ({desc}). "
                    f"Set the floor to {counted}."
                )
    return problems


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo-root", type=Path, default=None)
    ap.add_argument("--list", action="store_true", help="print every call with its floor and count")
    ap.add_argument("workflows", nargs="*", type=Path)
    ns = ap.parse_args(argv)
    root = (ns.repo_root or Path(__file__).resolve().parents[2]).resolve()
    workflows = ns.workflows or [root / ".github/workflows" / w for w in DEFAULT_WORKFLOWS]
    missing = [str(w) for w in workflows if not w.is_file()]
    if missing:
        print(f"ERROR: no such workflow: {', '.join(missing)}", file=sys.stderr)
        return 2
    packages = load_packages(root) if (root / "Cargo.toml").is_file() else {}
    cache: dict = {}
    problems: list[str] = []
    for wf in workflows:
        problems += check_workflow(wf, root, packages, cache, ns.list)
    for p in problems:
        print(f"ERROR: {p}", file=sys.stderr)
    if problems:
        print(
            f"ERROR: {len(problems)} executed floor problem(s). Every guard call in these workflows "
            "names a floor equal to the number of tests it selects (QA plan v1 T5).",
            file=sys.stderr,
        )
        return 1
    print(f"ok: every executed floor equals its test count in {len(workflows)} workflow(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
