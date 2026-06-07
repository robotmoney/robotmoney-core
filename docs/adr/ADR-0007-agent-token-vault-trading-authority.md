# ADR-0007: AgentTokenVault trading authority and strategy — deferred indefinitely (non-goal)

- **Status:** Accepted <!-- Status: Accepted -->
- **Date:** 2026-06-07
- **Deciders:** Engineering lead (technical recommendation); product owner confirmation pending
- **Related:** `docs/development/open-questions.md` §1.B (§3.2); `docs/adr/ADR-0001-mvp-agent-token-shortlist.md` §Out-of-scope; `docs/prd.md` §11.3

## Context

`docs/development/open-questions.md` §1.B (originally tagged §3.2) asks:

> "Specify trading strategy, position-sizing rules, stop-loss enforcement, and real-time NAV loss reporting *if* an agent component is reintroduced to the agent-token vault."

`ADR-0001` (line 80) already records: *"Trading authority and strategy inside the vault (open-questions §3.2) is not resolved; the MVP vault holds the basket and rebalances per §3.15 only."*

A codebase audit (2026-06-07) confirms zero contract references to `tradingAuthority`, `stopLoss`, `positionSizing`, or `navLoss`. The current `AgentTokenVault` is:

- **admin-curated** — shortlist set by Safe ≥2-of-3 through `TimelockController` (ADR-0004).
- **equal-weighted** — deposits are split across shortlisted tokens at deposit time (ADR-0001).
- **no autonomous trading** — no agent component, no autonomous swap path, no on-chain strategy logic.

The question as written presupposes that an *agent component* will be reintroduced. That presupposition is not supported by any current roadmap entry, implementation-plan milestone, or PRD commitment. There is no open issue, no plan phase, and no engineering estimate covering autonomous agent-trading infrastructure.

## Decision

**Trading authority and strategy for `AgentTokenVault` is a non-goal at all current roadmap horizons.**

No version of the protocol planned today will introduce autonomous on-chain trading logic (trading strategy, position-sizing rules, stop-loss enforcement, or real-time NAV loss reporting) inside `AgentTokenVault`. The vault is and will remain a custody-and-rebalance vehicle: it holds an admin-curated basket of agent-economy tokens and rebalances on new deposits only.

Any future initiative that would reintroduce an autonomous agent component **must not begin implementation** without a new ADR that resolves all of the following before any code is written:

1. **Trading authority model** — which address (agent EOA, Safe, keeper, DAO) is authorised to initiate a swap and under what on-chain conditions.
2. **Strategy specification** — the trading strategy type (e.g., momentum, mean-reversion, carry) with explicit entry/exit rules.
3. **Position-sizing rules** — maximum per-asset weight and concentration limits, expressed as on-chain invariants.
4. **Stop-loss enforcement mechanism** — the on-chain circuit breaker: who triggers it, at what NAV drawdown threshold, and what the liquidation path is.
5. **Real-time NAV loss reporting surface** — the contract interface (event, view, oracle push) that depositors and the Router use to observe vault health.

This ADR closes §1.B permanently. It does **not** prevent a future product decision to ship agent trading; it requires that decision to be made explicitly and recorded in a successor ADR before any code is written.

## Consequences

**Positive.**

- Closes the blocking open question without waiting on a product-owner roadmap decision: the question is resolved as a non-goal, not merely deferred.
- Eliminates any risk that a future engineer begins implementing autonomous trading logic without a written specification.
- Removes §1.B from the open-questions tracking list, reducing noise for ongoing Architecture-phase work.
- Consistent with the existing ADR-0001 "out of scope" statement — this ADR formalises and extends that scope boundary.

**Negative / accepted risks.**

- If the product owner later decides to introduce agent trading, a new ADR is required before implementation can begin. This is the intended gate, not a cost.
- The non-goal language here applies only to `AgentTokenVault`. A separate vault subclass with agent-trading semantics is not blocked by this ADR.

**Non-goals (explicit).**

- This ADR does not prevent rmAGENT from becoming Router-eligible; Router eligibility is gated on the four hardening criteria in `docs/prd.md` §11.3, none of which require agent-trading logic.
- This ADR does not change the shortlist governance model (see ADR-0004).
- This ADR does not affect `BasketVault` rebalancing (see ADR-0003).
