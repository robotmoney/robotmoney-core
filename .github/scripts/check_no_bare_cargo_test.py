#!/usr/bin/env python3
"""Fail on any `cargo test` that selects a target with `--test` and bypasses the executed-test guard.

WHY (issue 1656, follow-up of 1421, 1436, 1643): a plain `cargo test --test X` exits 0 when X
collects zero tests, so a green step can mean no assertion ran. Every such step in
.github/workflows must run through .github/scripts/cargo_test_require_executed.sh, which fails
below a floor (CARGO_TEST_MIN_EXECUTED).

A step that deliberately expects `cargo test` to FAIL (a proof that a skip is fatal under CI) may
carry the marker `bare-cargo-test-allowed: <reason>` as a comment-only line inside its `run:` block,
above the command it covers.

The marker is narrow (issue 1683, QA plan T3). Before, the literal text anywhere in a block exempted
the whole block: an `echo "bare-cargo-test-allowed: ..."` string counted, and so did every sibling
bare command in the same block. Now:
- it counts only on a line that is nothing but a comment opening with the marker; an echo string,
  a trailing comment after a command, or a comment that names the marker after other text does
  not count;
- it covers one `cargo test` invocation: the first command after it that runs `cargo test`, and only
  when that command holds a single `cargo test` (a `&&` or `||` sibling on the same line is not
  covered);
- a block gets one allowance, however many markers it carries. Put a second expected-failure
  command in a step of its own.

USAGE: check_no_bare_cargo_test.py [workflows_dir]   (default: <repo>/.github/workflows)
Self-test: .github/scripts/tests/test_check_no_bare_cargo_test.sh
"""
import pathlib
import re
import subprocess
import sys

CARGO_TEST = re.compile(r"\bcargo\s+test\b")
TARGET_FLAG = re.compile(r"(?<![\w-])--test(?=[\s=]|$)")
# Matched against a stripped comment-only line, so the marker must open the comment.
ALLOW = re.compile(r"^#+\s*bare-cargo-test-allowed:")
# Stands in, in the logical command list, for a comment-only line that carries ALLOW.
ALLOW_LINE = object()
RUN_BLOCK = re.compile(r"^(\s*)(?:-\s+)?run:\s*([>|])[-+]?\s*$")


def indent(line):
    return len(line) - len(line.lstrip(" "))


def blocks(lines):
    """Yield (first_line_no, [text lines]) for each `run:` value, block scalar or inline."""
    i = 0
    while i < len(lines):
        line = lines[i]
        m = RUN_BLOCK.match(line)
        if m:
            base, style = indent(line), m.group(2)
            body, j = [], i + 1
            while j < len(lines) and (not lines[j].strip() or indent(lines[j]) > base):
                body.append(lines[j])
                j += 1
            if style == ">":  # folded: newlines become spaces
                body = [" ".join(b.strip() for b in body if b.strip())]
            yield i + 2, body
            i = j
            continue
        m = re.match(r"^\s*(?:-\s+)?run:\s*(\S.*)$", line)
        if m:
            yield i + 1, [m.group(1)]
        i += 1


def logical_commands(body):
    """Join backslash-continued lines; drop comment-only lines.

    A comment-only line that carries the allow marker is kept as ALLOW_LINE, in order, so scan()
    knows which command it sits above.
    """
    cmds, cur = [], ""
    for raw in body:
        text = raw.strip()
        if not cur and text.startswith("#"):
            if ALLOW.match(text):
                cmds.append(ALLOW_LINE)
            continue
        cur += (" " if cur else "") + text.rstrip("\\").strip()
        if not raw.rstrip().endswith("\\"):
            cmds.append(cur)
            cur = ""
    if cur:
        cmds.append(cur)
    return cmds


def scan(path):
    problems = []
    lines = path.read_text().splitlines()
    for first, body in blocks(lines):
        pending = False  # a marker sits above and no cargo test command has used it yet
        spent = False  # this block has used its one allowance
        for cmd in logical_commands(body):
            if cmd is ALLOW_LINE:
                pending = pending or not spent
                continue
            runs = len(CARGO_TEST.findall(cmd))
            if not runs:
                continue
            covered = False
            if pending:
                # The first cargo test command after the marker uses it, bare or not.
                pending, spent = False, True
                covered = runs == 1
            if TARGET_FLAG.search(cmd) and not covered:
                problems.append((path, first, cmd[:160]))
    return problems


def main():
    if len(sys.argv) > 1:
        root = pathlib.Path(sys.argv[1])
    else:
        top = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
        root = pathlib.Path(top) / ".github" / "workflows"
    files = sorted(list(root.glob("*.yml")) + list(root.glob("*.yaml")))
    if not files:
        print(f"ERROR: no workflow files under {root}", file=sys.stderr)
        return 2
    problems = [p for f in files for p in scan(f)]
    for path, line, cmd in problems:
        print(f"{path}:{line}: bare cargo test --test: {cmd}", file=sys.stderr)
    if problems:
        print(
            "ERROR: wrap every `cargo test --test` in .github/scripts/cargo_test_require_executed.sh "
            "with CARGO_TEST_MIN_EXECUTED set to the executed count (issue 1656). A step that "
            "must see cargo test FAIL puts `# bare-cargo-test-allowed: <reason>` on its own "
            "comment line above that one command; one such command per run block (issue 1683).",
            file=sys.stderr,
        )
        return 1
    print(f"ok: no bare cargo test --test in {len(files)} workflow file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
