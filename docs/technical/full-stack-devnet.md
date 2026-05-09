# Devnet runbook

> **Canonical:** `docs/implementation-plan.md` §2 (Phase 1 gateway + vault).

The devnet is a local Geth + Lighthouse proof-of-stake chain managed by
the `testing/smoke-test` crate. All integration tests that need a live
chain boot through `Fixture::new()`, which starts the compose stack,
deploys contracts, and tears down on drop.

## Starting the devnet

```bash
# Boot Geth + Lighthouse and deploy gateway/vault contracts.
# Stays running until you Ctrl-C.
cargo run -p smoke-test
```

Or from a Rust test:

```rust
let fixture = smoke_test::Fixture::new()?;
// fixture tears down when dropped
```

## Prerequisites

- `docker` on PATH (for `docker compose`)
- `forge` and `cast` on PATH (Foundry)

`smoke_test::prerequisites_available()` checks all three and returns
`false` if any is missing.

## Compose stack

The compose file is `testing/ethereum-testnet/config/docker-compose.yaml`.
It defines:

- `geth` — execution layer (chain-id 32382)
- `lighthouse` — consensus layer (12-second blocks)
- `setup` — one-shot service that funds genesis accounts and deploys
  contracts via `forge script`

## Fork-state fixture

`testing/fork-e2e-rust` uses a separate checked-in Anvil fork-state
fixture (`testing/fixtures/fork-state/CURRENT.anvil-state`) for
fork-based contract tests. This fixture is loaded with `anvil --load-state`
and requires no live RPC at test time.

To refresh the fixture (developer-run, periodic):

```bash
# Uses public Base RPC by default; override with RMPC_FORK_RPC_URL.
bash scripts/devnet/snapshot-fork.sh
```

## Troubleshooting

- **Port 8545 already in use.** Another devnet instance is running.
  Stop it with `docker compose -f testing/ethereum-testnet/config/docker-compose.yaml down`.
- **`forge` or `cast` not found.** Install Foundry:
  `curl -L https://foundry.paradigm.xyz | bash && foundryup`.
- **`anvil --load-state` parse error.** The fixture is stale or was
  written by a different Anvil version. Regenerate with
  `bash scripts/devnet/snapshot-fork.sh`.
