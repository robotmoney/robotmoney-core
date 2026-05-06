# Specification: Constrained Rust Payment Client + Single Gateway Smart Contract

> **Status — design proposal, not the deployed system.** This document
> specifies a *future* agent-payment gateway. It is **not** a description of
> the contracts currently in `contracts/` (`RobotMoneyVault.sol` and the
> Aave/Compound/Morpho adapters), which implement an ERC-4626 yield vault
> with a different surface, different roles (`ADMIN_ROLE`, `EMERGENCY_ROLE`,
> `KEEPER_ROLE`), and no escrow / agent-registry / master-batch semantics.
> When this document and the deployed vault disagree, the deployed vault is
> authoritative for current behavior; this document is authoritative only
> for the proposed agent-payment layer.
>
> Section 37 (dead-man's-switch / auto-reversion) is a *separate* design
> sketch layered on an ERC-4337 smart account. It is independent of
> sections 1–36 and does not replace them. Treat §1–§36 and §37 as two
> proposals filed in the same document for convenience.
>
> Section 38 (attack catalog) applies to the proposal in §1–§36 and is the
> threat-model companion to §1.

## 0. System goal

Build an agentic-commerce payment system where:

```text
1. A Rust client/daemon can initiate USDC micropayments.
2. The client may run on VPS, Mac mini, bare metal, or other host.
3. The client must use the strongest available local signing backend:
   - hardware HSM
   - Secure Enclave / OS-backed key store
   - TPM / vTPM if available
   - cloud KMS if configured
   - encrypted software key only as fallback
4. The client can interact with exactly one smart contract gateway on exactly one chain.
5. Agent spend is bounded by on-chain policy.
6. Accumulated spend across all agents above a threshold requires master confirmation.
7. Master/admin keys are never stored on the client daemon host.
8. The smart contract is the final source of truth.
```

The client is **not a general-purpose wallet**. It is a constrained signing and payment daemon.

### 0.1 Actor vocabulary (normative)

To resolve interchangeable use of "agent," "daemon," and "client" elsewhere
in this doc, the following definitions are normative:

```text
- LLM / commerce logic   — untrusted high-level requester. Issues
                           structured payment intents only.
- Daemon (Rust client)   — partially trusted process. Validates intents,
                           builds calldata, holds the agent signing key
                           via a hardware-backed signer, broadcasts txs.
- Agent key              — the on-chain signer with AGENT_ROLE on the
                           gateway. Held by the daemon's signer backend;
                           never exportable.
- Master signer          — separate hardware/multisig holding MASTER_ROLE.
                           Confirms threshold-crossing batches. Never
                           on the daemon host.
- Admin                  — multisig + timelock holding ADMIN_ROLE.
                           Manages policy, agents, merchants, upgrades.
```

Where this doc previously says "agent" in a code/role context it means
the **agent key**; where it says "client" or "daemon" it means the Rust
process that holds that key via a signer abstraction.

---

# 1. Threat model assumptions

## 1.1 Trusted components

```text
- Gateway contract bytecode, after audit/deployment.
- Master/admin multisig or hardware-backed master signer.
- Canonical USDC contract address on the chosen chain.
- Secure signing backend, if available and correctly configured.
```

## 1.2 Partially trusted components

```text
- Rust client host.
- RPC provider.
- Payment daemon database.
- Merchant APIs.
- Agent/LLM process.
- Local OS.
```

## 1.3 Untrusted components

```text
- Web pages scraped by the agent.
- Merchant-provided text, invoices, metadata, PDFs, images.
- User-facing prompts.
- External API responses.
- RPC responses unless cross-checked.
- Client internal counters.
```

## 1.4 Required security property

The system must remain safe if:

```text
- one agent key is compromised;
- one payment daemon is compromised;
- the daemon’s local database is deleted or modified;
- multiple agents race each other;
- a VPS disk image is cloned;
- the daemon is tricked by prompt injection;
- an RPC endpoint gives stale or misleading state.
```

The maximum loss or lockup must be bounded by **on-chain policy**, not daemon behavior.

---

# 2. Non-goals

The system does not attempt to:

```text
- be a general wallet;
- sign arbitrary blockchain transactions;
- support arbitrary contracts;
- support arbitrary tokens;
- support arbitrary chains;
- hold master/admin/treasury keys on the daemon host;
- prove merchant honesty;
- eliminate USDC issuer risk;
- eliminate all risk from full host compromise.
```

---

# 3. High-level architecture

```text
┌────────────────────┐
│ Agent / Commerce   │
│ Logic / LLM        │
└─────────┬──────────┘
          │ high-level payment request only
          v
┌────────────────────┐
│ Rust Payment       │
│ Client / Daemon    │
│                    │
│ - validates input  │
│ - checks policy    │
│ - builds calldata  │
│ - asks signer      │
│ - broadcasts tx    │
└─────────┬──────────┘
          │ constrained signing request
          v
┌────────────────────┐
│ Key Provider       │
│                    │
│ HSM / enclave /    │
│ KMS / TPM /        │
│ encrypted fallback │
└─────────┬──────────┘
          │ signed tx
          v
┌────────────────────┐
│ Single Gateway     │
│ Smart Contract     │
│                    │
│ - agent registry   │
│ - spend policy     │
│ - escrow           │
│ - threshold check  │
│ - master confirm   │
│ - refund/settle    │
└─────────┬──────────┘
          v
┌────────────────────┐
│ Canonical USDC     │
└────────────────────┘
```

---

# 4. Core invariant

The following must always be true:

```text
No daemon, agent, or local signer can move or lock funds outside the gateway’s on-chain policy.
```

More concretely:

```text
1. The client only signs transactions to one gateway address.
2. The client only signs known gateway function selectors.
3. The gateway only accepts authorized agent keys.
4. The gateway enforces global accumulated spend across all agents.
5. The gateway requires master confirmation once the threshold is crossed.
6. The gateway rejects duplicate order/payment IDs.
7. The gateway never executes arbitrary calls.
8. The gateway never accepts arbitrary token addresses.
9. Master/admin keys are separate from agent keys.
```

---

# 5. Rust client specification

## 5.1 Client responsibilities

The Rust client must:

```text
- detect available signing backends;
- select the strongest configured backend;
- initialize or load the agent signing key;
- verify chain ID;
- verify gateway bytecode hash or deployed contract identifier;
- verify canonical USDC address from static config;
- fetch on-chain policy;
- maintain local cache/state for UX and preflight only;
- build exact calldata for allowed gateway methods;
- refuse arbitrary transaction signing;
- sign and broadcast transactions;
- monitor receipts/events;
- reconcile local state against chain state.
```

The client must not:

```text
- expose raw private keys;
- expose generic eth_sign;
- expose personal_sign;
- expose arbitrary EIP-712 signing;
- expose arbitrary calldata signing;
- allow dynamic chain switching;
- allow dynamic gateway replacement without signed config update;
- hold master/admin keys;
- hold merchant settlement keys;
- perform contract upgrades.
```

---

# 6. Rust client module layout

Recommended crate layout:

```text
client/
  src/
    main.rs
    config.rs
    policy.rs
    gateway.rs
    signer/
      mod.rs
      software.rs
      hsm.rs
      secure_enclave.rs
      tpm.rs
      kms.rs
      detection.rs
    tx.rs
    rpc.rs
    storage.rs
    monitor.rs
    errors.rs
    audit.rs
    types.rs
```

## 6.1 Minimal dependency policy

Use minimal dependencies.

Recommended categories:

```text
- secp256k1 signing library if software signing is needed
- keccak256 hashing
- ABI encoding for known static functions, preferably hand-rolled or minimal
- HTTP client for JSON-RPC
- serde/serde_json only if needed
- zeroize/secrecy-style crate for secret memory
- platform-specific FFI only behind feature flags
```

Avoid:

```text
- full wallet frameworks;
- plugin systems;
- browser automation inside signer;
- arbitrary ABI routers;
- dynamic contract-call builders;
- broad web3 convenience layers that expose generic signing paths.
```

---

# 7. Configuration specification

The client config must be explicit and narrow.

Example:

```toml
[chain]
chain_id = 8453
name = "base-mainnet"
rpc_urls = [
  "https://rpc1.example",
  "https://rpc2.example"
]

[contracts]
gateway = "0xGateway..."
gateway_code_hash = "0xExpectedRuntimeCodeHash..."
usdc = "0xCanonicalUSDC..."

[policy]
max_client_preflight_amount_usdc_atoms = 100000000
max_deadline_seconds = 600
max_gas_fee_wei = "10000000000"
max_priority_fee_wei = "2000000000"

[signer]
preferred_backends = [
  "external_hsm",
  "secure_enclave",
  "cloud_kms",
  "tpm",
  "software_encrypted"
]
allow_software_fallback = false

[storage]
path = "/var/lib/paymentd/state.db"

[audit]
log_path = "/var/log/paymentd/audit.log"
```

Hard security controls should be duplicated on-chain. Client-side config is not authoritative.

---

# 8. Signer abstraction

## 8.1 Trait

The signer interface must be narrow.

```rust
pub trait AgentSigner {
    fn backend_kind(&self) -> SignerBackendKind;

    fn public_address(&self) -> Address;

    fn sign_gateway_tx(
        &self,
        request: GatewayTxRequest,
    ) -> Result<SignedTransaction, SignerError>;
}
```

Do **not** expose:

```rust
sign_hash(hash)
sign_message(message)
sign_typed_data(data)
sign_transaction(tx)
```

unless they are private internals not reachable from the daemon API.

## 8.2 Gateway transaction request

```rust
pub enum GatewayTxRequest {
    EscrowMicropayment {
        order_id: [u8; 32],
        merchant_id: u64,
        amount_usdc_atoms: u64,
        deadline: u64,
        refund_address: Address,        // explicit refund destination,
                                        // bound at escrow time (see §20.4)
        merchant_authorization: Vec<u8>, // optional EIP-712 signature
                                        // by merchant over the order
                                        // tuple; required iff merchant
                                        // policy.requires_signed_orders
        idempotency_key: [u8; 32],
    },

    RequestRefundAfterExpiry {
        payment_id: [u8; 32],
    },
}
```

No arbitrary `to`, `data`, `value`, or `chain_id` field should be accepted from the agent layer.

---

# 9. Signer backend detection

## 9.1 Backend priority

The client should rank available backends as:

```text
1. External hardware HSM with non-exportable key.
2. Cloud KMS/HSM-backed asymmetric key, if explicitly configured.
3. Apple Secure Enclave / device-bound Keychain key.
4. TPM-sealed key, if available and meaningful.
5. Encrypted software key, only if explicitly allowed.
```

The system must refuse startup if no allowed backend is available.

## 9.2 Detection output

On startup, the client must produce a signed or logged attestation-style report:

```json
{
  "selected_backend": "secure_enclave",
  "agent_address": "0x...",
  "chain_id": 8453,
  "gateway": "0x...",
  "software_fallback_allowed": false,
  "key_exportable": false,
  "device_bound": true,
  "timestamp": 1770000000
}
```

## 9.3 Backend capabilities

Each backend must expose capability flags:

```rust
pub struct SignerCapabilities {
    pub non_exportable: bool,
    pub device_bound: bool,
    pub hardware_backed: bool,
    pub requires_user_presence: bool,
    pub supports_secp256k1: bool,
    pub supports_ethereum_recovery_id: bool,
    pub remote_attestation_available: bool,
}
```

The client must reject backends that cannot produce signatures compatible with the target chain.

---

# 10. Backend-specific requirements

## 10.1 External HSM

The HSM backend should support:

```text
- non-exportable key generation;
- secp256k1 ECDSA or compatible signing path;
- access-control credentials not stored in plaintext;
- rate limiting where possible;
- device serial allowlist;
- optional attestation/certificate of key origin.
```

The client must verify:

```text
- expected HSM device identity, if available;
- expected key handle;
- key is non-exportable, if the HSM reports this;
- signature address matches authorized on-chain agent address.
```

## 10.2 Apple Secure Enclave / Keychain

The Secure Enclave backend should support:

```text
- device-bound key storage;
- non-migratable key where possible;
- no raw private key export;
- access controlled by daemon identity;
- optional user presence only if operationally acceptable.
```

If Secure Enclave does not support the required curve/signature format directly, the implementation may instead use device-bound Keychain material to decrypt a local agent key, but this must be reported as weaker than native non-exportable signing.

## 10.3 TPM

TPM backend should support:

```text
- sealing a decrypting secret to platform state;
- boot-state binding where available;
- local unseal only on expected machine state;
- no reliance on TPM if running on VPS without meaningful vTPM support.
```

The client must mark TPM-backed software decryption as:

```text
hardware-bound: true
non-exportable signing key: false
```

unless the TPM itself performs compatible signing with the non-exportable key.

## 10.4 Cloud KMS

Cloud KMS backend should support:

```text
- asymmetric signing;
- key material non-exportability;
- IAM/service-account restrictions;
- audit logs;
- optional VPC/private endpoint restrictions;
- explicit key ID allowlist.
```

The client must not store cloud credentials that allow broad account access.

## 10.5 Software-encrypted fallback

Software fallback is allowed only for low-value deployments or development.

Requirements:

```text
- encrypted-at-rest key;
- passphrase or OS secret store;
- memory zeroization;
- no key export API;
- disabled core dumps;
- restrictive file permissions;
- explicit config flag required.
```

Software fallback must log a high-severity warning on startup.

---

# 11. Client transaction policy

Before signing, the client must enforce:

```text
chain_id == configured_chain_id
to == configured_gateway
value == 0
function_selector in allowed_gateway_selectors
amount <= local_preflight_limit
deadline >= now
deadline <= now + max_deadline_seconds
order_id not already submitted locally
idempotency_key not already used locally
gas_fee_cap <= configured_max
priority_fee <= configured_max
gateway bytecode hash == expected hash
agent key is authorized on-chain
```

The client must fetch on-chain policy before signing and reject if:

```text
agent is revoked
agent authorization expired
gateway is paused
merchant is not allowed
amount exceeds visible policy
payment ID already exists
```

However, the client must treat these checks as **preflight only**. The gateway must independently enforce them.

---

# 12. RPC requirements

The client should support at least two RPC URLs.

For critical reads, compare:

```text
chain ID
latest block number
gateway code hash
agent authorization state
payment status
nonce
gas estimates
```

If RPCs disagree beyond acceptable tolerance, fail closed.

The client must never rely on a single RPC response to override local hardcoded config.

---

# 13. Local state

The client may maintain:

```text
- known submitted order IDs;
- known transaction hashes;
- pending payment IDs;
- last observed block;
- local spend estimates;
- local nonce hints;
- backend detection report;
- audit logs.
```

Local state is advisory only.

The client must survive:

```text
- local DB deletion;
- local DB rollback;
- restart;
- duplicate request replay.
```

Idempotency must ultimately be enforced by the gateway.

---

# 14. Client audit logging

Every signing decision must produce an append-only audit record.

Log:

```text
timestamp
agent address
backend type
request type
order ID hash
merchant ID
amount
deadline
policy version
gateway address
chain ID
decision: signed/rejected
rejection reason
tx hash, if signed
```

Do not log:

```text
private keys
seed phrases
passphrases
full PII
raw auth tokens
cloud credentials
unredacted customer data
```

---

# 15. Smart contract specification

## 15.1 Contract role

The gateway contract is the only contract the client can call.

It must handle:

```text
- agent authorization;
- merchant allowlisting;
- USDC escrow;
- micropayment recording;
- global accumulated spend tracking;
- threshold enforcement;
- master confirmation;
- settlement;
- expiry/refund;
- emergency pause;
- event emission.
```

It must not:

```text
- execute arbitrary external calls;
- accept arbitrary token addresses;
- let agents upgrade contracts;
- let agents alter policy;
- let agents settle unconfirmed threshold-exceeding payments;
- let agents change merchant payout addresses;
- let master key upgrade contract alone, unless explicitly intended.
```

---

# 16. Gateway roles

Recommended roles:

```text
ADMIN_ROLE
  - manages upgrades, if upgradeable
  - changes core policy
  - should be multisig + timelock

MASTER_ROLE
  - confirms batches above threshold
  - should be hardware/multisig backed
  - cannot upgrade contract alone

PAUSER_ROLE
  - can pause escrow/settlement
  - may be emergency multisig or security operator

AGENT_ROLE
  - can create pending micropayments within policy

MERCHANT_MANAGER_ROLE
  - can add/remove merchants
  - should not be held by agent
```

The agent must not have:

```text
ADMIN_ROLE
MASTER_ROLE
PAUSER_ROLE
MERCHANT_MANAGER_ROLE
```

---

# 17. Gateway data structures

Example Solidity-style model:

```solidity
struct AgentPolicy {
    bool active;
    uint64 validUntil;
    uint256 maxPerPayment;
    uint256 maxPending;
    uint256 maxPerWindow;
}

struct Merchant {
    bool active;
    address payout;
    uint256 maxPerPayment;
}

enum PaymentStatus {
    None,
    Pending,
    Confirmed,
    Settled,
    Refunded,
    Expired,
    Rejected
}

struct Payment {
    bytes32 paymentId;
    bytes32 orderId;
    address agent;
    uint64 merchantId;
    uint256 amount;
    uint64 createdAt;
    uint64 expiresAt;
    uint64 windowId;
    PaymentStatus status;
}

struct WindowState {
    uint256 agentOnlyThreshold;
    uint256 hardCap;
    uint256 pendingGross;
    uint256 settledGross;
    uint256 masterConfirmedAmount;
}
```

---

# 18. Spend accumulation rule

The hard boundary must be enforced on-chain.

For every new payment:

```text
newGross = window.pendingGross + window.settledGross + amount
```

If:

```text
newGross <= agentOnlyThreshold
```

then the agent may create the payment without master approval.

If:

```text
newGross > agentOnlyThreshold
```

then either:

```text
- payment must be included in a master-approved batch; or
- escrow is allowed as pending but settlement is blocked until master confirmation.
```

Recommended model:

```text
Agents may create pending escrow up to a pending cap.
Settlement above threshold requires master batch confirmation.
```

This provides better UX while still preventing final settlement without master approval.

---

# 19. Pending escrow model

Preferred flow:

```text
1. Agent calls escrowMicropayment.
2. Gateway validates agent, merchant, amount, order, policy.
3. Gateway transfers exact USDC from agent/funding wallet into escrow.
4. Gateway records payment as Pending.
5. If accumulated spend is below threshold, payment may be auto-confirmed.
6. If accumulated spend exceeds threshold, payment remains Pending.
7. Master confirms batch within 24 hours.
8. Confirmed payments may settle to merchants.
9. Expired unconfirmed payments may be refunded.
```

---

# 20. Required gateway functions

## 20.1 Escrow micropayment

```solidity
function escrowMicropayment(
    bytes32 orderId,
    uint64 merchantId,
    uint256 amount,
    uint64 deadline,
    address refundAddress,
    bytes calldata merchantAuthorization
) external returns (bytes32 paymentId);
```

`refundAddress` is the destination for §20.4 refunds. It is bound at
escrow time and never inferred from `msg.sender`, since `msg.sender` is
the agent key, not the funding source.

`merchantAuthorization` is an EIP-712 signature by the registered
merchant key over `(chainid, gateway, orderId, merchantId, amount,
deadline)`. It is required iff `merchant.requiresSignedOrders == true`
in merchant policy; otherwise it must be empty. This binds the order to
a real merchant-side intent and prevents a compromised agent from
inventing orders for legitimate merchants.

Requirements:

```text
- msg.sender must be active authorized agent.
- agent authorization must not be expired.
- gateway must not be paused.
- merchant must be active.
- amount > 0.
- amount <= agent.maxPerPayment.
- amount <= merchant.maxPerPayment.
- deadline >= block.timestamp.
- deadline <= block.timestamp + maxDeadlineWindow.
- orderId must be unique or idempotent.
- paymentId must not already exist.
- canonical USDC only.
- transferFrom must move exact amount.
- payment enters Pending or Confirmed depending on threshold state.
- accumulated spend state must update atomically.
```

## 20.2 Confirm batch

```solidity
function confirmBatch(
    uint64 windowId,
    bytes32 paymentRoot,
    uint256 totalAmount,
    uint256 paymentCount,
    uint64 expiresAt,
    bytes calldata masterSignature
) external;
```

The master approval must bind to:

```text
chain ID
gateway address
contract version
window ID
payment root
total amount
payment count
expiry
policy version
nonce
```

The contract must reject:

```text
expired confirmations
replayed confirmations
wrong chain/domain
wrong gateway
wrong policy version
invalid master signature
batch amount above hard cap
```

## 20.3 Settle payment

```solidity
function settlePayment(
    bytes32 paymentId,
    bytes32[] calldata merkleProof
) external;
```

Requirements:

```text
- payment exists.
- payment is Pending or Confirmed.
- merchant is active, or settlement rules define behavior if merchant is disabled.
- if threshold requires master confirmation, payment must be included in confirmed batch root.
- payment not expired unless expiry rules still allow settlement.
- status moves to Settled before external transfer.
- USDC transfers to merchant payout.
```

## 20.4 Refund expired payment

```solidity
function refundExpired(bytes32 paymentId) external;
```

Requirements:

```text
- payment exists.
- payment is Pending.
- payment is expired.
- payment not settled.
- status moves to Refunded before transfer.
- USDC returns to the refundAddress recorded at escrow time.
- refundAddress is the value passed in §20.1 — never msg.sender of the
  escrow tx (that is the agent key, not the funding source) and never an
  RPC- or merchant-supplied address.
```

## 20.5 Agent management

```solidity
function authorizeAgent(
    address agent,
    AgentPolicy calldata policy
) external onlyAdminOrPolicyManager;

function revokeAgent(address agent) external onlyAdminOrEmergency;

function updateAgentPolicy(
    address agent,
    AgentPolicy calldata policy
) external onlyAdminOrPolicyManager;
```

Rules:

```text
- limit increases should be timelocked or multisig-gated.
- limit decreases may be immediate.
- revocation should be immediate.
- expired agents cannot create new payments.
```

## 20.6 Merchant management

```solidity
function addMerchant(
    uint64 merchantId,
    address payout,
    uint256 maxPerPayment
) external onlyMerchantManager;

function disableMerchant(uint64 merchantId) external onlyMerchantManager;

function updateMerchantPayout(
    uint64 merchantId,
    address newPayout
) external onlyMerchantManager;
```

Payout changes should be delayed or require extra approval.

## 20.7 Pause

```solidity
function pause() external onlyPauser;
function unpause() external onlyAdmin;
```

Pause should block:

```text
- new escrow
- settlement, optionally
```

Refunds should generally remain available unless there is a serious accounting issue.

---

# 21. Payment ID construction

Payment ID should be deterministic and collision-resistant:

```solidity
paymentId = keccak256(
    abi.encode(
        block.chainid,
        address(this),
        msg.sender,
        orderId,
        merchantId,
        amount,
        idempotencyKey
    )
);
```

`idempotencyKey` is caller-chosen, 32 bytes, and unique per logical
payment attempt. It is **not** a monotonic nonce — the gateway tracks
account nonces separately at the EVM level. Earlier drafts said
"nonce or idempotency key"; that phrasing is withdrawn because the two
have incompatible collision semantics (monotonic-per-agent vs
caller-chosen-globally-unique).

The contract must prevent duplicate `paymentId`.

Order ID policy:

```text
- if one order can only be paid once, enforce orderId uniqueness;
- if partial payments are allowed, include installment index or payment nonce.
```

---

# 22. Master confirmation model

Master confirmation should approve a batch commitment, not arbitrary execution.

Batch leaf example:

```solidity
leaf = keccak256(
    abi.encode(
        paymentId,
        orderId,
        agent,
        merchantId,
        amount,
        createdAt,
        expiresAt
    )
);
```

Batch domain:

```solidity
batchHash = keccak256(
    abi.encode(
        "CONFIRM_BATCH_V1",
        block.chainid,
        address(this),
        policyVersion,
        windowId,
        paymentRoot,
        totalAmount,
        paymentCount,
        expiresAt,
        batchNonce
    )
);
```

The master signature must be over this exact batch hash or EIP-712 equivalent.

---

# 23. Window and threshold policy

## 23.1 Fixed window

Simplest version:

```solidity
windowId = uint64(block.timestamp / WINDOW_SECONDS);
```

Example:

```text
WINDOW_SECONDS = 86400
```

Pros:

```text
simple
cheap
auditable
```

Cons:

```text
boundary gaming near rollover
```

## 23.2 Bucketed rolling window

More robust version:

```text
24 one-hour buckets
or 96 fifteen-minute buckets
```

This is more complex but reduces boundary gaming.

## 23.3 Recommended v1

Use fixed 24-hour windows for v1, with conservative thresholds.

Add clear documentation:

```text
Threshold applies per fixed UTC-style on-chain epoch, not arbitrary rolling 24-hour period.
```

---

# 24. Refund and threshold accounting

Refunds should not immediately restore agent spend capacity in the same window.

Recommended rule:

```text
gross spend counts toward threshold until window reset.
refunds return funds but do not reduce gross threshold usage.
```

This prevents churn attacks.

---

# 25. USDC handling

The gateway must:

```text
- hardcode or immutably store canonical USDC address;
- not accept arbitrary token input from agent;
- use safe ERC-20 transfer methods;
- verify actual balance delta after transferFrom;
- reject fee-on-transfer mismatch;
- handle USDC returning false or reverting;
- not assume ETH value is involved.
```

Escrow function must require:

```solidity
msg.value == 0
```

if payable is ever used. Prefer non-payable.

---

# 26. Upgradeability

Preferred:

```text
non-upgradeable gateway for v1
```

If upgradeability is required:

```text
- proxy admin must be multisig;
- upgrades must be timelocked;
- emergency pause must exist;
- implementation initializer must be disabled;
- storage layout must be tested;
- upgrade events must be emitted;
- client must verify implementation code hash or version.
```

The agent must never have upgrade power.

### 26.1 Code-hash pinning under proxy upgradeability

§5 / §7 / §28 require the client to verify a runtime code hash before
signing. Behind a proxy, `eth_getCode` returns the *proxy* runtime, not
the implementation. To make these requirements compatible:

```text
1. Client config pins:
   - proxy_runtime_hash      (the proxy bytecode — stable across upgrades)
   - implementation_id       (a version tag the gateway exposes via a
                              constant view, e.g. policyVersion or
                              IMPLEMENTATION_HASH())
2. On startup and before every signing decision the client:
   - verifies eth_getCode(proxy) == proxy_runtime_hash
   - reads gateway.implementationHash() and matches it against the
     pinned implementation_id (or the timelock-published successor).
3. During a timelocked upgrade window the client:
   - refuses to sign new escrows;
   - continues to support refundExpired (sender-protective);
   - re-pins implementation_id only after operator-side review of the
     new implementation source + bytecode + audit.
```

The non-upgradeable v1 path remains preferred. The above exists so the
two requirements stop contradicting each other if upgradeability is
ever turned on.

---

# 27. Events

Required events:

```solidity
event AgentAuthorized(address indexed agent, uint64 validUntil);
event AgentRevoked(address indexed agent);
event AgentPolicyUpdated(address indexed agent);

event MerchantAdded(uint64 indexed merchantId, address payout);
event MerchantDisabled(uint64 indexed merchantId);
event MerchantPayoutUpdated(uint64 indexed merchantId, address oldPayout, address newPayout);

event PaymentEscrowed(
    bytes32 indexed paymentId,
    bytes32 indexed orderId,
    address indexed agent,
    uint64 merchantId,
    uint256 amount,
    uint64 windowId,
    uint64 expiresAt
);

event BatchConfirmed(
    uint64 indexed windowId,
    bytes32 indexed paymentRoot,
    uint256 totalAmount,
    uint256 paymentCount
);

event PaymentSettled(bytes32 indexed paymentId, uint64 indexed merchantId, uint256 amount);
event PaymentRefunded(bytes32 indexed paymentId, address refundTo, uint256 amount);
event GatewayPaused(address indexed by);
event GatewayUnpaused(address indexed by);
```

---

# 28. Client startup sequence

On startup, the client must:

```text
1. Load static config.
2. Detect signer backends.
3. Select strongest allowed backend.
4. Derive or fetch agent address.
5. Verify software fallback policy.
6. Connect to at least one RPC.
7. Verify chain ID.
8. Verify gateway runtime code hash.
9. Verify USDC address from gateway, if exposed.
10. Verify agent authorization state.
11. Fetch policy version and thresholds.
12. Reconcile pending local payments with on-chain events.
13. Start serving high-level payment requests.
```

If any required verification fails, the client must refuse to sign.

---

# 29. Client payment flow

```text
1. Agent submits high-level payment request to daemon.
2. Daemon validates schema.
3. Daemon canonicalizes amount into USDC atoms.
4. Daemon checks merchant/order data.
5. Daemon fetches current gateway policy.
6. Daemon preflights transaction.
7. Daemon asks signer backend to sign exact gateway call.
8. Daemon broadcasts transaction.
9. Daemon waits for receipt.
10. Daemon records paymentId and status.
11. Monitor updates status from gateway events.
```

The daemon must never accept a request containing arbitrary calldata.

---

# 30. Master confirmation flow

```text
1. Monitor detects pending payments requiring master confirmation.
2. System builds batch summary.
3. Human/master review UI shows decoded contents:
   - total amount
   - payment count
   - merchant totals
   - new merchants
   - largest payments
   - duplicates
   - risk flags
   - batch root
   - chain ID
   - gateway address
4. Master signs batch hash using separate key.
5. Confirmation transaction is submitted.
6. Gateway verifies signature and records batch root.
7. Settlements can proceed incrementally.
```

The daemon may submit the confirmation transaction but must not hold the master key.

---

# 31. Secure enclave/HSM detection behavior

## 31.1 Startup policy

If config says:

```toml
allow_software_fallback = false
```

then the client must exit if no hardware/device-bound backend is available.

If config says:

```toml
allow_software_fallback = true
```

then client may start but must emit:

```text
HIGH SEVERITY: software signing fallback active
```

## 31.2 Backend selection

Selection algorithm:

```text
1. Enumerate configured preferred backends.
2. Probe each backend.
3. Verify compatible key exists or can be created.
4. Verify public address matches authorized agent or enroll mode is enabled.
5. Reject exportable or non-device-bound backend unless explicitly allowed.
6. Select first backend satisfying policy.
```

## 31.3 Enroll mode

Enroll mode should be separate from normal mode.

```text
paymentd enroll-agent
```

This command may:

```text
- create hardware-backed key;
- display public address;
- produce enrollment report;
- require admin to authorize address on-chain.
```

Normal daemon startup must not silently create new agent keys and use them.

---

# 32. API exposed by daemon

Expose only high-level methods.

Example local HTTP or Unix socket API:

```text
POST /v1/payments/escrow
GET  /v1/payments/{paymentId}
GET  /v1/status
GET  /v1/signer/capabilities
```

Do not expose:

```text
POST /sign
POST /sendRawTransaction
POST /eth_sign
POST /signTypedData
POST /wallet/export
```

Prefer Unix domain socket over TCP.

If TCP is required:

```text
- bind localhost only;
- require mTLS or signed requests;
- rate limit;
- audit all calls.
```

---

# 33. Failure behavior

The system must fail closed.

## 33.1 Client fail-closed cases

Reject signing if:

```text
- signer backend changes unexpectedly;
- software fallback is active but disallowed;
- chain ID mismatch;
- gateway code hash mismatch;
- RPCs disagree materially;
- agent revoked or expired;
- policy version unknown;
- amount exceeds local maximum;
- order ID already seen locally and on-chain status uncertain;
- nonce state uncertain and cannot be reconciled;
- Secure Enclave/HSM unavailable after startup.
```

## 33.2 Contract fail-closed cases

Revert if:

```text
- unauthorized agent;
- expired agent;
- paused gateway;
- inactive merchant;
- duplicate payment/order ID;
- amount exceeds policy;
- threshold exceeded without required confirmation, if using escrow-time enforcement;
- settlement attempted without required batch confirmation;
- expired payment settlement attempted after expiry, if not allowed;
- refund attempted after settlement;
- transferFrom did not move exact USDC amount.
```

---

# 34. Testing requirements

## 34.1 Rust client tests

```text
- signer backend selection;
- no generic signing reachable;
- chain ID mismatch rejection;
- gateway hash mismatch rejection;
- wrong function selector rejection;
- wrong token rejection;
- amount decimal conversion;
- idempotency key reuse;
- RPC disagreement handling;
- local DB rollback recovery;
- duplicate order handling;
- HSM unavailable behavior;
- software fallback disabled behavior.
```

## 34.2 Smart contract tests

```text
- unauthorized agent cannot escrow;
- revoked agent cannot escrow;
- expired agent cannot escrow;
- duplicate order rejected;
- duplicate payment rejected;
- threshold boundary exact behavior;
- cross-agent accumulation;
- race-like sequential transactions around threshold;
- master confirmation required above threshold;
- invalid master signature rejected;
- replayed master signature rejected;
- wrong chain/domain signature rejected;
- expired batch rejected;
- expired payment refundable;
- settled payment not refundable;
- refunded payment not settleable;
- merchant disabled behavior;
- USDC transfer failure behavior;
- pause behavior;
- upgrade restrictions, if upgradeable.
```

## 34.3 Fuzz/invariant tests

Important invariants:

```text
contract USDC balance == sum pending escrowed payments
no payment can be both settled and refunded
gross window spend never exceeds hard cap
agent-only settlement never exceeds threshold
revoked agents cannot create new payments
duplicate order/payment IDs cannot create extra claim
settlement amount equals escrow amount
master confirmation cannot approve wrong root/domain
```

---

# 35. Deployment checklist

Before production:

```text
- gateway audited;
- contract source verified;
- runtime bytecode hash pinned in client config;
- canonical USDC address verified;
- admin role assigned to multisig;
- master role assigned to separate multisig/hardware key;
- agent role assigned only to daemon key;
- pauser role assigned;
- threshold values initialized;
- software fallback disabled;
- monitoring deployed;
- alerting on every batch confirmation;
- alerting on threshold crossing;
- alerting on agent revocation/authorization;
- dry-run transaction executed;
- emergency pause tested;
- agent revocation tested;
- refund expiry tested.
```

---

# 36. Recommended v1 security posture

For v1, keep the system deliberately narrow:

```text
- one chain;
- one gateway;
- one canonical USDC;
- one escrow function;
- one refund function;
- one batch confirmation function;
- no arbitrary execution;
- no generic wallet API;
- no upgradeability unless absolutely required;
- no master/admin key on daemon host;
- no software fallback in production.
```

The client should be a constrained signer and gateway caller, not a wallet.

The contract should be a constrained escrow and settlement gateway, not a programmable execution layer.

The strongest security boundary is:

```text
client may propose;
hardware-backed agent key may sign only narrow gateway calls;
gateway enforces global policy;
master confirms accumulated spend above threshold;
admin governance remains offline/multisig-controlled.
```

---

# 37. Agentic Deposits: Dead-Man's-Switch / Auto-Reversion Policy

A timelocked clawback layered onto a smart-account signing model: incoming funds remain "pending" until the human (binding) key confirms; if no confirmation within 7 days, anyone can trigger a return to the original sender. Hard-coded destination — funds cannot be moved forward or elsewhere.

## 37.1 Context

Builds on a two-key smart-account design:

- **B (binding/human key)** — held off-box on a hardware token. Used for enrollment, policy changes, and confirming deposits.
- **H (hot key)** — held by an OWS-style signing daemon on the operator's machine. Signs day-to-day transactions within an on-chain policy.
- **Smart account** — ERC-4337 (or Safe with a custom validation module). Policy lives on-chain; H's `validateUserOp` enforces caps, allowlists, and now the confirmed/pending split.

The dead-man's-switch adds a third tier: **anyone** can trigger reversion of unconfirmed deposits after the timeout. Mechanical safety net, no trusted party.

## 37.2 The shape

The smart account tracks, per inbound deposit:

- `from` — the sender
- `amount` (or token + tokenId for ERC-20/721)
- `arrivalTime`
- `status` — pending | confirmed | reverted

Two state transitions:

- **Confirm**: B signs an EIP-712 confirmation message → funds move to `confirmedBalance` and become spendable by H under normal policy.
- **Auto-revert**: after 7 days with no confirmation, *anyone* can call `revert(depositId)` → contract sends funds back to `from`. No other destination is reachable from this code path.

H **cannot** spend unconfirmed deposits. The on-chain `validateUserOp` rejects any UserOp whose effect would touch funds still in the pending bucket.

## 37.3 Why this is genuinely good

- **Wrong-recipient mistakes are recoverable.** Sender always gets a 7-day window.
- **Compromise of H is bounded in time** — the attacker can only drain *confirmed* balance. New incoming funds auto-return.
- **No trusted third party.** The clawback is mechanical; anyone can trigger it after the deadline.
- **Hard-coded destination** removes the obvious attack: an attacker who controls H *cannot* redirect the revert to themselves, because the contract only knows one address (`from`).

## 37.4 The sharp edges

### 37.4.1 Per-deposit accounting is non-trivial

Native ETH and ERC-20s are fungible. If 5 ETH arrives from Alice and 3 ETH from Bob, the contract has to track two buckets and refuse to let H spend more than `confirmedBalance`.

- **Native ETH deposits via plain `send`** give you `msg.sender` in `receive()` — fine.
- **ERC-20 plain transfers**: the recipient contract gets *no callback*. You can't track `from` automatically. You either require senders to use `transferFrom` via a `deposit()` function, or you do periodic reconciliation against `Transfer` events (off-chain bot proposes, contract verifies via storage proofs — heavy).

This is the single biggest implementation gotcha. Most "smart account with deposit tracking" designs end up requiring a wrapper deposit function, which means the UX is "send to this address via *our* helper," not "send to this address however you like."

### 37.4.2 "Original sender" can itself be a contract

If Alice sent from a CEX hot wallet, the revert goes back to the CEX hot wallet, not Alice's account inside the CEX. She may never see it again. Mitigations:

- Require senders to register an explicit `refundAddress` at deposit time.
- Reject deposits from contracts (allowlist EOAs) — but that breaks 4337 senders, which are contracts. So really you need an explicit refund-address field.

### 37.4.3 Confirmation UX

B has to sign a confirmation per deposit (or batch). If B is hardware and offline most of the time, that's friction. Reasonable middle ground: B pre-authorizes a list of allowlisted senders whose deposits auto-confirm, while unknown senders go through the 7-day path.

### 37.4.4 Gas to revert

Someone has to pay gas to call `revert(depositId)`. In practice this means you run a small bot, or you accept that small deposits below the gas-cost threshold won't be auto-reverted (they'll just sit in pending forever, untouchable by H). A keeper-network pattern (Gelato, Chainlink Automation) solves this for a fee.

### 37.4.5 Reorgs and finality

`arrivalTime` should be measured from a finalized block, not the inclusion block, or a deep reorg could erase the deposit while the timer was running. On L2s with fast finality this matters less; on L1 use ~12-block confirmations before starting the timer.

### 37.4.6 Interaction with policy caps

The earlier on-chain policy had `dailyCap`, `allowedTargets`, etc. The clawback rule layers on top: H's spendable balance = `confirmedBalance − today's_outflow`. Pending balance is invisible to H regardless of caps.

## 37.5 Concrete contract sketch

```solidity
struct Deposit {
    address from;
    address token;        // 0x0 for ETH
    uint256 amount;
    uint64 arrivalTime;
    uint8 status;         // 0=pending, 1=confirmed, 2=reverted
}

mapping(uint256 => Deposit) deposits;
uint256 public confirmedEthBalance;
uint256 public constant REVERT_DELAY = 7 days;

receive() external payable {
    deposits[++nextId] = Deposit(msg.sender, address(0), msg.value,
                                 uint64(block.timestamp), 0);
    emit Deposited(nextId, msg.sender, msg.value);
}

function confirm(uint256 id, bytes calldata bSig) external {
    require(_verifyB(id, bSig));               // EIP-712 sig from binding key
    Deposit storage d = deposits[id];
    require(d.status == 0);
    d.status = 1;
    confirmedEthBalance += d.amount;
}

function revertDeposit(uint256 id) external {
    Deposit storage d = deposits[id];
    require(d.status == 0);
    require(block.timestamp >= d.arrivalTime + REVERT_DELAY);
    d.status = 2;
    (bool ok, ) = d.from.call{value: d.amount}("");
    require(ok);
    emit Reverted(id, d.from, d.amount);
}

// In validateUserOp / execute path:
function _checkSpendable(uint256 amount) internal view {
    require(amount <= confirmedEthBalance - todayOutflow);
}
```

ERC-20 needs a `deposit(token, amount, from, refundAddr)` entrypoint that pulls via `transferFrom` — there's no clean alternative without indexing events.

---

# 38. Attack catalog and mitigations

This section enumerates the realistic attacks against an agentic payment
system of the shape specified in §1–§36, and states which design element
contains each. It is the threat-model companion to §1.

For each attack: **A** is what the adversary tries; **W** is why the
naive design is vulnerable; **M** is the mitigation in this design,
with section reference; **R** is the residual risk that remains.

## 38.1 Adversaries

```text
LLM-PI    — prompt-injection attacker controlling untrusted text the
            LLM consumes (web pages, merchant descriptions, emails).
MERC      — malicious or compromised merchant.
AGENT-K   — attacker who has stolen the agent key (HSM bypass, side
            channel, insider, exfiltrated software fallback).
DAEMON    — attacker with root on the daemon host but not the signer
            backend.
RPC       — malicious or MITM'd RPC provider.
NET       — passive/active network attacker between daemon and RPC.
CHAIN-MEV — MEV bot with reorder/sandwich capability.
ADMIN-K   — compromised admin key (single signer of a multisig, not
            the full quorum).
MASTER-K  — compromised master key (single signer of a multisig).
USER      — naive user typing into the LLM.
SUPPLY    — supply-chain attacker against daemon dependencies.
USDC-ISS  — USDC issuer (Circle) freeze / blocklist action.
```

## 38.2 Attack catalog

### 38.2.1 Prompt-injection drains funds

**A** — LLM-PI plants instructions in a web page that cause the LLM to
emit a payment intent to an attacker-controlled merchant.

**W** — Naive agent wallets sign whatever the LLM asks for.

**M** — The LLM cannot sign. It can only submit a structured intent to
the daemon (§29). The daemon will only call `escrowMicropayment` against
a merchant in the on-chain allowlist (§20.1, §20.6). Unknown merchants
cannot receive funds at all. Per-payment, per-window, and accumulated
caps (§17, §18) bound the loss even when the merchant *is* on the
allowlist. Above the threshold, master must confirm (§22, §30).

**R** — Funds can still flow to *legitimate* allowlisted merchants the
LLM was tricked into paying. Mitigation is operator-side: keep the
merchant allowlist small and use signed-order requirements (§20.1
`merchantAuthorization`) for high-value merchants.

### 38.2.2 Stolen agent key, full key extraction

**A** — AGENT-K extracts the agent private key.

**W** — A wallet-style signer would let the attacker move arbitrary
value to arbitrary destinations.

**M** — Hardware-backed signer with non-exportable key (§9.1, §10.1,
§10.2, §10.4) makes extraction infeasible for the strongest backends.
Software fallback is opt-in and logs HIGH severity (§10.5, §31.1). Even
with the key, the attacker can only call gateway selectors (§4, §11),
only against allowlisted merchants (§20.1), only within
agent/merchant/window caps (§17, §18), and cannot settle above
threshold without master (§22).

**R** — Loss bounded by `min(agent.maxPerPayment × open-merchant-count,
window.agentOnlyThreshold − used)` per window. This is the *designed*
maximum-loss budget. If it is unacceptably large, lower the agent-only
threshold.

### 38.2.3 Compromised daemon host (root, no key extraction)

**A** — DAEMON has root on the box but the signer is hardware-bound and
won't release the key.

**W** — Without further mitigation the attacker can drive the signer to
sign arbitrary requests.

**M** — The signer interface exposes only `sign_gateway_tx` over a
narrow request enum (§8). There is no `sign_hash` / `sign_message` /
`sign_typed_data` / `sign_transaction` reachable from the daemon API
(§8.1, §32). The signer enforces selector and structure (§8.2, §11).
Audit log is append-only and shipped off-host (§14). Result: the
attacker is reduced to AGENT-K under the §38.2.2 caps.

**R** — Same residual as §38.2.2. Plus: the attacker can *delay* or
*drop* legitimate payments and corrupt the local DB. Mitigation:
gateway is the source of truth (§13), local state is advisory.

### 38.2.4 Replay of a signed escrow tx

**A** — DAEMON or NET captures a signed `escrowMicropayment` tx and
re-broadcasts it.

**W** — Without idempotency, the same payment could be charged twice.

**M** — `paymentId` is deterministic over `(chainid, gateway, agent,
orderId, merchantId, amount, idempotencyKey)` (§21). The gateway
rejects duplicate `paymentId`. EVM nonce semantics also prevent
re-broadcast of the literal signed tx.

**R** — None at the contract layer for exact replay. Cross-chain
replay is prevented by `chainid` inclusion in `paymentId` and in the
master batch domain (§22).

### 38.2.5 Cross-chain master-signature replay

**A** — MASTER-K (or a leak) reuses a master signature on a forked
chain or a sibling deployment.

**W** — A signature over `(windowId, paymentRoot, totalAmount, …)`
without a domain is portable.

**M** — The batch-hash domain binds `chainid`, `address(this)`,
`policyVersion`, and `batchNonce` (§22). The contract rejects wrong
chain/domain/version and replayed `batchNonce` (§20.2, §33.2).

**R** — Negligible if EIP-712 domain construction is implemented
correctly. Tested explicitly in §34.2.

### 38.2.6 Threshold gaming via window boundaries

**A** — AGENT-K times payments to straddle a window boundary, doubling
effective agent-only spend in a short period.

**W** — Fixed windows allow burst at rollover.

**M** — Acknowledged in §23.1 as a known weakness of fixed windows.
Mitigations available: (a) lower `agentOnlyThreshold` so a 2× burst is
still tolerable; (b) upgrade to bucketed rolling windows (§23.2). The
recommended v1 (§23.3) accepts the tradeoff and pairs it with
conservative thresholds.

**R** — One window of agent-only burst around the boundary. Operators
must size thresholds to this fact, not assume rolling-window
semantics.

### 38.2.7 Refund-redirect via spoofed source address

**A** — DAEMON or AGENT-K specifies a `refundAddress` they control at
escrow time. Later they trigger expiry to claw funds back to themselves
instead of the funding source.

**W** — Any field the daemon controls is attacker-controllable under
host compromise.

**M** — `refundAddress` is bound at escrow (§20.4) and is *not* a
mitigation against AGENT-K — it is a mitigation against the *separate*
risk of inferring refund destination from `msg.sender` (which is the
agent key, not the funder). The actual mitigation against AGENT-K
choosing a hostile refund address is the *funder-side* requirement that
the funding wallet only `approve()` the gateway for amounts it is
prepared to lose to the agent's caps. Funders are warned in §1.4 that
the agent-key compromise budget is the per-window cap.

**R** — A compromised agent can route refunds to themselves, which is
indistinguishable from spending the per-window cap. Bounded by
threshold.

### 38.2.8 Malicious or compromised merchant

**A** — MERC accepts USDC and does not deliver, or delivers and then
attempts to claim again.

**W** — On-chain logic cannot prove off-chain delivery.

**M** — Per-merchant caps (§17 `Merchant.maxPerPayment`), merchant
disable (§20.6), merchant payout-address change is delayed
(§20.6 closing note), and `orderId` uniqueness (§21) prevent
double-claim on the same order. Settlement is gated on Pending or
Confirmed status (§20.3). Threshold-crossing payments require master
review (§30) which surfaces "new merchants" and "largest payments"
explicitly.

**R** — Non-delivery is fundamentally off-chain and not solved by this
design. It is bounded by `merchant.maxPerPayment` and by master review
above threshold.

### 38.2.9 Forged merchant authorization (when required)

**A** — AGENT-K invents an order against a merchant that requires
signed orders (`merchant.requiresSignedOrders == true`).

**W** — Without merchant binding, agent can pay any allowlisted
merchant any amount.

**M** — `merchantAuthorization` (§20.1) is an EIP-712 signature by the
registered merchant key over `(chainid, gateway, orderId, merchantId,
amount, deadline)`. The gateway verifies it iff the merchant flag is
set. Forgery requires the merchant key, raising the bar substantially
for high-value merchants.

**R** — Merchants without the flag remain protected only by caps and
the allowlist.

### 38.2.10 Unauthorized upgrade

**A** — ADMIN-K attempts to upgrade the implementation.

**W** — Single-key admin = arbitrary code execution.

**M** — Admin is multisig (§16, §35) and upgrades are timelocked
(§26). Client refuses signing during the timelock window and re-pins
implementation hash post-upgrade (§26.1). The agent never has
upgrade power (§16, §26).

**R** — Full multisig quorum compromise can still upgrade after the
timelock. Operators monitor `Upgraded` events (§35) and the timelock
queue; any unexpected queued upgrade is an emergency-pause trigger.

### 38.2.11 Master-key abuse

**A** — MASTER-K signs a batch including payments the agent did not
escrow, or with inflated `totalAmount`.

**W** — A naive design might let master arbitrarily mint settlements.

**M** — Master cannot create payments — settlement requires the
payment to already exist as Pending and to be included in the
confirmed Merkle root (§20.3). The most a master can do is *approve*
already-escrowed payments. A compromised master can collude with
AGENT-K to push settlement above threshold, bounded by `hardCap` per
window (§17). The hard cap is a separate, lower-mutability parameter.

**R** — Collusion of master + agent compromises up to `hardCap`. Hard
cap is set conservatively; raising it requires admin + timelock.

### 38.2.12 Pause-trap / DoS via admin

**A** — ADMIN-K pauses the gateway permanently to lock funds.

**W** — Pause without an escape valve is a DoS.

**M** — Pause blocks new escrow and settlement but **refunds remain
available** (§20.7) so funders can recover after expiry. Unpause is
gated to admin (§20.7); admin is multisig+timelock (§16).

**R** — Settlements queued above threshold can be stalled until admin
quorum acts. Funders can always refund after expiry (§20.4).

### 38.2.13 Malicious RPC

**A** — RPC returns false code hash, false agent state, false
balances, or stale block.

**W** — Client trusting a single RPC inherits its lies.

**M** — Multi-RPC cross-check on chain ID, code hash, agent
authorization, payment status, nonce, gas (§12). On disagreement, fail
closed (§12, §33.1). Client also pins the proxy runtime hash and
implementation hash locally (§26.1) so RPC cannot lie about code.

**R** — A coordinated lie across all configured RPCs would defeat
this. Operators should pick independent providers (different orgs,
different ASNs).

### 38.2.14 Network MITM

**A** — NET tampers with RPC traffic.

**W** — Plaintext RPC = full tamper.

**M** — All RPC traffic is HTTPS with certificate validation
(implicit; should be made explicit in §12). Multi-RPC comparison
detects single-path tampering. Daemon API uses Unix sockets or
mTLS (§32).

**R** — Active MITM with a co-opted CA can still spoof; mitigated by
multi-RPC comparison. Recommend pinning RPC TLS certs in config.

### 38.2.15 MEV / sandwich on settlement

**A** — CHAIN-MEV reorders or sandwiches `settlePayment`.

**W** — USDC transfers don't have price impact, so classical sandwich
doesn't apply. But settlement-then-refund races could be gamed.

**M** — Settlement and refund are status-gated (§20.3, §20.4): a
payment cannot be both. State transitions are atomic. There is no
slippage and no AMM dependency. `block.timestamp` boundaries are coarse
(`WINDOW_SECONDS = 86400`) and not gameable at MEV resolution.

**R** — Negligible. Ordering of settlement vs refund near the deadline
is the only edge, and the contract picks deterministically based on
timestamp.

### 38.2.16 USDC issuer freeze

**A** — USDC-ISS blocklists the gateway address.

**W** — All escrow becomes unspendable.

**M** — Out of scope by design (§2 explicitly does not eliminate
issuer risk). Pause + refund path (§20.7, §20.4) returns funds before
freeze takes effect for any expired payment. Operators monitor Circle
blocklist signals and may pause preemptively.

**R** — Funds escrowed at the moment of freeze are stuck pending
issuer action. This is a fundamental USDC property.

### 38.2.17 Supply-chain attack on daemon

**A** — SUPPLY publishes a malicious version of a daemon dependency
(serde, http client, etc.) that exfiltrates the agent key or signs
extra requests.

**W** — Modern Rust dep trees can be deep.

**M** — Minimal-dependency policy (§6.1). Hardware-backed signer means
key exfiltration is infeasible from compromised software (§9, §10).
Hand-rolled or minimal ABI encoding (§6.1) reduces surface. Audit log
shipped off-host (§14) detects extra signing requests after the fact.

**R** — A malicious dep can still cause the daemon to *request* up to
the per-window cap of legitimate-looking signings. Bounded by §38.2.2.

### 38.2.18 Local DB tamper / rollback

**A** — DAEMON-with-disk-access wipes the local payment DB to replay
old orders.

**W** — DBs are not authoritative.

**M** — Gateway-side `paymentId` and `orderId` uniqueness (§21).
Idempotency reconciliation against on-chain events on startup
(§28 step 12). Local state explicitly advisory (§13).

**R** — None for replay. Local DB tamper can cause UX confusion until
reconciliation completes; cannot cause double-spend.

### 38.2.19 Daemon API exploitation

**A** — Local attacker (or a compromised neighbor process) hits the
daemon's HTTP/socket API.

**W** — A wide API exposes generic signing.

**M** — API is narrow (§32) — escrow / status / capabilities only.
No `sign`, `sendRawTransaction`, `eth_sign`, `signTypedData`,
`wallet/export`. Default transport is Unix socket. TCP requires mTLS
and rate limiting.

**R** — A local attacker who can hit the socket can still drive
escrow up to per-window caps. Bounded by §38.2.2.

### 38.2.20 Denial-of-service via merchant churn

**A** — MERC or AGENT-K registers, then the merchant turns malicious
and the operator has to disable; meanwhile pending escrows queue up.

**W** — Pending state could grow unboundedly.

**M** — `agent.maxPending` cap (§17) bounds outstanding pending per
agent. Merchant disable does not orphan pending — refunds remain
reachable (§20.7 closing note). Window hard cap (§17 `hardCap`) bounds
total exposure.

**R** — One window of bounded exposure during the disable + expiry
cycle. Refunds reclaim it.

### 38.2.21 Reorg between escrow and settlement

**A** — A deep chain reorg unwinds the escrow tx but leaves the
master batch confirmation in place.

**W** — Confirmation referencing a payment that no longer exists is
either a no-op or, worse, a settlement of a phantom payment.

**M** — `settlePayment` requires `payment exists` (§20.3) — i.e., a
storage slot, not a memory of one. A reorg that removes the escrow
also removes the storage write. Re-execution of the master
confirmation against a re-mined chain is fine because batch nonces are
single-use (§22).

**R** — On chains with weak finality, a reorg can briefly desync
client local state from chain state. Reconciliation (§28 step 12)
fixes it.

### 38.2.22 User confusion / phishing

**A** — USER is socially engineered (or LLM-PI'd) into approving a
larger funding allowance to the gateway than they intended.

**W** — `approve(MAX_UINT)` is a common foot-gun.

**M** — This design's threat boundary is `funder approves gateway up
to amount X` ⇒ `agent + master cannot spend more than X`. The funder
is responsible for sizing X. The §1.4 contract is explicit: max loss
under agent compromise is the unsettled approval × per-window cap.
Documentation should warn against `MAX_UINT` approvals.

**R** — Outside the contract's authority. Funder-side UX problem.

## 38.3 Attacks explicitly out of scope

```text
- Off-chain merchant non-delivery (§38.2.8 R).
- USDC issuer freeze beyond pause+refund (§38.2.16 R).
- Full multisig quorum compromise of admin or master (§38.2.10 R,
  §38.2.11 R) — mitigated operationally, not in code.
- Funder approving more than they intend to risk (§38.2.22 R).
- Endpoint-device compromise of the master signer's review UI — the
  master signer is assumed to validate decoded batch contents on a
  trusted display (§30).
```

## 38.4 Attack-to-defense matrix (summary)

| # | Attack | Primary defense | Residual budget |
|---|---|---|---|
| 1 | Prompt injection | Merchant allowlist + per-window cap | Caps to allowlisted merchants |
| 2 | Agent key extraction | Hardware-bound signer | `min(maxPerPayment × N, agentOnlyThreshold)` per window |
| 3 | Daemon root | Narrow signer trait + selector enforcement | Same as #2 |
| 4 | Tx replay | `paymentId` uniqueness + EVM nonce | None |
| 5 | Cross-chain master replay | Domain-bound batch hash | None |
| 6 | Window boundary gaming | Conservative thresholds | One-window 2× burst |
| 7 | Refund redirect | Approval sizing on funder side | Bounded by per-window cap |
| 8 | Merchant non-delivery | Per-merchant cap + master review | Off-chain risk |
| 9 | Forged merchant order | EIP-712 merchant signature (when required) | Caps + allowlist |
| 10 | Admin-key upgrade | Multisig + timelock + client re-pin | Quorum compromise |
| 11 | Master-key abuse | Hard cap + Merkle root binding | `hardCap` × collusion |
| 12 | Pause trap | Refunds remain unpaused | Stuck settlements only |
| 13 | Malicious RPC | Multi-RPC + local code-hash pin | Coordinated provider lie |
| 14 | Network MITM | TLS + multi-RPC compare | CA compromise |
| 15 | MEV / sandwich | No AMM dependency, atomic state | None |
| 16 | USDC freeze | Out of scope; pause+refund eases impact | Issuer-controlled |
| 17 | Supply chain | Minimal deps + hardware signer | Bounded by #2 |
| 18 | Local DB tamper | Gateway is source of truth | None |
| 19 | Daemon API abuse | Narrow API + Unix socket / mTLS | Bounded by #2 |
| 20 | Pending DoS | `maxPending` + window `hardCap` | One window |
| 21 | Reorg desync | `payment exists` storage check | Local UX confusion |
| 22 | User phishing | Funder approval sizing | Out of scope |

## 37.6 Capability hierarchy

A coherent three-tier authority model:

- **B (binding/human key, off-box)** — enrolls H, sets policy, confirms deposits, can rotate everything.
- **H (hot key, OWS daemon)** — spends *confirmed* balance within policy.
- **Anyone** — can trigger reverts after timeout (mechanical safety net).

This composes well with the existing policy primitives — caps, allowlists, epoch-based rotation — and gives the property we want: **a stolen H drains less, because new incoming value is on a leash held by B.**

## 37.7 Recommendation

Worth building if the usage pattern is "deposits arrive periodically, human reviews, agent operates against confirmed balance." Poor fit if it's "constant high-frequency funding flow" because the confirmation step becomes a bottleneck.

Build order:

1. ETH-only deposit tracking + revert (simplest, covers the demo).
2. Confirmation flow with EIP-712 + B's signature.
3. Allowlist of auto-confirming senders (cuts friction).
4. ERC-20 deposit entrypoint with explicit `refundAddress`.
5. Keeper integration for auto-revert.
