# `rmpc-fork-e2e` — Forked Base mainnet E2E (Plan #109 §8)

Runs the shipping `rmpc` client against the **real deployed Base contracts** in
a local `anvil` fork, to catch ABI/address/RPC-shape drift that the
fresh deployment on the Twin chain cannot see. Each scenario is a plain `#[test]`; the
harness boots one anvil child per test (fork-restart-per-test isolation, no
shared backend). The Phase 1 devnet `Fixture` (`../ethereum-testnet/e2e-rust/`)
is deliberately **not** shared with this crate.

- **Decision** (goldens vs. live, non-blocking nightly drift, refresh
  ownership, no CI secret):
  [ADR-0011](../../docs/adr/ADR-0011-fork-test-golden-fixtures-and-nightly-drift.md)
- **Harness design:**
  [testing-strategy-ethereum.md](../../docs/development/testing-strategy-ethereum.md)
  § Forked Base mainnet harness (fork-e2e)
- **Run / refresh commands + env-var table:**
  [environments.md](../../docs/development/environments.md) §2
- **CI wiring:** [ci-suites.md](../../docs/development/ci-suites.md) §5

## Backend modes

- `RMPC_FORK_RPC_URL` — a fresh local `anvil --fork-url` of that upstream per test: a real archive
  endpoint, or the Twin fork (core 1498, `RMPC_FORK_RPC_URL=$TWIN_RPC_URL`,
  `RMPC_FORK_BLOCK=$TWIN_PIN_BLOCK`), so a test can warp and rewind without touching the shared chain.
- `RMPC_TESTNET_RPC_URL` — connect straight to a running Twin fork (no second anvil).

There is no saved `--load-state` fixture and no USDC storage seed in this crate. Accounts are funded
with the anvil admin RPCs (fund gas, fund USDC on the real FiatToken slot).

**Clean room gap.** The scenarios here still read the live production v1 addresses from
`src/addresses.rs`. The clean room rule (a test deploys its own vault and reads manifests) is met by
the smoke-test harness suites. These scenarios are to be rewritten onto it.

## Running

```sh
# Against a running Twin fork (bun scripts/devnet/twin-fork.ts start ...).
RMPC_FORK_RPC_URL=$TWIN_RPC_URL RMPC_FORK_BLOCK=$TWIN_PIN_BLOCK \
  cargo test --manifest-path testing/fork-e2e-rust/Cargo.toml

# Or against a live Base archive fork.
RMPC_FORK_RPC_URL=https://mainnet.base.org \
  cargo test --manifest-path testing/fork-e2e-rust/Cargo.toml
```

`anvil` must be on PATH (install via [Foundry](https://getfoundry.sh)). The
`RMPC_FORK_RPC_URL` / `RMPC_FORK_BLOCK` env vars are documented in
[environments.md](../../docs/development/environments.md) §2.

## Module layout

- `src/lib.rs` — `ForkFixture`, `Account`, JSON-RPC client, EIP-1559 signing.
- `src/addresses.rs` — Base contract addresses + the address-set hash.
- `src/scenarios.rs` — ABI-encode/decode helpers shared across the test files.
- `tests/<scenario>.rs` — one `#[test]` per scenario.

## Why no shared `Fixture` trait with the devnet harness?

Phase 1 deploys the gateway stack against the Twin chain and tests
`rmpc` end-to-end; this crate forks a Base block and tests the already-deployed
Robot Money contracts. They share no fixture parameters — addresses, RPC URL
semantics, signing keys, deploy step — so a common supertype would only push
branching into every test. Two crates by design.
