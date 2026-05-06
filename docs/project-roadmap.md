# Robot Money — Project Roadmap

> **Deprecated (2026-05-06).** This roadmap is no longer maintained as
> in-repo source of truth. The canonical docs are now `docs/prd.md`
> (product), `docs/architecture.md` (architecture), and
> `docs/implementation-plan.md` (build plan). The public-facing roadmap
> lives at https://www.robotmoney.net/changelog. The content below is
> retained for historical reference only and may be out of date.

> Scope (historical): this was the **project-level** roadmap for Robot Money — the on-chain protocol, the website, the agent integrations, and the surrounding ecosystem work. Source of truth for protocol-side milestones is the public changelog at https://www.robotmoney.net/changelog; this file mirrored and contextualized it for in-repo consumers.

The deployed protocol is currently at **Phase 4** of the public roadmap (see `docs/technical/smart-contracts.md` §10): single-bucket, equal-weight, governance-free, Base-only stable-yield vault with a client-orchestrated agent-token sidecar. Later phases (governance token mechanics, multi-bucket allocation, multi-chain) are listed below for context.

---

## 1. Phase summary

| Phase | Theme | Status |
|---|---|---|
| 1 | Token launch ($ROBOTMONEY on Base via Bankr) | Shipped — 2026-03-12 |
| 2 | Public website + protocol design docs | Shipped — 2026-03-12 |
| 3 | Community channels (Telegram, X bot, Substack, exchange listings) | Shipped — Mar 2026 |
| 4 | Vault v1 + 5% basket sidecar | **Current** — vault live at `0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd` |
| 5 | Allocation transparency + delegated-strategy tracking | In progress — see 2026-04-13 / 2026-04-14 / 2026-04-15 entries |
| 6 | Research & risk publications | In progress — smart-contract risk + regime-detection surveys published |
| 7+ | Multi-bucket allocation, `$ROBOTMONEY` weekly votes, `veRM`, multi-chain | Future — not on-chain in current contracts |

---

## 2. Milestones (newest first)

Mirrored from https://www.robotmoney.net/changelog. Each entry: date · category · headline · key facts.

### 2026-04

- **2026-04-24 · Content** — *Regime Detection Research: Prior Art & Methodology Survey.* Reference covering risk-on/risk-off detection across equities, fixed income, FX, commodities, crypto, and DeFi yield. 50+ data sources; institutional prior art. Blog page gained a Research column.
- **2026-04-15 · Design** — *Allocation page redesign.* Standalone sleeves merged into the main allocation page with category-based grouping. Color mapping fixed: agent tokens (blue), protocol (orange), stables/SS (green).
- **2026-04-14 · Feature** — *Delegated strategy integration: ZYFAI & Giza stablecoin positions.* Real-time tracking of delegated USDC positions (~$4,500 each) via new API integrations for hourly prices and wallet-balance pipeline.
- **2026-04-13 · Partnership** — *Peaq partnership.* Peaq's Woon agent allocates a portion of its revenue to Robot Money. First demonstration of agent-to-agent treasury infrastructure.
- **2026-04-12 · Infrastructure** — *Data pipeline reliability fixes.* Disabled a duplicate workflow that produced chart errors; CSV parser fixed; pipeline refactor for accuracy.

### 2026-03 (back half)

- **2026-03-31 · Design** — *Development page redesign* into a two-column Roadmap + Changelog view; roadmap extended through Phase 9: Expansion.
- **2026-03-30 · Design** — *Visual effects system.* Seven interactive demo pages: Flow Field, Network Swarm, Liquid Mesh, Matrix Rain, and others.
- **2026-03-29 · Design** — Homepage redesign with Substrate crystal-growth hero; blog redesign with animated fractal tree; Robot Money SVG mark replaces nav logo.
- **2026-03-27 · Community** — *WEEX exchange listing.* `ROBOTMONEY/USDT` pair live (third listing).
- **2026-03-26 · Community & Features** — Telegram community launched; media/press archive page; performance page with live wallet data.
- **2026-03-23 · Feature** — *Buyback tracking.* Public buybacks section; 10 buybacks executed (~1.15 WETH, ~$2,504).
- **2026-03-22 · Content** — *Smart-contract risk research + OG image redesign.* Analysis of 13 major DeFi exploits 2016–2026 ($4B+ in losses). Social-share images refreshed.
- **2026-03-18 · Feature** — *Live allocation dashboard.* Real-time wallet holdings + strategy breakdown; reads Base RPC and GeckoTerminal directly.
- **2026-03-17 · Infrastructure** — *AgentMail inbox live.* Dedicated Robot Money email via AgentMail.
- **2026-03-16 · Community & Documentation** — Technical Design Proposal (community vote) launched; changelog and profile updates.

### 2026-03 (front half)

- **2026-03-13 · Social** — *X bot launched.* `@RobotMoneyAgent` active.
- **2026-03-12 · Multi** — *Token launch on Base via Bankr*; ZHC Institute partnership; website + protocol design docs published; Substack analysis.

---

## 3. CLI / skill milestones (in-repo)

For the CLI/skill release history that backs this repo, see [`CHANGELOG.md`](../CHANGELOG.md). High-level alignment with project phases:

| CLI version | Date | Project context |
|---|---|---|
| 0.1.0 | 2026-04-14 | Initial release — read + `prepare-*` only. |
| 0.1.1 | 2026-04-14 | Decoded ERC-4626 / ERC-20 custom errors. |
| 0.1.2 | 2026-04-14 | Signed `execute-*`, RPC fallback pool, gas-estimate fix. |
| 0.2.0 | 2026-04-27 | 5% agent basket leg + `get-basket-holdings` + sell flags. |
| 0.2.1 | 2026-04-28 | Two-pass gas estimate so `execute-*` no longer aborts mid-sequence. |

---

## 4. Out-of-repo / future phases

These items appear on the public roadmap or in protocol documentation but are **not** implemented in the contracts the CLI talks to today (see `docs/technical/smart-contracts.md` §10 for the gap analysis):

- **Multi-bucket allocation** — target 50% stable yield / 25% agent tokens / 25% revenue-generating tokens. Today the entire vault is the stable bucket and the basket is a fixed-list 5% sidecar.
- **`$ROBOTMONEY` weekly allocation votes** with monthly weight rebalancing and bribe infrastructure.
- **`veRM`** (vote-escrowed governance token).
- **Multi-chain support** beyond Base mainnet.
- **2% annual management fee** mechanics (only the 0.25% exit fee is visible in the vault ABI today).

When any of these graduate to deployed contracts the CLI must surface them via `get-vault` / `get-basket-holdings` extensions; track that work via this file plus a CLI `CHANGELOG.md` entry.

---

## 5. Conventions for this and other docs in `docs/`

For consistency across `docs/`:

- **Filename**: kebab-case, `.md` extension (e.g. `project-roadmap.md`, `harness-quickstart.md`).
- **First line**: a single H1 (`# Title`) — no front-matter.
- **Second block**: a `>` blockquote stating scope, TL;DR, or source-of-truth pointer.
- **Sections**: numbered `## 1. …` for spec-shaped docs (PRD, smart-contracts, this file); named `## …` for narrative docs (quickstarts, analyses).
- **Tables** for fact-heavy content (addresses, flags, milestones); fenced code blocks with explicit language tags (` ```bash `, ` ```solidity `).
- **In-repo links** are relative (`../CHANGELOG.md`, not absolute paths).
- **External authoritative sources** are linked once near the top so readers know which file is the mirror and which is the source of truth.

---

## 6. References

- Public changelog (source of truth): https://www.robotmoney.net/changelog
- Repo CLI changelog: [`../CHANGELOG.md`](../CHANGELOG.md)
- Vault on BaseScan: https://basescan.org/address/0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd
- Smart-contract analysis (gap to public roadmap): [`technical/smart-contracts.md`](technical/smart-contracts.md) §10
