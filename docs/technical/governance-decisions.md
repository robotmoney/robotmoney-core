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
  Rejected → Executed or Expired.

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

**Fallback.** If no proposal reaches quorum and the current weights become stale,
the protocol admin retains `ADMIN_ROLE` as an emergency override for the first
deployment cycle. A future phase must specify an on-chain fallback-weights
mechanism before the admin role is fully renounced.

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

```
Draft → Open → Passed → Executed
                      ↘ Expired (if not executed within 14 days)
       → Rejected
```

| State | Entry condition | Exit conditions |
|---|---|---|
| **Draft** | `createProposal()` called; validated weight vector stored. | Creator calls `openProposal()` or proposal is auto-opened at creation (design choice for implementation). |
| **Open** | Proposal is accepting votes. | Voting period ends (`block.timestamp >= openAt + votingPeriod`). |
| **Passed** | Voting period ended; quorum reached; yes > no. | `execute()` called after delay → Executed; or 14-day expiry → Expired. |
| **Rejected** | Voting period ended; quorum not reached OR no >= yes. | Terminal. |
| **Executed** | `execute()` succeeded; `PortfolioRouter.setWeights` was called. | Terminal. |
| **Expired** | Passed but not executed within 14 days. | Terminal. |

**Events.** The contract must emit:

- `ProposalCreated(uint256 proposalId, address proposer, address[] vaults, uint256[] bps, uint256 snapshotBlock)`
- `VoteCast(uint256 proposalId, address voter, bool support, uint256 power)`
- `ProposalPassed(uint256 proposalId, uint256 yesVotes, uint256 noVotes, uint256 quorumAtSnapshot)`
- `ProposalRejected(uint256 proposalId, uint256 yesVotes, uint256 noVotes)`
- `ProposalExecuted(uint256 proposalId, address[] vaults, uint256[] bps)`
- `ProposalExpired(uint256 proposalId)`
- `WeightsApplied(uint256 proposalId, address[] vaults, uint256[] bps)` (emitted alongside `PortfolioRouter.WeightsSet`)

### 3.6 setWeights call path

**Decision: `RouterGovernance.sol` is the only permitted caller of
`PortfolioRouter.setWeights` in production.**

`PortfolioRouter.setWeights` is currently gated by `ADMIN_ROLE`. The deployment
and wiring sequence is:

1. Deploy `RouterGovernance.sol` with `portfolioRouter` address as an immutable.
2. Current `ADMIN_ROLE` holder on `PortfolioRouter` calls
   `PortfolioRouter.grantRole(ADMIN_ROLE, routerGovernance)`.
3. Current `ADMIN_ROLE` holder on `PortfolioRouter` calls
   `PortfolioRouter.renounceRole(ADMIN_ROLE, admin)`.

After step 3, `routerGovernance` is the sole `ADMIN_ROLE` holder and the only
address that can call `setWeights`. No off-chain relay, multisig, or keeper is
in the weight-update path.

> **Status (mainnet plan, 2026-10-05).** The shipped wiring differs from steps
> 2 and 3. `DeployRouterGovernance.s.sol` grants RouterGovernance the router
> `ADMIN_ROLE`, and stage 11 (`DeployTimelock.s.sol`) also grants it to the
> TimelockController before revoking the deployer. Both can reach `setWeights`.
> Decided design: the timelock may set `defaultWeights` only
> (`setDefaultWeights`), and active weights come only from RouterGovernance
> votes. (Not yet implemented: core #1522.)

**Constraint.** `RouterGovernance.sol` must call `setWeights` only from its
`execute(proposalId)` function. No other function on the governance contract may
call `setWeights`.

**Emergency path.** The governance contract itself must include an `ADMIN_ROLE`
or `GUARDIAN_ROLE` that can pause proposal execution (but NOT directly call
`setWeights`). Emergency weight overrides require a governance proposal that
passes within a short emergency cadence. The exact emergency mechanism is
deferred to the `RouterGovernance.sol` implementation issue but must be
specified before the fork e2e.

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

- `PortfolioRouter.setWeights` role transfer (§3.6) cannot happen until
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

**Action.** `RouterGovernance.createProposal()` must validate the weight vector
against the registry at creation time. `execute()` must also re-validate (or the
implementation must document that execution can be blocked by vault deregistration
and handle the resulting Expired state gracefully).

### 6.4 Single active proposal constraint enforcement

**Risk.** Only one proposal may be Open at a time (§3.2). If the enforcement is
per-caller instead of global, a second proposer could bypass the cadence window.

**Action.** Enforcement must be global: the contract stores a single
`activeProposalId` state variable. `createProposal()` reverts if
`activeProposalId != 0` and the current proposal is still Open.

### 6.5 Emergency weight override before governance renouncement

**Risk.** §3.6 specifies that the admin renounces `ADMIN_ROLE` after wiring the
governance contract. If the governance contract has a bug (e.g., unable to reach
quorum because too little voting power is assigned), there is no path to update weights until the
governance contract is upgraded or redeployed.

**Action.** Before renouncing the admin role, confirm that the assigned voting
power can reach `quorumThreshold` in practice. The deploy script should include
a pre-flight check: `quorumThreshold <= totalVotingPower`. Document the emergency recovery path (redeploy
governance, re-grant ADMIN_ROLE) in the deploy runbook.

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

The following signatures are fixed by this ADR. Implementers must not change
these without a new ADR.

```solidity
/// @notice Return the currently active proposal (id=0 if none).
function activeProposal() external view returns (uint256 proposalId);

/// @notice Return vote tallies for a proposal.
function voteTallies(uint256 proposalId)
    external view
    returns (uint256 yesVotes, uint256 noVotes, uint256 snapshotQuorum);

/// @notice Return the weight vector most recently applied to the router
///         (the weights currently active on PortfolioRouter).
function currentWeights()
    external view
    returns (address[] memory vaults, uint256[] memory bps);

/// @notice Return governance timing parameters.
function cadenceParams()
    external view
    returns (
        uint256 cadenceWindow,   // 604800 — minimum seconds between proposals
        uint256 votingPeriod,    // 432000 — voting open duration in seconds
        uint256 executionDelay,  // 172800 — seconds after Passed before execute()
        uint256 expiryDelay      // 1209600 — seconds before a Passed proposal Expires
    );
```

These four read functions correspond to the `rmpc get-governance` output
contract specified in `docs/architecture.md` §4.4 and `Plan tracking issue #109`
§"Phase: Router-weight governance".
