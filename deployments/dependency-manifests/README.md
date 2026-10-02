# Dependency manifests

One file per release deploy and chain: `deployments/dependency-manifests/<chain id>/<release>.json` (core 1497).

Each file records every third-party contract the release depends on: the address, its code hash, its proxy implementation address and that implementation's code hash where it is a proxy, and the block number it was read at. Addresses come from the deploy config files (`config/*.json`). There is no second hand-kept list. `scripts/release/check-dependency-manifest-addresses.ts` fails when a manifest names an address the config files do not.

## Recording at a release deploy

The release deploy path calls the hook once per chain, from the core checkout at the deploy sha:

```
DEPENDENCY_MANIFEST_RPC_URL=<RPC URL of the deploy chain> \
  bun scripts/release/record-release-dependencies.ts --chain-id 8453 --release v1.2.3
```

The RPC URL comes from the environment only. It is never an argument, a file or a commit. A public Base endpoint is enough.

The hook writes the manifest, checks its addresses against the config, and prints the path. Commit that file with the release deployment record. The devops publish-contracts runbook step that calls the hook is tracked in the devops repo (out of scope here). `scripts/release/preflight-guards.sh --dependency-manifest CHAIN_ID:RELEASE` records the same file for a manual preflight.

The same recording is available as the dispatch workflow `.github/workflows/release-record.yml` (see `scripts/release/README.md`). The `example.json` file here is a marked example fixture, not a release.

## Reading

`.github/workflows/nightly-third-party-drift.yml` (dispatch only, schedule disabled) reads the latest manifest for a chain, reads the same values live, and reports each difference. With no manifest committed yet it exits 2. That is expected until the first release deploy records one.
