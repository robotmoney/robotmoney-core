# Testing Suite Ownership Matrix

This file maps every test suite root to its owner domain, run command, CI
workflow, required services/secrets, and the product promise it covers.

For the full CI pipeline design — job dependency graphs, step-by-step details,
and the environment key — see [docs/development/ci-suites.md](../docs/development/ci-suites.md).

---

## Suite roots

| # | Root | Owner domain | Environment | CI workflow |
|---|------|-------------|-------------|-------------|
| 1–2 | `contracts/test/` | Smart contracts | `anvil` | `suite-01-02-forge-tests.yml` |
| 5 | `testing/fork-e2e-rust/` | Rust client × mainnet adapters | `fork` | `suite-05-fork-integration.yml` |
| 14 | `testing/smoke-test/` | Devnet fixture library | `devnet` | `suite-14-smoke-test.yml` |
| 7 | `testing/ethereum-testnet/e2e-rust/` | Rust client × devnet | `devnet` | `suite-07-rmpc-integration.yml` |
| — | `testing/ethereum-testnet/typescript-sdk/` | TypeScript SDK × devnet | `devnet` | `suite-07-rmpc-integration.yml` |
| 15 | `testing/doctests/` | SDK doc-examples | `none` | `suite-04-rust-quality.yml` |
| 10 | `clients/dapp/tests/` | dApp E2E (Playwright) | `devnet` | `suite-10-dapp-e2e.yml` |
| 8 | `services/explorer-indexer/tests/` | Explorer indexer | `devnet` | `suite-08-explorer-indexer.yml` |

---

## Detailed entries

### 1–2. `contracts/test/` — Smart contract unit, invariant, and coverage

**Owner domain:** Smart contracts  
**CI workflow:** [`.github/workflows/suite-01-02-forge-tests.yml`](../.github/workflows/suite-01-02-forge-tests.yml)  
**Environment:** `anvil` (in-process; no Docker)  
**Required services/secrets:** none  
**docs/development/ci-suites.md reference:** [Suites 1–2](../docs/development/ci-suites.md#12-smart-contract-unit-tests-invariant-tests-and-coverage-gate)

**Run commands:**
```bash
# Unit tests
forge test

# Invariant / fuzz tests
forge test   # fuzzer settings in foundry.toml select invariant targets

# Coverage gate
forge coverage
```

**Product promise covered:**  
Every public function, access-control boundary, revert path, event emission,
and ERC-4626 rounding invariant on `RobotMoneyGateway`, `RobotMoneyVault`,
`PortfolioRouter`, `VaultRegistry`, and associated adapters is exercised.
A branch-coverage gate on `RobotMoneyGateway` is enforced by `check_gateway_coverage.py`.

---

### 5. `testing/fork-e2e-rust/` — Fork integration (Rust client × Base mainnet)

**Owner domain:** Rust client (`rmpc`) against already-deployed Base mainnet contracts  
**CI workflow:** [`.github/workflows/suite-05-fork-integration.yml`](../.github/workflows/suite-05-fork-integration.yml)  
**Environment:** `fork` — Anvil forked from a pinned Base mainnet block  
**Required services/secrets:** `RMPC_FORK_RPC_URL` (Base mainnet RPC endpoint with archive access). Tests skip loudly when the secret is absent.  
**docs/development/ci-suites.md reference:** [Suite 5](../docs/development/ci-suites.md#5-fork-integration-tests-protocol-adapters)

**Run commands:**
```bash
# Fast PR subset
cargo test --test abi_address_sanity --test vault_deposit_redeem_smoke \
  -- --test-threads=1

# Full suite (main / workflow_dispatch only)
cargo test \
  --test abi_address_sanity \
  --test vault_deposit_redeem_smoke \
  --test dex_route_smoke \
  --test failure_surface_smoke \
  --test gas_estimate_reality_check \
  --test rmpc_get_vault_fork_base_mainnet \
  --test rmpc_get_balance_fork \
  --test rmpc_get_allowance_fork \
  --test rmpc_get_tx_fork \
  -- --test-threads=1
```

**Product promise covered:**  
ABI encoding, contract addresses, and RPC error shapes produced by `rmpc` match
the contracts actually deployed on Base mainnet. Catches drift that only
surfaces against real deployed state (not fresh devnet contracts).

---

### 14. `testing/smoke-test/` — Devnet fixture library

**Owner domain:** `smoke-test` crate — the canonical devnet fixture used by suites 7, 8, 10, 11, 12  
**CI workflow:** [`.github/workflows/suite-14-smoke-test.yml`](../.github/workflows/suite-14-smoke-test.yml)  
**Environment:** `devnet` — real Geth + Lighthouse Docker Compose stack  
**Required services/secrets:** Docker available on the runner  
**docs/development/ci-suites.md reference:** [Suite 14](../docs/development/ci-suites.md#14-smoke-test-library)

**Run commands:**
```bash
# CLI meta test (boots full-stack, checks endpoint summary)
cargo test -p smoke-test --release --test cli_meta -- --nocapture

# Fixture meta test (boots devnet, deploys contracts, verifies RPC + blocks)
cargo test -p smoke-test --release --test fixture_meta \
  -- --test-threads=1 --nocapture

# Start the full stack manually
cargo run -p smoke-test -- --full-stack
```

**Product promise covered:**  
`Fixture::new()` reliably boots a real Geth+Lighthouse devnet, deploys all
contracts, and tears down cleanly. A failure here blocks all devnet-backed
suites before they pay their own boot cost.

---

### 7. `testing/ethereum-testnet/e2e-rust/` — Rust client integration (devnet)

**Owner domain:** `rmpc` binary against a real Geth+Lighthouse devnet  
**CI workflow:** [`.github/workflows/suite-07-rmpc-integration.yml`](../.github/workflows/suite-07-rmpc-integration.yml)  
**Environment:** `devnet` — Geth + Lighthouse Docker Compose stack; also an in-process nonce-race stress test (no chain)  
**Required services/secrets:** Docker available on the runner  
**docs/development/ci-suites.md reference:** [Suite 7](../docs/development/ci-suites.md#7-rust-client-integration-tests)

**Run commands:**
```bash
# Devnet-backed scenarios (sequential; each boots/tears down its own devnet)
cargo test --release --test smoke     -- --test-threads=1
cargo test --release --test scenarios -- --test-threads=1
cargo test --release --test window_cap -- --test-threads=1

# Nonce-race stress (in-process, no chain)
bash .github/scripts/stress_nonce_race.sh
```

**Product promise covered:**  
Full policy and failure scenarios for `rmpc` against a real devnet: deposit,
withdrawal, per-agent cap, nonce management, and window-cap enforcement.
Skill-doc parity and dApp TOML round-trip are also checked here.

---

### `testing/ethereum-testnet/typescript-sdk/` — TypeScript SDK × devnet

**Owner domain:** TypeScript SDK integration against a real Geth+Lighthouse devnet  
**CI workflow:** [`.github/workflows/suite-07-rmpc-integration.yml`](../.github/workflows/suite-07-rmpc-integration.yml)  
**Environment:** `devnet` — Geth + Lighthouse Docker Compose stack  
**Required services/secrets:** Docker available on the runner  
**docs/development/ci-suites.md reference:** [Suite 7](../docs/development/ci-suites.md#7-rust-client-integration-tests)

**Run commands:**
```bash
# From testing/ethereum-testnet/typescript-sdk/
bun install --frozen-lockfile
bun test
```

**Product promise covered:**  
TypeScript SDK calls (block production, minimal deployment, state proofs,
validator connectivity) work correctly against a live devnet chain.

---

### 15. `testing/doctests/` — SDK doc-examples

**Owner domain:** Rust crate public API — doc-example correctness  
**CI workflow:** [`.github/workflows/suite-04-rust-quality.yml`](../.github/workflows/suite-04-rust-quality.yml)  
**Environment:** `none` — pure compilation and unit execution; no chain  
**Required services/secrets:** none  
**docs/development/ci-suites.md reference:** [Suite 4](../docs/development/ci-suites.md#4-rust-quality-gate)

**Run commands:**
```bash
# Run doctests across all crates
cargo test --doc --all-features

# Or specifically for the doctests crate
cargo test -p doctests
```

**Product promise covered:**  
Every public Rust API carries accurate runnable documentation. Doc examples
that drift from the implementation are caught before they mislead contributors.

---

### 10. `clients/dapp/tests/` — dApp E2E (Playwright)

**Owner domain:** dApp — end-to-end browser flows against a live devnet  
**CI workflow:** [`.github/workflows/suite-10-dapp-e2e.yml`](../.github/workflows/suite-10-dapp-e2e.yml)  
**Environment:** `devnet` — smoke-test full stack booted by Playwright's `globalSetup`  
**Required services/secrets:** Docker available on the runner; `VITE_GATEWAY_EXPECTED_CODE_HASH` pinned at build time  
**docs/development/ci-suites.md reference:** [Suite 10](../docs/development/ci-suites.md#10-dapp-e2e-tests)

**Run commands:**
```bash
# From clients/dapp/
bun install --frozen-lockfile
bunx playwright install --with-deps chromium

# Run all E2E specs (globalSetup boots the full devnet stack automatically)
bun run test:e2e

# Run a single spec
bunx playwright test tests/e2e/<spec-file>.spec.ts
```

**Product promise covered:**  
The dApp's full deposit and read flows work in a real Chromium browser against
a live Geth+Lighthouse devnet. A JS-level EIP-1193 provider (injected via
`page.addInitScript`) drives the production wagmi connector — no test-only
code in `src/`. Gateway code-hash verification runs the production path.

---

### 8. `services/explorer-indexer/tests/` — Explorer indexer

**Owner domain:** `explorer-indexer` service — block ingestion, migrations, reorg handling  
**CI workflow:** [`.github/workflows/suite-08-explorer-indexer.yml`](../.github/workflows/suite-08-explorer-indexer.yml)  
**Environment:** `devnet` for reorg/finality tests; Postgres testcontainer + Anvil for fast unit tests  
**Required services/secrets:** Docker available on the runner (Postgres testcontainer started by the test itself)  
**docs/development/ci-suites.md reference:** [Suite 8](../docs/development/ci-suites.md#8-explorer-indexer-tests)

**Run commands:**
```bash
# Fast tests (Postgres testcontainer + Anvil; no Geth/Lighthouse)
cargo test --test migrations   # migration idempotency
cargo test --test idempotency  # block ingestion double-count guard
cargo test --test rpc_failure  # RPC failure recovery

# Devnet tests (real Geth + Lighthouse required)
cargo test --test fork_indexer  # reorg handling, finality-gated indexing

# Multi-vault and vault registry tests
cargo test --test multi_vault
cargo test --test vault_registry
```

**Product promise covered:**  
Deposit events are indexed exactly once (idempotency), database migrations
run cleanly and are idempotent, the indexer reconnects and resumes after
an RPC failure, and reorgs are handled correctly (orphaned-block rows are
removed) against real Geth+Lighthouse fork-choice.

---

## Environment key

| Symbol | Meaning |
|--------|---------|
| `devnet` | Geth + Lighthouse Docker Compose stack (`testing/ethereum-testnet/config/`). Lifecycle owned by the test code. |
| `anvil` | In-process Anvil EVM. No Docker. |
| `fork` | Anvil forked from a pinned mainnet block via `RMPC_FORK_RPC_URL`. Skips loudly when the secret is absent. |
| `none` | No chain. Static analysis, pure unit tests, doc checks. |

See [docs/development/ci-suites.md](../docs/development/ci-suites.md) for the full
environment description and per-suite job dependency graphs.
