# ADR — Source-Document Reconciliation (issue #92)

> **Status.** Accepted, 2026-05-07.
>
> **Authors.** dev-scout for issue #92.
>
> **Scope.** Records a chosen answer for every cross-document
> contradiction flagged in `docs/papers/open-questions.md` §1. The three
> source papers in `docs/papers/` (`Robot-Money-Whitepaper-v01.md`,
> `robot_money_plan_v4.md`, `robot_money_prd.md`) are **frozen
> historical artifacts**. Where they conflict, this ADR overrides
> them. Source files have not been edited; instead, a header note in
> each source file points to this ADR (see "Cross-links" below).
>
> **Decision frame.** Per the architecture pivot (memory entry
> 2026-05-06), the source PRD is deprecated and `docs/architecture.md`
> + `docs/implementation-plan.md` are the forward-direction
> design (gateway + `rmpc` + ERC-4626 vault). Where v0/MVP makes a
> commitment, that wins. Where v0/MVP is silent the whitepaper wins,
> because the whitepaper is the most internally consistent of the
> three source papers and aligns best with the deployed contracts
> (`docs/papers/implementation-evidence.md` §1.7, §4).
>
> **Companion docs.**
> - `docs/papers/open-questions.md` — the source list of contradictions.
> - `docs/papers/implementation-evidence.md` — code-level evidence
>   per question; the basis for several decisions below.
> - `docs/architecture.md`, `docs/implementation-plan.md` — v0/MVP
>   forward direction.
> - `docs/prd.md` — repo PRD, treated as the de-facto v1 product spec
>   (per implementation-evidence §4.4).

This ADR is intentionally compact: each contradiction gets a chosen
answer, rejected alternatives with one-line rationale, and a pointer
to the affected source-doc passages. Implementation work derived from
these decisions is out of scope and is tracked via separate issues
(noted inline where filed).

---

## 1.1 One token or two?

**Decision.** Single `$RM` / `$ROBOTMONEY` token. No v1→v2 migration.
Burn-only value accrual via prop-wallet realized gains, no
fee-distribution-to-stakers and no inflationary yield. Aligns with
whitepaper and repo PRD §5.3.

**Rejected alternatives.**
- *Plan v4 v1→v2 migration with staking + fee distribution.* Rejected
  — directly contradicts the whitepaper's burn-only flywheel, exposes
  early `$RM` holders to dilution/migration risk, requires a custom
  audited token contract that is not on the roadmap, and has no
  implementation footprint (`implementation-evidence.md` §1.1).
- *Two coexisting tokens.* Rejected — no documented use case
  distinguishes them.

**Source-doc pointers.**
- `docs/papers/Robot-Money-Whitepaper-v01.md` — token model section.
- `docs/papers/robot_money_plan_v4.md` — Phase 2/3 v1→v2 plan
  (superseded by this ADR).
- `docs/papers/robot_money_prd.md` — single-`$RM` framing (preserved).

---

## 1.2 Vault: three-bucket from launch, or stables-first?

**Decision.** Stables-first vault. The on-chain treasury custodies
only Bucket A (USDC stable-yield via Aave/Compound/Morpho adapters,
matching the deployed `RobotMoneyVault.sol`). Per repo PRD §5.2,
Bucket-B and Bucket-C exposure, if it ships at all, is delivered to
the depositor's wallet at deposit time, not custodied by the vault.
Aligns with v0/MVP and the deployed contract.

**Rejected alternatives.**
- *Whitepaper 33/33/33 three-bucket-in-vault from day one.* Rejected
  — vault as built has no bucket struct
  (`implementation-evidence.md` §1.2, §1.6); shipping it would expand
  audit surface, smart-contract scope, and on-chain risk for no v0
  benefit.
- *Plan-v4 phased addition of Bucket B/C inside the vault later.*
  Rejected — adopts the same audit/scope cost as above, on a deferred
  timeline, with no current product driver. If revisited, it is a
  whole new vault deployment, not an upgrade
  (cf. §3.5 below).

**Source-doc pointers.**
- `docs/papers/Robot-Money-Whitepaper-v01.md` — three-bucket vault.
- `docs/papers/robot_money_plan_v4.md` — Phase 3 robot-coin baskets.
- `docs/papers/robot_money_prd.md` — vault-pending framing.

---

## 1.3 Shortlist curation: top-down or bottom-up?

**Decision.** Deferred — tracked separately. v0/MVP has no on-chain
shortlist mechanism (`implementation-evidence.md` §1.3). The decision
has real product tradeoffs (governance topology, `$RM` demand model,
ops overhead) that should not be settled by a scout. Until governance
ships, all curation happens off-chain by the multisig operator
(consistent with repo PRD §7).

**Rejected alternatives (interim, until decision lands).**
- *Make the call now (curated).* Rejected — premature; no governance
  contract exists, so committing locks the design space without a
  product owner sign-off.
- *Make the call now (proposal-driven).* Rejected — same reason; also
  drags in tier/quorum/displacement scope (§1.5) that v0/MVP does not
  have.

**Follow-up.** A separate issue should be filed when governance work
is scheduled. Until then, treat the shortlist as a multisig-curated
operational artifact.

**Source-doc pointers.**
- `docs/papers/Robot-Money-Whitepaper-v01.md` — protocol-agent-curated.
- `docs/papers/robot_money_prd.md` — Analyst-tier proposal flow.

---

## 1.4 Voting mechanic for weekly allocation

**Decision.** Deferred — tracked separately, paired with §1.3. v0/MVP
has no on-chain voting (`implementation-evidence.md` §1.4). The
mechanic choice (ranked-choice vs. weighted bps) has real
gaming-resistance tradeoffs and a UI footprint; it should be decided
alongside §1.3 and §1.5 by a product owner once governance work is
scheduled.

**Rejected alternatives (interim).**
- *Pick one now.* Rejected — the three governance-shape questions
  (§1.3, §1.4, §1.5, §1.6) are interlocking; deciding one of them in
  isolation creates churn.

**Source-doc pointers.**
- `docs/papers/Robot-Money-Whitepaper-v01.md` — ranked choice.
- `docs/papers/robot_money_prd.md` — weighted bps.

---

## 1.5 Tier system: yes or no?

**Decision.** No tier system in v0/MVP. Governance, when it ships, is
linear-by-balance (whitepaper / plan v4 model) unless a future
product-owner decision reverses this. v0/MVP gates per-agent deposits
via the gateway's `authorizeAgent` policy
(`implementation-evidence.md` §1.5), which is a different axis and
remains in place; this decision concerns governance rights only.

**Rejected alternatives.**
- *PRD's four-tier system with 14-day activity gate.* Rejected for
  v0/MVP — it presupposes the CFO Feed (its activity-gate substrate)
  which is not on the v0/MVP roadmap, and adds substantial scope to
  the first governance contract.
- *Defer entirely (like §1.3, §1.4).* Rejected — the absence of tiers
  is the simpler default; committing to "no tiers in v0" prevents the
  PRD's tier scaffolding from being smuggled into other workstreams.

**Source-doc pointers.**
- `docs/papers/robot_money_prd.md` — Observer/Participant/Analyst/
  Strategist tiers.
- `docs/papers/Robot-Money-Whitepaper-v01.md` — linear weight.

---

## 1.6 Vault structure: bucketed or flat?

**Decision.** Flat list of strategy adapters with per-adapter
`capBps`. Matches the deployed `RobotMoneyVault.sol` and falls out of
§1.2. No bucket struct, no monthly bucket-weight reweighting surface.

**Rejected alternatives.**
- *Three risk buckets with intra-bucket selection.* Rejected — no
  on-chain support, no governance to drive monthly rebalance votes,
  contradicts §1.2.
- *Add a bucket layer over the flat adapter list as narrative.*
  Rejected for the technical specification — narrative framing in
  marketing or whitepaper-v2 is fine, but the contract layer is flat
  and should be described as such.

**Source-doc pointers.**
- `docs/papers/Robot-Money-Whitepaper-v01.md` — Bucket A/B/C.
- `docs/papers/robot_money_prd.md` — flat 15-token list (different
  flat shape; not adopted, see §1.2).

---

## 1.7 Sequencing: what ships first?

**Decision.** Vault first, token later. This matches the deployed
state (`RobotMoneyVault.sol` is live on Base mainnet;
`$ROBOTMONEY` is not deployed — `implementation-evidence.md` §1.7).
The repo PRD's "token live, vault not yet" premise is **factually
inverted** and is hereby retired as a design constraint. CFO Feed,
which the repo PRD framed as a stopgap for the missing vault, no
longer has that motivation; whether to build it is its own product
decision (out of scope here).

**Rejected alternatives.**
- *Plan v4's simultaneous Phase 1 launch.* Rejected — already
  inconsistent with deployed reality.
- *Repo PRD's token-first sequencing.* Rejected — already
  inconsistent with deployed reality.
- *Whitepaper's "vault and token roughly simultaneous, both at
  launch."* Partially superseded — vault did ship first; the token
  half is open and not constrained by this ADR.

**Source-doc pointers.**
- `docs/papers/Robot-Money-Whitepaper-v01.md` — vault Week 1–2 + token
  Week 3.
- `docs/papers/robot_money_plan_v4.md` — Phase 1 simultaneous.
- `docs/papers/robot_money_prd.md` — token live, vault pending
  (retired).

---

## 1.8 Customer wedge

**Decision.** Primary wedge is the whitepaper framing: **autonomous
agents with idle USDC seeking diversified managed exposure**. This is
the only wedge that the v0/MVP infrastructure (gateway, `rmpc`,
per-agent caps, encrypted-keystore signer) is built for
(`implementation-evidence.md` §1.8). The other two wedges — plan v4's
own-token-de-risking and repo PRD's CFO Feed analytical credibility —
are not contradicted, but neither has a v0 surface and neither is
treated as primary.

**Rejected alternatives.**
- *Plan v4 own-token-de-risking as primary.* Rejected for v0 — would
  require a swap path (own-token → USDC) that is not in scope.
- *Repo PRD CFO Feed as primary.* Rejected for v0 — content product
  with no fee model (`open-questions.md` §3.6) and no v0 code.
- *Refuse to pick a primary.* Rejected — wedge ambiguity has bled
  into the source papers' narratives; choosing one cleans up GTM
  copy.

**Source-doc pointers.** All three source papers (each names a
different wedge in its opening sections).

---

## 2. Status of source-doc open questions (§2 of `open-questions.md`)

These were **already** flagged as open by the source papers
themselves and the source-doc authors did not resolve them. They are
not contradictions across docs; they are TODOs inside individual
docs. This ADR does not resolve them — that is product-owner work,
not scout work — and it explicitly defers each. This section exists
so the validator's coverage check can confirm they are not silently
forgotten.

- **§2 Whitepaper §11 items** (legal entity, performance fee, deposit
  caps, multi-chain expansion, agent identity verification) — deferred
  per the whitepaper's own phasing (Phase 4–5) and the v0/MVP scope.
  Deposit caps are partially resolved at the contract level (`tvlCap`,
  `perDepositCap`, gateway `maxPerWindow`/`maxPerPayment` are live —
  `implementation-evidence.md` §2.3).
- **§2 Plan-v4 immediate-decisions list** (Compass Labs vs. direct
  adapters, stablecoin selection, agent persona, tokenomics, Clanker
  terms, v2 audit) — partially resolved by the implementation: direct
  adapters were chosen, USDC is the vault asset
  (`implementation-evidence.md` §2.6). The remaining items
  (agent persona, tokenomics, Clanker terms, v2 audit) are scoped out
  by §1.1 (no v2) and by v0/MVP not shipping a token persona.

---

## 3. Status of source-doc gaps (§3 of `open-questions.md`)

§3 of `open-questions.md` lists topics **none** of the source papers
address. Several have been silently resolved by what the
implementation chose **not** to build
(`implementation-evidence.md` §4.5). This ADR records that status
without re-litigating each gap.

- **§3.1 Quant filter operationalization** — off-chain; not in v0/MVP
  scope.
- **§3.2 Bucket B trading** — moot under §1.2 (no Bucket B in vault).
- **§3.3 Prop wallet seeding** — moot under §1.7 (no token yet, no
  buyback to fund).
- **§3.4 Multisig composition** — deployment-time configuration; not
  a contract property.
- **§3.5 Vault upgrade path** — clarified by
  `implementation-evidence.md` §3.5: bytecode immutable, parameters
  and adapter set mutable within hard floors. The whitepaper's
  blanket "immutable" claim is overstated; plan v4's "progressive
  expansion" is supported only at the parameter/adapter layer.
  Re-bucketing the vault would require a new deployment
  (cf. §1.2, §1.6).
- **§3.6 CFO Feed economics** — out of scope; gated on a separate
  product decision (cf. §1.8).
- **§3.7 Withdrawal under drawdown** — moot under §1.2; vault
  redemptions are synchronous against stable-yield adapter liquidity.
- **§3.8 Inclusion-attack bounds** — moot under §1.3/§1.4 deferral
  (no on-chain governance attack surface yet).
- **§3.9 Quorum cliff** — moot under §1.4 deferral.
- **§3.10 Protocol-agent failure modes** — partially resolved by
  contract-layer operator overrides
  (`implementation-evidence.md` §3.10): `pause`, `emergencyWithdraw`,
  `forceRemoveAdapter`, `shutdownVault`, gateway pause, per-agent
  revocation. Whether this is sufficient is a product judgment that
  should be revisited if/when the protocol agent becomes
  load-bearing for governance.

---

## 4. Cross-links

The three source papers are frozen. They are not edited beyond a
single ADR-pointer line at the top of each, so that readers landing
on a source paper see this ADR before treating any conflicting
passage as authoritative:

- `docs/papers/Robot-Money-Whitepaper-v01.md`
- `docs/papers/robot_money_plan_v4.md`
- `docs/papers/robot_money_prd.md`
- `docs/papers/open-questions.md` — links to this ADR per
  contradiction.
- `docs/papers/implementation-evidence.md` — companion evidence per
  contradiction; this ADR's chosen answers cite it.

The ADR is also referenced from `docs/implementation-plan.md` so
that the forward-direction plan documents the resolution of upstream
contradictions.
