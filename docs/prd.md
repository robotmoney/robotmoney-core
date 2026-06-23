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

Beyond the treasury surface, Robot Money provides an **agentic Investment
Committee**: an admin-allowlisted set of registered, signed AI agents that
read a shared market-regime feed and publish auditable per-vault
allocation tilts over the vaults. The committee's output is an upstream,
signalling-only input to allocation governance — it never moves funds or
sets router weights directly. It gives depositors a transparent,
multi-party, reproducible allocation rationale and gives third-party
organizations a way to contribute visible allocation signals.

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
- Admin-allowlisted committee agents can register an on-chain identity
  and submit signed, fixed-shape allocation-tilt votes over the vaults,
  each referencing a public rationale memo; any user can inspect
  registered agents, their votes, and their per-agent track record.

Success is measured by:

- successful deposit and withdrawal completion rate;
- percentage of attempted operations that provide a preview before user
  approval;
- percentage of failed operations that return a clear product reason;
- autonomous-agent activity that remains within depositor-defined limits;
- governance participation in allocation-weight votes;
- user visibility into allocation, performance, fees, and state changes;
- number of registered committee agents and of third-party agents
  producing live allocation output, plus the visibility and continuity of
  each agent's published track record.

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
- **Committee agent.** An admin-allowlisted AI agent, operated by a
  participating organization, that holds a registered on-chain identity
  and submits signed per-vault allocation-tilt votes over the vaults. It
  is distinct from an *autonomous depositor* (which sweeps treasury funds)
  and from a *governance voter* (which votes directly on router target
  weights): a committee agent only produces signalling-only allocation
  tilts that feed allocation governance upstream, and has no authority
  over funds or weights.
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
- Committee agents can register an identity and submit signed votes only
  while admin-allowlisted; their votes are signalling-only and cannot move
  funds or set router weights. All committee actions route through the same
  gateway entrypoint as other product actions, with no side channel.
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
- As a committee agent operated by a participating organization, I want to
  register a signed on-chain identity and submit a fixed-shape per-vault
  allocation-tilt vote referencing a public rationale memo, so that my
  allocation read is auditable, attributable to my organization, and builds
  a visible track record without my proprietary methods being exposed.
- As a depositor, I want to see the committee's registered agents, their
  current per-vault tilts, and each agent's track record so that I can
  judge the allocation rationale before it informs router weights.
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
ADMIN_ROLE-only. Token-holder voting is a future goal. Governance is
flat in the MVP — there is no tier system (Observer / Participant /
Analyst / Strategist) and no activity gate. Tiering is deferred past
MVP and is not on the build list.

1. An address with admin-assigned voting power reviews active
   allocation-weight proposals, target weights, timing, and expected
   impact.
2. The voter votes.
3. The product publishes vote outcome, execution state, and resulting
   allocation weights.
4. Depositors and agents see the resulting weights before future
   Portfolio Router actions.

Committee allocation tilts (see the Committee Vote workflow) are an
upstream, signalling-only input to this flow: aggregated committee output
informs proposed target weights, but applying weights remains
admin-applied. The committee never sets weights directly.

### Committee Vote

NOTE: Committee allocation signalling is a distinct mechanism from the
admin-weighted allocation-weight governance above. A committee agent does
not vote on router target weights; it publishes a signed per-vault tilt
that feeds weight governance upstream. Membership is admin-gated, and
committee output never auto-applies to router weights — it remains an
upstream signal.

1. An admin allowlists a participating organization's agent; the agent
   registers a signed on-chain identity through the gateway entrypoint.
2. The agent reads the shared market-regime feed and current holdings.
3. The agent forms a per-vault tilt (overweight / neutral / underweight)
   across the existing vaults and posts a narrative rationale memo to a
   public link.
4. The agent signs and submits a fixed-shape vote — referencing the memo
   and the inputs it consumed — routed through the gateway and registered
   on-chain. Votes from non-allowlisted agents are refused.
5. The product publishes the registered agents, their current and
   historical votes, and each agent's track record.
6. Aggregated committee tilts become a signalling input to allocation
   governance; any application to live router weights remains
   admin-applied.

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
  retired -> redeemable archive when redemptions remain available. A retired
  vault remains withdraw-only: existing depositors keep standard ERC-4626
  redemption at any time, the router routes no new deposits into it, and the
  protocol performs no forced or assisted on-chain migration of depositor funds.
  Any migration to a successor vault is user-initiated and user-signed at the app
  layer (redeem, then deposit) — the protocol never moves a depositor's funds
  without that depositor's own transaction.
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
- **Committee agent registration.** Allowlisted -> registered (signed
  on-chain identity) -> active -> deactivated when removed from the
  allowlist. A deactivated agent's historical votes and track record remain
  readable.
- **Committee vote.** Formed -> signed -> submitted -> registered on-chain
  -> superseded by the agent's next vote. A registered vote is immutable;
  corrections are made by submitting a new vote. Committee votes are
  signalling-only and never transition product funds or router weights.
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
- **Committee participation.** Triggered by agent allowlisting, on-chain
  identity registration, vote signing and submission through the gateway,
  publication of the shared market-regime feed, and posting of off-chain
  rationale memos to public links referenced by each vote.
- **Public state indexing and reporting.** Triggered by deposits,
  withdrawals, policy changes, governance actions, allocation changes,
  fee events, incident controls, committee registrations, committee votes,
  and per-agent track record.
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
- Agent-created vaults or agent-created assets. Committee agents produce
  signalling-only allocation tilts; no agent has direct control over
  governance changes, router weights, or funds.
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
- Committee actions must route through the gateway entrypoint with no side
  channel; committee votes are signalling-only and must not move funds or
  set router weights directly; committee membership is admin-gated; the
  committee vote payload is a fixed, schema-validated shape; and committee
  provenance is established by a registered, signed on-chain identity tied
  to a participating organization. Each registered vote must reference a
  publicly readable rationale memo.
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
| Status | Router-eligible after hardening gates (see below) |

Deposits swap USDC into basket assets; withdrawals swap back. NAV is
denominated in USDC and priced from a Uniswap V3 TWAP over an
admin-configured per-asset window; `slot0` is not consulted on hot
paths. Swap slippage means actual withdrawal proceeds may differ from
the preview by up to the configured slippage bound.

Redemption policy: depositors always redeem at the current per-share NAV.
Drawdowns are borne pro-rata by the redeeming depositor — the per-share NAV
already reflects any decline in basket asset prices — bounded by the slippage
cap. There is no forced sale and no withdrawal queue; redemption is synchronous,
pro-rata, and instant. A redemption that cannot clear within the slippage cap
reverts rather than settling at a catastrophic price.

Router eligibility is gated on all of the following hardening criteria
being satisfied and formally certified for a given deployment:

1. **Slippage-preview gate** — `previewWithdraw` returns a bound that
   includes worst-case Uniswap V3 swap slippage; the Portfolio Router
   will not route into any vault whose preview deviates from the
   realised amount by more than the configured tolerance.
2. **Rebalancing model gate** — the intra-vault rebalancing strategy
   (drift limits, timing, allowed DEX routes) is specified in a merged
   ADR and implemented in the contract; open question §3.15 in
   `docs/development/open-questions.md` is closed.
3. **Liquidity-proof gate** — per-asset pool cardinality and TWAP
   window prerequisites are met and verified on-chain; `slot0` is never
   consulted on hot paths.

Until all three gates are certified for a given deployment, the vault
subclass must not be added to the Portfolio Router weight vector.

### 11.3 Agent Token Vault

| Property | Value |
| --- | --- |
| Name | Robot Money Agent Tokens |
| Receipt token | rmAGENT |
| Accepted asset | USDC (Base, 6 decimals) |
| Risk label | SPECULATIVE |
| Exposure | Admin-curated basket of agent-economy tokens via per-asset DEX routing (Uniswap V3, Uniswap V4, Aerodrome) — see [ADR-0005](adr/ADR-0005-basketvault-multi-dex-routing.md) |
| MVP shortlist | BNKR, JUNO, RM (Base-chain only) — hand-picked per [ADR-0001](adr/ADR-0001-mvp-agent-token-shortlist.md); current membership and per-asset swap venue in `config/agent-token-shortlist.json` |
| Allocation model | Equal-weight across shortlisted tokens at deposit time |
| Exit fee | Configurable 0–1% |
| Withdrawal | Synchronous; depends on swap liquidity |
| Status | Router-eligible after hardening gates (see below) |

Shortlist curation is admin-controlled for the MVP, with a fixed
three-token equal-weighted basket: BNKR, JUNO, RM (Base-chain
only). Each token routes through the DEX venue holding its deepest
liquidity — BNKR via Uniswap V3, JUNO via Uniswap V4, and RM
via Aerodrome — under the per-asset venue abstraction in
[ADR-0005](adr/ADR-0005-basketvault-multi-dex-routing.md); current
membership, venues, and pool parameters live in
`config/agent-token-shortlist.json`. Changes flow through the Safe →
Timelock → `ADMIN_ROLE` path with a mandatory timelock delay and public
veto window (see
[ADR-0004](adr/ADR-0004-agent-token-shortlist-governance.md)); there is
no token-holder vote over shortlist membership in the MVP. The
production model (bribery-based or RM-token inclusion vote) is deferred
past MVP. Per-venue TWAP pricing is shipped via the basket-vault base.

This vault has no in-vault agent trading authority or strategy: it is an
admin-curated, equal-weight custody-and-rebalance basket, not a discretionary
trading vehicle. Autonomous on-chain trading (strategy, position-sizing,
stop-loss, NAV-loss reporting) is an explicit non-goal of this product.

Redemption policy: identical to rmPROTO (§11.2) — depositors redeem at the
current per-share NAV, drawdowns are borne pro-rata and bounded by the slippage
cap, and there is no forced sale or withdrawal queue.

Router eligibility is gated on all of the following hardening criteria
being satisfied and formally certified for a given deployment:

1. **Slippage-preview gate** — same requirement as rmPROTO (§11.2).
2. **Rebalancing model gate** — same requirement as rmPROTO (§11.2);
   open question §3.15 in `docs/development/open-questions.md` is
   closed.
3. **Liquidity-proof gate** — same requirement as rmPROTO (§11.2).
4. **Shortlist-governance gate** — the shortlist governance model (admin
   path for MVP, deferred on-chain vote for production) is specified in
   a merged ADR ([ADR-0004](adr/ADR-0004-agent-token-shortlist-governance.md));
   the deployed shortlist consists exclusively of the Base-chain set
   {BNKR, JUNO, RM}.

Until all four gates are certified for a given deployment, the vault
subclass must not be added to the Portfolio Router weight vector.

### 11.4 RWA / Thematic Vault

| Property | Value |
| --- | --- |
| Name | Robot Money RWA / Thematic |
| Receipt token | rmRWA |
| Accepted asset | USDC (Base, 6 decimals) |
| Risk label | SPECULATIVE |
| Underlying asset | Centrifuge deSPXA — tokenized S&P 500 exposure via Janus Henderson / Anemoy, issued on Centrifuge V3 and bridged to Base |
| Oracle | Chronicle on-chain NAV oracle for deSPXA (Base), providing a signed, push-updated price feed |
| Entry / exit | Aerodrome secondary-market swap only; ERC-7540 primary NAV redeem (Centrifuge V3) is never used by this vault |
| Status | Active — real asset, seeded, Router-eligible |

The RWA/Thematic vault holds deSPXA (Centrifuge V3, Base deployment).
deSPXA is a tokenized representation of S&P 500 exposure, issued by
Janus Henderson / Anemoy through the Centrifuge V3 protocol. The vault
enters and exits positions exclusively via Aerodrome secondary-market
swaps; it does not invoke ERC-7540 primary redemption against the
Centrifuge issuer, avoiding the primary NAV redemption queue entirely.

NAV pricing is supplied by the Chronicle on-chain NAV oracle for
deSPXA on Base. The oracle is a signed, push-updated feed; the vault
reads the latest signed price and reverts if the feed is stale beyond
the configured heartbeat.

**Issuer freeze-control risk disclosure:** deSPXA is subject to
Centrifuge and Janus Henderson issuer controls. The issuer may freeze
or restrict transfers of the underlying token at any time, which would
block vault entry and exit independently of Aerodrome liquidity. This
risk is disclosed to depositors in the dapp vault detail page and is a
known, accepted product risk for this vault category.

The vault is registered in `VaultRegistry` as Active. The Portfolio
Router may allocate to it once the Chronicle oracle integration and
Aerodrome adapter are deployed and the vault passes the standard Router
eligibility checks (`isRouterEligible` returns true).

## 12. Security invariants

The protocol is non-custodial and enforces three custody invariants. They
mitigate at source — preventing stranded or mis-routed assets — rather than
relying on after-the-fact recovery. They are the source of truth for the
contract surface; the implementing code lives in `contracts/`
(`ForeignTokenQuarantine.sol`, the vaults, the router, and the strategy
adapters) and is documented in `docs/architecture.md`,
`docs/technical/smart-contracts.md`, and
`docs/technical/adapter-architecture.md`.

**INV-1 — No arbitrary admin routing.** No admin-, role-, or vault-gated
function may route a protocol or depositor asset to a caller-supplied
recipient. The historical arbitrary-recipient rescue functions
(`PortfolioRouter.rescueUsdc`, `RobotMoneyVault.rescueTokens`,
`BasketVault.rescueTokens`, and the Aave/Compound/Morpho adapter
`rescueTokens`) are deleted, along with `IStrategyAdapter.rescueTokens`. The
only asset movement an operator can trigger is recovering NON-whitelisted,
already-quarantined tokens from a separate fixed trash address, and only via
multisig + offline governance.

**INV-2 — No stranded assets.** Every protocol or depositor asset is always
redeemable by holders or absorbed into NAV: protocol-asset donations accrue
pro-rata to all holders (USDC idle balances and active basket-asset balances
are counted in `totalAssets`, safe from inflation via the 1e18 decimals
offset); underlying-protocol emissions are harvested to the vault; a balance
that reappears on a removed (inactive) basket asset is re-absorbed into NAV
via `BasketVault.reabsorbRemovedAsset` (swapped to USDC, credited to holders),
never routed to an admin; rounding and dust always favor holders, never the
router or the fee recipient; and the router holds zero USDC after operations.
Non-whitelisted foreign tokens cannot be rejected on receipt nor
returned-to-sender (the sender is not knowable on-chain), so they are inert
(uncounted, un-redeemable) but additionally get a **deterministic
permissionless sweep** to a single hardcoded quarantine ("trash") address via
`sweepForeignToken(token)` — so nothing is permanently stuck. Anyone may
trigger the sweep; the destination is a compile-time constant, never
caller-supplied. An offline multisig governance process empties the trash
address (the reverse-mistakes safety valve).

**INV-3 — Governance-gated fee and quarantine control.** The fee recipient,
the fee parameters, and the quarantine address change only through the
`TimelockController` (multisig + timelock); direct non-timelock calls revert.
This is the same graduated-authority model used for the protocol's deliberate
value and lifecycle actions: permissionless actions (foreign-token sweep,
harvest trigger) need no privilege; emergency actions (pause, emergency
withdraw to the vault only, force-remove adapter) use the hot emergency key
and can only de-risk, never extract; and governance actions (unpause, restore,
retire, fee-recipient and fee-parameter changes, adapter add/allowlist/caps,
quarantine set and recover) require multisig + timelock. Depositor principal
is moved by the depositor alone.

**INV-4 — Committee policy is signalling-only.** The Investment-Committee
policy contract holds only registered agents, their votes, and aggregated
tilts; it grants no treasury-spend and no auto-apply authority. Committee
writes cannot move depositor or protocol funds and cannot set Portfolio
Router weights directly — committee output is an upstream signal, and any
application to live weights stays on the admin-applied governance path. The
contract is reached only through the gateway entrypoint, and
registration/vote submission is restricted to admin-allowlisted agents.
