# ADR-0001: MVP agent-token shortlist is hand-picked, not quant-filtered

- **Status:** Accepted
- **Date:** 2026-05-27
- **Deciders:** Product owner (recorded reply 2026-05-27)
- **Related:** `docs/development/open-questions.md` §1.3, §1.4, §3.1; `docs/prd.md` §11.3

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
product owner** and **equal-weighted** at deposit time. The MVP
shortlist is:

- JUNO
- ROBOTMONEY
- BANKR
- ZYFAI
- GIZA
- DEUS

PEAQ was considered but excluded because it does not live on Base; the
vault is Base-only by deployment.

Changes to the shortlist (add, remove, swap) flow through the existing
admin path: a Safe (≥2-of-N) proposes/executes against the
`TimelockController` that holds `ADMIN_ROLE` on the vault. There is no
separate token-holder vote over membership in the MVP.

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
