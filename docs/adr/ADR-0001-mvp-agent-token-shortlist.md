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
separate token-holder vote over membership.

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
  empty `shortlist`, so the RM entry is not yet added (core 1491). Core 1554 added it: the file now lists RM only.
  `contracts/script/DeployRmToken.s.sol` is already deleted and is listed
  as forbidden in `scripts/ci/check-no-test-only-code.ts`.
  `contracts/RmToken.sol` is also deleted (core 1489, 2026-10-05) and is
  listed as a deleted path in the same gate. The dapp reads the live RM
  address for its balance row; the faucet no longer drips RM.
- **RM's deepest liquidity is no longer on Aerodrome.** Read on Base on
  2026-10-05 (block 52222597):

  | RM pool | Approx. value | Note |
  |---|---|---|
  | Uniswap V4 RM/WETH | ~$170k | Deepest RM pool. Not usable: `addAsset` accepts only a token/USDC pool on every venue (see the [ADR-0005](ADR-0005-basketvault-multi-dex-routing.md) amendment). |
  | Uniswap V4 RM/USDC, fee 2.91%, id `0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252391` | ~$809 on 2026-10-05; in-range liquidity L 9.83e17 on 2026-10-08 | Deepest RM/USDC pool. rmAGENT's venue from 2026-10-08 (see the amendment below), through the restored V4 adapter. |
  | Uniswap V3 RM/USDC, fee 10000, `0x8Cd8c7015b6A8F8310c15CcC8aA3D200D9c74882` | — | In-range liquidity 0, observation cardinality 1. `addAsset` refuses it today (`MIN_POOL_CARDINALITY` 2, `MIN_POOL_LIQUIDITY` 1e6). |
  | Aerodrome Slipstream RM/USDC, `0x0992af1070f7fe4654a033fec8f153a6991465a8` | ~$8 | No deploy script registers the Aerodrome adapter. |

- **RM's venue was decided on 2026-10-06 (owner; mainnet plan §2.6
  item 2). SUPERSEDED on 2026-10-08, see the next bullet.** rmAGENT was to launch on the existing Uniswap V3 RM/USDC pool
  above (`0x8Cd8c7015b6A8F8310c15CcC8aA3D200D9c74882`, fee 10000), the
  only venue the deploy script wires; no code change. The owner funds it
  with in-range liquidity at market price before the mainnet run, sized
  to rmAGENT's first-period cap, and raises its observation cardinality.
  Restoring the Uniswap V4 swap adapter is a later option, not a launch
  blocker (see the ADR-0005 amendment for what the restore must first
  prove). No route goes through WETH.
- **RM's venue is the Uniswap V4 RM/USDC 2.91% pool (owner, 2026-10-08, core 1676; supersedes the 2026-10-06 V3 decision).**
  The V3 pool `0x8Cd8c7015b6A8F8310c15CcC8aA3D200D9c74882` has zero in-range liquidity (`liquidity()` returned 0 on 2026-10-08) and its
  owner funding is not under the protocol's control. rmAGENT therefore trades RM on the Uniswap V4 RM/USDC pool with fee 29100,
  tickSpacing 582, hooks `0x0` and pool id `0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252391` (its PoolManager
  `Initialize` event is Base tx `0x4fc63a04703f60cb9164d279bb60d4b346a64413250d8dbac4feca0c63c81f75`). The pool is hookless, so V4 records no
  observations for it. The vault prices RM from `UniswapV4PriceRecorder`, a permissionless, admin-free recorder in this repo (see the
  [ADR-0005](ADR-0005-basketvault-multi-dex-routing.md) 2026-10-08 amendment), and swaps through `UniswapV4SwapAdapter`. **Scope: a contained
  mainnet TEST, not the final deployment.** The owner's words: "It's sufficient for a test on mainnet, not the final deployment. We have yet to
  make a successful test." The first Base mainnet run keeps the containment of the devops plan (1 USDC seed, low `tvlCap` and `perDepositCap`,
  nonzero NAV deviation guard, pause available, no announcement). A stronger RM price source, such as a hooked oracle pool, is a later,
  separate owner decision before the final deployment. The V4 asset position adapter (core 1677) is deferred to the final deployment.
  Funding or deepening the pool, and the 8453 cap values, are owner actions.

Unchanged by this amendment: the hand-picked-not-quant-filtered method,
the equal-weight allocation, the admin-curation path (now as amended in
ADR-0004), and the absence of any RM-specific guard in code.

2026-10-06: no token-based governance is foreseen; considered alternatives that mention token voting are historical only.

2026-10-06: the owner decided RM's venue: the existing Uniswap V3 RM/USDC pool `0x8Cd8c7015b6A8F8310c15CcC8aA3D200D9c74882` (fee 10000), funded by the owner before the mainnet run. The V4 adapter restore is a later option, not a launch blocker.

2026-10-08: the owner superseded that decision. RM trades on the Uniswap V4 RM/USDC fee 2.91% pool `0xf2e7b957...2391` through the restored V4 swap adapter, priced by the in-protocol observation recorder. "It's sufficient for a test on mainnet, not the final deployment. We have yet to make a successful test." The first Base mainnet run is a contained test (devops rule b), not the final deployment.

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
  vs. bribery flow) was **deferred** here. ADR-0004 decides it: admin
  curation behind the timelock. This ADR commits the MVP only.
- Trading authority and strategy inside the vault (open-questions §3.2)
  is not resolved; the MVP vault holds the basket and rebalances per
  §3.15 only.
- Intra-vault rebalancing (§3.15) — the new-deposits-only proposal is
  tracked separately and may need its own ADR once product confirms.
