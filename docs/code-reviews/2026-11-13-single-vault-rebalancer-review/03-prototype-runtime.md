# Prototype runtime review

This first pass traced these attack candidates through the prototype contracts
and libraries. The evidence below records what the code does; it is not a claim
that the tests or simulations were rerun. No actionable runtime defect was
confirmed.

## Settlement bounds and cross-request value

**Candidate: combine a weakly bounded or stale price with a settlement.** The
settle path checks sequencer health, every active basket feed, and the USDC peg
before pricing (`FlowCheckLib.sol:203-218`). `FeedLib.read` rejects non-positive,
incomplete, future-dated, or stale rounds (`FeedLib.sol:29-50`). For each
basket asset, the queue takes a median of the slice TWAPs and enforces the
quorum (`FlowCheckLib.sol:221-229`, `TwapSlicesLib.sol:38-62`); it then rejects
a TWAP outside `refBandBps` of the outside feed and derives buy/sell bounds
from the stricter price mode (`FlowCheckLib.sol:231-242, 269-294`). The share
price breaker and lending-rate growth check run before the snapshot proceeds
(`FlowCheckLib.sol:117-130, 244-249, 297-326`). A transient spot push therefore
does not supply the settlement's price by itself; an unhealthy or stale
outside feed blocks the settlement, and disagreement outside the configured
band blocks it as well. These checks can delay flows by design. They do not
prove that every economically meaningful manipulation is unprofitable: the
proposal's own G8 result remains Fail (chapter 00).

**Candidate: use another request's loose limit or a favorable fill to make an
unfavorable request pass.** The walk screens each request against its own
limit before adding it to that side's fill set (`FlowSettleLib.sol:356-403`).
The fund calculates one batch fill, then checks each redeem fill against its
stored minimum (`FlowSettleLib.sol:564-579`) and each deposit fill against its
stored maximum (`FlowSettleLib.sol:697-709`). Redemption proceeds are split
pro rata and rounded down per request; unassigned rounding is booked as dust
(`FlowSettleLib.sol:565-596`). Deposit shares and refunds are likewise split
pro rata, and each request is independently checked (`FlowSettleLib.sol:669-728`).
The fund itself asserts proportional holdings after mint and sale
(`FundFlowsLib.sol:103-135, 152-183`). I found no path where a request with a
looser limit bypasses another included request's own realized-price check.
If a realized check fails, that side's whole self-call reverts and its
requests remain pending; this is a liveness cost, not a value transfer.

## Partial-side failure and callback attempts

**Candidate: make one failing venue or one side block the other side.**
`settle` runs redemption and deposit in separate self-calls and advances each
side's cursor according to that side's result (`FlowSettleLib.sol:162-169,
312-330`). The self-call has a fixed gas budget and capped revert-data copy;
failure emits `SideFailed` and returns false (`FlowSettleLib.sol:421-453`).
Because a revert rolls back the failed self-call's state, the other side can
still settle. A full-settlement revert is retained when the caller cannot
provide the complete fixed budget (`FlowSettleLib.sol:440-452`), preventing a
caller from selectively starving one side.

**Candidate: reenter queue state changes from a token, pool, adapter, or
receiver callback.** Stateful external queue entry points, including requests,
settlement, claims, pause controls, and parameter updates, carry the queue's
`nonReentrant` guard (`FlowQueue.sol:127-178, 201-213, 225-269`). The two
unguarded side entry points require `msg.sender == address(this)` before
calling settlement logic (`FlowQueue.sol:185-195`). The fund's flow mint and
sale paths are also role-gated and `nonReentrant` (`RobotMoneyFund.sol:318-342`).
I found no callback path in this trace that can reenter those state changes.

## Receipt application and claim ownership

**Candidate: apply an unrecorded, previously released, mismatched, or older
receipt, or apply a malformed asset vector.** `applyReceipt` requires
`TARGET_SETTER_ROLE`; it checks recorded status, release status, digest
equality, and strictly newer `recordedAt`, then releases and opens the fund
plan in the same transaction (`RebalanceGovernance.sol:135-160`). The fund's
`PlanMath.assetTargets` rejects unknown/inactive or duplicate assets, weights
over 10,000, a bad sum, a missing active asset, and lending targets above
`capBps` (`PlanMath.sol:59-95`; called by `FundAdminLib.sol:383-401`). A rejected
vector reverts the transaction, including receipt release. The contract does
not parse the payload to prove that the vector was derived from it; the
proposal assigns that comparison to the off-chain receipt/apply workflow
(proposal §4.1). I treated that stated boundary as design, not as a new code
finding.

**Candidate: redirect another user's pending or settled claim.** Deposit
delivery scans claims keyed by the selected owner and transfers shares only to
that owner (`FlowClaimLib.sol:188-217`). Redeem claim withdrawal requires
`msg.sender == owner`, though that owner may choose a receiver for the USDC
(`FlowClaimLib.sol:248-277`). Cancellation/expiry return escrow to the stored
owner, while `takeReturn` requires the claim owner and a currently active,
allowed freeze (`FlowClaimLib.sol:94-156, 317-341`). Queue-held balances are
tracked against booked obligations, and `sweep` sends only balance above
those obligations to the fund (`FlowClaimLib.sol:347-371`). These checks
blocked a claim-redirection path in the code trace. I did not execute an
exclusion-ledger recovery scenario.

## Disclosed setup caveat, not a confirmed finding

`FlowQueue.sol:305-310` checks `legBandBps` against the current maximum pool
fee when parameters are set. `FundAdminLib.addAsset` / `_checkBasket`
(`FundAdminLib.sol:87-104, 170-206`) do not repeat the queue-band check; the
queue source itself labels this a scaffold gap. If an added basket pool's fee
exceeds the current band, swaps against that asset can fail their per-leg
limits once the asset is held. Governance can raise the band after admission
and before assigning or operating the new target. This pass did not establish
an irreversible failure or an exploit path, so it is not indexed as a finding;
the deployment sequence must keep the band above fees of newly targeted
assets.

The proposal's documented G4 and G8 failures, G5 not-pass result, and G9 pass
remain experiment outcomes rather than newly reproduced findings. This first
pass did not reproduce them.
