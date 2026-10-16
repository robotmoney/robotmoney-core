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
6. uses-unpinned: a job that holds any write scope (`contents`, `id-token`,
   `attestations`, `packages`, ...) runs a `uses:` that is not pinned to a
   full 40-hex commit (a local `./` action and a `docker://...@sha256:` digest
   also count as pinned). A tag or branch ref can be moved upstream, and the
   moved code then runs inside the job that signs, publishes or pushes —
   release-rmpc.yml's build job attests the archive it built, so a moved
   action there could swap the binary and have the swap attested.
7. attest-ungated: an `actions/attest-build-provenance` step does not run
   under exactly `github.event_name == 'push' && startsWith(github.ref,
   'refs/tags/<prefix>')`. Any other condition (none, a dry run, an `||`)
   lets a writer who can dispatch the workflow or push a branch mint a
   genuine Sigstore attestation for whatever that run built, which the
   installer (scripts/release/install-rmpc.sh) would otherwise have to tell
   apart from the release by certificate fields alone.
8. attest-cache: a job that runs `actions/attest-build-provenance` restores or
   saves an Actions cache (Swatinem/rust-cache, actions/cache and its
   restore/save halves, sccache's GitHub cache, a truthy `cache:` input,
   actions/setup-go's default cache, or a `cache-from`/`cache-to` of
   `type=gha`), whatever its `if:`. A cache key holds no ref or trigger, a
   tag-push run restores from dev's scope, and any writer can get a run on dev
   to save one, so the cached bytes are linked into the binary the tag push
   then attests. The attesting job restores no cache at all.
9. cross-image: a job that runs `actions/attest-build-provenance` builds with
   `cross` for a target whose image is not pinned by `@sha256:<64 hex>` in the
   repository's Cross.toml (`[target.<triple>] image`), or that the audit
   cannot resolve, or the workflow sets a `CROSS_TARGET_<T>_IMAGE` that is not
   digest-pinned or a `CROSS_CONFIG`. Without a pin, cross links inside
   ghcr.io/cross-rs/<target>:<version>, a tag whoever controls it upstream can
   move to an image with a trojan linker or sysroot, and the job then attests
   that build. The `uses:` pin rule above never sees it: it is a Docker pull,
   not a `uses:` line.
10. anchor: the parser could not locate the piece of structure a finding above
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

# A `uses:` line (step-level or a job-level reusable-workflow call), with an
# optional trailing comment that carries the pinned version.
USES_LINE = re.compile(r"^\s*(?:-\s+)?uses:\s*(['\"]?)(\S+?)\1\s*(?:#.*)?$")
# What counts as pinned: a full commit SHA, a local action, or an image digest.
PINNED_USES = re.compile(
    r"^(?:\./\S*"
    r"|docker://\S+@sha256:[0-9a-f]{64}"
    r"|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:/\S*)?@[0-9a-f]{40})$"
)
ATTEST_ACTION = re.compile(r"^actions/attest-build-provenance@")
# The only condition an attest step may run under: the push of a release tag.
ATTEST_IF = re.compile(
    r"^github\.event_name == 'push' && startsWith\(github\.ref, 'refs/tags/[A-Za-z0-9._/-]+'\)$"
)

# Rule 8: what restores or saves an Actions cache. actions/setup-go caches by
# default unless its step says `cache: false`.
CACHE_USES = re.compile(
    r"^(?:Swatinem/rust-cache|actions/cache(?:/restore|/save)?|mozilla-actions/sccache-action)@"
)
SETUP_GO_USES = re.compile(r"^actions/setup-go@")
CACHE_INPUT = re.compile(r"^\s*cache:\s*(['\"]?)(.*?)\1\s*(?:#.*)?$")
CACHE_GHA = re.compile(r"^\s*cache-(?:from|to):.*\btype=gha\b")
SCCACHE_GHA = re.compile(r"\bSCCACHE_GHA_ENABLED\b")

# Rule 9: a `cross` build in a run: body (after backslash continuations are
# joined), and the image a Cross.toml or an env var names.
CROSS_CMD = re.compile(
    r"(?:^|[\s;&|(`])cross\s+(?:\+\S+\s+)?(?:build|b|rustc|check|c|test|t|run|r|bench|doc|install)\b"
)
CROSS_TARGET_ARG = re.compile(r"--target(?:=|\s+)(\$\{\{.*?\}\}|\S+)")
DIGEST_PINNED_IMAGE = re.compile(r"^\S+@sha256:[0-9a-f]{64}$")
CROSS_IMAGE_ENV = re.compile(r"^\s*(CROSS_TARGET_[A-Z0-9_]+_IMAGE):\s*(['\"]?)(.*?)\2\s*(?:#.*)?$")
CROSS_CONFIG_ENV = re.compile(r"^\s*CROSS_CONFIG:")


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


def step_condition(lines, uses_at):
    """The `if:` of the step whose `uses:` sits at uses_at, or None.

    Walks back to the step's own `- ` line, then forward through the step's
    keys until a line at or above the step's indent. The condition is returned
    with YAML quotes and a `${{ }}` wrapper removed and whitespace collapsed.
    """
    k = uses_at
    while k > 0 and not lines[k].lstrip().startswith("- "):
        k -= 1
    step_indent = indent(lines[k])
    for j in range(k, len(lines)):
        cur = lines[j]
        if j > k and not is_blank(cur) and indent(cur) <= step_indent:
            break
        m = re.match(r"\s*(?:-\s+)?if:\s*(\S.*?)\s*$", cur)
        if m and (j == k or indent(cur) == step_indent + 2):
            cond = m.group(1)
            if len(cond) >= 2 and cond[0] == cond[-1] and cond[0] in "\"'":
                cond = cond[1:-1]
            wrapped = re.match(r"^\$\{\{(.*)\}\}$", cond.strip())
            if wrapped:
                cond = wrapped.group(1)
            return " ".join(cond.split())
    return None


def step_span(lines, at):
    """[first, end) of the step that holds line `at`: back to its `- ` line,
    forward to the first line at or above that indent."""
    k = at
    while k > 0 and not lines[k].lstrip().startswith("- "):
        k -= 1
    step_indent = indent(lines[k])
    j = k + 1
    while j < len(lines):
        if not is_blank(lines[j]) and indent(lines[j]) <= step_indent:
            break
        j += 1
    return k, j


def _scalar(value):
    value = re.sub(r"\s+#.*$", "", value).strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        value = value[1:-1]
    return value


def matrix_targets(lines, start, end):
    """The `target:` of each strategy.matrix.include entry in lines[start:end].

    When any entry carries a `cross:` key, only the entries it marks `true`
    count. None when there is no include list to read, so a caller fails
    closed rather than treating "could not tell" as "no target".
    """
    inc = next((k for k in range(start, end) if re.match(r"^\s*include:\s*$", lines[k])), None)
    if inc is None:
        return None
    base = indent(lines[inc])
    entries, cur, item_indent = [], None, None
    for k in range(inc + 1, end):
        line = lines[k]
        if is_blank(line):
            continue
        if indent(line) <= base:
            break
        m = re.match(r"^(\s*)-\s+([A-Za-z_][\w-]*):\s*(.*?)\s*$", line)
        if m and (item_indent is None or len(m.group(1)) == item_indent):
            item_indent = len(m.group(1))
            cur = {m.group(2): _scalar(m.group(3))}
            entries.append(cur)
            continue
        m = re.match(r"^\s*([A-Za-z_][\w-]*):\s*(.*?)\s*$", line)
        if m and cur is not None:
            cur[m.group(1)] = _scalar(m.group(2))
    if not entries:
        return None
    if any("cross" in e for e in entries):
        entries = [e for e in entries if e.get("cross") == "true"]
    return {e["target"] for e in entries if e.get("target")}


def cross_images(text):
    """{target: image} from a Cross.toml, or None when it cannot be read."""
    try:
        import tomllib  # Python 3.11+

        data = tomllib.loads(text)
    except Exception:  # noqa: BLE001 — unreadable means unpinned, never "nothing to check"
        return None
    out = {}
    targets = data.get("target")
    for t, cfg in (targets.items() if isinstance(targets, dict) else []):
        image = cfg.get("image") if isinstance(cfg, dict) else None
        if isinstance(image, dict):
            image = image.get("name")
        if isinstance(image, str):
            out[t] = image
    return out


def attest_job_cache(lines, job, start, end):
    """Rule 8: every cache step inside an attesting job, whatever its `if:`."""
    out = []
    for at in range(start, end):
        line = lines[at]
        if is_blank(line):
            continue
        um = USES_LINE.match(line)
        what = None
        if um and CACHE_USES.match(um.group(2)):
            what = um.group(2)
        elif um and SETUP_GO_USES.match(um.group(2)):
            s0, s1 = step_span(lines, at)
            off = any(
                (m := CACHE_INPUT.match(lines[k])) and m.group(2).lower() == "false"
                for k in range(s0, s1)
            )
            if not off:
                what = "%s, which caches unless its step says cache: false" % um.group(2)
        elif (m := CACHE_INPUT.match(line)) and m.group(2).lower() not in ("false", ""):
            what = "a 'cache: %s' input" % m.group(2)
        elif CACHE_GHA.match(line):
            what = line.strip()
        elif SCCACHE_GHA.search(line):
            what = "SCCACHE_GHA_ENABLED"
        if what:
            out.append(
                "attest-cache: job '%s' runs actions/attest-build-provenance and "
                "restores or saves an Actions cache at line %d (%s) — a cache key "
                "holds no ref or trigger, a tag-push run restores from dev's scope, "
                "and any writer can get a run there to save one, so its bytes "
                "would be linked into the binary the tag push attests"
                % (job, at + 1, what)
            )
    return out


def attest_job_cross(lines, job, start, end, cross_toml):
    """Rule 9: every `cross` build inside an attesting job must use an image
    pinned by digest."""
    builds = []  # (line number, the command text with continuations joined)
    buf = ""
    for at in range(start, end):
        text = lines[at].strip()
        if not text or text.startswith("#"):
            continue
        um = USES_LINE.match(lines[at])
        if um and re.search(r"/actions-rust-cross@", um.group(2)):
            s0, s1 = step_span(lines, at)
            target = next(
                (_scalar(m.group(1)) for k in range(s0, s1)
                 if (m := re.match(r"^\s*target:\s*(.*?)\s*$", lines[k]))),
                "",
            )
            builds.append((at, "cross build --target %s" % target if target else "cross build"))
            continue
        if text.endswith("\\"):
            buf += text[:-1] + " "
            continue
        cmd, buf = buf + text, ""
        if CROSS_CMD.search(cmd):
            builds.append((at, cmd))
    if not builds:
        return []

    out = []
    where = lambda at: "job '%s' line %d" % (job, at + 1)  # noqa: E731
    for k, line in enumerate(lines):
        m = CROSS_IMAGE_ENV.match(line)
        if m and not DIGEST_PINNED_IMAGE.match(m.group(3)):
            out.append(
                "cross-image: %s at line %d overrides a Cross.toml image with '%s', "
                "which is not pinned by @sha256 digest, and a job that attests runs "
                "cross" % (m.group(1), k + 1, m.group(3))
            )
        if CROSS_CONFIG_ENV.match(line):
            out.append(
                "cross-image: CROSS_CONFIG at line %d points cross at a config this "
                "audit does not read, and a job that attests runs cross" % (k + 1)
            )
    images = cross_images(cross_toml) if cross_toml is not None else {}
    if images is None:
        out.append(
            "cross-image: %s runs cross, and Cross.toml cannot be read, so no "
            "target's image can be shown pinned" % where(builds[0][0])
        )
        images = {}
    for at, cmd in builds:
        m = CROSS_TARGET_ARG.search(cmd)
        arg = m.group(1) if m else ""
        if re.fullmatch(r"\$\{\{\s*matrix\.target\s*\}\}", arg):
            targets = matrix_targets(lines, start, end)
        elif arg and "${{" not in arg:
            targets = {arg}
        else:
            targets = None
        if not targets:
            out.append(
                "cross-image: %s runs cross for a target this audit cannot "
                "resolve ('%s'), so its image cannot be shown pinned" % (where(at), arg or "<no --target>")
            )
            continue
        for t in sorted(targets):
            image = images.get(t)
            if not image or not DIGEST_PINNED_IMAGE.match(image):
                out.append(
                    "cross-image: %s builds %s with cross, and Cross.toml pins no "
                    "[target.%s] image by @sha256 digest (it names '%s') — cross "
                    "then links inside ghcr.io/cross-rs/%s:<version>, a tag that "
                    "can be moved upstream, in the job that attests the result"
                    % (where(at), t, t, image or "<none>", t)
                )
    return out


def audit(lines, may_write_contents, workflow_scope_only=False, cross_toml=None):
    """`cross_toml` is the text of the repository's Cross.toml, or None when
    there is none (rule 9 then finds no pinned image)."""
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

    if workflow_scope_only:
        # Issue #1428: the floor applied to EVERY workflow file. Only the
        # workflow-scope check above runs; per-job blocks, writer jobs and
        # run-splice are the strict mode's business (release workflows).
        if not any(line == "jobs:" for line in lines):
            findings.append(
                "anchor: no top-level 'jobs:' key — this is not a workflow "
                "the audit can vouch for"
            )
        return findings

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
            write_scopes = sorted(k for k, v in (perms or {}).items() if v == "write")
            for at in range(i + 1, j):
                um = USES_LINE.match(lines[at])
                if not um:
                    continue
                ref = um.group(2)
                if write_scopes and not PINNED_USES.match(ref):
                    findings.append(
                        "uses-unpinned: job '%s' holds %s and runs '%s' at "
                        "line %d, which is not pinned to a full commit SHA — "
                        "a moved upstream tag or branch would run inside the "
                        "job that holds that authority"
                        % (job, ", ".join("%s: write" % k for k in write_scopes), ref, at + 1)
                    )
                if ATTEST_ACTION.match(ref):
                    cond = step_condition(lines, at)
                    if cond is None or not ATTEST_IF.match(cond):
                        findings.append(
                            "attest-ungated: the build-provenance attestation "
                            "step at line %d in job '%s' runs under '%s', not "
                            "exactly github.event_name == 'push' && "
                            "startsWith(github.ref, 'refs/tags/<prefix>') — any "
                            "writer who can dispatch this workflow or push a "
                            "branch would mint a genuine attestation for "
                            "whatever that run built"
                            % (at + 1, job, cond if cond is not None else "<no if:, every run>")
                        )
            attests = any(
                (um := USES_LINE.match(lines[at])) and ATTEST_ACTION.match(um.group(2))
                for at in range(i + 1, j)
            )
            if attests:
                findings.extend(attest_job_cache(lines, job, i + 1, j))
                findings.extend(attest_job_cross(lines, job, i + 1, j, cross_toml))
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
        "--workflow-scope-only",
        action="store_true",
        dest="workflow_scope_only",
        help="run only the perms-default check (top-level permissions: "
        "present and not contents: write); the floor CI applies to every "
        "workflow file (issue #1428)",
    )
    parser.add_argument(
        "--extract-step",
        dest="extract_step",
        default=None,
        help="instead of auditing, print the named step's dedented run: | "
        "body to stdout (refuses if it still splices a non-matrix/runner "
        "expression)",
    )
    parser.add_argument(
        "--cross-toml",
        dest="cross_toml",
        type=pathlib.Path,
        default=None,
        help="the Cross.toml rule 9 reads (default: <repo>/Cross.toml when the "
        "workflow sits in <repo>/.github/workflows/, else none)",
    )
    args = parser.parse_args()

    lines = args.workflow.read_text().splitlines()

    if args.extract_step is not None:
        sys.stdout.write(extract_step(lines, args.extract_step))
        return 0

    cross_path = args.cross_toml
    wf_dir = args.workflow.resolve().parent
    if cross_path is None and wf_dir.name == "workflows" and wf_dir.parent.name == ".github":
        cross_path = wf_dir.parent.parent / "Cross.toml"
    cross_toml = cross_path.read_text() if cross_path is not None and cross_path.is_file() else None

    findings = audit(lines, set(args.writer_jobs), args.workflow_scope_only, cross_toml)
    sys.stdout.write("".join(f + "\n" for f in findings))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
