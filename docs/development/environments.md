# Robot Money — Environment Modes

This document is the single operator reference for every environment mode used
in development, testing, and production. It covers:

- [1. Local devnet (the Twin chain)](#1-local-devnet-the-twin-chain)
- [2. Fork e2e (Anvil fork of Base mainnet)](#2-fork-e2e-anvil-fork-of-base-mainnet)
- [3. Full-stack staging (devnet + dapp + indexer)](#3-full-stack-staging-devnet--dapp--indexer)
- [4. Mainnet read-only (Base mainnet)](#4-mainnet-read-only-base-mainnet)

Each section lists: required env vars, startup command, contract address source,
data persistence behaviour, and teardown command.

Canonical: Plan tracking issue #109 (formerly `Plan tracking issue #109`). Related design docs:
`docs/technical/full-stack-devnet.md`, `docs/development/smoke-test-design.md`,
`docs/development/testing-strategy-ethereum.md` (both test stacks — the Twin chain
and the forked Base harness). The principle these modes embody —
one production codebase, environments differing only by configuration and
seeded data — is `docs/development/single-production-codebase.md`.

---

## 1. Local devnet (the Twin chain)

The **Twin chain**, chain id **918453**: a pinned lazy fork of real Base state made
with anvil (`anvil --fork-url <upstream> --fork-block-number <pin> --chain-id 918453`),
started by `scripts/devnet/twin-fork.ts`. Canonical Base contracts (USDC at
`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) are real Base state. The harness
deploys its own Robot Money contracts fresh each time through the deploy scripts and
reads the addresses from the manifests. No geth, no lighthouse, no genesis snapshot.
The chain runs on the host, not in a container. Details: `docs/technical/full-stack-devnet.md`
and `scripts/devnet/README-twin-fork.md`.

### Services

Anvil only (a host process). The dapp stack (§3) runs in Docker and reaches the fork over
the Docker bridge.

### Required env vars

None are required for a basic devnet boot: the harness starts its own fork on a free
port. The following vars override defaults:

| Var | Default | Meaning |
|-----|---------|---------|
| `TWIN_RPC_URL` | _(unset)_ | A running Twin fork to reuse. The harness never stops a fork it did not start |
| `TWIN_PIN_BLOCK` | _(auto)_ | Pinned Base block for a fork the harness starts. Auto is the upstream head minus 2 |
| `TWIN_CACHE_DIR` | _(unset)_ | Directory that persists anvil's RPC cache between runs |
| `BASE_UPSTREAM_RPC` | `https://mainnet.base.org` | Optional paid upstream. A secret: never printed, never in a file |
| `SMOKE_TEST_RPC_PORT` | _(free port)_ | Host port of a fork the harness starts |

### Startup command

```bash
# Start (or reuse) the Twin chain, deploy contracts — stays running until Ctrl-C.
cargo run -p smoke-test
```

Or start the fork on its own and point tests at it:

```bash
bun scripts/devnet/twin-fork.ts start --port 8545 --host 0.0.0.0 --block-time 1
export TWIN_RPC_URL=http://127.0.0.1:8545
```

### Contract address source

The manifests the publish run wrote (`PUBLISH_MANIFEST_DIR`, one JSON per stage). The harness
reads them (`Fixture::gateway()`, `Fixture::vault()`, ...). No address is hard-coded.

### Data persistence

The fork keeps state in memory. Nothing persists past `twin-fork.ts stop`. Anvil's RPC cache
(state fetched from the upstream) persists under `TWIN_CACHE_DIR` and is keyed by pin block in CI.

### Teardown command

```bash
bun scripts/devnet/twin-fork.ts stop --port 8545 --state-dir <dir>   # or: make teardown-zombies
```

### CI suites that exercise this environment

| Suite | Workflow file |
|-------|---------------|
| Suite 5 — fork integration | `.github/workflows/suite-05-fork-integration.yml` |
| Suite 7 — rmpc integration | `.github/workflows/suite-07-rmpc-integration.yml` |
| Suite 8 — explorer indexer | `.github/workflows/suite-08-explorer-indexer.yml` |
| Suite 10 — dapp E2E (Playwright) | `.github/workflows/suite-10-dapp-e2e.yml` |
| Suite 11b — OpenCode headless | `.github/workflows/suite-11b-opencode-headless.yml` |
| Suite 12 — OpenClaw | `.github/workflows/suite-12-openclaw.yml` |
| Suite 14 — smoke-test fixture | `.github/workflows/suite-14-smoke-test.yml` |
| Suite 29 — nightly Twin fork (one shared pin) | `.github/workflows/suite-29-nightly-twin-fork.yml` |

---

## 2. Fork e2e (Anvil fork of Base mainnet)

An Anvil instance forked from a pinned Base mainnet block. Chain id **8453**.
Real deployed contracts (USDC, Robot Money vault, adapters) are present at
their canonical addresses. Used to verify ABI encoding, adapter call paths,
and error handling against actual on-chain state without a live RPC at
test runtime.

### Services

Anvil only — no Docker required. Each test boots its own `anvil --fork-url $RMPC_FORK_RPC_URL`
child. In CI, `RMPC_FORK_RPC_URL` is the Twin fork (§1), so each test forks the Twin chain at the
run pin and can warp and rewind without touching the shared chain. There is no saved fork-state
fixture any more. The forge fork tests of suites 1 and 2 read `FORK_RPC_URL` (the Twin fork) and skip
with a named reason when it is unset.

### Required env vars

| Var | Required | Meaning |
|-----|----------|---------|
| `RMPC_FORK_RPC_URL` | Yes | Upstream for each test's fork: the Twin fork URL (`$TWIN_RPC_URL`) or a Base mainnet archive endpoint. In CI the suite-05 fork slots set it to the Twin fork. The forge fork tests read `FORK_RPC_URL` instead (the Twin fork URL). In CI a keyed upstream (`BASE_UPSTREAM_RPC`) must be a repository or organization Actions **secret**, not a variable: this repo is public, and GitHub does not mask `vars.*` values anywhere they appear. Scripts never print its value. |
| `RMPC_FORK_BLOCK` | No | Decimal block number pin. The suite-05 fork slots set it to the Twin pin (`TWIN_PIN_BLOCK`). Unset → `eth_blockNumber - 50` against the upstream RPC. |
| `RMPC_TESTNET_RPC_URL` | No | Connect straight to a running Twin fork (no second anvil), as the suite-05 `twin-*` slots do. |

### Startup command

```bash
# Run fork e2e tests against a running Twin fork (see §1).
RMPC_FORK_RPC_URL=$TWIN_RPC_URL RMPC_FORK_BLOCK=$TWIN_PIN_BLOCK \
  cargo test --manifest-path testing/fork-e2e-rust/Cargo.toml

# Or against a live Base mainnet fork (requires an archive RPC).
RMPC_FORK_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<key> \
  cargo test --manifest-path testing/fork-e2e-rust/Cargo.toml
```

For the read-only OpenCode walkthrough, boot Anvil directly:

```bash
anvil --fork-url "$RMPC_FORK_RPC_URL" --port 8545 --silent &
```

See `docs/development/opencode-readonly-fork.md` for the full walkthrough.

### Contract address source

The fork-e2e harness (`testing/fork-e2e-rust`) names no Robot Money address. Each fixture deploys its own vault on first use through the one deploy driver (`bun publish-contracts/src/cli.ts --stage vault`, the deployer is a throwaway encrypted keystore made by the rehearsal key helper, Twin chain 918453 only) and reads the vault and adapter addresses from the manifest the stage wrote (`ForkFixture::vault`, `crate::deployed`). When `RMPC_DEPLOY_MANIFEST` names a merged manifest from the publish contracts flow, the fixture reads that instead and deploys nothing. This is the clean room rule (core 1498): no test reads the live production v1 vault, its adapters or the old admin Safe.

`testing/fork-e2e-rust/src/addresses.rs` holds third-party addresses only (USDC, venues, DEX router, pools, tokens). The same set is listed in `scripts/deploy/third-party-addresses.json`. `scripts/ci/check-no-production-addresses.ts` fails CI when a test or harness file hard-codes a Robot Money production address.

For the read-only walkthrough the gateway address is a placeholder
(`0x000000000000000000000000000000000000dEaD`) — reads return a partial
envelope; no writes are attempted.

### Data persistence

Anvil state is ephemeral. Each test boots a fresh Anvil child process and
tears it down when the test exits (no `evm_snapshot`/`evm_revert`
orchestration — fork-restart-per-test isolation per ADR §3.5).

### Teardown command

Anvil stops automatically when the test process exits. For a manually started
Anvil:

```bash
pkill -f 'anvil --fork-url'
```

### The Twin fork pin (replaces refreshing a saved fixture)

There is nothing to refresh. The Twin chain pins the upstream head at the start of each run minus 2, so every run is as fresh as the upstream allows. A change that adds an adapter or wires a new pool needs no fixture commit. The nightly (suite 29) runs the chain suites at one shared pin and uploads the pin file.

```bash
# Run the forge fork tests on a Twin fork of your own.
bun scripts/devnet/twin-fork.ts start
export TWIN_RPC_URL=http://127.0.0.1:8545
bun scripts/devnet/safe-set.ts
bun scripts/devnet/forge-fork-tests.ts -- --match-path "contracts/test/VaultForkRegressions.t.sol"
```

### CI suites that exercise this environment

| Suite | Workflow file |
|-------|---------------|
| Suite 5 — fork protocol-adapter integration | `.github/workflows/suite-05-fork-integration.yml` |

---

## 3. Full-stack staging (devnet + dapp + indexer)

The local devnet (§1) plus Postgres, a one-shot explorer-migrate schema
step, explorer-indexer, explorer-api, and the dapp all running together in
Docker Compose. Used to validate the complete Robot Money service graph
end-to-end.

### Services

The Twin chain (§1) plus:

| Service | Role |
|---------|------|
| `postgres` | Explorer persistence |
| `explorer-migrate` | One-shot `indexer --migrate-only`: applies the explorer schema, then exits. `explorer-indexer` and `explorer-api` both wait on it with `service_completed_successfully`, so a failing migration stops the stack instead of leaving either service running against a half-migrated database (issue #1359) |
| `explorer-indexer` | Chain event indexer. Does **not** migrate on boot — instead it **refuses to start** unless every `(version, checksum)` row applied in `_sqlx_migrations` matches the migration set embedded in the binary (issues #1392, #1429). The refusal names the first diverging migration and its shape: `is embedded in this binary but is not applied` needs the migrate step run; `its content has changed since` means an applied migration was edited in place; `this binary does not embed it` means a rollback to an older image, which `--migrate-only` cannot fix. None of these is fixed by a restart |
| `explorer-api` | REST API serving indexed data |
| `dapp` | Built Vite bundle served by nginx |

Compose file: `testing/ethereum-testnet/config/docker-compose.dapp.yaml` (the dapp stack). The chain is the Twin fork on the host.

### Required env vars

Dapp overlay (`docker-compose.dapp.yaml`) requires:

| Var | Default | Meaning |
|-----|---------|---------|
| `VITE_GATEWAY_ADDRESS` | _(none — required)_ | Deployed gateway contract address |
| `VITE_VAULT_ADDRESS` | _(none — required)_ | Deployed vault contract address |
| `INDEXER_GATEWAY` | _(none — required)_ | Same as `VITE_GATEWAY_ADDRESS` |
| `INDEXER_VAULT` | _(none — required)_ | Same as `VITE_VAULT_ADDRESS` |
| `VITE_EXPLORER_API_URL` | `http://localhost:8080` | Explorer API base URL |
| `INDEXER_RPC_URL` | `http://host.docker.internal:8545` | Twin chain RPC URL for the indexer, as seen from the container |
| `INDEXER_CHAIN_ID` | `918453` | Chain id |
| `INDEXER_CHAIN_NAME` | `devnet` | Chain name label |
| `EXPLORER_API_CHAIN_ID` | `918453` | Chain id for the explorer API |
| `POSTGRES_PORT` | `5432` | Postgres host port |
| `EXPLORER_API_PORT` | `8080` | Explorer API host port |
| `DAPP_PORT` | `5173` | Dapp host port |
| `POSTGRES_USER` | `robotmoney` | Postgres user |
| `POSTGRES_PASSWORD` | `robotmoney` | Postgres password |
| `POSTGRES_DB` | `explorer` | Postgres database name |
| `VITE_ENV_CLASS` | `fork` | One of: `fork` \| `devnet` \| `testnet` \| `mainnet`. Set to `devnet` for this mode. |
| `VITE_GATEWAY_EXPECTED_CODE_HASH` | _(empty)_ | Keccak-256 of deployed gateway bytecode. The dapp refuses admin writes until this matches. Set from `deployments/devnet.json` field `gateway_runtime_hash`. |
| `VITE_RM_TOKEN_ADDRESS` | `0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3` | RM token address for the balances panel RM row (issue #466). RM is the live ROBOTMONEY token on Base; nothing deploys an RM token (core 1489), and the Twin fork carries the live token at the same address. The smoke-test threads `RM_TOKEN_ADDRESS_HEX` here. The faucet does not drip RM. |
| `VITE_FAUCET_DRIP_ETH_WEI` | `10000000000000000` (0.01 ETH) | Native Base ETH gas drip amount for the Faucet tab's "Get Base ETH" button (issue #466). Documented for parity with `FAUCET_DRIP_AMOUNT_ETH` in `clients/dapp/src/lib/chainClassifier.ts`. |

Additional optional dapp vars are documented in `clients/dapp/.env.example`.

### Startup command

```bash
# One command: boots chain, deploys contracts, starts dapp + indexer.
# Prints rpc_url, explorer_api_url, dapp_url, gateway_addr on stdout.
cargo run -p smoke-test -- --full-stack
```

Manual bring-up (after obtaining contract addresses from §1):

```bash
export VITE_GATEWAY_ADDRESS=<gateway>
export VITE_VAULT_ADDRESS=<vault>
export INDEXER_GATEWAY=$VITE_GATEWAY_ADDRESS
export INDEXER_VAULT=$VITE_VAULT_ADDRESS

cd testing/ethereum-testnet/config
docker compose -f docker-compose.dapp.yaml up --build
```

### Per-service restart and rebuild

`explorer-indexer` and `explorer-api` are built as two **separate images**
from two targets of `docker/rust-services.Dockerfile` (issue #1354), so either
can be rebuilt or restarted on its own. Iterating on one explorer service does
not require restarting the Twin fork or re-deploying contracts, and Postgres keeps its data.

The explorer services live in the dapp overlay's own compose project
(`robotmoney-dapp`); the chain is a separate project (`ethereum-testnet`) and
none of these commands touch it.

```bash
cd testing/ethereum-testnet/config

# Restart one service in place — no rebuild, same image.
docker compose -f docker-compose.dapp.yaml restart explorer-api

# Rebuild one service's image from source and recreate only that container.
docker compose -f docker-compose.dapp.yaml up -d --build explorer-api

# Follow one service's logs.
docker compose -f docker-compose.dapp.yaml logs -f explorer-indexer
```

Swap `explorer-indexer` for `explorer-api` to iterate on the indexer instead.
The `dapp`, `postgres`, and `receipt-fixtures` containers stay up throughout.

Every `docker compose` invocation — `restart` included — re-evaluates the
compose file's `${VAR:?...}` substitutions, so the same required env vars the
initial bring-up needed must still be exported. If the stack was launched by
`cargo run -p smoke-test -- --full-stack`, the harness also chose the host
ports; re-export `EXPLORER_API_PORT` / `DAPP_PORT` / `POSTGRES_PORT` to match
the URLs it printed, or compose republishes on the defaults in the table
above.

**`restart` does not re-evaluate `depends_on`.** `docker compose restart`
restarts an existing container in place; it does not recreate it and does not
re-check the `explorer-migrate: service_completed_successfully` barrier that
`up` uses to order the schema migration ahead of both readers. What still
fails safe on that path is explorer-api's own `/health` probe, which `SELECT`s
from `indexer_runs` (`clients/explorer-api/src/routes.rs`) and therefore
cannot report healthy while the explorer schema is missing. If a schema change
is part of what you are testing, use `up -d`, which evaluates the migrator
gate; `restart` will not run the migrator for you.

### Contract address source

Same as §1: the publish manifests. The smoke-test binary reads them
and passes the addresses as Docker build args automatically.

### Data persistence

Postgres data lives in a Docker named volume, wiped by `docker compose down -v`. The Twin fork keeps state in memory (§1).

### Teardown command

```bash
cd testing/ethereum-testnet/config
docker compose -f docker-compose.dapp.yaml down -v
```

When started via `cargo run -p smoke-test -- --full-stack`, send SIGINT
(Ctrl-C) — the binary's SIGINT handler runs `docker compose down` and stops the Twin fork it started.

### CI suites that exercise this environment

| Suite | Workflow file |
|-------|---------------|
| Suite 10 — dapp E2E (Playwright, full-stack) | `.github/workflows/suite-10-dapp-e2e.yml` |
| Suite 14 — smoke-test `--full-stack` CLI meta | `.github/workflows/suite-14-smoke-test.yml` |

---

## 4. Mainnet read-only (Base mainnet)

Connects `rmpc` to a live Base mainnet RPC for read-only portfolio inspection.
No transactions are signed. The OpenClaw harness uses this mode behind a
`RMPC_ALLOW_MAINNET=yes` guard.

Chain id: **8453**.

### Services

No local services. Operator provides a Base mainnet RPC endpoint.

### Required env vars

| Var | Required | Meaning |
|-----|----------|---------|
| `RMPC_CONFIG` | Yes | Path to an `rmpc` TOML config pointing at the mainnet RPC. See `BOOTSTRAP.md` §3 Profile B template. |
| `RMPC_ALLOW_MAINNET` | Yes (for OpenClaw harness) | Must be the literal string `yes` to pass the mainnet refusal guard in `testing/openclaw-config/openclaw_harness.sh`. |
| `RMPC_KEYSTORE_PASSPHRASE` | Yes | Keystore decryption passphrase. Never echoed; passed via environment only. |
| `RMPC_STATE_DIR` | Yes | State directory path. `rmpc` exits silently with code 3 if unset. |

Config template (save as `./rmpc-mainnet.toml`):

```toml
chain_id             = 8453
rpc_url              = "https://mainnet.base.org"   # replace with your archive endpoint
gateway_address      = "0x0000000000000000000000000000000000000000"  # not deployed; reads return partial envelope
usdc_address         = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
vault_address        = "<your vault address, from the deploy manifest>"
state_dir            = "./rmpc-state"

[signer]
allow_software_fallback = true
keystore_path           = "./keystore.json"
```

### Startup command

```bash
# Read-only vault inspection.
RMPC_KEYSTORE_PASSPHRASE="<passphrase>" \
  rmpc get-vault --config ./rmpc-mainnet.toml --pretty

# OpenClaw bounded monitor (read-only, requires RMPC_ALLOW_MAINNET guard).
RMPC_CONFIG=./rmpc-mainnet.toml \
RMPC_NETWORK=mainnet \
RMPC_ALLOW_MAINNET=yes \
RMPC_MONITOR_COMMAND=get-vault \
  bash testing/openclaw-config/openclaw_harness.sh
```

See `docs/development/opencode-readonly-fork.md` for the fork-based
read-only walkthrough (no mainnet RPC required).

### Contract address source

Fixed Base mainnet addresses (see §2 table). Updated only when Robot Money
deploys new contracts. Authoritative record: `docs/technical/smart-contracts.md` §2.

### Data persistence

No local chain state. `rmpc` persists signer state to `RMPC_STATE_DIR`
between runs.

### Teardown command

No chain to tear down. Kill the `rmpc` process or let it exit naturally.

### CI suites that exercise this environment

| Suite | Workflow file |
|-------|---------------|
| Suite 11a — OpenCode smoke (mainnet gate) | `.github/workflows/suite-11a-opencode-smoke.yml` |
| Suite 12 — OpenClaw | `.github/workflows/suite-12-openclaw.yml` |

---

## Quick-reference table

| Mode | Chain id | Startup command | Address source | Persistent state |
|------|----------|-----------------|----------------|-----------------|
| Local devnet | 918453 | `cargo run -p smoke-test` | `deployments/devnet.json` | Docker volume (wiped on `down -v`) |
| Fork e2e | 8453 | `cargo test --manifest-path testing/fork-e2e-rust/Cargo.toml` | `testing/fork-e2e-rust/src/addresses.rs` | None (ephemeral per test) |
| Full-stack staging | 918453 | `cargo run -p smoke-test -- --full-stack` | `deployments/devnet.json` | Docker volumes (wiped on `down -v`) |
| Mainnet read-only | 8453 | `rmpc get-vault --config ./rmpc-mainnet.toml --pretty` | `docs/technical/smart-contracts.md` §2 | `RMPC_STATE_DIR` on disk |
