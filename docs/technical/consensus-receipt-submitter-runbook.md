# Consensus receipt submitter — custody, operations, and compromise runbook

Canonical: `docs/architecture.md` §4.8 and §4.9 — Consensus Recommendation Receipt Contract
Canonical: `docs/product/20260623-product-proposal-investment-committee-v0.md` §2.1
Implements: issue #1247 tasks 4.11, 4.12, 4.13 and acceptance criteria 7, 8

The Investment Committee's only on-chain output is the consensus receipt. Consensus receipts are caller bound; they are released only by `RouterGovernance.applyReceipt` through the timelock. The receipt is the only rebalancing signal the Safe may cite. The vector the Safe schedules through `applyReceipt` is the input; the chain cannot parse the payload, so readers compare the applied vector to the payload. Receipts are submitted on-chain only by the submitter Safe through the publish-contracts `record-receipt` row (a Safe transaction), on every chain including Base production. `rmpc receipt submit` is not a path (owner decisions 2026-10-20).

**System boundary (owner decisions 2026-10-19).** The receipt contract
belongs to the vaults system. The rmpc gateway system (`RobotMoneyGateway`
and `rmpc`) is a separate system and a client of the vaults system. The
vaults system never depends on it. There is no `InvestmentCommitteePolicy`
and no on-chain committee membership. The submitter holds
`RECEIPT_SUBMITTER_ROLE` on `ConsensusRecommendationReceipt` and writes to it
directly. Rebalancing works with no gateway
deployed. The deployed release (v0.5.0) still records through the gateway.
Operators run the deployed-release procedure in §1 on it. The system split
review records where the code differs (`docs/code-review/20261019-code-review-internal-claude-opus-5-5-system-split.md`).

---

## 0. Status — read this first

**Current status.** The submitter is a Safe (§1.1). On a Base mainnet
deployment of the rehearsal kind (8453, `DEPLOYMENT_KIND=rehearsal`) the
Safe records receipts through the publish-contracts `record-receipt` verb;
two Deploy 2 receipts were recorded that way. On the production kind today's
tooling refuses the verb (`publish-contracts/src/cli.ts` line 617,
`src/record-receipt.ts` line 166). The target allows it on every chain,
Base production included (owner decision 2026-10-20; RS-1019 finding 5
lifts the refusal). No single key records a receipt anywhere. `ADMIN_ROLE`
on the receipt contract is held by the timelock after the handover stage;
the timelock alone grants and revokes `RECEIPT_SUBMITTER_ROLE`.
`RouterGovernance` holds only a narrow release role on the receipt
contract in the target (today it holds `ADMIN_ROLE`, RS-1019 finding 14).

Still open, each a separate decision: an audit pass before a production
submission, and the §2 custody items for the Safe owners' keys.

---

## 1. What the key is and what it can do

The **submitter** is an account (an EOA in the original v0.1 design, a multisig Safe from issue 1750, see §1.1).

**Target.** The submitter holds `RECEIPT_SUBMITTER_ROLE` on
`ConsensusRecommendationReceipt`. `ADMIN_ROLE` on the receipt contract, held by
the timelock, grants it: the governing Safe schedules one timelock call,
`grantRole(RECEIPT_SUBMITTER_ROLE, submitter)` (govern row
`register-submitter`). The submitter calls
`recordReceipt(receiptId, payloadDigest, payloadUri)` directly. The contract
reverts `SubmitterNotAllowlisted()` for any other caller and stores the caller
as the submitter. No gateway role and no gateway call is part of the path.

### Deployed release: the submitter records through the gateway

Operators run this procedure on release v0.5.0 (core 57fbe618). There the
receipt contract accepts `recordReceipt` only from the gateway
(`onlyGateway`, set once at initialization). The submitter therefore holds:

- `AGENT_ROLE` on `RobotMoneyGateway`, and
- `COMMITTEE_AGENT_ROLE` on `InvestmentCommitteePolicy`.

Those two together are the entire authority needed to call
`RobotMoneyGateway.consensusRecordReceipt`, which forwards to
`recordReceipt`. Registration also routes through the gateway
(`committeeRegister`). Committee votes route through
`committeeVoteSubmit`, which reverts `CommitteeAgentNotCaller` unless the
vote's `agent` is `msg.sender` (core issue 1790, PR 1818). Every step in
§1.1, §3 and §4 that names the gateway belongs to this deployed-release
procedure.

**What it can do.** Anchor a `receiptId` → `payloadDigest` commitment. Because
`receiptId` is unique per session per subject, a submitter that anchors a
*wrong* digest first **permanently blocks the correct one for that session** —
the contract refuses a duplicate id. This is the sharpest consequence of a
compromise and it is not recoverable on chain: the remedy is a new session id
plus a public correction, never a rewrite.

**What it cannot do.** Move value, set router weights, release a receipt, or
touch any vault. Recording makes no router call (INV-4); only the Safe, through
the `TimelockController` and the weight setter, releases a receipt and applies
its weights, and `ADMIN_ROLE` on the receipt contract is held by the
`TimelockController` (INV-3), not by the submitter. A compromised submitter cannot cause a rebalance; it can pollute the
public record, which for a record whose purpose is trust is damage enough.

**What a submitter attestation does *not* prove.** That each named analyst
signed. The chain proves the committee produced the recommendation and that one
submitter attested to it; the analysts' ed25519 signatures are payload data
verified off-chain (ADR-0012 §5). This is exactly why the off-chain
verification below is load-bearing rather than cosmetic.

### 1.1 The submitter is a multisig (issue 1750, owner decision 2026-10-10)

The multisig decision holds with or without the gateway. The register and
record steps below are the **deployed-release** procedure: they route
through the gateway (see "Deployed release" above).

Owner decision 2026-10-10: **no single key anchors a receipt.** For the Base mainnet rehearsal and every later run on the `publish-contracts` surface the submitter is not an
EOA. It is a **Safe** (a SafeL2 1.4.1 proxy with threshold 2 or more; it may be the governing Safe, owner decision 2026-10-20) that holds the submitter role and nothing else on the vaults-system contracts. A governing Safe that doubles as submitter also holds the timelock proposer and canceller roles. The submitter Safe and the governing Safe may share owners; separate multisigs are not required. Everything in §1 about what the
submitter can and cannot do holds unchanged for a contract account: the contracts check only the roles, never `msg.sender`, `tx.origin`, `isContract` or a signature
(`contracts/test/ConsensusReceiptSafeSubmitter.t.sol` proves it with a real Safe, including the 1-raw-unit deposit cap and the disabled withdrawals).

- **What the tooling pins** (`publish-contracts/src/submitter-safe.ts`): the canonical SafeProxy 1.4.1 code hash, the SafeL2 singleton in slot 0, `VERSION` 1.4.1, threshold 2 or more,
  no module, no guard, the canonical fallback handler. It may be the governing Safe (owner decision 2026-10-20; v0.5.0 tooling refuses it, `forbiddenSubmitters`). It is never the timelock, admin (= the deployer), the pauser or the emergency address.
- **Register it (target):** `govern --row register-submitter --submitter 0x<Safe>` schedules one timelock call, `ConsensusRecommendationReceipt.grantRole(RECEIPT_SUBMITTER_ROLE, safe)`. The checks run before the timelock round is scheduled. Nothing runs on the gateway, so there is no private half and no public window to front-run.
- **Register it (deployed release):** `govern --row register-committee --submitter 0x<Safe>`. The checks run before the timelock round is scheduled.
- **Deployed release (v0.5.0): registration has no public window (QA plan v1 B6, security review CS-2).** The `register-committee` row works in two halves. None of this exists in the target: there is no commit, reveal, `transferAgentOwnership`, `committeeRegister` or `authorizeAgent` on the receipt path.
  - **Private half, first.** The submitter Safe authorizes itself on the gateway in three Safe transactions. Its owners sign with `--owner-signer` and `--signer` pays the gas.
    1. `commitAuthorization(keccak256(abi.encode(safe, safe, salt)))` with a random salt. The commit does not name the agent.
    2. `revealAuthorization(safe, salt, policy)` at least one block later. The Safe reveals for itself, so it needs no consent commitment (issue 1791 asks for one only when the agent is not the caller). The Safe now owns its own agent.
    3. `transferAgentOwnership(safe, timelock)`. The timelock now owns the agent.
  - **Public half, second.** Only then does the governing Safe schedule the timelock batch: `gateway.setPolicy` (the 1-unit signalling-only policy, shares to the timelock) and `gateway.committeeRegister`.
  - **Why the order matters.** The old batch scheduled `authorizeAgent(safe)` in public for the whole delay. A squatter could commit and reveal an authorization for the published address first. The batch then reverted `AgentAlreadyOwned`, and the squatter could `revokeAgent` at will, because the gateway has no seize path. Two layers now close it. The gateway refuses a stranger's reveal for another address unless that address first committed its consent from its own account (issue 1791, `OwnerConsentMissing`), and for a Safe that takes a transaction its owners sign. The new batch also carries no first-time authorization, so nothing a stranger does can break it (`contracts/test/ConsensusReceiptSafeSubmitter.t.sol::test_publicRegisterBatchCannotBeFrontRun`).
  - **If the address is already owned.** The tool refuses with `GOVERN` and schedules nothing. Create a new submitter Safe and run the row with it. Against a gateway with the issue 1791 consent check a stranger cannot own a Safe's address at all. Against an older gateway a stranger could claim a published address in advance, such as the old governance Safe below, or win the one-block race between the commit and the reveal. The tool catches both before any timelock round is spent.
  - **A row that stops part-way resumes from the chain.** The agent owner shows which steps are done. A stored commitment is revealed while its 256-block window lasts. After that the tool commits again with a new salt.
- **Record with it:** `record-receipt --submitter 0x<Safe> --signer <deployer> --owner-signer <owner> ...`. The verb proposes `ConsensusRecommendationReceipt.recordReceipt` through the Safe (`RobotMoneyGateway.consensusRecordReceipt` on the deployed release), `threshold` owners
  sign, the deployer executes and pays the gas. It refuses fewer owner signers than the threshold, a Safe that differs from `--submitter`, and a Safe transaction without
  `ExecutionSuccess`. It reads the receipt back and requires the stored submitter to be the Safe.
- **Plainly: the same three owner keys control BOTH Safes** (the governing Safe and the submitter Safe). Proposing and approving are separated by the multisig (two of three
  signatures) and by each Safe's own nonce, not by different keys. A compromise of two owner keys is a compromise of both Safes. This is the owner's accepted trade-off for the
  rehearsal. The custody requirements of §2 (HSM or KMS, dedicated host, append-only signing log) describe a *single-key* submitter and are replaced, for the owners' keys, by
  the hardware wallets of the governing Safe's own runbook.
**Deployed release (v0.5.0): roles in the 900 s rehearsal (acceptance criterion 5).** The OLD governance Safe `0x5E68a40648DD23065b21b1C414e1178ddE6482ca` (the first rehearsal's governing Safe, 2 of 3, proxy code hash and singleton checked read-only on 8453) is the **PROPOSER**: it is the submitter Safe that records receipts (`record-receipt --submitter 0x5E68a40648DD23065b21b1C414e1178ddE6482ca`). The NEW governing Safe, created by this rehearsal with `SAFE_SALT_NONCE` 2026101002, is the **APPROVER**: it registers the proposer through the timelock and applies the receipt (`govern --row apply-receipt`). The old Safe holds no role on the new deployment until `register-committee` gives it AGENT_ROLE and COMMITTEE_AGENT_ROLE. **Caveat: the same three owner keys (A, B, C) control BOTH Safes**, so proposer and approver are separated by the multisig and by each Safe's own nonce, not by key. **Preflight:** the three owner EOAs A, B and C must differ from the 900 s sheet's ADMIN_ADDRESS, PAUSER_ADDRESS and EMERGENCY_ADDRESS (the sheet already enforces it for the new Safe; the submitter check enforces it for the old one) or registration is refused with an error naming which owner collided.
- **Rotation (§3)** is unchanged in shape: register a new submitter Safe, record one receipt through it, revoke the old one. The old Safe stays a valid record of what it attested.
- **The digest scheme (issue 1754).** `payloadDigest = keccak256("robotmoney:consensus-receipt:v1\n" || compact JSON || "\n")` and `receipt_id = keccak256("robotmoney:consensus-receipt-id:v1\n" || session_id || "\n" || subject_id)`. The domain line is part of the hashed bytes. The public canonical route (`/api/swarm/sessions/<session>/consensus-receipt/canonical`) serves the compact JSON plus the trailing newline WITHOUT the domain line, so a plain `keccak256` of the downloaded file is NOT the digest. Use the `payload_digest` and `receipt_id` that `rmpc receipt verify` prints. `record-receipt --payload FILE` (FILE as served by the route) recomputes both from the bytes before any signer is built and refuses a `--payload-digest` or `--receipt-id` that differs, naming both values. The real swarm receipt of session 5015526d-27f6-478a-86e9-ac768e310af1 (31941 bytes) has `payload_digest` `0x2aebf2b33c117d41813ef338ccf1d44b8006cc8a54eb162b17cbb8ac18adbacb` (a plain keccak256 would be `0x19d64ec6...7f86`) and `receipt_id` `0xdcf4108eb6186e913447fbf24353ee32b2e75cb6c7a46aabbb27f9a663c7ca81`. `govern --row apply-receipt --payload FILE` applies the same function, so the same file passes. The single TypeScript definition is `publish-contracts/src/receipt-digest.ts`.
- **Recovery after a landed transaction.** If `record-receipt` fails after the Safe transaction landed (a stale RPC read, a timeout), re-run the same command: it finds the receipt on chain with the Safe as submitter and takes the `already_recorded` path, and it fills the missing `tx_hash` and `safe_tx_hash` in the evidence from the Safe's `ExecutionSuccess` event when it can find it. If the event cannot be found the evidence entry keeps `already_recorded` without a transaction and the operator adds the transaction hash from the chain explorer by hand.
- **Evidence** carries `submitter_safe` (threshold, owners, proxy code hash, and for a record the Safe transaction hash, nonce and signers). `evidence-check` refuses a
  recorded receipt on 8453 without it.

Sections 2 to 5 below were written for a single-key submitter. Read "the key" as "the owner keys that sign for the submitter Safe" where a rehearsal is meant.

---

## 2. Custody requirements before any production submission

Each item is a hard gate. None is satisfied by v0.1.

| # | Requirement | Why |
|---|---|---|
| C-1 | Private key material lives in an **HSM or a cloud KMS** (non-exportable key, sign-only API). No plaintext key, no software keystore, no key in an env var or CI secret. | A software keystore's passphrase is recoverable from any host that ever ran the signer. |
| C-2 | Signing is reachable only from a **dedicated submitter host or workload identity**, with a deny-by-default network egress allowlist covering the RPC endpoint and the swarm API only. | Limits the blast radius to one machine and makes exfiltration visible. |
| C-3 | Every signature request is **logged with the calldata it signed** to an append-only store the submitter host cannot rewrite. | A compromise is only detectable if the tampered call is distinguishable from a legitimate one after the fact. |
| C-4 | The submitter holds **`RECEIPT_SUBMITTER_ROLE` and nothing else on the vaults-system contracts** (on the deployed release, the gateway `AGENT_ROLE` and `COMMITTEE_AGENT_ROLE` it needs to record instead, §1) — never `ADMIN_ROLE`, `DEPOSIT_PAUSER_ROLE`, or `DEFAULT_ADMIN_ROLE` on any contract. A governing Safe that doubles as submitter also holds the timelock proposer and canceller roles. Verified after every deploy and every role change. | The contracts already enforce role separation (`AccessRoles`); this makes the check explicit at the operational layer too. |
| C-5 | The submitter Safe holds **no ETH**. The deployer pays the gas of every `record-receipt` execution (`--signer`). Nothing tops the Safe up. | A Safe with no balance is nothing to steal, and a Safe transaction needs no balance to execute. |
| C-6 | A **named on-call owner** and a tested rotation drill exist before the first mainnet submission. | An untested rotation procedure is not a rotation procedure. |

### 2.1 Key generation

Generate inside the HSM/KMS. The key must never exist outside it — not on a
laptop, not in a paper backup, not in a password manager. If the key material
was ever material you could copy, it is a devnet key.

### 2.2 Devnet key (what exists today)

`rmpc` does not record receipts (owner decision 2026-10-19: `rmpc`'s one
on-chain write is an agent deposit into a vault). A receipt is recorded only
by the submitter Safe with publish-contracts `record-receipt` (§1.1).
`rmpc receipt verify` stays: it is offline and needs no key. What keeps a
single key out of the path is the role: an address without
`RECEIPT_SUBMITTER_ROLE` reverts.

---

## 3. Rotation

Rotation is **additive then subtractive**, and it needs no contract change
because submitter authority is role state.

1. Create the new submitter Safe with the Safe tool (§1.1; a new salt, the
   owners' keys per their own custody runbook) and note its address.
2. Register the new Safe with `govern --row register-submitter` (§1.1):
   one timelock call grants it `RECEIPT_SUBMITTER_ROLE`.
3. Record one receipt from the new Safe on a real session through the
   `record-receipt` row and confirm the indexer ingested it with
   `verified = true`.
4. Revoke the old Safe:
   `ConsensusRecommendationReceipt.revokeRole(RECEIPT_SUBMITTER_ROLE, old)` (an
   `ADMIN_ROLE` call from the timelock; the timelock alone grants and revokes
   this role, `RouterGovernance` cannot).
5. Confirm on chain that the old Safe holds no role.

> **Deployed release (v0.5.0) only.** On release v0.5.0 the steps above
> differ as follows. Step 2 uses `govern --row register-committee` instead,
> because registration routes through the gateway (§1). The new submitter
> first authorizes ITSELF in private, before anything is public:
> `gateway.commitAuthorization`, one block later `gateway.revealAuthorization`
> (its own agent, shares to itself), then
> `gateway.transferAgentOwnership(new, timelock)`. Only then, via the
> timelock's normal schedule → delay → execute path, one batch sets the
> signalling-only policy (`gateway.setPolicy`, shares to the timelock) and
> grants `COMMITTEE_AGENT_ROLE` (`gateway.committeeRegister`). Never schedule
> a public `gateway.authorizeAgent` for the new address: during the delay
> anyone can authorize that address first and own it for good (QA plan v1
> B6). Step 4 calls `InvestmentCommitteePolicy.revokeAgent` and
> `RobotMoneyGateway.revokeAgent` instead (§1). The timelock, as the
> agent's owner on v0.5.0, schedules the gateway `revokeAgent`. Step 5
> checks both roles.
> None of this exists in the target: there is no IC policy, no
> `transferAgentOwnership` and no `committeeRegister` (owner decisions
> 2026-10-19 and 2026-10-20).

**Both Safes are valid between steps 2 and 4.** That overlap is intentional — it
is what makes a rotation safe to abort. Never revoke before the new Safe has
successfully anchored.

**Cadence.** Rotate at least every 180 days, and immediately on any of: an
on-call owner leaving, a host rebuild, a suspected credential leak, or a
dependency compromise on the submitter host.

**What rotation does not do.** It does not invalidate anything already
anchored. Receipts recorded by a since-revoked submitter stay valid records of
what was attested at the time; the event log carries the submitter address, so
readers can scope trust by key epoch.

---

## 4. Compromise runbook

**Trigger:** any of — a receipt anchored for a session the committee did not
run; a `payloadDigest` that does not match the canonical bytes at its
`payloadUri`; a submission the audit log (C-3) cannot account for; credential
exfiltration suspected on the submitter host.

**Severity is high even though no funds can move.** The asset at risk is the
integrity of the public record.

1. **Contain (minutes).** Freeze the Safe's owner keys: no owner signs a
   Safe transaction until the incident is scoped. Where an owner key is
   itself suspect, the remaining owners remove it from the Safe
   (`removeOwner`, one Safe transaction, no delay). This needs no timelock
   transaction.
2. **Revoke (one timelock cycle).**
   `ConsensusRecommendationReceipt.revokeRole(RECEIPT_SUBMITTER_ROLE, submitter)`.
   The revocation lands only after `getMinDelay()` has passed on the
   timelock. Containment inside that window is off-chain: step 1, plus
   freezing the Safe's owner keys. Until it lands, containment rests on
   those alone. The stored submitter is the Safe address. Which owner keys
   signed the Safe transaction is off-chain evidence (the Safe transaction's
   signers in the evidence file), not chain state.

   > **Deployed release (v0.5.0) only.** Call
   > `InvestmentCommitteePolicy.revokeAgent` and
   > `RobotMoneyGateway.revokeAgent` instead (§1). The timelock, as the
   > agent's owner on v0.5.0, schedules the gateway `revokeAgent`.
3. **Freeze publication.** Stop the swarm worker from producing new receipts so
   a legitimate submission does not race the incident.
4. **Scope it.** From the indexer, list every `ReceiptRecorded` from the
   compromised address. For each, re-fetch `payloadUri`, recompute the
   canonical digest, and re-verify every embedded analyst signature. Classify
   each receipt as authentic or forged.

   **`verified = false` is not, on its own, evidence of forgery.** The flag
   records one thing: whether the indexer could fetch `payloadUri` and reproduce
   the on-chain `payloadDigest`. An unreachable or slow payload host produces the
   same `false` as a forgery does. Read the two companion columns before drawing
   any conclusion:

   | Column | Reading |
   | --- | --- |
   | `last_verify_error` | `GET … returned 5xx`, a timeout, a connection error, `payload fetch cut by the sweep's 30s per-tick budget`, `payload fetch cut by the tick's 30s inline fetch budget`, or `not fetched at index time: …` (the tick that indexed the receipt spent its fetch budget, and the sweep fetches it later) → a HOST problem, not a forgery signal. `refused …` → the URI names a scheme other than http/https or a link-local, unspecified, broadcast or multicast address (the cloud metadata endpoint among them), which the indexer never fetches: treat the URI itself as hostile. A `digest mismatch …` message is the one that matters here. |
   | `verify_attempts` | How many times the indexer has tried. A row at the ceiling with a transport error has simply been unreachable throughout. |
   | `verified_at` | When verification last SUCCEEDED. `NULL` means it never has. |

   The indexer re-verifies unverified rows on every tick and repairs them in
   place (never downgrading a verified row), so a transient failure converges on
   its own — a row that stays `verified = false` with a *digest mismatch* error
   after the payload host is known-good is the one to escalate.
5. **Publish the correction.** Blocked session ids are **not** recoverable:
   the contract refuses a duplicate `receiptId`. Re-anchor the affected
   sessions under new session ids from a clean key, and publish a public
   incident note listing the forged `receiptId`s. Do not attempt to overwrite.
6. **Rotate** per §3, starting from a fresh Safe with fresh owner keys —
   never the compromised one, and never a key that shared a host with it.
7. **Post-incident.** Record how the owner keys were reached, and add the
   detection that would have caught it earlier to §5.

---

## 5. Operations: gas, monitoring, and failure handling

### 5.1 Gas funding

The submitter Safe holds no ETH (C-5). The deployer executes every
`record-receipt` Safe transaction and pays its gas (`--signer`). Monitor the
deployer's balance with two thresholds:

- **Warn** at fewer than ~20 anchoring transactions' worth of balance.
- **Page** at fewer than ~5.

An unfunded deployer produces exactly the failure mode §5.3 exists to prevent:
a session that should have produced a receipt and did not.

### 5.2 Submission monitoring

The operator runs `rmpc receipt verify` **before** `record-receipt`, and
`record-receipt --payload` recomputes the digest and the id before any signer
exists (issue #1247 AC4), so these are the states worth watching:

| State | Meaning | Action |
|---|---|---|
| digest mismatch | the bytes at `payloadUri` do not hash to the receipt's digest | Do **not** submit. Alert. Treat as a swarm-side canonicalization defect until proven otherwise. |
| signature failure | at least one embedded analyst ed25519 signature does not verify | Do **not** submit. Alert. Possible take tampering. |
| tx revert | the chain refused the call | Alert with the revert reason. `ReceiptAlreadyRecorded` means the session was already anchored — check whether by *this* submitter. |
| tx never mined | broadcast succeeded, no receipt within the wait window | Alert. Do not blind-retry with a fresh nonce; re-check whether the original landed first. |
| no receipt for a session | a session that should have produced one produced none | Page. See §5.3. |

### 5.3 A missing receipt is a product defect, not an ops hiccup

If a session that should have produced a receipt silently produces none, the
public record has a hole in exactly the place someone would look for
suppression. **Submission failures must alert and must never drop quietly.**

The `watchdog` service carries this rule
(`services/watchdog/src/receipt_liveness.rs`). Enable it with the
`[consensus_receipts]` config section:

```toml
[consensus_receipts]
enabled = true
expected_cadence_secs = 86400   # the committee's publishing cadence
grace_secs = 21600              # tolerated lateness on top of it
```

When the gap since the most recently anchored receipt exceeds
`expected_cadence_secs + grace_secs`, the watchdog pages with
`alert_kind = "consensus_receipt_missing"` at `critical` severity. It is
deliberately a *page*, not a warning.

**Two limits, stated rather than hidden.**

- `robotmoney-core` cannot see swarm session state — sessions live in
  `robotmoney-frontend` — so the monitor cannot name the specific session that
  went missing. What it sees is the observable consequence, which is what
  actually catches suppression: an anchoring gap materially longer than the
  publishing cadence means at least one session that should have produced a
  receipt did not.
- **Cold start IS alertable** (changed — Project Fusion AC-CORE-09). Before the
  first receipt exists there is no last-anchor time to measure against, so the
  monitor measures from the earliest persisted `indexer_runs.started_at` on the
  chain instead. That baseline lives in the database, not in process memory, so
  restarting the watchdog cannot reset the observation window and hide a
  publisher that never started. The alert carries `last_recorded_at: null` and a
  `gap_started_at` naming the baseline it measured from, so a cold-start page is
  never confused with a stalled-cadence page.

  A chain with **no anchored receipt and no indexer run at all** has no baseline
  to be late against. That state is now a *fault*, not silence: the watchdog
  logs at `error` and pages with
  `alert_kind = "consensus_receipt_monitor_no_baseline"`, because in practice it
  means the daemon is pointed at a chain id that matches no rows.

**Set the chain id explicitly.** Every query the monitor runs is chain-scoped,
so the wrong id returns empty result sets that read as health. The daemon has
**no default chain id** and refuses to start without one. On `rm-core-stage-1`
run it with `WATCHDOG_CHAIN_ID=918453` (the Fusion devnet) or rely on
`chain_id = 918453` in `services/watchdog/config.staging.toml`, which is the
profile the staging deployment loads. Base mainnet's `8453` used to be the
compiled-in default and is exactly the value that made the monitor blind.

**Alert rate and resolution.** The missing-receipt condition stays true until
the first anchor lands, so paging it once per poll interval (12 s) would have
produced roughly 7 200 pages a day. Each condition carries a stable `dedup_key`
(`consensus_receipt_missing:<chain_id>`,
`consensus_receipt_monitor_no_baseline:<chain_id>`), re-triggers at most once per
`expected_cadence_secs`, and sends `event_action: "resolve"` on the same key on
the first cycle the gap comes back within budget — which is how AC-CORE-09's
"successful anchoring resolves the alert" is delivered.

**This path never pauses gateway deposits.** It is deliberately separate from the
mint/burn breach cycle so a quiet swarm can never halt the protocol. The
response to a missing receipt is a page, never a halt.

### 5.4 Retry policy

Retries are safe by construction: `receiptId` is deterministic and the contract
refuses duplicates, so a retry either lands the same commitment or reverts with
`ReceiptAlreadyRecorded`. Retry submission failures with backoff; never retry
past a **verification** failure — that is a content problem, and retrying it
would be an attempt to anchor bytes that failed their own check.

`record-receipt` itself stays one-shot on purpose — one invocation, one
Safe execution, one exit code. The retry loop is a separate process so that the
"did it actually land?" question is answered by reading the chain rather than by
trusting the exit status of the command that may have timed out.

### 5.5 The Fusion acceptance harnesses (`scripts/fusion/`)

Three scripts implement the autonomous half of §5.2–5.4. None of them holds a
key on argv, and none of them signs anything; only the Safe, through the timelock, applies a receipt.
A fourth, `watch-released-drafts.sh`, drafted a proposal per released receipt.
Issue 1698 retired it and QA plan v1 (leftovers L1) deleted it with its systemd
units: a receipt is now released only inside `RouterGovernance.applyReceipt`,
which applies its weights in the same transaction, so there is nothing left to
draft, and `rmpc governance draft-proposal` is deleted. A host installed from an
older checkout still runs the units and pages `fusion_draft_watcher_stalled`
every cycle. Decommission it: `systemctl disable --now fusion-draft-watcher.service`,
remove `fusion-draft-watcher.service` and `fusion-draft-watcher-failed.service`
from `/etc/systemd/system/`, run `systemctl daemon-reload`, delete
`/etc/fusion/draft-watcher.env` and `/var/lib/fusion-draft-watcher`, then resolve
any open `fusion_draft_watcher_*` incident by hand.

| Script | What it does | Idempotency / restart rule |
|---|---|---|
| `submit-receipt-worker.sh` | Verifies the receipt, then retries submission until the **exact** `(receiptId, payloadDigest)` pair is readable on chain. | Re-reads the chain before and after every attempt. An already-anchored id with the same digest exits `0` without broadcasting; an already-anchored id with a *different* digest is fatal and is never overwritten. |
| `cross-repo-acceptance.sh` | The AC-E2E-05 seam: consumes a *frontend-generated* receipt, verifies the **public URL** and the local bytes and proves they agree, requires four bucket weights totalling 10000 bps, submits, releases, and asserts INV-4. It drafts nothing. | Both write stages are idempotent. The worker reports `already_anchored` and broadcasts nothing; the release stage reads `isReleased(bytes32)` **before** the send and records a named `already_released` no-op, so a second run still reaches the INV-4 comparison and the evidence JSON instead of aborting at a `ReceiptAlreadyReleased` revert. INV-4 witnesses come from the shared `lib/inv4.sh`. |
| `devnet-acceptance.sh` | The AC-E2E-05 **run**: takes one frontend receipt URL and drives `verify → negative → record → index → release → dapp → govern`, writing a machine-readable result file. Exits non-zero on any failed assertion **and on any selected-but-unconfigured stage**. | Stage selection is explicit (`--stages`, `--no-anchor`). Every `SKIP` carries a `reason`: `not_selected` (green), `unconfigured` (**not** green), `prerequisite_failed`, `delegated`. An unknown stage name and a missing witness address refuse to start. |

**The harnesses draft nothing.** `RouterGovernance` has no proposal function
(issue 1698), and a released receipt is already applied:
`RouterGovernance.applyReceipt` releases it and sets the weights in one call.
The harnesses assert record and release. The `govern` stage of
`devnet-acceptance.sh` only proves the converse of applying: the release-only
path it ran set no router weights, so `RouterGovernance.currentWeights()` reads
the same before and after (AC-E2E-04).

**The submitter distinguishes "no anchor" from "cannot read the chain."** The
read RPC is a different endpoint from the write path's failover client, so those
states genuinely differ. An unreadable chain retries the read with backoff and
pages after `FUSION_READ_FAILURE_ALERT` consecutive outages; it never
re-broadcasts on an unknown anchor state, and the post-submit confirmation has
its own bounded read loop so a transient read failure after a successful submit
cannot report the anchor as missing.

Issue 1698 retired the draft path. `RouterGovernance` has no proposal, vote or
execute function. The weight path is the one `RouterGovernance.applyReceipt`
call the Safe schedules through the timelock (govern row `apply-receipt`), which
releases the receipt and writes its weights in the same transaction.
`rmpc governance draft-proposal` is deleted with it. The digest binding it
carried now lives in the govern row, which names the stored digest, and in
`applyReceipt`, which reverts `PayloadDigestMismatch` on chain
(`docs/technical/governance-decisions.md` §3.7).

**Why the orchestrator is separate from `cross-repo-acceptance.sh`.** The older
script is one straight line from artifact to release and always anchors. The
acceptance run needs two things it cannot give: a mode that verifies and refuses
while touching the chain only through `eth_call` — used to dry-run the whole
negative bundle before the first real receipt exists — and a durable result
document naming every assertion, including the ones that did **not** run. A
skipped stage reported as a pass is the failure shape this file exists to
prevent, so `devnet-acceptance.sh` records `PASS`, `FAIL` and `SKIP` as three
distinct outcomes and its own self-test asserts that unselected stages land as
`SKIP`.

**An absent `weights` array is a FAILED assertion, never a skipped one.** A
receipt with no allocation vector cannot carry a recommendation; reporting that
as "nothing to check" is exactly how the condition stays invisible. Both
harnesses enforce it on the receipt bytes: the verify stage of
`devnet-acceptance.sh` requires four bucket weights totalling exactly 10000 bps,
and `cross-repo-acceptance.sh` refuses the same receipt before it submits.

**The negative bundle keeps a weights-tampered case.** The weights are the one
field that becomes treasury calldata and the one the analyst signature check
cannot cover. The negative stage rewrites them to 10000/0/0/0 and asserts that
the stack refuses the receipt against the anchored digest. The apply path
carries the same binding: govern row `apply-receipt` names the stored digest,
and `applyReceipt` reverts `PayloadDigestMismatch`.

**The verdict derives from every SELECTED stage, not from the FAIL count.**
`devnet-acceptance.sh` used to compute `ok` as "no assertion is FAIL" and exit on
the same number, so four stages selected with none of their config supplied
SKIPped every assertion and reported `{failed: 0, ok: true}` with exit 0. One
dropped export after a host rebuild or a credential rotation was enough. A stage
the operator **asked for** whose configuration is missing is now recorded as
`SKIP` with `reason: "unconfigured"`, and `ok` requires both
`summary.failed == 0` **and** `summary.skipped_unconfigured == 0`.

**The anchored digest is compared FIELD-EXACTLY.** `getReceiptById` returns
`(receiptId, payloadDigest, payloadUri, …)` and the explorer API echoes
`payload_uri`, so a substring match over either accepts a wrong digest that
appears anywhere in the record — and with a content-addressed receipt URL
(`{receipt_id}.json` is one convention change away from `{digest}.json`) that is
not hypothetical. Both harnesses cut the `payloadDigest` field out of the tuple,
require `^0x[0-9a-f]{64}$`, and compare the API's `payload_digest` and
`payload_uri` as JSON fields.

**INV-4 witnesses come from one shared reader and fail loudly.**
`scripts/fusion/lib/inv4.sh` reads the INV-4 quantities (the router weights,
the receipt's release state, the role holders, and per mapped vault
`totalAssets()` **and** `totalSupply()`) with no `2>&1` anywhere
near a compared value and every `cast call` exit status checked. A read that did
not answer emits a sentinel that the comparison records as a **FAILED**
assertion; it can never diff clean against another unreadable snapshot. The
comparison window brackets the write stages only, because a mapped vault with a
live yield adapter accrues on its own (rmUSDC on devnet 918453 was measured
moving 1000004 → 1000008 over ~50 idle minutes with no receipt within a thousand
blocks). The comparison itself is still exact equality — only the window narrows.

### 5.5.1 Paging (`FUSION_ALERT_WEBHOOK`)

`FUSION_ALERT_WEBHOOK` is the PagerDuty-style Events-API endpoint the
long-running submit worker POSTs to (the draft watcher, which also did, is
deleted). **It is the precondition for every claim in this
section that a harness "pages".** Its handling is validated at startup, the same
way `rmpc` and `cast` are:

| State | Behaviour |
|---|---|
| set, with `curl` **and** `jq` on `PATH` | Pages are POSTed *and* echoed to stderr. |
| set, with `curl` or `jq` missing | The script **refuses to start** — a page that could never be delivered must not be discovered at 3am. |
| unset | The script starts and logs one explicit warning that every page will be **stderr-only**, which under `nohup`/systemd reaches nobody without a log sink. |

A delivery failure is logged as `ALERT DELIVERY FAILED` with the `curl` exit
status and the dedup key; it is never discarded with `|| true`.

Each condition has its **own** dedup key, so two incidents are two incidents:

| Key | Raised by | Resolved |
|---|---|---|
| `fusion_submit_worker_chain_reads_down` | `submit-receipt-worker.sh`, `FUSION_READ_FAILURE_ALERT` consecutive read outages | yes, when the chain answers again |

`scripts/fusion/tests/run-tests.sh` exercises all of it — including, for the
round-2 guards above, an unreadable chain that must record the INV-4 assertion as
`FAIL` (with a readable-chain control that must record `PASS`), a one-unit witness
drift that both harnesses must reach the same verdict on, a selected-but-
unconfigured stage that must exit non-zero with `failed == 0`, a govern stage
that must PASS while the weight setter's `currentWeights()` is unchanged and
FAIL when it moves or cannot be read, a receipt with no weights array that
`cross-repo-acceptance.sh` must refuse, a wrong `payloadDigest` hidden behind a content-addressed
`payloadUri` in both the tuple and the API body, a second `cross-repo-acceptance.sh`
run that must broadcast nothing and still produce its evidence JSON, and the alert
path's startup refusal, resolve and delivery-failure logging, driven through the
submit worker. Every one of them has a negative control that must FAIL — against stub `rmpc` and
`cast` binaries — retry-then-succeed, already-anchored no-op, conflicting-digest
refusal (including a conflicting digest whose `payloadUri` embeds the derived
digest, which a substring comparison would wrongly accept), a submit that
reports success without anchoring, a malformed `getReceiptById` tuple, and — for `devnet-acceptance.sh` — an unknown stage name, a
missing INV-4 witness address, a missing receipt URL, an unfetchable receipt URL
that must fail rather than pass vacuously, the negative control that
`--no-anchor` reaches no write subcommand, and the assertion that unselected
stages are recorded as `SKIP`.

**CI coverage.** Two workflows run this harness:
`.github/workflows/fusion-cross-repo-drift.yml` runs
`scripts/fusion/tests/run-tests.sh`, and
`.github/workflows/suite-27-fusion-assertion-floor.yml` holds the assertion
floor the same script asserts. (AC-GOV-01's watcher/restart clause went with
the watcher, issue 1698.)
