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
- Token holders can vote on target weights for the Portfolio Router
  allocation.
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
- **Token holder.** A `$ROBOTMONEY` holder who votes on target weights
  for the Portfolio Router allocation and observes protocol value
  capture.
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
- Token holders can participate in allocation-weight governance and view
  governance history.
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
- As a token holder, I want to vote on Portfolio Router target weights
  so that I can influence how the composite treasury exposure is
  balanced.
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

1. A token holder reviews active allocation-weight proposals, target
   weights, timing, and expected impact.
2. The token holder votes.
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
referenced in open questions or build-vs-buy decisions elsewhere in this
document.

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
vault and avoids creating a hidden custody layer (see §3.12).

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
custom adapters in-house (see §3.13). The current architecture is built
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
| TVL cap | Configurable; launch cap TBD (see §2, §3.4) |
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
denominated in USDC. Swap slippage means actual withdrawal proceeds may
differ from the preview by up to the configured slippage bound.
This vault requires a TWAP oracle replacing the current slot0 pricing and
a resolved rebalancing model (§3.15) before it is Router-eligible.

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
model (bribery-based or RM-token inclusion vote) is unresolved (§1.3,
§1.4, §3.15). This vault is not Router-eligible until shortlist
governance, TWAP pricing, and the rebalancing model are specified.

### 11.4 RWA / Thematic Vault

| Property | Value |
| --- | --- |
| Status | Future — not specified |

Flagged for narrative value (SP500 perp via Hyperliquid, commodities).
Requires separate legal, oracle, liquidation, disclosure, and redemption
work before inclusion in Portfolio Router allocations (§3.14).

# Robot Money — Open Questions

Unresolved questions derived from reading the three source documents kept locally under `docs/papers/`:

- `Robot-Money-Whitepaper-v01` (Protocol Specification v0.1, February 2026)
- `robot_money_plan_v4` (Gen Ventures × ZHC plan)
- `robot_money_prd` (PRD MVP v1.0, March 2026)

> **Source docs are confidential and local-only.** The PDF/docx originals and their verbatim markdown conversions are not committed to this repository (see `.gitignore`). This document is the public surface; quotations and section references below are the only public reflection of the source-doc contents.

The docs were authored at different moments with different scopes and were not reconciled before being collected here. This document captures (1) cross-document contradictions that require a product decision, (2) open questions the source docs explicitly flag, and (3) gaps that none of the docs address.

Where applicable, each item carries a **Product owner input** note capturing direction conveyed verbally by the product owner (Lex Sokolin, 2026-05-06). These are stated intentions, not yet written into specs the repo can verify, but they reflect current thinking. Treat them as one input — not a final resolution.

Each item may also carry a **Best current answer** note. These are the
working answers from current product planning, including the 2026-05-14
application-completeness discussion. They preserve the original
questions while making the present best guess explicit. Items marked
**TBD** remain unresolved.

---

## 1. Cross-document contradictions

These are points where two or more documents make incompatible claims. Each needs a decision before any of the docs can be published externally as a coherent set.

### 1.1 One token or two?

- **Whitepaper**: single `$ROBOTMONEY`, fixed 1B supply via Clanker v4, LP locked until 2100. Value accrues only through buyback-and-burn from prop-wallet realized gains. Explicitly: "no inflationary yield … staking $ROBOTMONEY does not earn more $ROBOTMONEY."
- **Plan v4**: two-token path. `$RM v1` (Clanker community token) → `$RM v2` (custom contract with **staking and fee distribution**), v1→v2 exchange with early-mover bonus.
- **PRD**: single `$RM`, governance only. No v1/v2.

**Question:** Is there a v2 protocol token with staking and fee distribution, or is the burn-only Clanker token the permanent design?

**Why it matters:** Plan v4's "fee distribution to stakers" directly contradicts the whitepaper's burn-only accrual. The two cannot both be true. This also determines whether early `$RM` buyers face dilution/migration risk.

**Product owner input:** Token is "a voting heartbeat for AIs to contribute to allocation voting and try to bribe in their own assets to vaults." Framed as governance + a designed-in bribery flow, not a yield-bearing instrument. Described as a "separate build attempt … described in specs" not in this repo. Consistent with single-token, governance-only.

**Best current answer:** Single `$ROBOTMONEY` / RM governance token. For the current product scope, RM holders vote only on Portfolio Router target weights across active vaults. No v1/v2 migration, staking, or fee-distribution model is specified here. Detailed tokenomics, supply, launch terms, Clanker terms, and buyback mechanics remain **TBD**.

### 1.2 Vault: three-bucket from launch, or stables-first?

- **Whitepaper**: 33/33/33 stables / agent-token trading / revenue tokens **from day one**. Monthly bucket-weight rebalance.
- **Plan v4**: stables-only genesis vault in Phase 1. Robot-coin baskets in Phase 3 (Weeks 8–16). Protocol/DeFi tokens Phase 4.
- **PRD**: vault is referred to as future ("before the vault ships"); CFO Feed exists partly to fill the gap.

**Question:** What is in the vault on day one — three buckets or a single-strategy stables vault?

**Why it matters:** Affects launch-week TVL targets, smart-contract scope, audit surface, and the GTM narrative ("managed three-bucket exposure" vs. "stable yield, expanding").

**Product owner input:** Architecture is multi-vault, not multi-bucket-in-one-vault: *"multi-vault of n vaults, and then receipt tokens for vaults, and then that maybe or maybe not wrapped into a vault. Perhaps people can opt into different mixes of exposure."* Specific vaults named: stables ("sort of done"; Giza and Zyfai mentioned as additional strategy candidates), a protocol vault (ETH/BTC/SOL), an agent-token vault ("not done", with the voting/bribery use case attached), and a possible RWA vault (SP500 via a Hyperliquid position; commodities). Veda was considered as an off-the-shelf provider; the team chose to build in-house. Reframes the question: not three-bucket-vs-stables-first but a sequence of separate vault contracts with optional meta-vault wrapping (see §3.11, §3.12).

**Best current answer:** Neither three-bucket-in-one-vault nor stables-only permanent product. The application-completeness target is a multi-vault system: stable-yield vault, protocol-asset vault, agent-token vault, and future thematic/RWA vaults. A Portfolio Router allocates deposits across active vaults according to RM-governed router weights.

### 1.3 Shortlist curation: top-down or bottom-up?

- **Whitepaper**: the protocol's agent runs the quant screen and **publishes** the shortlist of 10–15 tokens. Holders only rank.
- **PRD**: any Analyst-tier (100M `$RM`) agent **proposes** tokens. 48h Approve/Reject inclusion vote at 3% quorum. 15-token cap with displacement rules.

**Question:** Who decides what is on the shortlist — the protocol agent (curated) or `$RM` holders via inclusion proposals (community-driven)?

**Why it matters:** Different governance topologies. Curated is faster and lower-overhead; proposal-driven creates `$RM` demand from projects wanting inclusion. The PRD's whole eligibility/tier/activity machinery only exists if the answer is proposal-driven.

**Product owner input:** The bribery flow ("AIs … try to bribe in their own assets to vaults") is explicitly designed-in, which reads as bottom-up: agents pay/lobby `$RM` to push their tokens into the agent-token vault. Mechanics deferred to "specs." **Session decision:** agent-coin / agent-token shortlist ownership and inclusion mechanics remain TBD; the current RM-token vote is only Portfolio Router weights.

**Best current answer:** **TBD.** Agent-coin / agent-token shortlist ownership and inclusion mechanics are not part of the current router-weight governance scope. Do not assume protocol-agent curation, community proposals, Analyst-tier gates, or multisig curation as the product answer.

### 1.4 Voting mechanic for weekly allocation

- **Whitepaper**: ranked-choice voting over the shortlist.
- **PRD**: basis-point allocation (each agent distributes 0–10,000 bps across up to 15 tokens), weighted by `$RM` balance.

**Question:** Ranked choice or weighted bps allocation?

**Why it matters:** They produce different outcomes from the same inputs and require different UI, tally logic, and gaming-resistance analysis.

**Product owner input:** Mechanics not specified beyond "voting heartbeat" framing and the bribery flow. Treated as part of the separate token-side build described in specs.

**Best current answer:** The currently specified vote is not a weekly token-shortlist allocation vote. It is an RM-token vote on Portfolio Router target weights across active vaults. Ranked-choice voting and token-level bps allocation remain **TBD** for any future agent-token vault shortlist mechanism.

### 1.5 Tier system: yes or no?

- **PRD**: four tiers (Observer / Participant 10M / Analyst 100M / Strategist 500M) with 14-day activity gate for Analyst+ governance actions.
- **Whitepaper & Plan v4**: no tiers. Anyone with `$RM` can vote, linear weight.

**Question:** Are governance rights gated by both balance tier and recent activity, or only by balance?

**Why it matters:** The activity gate is the PRD's main sybil defense. Removing it weakens governance; keeping it requires the CFO Feed as a prerequisite product.

**Best current answer:** No tier system is specified for the current router-weight vote. RM-token voting power mechanics are still to be specified, but the current product scope does not include Observer/Participant/Analyst/Strategist tiers or CFO Feed activity gates. Future agent-token shortlist governance may revisit tiers; that remains **TBD**.

### 1.6 Vault structure: bucketed or flat?

- **Whitepaper**: Bucket A/B/C is structurally central (risk floor, alpha, middle ground). Monthly votes shift bucket *weights*.
- **PRD**: flat list of up to 15 tokens with bps weights. No bucket vocabulary, no bucket-weight vote.
- **Plan v4**: "baskets" — closer to buckets, undefined.

**Question:** Is the vault organized as three risk buckets with intra-bucket selection, or as a flat token list with direct weights?

**Why it matters:** The whitepaper's monthly bucket rebalance vote has no surface in the PRD's governance flows. If buckets are real, the PRD is missing a workflow.

**Product owner input:** Neither bucketed nor flat — multi-vault with receipt tokens, optionally wrapped into a meta-vault (see §1.2 and §3.12). Each asset class is its own vault; "different mixes of exposure" come from combining receipts or from depositing into a wrapper. Closest reference: Veda. This is a third architecture not described in any of the three source papers.

**Best current answer:** Product structure is multi-vault plus Portfolio Router. It is not a single bucketed vault and not a flat list of token weights. The outer allocation is router weights across active vaults. Per-vault internals, including the agent-token vault's asset list, remain separate design questions.

### 1.7 Sequencing: what ships first?

- **Whitepaper**: vault contract Week 1–2, token Week 3, first deposits Weeks 4–8. Vault and token roughly simultaneous.
- **Plan v4**: vault + token + agent persona simultaneous in Phase 1 (Weeks 1–2).
- **PRD**: `$RM` is **already live and trading**; vault is **not yet shipped**; CFO Feed is the stopgap.

**Question:** Was the vault live at token launch, will it be, or has the plan now changed to "token first, CFO Feed second, vault later"?

**Why it matters:** The whole strategic story differs. If the vault is not at launch, the whitepaper's day-one fee economics and prop-wallet seeding from launch fees are not yet operative, and `$RM` is purely speculative until the vault ships.

**Product owner input:** Confirms vault-first, with stables vault "sort of done" and the rest staged behind it. Token side is described as a separate build in specs. **Session decision:** production launch chain is Base; multi-chain expansion is deferred — see §3.11.

**Best current answer:** Vault and application surfaces first: multi-vault contracts, Portfolio Router, composite view, CLI, agent skills, and dapp UX. The RM token exists in the product model for router-weight voting, but detailed token launch and tokenomics remain **TBD**. Production launch chain is Base.

### 1.8 Customer wedge

- **Whitepaper**: agents with **idle USDC** seeking diversified managed exposure.
- **Plan v4**: agents **over-concentrated in their own token** seeking to de-risk into stables.
- **PRD**: agents seeking **analytical credibility and governance influence** (CFO Feed).

**Question:** Which is the primary go-to-market wedge?

**Why it matters:** Each wedge implies different onboarding flows. The plan-v4 framing also implicitly requires a swap path (own-token → USDC) that the whitepaper assumes has already happened.

**Product owner input:** Implies a wedge broader than any single source paper: agent-economy treasuries on chains with real payment activity. The agent-token vault carries the bribery/voting use case (governance demand for `$RM`); the RWA vault carries a story-telling use case (SP500/commodities exposure for narrative). The customer is still agents, but the product surface is broader than just "park idle USDC." **Session decision:** production launch starts on Base; other chains remain future expansion candidates.

**Best current answer:** Primary wedge is agent-economy treasury access through a multi-vault system that works for both agents and humans. The application-completeness scope is contracts, CLI, agent skills, and dapp UX for vaults, Portfolio Router, composite positions, and router-weight governance. CFO Feed is not the current wedge.

---

## 2. Questions the source docs themselves flag

These are explicitly listed as open in the originals. Re-stated here for tracking.

### From Whitepaper §11

- **Legal entity structure.** Vault accepts deposits and charges a management fee; in most jurisdictions this is fund management. Likely needs offshore foundation (Cayman, BVI) or DAO legal wrapper (Wyoming, Marshall Islands). Counsel review pre-launch. **Best current answer:** **TBD.**
- **Performance fee.** Whether to add a 20%-of-gains-above-hurdle fee in addition to the 2% management fee. Deferred to Phase 4 pending track record. **Best current answer:** **TBD.** Current PRD leaves fee parameters within published bounds; no performance-fee model is specified.
- **Deposit caps.** Whether to cap total deposits during bootstrap to limit smart-contract risk exposure. Whitepaper recommends $500K cap in Phase 2, lifted after 60 days incident-free. **Best current answer:** product requires vault-level, Portfolio Router-level, and agent-policy-level caps. Exact launch cap amounts remain **TBD**.
- **Multi-chain expansion.** Whether to deploy cross-chain (CCIP, LayerZero) if agent activity migrates from Base. Deferred to Phase 5. **Best current answer:** production launch chain is Base. Polygon, Ethereum mainnet, Peaq, and other chains remain future expansion candidates, not launch blockers. See §3.11.
- **Agent identity verification.** Whether the vault should verify depositors are agents and not humans. Current answer: no — vault is permissionless. **Best current answer:** no agent-identity requirement for vault deposits. Agent-specific restrictions apply only when using depositor-authorized agent policies.

### From Plan v4 "Immediate Decisions (Pre-Launch)"

- Genesis vault infrastructure: Compass Labs API vs. direct Aave/Sky vs. custom build.
- Stablecoin selection for the genesis vault: USDC vs. DAI vs. USDE.
- Agent persona: identity, hosting, posting infrastructure, and ongoing cost.
- Tokenomics: supply, fee structure, initial allocation, v1/v2 exchange terms.
- Clanker terms: exact fee structure, factored into v2 exchange economics.
- Audit budget and timeline for `$RM v2` (Phase 2–3 dependency).

**Best current answers:**

- Genesis vault infrastructure: build in-house for application completeness; build-vs-buy for particular strategy integrations remains **TBD** (see §3.13).
- Stablecoin selection: Base launch path uses USDC.
- Agent persona: **TBD**.
- Tokenomics, initial allocation, Clanker terms: **TBD**.
- `$RM v2`: no v2 is specified in the current product scope.

---

## 3. Gaps — questions none of the docs answer

Topics that are load-bearing for the protocol but not addressed in any source document.

### 3.1 Quant filter operationalization

The thresholds are defined ($10M mcap, 90 days, $100K volume, 500 holders) but not the *measurement methodology*: which oracle/aggregator, what averaging window, how disputes are resolved. The PRD mentions "CoinGecko + on-chain" with "consensus required if sources disagree" but does not specify rules.

**Best current answer:** **TBD.** Not needed for the current Portfolio Router weight vote. Required before agent-token shortlist governance ships.

### 3.2 Bucket B trading: who is the trader?

The whitepaper says "the agent trades agent-economy tokens using on-chain signals (volume, holder distribution, treasury health, developer activity)" but no doc specifies the trading strategy, position-sizing rules, stop-loss enforcement, or how losses are reported in NAV in real time. The 10%-of-Bucket-B position cap is mentioned once with no enforcement mechanism described.

**Best current answer:** Reframed as agent-token vault design. Trading authority, strategy, position sizing, and reporting remain **TBD** and are out of scope for Portfolio Router weight governance.

### 3.3 Prop wallet seeding and accounting

The whitepaper says the prop wallet is "seeded from Clanker launch fees" but does not quantify expected initial capital, nor specify how the prop wallet's PnL accounting handles unrealized gains, mark-to-market reporting, or tax-lot identification for buyback triggers.

**Best current answer:** **TBD.** Token launch, Clanker terms, buyback funding, and prop-wallet accounting are not specified in the current application-completeness scope.

### 3.4 Multisig composition and trust

The PRD's MVP relies on a 2-of-3 multisig to relay Snapshot results to `vault.rebalance()`. No doc names signers, defines challenge-window dispute resolution, or specifies what happens if signers disagree with the published tally.

**Best current answer:** **TBD.** Current docs require published router-weight execution rules, but signer set, challenge windows, and disagreement handling are not specified.

### 3.5 Vault upgrade path

The whitepaper says "no upgradeability — immutable contract." But Plan v4 and the PRD describe progressive expansion (new buckets, new strategies, Chainlink Automation, on-chain governance contract). How is "immutable vault" reconciled with "progressive expansion"? Is each phase a new vault deployment with a migration path?

**Best current answer:** Multi-vault architecture reduces pressure to mutate one monolithic vault. New exposure types can be new vaults and then become active Portfolio Router destinations. Exact upgradeability, migration, and retirement mechanics remain **TBD** per vault and router contract.

### 3.6 Agent CFO Feed economics

The PRD describes a content product (registration, posting, upvoting, comments) with no fee model. Hosting, RPC, IPFS, and moderation costs are not allocated. Does the CFO Feed run on protocol revenue, separate funding, or fees?

**Best current answer:** **TBD / out of current scope.** CFO Feed is not part of the application-completeness target.

### 3.7 Withdrawal mechanics under Bucket B drawdown

Redemptions are at NAV minus 0.25% exit fee. No doc specifies what happens when Bucket B (high-risk active positions) is mid-trade and a depositor wants to exit — forced sale, queued withdrawal, or NAV haircut?

**Best current answer:** Reframed as per-vault liquidity and redemption policy. The default product promise remains synchronous withdrawal, and vaults that cannot support it must be labeled separately and excluded from Portfolio Router allocations until the promise changes. Agent-token vault drawdown mechanics remain **TBD**.

### 3.8 Inclusion-attack economic bounds

The whitepaper argues the inclusion attack is self-punishing because attackers' `$RM` loses value if their token underperforms. But the magnitude is not modeled: how much `$RM` must an attacker hold to swing weekly allocation, vs. how much vault buy pressure that produces, vs. expected loss on `$RM` from underperformance? Without numbers, "self-punishing" is an assertion, not a proof.

**Best current answer:** **TBD.** Not applicable to the current router-weight vote unless / until RM governance controls agent-token inclusion or per-vault asset selection.

### 3.9 Quorum cliff

If the weekly vote falls just below 5%, the agent default executes; if just above, voted weights execute. No doc addresses smoothing — e.g., a continuous blend between voted and default weights as quorum scales — to avoid governance whiplash week-to-week.

**Best current answer:** **TBD.** Router-weight voting still needs quorum, cadence, threshold, execution, and fallback rules.

### 3.10 Failure modes for the protocol agent itself

The protocol agent is a single point of failure: it publishes shortlists, runs the default allocation, executes rebalances, and posts the public narrative. No doc addresses what happens if the agent goes offline, is compromised, hallucinates a bad allocation, or its operator wants to step away. There is no agent-of-last-resort or emergency pause that names a controller.

**Best current answer:** Partially avoided for current scope: the only specified vote is RM-token router weights, not protocol-agent-run shortlist selection. Agent-token shortlist and protocol-agent responsibilities remain **TBD**.

### 3.11 Production chain selection

**Resolved in this session.** Production launch chain is **Base**.

This decides the launch integration set, wallet assumptions, DeFi venue targets, testnet/mainnet configuration, and audit scope for application completeness. The existing Base deployment is no longer treated only as a throwaway POC in product planning; it is the launch-chain baseline to harden.

Open follow-up: multi-chain expansion is still deferred. Polygon, Ethereum mainnet, Peaq, and other chains can be revisited after the Base launch path is complete.

**Best current answer:** Launch on Base.

### 3.12 Multi-vault wrapping mechanism

The product owner describes "n vaults" with receipt tokens, optionally wrapped into a meta-vault that lets users opt into mixes of exposure. None of the source papers describe this, and the deployed contract is a single ERC-4626. Open: is the wrapper an ERC-4626-of-ERC-4626 (share-of-shares), a router that bundles deposits, an off-chain composite product, or something else? Who sets the mix weights — depositor at deposit time, governance, or the product?

*Product owner input: structure described as "multi-vault of n vaults, and then receipt tokens for vaults, and then that maybe or maybe not wrapped into a vault. Perhaps people can opt into different mixes of exposure." Reference point: Veda.*

**Best current answer:** Portfolio Router, not Portfolio Vault. The outer product does not issue shares. Users receive underlying vault receipts; the product presents a portfolio position / composite view. RM holders vote on Portfolio Router target weights.

### 3.13 Build-vs-buy commitment

The product owner introduced existing portfolio-management providers (Veda named as the largest), and the team chose to build in-house anyway — described as "opening the can of worms." This raises an implicit question of scope: how much of the multi-vault platform is in-scope to build, and at what point would integrating Veda (or Giza/Zyfai for the stables vault) be revisited?

*Product owner input: build-in-house decision is current; Giza and Zyfai are named as potentially interesting for the stables vault specifically.*

**Best current answer:** Build the application-completeness surfaces in-house: contracts, Portfolio Router, composite view, CLI, agent skills, and dapp UX. Build-vs-buy for specific vault strategies or providers remains **TBD**.

### 3.15 Intra-vault rebalancing when the basket changes

Basket vaults (protocol-asset and agent-token) allocate new deposits equally
across active assets at deposit time. Existing positions are not touched when
an asset is added or removed from the shortlist. This creates drift: a
depositor who entered before a new token was added holds none of it, and a
depositor who entered before a token was removed still holds it until they
redeem.

Three sub-questions are open:

- **Who triggers rebalancing?** Admin-initiated (keeper calls a rebalance
  function), keeper-automated on a cadence, or depositor-self-service (deposit
  small amount to "refresh" allocation).
- **What is the rebalancing target?** Equal weight across current active
  assets, or a governed weight vector (which would require the basket to adopt
  router-weight-style governance)?
- **What are the cost and slippage constraints?** A full rebalance on a large
  vault requires many swaps in sequence. Each swap incurs slippage and fee
  cost that is borne by all shareholders. The product must disclose rebalancing
  cost before it executes, or defer cost to depositors who trigger it
  individually at redemption.

Related: vault-level rebalancing is distinct from Portfolio Router weight
updates (§3.12), which allocate across vaults rather than within one vault.

**Best current answer:** **TBD.** The prototype implementation routes only new
deposits into equal-weight positions; existing holdings are not rebalanced.
A `rebalance()` admin function and its cost-disclosure model must be specified
before the agent-token vault can meet the PRD's transparent-performance
requirement (§2).

### 3.14 RWA vault feasibility

The product owner mentioned an RWA vault built around a Hyperliquid SP500 perp position, possibly extended to commodities — primarily a "story telling" exposure. None of the source papers describe RWA, and the regulatory and execution mechanics are non-trivial: a perp position is not a spot RWA, and exposing depositors to perp funding/liquidation risk through a "vault" framing has user-protection implications.

*Product owner input: RWA vault flagged as a future build for narrative value.*

**Best current answer:** **TBD / future.** RWA or thematic vaults are allowed by the product taxonomy but require separate legal, liquidation, oracle, and user-disclosure work before inclusion in Portfolio Router allocations.

---

## 4. Suggested resolution order

The multi-vault architecture, Portfolio Router, Base launch chain, and
router-weight governance scope now have best-current answers above.
Remaining TBD decisions should be sequenced as follows:

1. **Tokenomics and RM vote mechanics** — supply, launch terms,
   Clanker terms, voting power, quorum, cadence, execution, fallback
   rules, and buyback mechanics (§1.1, §3.3, §3.9).
2. **Portfolio Router implementation details** — contract API,
   preview semantics, failure behavior, receipt delivery, cap model,
   and vote-to-weight execution (§3.12).
3. **Build-vs-buy per vault** — which vaults/strategies are built
   directly and which use providers such as Veda, Giza, or Zyfai
   (§3.13).
4. **Agent-token vault internals** — shortlist ownership, inclusion
   rules, trading authority, position sizing, attack economics,
   whether tiers are needed, and intra-vault rebalancing trigger,
   target, and cost model (§1.3, §1.4, §1.5, §3.1, §3.2, §3.8,
   §3.10, §3.15).
5. **Launch controls and trust** — legal entity, launch cap amounts,
   multisig composition, challenge windows, upgrade/migration rules,
   and per-vault retirement policy (§2, §3.4, §3.5).
6. **RWA/thematic vault feasibility** — legal, oracle, liquidation,
   disclosure, and redemption mechanics before any RWA vault is made
   active in the Portfolio Router (§3.14).
7. **Future product surfaces** — CFO Feed economics, agent persona,
   multi-chain expansion, and any non-router governance surfaces
   (§1.8, §2, §3.6, §3.11).
