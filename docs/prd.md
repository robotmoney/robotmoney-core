# Product Requirements Document

## 1. Problem Statement

Robot Money helps autonomous agents, machine-operated businesses, and
human depositors put idle USDC to work without requiring each user to
manually assemble and monitor treasury exposure across multiple
strategies or product categories. Instead of managing each position by
hand, users get a hands-off managed allocation across strategies and
products — chosen and weighted for them — rather than having to select
and continuously tend each exposure themselves.

Primary users need a treasury product that supports direct vault
selection, a managed multi-vault allocation, transparent performance and
allocation reporting, and bounded autonomous-agent access. The product
is better than manual treasury management because users can choose an
exposure profile, preview the consequences of a deposit or withdrawal,
and rely on consistent controls across human and agent-operated flows.

Beyond the treasury surface, Robot Money provides an **agentic Investment
Committee**: a group of AI analysts that agree off-chain on a consensus
recommendation and sign it with their Ed25519 keys. The signed **consensus
recommendation receipt** is recorded on chain by an authorized submitter.
It is the only rebalancing signal the Safe may cite, and it is
signalling-only: it never moves funds or sets router weights until the Safe
applies it. The vector the Safe schedules through `applyReceipt` is the
input. The chain cannot parse the payload, so readers compare the applied
vector to the payload (owner decision 2026-10-20). It gives depositors
a transparent, multi-party, reproducible allocation rationale.

### Product Systems

Robot Money is two separate systems (owner decision, 2026-10-19).

- **Vaults system.** The treasury product. It holds the Robot Money
  vaults (rmUSDC, rmPROTO, rmAGENT, rmRWA), the vault registry, the
  Portfolio Router and router-weight governance. Its only rebalancing
  signal is the consensus recommendation receipt, recorded on the consensus
  receipt contract. The vector the Safe schedules through `applyReceipt`
  is the input. The Safe, through the TimelockController, grants the
  receipt submitter role. The submitter records receipts on the receipt
  contract directly. The Safe, through the TimelockController, applies a
  receipt to router weights or sets default weights. Human wallets deposit
  into a vault or the router directly.
- **rmpc gateway system.** `rmpc`, an agentic cryptographic signer for
  end users, and the Agent Permissions Gateway it needs for its one
  on-chain write (owner decision, 2026-10-19). `rmpc`'s other uses are
  off-chain: signing, keystores, the committee-identity Ed25519 signer,
  config export, and reads. The one on-chain write is an agent deposit
  into an allowed vault. The gateway decides whether an agent may deposit,
  how much, until when, for which depositor and share receiver, and into
  which allowed vault. It then forwards the permitted deposit to that
  vault.

The gateway system is a client of the vaults system. It calls the same
public vault deposit surface a human wallet uses. The vaults system
never depends on the gateway: no vaults-system contract names the
gateway or accepts writes only from it, and rebalancing works with no
gateway deployed. Each system is deployed in its own run and tested on
its own. The gateway is deployed after the vaults system and reads its
addresses for the allowed destinations. Who governs the gateway is an
open question for the gateway's own release.

## 2. Goals and Success Metrics

- Depositors can deposit USDC into a selected vault or a Portfolio
  Router allocation with a clear preview of destination, fees, expected
  receipts, and unavailable legs.
- Depositors can withdraw synchronously from eligible vaults and
  Portfolio Router paths.
- Autonomous depositors can authorize an agent to deposit into a vault
  with user-defined limits, allowed vaults, share receiver (always the
  owner), and expiration.
- The Safe multisig, through the TimelockController, is the only body
  that changes Portfolio Router target weights: the weight setter applies
  the Investment Committee's consensus receipt as one timelock operation.
  There is no voting by token holders or anyone else.
- Any user can inspect vault availability, allocation weights,
  performance, fees, governance state, and execution results.
- Product failures are explicit: users receive a product-level reason
  when an operation cannot proceed or only partially succeeds.
- Consensus sessions publish one subject-scoped receipt with a
  deterministic four-vault bps mean, judge-authored prose, and the analysts'
  off-chain Ed25519 signatures, committed on-chain by one submitter the Safe
  authorized through the timelock. Any user can inspect each receipt, its
  verification state, and whether the Safe applied it.

Success is measured by:

- successful deposit and withdrawal completion rate;
- percentage of attempted operations that provide a preview before user
  approval;
- percentage of failed operations that return a clear product reason;
- autonomous-agent activity that remains within depositor-defined limits;
- consensus receipts recorded, and the share the Safe applies to router
  weights through the timelock;
- user visibility into allocation, performance, fees, and state changes;
- the continuity and verification rate of published consensus receipts.

## 3. User Roles

- **Autonomous depositor.** An AI agent, autonomous machine, or
  agent-operated business that uses depositor-approved permissions to
  deposit into a vault and to observe positions. Withdrawals and
  redemptions are the depositor's own direct vault calls.
- **Human depositor.** A person who deposits USDC, chooses vault or
  Portfolio Router allocation exposure, withdraws funds, and monitors
  positions.
- **Protocol governance.** The Safe multisig acting through the
  TimelockController. It is the only body that changes any Robot Money
  contract configuration, router weights included. There is no
  governance voter role and no token-based governance.
- **Receipt submitter.** An address the Safe authorizes through the
  timelock with `RECEIPT_SUBMITTER_ROLE` on the consensus receipt contract.
  It records a consensus receipt that the analysts signed off-chain. It has
  no authority over funds or weights: only the Safe, through the timelock,
  applies a receipt.
- **Investment Committee analyst.** An AI analyst that signs consensus
  receipts off-chain with its Ed25519 key. It holds no on-chain role.
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
- There is no protocol agent key. An agent belongs to a depositor, runs
  `rmpc` with that depositor's key, and is authorized by that depositor
  through commit and reveal. The protocol deploy authorizes no agent
  (core 1527).
- Any user can view allocation-weight governance history: the consensus
  receipts the Safe applied through the timelock and the resulting
  weights. There is no voting by token holders or anyone else.
- Integrators can read public product state and submit user-authorized
  actions.
- A receipt submitter records receipts only while it holds
  `RECEIPT_SUBMITTER_ROLE`. A recorded receipt is signalling-only and
  cannot move funds or set router weights. The submitter calls the
  receipt contract of the vaults system directly, not through the
  gateway.
- Protocol operators can use product-wide safety controls, but cannot
  create, expand, or redirect an individual depositor's agent policy.
- Authorization depends on relationship: a depositor controls only their
  own positions, agent policies, recipients, and permissions.
- **NAV disclosure:** Vault shares are minted/redeemed proportional to realized NAV delta (ERC-4626 convention). User's share VALUE = market price of underlying assets; NAV is system accounting for protocol guards (growth limit, ORA-4 deviation, TVL cap). UI explicitly discloses this distinction at every point NAV appears.

## 4. User Stories

- As an autonomous depositor, I want to sweep idle USDC into an approved
  treasury destination so that surplus operating funds can earn exposure
  without giving the agent unrestricted control.
- As a human depositor, I want to choose a vault or Portfolio Router
  allocation and preview the result before approving so that I
  understand where my funds go and what I receive.
- As a human depositor, I want to get funds out in a single transaction
  with no queue — withdrawing a chosen amount from the stable-yield
  product, or redeeming my shares for their current value from a basket
  product — so that funds are available when needed.
- As a Safe signer, I want to apply the Investment Committee's consensus
  receipt to the Portfolio Router target weights as one timelock
  operation, so that every rebalance is a scheduled, delayed and
  observable governance action. There is no voting by token holders or
  anyone else.
- As a depositor, I want to see each consensus receipt, its off-chain
  analyst signatures, its verification state, and whether it was applied,
  so that I can judge the allocation rationale before it informs router
  weights.
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
4. The product settles the withdrawal in a single transaction with no
   queue — a chosen amount for the stable-yield product, or shares
   redeemed for their current value for a basket product — and reports
   the result.

### Autonomous Treasury Sweep

This workflow belongs to the rmpc gateway system. The gateway forwards
each permitted deposit to the vault's public deposit surface.

1. A depositor authorizes an agent and defines allowed vaults, maximum
   amounts, share receiver (always the owner), and expiration.
2. The agent observes available balance, policy limits, and vault state.
3. The agent requests a deposit into an allowed vault within the
   depositor's limits.
4. The product refuses requests outside policy, unavailable
   destinations, or insufficient balances.
5. Approved activity settles and is reported to the depositor and agent.

### Allocation Governance

This workflow and the Consensus Receipt workflow belong to the vaults
system. Neither needs the gateway.

The Safe multisig, through the TimelockController, is the only body that
changes any Robot Money contract configuration, router weights included.
`WEIGHT_SETTER_ROLE` is the only authority over router weights. The Safe
schedules `applyReceipt` through the timelock; `RouterGovernance` holds
`WEIGHT_SETTER_ROLE` and that one call is the rebalance. It releases the
Investment Committee's consensus receipt and applies its weights in one
timelock operation (govern row `apply-receipt`, core 1696). There is no voting by
token holders or anyone else: no voter set, no voting power, no quorum,
no voting period, no propose, vote or execute. `RouterGovernance` has no
voting function (issue 1698): the weight setter's one call is `applyReceipt`. There is no tier system
(Observer / Participant / Analyst / Strategist) and no activity gate.

1. A receipt submitter records the Investment Committee's consensus receipt
   with a weight vector over the router-eligible vaults.
2. The Safe schedules `apply-receipt` through the timelock: one
   `applyReceipt` call that releases the receipt and applies its weights.
3. The timelock delay elapses and the Safe executes the operation.
4. The product publishes the released receipt, the execution state, and
   the resulting allocation weights.
5. Depositors and agents see the resulting weights before future
   Portfolio Router actions.

The consensus receipt (see the Consensus Receipt workflow) is the only
upstream input to this flow. It is signalling-only: applying weights
remains admin-applied. The committee never sets weights directly.

### Consensus Receipt

NOTE: The Investment Committee's recommendation is a distinct mechanism
from the admin-applied allocation-weight governance above. There is no
voting. The committee's output never auto-applies to router weights.

1. The Safe, through the timelock, grants `RECEIPT_SUBMITTER_ROLE` on the
   consensus receipt contract to a submitter.
2. The committee's analysts reach a consensus recommendation off-chain
   and each signs the receipt payload with its Ed25519 key.
3. The submitter verifies the payload digest and every embedded analyst
   signature, then records the receipt on the receipt contract directly.
   A caller without the submitter role is refused.
4. The product publishes each receipt, its verification state, its
   released state, and whether it was applied.
5. The Safe applies a receipt it chooses through the timelock (the
   Allocation Governance workflow), or leaves it recorded and not
   released.

A receipt represents one frontend swarm session and its one subject, is
served from the stable `GET /api/swarm/receipts/{session_id}` path, and
carries a dapp-visible count of embedded off-chain analyst signatures.
Release has no automatic signature threshold: the Safe applies a receipt
after human review as one timelock operation, and no worker may schedule or
execute that operation unattended.

### Integrator Read And Action Flow

1. The integrator reads vault registry, allocation weights, position
   state, fees, and availability.
2. The integrator presents product-level previews and refusal reasons to
   its user or agent.
3. User-authorized actions are submitted only after the relevant preview
   and permission checks.
4. Results are returned with enough detail for downstream reporting.

Common edge cases:

- selected destination has deposits paused, is retired, full, or unavailable
  (this refuses a deposit only; a withdrawal is never refused for a pause);
- requested amount exceeds depositor, vault, allocation, or agent limits;
- withdrawal path cannot meet synchronous settlement requirements;
- a Portfolio Router allocation leg is unavailable, causing the whole deposit to revert;
- account balance or approval is insufficient;
- agent permission is expired, revoked, or scoped to a different
  destination;
- the timelock weight operation is cancelled, fails, or is not yet executable;
- external market, liquidity, valuation, or compliance constraints make
  a strategy temporarily unavailable.

## 6. Entity Lifecycle

- **Vault.** Proposed -> active -> deposits paused -> active; active -> retired;
  retired -> redeemable archive when redemptions remain available. A retired
  vault remains withdraw-only: existing depositors keep standard ERC-4626
  redemption at any time, the router routes no new deposits into it, and the
  protocol performs no forced or assisted on-chain migration of depositor funds.
  Any migration to a successor vault is user-initiated and user-signed at the app
  layer (redeem, then deposit) — the protocol never moves a depositor's funds
  without that depositor's own transaction.
- **Portfolio Router allocation.** Default weights -> applied weights (a
  consensus receipt applied through the timelock) -> replaced by the next
  applied receipt; applied weights -> default weights when the Safe clears
  them through the timelock. A weight operation the Safe cancels before
  execution changes nothing.
- **Depositor position.** No position -> previewed deposit -> active
  position -> previewed withdrawal -> reduced or closed position.
- **Agent policy.** Draft -> active -> updated -> revoked; active ->
  expired when its validity window ends. There is no paused state. The
  owner or the agent itself revokes; no admin can (owner decision
  2026-10-20).
- **Agent deposit.** Requested -> previewed -> approved -> settled into
  one allowed vault; requested or previewed -> refused.
- **Consensus receipt.** Recorded -> scheduled on the timelock ->
  released and applied in one operation, or cancelled before execution.
- **Receipt submitter.** Granted by the Safe through the timelock ->
  active -> revoked by the Safe through the timelock. Receipts it recorded
  stay readable after revocation.
- **Fee schedule.** Proposed -> published -> active -> superseded.
- **Incident control.** Normal -> deposits paused -> normal; normal or
  deposits paused -> shutdown. New deposits can be halted for incident
  response while existing holders can always redeem. Withdrawals are never
  blocked, by anyone.

## 7. Integration Needs

- **Wallet or account authorization.** Triggered when a depositor
  connects, approves a deposit or withdrawal, or manages an agent policy,
  and when a Safe signer signs a timelock operation.
- **Digital asset transfer and settlement.** Triggered by deposits,
  withdrawals, fee collection, allocation changes, and buyback activity.
- **Market access and valuation.** Triggered when vaults need asset
  pricing, liquidity checks, performance reporting, or strategy
  execution.
- **Governance participation.** Triggered by the Safe scheduling,
  cancelling or executing a timelock operation, weight publication, and
  execution reporting.
- **Consensus receipt publication.** Triggered by the Safe granting a
  submitter through the timelock, analysts signing a receipt off-chain,
  the submitter recording it directly on the receipt contract, and the
  receipt payload being served at its stable public URI.
- **Public state indexing and reporting.** Triggered by deposits,
  withdrawals, policy changes, governance actions, allocation changes,
  fee events, incident controls, and consensus receipts.
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
- Agent-created vaults or agent-created assets. No agent has direct
  control over governance changes, router weights, or funds.
- On-chain committee voting or on-chain committee tilts. The committee's
  only on-chain output is the consensus receipt.
- Token-based governance of any kind. Governance never covers vault
  internals, per-vault asset selection, strategy selection, fees, or
  individual agent permissions.
- Hosted custody or hosted signing services.
- Vault categories whose legal, liquidity, valuation, and disclosure
  requirements are not specified.

## 9. Constraints

- Deposits and withdrawals must provide a preview before user approval.
- Withdrawals must settle in a single transaction with no queue: the
  stable-yield product lets a holder withdraw a chosen amount, and basket
  products let a holder redeem shares for their current value.
- Product surfaces must expose fees, net amounts, destinations,
  recipients, limits, and refusal reasons in user-facing language.
- **NAV disclosure in UIs:** Whenever NAV is displayed (position value, preview estimates, performance metrics), the surface must include the disclaimer: "NAV is the protocol's system-level valuation, used for growth limits and guards. Your share value = market price of underlying assets. See help for details."
- Product surfaces must itemize fees and slippage in user-facing language where preview estimates diverge from market-adjusted outcomes.
- Autonomous-agent access must remain bounded by depositor-defined
  amount limits, allowed vaults, share receiver (always the owner), and
  expiration. An agent's only on-chain action is a deposit into a vault.
- A depositor must remain the authority over their own agent policy.
- Product-wide safety controls must not grant operators authority to
  redirect user funds or expand an individual agent's permissions.
- The Portfolio Router must expose target weights, active weights,
  governance state, and historical outcomes.
- Receipt submissions must go directly to the receipt contract of the
  vaults system, never through the gateway. A recorded receipt is
  signalling-only and must not move funds or set router weights directly.
  Submitter authority is admin-gated through the timelock. The receipt
  payload is a fixed, schema-validated shape, and each receipt carries the
  analysts' Ed25519 signatures verified off-chain.
- The vaults system must not depend on the rmpc gateway system. Deposits,
  withdrawals, receipt submission and rebalancing must work with no gateway
  deployed. The gateway may call only a vault's public deposit surface.
- Vault and Portfolio Router fee structures are limited to three
  classes: management fee, swap-fee share, and exit fee. Each fee
  class, its rate, and its recipient must be disclosed before user
  approval. In the current phase only exit fees are implemented (the live rmUSDC vault charges 25 bps);
  management fee and swap-fee share are deferred to a future phase.
- Vaults must disclose risk labels, fees, caps, availability, and
  retirement or pause state.
- Proxy-backed contracts must disclose their current implementation
  and whether upgrades remain possible. A final mainnet release must offer a
  freeze-at-deploy choice or an explicitly governed, time-bounded proving
  period followed by irreversible freeze; see
  `docs/technical/contract-upgradeability-plan.md`. Current direct
  deployments have no in-place upgrade path. The contracts expose both
  facts on chain (`upgradesFrozen()` and the ERC-1967 implementation slot,
  issue 1808); surfacing them to users is upgradeability stage 3.
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
(yield venues). The Robot Money stable-yield product reproduces this
pattern: each strategy is normalized behind a common interface, deposits
spread across the active strategies toward an equal-weight target, and
the mix is kept near that target through ordinary deposit and withdrawal
activity rather than scheduled trading. The asymmetric pause behavior —
new deposits can be halted for incident response while existing holders
can always redeem, so withdrawals are never blocked — is also borrowed
from Yearn's security design.

### Giza and Zyfai

Giza and Zyfai are yield optimization protocols on Base that allocate
USDC across Aave, Compound, and Morpho by utilization-driven or
off-chain-optimized weight models. Both are candidates for the stable-yield
vault's adapter layer if the team revisits the decision to maintain
custom adapters in-house (build-in-house is decided). The current architecture is built
to support either model: swapping a custom adapter for a Giza- or
Zyfai-managed allocation requires only deploying a new IStrategyAdapter
wrapper, not changing the vault contract.

### Moonwell Flagship USDC

A curated ERC-4626 vault on Base (mwUSDC) that allocates USDC across Morpho Blue
lending pools. It is itself a vault: the MorphoAdapter holds Moonwell Flagship
shares, not raw Morpho Blue positions, so depositors benefit from the curator's
active allocation without the stable-yield vault managing Morpho Blue directly.
This two-layer structure (Robot Money vault, Moonwell Flagship vault, Morpho Blue
pools) is a practical example of the multi-vault nesting the Portfolio Router
generalises. The owner chose Moonwell Flagship as the third venue (2026-10-02,
core 1485): it is the address in the deploy script and the name the manifest records.

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
| Exposure | USDC yield across Moonwell Flagship USDC, Aave V3, Compound V3 on Base |
| Allocation model | Equal-weight target across strategies; the mix is kept near target through ordinary deposit and withdrawal activity |
| Exit fee | Configurable 0–1%; the live rmUSDC vault charges 25 bps (0.25%) |
| Management fee | Not implemented in current phase |
| Swap-fee share | Not implemented in current phase |
| Withdrawal | Synchronous; single transaction |
| TVL cap | Configurable; launch cap amount is a business/ops decision tracked outside this repository |
| Per-deposit cap | Configurable |
| Status | Deployed on Base mainnet |

**Initial deposit state, one rule for all four vaults** (`scripts/deploy/stage-table.json` `vaults[].deployPaused` and `unpauseInStage13`, issue 1705): all four vaults deploy paused, and stage 13 unpauses all four through the Safe and the timelock.
All four vaults (rmUSDC, rmPROTO, rmAGENT, rmRWA) open deposits on day 2
of the mainnet launch. All four vaults are deployed paused (rmUSDC pauses
right after its seed deposit) and are unpaused only by Safe → Timelock
governance, one timelock operation per vault, executed after the timelock
delay (stage 13: four unpause rows, core #1710).
The timelock's proposer and canceller is the Safe (2-of-3), any address may
execute a ready operation after the delay, and the delay floor on Base is
48 hours (core #1521: `DeployTimelock` opens `EXECUTOR_ROLE` to
`address(0)` and the stage 12 verifier checks it). All products are
eligible for Portfolio Router allocation — four initially, extensible to
more — weighted by recommendation, once each passes its readiness review.
The router default weights at
launch are rmUSDC 9500, rmPROTO 500, rmAGENT 0, rmRWA 0 bps; later changes
come only from the Safe applying an Investment Committee consensus receipt
through the weight setter (`RouterGovernance.applyReceipt`, through the
timelock, core #1698). There is no voting. The
stable-yield product's single-transaction redemption is met through
proportional withdrawal across all active strategies in one transaction.
If any strategy cannot fulfil its proportional share, the product covers
the shortfall from the remaining strategies before reverting.

### 11.2 Protocol Asset Vault

| Property | Value |
| --- | --- |
| Name | Robot Money Protocol |
| Receipt token | rmPROTO |
| Accepted asset | USDC (Base, 6 decimals) |
| Risk label | VOLATILE |
| Exposure | Basket of protocol assets via Uniswap V3 swaps: wETH and cbBTC at launch; wSOL is added later through the timelock |
| Allocation model | Equal-weight target across basket assets at deposit time; not actively rebalanced |
| Exit fee | Configurable 0–1% for rmPROTO on its own; the rmUSDC rate does not apply. The rate is set at deploy and changes only through the timelock; its current value must be disclosed before approval |
| Withdrawal | Holders redeem shares for current value in a single transaction, subject to available liquidity within the stated limit |
| Status | Router-eligible after readiness review (see below) |

Deposits convert USDC into the basket assets; withdrawals convert back.
The product is valued in USDC using a manipulation-resistant on-chain
price for each asset held. Because conversions incur slippage, actual
withdrawal proceeds may differ from the preview by up to the disclosed
slippage limit.

Composition drift: the basket is set to an equal-weight target at deposit
time, and the product does not actively trade to restore that target as
prices move. A holder's exposure therefore changes over time as basket
asset prices move; holders always own their true pro-rata share of
whatever is held. No value is lost to this drift — it is a risk
characteristic to be aware of.

Redemption policy: depositors always redeem at the current per-share NAV.
Drawdowns are borne pro-rata by the redeeming depositor — the per-share NAV
already reflects any decline in basket asset prices — bounded by the slippage
cap. There is no forced sale and no withdrawal queue; redemption is synchronous,
pro-rata, and instant. A redemption that cannot clear within the slippage cap
reverts rather than settling at a catastrophic price.

Router eligibility is gated on a readiness review confirming that the
product is soundly valued and that a holder can exit within its stated
limits:

1. **Withdrawal-preview criterion** — the withdrawal preview returns a
   bound that includes worst-case slippage, and the Portfolio Router
   will not route into any product whose preview deviates from the
   realised amount by more than the disclosed tolerance.
2. **Valuation-and-liquidity criterion** — the product's holdings can be
   priced with a manipulation-resistant on-chain price and redeemed
   reliably within the disclosed limits.

A product must pass this readiness review before it can receive Portfolio
Router allocation.

### 11.3 Agent Token Vault

| Property | Value |
| --- | --- |
| Name | Robot Money Agent Tokens |
| Receipt token | rmAGENT |
| Accepted asset | USDC (Base, 6 decimals) |
| Risk label | SPECULATIVE |
| Exposure | Admin-curated basket of agent-economy tokens via per-asset DEX routing (one venue per asset) — see [ADR-0005](adr/ADR-0005-basketvault-multi-dex-routing.md) |
| MVP shortlist | BNKR, JUNO, RM (Base-chain only) — hand-picked per [ADR-0001](adr/ADR-0001-mvp-agent-token-shortlist.md); RM at launch, BNKR and JUNO added later through the timelock; current membership and per-asset swap venue in `config/agent-token-shortlist.json` |
| Allocation model | Equal-weight target across shortlisted tokens at deposit time; not actively rebalanced |
| Exit fee | Configurable 0–1% for rmAGENT on its own; the rmUSDC rate does not apply. The rate is set at deploy and changes only through the timelock; its current value must be disclosed before approval |
| Withdrawal | Holders redeem shares for current value in a single transaction, subject to available liquidity within the stated limit |
| Status | Router-eligible after readiness review (see below) |

Shortlist curation is admin-controlled for the MVP, with an
equal-weighted target basket drawn from BNKR, JUNO, RM (Base-chain
only). rmAGENT launches holding RM only: the existing ROBOTMONEY token on
Base at `0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3` (core #1491).
BNKR and JUNO are added later through the timelock. Each token
routes through one venue under the per-asset venue abstraction in
[ADR-0005](adr/ADR-0005-basketvault-multi-dex-routing.md). RM's venue is
decided (owner, 2026-10-08; supersedes 2026-10-06): the Uniswap V4 RM/USDC pool with fee 2.91%
(id `0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252391`, tickSpacing 582, no hooks). The vault
swaps through `UniswapV4SwapAdapter` and prices RM from `UniswapV4PriceRecorder`, a permissionless in-protocol
observation recorder (a hookless V4 pool keeps none). The owner called this sufficient for the Base mainnet
test, not for the final deployment: the first mainnet run is a contained test with low caps sized below the pool depth,
and a stronger price source is a later decision. If no one has recorded for 30 minutes deposits and USDC redeems fail
closed, and `redeemInKind` still pays RM. Current
membership, venues, and pool parameters live in
`config/agent-token-shortlist.json`. Changes flow through the Safe →
Timelock → `ADMIN_ROLE` path with a mandatory timelock delay and public
veto window (see
[ADR-0004](adr/ADR-0004-agent-token-shortlist-governance.md)); there is
no token-holder vote over shortlist membership, and no token-based
governance is foreseen. Basket products are valued using a manipulation-resistant
on-chain price for each asset held.

This product has no in-product agent trading authority or strategy: it is
an admin-curated, equal-weight target basket whose mix shifts with prices
and is not actively rebalanced, not a discretionary trading vehicle.
Autonomous trading (strategy, position-sizing, stop-loss, loss reporting)
is an explicit non-goal of this product. As prices move, the product's
exposure changes over time; it does not trade to restore the target
allocation, and holders always own their true pro-rata share of whatever
is held. No value is lost to this drift — it is a risk characteristic to
be aware of.

Redemption policy: identical to rmPROTO (§11.2) — depositors redeem at the
current per-share NAV, drawdowns are borne pro-rata and bounded by the slippage
cap, and there is no forced sale or withdrawal queue.

Router eligibility is gated on a readiness review confirming that the
product is soundly valued and that a holder can exit within its stated
limits:

1. **Withdrawal-preview criterion** — same requirement as rmPROTO (§11.2).
2. **Valuation-and-liquidity criterion** — same requirement as rmPROTO
   (§11.2).
3. **Shortlist-governance criterion** — the process for curating basket
   membership is specified and in force, and the deployed shortlist
   consists exclusively of the Base-chain set {BNKR, JUNO, RM}.

A product must pass this readiness review before it can receive Portfolio
Router allocation.

### 11.4 RWA / Thematic Vault

| Property | Value |
| --- | --- |
| Name | Robot Money RWA |
| Receipt token | rmRWA |
| Accepted asset | USDC (Base, 6 decimals) |
| Risk label | SPECULATIVE |
| Underlying asset | Centrifuge deSPXA — tokenized S&P 500 exposure via Janus Henderson / Anemoy, issued on Centrifuge V3 and bridged to Base |
| Oracle | None: a plain basket row priced from the TWAP of deSPXA's Uniswap V3 USDC pool (fee 500) |
| Entry / exit | Swaps in deSPXA's Uniswap V3 USDC pool (fee 500) only; ERC-7540 primary NAV redeem (Centrifuge V3) is never used by this vault |
| Status | Router-eligible after readiness review (see below) |

The RWA/Thematic vault holds deSPXA (Centrifuge V3, Base deployment).
deSPXA is a tokenized representation of S&P 500 exposure, issued by
Janus Henderson / Anemoy through the Centrifuge V3 protocol. The vault
enters and exits positions exclusively via swaps in deSPXA's Uniswap V3
USDC pool (fee 500); it does not invoke ERC-7540 primary redemption
against the Centrifuge issuer, avoiding the primary NAV redemption queue
entirely. Coinbase tokenized stocks are phase two (core #1500).

The vault has no oracle. deSPXA is a plain basket row priced from the
TWAP of that Uniswap V3 pool, the same way rmPROTO prices its assets.

**Issuer freeze-control risk disclosure:** deSPXA is subject to
Centrifuge and Janus Henderson issuer controls. The issuer may freeze
or restrict transfers of the underlying token at any time, which would
block vault entry and exit independently of pool liquidity. This
risk is disclosed to depositors in the dapp vault detail page and is a
known, accepted product risk for this vault category.

Holders redeem their shares for current value in a single transaction;
proceeds reflect the realized value at redemption, bounded by a slippage
limit, and a redemption that cannot clear within that limit does not
proceed. The Portfolio Router may allocate to this product once it passes
the standard readiness review — its holdings can be priced and it can be
exited within its stated limits.

## 12. Security invariants

The protocol is non-custodial and enforces three custody invariants. They
mitigate at source — preventing stranded or mis-routed assets — rather than
relying on after-the-fact recovery. They are the source of truth for the
contract surface; the implementing code lives in `contracts/`
(`ForeignTokenQuarantine.sol`, the vaults, the router, and the strategy
adapters) and is documented in `docs/architecture.md`,
`docs/technical/smart-contracts.md`, and
`docs/technical/adapter-architecture.md`.

**INV-1 — No arbitrary admin routing.** No admin, operator, or product
control may route a protocol or depositor asset to a recipient chosen by
the caller. There is no discretionary "rescue" path that could send held
assets to an arbitrary address. The only asset movement an operator can
trigger is recovering non-whitelisted, already-quarantined tokens from a
fixed quarantine address, and only through multisig-plus-offline
governance.

**INV-2 — No stranded assets.** Every protocol or depositor asset is always
redeemable by holders or absorbed into the product's value: donated assets
accrue pro-rata to all holders (assets a product holds are always reflected
in its value, and the accounting is protected against share-inflation
manipulation); underlying-strategy emissions are harvested into the product;
a balance that reappears on an asset that was removed from a basket is
re-absorbed into the product's value and credited to holders, never routed to
an admin; rounding and dust always favor holders, never the router or the fee
recipient; and the router holds no leftover funds after operations. Foreign
tokens sent in by mistake cannot be rejected on receipt nor returned to sender
(the sender is not knowable on-chain), so they are inert (uncounted,
un-redeemable) and can additionally be swept, by anyone, to a single fixed
quarantine address so nothing is permanently stuck; the destination is fixed
in advance, never caller-supplied. An offline multisig governance process
empties the quarantine address as the reverse-mistakes safety valve.

**INV-3 — Governance-gated fee and quarantine control.** The fee recipient,
the fee parameters, and the quarantine address change only through
multisig-plus-timelock governance; changes attempted outside that path do not
take effect. This is the same graduated-authority model used for the
protocol's deliberate value and lifecycle actions: permissionless actions
(foreign-token sweep, harvest trigger) need no privilege; emergency actions
can only de-risk, never extract — new deposits can be halted for incident
response while existing holders can always redeem, so withdrawals are never
blocked; and governance actions (unpause deposits, restore, retire, fee-recipient and
fee-parameter changes, strategy add/allowlist/caps, quarantine set and
recover) require multisig plus timelock. Depositor principal is moved by the
depositor alone.

**INV-4 — Committee output is applied only by the weight setter through the
timelock.** The consensus receipt contract holds only receipt digests,
their URIs, their submitters and their released state; it grants no
treasury-spend and no auto-apply authority. Receipt writes cannot move
depositor or protocol funds and cannot set Portfolio Router weights
directly. The committee's consensus receipt reaches live weights on exactly
one path: the Safe, through the TimelockController, schedules one operation
that releases the receipt and applies its weight vector through
`WEIGHT_SETTER_ROLE` (govern row `apply-receipt`, core 1696). No submitter,
analyst or EOA can release a receipt or set weights. The submitter calls
the receipt contract directly, not through the gateway. Only the Safe,
through the timelock, grants `RECEIPT_SUBMITTER_ROLE`. The receipt contract itself
cannot call the router: the weight setter's `applyReceipt` releases the
receipt and applies its weights in one call (issue 1698).
