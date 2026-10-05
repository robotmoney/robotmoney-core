# scripts/devnet: the Twin chain tools (Bun flow)

**The Twin chain (918453) is a pinned lazy fork of real Base state** made with anvil (core 1498, 1496, owner decision 2026-10-05). `twin-fork.ts` starts it, funds gas and USDC, and warps time. See `README-twin-fork.md` and `docs/technical/full-stack-devnet.md`. The composite actions are `.github/actions/twin-pin` (one pin per run) and `.github/actions/twin-fork`. No Robot Money contract is deployed by the tool. Every test deploys its own vault through the production scripts and reads addresses from the manifests (clean room rule).

There is no saved state. The snapshot machinery is retired: no `snapshot-fork.ts`, no `.anvil-state` fixture, no genesis alloc, no state digest, no pin-age warning and no `fork-block.json` or `expected-prices.json`. The state is real Base, read lazily from the upstream at the pinned block.

## Files

| File | Purpose |
|---|---|
| `twin-fork.ts`, `twin-fork-lib.ts` | start, wait-ready, status, fund-gas, fund-usdc, warp, stop. The library holds the pin choice, the argv, the retrying JSON-RPC helper (HTTP 429 and 5xx back-off) and the keccak256 used for the USDC balance slot. |
| `safe-set.ts` | Reads the canonical Safe v1.4.1 contracts from a chain over RPC. Checks each code hash and the singleton lock (slot 4 equals 1). Exit 0 ok, 2 unreadable, 14 not canonical. The pinned hashes are the data the dependency manifest tools also read. |
| `forge-fork-tests.ts` | Runs `forge test` with `FORK_RPC_URL` set to the Twin chain. Fails a run in which no test executed (skips do not count). |
| `check-twin-chain-ci-selftest.ts` | Checks the CI wiring: one pin per run, every `twin-fork` step takes it, nothing names a retired file. |

## Tests (offline, no anvil, no network)

```
bun test scripts/devnet --timeout 60000
bun scripts/devnet/check-twin-chain-ci-selftest.ts     # needs yq
```

The fork tests of the contracts (`VaultForkRegressions`, `DeploySeedDeposit`, `SafeIntegration`, `GovernanceExecutePathAfterHandover`, `RwaBasketVaultFork`, `CoreStagesFork`, `GatewayRouterSplitStagesForkTest`) read `FORK_RPC_URL`. Unset, each skips with a named reason. Set, an unreachable endpoint fails the test.

```
bun scripts/devnet/twin-fork.ts start
export TWIN_RPC_URL=http://127.0.0.1:8545
bun scripts/devnet/safe-set.ts
bun scripts/devnet/forge-fork-tests.ts -- --match-path "contracts/test/VaultForkRegressions.t.sol"
bun scripts/devnet/twin-fork.ts stop
```

## Env

`BASE_UPSTREAM_RPC` (optional secret, a paid upstream, never printed), `TWIN_RPC_URL` (the URL the actions export), `FORK_RPC_URL` (read by the forge fork tests). No secret is required: the default upstream is the public `https://mainnet.base.org`.
