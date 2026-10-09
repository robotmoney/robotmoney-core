# Full-Stack Smoke Test Design

> Canonical: `Plan tracking issue #109` §10.5 (Phase 4.5 — Full-stack hosted devnet).
> Implementation: issue #146.

This document records the design decisions for the full-stack integration
test harness that validates the complete Robot Money service graph: the
Twin chain (a pinned lazy anvil fork of real Base), deployed contracts, explorer indexer and API, and dapp running
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
    // fixture drops here → the Twin fork it started is stopped
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
`docker compose down` on exit and stops a Twin fork it started.

### Stage stack in containers (core 1549)

The stage host does not run the harness as a long-lived parent. Every stage service is a container and
`scripts/stage/core-stack.ts` only calls `docker compose` (no host process, no Docker socket mount):

- **Chain**: `twin-chain` (`docker-compose.stage-chain.yaml`, image from `docker/stage-images.Dockerfile`) runs the
  pinned lazy Twin fork in the foreground (`twin-fork.ts serve`). The harness reuses it through `TWIN_RPC_URL`, the
  same mechanism the CI suites use for the fork their composite action starts.
- **Deploy job**: `smoke-test --deploy-only` is the harness cut down to its ceremony. It funds keys, runs the real
  publish contracts run (Safe handover included), writes the keystores and manifests to `SMOKE_TEST_WORK_DIR`, writes
  the dapp compose environment (`--dapp-env-out`, one function, `dapp_compose_env`, feeds both this file and host
  mode) and the endpoint summary (`--summary-out`), then exits. It starts no container.
- **Dapp stack**: `core-stack.ts` starts `docker-compose.dapp.yaml` plus the stage overlay from that environment.

Host mode (`cargo run -p smoke-test -- --full-stack`, `Fixture::new`) is unchanged: the test runner still owns the
stack for the CI suites. Images are reproducible: base images pinned by digest, `cargo build --locked`,
`bun install --frozen-lockfile` (`scripts/ci/check-stage-containers.ts` fails CI otherwise).

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

## Devnet: the Twin chain, a pinned lazy fork of real Base state

Owner decision 2026-10-05 (core 1498, 1496). The devnet is the **Twin chain** (chain id 918453),
made with anvil: `anvil --fork-url <upstream> --fork-block-number <pinned> --chain-id 918453`.
The Geth+Lighthouse compose stack, its genesis alloc and the committed snapshot genesis are gone.
The runbook is `docs/technical/full-stack-devnet.md`. The tool is `scripts/devnet/twin-fork.ts`.

The full-stack smoke tests still exercise the complete service graph. Anvil is a faithful EVM
for it because the chain is real Base state at a real block, and because the harness deploys
through the same publish contracts runbook, the same real Safe and the same timelock that
production uses. What the fork does not give (real consensus, real 12-second blocks) no test in
this stack depends on. The explorer-indexer needs a moving tip, so a fork the harness starts runs
`--block-time 1`.

### Pin and upstream

The upstream defaults to `https://mainnet.base.org` (no key, no archive node) and is overridden by
the env `BASE_UPSTREAM_RPC` (an optional secret, never printed). The pinned block is the upstream head at
the start of a run minus 2 (reorg safety). Every job of one CI run uses the same pin: one setup job
outputs it and the others take it as input. Anvil's RPC cache is persisted in CI keyed by the pin
block. There is no warm list, no `anvil_dumpState` snapshot and no patching of forked state.

### Clean room rule

The fork contains the real production v1 Robot Money contracts because it is real Base state.
Every test deploys its OWN vault through our deploy scripts and reads addresses from the
manifests. No test reads the live production v1 vault, its adapters, the old admin Safe or any
hard-coded Robot Money address.

### Environment steps that may differ from production

Fund gas (`anvil_setBalance`), fund USDC (the real FiatToken balance slot) and warp time
(`evm_increaseTime` then `evm_mine`; this is how the 48h governance waits run). Nothing else.

### USDC faucet: set the real balance slot

USDC is the real `FiatTokenV2` proxy at its canonical Base address, so there is no `MockUSDC.mint`
shortcut. The environment step "fund USDC" writes the real
`balanceAndBlacklistStates[holder]` storage slot (mapping at slot 9, balance in the low 255 bits)
with `anvil_setStorageAt`, then checks `balanceOf`. Total supply is not changed. The real token's
own code then reads and spends the balance, so `transfer`, `approve` and the deposit path run
exactly as in production. `Fixture::fund_usdc(recipient, amount)` is a grant: it reads the current
balance and sets balance + amount.

`HARNESS_USDC_HOLDER` is a test-only EOA derived from a private key checked into the smoke-test
crate (never used on a real chain). It has no prior history on Base. At boot the harness funds it
with ETH for gas and a large USDC reserve (the dapp e2e specs use it as the admin EOA and faucet).

A real Base whale is never impersonated: a whale carries a long allowance graph, possible
blacklist state and inbound history that would make test assertions non-hermetic. A clean,
funded harness EOA has none of those properties.

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
  4. fund fresh rehearsal keystores, then call publish contracts (devops, Bun
     TypeScript) with the Twin chain arguments  →  read the manifests
  5. docker compose up -d postgres explorer-indexer explorer-api dapp
     (addresses + ports injected as env vars)
  6. poll explorer-api /health on allocated port until 200
  7. return FullStackFixture { rpc_url, gateway_addr, explorer_api_url, dapp_url, ... }

Drop:
  docker compose down -v --remove-orphans
```

Contract deployment (step 4) is not done by this harness. The harness boots the
Twin chain, mints a fresh set of rehearsal keystores (encrypted, 0700 directory,
passphrase in a 0600 file, never an argument), funds them, and calls the one
runbook, "publish contracts", with `--chain 918453 --rpc <twin rpc> --sheet
<stage sheet> --signer keystore --environment stage --core-sha <sha>`. The
addresses come from the manifests the driver writes (`core.json`, `registry.json`,
`router.json`, `governance.json`, `ic-policy.json`, `timelock.json`, `safe.json`,
`libraries.json`, one `vault-<key>.json` per extra vault) and are passed to the
remaining services as environment variables. See
`docs/development/stage-deployment.md`.

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
| `deployer_addr` | rehearsal key helper | The fresh keystore deployer. It holds nothing after handover. |
| `safe_addr` | `Fixture.safe()` | The real 2-of-3 Safe |
| `timelock_addr` | `Fixture.timelock()` | The TimelockController that holds admin |
| `manifest_dir`, `sheet_path`, `core_sha` | publish contracts run | Where the manifests and the run sheet are |
| `key_dir`, `password_file` | rehearsal key helper | Paths only, never secrets |
| `pauser_addr` | `PAUSER_ADDRESS_HEX` | Pauser EOA address |
| `share_receiver_addr` | `SHARE_RECEIVER_ADDRESS_HEX` | Vault share receiver address |
| `pauser_private_key` | `PAUSER_PRIVATE_KEY_HEX` | Pauser signing key (test-only) |
| `agent_private_key` | `AGENT_PRIVATE_KEY` | Agent signing key (test-only) |
| `gateway_runtime_hash` | `Fixture.gateway_runtime_hash()` | keccak256(getBytecode(gateway)) |
| `harness_usdc_holder_addr` | `HARNESS_USDC_HOLDER_ADDRESS_HEX` | Harness USDC holder EOA |
| `harness_usdc_holder_private_key` | `HARNESS_USDC_HOLDER_PRIVATE_KEY_HEX` | Holder signing key (test-only) |
| `registry_addr` | `Fixture.registry()` | VaultRegistry contract address (issue #320) |
| `router_addr` | `Fixture.router()` | PortfolioRouter contract address (issue #320) |
| `governance_addr` | `Fixture.governance()` | RouterGovernance contract address (issue #477) |

**Adding new fields.** Emit the field in `testing/smoke-test/src/bin/smoke-test.rs`
inside the `--- endpoint summary ---` block, add it to `REQUIRED_KEYS` in
`devnet-global-setup.ts`, build it into the `endpoints` object, and declare it
in the `DevnetEndpoints` interface in `helpers/devnet.ts`.

---

## Coverage that must never stop running

A spec that degrades to "skipped" is indistinguishable from a spec that passed,
in the exit code and in a CI summary line. That is not hypothetical: `b3ed4dc1`
gated `tests/e2e/consensus-receipts.spec.ts` on `FUSION_RECEIPT_ID` /
`FUSION_RECEIPT_URL`, variables nothing in `.github/`, `playwright.config.ts` or
the smoke-test harness sets, and `AC-CORE-08`'s browser-coverage claim then went
on standing while the spec executed on zero runs (QA finding T14).

Two mechanisms keep that from recurring.

**A standing spec and an optional spec, with different subjects.**

| Spec | Subject | May skip? |
| --- | --- | --- |
| `consensus-receipts-seeded.spec.ts` | the two receipts the `--full-stack` harness seeds (`Fixture::seed_consensus_receipts`, run by `DappStack::boot` unless `--no-receipt-fixtures`); it is in `REQUIRED_SPECS` | No |
| `consensus-receipts.spec.ts` | the receipt a Fusion QA run really anchored, named by `FUSION_RECEIPT_ID` / `FUSION_RECEIPT_URL` | Yes |

The seeding uses the mainnet authorities, with no test-only admin grant and no
mock Safe. `committeeRegister(agent, "smoke-test-receipt-agent")` needs the
gateway's `ADMIN_ROLE`, held by the timelock after handover, so it is a Safe ->
Timelock call (`Fixture::timelock_call`). The harness agent key (`AGENT_ROLE`
plus the `COMMITTEE_AGENT_ROLE` that registration grants) records `receipt-a`
with the keccak256 of its served bytes and `receipt-b` with a deliberately
wrong digest. `receipt-a` is then released through the publish-contracts govern
row `release-receipt` (the real Safe -> Timelock round). `receipt-b` stays
recorded, not released. Each receipt id is derived from the payload's own
`session_id` and `subject_id`. Both payloads in
`testing/ethereum-testnet/config/consensus-receipt-fixtures/` validate against
`tests/fixtures/consensus-receipt.schema.json`. `receipt-a`'s weights equal the
live Twin router vector under the missing-vault = 0 bps rule (the stage sheet's
`ROUTER_WEIGHTS`, which the deployer leaves on the router before the handover:
rmUSDC 9500, rmPROTO 500, rmAGENT 0, rmRWA 0), so it renders Applied; `receipt-b`'s weights differ,
so it renders Not applied.

The seeded pair is core's own fixture bytes — enough to prove the four rendered
state dimensions and the required explanatory language are wired, never enough to
prove a `robotmoney-frontend` receipt survives the round trip. The env-named spec
proves the round trip and nothing else. Neither substitutes for the other, which
is why the `receipt-fixtures` compose service, its `depends_on` health gate, the
`--host-resolver-rules` mapping in `playwright.config.ts` and the `csp.ts`
`http://receipt-fixtures:8097` allowance are all deliberately KEPT rather than
retired: they are the standing gate's apparatus, not leftovers.

**A reporter that fails a run with zero executed required tests.**
`tests/e2e/reporters/required-coverage-reporter.ts` (decision logic in
`requiredCoverage.ts`, unit-tested in `tests/unit/requiredCoverage.test.ts`) fails
the run — with no test having failed — when a spec listed in `REQUIRED_SPECS`
contributed zero executed tests, whether it skipped or was never collected at all.
Add a spec to `REQUIRED_SPECS` when it is the standing proof of an acceptance
criterion; never add one that is legitimately environment-gated.

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
