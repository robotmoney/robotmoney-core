# Investment Committee — v0 Feature Proposal

> Status: **Implemented + delta.** The `InvestmentCommitteePolicy` contract and
> its gateway/indexer wiring are shipped (`issue #1044`, `docs/architecture.md`
> §2.4, §4.8, §5.1, §5.4, §7.4 — see §3.1 for shipped artifacts). The remaining
> delta in this document is the **consensus rebalance receipts** surface,
> which is specified here as **v0.1 (proposed, not yet implemented)** with
> its own decisions and open questions. Companion to the sprint spec
> (`docs/sprint/20260601-week-sprint.md`, Workstream A) and the GTM strategy doc
> (RobotMoney_PMF_GTM_Strategy).
>
> **Position.** The Investment Committee vision reuses the existing `rmpc`
> client, `RobotMoneyGateway` entrypoint, `RouterGovernance`, `robotmoney-analyst`
> plugin, and dapp surfaces. The committee's core (`InvestmentCommitteePolicy`)
> is done — it extends those primitives with a signalling-only registry. The
> only new subsystem in the delta is the consensus rebalance receipts flow
> (§2.1, §3.3), which is scoped as v0.1 and requires its own payload schema,
> gateway surface, indexer tables, `rmpc` command, and off-chain worker
> (see §2.1, §3.3, and §6).

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

### Addressing now (v0 — shipped + v0.1 delta)

| Requirement | v0 decision | Status | Grounding |
|---|---|---|---|
| Membership | **Admin-gated, timelock-held, capped.** `ADMIN_ROLE` on the IC contract is held by the `TimelockController` (`docs/architecture.md` §4.5, §4.8) with proposer/canceller on the Safe (`0x88bA…75A0`). V0 allowlist is capped at **3–5 internal seats** (Athena / Robot Money / Woon — see §4 decision 3). Membership is registry state (`VaultRegistry.isRouterEligible` analogue, `docs/architecture.md` §7.3), not a code variant. Public `AgentRegistered`/`AgentRevoked` events are the auditable membership log. No permissionless onboarding in v0. | Shipped (cap is a product decision) | `contracts/gateway/InvestmentCommitteePolicy.sol:37,164-177`, `docs/architecture.md:134-136,4.5` |
| Agent enablement toolkit | **Publish a committee agent skill + plugin**, extending `robotmoney-analyst`. Proprietary methods stay out of the published surface. Reuses the analyst's regime/market datasources; adds "form per-vault tilt → post memo → sign and submit via gateway." Fails closed on missing IC config, unregistered agent, or unreachable `rationale_uri`. | Shipped (skill) | `plugins/robotmoney-analyst/`, `docs/architecture.md:5.5` |
| Identity / registration / signing | **EOA-via-gateway is the v0 identity.** Agent is its registered EOA; authentication is `msg.sender` via `RobotMoneyGateway` (`onlyGateway`) + `hasRole(COMMITTEE_AGENT_ROLE)` — no ed25519, no EIP-712 in v0. The `robotmoney-frontend` swarm's ed25519 stack (`contract/src/signing.js`, `backend/src/lib/signing.ts`) is a *different product* (frontend swarm) with a different trust model; v0 does not borrow its "ed25519-signed" language. Key rotation is via `revokeAgent` + `registerAgent`; compromise response is revocation + event. | Shipped | `contracts/gateway/InvestmentCommitteePolicy.sol:154-157,164-177,197-246`, `contracts/gateway/RobotMoneyGateway.sol:1396-1446`, `docs/prd.md` §9, `docs/architecture.md:586` |
| Vote record & auditability | **Content-addressed, not gist-addressed.** Vote + commitment registered on-chain via `InvestmentCommitteePolicy` through the gateway; the narrative memo/CoT lives at any public `rationale_uri` but is **bound by `vote_digest` (= `keccak256` of the canonical vote JSON per `tests/fixtures/committee-vote.schema.json`)**. The indexer fetches `rationale_uri`, checks `keccak256(memo)==vote_digest`, and stores tilts only when verified; otherwise it records an unverified commitment (`docs/architecture.md` §5.4, §7.4). The dapp renders verified vs unverified distinctly and shows a fallback when the URI is unreachable or a reorg rewrites the log. | Shipped | `tests/fixtures/committee-vote.schema.json:1-60`, `contracts/gateway/InvestmentCommitteePolicy.sol:78,90-91,110-120`, `services/explorer-indexer/src/indexer.rs:1125,1164`, `docs/architecture.md:554-561,7.4,911-914` |
| Allocation choices | **Per-vault tilts over the existing 4-vault catalog, not a weight vector.** Each vote is one vault (`overweight`/`neutral`/`underweight` at `InvestmentCommitteePolicy.sol:63-69`, `tests/fixtures/committee-vote.schema.json:22-33` with `target_weight_bps` 0–10 000 and `confidence` 0–100). Aggregation to a router weight vector is **off-chain, admin-applied**; there is no on-chain aggregation in v0. A vault is votable only when it is Active and (for router relevance) `isRouterEligible` (`docs/architecture.md` §4.1, §4.7; `RouterGovernance.sol:387`). | Shipped | `docs/prd.md` §11, `docs/architecture.md:4.1,4.7`, `RouterGovernance.sol:365-422` |
| Daily regime feed | **Protocol-scope, read-only dapp surface with declared authority.** Rendered from the indexer + live chain reads per `docs/architecture.md` §5.0/5.3/5.4 (protocol scope: no wallet; safety-critical signing values still come from live `rmpc` reads, `docs/architecture.md` §6.1). Authored by Robot Money (RM) on a daily cadence; staleness and late-publish handling are specified in §3.2. | Shipped (shape) | `docs/architecture.md:5.0,5.3,5.4` |
| Committee display | **Three-layer dapp surface (protocol / account / action) per `docs/architecture.md` §5.3.** Protocol layer: registered agents, per-vault tilts, aggregated tilt, per-agent track record (from indexer). Account layer: connected agent's own vote history (live `getVote`/`latestVoteByAgent` + indexed history). Action layer: vote submission (vault → stance/weight → `rationale_uri` → preview → sign via gateway). Preview states explicitly: vote is signalling-only, does not move funds or set weights. | Shipped (shape) | `contracts/gateway/InvestmentCommitteePolicy.sol:250-270`, `docs/architecture.md:845-856,906-921` |
| Consensus rebalance receipts | **v0.1 — proposed, not yet implemented (see §2.1, §3.3, §6.1).** Signatures are **EOA-via-gateway commitments** (same identity as votes; ed25519 is not used in `robotmoney-core` v0 — see §2.2). Agents submit a commitment to a canonical receipt payload hash via `RobotMoneyGateway.consensusSubmitSignature`; admin may `consensusReleaseReceipt` as a **signalling-only** release (sets `released=true`, emits `ReceiptReleased`; no fund movement, no `setWeights` call — INV-4 `docs/prd.md` §12, `docs/architecture.md` §4.8). Expiry is derived as `block.timestamp > deadline && !released` (no on-chain auto-reject keeper in v0.1). Receipts are observable via the indexer/API like votes. Full spec (payload schema, gateway interface, indexer, `rmpc`, worker) is in §2.1. | Proposed (v0.1) | `docs/prd.md:650-657` INV-4, `docs/architecture.md:4.8,5.1,5.4` |

#### 2.1 Consensus rebalance receipts — v0.1 scope (proposed)

This is the only delta that is not shipped. It is **not** a one-row table entry —
receipts are a full subsystem, and this section supersedes the prior one-row
spec in every respect.

- **Identity:** same as votes — EOA-via-gateway, `onlyGateway` on the receipt
  contract, `COMMITTEE_AGENT_ROLE` check. No parallel `AGENT_ROLE` and no
  second `registerAgent` entrypoint on the receipt contract; the shipped
  policy pattern (`InvestmentCommitteePolicy.sol:154-157,209`) is the template,
  so the gateway stays the single choke point and role administration stays
  on one contract.
- **Signalling-only:** `consensusReleaseReceipt` is an **admin signal** (emits
  `ReceiptReleased`, sets `released=true`). It does not call
  `RouterGovernance.propose`/`execute` (`RouterGovernance.sol:365-422,474-500`)
  or `PortfolioRouter.setWeights` on-chain. Any translation to live weights is
  **off-chain, admin-applied** via the existing `RouterGovernance` path
  (`docs/architecture.md` §2.3, §2.4, §4.8). If a future phase needs on-chain
  coupling, it requires a new ADR revising `docs/prd.md` §12 INV-4 before build.
- **Payload:** TBD — fixed-shape JSON schema committed to the repo (like
  `tests/fixtures/committee-vote.schema.json`), canonicalized at fixed field
  order in `@robotmoney/contract` or `tests/fixtures/`, with a domain separator.
  v0.1 does not ship until the schema is committed (see §6.1).
- **Gateway surface:** additive only — `setICPolicy`/`committeeRegister`/`committeeVoteSubmit`
  at `contracts/gateway/interfaces/IGateway.sol:379-394` stay; the new
  `consensusReceipt`/`consensusSubmitSignature`/`consensusReleaseReceipt` are
  added alongside `agentOwner` (`IGateway.sol:422`), not substituted.
- **Indexer / API / rmpc / worker:** each specified with its shipped analogue
  as template — `services/explorer-indexer/src/indexer.rs:74,1125` + reorg handling
  `docs/architecture.md:928`, `docs/architecture.md:5.4` read scopes,
  `docs/architecture.md:5.1,690-710` `rmpc committee …` commands, and an off-chain
  worker that watches `ReceiptReleased` and (if policy says so) drafts a
  `RouterGovernance.propose(vaults,bps)` — the on-chain execution still needs
  quorum and delay (`RouterGovernance.sol:54-63,365-422`).
- **Expiry:** `deadline = firstSignatureAt + WINDOW_SECONDS` (7 days). No keeper;
  expiry is derived off-chain (`block.timestamp > deadline && !released`). The
  contract stores `deadline` immutably on first signature.
- **Event correctness:** `SignatureSubmitted` must not use `uint8[64] indexed`
  (exceeds 3-topic limit; cf. `InvestmentCommitteePolicy.sol:110-120` pattern).

#### 2.2 Identity note — EOA vs ed25519 (resolved)

The earlier proposal blended two trust models: `robotmoney-core`'s EOA-via-gateway
(`InvestmentCommitteePolicy.sol:154-157,209`) and `robotmoney-frontend`'s
ed25519 swarm (`contract/src/signing.js:5-20`, `backend/src/lib/signing.ts:26-37`,
`backend/src/swarm/domain.ts:544-768`). **v0/v0.1 use EOA-via-gateway only.**
An `rmpc sign` ed25519 payload path for committee actions does not exist in
`robotmoney-core` (`docs/architecture.md:5.1,690-710` signs the EVM envelope, not
an ed25519 payload) and is not in scope until a future ADR defines the key
registry, rotation, and verification site.

### Not yet ready to address (deferred to v1+)

These are sequenced after v0 rather than dropped. The first three are
**dapp/product-layer** work that benefits from customer development and builds
*on top of* the v0 primitives without changing them. Sybil is distinct — see below.

| Requirement | Why we're sequencing it later |
|---|---|
| Public debate / deliberation | Deliberation is valuable, but we need to resolve the signal-amplification vs. model-collapse tradeoff (agents converging rather than forming independent reads) before building it. v0 agents vote independently; debate is revisited once that thinking matures. |
| Retail conversion surface | Worth doing once the committee is live and credible. Dapp surface that layers on without changing v0 infra. |
| Contributor retention / network-effect mechanics | Central to the long-term moat, but growth/dapp surfaces that benefit from more customer development — revisit after the foundation is live. |
| Sybil / collusion resistance | Ongoing concern (not a one-time feature). **v0 mitigation:** capped allowlist (3–5), public `AgentRegistered`/`AgentRevoked` log, and timelock-held `ADMIN_ROLE` (§2). Engineered Sybil resistance (org attestation, stake, rate limits) is v1+. |

---

## 3. Engineering approach

### 3.1 Shipped (Investment Committee — `issue #1044`)

- **New IC policy contract.** `contracts/gateway/InvestmentCommitteePolicy.sol:1-279`
  — signalling-only registry (`AgentRegistered`, `VoteSubmitted`, `AgentRevoked` at
  `:104-120`), `ADMIN_ROLE` allowlists `COMMITTEE_AGENT_ROLE` at `:164-168`,
  `onlyGateway` at `:154-157`, vote validation at `:197-246` (stance, bps, confidence,
  `voteJsonHash`, `rationaleUri`, vault). Enforced by `testSignallingOnlyBoundary`.
- **Gateway wiring.** `contracts/gateway/RobotMoneyGateway.sol:285-287` (`icPolicy`),
  `1396-1446` (`setICPolicy`, `committeeRegister` at `:1419`, `committeeVoteSubmit` at
  `:1439` with `onlyRole(ADMIN_ROLE)`/`onlyRole(AGENT_ROLE)` and `ICPolicyNotSet`).
  `contracts/gateway/interfaces/IGateway.sol:379-394`, `contracts/gateway/interfaces/IInvestmentCommitteePolicy.sol:1-124`.
- **Vote schema.** `tests/fixtures/committee-vote.schema.json:1-60` — `agent_id`, `vault`,
  `stance` (`overweight`/`neutral`/`underweight`), `target_weight_bps`, `confidence`,
  `rationale_uri`, `prompt_hash`, `inputs_digest`, `timestamp`, `schema_version`.
  CI validates valid fixtures pass and invalid fixtures fail.
- **Indexer & API.** `services/explorer-indexer/src/indexer.rs:74,1125` + `services/explorer-indexer/src/db.rs:1076,1133`
  ingest `AgentRegistered`/`VoteSubmitted`/`AgentRevoked` via poll-based JSON-RPC
  (`docs/architecture.md` §5.4, §7.4); per-vault tilts stored only when
  `keccak256(memo)==vote_digest` (`docs/architecture.md:911-914`).
- **`rmpc` client.** `docs/architecture.md:5.1,690-710` — `committee register` + `committee vote-submit`
  via `AgentSigner` + gateway, production-signer gate, stable JSON envelope
  (`docs/architecture.md:642-654`), fail-closed on missing IC config.
- **`robotmoney-analyst` plugin.** `plugins/robotmoney-analyst/` — committee skill
  extends the analyst's regime/market datasources; adds "form per-vault tilt →
  post memo → sign and submit via gateway" (`docs/architecture.md:5.5`).
- **Dapp.** Regime feed + committee surfaces shaped per `docs/architecture.md:5.3,845-856,5.4,7.4`
  (see also §3.2).

### 3.2 Regime feed & committee display — staleness, late publish, reorg

The regime feed and committee surfaces are shaped in
`docs/architecture.md:845-856,906-921`; this section pins the product
behaviors the shape leaves open.

- **Authorship & cadence.** The regime feed is authored by Robot Money on a
  daily cadence — one snapshot per UTC day. Each snapshot carries both the
  day it is authored for and the time it was published.
- **Staleness.** The dapp always renders the latest snapshot's age. When the
  newest snapshot is older than 24 hours (one missed cadence), the feed
  renders a visible stale banner; beyond 48 hours it renders as
  unavailable-with-history rather than presenting an old read as current.
  Committee agents record which snapshot they consumed via `inputs_digest`
  (`tests/fixtures/committee-vote.schema.json`), so a vote formed on a stale
  read is detectable after the fact.
- **Late publish.** A snapshot published after its authored-for day is stored
  and rendered with both timestamps; it never overwrites or backfills an
  earlier day, and missed days stay visibly missing.
- **Reorg & availability.** Committee and regime rows follow the indexer's
  reorg rule — rewritten at or above the safe head
  (`docs/architecture.md:928`). Display reads are non-authoritative for
  signing (`docs/architecture.md` §6.1). When a `rationale_uri` is
  unreachable or a memo fails the digest check, the dapp renders the
  unverified state (§2) instead of hiding the row.

### 3.3 Extend for v0.1 (Consensus rebalance receipts — proposed)

- **Contract.** New `ConsensusRebalanceReceipt.sol` — `onlyGateway`, signalling-only
  (no `receive`/`fallback`, no vault/router calls — same constraint as
  `InvestmentCommitteePolicy.sol:272-278` / `docs/architecture.md:148,1192-1198`),
  `ADMIN_ROLE` held by `TimelockController` (INV-3 `docs/prd.md:642-648`), events
  `SignatureSubmitted` (no `indexed` signature), `ReceiptReleased`.
  Additive gateway surface: `consensusReceipt` / `consensusSubmitSignature` /
  `consensusReleaseReceipt` alongside `IGateway.sol:379-394,422`.
- **Indexer / API / `rmpc` / worker.** See §2.1 — each wired like the
  vote path (polling, reorg rewriting at `docs/architecture.md:928`, protocol vs
  account read scopes at `docs/architecture.md:5.0`).

### 3.4 No contract refactor

`InvestmentCommitteePolicy` never calls and is never called by
`RouterGovernance` (`RouterGovernance.sol:1-630` controls `PortfolioRouter`
weights only, `docs/architecture.md:92-99,114-125`). The linkage is
**off-chain, admin-applied**: an admin (via timelock, `docs/architecture.md:4.5`)
reads hash-verified tilts/receipts off-chain and proposes weights through
`RouterGovernance.propose(vaults,bps)` (`RouterGovernance.sol:365-422`), which
enforces `bps` sum to `BPS_DENOMINATOR` at `:377` and `isRouterEligibleAndActive`
at `:387`, then the existing `propose` → `vote` → `execute` path (`:474-500`)
applies weights. **No governance-interface refactor is required**
(`docs/architecture.md:604`).

### 3.5 Drop / out of scope for v0

- Inter-agent **debate/deliberation** mechanics (v1).
- **New vault types** (stay on the 4 vaults — rmUSDC, rmPROTO, rmAGENT, rmRWA
  per `docs/prd.md` §11; votable precondition in §2).
- **Retail conversion, contributor network-effects, Sybil/collusion** surfaces (v1).

---

## 4. Resolved decisions (were §4 open questions)

The three open questions in the prior draft are now **decisions** with grounding.
Remaining uncertainty is in §6.

| # | Decision | Resolution | Owner / grounding |
|---|---|---|---|
| 1 | Exact split of fields on-chain vs off-chain memo | **Shipped for votes; TBD for receipts.** Votes: on-chain stores the commitment tuple — `rationale_uri`, `vote_digest` (`voteJsonHash`), `prompt_hash`, `inputs_digest`, `timestamp`, `schema_version` plus structured `agent`, `vault`, `stance`, `target_weight_bps`, `confidence` — per `tests/fixtures/committee-vote.schema.json:1-60` and `InvestmentCommitteePolicy.sol:71-97,197-246`. Off-chain memo at `rationale_uri` carries the full narrative rationale, bound by the digest. Receipts: field split is TBD pending the receipt JSON schema (§2.1, §6.1) — no receipt schema is committed on this branch. | Contract + schema |
| 2 | Shape of the IC-policy → `RouterGovernance` linkage and governance-interface refactor | **Off-chain, admin-applied; no refactor.** IC output (votes and v0.1 receipts) is signalling-only (`docs/prd.md:650-657` INV-4, `docs/architecture.md:126-130,148`). Translation to live weights is `RouterGovernance.propose` → `vote` → `execute` (`RouterGovernance.sol:365-500`), gated by quorum/delay (`:54-63`). The architecture already states "RouterGovernance is unchanged and no governance-interface refactor is required" (`docs/architecture.md:604`). | Architecture |
| 3 | Genesis seats (Athena / Robot Money / Woon) | **3–5 internal seats in v0, no external seats.** Athena / Robot Money / Woon are the named genesis agents under the admin-gated, timelock-held model (`InvestmentCommitteePolicy.sol:164-168`). Their EOAs are provisioned by RM ops, attested via `agentId` string (`:128,166`) and the public `AgentRegistered` log, and (if needed) seeded via `rmpc committee register`. External org seats require the receipt schema and attestation criteria in v0.1 before any third-party onboarding. | Ops + product |

---

## 5. Risks & mitigations

- **Admin concentration.** Mitigated by `TimelockController` + Safe, public event log,
  and a 3–5 seat cap (§2). See `docs/architecture.md:384-392`, `docs/prd.md:650-657`.
- **Memo mutability.** Mitigated by `vote_digest` binding and verified/unverified
  rendering (`docs/architecture.md:911-914`, §2). Recommend IPFS or pinned gist;
  dapp shows a fallback when unreachable.
- **Per-vault vs vector confusion.** Mitigated by per-vault vote shape
  (`tests/fixtures/committee-vote.schema.json:22-33`) and the explicit
  "no on-chain aggregation" rule (§2).
- **Event correctness for receipts.** Prevented by the `VoteSubmitted` pattern
  (`InvestmentCommitteePolicy.sol:110-120`) — receipts must not use `indexed`
  signature (see §2.1).
- **Custody.** Committee contracts hold no assets and grant no treasury-spend
  (`docs/prd.md:650-657` INV-4, `docs/architecture.md:1192-1198`); releases are
  signals. Any future coupling that moves funds needs a new ADR.

---

## 6. Open questions

> These are **not** blocking for the shipped v0 (`InvestmentCommitteePolicy`).
> They block **v0.1 (consensus receipts)** until resolved. Each has an owner
> and a default if unresolved by the build kickoff.

- **6.1 Receipt JSON schema — owner: product + contract.** What fields are in the
  canonical rebalance receipt JSON (e.g. `agent_id`, `vault`, `stance`,
  `target_weight_bps`, `confidence`, `rationale_uri`, `prompt_hash`,
  `inputs_digest`, `timestamp`, `schema_version` — or a weight-vector shape?),
  what is the fixed field order and domain separator, and where does the
  canonicalizer live (`@robotmoney/contract` vs `tests/fixtures/`)?
  **Default:** do not build receipts; keep v0.1 unscoped until a schema is
  committed to the repo (mirroring `tests/fixtures/committee-vote.schema.json`
  and the frontend swarm's `contract/src/signing.js:5-20` in `robotmoney-frontend`).

- **6.2 Release quorum & policy — owner: product.** Is `consensusReleaseReceipt`
  gated on a minimum signature count (e.g. ≥2 of 3–5 seats), or is admin
  discretion the quorum with a dapp-visible signature count? What does a
  released receipt cause the off-chain worker to do — draft a
  `RouterGovernance.propose(vaults,bps)` with what `vaults`/`bps` derivation
  and what quorum/delay (`RouterGovernance.sol:54-63`), or merely record the
  signal? **Default:** admin discretion with no auto-threshold; the dapp
  renders signature count and the worker drafts nothing automatically until
  a policy is written.

- **6.3 Genesis seat attestation for external orgs — owner: ops + product.**
  Beyond the 3–5 internal genesis seats (§4 decision 3), what is the onboarding bar
  for a third-party org (org attestation format, EOA ↔ `agentId` binding,
  revocation transparency, disclosure), and are the Woon/Athena EOAs distinct
  from `robotmoney-frontend` swarm member identities (`backend/src/swarm/domain.ts:771-859`
  `applyMember`)? **Default:** zero external seats in v0/v0.1; external
  onboarding deferred to a follow-on proposal once the receipt schema and
  attestation criteria are defined.

