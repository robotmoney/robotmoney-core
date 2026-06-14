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
| `BASE_TESTNET_RPC_URL` | Base Sepolia RPC endpoint (required for live tests) | `https://base-sepolia.g.alchemy.com/v2/...` |
| `RMPC_FORK_RPC_URL` | Base mainnet archive RPC for local fork (optional) | `https://base.g.alchemy.com/v2/...` |

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

**Suite 19 (Issue #843):** E2E tests with Base testnet support.

```yaml
# .github/workflows/suite-19-erc4626-demo-tvl.yml (example structure)
env:
  BASE_TESTNET_RPC_URL: ${{ secrets.BASE_TESTNET_RPC_URL }}
jobs:
  base-testnet-e2e:
    runs-on: ubuntu-latest
    steps:
      - run: cargo test --test base_testnet_fixture
      - run: cargo test --release --test e2e -- --network base --nocapture
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

## Future work (issue #839)

- [ ] Deploy Robot Money contracts to Base Sepolia
- [ ] Implement `BaseTestnetAccount::new()` with faucet integration
- [ ] Wire parameterized `@network.each` test macro
- [ ] Add CI job for Base testnet e2e suite
- [ ] Document deployed contract addresses
- [ ] Add tvl snapshot tests for multi-network adapter interaction

---

## Related docs

- [docs/prd.md §11](../../prd.md) — Vault types and adapter ecosystem
- [docs/development/smoke-test-design.md](../../development/smoke-test-design.md) — Devnet fixture design
- [docs/technical/fork-e2e-decisions.md](../../technical/fork-e2e-decisions.md) — Fork harness design decisions
- Issue #839 — Full Base testnet e2e implementation
