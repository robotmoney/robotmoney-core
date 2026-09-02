# Investment Committee — v0 Feature Proposal

> Status: **Implemented on a local devnet; not publicly deployed.** The
> `InvestmentCommitteePolicy` contract and its gateway/indexer wiring are
> shipped (`issue #1044`, `docs/architecture.md` §2.4, §4.8, §5.1, §5.4,
> §7.4 — see §3.1 for shipped artifacts). The v0.1 **consensus recommendation
> receipts** contract, client, indexer, and read surfaces are also implemented
> and exercised on the local-devnet path (`docs/architecture.md` §4.9, §5.1,
> §5.4, §7.5). They are deliberately not a public-chain deployment. Companion
> to the sprint spec
> (`docs/sprint/20260601-week-sprint.md`, Workstream A) and the GTM strategy doc
> (RobotMoney_PMF_GTM_Strategy).
>
> **Close-out boundary.** The independent local-devnet components above are
> implemented. The cross-repository acceptance test proving the full route is
> `robotmoney-core#1315`, now merged on `dev`; this document claims its
> end-to-end acceptance evidence on the local devnet, not a public deployment.
> There is no unresolved schema, release-policy, attestation, or subject-scope
> decision (§6).
>
> **Position.** The Investment Committee vision reuses the existing `rmpc`
> client, `RobotMoneyGateway` entrypoint, `RouterGovernance`, `robotmoney-analyst`
> plugin, and dapp surfaces. The committee's core (`InvestmentCommitteePolicy`)
> is done — it extends those primitives with a signalling-only registry. The
> only new subsystem in the delta is the consensus recommendation receipts flow
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
> §6 records the resulting pinned schema, release policy, and subject scope.
> The `judge` block's reconciliation with the shipped `JudgeOpinion` is now
> **settled** (§6.5): the receipt carries the shipped opinion field for field
> plus its `source`, and both repos hold the same bytes.
>
> **What receipts are for.** They are primarily a **public, censorship-resistant
> record** of what the committee recommended, and only occasionally the trigger
> for a real weight change — a separate body approves those (§3.4). This framing
> is set in §2.1 and shapes the surface: the on-chain commitment is the point
> rather than an enhancement, a silently missing receipt is a product defect, and
> the dapp must state per recommendation whether it was applied.
>
> **"Shipped" here means merged and tested. `InvestmentCommitteePolicy` is not
> deployed on any blockchain** — confirmed with the product owner, 2026-08-26.
> The repo evidence agrees: `deployments/full-stack.json` records gateway, vault,
> registry, `portfolio_router`, and `router_governance` but has **no
> `InvestmentCommitteePolicy` entry** and no `TimelockController` entry, its
> `admin` / `agent` / `pauser` are well-known Anvil development accounts, and no
> `ic_policy` address appears anywhere in `config/` or `deployments/` — so
> `setICPolicy` has never been called outside a local fork.
>
> **Three consequences for v0.1**, all assumed by §2.1 and §3.3:
> 1. The receipt contract shares **one** deployment, **one** timelock role-wiring
>    ceremony, and **one** audit pass with `InvestmentCommitteePolicy`'s own first
>    deployment. It does not follow it.
> 2. There is **no live interface to stay compatible with**, so the receipt
>    entrypoint set is designed freely rather than preserving the rejected
>    multi-signer shape (§2.1).
> 3. No committee agent is registered anywhere, so genesis seat provisioning
>    (§4 decision 3) is greenfield rather than a migration.
>
> **v0.1 targets a local fork or devnet, not a public chain.** Mainnet deployment
> is a separate decision, deliberately deferred. This matters for how §2.1's
> public-record framing should be read: the censorship-resistance it describes —
> that no single entity can silently suppress a recommendation — is **design
> intent that lands at deployment, not a property v0.1 delivers.** A devnet
> anchor rehearses the mechanism on a chain nobody else reads. Until the
> contracts are live on Base behind a real Safe and timelock, the dapp must not
> describe the record as tamper-proof or censorship-resistant in the present
> tense. Going live additionally requires a Safe with hardware-wallet signers,
> `ADMIN_ROLE` transferred to a deployed `TimelockController` on all five
> protocol contracts (`docs/architecture.md:1226`), an audit pass, a funded
> submitter key with a custody and rotation story, and registered genesis agents —
> none of which are in v0.1 scope.

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
| Consensus recommendation receipts | **v0.1 — implemented on the local devnet (see §2.1, §3.3, §6.1).** The on-chain write is an **EOA-via-gateway commitment** by a **single submitter** attesting for the committee; the analysts' ed25519 signatures ride inside the payload as data verified off-chain (§2.2, ADR-0012 §5). The allocation is the **deterministic mean** of the analysts' vectors converted to bps; a judge agent authors the rationale, not the numbers. Admin may `consensusReleaseReceipt` as a **signalling-only** release (sets `released=true`, emits `ReceiptReleased`; no fund movement, no `setWeights` call — INV-4 `docs/prd.md` §12, `docs/architecture.md` §4.9). Receipts are observable via the indexer/API like votes. Full spec (schema, judge, gateway interface, indexer, `rmpc`, worker) is in §2.1. | Implemented locally; public deployment deferred | `docs/prd.md:650-657` INV-4, `docs/architecture.md:4.9,5.1,5.4,7.5`, `docs/adr/ADR-0012-dual-curve-identity-policy.md` §4–5 |

#### 2.1 Consensus recommendation receipts — v0.1 implementation scope

This is not a one-row table entry — receipts are a full subsystem, and this
section supersedes the prior one-row spec in every respect. Its remaining
close-out dependency, the cross-repository acceptance test, is now merged
(`robotmoney-core#1315`) and supplies the end-to-end acceptance evidence for
the local-devnet path; there is no unimplemented receipt interface.

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
- **What receipts are for — a public record first, a rebalance trigger
  occasionally (decided).** The committee publishes on a fast cadence; a separate
  human body (§3.4) applies a real weight change only periodically. **The on-chain
  commitment and the public per-agent record are the deliverable**, not the
  rebalance loop. Most receipts are informational **by design, not by accident.**
  Three consequences:
  - **The on-chain anchor is the point, not an enhancement.** A signed receipt
    published only at an RM-controlled URL can still be silently suppressed by RM.
    The commitment is what makes the record censorship-resistant, which is the
    property the record exists to provide and what "no single entity in control"
    (§1) actually requires. **Note this is the design's purpose, not v0.1's
    delivered state** — v0.1 proves the mechanism on a devnet, and the property
    itself lands only at mainnet deployment (see the status header).
  - **A missing receipt is a product defect, not an ops hiccup.** If a session
    that should have produced a receipt silently produces none, the record has a
    hole in exactly the place someone would look for suppression. Submission
    failures must alert, never drop quietly.
  - **The dapp must show applied vs. not-applied per recommendation.** A public
    record of recommendations that were mostly not followed is either honest and
    valuable or misleading and damaging, and the difference is entirely
    presentation. This is a first-class requirement of the surface, not a polish
    item.

  This also removes any tension with `RouterGovernance`'s one-active-proposal
  limit (`RouterGovernance.sol:393-399`): receipts are not queued for application,
  so a fast publishing cadence against slow governance throughput is the intended
  shape rather than a bottleneck.
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
- **Payload (pinned by issue #1244):**
  `tests/fixtures/consensus-receipt.schema.json` is the fixed-shape schema and
  `consensus-receipt.canonicalization.json` is the language-neutral canonicalizer
  contract. The bytes are UTF-8
  `robotmoney:consensus-receipt:v1\n` + compact JSON + a trailing newline, hashed
  with `keccak256`; v1 fields are ordered `schema_version`, `session_id`,
  `subject_id`, `created_at`, `prompt_hash`, `inputs_digest`, `quorum`, `stances`,
  `judge`, `analyst_signatures`, then optional `weights`. Nested object order is
  pinned in the same data file. `weights`, when present, is the last field and
  contains the four canonical buckets in lexical order with integer bps summing
  exactly to 10,000. Its omission records a non-actionable session without
  fabricating an allocation. The analyst entries carry the exact
  `canonicalizeSubmission` string, raw Ed25519 public key, and signature, avoiding
  float reserialization before verification. New optional fields append after
  all existing fields and are omitted when absent; unknown fields are never
  serialized. The `judge` block is the shipped `JudgeOpinion`
  (`backend/src/swarm/judge.ts`) field for field —
  `{rationale, disagreements, release_safety}` — plus `source` from the
  `JudgeOutcome` envelope; `release_safety` carries the full shipped shape so a
  verifier recomputes thin support instead of trusting a flag (§6.5). Under D2
  both repos hold the identical bytes at `tests/fixtures/` here and
  `contract/src/__fixtures__/` in `robotmoney-frontend`, each side carrying its
  own byte-conformance test; the frontend half has landed
  (`robotmoney-frontend#775`). A non-ASCII conformance receipt
  (`consensus-receipt.escaping.*`) is part of that shared set because the two
  most likely non-JS implementations — Go's `encoding/json` and Python's
  `json.dumps` — each diverge from the escaping rule **by default while still
  reproducing an all-ASCII golden exactly**, so an ASCII-only corpus cannot
  detect either.
  `@robotmoney/contract` remains explicitly unsuitable across the
  Rust/Solidity boundary (§6.1).
- **Gateway surface:** additive only — `setICPolicy`/`committeeRegister`/`committeeVoteSubmit`
  at `contracts/gateway/interfaces/IGateway.sol:380,386,392` stay; the new
  receipt entrypoints are added alongside `agentOwner` (`IGateway.sol:422`), not
  substituted (D6). The exact new set is two calls:
  `consensusRecordReceipt(bytes32 receiptId, bytes32 payloadDigest, string payloadUri)`
  records the authenticated submitter and an unreleased commitment, and
  `consensusReleaseReceipt(bytes32 receiptId)` is the admin-only human gate.
  `receiptId` is `keccak256` of UTF-8
  `robotmoney:consensus-receipt-id:v1\n{session_id}\n{subject_id}`; refusing an
  existing ID enforces one receipt per session per subject.
  There is no per-analyst on-chain signature call and no other state transition.
  `payloadUri` must be the stable backend route
  `/api/swarm/receipts/{session_id}` on the configured frontend origin.
- **Indexer / API / rmpc / worker:** each specified with its shipped analogue
  as template — `services/explorer-indexer/src/indexer.rs:74,1125` + reorg handling
  `docs/architecture.md:928`, `docs/architecture.md:5.4` read scopes,
  `docs/architecture.md:5.1,690-710` `rmpc committee …` commands, and an off-chain
  worker that watches `ReceiptReleased` and (if policy says so) drafts a
  `RouterGovernance.propose(vaults,bps)` — the on-chain execution still needs
  quorum and delay (`RouterGovernance.sol:54-63,365-422`).
- **No contract expiry.** The earlier `deadline = firstSignatureAt +
  WINDOW_SECONDS` (7 days, stored immutably on first signature, expiry derived
  off-chain as `block.timestamp > deadline && !released`, no keeper) existed to
  bound a **multi-party signature-collection window**. With one submitter there
  is nothing to wait for, so it is deleted rather than repurposed. An unreleased
  receipt remains an immutable public record. The dapp labels it unreleased and
  stale from payload `created_at`; the worker never drafts from it. No timeout
  deletes it or changes its on-chain state.
- **Event correctness:** no event may use a `uint8[64] indexed` signature
  parameter (exceeds the 3-topic limit; cf. the `VoteSubmitted` pattern at
  `IInvestmentCommitteePolicy.sol:68-78`). This applies to whatever the
  entrypoint set above resolves to.
- **Release policy (D5).** There is no automatic signature threshold. Release is
  admin discretion after human review of the judge's safety opinion and the
  verified embedded signatures. The dapp always renders the payload signature
  count as `submitted / active` and labels those as off-chain analyst signatures,
  never on-chain approvals. Release remains signalling-only and no worker submits
  a governance proposal unattended (§3.4, §6.2).

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
be able to move funds), and fixes the anchoring model (§5). ADR-0012 is
**Accepted**; its commitment-on-chain, verification-off-chain rule is the
identity basis for receipts under §2.1.

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

### 3.3 Extend for v0.1 (Consensus recommendation receipts — implemented locally)

- **Contract.** New `ConsensusRecommendationReceipt.sol` — `onlyGateway`, signalling-only
  (no `receive`/`fallback`, no vault/router calls — same constraint as
  `InvestmentCommitteePolicy.sol:272-278` / `docs/architecture.md:148,1192-1198`),
  `ADMIN_ROLE` held by `TimelockController` (INV-3 `docs/prd.md:642-648`), event
  `ReceiptRecorded` plus `ReceiptReleased`, neither carrying an indexed signature
  parameter. Additive gateway surface alongside `IGateway.sol:380,386,392,422`:
  one record call and one admin release call with the signatures kept off-chain in
  the payload (§2.1). The rejected multi-party signature collection and 7-day
  deadline do not exist.
- **Judge.** New — see §2.1. Lives in `robotmoney-frontend`'s job queue and
  session state machine, emits prose and a release-safety opinion, and never
  emits weights. **Note it is not on the critical path:** because D4 puts the
  number on `meanTakeWeights` (shipped) and the frontend already generates
  narrative via `buildRationale` / `buildSynthesis`, a valid receipt can be
  produced before the judge exists. Build it in parallel and treat it as a
  quality upgrade, not a blocker.
- **Deployment sequencing.** Contracts here are immutable — `InvestmentCommitteePolicy`
  has no proxy or initializer — so receipts genuinely need a new contract rather
  than an extension. And since IC v0 is **confirmed undeployed** (status header),
  the two share **one** deploy script, one timelock role-wiring ceremony, and one
  audit pass. Plan them together, not sequentially. Nothing is live, so there is
  no migration, no registered agent to preserve, and no deployed interface to
  stay compatible with.
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
  `real_world_assets` → rmRWA (`:568`). The canonical data is
  `tests/fixtures/consensus-receipt.bucket-vault-map.json`, to be mirrored
  byte-for-byte in `robotmoney-frontend`. It maps symbols rather than inventing global
  addresses: every receipt-capable deployment manifest must provide all four
  `vault_addresses` entries, and a missing entry makes that deployment
  non-receipt-capable rather than falling back to a zero or cross-chain address.
- **Unit conversion.** Frontend weights are `[0,1]` floats; this repo is bps
  (`tests/fixtures/committee-vote.schema.json:22-33`), and
  `RouterGovernance.propose` hard-rejects a vector that does not sum to
  `BPS_DENOMINATOR` (`RouterGovernance.sol:377`). The converter needs a stated
  apportionment rule that closes on the denominator for *every* share vector —
  §7.1 settles it as largest remainder in binary64, with the exact-tie break
  pinned to canonical bucket order — plus a property test at the boundary.

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
| 1 | Exact split of fields on-chain vs off-chain memo | **Shipped for votes; pinned for receipts.** Votes retain their existing commitment tuple and public memo. A receipt's chain record stores derived `receipt_id`, `payload_digest`, `payload_uri`, authenticated submitter, and released state only. The schema-pinned off-chain payload carries session/subject identity, quorum and stance counts, judge prose, exact analyst Ed25519 signature material, `prompt_hash` / `inputs_digest`, and an optional four-bucket bps vector (§2.1, §6.1). | Contract + schema |
| 2 | Shape of the IC-policy → `RouterGovernance` linkage and governance-interface refactor | **Off-chain, admin-applied; no refactor.** IC output (votes and v0.1 receipts) is signalling-only (`docs/prd.md:650-657` INV-4, `docs/architecture.md:126-130,148`). Translation to live weights is `RouterGovernance.propose` → `vote` → `execute` (`RouterGovernance.sol:365-500`), gated by quorum/delay (`:54-63`). The architecture already states "RouterGovernance is unchanged and no governance-interface refactor is required" (`docs/architecture.md:604`). | Architecture |
| 3 | Genesis seats (Athena / Robot Money / Woon) | **3–5 internal seats in v0/v0.1, no external seats.** Athena / Robot Money / Woon are the named genesis agents under the admin-gated, timelock-held model (`InvestmentCommitteePolicy.sol:164-168`). Their EOAs are provisioned by RM ops, attested via `agentId` string (`:128,166`) and the public `AgentRegistered` log, and (if needed) seeded via `rmpc committee register`. External organization onboarding is deferred to a follow-on proposal (§6.3). | Ops + product |

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
- **An incomplete record (new, from §2.1's public-record framing).** When the
  product *is* the public record, a receipt that silently fails to publish leaves
  a gap exactly where an observer would look for suppression — and it is
  indistinguishable from a session that legitimately produced nothing. Mitigated
  by alerting on any session that should have produced a receipt and did not, by
  never dropping a failed submission quietly, and by rendering session-level
  participation (`quorum`, `absent`) so a thin session is visibly thin rather than
  silently missing.
- **A record that flatters or indicts by presentation (new, from §2.1).** Most
  recommendations will not be applied. Rendering them without that context implies
  an influence the committee does not have; rendering it badly implies the
  committee is ignored. Mitigated by making applied vs. not-applied an explicit,
  per-recommendation state in the dapp rather than something a reader infers.
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

## 6. Closed receipt decisions and deferred expansion

> Issue #1244 closes every design question needed by the format-gap and on-chain
> anchor work, including the `judge` block's reconciliation with the shipped
> `JudgeOpinion` (§6.5, settled). One item stays outside that set: the
> external-organization expansion is deferred (§6.3). It changes none of the
> receipt's identity, digest, derivation, signature set, or entrypoints.

- **6.1 Receipt JSON schema and transport — implemented and pinned (D2).** The canonical core
  fixtures are `tests/fixtures/consensus-receipt.*`, validated on every PR by
  `.github/scripts/check_consensus_receipt_schema.py`; identical copies belong at
  `robotmoney-frontend/contract/src/__fixtures__/` so both repos independently
  reproduce the golden canonical bytes. **That mirror has landed**
  (`robotmoney-frontend#775`), and the two sides are not merely equivalent but
  **byte-identical**: every `tests/fixtures/consensus-receipt.*` file here except
  the two core-only sidecars is the same bytes as the file of that name under
  `contract/src/__fixtures__/` there, and that set is asserted in CI both by
  name and, since issue #1246, by a committed `sha256` per file. Byte identity is
  what discharges D2 — "the same fixture in both repos" is not satisfiable by two
  files that merely agree in spirit. The two deliberate core-only additions are
  `consensus-receipt.anchor-digest.json`, which commits the `keccak256` of each
  golden and the `sha256` of each shared file and is checked by re-hashing rather
  than by transcription (`contract/` has zero dependencies and cannot reach a
  keccak256 implementation at all — `robotmoney-core#1280`), and
  `consensus-receipt.legacy-weights.json`, which records the two shape decisions
  of §7.2–§7.3 and pins the archived corpus they are about. The schema includes `schema_version`,
  bps-converted mean weights, judge-authored prose, exact analyst Ed25519
  signature material, and `prompt_hash` / `inputs_digest`; fixed order, domain,
  digest algorithm, nested order, bps conversion, and append-only evolution are
  data in `consensus-receipt.canonicalization.json`. The stable read path is
  `GET /api/swarm/receipts/{session_id}`. `@robotmoney/contract` is not the
  cross-repo home: it is frontend's unpublished file-linked package and cannot
  be consumed by Rust/Solidity. A receipt-capable deployment resolves the four
  vault symbols through its own complete `vault_addresses` table, as required by
  `consensus-receipt.bucket-vault-map.json`; no address is global.

- **6.2 Release quorum and governance handoff — implemented and pinned (D5/D6).** Release is
  admin discretion with no automatic signature threshold. The dapp renders the
  payload signature count as off-chain evidence. `meanTakeWeights` supplies the
  normalized unweighted mean; conversion uses the schema-pinned binary64
  largest-remainder allocation in canonical bucket order, which closes exactly
  at 10,000 bps. A released receipt records a signal only. Any worker may
  prepare a draft for human review after re-checking
  `isRouterEligibleAndActive`, but it never submits unattended. The existing
  per-vault registration and vote-submission path is kept unchanged alongside
  receipts; no receipt call replaces or deprecates it.

- **6.3 External-organization attestation — explicitly re-deferred past v0.1.**
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
  additive rather than a reshape. There are zero external seats in v0/v0.1;
  external onboarding requires a follow-on proposal and is not a receipt-build
  blocker: v0.1 has no external seats, no selected attestation authority, and
  no product decision for revocation/disclosure.

- **6.4 Judge scope across subjects — implemented and pinned.** `meanTakeWeights`
  averages within **one session's** take set, and `robotmoney-frontend` sessions
  are subject-scoped. Schema v1 therefore permits exactly one receipt per session
  and its one bound `subject_id`; there is no cross-session or cross-subject
  aggregation in v0.1. A future portfolio-wide artifact needs a new schema
  version rather than silently changing this derivation.

- **6.5 `judge` block vs the shipped `JudgeOpinion` — SETTLED.** The `judge`
  block was first drafted before `robotmoney-frontend` PR #757 shipped the
  consensus judge, and required a field no producer emits. Both halves are now
  decided, and schema 1.0 carries the shipped `JudgeOpinion`
  (`backend/src/swarm/judge.ts`) **field for field** —
  `{rationale, disagreements, release_safety}` — plus `source` from the
  `JudgeOutcome` envelope. The receipt and the judge opinion are deliberately
  not allowed to drift apart: keeping them identical is what makes "the receipt
  says what the judge said" checkable rather than asserted.

  - **`judge.consensus` — DROPPED.** It was an invention of the draft. No judge
    produces it: `JudgeOpinion` has no such field, and the only thing in the
    frontend that builds anything by that name, `buildConsensus()` in
    `backend/src/swarm/domain.ts`, restates quorum, stances, mean confidence and
    the regime summary in English. The first two of those are already carried
    **structurally and signed** in this payload's own `quorum` and `stances`
    blocks, so the field would have committed a prose paraphrase of numbers the
    receipt already commits exactly. Specifying a derivation for it would have
    meant inventing a producer to match a schema, which is backwards.

  - **`judge.release_safety` — the SHIPPED SHAPE, carried whole.**
    `{release: "safe"|"hold", thinly_supported, take_count, min_takes,
    concerns[]}` replaces the draft's `{safe_to_release, opinion}` reduction.
    The deciding argument is verifier-side and it is about trust, not tidiness:
    with `take_count` and `min_takes` present, a verifier **recomputes**
    `thinly_supported` (it must equal `take_count < min_takes`) and **recomputes**
    `release` (`"hold"` iff thinly supported or any concern is present) rather
    than believing two flags. That matters here more than it would elsewhere,
    because `release` is **member-steerable**: `releaseSafety()` merges concerns
    the model drew from member-authored take bodies, so one analyst's text can
    move the verdict (`robotmoney-frontend#767`). A reduction to a boolean would
    have anchored a steerable flag with nothing beside it to check it against.
    `judge.ts` also records that a later-phase signer reads this field — so the
    receipt has to carry what that signer read, in the shape it read it. Both
    recomputations are asserted in CI by
    `.github/scripts/check_consensus_receipt_schema.py`.

  - **`judge.source` — ADDED and required**, decided here rather than deferred.
    `runJudge()` spreads one `base` object — same `promptHash`, same
    `inputsDigest` — into both the model return and the template-fallback
    return, and `templateOpinion()` calls the same `buildRationale()` /
    `buildDisagreements()` the aggregator uses. Without `source` a published
    receipt carries **no field at all** separating "a model read the takes and
    wrote this" from "the model timed out and a template produced this".
    `"fallback"` is not a defect — it is the fail-closed path, and a fallback
    receipt is a complete, anchorable receipt — but an artifact whose point is
    attribution must say which one it is. `fallbackReason` and `model` are
    deliberately excluded: the first interpolates model-controlled text and is
    operator debugging rather than a public commitment, the second is deployment
    configuration that would make the anchored bytes depend on a vendor string.
    Both remain appendable after `source` under the minor-bump rule.

  - **`judge.disagreements` needed no change.** `JudgeDisagreement` is
    `{topic, positions[{member_id, view}], what_settles}`, which the draft
    already matched. `positions` is relaxed to `minItems: 1` to match what
    `parseJudgeResponse()` really produces.

  **This was resolved inside 1.0, not by a version bump.** No receipt has ever
  been published under the draft — the schema had not left this repository and
  no producer could satisfy it — so there are no bytes in the world to preserve.
  The append-only rule protects *published* receipts, and reshaping a block that
  no conforming receipt could ever have carried breaks nothing it exists to
  protect. **The golden canonical bytes did change**, and with them the
  anchored `keccak256`; both are now committed and asserted (§6.1). Reshaping
  the `judge` block after this point **is** a `schema_version` bump.

---

## 7. The cross-repo format contract (issue #1246)

§6 pins *what* a receipt is. This section pins *how the two repos stay able to
produce the same bytes for it* — the float→bps conversion that bridges the two
unit systems, the two serialized-shape questions that had drifted before anyone
wrote a decision down, and the process a schema revision has to follow to land
across two repositories without a window in which one side cannot read the
other.

### 7.1 Float `[0,1]` → bps — pinned, implemented, and one measured defect

`robotmoney-frontend` expresses an allocation as `[0,1]` floats over four named
buckets. This repo expresses it as `target_weight_bps` over four vault
addresses, and `RouterGovernance.propose` **hard-rejects** any vector that does
not sum to `BPS_DENOMINATOR` exactly (`RouterGovernance.sol:377`). Nothing
converted between them before this issue.

**The rule is data, not code.** `bps_conversion` in
`tests/fixtures/consensus-receipt.canonicalization.json` states it,
`canonical_bucket_order` in the same file supplies the iteration order, and the
schema supplies `BPS_DENOMINATOR` (`definitions.bucket_weight.properties.weight_bps.maximum`).
`mean_weights_to_bps()` in `.github/scripts/check_consensus_receipt_schema.py`
**reads all three** rather than restating any of them, for the same reason the
canonicalizer is spec-driven: the other repo implements from those files, so this
side has to be a reader of them and not a second authority that can drift. A
converter that hard-coded the four bucket names would agree with the golden no
matter what the published spec said; the property test scrambles the spec's order
and asserts the output follows it.

The rule is **largest remainder (Hare quota)**, in **IEEE-754 binary64**. Floor
every bucket's `share × BPS_DENOMINATOR`; hand the leftover —
`BPS_DENOMINATOR` minus the sum of those floors — out one basis point at a time
to the largest fractional remainders, largest first, at most one bp per bucket.
It closes on `BPS_DENOMINATOR` **by construction**, for every share vector,
whatever the last bucket holds. The only refusals left are of inputs that were
never share vectors: a canonical bucket missing, a share outside `0..1`, or a
total more than `1e-6` from 1.

Two clauses of the rule are load-bearing and easy to get wrong:

- **The exact-tie break is canonical bucket order.** Two buckets holding the
  identical share hold bitwise-identical binary64 remainders (a three-way mean
  of thirds does it), and which one takes the leftover bp changes the canonical
  bytes and so the anchored `keccak256`. The comparison is the total order
  *(remainder descending, `canonical_bucket_order` index ascending)*, stated
  rather than inherited from a language's sort stability — the two repos hand
  their sorts independently-constructed arrays, so stability guarantees nothing
  about agreement between them.
- **The arithmetic domain is binary64, and decimal recomputation is forbidden
  by name.** `bps_conversion.divergent_example` ships a share vector where two
  remainders are *exactly equal in decimal* and *one ULP apart in binary64*: the
  tie-break fires in one domain and not the other, the bp lands in a different
  bucket, and the receipt fails to verify. The schema-1.0 implementation here
  used `Decimal(str(x))`; #1290 replaced it with bare `float`, and the spec's
  self-test vector is converted in CI as proof.

**What the rule replaced, and why.** Schema 1.0 shipped *settle-the-last-entry*:
round the first three canonical buckets to nearest and set `real_world_assets`
to `BPS_DENOMINATOR − prefix_sum`, refusing a result outside
`0..BPS_DENOMINATOR`. When `real_world_assets` is **exactly zero** the three
prefix buckets carry the whole distribution, their true bps sum is exactly
`BPS_DENOMINATOR`, and their three independent roundings sum to `+1` bps about
**one time in eight** — settling the last entry to `−1` and refusing the vector,
so no receipt could be assembled for that session. `real_world_assets` is
exactly 0 in **four of the six** archived allocations (§7.3), so the refusal sat
on the shape the committee actually produces.

| last bucket | settle-the-last | largest remainder |
|---|---|---|
| `real_world_assets == 0` | **12.5 %** refused | **0 %** refused |
| `real_world_assets > 0` | 0 % refused | 0 % refused |

The refusal had a second sign that no range check caught: when the three prefix
roundings *undershot*, settle-the-last silently handed **1 bp of a vault the
session had allocated nothing to** — a wrong receipt rather than no receipt
(12.44 % on the same corpus, measured by `robotmoney-frontend`). Largest
remainder cannot do it: a zero share has remainder 0 and is last in the
apportionment order.

**The six archived allocations do not move.** Their means are whole bps, so
there is nothing to redistribute, and
`test_the_six_archived_vectors_do_not_move_under_the_new_rule` recomputes the
superseded rule inside the test and asserts both rules produce identical arrays
for all six. The rule change moves no already-settled data, and the receipt
bytes and anchored `keccak256` are untouched — `bps_conversion` is a derivation
rule, not a serialization rule.

**How the change landed, given the fixture is a cross-repo pin.**
`bps_conversion` is data in one of the nine byte-identical shared fixtures, so
this side did **not** author the replacement text. `robotmoney-frontend`
published the rewritten `consensus-receipt.canonicalization.json` first
(frontend PR #801), and this repo **adopted those exact bytes**, restoring the
byte identity the frontend's publish had temporarily broken. The two
implementations were then checked against each other at the meeting point: the
four exact-tie conformance vectors `robotmoney-frontend` published from its own
CI are converted by this repo's Python in
`test_the_published_cross_repo_tie_break_vectors_reproduce_exactly` and produce
the identical arrays. Tracked as **`robotmoney-core#1290`** and
`robotmoney-frontend#798`. No receipt had been anchored when this landed, so it
was resolvable inside `1.0` rather than by a version bump.

### 7.2 `within_bucket_weights` — DROPPED from schema 1.0

Recorded, with its reasoning and its reversal path, in
`tests/fixtures/consensus-receipt.legacy-weights.json`, and **bound to behaviour**:
the CI guard asserts schema 1.0 actually refuses a receipt carrying the field, so
the written decision cannot quietly become false.

- **No consumer can act on it.** `weights` exists to become a
  `RouterGovernance.propose` vector over the four vault addresses in
  `consensus-receipt.bucket-vault-map.json`. Nothing on-chain consumes a bucket's
  internal composition — the vault's own adapter set decides that. Anchoring a
  number no contract enforces commits the committee, in a signed artifact, to a
  figure nothing checks.
- **No producer writes it.** It appears in exactly six archived allocation
  payloads and nowhere else; its sole reader is `withinBucketWeightsFrom()` in
  `frontend/public/assets/js/app/alpine/static-views.js`, a display transform.
  Putting a display-only field under signature is the same mistake §6.5 avoided
  by dropping `judge.consensus`.
- **It is not destroyed.** The archived payloads keep it and the archive page
  keeps rendering it. What is dropped is its presence in the anchored commitment.
- **Reversible by a minor bump.** Under `evolution_rule` an optional field
  appended after `weights` is omitted when absent, so adding it later cannot move
  a byte of any receipt published under 1.0 or invalidate a signature. The bar
  is a producer that writes it and a consumer that acts on it.

### 7.3 Archived `weights`: map vs array — reconciled behind `schema_version`

**The array is the pinned shape.** A JSON object's key order is not part of its
value, so a map cannot pin bytes — two serializers holding the same map may emit
different bytes and therefore different digests. An array plus
`canonical_bucket_order` is the only shape under which "the same weights" and
"the same bytes" are the same statement. The archived payloads make this
concrete: all six spell their keys `conservative_defi_yield, agent_tokens,
protocol_tokens, real_world_assets`, which is **not** `canonical_bucket_order`.
The current producer (`meanTakeWeights()`, `backend/src/swarm/domain.ts`) already
emits an array and already settles its last entry to the exact remainder — the
same shape §7.1 pins, one unit system up. The map is the archived form only.

**The archived payloads are not retro-fitted.** They carry no `schema_version` at
all: they are pre-schema session archives, not receipts. Schema 1.0 types
`weights` as an array, so one can never be mistaken for the other. They are
converted on assembly — read the map by `canonical_bucket_order`, normalize to
sum 1, apply `bps_conversion` — and all six conversions are **recomputed in CI**
from the archived floats rather than transcribed, then round-tripped: the
recovered bucket set must equal the archived one and every weight must return
within 1 bps. Nothing at bucket level is lost. What is not carried is
`within_bucket_weights`, dropped deliberately per §7.2 rather than lost to the
shape change.

### 7.4 How a schema revision lands across two repos — and which side deploys first

**The two repos hold opposite ends of the artifact.** `robotmoney-frontend`
**produces and signs**; `robotmoney-core` **verifies and anchors**.

> **The verifier deploys first. The producer deploys second. This holds even for
> an append-only minor bump.**

The append-only rule protects **published signatures**, not **old verifiers**.
The schema root is `additionalProperties: false`, so a verifier holding only 1.0
*refuses* a receipt that carries a field appended in 1.1. Readers-first is
therefore mandatory, not merely tidy.

Readers-first is *safe* because a bump **adds** a schema document rather than
replacing one: `version_policy.retroactivity` publishes a new `$id`, keeps the
old document, and has a verifier select by the receipt's own `schema_version`.
A verifier holding both accepts 1.0 and 1.1 simultaneously, so the skew window
between the two deploys is harmless — **in that direction only**. Producer-first
inverts it: the frontend emits 1.1 bytes the anchoring side cannot validate or
reproduce, and a digest gets anchored over a payload nothing here can check.

**The landing procedure.**

1. **It is a schema event, never a drive-by edit.** Any change to one of the nine
   shared fixtures opens one issue in each repo, cross-linked. Within a version
   those nine files are frozen.
2. **Author both PRs together.** The nine shared files change **identically** in
   both. The frontend PR carries `contract/src/consensus-receipt.js`; the core PR
   carries `.github/scripts/check_consensus_receipt_schema.py`, the regenerated
   goldens, and the regenerated `keccak256` / `sha256` constants and
   `shared_fixture_manifest` in `consensus-receipt.anchor-digest.json`.
3. **Neither merges until both are green** and the manifest comparison passes —
   `shared_fixture_manifest.how_to_compare_from_robotmoney_frontend` is a
   one-command `sha256` diff runnable from either side.
4. **Merge order: core, then frontend.** **Deploy order: core, then frontend.**
5. **The old schema document is never deleted.** Retirement would strand every
   receipt already anchored under it.

**The conformance vector runs in both CIs, over the same bytes.** Here:
`.github/scripts/check_consensus_receipt_schema.py` (and `--self-test`) plus
`.github/scripts/tests/test_consensus_receipt_bps.py`, in suite-13
`schema-validators`. There: `contract/tests/unit/consensus-receipt-fixture.test.ts`.
Both reproduce `consensus-receipt.valid.canonical.txt` and
`consensus-receipt.escaping.canonical.txt` byte for byte; core additionally pins
the `keccak256` an anchor commits to.

**What neither CI can do alone is reach the other repo**, which is exactly the
hole `shared_fixture_manifest` fills. It pins each shared file's `sha256` —
`sha256` and not `keccak256` precisely because `contract/` has zero dependencies
and cannot reach keccak256, while `sha256` is already in its runtime. The
manifest is therefore comparable from **either** side with one command and no new
dependency, and it is derived by re-hashing on every run: changing a shared
fixture without changing its `sha256` fails, and so does the reverse.

**The one residual, stated rather than glossed.** The manifest comparison is a
**process control (step 3 above), not a CI check**, and it cannot become one on
either side alone: neither repo's CI fetches the other. So the chain "frontend
bytes reproduce the frontend golden" → "the two goldens are the same bytes" →
"that golden hashes to the anchored digest" has its middle link enforced by the
landing procedure rather than by a runner. The cheapest way to shorten it is for
`robotmoney-frontend` to assert the `sha256` of its own two goldens against the
constants in `shared_fixture_manifest` — reachable from `contract/`'s zero
dependencies, which is why the manifest is pinned in `sha256` at all. Until that
lands, step 3 is what stands between a drifted fixture and a divergent anchor.
