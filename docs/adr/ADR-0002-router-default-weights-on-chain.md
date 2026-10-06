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

- `PortfolioRouter.setWeights` and `setDefaultWeights` are both gated on
  the same `ADMIN_ROLE`. `DeployTimelock` grants router `ADMIN_ROLE` to
  the timelock, and `DeployRouterGovernance` grants it to
  `RouterGovernance`. The timelock can therefore still call `setWeights`
  directly. The separate weight-setter role that limits the timelock to
  `defaultWeights` is core 1522 and is **not yet implemented**.
- `_setDefaultWeights` requires one entry per router-eligible vault, each
  registered Active and eligible, summing to 10 000 bps. It does not
  refuse a 0 bps entry. Whether rmAGENT and rmRWA are marked eligible at
  0 bps or left ineligible is a sheet choice (devops 70, core 1520).
- The Twin stage sheet on this branch (`deployments/twin-918453/stage-sheet.env`)
  still carries `ROUTER_WEIGHTS=USDC:6000,PROTO:2500,RWA:1500`; the
  9500/500/0/0 vector is pending devops 70 and core 1520.

The on-chain source of truth, the fallback rule and the Safe → Timelock
path for `defaultWeights` are unchanged.

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
