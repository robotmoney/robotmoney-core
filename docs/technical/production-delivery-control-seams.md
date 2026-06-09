# Production delivery control seams

> Canonical controls: `docs/technical/security-model.md` sections 11 and 13.
> This document records compile-valid ownership seams discovered by issue #738.
> The jobs added by the scout are permanently disabled and do not publish,
> sign, deploy, verify, or contact a production endpoint.

## Current workflow boundary

The existing release workflows combine artifact production with publication:

- `release-dapp.yml` builds and pushes the dapp image in `build-and-push`.
- `release-rmpc.yml` builds archives in `build`, then tags and publishes them
  in `publish`.

The dapp workflow therefore has no approval boundary before its first external
write. The rmpc workflow has a build/publish boundary, but tag creation and
GitHub Release publication still share one job. Issue #660 must establish the
protected publication boundary before later controls are enabled.

Neither release workflow deploys contracts. BaseScan verification belongs to a
contract-deploy workflow created or selected by issue #662. The disabled
`contract-source-verification` job in `release-rmpc.yml` is only a routing seam
that records this ownership; it must not become a BaseScan caller.

## Ownership and order

The delivery-control issues are intentionally serialized:

1. **#660, runner and approval owner.** Split build from external writes, move
   all publication behind the `production` environment, and replace unpinned
   runner labels. It owns `environment:` and runner selection.
2. **#659, signing and provenance owner.** Build on #660's publication jobs. It
   owns release signing, OIDC, `id-token: write`, artifact attestations, and
   signing-related `contents:` / `packages:` permissions.
3. **#662, contract verification owner.** Create or select the contract-deploy
   workflow and add one reusable BaseScan verification implementation there.
   It owns `BASESCAN_API_KEY`, deployed-address inputs, timeout behavior, and
   the rule that deployment cannot finish before verification succeeds.
4. **#671, dapp transport owner.** Add HSTS at the production serving layer and
   enable `verify-dapp-headers` after deployment. It owns production dapp
   domains and header assertions, but no signing or deployment permissions.

This order is required because #659 changes the permission blocks established
by #660, #662 defines the post-deploy contract consumed by later checks, and
#671 consumes the final dapp deployment endpoint.

## Repository prerequisites

Before enabling the disabled jobs, repository administrators must configure:

- A GitHub environment named `production`.
- At least one required reviewer who is not the deployment initiator.
- Deployment branch/tag rules allowing only reviewed release tags or the
  designated production branch.
- Runner labels or immutable runner images selected by #660.
- GitHub OIDC trust for the keyless signing identity selected by #659.
- `BASESCAN_API_KEY` as an environment secret for the contract-deploy
  workflow selected by #662.
- Canonical production dapp domains as environment variables or configuration
  for #671; no placeholder domain may pass the production header check.

The scout introduces no secrets and does not modify repository settings.

## Integration rules

- Keep build jobs free of production-environment credentials.
- Grant write permissions only on the job that performs the corresponding
  external write; do not restore workflow-global write permissions.
- Approval must happen before tag pushes, package pushes, release creation,
  signing, deployment, or any other irreversible external write.
- Signing and verification failures are hard failures, never warnings.
- The BaseScan timeout must report every unverified address and fail closed.
- HSTS checks run against both the container serving layer and the canonical
  deployed HTTPS domains.
- Every implementation change must keep both release workflows valid under
  `actionlint`.
