# Devnet runbook

> **Canonical:** `Plan tracking issue #109` §2 (Phase 1 gateway + vault). Twin chain: core issues 1498, 1496, owner decision 2026-10-05.

The devnet is the **Twin chain** (chain id 918453): a **pinned lazy fork of real Base state**,
made with anvil. It replaces the Geth + Lighthouse proof-of-stake devnet, its docker compose
chain stack, its genesis alloc and its snapshot genesis. All integration tests that need a live
chain boot through `Fixture::new()` in `testing/smoke-test`, which starts (or reuses) the Twin
fork, funds keys, deploys a vault of its own through the deploy scripts and reads every address
from the manifests.

```
anvil --fork-url <upstream> --fork-block-number <pin> --chain-id 918453
```

- **Upstream** defaults to the public endpoint `https://mainnet.base.org` (no key, no archive
  node). The env `BASE_UPSTREAM_RPC` overrides it. It is an optional secret for a paid provider.
  Nothing prints a URL that may carry a key: logs show the host only.
- **Pin** is the upstream head at the start of a run minus 2 (reorg safety). Every job of one CI
  run uses the same pin: one setup job chooses it (`.github/actions/twin-pin`) and the chain jobs
  take it as input (`.github/actions/twin-fork`).
- **Lazy** means anvil fetches state from the upstream on first read. There is no warm list, no
  `anvil_dumpState` snapshot, no patched state and no geth/lighthouse snapshot genesis. Anvil's
  RPC cache directory is persisted in CI (`actions/cache` keyed by the pin block). Anvil retries
  and our own startup retry handle HTTP 429.
- The fork contains the real production v1 Robot Money contracts because it is real Base state.
  **Clean room rule:** every test deploys its OWN vault through our deploy scripts and reads
  addresses from the manifests. No test reads the live production v1 vault, its adapters, the old
  admin Safe or any hard-coded Robot Money address.

## Environment steps that may differ from production

Only these three. Everything else (contracts, Safe, timelock, handover) runs exactly as in
production.

| Step | Tool | What it does |
|---|---|---|
| Fund gas | `bun scripts/devnet/twin-fork.ts fund-gas <address> <eth>` | `anvil_setBalance`. |
| Fund USDC | `bun scripts/devnet/twin-fork.ts fund-usdc <address> <base units>` | Writes the real FiatToken `balanceAndBlacklistStates[holder]` slot (mapping at slot 9), then checks `balanceOf`. Total supply is not changed. |
| Warp time | `bun scripts/devnet/twin-fork.ts warp <seconds>` | `evm_increaseTime` then `evm_mine`. Refuses chain id 8453. This is how the 48h governance waits run: no real waiting. |

The Rust harness calls the same tool: `Fixture::fund_gas`, `Fixture::fund_usdc` (a grant: it reads
the balance and sets balance + amount) and `Fixture::warp`.

## Starting the devnet

```bash
# Start (or reuse) the Twin chain, deploy a vault, print the endpoints. Stays up until Ctrl-C.
cargo run -p smoke-test            # add --full-stack for the dapp, explorer-api and indexer
```

Or from a Rust test:

```rust
let fixture = smoke_test::Fixture::new()?;
// A fork the fixture started is stopped when it drops.
```

### Reusing a running fork (`TWIN_RPC_URL`)

```bash
bun scripts/devnet/twin-fork.ts start --port 8545 --host 0.0.0.0 --block-time 1
export TWIN_RPC_URL=http://127.0.0.1:8545
cargo test -p smoke-test --release --test fixture_meta -- --test-threads=1
```

`Fixture::new()` reuses the fork named by `TWIN_RPC_URL` and never stops a fork it did not start.
Test binaries keep their fixture in a `OnceLock` static, which Rust never drops, so run test
binaries with `TWIN_RPC_URL` set (CI does). Without it a binary starts its own fork that outlives
the process: stop it with `make teardown-zombies`.

The fork needs `--host 0.0.0.0` when containers must reach it (the explorer-indexer reaches it
over the Docker bridge) and `--block-time 1` when the indexer runs (its safe head is tip minus 5,
so the tip must keep moving). A fork the harness starts uses both.

| Env | Meaning |
|---|---|
| `TWIN_RPC_URL` | A running Twin fork to reuse. |
| `TWIN_PIN_BLOCK` | Pinned block for a fork the harness starts. Empty means upstream head minus 2. |
| `TWIN_CACHE_DIR` | Directory that persists anvil's RPC cache (HOME for the anvil process). |
| `BASE_UPSTREAM_RPC` | Optional paid upstream. Never printed. |
| `SMOKE_TEST_RPC_PORT` | Pins the port of a fork the harness starts. |

See `scripts/devnet/README-twin-fork.md` for every flag, the stage host service (systemd unit and
docker one-liner) and the CI snippet.

## Prerequisites

- `anvil`, `forge` and `cast` on PATH (Foundry) and `bun`. `smoke_test::prerequisites_available()`
  checks all four.
- `docker` on PATH only for `--full-stack` (the dapp compose stack: Postgres, explorer
  indexer, explorer API, dapp) and for the explorer-indexer test containers.

## Compose stack (dapp only)

`testing/ethereum-testnet/config/docker-compose.dapp.yaml` is the only compose file. The chain is
no longer a container: the indexer reaches the host-side Twin fork through the Docker bridge
(`INDEXER_RPC_URL`, the bridge gateway address and the fork port). Services that only need an RPC
(explorer-indexer, dapp) point at `TWIN_RPC_URL`.

## CI

Every chain suite (5, 7, 8, 10, 11b and 14) has a `pin` job and starts the Twin fork with
`.github/actions/twin-fork` at that pin. The nightly (`suite-29-nightly-twin-chain.yml`) runs all
of them in one run with one shared pin. Suite 26 targets the shared stage Twin fork. See
`docs/development/ci-suites.md`.

## Saved fork-state fixture (forge golden fork tests only)

The Twin chain uses no saved state. A checked-in Anvil fork-state fixture
(`testing/fixtures/fork-state/CURRENT.anvil-state`) is still loaded by the forge golden fork tests
of suites 1 and 2 (`scripts/devnet/run-golden-forge-forks.sh`). For its purpose, the
`RMPC_FORK_RPC_URL` regeneration variable and the refresh command
(`scripts/devnet/snapshot-fork.ts`), see `docs/development/environments.md` §2 and ADR-0011.
The `anvil-goldens` and `anvil-governance` groups of suite 5 do not use it: they point
`RMPC_FORK_RPC_URL` at the Twin fork.

### Pin age (issue #1386)

The Aave V3 / Compound V3 / Morpho state the saved fixture holds is frozen at its pinned Base
block. Those protocols accrue interest as a function of `block.timestamp - lastUpdateTimestamp`,
so the simulated interval grows by one day per day the fixture is not refreshed.
`scripts/devnet/check-fork-pin-age.sh` makes the age visible: `check-fork-manifest.sh` calls it on
every run and annotates a `::warning::` past the 21-day cadence. It never fails there. Measured
from `CURRENT.json`'s `captured_at`, because `snapshot-fork.ts` advances the fork clock to
wall-clock now before warming the adapters. The Twin chain has no such age: its pin is the
upstream head minus 2 at the start of every run.

### Refreshing the saved fixture

```bash
bun scripts/devnet/snapshot-fork.ts
```

The script uses public Base endpoints only (with back-off on HTTP 429) and needs no key or
archive node. It deploys nothing: the snapshot holds third-party Base state and no Robot Money
contract. Into the committed fixture dir it also realigns `fork-block.json` and recaptures
`expected-prices.json`, at the same block as `CURRENT.json`. A refreshed fixture is judged by
`bun scripts/devnet/check-fork-snapshot-contents.ts` and
`scripts/devnet/check-fork-manifest.sh --require-pinned`.
`bun scripts/devnet/snapshot-fork-selftest.ts` is the offline selftest.

## Troubleshooting

- **Port already in use.** Another Twin fork is running. Stop it with
  `bun scripts/devnet/twin-fork.ts stop --port <port> --state-dir <dir>`, or run
  `make teardown-zombies`.
- **HTTP 429 from the upstream.** Anvil and the tool retry with backoff. Lower
  `--compute-units-per-second`, retry later, or set `BASE_UPSTREAM_RPC` to a paid provider.
- **`missing trie node` or a block too old.** The public endpoint is not an archive node. A pin
  must be recent: start the fork soon after choosing the pin, or choose a new pin.
- **`forge`, `cast`, `anvil` or `bun` not found.** Install Foundry
  (`curl -L https://foundry.paradigm.xyz | bash && foundryup`) and Bun.
- **`TWIN_RPC_URL reports chain id N`.** The URL is not a Twin fork. The harness refuses to run on
  it (chain id 8453 is Base mainnet).
