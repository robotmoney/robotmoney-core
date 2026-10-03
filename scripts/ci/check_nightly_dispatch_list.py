#!/usr/bin/env python3
"""Fail when a suite workflow is missing from the nightly dispatch list.

Canonical: docs/development/ci-suites.md section 21.

Every .github/workflows/*.yml is either named in the SUITES array of
suite-21-nightly.yml or listed in EXCLUDED below with a reason.
Usage: check_nightly_dispatch_list.py [--self-test]
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
NIGHTLY = "suite-21-nightly.yml"
# Every other workflow file is dispatched by the nightly (the SUITES array), including
# config-check.yml and suite-28-core-stages.yml (both declare workflow_dispatch; the
# core-stages dispatch runs its offline job because its Twin chain inputs default empty).

# Workflows that must NOT be dispatched by the nightly, with the reason.
EXCLUDED = {
    NIGHTLY: "the orchestrator itself",
    "release-dapp.yml": "release workflow",
    "release-rmpc.yml": "release workflow",
    "release-tag-suite-dispatch.yml": "release workflow",
    "release-record.yml": "release workflow: requires a release tag input, dispatched by the release operator (issue 1497)",
    "nightly-third-party-drift.yml": "nightly job (c), shipped disabled: workflow_dispatch only, schedule commented out until the owner enables it (issue 1497)",
    "suite-29-nightly-fresh-snapshot.yml": "nightly (b) on its own schedule: it calls the chain suites itself with a fresh Base snapshot (issue 1496)",
    # Add a workflow that must not be dispatched here with its reason, for example one that
    # has no workflow_dispatch trigger or needs required inputs.
}


def dispatch_list(text: str) -> set:
    m = re.search(r"SUITES=\(\s*(.*?)\)", text, re.S)
    if not m:
        raise SystemExit("no SUITES=( ... ) array found in " + NIGHTLY)
    return set(re.findall(r"^\s*([\w.-]+\.ya?ml)\s*$", m.group(1), re.M))


def check(workflows: set, nightly_text: str) -> list:
    listed = dispatch_list(nightly_text)
    errors = []
    if not workflows or not listed:
        errors.append("zero checks ran: no workflows found or the nightly dispatch list is empty")
    for w in sorted(workflows - listed - set(EXCLUDED)):
        errors.append(f"{w} is not in the nightly dispatch list and not in EXCLUDED")
    for w in sorted(listed - workflows):
        errors.append(f"{w} is dispatched by the nightly but does not exist")
    for w in sorted(set(EXCLUDED) & listed - {NIGHTLY}):
        errors.append(f"{w} is in EXCLUDED but also dispatched")
    return errors


def self_test() -> int:
    text = (WORKFLOWS / NIGHTLY).read_text()
    wfs = {p.name for p in WORKFLOWS.glob("*.yml")}
    assert not check(wfs, text), "real tree must pass before the self-test"
    victim = sorted(dispatch_list(text))[0]
    broken = re.sub(r"^\s*" + re.escape(victim) + r"\s*\n", "", text, count=1, flags=re.M)
    errs = check(wfs, broken)
    if not any(victim in e for e in errs):
        print("self-test FAILED: removing", victim, "was not detected")
        return 1
    errs = check(wfs | {"suite-99-new.yml"}, text)
    if not any("suite-99-new.yml" in e for e in errs):
        print("self-test FAILED: a new suite was not detected")
        return 1
    if not check(set(), text) or not check(wfs, "SUITES=(\n)\n"):
        print("self-test FAILED: an empty scan was not rejected")
        return 1
    print("self-test ok")
    return 0


def main() -> int:
    if "--self-test" in sys.argv:
        return self_test()
    wfs = {p.name for p in WORKFLOWS.glob("*.yml")}
    errors = check(wfs, (WORKFLOWS / NIGHTLY).read_text())
    for e in errors:
        print("ERROR:", e)
    if not errors:
        print("nightly dispatch list covers every suite workflow")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
