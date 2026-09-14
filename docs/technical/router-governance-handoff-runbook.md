# Router-weight governance handoff — from a released receipt to applied weights

Canonical: `docs/product/20260623-product-proposal-investment-committee-v0.md` §3.4, §6.2
Canonical: `docs/technical/governance-decisions.md`
Canonical: `docs/technical/security-model.md` §4
Implements: issue #1248 tasks 5.5, 5.8, 5.9 and acceptance criteria 5, 6

---

## 0. Purpose and the separation that makes it a control, not a label

The committee **recommends**; a **different** body **approves**. `docs/architecture.md`
and `docs/prd.md` fix `RouterGovernance` as the only permitted caller of
`PortfolioRouter.setWeights` (INV-4, `docs/prd.md` §12), and the proposal
lifecycle is the only path that applies a weight change:

```
COMMITTEE (releases receipt, signalling-only, D5 admin discretion)
   │  worker never submits unattended (§6.2)
   ▼
off-chain worker drafts RouterGovernance.propose(vaults, bps)      ← `rmpc governance draft-proposal`
   │  human reviews
   ▼
RouterGovernance.propose(vaults, bps)                              ← ADMIN_ROLE, human submission
   ▼
vote() by the RouterGovernance voter set                           ← separate body, non-zero power
   ▼
Queued (quorum reached) → execution delay elapses
   ▼
execute(proposalId) → PortfolioRouter.setWeights(vaults, bps)
```

Every rebalance runs through a **human** step. There is no code path that
submits a governance proposal unattended. This runbook is the operator's
playbook for that path, end to end.

---

## 1. The intended RouterGovernance voter set (task 5.9)

`RouterGovernance` voting power is assigned by `ADMIN_ROLE` via
`setVotingPower` (`RouterGovernance.sol:310`) and read (checkpointed) at each
proposal's snapshot block. It is **not** token-holder governance.

**Who the voters are.** The approving body is intentionally a *different* set of
addresses than the committee that authors receipts. Genre staff followed from
`docs/product/20260623-product-proposal-investment-committee-v0.md` §3.4: the
voter set is the addresses the protocol admin designates to approve portfolio
weight changes — distinct from the `COMMITTEE_AGENT_ROLE` holders, from the
`Safe → TimelockController → ADMIN_ROLE` administrators, and from the Guardian.

**How `setVotingPower` assignment is authorised.** `ADMIN_ROLE` on
`RouterGovernance` is held by the `TimelockController` (behind the Safe), the
same admin channel that handles all protocol-role changes
(`docs/technical/security-model.md` §4). Changing the voter set therefore
requires a Safe quorum → timelock `schedule` → delay → `execute`
operation, exactly like any other privileged role change.

**How that authority is itself constrained.** Assigning or revoking voting power
is a privileged-configuration operation and must be routed through the admin
timelock (`docs/technical/governance-decisions.md` §3.3, `docs/technical/security-model.md` §4.5).
And critically: **no committee agent may hold voting power.** The
`COMMITTEE_AGENT_ROLE` holder set and the non-zero-voting-power set are disjoint
(`GovernanceSeparationInvariant.t.sol`). Granting a committee agent voting power
is a security-model change requiring a new ADR against INV-4 — it is **not** an
ordinary ops action and must never be performed by this runbook's steps.

### 1.1 Choosing the quorum (task 5.8)

`DeployRouterGovernance.s.sol` deploys `quorumThreshold = 2` by default, and
`MIN_QUORUM_THRESHOLD = 2` (`RouterGovernance.sol`) is the floor the contract
itself enforces — at both doors, the constructor and `setQuorumThreshold`.

**A quorum of 1 is not reachable, by deploy script or by setter.** Three refusals
now agree, and an operator will meet whichever comes first:

| Where | What refuses | How it reads |
|---|---|---|
| `DeployRouterGovernance.s.sol`, before any env read | `QUORUM_THRESHOLD <= 1` | `QUORUM_THRESHOLD must be greater than 1` |
| `RouterGovernance` constructor | `_quorumThreshold < 2` | `QuorumBelowMinimum()` |
| `RouterGovernance.setQuorumThreshold` | `threshold < 2` | `QuorumBelowMinimum()` |

The Step 5 postcondition below is therefore `quorumThreshold() > 1`, not
`> 0`: the weaker reading was the one that let the hollow default through.

**The floor is a lower bound, not a target.** Before receipts drive real weight
changes, set a quorum that reflects the intended voter set — two voters out of
twenty is still a minority carrying a change. The quorum is set at deploy time
via the `QUORUM_THRESHOLD` env var (or after deploy via `setQuorumThreshold`,
routed through the admin timelock).

**Migrating an existing deployment.** `MIN_QUORUM_THRESHOLD` is a `constant`, so
raising it changed the contract's bytecode. A `RouterGovernance` deployed before
this change keeps the old floor of 1 and cannot be upgraded into the new one:
redeploy `RouterGovernance`, grant the new instance `ADMIN_ROLE` on the
`PortfolioRouter`, revoke it from the old instance, and re-point every
off-chain reader (explorer indexer, dapp, watchdog) at the new address. The
`PortfolioRouter` and the receipt contract are untouched, so allocation state
and anchored receipts survive.

Selection rule: pick a quorum that **no minority subset of the voter set can
reach**, so a change requires broad consent of the approving body. Concretely,
with voters holding powers `p_1 … p_n` and total `T = Σ p_i`, choose
`quorumThreshold` in `(T/2, T]` — then at least a strict majority (by power) of
the voter body must vote FOR. Document the chosen value and the voter roster
(next to it) wherever the deployment parameters are recorded.

---

## 2. The handoff path, step by step

### Step 1 — a receipt is released

A receipt is recorded and then **released** by an admin through the timelock
(`ConsensusRecommendationReceipt.releaseReceipt`, `onlyRole(ADMIN_ROLE)` — INV-3; the
receipt contract's `ADMIN_ROLE` is held by the timelock). Release is signalling-
only (D5, `docs/product/20260623-product-proposal-investment-committee-v0.md` §2.1): it publishes the receipt and emits
`ReceiptReleased`, moving no funds and calling no `setWeights`. Most receipts
are published, not applied — that is the intended design.

### Step 2 — the worker drafts, for human review only

```
rmpc governance --config operator.toml draft-proposal \
  --receipt-id 0x<64hex> --receipt-url <URL> [--pretty]
```

The worker (`clients/rust-payment-client/src/commands/governance_draft.rs`):
- refuses an un-released receipt (`ErrReceiptNotReleased`),
- skips (not an error) a receipt with no `weights` vector,
- maps buckets to vaults through the config `[vault_addresses]` table,
- **re-checks `isRouterEligibleAndActive` at draft time** for every mapped
  vault — a vault Active when the receipt was recorded may be Paused by now, and
  `propose()` would revert `VaultNotEligible` on exactly that vault. An
  ineligible vault is dropped and its bps redistributed; every ineligible →
  `ErrNoEligibleVaults`,
- reports `blocked_active_proposal` instead of a submittable draft when
  `RouterGovernance` already has an Active/Queued proposal,
- emits the `propose` calldata for a **human** to submit. The worker never
  signs, takes no nonce lock, and never broadcasts.

**The human step is mandatory and permanent.** The worker is convenience
tooling, not core machinery. No automation submits a proposal unattended.

### Step 3 — a human submits the proposal

Submit the draft's `propose_calldata` through the approved channel:
- `rmpc propose` from an address holding `ADMIN_ROLE` on `RouterGovernance`, or
- the Safe → `TimelockController` → `ADMIN_ROLE` path, or
- any wallet the admin body controls.

`propose()` validates the bps sum to 10 000 and that every vault is
`isRouterEligibleAndActive`, and enforces the one-active-proposal rule.

### Step 4 — the voter body votes

Each voter with non-zero power calls `vote(proposalId)` within the voting
period. Their power is read at the proposal's snapshot block. When `votesFor`
reaches `snapshotQuorum`, the proposal becomes `Queued`.

### Step 5 — execution delay, then execute

After `execute()`'s execution delay elapses, anyone may call
`execute(proposalId)`, which calls `PortfolioRouter.setWeights(vaults, bps)` and
emits `WeightsApplied`. The router's weight vector is now the voted allocation.

---

## 3. Compromise and incident response

| Compromised role | Blast radius | Response |
|---|---|---|
| **Submitter EOA** (recorded a receipt) | Can anchor a wrong digest, polluting the public record; cannot release, cannot set weights. | New session id + public correction (`consensus-receipt-submitter-runbook.md`); revoke `AGENT_ROLE`/`COMMITTEE_AGENT_ROLE` via timelock. |
| **Worker host** | Can *draft* anything but cannot sign or broadcast; recommends, never approves. | Rebuild from clean state; treat any draft as advisory until a human re-runs and reviews it. |
| **A voter's key** | Can cast that voter's (single) vote. | Await proposal resolution; revoke/rotate the affected `setVotingPower` via timelock before the next proposal. |
| **`ADMIN_ROLE` on `RouterGovernance`** | Can assign voting power, set quorum, propose, cancel. | Safe quorum revocation of the affected key; verify the committee↔voter disjointness still holds (`GovernanceSeparationInvariant.t.sol`). |

---

## 4. Post-deployment verification

Every deploy that touches the voter set or quorum must re-run:

```bash
forge test --match-contract GovernanceSeparationInvariant   # committee ⊥ voter set
forge test --match-test testSignallingOnlyBoundary          # INV-4 static boundary
```

These fail loudly if the committee and approving bodies ever overlap or if the
receipt contract gains a `setWeights`/`execute` path.
