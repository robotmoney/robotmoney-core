# Releasing

Canonical for: `.github/workflows/release-rmpc.yml`, `.github/workflows/release-dapp.yml`,
`.github/scripts/assert_manifest_ahead_of_tags.sh`, `.github/scripts/bump_rmpc_manifest.sh`,
`scripts/release/install-rmpc.sh`.

Issues: #1191 (a released binary must not misreport its version), #1204 (checksummed
release assets), #1236 (build provenance — the checksum alone shares a trust root
with the archive), #1243 (the two version guards contradicted each other).

## Two components, two tag namespaces

| Namespace | Owner | Publishes |
|---|---|---|
| `rmpc-vX.Y.Z` | `release-rmpc.yml` | four `rmpc-vX.Y.Z-<platform>.tar.gz` archives + `.sha256`, attached to a GitHub Release, each with a Sigstore build-provenance attestation |
| `vX.Y.Z` | `release-dapp.yml` | `ghcr.io/<owner>/dapp:X.Y.Z` and `:latest` |

They were the same namespace until #1243, and the overlap was not cosmetic. Three
tags (`v0.2.2`, `v0.3.0`, `v0.3.1`) fired both pipelines at once, and two things
followed from that:

- The PR guard `assert_manifest_ahead_of_tags.sh` globbed `v*.*.*`, so a **dApp-only
  release raised the rmpc version floor**. Every rmpc PR went red until the rmpc
  crate was bumped past a version chosen for a component it shares no code with.
- `release-rmpc.yml`'s `verify-version` compared the **rmpc manifest** against a tag
  chosen for the **dApp**, failed, and printed `git push --delete origin vX.Y.Z` —
  which would have destroyed the dApp Release published from that same tag.

`v0.0.1 … v0.3.3` are the rmpc releases cut before the split. That namespace is
retired for rmpc: the guard treats `0.3.3` as a frozen floor constant and reads no
`v*.*.*` tag ever again. **Do not point `release-rmpc.yml` back at `v*.*.*`.**

## Cutting an rmpc release

1. Pick the version. It must equal the current `[package] version` in
   `clients/rust-payment-client/Cargo.toml` — `verify-version` refuses anything
   else, because the tag is what the archives are named and the manifest is what the
   binary reports (`rmpc --version` prints `CARGO_PKG_VERSION`, nothing injects the
   tag).
2. Dispatch `release-rmpc` with `tag = rmpc-vX.Y.Z` (and optionally
   `commit_hash`). Or push the tag directly; both paths run the same jobs.
   - To rehearse without publishing anything, dispatch with `dry_run = true` and
     **no** tag. Archives upload as 7-day workflow artifacts named
     `rmpc-dryrun-<sha7>-*`, and the version assertions are skipped by design —
     which is exactly why a dry run may not be named after a release.
3. The workflow verifies manifest == tag, builds all four targets, asserts the
   built binary reports that version, packages each archive with its `.sha256`,
   attests each archive's build provenance (`actions/attest-build-provenance`,
   which is why `build` carries its own `id-token: write` / `attestations: write`
   map and drops the inherited `contents: write`), and creates the Release.
4. `bump-manifest` then opens **chore(rmpc): bump manifest to X.Y.Z+1** against
   `dev`. Merge it.

### Step 4 is not optional, and here is why

The two guards this repository runs are individually correct and, left alone,
mutually exclusive:

- `verify-version` (release time) requires **manifest == tag**.
- `assert_manifest_ahead_of_tags.sh` (PR time) requires **manifest > newest
  published rmpc release**.

So the moment a release publishes, `dev` is *by construction* in the state the PR
guard rejects. That is not a bug in either guard — a manifest sitting on an
already-published version is precisely the #1191 harm, where every `dev` build
self-identifies as the shipped release and an operator cannot tell a patched build
from the distributed one.

Two things keep that from being a repository-wide outage:

- The PR guard is **scoped to changes under `clients/rust-payment-client/`**. A PR
  that does not touch the rmpc crate cannot make the manifest stale and is not
  failed by it. Only rmpc PRs see the red, and for them it is the correct signal.
- `bump-manifest` opens the fix automatically, so the window is one PR merge wide.

### If the bump PR was not opened

The most likely cause is the repository/organization setting **Allow GitHub Actions
to create and approve pull requests** being off; the job fails loudly and the
published Release is unaffected. Do it by hand:

```bash
git checkout dev && git pull
bash .github/scripts/bump_rmpc_manifest.sh rmpc-vX.Y.Z    # rewrites the manifest
git checkout -b chore/post-release-manifest-bump-X.Y.Z+1
git add clients/rust-payment-client/Cargo.toml
git commit -m "chore(rmpc): bump manifest to X.Y.Z+1 after releasing rmpc-vX.Y.Z"
```

Then open the PR against `dev` as usual. The script is a no-op (exit 3) if `dev` is
not actually sitting on the released version.

### If `verify-version` fails

Recovery depends on the trigger, and the workflow prints the right one:

- **Pushed tag** — the tag exists and `release-rmpc.yml` owns the `rmpc-v*`
  namespace outright, so `git push --delete origin rmpc-vX.Y.Z` destroys nothing
  else. Fix the manifest on `dev`, then re-tag.
- **workflow_dispatch** — `verify-version` runs *before* `publish`, so no tag was
  created. There is nothing to delete. Fix the manifest and re-dispatch.

Re-running the workflow without changing anything cannot help: it checks out the
same commit.

## Cutting a dApp release

Dispatch `release-dapp` with `tag = vX.Y.Z` and `commit_hash`, or push a `vX.Y.Z`
tag. It touches nothing in the rmpc release train.

## Installing a release

`scripts/release/install-rmpc.sh --tag rmpc-vX.Y.Z --dest ~/.local/bin`. It
downloads the archive *and* its `.sha256`, refuses a checksum file that does not
name that archive, then runs `gh attestation verify` pinned to this repository
and to `release-rmpc.yml` as the signer workflow, and only then extracts. `gh` is
a hard prerequisite: without it the installer exits 2 rather than installing a
binary it could not check.

The two checks answer different questions and both are needed. The `.sha256`
shares a trust root with the archive — same release, same host, same token — so
it detects a tampered *download* and nothing more; anyone who can write the
release can write a matching checksum beside a malicious archive. The attestation
is signed with an OIDC identity GitHub issues only to an Actions run in this
repository, so release-write alone cannot forge it. It does **not** prove the
commit was reviewed: whoever can push a ref here can trigger this workflow and
get a genuine attestation for it, which is what ref protection on `rmpc-v*` and
review on `release-rmpc.yml` are for.

Legacy `vX.Y.Z` tags still resolve — the archive name has one `rmpc-` prefix
either way — but releases up to and including `v0.3.3` predate #1204 and ship no
checksum (exit 4), and every release cut before #1236 has no attestation
(exit 6). See `BOOTSTRAP.md` §1.

Note that `releases/latest` is **not** a way to find the newest rmpc release: both
components publish Releases into the same repository, so a dApp release can be the
latest one. Select the newest `rmpc-v*` tag explicitly.

## What is executed on every PR

None of the release workflows run on a PR — they fire only on a tag. The behaviour
that must not silently rot is exercised by:

| Script | Proves |
|---|---|
| `.github/scripts/tests/test_assert_manifest_ahead_of_tags.sh` | the PR guard's collision, regression, tagless, prerelease-ordering, foreign-tag and out-of-scope branches, against synthetic repositories |
| `.github/scripts/tests/test_bump_rmpc_manifest.sh` | the post-release bump — including that the bump it writes makes the same repository pass the guard |
| `scripts/release/install-rmpc-selftest.sh` | `release-rmpc.yml`'s own packaging and pairing steps, extracted and *run* (packaging with `sha256sum` absent, i.e. the macOS runner), plus the installer's verify/refuse paths — including that an archive whose build provenance does not verify is refused with exit 6 before extraction, and that a missing `gh` refuses before the download rather than degrading |
| `scripts/release/install-rmpc-selftest.sh` (authority audit) | `release-rmpc.yml`'s per-job permission map and its `run:` bodies — see "Who holds the write token" below |

The first two run in `suite-07-rmpc-integration.yml` (job `rmpc-parity`), ahead of
`Build rmpc binary` so a version problem does not cost a release build first. The
third runs in `suite-17-swarm-plugin.yml`.

## Who holds the write token

`release-rmpc.yml` defaults to `contents: read` and grants write per job. The map,
audited on every PR by `install-rmpc-selftest.sh`:

| Job | `contents` | Why |
|---|---|---|
| `resolve` | `read` | full-history checkout to expand a short `commit_hash` |
| `verify-version` | `read` | checks out and reads `Cargo.toml` |
| `build` | `read` | checks out `submodules: recursive` at a caller-supplied SHA and runs cargo, so `build.rs` and every proc macro in that tree execute here; archives leave via `actions/upload-artifact`, which does not use the `contents` scope |
| `publish` | `write` | `git push origin <tag>` and the GitHub Release |
| `bump-manifest` | `write` (+ `pull-requests: write`) | pushes the post-release bump and opens its PR |

`contents: write` used to sit at workflow scope, so `build` inherited it and
arbitrary code from the dispatched ref ran alongside a repo-write token — "can
dispatch a release" silently meant "can run arbitrary code with that token"
(issue #1237). Two rules keep it closed, and both are asserted rather than
documented only: the workflow-scope default must not be `write`, and **every job
must state its own `permissions:` block** — silent inheritance is how the grant
reached `build` in the first place.

Relatedly, no `run:` body in that file may interpolate a `${{ }}` expression
other than `matrix.*` / `runner.*`. Actions substitutes an expression into the
shell *source* before bash parses it, so quoting at the call site cannot contain
a `$(...)` in a dispatched tag. Caller-supplied values reach the shell through
the step's `env:` and are read as `"$VAR"`. The selftest executes the release's
own `Validate inputs` step against a `$(...)` payload and a newline payload to
prove the refusal, and runs both renderings of one payload side by side to show
why the `env:` form is the fix.
