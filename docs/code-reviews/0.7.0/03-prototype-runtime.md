# Prototype runtime review

This first pass traced these attack candidates through the prototype contracts
and libraries. The evidence below records what the code does; it is not a claim
that the tests or simulations were rerun. The first-pass traces below remain bounded observations; the expanded pass identifies RUN-01.

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

## RUN-01 — P2: asset admission can invalidate the queue's swap band

**Requirement:** proposal §5.9.5 requires `legBandBps` above the pool fee. `FlowQueue.sol:305-310` enforces this when queue parameters are set, but explicitly notes that later asset admission does not recheck it. `FundAdminLib.sol:87-104,197-206` admits an asset after checking the fee against only the fund's slippage and NAV-deviation bounds.

**Reachable configuration:** start with queue band 100 bps and existing pools below it. Between plans, admit a healthy, liquid new basket asset with a 100 bps fee while fund slippage and NAV guards are 200 bps. These fund bounds exceed the new fee and do not cause admission to reject. A new target can be opened through `FundAdminLib.openPlan:383-401`; its checks are vector validity and pool-share limits, not queue band compatibility. Rebalancing uses its own swap limits (`FundStepLib.sol:216-232`). The review did not execute this full admission-to-rebalance scenario on a fork.

Once the asset is held, proportional deposits must purchase it. With feed, TWAP and spot aligned, a purchase with a reference cost of 1,000,000 USDC base units requires at least ceil(1,000,000 / 0.99) = **1,010,102** units before price impact. `FlowCheckLib.sol:288-293` allows only **1,010,000** units at a 100 bps band. The exact-output purchase therefore cannot fill at that aligned market, even before price impact. The proportional purchase path is `FundFlowsLib.sol:103-135,199-214`. The failed deposit self-call leaves deposits pending. Redemption sale bounds can also be too tight at positive impact, but this report's quantified proof establishes the deposit case only.

This is a governed configuration defect, not a theft path or a failure demonstrated for the five deployed default assets. Cancellation and in-kind exits remain available. Governance can raise the queue band before assigning/funding the target; the missing guard permits omission of that required sequencing and a resulting outage. The first pass incorrectly used recoverability as a reason to discard it.

**Validation:** static call-path inspection plus executed Bun integer arithmetic returned `requiredAtZeroImpact=1010102, allowed=1010000, canExecute=false`. No Solidity transaction or fork reproduction was run. The source comment already discloses the gap; disclosure does not enforce the invariant.

**Remedy:** enforce compatibility on asset admission when a queue is bound, and before enabling a target that would fund the asset. Retain the queue parameter check. A regression should admit a valid pool at or above the current queue band and prove rejection or an atomic parameter adjustment before funding it.

## Additional recovery review

The expanded pass read `FundExclusionLedger`, queued-share checkpoints, `FundPositionLib` unit mint/burn and claim arithmetic, unreadable-lending in-kind exits, restore/drain reservation of existing claims, and `FlowEpochs` anchored epoch transitions. It found no additional confirmed defect in those traces. It did not execute exclusion/recovery or repeated-loss scenarios, so those observations are not an economic safety proof.

Current published outcomes are G4 step 3e Pass, G5 not pass, G8 Fail and G9 Pass. Historical G4 step 3 failure remains in the evidence log; it does not describe the current scored design.
