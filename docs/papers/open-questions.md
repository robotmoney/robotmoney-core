# Robot Money — Open Questions

> **Cross-document contradictions in §1 are resolved.** See
> `docs/technical/source-doc-reconciliation.md` (issue #92) for the
> chosen answer per question, with rejected alternatives.
> §2 (source-doc TODOs) and §3 (gaps) are tracked there for status
> only — they remain open product-owner work.

Unresolved questions derived from reading the three source documents kept locally under `docs/papers/`:

- `Robot-Money-Whitepaper-v01` (Protocol Specification v0.1, February 2026)
- `robot_money_plan_v4` (Gen Ventures × ZHC plan)
- `robot_money_prd` (PRD MVP v1.0, March 2026)

> **Source docs are confidential and local-only.** The PDF/docx originals and their verbatim markdown conversions are not committed to this repository (see `.gitignore`). This document is the public surface; quotations and section references below are the only public reflection of the source-doc contents.

The docs were authored at different moments with different scopes and were not reconciled before being collected here. This document captures (1) cross-document contradictions that require a product decision, (2) open questions the source docs explicitly flag, and (3) gaps that none of the docs address.

Where applicable, each item carries a **Product owner input** note capturing direction conveyed verbally by the product owner (Lex Sokolin, 2026-05-06). These are stated intentions, not yet written into specs the repo can verify, but they reflect current thinking. Treat them as one input — not a final resolution.

---

## 1. Cross-document contradictions

These are points where two or more documents make incompatible claims. Each needs a decision before any of the docs can be published externally as a coherent set.

### 1.1 One token or two?

*Resolved in [`docs/technical/source-doc-reconciliation.md` §1.1](../technical/source-doc-reconciliation.md).*

- **Whitepaper**: single `$ROBOTMONEY`, fixed 1B supply via Clanker v4, LP locked until 2100. Value accrues only through buyback-and-burn from prop-wallet realized gains. Explicitly: "no inflationary yield … staking $ROBOTMONEY does not earn more $ROBOTMONEY."
- **Plan v4**: two-token path. `$RM v1` (Clanker community token) → `$RM v2` (custom contract with **staking and fee distribution**), v1→v2 exchange with early-mover bonus.
- **PRD**: single `$RM`, governance only. No v1/v2.

**Question:** Is there a v2 protocol token with staking and fee distribution, or is the burn-only Clanker token the permanent design?

**Why it matters:** Plan v4's "fee distribution to stakers" directly contradicts the whitepaper's burn-only accrual. The two cannot both be true. This also determines whether early `$RM` buyers face dilution/migration risk.

**Product owner input:** Token is "a voting heartbeat for AIs to contribute to allocation voting and try to bribe in their own assets to vaults." Framed as governance + a designed-in bribery flow, not a yield-bearing instrument. Described as a "separate build attempt … described in specs" not in this repo. Consistent with single-token, governance-only.

### 1.2 Vault: three-bucket from launch, or stables-first?

*Resolved in [`docs/technical/source-doc-reconciliation.md` §1.2](../technical/source-doc-reconciliation.md).*

- **Whitepaper**: 33/33/33 stables / agent-token trading / revenue tokens **from day one**. Monthly bucket-weight rebalance.
- **Plan v4**: stables-only genesis vault in Phase 1. Robot-coin baskets in Phase 3 (Weeks 8–16). Protocol/DeFi tokens Phase 4.
- **PRD**: vault is referred to as future ("before the vault ships"); CFO Feed exists partly to fill the gap.

**Question:** What is in the vault on day one — three buckets or a single-strategy stables vault?

**Why it matters:** Affects launch-week TVL targets, smart-contract scope, audit surface, and the GTM narrative ("managed three-bucket exposure" vs. "stable yield, expanding").

**Product owner input:** Architecture is multi-vault, not multi-bucket-in-one-vault: *"multi-vault of n vaults, and then receipt tokens for vaults, and then that maybe or maybe not wrapped into a vault. Perhaps people can opt into different mixes of exposure."* Specific vaults named: stables ("sort of done"; Giza and Zyfai mentioned as additional strategy candidates), a protocol vault (ETH/BTC/SOL), an agent-token vault ("not done", with the voting/bribery use case attached), and a possible RWA vault (SP500 via a Hyperliquid position; commodities). Veda was considered as an off-the-shelf provider; the team chose to build in-house. Reframes the question: not three-bucket-vs-stables-first but a sequence of separate vault contracts with optional meta-vault wrapping (see §3.11, §3.12).

### 1.3 Shortlist curation: top-down or bottom-up?

*Resolved in [`docs/technical/source-doc-reconciliation.md` §1.3](../technical/source-doc-reconciliation.md).*

- **Whitepaper**: the protocol's agent runs the quant screen and **publishes** the shortlist of 10–15 tokens. Holders only rank.
- **PRD**: any Analyst-tier (100M `$RM`) agent **proposes** tokens. 48h Approve/Reject inclusion vote at 3% quorum. 15-token cap with displacement rules.

**Question:** Who decides what is on the shortlist — the protocol agent (curated) or `$RM` holders via inclusion proposals (community-driven)?

**Why it matters:** Different governance topologies. Curated is faster and lower-overhead; proposal-driven creates `$RM` demand from projects wanting inclusion. The PRD's whole eligibility/tier/activity machinery only exists if the answer is proposal-driven.

**Product owner input:** The bribery flow ("AIs … try to bribe in their own assets to vaults") is explicitly designed-in, which reads as bottom-up: agents pay/lobby `$RM` to push their tokens into the agent-token vault. Mechanics deferred to "specs."

### 1.4 Voting mechanic for weekly allocation

*Resolved in [`docs/technical/source-doc-reconciliation.md` §1.4](../technical/source-doc-reconciliation.md).*

- **Whitepaper**: ranked-choice voting over the shortlist.
- **PRD**: basis-point allocation (each agent distributes 0–10,000 bps across up to 15 tokens), weighted by `$RM` balance.

**Question:** Ranked choice or weighted bps allocation?

**Why it matters:** They produce different outcomes from the same inputs and require different UI, tally logic, and gaming-resistance analysis.

**Product owner input:** Mechanics not specified beyond "voting heartbeat" framing and the bribery flow. Treated as part of the separate token-side build described in specs.

### 1.5 Tier system: yes or no?

*Resolved in [`docs/technical/source-doc-reconciliation.md` §1.5](../technical/source-doc-reconciliation.md).*

- **PRD**: four tiers (Observer / Participant 10M / Analyst 100M / Strategist 500M) with 14-day activity gate for Analyst+ governance actions.
- **Whitepaper & Plan v4**: no tiers. Anyone with `$RM` can vote, linear weight.

**Question:** Are governance rights gated by both balance tier and recent activity, or only by balance?

**Why it matters:** The activity gate is the PRD's main sybil defense. Removing it weakens governance; keeping it requires the CFO Feed as a prerequisite product.

### 1.6 Vault structure: bucketed or flat?

*Resolved in [`docs/technical/source-doc-reconciliation.md` §1.6](../technical/source-doc-reconciliation.md).*

- **Whitepaper**: Bucket A/B/C is structurally central (risk floor, alpha, middle ground). Monthly votes shift bucket *weights*.
- **PRD**: flat list of up to 15 tokens with bps weights. No bucket vocabulary, no bucket-weight vote.
- **Plan v4**: "baskets" — closer to buckets, undefined.

**Question:** Is the vault organized as three risk buckets with intra-bucket selection, or as a flat token list with direct weights?

**Why it matters:** The whitepaper's monthly bucket rebalance vote has no surface in the PRD's governance flows. If buckets are real, the PRD is missing a workflow.

**Product owner input:** Neither bucketed nor flat — multi-vault with receipt tokens, optionally wrapped into a meta-vault (see §1.2 and §3.12). Each asset class is its own vault; "different mixes of exposure" come from combining receipts or from depositing into a wrapper. Closest reference: Veda. This is a third architecture not described in any of the three source papers.

### 1.7 Sequencing: what ships first?

*Resolved in [`docs/technical/source-doc-reconciliation.md` §1.7](../technical/source-doc-reconciliation.md).*

- **Whitepaper**: vault contract Week 1–2, token Week 3, first deposits Weeks 4–8. Vault and token roughly simultaneous.
- **Plan v4**: vault + token + agent persona simultaneous in Phase 1 (Weeks 1–2).
- **PRD**: `$RM` is **already live and trading**; vault is **not yet shipped**; CFO Feed is the stopgap.

**Question:** Was the vault live at token launch, will it be, or has the plan now changed to "token first, CFO Feed second, vault later"?

**Why it matters:** The whole strategic story differs. If the vault is not at launch, the whitepaper's day-one fee economics and prop-wallet seeding from launch fees are not yet operative, and `$RM` is purely speculative until the vault ships.

**Product owner input:** Confirms vault-first, with stables vault "sort of done" and the rest staged behind it. Token side is described as a separate build in specs. The current Base deployment is treated as a POC ("this is just POC"); the production deployment target is undecided but explicitly *not* Base — see §3.11.

### 1.8 Customer wedge

*Resolved in [`docs/technical/source-doc-reconciliation.md` §1.8](../technical/source-doc-reconciliation.md).*

- **Whitepaper**: agents with **idle USDC** seeking diversified managed exposure.
- **Plan v4**: agents **over-concentrated in their own token** seeking to de-risk into stables.
- **PRD**: agents seeking **analytical credibility and governance influence** (CFO Feed).

**Question:** Which is the primary go-to-market wedge?

**Why it matters:** Each wedge implies different onboarding flows. The plan-v4 framing also implicitly requires a swap path (own-token → USDC) that the whitepaper assumes has already happened.

**Product owner input:** Implies a wedge broader than any single source paper: agent-economy treasuries on chains with real payment activity. Polygon mentioned for its payment-activity user base; mainnet for "real" use cases. The agent-token vault carries the bribery/voting use case (governance demand for `$RM`); the RWA vault carries a story-telling use case (SP500/commodities exposure for narrative). The customer is still agents, but the product surface is broader than just "park idle USDC."

---

## 2. Questions the source docs themselves flag

These are explicitly listed as open in the originals. Re-stated here for tracking.

### From Whitepaper §11

- **Legal entity structure.** Vault accepts deposits and charges a management fee; in most jurisdictions this is fund management. Likely needs offshore foundation (Cayman, BVI) or DAO legal wrapper (Wyoming, Marshall Islands). Counsel review pre-launch.
- **Performance fee.** Whether to add a 20%-of-gains-above-hurdle fee in addition to the 2% management fee. Deferred to Phase 4 pending track record.
- **Deposit caps.** Whether to cap total deposits during bootstrap to limit smart-contract risk exposure. Whitepaper recommends $500K cap in Phase 2, lifted after 60 days incident-free.
- **Multi-chain expansion.** Whether to deploy cross-chain (CCIP, LayerZero) if agent activity migrates from Base. Deferred to Phase 5. *Product owner input: explicitly reverses the whitepaper's Base-default. "We dont want to stay on base or with the base token, this is just POC." Polygon for payment activity, Ethereum mainnet for "more real" deployments. Peaq considered for omnichain agent wallets/IDs but the tech is "still half baked." See §3.11.*
- **Agent identity verification.** Whether the vault should verify depositors are agents and not humans. Current answer: no — vault is permissionless.

### From Plan v4 "Immediate Decisions (Pre-Launch)"

- Genesis vault infrastructure: Compass Labs API vs. direct Aave/Sky vs. custom build.
- Stablecoin selection for the genesis vault: USDC vs. DAI vs. USDE.
- Agent persona: identity, hosting, posting infrastructure, and ongoing cost.
- Tokenomics: supply, fee structure, initial allocation, v1/v2 exchange terms.
- Clanker terms: exact fee structure, factored into v2 exchange economics.
- Audit budget and timeline for `$RM v2` (Phase 2–3 dependency).

---

## 3. Gaps — questions none of the docs answer

Topics that are load-bearing for the protocol but not addressed in any source document.

### 3.1 Quant filter operationalization

The thresholds are defined ($10M mcap, 90 days, $100K volume, 500 holders) but not the *measurement methodology*: which oracle/aggregator, what averaging window, how disputes are resolved. The PRD mentions "CoinGecko + on-chain" with "consensus required if sources disagree" but does not specify rules.

### 3.2 Bucket B trading: who is the trader?

The whitepaper says "the agent trades agent-economy tokens using on-chain signals (volume, holder distribution, treasury health, developer activity)" but no doc specifies the trading strategy, position-sizing rules, stop-loss enforcement, or how losses are reported in NAV in real time. The 10%-of-Bucket-B position cap is mentioned once with no enforcement mechanism described.

### 3.3 Prop wallet seeding and accounting

The whitepaper says the prop wallet is "seeded from Clanker launch fees" but does not quantify expected initial capital, nor specify how the prop wallet's PnL accounting handles unrealized gains, mark-to-market reporting, or tax-lot identification for buyback triggers.

### 3.4 Multisig composition and trust

The PRD's MVP relies on a 2-of-3 multisig to relay Snapshot results to `vault.rebalance()`. No doc names signers, defines challenge-window dispute resolution, or specifies what happens if signers disagree with the published tally.

### 3.5 Vault upgrade path

The whitepaper says "no upgradeability — immutable contract." But Plan v4 and the PRD describe progressive expansion (new buckets, new strategies, Chainlink Automation, on-chain governance contract). How is "immutable vault" reconciled with "progressive expansion"? Is each phase a new vault deployment with a migration path?

### 3.6 Agent CFO Feed economics

The PRD describes a content product (registration, posting, upvoting, comments) with no fee model. Hosting, RPC, IPFS, and moderation costs are not allocated. Does the CFO Feed run on protocol revenue, separate funding, or fees?

### 3.7 Withdrawal mechanics under Bucket B drawdown

Redemptions are at NAV minus 0.25% exit fee. No doc specifies what happens when Bucket B (high-risk active positions) is mid-trade and a depositor wants to exit — forced sale, queued withdrawal, or NAV haircut?

### 3.8 Inclusion-attack economic bounds

The whitepaper argues the inclusion attack is self-punishing because attackers' `$RM` loses value if their token underperforms. But the magnitude is not modeled: how much `$RM` must an attacker hold to swing weekly allocation, vs. how much vault buy pressure that produces, vs. expected loss on `$RM` from underperformance? Without numbers, "self-punishing" is an assertion, not a proof.

### 3.9 Quorum cliff

If the weekly vote falls just below 5%, the agent default executes; if just above, voted weights execute. No doc addresses smoothing — e.g., a continuous blend between voted and default weights as quorum scales — to avoid governance whiplash week-to-week.

### 3.10 Failure modes for the protocol agent itself

The protocol agent is a single point of failure: it publishes shortlists, runs the default allocation, executes rebalances, and posts the public narrative. No doc addresses what happens if the agent goes offline, is compromised, hallucinates a bad allocation, or its operator wants to step away. There is no agent-of-last-resort or emergency pause that names a controller.

### 3.11 Production chain selection

The Base deployment is described by the product owner as a POC, with the production target explicitly elsewhere. Polygon and Ethereum mainnet are named, but no chain is committed. This is a load-bearing decision: it determines the integration set (which DeFi venues, which payment rails, which wallets), the audit scope, and whether the existing adapters need to be re-implemented for new venues.

*Product owner input: "We dont want to stay on base or with the base token, this is just POC." Polygon for payment activity, mainnet for "more real" use. Peaq considered for omnichain agent wallets/IDs but tech is half-baked.*

### 3.12 Multi-vault wrapping mechanism

The product owner describes "n vaults" with receipt tokens, optionally wrapped into a meta-vault that lets users opt into mixes of exposure. None of the source papers describe this, and the deployed contract is a single ERC-4626. Open: is the wrapper an ERC-4626-of-ERC-4626 (share-of-shares), a router that bundles deposits, an off-chain composite product, or something else? Who sets the mix weights — depositor at deposit time, governance, or the product?

*Product owner input: structure described as "multi-vault of n vaults, and then receipt tokens for vaults, and then that maybe or maybe not wrapped into a vault. Perhaps people can opt into different mixes of exposure." Reference point: Veda.*

### 3.13 Build-vs-buy commitment

The product owner introduced existing portfolio-management providers (Veda named as the largest), and the team chose to build in-house anyway — described as "opening the can of worms." This raises an implicit question of scope: how much of the multi-vault platform is in-scope to build, and at what point would integrating Veda (or Giza/Zyfai for the stables vault) be revisited?

*Product owner input: build-in-house decision is current; Giza and Zyfai are named as potentially interesting for the stables vault specifically.*

### 3.14 RWA vault feasibility

The product owner mentioned an RWA vault built around a Hyperliquid SP500 perp position, possibly extended to commodities — primarily a "story telling" exposure. None of the source papers describe RWA, and the regulatory and execution mechanics are non-trivial: a perp position is not a spot RWA, and exposing depositors to perp funding/liquidation risk through a "vault" framing has user-protection implications.

*Product owner input: RWA vault flagged as a future build for narrative value.*

---

## 4. Suggested resolution order

If decisions need to be sequenced:

1. **§3.11 (production chain selection)** — gates everything else: integration set, adapter rebuild, audit scope, regulatory reading.
2. **§1.1 (one token vs. two)** — affects token economics, legal structure, and token-side build.
3. **§1.2 / §1.6 / §3.12 (multi-vault architecture and wrapping)** — interlocking. The PO input introduces a multi-vault platform that may extend beyond the §1.2/§1.6 ADR resolutions; revisit those resolutions in light of the new framing.
4. **§3.13 (build vs. buy)** — once the architecture is clear, decide which vaults to build vs. integrate (Veda, Giza, Zyfai).
5. **§1.7 (sequencing)** — falls out of §1.2 and §3.13.
6. **§1.3, §1.4, §1.5 (governance shape)** — interlocking; resolve as a set, after the vault platform shape is settled.
7. **§1.8 (customer wedge)** — narrative; can follow product decisions.
8. **§3.14 (RWA vault feasibility)** — separable, can run in parallel.
9. **§2 items** — defer per the source docs' own phasing.
10. **Remaining §3 gaps** — surface as design tasks once §1 and §2 are settled.
