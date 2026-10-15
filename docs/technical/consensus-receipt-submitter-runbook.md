# Consensus receipt submitter — custody, operations, and compromise runbook

Canonical: `docs/architecture.md` §4.9 — Consensus Recommendation Receipt Contract
Canonical: `docs/product/20260623-product-proposal-investment-committee-v0.md` §2.1
Implements: issue #1247 tasks 4.11, 4.12, 4.13 and acceptance criteria 7, 8

Investment Committee signals are advisory only. The gateway signal endpoint binds the member to the caller: `committeeVoteSubmit` reverts `CommitteeAgentNotCaller` unless the vote's `agent` is `msg.sender` (core issue 1790, PR 1818). Consensus receipts are caller bound and ADMIN released; receipts are the only rebalance input, applied by the Safe through the timelock.

---

## 0. Status — read this first

**v0.1 is devnet only.** The submitter key described here is a devnet key held
in a software keystore. **No production submission may happen until every
requirement in §2 is met**, and none of them is met today. This document
exists so the gap is *recorded* rather than forgotten, which is the whole of
what issue #1247 task 4.11 asks for.

Out of scope for v0.1, and each a separate decision: mainnet deployment, a Safe
whose owners sign with encrypted keystores, `ADMIN_ROLE` transfer to a deployed
`TimelockController` on mainnet, an audit pass, a funded submitter key, and
registered genesis agents.

---

## 1. What the key is and what it can do

The **submitter** is an account that holds (an EOA in the original v0.1 design, a multisig Safe from issue 1750, see §1.1):

- `AGENT_ROLE` on `RobotMoneyGateway`, and
- `COMMITTEE_AGENT_ROLE` on `InvestmentCommitteePolicy`.

Those two together are the entire authority needed to call
`RobotMoneyGateway.consensusRecordReceipt`.

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

Owner decision 2026-10-10: **no single key anchors a receipt.** For the Base mainnet rehearsal and every later run on the `publish-contracts` surface the submitter is not an
EOA. It is a **second Safe**, a SafeL2 1.4.1 proxy separate from the governing Safe, that holds the two roles above and nothing else. Everything in §1 about what the
submitter can and cannot do holds unchanged for a contract account: the contracts check only the roles, never `msg.sender`, `tx.origin`, `isContract` or a signature
(`contracts/test/ConsensusReceiptSafeSubmitter.t.sol` proves it with a real Safe, including the 1-raw-unit deposit cap and the disabled withdrawals).

- **What the tooling pins** (`publish-contracts/src/submitter-safe.ts`): the canonical SafeProxy 1.4.1 code hash, the SafeL2 singleton in slot 0, `VERSION` 1.4.1, threshold 2 or more,
  no module, no guard, the canonical fallback handler. It is never the governing Safe, the timelock, admin (= the deployer), the pauser or the emergency address.
- **Register it:** `govern --row register-committee --submitter 0x<Safe>`. The checks run before the timelock round is scheduled.
- **Registration has no public window (QA plan v1 B6, security review CS-2).** The row works in two halves.
  - **Private half, first.** The submitter Safe authorizes itself on the gateway in three Safe transactions. Its owners sign with `--owner-signer` and `--signer` pays the gas.
    1. `commitAuthorization(keccak256(abi.encode(safe, safe, salt)))` with a random salt. The commit does not name the agent.
    2. `revealAuthorization(safe, salt, policy, "")` at least one block later. The Safe reveals for itself, so it passes no consent signature. The Safe now owns its own agent.
    3. `transferAgentOwnership(safe, timelock)`. The timelock now owns the agent.
  - **Public half, second.** Only then does the governing Safe schedule the timelock batch: `gateway.setPolicy` (the 1-unit signalling-only policy, shares to the timelock) and `gateway.committeeRegister`.
  - **Why the order matters.** The old batch scheduled `authorizeAgent(safe)` in public for the whole delay. A squatter could commit and reveal an authorization for the published address first. The batch then reverted `AgentAlreadyOwned`, and the squatter could `revokeAgent` at will, because the gateway has no seize path. Two layers now close it. The gateway refuses a stranger's reveal for another address unless that address signed its consent (issue 1791), and a Safe has no key to sign with. The new batch also carries no first-time authorization, so nothing a stranger does can break it (`contracts/test/ConsensusReceiptSafeSubmitter.t.sol::test_publicRegisterBatchCannotBeFrontRun`).
  - **If the address is already owned.** The tool refuses with `GOVERN` and schedules nothing. Create a new submitter Safe and run the row with it. Against a gateway with the issue 1791 consent check a stranger cannot own a Safe's address at all. Against an older gateway a stranger could claim a published address in advance, such as the old governance Safe below, or win the one-block race between the commit and the reveal. The tool catches both before any timelock round is spent.
  - **A row that stops part-way resumes from the chain.** The agent owner shows which steps are done. A stored commitment is revealed while its 256-block window lasts. After that the tool commits again with a new salt.
- **Record with it:** `record-receipt --submitter 0x<Safe> --signer <deployer> --owner-signer <owner> ...`. The verb proposes `consensusRecordReceipt` through the Safe, `threshold` owners
  sign, the deployer executes and pays the gas. It refuses fewer owner signers than the threshold, a Safe that differs from `--submitter`, and a Safe transaction without
  `ExecutionSuccess`. It reads the receipt back and requires the stored submitter to be the Safe.
- **Plainly: the same three owner keys control BOTH Safes** (the governing Safe and the submitter Safe). Proposing and approving are separated by the multisig (two of three
  signatures) and by each Safe's own nonce, not by different keys. A compromise of two owner keys is a compromise of both Safes. This is the owner's accepted trade-off for the
  rehearsal. The custody requirements of §2 (HSM or KMS, dedicated host, append-only signing log) describe a *single-key* submitter and are replaced, for the owners' keys, by
  the hardware wallets of the governing Safe's own runbook.
**Roles in the 900 s rehearsal (acceptance criterion 5).** The OLD governance Safe `0x5E68a40648DD23065b21b1C414e1178ddE6482ca` (the first rehearsal's governing Safe, 2 of 3, proxy code hash and singleton checked read-only on 8453) is the **PROPOSER**: it is the submitter Safe that records receipts (`record-receipt --submitter 0x5E68a40648DD23065b21b1C414e1178ddE6482ca`). The NEW governing Safe, created by this rehearsal with `SAFE_SALT_NONCE` 2026101002, is the **APPROVER**: it registers the proposer through the timelock and applies the receipt (`govern --row apply-receipt`). The old Safe holds no role on the new deployment until `register-committee` gives it AGENT_ROLE and COMMITTEE_AGENT_ROLE. **Caveat: the same three owner keys (A, B, C) control BOTH Safes**, so proposer and approver are separated by the multisig and by each Safe's own nonce, not by key. **Preflight:** the three owner EOAs A, B and C must differ from the 900 s sheet's ADMIN_ADDRESS, PAUSER_ADDRESS and EMERGENCY_ADDRESS (the sheet already enforces it for the new Safe; the submitter check enforces it for the old one) or registration is refused with an error naming which owner collided.
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
| C-4 | The submitter EOA holds **`AGENT_ROLE` and `COMMITTEE_AGENT_ROLE` and nothing else** — never `ADMIN_ROLE`, `DEPOSIT_PAUSER_ROLE`, or `DEFAULT_ADMIN_ROLE` on any contract. Verified after every deploy and every role change. | The gateway already enforces role separation (`AccessRoles`); this makes the check explicit at the operational layer too. |
| C-5 | The gas-funding wallet is **separate** from the submitter key and tops it up on a schedule, never the reverse. | The submitter should never hold a balance worth stealing on its own. |
| C-6 | A **named on-call owner** and a tested rotation drill exist before the first mainnet submission. | An untested rotation procedure is not a rotation procedure. |

### 2.1 Key generation

Generate inside the HSM/KMS. The key must never exist outside it — not on a
laptop, not in a paper backup, not in a password manager. If the key material
was ever material you could copy, it is a devnet key.

### 2.2 Devnet key (what exists today)

For devnet, the submitter is an ordinary `rmpc` software keystore, loaded the
same way every other `rmpc` write command loads one: the passphrase comes
strictly from `$RMPC_KEYSTORE_PASSPHRASE`, never from stdin and never from a
CLI flag. `rmpc receipt` (like `committee`) signs with a software keystore
on every chain, Base mainnet included, after the production warning: a
hardware wallet, HSM or KMS is optional, never required (owner decision
2026-10-14, QA plan Decision D12; the old `require_production_grade_for_write`
gate is gone). What keeps the single-key arrangement devnet-only is the role,
not a signer refusal: on 8453 the submitter is the Safe, and an EOA without
the submitter roles reverts.

---

## 3. Rotation

Rotation is **additive then subtractive**, and it needs no contract change
because membership is registry state.

1. Provision the new key per §2 and derive its address.
2. Register the new address with `govern --row register-committee` (§1.1). The
   new submitter first authorizes ITSELF in private, before anything is public:
   `gateway.commitAuthorization`, one block later `gateway.revealAuthorization`
   (its own agent, shares to itself), then
   `gateway.transferAgentOwnership(new, timelock)`. Only then, via the
   timelock's normal schedule → delay → execute path, one batch sets the
   signalling-only policy (`gateway.setPolicy`, shares to the timelock) and
   grants `COMMITTEE_AGENT_ROLE` (`gateway.committeeRegister`). Never schedule
   a public `gateway.authorizeAgent` for the new address: during the delay
   anyone can authorize that address first and own it for good (QA plan v1
   B6).
3. Submit one receipt from the new key on a real session and confirm the
   indexer ingested it with `verified = true`.
4. Revoke the old address: `InvestmentCommitteePolicy.revokeAgent` (an
   `ADMIN_ROLE` call from the timelock), then `RobotMoneyGateway.revokeAgent`.
5. Confirm on chain that the old address holds neither role.

**Both keys are valid between steps 2 and 4.** That overlap is intentional — it
is what makes a rotation safe to abort. Never revoke before the new key has
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

1. **Contain (minutes).** Disable the KMS signing grant for the key. This is
   the fastest kill switch and needs no chain transaction.
2. **Revoke (one timelock cycle).** `InvestmentCommitteePolicy.revokeAgent`
   to drop `COMMITTEE_AGENT_ROLE`, then `RobotMoneyGateway.revokeAgent`. Until this lands, containment rests on step 1
   alone.
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
6. **Rotate** per §3, starting from a freshly provisioned key — never the
   compromised one, and never a key that shared a host with it.
7. **Post-incident.** Record how the key was reached, and add the detection
   that would have caught it earlier to §5.

---

## 5. Operations: gas, monitoring, and failure handling

### 5.1 Gas funding

The submitter needs native-token balance to anchor. It is funded from a
separate wallet (C-5) and monitored with two thresholds:

- **Warn** at fewer than ~20 anchoring transactions' worth of balance.
- **Page** at fewer than ~5.

An unfunded submitter produces exactly the failure mode §5.3 exists to prevent:
a session that should have produced a receipt and did not.

### 5.2 Submission monitoring

`rmpc` verifies **before** it submits and refuses on failure (issue #1247
AC4), so these are the states worth watching:

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

`rmpc receipt submit` itself stays one-shot on purpose — one invocation, one
broadcast, one exit code. The retry loop is a separate process so that the
"did it actually land?" question is answered by reading the chain rather than by
trusting the exit status of the command that may have timed out.

### 5.5 The Fusion acceptance harnesses (`scripts/fusion/`)

Three scripts implement the autonomous half of §5.2–5.4. None of them holds a
key on argv, and none of them signs anything; only the Safe, through the timelock, applies a receipt.
A fourth, `watch-released-drafts.sh`, drafted a proposal per released receipt.
Issue 1698 retired it and QA plan v1 (leftovers L1) deleted it with its systemd
units: a receipt is now released only inside `RouterGovernance.applyReceipt`,
which applies its weights in the same transaction, so there is nothing left to
draft, and `rmpc governance draft-proposal` is deleted. A host that still runs
it is decommissioned per `docs/operations/fusion-draft-watcher.md`.

| Script | What it does | Idempotency / restart rule |
|---|---|---|
| `submit-receipt-worker.sh` | Verifies the receipt, then retries submission until the **exact** `(receiptId, payloadDigest)` pair is readable on chain. | Re-reads the chain before and after every attempt. An already-anchored id with the same digest exits `0` without broadcasting; an already-anchored id with a *different* digest is fatal and is never overwritten. |
| `cross-repo-acceptance.sh` | The AC-E2E-05 seam: consumes a *frontend-generated* receipt, verifies the **public URL** and the local bytes and proves they agree, requires four bucket weights totalling 10000 bps, submits, releases, checks that the weight setter applies receipts from this register (`receiptContract()`), and asserts INV-4. | Both write stages are idempotent. The worker reports `already_anchored` and broadcasts nothing; the release stage reads `isReleased(bytes32)` **before** the send and records a named `already_released` no-op, so a second run still reaches the INV-4 comparison, the apply-path read and the evidence JSON instead of aborting at a `ReceiptAlreadyReleased` revert. INV-4 witnesses come from the shared `lib/inv4.sh`. |
| `devnet-acceptance.sh` | The AC-E2E-05 **run**: takes one frontend receipt URL and drives `verify → negative → record → index → release → dapp → govern`, writing a machine-readable result file. Exits non-zero on any failed assertion **and on any selected-but-unconfigured stage**. | Stage selection is explicit (`--stages`, `--no-anchor`). Every `SKIP` carries a `reason`: `not_selected` (green), `unconfigured` (**not** green), `prerequisite_failed`, `delegated`. An unknown stage name and a missing witness address refuse to start. |

**The draft was bound to the on-chain commitment (pre-1698).** The deleted
`rmpc governance draft-proposal` command read the anchored tuple with
`getReceiptById`, fetches the bytes from the **anchored
`payloadUri`** (a `--receipt-url` that disagrees is refused, not preferred),
and refuses unless `keccak256(domain line + canonical_bytes) == payloadDigest` and every
analyst signature verifies — the same checks `rmpc receipt submit` runs before
anchoring. Without that comparison a weights-only edit of the published receipt
produced an identical `receipt_id`, signatures still `verified:true`, and a
`ready_for_review` draft whose calldata moved the treasury wherever the editor
chose: `receipt_id` is `keccak256(sep + session_id + subject_id)` and `weights`
is not in that preimage.

**The submitter distinguishes "no anchor" from "cannot read the chain."** The
read RPC is a different endpoint from the write path's failover client, so those
states genuinely differ. An unreadable chain retries the read with backoff and
pages after `FUSION_READ_FAILURE_ALERT` consecutive outages; it never
re-broadcasts on an unknown anchor state, and the post-submit confirmation has
its own bounded read loop so a transient read failure after a successful submit
cannot report the anchor as missing.

Issue 1698 retired the draft path (QA plan v1 C1). `RouterGovernance` has no
proposal, vote or execute function, and a receipt is released only inside the
one `RouterGovernance.applyReceipt` call the Safe schedules through the timelock
(govern row `apply-receipt`), which writes its weights in the same transaction.
`rmpc governance draft-proposal` is deleted with it. The digest binding it
carried now lives in the govern row, which refuses a payload whose digest
differs from the recorded one, and in `applyReceipt`, which refuses
`ReceiptDigestMismatch` on chain (`docs/technical/governance-decisions.md` §3.7).

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

**The verdict derives from every SELECTED stage, not from the FAIL count.**
`devnet-acceptance.sh` used to compute `ok` as "no assertion is FAIL" and exit on
the same number, so four stages selected with none of their config supplied
SKIPped every assertion and reported `{failed: 0, ok: true}` with exit 0. One
dropped export after a host rebuild or a credential rotation was enough. A stage
the operator **asked for** whose configuration is missing is now recorded as
`SKIP` with `reason: "unconfigured"`, and `ok` requires both
`summary.failed == 0` **and** `summary.skipped_unconfigured == 0`.

**The govern stage proves the apply path, with `eth_call` only (issue 1698).**
The stage used to assert on the draft `rmpc governance draft-proposal` built.
That command is deleted, so the stage now proves three properties against the
deployed contracts and changes nothing: `RouterGovernance.receiptContract()` is
the receipt contract that holds this receipt; `applyReceipt` sent from an
account that is not the timelock (`FUSION_UNAUTHORIZED_RELEASER`, or
`FUSION_UNAUTHORIZED_SUBMITTER`) reverts `AccessControlUnauthorizedAccount`; and,
once the receipt is released, `applyReceipt` sent from the timelock
(`FUSION_TIMELOCK_ADDRESS`) reverts `ReceiptAlreadyReleased`, so a released
receipt can never move weights later. An unreleased receipt with the release
stage not selected records the last probe as a `not_selected` skip. The
weights-tampered negative case (10000/0/0/0) stays: the stack must refuse it
against the anchored digest. The apply path carries the same binding: govern row
`apply-receipt` refuses a payload whose digest differs, and `applyReceipt`
reverts `ReceiptDigestMismatch`.

**The anchored digest is compared FIELD-EXACTLY.** `getReceiptById` returns
`(receiptId, payloadDigest, payloadUri, …)` and the explorer API echoes
`payload_uri`, so a substring match over either accepts a wrong digest that
appears anywhere in the record — and with a content-addressed receipt URL
(`{receipt_id}.json` is one convention change away from `{digest}.json`) that is
not hypothetical. Both harnesses cut the `payloadDigest` field out of the tuple,
require `^0x[0-9a-f]{64}$`, and compare the API's `payload_digest` and
`payload_uri` as JSON fields.

**INV-4 witnesses come from one shared reader and fail loudly.**
`scripts/fusion/lib/inv4.sh` reads all four quantities —
`PortfolioRouter.getEffectiveWeights()` (what deposits route by; it took the
slot of `RouterGovernance.currentProposalId()`, which issue 1698 deleted),
`PortfolioRouter.getWeights()`, and per
mapped vault `totalAssets()` **and** `totalSupply()` — with no `2>&1` anywhere
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
whose three apply-path probes must PASS against a bound, timelock-only weight
setter and FAIL against one bound to another register or with no guards at all,
a receipt with no weights array that `cross-repo-acceptance.sh` must refuse, a
stub `rmpc` with no `governance` subcommand so a harness that still calls the
deleted draft command fails, a wrong `payloadDigest` hidden behind a content-addressed
`payloadUri` in both the tuple and the API body, a second `cross-repo-acceptance.sh`
run that must broadcast nothing and still produce its evidence JSON, and the alert
path's startup refusal, resolve and delivery-failure logging, driven through the
submit worker. Every one of them has a negative control that must FAIL — against stub `rmpc` and
`cast` binaries — retry-then-succeed, already-anchored no-op, conflicting-digest
refusal (including a conflicting digest whose `payloadUri` embeds the derived
digest, which a substring comparison would wrongly accept), a submit that
reports success without anchoring, a malformed `getReceiptById` tuple, and —
for `devnet-acceptance.sh` — an unknown stage name, a
missing INV-4 witness address, a missing receipt URL, an unfetchable receipt URL
that must fail rather than pass vacuously, the negative control that
`--no-anchor` reaches no write subcommand, and the assertion that unselected
stages are recorded as `SKIP`.

> **CI coverage, stated honestly.** `grep -rn "scripts/fusion" .github/` returns
> nothing: no workflow runs this harness. It is the failure shape
> `docs/development/false-green-shapes.md` calls `uninvoked-evidence-script`,
> and the guard written to detect that shape
> (`.github/scripts/check_evidence_scripts.py`, invariant B) only sweeps
> scripts directly under its `TESTS_DIR`, so a harness here is invisible to it. Until a
> workflow invokes it, AC-CORE-09's retry/idempotency clause is **proven by
> local run only** and must be recorded that way in the §12.6 evidence bundle —
> never described as CI-covered. (AC-GOV-01's watcher/restart clause went with
> the watcher, issue 1698.)
> Follow-up: add a `bash scripts/fusion/tests/run-tests.sh` step to
> `suite-13-doc-checks.yml` (no paths filter, cheapest host). The Fusion
> acceptance run may not modify `.github/workflows`, so it is not done here.
