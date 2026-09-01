#!/usr/bin/env python3
"""Guard: every Rust ``tests/`` binary is COMPILED by a PR-stage CI job.

WHY THIS GUARD EXISTS (issue #1295)
-----------------------------------
On PR #1293 a required field was added to ``watchdog::config::Config``. Five
``Config { .. }`` literals in ``services/watchdog/tests/`` went incomplete and the
crate's integration test targets stopped compiling -- and the break reached
compliance review, because the job named after the crate said green.

The reason generalises. None of these compile a crate's ``tests/`` binaries:

  * ``cargo build --workspace``      -- builds lib/bin targets only
  * ``cargo test -p C --lib``        -- builds the lib test target only
  * ``cargo test --test one_binary`` -- builds exactly that one target
  * ``#[serde(default)]``            -- covers TOML deserialization, not literals

Only ``--all-targets`` (clippy/check/build) or an unfiltered ``cargo test
--no-run`` compiles them.

TWO INVARIANTS
--------------
(A) REACHABILITY. Every workspace member with a ``tests/*.rs`` file has its test
    targets compiled by at least one *unconditional* PR-stage job -- a job in a
    workflow that triggers on ``pull_request`` with no ``paths``/``paths-ignore``
    filter, and whose ``if:`` does not skip draft PRs. Without this, a crate can
    be added whose ``tests/`` nothing at PR stage ever type-checks.

(B) CRATE-LOCAL TRUTHFULNESS. Any job that runs ``cargo test ... --lib`` for
    crate C must, in the SAME job, also compile C's ``tests/`` targets. A job
    that presents itself as crate C's unit gate must not report green while C's
    test binaries do not compile. This is the exact hole #1293 fell through:
    ``watchdog-unit`` ran ``cargo clippy -p watchdog`` (no ``--all-targets``) and
    ``cargo test -p watchdog --lib``, neither of which touches ``tests/``.

Invariant (A) alone is not enough: it was already satisfied on #1293 by
``rust-lint``'s workspace-wide ``cargo clippy --all-targets``, which did go red
-- but ~9 minutes after the push, and only after the crate-named fast job had
already reported green. (B) is what makes the crate-local verdict honest.

Run ``--self-test`` to confirm the guard fires on both seeded defects.

Exit 0 when both invariants hold, non-zero otherwise.
"""

from __future__ import annotations

import re
import shlex
import subprocess
import sys
from pathlib import Path

import yaml

WORKFLOWS = Path(".github/workflows")
ROOT_MANIFEST = Path("Cargo.toml")

# Cargo commands that, with --all-targets, type-check tests/ binaries.
_ALL_TARGET_SUBCOMMANDS = ("clippy", "check", "build", "rustc")


class Crate:
    def __init__(self, name: str, path: str, has_tests: bool) -> None:
        self.name = name
        self.path = path  # workspace-relative directory, e.g. "services/watchdog"
        self.has_tests = has_tests

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"Crate({self.name!r}, {self.path!r}, tests={self.has_tests})"


def _package_name(manifest_text: str) -> str | None:
    """Return the ``[package] name`` from a Cargo.toml body, or None."""
    in_package = False
    for line in manifest_text.splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            in_package = stripped == "[package]"
            continue
        if in_package:
            m = re.match(r'name\s*=\s*"([^"]+)"', stripped)
            if m:
                return m.group(1)
    return None


def discover_crates(root: Path) -> list[Crate]:
    """Return the workspace members, with whether each carries tests/*.rs."""
    text = (root / ROOT_MANIFEST).read_text(encoding="utf-8")
    members_block = re.search(r"members\s*=\s*\[(.*?)\]", text, re.DOTALL)
    if not members_block:
        return []
    crates: list[Crate] = []
    for member in re.findall(r'"([^"]+)"', members_block.group(1)):
        manifest = root / member / "Cargo.toml"
        if not manifest.is_file():
            continue
        name = _package_name(manifest.read_text(encoding="utf-8"))
        if name is None:
            continue
        tests_dir = root / member / "tests"
        has_tests = tests_dir.is_dir() and any(tests_dir.glob("*.rs"))
        crates.append(Crate(name, member, has_tests))
    return crates


class CargoCall:
    """One ``cargo`` invocation found in a workflow ``run:`` block."""

    def __init__(self, subcommand: str, argv: list[str], working_dir: str) -> None:
        self.subcommand = subcommand
        self.argv = argv
        self.working_dir = working_dir.strip("./") if working_dir else ""

    def target_crate(self, crates: list[Crate]) -> Crate | None:
        """Which crate this call is scoped to, or None for workspace-wide."""
        for i, tok in enumerate(self.argv):
            if tok in ("-p", "--package") and i + 1 < len(self.argv):
                for c in crates:
                    if c.name == self.argv[i + 1]:
                        return c
            if tok.startswith("--package="):
                wanted = tok.split("=", 1)[1]
                for c in crates:
                    if c.name == wanted:
                        return c
            if tok == "--manifest-path" and i + 1 < len(self.argv):
                d = self.argv[i + 1].rsplit("/", 1)[0].strip("./")
                for c in crates:
                    if c.path == d:
                        return c
            if tok.startswith("--manifest-path="):
                d = tok.split("=", 1)[1].rsplit("/", 1)[0].strip("./")
                for c in crates:
                    if c.path == d:
                        return c
        if self.working_dir:
            for c in crates:
                if c.path == self.working_dir:
                    return c
        return None  # workspace-wide

    def is_lib_test(self) -> bool:
        return self.subcommand == "test" and "--lib" in self._flags()

    def compiles_test_targets(self) -> bool:
        """True when this call type-checks every ``tests/`` binary in scope."""
        flags = self._flags()
        if "--all-targets" in flags and self.subcommand in _ALL_TARGET_SUBCOMMANDS:
            return True
        if self.subcommand == "test" and "--no-run" in flags:
            # `cargo test --no-run` builds every target unless narrowed to one.
            narrowing = ("--lib", "--test", "--bin", "--bins", "--example", "--doc")
            return not any(f == n or f.startswith(n + "=") for f in flags for n in narrowing)
        return False

    def _flags(self) -> list[str]:
        """Argv up to the ``--`` that hands arguments to the test harness."""
        out: list[str] = []
        for tok in self.argv:
            if tok == "--":
                break
            out.append(tok)
        return out


def parse_cargo_calls(run_body: str, working_dir: str) -> list[CargoCall]:
    """Extract every ``cargo <sub>`` invocation from a ``run:`` script body."""
    calls: list[CargoCall] = []
    # Join backslash-continued lines so a wrapped command parses as one.
    body = re.sub(r"\\\s*\n\s*", " ", run_body)
    for raw in re.split(r"[\n;]|&&|\|\|", body):
        line = raw.strip()
        if "cargo" not in line:
            continue
        try:
            tokens = shlex.split(line, comments=True)
        except ValueError:
            tokens = line.split()
        for i, tok in enumerate(tokens):
            if tok != "cargo" and not tok.endswith("/cargo"):
                continue
            rest = tokens[i + 1 :]
            # Skip cargo's own leading options to find the subcommand.
            sub = None
            for j, t in enumerate(rest):
                if not t.startswith("-"):
                    sub = t
                    rest = rest[j + 1 :]
                    break
            if sub:
                calls.append(CargoCall(sub, rest, working_dir))
            break
    return calls


class Job:
    def __init__(self, workflow: str, job_id: str, name: str, unconditional: bool) -> None:
        self.workflow = workflow
        self.job_id = job_id
        self.name = name
        self.unconditional = unconditional
        self.calls: list[CargoCall] = []

    @property
    def label(self) -> str:
        return f"{self.workflow}:{self.name}"


def _pr_stage_unconditional(workflow: dict) -> bool:
    """True when this workflow runs on EVERY pull_request (no path filter)."""
    on = workflow.get("on") or workflow.get(True)  # YAML 1.1 parses `on:` as True
    if not isinstance(on, dict):
        return False
    if "pull_request" not in on:
        return False
    pr = on["pull_request"] or {}
    if not isinstance(pr, dict):
        return True
    return "paths" not in pr and "paths-ignore" not in pr


def load_jobs(root: Path) -> list[Job]:
    jobs: list[Job] = []
    for wf_path in sorted((root / WORKFLOWS).glob("*.yml")):
        try:
            doc = yaml.safe_load(wf_path.read_text(encoding="utf-8"))
        except yaml.YAMLError:
            continue
        if not isinstance(doc, dict):
            continue
        wf_unconditional = _pr_stage_unconditional(doc)
        for job_id, job in (doc.get("jobs") or {}).items():
            if not isinstance(job, dict):
                continue
            job_if = str(job.get("if", ""))
            # A job that skips draft PRs is not part of the draft-stage gate.
            skips_drafts = "draft == false" in job_if or "draft != true" in job_if
            job_wd = ((job.get("defaults") or {}).get("run") or {}).get(
                "working-directory", ""
            )
            j = Job(
                wf_path.name,
                str(job_id),
                str(job.get("name", job_id)),
                wf_unconditional and not skips_drafts,
            )
            for step in job.get("steps") or []:
                if not isinstance(step, dict) or "run" not in step:
                    continue
                wd = step.get("working-directory", job_wd) or ""
                j.calls.extend(parse_cargo_calls(str(step["run"]), str(wd)))
            jobs.append(j)
    return jobs


def check(root: Path) -> list[str]:
    """Return failure messages (empty = both invariants hold)."""
    failures: list[str] = []
    crates = discover_crates(root)
    tested = [c for c in crates if c.has_tests]
    if not tested:
        return ["no workspace member with a tests/ directory was discovered"]
    jobs = load_jobs(root)

    # (A) Reachability: an unconditional PR-stage job compiles each crate's tests/.
    for crate in tested:
        covering = [
            j.label
            for j in jobs
            if j.unconditional
            for call in j.calls
            if call.compiles_test_targets()
            and call.target_crate(crates) in (None, crate)
        ]
        if not covering:
            failures.append(
                f"crate '{crate.name}' ({crate.path}/tests/) has its test targets "
                f"compiled by NO unconditional PR-stage job -- add a "
                f"`--all-targets` or unfiltered `cargo test --no-run` step"
            )

    # (B) Crate-local truthfulness: a job running `cargo test --lib` for crate C
    #     must compile C's tests/ in the same job.
    for job in jobs:
        for call in job.calls:
            if not call.is_lib_test():
                continue
            crate = call.target_crate(crates)
            if crate is None or not crate.has_tests:
                continue
            same_job = [
                other
                for other in job.calls
                if other.compiles_test_targets()
                and other.target_crate(crates) in (None, crate)
            ]
            if not same_job:
                failures.append(
                    f"job '{job.label}' runs `cargo test --lib` for crate "
                    f"'{crate.name}' but never compiles {crate.path}/tests/ -- the "
                    f"job reports green while that crate's test binaries may not "
                    f"compile; add `--all-targets` or `cargo test --no-run`"
                )
    return sorted(set(failures))


# --------------------------------------------------------------------------- #
# Self-test
# --------------------------------------------------------------------------- #

_MANIFEST = '[workspace]\nresolver = "2"\nmembers = [\n    "svc/alpha",\n]\n'
_CRATE_MANIFEST = '[package]\nname = "alpha"\nversion = "0.1.0"\n'


def _seed(root: Path, lint_flags: str, unit_steps: str) -> None:
    (root / "svc/alpha/tests").mkdir(parents=True, exist_ok=True)
    (root / "Cargo.toml").write_text(_MANIFEST, encoding="utf-8")
    (root / "svc/alpha/Cargo.toml").write_text(_CRATE_MANIFEST, encoding="utf-8")
    (root / "svc/alpha/tests/it.rs").write_text("#[test]\nfn t() {}\n", encoding="utf-8")
    (root / WORKFLOWS).mkdir(parents=True, exist_ok=True)
    (root / WORKFLOWS / "lint.yml").write_text(
        "name: lint\n"
        "on:\n  pull_request:\n"
        "jobs:\n"
        "  lint:\n"
        "    name: rust-lint\n"
        "    steps:\n"
        f"      - run: cargo clippy {lint_flags}-- -D warnings\n",
        encoding="utf-8",
    )
    (root / WORKFLOWS / "unit.yml").write_text(
        "name: unit\n"
        "on:\n  pull_request:\n"
        "jobs:\n"
        "  fast:\n"
        "    name: alpha-unit\n"
        "    steps:\n" + unit_steps,
        encoding="utf-8",
    )


def self_test() -> int:
    import tempfile

    covered_unit = "      - run: cargo clippy -p alpha --all-targets -- -D warnings\n" \
                   "      - run: cargo test -p alpha --lib -- --nocapture\n"
    bare_unit = "      - run: cargo clippy -p alpha -- -D warnings\n" \
                "      - run: cargo test -p alpha --lib -- --nocapture\n"

    cases = [
        # (label, lint_flags, unit_steps, expected substring or None for pass)
        ("compliant", "--all-targets --all-features ", covered_unit, None),
        (
            "invariant B: --lib job never compiles tests/",
            "--all-targets --all-features ",
            bare_unit,
            "never compiles svc/alpha/tests/",
        ),
        (
            "invariant A: --all-targets dropped from the workspace lint",
            "",
            covered_unit.replace("--all-targets ", ""),
            "compiled by NO unconditional PR-stage job",
        ),
    ]

    for label, lint_flags, unit_steps, expect in cases:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _seed(root, lint_flags, unit_steps)
            failures = check(root)
            if expect is None:
                if failures:
                    print(f"SELF-TEST FAIL [{label}]: compliant fixture flagged:", file=sys.stderr)
                    for f in failures:
                        print(f"  - {f}", file=sys.stderr)
                    return 1
            else:
                if not any(expect in f for f in failures):
                    print(
                        f"SELF-TEST FAIL [{label}]: guard did not flag the seeded "
                        f"defect (expected a message containing {expect!r})",
                        file=sys.stderr,
                    )
                    for f in failures:
                        print(f"  - {f}", file=sys.stderr)
                    return 1
        print(f"  self-test OK: {label}")

    print("SELF-TEST OK: guard fires for both invariants and passes a compliant fixture.")
    return 0


def repo_root() -> Path:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
        )
        return Path(out.stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError):
        return Path.cwd()


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return self_test()

    root = repo_root()
    failures = check(root)
    if failures:
        print("FAIL: Rust tests/ compile-coverage invariants violated:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1

    crates = [c for c in discover_crates(root) if c.has_tests]
    print(
        "OK: every workspace crate with tests/ is compiled by an unconditional "
        "PR-stage job, and every `cargo test --lib` job compiles its own crate's "
        f"tests/ ({len(crates)} crates checked: "
        + ", ".join(c.name for c in crates)
        + ")"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
