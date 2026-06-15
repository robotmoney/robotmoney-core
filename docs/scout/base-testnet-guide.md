# Base Testnet E2E Test Environment Guide

**Issue:** #842 (dev-scout)  
**Canonical modules:**
- `testing/fork-e2e-rust/src/base_testnet.rs` — Network parameter configuration
- `testing/smoke-test/src/base_testnet.rs` — Account funding configuration  
- `testing/smoke-test/tests/base_testnet_fixture.rs` — Fixture test stubs

**Full implementation (issue #839):** Contract deployment, faucet integration, parameterized e2e tests.

---

## Overview

Base testnet is a Sepolia-linked test network where Robot Money contracts have been deployed (or will be) alongside live third-party services (Aave, Curve, Uniswap). Parallel e2e tests against Base testnet validate multi-network adapter behavior without relying on devnet-only deployment machinery.

### Key differences from devnet tests

| Aspect | Devnet (smoke-test) | Base testnet (fork-e2e) |
|--------|-----|-----|
| **Chain lifecycle** | Fresh boots via Docker Compose + Geth/Lighthouse | Pre-existing chain (Base Sepolia) |
| **Contract deployment** | `forge script` at fixture time | Pre-deployed or deployed once at test startup |
| **Account funding** | `forge script` + storage-slot writes | Faucet API or seeded transfers |
| **RPC connectivity** | Hardcoded localhost ports | `BASE_TESTNET_RPC_URL` env var |
| **Test realism** | High isolation, reproducible state | Live service interactions, nonce races |

---

## Configuration

### RPC endpoint

Set `BASE_TESTNET_RPC_URL` to point to a Base Sepolia node:

```bash
export BASE_TESTNET_RPC_URL="https://base-sepolia.g.alchemy.com/v2/YOUR_API_KEY"
# or
export BASE_TESTNET_RPC_URL="http://localhost:8545"  # local node
```

Tests gracefully skip if the env var is unset.

### Environment variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `BASE_TESTNET_RPC_URL` | Base Sepolia RPC endpoint (required for live testnet tests) | `https://base-sepolia.g.alchemy.com/v2/...` |
| `BASE_TESTNET_FUNDER_KEY` | Private key of a faucet-funded Base Sepolia EOA; seeds ephemeral test accounts via signed transfers (`ForkFixture::ephemeral_testnet`). Unset ⇒ testnet legs skip. | `0xabc…` |
| `BASE_TESTNET_FUNDER_ADDR` | Address asserted by the smoke-test `eth_getBalance` funding gate (`base_testnet_account_funding_assertion`). | `0x1234…` |
| `BASE_TESTNET_USDC_ADDR` | Override for Base Sepolia USDC (defaults to Circle's `0x036C…cF7e`). | `0x036C…cF7e` |
| `RM_TESTNET_VAULT_ADDR` | Deployed `RobotMoneyVault` on Base Sepolia (deploy is a prerequisite, out of scope for #839). Unset ⇒ the vault-stack adapter leg (Compound/Morpho/Curve) skips. | `0x…` |
| `RM_TESTNET_<PROTO>_ADAPTER_ADDR` | Deployed strategy-adapter addresses (`AAVE_V3`, `COMPOUND_V3`, `MORPHO`). | `0x…` |
| `RMPC_FORK_RPC_URL` | Base mainnet archive RPC for local fork — required for the mainnet leg of the parameterized adapter test (fixture-only is skipped). | `https://base.g.alchemy.com/v2/...` |

---

## Test structure

### Multi-network parameterization

Tests use the `Network` enum to select configuration per-test:

```rust
use rmpc_fork_e2e::Network;

#[test]
fn deposit_mainnet() {
    let network = Network::BaseMainnet;
    let rpc_url = network.rpc_url()?;  // RMPC_FORK_RPC_URL
    // ...test mainnet scenario
}

#[test]
fn deposit_testnet() {
    let network = Network::BaseTestnet;
    let rpc_url = network.rpc_url()?;  // BASE_TESTNET_RPC_URL
    // ...test testnet scenario
}
```

**Future (issue #839):** A parameterized macro will avoid duplication:

```rust
#[parameterized_e2e(Network::BaseMainnet, Network::BaseTestnet)]
fn deposit(network: Network) {
    let rpc_url = network.rpc_url()?;
    // single test runs twice: once per network
}
```

### Account funding

The `AccountFundingConfig` struct holds seeding parameters:

```rust
use smoke_test::base_testnet::{AccountFundingConfig, FundingMethod};

let config = AccountFundingConfig {
    eth_amount_wei: 5_000_000_000_000_000_000,  // 5 ETH
    usdc_amount_units: 1_000_000_000,           // 1000 USDC
    funding_method: FundingMethod::Faucet,
};
```

**Acceptance criteria link:** Tests must verify account funding via `eth_getBalance` calls:

```bash
# CI job will run:
curl -X POST http://rpc:8545 \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "method":"eth_getBalance",
    "params":["0xTEST_ACCOUNT","latest"],
    "id":1
  }'
```

---

## Contract deployment

**Out of scope for #842** (scout only). Issue #839 will deploy or reference:

- Robot Money Gateway + Vault on Base Sepolia
- Aave V3 / Compound V3 / Morpho adapters on Base Sepolia
- USDC token (Base Sepolia canonical)

Deployment addresses will be stored in a registry module (e.g., `base_testnet::addresses` in issue #839).

---

## Known divergences from mainnet

1. **Block timing:** Base Sepolia produces blocks slower than mainnet (~12s vs ~2s). Increase test timeouts if polling for block production.

2. **Faucet availability:** Test account funding depends on external faucet APIs. Tests should skip gracefully if faucet is down (return `HarnessError::SkipNoRpc` or similar).

3. **Gas prices:** Base Sepolia gas prices fluctuate less predictably. Hard-coded gas estimates from mainnet may fail; use dynamic `eth_estimateGas`.

4. **Service availability:** Live Aave/Curve/Uniswap pools on Sepolia may have low liquidity. Test swap sizes appropriately (smoke amounts, not real deposit sizes).

---

## CI integration

The Base testnet adapter e2e runs as the `base-testnet-adapters` job in
`.github/workflows/suite-05-fork-integration.yml` (shipped in PR #849). The job
gracefully skips when `BASE_TESTNET_RPC_URL` is unset (the secret has no value).

```yaml
# .github/workflows/suite-05-fork-integration.yml (base-testnet-adapters job)
jobs:
  base-testnet-adapters:
    name: base-testnet-adapters
    runs-on: ubuntu-latest
    env:
      BASE_TESTNET_RPC_URL: ${{ secrets.BASE_TESTNET_RPC_URL }}
      BASE_TESTNET_FUNDER_KEY: ${{ secrets.BASE_TESTNET_FUNDER_KEY }}
      BASE_TESTNET_FUNDER_ADDR: ${{ secrets.BASE_TESTNET_FUNDER_ADDR }}
      RM_TESTNET_VAULT_ADDR: ${{ secrets.RM_TESTNET_VAULT_ADDR }}
    steps:
      - name: Base testnet account-funding assertion (smoke-test)
        run: cargo test -p smoke-test --release --test base_testnet_fixture -- --nocapture
      - name: Base testnet multi-network adapter e2e (fork-e2e)
        working-directory: testing/fork-e2e-rust
        run: cargo test --release --test multi_network_adapters -- --test-threads=1 --nocapture
```

---

## Troubleshooting

### "BASE_TESTNET_RPC_URL not set; skipping"

Normal behavior. Set the env var to run against real testnet.

### RPC timeout errors

Check that the RPC endpoint is reachable and responsive:

```bash
curl -X POST "$BASE_TESTNET_RPC_URL" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"net_version","params":[],"id":1}'
```

### Account funding fails

Verify faucet is operational. Base Sepolia faucet status:
- **Alchemy Faucet:** https://www.alchemy.com/faucets/base-sepolia (requires Alchemy account)
- **Dripcode Faucet:** https://dripcode.io/ (requires Twitter verification)

### Adapter calls fail on testnet

Verify the adapter is deployed to the expected address and has correct ABI. Check logs for `call failed` errors indicating address mismatches.

---

## Implementation status (issue #839)

Done in PR #849:

- [x] Base Sepolia live-service address registry —
  `testing/fork-e2e-rust/src/base_testnet_addresses.rs` (USDC, WETH9, Uniswap
  V3 SwapRouter02, Aave V3 Pool) + `Network::{chain_id,usdc,weth9,…}` accessors.
- [x] `BaseTestnetAccount::new()` + `assert_funded()` — real `eth_getBalance`
  and ERC-20 `balanceOf` validation in `testing/smoke-test/src/base_testnet.rs`.
- [x] Parameterized `parameterized_e2e!` macro (multi-network test template, no
  copy-paste) + `ForkFixture::for_network` / `ephemeral_testnet`.
- [x] Multi-network adapter e2e exercising live Uniswap/Aave (+ vault stack for
  Compound/Morpho/Curve) — `testing/fork-e2e-rust/tests/multi_network_adapters.rs`.
- [x] CI job `base-testnet-adapters` in `suite-05-fork-integration.yml`.

Prerequisites (out of scope for #839 — flip the suite from "skipped" to
"live-exercised" once provisioned):

- [ ] Deploy Robot Money contracts to Base Sepolia and set `RM_TESTNET_*`.
- [ ] Provision the `BASE_TESTNET_RPC_URL` / `BASE_TESTNET_FUNDER_KEY` CI secrets.

---

## Related docs

- [docs/prd.md §11](../../prd.md) — Vault types and adapter ecosystem
- [docs/development/smoke-test-design.md](../../development/smoke-test-design.md) — Devnet fixture design
- [docs/technical/fork-e2e-decisions.md](../../technical/fork-e2e-decisions.md) — Fork harness design decisions
- Issue #839 — Full Base testnet e2e implementation
