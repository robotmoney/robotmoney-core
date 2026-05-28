<!-- Living document. Deliberately temporal: it tracks the status of open
product/engineering questions and changes as they are resolved. It is kept
OUT of docs/prd.md, which is an atemporal product-requirements document and
must not track status. Subsection identifiers (§1.3, §3.15, …) are retained
as stable anchors for cross-references from other docs. -->

# Robot Money — Open Questions

Unresolved **product and engineering** questions derived from reading the three source documents kept locally under `docs/papers/`:

- `Robot-Money-Whitepaper-v01` (Protocol Specification v0.1, February 2026)
- `robot_money_plan_v4` (Gen Ventures × ZHC plan)
- `robot_money_prd` (PRD MVP v1.0, March 2026)

> **Source docs are confidential and local-only.** The PDF/docx originals and their verbatim markdown conversions are not committed to this repository (see `.gitignore`). This document is the public surface; quotations and section references below are the only public reflection of the source-doc contents.

This document tracks only the questions that are **still open and product/engineering-owned**, grouped by topic. Items are tagged with their original `§x.y` identifier, retained as a stable anchor so existing cross-references from other docs still resolve; the identifiers no longer imply order.

> **Out of scope here:** resolved contradictions and their code evidence are tracked outside this document and asserted as facts in `docs/prd.md`, `docs/architecture.md` §2–4 and §10, and `docs/adr/`. Business, legal, pricing, tokenomics, agent-persona, audit, multi-chain, and other go-to-market/launch decisions are **tracked outside this repository**.

---

## 1. Product topics

### 1.A Governance and voting

**Router default-weight vector (§3.9).** Ship an admin-settable on-chain default-weights vector that the Router falls back to below quorum, sized to the live vault set and sourced from chain state per [ADR-0002](../adr/ADR-0002-router-default-weights-on-chain.md). Continuous smoothing / whiplash blending is deferred.

### 1.B Agent-token vault internals

**Trading authority and strategy (§3.2).** Specify trading strategy, position-sizing rules, stop-loss enforcement, and real-time NAV loss reporting *if* an agent component is reintroduced to the agent-token vault. Not live in the MVP shortlist model (admin-curated, equal-weighted, no agent trading); question needs reframing with the product owner before any engineering work.

**Intra-vault rebalancing (§3.15).** The working direction is "new-deposits-only" rebalancing — when target weights change, only incremental deposits route at the new weights; existing positions are never sold. Zero swap cost, but per-depositor weight drift relative to the published target.

Open residual: which depositor-facing reporting surface does the PRD's transparent-performance requirement demand — (a) target weights, (b) aggregate realized weights across all depositors, or (c) per-depositor effective weights — and is (a) sufficient without (c)?

### 1.C Vault lifecycle and redemption

**Depositor migration on vault retirement (§3.5).** Retirement is a one-way status and existing depositors can still withdraw, but there is no forced or assisted migration path out of a retiring vault. Decide whether one is needed.

**Basket-vault drawdown redemption policy (§3.7).** Specify the redemption policy when a basket vault is in drawdown — forced sale vs. queued withdrawal vs. NAV haircut — before ADMIN_ROLE marks any basket vault router-eligible.

> **Research questions** (open-ended modeling and assurance, not product/engineering decisions) live in `docs/technical/research-questions.md` — currently the inclusion-attack economic bounds (§3.8) and protocol-agent resilience (§3.10).

---

## 2. Suggested resolution order

1. **Router default-weight vector on-chain** — implement the admin-settable fallback per ADR-0002 and close §3.9.
2. **Intra-vault rebalancing transparency** — pick the depositor-facing reporting surface (target / aggregate-realized / per-depositor effective) for the new-deposits-only model and close §3.15.
3. **Vault lifecycle residuals** — depositor migration on retirement (§3.5) and basket-drawdown redemption policy (§3.7); only the latter blocks marking a basket vault router-eligible.
4. **Trading authority reframe (§3.2)** — product to reframe before any engineering work.
