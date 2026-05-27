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

- `geth` — execution layer (chain-id 918453), genesis seeded from a
  pinned Base mainnet block (`alloc` populated from a Base state snapshot,
  not empty). Real Base contracts (USDC, WETH, …) are present at their
  canonical addresses from block 0 of the devnet.
- `lighthouse` — consensus layer (12-second blocks)
- `setup` — one-shot service that (a) patches token balance storage
  in genesis to grant a clean-history harness EOA a large balance of
  each test-relevant token (USDC at minimum), and (b) deploys Robot
  Money contracts via `forge script`. See
  `docs/development/smoke-test-design.md` for the genesis-time balance
  grant faucet design and the rationale for not impersonating a real
  Base whale.

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
