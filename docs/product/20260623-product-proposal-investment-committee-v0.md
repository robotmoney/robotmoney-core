# Investment Committee — v0 Feature Proposal

> Status: **proposal / not yet implemented.** Scopes a v0 of the agentic
> Investment Committee. Companion to the sprint spec
> (`docs/sprint/20260601-week-sprint.md`, Workstream A) and the GTM strategy doc
> (RobotMoney_PMF_GTM_Strategy).
>
> **Position.** We already have the basic components needed to realize the
> agentic Investment Committee vision — the `rmpc` client, the
> `RobotMoneyGateway` entrypoint, `RouterGovernance`, the `robotmoney-analyst`
> plugin, and the dapp dashboard surface. v0 is mostly *extending* these, with
> one new policy contract and a likely governance refactor. Nothing here
> requires a new subsystem built from scratch.

---

## 1. What the GTM document asks for (briefly)

The GTM strategy frames the committee as the company's core moat and primary
trust/conversion lever — an **open, multi-organization network of AI agents**
that debate a shared market read and vote publicly on allocations. In brief, it
asks for:

- **Multi-org membership at scale** — 15–20 contributor agents from AI
  companies, TradFi quant teams, and protocols (not just internal seats).
- **An agent enablement toolkit** — let non-investment-experts build competent
  committee agents, *without* exposing RM's proprietary methods.
- **Public debate, then vote** — agents debate the daily regime read against
  current holdings and publish votes.
- **Provenance & credibility** — agents tied to real, named, reputable
  orgs/people.
- **Live, per-agent track record** — visible allocation output over time;
  conversion gate is "2+ third-party agents producing live output."
- **Auditable allocations** — defensible, reproducible, no single entity in
  control.
- **A canonical daily regime feed** — transparent market analysis all agents
  consume.
- **Substantive allocation choices** — enough distinct vaults for tilts to
  matter.
- **Retail trust surface, contributor network effects, Sybil resistance** —
  growth and defensibility mechanics.

---

## 2. What we are addressing in v0 vs. deferring

### Addressing now (v0)

| Requirement | v0 decision |
|---|---|
| Membership | **Admin-gated.** Admins allowlist participating orgs/agents; no permissionless onboarding in v0. |
| Agent enablement toolkit | **Publish a committee agent skill + plugin**, extending `robotmoney-analyst`. Proprietary methods stay out of the published surface. |
| Identity / registration / signing | **On-chain registration + signed votes via `rmpc`**, routed through `RobotMoneyGateway`. Provenance = registered, signed on-chain identity. |
| Consensus rebalance receipts | **ed25519-signed receipts collected on-chain** (no threshold scheme). Agents sign off-chain with `rmpc sign` over canonical payload hash. Signatures submitted via `RobotMoneyGateway.consensusSubmitSignature`. Admin may `consensusReleaseReceipt` to trigger off-chain balance update, or receipt auto-rejects after 7-day window. |
| Vote record & auditability | Vote + metadata **registered on-chain** (via the new IC policy contract, through the gateway); the narrative memo / CoT **posted to a public link** (GitHub gist, etc.) referenced by `rationale_uri`. Track record and "auditable allocations" are the same mechanism. |
| Allocation choices | **Start with the existing 4-vault model.** No new vault type for v0. |
| Daily regime feed | **A dapp surface** (engineering-equivalent to the existing dashboard). Agents consume/reference it as the canonical shared input. |
| Committee display | **A dapp surface** rendering registered agents, votes, and track record from the on-chain registry. |

### Not yet ready to address (deferred to v1+)

These are all valuable ideas worth pursuing — we're sequencing them after v0
rather than dropping them. The first three share a helpful property: they sit at
the **dapp/product layer rather than the infrastructure layer**, and each would
benefit from a bit more **customer development** to get right. Because they build
*on top of* the v0 primitives rather than changing them, we lose nothing by
landing the foundation first and revisiting these with more user input. Sybil
resistance is in a slightly different category, noted below.

| Requirement | Why we're sequencing it later |
|---|---|
| Public debate / deliberation | A great direction. Before building it we'd like to spend time thinking through the trade-off between **amplification of signal and performance**, and the **model-collapse risk** (agents converging on one another rather than forming independent reads). v0 agents vote independently; we revisit debate once that thinking matures. |
| Retail conversion surface | Worth doing once the committee is live and credible. It's a dapp surface that wants more customer development, and it layers on without changing v0 infrastructure. |
| Contributor retention / network-effect mechanics | Central to the long-term moat. These are growth/dapp surfaces that benefit from more customer development, so we revisit them after the foundation is in place. |
| Sybil / collusion resistance | An ongoing concern shared by all blockchain systems rather than a single feature we engineer once. In v0 it's mitigated indirectly by admin-gating membership; we'll keep iterating on it as membership opens. |

---

## 3. Engineering approach

### Extend current tooling

- **`rmpc` client** — add committee-agent **registration** and **vote signing**.
  All committee actions, like all other `rmpc` actions, **pass through the
  `RobotMoneyGateway`** entrypoint; the committee does not get a side channel.
- **`robotmoney-analyst` plugin** — the published committee agent skill/plugin
  is an extension of the analyst plugin: it already reads regime/market context,
  so it gains "form a per-vault tilt → sign → submit vote" on top.
- **Dapp** — add the regime-feed surface and the committee surface as new pages
  alongside the existing dashboard (same engineering shape).

### New contract + refactor

- **New IC policy contract.** Committee policy (registered agents, the vote
  registry, aggregated tilts) lives in a **new contract**, not in
  `RouterGovernance`. This keeps `RouterGovernance`'s constraint intact (it
  controls router target weights only).
- **IC → RouterGovernance linkage.** IC policy **can in turn affect
  `RouterGovernance`** — committee output feeds the router-weight governance
  flow. Application to live weights remains **signalling → admin-applied**
  (consistent with Workstream B), now with an on-chain, auditable committee
  record upstream of it.
- **Likely refactor.** Wiring the IC policy contract into the existing
  gateway + `RouterGovernance` boundary will probably require a refactor of the
  governance interfaces. Scope the refactor before adding the IC contract so the
  boundary (router-weights vs. committee policy vs. registry lifecycle) stays
  clean.

### Drop / out of scope for v0

- Inter-agent **debate/deliberation** mechanics (v1 — model-collapse risk).
- **New vault types** (stay on the current 4 vaults).
- **Retail conversion, contributor network-effects, Sybil/collusion** surfaces.

---

## 4. Open questions

- Exact split of fields registered **on-chain** vs. left in the **off-chain
  memo** (the sprint's minimum set: `agent_id`, `vault`, `stance`,
  `target_weight_bps`, `confidence`, `rationale_uri`, `prompt_hash`,
  `inputs_digest`, `timestamp`, `schema_version`).
- Shape of the IC-policy → `RouterGovernance` linkage and the precise refactor
  of the governance interfaces.
- Genesis seats (Athena / Robot Money / Woon) and their registered wallets under
  the admin-gated model.
