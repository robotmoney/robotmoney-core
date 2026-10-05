# ADR-0001: MVP agent-token shortlist is hand-picked, not quant-filtered

- **Status:** Accepted (amended 2026-10-05 — see [Amendment — 2026-10-05](#amendment--2026-10-05-mainnet-launch-shortlist-is-rm-only); earlier [Amendment — 2026-06-15](#amendment--2026-06-15-real-four-vault-demo-shortlist))
- **Date:** 2026-05-27 (amended 2026-06-15, 2026-10-05)
- **Deciders:** Product owner (recorded reply 2026-05-27)
- **Related:** `docs/development/open-questions.md` §1.3, §1.4, §3.1; `docs/prd.md` §11.3; [ADR-0004](ADR-0004-agent-token-shortlist-governance.md); [ADR-0005](ADR-0005-basketvault-multi-dex-routing.md); `config/agent-token-shortlist.json`

## Context

The source PRD (MVP v1.0, March 2026) specifies an agent-token vault whose
membership is decided by a quantitative filter — $10M market cap, 90-day
listing age, $100K daily volume, 500 holders — with a CoinGecko + on-chain
consensus methodology, an inclusion-proposal mechanism with quorum, a
displacement rule, and a 15-token cap.

None of that machinery exists today. The contract
(`contracts/vaults/AgentTokenVault.sol`) accepts an admin-curated shortlist
and equal-weights deposits across it. To ship the MVP, the team needs a
concrete shortlist; building the analytics pipeline and inclusion-vote
machinery to derive one from quant filters is not feasible inside the
demo timeline.

## Decision

For the MVP, the agent-token vault shortlist is **hand-picked by the
product owner** and **equal-weighted** at deposit time — not derived
from a quantitative filter. This decision governs the *method*; the
specific membership has since been revised for the Real four-vault demo
(see [Amendment — 2026-06-15](#amendment--2026-06-15-real-four-vault-demo-shortlist)
below).

The current deployed shortlist is a three-token Base-only basket, each
token routed through the DEX venue holding its deepest liquidity:

| Token | Swap venue |
|---|---|
| BNKR | Uniswap V3 |
| JUNO | Uniswap V4 |
| RM ($RM) | Aerodrome |

Token, pool, and adapter addresses live in
`config/agent-token-shortlist.json` (never in Solidity source), which is
the single source of truth for membership and per-asset venue. The
multi-DEX per-asset routing model is specified in
[ADR-0005](ADR-0005-basketvault-multi-dex-routing.md).

Changes to the shortlist (add, remove, swap) flow through the existing
admin path: a Safe (≥2-of-N) proposes/executes against the
`TimelockController` that holds `ADMIN_ROLE` on the vault, now subject to
the mandatory timelock delay and public veto window specified in
[ADR-0004](ADR-0004-agent-token-shortlist-governance.md). There is no
separate token-holder vote over membership in the MVP.

## Amendment — 2026-06-15: Real four-vault demo shortlist

The original 2026-05-27 shortlist assumed all four tokens traded as
Uniswap V3 USDC pairs:

- JUNO (`0x4e6c9f48f73e54ee5f3ab7e2992b2d733d0d0b07`)
- Woon (`0x85eac631c800af804476b140f87039f742c28ba3`)
- ZYFAI (`0xd080ed3c74a20250a2c9821885203034acd2d5ae`)
- GIZA (`0x590830dfdf9a3f68afcdde2694773debdf267774`)

The Real four-vault demo (Plan #109) requires the agent-token vault to
hold real, on-chain-tradeable Base assets with enough DEX liquidity to
support deposit/redeem swaps without catastrophic slippage. That
requirement, together with the per-asset multi-DEX routing decision in
[ADR-0005](ADR-0005-basketvault-multi-dex-routing.md), drove the
following revisions:

- **Woon, ZYFAI, GIZA — removed.** They did not meet the demo's
  liquidity / venue requirements as basket swap legs.
- **BNKR — added (Uniswap V3).** Reinstated as a live Base
  agent-economy token with a usable V3 USDC pool; this reverses the
  original "dropped" determination.
- **JUNO — retained, re-venued to Uniswap V4.** Its deepest USDC
  liquidity is on Uniswap V4, not V3; routing follows ADR-0005.
- **RM — added (Aerodrome).** This reverses the original
  self-referential conflict-of-interest exclusion. As deployed, the code
  applies **no self-referential or conflict-of-interest guard**:
  `AgentTokenVault` treats RM identically to any other shortlist
  entry — equal-weighted, with a token/pool/adapter triple routed through
  the Aerodrome adapter (`BasketVault.Venue.Aerodrome`, asset index 2 in
  the demo seed). Router-eligibility is generic vault-level registry
  state (`VaultRegistry.isRouterEligible`) and is **not** conditioned on,
  nor blocked by, RM's presence anywhere in the contract: in the
  Real four-vault demo the agent-token vault — RM leg included —
  is seeded Router-eligible and carries a leg in the router default
  weight vector (`test_rmAGENT_is_router_eligible`). On mainnet,
  Router-eligibility still depends on the generic hardening gates
  (audit / TWAP oracle / liquidity proof), not on a RM-specific
  check. The demo seeds RM as a stand-in `DemoBasketToken`; the
  live `$RM` / `RmToken` address for a production deploy is an unresolved
  `TODO` in `config/agent-token-shortlist.json`. The original
  self-referential concern is therefore a governance/product
  consideration only — it is **not** enforced or gated in code.

The hand-picked-not-quant-filtered method, the equal-weight allocation,
and the admin-curation governance path are unchanged by this amendment.
DEUS and PEAQ remain excluded for the reasons recorded in the original
decision (no active Base presence; not Base-native, respectively).

## Amendment — 2026-10-05: Mainnet launch shortlist is RM only

Owner decisions of 2026-10-05 (mainnet plan §2.2, §2.6, §3.1, §3.5)
replace the 2026-06-15 three-token shortlist for the Base mainnet launch:

- **Launch shortlist: RM only.** rmAGENT holds RM from day 2. BNKR and
  JUNO have no usable token/USDC pool today; they are added later
  through the timelock path of
  [ADR-0004](ADR-0004-agent-token-shortlist-governance.md) (core 1491).
- **RM is the live Base token.** RM is ROBOTMONEY at
  `0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3` (on-chain name
  "Robot Money", symbol `ROBOTMONEY`, 18 decimals). Nothing deploys RM
  in production. No test deploys an RM mock: the Twin fork of Base
  carries the live token. The address is config, pinned by code hash
  like USDC. This voids the 2026-06-15 statements that the demo seeds RM
  as a stand-in `DemoBasketToken` and that the live address is a `TODO`.
- **Branch state when this amendment was written** (`impl/core-contracts`,
  core PR 1505): `config/agent-token-shortlist.json` still carries an
  empty `shortlist`, so the RM entry is not yet added (core 1491).
  `contracts/script/DeployRmToken.s.sol` is already deleted and is listed
  as forbidden in `scripts/ci/check-no-test-only-code.ts`.
  `contracts/RmToken.sol` **still exists** on this branch (it is also
  named in `contracts/test/CustodyInvariantGuard.t.sol` and the
  generated contract docs); its deletion is tracked by core 1489.
- **RM's deepest liquidity is no longer on Aerodrome.** Read on Base on
  2026-10-05 (block 52222597):

  | RM pool | Approx. value | Note |
  |---|---|---|
  | Uniswap V4 RM/WETH | ~$170k | Deepest RM pool. Not usable: `addAsset` accepts only a token/USDC pool on every venue (see the [ADR-0005](ADR-0005-basketvault-multi-dex-routing.md) amendment). |
  | Uniswap V4 RM/USDC, fee 2.91% | ~$809 | Deepest RM/USDC pool. Needs the restored V4 adapter. |
  | Uniswap V3 RM/USDC, fee 10000, `0x8Cd8c7015b6A8F8310c15CcC8aA3D200D9c74882` | — | In-range liquidity 0, observation cardinality 1. `addAsset` refuses it today (`MIN_POOL_CARDINALITY` 2, `MIN_POOL_LIQUIDITY` 1e6). |
  | Aerodrome Slipstream RM/USDC, `0x0992af1070f7fe4654a033fec8f153a6991465a8` | ~$8 | No deploy script registers the Aerodrome adapter. |

- **RM's venue is open** (owner decision pending, mainnet plan §2.6
  item 2). Option A: fund the existing V3 RM/USDC pool above and raise its
  observation cardinality; no code change. Option B: restore the
  Uniswap V4 swap adapter as a supported venue and use a V4 RM/USDC pool
  (see the ADR-0005 amendment for what the restore must first prove).
  Neither option routes through WETH. The mainnet run waits on this
  choice and on who funds the pool, sized to rmAGENT's 3% default
  slippage.

Unchanged by this amendment: the hand-picked-not-quant-filtered method,
the equal-weight allocation, the admin-curation path (now as amended in
ADR-0004), and the absence of any RM-specific guard in code.

## Consequences

**Positive.**

- Unblocks the agent-token vault for the demo and launch path without
  waiting on the quant-filter analytics build.
- Keeps the admin surface uniform with the rest of the protocol — one
  Safe→Timelock path, one set of signers — instead of introducing a
  parallel inclusion-vote system before its economics are modeled.
- Defers the inclusion-attack modeling
  (`docs/technical/research-questions.md` §3.8) until the bottom-up model
  is actually on the table.

**Negative / accepted risks.**

- Shortlist legitimacy depends on a small group of signers rather than a
  measurable rule. This is acceptable for MVP because the vault is
  prototype-labeled and not Router-eligible.
- The PRD's "transparent eligibility methodology" requirement is not
  met; this is tracked as deferred, not waived. Production must revisit
  before the agent-token vault is marked Router-eligible.
- The shortlist will drift from the *intent* of the quant filter
  ($10M / 90d / $100K / 500-holders) unless signers self-impose it. No
  on-chain check enforces the thresholds.

**Out of scope of this decision.**

- The long-term ownership model (admin-curated vs. RM-inclusion vote
  vs. bribery flow) is **deferred**, not decided. This ADR commits the
  MVP only.
- Trading authority and strategy inside the vault (open-questions §3.2)
  is not resolved; the MVP vault holds the basket and rebalances per
  §3.15 only.
- Intra-vault rebalancing (§3.15) — the new-deposits-only proposal is
  tracked separately and may need its own ADR once product confirms.
