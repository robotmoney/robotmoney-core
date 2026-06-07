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

**AgentTokenVault shortlist governance (§1.3, §1.4).** **Resolved** — see [ADR-0004](../adr/ADR-0004-agent-token-shortlist-governance.md) (2026-06-03).

Decision: admin multisig (Safe ≥2-of-3) + mandatory `TimelockController` delay (48 h for `addAsset`, 24 h for `removeAsset`) + public veto window. Any Safe signer may cancel a queued change unilaterally. `addAsset` gate requires market-cap ≥ $10M, listing age ≥ 90 days, daily volume ≥ $100K, holder count ≥ 500, oracle availability, and liquidity depth ≥ $50K within 2% of mid-price. Maximum shortlist size: 15 tokens. Upgrade path to RM-token veto module (Option B) is reserved via `TimelockController` `CANCELLER_ROLE`. Resolves the blocking gap-report Appendix C item and enables rmAGENT router-eligibility (pending TWAP oracle, rebalancing model, and liquidity proof gaps).

### 1.B Agent-token vault internals

**Trading authority and strategy (§3.2).** Specify trading strategy, position-sizing rules, stop-loss enforcement, and real-time NAV loss reporting *if* an agent component is reintroduced to the agent-token vault. Not live in the MVP shortlist model (admin-curated, equal-weighted, no agent trading); question needs reframing with the product owner before any engineering work.

**Intra-vault rebalancing (§3.15).** **Resolved** — see [ADR-0003](../adr/ADR-0003-basketvault-rebalancing-model.md) (2026-06-02).

Decision: new-deposits-only rebalancing (no global `rebalance()` in MVP). Trigger = deposit; target = equal-weight; cost disclosure = `WeightSnapshot` event on every deposit + `previewDepositWeights` view + `realizedWeights(depositor)` view. The transparent-performance requirement is satisfied by exposing both (a) target weights and (c) per-depositor effective weights — option (a) alone is insufficient. A `rebalance()` stub with `NotImplemented()` revert reserves the selector for Phase B.

### 1.C Vault lifecycle and redemption

**Depositor migration on vault retirement (§3.5).** **Resolved** — see [ADR-0007](../adr/ADR-0007-vault-retirement-no-assisted-migration.md) (2026-06-07).

Decision: no assisted migration path is implemented. The current withdraw-only behavior is acceptable for production use of `VaultRegistry.Retired`. Depositors in a retired vault retain full ERC-4626 redemption rights and may exit at any time via `redeem`. The `PortfolioRouter` rejects new deposits into a retired vault. Operator communication (dapp notice, rmpc CLI, `VaultStatusChanged` event indexing) is the appropriate migration UX — depositors self-select into the successor vault using the standard deposit flow. A gateway-routed redeem-and-redeposit helper adds unjustified complexity, a transient USDC balance in the gateway, a successor-registry governance surface, and an expanded MEV surface for the MVP. See ADR-0007 for full rationale and consequences.

**Basket-vault drawdown redemption policy (§3.7).** Specify the redemption policy when a basket vault is in drawdown — forced sale vs. queued withdrawal vs. NAV haircut — before ADMIN_ROLE marks any basket vault router-eligible.

> **Research questions** (open-ended modeling and assurance, not product/engineering decisions) live in `docs/technical/research-questions.md` — currently the inclusion-attack economic bounds (§3.8) and protocol-agent resilience (§3.10).

---

## 2. Suggested resolution order

1. **Router default-weight vector on-chain** — implement the admin-settable fallback per ADR-0002 and close §3.9.
2. **Intra-vault rebalancing transparency** — ~~pick the depositor-facing reporting surface (target / aggregate-realized / per-depositor effective) for the new-deposits-only model and close §3.15~~ **Closed** by ADR-0003.
3. **Vault lifecycle residuals** — depositor migration on retirement (§3.5) and basket-drawdown redemption policy (§3.7); only the latter blocks marking a basket vault router-eligible.
4. **Trading authority reframe (§3.2)** — product to reframe before any engineering work.
