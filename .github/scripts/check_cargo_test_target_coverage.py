#!/usr/bin/env python3
"""Fail when a cargo integration-test target is executed by NO workflow.

WHY THIS EXISTS (issue #1282)
-----------------------------
Every Rust suite in this repository names its cargo test binaries by hand:
`cargo test --lib`, `cargo test --test migrations`, `cargo test --test
<matrix.binary>`. There is no bare `cargo test` over a whole package and no
`--test '*'` anywhere in `.github/workflows`. The consequence is that adding a
`tests/<name>.rs` file adds ZERO CI coverage unless a workflow is edited in the
same change -- and nothing detected the omission. When this check was first run,
35 of 83 integration-test targets were dark, including both explorer-indexer
reorg suites, `clients/explorer-api/tests/endpoints.rs` (42 tests) and
`clients/rust-payment-client/tests/cli_deposit.rs` (687 lines, 10 tests).

`.github/scripts/cargo_test_require_executed.sh` already fails when a target
that IS invoked collects zero tests. It cannot see a target nobody invoked at
all. This script closes that half of the gap: it enumerates every integration
target across the workspace, resolves which (package, target) pairs the
workflows actually execute, and fails on any pair that is neither executed nor
on the allowlist.

WHY MATCHING IS PACKAGE-SCOPED AND NOT A GREP
---------------------------------------------
A plain `grep -rn <name> .github/` lies in both directions. `endpoints` and
`cli` appear as prose in workflow comments, so a grep calls them covered when
nothing runs them. And `--test governance` in suite-05 runs from
`testing/fork-e2e-rust`, so a name-only match wrongly credits
`testing/smoke-test/tests/governance.rs` too. This script therefore resolves the
package of every `cargo test` invocation from `-p` / `--package`,
`--manifest-path`, or the step's effective `working-directory`, and only credits
targets in that package.

USAGE
    python3 .github/scripts/check_cargo_test_target_coverage.py [--repo-root DIR]
                                                               [--allowlist FILE]
                                                               [--list-executed]

Exit 0 when every target is executed or allowlisted; exit 1 otherwise.

Reference: skills/_shared/test-coverage-policy.md (invariant 2: Exit 0 != tested).
"""

from __future__ import annotations

import argparse
import os
import re
import shlex
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - CI installs pyyaml
    sys.stderr.write("ERROR: PyYAML is required (pip install pyyaml)\n")
    raise SystemExit(2)

# Target selectors that RESTRICT a `cargo test` run to non-integration targets.
# If one of these appears and no integration selector does, the invocation
# executes zero `tests/*.rs` targets.
NON_INTEGRATION_SELECTORS = {"--lib", "--bins", "--bin", "--doc", "--example", "--examples", "--bench", "--benches"}
# Selectors that pull in EVERY integration target of the selected package(s).
ALL_INTEGRATION_SELECTORS = {"--tests", "--all-targets"}

MATRIX_REF = re.compile(r"\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}")


def load_workspace_members(repo_root: Path) -> list[Path]:
    """Return the workspace member directories from the root Cargo.toml."""
    text = (repo_root / "Cargo.toml").read_text(encoding="utf-8")
    block = re.search(r"^members\s*=\s*\[(.*?)\]", text, re.S | re.M)
    if not block:
        raise SystemExit("ERROR: could not find [workspace] members in Cargo.toml")
    members: list[Path] = []
    for raw in re.findall(r'"([^"]+)"', block.group(1)):
        if "*" in raw:
            members.extend(sorted(p for p in repo_root.glob(raw) if (p / "Cargo.toml").is_file()))
        else:
            members.append(repo_root / raw)
    return members


def package_name(member: Path) -> str:
    """Read `name = "..."` out of a member's [package] section."""
    text = (member / "Cargo.toml").read_text(encoding="utf-8")
    m = re.search(r'^\s*name\s*=\s*"([^"]+)"', text, re.M)
    if not m:
        raise SystemExit(f"ERROR: {member}/Cargo.toml has no package name")
    return m.group(1)


def enumerate_targets(repo_root: Path) -> tuple[dict[str, Path], dict[tuple[str, str], Path]]:
    """Map package -> dir, and (package, target) -> test file path.

    Cargo's autotest discovery treats every `tests/*.rs` file as its own
    integration target. `tests/<dir>/mod.rs` helpers are NOT targets, which is
    why only regular files directly under `tests/` are counted.
    """
    pkg_dirs: dict[str, Path] = {}
    targets: dict[tuple[str, str], Path] = {}
    for member in load_workspace_members(repo_root):
        pkg = package_name(member)
        pkg_dirs[pkg] = member
        tests_dir = member / "tests"
        if not tests_dir.is_dir():
            continue
        for entry in sorted(tests_dir.iterdir()):
            if entry.is_file() and entry.suffix == ".rs":
                targets[(pkg, entry.stem)] = entry
    return pkg_dirs, targets


def matrix_combinations(job: dict) -> list[dict[str, str]]:
    """Expand a job's `strategy.matrix` into concrete key->value dicts.

    Both matrix forms are handled: plain `key: [a, b]` axes (expanded as the
    cross product) and `include:` entries (each taken verbatim). A job with no
    matrix yields a single empty substitution so its steps are still scanned.
    """
    strategy = job.get("strategy") or {}
    matrix = strategy.get("matrix") or {}
    if not isinstance(matrix, dict):
        return [{}]
    axes = {k: v for k, v in matrix.items() if k not in ("include", "exclude") and isinstance(v, list)}
    combos: list[dict[str, str]] = [{}]
    for key, values in axes.items():
        combos = [dict(c, **{key: str(v)}) for c in combos for v in values]
    for inc in matrix.get("include") or []:
        if isinstance(inc, dict):
            combos.append({k: str(v) for k, v in inc.items()})
    return combos or [{}]


def substitute(text: str, combo: dict[str, str]) -> str:
    return MATRIX_REF.sub(lambda m: combo.get(m.group(1), m.group(0)), text)


def resolve_package(tokens: list[str], workdir: str, dir_to_pkg: dict[str, str]) -> str | None:
    """Resolve which package a cargo invocation selects.

    Precedence matches cargo's own: an explicit `-p`/`--package` wins, then
    `--manifest-path`, then the step's effective working directory. A root-level
    invocation resolves to None because the workspace root is a virtual manifest
    -- `--test <name>` there is ambiguous and no workflow relies on it.
    """
    for i, tok in enumerate(tokens):
        if tok in ("-p", "--package") and i + 1 < len(tokens):
            return tokens[i + 1]
        if tok.startswith("--package="):
            return tok.split("=", 1)[1]
        if tok in ("--manifest-path",) and i + 1 < len(tokens):
            return dir_to_pkg.get(os.path.normpath(os.path.dirname(tokens[i + 1])))
        if tok.startswith("--manifest-path="):
            return dir_to_pkg.get(os.path.normpath(os.path.dirname(tok.split("=", 1)[1])))
    return dir_to_pkg.get(os.path.normpath(workdir)) if workdir else None


def scan_command(cmd: str, workdir: str, dir_to_pkg: dict[str, str], pkg_targets: dict[str, set[str]]):
    """Yield (package, target) pairs a single shell command executes.

    `cargo test --no-run` only COMPILES, so it is deliberately not credited:
    a compiled-but-never-run binary is exactly the silent-skip this check
    exists to expose.
    """
    if "cargo test" not in cmd and "cargo_test_require_executed" not in cmd:
        return
    try:
        tokens = shlex.split(cmd, comments=True)
    except ValueError:
        tokens = cmd.split()
    if "--no-run" in tokens:
        return
    # Everything after the libtest `--` separator is a name filter, not a
    # target selector, so it must not be mistaken for one.
    if "--" in tokens:
        tokens = tokens[: tokens.index("--")]

    pkg = resolve_package(tokens, workdir, dir_to_pkg)
    if pkg is None or pkg not in pkg_targets:
        return

    named: set[str] = set()
    for i, tok in enumerate(tokens):
        if tok == "--test" and i + 1 < len(tokens):
            named.add(tokens[i + 1])
        elif tok.startswith("--test="):
            named.add(tok.split("=", 1)[1])
    if named:
        for t in named:
            yield (pkg, t)
        return
    if ALL_INTEGRATION_SELECTORS & set(tokens):
        for t in pkg_targets[pkg]:
            yield (pkg, t)
        return
    if NON_INTEGRATION_SELECTORS & set(tokens):
        return
    # A bare `cargo test` with no target selector runs every target, integration
    # targets included.
    for t in pkg_targets[pkg]:
        yield (pkg, t)


def split_commands(script: str) -> list[str]:
    """Flatten a `run:` block into individual shell commands.

    Backslash-newline continuations are joined first so a multi-line
    `cargo_test_require_executed.sh \\ -p x \\ --test y` invocation is seen as
    one command rather than three fragments.
    """
    script = re.sub(r"\\\s*\n\s*", " ", script)
    parts = re.split(r"[\n;]|&&|\|\|", script)
    return [p.strip() for p in parts if p.strip()]


def executed_pairs(repo_root: Path, pkg_targets: dict[str, set[str]], dir_to_pkg: dict[str, str]):
    """Collect every (package, target) pair executed by any workflow."""
    found: dict[tuple[str, str], set[str]] = {}
    for wf in sorted((repo_root / ".github" / "workflows").glob("*.yml")):
        try:
            doc = yaml.safe_load(wf.read_text(encoding="utf-8"))
        except yaml.YAMLError as e:
            raise SystemExit(f"ERROR: {wf} is not parseable YAML: {e}")
        if not isinstance(doc, dict):
            continue
        for job_id, job in (doc.get("jobs") or {}).items():
            if not isinstance(job, dict):
                continue
            job_wd = ((job.get("defaults") or {}).get("run") or {}).get("working-directory", "")
            combos = matrix_combinations(job)
            for step in job.get("steps") or []:
                if not isinstance(step, dict) or "run" not in step:
                    continue
                wd = step.get("working-directory", job_wd) or ""
                for combo in combos:
                    script = substitute(str(step["run"]), combo)
                    step_wd = substitute(str(wd), combo)
                    for cmd in split_commands(script):
                        for pair in scan_command(cmd, step_wd, dir_to_pkg, pkg_targets):
                            found.setdefault(pair, set()).add(f"{wf.name}:{job_id}")
    return found


def load_allowlist(path: Path) -> tuple[dict[tuple[str, str], str], list[str]]:
    """Parse the allowlist, requiring a stated reason on every entry.

    An entry is `package::target`, and its reason is either an inline `#`
    comment or the comment block immediately above it. An entry with neither is
    an error: an allowlist row without a reason is indistinguishable from an
    oversight, which is the failure mode this whole check exists to prevent.
    """
    entries: dict[tuple[str, str], str] = {}
    errors: list[str] = []
    if not path.is_file():
        return entries, errors
    pending: list[str] = []
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line:
            pending = []
            continue
        if line.startswith("#"):
            comment = line.lstrip("#").strip()
            if comment:
                pending.append(comment)
            continue
        entry, _, inline = line.partition("#")
        entry = entry.strip()
        reason = inline.strip() or " ".join(pending).strip()
        pending = []
        if "::" not in entry:
            errors.append(f"{path}:{lineno}: malformed entry {entry!r} (expected package::target)")
            continue
        pkg, target = entry.split("::", 1)
        if not reason:
            errors.append(
                f"{path}:{lineno}: allowlist entry '{entry}' has no reason. "
                "Add a comment above it, or after it on the same line, saying why "
                "this target is deliberately not executed by any workflow."
            )
            continue
        entries[(pkg.strip(), target.strip())] = reason
    return entries, errors


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo-root", default=".", help="repository root (default: cwd)")
    ap.add_argument(
        "--allowlist",
        default=None,
        help="allowlist file (default: <repo-root>/.github/cargo-test-target-allowlist.txt)",
    )
    ap.add_argument("--list-executed", action="store_true", help="also print every executed target and its workflow")
    args = ap.parse_args()

    repo_root = Path(args.repo_root).resolve()
    allowlist_path = Path(args.allowlist) if args.allowlist else repo_root / ".github" / "cargo-test-target-allowlist.txt"

    pkg_dirs, targets = enumerate_targets(repo_root)
    pkg_targets: dict[str, set[str]] = {p: set() for p in pkg_dirs}
    for (pkg, target) in targets:
        pkg_targets[pkg].add(target)
    dir_to_pkg = {os.path.normpath(str(d.relative_to(repo_root))): p for p, d in pkg_dirs.items()}

    executed = executed_pairs(repo_root, pkg_targets, dir_to_pkg)
    allow, allow_errors = load_allowlist(allowlist_path)

    dark = sorted(k for k in targets if k not in executed and k not in allow)
    stale = sorted(k for k in allow if k in executed)
    orphan = sorted(k for k in allow if k not in targets)

    total = len(targets)
    print(f"cargo integration-test targets: {total}")
    print(f"  executed by a workflow:       {len([k for k in targets if k in executed])}")
    print(f"  allowlisted (not executed):   {len([k for k in targets if k not in executed and k in allow])}")
    print(f"  DARK (nothing runs them):     {len(dark)}")

    if args.list_executed:
        print("\nexecuted targets:")
        for key in sorted(k for k in targets if k in executed):
            print(f"  {key[0]}::{key[1]}  <- {', '.join(sorted(executed[key]))}")

    failed = False
    for err in allow_errors:
        print(f"\nERROR: {err}", file=sys.stderr)
        failed = True

    if dark:
        failed = True
        print("\nERROR: these integration-test targets are executed by NO workflow:", file=sys.stderr)
        for pkg, target in dark:
            print(f"  {pkg}::{target}  ({targets[(pkg, target)].relative_to(repo_root)})", file=sys.stderr)
        print(
            "\nA tests/<name>.rs file that no job names with `--test <name>` (or that no\n"
            "job covers with a bare `cargo test -p <pkg>`) never runs. It is not coverage.\n"
            "Fix by EITHER wiring it into a suite -- preferably through\n"
            ".github/scripts/cargo_test_require_executed.sh so a zero-collected run is red --\n"
            f"OR adding `<package>::<target>` to {allowlist_path.relative_to(repo_root)} with a\n"
            "comment stating why it is deliberately not executed.\n"
            "See docs/development/ci-suites.md (Integration-test target coverage).",
            file=sys.stderr,
        )

    if stale:
        failed = True
        print("\nERROR: these allowlist entries are stale — the target IS executed now:", file=sys.stderr)
        for pkg, target in stale:
            print(f"  {pkg}::{target}", file=sys.stderr)
        print("Remove them from the allowlist.", file=sys.stderr)

    if orphan:
        failed = True
        print("\nERROR: these allowlist entries name a target that does not exist:", file=sys.stderr)
        for pkg, target in orphan:
            print(f"  {pkg}::{target}", file=sys.stderr)
        print("Remove them; a stale entry hides the next real gap.", file=sys.stderr)

    if failed:
        return 1
    print("\nOK: every cargo integration-test target is executed by a workflow or allowlisted with a reason.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
