# Product Requirements Document

## 1. Problem Statement

Robot Money helps autonomous agents, machine-operated businesses, and
human depositors put idle USDC to work without requiring each user to
manually assemble, monitor, and rebalance treasury exposure across
multiple venues or strategy categories.

Primary users need a treasury product that supports direct vault
selection, a managed multi-vault allocation, transparent performance and
allocation reporting, and bounded autonomous-agent access. The product
is better than manual treasury management because users can choose an
exposure profile, preview the consequences of a deposit or withdrawal,
and rely on consistent controls across human and agent-operated flows.

## 2. Goals and Success Metrics

- Depositors can deposit USDC into a selected vault or a Portfolio
  Router allocation with a clear preview of destination, fees, expected
  receipts, and unavailable legs.
- Depositors can withdraw synchronously from eligible vaults and
  Portfolio Router paths.
- Autonomous depositors can authorize agent activity with user-defined
  limits, destinations, recipients, and expiration.
- Addresses with admin-assigned voting power can vote on target weights
  for the Portfolio Router allocation. (Current governance is an
  admin-weighted MVP mock; token-holder voting is a future goal.)
- Any user can inspect vault availability, allocation weights,
  performance, fees, governance state, and execution results.
- Product failures are explicit: users receive a product-level reason
  when an operation cannot proceed or only partially succeeds.

Success is measured by:

- successful deposit and withdrawal completion rate;
- percentage of attempted operations that provide a preview before user
  approval;
- percentage of failed operations that return a clear product reason;
- autonomous-agent activity that remains within depositor-defined limits;
- governance participation in allocation-weight votes;
- user visibility into allocation, performance, fees, and state changes.

## 3. User Roles

- **Autonomous depositor.** An AI agent, autonomous machine, or
  agent-operated business that uses depositor-approved treasury
  permissions to deposit, withdraw, and observe positions.
- **Human depositor.** A person who deposits USDC, chooses vault or
  Portfolio Router allocation exposure, withdraws funds, and monitors
  positions.
- **Governance voter.** An address with admin-assigned voting power
  (current MVP) who votes on target weights for the Portfolio Router
  allocation and observes protocol value capture. Token-holder voting
  is a future goal once a real token snapshot or voting-power source
  is integrated.
- **Integrator.** A builder who embeds Robot Money treasury actions and
  reporting into an agent runtime, treasury workflow, or external
  product.
- **Protocol operator.** A limited operations role responsible for
  product-wide incident response and published administrative controls,
  without authority over individual depositor agent policies.

Access expectations:

- Depositors can create positions, withdraw from their positions,
  define agent permissions for their own agents, update those
  permissions, and revoke those permissions.
- Autonomous depositors can act only within permissions set by the
  depositor who authorized them.
- Addresses with admin-assigned voting power can participate in
  allocation-weight governance and view governance history. (Current
  governance is admin-weighted MVP; token-holder voting is a future
  goal.)
- Integrators can read public product state and submit user-authorized
  actions.
- Protocol operators can use product-wide safety controls, but cannot
  create, expand, or redirect an individual depositor's agent policy.
- Authorization depends on relationship: a depositor controls only their
  own positions, agent policies, recipients, and permissions.

## 4. User Stories

- As an autonomous depositor, I want to sweep idle USDC into an approved
  treasury destination so that surplus operating funds can earn exposure
  without giving the agent unrestricted control.
- As a human depositor, I want to choose a vault or Portfolio Router
  allocation and preview the result before approving so that I
  understand where my funds go and what I receive.
- As a human depositor, I want to withdraw synchronously from eligible
  positions so that funds are available when needed.
- As an address with admin-assigned voting power, I want to vote on
  Portfolio Router target weights so that I can influence how the
  composite treasury exposure is balanced. (Token-holder voting is a
  future goal; current governance is admin-weighted MVP.)
- As an integrator, I want stable read and action surfaces so that agent
  runtimes and treasury tools can embed Robot Money safely.
- As a protocol operator, I want narrow product-wide safety controls so
  that incidents can be contained without taking control of user agents
  or positions.

## 5. Core Workflows

### Human Depositor Deposit

1. The depositor connects a wallet or other supported account surface.
2. The depositor reviews available vaults, risk labels, fees,
   availability, and the Portfolio Router allocation option.
3. The depositor enters an amount and chooses a destination.
4. The product previews destination weights, expected receipts, fees,
   net amount, and unavailable legs.
5. The depositor approves the operation.
6. The product reports the result and updates the depositor's position
   view.

### Human Depositor Withdrawal

1. The depositor selects a position.
2. The product previews source, amount, fees, net amount, recipient, and
   any limitations.
3. The depositor approves the withdrawal.
4. The product settles the withdrawal synchronously for eligible paths
   and reports the result.

### Autonomous Treasury Sweep

1. A depositor authorizes an agent and defines allowed destinations,
   maximum amounts, recipients, and expiration.
2. The agent observes available balance, policy limits, destination
   state, and allocation state.
3. The agent requests a deposit or withdrawal within the depositor's
   limits.
4. The product refuses requests outside policy, unavailable
   destinations, or insufficient balances.
5. Approved activity settles and is reported to the depositor and agent.

### Allocation Governance

NOTE: Current governance is admin-weighted MVP (RouterGovernance.sol).
Voting power is assigned by ADMIN_ROLE; proposal creation is
ADMIN_ROLE-only. Token-holder voting is a future goal.

1. An address with admin-assigned voting power reviews active
   allocation-weight proposals, target weights, timing, and expected
   impact.
2. The voter votes.
3. The product publishes vote outcome, execution state, and resulting
   allocation weights.
4. Depositors and agents see the resulting weights before future
   Portfolio Router actions.

### Integrator Read And Action Flow

1. The integrator reads vault registry, allocation weights, position
   state, fees, and availability.
2. The integrator presents product-level previews and refusal reasons to
   its user or agent.
3. User-authorized actions are submitted only after the relevant preview
   and permission checks.
4. Results are returned with enough detail for downstream reporting.

Common edge cases:

- selected destination is paused, retired, full, or unavailable;
- requested amount exceeds depositor, vault, allocation, or agent limits;
- withdrawal path cannot meet synchronous settlement requirements;
- a Portfolio Router allocation leg is unavailable, causing the whole deposit to revert;
- account balance or approval is insufficient;
- agent permission is expired, revoked, or scoped to a different
  destination;
- governance proposal expires, fails, or is not executable;
- external market, liquidity, valuation, or compliance constraints make
  a strategy temporarily unavailable.

## 6. Entity Lifecycle

- **Vault.** Proposed -> active -> paused -> active; active -> retired;
  retired -> redeemable archive when redemptions remain available.
- **Portfolio Router allocation.** Draft weights -> active vote ->
  approved weights -> applied weights; active vote -> rejected or
  expired.
- **Depositor position.** No position -> previewed deposit -> active
  position -> previewed withdrawal -> reduced or closed position.
- **Agent policy.** Draft -> active -> updated -> paused or revoked;
  active -> expired when its validity window ends.
- **Agent action.** Requested -> previewed -> approved -> settled;
  requested or previewed -> refused; approved -> partially settled only
  when the user-facing preview allows partial execution.
- **Governance proposal.** Draft -> open for voting -> approved or
  rejected -> applied or expired.
- **Fee schedule.** Proposed -> published -> active -> superseded.
- **Incident control.** Normal -> paused -> normal; normal or paused ->
  shutdown when new deposits must stop while preserving withdrawal
  rights where possible.

## 7. Integration Needs

- **Wallet or account authorization.** Triggered when a depositor
  connects, approves a deposit or withdrawal, manages an agent policy, or
  votes.
- **Digital asset transfer and settlement.** Triggered by deposits,
  withdrawals, fee collection, allocation changes, and buyback activity.
- **Market access and valuation.** Triggered when vaults need asset
  pricing, liquidity checks, performance reporting, or strategy
  execution.
- **Governance participation.** Triggered by proposal creation, vote
  casting, vote tallying, weight publication, and execution reporting.
- **Public state indexing and reporting.** Triggered by deposits,
  withdrawals, policy changes, governance actions, allocation changes,
  fee events, and incident controls.
- **Agent runtime integration.** Triggered when an authorized agent reads
  product state, previews an action, submits an action, or receives a
  refusal reason.
- **Compliance and disclosure support.** Triggered by new vault
  categories, restricted exposure types, user disclosures, incident
  reporting, and jurisdiction-specific requirements.

## 8. Out of Scope

- Custodial private-key management for users.
- General-purpose wallet functionality beyond Robot Money treasury and
  governance workflows.
- Fiat on-ramps and off-ramps.
- Direct user interaction with underlying strategy venues outside Robot
  Money vault and allocation flows.
- Agent-created vaults, agent-created assets, or agent-controlled
  governance changes.
- Token-holder governance over vault internals, per-vault asset
  selection, strategy selection, fees, or individual agent permissions.
- Hosted custody or hosted signing services.
- Vault categories whose legal, liquidity, valuation, and disclosure
  requirements are not specified.

## 9. Constraints

- Deposits and withdrawals must provide a preview before user approval.
- Eligible withdrawals must settle synchronously.
- Product surfaces must expose fees, net amounts, destinations,
  recipients, limits, and refusal reasons in user-facing language.
- Autonomous-agent access must remain bounded by depositor-defined
  amount limits, destination limits, recipients, and expiration.
- A depositor must remain the authority over their own agent policy.
- Product-wide safety controls must not grant operators authority to
  redirect user funds or expand an individual agent's permissions.
- The Portfolio Router must expose target weights, active weights,
  governance state, and historical outcomes.
- Vault and Portfolio Router fee structures are limited to three
  classes: management fee, swap-fee share, and exit fee. Each fee
  class, its rate, and its recipient must be disclosed before user
  approval. In the current phase only exit fees are implemented;
  management fee and swap-fee share are deferred to a future phase.
- Vaults must disclose risk labels, fees, caps, availability, and
  retirement or pause state.
- Accessibility expectations apply to human-facing flows, including
  readable previews, keyboard-accessible controls, and clear status and
  error messaging.
- New exposure categories must satisfy legal, liquidity, valuation,
  redemption, and disclosure requirements before being made available to
  depositors.

## 10. Prior Art

The following protocols informed the Robot Money architecture. Each is
referenced in the open-questions register
(`docs/development/open-questions.md`) or in build-vs-buy decisions.

### Veda

Veda is the closest published reference to the Portfolio Router model.
It manages depositor USDC across a curated set of underlying ERC-4626
vaults and issues a single composite receipt. Governance or an operator
sets target weights; the protocol routes deposits accordingly.

Robot Money diverges on one key point: Veda issues an outer share token
wrapping the underlying vault positions. The Robot Money Portfolio Router
does not — depositors receive underlying vault receipts directly and the
portfolio position is a reporting concept over those receipts, not a
separate on-chain claim. This preserves depositor visibility into each
vault and avoids creating a hidden custody layer (see
`docs/architecture.md` §2.2).

### Yearn V3

Yearn V3 is the architectural reference for the Robot Money vault and
adapter layer. A Yearn V3 vault accepts deposits into a single ERC-4626
contract and routes assets across multiple pluggable "strategies"
(yield venues). The RobotMoneyVault reproduces this pattern: an
IStrategyAdapter interface normalizes each venue, deposits route across
active adapters by equal-weight target, and a keeper-triggered rebalance
corrects drift. The asymmetric pause model (EMERGENCY_ROLE pauses,
ADMIN_ROLE unpauses) is also borrowed from Yearn's security design.

### Giza and Zyfai

Giza and Zyfai are yield optimization protocols on Base that allocate
USDC across Aave, Compound, and Morpho by utilization-driven or
off-chain-optimized weight models. Both are candidates for the stable-yield
vault's adapter layer if the team revisits the decision to maintain
custom adapters in-house (build-in-house is decided). The current architecture is built
to support either model: swapping a custom adapter for a Giza- or
Zyfai-managed allocation requires only deploying a new IStrategyAdapter
wrapper, not changing the vault contract.

### Morpho Gauntlet USDC Prime

A curated ERC-4626 vault on Base, managed by Gauntlet, that optimally
allocates USDC across Morpho Blue lending pools. It is itself a vault —
the MorphoAdapter holds Morpho Gauntlet shares, not raw Morpho Blue
positions — which means depositors benefit from Gauntlet's active
allocation without the stable-yield vault needing to manage Morpho Blue
directly. This two-layer structure (Robot Money vault → Morpho Gauntlet
vault → Morpho Blue pools) is a practical example of the multi-vault
nesting the Portfolio Router generalises.

## 11. Vault Catalog

This section specifies the product properties of each Robot Money vault
category. Technical implementation details live in `docs/architecture.md`
and the contract source. The catalog is the product-level commitment:
risk label, fee structure, accepted asset, withdrawal model, and status.

### 11.1 Stable Yield Vault

| Property | Value |
| --- | --- |
| Name | Robot Money USDC |
| Receipt token | rmUSDC |
| Accepted asset | USDC (Base, 6 decimals) |
| Risk label | STABLE_YIELD |
| Exposure | USDC yield across Morpho Gauntlet USDC Prime, Aave V3, Compound V3 on Base |
| Allocation model | Equal-weight across active adapters; keeper-triggered rebalance |
| Exit fee | Configurable 0–1%; 0.1% at launch |
| Management fee | Not implemented in current phase |
| Swap-fee share | Not implemented in current phase |
| Withdrawal | Synchronous; single transaction |
| TVL cap | Configurable; launch cap amount is a business/ops decision tracked outside this repository |
| Per-deposit cap | Configurable |
| Status | Deployed on Base mainnet |

The stable-yield vault is the launch vault and the only vault currently
eligible for Portfolio Router allocation. Its synchronous redemption
guarantee is met through proportional withdrawal across all active
adapters in a single transaction. If any adapter cannot fulfil its
proportional share, the vault attempts to cover the shortfall from the
remaining adapters before reverting.

### 11.2 Protocol Asset Vault

| Property | Value |
| --- | --- |
| Name | Robot Money Protocol |
| Receipt token | rmPROTO |
| Accepted asset | USDC (Base, 6 decimals) |
| Risk label | VOLATILE |
| Exposure | Basket of protocol assets (wETH, cbBTC, wSOL) via Uniswap V3 swaps |
| Allocation model | Equal-weight across active basket assets at deposit time |
| Exit fee | Configurable 0–1% |
| Withdrawal | Synchronous; depends on swap liquidity |
| Status | Prototype — not audited, not Router-eligible |

Deposits swap USDC into basket assets; withdrawals swap back. NAV is
denominated in USDC and priced from a Uniswap V3 TWAP over an
admin-configured per-asset window; `slot0` is not consulted on hot
paths. Swap slippage means actual withdrawal proceeds may differ from
the preview by up to the configured slippage bound. Router eligibility
remains blocked by the unresolved intra-vault rebalancing model
(`docs/development/open-questions.md` §3.15); concrete subclasses must additionally certify pool
cardinality and per-asset window prerequisites before opting out of
prototype status.

### 11.3 Agent Token Vault

| Property | Value |
| --- | --- |
| Name | Robot Money Agent Tokens |
| Receipt token | rmAGENT |
| Accepted asset | USDC (Base, 6 decimals) |
| Risk label | SPECULATIVE |
| Exposure | Admin-curated basket of agent-economy tokens via Uniswap V3 swaps |
| Allocation model | Equal-weight across shortlisted tokens at deposit time |
| Exit fee | Configurable 0–1% |
| Withdrawal | Synchronous; depends on swap liquidity |
| Status | Prototype — not audited, not Router-eligible |

Shortlist curation is admin-controlled in the prototype. The production
model (bribery-based or RM-token inclusion vote) is unresolved
(`docs/development/open-questions.md` §1.3, §1.4, §3.15). TWAP pricing is shipped via the basket-vault base.
Router eligibility remains blocked by unresolved shortlist governance
and the intra-vault rebalancing model.

### 11.4 RWA / Thematic Vault

| Property | Value |
| --- | --- |
| Status | Future — not specified |

Flagged for narrative value (SP500 perp via Hyperliquid, commodities).
Requires separate legal, oracle, liquidation, disclosure, and redemption
work before inclusion in Portfolio Router allocations (a business/launch
decision tracked outside this repository).
