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
timelock (`docs/technical/governance-decisions.md` §3.3, `docs/technical/security-model.md` §4).
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

**Replacing RouterGovernance is a rotation, not a redeploy (core 1571).**
`MIN_QUORUM_THRESHOLD` is a `constant`, so a `RouterGovernance` deployed before
the floor change keeps the old floor of 1 and cannot be upgraded in place. The
same holds for a buggy instance. Replace it through the router's bounded
rotation of `WEIGHT_SETTER_ROLE` (ADR-0002, amendment 2026-10-07). Granting a
new `RouterGovernance` `ADMIN_ROLE` does not move `setWeights` authority,
because `setWeights` is gated on `WEIGHT_SETTER_ROLE`, which no role admin can
grant. Only the rotation moves it.

1. Deploy the new `RouterGovernance` against the existing router
   (`RouterGovernance.router` is an immutable). Its deployer sets quorum,
   voting power and delays, then hands its `ADMIN_ROLE` to the timelock. Voted
   weights and proposals start empty on the new instance.
2. The Safe calls `router.proposeWeightSetterRotation(newGovernance)` directly.
   It needs the Safe's 2-of-3 signatures. The target must be a contract. Only
   one proposal can be pending. The `WeightSetterRotationProposed` log and
   `pendingWeightSetterRotation()` make it observable, and the stage 12
   verifier fails while it is pending.
3. The Safe schedules ONE timelock batch (`scheduleBatch`) with three router
   calls, in this order: `executeWeightSetterRotation(newGovernance)`,
   `grantRole(ADMIN_ROLE, newGovernance)`, `revokeRole(ADMIN_ROLE, oldGovernance)`.
   Never schedule them separately. The execute call does not touch `ADMIN_ROLE`,
   so the old `RouterGovernance` would keep it (caps, quarantine, default
   weights) between operations. The batch runs once the timelock delay has
   passed (172800 s on 8453), counted from the proposal in step 2 and from the
   schedule. Anyone may then run the ready batch. To abort before execution, the
   Safe calls `router.cancelWeightSetterRotation()` and cancels the scheduled
   batch. The timelock cannot cancel.
4. Check after the batch: `getRoleMemberCount(WEIGHT_SETTER_ROLE) == 1`, the new
   instance holds `WEIGHT_SETTER_ROLE` and router `ADMIN_ROLE`, and the old
   instance holds neither. Check the router caps, `quarantineAddress` and
   default weights are unchanged (`routerCap`, `vaultCap[*]`,
   `quarantineAddress`, `getDefaultWeights`).
5. The target must not be able to grant `WEIGHT_SETTER_ROLE` to other accounts.
   Execution revokes every holder in a loop of about 19k gas per holder, so a
   target that floods the role with holders (1501 holders cost about 28.97M gas)
   could make the rotation unexecutable. The current `RouterGovernance` has no
   such path. Audit any other target for it before proposing. The router refuses
   itself, the Safe and the timelock as targets.
6. Update the governance entry of the governance manifest to the new address,
   then rerun the stage 12 verifier. Re-point the off-chain readers listed in
   redeploy step 7 that name the governance address (`VITE_GOVERNANCE_ADDRESS`,
   `governance_address`, `INDEXER_ROUTER_GOVERNANCE`).

The old instance cannot set weights after step 4. Its proposals, votes and
voting power do not carry over.

**Replacing the gateway or the router themselves.** The rotation does not cover
these. The gateway holds the router as an immutable, so a new router needs a
redeploy that cascades:

1. Deploy a new `PortfolioRouter`. Do not rerun `DeployPortfolioRouter.s.sol`
   against the existing deployment. It calls `registry.setRouterEligible` and
   `registry.setRouter` as the deployer, who no longer holds the registry
   `ADMIN_ROLE`, so it would revert. Deploy the router contract on its own.
   The constructor grants the deployer `ADMIN_ROLE` and `WEIGHT_SETTER_ROLE` on
   the new router, and the constructor defaults apply until you set otherwise.
   Order matters. While the deployer still holds `ADMIN_ROLE` on the new router,
   which is before the new router's `ADMIN_ROLE` moves to the timelock, the
   deployer sets `routerCap`, every `vaultCap[*]`, `quarantineAddress` and the
   default weights (`setRouterCap`, `setVaultCap`, `setQuarantineAddress`,
   `setDefaultWeights`). After that handover the same calls are Safe-scheduled
   timelock calls. Eligibility is already on the registry, so no
   `setRouterEligible` is needed. The default weights need one entry per
   router-eligible vault, so their length equals `registry.routerEligibleCount()`.
   The deployer's `WEIGHT_SETTER_ROLE` on the new router must be dropped too.
   Step 2 covers it.
2. Deploy a new `RouterGovernance` against it. `RouterGovernance.router` is an
   immutable. Voted weights, voting power and proposals start empty on the new
   instance. Run the stage 6 and 11 handoff again for the new pair.
3. Deploy a new gateway. `RobotMoneyGateway.routerContract` is an immutable.
   Depositors must authorize agents on the new gateway again. Hand the new
   gateway to the timelock as well (gateway `ADMIN_ROLE` handover), not only
   the router pair.
4. Deploy a new `InvestmentCommitteePolicy` and `ConsensusRecommendationReceipt`
   (`DeployInvestmentCommitteePolicy`). Both hold the gateway as an immutable,
   and the receipt also takes the IC policy as an immutable, so they bind the
   gateway address (`DeployGateway.s.sol`). Wire them on the new gateway with
   `setICPolicy` and `setConsensusReceipt`.
5. The Safe schedules and executes `VaultRegistry.setRouter(newRouter)` through
   the admin timelock. The deployer cannot do it: it no longer holds the
   registry `ADMIN_ROLE`. The registry does not need a redeploy because
   `setRouter` is repeatable. `setRouter(address(0))` is refused while the old
   router still carries default weights, so never unlink first. Re-link
   straight to the new router, whose default weights step 1 already set.
6. Retire the old router and gateway. `setRouter` does not stop them. The old
   gateway stays depositable, and its router still serves any deposit routed
   through it. The pause is `RobotMoneyGateway.pauseDeposits()` on the old
   gateway, which reverts both `deposit` entry points with `DepositsArePaused`.
   The holder of `DEPOSIT_PAUSER_ROLE` (the pauser key set at deploy, which the
   timelock handover does not touch) calls it directly. It needs no timelock
   call. Only `unpauseDeposits()` needs the timelock-held `ADMIN_ROLE`. Do not
   use the vault's `pauseDeposits()`. The vault is shared, so that would stop
   the new gateway as well. The old router has no switch of its own.
   `PortfolioRouter.deposit` and `depositFor` are public with no gateway gate,
   so pausing the old gateway does not stop direct deposits to the old router.
   No router-level call stops the old router. The only stop is the shared vault
   `pauseDeposits`, which also halts the new gateway, so do not use it. Treat
   the old router as still depositable, tell users to stop using it, and pause
   the old gateway. Each agent's owner may also call
   `revokeAgent` on the old gateway. Users withdraw through the old gateway,
   because `pauseDeposits` never freezes a withdrawal. Old receipts and old
   agent authorizations stay on the old contracts and do not move.
7. Re-point every off-chain reader at the new addresses:
   - dapp: `VITE_ROUTER_ADDRESS`, `VITE_GATEWAY_ADDRESS`, `VITE_GOVERNANCE_ADDRESS`
     (`clients/dapp/.env.example`) and the pinned `VITE_GATEWAY_EXPECTED_CODE_HASH`.
   - Rust payment client: `router_address`, `gateway_address`, `governance_address`
     and the pinned `gateway_runtime_hash` (`clients/rust-payment-client/config.example.toml`).
   - explorer indexer: `INDEXER_PORTFOLIO_ROUTER`, `INDEXER_ROUTER_GOVERNANCE`,
     `INDEXER_GATEWAY`, `INDEXER_CONSENSUS_RECEIPT` (`services/explorer-indexer/src/main.rs`).
   - publish-contracts manifests: the `router`, `gateway` and governance
     entries of the new deployment manifest (sheet keys `ROUTER_ADDRESS`,
     `GATEWAY_ADDRESS`, `GOVERNANCE_ADDRESS`, `IC_POLICY_ADDRESS`,
     `CONSENSUS_RECEIPT_ADDRESS` are read from manifests, never typed).

Old receipts stay readable on the old receipt contract but do not move to the
new one. Allocation state on the old router does not carry over either.

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
receipt contract's `ADMIN_ROLE` is held by the timelock). The operator runs the
publish-contracts govern row `release-receipt` (`bun publish-contracts/src/cli.ts
govern --row release-receipt --receipt-id 0x<64hex>` plus the usual chain, RPC,
sheet and signer arguments; on the Twin chain `bun scripts/stage/core-stack.ts
governance release --receipt-id 0x<64hex>` wraps it). The row runs on the Twin chain
and on 8453. On 8453 it is a standalone post-launch action, never part of stage 13 (the
three basket unpauses). The real Safe schedules `releaseReceipt` as its own timelock operation and the
CLI exits `GOVERN_PENDING` (exit 15) with the exact resume command. After the 48-hour delay (172800 s) the
same command makes the Safe execute it, and the CLI reads `isReleased` back. Record the release
in the evidence file under `receipt_releases` (see `publish-contracts/evidence.example.json`).
`update-delay`, `batch` and `cancel` stay Twin-only. No EOA can release. Release is signalling-
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
- the Safe → `TimelockController` → `ADMIN_ROLE` path, or
- any wallet the admin body controls.

rmpc has no `propose` command: it is not a governance signer.

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
