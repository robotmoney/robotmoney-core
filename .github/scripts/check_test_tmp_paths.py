#!/usr/bin/env python3
"""Fail when forge tests could share a scratch file (issue 1735).

Forge runs test contracts, and the tests in one contract, in parallel threads. A scratch file
whose name two tests share lets one test remove or rewrite the file the other reads. That was
the flake `vm.readFile: failed to open file "/tmp/1476-run-entrypoint-manifest-..."`.

Rules, over contracts/test/**/*.sol (vendor and helpers/TmpPaths.sol excluded):
  1. No string literal names a path under /tmp/ or a fixed file under /deployments/. Paths come
     from helpers/TmpPaths.sol (claimTmpPath or uniqueTmpPath).
  2. Every literal tag passed to claimTmpPath / uniqueTmpPath is used once in the whole tree.
  3. A uniqueTmpPath tag that is not a plain literal must contain `_prefix()`, the per-contract
     name (all test contracts share one address, so nothing else tells them apart).
  4. Every `_prefix()` return literal is used once in the whole tree.
  5. vm.removeFile / vm.removeDir are not called with a string literal.

USAGE: check_test_tmp_paths.py [test_dir]      (default: contracts/test)
Self-test: .github/scripts/tests/test_check_test_tmp_paths.sh
"""
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
test_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "contracts" / "test"

HELPER = "TmpPaths.sol"
LITERAL = re.compile(r'"([^"\n]*)"')
CALL = re.compile(r'\b(claimTmpPath|uniqueTmpPath)\s*\(\s*vm\s*,\s*([^;]*?)\)\s*;', re.S)
PREFIX = re.compile(r'function\s+_prefix\s*\(\)[^{]*\{\s*return\s+"([^"]*)"\s*;')
REMOVE_LIT = re.compile(r'\bvm\.remove(?:File|Dir)\s*\(\s*"')

problems = []
tags = defaultdict(list)
prefixes = defaultdict(list)


def strip_comments(src):
    src = re.sub(r'/\*.*?\*/', lambda m: "\n" * m.group(0).count("\n"), src, flags=re.S)
    return re.sub(r'//[^\n]*', '', src)


files = [
    f for f in sorted(test_dir.rglob("*.sol"))
    if "vendor" not in f.parts and f.name != HELPER
]
for f in files:
    raw = f.read_text()
    src = strip_comments(raw)
    rel = f.relative_to(test_dir) if f.is_relative_to(test_dir) else f
    for m in LITERAL.finditer(src):
        s = m.group(1)
        line = src.count("\n", 0, m.start()) + 1
        if "/tmp/" in s or s.startswith("/deployments/"):
            problems.append(f"{rel}:{line}: fixed scratch path {s!r}; use claimTmpPath or uniqueTmpPath")
    for m in REMOVE_LIT.finditer(src):
        line = src.count("\n", 0, m.start()) + 1
        problems.append(f"{rel}:{line}: removes a literal path; remove only a path you claimed")
    for m in CALL.finditer(src):
        fn, args = m.group(1), m.group(2).strip()
        line = src.count("\n", 0, m.start()) + 1
        plain = re.fullmatch(r'"([^"]*)"', args)
        if plain:
            tags[(fn, plain.group(1))].append(f"{rel}:{line}")
        elif fn == "uniqueTmpPath" and "_prefix()" not in args:
            problems.append(f"{rel}:{line}: uniqueTmpPath tag must be a unique literal or contain _prefix()")
        elif fn == "claimTmpPath" and not LITERAL.search(args):
            problems.append(f"{rel}:{line}: claimTmpPath tag needs a literal")
    for m in PREFIX.finditer(src):
        line = src.count("\n", 0, m.start()) + 1
        prefixes[m.group(1)].append(f"{rel}:{line}")

for (fn, tag), where in sorted(tags.items()):
    if len(where) > 1:
        problems.append(f"{fn} tag {tag!r} is shared by {', '.join(where)}")
for tag, where in sorted(prefixes.items()):
    if len(where) > 1:
        problems.append(f"_prefix() {tag!r} is shared by {', '.join(where)}")

if problems:
    print("\n".join(problems), file=sys.stderr)
    print("ERROR: forge tests could share a scratch file (issue 1735).", file=sys.stderr)
    sys.exit(1)
print(f"ok: {len(files)} test files, {len(tags)} scratch tags and {len(prefixes)} prefixes, none shared")
