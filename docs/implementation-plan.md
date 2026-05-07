# MVP Implementation Plan — Rust Client, Gateway, Testing, Agent Surfaces

> **Status (2026-05-06).** Phase 1 (secure agent deposit
> infrastructure) is complete: contracts, deploy script, Rust client,
> preflight, fee policy, nonce lock, all 11 e2e scenarios across the
> Anvil and Geth+Lighthouse layers, and the `rmpd` → `rmpc` rename
> have all merged. Phases 2–7 are not yet started; their sections
> below describe the target shape and acceptance criteria.

> Companion to `docs/architecture.md`. This plan covers the
> full MVP sequence. Phase 1 was the buildable slice of v0: one
> chain, one token, one gateway, one Rust client. Later phases add
> fork-based smart-contract testing, direct chain-read tooling,
> agent-harness installation, a simple explorer API/database,
> human-facing controls, and a final OpenClaw demo.
>
> **Relationship to the product.** Robot Money is the ERC-4626 yield
> vault in `contracts/RobotMoneyVault.sol` plus its
> Aave/Compound/Morpho adapters; see `docs/prd.md`. This plan builds
> the security architecture for autonomous-agent access to that
> vault — a Rust signing daemon plus an on-chain policy gateway that
> wraps `vault.deposit()`. The gateway is the only contract an
> agent's key may call; it pulls USDC from the agent, enforces
> per-agent caps, and forwards into the vault.
>
> The Rust client is the replacement direction for the TypeScript CLI's
> relevant supported features, but this MVP is not full CLI parity. It
> does not implement adapter strategy, Morpho/Aave/Compound allocation,
> OWS wallet UX, Permit2, withdraw/redeem flows, or the UniversalRouter
> basket sidecar. Those require additional architecture work before
> they move into `rmpc`.

## 0. Scope

**Phase 1 in scope.** A single-chain (local Geth devnet),
single-token (mock USDC), single-gateway system where a Rust daemon
authenticates as an `AGENT_ROLE` key and calls one function —
`deposit` — on a gateway that enforces per-agent allowlist,
per-deposit cap, per-window cap, pause, and **forwards the deposit into
a `RobotMoneyVault`**. Vault shares (`rmUSDC`) route to a configurable
receiver registered with the gateway. Admin role is real (separate
key, on-chain checks).

**Full MVP in scope.** The full MVP is broader than phase 1. It also
includes fork-based Robot Money contract tests, direct chain-read query
commands in `rmpc`, agent-harness packaging for OpenCode and OpenClaw,
a small explorer API/database for transaction and vault history, a
human dapp for sensitive credential/policy actions, and a final
OpenClaw-driven demo on a recent public-chain fork.

**Mock USDC + mock vault are the phase 1 test target.** The phase 1 test suite
runs against a 6-decimal `MockUSDC.sol` and a minimal `MockVault.sol`
(or the real `RobotMoneyVault.sol` deployed in a single-adapter
configuration) on Anvil and on the Docker devnet.

**Out of scope (deferred).** Implementing or changing the ERC-4626
vault/share token, adapters/yield, master-batch Merkle confirmation
(v0 §22), `MASTER_ROLE` in any form, reversal/expiry, Permit2
/ UniversalRouter, withdraw/redeem flows, multi-RPC consensus,
multi-backend signers (only software-encrypted for MVP), proxy
upgradeability, governance.

**Future replacement scope (TBD).** `rmpc` should replace the
TypeScript CLI for the supported command surface that still matters.
The design for full replacement is intentionally not specified in this
MVP. Before those features are ported, separate architecture decisions
are needed for read-command parity, withdraw/redeem safety, basket
routing, simulation/state overrides, OWS or wallet-adapter UX, and
mainnet configuration management.

## 1. Phase map

| Phase | Theme | Primary outcome | Status |
|---|---|---|---|
| 1 | Secure agent deposit infrastructure | Agents can safely call a policy gateway that deposits USDC into the vault. | **DONE** (PRs #22–#36, #40, #43) |
| 2 | Forked smart-contract e2e | Robot Money contracts are tested against a recent public-chain fork with real DEX/router interactions. | Not started |
| 3 | Rust query tooling | `rmpc` exposes direct on-chain reads for vault status and related state without explorer APIs. | Not started |
| 4 | Agent-harness installation | `rmpc` and the Robot Money skill install into OpenCode and OpenClaw; MCP is evaluated and scoped. | Not started |
| 5 | Explorer API + database | A small service indexes relevant on-chain and `rmpc` activity for web/API consumers. | Not started |
| 6 | Human dapp controls | Humans can execute sensitive commands such as granting permissions or creating credentials. | Not started |
| 7 | E2E agent demo | OpenClaw completes a long-running Robot Money task on a recent public-chain fork. | Not started |

Phase 1 is specified in detail below because it was the implementation
branch through 2026-05; the spec is preserved as a record of what
shipped. Phases 2–7 define the target shape and acceptance criteria;
they are intentionally less prescriptive where the architecture is
still open.

These are internal MVP delivery phases for the Rust/agent-access work.
They are not the same numbering scheme as the public Robot Money
product roadmap (`docs/project-roadmap.md` is deprecated; the public
roadmap lives at robotmoney.net/changelog).

**Intentional tradeoffs.**

- **Wrapper deposit UX.** USDC is a plain ERC-20; it cannot tell the
  vault who an agent intended to credit just from a token transfer.
  The gateway therefore exposes an explicit `deposit(...)` entrypoint
  and pulls USDC with `transferFrom`. This is less natural than
  "send USDC to this address", but it gives deterministic
  attribution, policy checks, and event emission.
- **Software signer in MVP.** The production architecture prefers HSM,
  Secure Enclave, TPM, or KMS-backed non-exportable keys. The MVP ships
  only the encrypted software signer so the contract and client path
  can be tested end-to-end. Operators must set
  `[signer].allow_software_fallback = true` explicitly.
- **No master review in MVP.** Human/master confirmation is useful for
  high-value flows, but it adds latency and operational review. This
  MVP uses per-agent and per-window caps only; master-batch approval is
  deferred.
- **Fixed window accounting.** The contract uses epoch-aligned
  24-hour windows for the first implementation. A request timed around
  the boundary can consume cap from two adjacent windows in a short
  interval, so caps should be configured conservatively.

## 2. Phase 1 — Secure Agent Deposit Infrastructure

Goal: establish the minimum secure path for autonomous agents to
deposit USDC into Robot Money through a constrained Rust client and a
policy gateway. This phase proves the key security boundary: an agent
key can deposit only through audited calldata, under on-chain caps, and
with structured refusal/audit behavior.

### 2.1 Components

```
contracts/gateway/
  MockUSDC.sol                  # 6-decimal ERC20 for tests
  RobotMoneyGateway.sol         # the deposit gateway (this MVP)
  AccessRoles.sol               # role constants + AccessControl wiring
  interfaces/IGateway.sol

clients/rust-payment-client/         # crate name; binary is `rmpc`
  Cargo.toml
  src/
    main.rs                     # binary entry; defers to lib::run
    lib.rs                      # public surface for integration tests
    cli.rs                      # clap parser
    commands/                   # deposit / status / self-check
    config.rs                   # toml loader, address pinning, chain_id
    signer/                     # AgentSigner trait + encrypted-keystore impl
    gateway/                    # alloy-sol-types bindings + event decode
    rpc/                        # minimal JSON-RPC over reqwest
    policy/                     # preflight checks mirrored from contract
    tx/                         # build/sign/broadcast EIP-1559 tx
    fees/                       # gas pricing + fee-cap policy
    nonce/                      # per-agent file lock + nonce read
    replay_cache.rs             # local idempotency cache
    logging.rs
    errors.rs

testing/ethereum-testnet/
  contracts/                    # forge project (existing)
  e2e-rust/                     # NEW: Rust integration tests, driven
                                # against the Docker stack
```

Note: the e2e tests live under the existing `testing/ethereum-testnet/`
tree (not a separate `testing/e2e/`) to keep the harness, contracts,
and driver co-located.

## 3. Phase 1 Contracts (smallest viable surface)

### 3.1 `AccessRoles.sol`

OpenZeppelin `AccessControl` with three roles, all distinct keys:

- `ADMIN_ROLE` — grants/revokes other roles, sets policy, unpauses.
- `PAUSER_ROLE` — `pause()` only. Asymmetric with unpause by design:
  pausing is a "stop the world" tool that must be fast and unilateral
  (one compromised PAUSER can only DoS, not steal); unpause should be
  deliberate and is restricted to ADMIN.
- `AGENT_ROLE` — only role allowed to call `deposit()`.

**Invariant.** An `AGENT_ROLE` holder must not also hold `ADMIN_ROLE`
or `PAUSER_ROLE`. Enforced in deploy script and asserted in a
post-grant check.

### 3.2 `RobotMoneyGateway.sol`

The gateway is a thin policy-gated wrapper around `vault.deposit()`.
It pulls USDC from the agent, enforces per-agent caps, calls the
vault, and routes the resulting `rmUSDC` shares to a per-agent
configured receiver (typically an operator-controlled address, never
the agent's signing key).

Storage:

```solidity
IERC20    public immutable usdcToken;                  // pinned at construction
IERC4626  public immutable vaultContract;              // RobotMoneyVault, pinned
                                                       // (exposed via usdc()/vault() views)

struct AgentPolicy {
    bool    active;
    uint64  validUntil;
    uint256 maxPerPayment;
    uint256 maxPerWindow;
    address shareReceiver;     // who gets rmUSDC; set by ADMIN, not the agent
}
mapping(address => AgentPolicy) public agents;

mapping(address => mapping(uint64 => uint256))         // per-agent windowed gross —
        public agentWindowGross;                       // NOT shared across agents
mapping(bytes32 => bool) public usedPaymentIds;
bool private _paused;                                  // exposed via paused()
uint64  public constant WINDOW_SECONDS    = 86400;     // Unix-epoch-aligned;
                                                       // see v0 §23.3
uint256 public constant MAX_DEADLINE_SKEW = 600;       // seconds
```

Functions (refuse anything else):

```solidity
function deposit(
    bytes32 orderId,
    uint256 amount,
    uint64  deadline,
    bytes32 idempotencyKey
) external onlyRole(AGENT_ROLE)
    returns (bytes32 paymentId, uint256 sharesMinted);
// Pause is enforced by an explicit `if (_paused) revert PausedError()`
// at function head; the gateway uses custom errors throughout instead
// of OZ's `whenNotPaused` modifier.

function authorizeAgent(address agent, AgentPolicy calldata p) external onlyRole(ADMIN_ROLE);
function revokeAgent(address agent) external onlyRole(ADMIN_ROLE);
function pause()    external onlyRole(PAUSER_ROLE);
function unpause()  external onlyRole(ADMIN_ROLE);
```

Events:

```solidity
event AgentAuthorized(address indexed agent, uint64 validUntil,
                      uint256 maxPerPayment, uint256 maxPerWindow,
                      address shareReceiver);
event AgentRevoked(address indexed agent);
event Paused(address indexed by);
event Unpaused(address indexed by);
event AgentDeposit(
    bytes32 indexed paymentId,
    bytes32 indexed orderId,
    address indexed agent,
    address shareReceiver,
    uint256 amount,
    uint256 sharesMinted,
    uint64  windowId
);
```

Behavior of `deposit` (subset of v0 §20.1, retargeted to the vault):

1. `amount > 0 && amount <= agents[msg.sender].maxPerPayment`
2. `block.timestamp <= deadline && deadline <= block.timestamp + MAX_DEADLINE_SKEW`
3. `agents[msg.sender].active && validUntil >= block.timestamp`
4. `windowId = uint64(block.timestamp / WINDOW_SECONDS)`
5. `agentWindowGross[msg.sender][windowId] + amount <= agents[msg.sender].maxPerWindow`
6. `paymentId = keccak256(abi.encode(block.chainid, address(this),
   msg.sender, orderId, amount, idempotencyKey))`; revert if already
   used.
   - **`deadline` is intentionally excluded from the hash.**
     Idempotency is keyed on (caller, order, amount, idempotency
     key). Two requests with the same `(orderId, idempotencyKey)`
     collapse to the same paymentId regardless of deadline; the
     second is rejected by `usedPaymentIds`. This makes deadline a
     *liveness* parameter, not an *identity* parameter.
7. `usdcToken.safeTransferFrom(msg.sender, address(this), amount)` with
   **balance-delta verification** (fee-on-transfer defense, v0 §25).
8. `usdcToken.forceApprove(address(vaultContract), amount)` (one-shot
   allowance, reset to zero post-call).
9. `sharesMinted = vaultContract.deposit(amount, agents[msg.sender].shareReceiver)`
   — the gateway is the ERC-4626 caller; the receiver is the agent's
   pre-registered share-receiver address. Vault-side reverts (TVL
   cap, paused, shutdown) propagate; the gateway never holds shares.
10. `usdcToken.forceApprove(address(vaultContract), 0)` to clear residual.
11. Update `agentWindowGross[msg.sender][windowId] += amount` and
    mark `usedPaymentIds[paymentId] = true`.
12. emit `AgentDeposit(paymentId, orderId, agent, shareReceiver,
    amount, sharesMinted, windowId)`.

The gateway must never custody `rmUSDC`; the vault deposit and the
share routing happen in the same call frame and the gateway's
`rmUSDC` balance is asserted to be zero before and after.

## 4. Phase 1 Rust client

### 4.1 Crate layout

Matches v0 §6 but trimmed: only `signer/software.rs` is implemented.
`signer/mod.rs` defines the trait so HSM/KMS land later without API
churn.

### 4.2 `AgentSigner` trait (matches v0 §8.1)

```rust
use alloy_primitives::Address;
use alloy_signer::Signature;

pub trait AgentSigner: Send + Sync {
    fn backend_kind(&self) -> SignerBackendKind;
    fn public_address(&self) -> Address;
    fn sign_eip1559_hash(&self, hash: &[u8; 32])
        -> Result<Signature, SignerError>;
}
```

The trait does **not** expose `sign_hash` / `sign_message` /
`sign_typed_data`. The only hash a caller can produce is the EIP-1559
envelope hash for a known gateway-deposit transaction, which is
constructed by the `tx` module from a typed `GatewayTxRequest` —
keeping the trust boundary at the call site rather than inside the
signer. Future backends cannot widen this.

### 4.3 Software signer

- secp256k1 via `k256` crate (or alloy's signer abstraction; see §4.5).
- Key encrypted-at-rest with `aes-gcm` + Argon2 KDF; passphrase from
  env or stdin.
- Plaintext key zeroized after each sign via `zeroize`.
- Refuses to start unless `[signer].allow_software_fallback = true`.
  Emits a high-severity log line on startup (v0 §10.5).

### 4.4 Preflight (mirrors contract, v0 §11)

Before signing the client RPC-reads:

- `gateway.paused()`, `gateway.agents(self_addr)`
- `usdc.allowance(self, gateway)`, `usdc.balanceOf(self)`
- `eth_chainId` matches config
- `keccak256(eth_getCode(gateway))` matches pinned `gateway_runtime_hash`

Any failure → **hard refusal** with non-zero exit and a high-severity
log line. The check is *not* advisory; the contract being
authoritative does not justify shipping a tx the client cannot prove
is going to the audited bytecode.

The MVP gateway is non-upgradeable, so the legitimate path for
`gateway_runtime_hash` to change is a v1 redeployment + operator
config bump. The full proxy-aware rotation flow (re-pinning across a
timelock window) is specified in v0 §26.1.

### 4.5 ABI encoding and Ethereum primitives

Use `alloy-primitives` + `alloy-sol-types` for typed ABI
encoding/decoding and `alloy-consensus` (or equivalent) for EIP-1559
transaction construction. Earlier drafts of this plan called for
hand-rolling the ABI for four selectors and the 1559 envelope; that
choice has been withdrawn — security-critical signing code is the
wrong place to reimplement audited primitives, and the alleged
dep-tree win was illusory once you account for `k256`, `sha3`,
`aes-gcm`, `argon2`, and `reqwest`.

Dependency list:

```toml
alloy-primitives    = "*"   # Address, U256, B256, keccak
alloy-sol-types     = "*"   # sol! macro, typed encode/decode
alloy-consensus     = "*"   # EIP-1559 tx envelope, signing
alloy-rpc-types     = "*"   # JSON-RPC types (or hand-roll if minimal)
k256                = "*"   # only if not using alloy's signer
aes-gcm             = "*"
argon2              = "*"
reqwest             = "*"   # JSON-RPC transport
serde / serde_json  = "*"
zeroize             = "*"
thiserror           = "*"
clap                = "*"
```

The Rust binary must remain the only path to a signed deposit tx; no
alloy provider is exposed externally.

### 4.6 Nonce management

The MVP CLI is **single-flight**: each `rmpc deposit` invocation
acquires an exclusive file lock on
`$RMPC_STATE_DIR/agent-<address>.lock` for the duration of
`(eth_getTransactionCount → sign → broadcast → receipt)`. Concurrent
invocations against the same agent address fail fast with
`ErrConcurrentInvocation`. A full nonce manager (with pending-tx
queue, replacement, gap recovery) is v1 work.

### 4.7 Fee policy

EIP-1559 transactions only. Per-invocation behavior:

- Read `eth_feeHistory` for the last 5 blocks; compute
  `baseFee` from the latest block and `priorityFee = max(p50, 1 gwei)`.
- Set `maxPriorityFeePerGas = priorityFee`.
- Set `maxFeePerGas = min(2 * baseFee + priorityFee,
  config.max_fee_per_gas_cap)`.
- If the computed `maxFeePerGas` would exceed
  `config.max_fee_per_gas_cap`, refuse with `ErrFeeCapExceeded` (no
  broadcast). The cap is operator policy, not best-effort.

Defaults (issue #93 — per-chain, resolved at config load):

| Chain                | id     | default `max_fee_per_gas_cap` |
|----------------------|--------|-------------------------------|
| Ethereum mainnet     | 1      | 100 gwei                      |
| Base mainnet         | 8453   | 1 gwei                        |
| Base Sepolia         | 84532  | 1 gwei                        |
| Anvil / local devnet | 31337  | 1000 gwei (effectively unlimited) |
| Other (unknown id)   | —      | 100 gwei + `log::warn!`       |

Resolution order, highest priority first:

1. `--fee-cap <wei>` on the rmpc subcommand (issue #93).
2. `max_fee_per_gas_cap = <wei>` in the operator TOML.
3. The per-chain default from the table above.
4. Otherwise the unknown-chain fallback (100 gwei) plus a warn log.

The TOML field is now optional; omitting it lets the per-chain table
drive the cap, which keeps L2 deployments quiet without per-operator
TOML edits.

### 4.8 CLI surface

```
rmpc deposit --amount 100.00 --order-id 0x…
rmpc status  --deposit-id 0x…
rmpc self-check                # backend report (v0 §9.2 JSON)
```

JSON on stdout, exit 0 on success, named errors on failure.

## 5. Phase 1 End-to-end test plan

**Harness split.** Two layers, deliberately:

- **Anvil layer (fast).** Forge + Anvil for logic-only scenarios.
  No consensus client. Sub-second per test. Used for tests 2, 3, 4,
  6, 7, 8, 10, 11 below — the ones that exercise contract reverts and
  client preflight, not real-chain semantics.
- **Geth+Lighthouse layer (slow, real).** Existing
  `testing/ethereum-testnet` Docker stack (12-second blocks). Used for
  tests 1, 5, 9 — happy path, multi-block window accounting, and the
  role-separation deploy invariant. One-off `forge script` deploy
  per Docker-layer test would push CI past 10 minutes; instead, a
  single shared deployment per suite is reused with state isolation
  via per-test `evm_snapshot` / `evm_revert`.

**Driver — Rust-native.** The e2e suite is a `cargo test` integration
target in `testing/ethereum-testnet/e2e-rust/`. No TypeScript, no
Hardhat. The harness exercises the Rust binary boundary directly:
subprocess `rmpc` invocations, JSON-on-stdout assertions, real signing.

Anvil/Geth interaction from Rust uses `alloy-provider` for read calls
and JSON-RPC pokes (`anvil_setNextBlockBaseFeePerGas`,
`evm_snapshot`, `evm_revert`); deployments use `forge script` invoked
as a subprocess from the Rust harness's `setup()` fixture.

**Scenarios** (each = one `#[test]`):

1. `deposit_happy_path` *(Geth)* — admin authorizes agent, agent runs
   `rmpc deposit`, assert `AgentDeposit` event + USDC balance delta
   on gateway.
2. `unauthorized_agent_rejected` *(Anvil)* — agent without
   `AGENT_ROLE` → contract reverts; client surfaces
   `ErrAgentNotAuthorized`.
3. `paused_blocks_deposit` *(Anvil)* — `PAUSER_ROLE` calls `pause()`;
   client preflight refuses to sign (no broadcast).
4. `over_per_payment_cap_rejected` *(Anvil)* — preflight rejects;
   contract would also revert (asserted via debug-only bypass).
5. `over_window_cap_rejected` *(Geth)* — two deposits whose sum
   exceeds `maxPerWindow` → second reverts on-chain. Geth-layer
   because window math is timestamp-driven and benefits from real
   block cadence.
6. `idempotent_replay_rejected` *(Anvil)* — same `(orderId,
   idempotencyKey)` twice → second reverts with
   `DepositIdAlreadyUsed`.
7. `code_hash_mismatch_aborts` *(Anvil)* — flip pinned hash in config
   → client refuses to sign (hard refusal, not advisory).
8. `software_fallback_disabled_aborts_startup` *(Anvil)* —
   `allow_software_fallback = false` with software backend selected →
   exits non-zero before any RPC.
9. `role_separation_invariant` *(Geth)* — deploy script tries to grant
   `AGENT_ROLE` to admin → assertion reverts.
10. `fee_cap_exceeded_aborts` *(Anvil)* — set Anvil base fee above
    `max_fee_per_gas_cap` → client refuses with `ErrFeeCapExceeded`.
11. `concurrent_invocation_locked` *(Anvil)* — two `rmpc deposit`
    processes against the same agent address; one wins, the other
    fails fast with `ErrConcurrentInvocation`.

Per-test: pre-fund agent EOA with mock USDC and approve the gateway;
run `rmpc` as subprocess and assert on JSON stdout + on-chain event
log.

**Coverage targets.** Every `revert` in the gateway has a corresponding
negative test; every preflight rule has a corresponding client-side
test; every refusal in §4.4/§4.6/§4.7 has a corresponding client-side
test.

## 6. Phase 1 build order

All six chunks shipped 2026-04 → 2026-05; recorded here for posterity.

1. ✅ Contracts + role-separation deploy script + Foundry tests on
   Anvil. (PRs #23–#26, #29, #30)
2. ✅ Mock USDC + deploy harness wired into the Docker testnet, plus a
   bare `cast send` smoke (one tx) to confirm the stack — no TS SDK
   detour. (PRs #23, #29)
3. ✅ Rust crate skeleton + config loader + RPC + alloy bindings.
   `rmpc self-check` can read state. (PRs #22, #25, #27, #32)
4. ✅ Software signer + nonce lock + fee-cap policy + `deposit` happy
   path. Tests 1–2, 10–11. (PRs #25, #28, #33)
5. ✅ Preflight + policy refusal + code-hash pinning. Tests 3–4, 7–8.
   (PR #31)
6. ✅ Negative on-chain paths. Tests 5–6, 9. (PRs #34–#36)

Final cleanups: audit findings, logging, `rmpd` → `rmpc` rename
(PR #40); deprecated TypeScript CLI removed (PR #43).

## 7. Phase 1 open questions

1. **Fee-cap default.** `100 gwei` is generous for an L1 devnet but
   intentionally loud if it ever fires on a real chain. Operators on
   L2s should lower this an order of magnitude.

## 8. Phase 2 — Forked Smart-Contract E2E

Goal: test the actual Robot Money smart-contract stack against a
recent fork of a public Ethereum-compatible chain, with real router,
vault, token, and DEX interactions. This phase is separate from phase
1's mock gateway/devnet suite: it answers "does the deployed-style
Robot Money flow still work against current on-chain reality?"

**Fork target.**

- Default target is a recent Base mainnet fork, because Robot Money's
  deployed contracts and USDC flow are Base-oriented.
- The fork block must be pinned in CI for reproducibility, while local
  runs may opt into "latest recent fork" mode for smoke testing.
- The test harness must record chain id, fork block, RPC endpoint
  label, deployed contract addresses, and tx hashes in test output.

**Required scenarios.**

1. `vault_deposit_redeem_smoke` — fund an ephemeral wallet with forked
   USDC, approve the vault/gateway path, deposit, then redeem/withdraw
   enough to prove share accounting and exit behavior.
2. `dex_route_smoke` — execute the smallest meaningful basket or DEX
   interaction still relevant to the replacement CLI scope, using real
   router contracts and real pool state.
3. `gas_estimate_reality_check` — estimate and execute the deposit
   path, then assert actual gas used is within documented budgets.
4. `abi_address_sanity` — assert every configured contract has code,
   expected `decimals()`/`symbol()` where applicable, and selectors
   decode against the current ABI.
5. `failure_surface_smoke` — paused/cap/allowance/balance failures
   produce stable refusal JSON and do not leave partial state.

**Harness.**

- Use Anvil fork mode for fast local and CI runs.
- Prefer Rust integration tests once `rmpc` owns the command surface.
  Existing TypeScript fork-test logic may be used as reference, not as
  the long-term driver.
- Every test uses an isolated ephemeral key and snapshot/revert.
- No explorer APIs in the test path. Reads come from JSON-RPC calls
  against the fork.

**Outputs.**

- A CI job that runs a pinned fork smoke subset.
- A release-gated or manually-triggered job that runs the fuller fork
  suite.
- Fork fixtures for USDC funding, approval, vault reads, router reads,
  and deterministic account setup.

**Acceptance criteria.**

- CI catches ABI/address drift against the pinned fork.
- A developer can run the fork smoke locally with one documented
  command and a public or configured RPC URL.
- The fork suite fails with actionable errors: address mismatch, ABI
  mismatch, route failure, gas budget exceeded, or command regression.

See `docs/technical/fork-e2e-decisions.md` for the operational decision
record (issue #47): chain target, block-pin mechanism, harness driver
(Rust crate), CI vs manual-trigger split, per-test isolation, and the
recommendation on issue #37 (drop Anvil flavor).

## 9. Phase 3 — Direct Chain-Read Query Tooling

Goal: make `rmpc` useful for observing Robot Money state without
depending on Etherscan/Basescan, website APIs, or other explorer
services. Agents and humans should be able to ask the Rust CLI what is
true on-chain.

**Principles.**

- Direct JSON-RPC reads only for canonical chain state.
- Explorer APIs may be optional enrichment later, but must not be the
  source of truth for vault, role, balance, cap, or tx-status checks.
- Output is stable JSON suitable for agents, shell scripts, and the
  phase 5 explorer service.

**Initial commands.**

```text
rmpc get-vault
rmpc get-balance --address 0x...
rmpc get-agent --agent 0x...
rmpc get-gateway
rmpc get-deposit --deposit-id 0x...
rmpc get-tx --tx-hash 0x...
rmpc get-allowance --owner 0x... --spender 0x...
rmpc get-roles --address 0x...
```

Names may change before implementation, but the read surface must cover
the same concepts.

**Vault state.**

- Vault address, asset address, share token metadata.
- Total assets, total supply, share price, deposit caps, pause/shutdown
  state, fee fields that are actually readable on-chain.
- Adapter addresses, adapter balances, active adapter count, rebalance
  availability, next rebalance timestamp, drift if exposed by the ABI.
- Explicit `unknown` or `not_onchain` values where docs or website
  claims exceed the deployed contract's read surface.

**Gateway and agent state.**

- Gateway code hash, chain id, configured USDC/vault addresses.
- Agent policy: active, valid until, max per deposit, max per window,
  current window usage, share receiver.
- Role membership for ADMIN, PAUSER, AGENT, and any future roles.
- Deposit/order status from gateway events and direct storage reads
  where possible.

**Output contract.**

- All large integers are decimal strings.
- Every command includes `chain_id`, `block_number`, and `source:
  "json_rpc"`.
- Commands that combine multiple reads include a `partial` flag and a
  per-field error list if some reads fail.

See `docs/technical/rmpc-read-output-contract.md` for the operational
decision record (issue #51): the shared envelope shape, the
`PartialBuilder` aggregation seam, the `DecimalU256` / `DecimalU128`
newtypes that enforce "decimal-string large integers" at the type
level, and the surfaces every read-command batch must consume. Stub
module lives at `clients/rust-payment-client/src/read_output.rs`. No
read-command behavior changes from this scout.

**Acceptance criteria.**

- Agents can answer "is the vault healthy?", "what is my position?",
  "can this agent deposit?", and "what happened to this tx?" from
  `rmpc` alone.
- No query command requires a block explorer API key.
- Fork tests cover every read command against pinned contracts.

## 10. Phase 4 — Agent-Harness Installation and Skill Loading

Goal: install and exercise Robot Money inside agent runtimes, starting
with OpenCode for manual agent interaction and OpenClaw for long-running
agentic tasks.

**Supported harnesses.**

- **OpenCode** — manual interactive testing. A developer can load the
  Robot Money skill, give the agent a task, inspect tool calls, and
  iterate quickly.
- **OpenClaw** — long-running task testing. The agent runs with
  scheduled or goal-driven behavior against a fork/devnet, suitable for
  phase 7.

**Skill loading.**

The canonical skill package must include:

```text
SKILL.md                 # when to use Robot Money
references/read.md       # query commands and interpretation
references/write.md      # deposit / credential / permission flows
references/safety.md     # refusal cases, caps, fork-vs-mainnet warning
references/examples.md   # minimal prompts and expected command traces
```

The skill must be harness-portable: avoid Claude-specific assumptions,
avoid hidden prompt dependencies, and keep command examples aligned with
`rmpc --help` output.

**OpenCode installation.**

- Document how to build/install `rmpc`.
- Document how to register the skill with OpenCode.
- Provide a local/fork config file and a "read-only first" prompt.
- Provide a refusal-case demonstration backed by automated assertions.

See [`docs/walkthroughs/opencode-readonly-fork.md`](walkthroughs/opencode-readonly-fork.md)
for the read-only fork walkthrough (issue #53). The walkthrough is
backed by [`testing/opencode-walkthrough/`](../testing/opencode-walkthrough/),
a Rust test crate that asserts doc-vs-CLI parity, parses the shipped
config template with the real `rmpc` config loader, and exercises the
refusal envelope on every PR via
[`.github/workflows/opencode-walkthrough.yml`](../.github/workflows/opencode-walkthrough.yml).

**OpenClaw installation.**

- Document how OpenClaw obtains the `rmpc` binary/config.
- Document environment variables and secret handling.
- Define how long-running tasks persist state: local state dir for
  `rmpc`, OpenClaw task state for goals, and optional phase 5 API for
  history.
- Require fork/devnet mode by default; mainnet mode must be an explicit
  operator action.

**MCP decision.**

See `docs/technical/mcp-decision.md` for the recorded ADR (issue #55) — decision: **defer**.

MCP is desirable if the harness cannot safely or ergonomically execute
shell commands, or if long-running OpenClaw tasks need a stable tool
server with schemas, lifecycle, and structured errors. It is not
required for the first OpenCode manual tests if shell execution is
available.

Decision criteria:

- Build MCP if OpenClaw integration is materially simpler or safer with
  long-lived tools than with process-per-call shell execution.
- Defer MCP if both OpenCode and OpenClaw can run `rmpc` commands
  directly with clean JSON and robust timeout handling.
- If built, MCP must expose the same command schema as `rmpc`, fix
  chain/config at server startup by default, restrict network binding
  to localhost unless explicitly configured, and exclude interactive
  secret prompts.

**Acceptance criteria.**

- OpenCode can load the skill and complete a read-only vault inspection
  on a fork.
- OpenCode can guide a human through a guarded deposit attempt on a
  fork, including refusal handling.
- OpenClaw can run a long-lived read/monitor task against a fork
  without manual intervention.
- The MCP decision is recorded as `build now`, `defer`, or `not needed`,
  with rationale.

## 11. Phase 5 — Simple Web Explorer API and Database

Goal: provide a lightweight service for browsing Robot Money activity
and serving recent state to web/UI consumers. This is not the source of
truth for signing or safety decisions; it is an indexed convenience
layer over chain data and `rmpc` outputs.

**Service shape.**

- Small HTTP API.
- Relational database, preferably Postgres for production-like use and
  SQLite only for local development if it materially simplifies setup.
- Background indexer that reads JSON-RPC logs and selected state at
  known blocks.
- Idempotent ingestion keyed by `chain_id`, `block_number`, `log_index`,
  and `tx_hash`.

**Data model.**

Minimum tables:

```text
chains
contracts
blocks
transactions
agent_deposits
agent_policies
vault_snapshots
wallet_positions
indexer_runs
```

Optional later tables:

```text
basket_routes
governance_events
buybacks
agent_task_runs
```

**API endpoints.**

```text
GET /health
GET /v1/chains/:chain_id/contracts
GET /v1/vault/snapshot/latest
GET /v1/vault/snapshots?from_block=&to_block=
GET /v1/agents/:address
GET /v1/agents/:address/deposits
GET /v1/transactions/:tx_hash
GET /v1/deposits/:deposit_id
```

**Boundaries.**

- The API does not sign transactions.
- The API does not authorize agents.
- The API does not replace `rmpc` preflight checks.
- Stale data must be marked with block number and indexed-at time.

**Acceptance criteria.**

- A local developer can start the API and DB, index a fork range, and
  query deposit/vault history.
- The API clearly distinguishes indexed data from live chain reads.
- Phase 6 can use the API for display, while sensitive actions still
  go through wallet/Rust-client flows.

See `docs/technical/explorer-schema-decisions.md` for the operational
decision record (issue #56) covering DB engine, indexer cadence,
reorg handling, per-table idempotency keys, ingestion model
(JSON-RPC canonical; rmpc outputs not ingested), and the explicit
defer list for "optional later" tables.


## 12. Phase 6 — Human Dapp for Commands and Credentials

Goal: provide a human-facing interface for sensitive actions that should
not be left to autonomous agents alone: granting permissions, creating
or rotating agent credentials, configuring policy caps, and inspecting
the consequences before execution.

**Primary workflows.**

1. Connect wallet.
2. Select chain/environment.
3. Inspect current vault/gateway/agent state.
4. Create or register a new agent credential.
5. Configure agent policy: share receiver, valid-until, max per
   deposit, max per window.
6. Grant/revoke roles or agent authorization.
7. Pause/unpause where permitted.
8. Export `rmpc` config for the agent runtime.

**Credential model.**

- The dapp may help generate a new agent public address or register an
  existing one, but it must not silently take custody of private keys.
- If browser-generated credentials are considered, that requires a
  separate design review. Preferred path is: user creates/holds the
  credential in the target signer backend, dapp registers the public
  address and policy.
- Any secret export must be explicit, encrypted where possible, and
  labeled as unsafe for production if it is software-backed.

**Execution model.**

- Human wallet signs admin/policy transactions.
- Dapp reads live chain state directly through RPC and may use phase 5
  API for historical display.
- Every transaction preview decodes target, calldata, role/policy
  effect, and expected risk.

**Acceptance criteria.**

- A human can authorize an agent for fork/devnet use without touching
  raw contract calldata.
- A human can revoke that agent and verify `rmpc self-check` refuses
  afterward.
- Generated/exported config is sufficient for OpenCode/OpenClaw phase 4
  setups.

See `docs/technical/dapp-credential-decisions.md` for the operational
decision record (issue #59) covering the agent-credential generation
policy (register-only by default; browser-generated as a fork-mode-only
labeled flow), the key-custody boundary (the dapp never persists a
private key), the calldata-preview UX shape (target / function /
decoded args / role-policy effect / risk class / raw calldata, with a
hard refusal on decoder failure), and the `rmpc` config export format
(TOML with an `unsafe_for_production` marker for software-backed
signers).

The browser-generated credential path named in §3.1 of that ADR is
gated behind the security-review record at
`docs/technical/dapp-browser-keygen-review.md` (issue #84). The
feature flag `DAPP_BROWSER_KEYGEN_ENABLED` defaults to `false` and may
not be enabled until that ADR's go/no-go conditions are met.

## 13. Phase 7 — OpenClaw E2E Demo on Recent Public-Chain Fork

> Operational decision record: `docs/technical/demo-runbook.md` (issue
> #62). It fixes the fork pin capture, the verbatim OpenClaw task
> prompt, the artifact set's exact file paths and formats, and the
> per-failure-case toggle commands. The §13 prose below is unchanged;
> the runbook is the deterministic script the impl issue (#61) runs.

Goal: demonstrate the full autonomous loop without requiring the phase
5 API or phase 6 dapp. The demo uses OpenClaw plus `rmpc` against a
recent fork of a public Ethereum-compatible chain, with real
contract/router state and isolated fork funds.

**Why phase 7 excludes the web API and dapp.**

The demo should prove the agent path itself: skill loading, tool use,
direct chain reads, guarded deposit behavior, refusal handling, and
long-running task management. The explorer API and dapp are useful
operator surfaces, but they should not be required for the autonomous
agent to function.

**Demo setup.**

- Start a recent fork with pinned block metadata recorded.
- Deploy or configure the gateway/vault addresses for the demo path.
- Create an ephemeral agent key and human/admin key.
- Authorize the agent and fund it with forked USDC.
- Install `rmpc` and the Robot Money skill into OpenClaw.
- Run OpenClaw with a bounded task such as:
  "Monitor vault status, verify the agent is authorized, deposit a
  capped amount of USDC when safe, then report tx hash and resulting
  position."

**Required demo behaviors.**

1. OpenClaw loads the skill and selects `rmpc` for Robot Money tasks.
2. The agent performs direct chain reads before attempting a write.
3. The agent refuses or asks for operator action if config, role,
   balance, allowance, cap, or code hash checks fail.
4. The agent performs a successful guarded deposit on the fork.
5. The agent records tx hash, deposit id, vault position, and block
   number.
6. The agent continues running long enough to detect final status and
   produce a concise final report.

**Artifacts.**

- Demo runbook.
- Fork config and pinned block metadata.
- OpenClaw config.
- Skill package used for the run.
- Captured command trace and JSON outputs.
- Final report with tx hashes and state changes.

**Acceptance criteria.**

- The demo can be reproduced from a clean checkout with documented
  prerequisites.
- The agent never uses explorer APIs for safety-critical reads.
- The demo does not require the phase 5 API or phase 6 dapp.
- Failure cases are demonstrable by toggling one condition at a time:
  unauthorized agent, insufficient allowance, paused gateway, fee cap,
  and code-hash mismatch.
