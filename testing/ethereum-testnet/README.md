# testing/ethereum-testnet

The Twin chain test assets. The chain (id 918453) is a **pinned lazy fork of real Base state** made with anvil (core 1498, 1496). The Geth + Lighthouse docker compose stack, its genesis generator and the TypeScript SDK that drove them are retired.

- `config/docker-compose.dapp.yaml` — the dapp stack (Postgres, explorer migrate, indexer, API, dapp). The indexer reaches the Twin fork on the host over the Docker bridge.
- `config/price-strip-pairs.json` — the landing price strip pools and a sanity band per pair. The pin moves every run, so there is no golden price (the saved fork-state fixture, `fork-block.json` and `expected-prices.json` are retired).
- `config/consensus-receipt-fixtures/` — static receipt payloads for the dapp e2e.
- `e2e-rust/` — the rmpc end-to-end scenarios (suite 7). Each binary deploys its own vault through publish contracts on the Twin chain.

Start the chain: `cargo run -p smoke-test` (or `bun scripts/devnet/twin-fork.ts start`). Runbook: `docs/technical/full-stack-devnet.md`. Flags: `scripts/devnet/README-twin-fork.md`.
