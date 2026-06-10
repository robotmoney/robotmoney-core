# CI environments and release-runner hardening

> Canonical control: `docs/technical/security-model.md` §13 (Operational — keys,
> secrets, deployment), row "CI runner compromise injecting deploy artifact".
> Ownership map for the surrounding delivery controls:
> `docs/technical/production-delivery-control-seams.md`.
> Implemented by issue #660.

## The `production` protected environment

Both release workflows gate every external write behind the GitHub protected
environment named `production`:

| Workflow | Gated job | External writes behind the gate |
|---|---|---|
| `.github/workflows/release-rmpc.yml` | `publish` (`tag-and-publish`) | git tag push, GitHub Release creation with binary assets |
| `.github/workflows/release-dapp.yml` | `publish` (`publish-dapp-image`) | git tag push, GHCR image push (`:semver` and `:latest`) |

A job that declares `environment: production` does not start until a required
reviewer approves the pending deployment in the Actions run UI. Build jobs are
credential-free: workflow-level `permissions:` are read-only and write scopes
(`contents: write`, `packages: write`) are granted only on the gated publish
jobs. In `release-dapp.yml` the image is built in a separate, push-free `build`
job and travels to `publish` as a docker-archive artifact, so no registry write
can precede approval. In `release-rmpc.yml` dry runs (`dry_run=true`) skip the
`publish` job entirely and therefore request no approval.

### Repository settings (configured 2026-06-10 via `gh api`)

Settings → Environments → `production`:

- **Required reviewers:** 1 — `lucky-tensor` (repository owner).
  `prevent_self_review` is **off**: the repository currently has a single
  maintainer, so requiring a non-initiator reviewer would deadlock every
  release. When a second maintainer with deploy authority exists, add them as a
  reviewer and enable `prevent_self_review` to satisfy the two-person rule in
  security-model.md §13.
- **Wait timer:** none (0 minutes). Approval latency is already human-paced;
  a timer would add delay without adding review.
- **Deployment branches and tags:** custom policy — only tag pattern `v*.*.*`
  and branches `main` and `dev` may deploy to this environment. A
  `workflow_dispatch` from any other ref fails the environment check.
- **Admin bypass:** GitHub's default (`can_admins_bypass: true`) is in effect.

Reproduce / verify the configuration:

```bash
gh api repos/lucky-tensor/robotmoney-monorepo/environments/production \
  --jq '.protection_rules'
gh api repos/lucky-tensor/robotmoney-monorepo/environments/production/deployment-branch-policies \
  --jq '.branch_policies[] | "\(.type): \(.name)"'
```

## Runner pinning policy for release workflows

Every job in `.github/workflows/release-*.yml` runs on a **version-pinned
runner label** — `ubuntu-24.04` or `macos-15` — never a floating `*-latest`
alias. Floating aliases silently migrate to new OS images, which is exactly the
supply-chain drift the §13 control forbids on the deploy surface.

Known limitation: GitHub-hosted runners cannot be pinned to an exact image SHA
digest — the versioned label still receives rolling patch updates to the same
OS image line. The versioned label is the strongest pin GitHub-hosted runners
offer. The upgrade path to digest-level immutability is a **self-hosted runner
label** backed by an immutable image; the lint below accepts any non-`*-latest`
label, so adopting self-hosted labels requires no lint change.

Non-release suite workflows (`suite-*.yml`) may continue to use
`ubuntu-latest`; the pinning control applies to the deploy/release surface.

## Enforcement

`scripts/ci/check-release-runner-pinning.sh` asserts, for every
`.github/workflows/release-*.yml`:

1. no `runs-on:` or matrix `runner:` value ends in `-latest`;
2. at least one job declares `environment: production`.

It runs locally (`bash scripts/ci/check-release-runner-pinning.sh`) and on
every PR as the `release-runner-pinning` job in
`.github/workflows/suite-17-ci-velocity-guard.yml`. Both release workflows must
also stay valid under `actionlint` (see
`docs/technical/production-delivery-control-seams.md` §Integration rules).
