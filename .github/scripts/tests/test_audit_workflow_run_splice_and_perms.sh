#!/usr/bin/env bash
# Guard exercise for .github/scripts/audit_workflow_run_splice_and_perms.py
#
# Canonical: .github/scripts/audit_workflow_run_splice_and_perms.py,
# .github/workflows/release-dapp.yml, .github/workflows/release-rmpc.yml
# Issues: #1237 (the defect), #1301 (this test, and the generalized auditor
# it exercises — release-dapp.yml had both of #1237's defects and no
# selftest of its own; the auditor that already existed for release-rmpc.yml
# lives inside scripts/release/install-rmpc-selftest.sh and hardcodes rmpc's
# job names, so it was not pointed at release-dapp.yml directly — see that
# auditor's own module docstring for the full reasoning).
#
# WHY THIS EXISTS
# An auditor that always prints nothing wrong is indistinguishable, from a
# green CI check, from an auditor with no teeth. Every finding class the
# auditor can report is therefore proved REACHABLE here: built by mutating a
# real copy of the workflow it is meant to protect, run back through the SAME
# parser, and asserted present. The auditor is exercised against BOTH
# release-dapp.yml and release-rmpc.yml — proving it is the workflow-agnostic
# tool its module docstring claims to be, not a second copy of the rmpc-only
# auditor with the serial numbers filed off.
#
# No network: every fixture is a mutated copy of a real, already-checked-in
# workflow file, built with a small parameterized mutator.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
AUDITOR="${REPO_ROOT}/.github/scripts/audit_workflow_run_splice_and_perms.py"
DAPP_WORKFLOW="${REPO_ROOT}/.github/workflows/release-dapp.yml"
RMPC_WORKFLOW="${REPO_ROOT}/.github/workflows/release-rmpc.yml"

command -v python3 >/dev/null 2>&1 || {
  echo "FATAL: required tool 'python3' is not installed — refusing to skip." >&2
  exit 1
}
[[ -f "$AUDITOR" ]] || { echo "FATAL: $AUDITOR is missing." >&2; exit 1; }
[[ -f "$DAPP_WORKFLOW" ]] || { echo "FATAL: $DAPP_WORKFLOW is missing." >&2; exit 1; }
[[ -f "$RMPC_WORKFLOW" ]] || { echo "FATAL: $RMPC_WORKFLOW is missing." >&2; exit 1; }

# A case that stops being REACHED is indistinguishable from one that passes,
# so the count of assertions actually executed is asserted too. Raise this
# together with any case you add; lowering it is how coverage disappears
# quietly.
MIN_EXPECTED_ASSERTIONS=39

PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

WORKDIR="$(mktemp -d -t audit-workflow-selftest.XXXXXX)"
trap 'rm -rf "$WORKDIR"' EXIT

audit() {
  # $1 workflow path, remaining args are --writer-job values
  local wf="$1"
  shift
  local -a writer_args=()
  for j in "$@"; do
    writer_args+=(--writer-job "$j")
  done
  python3 "$AUDITOR" "$wf" "${writer_args[@]}"
}

# ---------- the auditor is clean on both real, already-fixed workflows ------
echo "--- selftest: the auditor is clean on the real, already-fixed workflows ---"

DAPP_CLEAN="$(audit "$DAPP_WORKFLOW" build-and-push)"
if [[ -z "$DAPP_CLEAN" ]]; then
  pass "release-dapp.yml audits clean (writer job: build-and-push)"
else
  fail "release-dapp.yml is not clean: $DAPP_CLEAN"
fi

RMPC_CLEAN="$(audit "$RMPC_WORKFLOW" publish bump-manifest)"
if [[ -z "$RMPC_CLEAN" ]]; then
  pass "release-rmpc.yml audits clean (writer jobs: publish, bump-manifest) — the same parser, a second workflow, proving this is not a dapp-only checker"
else
  fail "release-rmpc.yml is not clean: $RMPC_CLEAN"
fi

# ---------- a workflow with the wrong writer-job set is refused, not silently trusted ----------
echo ""
echo "--- selftest: a stale/misspelled --writer-job is refused, never silently accepted ---"

STALE_JOB="$(audit "$DAPP_WORKFLOW" build-and-push does-not-exist)"
if grep -q "^anchor: declared writer job 'does-not-exist' does not exist" <<<"$STALE_JOB"; then
  pass "a --writer-job naming a job absent from the workflow is refused as an anchor error"
else
  fail "a nonexistent --writer-job was not flagged (findings: ${STALE_JOB:-<none>})"
fi

MISSING_WRITER="$(audit "$DAPP_WORKFLOW")"
if grep -q "^perms-write: job 'build-and-push'" <<<"$MISSING_WRITER"; then
  pass "omitting the real writer job from --writer-job reports perms-write — a job holding contents: write outside the declared set is never silently accepted"
else
  fail "omitting build-and-push from --writer-job did not report perms-write (findings: ${MISSING_WRITER:-<none>})"
fi

# ---------- mutator: put each defect back into a real copy, prove it's caught ----------
# mutate_workflow.py takes: <src> <dst> <mutation> [job-name]
# Anchored on the real file's own structure — a mutation whose anchor has
# moved exits non-zero and says so, so a fixture can never quietly stop
# reintroducing the defect it exists to reintroduce and leave its assertion
# green over nothing.
MUTATOR_PY="$WORKDIR/mutate_workflow.py"
cat > "$MUTATOR_PY" <<'PY'
import pathlib
import re
import sys

src, dst, mutation = sys.argv[1], sys.argv[2], sys.argv[3]
arg = sys.argv[4] if len(sys.argv) > 4 else None
lines = pathlib.Path(src).read_text().splitlines(True)


def find_exact(text):
    for i, line in enumerate(lines):
        if line.rstrip("\n") == text:
            return i
    sys.exit("anchor not found: %r — this fixture's anchor has moved" % text)


def insert_first_step(job, step):
    i = find_exact("  %s:" % job)
    for j in range(i + 1, len(lines)):
        cur = lines[j]
        if cur.strip() and not cur.startswith("    ") and not cur.lstrip().startswith("#"):
            break
        if cur.rstrip("\n") == "    steps:":
            lines[j + 1:j + 1] = step
            return
    sys.exit("job %r has no steps: block — anchor moved" % job)


if mutation == "default-write":
    i = find_exact("permissions:")
    j = i + 1
    replaced = False
    while j < len(lines):
        if lines[j].startswith("  contents:"):
            lines[j] = "  contents: write\n"
            replaced = True
            break
        if lines[j].strip() and not lines[j].startswith("  "):
            break
        j += 1
    if not replaced:
        lines.insert(i + 1, "  contents: write\n")

elif mutation == "unauthorized-write-job":
    # Adds a NEW job the caller's --writer-job set does not name, holding
    # contents: write with no permissions block of its own removed — this is
    # exactly the shape issue #1301/#1237 describe: a future job added to the
    # file silently getting (or here, explicitly grabbing) write it was never
    # meant to have.
    i = find_exact("jobs:")
    block = [
        "  mallory:\n",
        "    runs-on: ubuntu-latest\n",
        "    permissions:\n",
        "      contents: write\n",
        "    steps:\n",
        "      - run: echo hi\n",
    ]
    lines[i + 1:i + 1] = block

elif mutation == "remove-writer-permissions":
    job = arg
    i = find_exact("  %s:" % job)
    j = i + 1
    perm_start = None
    perm_end = None
    while j < len(lines):
        cur = lines[j]
        if cur.strip() and not cur.startswith("    "):
            break
        if cur.rstrip("\n") == "    permissions:":
            perm_start = j
            k = j + 1
            while k < len(lines) and (not lines[k].strip() or lines[k].startswith("      ")):
                k += 1
            perm_end = k
            break
        j += 1
    if perm_start is None:
        sys.exit("job %r has no permissions: block to remove — anchor moved" % job)
    del lines[perm_start:perm_end]

elif mutation == "drop-top-permissions":
    # Removes the workflow-scope permissions: block (issue #1428).
    i = find_exact("permissions:")
    j = i + 1
    while j < len(lines) and (not lines[j].strip() or lines[j].startswith((" ", "#"))):
        j += 1
    del lines[i:j]

elif mutation == "run-splice-input":
    for i, line in enumerate(lines):
        if re.match(r"\s*run:\s*\|\s*$", line):
            body_indent = len(lines[i + 1]) - len(lines[i + 1].lstrip())
            lines.insert(i + 1, " " * body_indent + 'echo "${{ inputs.tag }}"\n')
            break
    else:
        sys.exit("no 'run: |' block found — anchor moved")

elif mutation == "unpinned-uses":
    # A third-party action at a mutable tag, as the first step of the named
    # job. The real files pin every `uses:` to a commit; this puts one back.
    job = arg
    i = find_exact("  %s:" % job)
    for j in range(i + 1, len(lines)):
        cur = lines[j]
        if cur.strip() and not cur.startswith("    ") and not cur.lstrip().startswith("#"):
            sys.exit("job %r has no steps: block — anchor moved" % job)
        if cur.rstrip("\n") == "    steps:":
            lines.insert(j + 1, "      - uses: x/y@v2\n")
            break
    else:
        sys.exit("job %r has no steps: block — anchor moved" % job)

elif mutation in ("attest-ungated", "attest-widened"):
    # The attest step's `if:` removed (it runs on every run, dry runs and
    # branch dispatches included), or widened with an `||`.
    for i, line in enumerate(lines):
        if re.match(r"\s*uses:\s*actions/attest-build-provenance@", line):
            break
    else:
        sys.exit("no attest-build-provenance step — anchor moved")
    k = i
    while k > 0 and not lines[k].lstrip().startswith("- "):
        k -= 1
    for j in range(k, i + 1):
        if re.match(r"\s*if:\s", lines[j]):
            if mutation == "attest-ungated":
                del lines[j]
            else:
                pad = lines[j][: len(lines[j]) - len(lines[j].lstrip())]
                lines[j] = pad + "if: github.event_name == 'push' || inputs.dry_run\n"
            break
    else:
        sys.exit("the attest step has no if: — anchor moved")

elif mutation in (
    "attest-job-rust-cache",
    "attest-job-rust-cache-dispatch-only",
    "attest-job-actions-cache",
):
    # A cache step put back into release-rmpc.yml's attesting build job: on
    # every trigger, gated to dispatch runs that never save, or the bare
    # restore half of actions/cache. Each is pinned, so only the cache rule
    # can fire.
    step = {
        "attest-job-rust-cache": [
            "      - name: Cargo cache\n",
            "        uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2\n",
        ],
        "attest-job-rust-cache-dispatch-only": [
            "      - name: Cargo cache\n",
            "        if: github.event_name == 'workflow_dispatch'\n",
            "        uses: Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2\n",
            "        with:\n",
            "          save-if: false\n",
        ],
        "attest-job-actions-cache": [
            "      - name: Restore target\n",
            "        uses: actions/cache/restore@0400d5f644dc74513175e3cd8d07132dd4860809 # v4.2.4\n",
            "        with:\n",
            "          path: target\n",
            "          key: rmpc-build\n",
        ],
    }[mutation]
    insert_first_step("build", step)

elif mutation in ("attest-job-cross", "attest-job-cross-env"):
    # The pre-fix aarch64 leg: a `cross: true` matrix entry and a `cross build`
    # for the matrix target in the attesting job. The -env variant also sets
    # the CROSS_TARGET_<T>_IMAGE override to a tag.
    i = find_exact("          - target: aarch64-unknown-linux-gnu")
    lines.insert(i + 1, "            cross: true\n")
    step = [
        "      - name: Build (cross)\n",
        "        if: matrix.cross\n",
    ]
    if mutation == "attest-job-cross-env":
        step += [
            "        env:\n",
            "          CROSS_TARGET_AARCH64_UNKNOWN_LINUX_GNU_IMAGE: ghcr.io/cross-rs/aarch64-unknown-linux-gnu:0.2.5\n",
        ]
    step += [
        "        run: |\n",
        "          cross build --release --target ${{ matrix.target }} \\\n",
        "            --package rust-payment-client --bin rmpc\n",
    ]
    insert_first_step("build", step)

else:
    sys.exit("unknown mutation %r" % mutation)

pathlib.Path(dst).write_text("".join(lines))
PY

# mutate_and_audit <workflow> <mutation> <writer-jobs...> -- runs the SAME
# auditor over a hostile mutated copy. A fixture that fails to build reports
# itself through this same channel, so it can only ever produce a FAIL, never
# a quiet pass.
mutate_and_audit() {
  local wf="$1" mutation="$2" job_arg="$3"
  shift 3
  local base_name dir
  base_name="$(basename "$wf" .yml)"
  dir="$WORKDIR/hostile/${mutation}-${base_name}"
  rm -rf "$dir"
  mkdir -p "$dir"
  local mutate_err
  if ! mutate_err=$(python3 "$MUTATOR_PY" "$wf" "$dir/workflow.yml" "$mutation" "$job_arg" 2>&1); then
    echo "FIXTURE DID NOT BUILD: $mutate_err"
    return 0
  fi
  audit "$dir/workflow.yml" "$@"
}

echo ""
echo "--- selftest: each defect class is caught on a hostile copy of BOTH release workflows ---"

for wf_pair in "$DAPP_WORKFLOW:build-and-push" "$RMPC_WORKFLOW:publish bump-manifest"; do
  wf="${wf_pair%%:*}"
  writers="${wf_pair#*:}"
  label="$(basename "$wf")"
  # shellcheck disable=SC2086 # writers is a deliberately unquoted word-split list
  set -- $writers

  HOSTILE_DEFAULT="$(mutate_and_audit "$wf" default-write "" "$@")"
  if grep -q '^perms-default:' <<<"$HOSTILE_DEFAULT"; then
    pass "$label: restoring workflow-scope 'contents: write' is caught"
  else
    fail "$label: workflow-scope 'contents: write' was accepted (findings: ${HOSTILE_DEFAULT:-<none>})"
  fi

  HOSTILE_UNAUTH="$(mutate_and_audit "$wf" unauthorized-write-job "" "$@")"
  if grep -q "^perms-write: job 'mallory'" <<<"$HOSTILE_UNAUTH"; then
    pass "$label: a new job granting itself contents: write outside the declared writer set is caught"
  else
    fail "$label: an unauthorized writer job was accepted (findings: ${HOSTILE_UNAUTH:-<none>})"
  fi

  first_writer="$1"
  HOSTILE_MISSING="$(mutate_and_audit "$wf" remove-writer-permissions "$first_writer" "$@")"
  if grep -q "^perms-missing: job '${first_writer}'" <<<"$HOSTILE_MISSING"; then
    pass "$label: deleting '${first_writer}''s permissions: block is caught — silent inheritance is how a workflow-scope grant reaches a job in the first place"
  else
    fail "$label: removing '${first_writer}''s permissions: block was accepted (findings: ${HOSTILE_MISSING:-<none>})"
  fi
  if grep -q "^perms-cannot-publish: job '${first_writer}'" <<<"$HOSTILE_MISSING"; then
    pass "$label: a declared writer job that no longer holds contents: write is separately flagged perms-cannot-publish — the least-privilege checks above cannot be passing on a workflow that lost the ability to release"
  else
    fail "$label: a declared writer job stripped of its permissions: block was not flagged perms-cannot-publish (findings: ${HOSTILE_MISSING:-<none>})"
  fi

  HOSTILE_SPLICE="$(mutate_and_audit "$wf" run-splice-input "" "$@")"
  if grep -q "^run-splice: '\${{ inputs.tag }}'" <<<"$HOSTILE_SPLICE"; then
    pass "$label: splicing '\${{ inputs.tag }}' back into a run: body is caught"
  else
    fail "$label: '\${{ inputs.tag }}' interpolated into a run: body was accepted (findings: ${HOSTILE_SPLICE:-<none>})"
  fi

  HOSTILE_UNPINNED="$(mutate_and_audit "$wf" unpinned-uses "$first_writer" "$@")"
  if grep -q "^uses-unpinned: job '${first_writer}' .*'x/y@v2'" <<<"$HOSTILE_UNPINNED"; then
    pass "$label: an action at a mutable tag (x/y@v2) in writer job '${first_writer}' is caught"
  else
    fail "$label: 'uses: x/y@v2' in writer job '${first_writer}' was accepted (findings: ${HOSTILE_UNPINNED:-<none>})"
  fi
done

# ---------- release-rmpc.yml: the job that ATTESTS holds no contents: write ----------
# `build` holds id-token: write and attestations: write. An action moved
# upstream there runs before the attest step and can swap the binary it signs,
# so the pin rule keys on ANY write scope, not only on contents.
echo ""
echo "--- selftest: release-rmpc.yml's attesting build job and its attest step ---"

HOSTILE_BUILD_UNPINNED="$(mutate_and_audit "$RMPC_WORKFLOW" unpinned-uses build publish bump-manifest)"
if grep -q "^uses-unpinned: job 'build' holds .*id-token: write.*'x/y@v2'" <<<"$HOSTILE_BUILD_UNPINNED"; then
  pass "release-rmpc.yml: 'uses: x/y@v2' in the build job (id-token: write, attestations: write) is caught"
else
  fail "release-rmpc.yml: 'uses: x/y@v2' in the attesting build job was accepted (findings: ${HOSTILE_BUILD_UNPINNED:-<none>})"
fi

# Any writer can dispatch release-rmpc.yml on a branch. An attest step that runs
# on that dispatch mints a genuine attestation for whatever the branch built.
HOSTILE_ATTEST_UNGATED="$(mutate_and_audit "$RMPC_WORKFLOW" attest-ungated "" publish bump-manifest)"
if grep -q "^attest-ungated: .*<no if:, every run>" <<<"$HOSTILE_ATTEST_UNGATED"; then
  pass "release-rmpc.yml: an attest step with no if: (attests dry runs and branch dispatches) is caught"
else
  fail "release-rmpc.yml: an attest step with no if: was accepted (findings: ${HOSTILE_ATTEST_UNGATED:-<none>})"
fi

HOSTILE_ATTEST_WIDENED="$(mutate_and_audit "$RMPC_WORKFLOW" attest-widened "" publish bump-manifest)"
if grep -q "^attest-ungated: .*inputs.dry_run" <<<"$HOSTILE_ATTEST_WIDENED"; then
  pass "release-rmpc.yml: an attest step widened with '|| inputs.dry_run' is caught"
else
  fail "release-rmpc.yml: an attest step widened with '|| inputs.dry_run' was accepted (findings: ${HOSTILE_ATTEST_WIDENED:-<none>})"
fi

# ---------- release-rmpc.yml: the attesting job restores no cache and runs no unpinned cross image ----------
# A cache key holds no ref or trigger and a tag-push run restores from dev's
# scope, so a writer's dry run on dev could save a poisoned target/ that the
# admin's tag push then links and attests. Any cache step in an attesting job
# is refused, whatever its if:.
echo ""
echo "--- selftest: release-rmpc.yml's attesting job restores no cache and runs no unpinned cross image ---"

HOSTILE_RUST_CACHE="$(mutate_and_audit "$RMPC_WORKFLOW" attest-job-rust-cache "" publish bump-manifest)"
if grep -q "^attest-cache: job 'build' .*Swatinem/rust-cache@" <<<"$HOSTILE_RUST_CACHE"; then
  pass "release-rmpc.yml: Swatinem/rust-cache back in the attesting build job, on the push path, is caught"
else
  fail "release-rmpc.yml: Swatinem/rust-cache in the attesting build job was accepted (findings: ${HOSTILE_RUST_CACHE:-<none>})"
fi

HOSTILE_RUST_CACHE_GATED="$(mutate_and_audit "$RMPC_WORKFLOW" attest-job-rust-cache-dispatch-only "" publish bump-manifest)"
if grep -q "^attest-cache: job 'build' .*Swatinem/rust-cache@" <<<"$HOSTILE_RUST_CACHE_GATED"; then
  pass "release-rmpc.yml: a rust-cache step gated to dispatch runs with save-if: false is still refused in the attesting job"
else
  fail "release-rmpc.yml: a dispatch-only rust-cache step in the attesting build job was accepted (findings: ${HOSTILE_RUST_CACHE_GATED:-<none>})"
fi

HOSTILE_ACTIONS_CACHE="$(mutate_and_audit "$RMPC_WORKFLOW" attest-job-actions-cache "" publish bump-manifest)"
if grep -q "^attest-cache: job 'build' .*actions/cache/restore@" <<<"$HOSTILE_ACTIONS_CACHE"; then
  pass "release-rmpc.yml: actions/cache/restore in the attesting build job is caught"
else
  fail "release-rmpc.yml: actions/cache/restore in the attesting build job was accepted (findings: ${HOSTILE_ACTIONS_CACHE:-<none>})"
fi

# cross links inside ghcr.io/cross-rs/<target>:<version> unless Cross.toml pins
# the image by digest. The `uses:` pin rule never sees that pull.
# cross_audit <mutation> <label> [Cross.toml text] -- audits a hostile copy with
# --cross-toml naming a file that holds the text (no Cross.toml when omitted).
cross_audit() {
  local mutation="$1" dir="$WORKDIR/hostile-cross/$2" mutate_err
  rm -rf "$dir"
  mkdir -p "$dir"
  if ! mutate_err=$(python3 "$MUTATOR_PY" "$RMPC_WORKFLOW" "$dir/workflow.yml" "$mutation" 2>&1); then
    echo "FIXTURE DID NOT BUILD: $mutate_err"
    return 0
  fi
  local -a cross_args=()
  if [[ $# -ge 3 ]]; then
    printf '%s\n' "$3" > "$dir/Cross.toml"
    cross_args=(--cross-toml "$dir/Cross.toml")
  fi
  python3 "$AUDITOR" "$dir/workflow.yml" --writer-job publish --writer-job bump-manifest "${cross_args[@]}"
}

DIGEST="$(printf '%064d' 0)"
CROSS_TAG_TOML="$(printf '[target.aarch64-unknown-linux-gnu]\nimage = "ghcr.io/cross-rs/aarch64-unknown-linux-gnu:0.2.5"')"
CROSS_PINNED_TOML="$(printf '[target.aarch64-unknown-linux-gnu]\nimage = "ghcr.io/cross-rs/aarch64-unknown-linux-gnu:0.2.5@sha256:%s"' "$DIGEST")"

CROSS_NONE="$(cross_audit attest-job-cross none)"
if grep -q "^cross-image: job 'build' .*builds aarch64-unknown-linux-gnu with cross" <<<"$CROSS_NONE"; then
  pass "release-rmpc.yml: a cross build of aarch64-unknown-linux-gnu in the attesting job with no Cross.toml is caught"
else
  fail "release-rmpc.yml: a cross build with no Cross.toml was accepted (findings: ${CROSS_NONE:-<none>})"
fi
if grep -q "^cross-image: .*apple-darwin" <<<"$CROSS_NONE"; then
  fail "release-rmpc.yml: the cross rule named a matrix target that the cross: key leaves native (findings: $CROSS_NONE)"
else
  pass "release-rmpc.yml: the cross rule reads the matrix and names only the target marked cross: true"
fi

CROSS_TAG="$(cross_audit attest-job-cross tag "$CROSS_TAG_TOML")"
if grep -q "^cross-image: job 'build' .*aarch64-unknown-linux-gnu:0.2.5'" <<<"$CROSS_TAG"; then
  pass "release-rmpc.yml: a Cross.toml image pinned by tag, not digest, is caught"
else
  fail "release-rmpc.yml: a tag-pinned Cross.toml image was accepted (findings: ${CROSS_TAG:-<none>})"
fi

CROSS_PINNED="$(cross_audit attest-job-cross pinned "$CROSS_PINNED_TOML")"
if [[ -n "$CROSS_PINNED" ]] && ! grep -q '^FIXTURE DID NOT BUILD' <<<"$CROSS_PINNED" && ! grep -q '^cross-image:' <<<"$CROSS_PINNED"; then
  fail "release-rmpc.yml: the digest-pinned cross fixture produced other findings: $CROSS_PINNED"
elif [[ -z "$CROSS_PINNED" ]]; then
  pass "release-rmpc.yml: a cross build whose Cross.toml pins the image by @sha256 digest passes — the rule is not refusing every cross build"
else
  fail "release-rmpc.yml: a digest-pinned Cross.toml image was refused (findings: $CROSS_PINNED)"
fi

CROSS_ENV="$(cross_audit attest-job-cross-env env "$CROSS_PINNED_TOML")"
if grep -q "^cross-image: CROSS_TARGET_AARCH64_UNKNOWN_LINUX_GNU_IMAGE" <<<"$CROSS_ENV"; then
  pass "release-rmpc.yml: a CROSS_TARGET_<T>_IMAGE tag override of a digest-pinned Cross.toml is caught"
else
  fail "release-rmpc.yml: a tag-pinned CROSS_TARGET_<T>_IMAGE override was accepted (findings: ${CROSS_ENV:-<none>})"
fi

# ---------- the refusal, executed: release-dapp.yml's own shape check ------
# Everything above reads YAML. This runs release-dapp.yml's OWN "Validate
# tag" step body — extracted by the auditor's --extract-step mode, which
# refuses to hand back a body that still splices an expression — against the
# exact payload class issue #1301 exists for, and against a legitimate tag.
echo ""
echo "--- selftest: release-dapp.yml's own tag shape-check, extracted and executed ---"

VALIDATE_BODY="$WORKDIR/validate-tag.sh"
python3 "$AUDITOR" "$DAPP_WORKFLOW" --extract-step "Validate tag" > "$VALIDATE_BODY"

run_validate() {
  # $1 = INPUT_TAG payload
  ( env -i INPUT_TAG="$1" HOME="$WORKDIR" PATH="$PATH" \
    "$(command -v bash)" --noprofile --norc -o pipefail "$VALIDATE_BODY" 2>&1 )
}

# shellcheck disable=SC2016 # the format string is deliberately single-quoted; %s is a printf placeholder, not shell expansion
INJECTION_PAYLOAD="$(printf 'v1";$(touch %s/pwned)  ;"' "$WORKDIR")"
INJECTION_OUT="$(run_validate "$INJECTION_PAYLOAD")" && INJECTION_EXIT=0 || INJECTION_EXIT=$?
if [[ $INJECTION_EXIT -ne 0 ]]; then
  pass "the extracted shape-check refuses a shell-injection payload in inputs.tag (exit $INJECTION_EXIT)"
else
  fail "the extracted shape-check accepted a shell-injection payload in inputs.tag (output: $INJECTION_OUT)"
fi
if [[ -e "$WORKDIR/pwned" ]]; then
  fail "the injection payload actually executed — a file was created outside the shape-check's own logic"
else
  pass "the injection payload never executed as a command — env: kept it as inert data"
fi

NEWLINE_PAYLOAD="$(printf 'v1.2.3\nrm -rf /')"
NEWLINE_OUT="$(run_validate "$NEWLINE_PAYLOAD")" && NEWLINE_EXIT=0 || NEWLINE_EXIT=$?
if [[ $NEWLINE_EXIT -ne 0 ]]; then
  pass "the extracted shape-check refuses a tag carrying an embedded newline (exit $NEWLINE_EXIT) — this is exactly what [[ =~ ]] catches and a line-anchored grep would not"
else
  fail "the extracted shape-check accepted a tag with an embedded newline (output: $NEWLINE_OUT)"
fi

RMPC_PAYLOAD="rmpc-v0.4.0"
RMPC_OUT="$(run_validate "$RMPC_PAYLOAD")" && RMPC_EXIT=0 || RMPC_EXIT=$?
if [[ $RMPC_EXIT -ne 0 ]]; then
  pass "the extracted shape-check refuses release-rmpc.yml's own namespace ('${RMPC_PAYLOAD}') — the two release pipelines cannot be dispatched into each other's tag space (issue #1243)"
else
  fail "the extracted shape-check accepted '${RMPC_PAYLOAD}', which belongs to release-rmpc.yml's namespace (output: $RMPC_OUT)"
fi

GOOD_TAG="v1.2.3"
GOOD_OUT="$(run_validate "$GOOD_TAG")" && GOOD_EXIT=0 || GOOD_EXIT=$?
if [[ $GOOD_EXIT -eq 0 ]]; then
  pass "the extracted shape-check accepts a legitimate tag ('${GOOD_TAG}') — the guard is not vacuously refusing everything"
else
  fail "the extracted shape-check rejected a legitimate tag '${GOOD_TAG}' (output: $GOOD_OUT)"
fi

GOOD_PRERELEASE="v1.2.3-rc.1"
GOOD_PRE_OUT="$(run_validate "$GOOD_PRERELEASE")" && GOOD_PRE_EXIT=0 || GOOD_PRE_EXIT=$?
if [[ $GOOD_PRE_EXIT -eq 0 ]]; then
  pass "the extracted shape-check accepts a legitimate prerelease tag ('${GOOD_PRERELEASE}')"
else
  fail "the extracted shape-check rejected a legitimate prerelease tag '${GOOD_PRERELEASE}' (output: $GOOD_PRE_OUT)"
fi

# ---------- --workflow-scope-only: the floor CI applies to EVERY workflow (issue #1428) ----------
echo ""
echo "--- selftest: --workflow-scope-only is clean on real files and catches a dropped or write-all top-level block ---"

scope_only() { python3 "$AUDITOR" "$1" --workflow-scope-only; }

for wf in "$DAPP_WORKFLOW" "$RMPC_WORKFLOW"; do
  label="$(basename "$wf")"
  OUT="$(scope_only "$wf")"
  if [[ -z "$OUT" ]]; then
    pass "$label: --workflow-scope-only is clean on the real file"
  else
    fail "$label: --workflow-scope-only is not clean: $OUT"
  fi

  mkdir -p "$WORKDIR/scope/$label"
  if python3 "$MUTATOR_PY" "$wf" "$WORKDIR/scope/$label/drop.yml" drop-top-permissions; then
    OUT="$(scope_only "$WORKDIR/scope/$label/drop.yml")"
    if grep -q '^perms-default:' <<<"$OUT"; then
      pass "$label: a workflow with no top-level permissions: block is caught by --workflow-scope-only"
    else
      fail "$label: a dropped top-level permissions: block was accepted (findings: ${OUT:-<none>})"
    fi
  else
    fail "$label: drop-top-permissions fixture did not build"
  fi

  OUT="$(python3 "$MUTATOR_PY" "$wf" "$WORKDIR/scope/$label/w.yml" default-write && scope_only "$WORKDIR/scope/$label/w.yml")"
  if grep -q '^perms-default:' <<<"$OUT"; then
    pass "$label: top-level contents: write is caught by --workflow-scope-only"
  else
    fail "$label: top-level contents: write was accepted by --workflow-scope-only (findings: ${OUT:-<none>})"
  fi
done

TOTAL=$((PASS + FAIL))
echo ""
echo "=== audit_workflow_run_splice_and_perms.py guard exercise: ${PASS} passed, ${FAIL} failed ==="

if [[ "$TOTAL" -lt "$MIN_EXPECTED_ASSERTIONS" ]]; then
  echo "FAIL: only ${TOTAL} assertions ran, fewer than the ${MIN_EXPECTED_ASSERTIONS} this file declares — a case stopped being reached" >&2
  exit 1
fi

echo "AUDIT_WORKFLOW_ASSERTIONS_EXECUTED=${TOTAL}"
[[ "$FAIL" -eq 0 ]] || exit 1
