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
> **consensus judge**, gateway surface, indexer tables, `rmpc` command, and
> off-chain worker (see §2.1, §3.3, and §6).
>
> **Two decisions since the first draft** (both in §2.1, and both narrowing §6):
> the on-chain write is made by a **single submitter attesting for the
> committee**, with analyst ed25519 signatures carried inside the payload and
> verified off-chain per ADR-0012 §5; and the allocation is the **deterministic
> mean** of the analysts' vectors, with the judge authoring the rationale rather
> than the numbers. Together they make the signed allocation reproducible, remove
> any need for per-analyst EVM identity in v0.1, and shrink the receipt contract.
> §6.1 is unblocked as a result — writing the schema file is the next task.
>
> **"Shipped" here means merged and tested, not deployed.** The only deployment
> manifest in this repo (`deployments/full-stack.json`) records gateway, vault,
> registry, `portfolio_router`, and `router_governance` — it has **no
> `InvestmentCommitteePolicy` entry**, no `TimelockController` entry, and its
> `admin` / `agent` / `pauser` are well-known Anvil development accounts, so it
> describes a local fork rather than production. No `ic_policy` address appears
> anywhere in `config/` or `deployments/`, which means `setICPolicy` has never
> been called from anything recorded here. Confirm the live position with ops
> before planning any rollout. If IC v0 is genuinely not deployed, the receipt
> contract can share **one** deployment and timelock-wiring ceremony with it
> instead of needing a second — see §3.3.

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
| Identity / registration / signing | **EOA-via-gateway is the v0 identity.** Agent is its registered EOA; authentication is `msg.sender` via `RobotMoneyGateway` (`onlyGateway`) + `hasRole(COMMITTEE_AGENT_ROLE)` — no ed25519, no EIP-712 in v0. The `robotmoney-frontend` swarm's ed25519 stack (`contract/src/signing.js`, `backend/src/lib/signing.ts`) is a *different product* (frontend swarm) with a different trust model, and **no on-chain write in v0 or v0.1 is ever authenticated by an ed25519 signature.** *(v0.1 carve-out: ed25519 signatures may appear inside a receipt payload as data verified off-chain — content, not authentication. See §2.2 and ADR-0012 §5.)* Key rotation is via `revokeAgent` + `registerAgent`; compromise response is revocation + event. | Shipped | `contracts/gateway/InvestmentCommitteePolicy.sol:154-157,164-177,197-246`, `contracts/gateway/RobotMoneyGateway.sol:1396-1446`, `docs/prd.md` §9, `docs/architecture.md:586` |
| Vote record & auditability | **Content-addressed, not gist-addressed.** Vote + commitment registered on-chain via `InvestmentCommitteePolicy` through the gateway; the narrative memo/CoT lives at any public `rationale_uri` but is **bound by `vote_digest` (= `keccak256` of the canonical vote JSON per `tests/fixtures/committee-vote.schema.json`)**. The indexer fetches `rationale_uri`, checks `keccak256(memo)==vote_digest`, and stores tilts only when verified; otherwise it records an unverified commitment (`docs/architecture.md` §5.4, §7.4). The dapp renders verified vs unverified distinctly and shows a fallback when the URI is unreachable or a reorg rewrites the log. | Shipped | `tests/fixtures/committee-vote.schema.json:1-60`, `contracts/gateway/InvestmentCommitteePolicy.sol:78,90-91,110-120`, `services/explorer-indexer/src/indexer.rs:1125,1164`, `docs/architecture.md:554-561,7.4,911-914` |
| Allocation choices | **Per-vault tilts over the existing 4-vault catalog, not a weight vector.** Each vote is one vault (`overweight`/`neutral`/`underweight` at `InvestmentCommitteePolicy.sol:63-69`, `tests/fixtures/committee-vote.schema.json:22-33` with `target_weight_bps` 0–10 000 and `confidence` 0–100). Aggregation to a router weight vector is **off-chain, admin-applied**; there is no on-chain aggregation in v0. A vault is votable only when it is Active and (for router relevance) `isRouterEligible` (`docs/architecture.md` §4.1, §4.7; `RouterGovernance.sol:387`). | Shipped | `docs/prd.md` §11, `docs/architecture.md:4.1,4.7`, `RouterGovernance.sol:365-422` |
| Daily regime feed | **Protocol-scope, read-only dapp surface with declared authority.** Rendered from the indexer + live chain reads per `docs/architecture.md` §5.0/5.3/5.4 (protocol scope: no wallet; safety-critical signing values still come from live `rmpc` reads, `docs/architecture.md` §6.1). Authored by Robot Money (RM) on a daily cadence; staleness and late-publish handling are specified in §3.2. | Shipped (shape) | `docs/architecture.md:5.0,5.3,5.4` |
| Committee display | **Three-layer dapp surface (protocol / account / action) per `docs/architecture.md` §5.3.** Protocol layer: registered agents, per-vault tilts, aggregated tilt, per-agent track record (from indexer). Account layer: connected agent's own vote history (live `getVote`/`latestVoteByAgent` + indexed history). Action layer: vote submission (vault → stance/weight → `rationale_uri` → preview → sign via gateway). Preview states explicitly: vote is signalling-only, does not move funds or set weights. | Shipped (shape) | `contracts/gateway/InvestmentCommitteePolicy.sol:250-270`, `docs/architecture.md:845-856,906-921` |
| Consensus rebalance receipts | **v0.1 — proposed, not yet implemented (see §2.1, §3.3, §6.1).** The on-chain write is an **EOA-via-gateway commitment** by a **single submitter** attesting for the committee; the analysts' ed25519 signatures ride inside the payload as data verified off-chain (§2.2, ADR-0012 §5). The allocation is the **deterministic mean** of the analysts' vectors converted to bps; a judge agent authors the rationale, not the numbers. Admin may `consensusReleaseReceipt` as a **signalling-only** release (sets `released=true`, emits `ReceiptReleased`; no fund movement, no `setWeights` call — INV-4 `docs/prd.md` §12, `docs/architecture.md` §4.8). Receipts are observable via the indexer/API like votes. Full spec (schema, judge, gateway interface, indexer, `rmpc`, worker) is in §2.1. | Proposed (v0.1) | `docs/prd.md:650-657` INV-4, `docs/architecture.md:4.8,5.1,5.4`, `docs/adr/ADR-0012-dual-curve-identity-policy.md` §4–5 |

#### 2.1 Consensus rebalance receipts — v0.1 scope (proposed)

This is the only delta that is not shipped. It is **not** a one-row table entry —
receipts are a full subsystem, and this section supersedes the prior one-row
spec in every respect.

- **Identity — one submitter attests for the committee (decided).** The on-chain
  write is EOA-via-gateway: `onlyGateway` on the receipt contract,
  `COMMITTEE_AGENT_ROLE` check, no parallel `AGENT_ROLE` and no second
  `registerAgent` entrypoint; the shipped policy pattern
  (`InvestmentCommitteePolicy.sol:154-157,209`) is the template, so the gateway
  stays the single choke point and role administration stays on one contract.
  **What changed:** an earlier draft of this section had *each* analyst call
  `consensusSubmitSignature` under its own `COMMITTEE_AGENT_ROLE` EOA. That is
  rejected. A **single submitter** records the receipt, and the analysts'
  ed25519 signatures ride **inside the payload as verifiable data**, checked
  off-chain. This is exactly the model ADR-0012 §5 fixes for the anchoring seam —
  the chain stores a commitment, never an ed25519 verification — and it needs no
  EVM identity for any analyst (see §2.2).
  **Accepted cost:** the chain proves the committee produced the recommendation
  and that one submitter attested to it; it does **not** prove each named analyst
  signed. Verifying that is an off-chain check against the payload, and the dapp
  must say so plainly rather than implying per-analyst on-chain attestation. A
  compromised submitter could therefore publish a receipt the analysts never
  agreed to unless the embedded signatures are verified on read — so that
  verification is load-bearing, not cosmetic. Per-analyst on-chain signing
  returns when external orgs onboard (§6.3); design the payload so analyst
  identity is a first-class field and that migration stays additive.
- **Signalling-only:** `consensusReleaseReceipt` is an **admin signal** (emits
  `ReceiptReleased`, sets `released=true`). It does not call
  `RouterGovernance.propose`/`execute` (`RouterGovernance.sol:365-422,474-500`)
  or `PortfolioRouter.setWeights` on-chain. Any translation to live weights is
  **off-chain, admin-applied** via the existing `RouterGovernance` path
  (`docs/architecture.md` §2.3, §2.4, §4.8). If a future phase needs on-chain
  coupling, it requires a new ADR revising `docs/prd.md` §12 INV-4 before build.
- **Consensus derivation — deterministic; the judge explains, it does not decide
  (decided).** The weight vector is the **unweighted arithmetic mean of the
  analysts' normalized vectors** — `robotmoney-frontend`'s shipped
  `meanTakeWeights` (`backend/src/swarm/domain.ts:1691-1710`), converted to bps.
  A judge agent reads the frozen take set and the session brief and authors the
  **rationale, the disagreements, and a release-safety opinion**; it never
  authors a number. This is §6.2's stated default, now adopted.
  **Why it matters:** the signed allocation is *reproducible* — anyone holding
  the take set recomputes the vector and gets the same answer, which is the
  strongest available property for an artifact governance acts on. A judge
  failure degrades the explanation, never the weights, so the trust boundary
  stays with the analysts and their existing per-take signatures.
  *Rejected:* a judge authoring its own allocation so it can weight a stronger
  argument over a weaker one. That is a v1+ conversation and would need pinned
  inputs plus a bounds check before anything could sign its output.
  **Consequence:** `meanTakeWeights` becomes load-bearing — a rounding or
  normalization bug there propagates into a signed, governance-facing artifact.
  It needs property tests and a guard against being bypassed or reimplemented.
- **Judge component.** The judge is a **sixth component** of this subsystem
  alongside the schema, gateway surface, indexer, `rmpc` command, and worker.
  It slots into the frontend's existing job queue and session state machine
  (`backend/src/worker/handlers/index.ts:55-59`, states
  `scheduled → collecting → window_closed → aggregated → published`). Its inputs
  must be pinned with `promptHash` / `inputsDigest` — the vocabulary the vote
  schema already uses — which here protect the prose, since the number is
  independently recomputable. It must fail closed on an unavailable model,
  malformed output, or too few takes.
- **Payload:** fixed-shape JSON schema committed to the repo (like
  `tests/fixtures/committee-vote.schema.json`), canonicalized at fixed field
  order with a domain separator and a `schema_version`. v0.1 does not ship until
  the schema is committed (see §6.1). Its contents are now settled in outline:
  **bps-converted mean weights, judge-authored prose, the embedded analyst
  ed25519 signature set, and `promptHash` / `inputsDigest`.** Adopt
  `canonicalizeSubmission`'s append-only field-order rule
  (`contract/src/signing.js:5-20`) so added fields never invalidate old
  signatures. **Shape prior art exists** — `robotmoney-frontend` already ships a
  multi-agent aggregate carrying target weights (`SwarmRecommendation`); see §2.3
  for what to borrow and what it does not solve.
- **Gateway surface:** additive only — `setICPolicy`/`committeeRegister`/`committeeVoteSubmit`
  at `contracts/gateway/interfaces/IGateway.sol:380,386,392` stay; the new
  receipt entrypoints are added alongside `agentOwner` (`IGateway.sol:422`), not
  substituted. **The exact entrypoint set is reopened by the identity decision
  above:** with one submitter carrying N signatures as payload data, there may be
  nothing left for a per-agent `consensusSubmitSignature` to do, and a one-shot
  `consensusRecordReceipt` (payload hash + digest + submitter) may replace both
  it and `consensusReceipt`. Settle this before writing the contract.
  `consensusReleaseReceipt` survives regardless — it is the human gate before the
  governance worker sees anything, and becomes the only meaningful state
  transition on the contract.
- **Indexer / API / rmpc / worker:** each specified with its shipped analogue
  as template — `services/explorer-indexer/src/indexer.rs:74,1125` + reorg handling
  `docs/architecture.md:928`, `docs/architecture.md:5.4` read scopes,
  `docs/architecture.md:5.1,690-710` `rmpc committee …` commands, and an off-chain
  worker that watches `ReceiptReleased` and (if policy says so) drafts a
  `RouterGovernance.propose(vaults,bps)` — the on-chain execution still needs
  quorum and delay (`RouterGovernance.sol:54-63,365-422`).
- **Expiry — re-derive, do not port.** The earlier `deadline = firstSignatureAt +
  WINDOW_SECONDS` (7 days, stored immutably on first signature, expiry derived
  off-chain as `block.timestamp > deadline && !released`, no keeper) existed to
  bound a **multi-party signature-collection window**. With one submitter there
  is nothing to wait for. The window may collapse to zero, or be repurposed as a
  staleness bound on the recommendation itself — decide which before building,
  and define what the dapp and the worker each do with a receipt that is never
  released.
- **Event correctness:** no event may use a `uint8[64] indexed` signature
  parameter (exceeds the 3-topic limit; cf. the `VoteSubmitted` pattern at
  `IInvestmentCommitteePolicy.sol:68-78`). This applies to whatever the
  entrypoint set above resolves to.
- **Quorum floor.** With the allocation now a plain mean, a two-analyst session
  yields a mathematically valid but thinly-supported vector. The judge's
  release-safety opinion is the natural place to catch this; the threshold itself
  is a product decision (§6.2).

#### 2.2 Identity note — EOA vs ed25519 (resolved)

The earlier proposal blended two trust models: `robotmoney-core`'s EOA-via-gateway
(`InvestmentCommitteePolicy.sol:154-157,209`) and `robotmoney-frontend`'s
ed25519 swarm (`contract/src/signing.js:5-20`, `backend/src/lib/signing.ts:26-37`,
`backend/src/swarm/domain.ts:544-768`).

**The rule, stated precisely:**

- **EOA-via-gateway is the sole *on-chain* identity** for v0 and v0.1. Every
  on-chain write — vote or receipt — is authenticated by `msg.sender` through the
  gateway plus a role check. No ed25519 signature is ever verified on-chain;
  the EVM has no ed25519 precompile, and ADR-0012 §5 closes that seam explicitly
  so no design assumes one.
- **Ed25519 signatures may ride inside a receipt payload as verifiable data**,
  checked off-chain by the indexer and the dapp. This is not a second on-chain
  identity — it is content, bound by the payload digest, exactly the
  "commitment on-chain, verification off-chain" model ADR-0012 §5 fixes.

**Amended from the earlier draft.** This section previously said an ed25519 path
"is not in scope until a future ADR defines the key registry, rotation, and
verification site." **ADR-0012 is that ADR** — it makes ed25519 the default for
every identity that does not sign EVM transactions (§1), keeps the curves from
swapping roles (§4: a committee key carries no on-chain authority and must not
be able to move funds), and fixes the anchoring model (§5). ADR-0012 is currently
**Proposed**; accepting it is a precondition for building receipts under §2.1's
identity decision.

An `rmpc sign` ed25519 payload path for committee *actions* still does not exist
in `robotmoney-core` (`docs/architecture.md:5.1,690-710` signs the EVM envelope,
not an ed25519 payload) and remains out of scope. `rmpc committee-identity`
(`clients/rust-payment-client/src/committee_identity.rs`) already implements the
frontend's exact ed25519 wire format — raw 32-byte key, raw 64-byte signature,
standard padded base64 — but it is a **demo-flow identity with no on-chain
authority** (ADR-0012 §4), and §2.1's submitter does not use it to authenticate
its chain write.

#### 2.3 Prior art — `SwarmRecommendation` in `robotmoney-frontend`

A consensus-produced rebalance artifact **already exists in `robotmoney-frontend`**.
It is the closest working precedent for §2.1's receipt payload, so §6.1 is a
question of *what to change*, not *what to invent*.

**What §2.1 adopts from it, and what it does not.** Adopted: the **derivation**
(`meanTakeWeights`, in bps), the aggregate's **field shape**, the
**append-only canonicalization rule**, and the analysts' **ed25519 signatures as
payload content**. Not adopted: the frontend's **authentication model** — no
ed25519 signature authenticates an on-chain write here, and the receipt's
authority comes from EOA-via-gateway plus the payload digest (§2.2, ADR-0012 §5).
The frontend's off-chain Postgres record remains a different product's storage,
not this subsystem's source of truth.

**The aggregate** — `SwarmRecommendation` (`contract/src/swarm.d.ts:260-275`),
persisted as `swarm_sessions.swarm_recommendation` (jsonb):

| Field | Meaning |
|---|---|
| `quorum` | `{active, submitted, absent, participation}` (`swarm.d.ts:227-232`) |
| `stances` | `Record<stance, count>` tally |
| `meanConfidence`, `absent[]` | participation summary |
| `type` | `"bucket_weights" \| "position_actions"` |
| `consensus[]`, `disagreements[]`, `rationale?` | prose; `disagreements` is `{topic, positions[{member_id, view}], what_settles}` |
| `weights?` | **the rebalance content** — `{bucket, weight}[]` |

**How consensus is computed.** `aggregateSession()`
(`backend/src/swarm/domain.ts:1784-1931`) selects the *latest revision per member*
over a frozen roster, then `meanTakeWeights` (`:1691-1710`) normalizes each agent's
weights to sum 1 and takes the **unweighted arithmetic mean per bucket**, sorted by
bucket, with the final bucket set to `1 - prefixTotal` so the vector sums exactly.
**This is now adopted** as the receipt's derivation, in bps (§2.1) — it was the
shipped answer to §6.2's "what derivation", and taking it is what makes the signed
allocation reproducible.

**The per-agent input** — `canonicalizeSubmission` (`contract/src/signing.js:5-20`)
fixes key order as `memberId, date, subjectId, nonce, stance, confidence, body,
memoUrl, weights?` and signs the UTF-8 bytes with ed25519. Note `weights` is
**appended last and only when present**, so pre-`weights` signatures stay valid
(`backend/tests/signing.test.ts:56,63`) — a schema-evolution pattern worth copying
into the receipt canonicalizer.

**Three gaps this precedent does *not* close** — each is a real design decision
for v0.1, not a copy:

1. **The aggregate is neither signed nor hashed.** Only per-agent takes carry
   signatures (`backend/src/lib/signing.ts:26-38`, re-verified at read time at
   `backend/src/swarm/projections.ts:183-201`). The only digest over aggregated
   content is the v0 archive bundle's sha256 over 72 sessions
   (`backend/src/swarm/v0-archive.ts:201`). §2.1's receipt is precisely the
   missing piece: a canonical, hashed *aggregate* that carries the analysts'
   signatures and is anchored by an on-chain commitment. The frontend has
   per-agent receipts (`SwarmTakeReceipt`, `swarm.d.ts:173-178`) but no aggregate one.
2. **Units differ.** Frontend weights are `[0,1]` floats; `robotmoney-core` uses
   `target_weight_bps` 0–10 000 (`tests/fixtures/committee-vote.schema.json:22-33`,
   `RouterGovernance.sol:377` sums to `BPS_DENOMINATOR`). A receipt schema must be
   bps-native, and the float→bps conversion needs a stated rounding rule so the
   vector still sums exactly.
3. **Serialized shape has already drifted.** Archived session payloads store
   `weights` as a **map** plus a `within_bucket_weights` field that no backend code
   writes and only the frontend reads
   (`frontend/public/data/swarm/sessions/2026-06-17-robotmoney-allocation.json`,
   `frontend/public/assets/js/app/alpine/static-views.js:335`), while the current
   producer emits an **array**. This is the failure mode a committed schema plus
   `schema_version` is meant to prevent (§6.1).

**Also nearby, and not consensus-derived:** `AllocationFramework`
(`backend/src/chain/allocation-framework.ts:15-34`) is the standing admin-managed
target-weight policy — rebalance content with no multi-agent derivation. And the
`"position_actions"` branch of `aggregateSession` emits **hardcoded** actions
(`domain.ts:1891-1894`), not agent-derived ones; a receipt must not inherit that.

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
  `ADMIN_ROLE` held by `TimelockController` (INV-3 `docs/prd.md:642-648`), event
  `ReceiptReleased` plus whatever record event the entrypoint set resolves to —
  none of them using an `indexed` signature parameter.
  Additive gateway surface alongside `IGateway.sol:380,386,392,422`. **Note the
  single-submitter decision (§2.1) shrinks this contract**: the multi-party
  signature collection and its 7-day deadline may both disappear, leaving record
  and release as the only transitions. Settle the entrypoint set before writing it.
- **Judge.** New — see §2.1. Lives in `robotmoney-frontend`'s job queue and
  session state machine, emits prose and a release-safety opinion, and never
  emits weights. **Note it is not on the critical path:** because D4 puts the
  number on `meanTakeWeights` (shipped) and the frontend already generates
  narrative via `buildRationale` / `buildSynthesis`, a valid receipt can be
  produced before the judge exists. Build it in parallel and treat it as a
  quality upgrade, not a blocker.
- **Deployment sequencing.** Contracts here are immutable — `InvestmentCommitteePolicy`
  has no proxy or initializer — so receipts genuinely need a new contract rather
  than an extension. But since IC v0 appears undeployed (see the status header),
  the two should share **one** deploy script, one timelock role-wiring ceremony,
  and one audit pass. Plan them together rather than sequentially.
- **Indexer / API / `rmpc` / worker.** See §2.1 — each wired like the
  vote path (polling, reorg rewriting at `docs/architecture.md:928`, protocol vs
  account read scopes at `docs/architecture.md:5.0`). The indexer and dapp must
  additionally verify the **embedded analyst ed25519 signatures** on read and
  render verified/unverified distinctly, exactly as they already do for
  `vote_digest` (`docs/architecture.md:911-914`) — under §2.1's identity model
  that check is the only thing binding the receipt to the analysts.
- **Cross-repo transport.** `robotmoney-frontend`'s backend is **`eth_call`-only**
  (`backend/src/chain/base-rpc-client.ts`) and cannot submit a transaction. The
  submitter is therefore `rmpc` (or a core-side worker): it fetches the receipt
  from the swarm API, verifies the digest and the embedded signatures, then
  writes the commitment. `rmpc` is the lower-risk choice — the production-signer
  gate, fail-closed config, and stable JSON envelope already exist there
  (`docs/architecture.md:5.1,642-654,690-710`).
- **Bucket ↔ vault mapping.** The frontend's four allocation buckets map 1:1 onto
  this repo's four vaults: `conservative_defi_yield` → rmUSDC (`docs/prd.md:434`),
  `protocol_tokens` → rmPROTO (`:460`), `agent_tokens` → rmAGENT (`:509`),
  `real_world_assets` → rmRWA (`:568`). Today this correspondence is **implicit**;
  it must be committed as canonical data referenced by both repos, with bucket →
  vault *address* resolved per deployment, before any receipt can name vaults.
- **Unit conversion.** Frontend weights are `[0,1]` floats; this repo is bps
  (`tests/fixtures/committee-vote.schema.json:22-33`), and
  `RouterGovernance.propose` hard-rejects a vector that does not sum to
  `BPS_DENOMINATOR` (`RouterGovernance.sol:377`). The converter needs a stated
  rounding rule with a settle-the-last-entry step — the same technique
  `meanTakeWeights` already uses for floats — plus a property test at the boundary.

### 3.4 No contract refactor — and who recommends vs. who approves

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

#### Governance topology (this repo has more than one governing body)

Earlier drafts said "admin-applied" as though one Safe did everything. It does
not. Three distinct bodies exist, with different membership models:

| Body | Membership | Governs |
|---|---|---|
| **Safe → `TimelockController` → `ADMIN_ROLE`** | 2-of-N Safe, hardware wallets required (`docs/technical/security-model.md` §4, `:89,98`) | Role changes, protocol params, committee agent registration, the agent-token shortlist (with a public veto window, ADR-0004) |
| **`RouterGovernance` voter set** | Addresses given power by `ADMIN_ROLE` via `setVotingPower` (`RouterGovernance.sol:310`); `vote()` reads power checkpointed at the proposal's `voteSnapshot`. Explicitly **not** token-holder governance (`docs/technical/governance-decisions.md:98`, `services/explorer-indexer/src/abi.rs:139`) | Portfolio weights, and only those |
| **Guardian** | Lower quorum than the full Safe; may pause, may **not** unpause (`docs/technical/security-model.md:212`) | Emergency pause |

**Decision — the committee and the `RouterGovernance` voter set are separate
bodies.** The committee recommends; a different set approves. No committee agent
address may hold `RouterGovernance` voting power.

This is what makes INV-4's signalling-only boundary real rather than nominal — if
the same parties both recommended and approved, "signalling-only" would be a
label, not a control. Three consequences:

- **New invariant, and it is testable.** The `COMMITTEE_AGENT_ROLE` holder set and
  the `RouterGovernance` non-zero-voting-power set MUST be disjoint. Add a
  regression test asserting it, alongside `testSignallingOnlyBoundary`. Any future
  change granting a committee agent voting power is a security-model change
  requiring a new ADR against `docs/prd.md` §12 INV-4.
- **The loop never runs unattended.** A human approval step sits in every
  rebalance, permanently — not merely by default. The off-chain worker drafts a
  proposal for human review and must never submit one itself (§6.2).
- **This strengthens the case for keeping the per-vault vote path.** Because the
  approving body is different, the committee's on-chain per-agent record is its
  own public artifact rather than a duplicate of who holds power — which is
  precisely the "live, per-agent track record" the GTM strategy asks for (§1).

**Open concern: the approving body's quorum is currently 1.**
`DeployRouterGovernance.s.sol` deploys `quorumThreshold = DEFAULT_QUORUM_THRESHOLD`
= 1, and `MIN_QUORUM_THRESHOLD` is also 1 (`RouterGovernance.sol:54`). One voter
with any nonzero power can therefore carry a weight proposal. That is a defensible
MVP default when the voter set is a single trusted admin, but it is **not** a
meaningful separate-body control. Before receipts drive real weight changes, set a
quorum that reflects the intended voter set — otherwise "a different body
approves" is true on paper and hollow in practice.

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
| 1 | Exact split of fields on-chain vs off-chain memo | **Shipped for votes; TBD for receipts.** Votes: on-chain stores the commitment tuple — `rationale_uri`, `vote_digest` (`voteJsonHash`), `prompt_hash`, `inputs_digest`, `timestamp`, `schema_version` plus structured `agent`, `vault`, `stance`, `target_weight_bps`, `confidence` — per `tests/fixtures/committee-vote.schema.json:1-60` and `InvestmentCommitteePolicy.sol:71-97,197-246`. Off-chain memo at `rationale_uri` carries the full narrative rationale, bound by the digest. Receipts: **the split is now decided in outline, the schema file is still uncommitted.** On-chain stores a commitment only — payload digest, submitter, released flag. Off-chain payload carries the bps weight vector, the judge's prose, the embedded analyst ed25519 signature set, `prompt_hash` / `inputs_digest`, and `schema_version` (§2.1, §2.2). `robotmoney-frontend`'s `SwarmRecommendation` is shape prior art for the aggregate half (§2.3). Writing the schema file is the immediate next task (§6.1). | Contract + schema |
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
- **Submitter compromise (new, from §2.1's identity decision).** Because one
  submitter attests for the committee, a compromised submitter could publish a
  receipt the analysts never agreed to. Mitigated by verifying the **embedded
  analyst ed25519 signatures on read** in both the indexer and the dapp, and by
  rendering an unverified receipt distinctly rather than hiding it — the same
  treatment `vote_digest` already gets (`docs/architecture.md:911-914`). The
  submitter holds no on-chain authority beyond recording a signal (INV-4), and
  release remains an admin gate. Residual risk is a plausible-looking but
  unsupported receipt reaching a human reviewer; the signature check is what
  catches it, so it is not optional.
- **Approving body with a quorum of 1 (new, from §3.4).** The committee and the
  `RouterGovernance` voter set are deliberately separate bodies, but the deployed
  default `quorumThreshold = 1` means a single voter can carry a weight proposal,
  which hollows out that separation. Mitigated by setting a quorum that reflects
  the real voter set before receipts drive weight changes, and by the disjointness
  invariant in §3.4. Until then, treat the separation as an organisational control
  rather than an enforced one.
- **`meanTakeWeights` as a single point of failure (new, from §2.1's derivation
  decision).** A rounding or normalization bug in
  `backend/src/swarm/domain.ts:1691-1710` now propagates into a signed artifact
  that governance acts on — a role that function has never carried. Mitigated by
  property tests on the mean and on the float→bps conversion at the
  `BPS_DENOMINATOR` boundary, and by a guard against the derivation being
  bypassed or reimplemented elsewhere.

---

## 6. Open questions

> These are **not** blocking for the shipped v0 (`InvestmentCommitteePolicy`).
> They block **v0.1 (consensus receipts)** until resolved. Each has an owner
> and a default if unresolved by the build kickoff.

- **6.1 Receipt JSON schema — owner: product + contract. → UNBLOCKED; write it.**
  Both design prerequisites are now decided (§2.1): the payload carries the
  **bps-converted deterministic mean weight vector**, the **judge's prose**
  (rationale, disagreements, release-safety opinion), the **embedded analyst
  ed25519 signature set**, `prompt_hash` / `inputs_digest`, and `schema_version`;
  the chain stores only a commitment to its digest. Start from
  `SwarmRecommendation`'s field list (`contract/src/swarm.d.ts:260-275` — quorum,
  stance tally, disagreements, weights) and make §2.3's three changes: hash the
  aggregate, express weights in bps, and pin one serialized shape.
  **What genuinely remains open is narrower than it looks:** the fixed field
  order, the domain separator, and where the canonicalizer lives.
  **On that last point — `@robotmoney/contract` does not work as an option.** It
  is `robotmoney-frontend`'s own package (`contract/package.json`), wired by
  `file:./contract` and `file:../contract` in that repo's two `package.json`s,
  never published to a registry, and not consumable from a Rust/Solidity repo at
  all. Either commit the schema to **both** repos as a shared fixture with a
  byte-conformance test on each side (recommended — a JS package on `rmpc`'s
  critical path is a heavy cost for one canonicalizer), or treat publishing
  `@robotmoney/contract` as an explicit precondition.
  **Default:** do not build receipts until the schema is committed to the repo,
  mirroring `tests/fixtures/committee-vote.schema.json` and adopting
  `contract/src/signing.js:5-20`'s append-only field-order rule.

- **6.2 Release quorum & policy — owner: product.** Is `consensusReleaseReceipt`
  gated on a minimum signature count (e.g. ≥2 of 3–5 seats), or is admin
  discretion the quorum with a dapp-visible signature count? What does a
  released receipt cause the off-chain worker to do — draft a
  `RouterGovernance.propose(vaults,bps)` with what `vaults`/`bps` derivation
  and what quorum/delay (`RouterGovernance.sol:54-63`), or merely record the
  signal? **The derivation half is now closed:** `meanTakeWeights`
  (`backend/src/swarm/domain.ts:1691-1710`) is adopted in bps form (§2.1) —
  normalize each agent's vector, take the unweighted per-bucket mean, settle the
  last entry so it sums exactly.
  **What remains open** is the release threshold and how much the worker may do
  unattended. Two constraints the earlier draft did not account for:
  - **A signature count now counts payload signatures, not on-chain calls**
    (§2.1's identity decision). The dapp must label them as such.
  - **`RouterGovernance` permits only one Active/Queued proposal at a time**
    (`RouterGovernance.sol:393-399`). If sessions publish faster than a proposal
    completes voting plus `executionDelay`, receipts queue behind one another —
    the policy must say skip, supersede, or throttle. The worker must also
    re-check `isRouterEligibleAndActive` (`:387`) at draft time, since a vault
    Active at receipt time may be Paused by then, and `propose` would revert.

  **Default:** admin discretion with no auto-threshold; the dapp renders the
  payload signature count and the worker drafts nothing automatically until a
  policy is written. Where a worker does draft, it drafts **for human review** —
  it never submits unattended.

- **6.3 Genesis seat attestation for external orgs — owner: ops + product.**
  Beyond the 3–5 internal genesis seats (§4 decision 3), what is the onboarding bar
  for a third-party org (org attestation format, EOA ↔ `agentId` binding,
  revocation transparency, disclosure), and are the Woon/Athena EOAs distinct
  from `robotmoney-frontend` swarm member identities (`backend/src/swarm/domain.ts:771-859`
  `applyMember`)? **Sharpened by §2.1's identity decision:** because a single
  submitter attests for the committee, no analyst needs an EVM address in v0.1 —
  and `committee_members` in `robotmoney-frontend`
  (`backend/migrations/0001_backends.sql:18-36`) has none. External-org onboarding
  is precisely what forces per-analyst on-chain signing, and with it an
  `evm_address` column and a real ed25519 ↔ EOA binding. Design the receipt
  payload so analyst identity is a first-class field, keeping that migration
  additive rather than a reshape. **Default:** zero external seats in v0/v0.1;
  external onboarding deferred to a follow-on proposal once the receipt schema
  and attestation criteria are defined.

- **6.4 Judge scope across subjects — owner: product. (New.)** `meanTakeWeights`
  averages within **one session's** take set, and `robotmoney-frontend` sessions
  are subject-scoped. A portfolio-wide rebalance spanning all four vaults
  therefore has no defined derivation yet — either sessions must become
  portfolio-scoped, or cross-session aggregation needs specifying. **Default:**
  one receipt per session per subject; no cross-subject aggregation in v0.1.
  This is the most likely thing to surface late, so decide it early.

