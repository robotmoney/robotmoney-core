# Stage deployment: the one deployment scheme

Canonical plan: the one-deployment-scheme plan. Core issue 1488 (S9).

Stage is the same deployment as mainnet. Only parameters differ. There is one runbook, "publish contracts" (devops, Bun TypeScript). It runs on the Twin chain (918453) and on Base mainnet (8453). A rehearsal and production differ only in the arguments given to it.

## What runs on stage

1. `bun scripts/stage/core-stack.ts chain up` rebuilds `rmpc` from this checkout and boots the smoke harness (`cargo run -p smoke-test -- --full-stack`).
2. The harness boots the Twin chain. It does not use a fork and does not use a lazy anvil.
3. The harness mints a **fresh keystore set** with the devops rehearsal key helper. Every boot gets new keys, so a redeploy from a new SHA never reuses a deployer. The keystores are encrypted. The passphrase is random, lives in a 0600 file, and is never an argument or an exported variable.
4. The harness funds the keys, then calls publish contracts:

   ```
   --chain 918453 --rpc <twin rpc> --sheet <stage sheet> \
   --signer keystore:<key dir>/DEPLOYER:<passphrase file> --environment stage --core-sha <sha>
   ```

   Publish contracts deploys all four vaults, creates the real Safe (Safe SDK, `@safe-global/protocol-kit`), hands over to the Safe and the timelock, and verifies.
5. The harness reads the manifests (`core.json`, `registry.json`, `router.json`, `governance.json`, `ic-policy.json`, `timelock.json`, `safe.json`, `libraries.json`, `vault-<key>.json`) and starts the dapp stack with those addresses.
   The signer is the string publish contracts accepts, `keystore:PATH:PASSFILE`. Only paths are passed. The passphrase stays in its 0600 file.
6. `core-stack.ts governance ensure` runs the stage 13 govern matrix through the real Safe and the timelock. The matrix is the same on stage and mainnet. Every row prints a tx hash and a receipt status. `scripts/stage/govern-rows.ts` fails the verb unless every row has both and status 1.

## Environment

| Variable | Meaning |
| --- | --- |
| `PUBLISH_CONTRACTS_DIR` | The devops `publish-contracts` directory (holds `src/cli.ts`). |
| `STAGE_SHEET` | The stage sheet. Parameter lines only. Selected by input, never edited between runs. |

## Vaults

All four vaults ship with assets that have usable pools: rmUSDC, rmPROTO (wETH and cbBTC), rmAGENT (empty and paused) and rmRWA (deSPXA only, plain basket row, no oracle). Coinbase stocks are phase two.

## What is not here

Stage has no second deployment path. These do not exist and a CI gate keeps them gone:

- a stage ceremony shell and a stage deploy shell. Publish contracts deploys, hands over to the Safe and verifies.
- a Rust harness deployment of core, registry, router, governance and the IC policy. The harness boots the Twin chain and calls publish contracts.
- demo vaults, stub pools, demo depositor seeding and dapp faucet funding.
- a deploy workflow. Deploys are the publish contracts runbook.
- a single-key release in the Fusion acceptance script. The release is a govern row.
- a committed timelock or governance record for chain 918453. Manifests are written by each run.

The stage verbs (chain boot and health, publish and governance calls, parity, the record, dapp and rmpc checks) are Bun TypeScript in `scripts/stage/core-stack.ts` with typed arguments and structured JSON log lines. The old `core-stack.sh` shim is deleted: every caller runs `bun scripts/stage/core-stack.ts` directly. The file holds no deploy or ceremony logic. A CI grep gate (`scripts/stage/check-deleted-stage-scripts.ts`) enforces that and fails if the shim or any mention of it returns.

## No deployer-set voters

Voting power, quorum, agent registration and weights are govern rows executed through the real Safe and the timelock. Nothing sets them from a deployer key. `Fixture::set_voting_power` is gone. `Fixture::unpause_gateway`, `revoke_agent` and `reauthorize_agent` call govern rows. The Fusion acceptance release stage runs `core-stack governance release` (govern row `release-receipt`). No release keystore exists.

## Seed share receiver (verifier note for devops)

The vault stage reads a required `SEED_SHARE_RECEIVER`. It must not be the zero address and must not be the deployer (`ADMIN_ADDRESS`). The stage reverts otherwise. The seed deposit is made on behalf of the receiver, so the receiver holds the seed shares and the deployer holds none.

Devops verifies after the vault stage:

- `rmUSDC.balanceOf(deployer) == 0` (deployer share balance 0).
- `rmUSDC.balanceOf(SEED_SHARE_RECEIVER) == rmUSDC.totalSupply()`.

`SEED_SHARE_RECEIVER` is an identity key in the sheet (`scripts/stage/sheet-diff.ts`). It is an address and differs per run.

Frozen sheet example (identity and parameter lines only, placeholders for addresses):

```
ADMIN_ADDRESS=<deployer address>
FEE_RECIPIENT=<treasury address>
SEED_SHARE_RECEIVER=<seed share holder, not the deployer>
SEED_DEPOSIT_USDC=1000000
EXIT_FEE_BPS=<basis points, 0 allowed>
TVL_CAP=<6-decimal USDC units>
PER_DEPOSIT_CAP=<6-decimal USDC units>
VAULT_NAME=<registered name of the rmUSDC vault in the registry>
QUORUM_THRESHOLD=<greater than 1>
VOTING_PERIOD=<seconds>
EXECUTION_DELAY=<seconds>
```

Every line above is required. No script has a default for it (`scripts/deploy/README.md`).

## Checks

| Check | Where |
| --- | --- |
| Four vault manifests after a publish run | `core-stack publish run` (exit 66 on a short count) |
| Verifier labels on stage equal the mainnet label set | `scripts/stage/parity.ts` runs `label-diff.ts` on the verifier output the Twin chain smoke job saved (`SMOKE_TEST_VERIFY_OUT`) |
| Stage sheet versus production sheet differ only in parameter lines | `scripts/stage/parity.ts` runs `sheet-diff.ts` on the run sheet the smoke job saved (`SMOKE_TEST_SHEET_OUT`) |
| Router, basket vault and timelock role proofs | `scripts/deploy/core-stages.ts` runs `assert-core-router.ts` after the gateway stage, `assert-basket-vaults.ts` after the rwa stage and `assert-timelock-roles.ts` after the timelock stage |
| Every govern row has a tx hash and receipt status 1 | `scripts/stage/govern-rows.ts` |
| Deleted paths stay deleted | `scripts/stage/check-deleted-stage-scripts.ts` |

Parity compares against the devops production fixtures directory (`verifier-labels.txt`, `production-sheet.env`). Suite 14 takes its path as the input `production_fixtures_dir` (default `devops/deployments/base-8453`). A missing or empty file fails the step and names the path.

Run the tooling tests with `cd scripts/stage && bun test tests`.

## What a Twin chain run proves

A short timelock delay proves the scripts execute. It proves that only parameters differ. It does not prove the real 48 hour delay. Governance timing is proven on 8453 (runbook Q2).
