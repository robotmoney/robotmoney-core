# ADR-0002: Router default weights live on-chain, not derived from the front-end

- **Status:** Accepted (amended 2026-10-05 — see [Amendment — 2026-10-05](#amendment--2026-10-05-launch-default-weights-and-who-sets-active-weights))
- **Date:** 2026-05-27 (amended 2026-10-05)
- **Deciders:** Product owner (recorded reply 2026-05-27)
- **Related:** `docs/development/open-questions.md` §3.9; `contracts/RouterGovernance.sol`, `contracts/PortfolioRouter.sol`; public allocation surface at `robotmoney.net/allocation`

## Context

`RouterGovernance` runs an on-chain proposal/quorum/timelock cycle to
update Portfolio Router weights. When a proposal fails quorum, the
contract reverts with `QuorumNotReached` and weights hold at the
status quo — there is no explicit default-weight fallback.

The product owner has stated that the public allocation surface
(robotmoney.net/allocation) must show the *same* four-vault allocation
that the Router actually uses. Two implementations are possible:

1. The website is the source of truth: an indexer or the contract reads
   weights from the site (directly or via an off-chain attestation).
2. The chain is the source of truth: the website renders the on-chain
   default vector and votes determine deviations from it.

The product owner explicitly flagged the first option as unsafe: "we
don't want to just read these numbers from the website as someone might
hack the front end."

## Decision

**The chain is the source of truth.** Router default weights live in
contract state as an admin-settable `defaultWeights` vector (one bps
entry per Router-eligible vault, sum = 10_000). The public allocation
page renders this vector by reading the contract; it does not feed it.

The Router falls back to `defaultWeights` whenever the active proposal
state would otherwise leave weights undefined (no proposal in flight, or
the last proposal failed quorum). Successful proposals overwrite the
active weight vector, leaving `defaultWeights` untouched as the
post-vote fallback.

Updates to `defaultWeights` flow through the same Safe → Timelock →
`ADMIN_ROLE` path used elsewhere in the protocol; there is no
governance vote over the default itself in the MVP.

## Amendment — 2026-10-05: Launch default weights and who sets active weights

Owner decisions of 2026-10-05 (mainnet plan §2.2, §3.1, §3.5):

- **Launch `defaultWeights`** are rmUSDC 9500, rmPROTO 500, rmAGENT 0,
  rmRWA 0 bps. This records the values the original decision left out of
  scope ("an ops decision and not recorded here").
- **The deployer sets them before handover.** They are deploy-time
  configuration, set before the timelock stage (stage 11), not a
  governance step.
- **After handover the timelock sets `defaultWeights` only.** Active
  weights come only from `RouterGovernance` votes
  (`docs/technical/governance-isomorphism.md`).

Code state when this amendment was written (`impl/core-contracts`, core
PR 1505):

- `PortfolioRouter.setWeights` is gated on `WEIGHT_SETTER_ROLE`, the only
  `setWeights` gate. `RouterGovernance` is the only holder after the deploy
  ceremony: `DeployRouterGovernance` (stage 6) grants it and drops the
  deployer's copy, and the stage 12 verifier asserts the timelock, the
  deployer, the Safe, the pauser and the emergency key do not hold it.
  `setDefaultWeights` and `clearVotedWeights` stay on `ADMIN_ROLE`, the
  defaultWeights gate, which `DeployTimelock` grants to the timelock and
  `DeployRouterGovernance` grants to `RouterGovernance`. The timelock can
  therefore set `defaultWeights` and cannot call `setWeights` (core 1522).
- `_setDefaultWeights` requires one entry per router-eligible vault, each
  registered Active and eligible, summing to 10 000 bps. It does not
  refuse a 0 bps entry. Whether rmAGENT and rmRWA are marked eligible at
  0 bps or left ineligible is a sheet choice (devops 70, core 1520).
- The Twin stage sheet on this branch (`deployments/twin-918453/stage-sheet.env`)
  still carries `ROUTER_WEIGHTS=USDC:6000,PROTO:2500,RWA:1500`; the
  9500/500/0/0 vector is pending devops 70 and core 1520.

The on-chain source of truth, the fallback rule and the Safe → Timelock
path for `defaultWeights` are unchanged.

**Trade-off: `WEIGHT_SETTER_ROLE` cannot be granted or revoked by any role admin.**
The role is its own role admin and the deployer copy is revoked at stages 6
and 11. Making `ADMIN_ROLE` the role admin again would re-open the timelock
bypass that core 1522 closed. The only way to move the role is the bounded
rotation in the amendment below (core 1571): the Safe proposes, the timelock
executes after its delay, and execution leaves one holder. Replacing
`RouterGovernance` is therefore a rotation, not a redeploy. A redeploy of the
router, the gateway, and the IC policy and receipt that bind the gateway (each
holds its counterpart as an immutable) is only needed to replace the gateway or
the router themselves. The registry is re-linked with `setRouter`, which is
repeatable. After a rotation the old `RouterGovernance` still holds router
`ADMIN_ROLE` unless the same timelock batch revokes it (see the bounds below).

## Amendment — 2026-10-07: Bounded rotation of `WEIGHT_SETTER_ROLE`

Owner decision of 2026-10-07 on core 1571 (plan decision 23): replacing
`RouterGovernance` by redeploying the router, the gateway, the IC policy and
the receipt is **not** accepted. The router gets a bounded rotation path for
`WEIGHT_SETTER_ROLE` that does not reopen the timelock bypass closed by core
1522. Tracked by core 1616.

### Mechanism

Two new router roles, both **self-administered** (each is its own role admin,
exactly as `WEIGHT_SETTER_ROLE` is), so no `ADMIN_ROLE` holder can grant either:

- `WEIGHT_SETTER_ROTATOR_ROLE`: the Safe. It proposes and cancels.
- `WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE`: the timelock. It executes.

The router constructor seeds both to the deployer, as it does for the other
roles. `DeployTimelock` (stage 11) grants the rotator role to the Safe and the
executor role to the timelock, reads both back, and revokes the deployer's copy.

Three functions and one pending record (`pendingWeightSetterRotation`):

1. `proposeWeightSetterRotation(newHolder)`. Rotator only. `newHolder` must have
   contract code, so address(0), an EOA and a not-yet-deployed address revert.
   One proposal at a time. Stores `{newHolder, proposedAt}` and emits
   `WeightSetterRotationProposed`.
2. `cancelWeightSetterRotation()`. Rotator only. Clears the pending record and
   emits `WeightSetterRotationCancelled`. This is the cancel path.
3. `executeWeightSetterRotation(expectedNewHolder)`. Executor only. Requires a
   pending record whose holder equals `expectedNewHolder`, and
   `block.timestamp >= proposedAt + delay`, where `delay` is
   `getMinDelay()` read from the calling timelock. It clears the record, revokes
   `WEIGHT_SETTER_ROLE` from every current holder, grants it to `newHolder`, and
   emits `WeightSetterRotated`. Afterwards the role has exactly one holder.

The Safe reaches step 3 only as Safe to timelock `schedule` then `execute`, so
the timelock's own delay also applies, and the scheduled call carries
`expectedNewHolder`, so the target is public for the whole delay. The router-side
delay is measured from the proposal, so the Safe cannot propose late and execute
at once after scheduling early.

### The delay

The delay is the executing timelock's own `getMinDelay()`, not a number in the
router. The mainnet floor (172800 s, `MAINNET_DELAY_FLOOR`) is already enforced
where the timelock is built (`DeployTimelock` refuses a lower delay on 8453) and
where it is verified (stage 12). The router inherits that floor and Twin
inherits its short delay, so one codebase serves every chain. An executor
that does not answer `getMinDelay()` cannot execute at all.

### Why the 1522 bypass stays closed

1522 closed a path where `ADMIN_ROLE` (the timelock) could grant itself
`WEIGHT_SETTER_ROLE`. Here the timelock cannot propose (rotator role), cannot
grant itself the rotator role (self-administered), cannot grant the weight
setter role (self-administered), and can execute only a target the Safe
proposed. The Safe alone cannot execute (executor role) and cannot grant
anything on this role. The rotation target is whatever the Safe chose, so the
Safe and the timelock together can install a new weight setter after the
delay. That is the intended escape hatch, and it is the same authority that
already controls `ADMIN_ROLE` through the timelock, but it is delayed,
observable, and cannot be exercised by the timelock alone.

### What each actor can and cannot do

| Actor | Can | Cannot |
|---|---|---|
| Timelock alone | execute a rotation the Safe proposed, once the delay has passed (it administers the executor role, so it can also add executors, who still need a Safe proposal) | propose, cancel, grant itself either new role or `WEIGHT_SETTER_ROLE`, call `setWeights`, change the target |
| Safe alone | propose, cancel | execute, call `setWeights`, grant `WEIGHT_SETTER_ROLE`, shorten the delay |
| Safe plus timelock | rotate to a contract of the Safe's choosing after the delay | rotate to address(0) or a non-contract, execute before the delay, execute a target other than the pending one |
| Deployer | nothing after stage 11, which revokes its copies | hold any rotation role or `WEIGHT_SETTER_ROLE` after the handover |
| Emergency key, pauser | nothing here | propose, cancel, execute, set weights |
| Compromised `RouterGovernance` | set active weights (its job) and grant `WEIGHT_SETTER_ROLE` to others (as every self-administered holder can; the rotation revokes all holders) | propose, cancel or execute a rotation, because it holds neither rotation role and has no `getMinDelay()` |
| Compromised Safe | propose a hostile target | execute it without the timelock, whose delay lets honest parties react (the hostile `schedule` is public) |
| Compromised timelock | nothing alone | anything on this path without a Safe proposal |

A pending rotation is visible as a non-zero `pendingWeightSetterRotation()` and
as a `WeightSetterRotationProposed` log. The stage 12 verifier treats a pending
rotation as a failure (fail closed), so no run is accepted mid-rotation. After a
completed rotation the verifier reads the holder from the router (the single
member of `WEIGHT_SETTER_ROLE`) and expects it to equal the governance address
recorded in the manifest, so a rotation must be followed by the manifest update
described in the runbook.

### Additional bounds and limits (security review of core 1571)

- **Forbidden targets.** `proposeWeightSetterRotation` and
  `executeWeightSetterRotation` refuse the router itself, the caller, and any
  holder of either rotation role (`RotationTargetForbidden`). Rotating to the
  timelock would grant it `WEIGHT_SETTER_ROLE` at the Safe's choice and reopen the
  1522 path.
- **Old `ADMIN_ROLE`.** Execution moves `WEIGHT_SETTER_ROLE` only. The old
  `RouterGovernance` keeps router `ADMIN_ROLE`, so it could still change caps,
  the quarantine address and default weights. A rotation MUST therefore be
  scheduled as one atomic timelock batch: execute the rotation, grant the new
  governance `ADMIN_ROLE`, revoke the old one's `ADMIN_ROLE`. A fork test runs
  exactly this batch through the real Safe and timelock. The alternative, revoking
  `ADMIN_ROLE` inside the execute loop, needs a contract change and is the
  owner's call.
- **Holder flood.** Execution revokes every holder in a loop, about 19k gas per
  holder (1501 holders cost about 28.97M gas). A target that can grant
  `WEIGHT_SETTER_ROLE` to many accounts could push the loop past the block gas
  limit. The current `RouterGovernance` cannot. A target must not be able to
  grant the role.
- **Delay is the timelock's policy.** The rotation delay is the executing
  timelock's current `getMinDelay()`. The Safe plus timelock can lower it with
  `updateDelay` after one full delay, and a later rotation then uses the lower
  value. The floor is therefore the timelock's own policy (the stage 12 verifier
  and `DeployTimelock` hold it to the chain floor at deploy time).
- **Verifier.** Both rotation roles must have exactly one member, and
  `WEIGHT_SETTER_ROLE` exactly one holder.

### Design choices the owner should confirm

- **Who proposes.** Chosen: the Safe directly (separate on-chain actor). Alternative:
  the timelock proposes and the Safe consents, which makes the Safe's consent
  invisible to the router. Recommendation: keep the Safe as proposer.
- **Does `RouterGovernance` consent.** Chosen: no. The reason to rotate is that it
  may be broken or hostile, so requiring its consent would defeat the purpose.
- **Delay source.** Chosen: the executing timelock's `getMinDelay()`. Alternative:
  a literal 48 hours in the router, which would force 48 hours on Twin.
- **Cancel.** Chosen: rotator (Safe) only. The timelock cannot cancel, because a
  compromised `RouterGovernance` holds `ADMIN_ROLE` and must not be able to
  block its own replacement.
- **Cost.** Four more transactions at stage 11 (two grants, two deployer revokes).

## Consequences

**Positive.**

- A front-end compromise cannot redirect router flow. The contract is
  authoritative; the website is a view layer.
- Below-quorum behavior becomes explicit and inspectable on-chain
  rather than implicit "hold the last value" semantics.
- The "router weights = displayed allocation" invariant becomes a
  read-side property of the indexer/site, not a write-side constraint
  on the contract.

**Negative / accepted risks.**

- An admin update to `defaultWeights` takes effect at the next
  below-quorum window without a separate governance signal. This is
  consistent with how every other `ADMIN_ROLE` action works in the
  protocol (Safe + Timelock) and is judged acceptable for MVP.
- The product loses the ability to "tweak the allocation from the
  website" — every change must go through the on-chain admin path.
  Treated as desirable, not a regression.

**Out of scope of this decision.**

- Continuous smoothing / governance-whiplash blending between voted and
  default weights remains deferred. The fallback is binary (active vote
  result if quorum reached, `defaultWeights` otherwise).
- The specific allocation values that go into the first
  `defaultWeights` deployment are an ops decision and not recorded
  here.
- Indexer / website implementation of the read path is downstream and
  not covered by this ADR.
