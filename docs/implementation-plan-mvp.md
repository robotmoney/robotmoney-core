# MVP Implementation Plan — Rust Payment Client + Deposit Gateway

> Companion to `docs/architecture-proposal-v0.md`. This plan trims the v0
> spec to a runnable end-to-end slice: one chain, one token, one
> gateway, one Rust client backend. Every cut item lives in v0 §16–§28
> and can be added incrementally without changing the trait surface
> defined here.

## 0. Scope

**In scope.** A single-chain (local Geth devnet), single-token (mock
USDC), single-gateway system where a Rust daemon authenticates as an
`AGENT_ROLE` key and calls one function — `deposit` — on a gateway that
enforces per-agent allowlist, per-payment cap, per-window cap, pause,
and event emission. Funds escrow into the gateway under an `orderId`.
Admin/master roles are real (separate keys, on-chain checks).

**Out of scope (deferred).** Adapters/yield, ERC-4626 share token,
master-batch Merkle confirmation (v0 §22), refund/expiry, Permit2 /
UniversalRouter, multi-RPC consensus, multi-backend signers (only
software-encrypted for MVP), proxy upgradeability, governance.

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
    gateway.rs                  # ABI-encode deposit() + decode events
    rpc.rs                      # minimal JSON-RPC over reqwest
    policy.rs                   # preflight checks mirrored from contract
    tx.rs                       # build/sign/broadcast EIP-1559 tx
    errors.rs

testing/e2e/
  scripts/deploy_gateway.ts     # forge script + ts deploy helper
  tests/e2e_deposit.rs          # Rust integration test driver
```

## 2. Contracts (smallest viable surface)

### 2.1 `AccessRoles.sol`
OpenZeppelin `AccessControl` with four roles, all distinct keys:

- `ADMIN_ROLE` — grants/revokes other roles, sets policy.
- `MASTER_ROLE` — placeholder for v0 §22 batch confirmation; in MVP it
  may raise per-agent caps with a 1-of-1 signature.
- `PAUSER_ROLE` — `pause()` / `unpause()`.
- `AGENT_ROLE` — only role allowed to call `deposit()`.

**Invariant.** An `AGENT_ROLE` holder must not also hold `ADMIN_ROLE`,
`MASTER_ROLE`, or `PAUSER_ROLE`. Enforced in deploy script and asserted
in a post-grant check.

### 2.2 `RobotMoneyGateway.sol`

Storage:

```solidity
IERC20  public immutable usdc;                  // pinned at construction
mapping(address => AgentPolicy) public agents;  // active, validUntil,
                                                // maxPerPayment, maxPerWindow
mapping(uint64  => uint256) public windowGross; // windowId => gross
mapping(bytes32 => bool)    public usedPaymentIds;
bool public paused;
uint64 public constant WINDOW_SECONDS = 86400;
```

Functions (refuse anything else):

```solidity
function deposit(
    bytes32 orderId,
    uint64  merchantId,
    uint256 amount,
    uint64  deadline,
    bytes32 idempotencyKey
) external whenNotPaused onlyRole(AGENT_ROLE) returns (bytes32 paymentId);

function authorizeAgent(address agent, AgentPolicy calldata p) external onlyRole(ADMIN_ROLE);
function revokeAgent(address agent) external onlyRole(ADMIN_ROLE);
function pause()    external onlyRole(PAUSER_ROLE);
function unpause()  external onlyRole(ADMIN_ROLE);
```

Checks inside `deposit` (subset of v0 §20.1):

- `amount > 0 && amount <= agents[msg.sender].maxPerPayment`
- `block.timestamp <= deadline && deadline <= block.timestamp + 600`
- `agents[msg.sender].active && validUntil >= block.timestamp`
- `windowGross[currentWindow] + amount <= agents[msg.sender].maxPerWindow`
- `paymentId = keccak256(chainid, this, msg.sender, orderId,
  merchantId, amount, idempotencyKey)`; revert if already used
- `usdc.transferFrom(msg.sender, address(this), amount)` with
  **balance-delta verification** (fee-on-transfer defense, v0 §25)
- emit `PaymentEscrowed(paymentId, orderId, agent, merchantId, amount, windowId)`

### 2.3 Cuts vs. v0

- Merchant registry — `merchantId` is a logged tag only.
- Master batch confirmation — replaced by per-agent `maxPerWindow`.
- Refund/expiry — not in MVP; admin rescue is post-MVP.
- Upgradeability — non-upgradeable, `immutable` USDC.

## 3. Rust client

### 3.1 Crate layout

Matches v0 §6 but trimmed: only `signer/software.rs` is implemented.
`signer/mod.rs` defines the trait so HSM/KMS land later without API
churn.

### 3.2 `AgentSigner` trait (verbatim from v0 §8.1, MVP-shrunk request)

```rust
pub trait AgentSigner {
    fn backend_kind(&self) -> SignerBackendKind;
    fn public_address(&self) -> Address;
    fn sign_gateway_tx(&self, req: GatewayTxRequest) -> Result<SignedTx, SignerError>;
}

pub enum GatewayTxRequest {
    Deposit {
        order_id: [u8; 32],
        merchant_id: u64,
        amount: u64,
        deadline: u64,
        idempotency_key: [u8; 32],
    },
}
```

The trait does **not** expose `sign_hash` / `sign_message` /
`sign_typed_data`. Enforced at the type level so future backends
cannot widen it.

### 3.3 Software signer

- secp256k1 via `k256` crate.
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

Any failure → refuse without broadcasting. Advisory only; the contract
is authoritative.

### 3.5 ABI encoding

Hand-rolled for the four selectors used (`approve`, `allowance`,
`balanceOf`, `deposit`). No `ethers-rs`, no `alloy` runtime. Dep tree:
`k256`, `sha3`, `aes-gcm`, `argon2`, `reqwest`, `serde_json`,
`zeroize`, `thiserror`, `clap`.

### 3.6 CLI surface

```
rmpd deposit --amount 100.00 --order-id 0x… --merchant 7
rmpd status  --payment-id 0x…
rmpd self-check                # backend report (v0 §9.2 JSON)
```

JSON on stdout, exit 0 on success, named errors on failure.

## 4. End-to-end test plan

**Harness.** Existing `testing/ethereum-testnet` Docker stack
(Geth + Lighthouse + 4 validators, 12-second blocks). Foundry config
at `testing/ethereum-testnet/contracts/foundry.toml` is the deploy
harness.

**Driver.** `cargo test` integration test in `testing/e2e/`. The user
asked for a Rust client, so the e2e signal must come from the Rust
binary itself, not a TS shim.

**Scenarios** (each = one `#[test]`):

1. `deposit_happy_path` — admin authorizes agent, agent runs `rmpd
   deposit`, assert `PaymentEscrowed` event + USDC balance delta on
   gateway.
2. `unauthorized_agent_rejected` — agent without `AGENT_ROLE` →
   contract reverts; client surfaces `ErrAgentNotAuthorized`.
3. `paused_blocks_deposit` — `PAUSER_ROLE` calls `pause()`; client
   preflight refuses to sign (no broadcast).
4. `over_per_payment_cap_rejected` — preflight rejects; contract would
   also revert (asserted via debug-only bypass).
5. `over_window_cap_rejected` — two deposits whose sum exceeds
   `maxPerWindow` → second reverts on-chain.
6. `idempotent_replay_rejected` — same `(orderId, idempotencyKey)`
   twice → second reverts with `PaymentIdAlreadyUsed`.
7. `code_hash_mismatch_aborts` — flip pinned hash in config → client
   refuses to sign.
8. `software_fallback_disabled_aborts_startup` —
   `allow_software_fallback = false` with software backend selected →
   exits non-zero before any RPC.
9. `role_separation_invariant` — deploy script tries to grant
   `AGENT_ROLE` to admin → assertion reverts.

Each test: fresh deployment via forge script (per-test fixture,
not per-suite, for state isolation); pre-fund agent EOA with mock USDC
and approve the gateway; run `rmpd` as subprocess and assert on JSON
stdout + on-chain event log.

**Coverage targets.** Every `revert` in the gateway has a corresponding
negative test; every preflight rule has a corresponding client-side
test.

## 5. Build order

1. Contracts + role-separation deploy script + Foundry tests.
2. Mock USDC + deploy harness wired into the Docker testnet.
   Smoke test: TS SDK calls `deposit` (proves contract before
   introducing Rust).
3. Rust crate skeleton + config loader + RPC + ABI encoder.
   `rmpd self-check` can read state.
4. Software signer + `deposit` happy path. Tests 1–2.
5. Preflight + policy refusal + code-hash pinning. Tests 3–4, 7–8.
6. Negative on-chain paths. Tests 5–6, 9.

Each chunk is independently mergeable.

## 6. Open questions

1. **Mock USDC vs forked mainnet USDC.** MVP defaults to mock for
   determinism; canonical-USDC verification (v0 §25) deferred.
2. **`merchantId` semantics.** Opaque tag in MVP; no registry.
3. **`MASTER_ROLE` in MVP.** Wired in but dormant by default; can be
   given a real job (raising per-agent caps with a 1-of-1 sig) on
   request.
4. **Test runner shape.** Subprocess-driven cargo integration test,
   matching real deployment. Library-mode tests are faster but skip
   the binary boundary.
