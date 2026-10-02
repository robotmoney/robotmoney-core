# Nightly fresh snapshot: scope notes (core 1496)

Canonical: `docs/development/ci-suites.md` suite 29. Workflow: `.github/workflows/suite-29-nightly-fresh-snapshot.yml`.

## Suites in the run

Suites 5, 7, 8, 10, 11b and 14 run on the fresh Twin chain snapshot. The Bun self-test `scripts/devnet/check-nightly-fresh-snapshot-selftest.ts` runs in suite 13 on every pull request.

## Suite 26 is out of the nightly

Suite 26 (`suite-26-fusion-devnet-acceptance.yml`) is removed from the nightly list for two reasons.

- It needs `secrets.FUSION_RMPC_CONFIG` and many repository variables. The nightly passes no secret.
- It targets the shared fusion devnet. It never applies the fresh snapshot, so it did not run against the Twin chain built from the fresh genesis.

Keeping it would leave the nightly red for ever or make it lie. Suite 26 keeps its own dispatch and its place in the suite 21 dispatch list. The self-test fails if suite 26 is added back to suite 29.

## Secrets in called suites

- Suite 5: the `base-testnet-adapters` job reads `BASE_TESTNET_*` secrets. It now carries `if: inputs.fresh_snapshot != true`, so it never starts in the nightly.
- Suite 14: it checks out the private `robotmoney/devops` repo with `secrets.DEVOPS_READ_TOKEN` to run publish-contracts. This is the one known exception, listed in the self-test. It goes away when devops is public or the publish step reads a vendored copy. This is an open owner decision.

The self-test scans every called suite job and fails on a secret that is not `GITHUB_TOKEN`, not gated by `fresh_snapshot != true` and not on the exception list.

## Final git diff step

The final step of the `results` job runs `git diff --exit-code` over `testing/fixtures/fork-state` and `testing/ethereum-testnet/config`. It runs on a fresh checkout, so it shows only that the workflow itself commits nothing. It does not prove each suite left tracked files untouched. Each suite job applies the overlay with `.github/actions/apply-fresh-snapshot` into its own runner checkout.

## Block lockstep (core 1498)

`scripts/devnet/check-fork-lockstep.ts` asserts `CURRENT.json` (`fork_block`, `fork_block_hash`), `fork-block.json` (`block_number`, `block_hash`) and `genesis-alloc.block.json` (block number, hash and the sha256 of `genesis-alloc.json`) agree. The snapshot and the nightly overlay write the hash. `check-fork-manifest.sh` runs the check.

## BNKR

BNKR is warmed and asserted only when `config/agent-token-shortlist.json` names it. The shortlist is empty today (rmAGENT ships empty), so BNKR is skipped and the contents check prints a skip line.
