# Stage deployment: the one deployment scheme

Canonical plan: core issue 1499. Core issue 1488 (S9).

Stage is the same deployment as mainnet. Only parameters differ. There is one runbook, "publish contracts" (the Bun TypeScript CLI in `publish-contracts/` in this repo, run as `bun publish-contracts/src/cli.ts`). It is the only deploy driver. Devops checks core out and runs the same CLI: core never depends on devops. It runs on the Twin chain (918453) and on Base mainnet (8453). A rehearsal and production differ only in the arguments given to it.

## What runs on stage

Every stage service runs in a container (core 1549). `core-stack.ts` only calls `docker compose`: it starts no host process and no container mounts the Docker socket.

1. `bun scripts/stage/core-stack.ts chain up` rebuilds `rmpc` from this checkout (a build artifact the status checks compare, not a service), then starts the **Twin chain container**: the `twin-chain` service of `testing/ethereum-testnet/config/docker-compose.stage-chain.yaml` (project `robotmoney-stage-chain`). It is the pinned lazy anvil fork of real Base state (`scripts/devnet/twin-fork.ts serve`, chain id 918453, one block per second), published on `127.0.0.1:18545` and on the chain network as `twin-chain:8545`. `BASE_UPSTREAM_RPC` (optional secret) and `TWIN_PIN_BLOCK` pass through the environment. `chain up` refuses a `TWIN_RPC_URL` that names any other chain.
2. `chain up` then runs the **deploy job**, the one-shot `stage-harness` service (`smoke-test --deploy-only`, image built from this ref by `docker/stage-images.Dockerfile`). It runs as the invoking user against the mounted checkout and the chain container. The job mints a **fresh keystore set** with the rehearsal key helper (`publish-contracts/src/rehearsal`). Every boot gets new keys, so a redeploy from a new SHA never reuses a deployer. The keystores are encrypted. The passphrase is random, lives in a 0600 file, and is never an argument or an exported variable. They live in the work directory (`/tmp/robotmoney-stage-work`, `STAGE_WORK_DIR` overrides it), because forge only lets a script write manifests under `/tmp` or `./deployments`. `chain down` deletes the directory.
3. The job funds the keys, then calls publish contracts:

   ```
   --chain 918453 --rpc <twin rpc> --sheet <stage sheet> \
   --signer keystore:<key dir>/DEPLOYER:<passphrase file> --environment stage --core-sha <sha>
   ```

   Publish contracts deploys all four vaults, creates the real Safe (Safe SDK, `@safe-global/protocol-kit`), hands over to the Safe and the timelock, and verifies. It refuses a checkout that is not the DEPLOY_SHA or has uncommitted changes, so the stage host checkout must be a normal clone (not a git worktree) at the ref.
4. The job reads the manifests (`core.json`, `registry.json`, `router.json`, `governance.json`, `ic-policy.json`, `timelock.json`, `safe.json`, `libraries.json`, `vault-<key>.json`), writes the endpoint summary and the dapp compose environment (`dapp-env.json`) to the work directory, and **exits**. It owns nothing afterwards.
   The signer is the string publish contracts accepts, `keystore:PATH:PASSFILE`. Only paths are passed. The passphrase stays in its 0600 file.
5. `chain up` starts the **dapp stack** from that environment: `docker-compose.dapp.yaml` plus `docker-compose.dapp.stage.yaml` (project `robotmoney-dapp`). The overlay joins the indexer to the chain network (it dials `twin-chain:8545`) and publishes no postgres host port. Ports (`18545`, `18546`, `5173`) and the public stage URLs are unchanged.
   `chain status` checks the stamp, that the chain container runs, `eth_chainId` on 18545, a healthy `robotmoney-dapp` container and the rmpc build commit. A stamp from the host-process era (it names a pid) reads as `not-booted`: run `chain down` and `chain up` once on the new ref. There is no data to migrate.
6. `core-stack.ts governance ensure` runs stage 13 through the real Safe and the timelock: the unpauses of all four vaults, rmUSDC included, because every vault deploys paused (one timelock operation each, all scheduled in one sitting, one wait). The unpauses are the same on stage and mainnet. On the Twin chain the Twin-only rows (`update-delay`, `batch`, `cancel`) follow. Every row prints a tx hash and a receipt status. `scripts/stage/govern-rows.ts` fails the verb unless every row has both and status 1.

## Environment

| Variable | Meaning |
| --- | --- |
| `STAGE_SHEET` | Optional. An alternative stage sheet. Parameter lines only. Default: the committed `deployments/twin-918453/stage-sheet.env`. |
| `STAGE_WORK_DIR` | Optional. The deploy job's work directory (keystores, manifests). Default `/tmp/robotmoney-stage-work`. Deleted on `chain down`. |
| `BASE_UPSTREAM_RPC` | Optional secret. A paid Base RPC for the Twin chain container. Default: the public endpoint. Never logged. |
| `TWIN_PIN_BLOCK` | Optional. The Base block the chain container pins. Default: the upstream head minus 2. |

## Vaults

All four vaults ship with assets that have usable pools: rmUSDC, rmPROTO (wETH and cbBTC), rmAGENT (paused, holding RM on the Uniswap V4 RM/USDC 2.91% pool, priced by the permissionless price recorder; the Twin forks the live pool and never funds it) and rmRWA (deSPXA only, plain basket row, no oracle). Coinbase stocks are phase two.

## What is not here

Stage has no second deployment path. These do not exist and a CI gate keeps them gone:

- a stage ceremony shell and a stage deploy shell. Publish contracts deploys, hands over to the Safe and verifies.
- a Rust harness deployment of core, registry, router, governance and the IC policy. The deploy job calls publish contracts.
- a stage service that runs as a host process, or any container that mounts the Docker socket. `scripts/ci/check-stage-containers.ts` (suite 28) keeps that true, with digest-pinned base images and `--locked` builds.
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
| Router, basket vault and timelock role proofs | Labels of the one verifier (`publish-contracts/src/verify`): `gateway: router() equals the deployed router`, `registry: router() equals the deployed router`, `vault[KEY]: a second setRegistry reverts`, the role matrix, the asset config and `vault[rmAGENT]: holds RM as its one asset` |
| Every govern row has a tx hash and receipt status 1 | `scripts/stage/govern-rows.ts` |
| Deleted paths stay deleted | `scripts/stage/check-deleted-stage-scripts.ts` |

Parity compares against production fixtures (`verifier-labels.txt`, `production-sheet.env`). Suite 14 takes the directory as the optional input `production_fixtures_dir`, for a caller that has the production files. Without it the step uses the label and sheet fixtures committed in `publish-contracts/tests/fixtures`. A missing or empty file fails the step and names the path.

Run the tooling tests with `cd scripts/stage && bun test tests`.

## What a Twin chain run proves

A short timelock delay proves the scripts execute. It proves that only parameters differ. It does not prove the real 48 hour delay. Governance timing is proven on 8453 (runbook Q2).

## Mainnet-class dapp safety: banner and wrong-chain guard (core issue 1729)

These exist in the dapp and must be live before any public tunnel points at a dapp built with `VITE_ENV_CLASS=mainnet`.

- **Banner.** On the mainnet class every page shows a sticky, non-dismissible banner: "Base mainnet - real funds", with the chain name and id (8453). The testnet banner is unchanged on the other classes and still renders nothing on mainnet (`MainnetBanner.tsx`).
- **One write path.** Every transaction goes through `useGuardedWriteContract` (`clients/dapp/src/lib/useGuardedWriteContract.ts`), the only module allowed to use wagmi's `useWriteContract`. On the mainnet class a write is refused unless the connected wallet is on chain 8453, and an allowed write is pinned to chain 8453. A source-scan test fails if any other module imports the raw hook, so a new write path cannot bypass it. The Safe proposal signing is gated the same way.
- **Wrong chain screen.** When a wallet is connected on another chain (Ethereum 1, the Twin chain 918453, anything else), the app body is replaced by "Switch your wallet to Base (chain 8453)" with a switch button. Nothing under it mounts, so no balance, price or position for the wrong chain is shown, and no write control exists. The top bar and wallet connect stay.
- **Gateway code hash and deposits.** Human deposits, withdrawals and redeems call the vaults and the router directly. They never call the gateway, so the gateway code-hash pin (`VITE_GATEWAY_EXPECTED_CODE_HASH`) correctly gates only admin and agent writes. Pinning the vault and router code hashes for deposits is a separate decision (owner question in core issue 1729).
- **Indexer logs.** `RpcError::Transport` text has every URL replaced by `scheme://<redacted>`, so a keyed RPC URL cannot reach logs or `indexer_runs.error`.

