# Full-Stack Smoke Test Design

> Canonical: `docs/implementation-plan.md` §10.5 (Phase 4.5 — Full-stack hosted devnet).
> Implementation: issue #146.

This document records the design decisions for the full-stack integration
test harness that validates the complete Robot Money service graph: Geth
devnet, deployed contracts, explorer indexer and API, and dapp running
together as a single orchestrated stack.

---

## The `smoke-test` crate

The harness lives in a dedicated Rust library crate (`testing/smoke-test/`)
that any integration test can pull in as a dev-dependency:

```toml
[dev-dependencies]
smoke-test = { path = "../../testing/smoke-test" }
```

A test starts the full stack by constructing `FullStackFixture` and drops
it when done — `Drop` handles teardown unconditionally:

```rust
#[test]
fn gateway_accepts_deposit() {
    let fixture = FullStackFixture::new().expect("full-stack setup failed");
    // fixture.rpc_url, fixture.gateway_addr, fixture.explorer_api_url, ...
    // ... test body ...
    // fixture drops here → docker compose down
}
```

This is the same pattern used by `rmpc-fork-e2e` (`ForkFixture::new` +
`Drop`). Each test owns its entire stack; there is no global state.

The crate also exposes a binary target. Running `cargo r smoke-test` from
the workspace root starts the full stack and keeps it alive, printing the
allocated URLs and addresses to stdout. This lets a developer point other
tests or tools at the running network without waiting for the boot sequence
on every test run.

```
$ cargo r smoke-test
rpc_url=http://127.0.0.1:54321
explorer_api_url=http://127.0.0.1:54322
dapp_url=http://127.0.0.1:54323
gateway_addr=0xabc...
^C  ← stack torn down on SIGINT
```

The binary blocks until interrupted; `Drop` (or a SIGINT handler) runs
`docker compose down` on exit.

---

## Guiding principle: the test runner owns the stack

The devnet lifecycle — boot, contract deployment, health-wait, teardown —
is controlled entirely by Rust test code. The CI workflow calls `cargo test`;
it has no knowledge of Docker or service orchestration.

**Why this matters.** If the workflow controls the devnet, ordering is
enforced by YAML job/step sequencing, which is fragile and opaque. When
the test code controls the devnet, ordering is enforced by ordinary Rust
logic — explicit, reviewable, and testable in isolation. Failures surface
as test failures with stack traces, not as mysterious CI timing problems.

---

## Devnet: real Geth+Lighthouse, forked from mainnet

The full-stack fixture uses the existing Geth+Lighthouse compose stack
(`testing/ethereum-testnet/config/docker-compose.yaml`), not Anvil.

Anvil is a simulated EVM suitable for fast unit-level fixture work. The
full-stack smoke tests exercise the complete service graph — real mempool
behaviour, real consensus, real block production — so they require a real
execution client.

The devnet forks from a pinned mainnet block. This means the chain starts
with real mainnet state (deployed contracts, account balances, chain
parameters) at the fork point, giving tests realistic on-chain conditions.
The fork block number is pinned in the compose configuration so every
devnet instance is reproducible.

---

## Port allocation

Every port used by the stack is chosen by binding to `0` (OS-assigned)
at fixture construction time and recorded in `FullStackFixture`. No port
number is hardcoded anywhere in the harness — not in the compose file, not
in the test code, not in the CI workflow.

```rust
pub struct FullStackFixture {
    pub rpc_url: String,
    pub explorer_api_url: String,
    pub dapp_url: String,
    pub gateway_addr: Address,
    // internal compose child handle
}
```

`FullStackFixture::new()` picks each port by opening a `TcpListener` on
`127.0.0.1:0`, reading the OS-assigned port, closing the listener, then
passing that port to the compose service via env vars. The compose file
exposes each service port via the env var (e.g. `GETH_RPC_PORT`,
`EXPLORER_API_PORT`) rather than a fixed `ports:` mapping.

This makes parallel runs safe by construction: two fixture instances
running simultaneously will never collide on a port.

---

## Fixture lifecycle

`FullStackFixture::new()` runs the full boot sequence synchronously and
returns only when the stack is healthy. `Drop` tears it down.

```
new():
  1. allocate randomized ports for all services
  2. docker compose up -d geth beacon validator-{1..4}
     (ports injected via env vars, fork block injected via FORK_BLOCK env var)
  3. poll geth RPC on allocated port until healthy (eth_blockNumber succeeds)
  4. forge script Deploy.s.sol  →  parse addresses from output
  5. docker compose up -d postgres explorer-indexer explorer-api dapp
     (addresses + ports injected as env vars)
  6. poll explorer-api /health on allocated port until 200
  7. return FullStackFixture { rpc_url, gateway_addr, explorer_api_url, dapp_url, ... }

Drop:
  docker compose down -v --remove-orphans
```

Contract deployment (step 4) is a `std::process::Command` call to
`forge script`. The addresses are parsed from the JSON deployment output
and passed to the remaining services as environment variables — no
deployer container, no chicken-and-egg problem in the compose file.

---

## CI entrypoint

```yaml
- name: Full-stack smoke tests
  working-directory: testing/ethereum-testnet/e2e-rust
  run: cargo test --release --test full_stack -- --test-threads=1 --nocapture

- name: Tear down (always)
  if: always()
  working-directory: testing/ethereum-testnet/config
  run: docker compose down -v --remove-orphans || true
```

The workflow step is thin by design. All meaningful logic lives in the
Rust fixture. The explicit teardown step at the workflow level is a safety
net for the case where the Rust process exits uncleanly and `Drop` does
not run.

---

## Relationship to existing harnesses

| Harness | Devnet | Lifecycle owner | Scope |
|---|---|---|---|
| `smoke.rs`, `scenarios.rs`, `window_cap.rs` | Geth+Lighthouse | Rust `Fixture` | rmpc client behaviour |
| `full_stack.rs` (issue #146) | Geth+Lighthouse + full service graph | Rust `FullStackFixture` | end-to-end service integration |
| `opencode-headless-deposit.yml` | Anvil fork | CI workflow steps | OpenCode agent behaviour |
| `dapp.yml` e2e | Anvil (local, no fork) | CI workflow steps | dapp UI |

The full-stack harness sits between the rmpc unit harnesses and the
OpenCode headless tests in the integration pyramid. It validates that
services connect to each other correctly; it does not re-test rmpc
command behaviour or OpenCode agent reasoning.
