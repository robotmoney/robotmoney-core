# `rmpc-fork-e2e` — Forked Base mainnet E2E (Plan #109 §8)

Runs the shipping `rmpc` client against the **real deployed Base contracts** in
a local `anvil` fork, to catch ABI/address/RPC-shape drift that the
empty-genesis PoS devnet cannot see. Each scenario is a plain `#[test]`; the
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

The `anvil` backend runs in two modes:

- `anvil --load-state` — the checked-in golden fixture
  (`testing/fixtures/fork-state/`); offline, no secret.
- `anvil --fork-url` — a live Base fork via `RMPC_FORK_RPC_URL`.

**Current reality vs. target.** ADR-0011's end-state is that every merge-gating
fork test runs against the offline fixture (loud on a missing fixture, no CI
secret), with live Base realism handled by a **non-blocking nightly** drift
alarm on a free public RPC. That is the *target*, not yet reached: the
checked-in fixture carries contract bytecode but not the full Base-contract
storage, so the flagship scenarios (`vault_deposit_redeem_smoke`,
`dex_route_smoke`, `abi_address_sanity`) still require a **live**
`RMPC_FORK_RPC_URL` today and skip without it (`src/lib.rs:150-164`). See
ADR-0011 for the migration.

## Running

```sh
# Offline fixture (no RPC).
cargo test --manifest-path testing/fork-e2e-rust/Cargo.toml

# Live Base fork (needed by the flagship scenarios today).
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

Phase 1 deploys the gateway stack against a Geth+Lighthouse devnet and tests
`rmpc` end-to-end; this crate forks a Base block and tests the already-deployed
Robot Money contracts. They share no fixture parameters — addresses, RPC URL
semantics, signing keys, deploy step — so a common supertype would only push
branching into every test. Two crates by design.
