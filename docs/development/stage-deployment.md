# Stage deployment: the one deployment scheme

Canonical plan: core issue 1499. Core issue 1488 (S9).

Stage is the same deployment as mainnet. Only parameters differ. There is one runbook, "publish contracts" (the Bun TypeScript CLI in `publish-contracts/` in this repo, run as `bun publish-contracts/src/cli.ts`). It is the only deploy driver. Devops checks core out and runs the same CLI: core never depends on devops. It runs on the Twin chain (918453) and on Base mainnet (8453). A rehearsal and production differ only in the arguments given to it.

> **System split (owner decision, 2026-10-19).** The vaults system and the
> rmpc gateway system are separate systems (`docs/architecture.md` §1).
> Deployed release (v0.5.0): the stage stack deploys and runs both in one
> run, as the deployed release does. The target runs the vaults release
> alone (`docs/operations/contract-release-runbooks.md` §4, the target delta
> list). The system split review
> records the differences (`docs/code-review/20261019-vaults-gateway-split/20261019-code-review-internal-claude-opus-5-5-system-split.md`).


## What runs on stage

Every rehearsal chain runs on the stage host `rm-core-stage-1`: the Twin fork, any anvil and any fork of Base. None runs on the operator machine. The operator machine holds the keys, drives a contract QA run over ssh and signs through an ssh tunnel to the stage fork (`docs/runbooks/contract-qa/README.md`, "Hosts").

Every stage service runs in a container (core 1549). `core-stack.ts` only calls `docker compose`: it starts no host process and no container mounts the Docker socket.

1. `bun scripts/stage/core-stack.ts chain up` rebuilds `rmpc` from this checkout (a build artifact the status checks compare, not a service), then starts the **Twin chain container**: the `twin-chain` service of `testing/ethereum-testnet/config/docker-compose.stage-chain.yaml` (project `robotmoney-stage-chain`). It is the pinned lazy anvil fork of real Base state (`scripts/devnet/twin-fork.ts serve`, chain id 918453, one block per second), published on `127.0.0.1:18545` and on the chain network as `twin-chain:8545`. `BASE_UPSTREAM_RPC` (optional secret) and `TWIN_PIN_BLOCK` pass through the environment. `chain up` refuses a `TWIN_RPC_URL` that names any other chain.
2. `chain up` then runs the **deploy job**, the one-shot `stage-harness` service (`smoke-test --deploy-only`, image built from this ref by `docker/stage-images.Dockerfile`). It runs as the invoking user against the mounted checkout and the chain container. The job mints a **fresh keystore set** with the rehearsal key helper (`publish-contracts/src/rehearsal`). Every boot gets new keys, so a redeploy from a new SHA never reuses a deployer. The keystores are encrypted. The passphrase is random, lives in a 0600 file, and is never an argument or an exported variable. They live in the work directory (`/tmp/robotmoney-stage-work`, `STAGE_WORK_DIR` overrides it), because forge only lets a script write manifests under `/tmp` or `./deployments`. `chain down` deletes the directory.
3. The job funds the keys, then calls publish contracts:

   ```
   --chain 918453 --rpc <twin rpc> --sheet <stage sheet> \
   --signer keystore:<key dir>/DEPLOYER:<passphrase file> --environment stage --core-sha <sha>
   ```

   Publish contracts deploys the three vaults (rmUSDC, rmPROTO, rmRWA; rmAGENT is retired, ADR-0017), creates the real Safe (Safe SDK, `@safe-global/protocol-kit`), hands over to the Safe and the timelock, and verifies. It refuses a checkout that is not the DEPLOY_SHA or has uncommitted changes, so the stage host checkout must be a normal clone (not a git worktree) at the ref.
4. The job reads the manifests (`libs.json`, `vault.json`, `registry.json`, `router.json`, `receipt.json`, `governance.json`, `protocol-asset-vault.json`, `rwa-basket-vault.json`, `timelock.json`, `gateway.json`, `gateway-handover.json`). The first nine are the vaults system and the last two are the gateway system, which `core-stack publish gateway` deploys in a separate run after the vaults run. The job writes the endpoint summary and the dapp compose environment (`dapp-env.json`) to the work directory, and **exits**. It owns nothing afterwards.
   The signer is the string publish contracts accepts, `keystore:PATH:PASSFILE`. Only paths are passed. The passphrase stays in its 0600 file.
5. `chain up` starts the **dapp stack** from that environment: `docker-compose.dapp.yaml` plus `docker-compose.dapp.stage.yaml` (project `robotmoney-dapp`). The overlay joins the indexer to the chain network (it dials `twin-chain:8545`) and publishes no postgres host port. Ports (`18545`, `18546`, `5173`) and the public stage URLs are unchanged.
   `chain status` checks the stamp, that the chain container runs, `eth_chainId` on 18545, a healthy `robotmoney-dapp` container and the rmpc build commit. A stamp from the host-process era (it names a pid) reads as `not-booted`: run `chain down` and `chain up` once on the new ref. There is no data to migrate.
6. `core-stack.ts governance ensure` runs stage 13 through the real Safe and the timelock: the unpauses of all three vaults, rmUSDC included, because every vault deploys paused (one timelock operation each, all scheduled in one sitting, one wait). The unpauses are the same on stage and mainnet. It then sets the emergency unwind guard of every basket the sheet's `GOVERN_UNPAUSE_VAULTS` opened (`govern --row set-unwind-guard`, `token=all`, `min-usdc-out=1000000`, `max-loss-bps=500`, QA plan v1 D7), one timelock round per basket, so `governance verify` passes the stage 12 label "emergencyUnwindGuard minUsdcOut above zero on every active asset of an open vault". The stage baskets hold nothing, so these values prove the row and never size a guard (on 8453 the runbook sizes them from each vault's holding). On the Twin chain the Twin-only rows (`update-delay`, `batch`, `cancel`) follow the unpauses. Every row prints a tx hash and a receipt status. `scripts/stage/govern-rows.ts` fails the verb unless every row has both and status 1.

## Two systems, two runs (core issue 1892)

The vaults system and the rmpc gateway system deploy, verify and rehearse independently (`docs/architecture.md` §1, `docs/operations/contract-release-runbooks.md` §4.13).

- `core-stack publish run` is the **vaults system**. It writes the vaults manifests, creates the Safe, hands over to the timelock and verifies. It needs no gateway, no gateway sheet name and no agent input. It fails if a gateway manifest is present in the manifest directory.
- `core-stack publish gateway` is the **gateway system**, run after the vaults system against its manifests. It uses its own small sheet (`gateway-sheet.env` in the work directory), its own evidence directory (`evidence-gateway`) and its own run manifest. The sheet names the gateway admin (`GATEWAY_ADMIN_ADDRESS`) and the gateway upgrade timelock (`GATEWAY_UPGRADE_TIMELOCK`) explicitly. On the Twin chain the stage tool names the run's own timelock for both, so the Twin's governed unpauses and role grants keep working. That is a Twin choice. Production decides its own (an open decision, `docs/architecture.md` §10).
- The Twin chain job `core-stages-twin-chain` runs both modes and asserts that the vaults run sends no gateway transaction, that the gateway run leaves the vaults manifests unchanged, and that a missing or zero gateway upgrade timelock or any `AGENT_` name in the gateway sheet is refused before any broadcast.

## Environment

| Variable | Meaning |
| --- | --- |
| `STAGE_SHEET` | Optional. An alternative stage sheet. Parameter lines only. Default: the committed `deployments/twin-918453/stage-sheet.env`. |
| `STAGE_WORK_DIR` | Optional. The deploy job's work directory (keystores, manifests). Default `/tmp/robotmoney-stage-work`. Deleted on `chain down`. |
| `BASE_UPSTREAM_RPC` | Optional secret. A paid Base RPC for the Twin chain container. Default: the public endpoint. Never logged. |
| `TWIN_PIN_BLOCK` | Optional. The Base block the chain container pins. Default: the upstream head minus 2. |

## Vaults

All three vaults ship with assets that have usable pools: rmUSDC, rmPROTO (wETH and cbBTC) and rmRWA (deSPXA only, plain basket row, no oracle). rmAGENT and its Uniswap V4 price recorder are not deployed any more (ADR-0017). Coinbase stocks are phase two.

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
- **Catch-up target (issue 1769).** One tick reads at most `INDEXER_MAX_BLOCKS_PER_TICK` blocks with one `eth_getLogs`. A tick with no events sends at most 10 JSON-RPC requests besides its vault snapshot reads, and a quiet tick sends at most 10 in all (asserted by `tests/catch_up_budget.rs` with the vaults of the deployment under test, four on the live v0.5.0 line on 8453): 4 (`eth_blockNumber`, the cursor reorg check, one `eth_getLogs` and the cursor header) plus seven snapshot `eth_call`s for each vault the tick reads (`totalAssets`, `totalSupply`, `previewRedeem(totalSupply())`, `exitFeeBps`, `tvlCap`, `perDepositCap` and `depositsPaused`; QA plan X8, issue 1795, added `previewRedeem`). A tick reads a vault only when the vault has no snapshot yet, emitted a watched log in the tick, holds nothing, has an unknown cap, or is due its 7200-block heartbeat (issue 1781). So a quiet catch-up tick reads no vault, and only the first tick of a database reads every vault once (28 `eth_call`s for four). Each event block adds its header and one receipt per transaction that carries a watched log, never the block's other transactions (QA plan X6). Measured on `mainnet.base.org`, one 1000-block tick took about 4.5 minutes (about 220 blocks per minute), because its 429 answers are retried with doubling waits. **The rate on the `--logs-rpc` endpoint is unmeasured** (issue 1780). No catch-up on `base.gateway.tenderly.co` has been timed, so 1000 blocks per minute (one full tick per minute, 33 times the Base block rate of 30 blocks per minute) is a target, not a number to plan a catch-up on. Measure it as the next bullet says and replace the target with the measured rate. The recommended values are `INDEXER_RPC_MAX_RETRIES` 6, `INDEXER_RPC_BACKOFF_MS` 1000 (waits of 1, 2, 4, 8, 16 and 32 s, capped at 32 times the base, and a `Retry-After` header raises a wait up to that cap) and `INDEXER_MAX_BLOCKS_PER_TICK` 1000 (the most `eth_getLogs` of `base.gateway.tenderly.co` allows). A catch-up from the 8453 start block to the head is the head minus 52401633 blocks divided by 1000 ticks.
- **Measuring the catch-up rate (issue 1780).** Measure on a build that has QA plan X6 (an event block fetches only the transactions that carry a watched log). Three steps on the stage host:
  1. `bun scripts/stage/core-stack.ts dapp down --chain 8453`.
  2. `bun scripts/stage/core-stack.ts dapp up --chain 8453 --rpc <base rpc url> --logs-rpc https://base.gateway.tenderly.co --manifests <copy of the manifests dir> --start-block 52401633`. The postgres service has no named volume, so the down and the up give an empty index and the indexer catches up from the start block. Until it is caught up, a dapp on this stack shows `indexer M blocks behind (head H)`.
  3. `bun scripts/stage/measure-catch-up.ts [--explorer-port P] [--minutes 30] [--json]`. It reads the indexer container's settings with `docker inspect` and refuses an indexer with no `INDEXER_LOGS_RPC_URL` (exit 65, `no-logs-rpc`) and an index already within one tick of the head (exit 1, `not-catching-up`). It polls `/health` every 10 s and stops when the index is within one tick of the head, at `--minutes`, or on Ctrl-C. It prints the blocks per minute between the first and the last cursor move it saw, the logs RPC and RPC origins (never a key), the `INDEXER_*` settings, the polls that saw a failed tick, and how long a full catch-up from the start block takes at that rate. It starts, stops and changes nothing.

  Record the printed rate, the date, the commit and the endpoints in the bullet above, in place of the target.
- **A refusing RPC is named, not retried.** HTTP 401 and 403 are final answers. The indexer stores and logs one line such as `rpc eth_getLogs refused by https://base-rpc.publicnode.com (HTTP 403) for blocks 52401633..52402632: ... set INDEXER_LOGS_RPC_URL (--logs-rpc) to an archive-capable logs RPC such as https://base.gateway.tenderly.co`. It names the endpoint origin (never the path or key), the method and the block range. It sends no retry, then waits 12 s, 24 s, 48 s and so on up to 300 s between ticks, and logs `indexer cannot make progress: an RPC endpoint refused the request; fix the endpoint and restart`. The same text is in `indexer_runs.error`. Fix: restart the stack with an archive-capable `--logs-rpc`.
- **Index progress and staleness.** The explorer `/health` reports `last_indexed_block` (the highest cursor of a run that finished without an error) and `chain_head_block` (the head that tick saw). Every `/v1/vaults` and `/v1/stats` response carries the same `block_number` and `chain_head_block`. The indexer reads blocks 5 behind the head, so a healthy index is about 5 blocks behind. The dapp prints `Block N` and, when the index is more than 30 blocks behind, `indexer M blocks behind (head H)`. `block_number` 0 means nothing is indexed yet and the dapp prints "Not indexed yet".
- **Safe and timelock.** The manifests builder passes `INDEXER_SAFE` and `INDEXER_TIMELOCK` (the `safe` and `timelock` addresses of `timelock.json`). The indexer watches only the addresses it is given, so both are listed in `/v1/chains/8453/contracts` (kinds `safe` and `timelock`) and their events are served at `/v1/governance/admin-events`: the timelock `CallScheduled`, `CallExecuted`, `Cancelled` and `MinDelayChange`, and the Safe `ExecutionSuccess`, `ExecutionFailure`, `AddedOwner`, `RemovedOwner` and `ChangedThreshold`. There is no proposals route: `RouterGovernance` has no voting (issue 1698), and the governed path is the Safe through the timelock. The events are read from the start block on, so the Safe setup events (before the start block) are not listed.
- **Deposits paused.** The registry status stays `Active` when a vault's own `pauseDeposits()` is set. `GET /v1/vaults` therefore carries `deposits_paused` (the vault's `depositsPaused()` at its latest snapshot, null until it has one). The dapp resolves one state per vault: registry paused or retired wins, then a live `depositsPaused()` read (a `true` always beats an index `false`), then the explorer. An answer that comes only from the explorer is shown as `Active (per index, block N)`, and only while the index is fresh (`block_number` above 0 and a KNOWN `chain_head_block` at most 30 blocks ahead of it; no head means unknown); a stale or unindexed index `false` is `Deposit state unknown`. A pause from the index is trusted at any age. Every deposit form (single vault, router, vault selector) is enabled ONLY in the known-open state: paused, retired and unknown disable it and show the reason (unknown: "Deposit state unknown: cannot confirm deposits are open"). Cards, the vault list and the detail page never print `Active` unless deposits are known open. Withdraw and redeem are not changed: `pauseDeposits()` closes the deposit side only. On the mainnet class the live read runs only with a wallet on Base, pinned to 8453.
- **Prices.** The price strip reads Uniswap V3 pools through the user's wallet (no dapp-owned RPC). On the mainnet class the read runs only with a wallet on Base. A cell that cannot be read says `price unavailable (wallet RPC: ...)` with the reason (no wallet on Base, wrong chain, or the read error). A failed refetch keeps the last good price and marks it `(may be old)`.
- **Known limit.** Block snapshots use `eth_call` at old blocks and each event block fetches its receipts. A node that keeps no old state or receipts answers those with errors. The indexer logs and skips a snapshot it cannot read. Use an archive endpoint when full history matters.
- **No signing, no faucet, no deploy.** The tool refuses to start (exit 65, class `signing-env-present`) when the environment holds a variable named like a key, mnemonic, passphrase, keystore, signer, deployer, faucet, `STAGE_SHEET` or `PUBLISH_*`. It builds the dapp with `VITE_ENV_CLASS=mainnet` and an empty `VITE_FAUCET_HARNESS_PRIVATE_KEY`, so the faucet is refused (`chainClassifier.ts`, `buildEnvValidation.ts`). It reads `docker compose config` and refuses unless every published port is on `127.0.0.1`.
- **Exposure (owner decision 2026-10-10, relayed by the plan owner's session).** Public exposure of the mainnet stage dapp is approved, through the cloudflared tunnel already configured on the stage host (`stage-dapp` and `stage-explorer` under `robotmoney-labs.dev`). That tunnel config is not in this repo and this tool never creates, edits or runs tunnel, DNS, Cloudflare or nginx configuration. The stack publishes on `127.0.0.1` only, which a tunnel on the same host reaches. The compose project is `robotmoney-dapp-8453`, the containers are `dapp8453-*`, and the default host ports are 15173 (dapp) and 18547 (explorer API), which differ from the Twin stack (5173 and 18546) so nothing existing is repointed by accident. To serve the public names the operator stops the Twin stack, then starts this one on the ports the existing tunnel forwards to (`--dapp-port` and `--explorer-port`, read from the host's tunnel config) and passes `--public-dapp-url` and `--public-explorer-url` so the bundle and the explorer CORS origin name the public URLs. Those two flags change only what the browser is told.
- **Warning: real funds.** Once the vaults open on 2026-10-12 anyone who reaches the public dapp can deposit REAL USDC (caps 1000 and 100 USDC, rmAGENT 100 and 15). The mainnet class shows a persistent "Base mainnet — real funds" banner and refuses every write unless the wallet is on Base (8453); see "Mainnet-class dapp safety" below. The overlay (`docker-compose.dapp.mainnet.yaml`) builds the dapp with `VITE_ENV_CLASS=mainnet`, `VITE_CHAIN_ID=8453` and an empty `VITE_DEVNET_RPC_URL` as build args, which `validateEnvClassForChain` accepts.
- **Never from CI.** No workflow runs this verb. The tests use a fixture and a fake `docker compose`.

## Stage dapp on rm-core-stage-1 pointed at Deploy 2 (core issue 1782, QA plan U8)

**Testers: use Deploy 3, not Deploy 2.** Deploy 3 is the current test deployment on Base. It was upgraded to v0.6.0 on 2026-10-29: rmAGENT is retired and the router splits across rmUSDC, rmPROTO and rmRWA. Its addresses and the steps to deposit and withdraw are in `docs/testing/base-mainnet-deposit-guide.md`. Deploy 2 below is an older, separate deployment with its own vault addresses (`deployments/8453/deploy-2/`). It was not upgraded, and its rmAGENT is not retired.

Deploy 2 is devops run 2 on Base 8453: release `release/v0.4.0-base.3-rehearsal` (core `78c50cbd`), a rehearsal-kind deployment. Its Safe `0xdFDea0E1AdF55a9a938bD34ead7920175b47Cb4b` governs through the timelock `0xd65165AF0Fb4062ED0da5D119d4B56B92b15356b`. Its router `0xB3a8e66d9E2980B54aC0e70e0e236486D1DCb356` holds the split a consensus receipt applied on 2026-10-11: rmUSDC 8550, rmPROTO 525, rmAGENT 575 and rmRWA 350 basis points (devops `docs/plans/deploy-correctness.md`, "Run 2 results"). The stage dapp for it is the read-only 8453 stack of the section above, run on `rm-core-stage-1`. It is not the Twin stage stack: `docker-compose.dapp.stage.yaml` joins the Twin chain network and plays no part here. Nothing in this section deploys a contract, and nothing on the stage host signs. It describes Deploy 2 as run 2 left it, before any rmPROTO redeploy (`docs/technical/single-vault-redeploy.md`).

**Status (2026-10-14): documented, not run.** Record the result in the last bullet. Deploy 2 is a four-vault deployment of the v0.5.0 line. The current tool reads three vaults (ADR-0017) and refuses a `timelock.json` whose `addresses.vaults` lists four, so this section runs from the v0.5.0 tag of the tool. The manifest list below is the three-vault set the current tool reads.

- **Manifest paths.** The originals are in run 2's evidence folder on the operator machine: `~/robotmoney-evidence/base-mainnet-r900/manifests/`. A byte-identical copy of all thirteen files is committed in `deployments/8453/deploy-2/` (QA plan v1 E10), for tests that must read Deploy 2 addresses and for the clean room gate's list. The 8453 stack reads eight of them, named by `scripts/deploy/stage-table.json` through `scripts/stage/stage-manifests.ts`: `gateway.json`, `registry.json`, `router.json`, `governance.json`, `timelock.json`, and the vault manifests `vault.json` (rmUSDC), `protocol-asset-vault.json` (rmPROTO) and `rwa-basket-vault.json` (rmRWA). It does not read `libs.json`, `recorder.json`, `ic-policy.json`, `safe.json` or `agent-token-vault.json` (rmAGENT is retired, ADR-0017), which sit in the same folder. Copy the whole folder to the stage host, outside the core checkout, and pass the copy: `scp -r ~/robotmoney-evidence/base-mainnet-r900/manifests rm-core-stage-1:deploy-2-manifests`. Every file says `chain_id` 8453. `timelock.json` records `code_hashes.router` and a `code_hash` for each of `vault_handover.vault_0` to `vault_3`, which the build-time code-hash pins (QA plan U5) need.
- **Start block.** `--start-block 52484018`. It is `firstBlock` in run 2's `evidence/publish-run.json`, the block in which the deployer created the Safe (`safe.json` `block`). 52401633 in the bullets above is run 1's first block. Do not reuse it for Deploy 2.
- **Build ref.** The stage host checkout builds the dapp image. It must contain the price recorder gate (PR 1761), the router deposit gas limit (core issue 1777, PR 1783, `ca7ecf61`) and the code-hash pins (QA plan U5). A dapp built before PR 1783 leaves the router deposit's gas to the wallet estimate, which can land under the router's 6,800,000 floor and revert `InsufficientGas` (`docs/technical/deposit-gas-1777.md`).
- **Command.** On `rm-core-stage-1`, from the core checkout, in a shell with no key-like variable (the verb exits 65, class `signing-env-present`, otherwise):

  ```
  bun scripts/stage/core-stack.ts dapp up --chain 8453 \
    --rpc <base rpc url> --logs-rpc https://base.gateway.tenderly.co \
    --manifests ~/deploy-2-manifests --start-block 52484018
  bun scripts/stage/core-stack.ts dapp status --chain 8453
  ```

  The Twin stage stack keeps its own ports and public names. The deposit below does not wait for the index to catch up: with a wallet on Base, the deposit form reads `depositsPaused()`, the effective weights and the recorder freshness from the chain.
- **Stage overlay keys.** The compose files are `docker-compose.dapp.yaml` and the 8453 overlay `docker-compose.dapp.mainnet.yaml`, compose project `robotmoney-dapp-8453`. `buildMainnetDappEnv` (`scripts/stage/mainnet-dapp.ts`) sets each key below from the manifest field or the flag named. No key is typed by hand.

  | Key | Source | Deploy 2 value |
  | --- | --- | --- |
  | `VITE_ENV_CLASS`, `VITE_CHAIN_ID` | builder, and the overlay's build args | `mainnet`, `8453` |
  | `INDEXER_CHAIN_ID`, `EXPLORER_API_CHAIN_ID`, `INDEXER_CHAIN_NAME` | builder | `8453`, `8453`, `base` |
  | `VITE_FAUCET_HARNESS_PRIVATE_KEY`, `VITE_DEVNET_RPC_URL`, `COMPOSE_PROFILES` | builder, empty on purpose | empty |
  | `VITE_GATEWAY_ADDRESS`, `INDEXER_GATEWAY` | `gateway.json` `gateway` | `0x8E866418Ba2c9120753b8f9B2C5F7c33246575BE` |
  | `VITE_GATEWAY_EXPECTED_CODE_HASH` | `gateway.json` `gateway_runtime_hash` | `0xaa8b1de9573731550d9cbe273a76590b5339f7bc616d3879306806b09cb781dd` |
  | `VITE_GATEWAY_EXPECTED_IMPLEMENTATION`, `VITE_GATEWAY_EXPECTED_IMPLEMENTATION_HASH` | `gateway.json` `gateway_implementation` and `gateway_implementation_runtime_hash`, both or neither; empty for a direct gateway (issue 1810) | empty, empty (Deploy 2 is direct) |
  | `VITE_VAULT_ADDRESS`, `INDEXER_VAULT` | `vault.json` `vault` (rmUSDC) | `0x28Bf6E6EDAD526191e8652ee631B56EAd4cE7435` |
  | `VITE_VAULT_ADDRESSES` | `vault` of the vault manifests (four on the live v0.5.0 line, three from v0.6.0, ADR-0017), in the order of `timelock.json` `addresses.vaults` | rmUSDC as above; rmPROTO `0x28C5ca4DF0107679bFcc9b0ad4c2f3F209b8f797`; rmAGENT `0x22bD48C56c34A2C1C1baC77BD7c4E636a6f10D57`; rmRWA `0x37Be372Bd32f9E63A94C7DB3ab415996658bcd50` |
  | `VITE_VAULT_EXPECTED_CODE_HASH` | `timelock.json` `vault_handover.vault_<i>.code_hash`, keyed by vault address | rmUSDC `0x37575f69ed37ca97ce4bd48a86161a31a01e6d4aa500521a0f607b16ab516ce5`; rmPROTO `0x6cf32003ce46eb8f8c69ccfa17d61d4b95b72fce22ae7b45b0058dfc25ff4fd8`; rmAGENT `0xd8e32680c955aefda70407d15e991ee5160ece35845bf75f69053417e724d530`; rmRWA `0x806af3ca8d1d1c4462f80e5e05cb1f397d8f3fe2f40258b1c23044cfac268214` |
  | `VITE_ROUTER_ADDRESS`, `INDEXER_PORTFOLIO_ROUTER` | `router.json` `router` (must equal `gateway.json` `gateway_router`) | `0xB3a8e66d9E2980B54aC0e70e0e236486D1DCb356` |
  | `VITE_ROUTER_EXPECTED_CODE_HASH` | `timelock.json` `code_hashes.router` | `0x48329ef938fb9a7bd2ce0d42b0718362f4ec736c5f05c4cfd76d757286302e26` |
  | `VITE_VAULT_EXPECTED_IMPLEMENTATION_HASH` | `timelock.json` `vault_handover.vault_<i>.implementation_code_hash`, keyed by vault address, for each vault whose stage manifest names a `vault_implementation` (ADR-0014) | `{}` (Deploy 2 is direct) |
  | `VITE_ROUTER_EXPECTED_IMPLEMENTATION_HASH` | `timelock.json` `code_hashes.router_implementation` when `router.json` names a `router_implementation` | empty (Deploy 2 is direct) |
  | `VITE_REGISTRY_ADDRESS`, `INDEXER_REGISTRY` | `registry.json` `registry` | `0x686EbEFda732DffA988253Ecf9c012946B8066A3` |
  | `INDEXER_ROUTER_GOVERNANCE` | `governance.json` `governance` | `0x59b593ab06bB5587534EfE255f6C614858b32754` |
  | `INDEXER_CONSENSUS_RECEIPT` | `timelock.json` `addresses.consensus_receipt` | `0xEfEe1c9881D1291460f72dA7000bA53e42eb36E2` |
  | `VITE_TIMELOCK_ADDRESS`, `INDEXER_TIMELOCK` | `timelock.json` `addresses.timelock` | `0xd65165AF0Fb4062ED0da5D119d4B56B92b15356b` |
  | `VITE_SAFE_ADDRESS`, `INDEXER_SAFE` | `timelock.json` `addresses.safe` | `0xdFDea0E1AdF55a9a938bD34ead7920175b47Cb4b` |
  | `INDEXER_START_BLOCK` | `--start-block` | `52484018` |
  | `INDEXER_RPC_URL` | `--rpc` | the operator's Base RPC, logged as its origin only |
  | `INDEXER_LOGS_RPC_URL` | `--logs-rpc` | `https://base.gateway.tenderly.co` |
  | `INDEXER_MAX_BLOCKS_PER_TICK` | `--max-block-range` | `1000` (default) |
  | `INDEXER_RPC_MAX_RETRIES`, `INDEXER_RPC_BACKOFF_MS`, `INDEXER_RPC_LABEL` | overlay | `6`, `1000`, `base-mainnet-readonly` |
  | `DAPP_PORT`, `EXPLORER_API_PORT` | `--dapp-port`, `--explorer-port` | `15173`, `18547` (defaults) |
  | `VITE_DAPP_URL`, `VITE_EXPLORER_API_URL` | the loopback URLs, or `--public-dapp-url` and `--public-explorer-url` | `http://127.0.0.1:15173`, `http://127.0.0.1:18547` |

- **Reaching it.** The default ports are bound to `127.0.0.1` on the stage host. Forward them from the operator's machine: `ssh -N -L 15173:127.0.0.1:15173 -L 18547:127.0.0.1:18547 rm-core-stage-1`. Then open `http://127.0.0.1:15173` (not `localhost`). Keep the same port numbers on both ends: the bundle calls the explorer at `http://127.0.0.1:18547`, and the explorer accepts only the origin `http://127.0.0.1:15173`. To serve Deploy 2 at the public stage names instead, follow "Exposure" above.
- **Who funds the 1 USDC deposit.** The operator, from a browser wallet they control. The stage stack is keyless: it holds no key, a mainnet build refuses a faucet key, and `dapp up` refuses to start with a key-like variable in its environment. Nothing on `rm-core-stage-1` can pay or sign. The operator signs in a browser wallet extension (an EIP-1193 wallet such as Rabby or MetaMask) on Base 8453, from a fresh account used only for this test. Fund that account before the run with 1 USDC (`1000000` units of Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) and about 0.001 ETH for gas. The router deposit goes out with an 8,000,000 gas limit (4 legs × 1,700,000 + 1,200,000, `clients/dapp/src/lib/depositGas.ts`), so the wallet must hold that limit times its maximum fee per gas. Unused gas is refunded. The money comes from the operator's own funds, or from two plain transfers by the deployer on the operator machine while no rehearsal runs (`cast send` with the deployer keystore, as in the deposit commands of `docs/operations/contract-release-runbooks.md` §4.3). Never import the deployer keystore, a Safe owner key, the emergency or pauser key, or the recorder keeper key into a browser wallet. Every rehearsal shares the deployer, which must keep one nonce writer, and the other keys hold roles on Deploy 2. The publish-time 1 USDC tests (runbook §4.3, standing rule 7) are different: the deployer sends them from the operator machine, not through a dapp.
- **The deposit.** Connect the wallet on Base. The page shows the "Base mainnet — real funds" banner. In the deposit form pick "Portfolio Router (all active vaults by weight)". The leg table must list four open legs of about 0.855, 0.0525, 0.0575 and 0.035 USDC. The router deposit stays disabled until every leg is known open. If the rmAGENT leg says its price is stale, press "Refresh price". It sends the permissionless `record()` to the rmAGENT recorder `0x0aDc14e6521aF213F9DCe5585D530f237831E934` from the same wallet, which pays its gas. Run 2's sheet set the rmAGENT NAV deviation guard to 100 bps (`VAULT_AGENT_NAV_DEVIATION_BPS`). After a quiet period the deposit simulation can still revert until the recorded average catches the pool price. The recorder keeper (`scripts/ops/recorder-keeper.sh`, runbook "Recorder keeper (issue 1779)") or repeated `record()` calls at least 60 s apart clear it (run 1 needed 13 calls over 25 minutes). Then approve exactly 1 USDC to the router and deposit 1 USDC.
- **Acceptance (issue 1782).** The deposit receipt has status 1 and one `RouterDeposit(receiver, vault, legAmount, sharesReceived, weightBps)` event per vault in the default vector (three from v0.6.0, ADR-0017), each with `sharesReceived` above 0. `cast receipt <tx hash> --rpc-url <base rpc url>` reads it with no key, and `cast call <vault> "balanceOf(address)(uint256)" <wallet> --rpc-url <base rpc url>` reads each position. Run 2's harness showed the same split funding all four vaults of the v0.5.0 line on 2026-10-12 (tx `0x346dd34f429ebe957a549789b9d6a6738f6a1eaba9051b60097ed9037ef3e845`). That run proves the router, not the dapp.
- **Redeem back.** rmUSDC, rmAGENT and rmRWA redeem from the Withdraw tab. Deploy 2's rmPROTO runs the bytecode from before the sell-floor fix (core issue 1778). Its USDC redeem of a leg this small can revert `Too little received` (`docs/technical/redeem-gas-1482.md`). The dapp then shows the in-kind hint, but it sends no `redeemInKind`. Call `redeemInKind(shares, receiver, owner)` on rmPROTO from the same wallet outside the dapp, or leave the dust.
- **Result.** Not run yet. After the run, record here the date, the dapp build commit, the deposit tx hash and block, and the four `legAmount` and `sharesReceived` values.

## What is not here

Stage has no second deployment path. These do not exist and a CI gate keeps them gone:

- a stage ceremony shell and a stage deploy shell. Publish contracts deploys, hands over to the Safe and verifies.
- a Rust harness deployment of core, registry, router, governance and the receipt. The deploy job calls publish contracts.
- a stage service that runs as a host process, or any container that mounts the Docker socket. `scripts/ci/check-stage-containers.ts` (suite 28) keeps that true, with digest-pinned base images and `--locked` builds.
- demo vaults, stub pools, demo depositor seeding and dapp faucet funding.
- a deploy workflow. Deploys are the publish contracts runbook.
- a single-key release in the Fusion acceptance script. The release is a govern row.
- a committed timelock or governance record for chain 918453. Manifests are written by each run.

The stage verbs (chain boot and health, publish and governance calls, parity, the record, dapp and rmpc checks) are Bun TypeScript in `scripts/stage/core-stack.ts` with typed arguments and structured JSON log lines. The old `core-stack.sh` shim is deleted: every caller runs `bun scripts/stage/core-stack.ts` directly. The file holds no deploy or ceremony logic. A CI grep gate (`scripts/stage/check-deleted-stage-scripts.ts`) enforces that and fails if the shim or any mention of it returns.

## No voting

There is no voting by anyone. The Safe, through the timelock, is the only body that changes contract configuration; router weights change only when it applies a consensus receipt (govern row `apply-receipt`, core 1696). `RouterGovernance` has no propose, vote or execute function (issue 1698). Its stage takes only the admin, router and consensus receipt addresses. Deployed release (v0.5.0): it runs after ic-policy. Target: it runs after the receipt stage. The sheet parser refuses the old voter, quorum, voting period and execution delay names. Agent registration and weights are govern rows executed through the real Safe and the timelock. Nothing sets them from a deployer key. `Fixture::set_voting_power` is gone. `Fixture::unpause_gateway`, `revoke_agent` and `reauthorize_agent` call govern rows. The Fusion acceptance release stage runs `core-stack governance apply --receipt-id ID --payload FILE` (govern row `apply-receipt`). `core-stack governance release` is refused with exit 64, because govern refuses row `release-receipt` since issue 1831 (issue 1849). No release keystore exists.

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
```

Every line above is required. No script has a default for it (`scripts/deploy/README.md`).

## Checks

| Check | Where |
| --- | --- |
| Vault manifests (three; ADR-0017) after a publish run | `core-stack publish run` (exit 66 on a short count) |
| Verifier labels on stage equal the mainnet label set | `scripts/stage/parity.ts` runs `label-diff.ts` on the verifier output the Twin chain smoke job saved (`SMOKE_TEST_VERIFY_OUT`) |
| Stage sheet versus production sheet differ only in parameter lines | `scripts/stage/parity.ts` runs `sheet-diff.ts` on the run sheet the smoke job saved (`SMOKE_TEST_SHEET_OUT`) |
| Router, basket vault and timelock role proofs | Labels of the one verifier (`publish-contracts/src/verify`): `registry: router() equals the deployed router`, `vault[KEY]: a second setRegistry reverts`, the role matrix, the asset config and `vault[rmAGENT]: lists exactly the shortlist asset of the config` |
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

