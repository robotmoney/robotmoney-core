# Robot Money — Product Requirements

> Scope: this PRD describes **what Robot Money is** to its users — what
> they do, what they get, what we promise. It is atemporal: it
> specifies the product, not the order in which pieces ship and not
> how they are built. Architecture, contract surfaces, signing paths,
> tooling, schemas, and other implementation details live in
> `docs/architecture.md` (security architecture) and
> `docs/implementation-plan.md` (build slice). Implementation status
> lives in the git history and the implementation plan;
> `docs/project-roadmap.md` is deprecated (kept for historical
> reference only).

## 1. Product

Robot Money is a treasury for the agent economy. Idle USDC held by AI
agents, autonomous machines, and human depositors is pooled and
allocated across three buckets:

- a stable-yield base,
- a diversified set of agent-economy tokens, and
- a set of revenue-generating tokens.

Allocation is determined by holders of the protocol's governance
token. Depositors receive a share whose value tracks the portfolio.

A single deposit gives a depositor pro-rata exposure to all three
buckets. A single withdrawal returns the equivalent USDC. The
protocol is observable end-to-end: anyone can see what the treasury
holds, how it is allocated, and how decisions were made.

## 2. Users

- **Autonomous depositors.** AI agents and machines holding USDC that
  want diversified yield without bespoke per-protocol setup.
- **Human depositors.** Individuals seeking diversified, actively
  governed exposure to stable yield plus the agent-token economy via
  one share.
- **Token holders.** Holders of `$ROBOTMONEY` who govern bucket
  composition and weights and who benefit from buyback-and-burn
  supply reduction funded by protocol revenue.
- **Integrators.** Builders embedding Robot Money into their own
  agent runtimes or treasuries.

## 3. Promises to the user

1. **One transfer, diversified exposure.** A single USDC deposit
   yields pro-rata exposure across all three buckets. No manual
   rebalancing, no per-protocol onboarding chains.
2. **Synchronous redemption.** Withdrawals settle in one transaction.
   No cooldowns, no two-step claims, no unbonding windows.
3. **Two-audience parity.** Humans and agents can perform the same
   operations — deposit, withdraw, observe, govern — through
   audience-appropriate surfaces.
4. **No-config defaults.** First-time use does not require manual
   tuning. The product picks safe defaults; advanced users can
   override.
5. **Honest failures.** When something cannot be done, the user is
   told why. When something partially succeeds, the user is told
   exactly what happened. There are no silent failures.
6. **Governance-driven composition.** Bucket weights and bucket-B/C
   constituents are voted on published cadences. Robot Money does not
   hardcode a permanent universe of holdings.
7. **Allocation transparency.** The current allocation, recent
   performance, and governance state are observable to anyone, in
   real time.

## 4. What users do

### 4.1 Autonomous treasury sweep

An autonomous business — a SaaS run by agents, a machine selling its
output over a payment rail, a fleet of devices generating micro-revenue
— accumulates USDC. It periodically sweeps the surplus above an
operator-defined working reserve into Robot Money. The treasury earns
yield while idle. When the business needs to pay vendors, refund
customers, or reinvest, it withdraws.

What the operator wants: predictable yield on cash that would otherwise
sit idle, with bounded risk per transaction so a misbehaving agent
cannot drain the treasury.

What we promise: deposits and withdrawals settle synchronously; the
agent's spending is bounded by per-agent caps the operator sets; the
operator can pause or revoke an agent at any time.

### 4.2 Human depositor with delegated monitoring

An individual deposits USDC and receives shares. They check in
periodically — through the web app, or by asking an LLM — to see how
the position has performed and whether any governance proposals are
worth weighing in on.

What the depositor wants: one place to park USDC for diversified yield,
a clear view of where it is allocated, and a vote in how it gets
allocated next.

What we promise: a single share token, a single deposit/withdraw
flow, real-time visibility into allocation and performance, and
governance participation.

### 4.3 Token holder participating in governance

A `$ROBOTMONEY` holder votes on bucket constituents (weekly) and
bucket weights (monthly). Protocol revenue funds buyback-and-burn,
reducing the token supply over time.

What the holder wants: a voice in what the treasury holds, and a
share of protocol value capture without needing to be a depositor.

What we promise: open and on-chain voting, published cadences,
observable buyback execution.

## 5. Product surfaces

### 5.1 Treasury

- A pooled treasury of USDC, denominated in a single share token.
- Three buckets: stable yield, agent-economy tokens, revenue-generating
  tokens.
- Two emergency switches:
  - a reversible operational pause, and
  - a permanent shutdown that disables further deposits while
    preserving redemption rights.
- Deposit caps (total and per-deposit) governed by Robot Money admin
  within published bounds.
- Synchronous deposit and withdrawal.

### 5.2 Buckets

- **Bucket A — Stable yield.** USDC routed across diversified
  stable-yield venues so no single venue is a single point of
  failure.
- **Bucket B — Agent-economy tokens.** A holder-curated set of
  tokens from the agent economy.
- **Bucket C — Revenue-generating tokens.** A holder-curated set of
  tokens passing minimum eligibility thresholds.

Bucket-B and bucket-C tokens land directly in the depositor's wallet
at deposit time. The treasury custodies stable-yield positions only.

Cadences:
- **Bucket weights** (the A/B/C split) are voted **monthly**.
- **Bucket constituents** (the membership of B and C) are voted
  **weekly**.

### 5.3 Governance and the `$ROBOTMONEY` token

- Fixed-supply governance token.
- Holders vote on bucket constituents (weekly) and on the A/B/C
  weight split (monthly).
- The token does **not** entitle holders to treasury returns; it
  entitles them to direct allocation decisions.
- Protocol revenue funds buyback-and-burn of `$ROBOTMONEY`.
- Vote results and execution are observable on-chain.

### 5.4 Fees

The protocol levies three fees, each set by governance:

- **Management fee** — a percentage of treasury value, accrued
  continuously.
- **Swap-fee share** — a percentage of swap fees earned on bucket
  trading activity.
- **Exit fee** — a percentage of value applied to redemptions and
  withdrawals; included in the amount a depositor sees as their
  net-out.

The fee recipient is administered by the protocol's multisig.

### 5.5 Autonomous-agent access

Autonomous agents can deposit, withdraw, and observe the treasury
through a programmatic interface. Agent operators set per-agent
spending bounds and can pause or revoke any agent at any time. See
`docs/architecture.md` for the security architecture and
`docs/implementation-plan.md` for the agent client.

### 5.6 Human-facing web application

- Public dashboards: treasury state, current bucket composition,
  performance, and history.
- Connect-wallet flow for deposits, withdrawals, and governance
  participation.
- Governance UI: active proposals, vote casting, vote history.
- Observability for buybacks and protocol revenue.

### 5.7 Allocation transparency

- Real-time, public allocation reporting across both treasury-resident
  and externally delegated assets.
- Per-strategy attribution: which venue, what weight, what valuation.
- The same view is available to humans (web app) and to agents
  (programmatic interface).

## 6. Promises about quality

- **Stable interfaces.** Programmatic surfaces are versioned;
  breaking changes are announced and documented.
- **Helpful errors.** When an operation cannot proceed, the user
  receives an explanation in product terms (e.g. "deposit cap
  reached," "treasury paused"), not raw technical output.
- **Reliable connectivity.** The product handles transient network
  failures gracefully without user intervention.
- **Pre-flight checks.** Operations are validated before they are
  committed; users are warned of likely failures before incurring
  cost.
- **Auditability.** Every state change is observable on-chain;
  off-chain decisions (governance, delegated allocations) are
  observable through the same surfaces.

## 7. Trust

- **Treasury.** A pooled treasury contract administered by a
  multisig. Emergency switches (pause, permanent shutdown) exist for
  operator response to incidents.
- **Bucket execution.** Slippage and quote-freshness bounds apply to
  every bucket buy and sell. The treasury leg and the bucket leg
  commit independently — a failure in one does not put the other at
  risk.
- **Custody.** The treasury holds USDC and stable-yield positions.
  Bucket-B/C tokens land in the depositor's wallet directly.
- **Governance.** Vote results are public and on-chain. The path
  from a vote to an admin action is bounded by the multisig
  operating within published constraints.
- **Autonomous-agent signing.** Specified separately in
  `docs/architecture.md`; out of PRD scope.
- **Security posture.** The exhaustive web/web3/blockchain attack
  taxonomy and our per-row assessment is in
  `docs/security-model.md`.

## 8. Out of scope

- **Custodial key management.** Robot Money does not hold private
  keys for any user.
- **General-purpose wallet UX.** The web app is a depositor and
  governance interface, not a wallet.
- **Fiat on-ramps and off-ramps.** USD ↔ USDC conversion is
  out-of-band.
- **Direct user calls into stable-yield venues.** All flows go
  through the treasury.
- **Hardcoded bucket-B/C universes.** Bucket membership is voted, not
  curated.
- **Hosted custody or hosted signing services.**
