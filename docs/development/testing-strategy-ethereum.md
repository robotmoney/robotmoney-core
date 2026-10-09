# Ethereum Test Stacks Guide

Robot Money runs contract and integration tests against two Ethereum test
stacks, both anvil-based: (a) the Twin chain (chain id 918453), a pinned lazy fork
of real Base state where the harness deploys fresh contracts through the deploy
scripts, and (b) a forked-Base-mainnet harness that exercises the real deployed
Base contracts. This guide covers both.

## The Twin chain (smoke-test devnet)

Owner decision 2026-10-05 (core 1498, 1496). The Post-Merge PoS devnet (Geth + Lighthouse, four
validators, a generated genesis and a docker compose stack) is retired. The devnet is the Twin
chain: `anvil --fork-url <upstream> --fork-block-number <pinned> --chain-id 918453`, a pinned
**lazy** fork of real Base state started by `scripts/devnet/twin-fork.ts`.

- **Why anvil:** the chain under test is real Base state at a real block. The harness deploys its
  own vault through the one deployment scheme (the real Safe, the timelock, the verifier), so what
  is under test is our contracts and clients, not a consensus client. Anvil gives a pinned lazy
  fork, `anvil_setBalance`, `anvil_setStorageAt` and `evm_increaseTime` in one binary.
- **Environment steps that may differ from production:** fund gas, fund USDC (the real FiatToken
  balance slot) and warp time. The 48h governance waits run by warping.
- **Pin:** the upstream head at the start of a run minus 2. One pin per CI run. Anvil's RPC cache
  is persisted per pin block. The upstream defaults to `https://mainnet.base.org` and is overridden
  by the optional secret `BASE_UPSTREAM_RPC`.
- **Not tested here:** real proof-of-stake timing (12-second slots, fork choice, reorgs). Reorg
  handling in the explorer-indexer is covered by stub-RPC tests that script competing tips.

Runbook and flags: `docs/technical/full-stack-devnet.md` and `scripts/devnet/README-twin-fork.md`.

---

## Forked Base mainnet harness (fork-e2e)

The second stack forks **Base mainnet** into a local `anvil` backend and runs
the shipping `rmpc` client against the **real deployed Base contracts**, to
catch ABI/address/RPC-shape drift against the real deployed contracts, which a fresh deployment on the Twin chain cannot see.
Its durable design is recorded here; the CI goldens-vs-live decision lives in
[ADR-0011](../adr/ADR-0011-fork-test-golden-fixtures-and-nightly-drift.md), and
the run/refresh commands live in
[environments.md](./environments.md) §2 (Fork e2e).

### Design

- **Chain:** Base mainnet (chain id 8453). Tests exercise the real deployed
  Base contracts (vault, adapters, USDC, DEX pools) — the point is to test the
  actually-shipped bytecode, not fresh deployments.
- **Harness driver:** a Rust integration crate, `testing/fork-e2e-rust/`, that
  drives the same `rmpc` command surface that ships to users (no read/write
  path bypasses the CLI). It is a distinct crate from the Twin chain harness
  (`testing/ethereum-testnet/e2e-rust/`); the two deliberately do not share a
  `Fixture` type.
- **Backend:** `anvil` as the fork backend — `anvil --fork-url` of a live
  archive endpoint or of the Twin fork (core 1498). The retired saved
  snapshot fixture is no longer used by this crate. Chosen because anvil is the single tool
  that offers `eth_impersonate` (whale funding), fork-block pinning, and a
  one-binary backend with no consensus layer to run.
- **Per-test isolation:** fork-restart-per-test — each test boots its own anvil
  child and tears it down at exit (no `evm_snapshot`/`evm_revert`
  orchestration). Each test uses an ephemeral signer (`alloy-signer-local`)
  funded by impersonating a known Base USDC whale.
- **Block pin:** `RMPC_FORK_BLOCK` (decimal block number) pins the fork block;
  when it is unset, the harness uses `eth_blockNumber − N` (latest-minus-N) for
  local runs. Refresh cadence and CI wiring are ADR-0011's domain, not a fixed
  schedule.

### Fixture storage (retired for this crate)

The retired saved snapshot fixture carried contract **bytecode but not the full storage** of the Base
contracts, so the flagship Rust scenarios needed a live fork anyway. Since core 1498 the harness
forks a real upstream, and in CI that upstream is the Twin fork (a lazy fork of real Base at the run
pin), so the full storage is read on demand. There is no saved fixture to enrich. The forge golden
fork tests of suites 1 and 2 still load the saved fixture (ADR-0011).
