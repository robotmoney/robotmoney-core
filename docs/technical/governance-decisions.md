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
> floors `MIN_QUORUM_THRESHOLD = 1`, `MIN_VOTING_PERIOD = 1 hour`, and
> `MIN_EXECUTION_DELAY = 1 hour`, with `DeployRouterGovernance.s.sol` defaulting
> to 1 h / 1 h / quorum 1. The original 5 %-of-`RM.totalSupply()` quorum, 7-day
> cadence, 5-day voting period, and 48 h execution delay were **ADR-recommended
> targets that were never hard-coded**; they remain deferred token-holder-
> governance goals. §4 onward describes that deferred RM-token-snapshot design,
> not shipped contract behaviour.

---

## 2. Context

`docs/architecture.md` §2.3 fixes the governance boundary: `$RM`
governance controls Portfolio Router target weights across active vaults and
nothing else. It cannot govern vault onboarding, vault retirement, per-vault
asset selection, per-vault strategy internals, adapter selection, adapter caps,
fees, or agent permissions.

`docs/architecture.md` §10 flags the governance implementation as an open
decision: "PRD fixes the governance surface but not the voting contract, cadence
enforcement, quorum, delay, or execution path."

`docs/prd.md` §"Allocation Governance" fixes the product surface:

- Token holders review active allocation-weight proposals and cast votes.
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

1. **Quorum threshold.** What fraction of RM token supply must vote for a
   proposal to be executable?
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
`quorumThreshold`, bounded below by `MIN_QUORUM_THRESHOLD = 1`.**

As deployed in `contracts/RouterGovernance.sol`, quorum is an absolute amount of
FOR voting power — the `quorumThreshold` storage variable — **not** a 5 %-of-
`RM.totalSupply()` denominator. A proposal reaches quorum when its `votesFor`
meets or exceeds the threshold captured at `propose()` time (`snapshotQuorum`),
so a later `setQuorumThreshold` call does not retroactively defeat or pass an
in-flight proposal.

`ADMIN_ROLE` adjusts the live value via `setQuorumThreshold(uint256)`, which
reverts (`QuorumBelowMinimum`) for any value below the constant floor
`MIN_QUORUM_THRESHOLD = 1`; at least one vote must always be required so a
proposal cannot pass with zero votes cast. `contracts/script/DeployRouterGovernance.s.sol`
deploys with `quorumThreshold = 1` (`DEFAULT_QUORUM_THRESHOLD`). This matches the
admin-assigned voting-power model of the MVP (voting power is assigned by
`ADMIN_ROLE` via `setVotingPower`, not derived from RM balances).

**Deferred target (not shipped).** The whitepaper's "5 % quorum" parameter
(`docs/development/open-questions.md` §3.9) is a future *token-holder*-governance
target — a participation floor expressed as 5 % of `RM.totalSupply()` at a
snapshot block — that is **not** hard-coded in the current contract and only
becomes relevant once RM-balance snapshot voting (§3.3, §6.1) lands. The cliff
problem (`docs/development/open-questions.md` §3.9) is noted in §5 below.

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

**Deferred target (not shipped).** The "weekly allocation" /
"monthly votes" references (`docs/development/open-questions.md` §1.4) describe a
minimum inter-proposal cadence — e.g. a 7-day window — that is a future
token-holder-governance target, not a current contract constant.

**Voting period.** Each proposal's voting window is the `votingPeriod` storage
variable, **not** an immutable. `ADMIN_ROLE` adjusts it via
`setVotingPeriod(uint64 seconds)`, which reverts (`VotingPeriodBelowMinimum`)
for any value below the constant floor `MIN_VOTING_PERIOD = 1 hour`.
`contracts/script/DeployRouterGovernance.s.sol` deploys with a 1-hour voting
period (`DEFAULT_VOTING_PERIOD = 3600` seconds). A 5-day (432 000-second) voting
period is a deferred token-holder-governance target, not the shipped default.
When the period elapses the proposal transitions to `Queued` (quorum reached) or
`Defeated`.

### 3.3 Voting power model

**Decision: linear by RM balance at proposal snapshot block.**

Each voter's power equals their `RM.balanceOf(voter)` at the snapshot block
captured at proposal creation. Votes are additive; no tier system, no activity
gate, no delegation mechanism is specified for this phase.

**RM token interface assumptions:**

- `RM.balanceOf(address)` — ERC-20 standard; must return the balance at the
  current block when called inside the `vote()` function.

  > **Risk:** ERC-20 does not natively support historical balance reads.
  > `RouterGovernance.sol` must snapshot balances at proposal creation or use
  > an on-chain snapshot mechanism. See §5.1 for the snapshot integration risk.

- `RM.totalSupply()` — ERC-20 standard; would return the total supply at the
  snapshot block to calculate a percentage-of-supply quorum denominator. This is
  only relevant to the deferred token-holder-governance target (§3.1); the
  shipped MVP uses an absolute `quorumThreshold` and admin-assigned voting power,
  so it does not read `RM.totalSupply()`.

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
seconds). A 48-hour (172 800-second) execution delay is a deferred
token-holder-governance target, not the shipped default.

**Rationale.** Enforcing a non-zero minimum delay (1 hour) prevents a proposal
from being executed in the same block its voting deadline passes, giving token
holders, auditors, or the protocol admin time to react to a malicious weight
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
- `ProposalPassed(uint256 proposalId, uint256 yesVotes, uint256 noVotes, uint256 totalSupplyAtSnapshot)`
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

## 4. RM-token contract interface assumptions

The following interface is assumed by `RouterGovernance.sol`. The RM-token
contract must satisfy these before the governance contract is deployed.

```solidity
/// Minimum interface required of the RM token by RouterGovernance.
interface IRM {
    /// ERC-20: current balance. Used during vote() to record voter power.
    function balanceOf(address account) external view returns (uint256);

    /// ERC-20: total supply. Used at proposal creation to fix the quorum
    /// denominator (5% of totalSupply at snapshotBlock).
    function totalSupply() external view returns (uint256);
}
```

**Snapshot risk.** Standard ERC-20 does not support historical balance reads.
The implementation must choose one of:

1. **Block-level snapshot at creation.** `RouterGovernance` calls
   `RM.totalSupply()` at `createProposal()` and stores it as
   `proposal.snapshotSupply`. Voter balances are read at `vote()` time (current
   block, not snapshot block). This is simpler but allows voters to transfer RM
   between proposal creation and their vote to double-count voting power. This
   is acceptable for a minimal first governance contract if the voting period is
   short (5 days) and there is no liquid RM trading market yet.

2. **ERC-20 Votes / EIP-5805 snapshot.** The RM token implements
   `getPastTotalSupply(blockNumber)` and `getPastVotes(account, blockNumber)`.
   `RouterGovernance` captures `snapshotBlock = block.number` at proposal
   creation and reads historical balances at vote time. This is the correct
   long-term design.

**Decision:** The implementation issue must confirm which snapshot mechanism the
RM token supports before writing `vote()`. If ERC-20 Votes is available, use
option 2. If not, use option 1 with a documented upgrade path. This is a
**blocker** for the `RouterGovernance.sol` implementation issue; see §5.1.

---

## 5. Downstream unblocked issues and sequencing

All items below are in `Plan tracking issue #109` §"Phase: Router-weight
governance".

| Issue | Unblocked by this ADR? | Must serialize after |
|---|---|---|
| `RouterGovernance.sol` — proposal creation, voting, quorum, execution | Yes — all parameters fixed | This ADR + RM-token snapshot clarification |
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

### 6.1 RM-token snapshot mechanism (blocker for vote() implementation)

**Risk.** `RouterGovernance.sol` cannot implement safe historical-balance voting
without knowing whether the RM token implements ERC-20 Votes (EIP-5805). If it
does not, voter balances are live at `vote()` time, enabling flash-loan or
transfer-then-vote manipulation.

**Action.** Before writing `vote()`, confirm the RM token's snapshot interface.
If ERC-20 Votes is not available, the implementation must document the
limitation explicitly and plan an upgrade. This is a blocker for `vote()`
correctness, not for `createProposal()` or the proposal state machine.

### 6.2 Quorum cliff / governance whiplash (design risk)

**Risk.** `docs/development/open-questions.md` §3.9 flags that a hard 5 % quorum cliff causes
governance whiplash: just-below-5 % participation falls back to the existing
weights, just-above-5 % applies the voted weights, with no smooth transition.

**Action.** The `RouterGovernance.sol` implementation issue must decide whether
to add a blend or accept the cliff. The cliff is acceptable for a first
deployment if the community is small; a blend requires more complex contract
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
quorum due to low RM distribution), there is no path to update weights until the
governance contract is upgraded or redeployed.

**Action.** Before renouncing the admin role, confirm that the RM token has
sufficient distribution for the 5 % quorum to be reachable in practice. The
deploy script should include a pre-flight check: `RM.totalSupply() * 0.05 <=
sum(balancesOf known_voters)`. Document the emergency recovery path (redeploy
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
    returns (uint256 yesVotes, uint256 noVotes, uint256 snapshotSupply);

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
