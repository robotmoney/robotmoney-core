# ROBOT MONEY
## Autonomous Treasury Management for AI Agents

**Gen Ventures × ZHC**

> **Frozen historical artifact.** Where this plan conflicts with
> other source papers in `docs/papers/`, the resolution is recorded in
> `docs/technical/source-doc-reconciliation.md` (issue #92). See that
> ADR before treating any passage here as authoritative.

---

## The Problem

AI agents on Base and across the Lobster/OpenClaw ecosystem hold concentrated treasuries — typically 100% exposure to their own token. This is the equivalent of a startup keeping its entire balance sheet in its own equity. It's fragile, undiversified, and leaves agents one bad week away from insolvency.

There is no treasury management layer for agents. No way for an AI agent to de-risk its holdings, diversify into yield-bearing stablecoins, or gain exposure to a broader basket of quality assets. Every agent is on its own.

## The Solution

Robot Money is an autonomous treasury manager for AI agents. It provides a set of vaults that allow agents (and their holders) to diversify exposure from concentrated single-token positions into higher-quality, de-risked portfolios.

The protocol starts simple — a stablecoin vault that gives agents access to yield-bearing stable assets — and expands progressively into diversified baskets of robot coins, and eventually into fundamentals-driven protocol and DeFi tokens.

$RM is the protocol's governance token. Holding $RM aligns capital with influence over asset allocation decisions: which tokens are included in baskets, how vault strategies are weighted, and which new asset classes are added. This alignment mechanism ensures that those with the most at stake have the greatest say in how the protocol's capital is deployed.

The entire protocol is publicly managed by an AI agent persona — a lobster/OpenClaw identity that serves as the face, voice, and operator of Robot Money.

---

## Token Architecture

### $RM v1 — Genesis Token

Launched on Base via Clanker/Lobsters. This is the community formation token — it establishes the holder base, seeds initial liquidity, and gives the market a way to express conviction in the Robot Money vision. $RM v1 is backed by a live stablecoin vault from day one.

### $RM v2 — Protocol Token

Custom contract with staking and governance mechanics. $RM v2 is the token that powers the full protocol — vault allocation governance, fee distribution, and capital-aligned influence over portfolio construction. Designed during Phase 2, deployed in Phase 3.

### v1 → v2 Exchange

$RM v1 holders can exchange into $RM v2 at a defined rate via a dedicated liquidity pool or exchange mechanism. Early exchangers may receive a bonus to reward early conviction. The v1 token may continue to trade independently — the exchange is an upgrade path, not a forced migration.

---

## Product Timeline

### PHASE 1 — Launch (Weeks 1–2)

| Step | Deliverable | Detail | Owner | Gating Item |
| --- | --- | --- | --- | --- |
| 1.1 | Whitepaper v1 | • Problem: agents hold concentrated, undiversified treasuries<br>• Solution: autonomous treasury manager with progressive vault expansion<br>• Tokenomics, fee structure, v1/v2 architecture<br>• Published by agent persona | Gen Ventures | None |
| 1.2 | $RM v1 token on Base | • Deploy via Clanker on Base/Lobsters<br>• Initial liquidity seeded at launch<br>• v2 exchange path documented from day one | ZHC / Tom | Whitepaper live |
| 1.3 | Genesis stablecoin vault | • USDC or DAI vault live at token launch<br>• Simple deposit/withdraw, single-strategy yield<br>• First de-risking tool for agents: move from 100% own-token to stables<br>• Aave, Sky, or Compass Labs API as backend | Corbin + Nevermined | Vault infra decision |
| 1.4 | Agent persona live | • Lobster/OpenClaw identity as public face of Robot Money<br>• All announcements and social from agent<br>• Farcaster, CT, Lobster social channels | ZHC / Tom | Token deployed |

✓ **MILESTONE:** Live token + live vault + active agent. Robot Money exists and agents can start de-risking.

### PHASE 2 — Vault Expansion + v2 Design (Weeks 3–8)

| Step | Deliverable | Detail | Owner | Gating Item |
| --- | --- | --- | --- | --- |
| 2.1 | Multi-strategy stables vault | • Diversified allocation across USDE, Aave, Sky<br>• Agents gain exposure to multiple yield sources, not just one<br>• TVL growth validates the treasury management thesis | Corbin + Nevermined | Genesis vault stable |
| 2.2 | $RM v2 contract design | • Staking and governance mechanics<br>• Capital-aligned influence over allocation decisions<br>• v1 → v2 exchange mechanism and rate<br>• Audit and testing | Gen Ventures | Spec finalized |
| 2.3 | Agent social automation | • AI agents posting on Moltbook and Lobster networks<br>• Automated vault performance and allocation updates<br>• Narrative maintained without manual effort | ZHC | Agent infra ready |

✓ **MILESTONE:** Diversified stables vault with growing TVL. v2 contract in audit. Treasury management thesis validated.

### PHASE 3 — Robot Coin Baskets + Governance (Weeks 8–16)

| Step | Deliverable | Detail | Owner | Gating Item |
| --- | --- | --- | --- | --- |
| 3.1 | $RM v2 launch + exchange | • Deploy $RM v2 with full governance mechanics<br>• Open v1 → v2 exchange with early-mover bonus<br>• v1 continues trading — exchange is an upgrade path | Gen Ventures | Audit complete |
| 3.2 | Diversified robot coin baskets | • Curated baskets of Lobster/OpenClaw tokens<br>• Agents diversify from own-token into basket exposure<br>• Inclusion criteria based on liquidity, activity, fundamentals | Corbin + Nevermined | v2 live |
| 3.3 | Allocation governance | • $RM v2 holders govern basket composition and weighting<br>• Capital-aligned influence: holding $RM = voice in allocation<br>• Projects can align with $RM holders to support their inclusion<br>• Creates demand for $RM as the protocol's allocation universe grows | Gen Ventures | Baskets live |

✓ **MILESTONE:** Agents can de-risk into stables AND diversified robot coin baskets. $RM holders govern allocation.

### PHASE 4 — Multi-Asset & Scale (Week 16+)

| Step | Deliverable | Detail | Owner | Gating Item |
| --- | --- | --- | --- | --- |
| 4.1 | Yield optimization | • Automated yield maximization on stables vault<br>• Evaluate Giza, Sail, or custom optimizer | TBD | TVL justifies cost |
| 4.2 | Protocol & DeFi tokens | • Expand allocation universe beyond robot coins<br>• Fundamentals-driven protocol tokens, revenue-generating DeFi<br>• Agent payment infrastructure integration<br>• Robot Money becomes a full-spectrum autonomous allocator | Gen Ventures | Governance proven |
| 4.3 | Team & capitalization | • Dedicated team buildout as protocol scales<br>• Revenue-fund or raise based on traction<br>• Formalize long-term governance structure | Gen Ventures | Product-market fit |

✓ **MILESTONE:** Full autonomous treasury manager. Stables, robot coins, protocol tokens. The financial infrastructure layer for the agent economy.

---

## Go-to-Market Timeline

### GTM 1 — Attention & Early Distribution (Launch Week)

| Step | Action | Detail | Owner | Gating Item |
| --- | --- | --- | --- | --- |
| G1.1 | Token + vault launch | • Agent persona announces Robot Money with live vault<br>• Whitepaper published simultaneously<br>• Day-one narrative: agents can finally de-risk their treasuries | ZHC / Tom | Token + vault live |
| G1.2 | Distribution push | • Farcaster, Crypto Twitter, Base ecosystem channels<br>• All comms from agent persona — not human team<br>• Seed holder base via Lobsters/OpenClaw network | Agent / ZHC | Persona live |

### GTM 2 — Agent-Driven Social (Weeks 2–8)

| Step | Action | Detail | Owner | Gating Item |
| --- | --- | --- | --- | --- |
| G2.1 | Automated social presence | • AI agents post on Moltbook and Lobster social networks<br>• Vault performance, allocation updates, market commentary<br>• Sustains narrative without manual effort | Agent | Agent infra |
| G2.2 | Ecosystem integration | • Build relationships with Lobster/OpenClaw projects<br>• Position Robot Money as the treasury layer for the ecosystem<br>• Onboard agents looking to diversify | Agent / ZHC | Ongoing |

### GTM 3 — Product Marketing (Post-Vault Expansion)

| Step | Action | Detail | Owner | Gating Item |
| --- | --- | --- | --- | --- |
| G3.1 | Formal product launch | • Announce diversified baskets, $RM v2, and governance<br>• Press, DeFi partnerships, protocol integrations<br>• Infrastructure partner story | Gen Ventures | Vaults live + tested |
| G3.2 | Institutional outreach | • Larger allocators, DeFi protocols, partnerships<br>• TVL and revenue-driven narrative<br>• Hiring and longer-term capitalization | Gen Ventures | TVL traction |

---

## Immediate Decisions (Pre-Launch)

1. **Genesis vault infrastructure:** Compass Labs API, direct Aave/Sky integration, or custom build. Must ship with the token — vault is live on day one.
2. **Stablecoin selection:** USDC, DAI, or USDE for the genesis vault. Single asset to start.
3. **Agent persona:** Identity, hosting, posting infrastructure, and ongoing cost.
4. **Tokenomics:** Supply, fee structure, initial allocation, and v1/v2 exchange terms. All in the whitepaper before launch.
5. **Clanker terms:** Confirm exact fee structure. Factor into v2 exchange economics.
6. **Audit budget and timeline** for $RM v2 contract (Phase 2–3 dependency).
