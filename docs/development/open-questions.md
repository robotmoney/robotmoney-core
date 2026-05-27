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

> **Out of scope here:** resolved contradictions and their code evidence are tracked outside this document and asserted as facts in the PRD body and `docs/architecture.md` §2–4, §10. This now includes the admin-multisig mechanism (was §3.4): a canonical Safe (≥2-of-N) holds proposer/executor on an OZ `TimelockController` that holds `ADMIN_ROLE` on all five contracts — see `contracts/script/DeployTimelock.s.sol` and `docs/architecture.md` §10; signer identities remain an ops decision. Business, legal, pricing, tokenomics, agent-persona, audit, multi-chain, and other go-to-market/launch decisions are **tracked outside this repository**.

---

## 1. Product topics

### 1.A Governance and voting

**Router-weight vote rules (§3.9).** *Largely implemented.* `contracts/RouterGovernance.sol` has a configurable `votingPeriod` (cadence), `executionDelay`, and `quorumThreshold`; a proposal that fails quorum becomes `Defeated` and cannot execute (`QuorumNotReached`), so weights hold at the status quo — the implicit fallback. **Open residual:** whether to add governance-whiplash smoothing (a continuous blend between voted and default weights as quorum scales) or an explicit default-weight vector below quorum, rather than the current status-quo hold. A design preference, not a missing mechanism.

**Governance tiers (§1.5).** No tier system exists today; `RouterGovernance` is flat (admin-assigned voting power now, RM-balance-linear later). The source PRD's four tiers (Observer / Participant / Analyst / Strategist) plus a 14-day activity gate are unbuilt. **Open question for the product owner:** do governance tiers and an activity gate matter to the MVP at all, or only to a future agent-token shortlist surface? Until ruled on, treat tiers as out of current scope but undecided as product direction — do not build the four-tier machinery.

**Agent-token shortlist ownership (§1.3).** For the current product the agent-token vault shortlist is admin/protocol-curated (`contracts/vaults/AgentTokenVault.sol`). Unresolved is the long-term model: admin curation vs. `$RM`-token inclusion proposals vs. the designed-in bribery flow (agents lobby/pay `$RM` to push their token into the vault). The source PRD's inclusion-proposal / quorum / displacement / 15-token-cap machinery only applies if a bottom-up model is chosen. **TBD** — out of current router-weight governance scope.

**Shortlist vote mechanic (§1.4).** The implemented vote is bps allocation across active vaults for Portfolio Router weights (resolved). Unresolved is the mechanic for any *future agent-token shortlist* vote: ranked-choice over the shortlist (whitepaper) vs. token-level bps allocation (source PRD). **TBD**, pending the §1.3 ownership decision.

### 1.B Agent-token vault internals

**Token eligibility / quant-filter methodology (§3.1).** The thresholds are defined ($10M mcap, 90 days, $100K volume, 500 holders) but not the *measurement methodology*: which oracle/aggregator, what averaging window, how disputes are resolved. The PRD mentions "CoinGecko + on-chain" with "consensus required if sources disagree" but does not specify rules. **TBD.** Not needed for the router-weight vote; required before agent-token shortlist governance ships.

**Trading authority and strategy (§3.2).** The whitepaper says the agent trades agent-economy tokens using on-chain signals (volume, holder distribution, treasury health, developer activity), but no doc specifies the trading strategy, position-sizing rules, stop-loss enforcement, or how losses are reported in NAV in real time. Trading authority, strategy, position sizing, and reporting remain **TBD** and are out of scope for Portfolio Router weight governance.

**Intra-vault rebalancing (§3.15).** Basket vaults (protocol-asset and agent-token) allocate new deposits equally across active assets at deposit time; existing positions are not touched when an asset is added or removed, creating drift. Three sub-questions are open:

- **Who triggers rebalancing?** Admin-initiated (keeper calls a rebalance function), keeper-automated on a cadence, or depositor-self-service.
- **What is the target?** Equal weight across current active assets, or a governed weight vector (which would require the basket to adopt router-weight-style governance)?
- **What are the cost and slippage constraints?** A full rebalance requires many swaps in sequence; slippage and fee cost are borne by all shareholders. The product must disclose rebalancing cost before it executes, or defer cost to depositors who trigger it at redemption.

Vault-level rebalancing is distinct from Portfolio Router weight updates, which allocate across vaults rather than within one. **TBD.** The prototype routes only new deposits into equal-weight positions; a `rebalance()` admin function and its cost-disclosure model must be specified before the agent-token vault can meet the PRD's transparent-performance requirement.

### 1.C Vault lifecycle and redemption

**Vault retirement and depositor migration (§3.5).** *Lifecycle resolved.* `contracts/VaultRegistry.sol` has an `Active`/`Paused`/`Retired` status (`setVaultStatus`), and `contracts/PortfolioRouter.sol` excludes non-Active vaults from deposits and previews; the "immutable vault vs. progressive expansion" tension is answered by shipping new exposure as new vaults rather than mutating one. **Open residual:** depositor migration when a vault is retired — retirement is a one-way status and existing depositors can still withdraw, but there is no forced or assisted migration path out of a retiring vault; whether one is needed is unresolved.

**Withdrawal under basket-vault drawdown (§3.7).** *Exclusion resolved.* Router eligibility is registry state — `VaultRegistry.isRouterEligible(vault)`, set by ADMIN_ROLE via `setRouterEligible` — and `contracts/PortfolioRouter.sol` excludes ineligible vaults from allocation and previews; basket vaults stay ineligible by default and are gated out this way today (issue #475). **Open residual:** the explicit redemption policy for a basket vault *in drawdown* — forced sale vs. queued withdrawal vs. NAV haircut — must be specified before ADMIN_ROLE marks any basket vault router-eligible.

> **Research questions** (open-ended modeling and assurance, not product/engineering decisions) live in `docs/technical/research-questions.md` — currently the inclusion-attack economic bounds (§3.8) and protocol-agent resilience (§3.10).

---

## 2. Suggested resolution order

1. **Router-weight vote rules** — close the smoothing / default-weight-vector residual; the core quorum/cadence/threshold/execution path is built (§3.9).
2. **Portfolio Router implementation details** — contract API, preview semantics, failure behavior, receipt delivery, cap model, vote-to-weight execution.
3. **Agent-token vault internals** — shortlist ownership and vote mechanic, whether tiers are needed, token eligibility methodology, trading authority, and intra-vault rebalancing, gated by the inclusion-attack modeling in `docs/technical/research-questions.md` §3.8 (§1.3, §1.4, §1.5, §3.1, §3.2, §3.15).
4. **Vault lifecycle** — depositor migration on retirement and basket-drawdown redemption policy; the status lifecycle and prototype exclusion are built (§3.5, §3.7).
