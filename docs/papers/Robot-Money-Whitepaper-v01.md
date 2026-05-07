> Confidential and Privileged
> Not for distribution

> **Frozen historical artifact.** Where this paper conflicts with
> other source papers in `docs/papers/`, the resolution is recorded in
> `docs/technical/source-doc-reconciliation.md` (issue #92). See that
> ADR before treating any passage here as authoritative.

# ROBOT MONEY
## An Autonomous Treasury for the Agent Economy

────────────────────────────────────────────────────────────

**Protocol Specification v0.1**
**February 2026**
For agent operators, protocol treasuries, and institutional participants.

---

## 0. Abstract

Robot Money is a managed vault on Base that accepts USDC deposits from autonomous agents and allocates across three strategies: stable yield (Aave/Compound), active agent-token trading, and revenue-generating liquid positions. A 2% annual management fee, charged daily, funds a proprietary trading wallet that runs the same book. The $ROBOTMONEY token, launched via Clanker on Uniswap v4, governs weekly allocation votes. When no external votes are cast, the protocol's own agent executes its default allocation. Realized gains from the proprietary wallet buy back and burn $ROBOTMONEY from the open market.

The protocol is designed for a specific customer: AI agents with idle treasury balances that need diversified, managed exposure without building their own trading infrastructure. Human participation is possible through the same vault interface or by holding $ROBOTMONEY for governance influence.

This document specifies the system architecture, mechanism design, fee economics, governance structure, go-to-market strategy, and revenue projections at multiple scales. It is written for an audience that evaluates mechanisms, not narratives.

---

## 1. Problem Statement

As of February 2026, the Base agent economy has produced over 18,000 tokenized agents (Virtuals Protocol), processed $600M+ in x402 micropayments, and generated $50M+ in cumulative Clanker launch fees. Every agent with a wallet accumulates revenue. Most of that capital sits idle.

The problem is structural. Agents have three options for treasury management: (1) hold ETH/USDC and earn nothing, (2) deposit into DeFi protocols directly, which requires integration work per protocol, or (3) trade actively, which requires building and maintaining a trading stack. Options 2 and 3 are engineering-intensive. Most agent operators choose option 1 by default.

Robot Money eliminates this engineering burden. One USDC transfer to the vault contract. Diversified, actively managed exposure. Withdraw at NAV anytime. The agent's operator writes one integration, not twenty.

---

## 2. System Architecture

The protocol consists of three components: the Vault (holds third-party capital), the Token (governs allocation), and the Prop Wallet (holds protocol-owned capital). Each is a separate contract with defined interfaces between them.

### 2.1 System Diagram

```
                    DEPOSITORS (Agents + Humans)
                              |
                         USDC deposit
                              |
                              v
  +----------------------------------------------------------+
  |                    VAULT (ERC-4626)                      |
  |                                                          |
  |   Bucket A (33%)     Bucket B (33%)    Bucket C (33%)    |
  |   Aave/Compound      Robot coin        Revenue tokens    |
  |   USDC/USDT only     active trading    (liquid, vetted)  |
  |                                                          |
  |   ---- 2% annual mgmt fee (daily accrual) ------------>  |
  +----------------------------------------------------------+
                              |
                         fee sweep
                              |
                              v
  +----------------------------------------------------------+
  |                    PROP WALLET                           |
  |                                                          |
  |   Same 3-bucket allocation                               |
  |   + trades $ROBOTMONEY in Bucket B                       |
  |   + receives 40% Clanker swap fees                       |
  |                                                          |
  |   Realized gains --> buyback $RM --> burn (dead addr)    |
  +----------------------------------------------------------+
                              ^
                              |
                     40% swap fees
                              |
  +----------------------------------------------------------+
  |               $ROBOTMONEY TOKEN                          |
  |               Clanker v4 / Uniswap v4                    |
  |               LP locked until 2100                       |
  |                                                          |
  |   Holders vote on weekly allocation                      |
  |   Default: agent's own allocation executes               |
  +----------------------------------------------------------+
```

### 2.2 The Vault

An ERC-4626 tokenized vault on Base. Accepts USDC. Returns vault shares representing pro-rata claim on underlying assets. Permissionless — any address (agent or human) can deposit and withdraw. Redemptions at current NAV minus a 0.25% exit fee that remains in the vault as an anti-churn mechanism.

The vault allocates across three buckets with target weights set by governance:

| Bucket | Strategy | Assets | Target | Risk |
| --- | --- | --- | --- | --- |
| A | Stable yield | USDC/USDT on Aave, Compound, Morpho on Base | 33% | Low |
| B | Agent-token trading | Active positions in tokens passing quantitative filter | 33% | High |
| C | Revenue liquid tokens | Established tokens with on-chain revenue (EtherFi, Hyperliquid, Virtuals, etc.) | 33% | Medium |

Bucket A is the stability anchor. It generates 3–6% APY on stablecoins with near-zero risk of principal loss. Bucket B is the alpha engine. The agent trades agent-economy tokens using on-chain signals (volume, holder distribution, treasury health, developer activity). Bucket C is the middle ground — tokens with verifiable revenue streams that pass the protocol's investment framework: minimum $10M market cap, minimum 90 days live, minimum $100K daily volume, on-chain revenue verifiable.

### 2.3 The Token

$ROBOTMONEY is launched via Clanker v4 on Base. Fixed supply of 1B tokens. No team allocation. Fair launch: all tokens enter the Uniswap v4 pool via Clanker's liquidity staircase (up to 7 LP positions across price bands). LP locked until 2100 by Clanker's locker contract. MEV protection via ClankerMevDescendingFees (starting fee up to 80%, decaying parabolically over 2 minutes).

Fee routing: 40% of swap fees to the protocol's prop wallet (creator share), 40% to the launch interface (Bankr or partner), 20% to Clanker protocol. The 40% creator share is a permanent revenue stream for Robot Money tied to trading volume on the token.

The token serves exactly one function: governance over vault allocation. It does not entitle holders to vault returns. It does not represent a share of AUM. This separation is by design — the vault is the investment product, the token is the steering mechanism.

### 2.4 The Prop Wallet

A protocol-owned trading wallet on Base (Coinbase Agentic Wallet). Receives two income streams: (1) daily management fee sweep from the vault, (2) 40% Clanker swap fees on $ROBOTMONEY. Runs the same three-bucket allocation as the vault but additionally trades $ROBOTMONEY in Bucket B. All holdings visible on BaseScan.

When the prop wallet realizes gains (closes a position at profit), the realized PnL triggers a deterministic buyback: the wallet buys $ROBOTMONEY on the Uniswap v4 pool and sends purchased tokens to the dead address (0x000...dEaD). Every burn has an on-chain receipt. When the prop wallet realizes losses, no buyback occurs. Losses are published with the same transparency as gains.

---

## 3. Governance

### 3.1 Allocation Voting

Weekly cycle. The Robot Money agent runs a quantitative screen and publishes a shortlist of 10–15 tokens that pass the investment framework filters for Buckets B and C. The shortlist, with supporting data (volume, holders, revenue, treasury size, age), is published to X and Moltbook.

$ROBOTMONEY holders rank their preferred allocations over a 48-hour window. Votes are weighted by token balance. Results determine which tokens enter each bucket and at what weight. The agent executes the rebalance on-chain.

Default behavior: if fewer than 5% of circulating supply votes, the agent's own ranked allocation executes. This ensures the fund always has a strategy. Early on, the agent effectively manages the fund solo. As the token distributes and voters emerge, external preferences gradually override the default.

### 3.2 The Inclusion Attack

An agent can buy $ROBOTMONEY to vote its own token into the portfolio, creating buy pressure from the vault's USDC. This is the primary governance attack vector. The protocol treats it as a feature, not a bug, with one hard constraint:

The quantitative filter is the gate, not the vote. Tokens must meet minimum thresholds to appear on the ballot: $10M market cap, 90+ days live, $100K+ daily volume, 500+ unique holders, verifiable on-chain revenue or treasury. Votes allocate weight among qualifying tokens only. An agent cannot vote a token onto the ballot that the filter has excluded.

Under this constraint, the inclusion attack becomes economically rational participation: an agent buys $ROBOTMONEY (supporting the token price), votes for its own established, qualifying token (which has already demonstrated fundamental health), and if that token underperforms, the vault's NAV drops, depositors withdraw, fees decline, and the $ROBOTMONEY the agent purchased to gain influence loses value. The attacker is punished by the same flywheel it tried to exploit.

### 3.3 Monthly Weight Rebalance

Bucket weights (the 33/33/33 default) are subject to monthly governance votes. Token holders can shift allocation, e.g., 50% stables / 25% trading / 25% liquid in a downturn. The agent proposes weight shifts with supporting analysis. If no quorum, weights remain unchanged.

---

## 4. Fee Economics and Revenue Projections

### 4.1 Revenue Streams

| Stream | Mechanism | Recipient |
| --- | --- | --- |
| Management fee | 2% annual on vault AUM, accrued daily (0.00548%/day) | Prop wallet |
| Clanker swap fees | 40% of 1% fee on every $ROBOTMONEY swap | Prop wallet |
| Vault exit fee | 0.25% of withdrawal amount | Remains in vault (benefits remaining depositors) |
| Prop wallet trading gains | Realized PnL from three-bucket trading | Buyback-and-burn $ROBOTMONEY |
| Bucket A yield | 3–6% APY on stables | Vault NAV (benefits depositors) |

### 4.2 Revenue at Scale

Projections assume 2% management fee, 20% annual vault turnover (exit fees), and Clanker swap volume correlated to TVL. No performance fee is charged. Prop wallet trading gains are excluded from projections as they are speculative.

| Vault TVL | Mgmt Fee/yr | Mgmt Fee/day | Exit Fees/yr | Swap Fees/yr* | Total Rev/yr |
| --- | --- | --- | --- | --- | --- |
| $100K | $2,000 | $5.48 | $50 | $1,200 | $3,250 |
| $500K | $10,000 | $27.40 | $250 | $6,000 | $16,250 |
| $1M | $20,000 | $54.79 | $500 | $12,000 | $32,500 |
| $5M | $100,000 | $273.97 | $2,500 | $60,000 | $162,500 |
| $10M | $200,000 | $547.95 | $5,000 | $120,000 | $325,000 |
| $25M | $500,000 | $1,369.86 | $12,500 | $300,000 | $812,500 |
| $50M | $1,000,000 | $2,739.73 | $25,000 | $600,000 | $1,625,000 |

*Swap fee estimate assumes annual $ROBOTMONEY trading volume at 30% of vault TVL, with protocol capturing 0.4% (40% of 1% Clanker fee). Actual swap revenue is a function of token trading activity, not vault size directly. Correlation assumed for modeling purposes only.

### 4.3 Breakeven Analysis

Protocol operating costs are minimal: agent compute (~$200–500/month for API calls, on-chain execution gas, data feeds), domain/hosting (~$50/month), and monitoring (~$100/month). At a conservative $850/month operating cost:

| Metric | Value |
| --- | --- |
| Monthly operating cost | $850 |
| Annual operating cost | $10,200 |
| Breakeven TVL (mgmt fee only) | $510,000 |
| Breakeven TVL (all revenue) | $315,000 |
| Days to breakeven at $500K TVL | ~230 days (mgmt fee only), ~140 days (all revenue) |

The protocol is cash-flow positive at $500K TVL. Below that, the prop wallet's Clanker swap fee revenue and its own trading gains subsidize operations. The prop wallet is seeded from Clanker launch fees (initial ETH from the fair launch liquidity event) and does not require external funding.

---

## 5. Buyback-and-Burn

The $ROBOTMONEY token accrues value through supply reduction, not yield distribution. The prop wallet is the sole source of buyback pressure. The mechanism is deterministic:

```
  Prop wallet closes position at profit
         |
         v
  Realized gain calculated (USDC terms)
         |
         v
  Buyback: prop wallet buys $RM on Uniswap v4 pool
         |
         v
  Burn: purchased $RM sent to 0x000...dEaD
         |
         v
  Receipt: BaseScan tx hash published to X + Moltbook

  If position closed at loss:
         |
         v
  No buyback. Loss published with same transparency.
```

This design has one critical property: there is no inflationary yield. Staking $ROBOTMONEY does not earn more $ROBOTMONEY. The only value accrual is supply reduction from realized trading gains. If the prop wallet underperforms, the token supply stays flat and the price reflects that. There is no mechanism to disguise poor performance.

### 5.1 Illustrative Burn Scenarios

| Prop Wallet Size | Annual Return | Realized Gains | Burn at $0.001/RM | Supply Reduction |
| --- | --- | --- | --- | --- |
| $50K | 15% | $7,500 | 7.5M tokens | 0.75% |
| $100K | 15% | $15,000 | 15M tokens | 1.5% |
| $250K | 20% | $50,000 | 50M tokens | 5.0% |
| $500K | 20% | $100,000 | 100M tokens | 10.0% |
| $1M | 25% | $250,000 | 250M tokens | 25.0% |

Token price of $0.001 used for illustration. Actual burn quantity depends on market price at time of buyback. Higher token price = fewer tokens burned per dollar of gain.

---

## 6. Go-to-Market Strategy

### 6.1 Primary Channel: Agent Social Networks

Robot Money's first customers are not humans reading newsletters. They are agents with wallets on Base. The go-to-market strategy targets agent discovery surfaces:

**Moltbook.** The protocol's agent creates a Moltbook presence and publishes daily portfolio updates, weekly allocation shortlists, and burn receipts. Moltbook is where agents discover other agents. Robot Money's thesis posts and allocation research function as content marketing within the agent social graph. Agent operators scanning Moltbook for treasury solutions see Robot Money's track record before they ever visit a website.

**Bankr integration.** Bankr is the wallet/identity layer for agent-economy participants. A Bankr SDK integration means any agent using Bankr can deposit to the Robot Money vault with a single API call. The launch itself can be executed via Bankr's Clanker interface, earning Bankr the 40% interface fee and aligning incentives for Bankr to promote Robot Money to its agent user base.

**x402 discovery.** Robot Money can offer its portfolio data (holdings, NAV, allocation weights, historical returns) as an x402-priced API endpoint. Other agents pay micropayments to query the fund's current state. This serves dual purpose: revenue from data access and distribution through the x402 network of agents already making API calls.

**OpenClaw / ClawHub.** Publish Robot Money's vault integration as an OpenClaw skill. Any agent built on the OpenClaw framework can add "deposit idle treasury to Robot Money" as a skill, enabling autonomous treasury management without operator intervention.

### 6.2 Secondary Channel: Human Operators

Agent operators — the humans who build, deploy, and monitor agents — are the decision-makers for treasury allocation even when the agent executes autonomously. Human-facing distribution:

**Fintech Blueprint.** The newsletter audience (~sophisticated fintech/crypto operators) receives the investment thesis, allocation methodology, and performance reporting. This is not a retail pitch; it is a transparent communication channel for the type of person who already runs agents or manages protocol treasuries.

**X / Twitter.** Daily portfolio updates, weekly allocation votes, burn receipts. The Robot Money agent's X presence serves as the public performance record. Every position entry, exit, and allocation shift is posted with BaseScan links.

**Farcaster / Warpcast.** Clanker's native social layer. The token launch itself generates Farcaster engagement. Ongoing casts about allocation votes and fund performance target the Farcaster-native DeFi audience that overlaps heavily with Base agent operators.

### 6.3 Human Participation Modes

Humans can participate in Robot Money through two paths, both using the same infrastructure agents use:

| Mode | How | What You Get |
| --- | --- | --- |
| Vault depositor | Deposit USDC to the vault contract via any Base-compatible wallet (Coinbase Wallet, MetaMask, Rabby) | Vault shares. Exposure to three-bucket allocation. Withdraw at NAV minus 0.25% exit fee. Identical to agent experience. |
| Token holder / voter | Buy $ROBOTMONEY on Uniswap v4 (via Clanker pool) | Governance: vote on weekly allocation and monthly weight rebalance. Economic: benefit from buyback-and-burn if prop wallet performs. No yield, no dividends. |

There is no separate "human product." Humans use the same vault, the same token, the same governance. The interface is a contract, not an app. If a frontend is built later, it's a convenience layer, not a separate product.

---

## 7. Infrastructure

| Layer | Choice | Rationale |
| --- | --- | --- |
| Chain | Base | Agent economy center of gravity. x402, Bankr, Clanker, Virtuals all on Base. Sub-cent transaction fees. Coinbase Agentic Wallet native support. |
| Token launch | Clanker v4 | Fair launch. Uniswap v4 liquidity staircase (7 LP positions). LP locked until 2100. MEV protection via descending fee hooks. Audited by Macro + Cantina. |
| Vault standard | ERC-4626 | Industry-standard tokenized vault. One function to deposit, one to withdraw. Composable with any DeFi aggregator or agent SDK. |
| Agent wallet | Coinbase Agentic Wallet | Purpose-built for agents (Feb 11, 2026). x402 native. Deploy + fund in <2 min via CLI. Built-in spending guardrails. |
| Payments | x402 / USDC | Sub-$0.001 micropayment standard. 50M+ transactions processed. Native to Base agent commerce. |
| Transparency | BaseScan + Arkham | Real-time portfolio visibility. Every transaction, burn, and allocation shift verifiable on-chain. |
| Agent social | Moltbook + Farcaster | Agent-to-agent discovery (Moltbook). Human-readable social (Farcaster/Warpcast). Clanker launches natively on Farcaster. |
| Agent skills | OpenClaw / ClawHub | Vault deposit as a published skill. Enables autonomous agent treasury management. |

---

## 8. Risk Framework

| Risk | Severity | Description | Mitigation |
| --- | --- | --- | --- |
| Vault smart contract exploit | Critical | ERC-4626 vault is hacked; depositor funds lost. | Use audited, battle-tested ERC-4626 implementation (OpenZeppelin). Cap initial deposits during bootstrap phase. No upgradeability — immutable contract. |
| Prop wallet key compromise | Critical | Attacker drains prop wallet. | Coinbase Agentic Wallet guardrails: daily spending limits, multi-sig for transfers above threshold. Prop wallet holds operating capital only, not depositor funds. |
| Bucket B trading losses | High | Agent-token positions lose value, dragging vault NAV. | Bucket B is 33% of portfolio. Position-level stop losses. No single position exceeds 10% of Bucket B. Losses are transparent and bounded. |
| Governance manipulation | Medium | Agent buys $RM to vote its token into portfolio. | Quantitative filter as hard gate. Token must meet $10M cap, 90-day age, $100K volume, 500 holders. Attack cost (buying $RM) is punished if voted token underperforms. |
| Regulatory classification | Medium | Vault or token classified as unregistered security. | Vault charges management fee only (no performance fee). Token has no claim on vault returns. Fair launch, no pre-sale, no promises of return. Legal wrapper (offshore foundation) advisable. |
| Agent economy contraction | Medium | Base agent volumes collapse; Bucket B and C assets lose value. | Bucket A (33% stables) provides floor. Monthly weight vote can shift to 60%+ stables in downturn. Redemptions at NAV ensure depositors can exit. |
| Low TVL / irrelevance | Medium | Vault fails to attract deposits. | Agent-first GTM via Moltbook, Bankr, OpenClaw. Low operating costs ($850/mo) mean the protocol survives at low TVL while building track record. |

---

## 9. Launch Sequence

| Phase | Timeline | Actions | Success Metric |
| --- | --- | --- | --- |
| 0 | Week 1–2 | Deploy ERC-4626 vault (USDC, Base). Set up Coinbase Agentic Wallet for prop wallet. Build quantitative filter (volume, holders, revenue, age thresholds). Define initial Bucket B + C shortlist. Create Moltbook agent profile. | Vault contract deployed and verified on BaseScan. |
| 1 | Week 3 | Launch $ROBOTMONEY via Clanker v4 on Base (Bankr interface). Fair launch, no pre-sale. Prop wallet funded from initial launch fees. Publish investment thesis v1 on X, Moltbook, Fintech Blueprint. | $ROBOTMONEY trading on Uniswap v4 with locked LP. |
| 2 | Weeks 4–8 | Vault accepts first deposits. Agent begins three-bucket allocation. Daily portfolio updates on X + Moltbook. First weekly allocation vote. Publish OpenClaw skill for vault deposits. | $100K TVL. First allocation vote completed. |
| 3 | Months 2–3 | First burn receipt published. x402 portfolio data API live. Bankr SDK integration for one-call deposits. Approach 10–20 agent operators directly for treasury deposits. | $500K TVL. First buyback-and-burn executed. |
| 4 | Months 4–6 | Monthly performance report with full on-chain receipts. Iterate on quantitative filter based on Bucket B/C performance. Evaluate adding performance fee if track record warrants. | $1M+ TVL. Positive prop wallet PnL. |
| 5 | Months 6+ | Scale TVL through agent network effects (depositing agents promote to other agents via Moltbook). Quarterly strategy reviews published. Consider multi-chain expansion if Base agent economy migrates. | $5M+ TVL target. Self-sustaining flywheel. |

---

## 10. Comparable Mechanism Analysis

Three existing protocols inform Robot Money's design. Each contributed a specific mechanism; each also demonstrated a failure mode the protocol explicitly avoids.

| Protocol | Mechanism Adopted | Failure Mode Avoided | Application in Robot Money |
| --- | --- | --- | --- |
| OlympusDAO | Protocol-Owned Liquidity: protocol owns its LP position, earning trading fees permanently and guaranteeing liquidity without paying inflationary rewards to external LPs. | High-APY staking death spiral: 80,000%+ APY funded by inflation attracted mercenary capital. When inflows slowed, unstake-sell-crash cycle destroyed $4B in TVL. | LP locked until 2100 via Clanker. No inflationary staking yield. Prop wallet earns swap fees. Buyback funded by realized gains, not token printing. |
| Botto | Revenue-split governance: 50% of auction revenue to active voters, 50% to treasury. Participation required to earn — no passive income. Survived 3+ years, $5M+ revenue, Sotheby's exhibitions. | DAO governance overhead: voting on artistic direction, treasury spending, marketing all require sustained community engagement that doesn't scale without active operators. | Voting limited to allocation ranking (simple ranked choice). No treasury spending votes. No marketing governance. Agent executes default if quorum not met. Minimal governance surface. |
| AntiHunter | Receipts-first transparency: every treasury movement, buyback, and burn verifiable on BaseScan. Deterministic buyback tied to realized PnL. Published agent-ops architecture open-source. | Single-agent concentration risk: one AI's trading judgment determines all returns. $5M market cap limits scale. No third-party capital — only token-funded treasury. | Separates third-party capital (vault) from protocol capital (prop wallet). Vault diversifies across three buckets with governance-directed allocation. Scale not limited by token market cap. |

---

## 11. Open Questions

**Legal entity structure.** The vault accepts deposits and charges a management fee. In most jurisdictions, this constitutes fund management. An offshore foundation (Cayman, BVI) or a DAO legal wrapper (Wyoming, Marshall Islands) is likely required. Legal counsel should review before launch.

**Performance fee.** The current design charges only a management fee (2%). A performance fee (e.g., 20% of gains above a hurdle rate) would increase prop wallet revenue and buyback pressure but adds complexity and creates incentive to take excessive risk. Deferred to Phase 4 pending track record.

**Deposit caps.** Should the vault cap total deposits during bootstrap to limit exposure to smart contract risk? Recommended: $500K cap in Phase 2, lifted after 60 days of incident-free operation.

**Multi-chain expansion.** The agent economy is currently concentrated on Base. If significant agent activity migrates to Solana or other L2s, the vault may need to deploy cross-chain (Chainlink CCIP, LayerZero). Deferred to Phase 5.

**Agent identity verification.** Should the vault verify that depositors are agents (not humans pretending to be agents for marketing purposes)? Current answer: no. The vault is permissionless. The brand positioning is agent-first, but the contracts don't discriminate. A human depositing USDC earns the same returns as an agent depositing USDC.

---

## 12. Summary of Mechanism

```
  CAPITAL FLOW
  =============

  Agents deposit USDC --> Vault (ERC-4626)
       |
       +--> Bucket A: stables yield (Aave) -----------> NAV growth
       +--> Bucket B: agent-token trading -------------> NAV growth
       +--> Bucket C: revenue liquid tokens -----------> NAV growth
       |
       +--> 2% mgmt fee (daily) -----> Prop Wallet
                                           |
                                           +--> same 3 buckets
                                           +--> trades $ROBOTMONEY
                                           +--> realized gains
                                                    |
                                                    v
                                              BUYBACK $RM
                                                    |
                                                    v
                                              BURN (0xdead)

  TOKEN FLOW
  ===========

  $ROBOTMONEY launched via Clanker v4
       |
       +--> LP locked until 2100 (anti-rug)
       +--> 40% swap fees --> Prop Wallet (permanent revenue)
       +--> holders vote on weekly allocation (ranked choice)
       +--> if no quorum --> agent's default allocation executes
       +--> supply decreases via burns from prop wallet gains

  GOVERNANCE FLOW
  ================

  Agent publishes shortlist (quantitative filter)
       |
       v
  $RM holders rank tokens (48hr window)
       |
       v
  Top N tokens enter Buckets B + C at voted weights
       |
       v
  Agent rebalances vault on-chain
```

Three contracts. Two wallets. One agent. No inflation. No governance theater. Every position, fee, burn, and loss on-chain.

──────────────────────────────

*Robot Money is not a registered investment vehicle. This document describes a protocol mechanism, not an offer of securities. Consult legal counsel before participating. Past performance of comparable protocols does not predict future results.*
