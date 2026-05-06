# rmpc-e2e

End-to-end harness for the Rust payment daemon (`rmpc`). Implements
the scaffold called for in issue #17 / `docs/implementation-plan-mvp.md`
§4. The actual scenario tests land in #18 (Anvil layer) and #19
(Geth+Lighthouse layer); this crate is the test runner they will use.

## Layout

- `src/lib.rs` — `Fixture` + helpers. Two backends:
  - `Fixture::anvil()` — fast (sub-second blocks), no consensus client.
  - `Fixture::geth()` — slow (12s blocks), real Docker stack.
- `tests/anvil_smoke.rs` — proves the Anvil path works end-to-end.
- `tests/geth_smoke.rs` — proves the Geth path works (gated behind
  `RMPC_E2E_GETH=1`).

## Running

### Anvil flavor (default)

Requires Foundry on PATH (`anvil`, `forge`, `cast`). The test
auto-skips with a printed warning when Foundry is missing — install via
<https://getfoundry.sh>:

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
cargo test -p rmpc-e2e --test anvil_smoke -- --nocapture
```

The Anvil smoke test boots a private `anvil` instance on a random
port, runs `forge script contracts/script/Deploy.s.sol:Deploy`
against it, decrypts a generated keystore, and invokes
`rmpc self-check`. It expects `ok: true` in the JSON output.

### Geth flavor (opt-in)

Requires Docker + Docker Compose. Enable explicitly:

```bash
RMPC_E2E_GETH=1 cargo test -p rmpc-e2e --test geth_smoke -- --nocapture
```

This brings up the `testing/ethereum-testnet/config/docker-compose.yaml`
stack (Geth + Lighthouse) plus the `docker-compose.deployer.yaml`
overlay that runs the gateway deploy script. The fixture tears the
stack down on drop.

## Public harness API

```rust
let fx = Fixture::anvil()?;          // or Fixture::geth()?

fx.gateway();        // Address of deployed RobotMoneyGateway
fx.usdc();           // Address of MockUSDC
fx.vault();          // Address of MockVault
fx.agent();          // Address of the agent EOA (matches keystore)
fx.share_receiver(); // Address registered as the share receiver
fx.rpc_url();        // RPC URL of the backend
fx.chain_id();       // EIP-155 chain id (31337 for Anvil)

fx.run_rmpc_self_check()?;
fx.run_rmpc_status("0x…")?;
fx.run_rmpc_deposit(["--amount", "1000000", "--order-id", "0x…"])?;

// Anvil-only:
let snap = fx.evm_snapshot()?;
fx.evm_revert(&snap)?;
fx.anvil_set_next_base_fee(150_000_000_000)?;

// Either backend:
fx.fund_usdc(fx.agent(), 1_000_000_000)?;
```

`rmpc` is built once per process via `cargo build --release` against
its sibling crate; the binary path is cached in a static `Mutex`.

## Environment

- `anvil` + `forge` + `cast` on PATH (Anvil flavor).
- `docker` on PATH and `RMPC_E2E_GETH=1` (Geth flavor).
- The fixture sets `RMPC_KEYSTORE_PASSPHRASE` and `RMPC_STATE_DIR`
  for the spawned `rmpc` process automatically; tests should not
  unset them.
