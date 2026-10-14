#!/usr/bin/env python3
"""Fail when a reusable-workflow call grants fewer token permissions than a called job asks for.

Canonical: docs/development/ci-suites.md section 29 (and section 13, step list).

A called workflow (workflow_call) can keep or lower its caller's GITHUB_TOKEN permissions, never
raise them. When a called job asks for a scope its caller job does not grant, GitHub refuses the
whole run as `startup_failure` before any job starts: no job goes red, the run just never happens.
That is how suite-29-nightly-twin-fork.yml never ran (7/7 startup_failure 2026-10-07..13, QA plan
v1 T1): it granted `contents: read` only and the suite-07 `parity` job asks for
`pull-requests: read`. actionlint does not check this.

For every job in .github/workflows/*.yml that calls a local workflow
(`uses: ./.github/workflows/X.yml`), every job of X must ask for no scope above what the caller
job grants. A job's permissions are its own `permissions:` block, else its workflow's top-level
block, else what its caller granted. Calls are followed through nested reusable workflows. A
caller with no permissions block at either level runs with the repository default, which this
check cannot read, so it is refused: declare the grant (issue #1428 least privilege).
Usage: check_reusable_workflow_permissions.py [--self-test]
Needs PyYAML (suite 13 installs it).
"""
import copy
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
LOCAL = "./.github/workflows/"
LEVEL = {"none": 0, "read": 1, "write": 2}
# Every GITHUB_TOKEN scope; `read-all` and `write-all` set each of them. A map leaves every scope
# it does not name at none.
SCOPES = (
    "actions", "attestations", "checks", "contents", "deployments", "discussions", "id-token",
    "issues", "models", "packages", "pages", "pull-requests", "repository-projects",
    "security-events", "statuses",
)


def perms(block) -> dict:
    """Normalise one `permissions:` value to {scope: level}, scopes at none left out."""
    if block is None or block == {}:
        return {}
    if isinstance(block, str):
        if block not in ("read-all", "write-all"):
            raise ValueError(f"unknown permissions shorthand {block!r}")
        return {s: block.split("-")[0] for s in SCOPES}
    if not isinstance(block, dict):
        raise ValueError(f"permissions must be a map or read-all/write-all, got {block!r}")
    out = {}
    for scope, level in block.items():
        if not isinstance(level, str) or level not in LEVEL:
            raise ValueError(f"permissions {scope}: {level!r} is not none, read or write")
        if level != "none":
            out[str(scope)] = level
    return out


def granted(job: dict, wf: dict, inherited):
    """The permissions a job runs with: its own block, else its workflow's, else its caller's."""
    if "permissions" in job:
        return perms(job["permissions"])
    if "permissions" in wf:
        return perms(wf["permissions"])
    return inherited


def triggers(wf: dict) -> set:
    # PyYAML reads the bare key `on` as the boolean True.
    on = wf.get("on", wf.get(True))
    if isinstance(on, str):
        return {on}
    return set(on or [])


def jobs(wf: dict) -> list:
    return list((wf.get("jobs") or {}).items())


def check(workflows: dict) -> list:
    """workflows maps a file name to its parsed YAML. Returns one message per problem."""
    errors = []
    calls = 0

    def visit(name: str, inherited, chain: list) -> None:
        nonlocal calls
        wf = workflows[name]
        for job_id, job in jobs(wf):
            target = job.get("uses") if isinstance(job, dict) else None
            if not isinstance(target, str):
                continue
            here = f"{name}:{job_id}"
            where = " -> ".join(chain + [here])
            if not target.startswith(LOCAL):
                errors.append(f"{where} calls {target}: only local reusable workflows can be checked")
                continue
            callee = target[len(LOCAL):]
            if callee not in workflows:
                errors.append(f"{where} calls {target}, which does not exist")
                continue
            if any(c.split(":")[0] == callee for c in chain + [here]):
                errors.append(f"{where} calls {callee} again: reusable workflow calls form a cycle")
                continue
            try:
                grant = granted(job, wf, inherited)
            except ValueError as e:
                errors.append(f"{where}: {e}")
                continue
            if grant is None:
                errors.append(
                    f"{where} calls {callee} but declares no permissions at job or workflow level, so it "
                    "runs with the repository default, which cannot be checked; declare the grant"
                )
                continue
            calls += 1
            cwf = workflows[callee]
            for cjob_id, cjob in jobs(cwf):
                try:
                    need = granted(cjob if isinstance(cjob, dict) else {}, cwf, grant)
                except ValueError as e:
                    errors.append(f"{callee}:{cjob_id}: {e}")
                    continue
                for scope, level in sorted(need.items()):
                    have = grant.get(scope, "none")
                    if LEVEL[level] > LEVEL[have]:
                        errors.append(
                            f"{where} grants {scope}: {have} but the called job {callee}:{cjob_id} asks for "
                            f"{scope}: {level}; GitHub refuses the run as startup_failure. Grant "
                            f"`{scope}: {level}` in the permissions of {here}"
                        )
            visit(callee, grant, chain + [here])

    # A workflow that only declares workflow_call is checked through its callers, with their grant.
    for name in sorted(workflows):
        if triggers(workflows[name]) - {"workflow_call"}:
            visit(name, None, [])
    if not workflows or calls == 0:
        errors.append("zero checks ran: no workflows found or no job calls a local reusable workflow")
    return list(dict.fromkeys(errors))


def load(directory: Path) -> dict:
    files = sorted([*directory.glob("*.yml"), *directory.glob("*.yaml")])
    return {p.name: yaml.safe_load(p.read_text()) or {} for p in files}


# ---------------------------------------------------------------- self-test


def workflow(perms_block=None, on=("push",), **job_map) -> dict:
    """A minimal workflow: `on`, an optional top-level permissions block, the given jobs."""
    out = {"on": {t: None for t in on}, "jobs": job_map}
    if perms_block is not None:
        out["permissions"] = perms_block
    return out


def call(target: str, permissions=None) -> dict:
    job = {"uses": LOCAL + target}
    if permissions is not None:
        job["permissions"] = permissions
    return job


def run(permissions=None) -> dict:
    job = {"runs-on": "ubuntu-latest", "steps": [{"run": "true"}]}
    if permissions is not None:
        job["permissions"] = permissions
    return job


def must_fail(errs: list, *needles: str) -> bool:
    return any(all(n in e for n in needles) for e in errs)


def self_test() -> int:
    real = load(WORKFLOWS)
    called = {"on": {"workflow_call": None}}
    cases = []

    def case(name):
        def register(fn):
            cases.append((name, fn))
            return fn
        return register

    @case("real_tree_passes")
    def _():
        errs = check(real)
        return not errs, errs

    @case("nightly_suite07_parity_needs_pull_requests_read")
    def _():
        # The 2026-10-07..13 startup_failure: drop the job-level grant from the nightly's suite-07 call.
        tree = copy.deepcopy(real)
        job = tree["suite-29-nightly-twin-fork.yml"]["jobs"]["suite-07"]
        if "permissions" not in job:
            return False, ["suite-29 suite-07 caller job has no permissions block to remove"]
        del job["permissions"]
        errs = check(tree)
        return must_fail(errs, "suite-29-nightly-twin-fork.yml:suite-07",
                         "suite-07-rmpc-integration.yml:parity", "pull-requests: read"), errs

    @case("caller_write_covers_called_read")
    def _():
        tree = {"a.yml": workflow({"contents": "write"}, a=call("b.yml")),
                "b.yml": dict(called, jobs={"j": run({"contents": "read"})})}
        errs = check(tree)
        return not errs, errs

    @case("called_write_above_caller_read_fails")
    def _():
        tree = {"a.yml": workflow({"contents": "read"}, a=call("b.yml")),
                "b.yml": dict(called, jobs={"j": run({"contents": "write"})})}
        errs = check(tree)
        return must_fail(errs, "a.yml:a", "b.yml:j", "contents: write"), errs

    @case("called_workflow_level_block_counts")
    def _():
        tree = {"a.yml": workflow({"contents": "read"}, a=call("b.yml")),
                "b.yml": dict(called, permissions={"issues": "read"}, jobs={"j": run()})}
        errs = check(tree)
        return must_fail(errs, "b.yml:j", "issues: read"), errs

    @case("caller_job_grant_overrides_workflow_grant")
    def _():
        tree = {"a.yml": workflow({"contents": "read"}, a=call("b.yml", {"contents": "read", "issues": "read"})),
                "b.yml": dict(called, jobs={"j": run({"issues": "read"})})}
        errs = check(tree)
        return not errs, errs

    @case("called_job_without_block_inherits")
    def _():
        tree = {"a.yml": workflow({"contents": "read"}, a=call("b.yml")),
                "b.yml": dict(called, jobs={"j": run(), "k": run({})})}
        errs = check(tree)
        return not errs, errs

    @case("nested_call_is_followed")
    def _():
        tree = {"a.yml": workflow({"contents": "read"}, a=call("b.yml")),
                "b.yml": dict(called, jobs={"mid": call("c.yml")}),
                "c.yml": dict(called, jobs={"deep": run({"contents": "read", "pull-requests": "read"})})}
        errs = check(tree)
        return must_fail(errs, "a.yml:a -> b.yml:mid", "c.yml:deep", "pull-requests: read"), errs

    @case("read_all_and_write_all_shorthands")
    def _():
        callee = dict(called, jobs={"j": run({"id-token": "write"})})
        low = check({"a.yml": workflow("read-all", a=call("b.yml")), "b.yml": callee})
        high = check({"a.yml": workflow("write-all", a=call("b.yml")), "b.yml": callee})
        return must_fail(low, "id-token: write") and not high, low + high

    @case("caller_without_any_block_is_refused")
    def _():
        tree = {"a.yml": workflow(None, a=call("b.yml")),
                "b.yml": dict(called, jobs={"j": run()})}
        errs = check(tree)
        return must_fail(errs, "a.yml:a", "declares no permissions"), errs

    @case("missing_callee_is_refused")
    def _():
        errs = check({"a.yml": workflow({"contents": "read"}, a=call("gone.yml"))})
        return must_fail(errs, "gone.yml", "does not exist"), errs

    @case("empty_scan_is_refused")
    def _():
        no_calls = check({"a.yml": workflow({"contents": "read"}, a=run())})
        return must_fail(check({}), "zero checks ran") and must_fail(no_calls, "zero checks ran"), no_calls

    failed = 0
    for name, fn in cases:
        good, detail = fn()
        print(("ok   - " if good else "FAIL - ") + name)
        if not good:
            failed += 1
            for line in detail:
                print("       ", line)
    if failed:
        print(f"self-test FAILED: {failed} of {len(cases)} cases")
        return 1
    print(f"self-test ok ({len(cases)} cases)")
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    errors = check(load(WORKFLOWS))
    for e in errors:
        print("ERROR:", e)
    if not errors:
        print("every reusable-workflow caller grants what its called jobs ask for")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
