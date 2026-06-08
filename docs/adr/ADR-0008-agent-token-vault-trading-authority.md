# ADR-0008: AgentTokenVault trading authority and strategy — deferred indefinitely (explicit non-goal)

- **Status:** Accepted
- **Date:** 2026-06-08
- **Deciders:** Product owner
- **Related:**
  - `docs/development/open-questions.md` §1.B (trading authority and strategy, §3.2)
  - `docs/adr/ADR-0001-mvp-agent-token-shortlist.md` (§Out-of-scope — agent trading scoped out of MVP)
  - `docs/adr/ADR-0003-basketvault-rebalancing-model.md` (`rebalance()` `NotImplemented` stub pattern)
  - `docs/adr/ADR-0007-basket-vault-drawdown-redemption-policy.md` (redemption policy)
  - `docs/prd.md` §11.3 (Agent Token Vault)

## Context

`docs/development/open-questions.md` §1.B (originally tagged §3.2) asks:

> *"Specify trading strategy, position-sizing rules, stop-loss enforcement, and
> real-time NAV loss reporting if an agent component is reintroduced to the
> agent-token vault."*

`ADR-0001` already records that trading authority and strategy inside the vault
is not part of the MVP: the MVP vault is admin-curated, equal-weighted, and holds
the basket without any autonomous trading. A codebase audit confirms there are no
contract references to `tradingAuthority`, `stopLoss`, `positionSizing`, or
`navLoss`. The current `AgentTokenVault` is:

- **admin-curated** — shortlist set by Safe ≥2-of-3 through `TimelockController`
  (ADR-0004);
- **equal-weighted** — deposits split across shortlisted tokens at deposit time
  (ADR-0001);
- **no autonomous trading** — no agent component, no autonomous swap path, no
  on-chain strategy logic.

The question as written presupposes that an *agent component* will be
reintroduced. That presupposition is not supported by any current roadmap entry,
implementation-plan milestone, or PRD commitment.

## Decision

**In-vault trading authority and strategy for `AgentTokenVault` is an explicit
non-goal and is deferred indefinitely.**

No version of the protocol planned today will introduce autonomous on-chain
trading logic — trading strategy, position-sizing rules, stop-loss enforcement,
or real-time NAV-loss reporting — inside `AgentTokenVault`. The vault is and
remains a custody-and-rebalance vehicle: it holds an admin-curated, equal-weight
basket of agent-economy tokens and rebalances on new deposits only (ADR-0003).

Any future initiative that would reintroduce a discretionary on-chain trading
component **must not begin implementation** without a new, separate,
independently-audited module and a successor ADR that first resolves all of:

1. **Trading authority model** — which address (agent EOA, Safe, keeper, DAO) may
   initiate a swap, and under what on-chain conditions.
2. **Strategy specification** — the strategy type with explicit entry/exit rules.
3. **Position-sizing rules** — per-asset and concentration limits as on-chain
   invariants.
4. **Stop-loss enforcement** — the on-chain circuit breaker: trigger authority,
   NAV-drawdown threshold, and liquidation path.
5. **Real-time NAV-loss reporting** — the contract interface (event/view/oracle
   push) by which depositors and the Router observe vault health.

This mirrors the ADR-0003 `rebalance()` `NotImplemented()` stub pattern: the
capability is explicitly reserved and gated behind a written specification, never
implemented implicitly.

### Rationale

- **ADR-0001 already scopes agent trading out of the MVP** (admin-curated,
  equal-weighted). This ADR formalises and extends that scope boundary.
- **Large security surface.** Discretionary on-chain trading introduces oracle
  manipulation, MEV, and strategy-governance attack vectors.
- **Regulatory / fiduciary risk.** A vault that trades discretionarily on
  depositors' behalf is materially different in legal posture from a passive,
  admin-curated, equal-weight basket.
- **Must be independently audited if ever revived.** Any reintroduction belongs
  in a separate module with its own audit, not bolted onto the basket vault.

## Alternatives considered

- **Specify the agent-trading parameters now (as the open question requested)** —
  rejected: no roadmap, plan phase, or PRD commitment exists; specifying it now
  would invite implementation of an un-audited, high-risk surface with no product
  driver.
- **Leave §1.B open as "needs reframing"** — rejected: leaving it open keeps a
  blocking architecture question unresolved. Recording it as an explicit non-goal
  closes it cleanly while preserving the option to revive via a successor ADR.
- **Embed a minimal trading hook now, gated by a flag** — rejected: any on-chain
  trading authority, however minimal, expands the attack surface and fiduciary
  exposure; it must be a separate, independently-audited module.

## Consequences

**Positive.**

- Closes the blocking open question (§1.B) as a non-goal rather than leaving it
  open indefinitely.
- Eliminates the risk that an engineer begins implementing autonomous trading
  logic without a written, audited specification.
- Consistent with ADR-0001's out-of-scope statement and ADR-0003's stub pattern.

**Negative / accepted risks.**

- If the product owner later decides to introduce agent trading, a new ADR and a
  separate audited module are required before implementation. This gate is
  intended, not a cost.
- The non-goal applies to `AgentTokenVault`. A future, separate vault subclass
  with agent-trading semantics is not pre-blocked — it simply requires its own
  ADR and audit.

**Non-goals (explicit).**

- This ADR does not prevent rmAGENT from becoming router-eligible; eligibility is
  gated on the hardening criteria in `docs/prd.md` §11.3 (and the drawdown
  policy of ADR-0007), none of which require agent-trading logic.
- This ADR does not change shortlist governance (ADR-0004) or basket-vault
  rebalancing (ADR-0003).
