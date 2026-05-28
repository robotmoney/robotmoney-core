# ADR-0002: Router default weights live on-chain, not derived from the front-end

- **Status:** Accepted
- **Date:** 2026-05-27
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
