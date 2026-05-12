# Architecture — Autonomous-Agent Access to Robot Money

> **Status.** Robot Money remains the ERC-4626 yield vault in
> `contracts/RobotMoneyVault.sol` plus its adapters. This document
> specifies the autonomous-agent access layer around that product: a
> constrained Rust client (`rmpc`) and an on-chain policy gateway that
> permits safe agent-initiated deposits into the vault.
>
> The Rust client is the replacement direction for relevant TypeScript
> CLI features. The first implementation is narrower than full CLI
> parity: it covers guarded deposits, direct chain reads, and the agent
> safety boundary. Reads, withdraw/redeem, basket routing, simulation,
> wallet UX, and mainnet configuration are phased in
> `docs/implementation-plan.md`.

## 1. Product Boundary

Robot Money product:

```text
ERC-4626 vault + adapters + share accounting + public product state.
```

Autonomous-agent access layer:

```text
Rust client + signer backend + policy gateway + agent skill/runtime integration.
```

The access layer is not a new vault and does not change the vault's
adapter strategy. It gives autonomous agents a constrained way to move
USDC into the vault while preserving the human/operator control plane.

## 2. Goal

Enable an autonomous agent to deposit USDC into Robot Money without
giving the agent a general wallet.

The required safety property:

```text
An agent key can only execute known gateway calldata, on a configured
chain, against configured contracts, within on-chain policy caps.
```

The system must remain bounded if:

- the LLM or task planner is prompt-injected;
- the Rust client host is compromised;
- the local state directory is deleted or rolled back;
- one agent key is exposed;
- an RPC endpoint is stale or malicious;
- multiple agent tasks race each other.

## 3. Actors

- **Agent planner** — untrusted high-level task logic. It can request a
  deposit or read state, but it cannot sign.
- **Rust client (`rmpc`)** — partially trusted process. It validates
  intent, reads chain state, builds known calldata, asks the signer for
  a signature, broadcasts, and reports JSON.
- **Agent key** — on-chain key with `AGENT_ROLE` on the gateway. It is
  held by the configured signer backend and must not hold admin or
  pause authority.
- **Signer backend** — HSM, Secure Enclave, TPM, KMS, or encrypted
  software key. Production preference is non-exportable hardware or KMS
  material; software is an explicit fallback for development and
  low-value deployments.
- **Depositor (agent owner) wallet** — the EOA, multisig, or hardware
  wallet that authorizes an agent under its own signature, sets per-agent
  spending bounds and share receiver, and revokes or repolicies that
  agent at any time. Each depositor is the sole authority over her own
  agent; no third party — including the Robot Money team — gates these
  calls. The Robot Money team's only on-chain authority is contract
  upgrade plus protocol-wide kill switches (pause counterweight,
  `unpause`).
- **Share receiver** — address that receives vault shares from the
  gateway deposit. It is part of the per-agent policy the depositor
  registers under her own wallet, not chosen by the agent at call time.

## 4. High-Level Flow

```text
Agent planner
  -> rmpc request: "deposit amount X with order id Y"
  -> rmpc validates config, chain, code hash, role, caps, balance, allowance
  -> signer signs only the known gateway deposit envelope
  -> gateway pulls USDC from the agent
  -> gateway calls vault.deposit(amount, shareReceiver)
  -> vault shares land at the configured receiver
  -> rmpc emits JSON and writes audit records
```

The agent never receives a generic transaction builder. The signer
never exposes `eth_sign`, `personal_sign`, arbitrary EIP-712 signing,
or arbitrary transaction signing through the agent path.

## 5. On-Chain Gateway

The gateway is a small wrapper around `vault.deposit()`.

Responsibilities:

- authorize agent keys;
- store per-agent policy;
- enforce maximum amount per deposit;
- enforce maximum amount per fixed window;
- enforce deadline bounds;
- enforce idempotency for repeated order attempts;
- pull exact USDC amount from the agent;
- approve the vault only for the current call;
- call `vault.deposit(amount, shareReceiver)`;
- emit events for agent deposits and policy changes;
- support emergency pause.

The gateway must not:

- hold vault shares after the call frame;
- execute arbitrary external calls;
- accept arbitrary token addresses;
- let the agent set its own share receiver;
- let the agent grant roles or change policy;
- let admin and pause authority overlap with agent authority.

Core storage shape:

```solidity
IERC20   public immutable usdcToken;
IERC4626 public immutable vaultContract;

struct AgentPolicy {
    bool active;
    uint64 validUntil;
    uint256 maxPerPayment;
    uint256 maxPerWindow;
    address shareReceiver;
}

mapping(address => AgentPolicy) public agents;
mapping(address => mapping(uint64 => uint256)) public agentWindowGross;
mapping(bytes32 => bool) public usedPaymentIds;
bool private _paused;                                  // exposed via paused()
uint64 public constant WINDOW_SECONDS = 86400;
uint256 public constant MAX_DEADLINE_SKEW = 600;
```

The `usdcToken` / `vaultContract` storage names let the gateway also
expose `usdc()` and `vault()` view functions matching the `IGateway`
interface without colliding with the storage variables.

Deposit function shape:

```solidity
function deposit(
    bytes32 orderId,
    uint256 amount,
    uint64 deadline,
    bytes32 idempotencyKey
) external returns (bytes32 paymentId, uint256 sharesMinted);
```

The returned identifier is named `paymentId` because the gateway's
abstraction is "policy-gated payments out of an agent's USDC balance",
of which deposit is the first verb. The id namespace is reusable for
future verbs (e.g. agent-initiated withdraw) without hardcoding
"deposit".

Deposit behavior:

1. Require gateway is not paused.
2. Require caller has `AGENT_ROLE`.
3. Require agent policy is active and unexpired.
4. Require `amount > 0`.
5. Require `amount <= maxPerPayment`.
6. Require `deadline` is current and within the maximum skew.
7. Compute the current fixed window.
8. Require `agentWindowGross[agent][window] + amount <= maxPerWindow`.
9. Compute deterministic `paymentId` from chain id, gateway, agent,
   order id, amount, and idempotency key.
10. Require `paymentId` has not been used.
11. Pull exact USDC from the agent and verify the balance delta.
12. Approve the vault for exactly this amount.
13. Call `vault.deposit(amount, shareReceiver)`.
14. Clear residual vault allowance.
15. Mark the idempotency record and update window usage.
16. Emit `AgentDeposit`.
17. Assert the gateway does not retain vault shares.

## 6. Roles

Roles are pairwise disjoint and serve distinct, narrow purposes:

- `ADMIN_ROLE` — protocol-wide kill-switch counterweight to `pause`
  held by the Robot Money team (contract upgrader). Authorizes
  `unpause()` only. Does not gate authorization or policy of any
  individual depositor's agent.
- `PAUSER_ROLE` — can pause the gateway quickly during an incident.
- `AGENT_ROLE` — can call only the gateway deposit function. Granted
  to an agent address when its depositor (the agent owner) calls
  `authorizeAgent` under her own wallet, and revoked when she calls
  `revokeAgent`.

Each depositor is the sole authority over her own agent. The
`authorizeAgent`, `setPolicy`, and `revokeAgent` surfaces are
permissionless and gated solely on `msg.sender == agentOwner[agent]`
(or, for first-time authorize, on the agent not yet being owned).
`ADMIN_ROLE` plays no part in any agent's lifecycle.

No account may hold more than one of `{ADMIN_ROLE, PAUSER_ROLE,
AGENT_ROLE}`. This prevents a compromised agent from also unpausing,
and prevents a pauser/admin key from also acting as an agent.

## 7. Rust Client

`rmpc` owns the agent-facing command surface.

Required responsibilities:

- load strict TOML config;
- verify chain id;
- verify configured contract addresses;
- verify gateway runtime code hash;
- load the signer backend;
- refuse software fallback unless explicitly allowed;
- run preflight reads before signing;
- acquire a per-agent local lock;
- check local idempotency cache for repeated order attempts;
- compute EIP-1559 fees under configured caps;
- build only known gateway calldata;
- ask the signer for only the EIP-1559 envelope signature;
- broadcast and wait for receipt;
- decode gateway and vault events;
- emit stable JSON;
- write diagnostic and audit logs.

The client must not:

- expose raw private keys;
- expose generic signing methods;
- support arbitrary destination addresses;
- accept arbitrary calldata from the agent planner;
- change chain or gateway dynamically at planner request;
- hold admin credentials.

## 8. Signer Backends

Backend preference:

1. External HSM with non-exportable secp256k1 key.
2. Cloud KMS/HSM asymmetric key, explicitly configured.
3. Secure Enclave or OS key store where compatible.
4. TPM/vTPM-bound material where meaningful.
5. Encrypted software key, explicitly allowed.

Software fallback is a development and low-value path. It must be
visible in `self-check`, logged at high severity, and disabled unless
the config opts in.

The signer API is narrow:

```rust
pub trait AgentSigner {
    fn backend_kind(&self) -> SignerBackendKind;
    fn public_address(&self) -> Address;
    fn sign_eip1559_hash(&self, hash: &[u8; 32]) -> Result<Signature, SignerError>;
}
```

The caller may only produce that hash through the known gateway
transaction builder. No generic signing oracle is exposed to the agent
planner.

## 9. Client Preflight

Before signing a deposit, `rmpc` must read and verify:

- chain id matches config;
- gateway bytecode hash matches config;
- gateway points at configured USDC and vault;
- gateway is not paused;
- agent is authorized and unexpired;
- requested amount fits per-deposit and per-window policy;
- agent USDC balance is sufficient;
- agent USDC allowance to the gateway is sufficient;
- configured fee caps are not exceeded;
- local idempotency cache does not already contain the same order
  attempt.

Preflight is a refusal path, not a warning path. The contract remains
authoritative, but the client should not knowingly ship a transaction
that violates visible policy.

## 10. Local State

Local state is advisory and UX-oriented:

- per-agent lock file;
- submitted order cache;
- tx hash cache;
- audit log;
- diagnostic log;
- last observed chain metadata.

Deleting local state must not bypass gateway idempotency or policy.
The gateway is the source of truth for safety.

## 11. Query Surface

The Rust client should replace relevant TypeScript CLI reads with
direct JSON-RPC reads, not explorer APIs.

Initial read commands are scoped in `docs/implementation-plan.md`
and include vault status, balances, agent policy, gateway config,
roles, tx status, and allowance checks.

Every read output should include:

- `chain_id`;
- `block_number`;
- `source: "json_rpc"`;
- decimal strings for large integers;
- explicit `unknown` or `not_onchain` where the deployed contract does
  not expose a claimed field.

## 12. Agent Runtime Integration

The same Rust binary and Robot Money skill should work in OpenCode for
manual testing and OpenClaw for long-running tasks.

Skill content must describe:

- when to use Robot Money;
- safe read commands;
- guarded deposit commands;
- refusal cases;
- fork versus mainnet warnings;
- expected JSON fields;
- when to ask for human/admin action.

MCP is desirable only if a target runtime cannot safely execute shell
commands or if long-running OpenClaw tasks need a persistent typed tool
server. The MVP plan records the MCP decision criteria.

## 13. Human Control Plane

Sensitive operations stay with humans:

- creating or selecting agent credentials;
- authorizing an agent;
- configuring share receiver and caps;
- revoking an agent;
- pausing and unpausing;
- exporting `rmpc` config for a runtime.

The dapp in the MVP plan is an operator surface for these actions. It
is not required for the OpenClaw demo, and it must not silently custody
private keys.

## 14. Audit Logging

Every signing decision writes an audit record:

- timestamp;
- agent address;
- signer backend;
- request type;
- order id;
- idempotency key;
- amount;
- deadline;
- gateway;
- vault;
- chain id;
- decision;
- refusal reason when applicable;
- tx hash when available;
- payment id when available.

Never log private keys, passphrases, seed phrases, cloud credentials,
or unredacted customer data.

## 15. Threats and Mitigations

> The full attack taxonomy — including web2/dapp, off-chain agent,
> economic, and process risks — lives in `docs/security-model.md`.
> The table below is the agent-access-layer subset.

| Threat | Mitigation | Residual risk |
|---|---|---|
| Prompt injection causes an unsafe deposit | Agent planner cannot sign; `rmpc` and gateway enforce role, caps, code hash, amount, deadline, and receiver policy | A valid agent can still deposit within configured caps |
| Agent key exposure | Agent key can call only the gateway deposit path within caps | Loss/risk budget equals configured per-window exposure |
| Client host compromise | Narrow signer API, known calldata only, audit logs, on-chain caps | Attacker can request valid deposits up to caps |
| Local state rollback | Gateway idempotency and window caps are on-chain | Local UX confusion until cache rebuild |
| Malicious RPC | Chain id and code hash checks; future multi-RPC comparison | Coordinated RPC failure remains an operator risk |
| Fixed-window boundary burst | Documented cap sizing requirement; future rolling-window upgrade possible | Up to adjacent-window burst if caps are too high |
| Software key extraction | Prefer HSM/KMS/Secure Enclave/TPM; explicit software opt-in | Software fallback remains weaker |
| Admin key misuse | Multisig/hardware wallet recommended; role separation enforced | Full admin quorum compromise is out of scope |
| Pause abuse | Agent cannot pause; pause key cannot deposit if role separation holds | Pause can still block new deposits |
| USDC issuer action | Out of scope; monitor and pause if needed | Issuer-controlled risk |

## 16. MVP Phase Link

The implementation sequence lives in
`docs/implementation-plan.md`.

That plan defines:

1. secure agent deposit infrastructure;
2. forked smart-contract e2e;
3. direct chain-read query tooling;
4. OpenCode/OpenClaw installation and skill loading;
5. simple explorer API and database;
6. human dapp controls;
7. OpenClaw e2e demo on a recent public-chain fork.

These phases are internal delivery phases for the Rust/agent-access
work and are separate from the public Robot Money roadmap phases.

## 17. Open Design Decisions

- Full TypeScript CLI replacement architecture for reads,
  withdraw/redeem, basket routing, simulation, and wallet UX.
- HSM/KMS/Secure Enclave implementation order.
- ~~Whether MCP is needed for OpenClaw or can be deferred.~~ Resolved
  2026-05-06: **deferred**. See `docs/technical/mcp-decision.md` (issue #55).
- Whether fixed windows are sufficient beyond MVP or should become
  rolling windows.
- How the human dapp should create, import, or register agent
  credentials without taking custody.
- Which on-chain fields are actually available for vault fee and
  adapter reporting, versus which must be marked `not_onchain`.
