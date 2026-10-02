# Stage deployment: the one deployment scheme

Canonical plan: `robotmoney/devops` `docs/plans/one-deployment-scheme.md`. Core issue 1488 (S9).

Stage is the same deployment as mainnet. Only parameters differ. There is one runbook, "publish contracts" (devops, Bun TypeScript). It runs on the Twin chain (918453) and on Base mainnet (8453). A rehearsal and production differ only in the arguments given to it.

## What runs on stage

1. `scripts/stage/core-stack.sh chain up` rebuilds `rmpc` from this checkout and boots the smoke harness (`cargo run -p smoke-test -- --full-stack`).
2. The harness boots the Twin chain. It does not use a fork and does not use a lazy anvil.
3. The harness mints a **fresh keystore set** with the devops rehearsal key helper. Every boot gets new keys, so a redeploy from a new SHA never reuses a deployer. The keystores are encrypted. The passphrase is random, lives in a 0600 file, and is never an argument or an exported variable.
4. The harness funds the keys, then calls publish contracts:

   ```
   --chain 918453 --rpc <twin rpc> --sheet <stage sheet> --signer keystore \
   --environment stage --core-sha <sha>
   ```

   Publish contracts deploys all four vaults, creates the real Safe (Safe SDK, `@safe-global/protocol-kit`), hands over to the Safe and the timelock, and verifies.
5. The harness reads the manifests (`core.json`, `registry.json`, `router.json`, `governance.json`, `ic-policy.json`, `timelock.json`, `safe.json`, `libraries.json`, `vault-<key>.json`) and starts the dapp stack with those addresses.
6. `core-stack.sh governance ensure` runs the stage 13 govern matrix through the real Safe and the timelock. The matrix is the same on stage and mainnet. Every row prints a tx hash and a receipt status. `scripts/stage/govern-rows.ts` fails the verb unless every row has both and status 1.

## Environment

| Variable | Meaning |
| --- | --- |
| `PUBLISH_CONTRACTS_DIR` | The devops `publish-contracts` directory (holds `src/cli.ts`). |
| `STAGE_SHEET` | The stage sheet. Parameter lines only. Selected by input, never edited between runs. |

## Vaults

All four vaults ship with assets that have usable pools: rmUSDC, rmPROTO (wETH and cbBTC), rmAGENT (empty and paused) and rmRWA (deSPXA only, plain basket row, no oracle). Coinbase stocks are phase two.

## What was deleted

- the stage ceremony script and its self-test (the bash ceremony and handover).
- The stage deploy script (including the stale `timelock-918453` fallback).
- The Rust harness deployment of core, registry, router, governance and the IC policy (`run_forge_deploy_*`), the demo vault and stub-pool deploys, `seed_demo_depositors`, the `demo-seed-depositors` binary, and the dapp faucet funding.
- `.github/workflows/deploy-contracts.yml`.
- The single-key release in `scripts/fusion/cross-repo-acceptance.sh`.
- `deployments/timelock-918453.json` and `deployments/governance-918453.json`.

`scripts/stage/core-stack.sh` stays as a thin boot and health wrapper. It holds no deploy or ceremony logic. A CI grep gate (`scripts/stage/check-deleted-stage-scripts.ts`) enforces that.

## No deployer-set voters

Voting power, quorum, agent registration and weights are govern rows executed through the real Safe and the timelock. Nothing sets them from a deployer key. `Fixture::set_voting_power` is gone. `Fixture::unpause_gateway`, `revoke_agent` and `reauthorize_agent` call govern rows. The Fusion acceptance release stage runs `core-stack.sh governance release` (govern row `release-receipt`). No release keystore exists.

## Checks

| Check | Where |
| --- | --- |
| Four vault manifests after a publish run | `core-stack.sh publish run` (exit 66 on a short count) |
| Verifier labels on stage equal the mainnet label set | `scripts/stage/label-diff.ts` (non-zero on any difference) |
| Stage sheet versus production sheet differ only in parameter lines | `scripts/stage/sheet-diff.ts` (allow-list of keys) |
| Every govern row has a tx hash and receipt status 1 | `scripts/stage/govern-rows.ts` |
| Deleted paths stay deleted | `scripts/stage/check-deleted-stage-scripts.ts` |

Run the tooling tests with `cd scripts/stage && bun test tests`.

## What a Twin chain run proves

A short timelock delay proves the scripts execute. It proves that only parameters differ. It does not prove the real 48 hour delay. Governance timing is proven on 8453 (runbook Q2).
