# `rmpc-fork-e2e` — Phase 2 Forked Smart-Contract E2E

> Canonical: [`docs/implementation-plan.md`](../../docs/implementation-plan.md) §8.
> Decision record: [`docs/technical/fork-e2e-decisions.md`](../../docs/technical/fork-e2e-decisions.md) (issue #47).
> Implements: issue #48.

This crate runs the five §8 fork scenarios against a forked Base
mainnet (`anvil --fork-url`) backend. Each scenario is a plain
`#[test]` — the harness boots one anvil child per test (per ADR
§3.5: fork-restart-per-test isolation, no shared backend, no
`evm_snapshot` / `evm_revert` orchestration). The Phase 1 e2e
`Fixture` lives in `../ethereum-testnet/e2e-rust/` and is **not**
shared with this crate; the two `Fixture` types deliberately do
not implement a common trait (ADR §3.6).

## Running

```sh
# One-line developer command (matches §8 acceptance criterion).
RMPC_FORK_RPC_URL=https://mainnet.base.org cargo test --manifest-path testing/fork-e2e-rust/Cargo.toml
```

The harness reads two environment variables:

| Var | Required | Meaning |
|---|---|---|
| `RMPC_FORK_RPC_URL` | yes | A Base mainnet archive RPC (Alchemy, Infura, or any archive endpoint). When unset, every scenario prints a skip line and exits 0 — `cargo test` on a contributor laptop without an RPC stays green. |
| `RMPC_FORK_BLOCK` | no | Decimal block number to pin. CI sets this in the workflow file so a pin change is visible in PR diff. When unset, the harness uses `eth_blockNumber - 50` against the upstream RPC. |

`anvil` must be on PATH (install via [Foundry](https://getfoundry.sh)).

## Scenario → trigger map (ADR §3.4)

| Scenario | Trigger |
|---|---|
| `abi_address_sanity` | every PR |
| `vault_deposit_redeem_smoke` | every PR |
| `dex_route_smoke` | manual + post-merge |
| `gas_estimate_reality_check` | manual + post-merge |
| `failure_surface_smoke` | manual + post-merge |

The CI workflow lives at [`.github/workflows/fork-e2e.yml`](../../.github/workflows/fork-e2e.yml).

## Pin-refresh runbook

ADR §3.2 mandates a monthly manual refresh of `RMPC_FORK_BLOCK`.
Procedure:

1. Read the current block: `cast block-number --rpc-url $RMPC_FORK_RPC_URL`.
2. Subtract at least 100 to stay clear of reorg risk.
3. Open a PR titled `chore(fork-e2e): refresh fork block pin to <N>` that updates the `env: RMPC_FORK_BLOCK:` line in `.github/workflows/fork-e2e.yml`.
4. CI must pass on the new pin before merge.

If a refresh PR's CI fails because the configured `USDC_WHALE`
(see [`src/addresses.rs`](src/addresses.rs)) has gone dry at the
new block, swap the whale to another large USDC holder on Base
in the same PR. Document the swap in the PR description.

## Module layout

- `src/lib.rs` — `ForkFixture`, `Account`, JSON-RPC client, EIP-1559 signing.
- `src/addresses.rs` — Base mainnet contract addresses + the address-set hash.
- `src/scenarios.rs` — small ABI-encode / decode helpers shared across the test files.
- `tests/<scenario>.rs` — one `#[test]` per §8 scenario.

## Why no shared `Fixture` trait with Phase 1?

Phase 1 deploys the gateway stack against a Geth+Lighthouse devnet
and tests `rmpc` end-to-end. Phase 2 forks Base mainnet and tests
the deployed Robot Money contracts. They share no fixture
parameters — addresses, RPC URL semantics, signing keys, deploy
step — so an artificial supertype would just push branching into
every test. ADR §3.3 / §3.6 explicitly opt for two crates.
