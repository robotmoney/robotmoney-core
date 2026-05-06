# rmpc-e2e

End-to-end harness for the Rust payment daemon (`rmpc`). Implements
the scaffold called for in issue #17 / `docs/implementation-plan.md`
§4 and the scenario coverage from #18 / #19, consolidated onto a
single Geth+Lighthouse backend per #37.

## Layout

- `src/lib.rs` — `Fixture` + helpers. Single backend: Docker
  Geth+Lighthouse devnet + host-side `forge script` deploy.
- `tests/smoke.rs` — proves the harness boots end-to-end and that
  `rmpc self-check` returns `ok: true`.
- `tests/scenarios.rs` — nine scenario tests sharing one fixture
  (default deploy caps).
- `tests/window_cap.rs` — one scenario in its own binary because it
  needs a deploy-time `AGENT_MAX_PER_WINDOW` override.

## Running

Requires Docker, Foundry (`forge`, `cast`) on PATH. Tests auto-skip
with a printed warning when prerequisites are missing — install Docker
and Foundry (`curl -L https://foundry.paradigm.xyz | bash; foundryup`)
to run them locally.

CI runs the three test binaries sequentially because each one boots
its own Geth devnet on port 8545; running them in parallel would race
on the port.

```bash
cd testing/ethereum-testnet/e2e-rust
cargo test --release --test smoke      -- --test-threads=1 --nocapture
cargo test --release --test scenarios  -- --test-threads=1 --nocapture
cargo test --release --test window_cap -- --test-threads=1 --nocapture
```

The full suite takes ~5-10 minutes wall-clock — the project trades
fast feedback for realism (#37). Each test binary pays one ~90s Geth
boot; within a binary the fixture is shared via `OnceLock<Mutex<…>>`
so the Docker stack lives only as long as the binary's process.

## Public harness API

```rust
let fx = Fixture::new()?;            // boot devnet + deploy

fx.gateway();        // Address of deployed RobotMoneyGateway
fx.usdc();           // Address of MockUSDC
fx.vault();          // Address of MockVault
fx.agent();          // Address of the agent EOA (matches keystore)
fx.share_receiver(); // Address registered as the share receiver
fx.rpc_url();        // RPC URL of the backend
fx.chain_id();       // EIP-155 chain id

fx.run_rmpc_self_check()?;
fx.run_rmpc_status("0x…")?;
fx.run_rmpc_deposit(["--amount", "1000000", "--order-id", "0x…"])?;

// On-chain pokes signed with real harness keys (no impersonation):
fx.pause_gateway()?;          // signs with PAUSER_PRIVATE_KEY_HEX
fx.unpause_gateway()?;        // signs with deployer (admin)
fx.revoke_agent()?;           // signs with deployer (admin)
fx.reauthorize_agent(p, w)?;  // restore deploy-time policy
fx.fund_usdc(fx.agent(), 1_000_000_000)?;
```

`rmpc` is built once per process via `cargo build --release`; the
binary path is cached in a static `Mutex`.

## Environment

- `docker`, `forge`, `cast` on PATH.
- The fixture sets `RMPC_KEYSTORE_PASSPHRASE` and `RMPC_STATE_DIR`
  for the spawned `rmpc` process automatically; tests should not
  unset them.

## Why no Anvil?

The crate originally shipped two backends: Anvil (sub-second blocks,
fast) and Geth+Lighthouse (12-second blocks, real). Issue #37 dropped
the Anvil flavor — the project is not optimizing for fast feedback,
and parallel coverage was net cost. The single backend lets the
harness drop `anvil_impersonateAccount`, `evm_snapshot`/`evm_revert`,
and `anvil_setNextBlockBaseFeePerGas`, replacing them with real-key
signing and unit-test coverage in `clients/rust-payment-client/src/fees`
for the fee-cap math.
