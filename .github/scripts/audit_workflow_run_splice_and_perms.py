#!/usr/bin/env python3
"""audit_workflow_run_splice_and_perms.py — structural authority auditor for a
GitHub Actions workflow file.

Canonical: .github/workflows/release-dapp.yml, .github/workflows/release-rmpc.yml
Issues: #1237 (the defect, first fixed in release-rmpc.yml), #1301 (this
generalized, reusable auditor — release-dapp.yml had both of #1237's defects
and no selftest harness of its own).

WHY THIS EXISTS AS A STANDALONE, PARAMETERIZED SCRIPT
release-rmpc.yml already carries a structural auditor of this exact shape,
embedded in scripts/release/install-rmpc-selftest.sh (`audit-workflow.py` /
`hostile_audit()` / `mutate-authority.py`). That auditor hardcodes rmpc's job
names (`publish`, `bump-manifest` as the only jobs allowed `contents: write`)
and rmpc's own mutation fixtures, inside a 2000+ line file whose name, header
comments and every fixture already say "rmpc". Generalizing it in place would
have meant threading a second workflow path and a second writer-job set
through a script that is already dense and deliberately rmpc-specific by
design (see its own header). So this is a NEW, small, parameterized script:
it audits ANY workflow file against ANY caller-supplied set of jobs allowed to
hold `contents: write`, and both release-dapp.yml and release-rmpc.yml can be
pointed at it (see .github/scripts/tests/test_audit_workflow_run_splice_and_perms.sh,
which exercises both) without either workflow's selftest owning the other's
fixtures.

WHAT IT CHECKS
1. perms-default: the workflow declares no top-level `permissions:` block, or
   grants `contents: write` at workflow scope. Either way every job inherits
   it, including a job added to the file later that never asked for it.
2. perms-missing: a job declares no `permissions:` block of its own, so its
   authority is inherited rather than stated where it is reviewed.
3. perms-write: a job holds `contents: write` but is not one of the
   caller-declared writer jobs (--writer-job).
4. perms-cannot-publish: a declared writer job does NOT actually hold
   `contents: write` — the other side of (3): an auditor that only ever says
   "nothing may write" is satisfied by a workflow that lost the authority to
   release at all, which would be green here and broken in production.
5. run-splice: a `run:` body (comments included — Actions substitutes into
   the body's plain text, not just its executable lines) interpolates a
   `${{ }}` expression other than `matrix.*` / `runner.*`. Those two prefixes
   are literals from the workflow's own matrix and runner, so neither can
   carry a caller's string; every other expression — `inputs.*`,
   `github.event.*`, `needs.*.outputs.*` (derived FROM inputs), `secrets.*` —
   has to reach the shell through a step's own `env:` as data, never as
   source text.
6. anchor: the parser could not locate the piece of structure a finding above
   depends on (no exactly-one `jobs:` key, a declared writer job that does
   not exist, no `run:` blocks at all). An auditor that cannot find what it is
   auditing must never look like an auditor that found nothing wrong, so this
   is a hard finding, not a silent skip.

Structural, not a grep: `contents: write` and `${{ inputs.tag }}` both appear
in this repo's prose and comments too (including this file's own docstring).
What matters is which JOB a permissions map lands in and which `run:` body an
expression sits inside, which only the YAML nesting can say. PyYAML is not a
dependency of this repo's CI, so nesting is walked with the same indentation
tracking release-rmpc.yml's own extractor uses, not a real YAML parser.

Prints one finding per line, tagged so a caller can grep for the exact shape
it means. No output means clean.
"""
import argparse
import pathlib
import re
import sys

# The only expressions allowed inside a `run:` body. Keep this list closed:
# the value of the guard is that a new expression is refused until someone
# decides it is safe to read directly rather than through env:.
RUN_ALLOWED_PREFIXES = ("matrix.", "runner.")

EXPR = re.compile(r"\$\{\{([^}]*)\}\}")


def indent(line):
    return len(line) - len(line.lstrip())


def is_blank(line):
    return not line.strip() or line.lstrip().startswith("#")


def mapping_at(lines, start, base_indent):
    """Read a `key: value` mapping whose entries sit deeper than base_indent."""
    out = {}
    k = start
    while k < len(lines):
        line = lines[k]
        if is_blank(line):
            k += 1
            continue
        if indent(line) <= base_indent:
            break
        m = re.match(r"\s*([A-Za-z][\w-]*):\s*(\S+)\s*$", line)
        if m:
            out[m.group(1)] = m.group(2)
        k += 1
    return out


def job_permissions(lines, job):
    """Return the `permissions:` mapping declared directly under jobs.<job>,
    or None if the job declares no such block. `line_of` is the 0-based index
    of the job's own key line, or None if the job does not exist."""
    line_of = None
    for i, line in enumerate(lines):
        if line == "  %s:" % job:
            line_of = i
            break
    if line_of is None:
        return None, None
    j = line_of + 1
    perms = None
    while j < len(lines):
        cur = lines[j]
        if not is_blank(cur) and indent(cur) <= 2:
            break
        if re.match(r"^    permissions:\s*$", cur):
            perms = mapping_at(lines, j + 1, 4)
        j += 1
    return perms, line_of


def audit(lines, may_write_contents):
    findings = []

    # ---- workflow-scope permissions ----------------------------------------
    workflow_perms = None
    for i, line in enumerate(lines):
        if line == "permissions:":
            workflow_perms = mapping_at(lines, i + 1, 0)
            break

    if workflow_perms is None:
        findings.append(
            "perms-default: the workflow declares no top-level permissions: "
            "block, so every job falls back to the repository's default "
            "GITHUB_TOKEN scopes — which can be read-write, and is decided "
            "outside this file"
        )
    elif workflow_perms.get("contents") == "write":
        findings.append(
            "perms-default: the workflow-scope permissions: block grants "
            "contents: write, which every job inherits — including any job "
            "added to this file later that never asked for it"
        )

    # ---- per-job permissions ------------------------------------------------
    jobs_at = [i for i, line in enumerate(lines) if line == "jobs:"]
    if len(jobs_at) != 1:
        findings.append(
            "anchor: expected exactly one top-level 'jobs:' key, found %d"
            % len(jobs_at)
        )
        jobs_at = []

    seen_jobs = []
    for start in jobs_at:
        i = start + 1
        while i < len(lines):
            line = lines[i]
            if is_blank(line):
                i += 1
                continue
            if indent(line) == 0:
                break
            m = re.match(r"^  ([A-Za-z][\w-]*):\s*$", line)
            if not m:
                i += 1
                continue
            job = m.group(1)
            seen_jobs.append(job)
            perms, _ = job_permissions(lines, job)
            if perms is None:
                findings.append(
                    "perms-missing: job '%s' declares no permissions: block, "
                    "so its authority is inherited rather than stated where "
                    "it is reviewed" % job
                )
            elif perms.get("contents") == "write" and job not in may_write_contents:
                findings.append(
                    "perms-write: job '%s' is granted contents: write and is "
                    "not one of the declared writer jobs %s"
                    % (job, sorted(may_write_contents))
                )
            # advance past this job's block
            j = i + 1
            while j < len(lines):
                cur = lines[j]
                if not is_blank(cur) and indent(cur) <= 2:
                    break
                j += 1
            i = j

    if not seen_jobs:
        findings.append("anchor: no jobs found under 'jobs:' — the audit would be vacuous")

    # Non-vacuity from the other side: a declared writer job must actually
    # hold contents: write, or the least-privilege findings above are passing
    # on a workflow that lost the authority to release at all.
    for job in sorted(may_write_contents):
        if job not in seen_jobs:
            findings.append(
                "anchor: declared writer job '%s' does not exist in this "
                "workflow — --writer-job is stale or misspelled" % job
            )
            continue
        perms, _ = job_permissions(lines, job)
        if (perms or {}).get("contents") != "write":
            findings.append(
                "perms-cannot-publish: job '%s' does not hold contents: "
                "write, so it cannot perform the write it is declared to "
                "need" % job
            )

    # ---- every run: body, scanned for interpolated expressions -------------
    # The scan covers comment lines inside a body on purpose. Actions
    # substitutes an expression wherever it appears in the run string,
    # comments included, and a value carrying a newline ends the comment and
    # starts a command.
    def report_splice(text, where):
        for raw in EXPR.findall(text):
            key = raw.strip()
            if key.startswith(RUN_ALLOWED_PREFIXES):
                continue
            findings.append(
                "run-splice: '${{ %s }}' is interpolated into the run: body "
                "at %s — Actions substitutes it into the shell SOURCE before "
                "bash parses it, so quoting at the call site cannot contain "
                "it. Pass it through the step's env: and read it as a shell "
                "variable" % (key, where)
            )

    i = 0
    run_blocks = 0
    while i < len(lines):
        m = re.match(r"(\s*)run:\s*(.*)$", lines[i])
        if not m:
            i += 1
            continue
        run_indent, inline = len(m.group(1)), m.group(2).strip()
        run_blocks += 1
        where = "line %d" % (i + 1)
        if inline in ("|", ">", "|-", ">-", "|+", ">+"):
            body = []
            j = i + 1
            while j < len(lines):
                cur = lines[j]
                if cur.strip() and indent(cur) <= run_indent:
                    break
                body.append(cur)
                j += 1
            report_splice("\n".join(body), where)
            i = j
        else:
            report_splice(inline, where)
            i += 1

    if run_blocks == 0:
        findings.append("anchor: no run: blocks found — the splice scan would be vacuous")

    return findings


def extract_step(lines, step_name):
    """Return the dedented `run: |` body of the named step.

    Refuses (raises SystemExit) rather than returning mangled text if: the
    step name is missing or ambiguous, the step has no `run: |` block, or the
    body still contains a `${{ }}` expression other than matrix./runner. — a
    step that reads inputs.* only through its own env: has none left to
    substitute, so a survivor here means the file is not the shape this
    extractor is allowed to execute.
    """
    pattern = re.compile(r"\s*-\s+name:\s+" + re.escape(step_name) + r"\s*$")
    matches = [i for i, line in enumerate(lines) if pattern.match(line)]
    if len(matches) != 1:
        sys.exit(
            "step '%s' matches %d occurrences — refusing to extract an "
            "ambiguous or missing step" % (step_name, len(matches))
        )
    i = matches[0]
    base = indent(lines[i])
    body = []
    j = i + 1
    while j < len(lines):
        cur = lines[j]
        if cur.strip() and indent(cur) <= base:
            break
        body.append(cur)
        j += 1
    for k, cur in enumerate(body):
        if re.match(r"\s*run:\s*\|\s*$", cur):
            run_indent = indent(cur)
            block = []
            for nxt in body[k + 1:]:
                if nxt.strip() and indent(nxt) <= run_indent:
                    break
                block.append(nxt)
            while block and not block[-1].strip():
                block.pop()
            if not block:
                sys.exit("step '%s' has an empty run: | block" % step_name)
            pad = min(indent(b) for b in block if b.strip())
            text = "\n".join(b[pad:] if b.strip() else "" for b in block) + "\n"
            for raw in EXPR.findall(text):
                key = raw.strip()
                if not key.startswith(RUN_ALLOWED_PREFIXES):
                    sys.exit(
                        "step '%s' still splices '${{ %s }}' into its run: "
                        "body — refusing to extract and execute a body this "
                        "auditor would flag as run-splice" % (step_name, key)
                    )
            return text
    sys.exit("step '%s' has no 'run: |' block" % step_name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workflow", type=pathlib.Path)
    parser.add_argument(
        "--writer-job",
        action="append",
        default=[],
        dest="writer_jobs",
        help="job name allowed to declare contents: write (repeatable)",
    )
    parser.add_argument(
        "--extract-step",
        dest="extract_step",
        default=None,
        help="instead of auditing, print the named step's dedented run: | "
        "body to stdout (refuses if it still splices a non-matrix/runner "
        "expression)",
    )
    args = parser.parse_args()

    lines = args.workflow.read_text().splitlines()

    if args.extract_step is not None:
        sys.stdout.write(extract_step(lines, args.extract_step))
        return 0

    findings = audit(lines, set(args.writer_jobs))
    sys.stdout.write("".join(f + "\n" for f in findings))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
