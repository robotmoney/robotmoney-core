# Robot Money Architecture

> Canonical sources: `docs/prd.md`, `docs/definitions.md`,
> `docs/technical/adapter-architecture.md`,
> `docs/technical/smart-contracts.md`, and accepted ADRs under
> `docs/technical/`. This document describes how Robot Money is built.
> Product promises and user workflows live in the PRD; delivery order
> lives in `docs/implementation-plan.md`.

## 1. Overview

Robot Money is a USDC treasury system for human depositors, autonomous
agents, and token holders. The product architecture has three on-chain
allocation layers: the Portfolio Router at the outer product layer,
individual Robot Money vaults at the exposure layer, and vault adapters
inside each vault for venue-specific strategy execution. Agent access has
a separate permission and safety layer: the gateway. Human and agent
clients share the same read-before-write safety model: chain state is the
authority for signing and execution, while indexed data is used only for
display, history, and public observability.

## 2. Core Model

### 2.1 Allocation Layers

```text
Human wallet
  -> direct vault deposit
  -> or Portfolio Router deposit

Agent client / rmpc
  -> gateway permission and safety checks
  -> allowed vault or Portfolio Router action

Portfolio Router
  -> active underlying Robot Money vaults by RM-governed weights

Robot Money vault
  -> internal strategy adapters by vault-controlled routing/caps

Vault adapter
  -> external venue or strategy
```

The Portfolio Router allocates across vaults. Vaults allocate internally
through adapters. Users, agents, and the Portfolio Router consume vault
surfaces; they do not call adapters directly.

The gateway is not an allocation layer. It is the on-chain permission and
agent-safety layer in front of agent-initiated writes. It answers whether
the agent may act, for how much, until when, on behalf of which depositor,
to which share receiver, and into which allowed destination. After those
checks pass, the gateway forwards the permitted action to a vault or the
Portfolio Router.

Human wallets and agent clients use different permission paths, but they
terminate at the same product surfaces: vaults, the Portfolio Router,
governance reads/writes, and public observability. Architecture should
avoid parallel product semantics for humans and agents; the difference is
who is allowed to sign and which safety checks run before the product
surface is called.

### 2.2 Receipts and Portfolio Positions

Every vault issues its own receipt token. Direct vault deposits and
Portfolio Router deposits both leave users with underlying vault
receipts. The Portfolio Router does not issue an outer share token in the
current product definition.

A portfolio position is therefore a reporting concept computed from a
user's vault receipt balances, vault values, and current router weights.
The composite view in the dapp, CLI, and agent-readable output must
preserve drill-down into each vault, receipt balance, valuation, fee,
weight, and unavailable leg.

### 2.3 Governance Boundary

`$ROBOTMONEY` governance controls Portfolio Router target weights across
active vaults. It does not currently govern vault onboarding, vault
retirement, per-vault asset selection, per-vault strategy internals,
adapter selection, adapter caps, fees, or agent permissions.

The governance architecture must expose proposal state, vote casting,
vote history, cadence metadata, execution state, and the resulting router
weights. Those surfaces are required for both the dapp and programmatic
read clients; the implementation of quorum, delay, and execution remains
an open decision.

## 3. Technology Stack

| Layer | Choice | Rationale | Source |
| --- | --- | --- | --- |
| Chain | Base mainnet, chain id 8453; forked Base for integration tests | Current verified deployments and test strategy are Base-oriented. | `docs/technical/smart-contracts.md` §2; `docs/technical/fork-e2e-decisions.md` §3.1 |
| Smart contracts | Solidity 0.8.24, EVM Cancun, Foundry | Existing vault, gateway, adapter, and tests use this toolchain. | `foundry.toml`; `docs/technical/smart-contracts.md` §1 |
| Contract libraries | OpenZeppelin v5 ERC-4626, ERC-20, AccessControl, Pausable, ReentrancyGuard | Standardizes vault accounting, role separation, pause behavior, and reentrancy protection. | `docs/technical/smart-contracts.md` §3.1 |
| Primary asset | USDC, 6 decimals | Product accepts USDC as the treasury input asset. | `docs/prd.md` §1; `docs/technical/smart-contracts.md` §1 |
| Vault standard | ERC-4626 for individual vaults | Standard deposit, withdraw, redeem, preview, conversion, and `totalAssets()` surface. | `docs/technical/adapter-architecture.md` §1 |
| Stable-yield venues | Morpho Gauntlet USDC Prime, Aave V3, Compound V3 through vault adapters | Current deployed stable-yield vault normalizes these venues behind adapters. | `docs/technical/adapter-architecture.md` §4; `docs/technical/smart-contracts.md` §4 |
| Agent command client | Rust binary `rmpc` | Builds known calldata, signs through constrained backends, performs direct JSON-RPC reads, and emits stable JSON. | `docs/implementation-plan.md` §4; `docs/technical/rmpc-read-output-contract.md` §3 |
| Rust workspace | Cargo workspace, Tokio, reqwest, Alloy, sqlx where applicable | Existing Rust clients, indexer, tests, and shared logging use this stack. | root `Cargo.toml`; client and service `Cargo.toml` files |
| Human dapp | React 18, Vite, TypeScript, wagmi/viem, TanStack Query, Tailwind, Playwright | Current dapp package and ADRs target wallet signing, calldata preview, config export, and browser tests. | `clients/dapp/package.json`; `docs/technical/dapp-credential-decisions.md` §3 |
| Explorer API | Rust Axum service over Postgres | Read-only HTTP API for indexed history and display data. | `clients/explorer-api/Cargo.toml`; `docs/technical/explorer-schema-decisions.md` §3 |
| Explorer indexer | Rust poller, JSON-RPC canonical, Postgres storage | Derives events and snapshots from chain, never from `rmpc` output. | `services/explorer-indexer/Cargo.toml`; `docs/technical/explorer-schema-decisions.md` §3.5 |
| Database | Postgres for explorer/indexer environments | One DB engine for indexed data; no SQLite path. | `docs/technical/explorer-schema-decisions.md` §3.1 |
| Queue / async processing | None in the current architecture | Indexing is poll-based; there is no message queue commitment. | `docs/technical/explorer-schema-decisions.md` §3.2 |
| Auth / identity | Wallet signatures, gateway-enforced agent policies, and on-chain roles | The gateway is the permissions and agent-safety layer; depositors authorize their own agents; protocol roles are narrow and separated. | `docs/prd.md` §3, §5, §9; `docs/security-model.md` §10 |
| File / object storage | Local config, audit logs, build artifacts; no product object store | Current flows use TOML config export and local audit artifacts, not an object-storage service. | `docs/technical/dapp-credential-decisions.md` §3.4 |
| Email / notifications | Unspecified | No canonical doc selects an email or notification provider. | Open decision |
| Payment processing | On-chain USDC only | Fiat on/off ramps are out of scope. | `docs/prd.md` §8 |
| Observability | On-chain events, direct JSON-RPC reads, explorer indexer/API, structured `rmpc` JSON | Every state change must be observable; safety-critical reads stay live-chain. | `docs/prd.md` §2, §5, §7; `docs/technical/explorer-schema-decisions.md` §3.5 |
| Infrastructure / hosting | Base, JSON-RPC providers, Docker devnet, CI-managed services | Production hosting is not fully specified; tests use Base forks and local Geth/Lighthouse devnet. | `docs/testing-strategy-ethereum.md`; `docs/testing/smoke-test-design.md` |
| CI/CD | GitHub Actions quality gates for contracts, Rust, dapp, fork tests, docs validators | Test suites are documented as separate CI gates. | `docs/testing/ci-suites.md` |

## 4. On-Chain Architecture

### 4.1 Vault Family

A Robot Money vault is an individual strategy container with a mandate,
accepted asset, receipt token, caps, fees, risk label, and status. Each
vault is independently observable and independently pausable. Retiring a
vault stops new deposits while preserving redemption rights wherever
possible.

The current production-deployed source-backed vault is
`RobotMoneyVault`, an ERC-4626 USDC vault with rmUSDC shares,
OpenZeppelin access control, pause support, reentrancy protection,
caps, an exit fee ceiling, adapter routing, rebalance controls, and
emergency shutdown. It is a direct non-proxy deployment on Base.

The source tree also contains the basket-vault family — an abstract
`BasketVault` base with Uniswap V3 TWAP NAV pricing and slippage
controls, plus concrete `ProtocolAssetVault` (wETH/cbBTC/wSOL exposure)
and `AgentTokenVault` (admin-curated agent-economy tokens) subclasses.
These are prototypes (`isPrototype()` returns `true` at the base) and
remain excluded from production Portfolio Router weights until each
subclass certifies pool cardinality, per-asset TWAP windows, and an
intra-vault rebalancing model (PRD §3.15).

Future vault categories include thematic/RWA vaults. Those need
separate execution, oracle, liquidity, legal, and disclosure
architecture before production use.

### 4.2 Portfolio Router

The Portfolio Router is the outer allocation contract. It accepts USDC
deposits and splits them across active underlying Robot Money vaults by
the current RM-governed router weights.

Router requirements:

- destinations are vaults, not adapters or raw DeFi venues;
- deposits expose a preview with destination vaults, weights, estimated
  receipts, fees, and unavailable legs;
- a deposit with any unavailable leg reverts in full; the preview
  surfaces unavailable legs before signing so the user can decide
  whether to proceed or wait;
- receipt tokens remain visible as underlying vault receipts;
- router caps and vault caps both apply;
- router state, weights, governance execution, and history are publicly
  observable.

The source tree contains `contracts/PortfolioRouter.sol`, a dedicated
router contract that backs the requirements above. It integrates with
`VaultRegistry` for eligibility, enforces a prototype gate via
`IPrototypeAware.isPrototype()` with an admin-controlled
`prototypeOverride` and a separate non-prototype attestation flag,
applies per-vault withdrawal caps over a fixed window, and depends on
`RouterGovernance` for weight execution. It is not yet on the
production mainnet deployment manifest; the contract surface is in
place, audit and mainnet onboarding remain implementation-plan work.

### 4.3 Vault Adapters

Adapters are internal to one vault. They normalize venue-specific
deposit, withdrawal, valuation, and rescue behavior behind
`IStrategyAdapter`:

- `deploy(uint256 amount)`;
- `withdraw(uint256 amount) returns (uint256 actual)`;
- `totalAssets() returns (uint256)`;
- `rescueTokens(address token, address to)`.

Mutating adapter functions are callable only by the owning vault. Adapter
selection and caps are privileged vault-management operations and expand
the audit surface of that vault.

Current stable-yield adapters:

- `MorphoAdapter` deposits USDC into the Morpho Gauntlet USDC Prime
  ERC-4626 vault.
- `AaveV3Adapter` supplies USDC to Aave V3 on Base and holds aToken
  exposure.
- `CompoundV3Adapter` supplies USDC to Compound V3 Comet on Base and
  forwards withdrawn USDC back to the vault.
- `PassthroughAdapter` is for devnet and smoke tests only.

### 4.4 Synchronous Redemption

Synchronous redemption is a product promise. A vault included in router
allocations must support one-transaction withdrawal or be excluded until
the product promise changes. Adapter liquidity failures, upstream venue
pauses, and withdrawal shortfalls are therefore first-order risks, not
background implementation details.

### 4.5 Protocol Admin Authority

All five protocol contracts (`RobotMoneyVault`, `RobotMoneyGateway`,
`VaultRegistry`, `PortfolioRouter`, `RouterGovernance`) use OpenZeppelin
`AccessControl` with an `ADMIN_ROLE` that governs privileged operations:
adapter add/remove, cap and fee changes, vault registration and
deregistration, pause-role grants, governance parameter changes, and
`ADMIN_ROLE` membership changes.

On-chain enforcement requirement: `ADMIN_ROLE` on all five contracts
must be held by a deployed `TimelockController`. The existing Safe
multisig (`0x88bA…75A0`) holds `PROPOSER_ROLE` and CANCELLER_ROLE on
the controller. EXECUTOR_ROLE should be open (`address(0)`) so any
address can execute an already-authorized operation after the delay; if
execution is restricted, the executor must also be a Safe with threshold
≥ 2 and the liveness tradeoff must be documented. No EOA may hold
`ADMIN_ROLE` directly in production. All high-risk admin operations must
pass through the schedule → delay → execute flow. The minimum delay is
configurable per operation class.

The `TimelockController` address, proposer set, executor policy, min
delay, canceller set, and pending operation hashes must be observable
on-chain and surfaced by `rmpc get-timelock` and the dapp timelocked
proposals panel.

This constraint does not apply to depositor-owned agent policies, which
remain under sole depositor authority. Router-weight votes and post-vote
weight execution use the `RouterGovernance` module's own voting period
and execution delay. RouterGovernance administration, including voting
power assignment and cadence/quorum parameter changes, remains a
protocol-admin operation and must route through the admin timelock in
production.

See `docs/security-model.md` §4 and issue #414.

### 4.6 Fees, Revenue, and Buybacks

The PRD defines three fee classes per vault or Portfolio Router path:
management fee, swap-fee share, and exit fee. The current deployed
`RobotMoneyVault` source implements an exit fee only.

**Current phase:** only exit fees are in scope. Management fee,
swap-fee-share, protocol revenue collection, and buyback-and-burn are
deferred to a future phase and require explicit contract design before
implementation.

Architecture requirements for exit fees (current phase):

- exit fee bounds are explicit per vault or router path before a user
  or agent signs;
- previews show gross amount, fee amount, and net amount;
- fee recipient changes are protocol-admin operations and observable.

Architecture requirements for deferred fee surfaces (future phase):

- management-fee and swap-fee-share mechanisms require dedicated
  contract design and a separate ADR before implementation;
- protocol revenue and buyback-and-burn execution must have observable
  on-chain events and indexed history when implemented.

## 5. Off-Chain Architecture

### 5.0 Read Surface Taxonomy

All client surfaces — dapp, `rmpc`, and explorer API — expose data in
two scopes. The scope determines what address (if any) is required and
which data source is authoritative.

**Protocol scope** — no address required. Shows the state of the
protocol as a whole: all registered vaults, vault statuses, caps, fees,
risk labels, adapter breakdowns, Portfolio Router weights, governance
proposals, and aggregate metrics (total TVL, number of active vaults).
This is the data a landing page, a public API consumer, or an agent
with no depositor relationship needs to decide whether and where to
deposit. Sources: live chain reads for current vault state and weights;
explorer indexer for historical activity and aggregate metrics.

**Account scope** — an address is required. Shows the state of a
specific depositor or agent address: receipt token balances across all
vaults, USDC value of each position, combined portfolio value, agent
policy details, gateway cap usage, and full transaction history.
Sources: live chain reads for balances, receipt supply, and policy
state; explorer indexer for history and aggregated fee data.

Both scopes are read-only and require no signing. The account scope
requires only an address, not a signature — a watched address is
sufficient. Signing is required only for writes (deposits, withdrawals,
policy management, governance votes).

Safety-critical values used for signing (fee bounds, cap headroom,
policy state, allowances, code hash) must always come from live chain
reads regardless of scope. Explorer data may annotate display but must
not be the source of values presented in a signing prompt.

### 5.1 `rmpc`

`rmpc` is the constrained Rust command client for agents and operators.
Its signing path builds only known calldata for configured contracts on a
configured chain. It performs direct JSON-RPC preflight reads before any
write and emits stable JSON envelopes for read commands:

- `chain_id`;
- `block_number`;
- `source`;
- `partial`;
- `errors`;
- `data`.

Large integer fields are serialized as decimal strings. For
safety-critical flows, JSON-RPC is the source of truth; explorer/indexer
data may be used only as an explicitly labeled non-authoritative source
if a future ADR adds that path.

`rmpc` read commands cover both scopes defined in §5.0:

**Protocol-scope reads** (no address argument required):

- `get-vaults` — vault registry: all registered vaults, their name,
  risk label, mandate, status (active/paused/retired), TVL, caps, exit
  fee, and receipt token address.
- `get-vault <address>` — single vault: all of the above plus adapter
  breakdown (address, balance, cap, active flag) and rebalance state.
- `get-router` — Portfolio Router: active vault addresses, current
  weight bps per vault, pending governance proposal if any, and router
  cap.
- `get-governance` — governance state: active proposal, vote tallies if
  available, cadence, quorum threshold, execution delay, and last
  applied weights.

**Account-scope reads** (address argument required):

- `get-position <address>` — positions across all registered vaults:
  receipt token balance, USDC value, share of vault TVL, and composite
  portfolio total. Suitable for an agent checking its treasury exposure.
- `get-agent <address>` — agent policy: valid-until, max per payment,
  max per window, window usage to date, allowed destinations, share
  receiver, and asset recipient.
- `get-balance <address>` — USDC and receipt token balances for the
  address, plus USDC allowance to each configured contract.

Protocol-scope reads require only the chain and registry configuration;
they do not require a signer key. This allows agent runtimes to run
protocol reads from a read-only deployment without any key material.

### 5.2 Agent Permissions Gateway

The gateway is the permissions and agent-safety layer for autonomous
access. It is not a vault, not the Portfolio Router, and not an adapter.
It sits between `rmpc`/agent keys and product write surfaces so an agent
can only execute allowed actions under a depositor-owned policy.

The depositor owns the policy: valid-until, max per payment, max per
window, share receiver, and allowed destinations. The Robot Money team
does not manage individual depositor agent policies at runtime.

The current gateway implementation gates agent deposits into a vault. The
product architecture uses the same safety boundary for agent deposits and
agent withdrawals across single-vault and Portfolio Router paths:

- the agent can call only gateway-approved verbs;
- the agent cannot choose its own share receiver;
- the agent cannot choose its own withdrawal recipient;
- the agent cannot raise caps or expand destinations;
- the agent cannot add vaults, change mandates, alter router weights, or
  bypass disabled vaults;
- the gateway enforces amount, expiry, window usage, destination,
  idempotency, pause, receiver, and recipient constraints on-chain;
- the client must read registry, vault status, router weights, policy,
  allowance, balance, and projected cap usage before signing.

For deposits, the gateway pulls USDC from the agent, enforces policy, and
forwards the allowed deposit to a vault or the Portfolio Router. The
resulting vault receipts are minted to the policy-configured share
receiver.

For withdrawals, the gateway is the only agent-callable redemption
spender. The depositor or configured receipt owner grants the gateway the
needed vault-receipt allowance, or uses an owner contract that exposes
the same policy boundary. The agent submits a gateway withdrawal request;
the gateway verifies policy, cap usage, allowed source vault/router path,
receipt allowance, receipt balance, previewed assets out, pause state,
and recipient, then calls the vault or Portfolio Router redemption path.
Withdrawn USDC is sent only to the policy-configured asset recipient.
The agent cannot redirect proceeds to itself.

Because the Portfolio Router does not issue an outer share token,
router-position withdrawals resolve to underlying vault receipts. A
router withdrawal helper may orchestrate proportional underlying
redemptions, but it must preserve the same gateway permission checks and
must not create hidden custody or an unobservable outer claim.

### 5.3 Human Dapp

The dapp is the human command and observability surface. It covers both
scopes defined in §5.0 and is organized into three view layers.

**Protocol layer (no wallet required)**

The protocol layer is the first contact for any visitor. It must be
fully functional without a connected wallet and must load from the
explorer API plus live chain reads for vault state. It contains:

- Vault registry view: all registered vaults listed with name, risk
  label, TVL, current APY estimate, exit fee, deposit cap headroom, and
  status (active/paused/retired). The list is derived from the on-chain
  vault registry so new vaults appear automatically.
- Vault detail view: single-vault breakdown — adapter allocations and
  their individual TVL, rebalance state, fee schedule, caps, receipt
  token address, and historical TVL and activity charts from the
  explorer.
- Portfolio Router view: active vaults, current target weights, pending
  governance proposal (if any), and historical weight changes.
- Protocol stats: total TVL across all active vaults, number of unique
  depositor addresses (indexed), and a recent activity feed of deposits
  and withdrawals across all vaults.

**Account layer (wallet connected or watched address)**

The account layer shows the state of a specific address. It activates
on wallet connection but must also be accessible by entering any address
for read-only portfolio inspection (watched address mode).

- Portfolio position: receipt token balances across all registered
  vaults, USDC value of each position using live vault share price, and
  composite portfolio total. Positions from direct vault deposits and
  Portfolio Router deposits are both shown, broken down by vault.
- Transaction history: chronological list of deposits, withdrawals, fee
  events, and governance votes for the address, sourced from the
  explorer indexer.
- Agent policies: all active agent policies the address owns — each
  showing allowed destinations, max per payment, max per window, window
  usage, share receiver, asset recipient, and expiry.

**Action layer (wallet required for signing)**

Actions are available only with a connected wallet. Every action must
render a preview before invoking the wallet.

- Deposit: vault selection or Portfolio Router path, amount entry,
  preview (destination weights, estimated receipts, fees, net amount,
  unavailable legs), and sign.
- Withdrawal: position selection, amount or share entry, preview
  (source vault or router path, estimated USDC, fee, net amount), and
  sign.
- Agent policy management: authorize a new agent, update or revoke an
  existing policy, and export the resulting `rmpc` config file.
- Governance: review active weight proposal, cast vote, and view
  execution state.

Credential boundary:

- the dapp registers agent public addresses and policy settings;
- it does not persist production private keys;
- browser-generated software credentials are fork/devnet-only,
  feature-gated, immediately exported, clearly labeled unsafe for
  production, and rejected by `rmpc` for Base mainnet write commands.

Every admin or policy signing prompt must decode target, function,
arguments, role/policy effect, and risk class before invoking the
wallet.

Signing prompts for deposits and withdrawals must also show the concrete
product effects: destination or source vaults, router weights when
applicable, gross amount, fees, net amount, receipt owner, recipient,
slippage/quote bounds where relevant, and whether execution is
all-or-revert or an explicitly previewed partial fill.

### 5.4 Explorer Indexer and API

The explorer stack exists for public history, dashboards, and display. It
does not authorize actions and does not replace live `rmpc` preflight.

The explorer API exposes both scopes defined in §5.0. It is the primary
data source for the dapp protocol layer and account history, and for
integrators who need activity feeds without running their own indexer.

**Protocol-scope endpoints** (no address parameter):

- Vault list: all registered vaults with current indexed TVL, status,
  fee, and receipt token. Updates on every indexer tick.
- Vault detail: single vault with adapter allocation history, TVL over
  time, deposit and withdrawal event log, and fee collection history.
- Router state: current weights, weight change history, and governance
  proposal log.
- Protocol stats: aggregate TVL across all active vaults, unique
  depositor count, total deposits and withdrawals by volume and count,
  and a global activity feed of recent events across all vaults.

**Account-scope endpoints** (address parameter required):

- Account positions: receipt token balances and USDC values per vault
  for a given address, derived from indexed transfer events and current
  share price.
- Account history: chronological event log for the address — deposits,
  withdrawals, fee events, policy changes, and governance votes.
- Account agent policies: all gateway policy states for policies owned
  by the address, including window usage history.

Architecture constraints:

- Postgres is the database for every environment that runs the indexer.
- The indexer polls JSON-RPC; it does not use `eth_subscribe`.
- Indexed rows are keyed by chain and event/state identity.
- Reorg handling rewrites rows at or above the safe head.
- `rmpc` outputs are never ingested by the indexer.
- The API is read-only and scoped to one configured chain.
- Explorer data is non-authoritative for signing. The dapp must
  re-fetch balances, caps, fees, and policy state from live chain
  before presenting any signing prompt, even if the explorer was
  used to populate the preceding display view.

### 5.5 Agent Runtime Integration

OpenCode, OpenClaw, and other agent harnesses invoke `rmpc` as a
process-per-call command. MCP is deferred; any future MCP surface must
inherit `rmpc`'s command schema, chain/config pinning, and refusal
semantics rather than becoming a new signing authority.

## 6. Data and Trust Boundaries

### 6.1 Authoritative Data

Authoritative sources for safety decisions:

- on-chain contract storage read through JSON-RPC;
- transaction receipts and logs from the configured chain;
- locally configured contract addresses, chain id, and runtime-code
  hashes;
- wallet signatures or configured signer backends.

Non-authoritative sources:

- explorer API responses;
- cached indexer snapshots;
- dapp-rendered summaries;
- agent planner text;
- docs and static config examples.

### 6.2 Custody

Robot Money does not custody user private keys. Vault assets are held by
vaults or adapters. Vault receipts are held by the depositor or the
depositor's configured share receiver. The Portfolio Router does not
custody an outer share position under the current product definition.

### 6.3 Role Separation

Protocol authority is limited to contract upgrade where applicable,
configuration of protocol-level controls, pause, and permanent shutdown.
Depositor-owned agent policies are controlled by the depositor. Agent
keys must not hold admin or pause authority.

## 7. Interface and Execution Contracts

### 7.1 Previews

Every write surface that can move assets must have a preview path before
signature:

- direct vault deposit and withdrawal preview;
- Portfolio Router deposit and withdrawal preview;
- gateway-mediated agent deposit and withdrawal preview;
- governance execution preview for router-weight changes;
- fee and net-out preview for any path with a fee.

Preview data must be derived from live chain reads for safety-critical
fields. Cached explorer data may annotate history or display context, but
it cannot be the source of values used for signing.

### 7.2 Execution Results

Write results must emit and report enough structured data for the dapp,
`rmpc`, explorer, and agent clients to agree on what happened:

- transaction hash, block number, and chain id;
- destination/source vaults and router path;
- gross amount, fees, net amount, receipts minted/burned, and recipient;
- policy id or agent address for gateway-mediated actions;
- whether execution was complete or partial;
- per-leg result for Portfolio Router actions;
- product-level refusal reason when execution did not proceed.

Contract reverts can stay technical at the EVM boundary, but client and
API surfaces must map known failures to stable product reason codes such
as `paused`, `vault_disabled`, `cap_exceeded`, `expired_policy`,
`insufficient_allowance`, `insufficient_balance`, `unavailable_leg`,
`fee_cap_exceeded`, and `slippage_bound_exceeded`.

## 8. Security Constraints

These constraints are mandatory for implementation plans derived from
this architecture:

- Users and agents must call vaults or the Portfolio Router, not
  adapters or raw underlying venues.
- Adapters must restrict mutating functions to their owning vault.
- Adapter rescue functions must not sweep USDC or protected receipt
  tokens.
- Vaults and router legs must enforce caps before accepting deposits.
- Any router leg with slippage, oracle, liquidity, or quote-freshness
  risk must surface bounds before signing.
- Withdrawals and redemptions are synchronous unless a vault is clearly
  labeled out of router eligibility.
- Gateway-mediated withdrawals must verify receipt owner, receipt
  allowance, receipt balance, allowed source, maximum amount, minimum net
  assets out, and policy-configured recipient before signing and before
  execution.
- `rmpc` must verify chain id, configured addresses, code hash, role,
  policy, cap usage, allowance, balance, and fee caps before signing.
- The dapp must decode transaction effects before wallet invocation.
- Explorer data must not be used as the source of truth for signing or
  safety decisions.
- Software-backed credentials are development or low-value fallbacks and
  must be explicit in config and UI.
- `ADMIN_ROLE` on all protocol contracts must be held by the deployed
  `TimelockController` in production; no EOA may hold `ADMIN_ROLE`
  directly. All high-risk admin operations must pass through the
  schedule → delay → execute flow. See §4.5.

## 9. Vendor Selections

| Vendor / project | Category | Selection status | Source |
| --- | --- | --- | --- |
| Base | Production chain | Current chain for verified deployments and fork tests. | `docs/technical/smart-contracts.md` §2 |
| Circle USDC | Asset | Current accepted treasury asset. | `docs/prd.md` §1 |
| OpenZeppelin | Contract library | Used for ERC-4626, AccessControl, Pausable, and ReentrancyGuard. | `docs/technical/smart-contracts.md` §3.1 |
| Morpho Gauntlet USDC Prime | Stable-yield venue | Current adapter target. | `docs/technical/adapter-architecture.md` §4 |
| Aave V3 | Stable-yield venue | Current adapter target. | `docs/technical/adapter-architecture.md` §4 |
| Compound V3 Comet | Stable-yield venue | Current adapter target. | `docs/technical/adapter-architecture.md` §4 |
| Postgres | Explorer database | Accepted for every environment that runs the indexer. | `docs/technical/explorer-schema-decisions.md` §3.1 |
| JSON-RPC providers | Chain data transport | Required; specific production provider is not selected. | `docs/technical/explorer-schema-decisions.md` §3.5 |
| HSM / Secure Enclave / TPM / KMS | Production signer class | Preferred signer classes; exact vendor not selected. | `docs/implementation-plan.md` §0 |
| GitHub Actions | CI/CD | Existing documented CI environment. | `docs/testing/ci-suites.md` |

## 10. Open Decisions

| Decision | Tradeoff | Recommended default |
| --- | --- | --- |
| Portfolio Router contract design | Execution model resolved: all-or-revert. Remaining open: contract API, preview call signatures, cap enforcement across legs, and governance weight execution path. | Build a dedicated router contract; do not fold router behavior into adapters or `rmpc`. |
| Vault registry contract | Resolved: on-chain contract. PRD requires observable vault registry, mandates, statuses, caps, and risk labels; the registry must expose stable read methods and emit events indexable by the explorer. | Add an on-chain registry with stable read methods and event history, then index it. |
| Router-weight governance implementation | PRD fixes the governance surface but not the voting contract, cadence enforcement, quorum, delay, or execution path. | Keep governance narrow: one weight-vote module that can update router weights only. |
| Protocol-asset and agent-token vault execution | These vaults need swaps, oracles, slippage bounds, liquidity rules, and asset-selection criteria. | Require separate ADRs before implementation; exclude from router until synchronous redemption and pricing are proven. |
| Management fee and swap-fee-share mechanism | Resolved: deferred to a future phase. Current phase ships exit-fee-only disclosure. | Require a separate ADR and contract design before management fee or swap-fee-share are implemented. |
| Protocol revenue and buyback-and-burn execution | Resolved: deferred to a future phase alongside management fee and swap-fee-share. | Require a separate ADR; when implemented, add a narrow revenue collector plus buyback executor with indexed events and admin bounds. |
| On-chain admin timelock | Resolved: required. `docs/security-model.md` §4 deferred this until bucket-B/C governance landed; VaultRegistry, PortfolioRouter, and RouterGovernance are now in the codebase. All five protocol contracts must transfer `ADMIN_ROLE` to an OZ `TimelockController` before mainnet scale. | Deploy `TimelockController`; transfer `ADMIN_ROLE` on all five contracts to it; configure existing Safe as proposer and canceller; prefer open execution unless a restricted Safe executor is explicitly justified. See §4.5 and issue #414. |
| Production JSON-RPC provider | Safety-critical reads depend on provider correctness and availability. | Support configured primary plus documented fallback; defer multi-RPC consensus until a specific risk justifies it. |
| Production signer vendor | Architecture requires a production-grade HSM/KMS/device-bound signer for Base mainnet writes, but no vendor is chosen. | Keep signer backend trait stable; refuse software-keystore signing on Base mainnet until a production operator picks HSM/KMS. |
| Dapp hosting and CSP | Security model flags XSS/build compromise as unresolved. | Require static hosting with strict CSP, pinned dependencies, and release provenance before public mainnet use. |
| Email/notification provider | No product or technical doc selects one. | Leave out until a concrete notification workflow is specified. |

## 11. Source Coverage

| Source doc | Rules applied | Rules not applicable |
| --- | --- | --- |
| `docs/prd.md` | Problem statement, success metrics, user roles, user stories, workflows, entity lifecycles, integration needs, constraints, and out-of-scope boundaries. | Implementation sequencing. |
| `docs/definitions.md` | Canonical meanings for vault, underlying vault, adapter, receipt, router, portfolio position, composite view, router weights, governance, and agent policy. | None. |
| `docs/technical/adapter-architecture.md` | Adapter interface, vault flow, implemented adapters, adapter controls, risk model, router-vs-adapter separation. | Portfolio Router implementation details; the doc explicitly excludes router design. |
| `docs/technical/smart-contracts.md` | Current Base deployments, ERC-4626 vault behavior, roles, caps, fees, emergency paths, adapter source behavior, share-scale mitigation. | Future vault categories and Portfolio Router. |
| `docs/security-model.md` | Role separation, live-chain safety decisions, dapp/web2 risks, upstream protocol risks, infrastructure risks, triage backlog. | Exhaustive attack table details; kept in the security model. |
| `docs/technical/rmpc-read-output-contract.md` | Stable JSON envelope, JSON-RPC source lock, partial-read contract, decimal-string integer serialization. | Per-command flag spelling and future indexer source variant. |
| `docs/technical/explorer-schema-decisions.md` | Postgres, JSON-RPC-only ingestion, poll cadence, reorg handling, single-chain scoping, read-only API boundary. | Optional later tables and future multi-chain expansion. |
| `docs/technical/dapp-credential-decisions.md` | Dapp credential boundary, wallet-signing previews, config export, unsafe software credential marker. | Frontend framework choice was later resolved by the existing dapp package. |
| `docs/technical/dapp-browser-keygen-review.md` | Fork/devnet-only browser keygen gate and no-go conditions. | Mainnet production credential generation. |
| `docs/technical/mcp-decision.md` | MCP deferred; agent harnesses invoke `rmpc` as process-per-call. | A future MCP implementation. |
| `docs/testing-strategy-ethereum.md`, `docs/testing/*` | Devnet, fork, smoke, CI, and dapp test boundaries. | Product behavior and vendor selection beyond tests. |
| `docs/implementation-plan.md` | Existing shipped components and stale areas were used as implementation status context only. | Delivery sequence is intentionally not reproduced here. |
