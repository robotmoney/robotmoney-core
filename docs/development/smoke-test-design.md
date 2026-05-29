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

The crate also exposes a binary target. Running `cargo r -p smoke-test -- --full-stack`
from the workspace root starts the full stack and keeps it alive, printing the
allocated URLs and addresses to stdout. This lets a developer point other
tests or tools at the running network without waiting for the boot sequence
on every test run. Pass `--dapp-port <port>` when you want the webapp to stay
on a fixed host port for a reverse proxy; otherwise the harness randomizes it.

```
$ cargo r -p smoke-test -- --full-stack
rpc_url=http://127.0.0.1:54321
explorer_api_url=http://127.0.0.1:54322
dapp_url=http://localhost:54323
gateway_addr=0xabc...
^C  ← stack torn down on SIGINT
```

The binary blocks until interrupted; `Drop` (or a SIGINT handler) runs
`docker compose down` on exit.

---

## Guiding principle: no test-only code in production

Every dapp E2E spec runs against a build of `clients/dapp` that is
bit-identical to what would ship to operators. The `src/` tree contains
no `VITE_USE_MOCK_WALLET`, no `VITE_GATEWAY_VERIFY_BYPASS_FOR_TEST`,
no env-gated mock connectors, no test-only refusal bypasses, and no
"if testing" branches of any kind.

This is enforced structurally, not by convention:

- **Wallets.** The dapp ships with `connectors: [injected()]` only. To
  drive flows in Playwright, tests install a JS-level EIP-1193 provider
  on `window.ethereum` via `page.addInitScript` *before* the dapp
  bundle loads. The provider is backed by viem's `privateKeyToAccount`
  for signing and forwards reads to the real RPC URL. The dapp's prod
  `injected()` connector handles it like a real wallet extension; it
  cannot tell the difference. Helper: `tests/e2e/helpers/wallet.ts`.
- **Bytecode verification.** The dapp refuses admin writes unless
  `VITE_GATEWAY_EXPECTED_CODE_HASH` matches `keccak256(getBytecode(gateway))`
  on-chain. There is no bypass path. The smoke-test harness deploys
  the gateway, computes `fixture.gateway_runtime_hash()`, and pipes it
  into `docker compose up --build` as a build arg so the dapp container
  is built with the real hash pinned. Verification then passes
  end-to-end against a real chain, exactly as in prod.

The cost of this principle is that every dapp E2E spec must boot the
smoke-test full stack (no local `vite preview` shortcut). The reward
is that CI failures map to real product failures: there is no class of
"works in tests, breaks in prod because the test flag papered over it".

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

## Devnet: real Geth+Lighthouse, forked from Base mainnet

The full-stack fixture uses the existing Geth+Lighthouse compose stack
(`testing/ethereum-testnet/config/docker-compose.yaml`), not Anvil.

Anvil is a simulated EVM suitable for fast unit-level fixture work. The
full-stack smoke tests exercise the complete service graph — real mempool
behaviour, real consensus, real block production — so they require a real
execution client.

### Forked genesis

The devnet's genesis is constructed from a snapshot of Base mainnet at a
pinned block. The chain starts with real Base state — deployed contracts
(USDC, WETH, aggregators, etc.), account balances, and chain parameters
— at the fork point, giving tests realistic on-chain conditions.
The fork block number is pinned in the compose configuration so every
devnet instance is reproducible.

Concretely, `testing/ethereum-testnet/config/genesis/generate.sh` must
produce a `genesis.json` whose `alloc` is seeded from Base state at the
pinned block, not an empty allocation. The pinned block is recorded in
`testing/ethereum-testnet/config/fork-block.json` (versioned, schema-
validated by `smoke_test::fork_manifest`) and changing it is a
deliberate, reviewed action.

**Single fork point across harnesses.** The smoke-test devnet and the
Anvil fork-e2e fixture (`testing/fixtures/fork-state/CURRENT.json`)
MUST pin the same Base block. Both harnesses ingest the same captured
state file (`testing/fixtures/fork-state/CURRENT.anvil-state`), so a
scenario that reproduces on one harness reproduces on the other. The
manifest validator unit test
`smoke_test::fork_manifest::tests::fork_block_aligns_with_anvil_fixture_current`
enforces this alignment in CI; refreshing the pin is a single
`scripts/devnet/snapshot-fork.sh` invocation that updates both.

### USDC faucet via genesis-time balance grant

Fresh test EOAs need USDC. Because the chain forks Base, USDC is the
real `FiatTokenV2` proxy at its canonical Base address — there is no
`MockUSDC.mint` shortcut available, and there is no `anvil_*` cheat RPC
on geth.

**Mechanism.** When the forked genesis is built, USDC's own storage is
patched in the `alloc` entry for the canonical USDC proxy address:

- `balances[HARNESS_USDC_HOLDER]` is set to a large fixed amount.
- `totalSupply` is incremented by that amount.

`HARNESS_USDC_HOLDER` is an EOA derived from a private key checked into
the smoke-test crate (test-only, never used on a real chain). It has no
prior history on Base — its balance, nonce, and code are all zero in
the Base snapshot; the genesis builder simply allocates ETH for gas and
writes the USDC storage slots above.

`Fixture::fund_usdc(recipient, amount)` is then a plain `cast send`:
the harness key signs `usdc.transfer(recipient, amount)` against the
canonical USDC proxy. A real `Transfer(from=HARNESS_USDC_HOLDER, to=recipient, value=amount)`
event is emitted from the real USDC address. No mock, no cheat RPC, no
test-only branch in production code — only genesis state and ordinary
signed transactions.

The same shape can be added for other tokens by patching their balance
storage in their own genesis `alloc` entries (WETH, DAI, etc.) when
tests need them.

#### Why not impersonate a real Base whale

We considered two alternatives that would let the harness sign as an
existing high-balance USDC holder on Base:

1. **Balance reassignment from a real whale** — at genesis, move
   `balances[W]` from the whale `W` to the harness EOA. Same end state
   as the chosen mechanism, but harder to reason about: `W`'s prior
   USDC history (allowances, blacklist state, in-flight Circle minter
   relationships) bleeds into the devnet state.
2. **Code injection at the whale's address** — overwrite `W.code` at
   genesis with a tiny Executor contract gated to the harness key, so
   `cast send <W> "execute(usdc, transferCalldata)"` produces a real
   `Transfer(from=W, …)`. Closest thing to true impersonation on geth.

Both were discounted for the same root reason: **we want an account
with clean history.** A real Base whale carries:

- A long allowance graph (`approve(spender, …)`) we did not opt into.
- Potential `FiatToken.blacklisted[W] == true` state at or after the
  pinned block, which silently reverts every `transfer` from `W`.
- Inbound transfer history that pollutes our explorer's indexer view
  and makes test assertions about USDC flow non-hermetic.
- For the code-injection variant: `extcodesize(W) != 0`, which breaks
  any `require(isContract(addr) == false)` check downstream and forces
  us to audit the call path for EOA gates on every PR.

A test-only harness EOA has none of those properties. The minor cost is
that `Transfer.from` is an unfamiliar address (acceptable — no test or
indexer in our stack asserts on the from-side) and USDC's `totalSupply`
is inflated by the grant (acceptable and documented).

The code-injection mechanism remains a reasonable choice if and when
a test genuinely needs `msg.sender == <some specific Base address>`
(e.g., to exercise a flow gated to a known multisig). At that point it
can be added alongside the balance grant; it is deliberately not the
default.

---

## Port allocation

Every host port used by the stack is chosen by binding to `0`
(OS-assigned) at fixture construction time and recorded in the harness.
No port number is hardcoded anywhere in the runtime path unless the user
explicitly sets `--dapp-port` for the webapp.

```rust
pub struct Fixture {
    pub rpc_url: String,
    pub explorer_api_url: String,
    pub dapp_url: String,
    pub gateway_addr: Address,
    // internal compose child handle
}
```

`Fixture::new()` picks each port by opening a `TcpListener` on
`127.0.0.1:0`, reading the OS-assigned port, closing the listener, then
passing that port to the compose service via env vars. The compose file
exposes each service port via env var-backed `ports:` mappings (e.g.
`GETH_RPC_PORT`, `EXPLORER_API_PORT`, `DAPP_PORT`) rather than hardcoded
host ports.

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

## Playwright endpoint schema (`DevnetEndpoints`)

The smoke-test binary emits a structured `--- endpoint summary ---` block to
stdout once the full stack is healthy. `devnet-global-setup.ts` parses this
block and writes it as JSON to a temp file whose path is stored in
`DEVNET_ENDPOINTS_FILE`. Every Playwright spec loads the file via
`helpers/devnet.ts:loadEndpoints()`.

The `DevnetEndpoints` interface tracks the fields emitted by the binary:

| Field | Source | Description |
|---|---|---|
| `rpc_url` | `Fixture.rpc_url()` | Geth JSON-RPC endpoint (localhost) |
| `dapp_url` | `DappStack.endpoints.dapp_url` | Dapp frontend URL (localhost) |
| `explorer_api_url` | `DappStack.endpoints.explorer_api_url` | Explorer API base URL |
| `chain_id` | `Fixture.chain_id()` | EVM chain id (918453 for devnet) |
| `gateway_addr` | `Fixture.gateway()` | Gateway contract address |
| `vault_addr` | `Fixture.vault()` | Primary RobotMoneyVault address |
| `usdc_addr` | `Fixture.usdc()` | USDC ERC-20 address |
| `agent_addr` | `Fixture.agent()` | Test agent EOA address |
| `admin_addr` | `DEPLOYER_ADDRESS_HEX` | Deployer / admin EOA address |
| `pauser_addr` | `PAUSER_ADDRESS_HEX` | Pauser EOA address |
| `share_receiver_addr` | `SHARE_RECEIVER_ADDRESS_HEX` | Vault share receiver address |
| `admin_private_key` | `DEPLOYER_PRIVATE_KEY_HEX` | Admin signing key (test-only) |
| `pauser_private_key` | `PAUSER_PRIVATE_KEY_HEX` | Pauser signing key (test-only) |
| `agent_private_key` | `AGENT_PRIVATE_KEY` | Agent signing key (test-only) |
| `gateway_runtime_hash` | `Fixture.gateway_runtime_hash()` | keccak256(getBytecode(gateway)) |
| `harness_usdc_holder_addr` | `HARNESS_USDC_HOLDER_ADDRESS_HEX` | Harness USDC holder EOA |
| `harness_usdc_holder_private_key` | `HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX` | Holder signing key (test-only) |
| `registry_addr` | `Fixture.registry()` | VaultRegistry contract address (issue #320) |
| `router_addr` | `Fixture.router()` | PortfolioRouter contract address (issue #320) |
| `governance_addr` | `Fixture.governance()` | RouterGovernance contract address (issue #477) |
| `rm_token_addr` | `Fixture.rm_token()` | RmToken ERC-20 address (issue #477) |

**Adding new fields.** Emit the field in `testing/smoke-test/src/bin/smoke-test.rs`
inside the `--- endpoint summary ---` block, add it to `REQUIRED_KEYS` in
`devnet-global-setup.ts`, build it into the `endpoints` object, and declare it
in the `DevnetEndpoints` interface in `helpers/devnet.ts`.

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
