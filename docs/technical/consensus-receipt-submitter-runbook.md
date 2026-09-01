# Consensus receipt submitter — custody, operations, and compromise runbook

Canonical: `docs/architecture.md` §4.9 — Consensus Recommendation Receipt Contract
Canonical: `docs/product/20260623-product-proposal-investment-committee-v0.md` §2.1
Implements: issue #1247 tasks 4.11, 4.12, 4.13 and acceptance criteria 7, 8

---

## 0. Status — read this first

**v0.1 is devnet only.** The submitter key described here is a devnet key held
in a software keystore. **No production submission may happen until every
requirement in §2 is met**, and none of them is met today. This document
exists so the gap is *recorded* rather than forgotten, which is the whole of
what issue #1247 task 4.11 asks for.

Out of scope for v0.1, and each a separate decision: mainnet deployment, a Safe
with hardware-wallet signers, `ADMIN_ROLE` transfer to a deployed
`TimelockController` on mainnet, an audit pass, a funded submitter key, and
registered genesis agents.

---

## 1. What the key is and what it can do

The **submitter** is a single EOA that holds:

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
touch any vault. Recording is signalling-only (INV-4) and `ADMIN_ROLE` on the
receipt contract is held by the `TimelockController` (INV-3), not by the
submitter. A compromised submitter cannot cause a rebalance; it can pollute the
public record, which for a record whose purpose is trust is damage enough.

**What a submitter attestation does *not* prove.** That each named analyst
signed. The chain proves the committee produced the recommendation and that one
submitter attested to it; the analysts' ed25519 signatures are payload data
verified off-chain (ADR-0012 §5). This is exactly why the off-chain
verification below is load-bearing rather than cosmetic.

---

## 2. Custody requirements before any production submission

Each item is a hard gate. None is satisfied by v0.1.

| # | Requirement | Why |
|---|---|---|
| C-1 | Private key material lives in an **HSM or a cloud KMS** (non-exportable key, sign-only API). No plaintext key, no software keystore, no key in an env var or CI secret. | A software keystore's passphrase is recoverable from any host that ever ran the signer. |
| C-2 | Signing is reachable only from a **dedicated submitter host or workload identity**, with a deny-by-default network egress allowlist covering the RPC endpoint and the swarm API only. | Limits the blast radius to one machine and makes exfiltration visible. |
| C-3 | Every signature request is **logged with the calldata it signed** to an append-only store the submitter host cannot rewrite. | A compromise is only detectable if the tampered call is distinguishable from a legitimate one after the fact. |
| C-4 | The submitter EOA holds **`AGENT_ROLE` and `COMMITTEE_AGENT_ROLE` and nothing else** — never `ADMIN_ROLE`, `PAUSER_ROLE`, or `DEFAULT_ADMIN_ROLE` on any contract. Verified after every deploy and every role change. | The gateway already enforces role separation (`AccessRoles`); this makes the check explicit at the operational layer too. |
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
CLI flag. `rmpc` refuses a software signer for production-grade chain ids
(`require_production_grade_for_write`), which is the mechanical guard keeping
the devnet arrangement devnet-only.

---

## 3. Rotation

Rotation is **additive then subtractive**, and it needs no contract change
because membership is registry state.

1. Provision the new key per §2 and derive its address.
2. Via the timelock's normal schedule → delay → execute path, grant the new
   address `COMMITTEE_AGENT_ROLE` (`gateway.committeeRegister`) and authorize
   it as a gateway agent (`gateway.authorizeAgent`).
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
   each receipt as authentic or forged. The indexer already stores this
   verification state, so the forged ones should be visible as
   `verified = false` before anyone looks.
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
- **Cold start is not alertable.** With no receipt ever anchored on a chain
  there is no cadence to be late against, so the monitor stays quiet until the
  first receipt lands. A publisher that never started is a deployment question,
  not a suppression signal — check the deploy, not this alert.

**This path never pauses the gateway.** It is deliberately separate from the
mint/burn breach cycle so a quiet swarm can never halt the protocol. The
response to a missing receipt is a page, never a halt.

### 5.4 Retry policy

Retries are safe by construction: `receiptId` is deterministic and the contract
refuses duplicates, so a retry either lands the same commitment or reverts with
`ReceiptAlreadyRecorded`. Retry submission failures with backoff; never retry
past a **verification** failure — that is a content problem, and retrying it
would be an attempt to anchor bytes that failed their own check.
