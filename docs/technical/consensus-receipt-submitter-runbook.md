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
   each receipt as authentic or forged.

   **`verified = false` is not, on its own, evidence of forgery.** The flag
   records one thing: whether the indexer could fetch `payloadUri` and reproduce
   the on-chain `payloadDigest`. An unreachable or slow payload host produces the
   same `false` as a forgery does. Read the two companion columns before drawing
   any conclusion:

   | Column | Reading |
   | --- | --- |
   | `last_verify_error` | `GET … returned 5xx`, a timeout, or a connection error → a HOST problem, not a forgery signal. A `digest mismatch …` message is the one that matters here. |
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

**This path never pauses the gateway.** It is deliberately separate from the
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

Four scripts implement the autonomous half of §5.2–5.4. None of them holds a
key on argv, and none of them signs a governance proposal.

| Script | What it does | Idempotency / restart rule |
|---|---|---|
| `submit-receipt-worker.sh` | Verifies the receipt, then retries submission until the **exact** `(receiptId, payloadDigest)` pair is readable on chain. | Re-reads the chain before and after every attempt. An already-anchored id with the same digest exits `0` without broadcasting; an already-anchored id with a *different* digest is fatal and is never overwritten. |
| `watch-released-drafts.sh` | Polls `ReceiptReleased` behind `FUSION_CONFIRMATIONS` and emits a human-review-only draft per released receipt. | The block cursor is a durable file, written atomically and advanced **only** after a whole confirmed range was actually examined. A crash mid-range rescans it; drafts are read-only JSON, so a rescan costs nothing. **Restarted by `scripts/fusion/fusion-draft-watcher.service`** (`Restart=always`, `StartLimitIntervalSec=0`, `OnFailure=` pages `fusion_draft_watcher_process_down`); install per `docs/operations/fusion-draft-watcher.md`. |
| `cross-repo-acceptance.sh` | The AC-E2E-05 seam: consumes a *frontend-generated* receipt, verifies the **public URL** and the local bytes and proves they agree, submits, releases, drafts, and asserts INV-4. | Reads `RouterGovernance.currentProposalId()`, `PortfolioRouter.getWeights()` and every mapped vault's `totalAssets()` before and after and fails if any moved. |
| `devnet-acceptance.sh` | The AC-E2E-05 **run**: takes one frontend receipt URL and drives `verify → negative → record → index → release → dapp → govern`, writing a machine-readable result file. Exits non-zero on any failed assertion. | Stage selection is explicit (`--stages`, `--no-anchor`). An unselected stage is written to the result as `SKIP` and is never counted as a pass; an unknown stage name and a missing witness address both refuse to start. |

**Poison cannot wedge the watcher, and a blip cannot skip a release.** These
are two different failures with opposite fixes, and the split between them is
the *cause* of the refusal.

A **content** refusal — tampered bytes, a digest that does not equal the
anchored `payloadDigest`, a receipt id that does not derive from the bytes, an
invalid analyst signature, no eligible vault — is a property of that receipt
and reproduces forever. Scan mode reports it as a `"refused"` entry inside the
range result and exits `0`. The watcher reads `.drafts[]` with `jq`, appends
each refused `receipt_id`/error to `$FUSION_DRAFT_QUARANTINE`, pages
`fusion_draft_watcher_refused_receipt`, and **only then** advances the cursor:
once the cursor has moved that receipt is never looked at again, so the record
has to be written first. An `EXIT_REFUSAL` (2) that reaches the shell anyway is
quarantined the same way.

A **transport** refusal — an unreachable payload URL, an unreadable file, an
RPC that is down — is a property of the moment, and the receipts behind it were
never examined at all. `rmpc` exits non-zero for those (after a bounded retry
with backoff on the payload GET), and the cursor is **held** and the range
retried. Absorbing them was the shipped defect: one 503 or one 10 s timeout
permanently un-drafted a released receipt, and because the cursor advanced,
`stalled_cycles` reset and the stall alert could not fire either.

A cursor that has not moved for `FUSION_STALL_ALERT_CYCLES` cycles pages, with
the scan window capped at `FUSION_MAX_SCAN_BLOCKS`. A failed `cast block-number`
is handled as a transport failure too — guarded, shape-checked, counted and
retried — rather than killing the loop under `set -euo pipefail` with no alert
at all, and every cycle's draft result is persisted to `$FUSION_DRAFT_RESULT`.

**The draft is bound to the on-chain commitment.** `draft-proposal` reads the
anchored tuple with `getReceiptById`, fetches the bytes from the **anchored
`payloadUri`** (a `--receipt-url` that disagrees is refused, not preferred),
and refuses unless `keccak256(canonical_bytes) == payloadDigest` and every
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

The draft watcher's read-only property is structural, not a convention:
`rmpc governance draft-proposal` imports no signer, no nonce lock and no
broadcast path (`clients/rust-payment-client/src/commands/governance_draft.rs`),
so there is no code path from a `ReceiptReleased` log to a transaction.

**Why the orchestrator is separate from `cross-repo-acceptance.sh`.** The older
script is one straight line from artifact to draft and always anchors. The
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
as "nothing to check" is exactly how the condition stays invisible.

`scripts/fusion/tests/run-tests.sh` exercises all of it against stub `rmpc` and
`cast` binaries — retry-then-succeed, already-anchored no-op, conflicting-digest
refusal (including a conflicting digest whose `payloadUri` embeds the derived
digest, which a substring comparison would wrongly accept), a submit that
reports success without anchoring, a malformed `getReceiptById` tuple, cursor
persistence across a restart, cursor non-advance on scan failure, the mandatory
`FUSION_START_BLOCK`, the negative control that the watcher never invokes a
write subcommand, and — for `devnet-acceptance.sh` — an unknown stage name, a
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
> workflow invokes it, AC-CORE-09's retry/idempotency clause and AC-GOV-01's
> watcher/restart clause are **proven by local run only** and must be recorded
> that way in the §12.6 evidence bundle — never described as CI-covered.
> Follow-up: add a `bash scripts/fusion/tests/run-tests.sh` step to
> `suite-13-doc-checks.yml` (no paths filter, cheapest host). The Fusion
> acceptance run may not modify `.github/workflows`, so it is not done here.
