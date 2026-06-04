#!/usr/bin/env python3
# Canonical: docs/development/ci-suites.md (CI velocity tier model)
#
# WHY THIS SCRIPT EXISTS
# Issue #600 split CI into a QUICK tier (runs on every feature-branch PR) and a
# HEAVY tier (devnet e2e matrices + the forge coverage gate, re-anchored at the
# phase-integration boundary: dev-phase-* staging branches and dev). The split,
# the per-binary devnet matrices, the concurrency cancellation, and the move to
# Swatinem/rust-cache are all structural invariants that are trivially easy to
# regress with a one-line YAML edit and impossible to notice in review. This
# script parses every workflow YAML and fails the build if any invariant is
# broken, so the velocity work cannot silently rot.
#
# INVARIANTS ENFORCED (mirror docs/development/ci-suites.md "CI velocity tiers")
#   1. Every PR-triggered workflow declares concurrency.cancel-in-progress: true,
#      while push:main/dev runs stay exempt (we only require the concurrency
#      group; cancellation only applies to the in-progress group, and the group
#      key is ${{ github.workflow }}-${{ github.ref }} so main/dev pushes get
#      their own non-cancelling lane via github.ref).
#   2. suite-07 and suite-14 each express their devnet test binaries as a job
#      matrix (one entry per binary) and every matrix job declares an
#      `if: always()` `docker compose down` teardown. No devnet binary may be a
#      sequential step inside a shared job.
#   3. No Rust-building workflow uses actions/cache for cargo target/registry
#      directories; each uses Swatinem/rust-cache@v2 instead.
#   4. The heavy suites are NOT reachable from an ordinary feature-branch PR
#      trigger and ARE triggered on dev-phase-* branches and dev.
#   5. docs/development/ci-suites.md documents the quick-vs-heavy tier mapping
#      and every workflow's tier matches its documented tier entry.
#
# USAGE
#   python3 scripts/ci/check_workflow_tiers.py
# Exits 0 when every invariant holds, nonzero (printing each violation) on the
# first failing invariant set.

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_DIR = REPO_ROOT / ".github" / "workflows"
CI_SUITES_DOC = REPO_ROOT / "docs" / "development" / "ci-suites.md"

# Heavy-tier workflows keyed by their `name:` field. These must never be
# reachable from an ordinary feature-branch PR and must run on dev-phase-* + dev.
HEAVY_WORKFLOW_NAMES = {
    "rust-client-devnet-integration",
    "smoke-test-devnet-boot-teardown",
    "dapp-e2e",
}
# The forge coverage gate is a heavy JOB inside an otherwise-quick workflow; it
# is enforced separately (see check_forge_coverage_gate).
FORGE_TESTS_WORKFLOW_NAME = "forge-unit-invariant-coverage"
FORGE_COVERAGE_JOB = "coverage"

# Devnet test binaries that MUST each be their own matrix entry, by workflow name.
DEVNET_MATRIX_BINARIES = {
    "rust-client-devnet-integration": {"smoke", "scenarios", "window_cap", "withdraw"},
    "smoke-test-devnet-boot-teardown": {"cli_meta", "fixture_meta", "demo_seeding"},
}

# Phase-integration boundary branches the heavy tier anchors on.
DEV_PHASE_GLOB = "dev-phase-*"


class Violations:
    def __init__(self) -> None:
        self.items: list[str] = []

    def add(self, msg: str) -> None:
        self.items.append(msg)

    def __bool__(self) -> bool:
        return bool(self.items)


def load_workflows() -> dict[Path, dict]:
    """Parse every .github/workflows/*.yml into a {path: parsed_yaml} map.

    PyYAML maps the bare `on:` key to Python True, so we re-key it to the string
    "on" for predictable downstream access.
    """
    workflows: dict[Path, dict] = {}
    for path in sorted(WORKFLOW_DIR.glob("*.yml")):
        with path.open() as fh:
            data = yaml.safe_load(fh)
        if not isinstance(data, dict):
            continue
        if True in data and "on" not in data:
            data["on"] = data.pop(True)
        workflows[path] = data
    return workflows


def get_on(wf: dict) -> dict:
    on = wf.get("on", {})
    if isinstance(on, list):
        # e.g. `on: [push, pull_request]` -> normalise to dict of empty configs
        return {k: {} for k in on}
    if isinstance(on, str):
        return {on: {}}
    return on if isinstance(on, dict) else {}


def pr_branches(wf: dict) -> list[str]:
    on = get_on(wf)
    pr = on.get("pull_request")
    if pr is None:
        return []
    if not isinstance(pr, dict):
        return ["**"]  # pull_request with no config = all base branches
    branches = pr.get("branches")
    if branches is None:
        return ["**"]
    return list(branches)


def push_branches(wf: dict) -> list[str]:
    on = get_on(wf)
    push = on.get("push")
    if not isinstance(push, dict):
        return []
    return list(push.get("branches", []))


def is_pr_triggered(wf: dict) -> bool:
    return "pull_request" in get_on(wf)


def feature_pr_reachable(wf: dict) -> bool:
    """A heavy suite is feature-PR-reachable if it has any pull_request trigger
    whose base-branch filter would match an ordinary feature PR. Ordinary
    feature PRs target main/dev (and lack a dev-phase-* base). We treat a
    pull_request trigger limited strictly to dev-phase-* bases as the allowed
    phase-integration boundary; any pull_request whose branch filter includes
    main, dev, or a wildcard is feature-PR-reachable.
    """
    if "pull_request" not in get_on(wf):
        return False
    branches = pr_branches(wf)
    allowed = {DEV_PHASE_GLOB}
    for b in branches:
        if b not in allowed:
            return True
    return False


def check_concurrency(workflows: dict[Path, dict], v: Violations) -> None:
    for path, wf in workflows.items():
        if not is_pr_triggered(wf):
            continue
        conc = wf.get("concurrency")
        if not isinstance(conc, dict):
            v.add(
                f"{path.name}: PR-triggered workflow is missing a `concurrency` "
                f"block (need cancel-in-progress: true)."
            )
            continue
        cip = conc.get("cancel-in-progress")
        # Accept either a literal `true` (cancellation always on; push lanes are
        # kept distinct via github.ref in the group key) or an expression that
        # turns cancellation on for pull_request events while leaving push:main/dev
        # exempt (the explicit "push runs always complete" guarantee).
        cip_ok = cip is True or (
            isinstance(cip, str) and "pull_request" in cip and "event_name" in cip
        )
        if not cip_ok:
            v.add(
                f"{path.name}: concurrency.cancel-in-progress must be true (or an "
                f"expression enabling it for pull_request events while exempting "
                f"push:main/dev) (found {cip!r})."
            )
        group = conc.get("group", "")
        if "github.ref" not in str(group):
            v.add(
                f"{path.name}: concurrency.group must include ${{{{ github.ref }}}} "
                f"so push:main/dev runs get their own non-cancelling lane "
                f"(found {group!r})."
            )


def _job_has_always_teardown(job: dict) -> bool:
    for step in job.get("steps", []) or []:
        if not isinstance(step, dict):
            continue
        cond = str(step.get("if", ""))
        run = str(step.get("run", ""))
        if "always()" in cond and "docker compose down" in run:
            return True
    return False


def _matrix_binary_values(job: dict) -> set[str]:
    """Return the set of matrix dimension values across all list-valued matrix
    keys for a job (e.g. {smoke, scenarios, ...})."""
    strategy = job.get("strategy", {})
    if not isinstance(strategy, dict):
        return set()
    matrix = strategy.get("matrix", {})
    if not isinstance(matrix, dict):
        return set()
    values: set[str] = set()
    for val in matrix.values():
        if isinstance(val, list):
            for entry in val:
                if isinstance(entry, str):
                    values.add(entry)
                elif isinstance(entry, dict):
                    # include/object form: collect scalar string fields
                    for fv in entry.values():
                        if isinstance(fv, str):
                            values.add(fv)
    return values


def check_devnet_matrices(workflows: dict[Path, dict], v: Violations) -> None:
    by_name = {wf.get("name"): (path, wf) for path, wf in workflows.items()}
    for name, required_bins in DEVNET_MATRIX_BINARIES.items():
        if name not in by_name:
            v.add(f"expected workflow named {name!r} not found.")
            continue
        path, wf = by_name[name]
        jobs = wf.get("jobs", {}) or {}
        # Find the job(s) that carry a matrix covering the devnet binaries.
        matrix_job = None
        for job_name, job in jobs.items():
            if not isinstance(job, dict):
                continue
            vals = _matrix_binary_values(job)
            if required_bins & vals:
                matrix_job = (job_name, job, vals)
                break
        if matrix_job is None:
            v.add(
                f"{path.name}: no job defines a matrix containing the devnet "
                f"binaries {sorted(required_bins)}; serial steps are forbidden."
            )
            continue
        job_name, job, vals = matrix_job
        missing = required_bins - vals
        if missing:
            v.add(
                f"{path.name} job {job_name!r}: matrix is missing devnet binary "
                f"entries {sorted(missing)}."
            )
        if not _job_has_always_teardown(job):
            v.add(
                f"{path.name} job {job_name!r}: matrix job must declare an "
                f"`if: always()` `docker compose down` teardown step."
            )
        # fail-fast must be false so one binary failing does not cancel the
        # others (required for the no-port-contention assertion to be meaningful).
        strategy = job.get("strategy", {})
        if isinstance(strategy, dict) and strategy.get("fail-fast") is not False:
            v.add(
                f"{path.name} job {job_name!r}: strategy.fail-fast must be false "
                f"so every devnet matrix entry runs independently."
            )
        # No devnet binary may also appear as a sequential `cargo test --test <bin>`
        # step in any OTHER job in the same workflow.
        for other_name, other in jobs.items():
            if other_name == job_name or not isinstance(other, dict):
                continue
            for step in other.get("steps", []) or []:
                if not isinstance(step, dict):
                    continue
                run = str(step.get("run", ""))
                for binary in required_bins:
                    if re.search(rf"--test\s+{re.escape(binary)}\b", run):
                        v.add(
                            f"{path.name} job {other_name!r}: devnet binary "
                            f"{binary!r} is run as a sequential step; it must be "
                            f"a matrix entry instead."
                        )


def _uses_in_steps(job: dict) -> list[str]:
    out = []
    for step in job.get("steps", []) or []:
        if isinstance(step, dict) and step.get("uses"):
            out.append(str(step["uses"]))
    return out


CARGO_DIR_HINTS = ("~/.cargo", "/target", "target\n", "target ")


def check_rust_caching(workflows: dict[Path, dict], v: Violations) -> None:
    for path, wf in workflows.items():
        jobs = wf.get("jobs", {}) or {}
        for job_name, job in jobs.items():
            if not isinstance(job, dict):
                continue
            uses = _uses_in_steps(job)
            installs_rust = any("dtolnay/rust-toolchain" in u for u in uses)
            for step in job.get("steps", []) or []:
                if not isinstance(step, dict):
                    continue
                u = str(step.get("uses", ""))
                if "actions/cache" not in u:
                    continue
                with_block = step.get("with", {}) or {}
                cache_paths = str(with_block.get("path", ""))
                caches_cargo = (
                    ".cargo" in cache_paths
                    or "cargo" in str(with_block.get("key", "")).lower()
                    or re.search(r"(^|\n)\s*target\b", cache_paths) is not None
                )
                if installs_rust and caches_cargo:
                    v.add(
                        f"{path.name} job {job_name!r}: hand-rolled actions/cache "
                        f"for cargo target/registry is forbidden — use "
                        f"Swatinem/rust-cache@v2."
                    )
            # A Rust-building job must use Swatinem/rust-cache.
            if installs_rust:
                builds_rust = any(
                    "cargo " in str(s.get("run", ""))
                    for s in (job.get("steps", []) or [])
                    if isinstance(s, dict)
                )
                if builds_rust and not any("Swatinem/rust-cache" in u for u in uses):
                    v.add(
                        f"{path.name} job {job_name!r}: Rust-building job must "
                        f"declare Swatinem/rust-cache@v2."
                    )


def check_tier_triggers(workflows: dict[Path, dict], v: Violations) -> None:
    by_name = {wf.get("name"): (path, wf) for path, wf in workflows.items()}
    for name in HEAVY_WORKFLOW_NAMES:
        if name not in by_name:
            v.add(f"heavy workflow named {name!r} not found.")
            continue
        path, wf = by_name[name]
        if feature_pr_reachable(wf):
            v.add(
                f"{path.name}: heavy suite {name!r} is reachable from an ordinary "
                f"feature-branch PR (pull_request base filter {pr_branches(wf)}); "
                f"heavy suites must be gated to the dev-phase-* boundary."
            )
        pushes = push_branches(wf)
        if "dev" not in pushes:
            v.add(f"{path.name}: heavy suite {name!r} must run on push to dev.")
        if not any(re.match(r"dev-phase", b) for b in pushes + pr_branches(wf)):
            v.add(
                f"{path.name}: heavy suite {name!r} must be anchored on "
                f"dev-phase-* (push or pull_request)."
            )

    # forge-coverage-gate job must depend on the heavy boundary too: the
    # coverage job is gated behind push/dev-phase via the workflow trigger AND
    # must not be reachable from a feature PR. The forge-tests workflow as a
    # whole is quick (unit/invariant run on feature PRs), so the coverage JOB
    # carries an explicit `if:` guard restricting it off feature PRs.
    if FORGE_TESTS_WORKFLOW_NAME in by_name:
        path, wf = by_name[FORGE_TESTS_WORKFLOW_NAME]
        cov = (wf.get("jobs", {}) or {}).get(FORGE_COVERAGE_JOB)
        if not isinstance(cov, dict):
            v.add(f"{path.name}: forge {FORGE_COVERAGE_JOB!r} job not found.")
        else:
            guard = str(cov.get("if", ""))
            if "pull_request" not in guard:
                v.add(
                    f"{path.name} job {FORGE_COVERAGE_JOB!r}: the heavy forge "
                    f"coverage gate must carry an `if:` guard excluding "
                    f"feature-branch pull_request events (e.g. only run on "
                    f"push / dev-phase-*)."
                )


def parse_doc_tier_table() -> dict[str, str]:
    """Parse the 'CI velocity tiers' table from ci-suites.md into {workflow_name: tier}."""
    if not CI_SUITES_DOC.exists():
        return {}
    text = CI_SUITES_DOC.read_text()
    mapping: dict[str, str] = {}
    in_section = False
    for line in text.splitlines():
        if line.strip().lower().startswith("## ci velocity tiers"):
            in_section = True
            continue
        if in_section and line.startswith("## ") and "velocity" not in line.lower():
            break
        if in_section and line.strip().startswith("|"):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) < 2:
                continue
            wf_name = cells[0].strip("`")
            tier = cells[1].lower()
            if wf_name in ("workflow `name:`", "workflow", "---") or wf_name.startswith("-"):
                continue
            if "quick" in tier or "heavy" in tier:
                mapping[wf_name] = "heavy" if "heavy" in tier else "quick"
    return mapping


def check_doc_sync(workflows: dict[Path, dict], v: Violations) -> None:
    doc_tiers = parse_doc_tier_table()
    if not doc_tiers:
        v.add(
            "docs/development/ci-suites.md: missing the 'CI velocity tiers' table "
            "mapping each workflow name to quick|heavy."
        )
        return
    actual_names = {wf.get("name") for wf in workflows.values() if wf.get("name")}
    for name in HEAVY_WORKFLOW_NAMES:
        if doc_tiers.get(name) != "heavy":
            v.add(
                f"docs/development/ci-suites.md: heavy suite {name!r} must be "
                f"documented as heavy in the CI velocity tiers table "
                f"(found {doc_tiers.get(name)!r})."
            )
    for name, tier in doc_tiers.items():
        if name not in actual_names:
            v.add(
                f"docs/development/ci-suites.md: tier table lists {name!r} but no "
                f"workflow declares that `name:`."
            )


def main() -> int:
    workflows = load_workflows()
    if not workflows:
        print(f"error: no workflows found under {WORKFLOW_DIR}", file=sys.stderr)
        return 2
    v = Violations()
    check_concurrency(workflows, v)
    check_devnet_matrices(workflows, v)
    check_rust_caching(workflows, v)
    check_tier_triggers(workflows, v)
    check_doc_sync(workflows, v)
    if v:
        print("CI workflow tier invariants FAILED:", file=sys.stderr)
        for item in v.items:
            print(f"  - {item}", file=sys.stderr)
        return 1
    print(f"OK: {len(workflows)} workflows satisfy all CI velocity tier invariants.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
