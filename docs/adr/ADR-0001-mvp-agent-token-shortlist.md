# ADR-0001: MVP agent-token shortlist revised to Base-liquid set {BNKR, JUNO, ROBOTMONEY}

- **Status:** Supersedes revision dated 2026-05-27; current revision 2026-06-02
- **Date (original):** 2026-05-27
- **Date (revised):** 2026-06-02
- **Deciders:** Product owner (recorded reply 2026-05-27); on-chain liquidity audit 2026-06-02
- **Related:** `docs/development/open-questions.md` §1.3, §1.4, §3.1; `docs/prd.md` §11.3; `config/agent-token-shortlist.json`

## Context

The original decision (2026-05-27) hand-picked a six-token MVP shortlist from the
Base agent-economy ecosystem. The rationale was that building the analytics pipeline
and inclusion-vote machinery to derive the shortlist from quant filters is not
feasible inside the demo timeline. The full original six-token list is preserved in
git history at the commit that introduced this ADR.

A subsequent on-chain liquidity audit (2026-06-02) found that three of the original
six tokens — ZYFAI, GIZA, and one additional token — have no swappable Base
liquidity: no Uniswap V3, Uniswap V4, or Aerodrome pool pair with USDC or WETH
exists on Base mainnet for any of them. A real `rmAGENT` vault cannot include tokens
it cannot swap on entry or exit, so the shortlist must be revised before the vault
is wired with real assets.

A second finding from the same audit is that the three remaining Base-liquid tokens
— BNKR (BankrCoin), JUNO (Juno Agent), and ROBOTMONEY — do not all share a single
DEX venue. BNKR has a Uniswap V3 USDC pool; JUNO and ROBOTMONEY trade primarily on
Uniswap V4 (Base) and Aerodrome Slipstream 2. The existing `AgentTokenVault`
hardcodes Uniswap V3 as the swap router, so a multi-DEX adapter is a prerequisite
before the vault can hold JUNO or ROBOTMONEY in production. That prerequisite is
tracked separately (see Consequences below).

## Decision

The MVP agent-token shortlist is revised to exactly three tokens, all confirmed
Base-liquid as of 2026-06-02:

| Symbol | Token (Base mainnet) | Primary DEX venue | Swap pair | Rationale |
|--------|----------------------|-------------------|-----------|-----------|
| BNKR | `0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b` | Uniswap V3 | BNKR/USDC (`0xe6ad781985ee9d7de25106ec18bdde837fad0b45`, 1% fee) | Active Uniswap V3 pool on Base; AI-agent social token for Bankr.bot; direct V3 compatibility |
| JUNO | `0x4e6c9f48f73e54ee5f3ab7e2992b2d733d0d0b07` | Uniswap V4 | JUNO/WETH on Uniswap V4 Base (`0x1635213e2b19e459a4132df40011638b65ae7510a35d6a88c47ebf94912c7f2e`) | ~$1.77M liquidity on Uniswap V4 Base; Juno Agent — AI-agent launchpad/DAO token; requires multi-DEX adapter |
| ROBOTMONEY | `0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3` | Uniswap V4 / Aerodrome Slipstream 2 | ROBOTMONEY/WETH on Uniswap V4 Base (`0xcece56fd6eb8fcbc6c45af8181bfe71ea6057770630490cac36dbbc4aa27a4a6`) | Protocol's own token; ~$442K liquidity on Uniswap V4; Aerodrome Slipstream 2 ROBOTMONEY/USDC pool also available; requires multi-DEX adapter |

Tokens removed from the original shortlist and the rationale for each removal:

| Removed token | Removal rationale |
|---------------|-------------------|
| ZYFAI | No swappable Base liquidity found on Uniswap V3, Uniswap V4, or Aerodrome as of 2026-06-02 |
| GIZA | No swappable Base liquidity found on Uniswap V3, Uniswap V4, or Aerodrome as of 2026-06-02 |
| Third original token (see git history) | No swappable Base liquidity found on Uniswap V3, Uniswap V4, or Aerodrome as of 2026-06-02 — the complete original six-token list is in git history |

**Multi-DEX adapter prerequisite.** The current `AgentTokenVault` swap path is
hard-wired to Uniswap V3. JUNO and ROBOTMONEY are not on Uniswap V3 with usable
liquidity; their primary venues are Uniswap V4 and Aerodrome Slipstream 2. The
multi-DEX adapter (`IBasketSwapAdapter`) tracked in the seams document
(`docs/technical/real-four-vault-demo-seams.md` §3) must be implemented (issues
#552/#553) before the vault can perform entry/exit swaps for JUNO and ROBOTMONEY.
Until the adapter lands, the shortlist definition in this ADR and `config/` is
correct, but the vault should not be seeded with those assets on devnet or mainnet.

The original rationale for hand-picking rather than quant-filtering the shortlist
(demo timeline constraint, no analytics pipeline) remains unchanged.

Changes to the shortlist continue to flow through the existing admin path: a Safe
(≥2-of-N) proposes/executes against the `TimelockController` that holds
`ADMIN_ROLE` on the vault. There is no separate token-holder vote over membership
in the MVP.

## Consequences

**Positive.**

- Removes the three unswappable tokens before they block devnet wiring and E2E
  fork tests, allowing the real four-vault demo to proceed without no-op placeholders.
- Records verified Base mainnet addresses and DEX venues for all three shortlisted
  tokens, making `config/agent-token-shortlist.json` deployable for BNKR (V3 path)
  immediately.
- Preserves the uniform admin surface (Safe→Timelock) with no new governance
  mechanism.

**Negative / accepted risks.**

- A three-token basket is more concentrated than the original six-token intent.
  This is accepted for MVP; the shortlist can expand once liquidity is confirmed
  for candidate tokens.
- JUNO and ROBOTMONEY require the multi-DEX adapter before vault wiring; the
  shortlist document is ahead of the code. This is intentional and tracked.
- BNKR/USDC Uniswap V3 pool (`0xe6ad781985...`) has thin liquidity (~$19 TVL).
  The primary BNKR liquidity pool is BNKR/WETH on Uniswap V3 ($2.58M). The vault
  will route through WETH as an intermediate for BNKR swaps until a deeper
  BNKR/USDC V3 pool is available.
- Shortlist legitimacy depends on a small group of signers. This remains acceptable
  for the MVP prototype label.
- The PRD's "transparent eligibility methodology" requirement is not met; this is
  tracked as deferred, not waived. Production must revisit before the agent-token
  vault is marked Router-eligible.

**Out of scope of this decision.**

- The long-term ownership model (admin-curated vs. RM-inclusion vote vs. bribery
  flow) is **deferred**, not decided.
- Trading authority and strategy inside the vault (open-questions §3.2) is not
  resolved; the MVP vault holds the basket and rebalances per §3.15 only.
- Intra-vault rebalancing (§3.15) — tracked separately.
- Multi-DEX adapter implementation — tracked in issues #552/#553.
- Fork fixture update to ingest the new pool addresses — tracked in the demo seams
  document and dependent issues.
