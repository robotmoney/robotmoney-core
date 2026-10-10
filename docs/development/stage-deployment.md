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

## Read-only dapp on Base mainnet (core issue 1725)

`core-stack dapp up --chain 8453` runs the dapp, the explorer indexer and the explorer API against real Base (8453) and the contracts a mainnet rehearsal deployed. It reads only. It starts no Twin chain, runs no deploy job, holds no key and sends no transaction.

```
bun scripts/stage/core-stack.ts dapp up --chain 8453 \
  --rpc <base rpc url> --manifests <copy of the manifests dir> --start-block <first block of the deployment> \
  [--logs-rpc <url>] [--max-block-range N] [--dapp-port P] [--explorer-port P]
bun scripts/stage/core-stack.ts dapp status --chain 8453
bun scripts/stage/core-stack.ts dapp down --chain 8453
```

- **Manifests.** Pass a COPY of the manifests directory as an argument. The tool only reads it and requires `chain_id` 8453 in every file. The gateway, vaults, registry, router, governance, consensus receipt, timelock and Safe addresses and the gateway runtime hash come from there (`scripts/stage/mainnet-dapp.ts`). The vault order is rmUSDC, rmPROTO, rmAGENT, rmRWA and must match `timelock.json`.
- **Start block.** `--start-block` becomes `INDEXER_START_BLOCK`. The indexer then skips its `eth_getCode` search for the deploy block. Public Base RPCs are not archive nodes, so that search fails there and falls back to block 0. The first block of the rehearsal on 8453 is 52401633.
- **RPC choices.** `--rpc` serves everything. `--logs-rpc` (`INDEXER_LOGS_RPC_URL`) sends only `eth_getLogs` to a second endpoint. **For the 8453 rehearsal start block pass `--logs-rpc https://base.gateway.tenderly.co`.** It served the logs from the start block in the loopback run, and it allows `eth_getLogs` up to 1000 blocks. `base-rpc.publicnode.com` is not a usable logs endpoint for this start block: it answers HTTP 403 ("Archive requests require a personal token") for logs older than about 4400 blocks. `mainnet.base.org` throttles logs with 429. `--max-block-range` (`INDEXER_MAX_BLOCKS_PER_TICK`, default 1000, at least 1) is the `eth_getLogs` range. The indexer always sends the address list. The overlay sets `INDEXER_RPC_MAX_RETRIES` 6 and `INDEXER_RPC_BACKOFF_MS` 1000: HTTP 429, 502, 503, 504 and transport errors are retried with doubling waits. A key inside an RPC URL is passed through the environment only and logged as its origin.
- **A refusing RPC is named, not retried.** HTTP 401 and 403 are final answers. The indexer stores and logs one line such as `rpc eth_getLogs refused by https://base-rpc.publicnode.com (HTTP 403) for blocks 52401633..52402632: ... set INDEXER_LOGS_RPC_URL (--logs-rpc) to an archive-capable logs RPC such as https://base.gateway.tenderly.co`. It names the endpoint origin (never the path or key), the method and the block range. It sends no retry, then waits 12 s, 24 s, 48 s and so on up to 300 s between ticks, and logs `indexer cannot make progress: an RPC endpoint refused the request; fix the endpoint and restart`. The same text is in `indexer_runs.error`. Fix: restart the stack with an archive-capable `--logs-rpc`.
- **Index progress and staleness.** The explorer `/health` reports `last_indexed_block` (the highest cursor of a run that finished without an error) and `chain_head_block` (the head that tick saw). Every `/v1/vaults` and `/v1/stats` response carries the same `block_number` and `chain_head_block`. The indexer reads blocks 5 behind the head, so a healthy index is about 5 blocks behind. The dapp prints `Block N` and, when the index is more than 30 blocks behind, `indexer M blocks behind (head H)`. `block_number` 0 means nothing is indexed yet and the dapp prints "Not indexed yet".
- **Safe and timelock.** The manifests builder passes `INDEXER_SAFE` and `INDEXER_TIMELOCK` (the `safe` and `timelock` addresses of `timelock.json`). The indexer watches only the addresses it is given, so both are listed in `/v1/chains/8453/contracts` (kinds `safe` and `timelock`) and their events are served at `/v1/governance/admin-events`: the timelock `CallScheduled`, `CallExecuted`, `Cancelled` and `MinDelayChange`, and the Safe `ExecutionSuccess`, `ExecutionFailure`, `AddedOwner`, `RemovedOwner` and `ChangedThreshold`. `/v1/governance/proposals` stays empty by design: it lists the RouterGovernance voting proposals, and the governed path is the Safe through the timelock. The events are read from the start block on, so the Safe setup events (before the start block) are not listed.
- **Deposits paused.** The registry status stays `Active` when a vault's own `pauseDeposits()` is set. `GET /v1/vaults` therefore carries `deposits_paused` (the vault's `depositsPaused()` at its latest snapshot, null until it has one). The dapp resolves one state per vault: registry paused or retired wins, then a live `depositsPaused()` read (a `true` always beats an index `false`), then the explorer. An answer that comes only from the explorer is shown as `Active (per index, block N)`, and only while the index is fresh (`block_number` above 0 and at most 30 blocks behind `chain_head_block`); a stale or unindexed index `false` is `Deposit state unknown`. A pause from the index is trusted at any age. Every deposit form (single vault, router, vault selector) is enabled ONLY in the known-open state: paused, retired and unknown disable it and show the reason (unknown: "Deposit state unknown: cannot confirm deposits are open"). Cards, the vault list and the detail page never print `Active` unless deposits are known open. Withdraw and redeem are not changed: `pauseDeposits()` closes the deposit side only. On the mainnet class the live read runs only with a wallet on Base, pinned to 8453.
- **Prices.** The price strip reads Uniswap V3 pools through the user's wallet (no dapp-owned RPC). On the mainnet class the read runs only with a wallet on Base. A cell that cannot be read says `price unavailable (wallet RPC: ...)` with the reason (no wallet on Base, wrong chain, or the read error). A failed refetch keeps the last good price and marks it `(may be old)`.
- **Known limit.** Block snapshots use `eth_call` at old blocks and each event block fetches its receipts. A node that keeps no old state or receipts answers those with errors. The indexer logs and skips a snapshot it cannot read. Use an archive endpoint when full history matters.
- **No signing, no faucet, no deploy.** The tool refuses to start (exit 65, class `signing-env-present`) when the environment holds a variable named like a key, mnemonic, passphrase, keystore, signer, deployer, faucet, `STAGE_SHEET` or `PUBLISH_*`. It builds the dapp with `VITE_ENV_CLASS=mainnet` and an empty `VITE_FAUCET_HARNESS_PRIVATE_KEY`, so the faucet is refused (`chainClassifier.ts`, `buildEnvValidation.ts`). It reads `docker compose config` and refuses unless every published port is on `127.0.0.1`.
- **Exposure (owner decision 2026-10-10, relayed by the plan owner's session).** Public exposure of the mainnet stage dapp is approved, through the cloudflared tunnel already configured on the stage host (`stage-dapp` and `stage-explorer` under `robotmoney-labs.dev`). That tunnel config is not in this repo and this tool never creates, edits or runs tunnel, DNS, Cloudflare or nginx configuration. The stack publishes on `127.0.0.1` only, which a tunnel on the same host reaches. The compose project is `robotmoney-dapp-8453`, the containers are `dapp8453-*`, and the default host ports are 15173 (dapp) and 18547 (explorer API), which differ from the Twin stack (5173 and 18546) so nothing existing is repointed by accident. To serve the public names the operator stops the Twin stack, then starts this one on the ports the existing tunnel forwards to (`--dapp-port` and `--explorer-port`, read from the host's tunnel config) and passes `--public-dapp-url` and `--public-explorer-url` so the bundle and the explorer CORS origin name the public URLs. Those two flags change only what the browser is told.
- **Warning: real funds.** Once the vaults open on 2026-10-12 anyone who reaches the public dapp can deposit REAL USDC (caps 1000 and 100 USDC, rmAGENT 100 and 15). The mainnet class shows a persistent "Base mainnet — real funds" banner and refuses every write unless the wallet is on Base (8453); see "Mainnet-class dapp safety" below. The overlay (`docker-compose.dapp.mainnet.yaml`) builds the dapp with `VITE_ENV_CLASS=mainnet`, `VITE_CHAIN_ID=8453` and an empty `VITE_DEVNET_RPC_URL` as build args, which `validateEnvClassForChain` accepts.
- **Never from CI.** No workflow runs this verb. The tests use a fixture and a fake `docker compose`.

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

- **Banner.** On the mainnet class every page shows a sticky, non-dismissible banner: "Base mainnet — real funds", with the chain name and id (8453). The testnet banner is unchanged on the other classes and still renders nothing on mainnet (`MainnetBanner.tsx`).
- **One write path.** Every transaction goes through `useGuardedWriteContract` (`clients/dapp/src/lib/useGuardedWriteContract.ts`), the only module allowed to use wagmi's `useWriteContract`. On the mainnet class a write is refused unless the connected wallet is on chain 8453, and an allowed write is pinned to chain 8453. A source-scan test fails if any other module imports the raw hook, so a new write path cannot bypass it. The Safe proposal signing is gated the same way.
- **Wrong chain screen.** When a wallet is connected on another chain (Ethereum 1, the Twin chain 918453, anything else), the app body is replaced by "Switch your wallet to Base (chain 8453)" with a switch button. Nothing under it mounts, so no balance, price or position for the wrong chain is shown, and no write control exists. The top bar and wallet connect stay.
- **The class is build time only.** `VITE_ENV_CLASS` is not a runtime key: a `/config.json` cannot change it, and a mainnet build refuses to start (error panel, nothing mounts) if the document names another class. On a mainnet build the document also cannot change any contract address, the devnet RPC or the vault list: only the explorer URL and the timelock deploy block are read from it. `vite build` fails if `VITE_CHAIN_ID` is 1 or 8453 without `VITE_ENV_CLASS=mainnet`, if the mainnet class names another chain, or if it sets `VITE_DEVNET_RPC_URL` (`validateEnvClassForChain`). The mainnet overlay (`docker-compose.dapp.mainnet.yaml`, used by `core-stack dapp up --chain 8453`) builds with `VITE_ENV_CLASS=mainnet`, `VITE_CHAIN_ID=8453` and an empty `VITE_DEVNET_RPC_URL`, which fixes the write target to 8453 in the bundle and passes that check.
- **Explorer data is untrusted.** The explorer API URL (with the timelock deploy block, a plain number) is all a mainnet build still reads from `/config.json`, so anything the explorer returns (positions, history, prices) is display only and must never drive a decision. Balances, allowances and positions used for a write come from the chain. A hostile or wrong explorer can mislead a reader. It cannot move funds.
- **How a public 8453 stack must be built.** Only `core-stack dapp up --chain 8453` is allowed to produce a public mainnet stack. Its overlay (`docker-compose.dapp.mainnet.yaml`) sets `VITE_ENV_CLASS=mainnet` as a BUILD arg. A bundle built from the base `docker-compose.dapp.yaml` defaults to class `fork`: no banner and no guard. Never point a tunnel at such a bundle.
- **Target code check.** Before any write on the mainnet class the guarded hook reads the target's code on Base. An empty target or an unreadable one refuses the write with a clear message. Pinning vault and router code hashes is not done yet (open owner question in core issue 1729).
- **Gateway code hash and deposits.** Human deposits, withdrawals and redeems call the vaults and the router directly. They never call the gateway, so the gateway code-hash pin (`VITE_GATEWAY_EXPECTED_CODE_HASH`) correctly gates only admin and agent writes. Pinning the vault and router code hashes for deposits is a separate decision (owner question in core issue 1729).
- **Indexer logs.** `RpcError::Transport` text has every URL replaced by `scheme://<redacted>`, so a keyed RPC URL cannot reach logs or `indexer_runs.error`.

