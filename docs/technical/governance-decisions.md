# ADR — Router-weight governance: quorum, cadence, voting power, execution delay, and setWeights call path

> Scope: dev-scout decision record for the Router-weight governance phase of
> `Plan tracking issue #109` §"Phase: Router-weight governance". Resolves all
> open questions that gate any `RouterGovernance.sol` code: quorum threshold,
> voting cadence, voting power model, execution delay, proposal lifecycle states,
> and the exclusive weight-update call path. No `RouterGovernance.sol` bytecode,
> explorer changes, or rmpc commands are produced by this scout.
>
> Closes the open question gate listed under `Plan tracking issue #109`
> §"Phase: Router-weight governance" item 1 and `docs/architecture.md` §10
> ("Router-weight governance implementation").

---

## 1. Status

Accepted. Authored 2026-05-15 against `docs/architecture.md` §2.3, §4.2, §10
and `docs/prd.md` §"Allocation Governance"; `docs/development/open-questions.md` §3.9 on branch
`chore/305-dev-scout-map-router-weight-governance-contract-`.

> **Reconciliation note.** §3 (Decisions) has been reconciled with the deployed
> `contracts/RouterGovernance.sol` and `docs/technical/smart-contracts.md` §9:
> the shipped MVP uses **admin-configurable** `quorumThreshold` /
> `votingPeriod` / `executionDelay` storage with `setQuorumThreshold` /
> `setVotingPeriod` / `setExecutionDelay` setters, bounded only by the constant
> floors `MIN_QUORUM_THRESHOLD = 2`, `MIN_VOTING_PERIOD = 1 hour`, and
> `MIN_EXECUTION_DELAY = 1 hour`, with `DeployRouterGovernance.s.sol` defaulting
> to 1 h / 1 h / quorum 2. The original 5 %-of-supply quorum, 7-day cadence,
> 5-day voting period, and 48 h execution delay were **early recommendations
> that were never hard-coded**. Voting power is admin-assigned, and there is no
> token-based governance (owner decision 2026-10-06), so no part of this record
> describes an RM-token voting design.

---

## 2. Context

`docs/architecture.md` §2.3 fixes the governance boundary: router-weight
governance controls Portfolio Router target weights across active vaults and
nothing else. It cannot govern vault onboarding, vault retirement, per-vault
asset selection, per-vault strategy internals, adapter selection, adapter caps,
fees, or agent permissions.

`docs/architecture.md` §10 flags the governance implementation as an open
decision: "PRD fixes the governance surface but not the voting contract, cadence
enforcement, quorum, delay, or execution path."

`docs/prd.md` §"Allocation Governance" fixes the product surface:

- Voters with admin-assigned voting power review active allocation-weight
  proposals and cast votes.
- The product publishes vote outcome, execution state, and resulting weights.
- The governance proposal lifecycle is: Draft → Open for voting → Approved or
  Rejected → Executed or Expired. (This is the PRD wording. The shipped
  states are in §3.5.)

`docs/development/open-questions.md` §3.9 confirms that quorum threshold and fallback rules are TBD.

`contracts/PortfolioRouter.sol` is already deployed. Its `setWeights(address[],
uint256[])` function is the only mechanism that updates the weight vector; it
requires `ADMIN_ROLE`. The governance contract must be granted `ADMIN_ROLE` by
the current admin. After granting, the current admin should revoke its own
`ADMIN_ROLE` so that governance is the sole weight-update path.

Five questions must be resolved before any `RouterGovernance.sol` implementation
issue begins:

1. **Quorum threshold.** How much voting power must vote for a proposal to
   be executable?
2. **Voting cadence.** How frequently can a proposal be submitted?
3. **Voting power model.** How is each voter's weight calculated?
4. **Execution delay.** How long after quorum is reached before weights are
   applied?
5. **setWeights call path.** What contract is the sole caller of
   `PortfolioRouter.setWeights`?

---

## 3. Decisions

### 3.1 Quorum threshold

**Shipped (MVP): admin-configurable absolute voting-power threshold,
`quorumThreshold`, bounded below by `MIN_QUORUM_THRESHOLD = 2`.**

As deployed in `contracts/RouterGovernance.sol`, quorum is an absolute amount of
FOR voting power — the `quorumThreshold` storage variable — **not** a 5 %-of-
`RM.totalSupply()` denominator. A proposal reaches quorum when its `votesFor`
meets or exceeds the threshold captured at `propose()` time (`snapshotQuorum`),
so a later `setQuorumThreshold` call does not retroactively defeat or pass an
in-flight proposal.

`ADMIN_ROLE` adjusts the live value via `setQuorumThreshold(uint256)`, which
reverts (`QuorumBelowMinimum`) for any value below the constant floor
`MIN_QUORUM_THRESHOLD = 2`. The floor was `1` through the MVP, which required
only that *some* vote be cast — a bar one voter clears alone, making the
separate-body approval this contract exists to provide hollow. It is now `2`, so
no single voter can carry a weight change, and the constructor and
`setQuorumThreshold` enforce it identically: a configured deployment cannot be
walked back down to a single-voter quorum after the fact.
`contracts/script/DeployRouterGovernance.s.sol` deploys with
`quorumThreshold = 2` (`DEFAULT_QUORUM_THRESHOLD`) and additionally refuses an
explicit `QUORUM_THRESHOLD <= 1` before spending any gas. This matches the
admin-assigned voting-power model of the MVP (voting power is assigned by
`ADMIN_ROLE` via `setVotingPower`, not derived from RM balances).

Raising the floor changed `RouterGovernance` bytecode. A governance contract
deployed before the change keeps the old floor; the fix is a **redeploy** of
`RouterGovernance` (and a re-grant of router `ADMIN_ROLE` to the new instance),
not an upgrade. See `docs/technical/router-governance-handoff-runbook.md` §1.1.

**Not adopted.** The whitepaper's "5 % quorum" parameter
(`docs/development/open-questions.md` §3.9) was a share of RM supply. There is
no token-based governance, so quorum is always an absolute amount of
admin-assigned voting power. The cliff problem
(`docs/development/open-questions.md` §3.9) is noted in §6.2 below.

**Fallback.** If no proposal reaches quorum, the router routes by its default
weight vector. `PortfolioRouter` keeps `defaultWeights` next to the voted vector
and uses it while `votedWeightsActive` is false. `RouterGovernance.setDefaultWeights`
and `clearVotedWeights` forward to the router and are `ADMIN_ROLE` only, so after
stage 11 they go Safe -> Timelock -> `ADMIN_ROLE` (ADR-0002). Nothing in the
fallback needs `ADMIN_ROLE` on the router to call `setWeights` (see §3.6).

### 3.2 Voting cadence

**Shipped (MVP): single-active-proposal cadence; no fixed inter-proposal
window.**

Only one proposal may be Active or Queued at a time. A new proposal cannot be
submitted until the current proposal is resolved (Executed, Defeated, or
Cancelled). The deployed `contracts/RouterGovernance.sol` has **no**
`cadenceWindow` variable and does **not** enforce a 7-day gap between proposal
creation timestamps; the only cadence constraint is the single-active-proposal
rule.

**Not a contract constant.** The "weekly allocation" /
"monthly votes" references (`docs/development/open-questions.md` §1.4) describe a
minimum inter-proposal cadence — e.g. a 7-day window — that the contract does
not enforce. Any such cadence is an operating policy of the `ADMIN_ROLE`
proposer.

**Voting period.** Each proposal's voting window is the `votingPeriod` storage
variable, **not** an immutable. `ADMIN_ROLE` adjusts it via
`setVotingPeriod(uint64 seconds)`, which reverts (`VotingPeriodBelowMinimum`)
for any value below the constant floor `MIN_VOTING_PERIOD = 1 hour`.
`contracts/script/DeployRouterGovernance.s.sol` deploys with a 1-hour voting
period (`DEFAULT_VOTING_PERIOD = 3600` seconds). A 5-day (432 000-second) voting
period was an early recommendation, not the shipped default.
When the period elapses the proposal transitions to `Queued` (quorum reached) or
`Defeated`.

### 3.3 Voting power model

**Shipped: admin-assigned voting power, read at the proposal snapshot block.**

`ADMIN_ROLE` sets each voter's power with `setVotingPower(voter, power)`. Every
change is checkpointed by block number. `propose()` records
`voteSnapshot = block.number`, and `vote()` reads the voter's power at that
block via `_getPastVotes`, so a power change after proposal creation does not
change an in-flight tally. Votes are additive; no tier system, no activity
gate, no delegation mechanism is specified for this phase.

There is no token-based governance. Voting power is never derived from RM
balances, and `RouterGovernance` reads no RM-token interface.

**No tiers.** `docs/development/open-questions.md` §1.5 records the open status of
Observer/Participant/Analyst/Strategist tiers. No tier system or CFO Feed
activity gate is specified for router-weight voting.

**Delegation.** Vote delegation is out of scope for this phase (listed as out of
scope in `Plan tracking issue #109` §"Phase: Router-weight governance").

### 3.4 Execution delay

**Shipped (MVP): admin-configurable `executionDelay` storage, bounded below by
`MIN_EXECUTION_DELAY = 1 hour`.**

A `Queued` proposal may be executed by any caller after its execution delay
elapses. `execute(proposalId)` confirms the proposal is `Queued` and the delay
has passed, then calls `PortfolioRouter.setWeights(vaults, bps)`.

The delay is the `executionDelay` storage variable, **not** an immutable.
`ADMIN_ROLE` adjusts it via `setExecutionDelay(uint64 seconds)`, which reverts
(`ExecutionDelayBelowMinimum`) for any value below the constant floor
`MIN_EXECUTION_DELAY = 1 hour`. `contracts/script/DeployRouterGovernance.s.sol`
deploys with a 1-hour execution delay (`DEFAULT_EXECUTION_DELAY = 3600`
seconds). A 48-hour (172 800-second) execution delay was an early
recommendation, not the shipped default.

**Rationale.** Enforcing a non-zero minimum delay (1 hour) prevents a proposal
from being executed in the same block its voting deadline passes, giving
voters, auditors, or the protocol admin time to react to a malicious weight
vector before it takes effect. The exact production value is an admin policy
choice within `[MIN_EXECUTION_DELAY, ∞)`, not a contract constant.

### 3.5 Proposal lifecycle states

The deployed `ProposalState` enum in `contracts/RouterGovernance.sol` has five
states: `Active`, `Defeated`, `Queued`, `Executed`, `Cancelled`.

| State | Entry condition | Exit conditions |
|---|---|---|
| **Active** | `propose()` succeeded (`ADMIN_ROLE` only). Voters cast FOR votes until `votingDeadline`. | Voting period ends: `Queued` if `votesFor >= snapshotQuorum`, else `Defeated`. `cancel()` moves it to `Cancelled`. |
| **Defeated** | Voting period ended with `votesFor < snapshotQuorum`. | Terminal. Does not block a new proposal. |
| **Queued** | Voting period ended with quorum reached. | Any caller may `execute()` once `executableAfter` has passed. `cancel()` moves it to `Cancelled`. |
| **Executed** | `execute()` called `PortfolioRouter.setWeights`. | Terminal. |
| **Cancelled** | `ADMIN_ROLE` called `cancel()` before execution. | Terminal. Does not block a new proposal. |

There is no `Draft`, `Rejected`, `Passed` or `Expired` state. There is no
against-vote: `vote(proposalId)` only adds FOR power, and a proposal that is
Queued does not expire.

**Events.** The contract emits `ProposalCreated`, `VoteCast`, `ProposalExecuted`,
`WeightsApplied`, `ProposalCancelled`, `QuorumThresholdSet`, `VotingPeriodSet`,
`ExecutionDelaySet` and `VotingPowerSet`. Exact signatures are in
`contracts/RouterGovernance.sol`.

### 3.6 setWeights call path

**Decision: `RouterGovernance.sol` is the only permitted caller of
`PortfolioRouter.setWeights` in production.**

`PortfolioRouter.setWeights` is gated by `WEIGHT_SETTER_ROLE` (core 1522), not by
`ADMIN_ROLE`. `RouterGovernance.execute(proposalId)` is the only function in
`contracts/RouterGovernance.sol` that calls `setWeights`.

- `DeployRouterGovernance.s.sol` grants RouterGovernance `WEIGHT_SETTER_ROLE` and
  drops the deployer's copy.
- Stage 11 (`DeployTimelock.s.sol`) grants the TimelockController `ADMIN_ROLE`
  only, which reaches `setDefaultWeights` and `clearVotedWeights`. A direct
  `setWeights` from the timelock reverts, so active weights come only from
  RouterGovernance votes.
- `WEIGHT_SETTER_ROLE` is its own role admin. `ADMIN_ROLE` is not its admin, so the
  timelock cannot grant itself the role through a scheduled operation.
- Rotation (core 1616): RouterGovernance is replaced without a router redeploy
  through a bounded rotation, not through a role grant. The Safe holds
  `WEIGHT_SETTER_ROTATOR_ROLE` and proposes a contract target on the router
  (`proposeWeightSetterRotation`). The timelock holds
  `WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE` and executes it after the timelock's own
  delay, measured from the proposal (`executeWeightSetterRotation`). The Safe can
  cancel. Execution revokes every holder and grants the target, so one holder
  remains. Neither the timelock nor the Safe can grant either role or
  `WEIGHT_SETTER_ROLE` (all three are self-administered). Design and threat table:
  ADR-0002, amendment 2026-10-07.

RouterGovernance holds `ADMIN_ROLE` on the router as well, because
`RouterGovernance.setDefaultWeights` and `clearVotedWeights` forward to router
functions gated by it (`DeployTimelock.s.sol` asserts this before it finishes).
No admin renounces anything to make RouterGovernance the weight setter: the role
split above does that. No off-chain relay, multisig, or keeper is in the
weight-update path.

**Constraint.** `RouterGovernance.sol` calls `setWeights` only from its
`execute(proposalId)` function.

**Emergency path.** `RouterGovernance` has no pause or guardian role. The
emergency levers are `cancel(proposalId)` (`ADMIN_ROLE`) for a proposal that has
not executed, and `clearVotedWeights` to return routing to the default vector.
Both go through the timelock after stage 11.

---

## 4. Voting-power source

`RouterGovernance.sol` requires no token interface. Voting power is
admin-assigned through `setVotingPower` and checkpointed in the contract
(§3.3). There is no token-based governance (owner decision 2026-10-06).

---

## 5. Downstream unblocked issues and sequencing

All items below are in `Plan tracking issue #109` §"Phase: Router-weight
governance".

| Issue | Unblocked by this ADR? | Must serialize after |
|---|---|---|
| `RouterGovernance.sol` — proposal creation, voting, quorum, execution | Yes — all parameters fixed | This ADR |
| `RouterGovernance.sol` read surface (`activeProposal`, `voteTallies`, etc.) | Yes — proposal lifecycle states fixed | This ADR |
| Explorer: `governance_proposals` and `governance_votes` tables | Yes — events are specified | `RouterGovernance.sol` deployed |
| Explorer API: governance endpoints | Yes | Explorer tables |
| `rmpc get-governance` | Yes — output shape implied by lifecycle | `RouterGovernance.sol` + explorer API |
| Fork e2e: propose → vote → execute | Yes | All above |

**Parallel work that is safe:**

- `RouterGovernance.sol` core implementation and explorer schema additions can
  begin in parallel.
- `rmpc get-governance` can be stub-implemented against the read-surface
  function signatures defined here.

**Strict serial dependency:**

- The `WEIGHT_SETTER_ROLE` grant (§3.6) cannot happen until
  `RouterGovernance.sol` is deployed to the target network. Deploy scripts must
  sequence this explicitly.
- Fork e2e requires both the governance contract and the router to be deployed
  and wired; it must run after the deploy script is complete.

---

## 6. Integration risks and open questions deferred to implementation

The following risks were discovered during scouting. They are not blockers for
implementation issues to begin (except where noted), but each assigned
implementer must address them.

### 6.1 Voting-power snapshot (resolved)

**Resolution.** `vote()` reads admin-assigned power at the proposal's
`voteSnapshot` block from the contract's own checkpoints (§3.3). A
`setVotingPower` call after `propose()` cannot change an in-flight tally. No
token snapshot is needed because there is no token-based governance.

### 6.2 Quorum cliff / governance whiplash (design risk)

**Risk.** `docs/development/open-questions.md` §3.9 flags that a hard quorum cliff causes
governance whiplash: participation just below quorum falls back to the existing
weights, participation just above quorum applies the voted weights, with no
smooth transition.

**Action.** The `RouterGovernance.sol` implementation issue must decide whether
to add a blend or accept the cliff. The cliff is acceptable for a first
deployment if the voter set is small; a blend requires more complex contract
logic. The implementation issue owner decides.

### 6.3 Weight validation in proposals

**Risk.** `PortfolioRouter.setWeights` requires all proposed vault addresses to
be registered in `VaultRegistry` and the bps sum to exactly 10 000. If a vault
is deregistered between proposal creation and execution, `execute()` will revert
and the proposal cannot be executed.

**Action.** `RouterGovernance.propose()` validates every vault with
`router.isRouterEligibleAndActive` and the bps sum at creation time. `execute()`
calls `setWeights`, which validates again, so a vault that becomes ineligible
after proposal creation makes `execute()` revert.

### 6.4 Single active proposal constraint enforcement

The rule is global. `propose()` reverts with `ActiveProposalExists` while the
latest proposal (`currentProposalId`) is `Active` or `Queued`. `Defeated` and
`Cancelled` proposals do not block a new one.

### 6.5 Governance that cannot reach quorum

**Risk.** If too little voting power is assigned to reach `quorumThreshold`, no
proposal can pass and `setWeights` cannot be called.

**Action.** Before the handover, confirm that the assigned voting power can reach
`quorumThreshold`. Routing is not stuck meanwhile: the router uses its default
vector (§3.1 fallback). Replacing a broken RouterGovernance uses the rotation in
§3.6. The runbook is `docs/technical/router-governance-handoff-runbook.md`.

### 6.6 No outer share token constraint propagation

**Risk.** The governance contract routes shares to individual vault addresses via
`PortfolioRouter.setWeights`. Adding an outer share token or LP token in any
governance-adjacent contract would violate `docs/architecture.md` §2.2
("Receipt tokens remain visible as underlying vault receipts; no outer share
token").

**Action.** `RouterGovernance.sol` must not introduce any token minting,
wrapping, or LP mechanics. The governance contract's only on-chain side effect
is calling `PortfolioRouter.setWeights`.

---

## 7. Read surface — function signatures for `RouterGovernance.sol`

The read surface below is what `contracts/RouterGovernance.sol` exposes. There
is no `voteTallies` function: the tally is `votesFor` and `snapshotQuorum` in the
`activeProposal()` return. Implementers must not change these without a new ADR.

```solidity
/// @notice Latest proposal (reverts NoActiveProposal if none was ever made).
function activeProposal() external view returns (
    uint256 id, address proposer, address[] memory vaults, uint256[] memory bps,
    uint64 votingDeadline, uint64 executableAfter, uint256 votesFor,
    uint256 snapshotQuorum, bool executed, bool cancelled
);

/// @notice State of one proposal.
function proposalState(uint256 proposalId) external view returns (ProposalState);

/// @notice The weight vector currently active on PortfolioRouter.
function currentWeights() external view returns (address[] memory vaults, uint256[] memory bps);

/// @notice Governance parameters in one call.
function cadenceParams() external view returns (
    uint64 votingPeriod, uint64 executionDelay, uint256 quorumThreshold, uint256 totalVotingPower
);
```

These read functions correspond to the `rmpc get-governance` output
contract specified in `docs/architecture.md` §4.4 and `Plan tracking issue #109`
§"Phase: Router-weight governance".
