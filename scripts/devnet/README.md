# scripts/devnet: the Twin chain Base snapshot (Bun flow)

The Twin chain (918453) boots from a saved snapshot of third-party Base state. No Robot Money contract exists in it. The rehearsal deploys the production contracts with the production scripts (one deployment scheme). Canonical docs: `docs/technical/full-stack-devnet.md`, `docs/adr/ADR-0011-fork-test-golden-fixtures-and-nightly-drift.md`.

## Files it writes (all at one block)

| File | Block fields |
|---|---|
| `testing/fixtures/fork-state/CURRENT.json` | `fork_block`, `fork_block_hash`, `state_sha256` |
| `testing/fixtures/fork-state/CURRENT.anvil-state` | the anvil dump the digest binds |
| `testing/fixtures/fork-state/genesis-alloc.json` | address map from the genesis ingester |
| `testing/fixtures/fork-state/genesis-alloc.block.json` | `block_number`, `block_hash`, `alloc_sha256` (sidecar, since the alloc is an address map) |
| `testing/ethereum-testnet/config/fork-block.json` | `block_number`, `block_hash` |
| `testing/ethereum-testnet/config/expected-prices.json` | prices at that block |

## Flow

1. `bun scripts/devnet/snapshot-fork.ts` pins a block on a public Base endpoint (no key, no archive node, back-off on HTTP 429).
2. It boots anvil forking that block in Docker and warms third-party code: V3 factory, SwapRouter02, QuoterV2, every pool in `config/dex-pools.json`, the lending stack and the Safe v1.4.1 set.
3. It runs representative quotes and swaps so tick, bitmap and observation slots are in the dump.
4. It dumps state, writes `CURRENT.json` with the block hash and the sha256 binding, then writes `fork-block.json`, runs the genesis ingester and writes the `genesis-alloc.block.json` sidecar.
5. It runs the contents check on the result.

The nightly job (core 1496) uses `nightly-fresh-snapshot.ts` (`snapshot`, `realign`, `apply`) on a runner and commits nothing.

## Checks (CI)

- `bun scripts/devnet/check-fork-snapshot-contents.ts` boots anvil from the snapshot with no fork URL. It asserts code at SwapRouter02, QuoterV2, the V3 factory, the infrastructure and the Safe set, live `slot0`, `liquidity` and `observe` on every configured pool, `factory.getPool` agreement, and no Robot Money code at genesis.
- `bash scripts/devnet/check-fork-manifest.sh` verifies the digest, the Safe set and pin age, then `check-fork-lockstep.ts`, which asserts block number and hash are equal across `CURRENT.json`, `fork-block.json` and `genesis-alloc.json` (through its sidecar, bound to the alloc bytes by sha256).
- `bun scripts/devnet/snapshot-fork-selftest.ts` is the offline unit test. Its fixtures are in `scripts/devnet/fixtures/lockstep/`.

## Exclusions

- wSOL is excluded from the checked basket list explicitly (`EXCLUDED_BASKET_SYMBOLS` in `fork-snapshot-lib.ts`). The contents check fails if any config row names it.
- BNKR has no address in config (rmAGENT ships empty), so it is not warmed or asserted. If an address is added to `config/agent-token-shortlist.json`, the warm list and the check pick it up.

## Env

`RMPC_FORK_RPC_URL`, `FORK_PIN_LAG`, `FORK_CHAIN_ID`, `ANVIL_PORT`, `FOUNDRY_IMAGE`, `FIXTURE_DIR`, `SNAPSHOT_SWAP_USDC`, `SNAPSHOT_TICK_WORDS`, `SNAPSHOT_MAX_OBSERVATIONS`. See the header of `snapshot-fork.ts`. No secret is read.
