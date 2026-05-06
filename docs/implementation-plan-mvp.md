# MVP Implementation Plan — Rust Payment Client + Deposit Gateway

> Companion to `docs/architecture-proposal-v0.md`. This plan is the
> buildable slice of v0: one chain, one token, one gateway, one Rust
> client.
>
> **Relationship to the product.** Robot Money is the ERC-4626 yield
> vault in `contracts/RobotMoneyVault.sol` plus its
> Aave/Compound/Morpho adapters; see `docs/prd.md`. This plan builds
> the security architecture for autonomous-agent access to that
> vault — a Rust signing daemon plus an on-chain policy gateway that
> wraps `vault.deposit()`. The gateway is the only contract an
> agent's key may call; it pulls USDC from the agent, enforces
> per-agent caps, and forwards into the vault.

## 0. Scope

**In scope.** A single-chain (local Geth devnet), single-token (mock
USDC), single-gateway system where a Rust daemon authenticates as an
`AGENT_ROLE` key and calls one function — `deposit` — on a gateway
that enforces per-agent allowlist, per-payment cap, per-window cap,
pause, and **forwards the deposit into a `RobotMoneyVault`**. Vault
shares (`rmUSDC`) settle to a configurable receiver registered with
the gateway. Admin role is real (separate key, on-chain checks).

**Mock USDC + mock vault are the test target.** The MVP test suite
runs against a 6-decimal `MockUSDC.sol` and a minimal `MockVault.sol`
(or the real `RobotMoneyVault.sol` deployed in a single-adapter
configuration) on Anvil and on the Docker devnet.

**Out of scope (deferred).** Adapters/yield, ERC-4626 share token,
master-batch Merkle confirmation (v0 §22), `MASTER_ROLE` in any form
(see §2.3), refund/expiry, Permit2 / UniversalRouter, multi-RPC
consensus, multi-backend signers (only software-encrypted for MVP),
proxy upgradeability, governance.

## 1. Components

```
contracts/gateway/
  MockUSDC.sol                  # 6-decimal ERC20 for tests
  RobotMoneyGateway.sol         # the deposit gateway (this MVP)
  AccessRoles.sol               # role constants + AccessControl wiring
  interfaces/IGateway.sol

clients/rust-payment-daemon/
  Cargo.toml
  src/
    main.rs                     # CLI: deposit / status / self-check
    config.rs                   # toml loader, address pinning, chain_id
    signer/mod.rs               # AgentSigner trait
    signer/software.rs          # encrypted-keystore secp256k1 (MVP)
    gateway.rs                  # alloy-sol-types bindings + event decode
    rpc.rs                      # minimal JSON-RPC over reqwest
    policy.rs                   # preflight checks mirrored from contract
    tx.rs                       # build/sign/broadcast EIP-1559 tx
    fees.rs                     # gas pricing + fee-cap policy
    nonce.rs                    # local nonce manager
    errors.rs

testing/ethereum-testnet/
  contracts/                    # forge project (existing)
  e2e-rust/                     # NEW: Rust integration tests, driven
                                # against the Docker stack
```

Note: the e2e tests live under the existing `testing/ethereum-testnet/`
tree (not a separate `testing/e2e/`) to keep the harness, contracts,
and driver co-located.

## 2. Contracts (smallest viable surface)

### 2.1 `AccessRoles.sol`

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

### 2.2 `RobotMoneyGateway.sol`

The gateway is a thin policy-gated wrapper around `vault.deposit()`.
It pulls USDC from the agent, enforces per-agent caps, calls the
vault, and routes the resulting `rmUSDC` shares to a per-agent
configured receiver (typically an operator-controlled address, never
the agent's signing key).

Storage:

```solidity
IERC20    public immutable usdc;                       // pinned at construction
IERC4626  public immutable vault;                      // RobotMoneyVault, pinned

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
bool public paused;
uint64 public constant WINDOW_SECONDS = 86400;         // Unix-epoch-aligned;
                                                       // see v0 §23.3
```

Functions (refuse anything else):

```solidity
function deposit(
    bytes32 orderId,
    uint256 amount,
    uint64  deadline,
    bytes32 idempotencyKey
) external whenNotPaused onlyRole(AGENT_ROLE)
    returns (bytes32 paymentId, uint256 sharesMinted);

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
2. `block.timestamp <= deadline && deadline <= block.timestamp + 600`
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
7. `usdc.safeTransferFrom(msg.sender, address(this), amount)` with
   **balance-delta verification** (fee-on-transfer defense, v0 §25).
8. `usdc.forceApprove(address(vault), amount)` (one-shot allowance,
   reset to zero post-call).
9. `sharesMinted = vault.deposit(amount, agents[msg.sender].shareReceiver)`
   — the gateway is the ERC-4626 caller; the receiver is the agent's
   pre-registered share-receiver address. Vault-side reverts (TVL
   cap, paused, shutdown) propagate; the gateway never holds shares.
10. `usdc.forceApprove(address(vault), 0)` to clear residual.
11. Update `agentWindowGross[msg.sender][windowId] += amount` and
    mark `usedPaymentIds[paymentId] = true`.
12. emit `AgentDeposit(paymentId, orderId, agent, shareReceiver,
    amount, sharesMinted, windowId)`.

The gateway must never custody `rmUSDC`; the vault deposit and the
share routing happen in the same call frame and the gateway's
`rmUSDC` balance is asserted to be zero before and after.

## 3. Rust client

### 3.1 Crate layout

Matches v0 §6 but trimmed: only `signer/software.rs` is implemented.
`signer/mod.rs` defines the trait so HSM/KMS land later without API
churn.

### 3.2 `AgentSigner` trait (verbatim from v0 §8.1, MVP-shrunk request)

```rust
use alloy_primitives::{Address, B256, U256};

pub trait AgentSigner {
    fn backend_kind(&self) -> SignerBackendKind;
    fn public_address(&self) -> Address;
    fn sign_gateway_tx(&self, req: GatewayTxRequest) -> Result<SignedTx, SignerError>;
}

pub enum GatewayTxRequest {
    Deposit {
        order_id: B256,
        amount: U256,                // matches contract uint256;
                                     // never narrowed at the trust boundary
        deadline: u64,
        idempotency_key: B256,
    },
}
```

The trait does **not** expose `sign_hash` / `sign_message` /
`sign_typed_data`. Enforced at the type level so future backends
cannot widen it.

### 3.3 Software signer

- secp256k1 via `k256` crate (or alloy's signer abstraction; see §3.5).
- Key encrypted-at-rest with `aes-gcm` + Argon2 KDF; passphrase from
  env or stdin.
- Plaintext key zeroized after each sign via `zeroize`.
- Refuses to start unless `[signer].allow_software_fallback = true`.
  Emits a high-severity log line on startup (v0 §10.5).

### 3.4 Preflight (mirrors contract, v0 §11)

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

### 3.5 ABI encoding and Ethereum primitives

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

### 3.6 Nonce management

The MVP CLI is **single-flight**: each `rmpd deposit` invocation
acquires an exclusive file lock on
`$RMPD_STATE_DIR/agent-<address>.lock` for the duration of
`(eth_getTransactionCount → sign → broadcast → receipt)`. Concurrent
invocations against the same agent address fail fast with
`ErrConcurrentInvocation`. A full nonce manager (with pending-tx
queue, replacement, gap recovery) is v1 work.

### 3.7 Fee policy

EIP-1559 transactions only. Per-invocation behavior:

- Read `eth_feeHistory` for the last 5 blocks; compute
  `baseFee` from the latest block and `priorityFee = max(p50, 1 gwei)`.
- Set `maxPriorityFeePerGas = priorityFee`.
- Set `maxFeePerGas = min(2 * baseFee + priorityFee,
  config.max_fee_per_gas_cap)`.
- If the computed `maxFeePerGas` would exceed
  `config.max_fee_per_gas_cap`, refuse with `ErrFeeCapExceeded` (no
  broadcast). The cap is operator policy, not best-effort.

Defaults: `max_fee_per_gas_cap = 100 gwei` for MVP devnet runs.

### 3.8 CLI surface

```
rmpd deposit --amount 100.00 --order-id 0x…
rmpd status  --payment-id 0x…
rmpd self-check                # backend report (v0 §9.2 JSON)
```

JSON on stdout, exit 0 on success, named errors on failure.

## 4. End-to-end test plan

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
subprocess `rmpd` invocations, JSON-on-stdout assertions, real signing.

Anvil/Geth interaction from Rust uses `alloy-provider` for read calls
and JSON-RPC pokes (`anvil_setNextBlockBaseFeePerGas`,
`evm_snapshot`, `evm_revert`); deployments use `forge script` invoked
as a subprocess from the Rust harness's `setup()` fixture.

**Scenarios** (each = one `#[test]`):

1. `deposit_happy_path` *(Geth)* — admin authorizes agent, agent runs
   `rmpd deposit`, assert `PaymentEscrowed` event + USDC balance delta
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
   `PaymentIdAlreadyUsed`.
7. `code_hash_mismatch_aborts` *(Anvil)* — flip pinned hash in config
   → client refuses to sign (hard refusal, not advisory).
8. `software_fallback_disabled_aborts_startup` *(Anvil)* —
   `allow_software_fallback = false` with software backend selected →
   exits non-zero before any RPC.
9. `role_separation_invariant` *(Geth)* — deploy script tries to grant
   `AGENT_ROLE` to admin → assertion reverts.
10. `fee_cap_exceeded_aborts` *(Anvil)* — set Anvil base fee above
    `max_fee_per_gas_cap` → client refuses with `ErrFeeCapExceeded`.
11. `concurrent_invocation_locked` *(Anvil)* — two `rmpd deposit`
    processes against the same agent address; one wins, the other
    fails fast with `ErrConcurrentInvocation`.

Per-test: pre-fund agent EOA with mock USDC and approve the gateway;
run `rmpd` as subprocess and assert on JSON stdout + on-chain event
log.

**Coverage targets.** Every `revert` in the gateway has a corresponding
negative test; every preflight rule has a corresponding client-side
test; every refusal in §3.4/§3.6/§3.7 has a corresponding client-side
test.

## 5. Build order

1. Contracts + role-separation deploy script + Foundry tests on Anvil.
2. Mock USDC + deploy harness wired into the Docker testnet, plus a
   bare `cast send` smoke (one tx) to confirm the stack — no TS SDK
   detour.
3. Rust crate skeleton + config loader + RPC + alloy bindings.
   `rmpd self-check` can read state.
4. Software signer + nonce lock + fee-cap policy + `deposit` happy
   path. Tests 1–2, 10–11.
5. Preflight + policy refusal + code-hash pinning. Tests 3–4, 7–8.
6. Negative on-chain paths. Tests 5–6, 9.

Each chunk is independently mergeable.

## 6. Open questions

1. **Fee-cap default.** `100 gwei` is generous for an L1 devnet but
   intentionally loud if it ever fires on a real chain. Operators on
   L2s should lower this an order of magnitude.
