# scripts/release

Release tooling. Orchestration is Bun TypeScript.

## Recording third-party dependencies (core 1497)

Entry point: `bun scripts/release/record-release-dependencies.ts --chain-id N --release TAG [--manifests-dir DIR]` with `DEPENDENCY_MANIFEST_RPC_URL` in the environment.

It writes `deployments/dependency-manifests/<chain id>/<release>.json`, checks every address against the deploy config, and prints the path last. See `deployments/dependency-manifests/README.md`.

Callers:

- Devops publish-contracts: run it from the core checkout at DEPLOY_SHA after the deploy is final, or dispatch the workflow below with `gh workflow run release-record.yml -f chain_id=8453 -f release=TAG`.
- A human: Actions tab, workflow `release-record`. Inputs: `chain_id`, `release`, optional `manifests_dir`. The workflow commits nothing. It prints the manifest to the job summary and uploads it as the artifact `dependency-manifest-<chain>-<release>`. Commit that file with the release deployment record.

The fixture `deployments/dependency-manifests/example.json` is an EXAMPLE generated from config and the checked-in Base snapshot. It is not a release record. The self-test `dependency-manifest-selftest.ts` reads it. It sits outside any chain directory so the nightly drift check never treats it as a release.

## Release branches and tags

Contract releases ship from `releases-A.B.x`, are rehearsed on `qa/A.B.x-<YYYY-MM-DD>` and run in production only from an rc tag (`release/vA.B.C-rc.N`) cut at the squash commit. The policy is `docs/operations/contract-release-runbooks.md` sections 2, 3 and 4.14. `record-release-dependencies.ts` records the dependency manifest for the release the rc names.

## Other files

- `dependency-manifest-diff.ts`, `check-nightly-third-party-workflow.ts`: nightly drift (dispatch only).
- `install-rmpc.sh`, `preflight-guards.sh`: rmpc install and preflight.
