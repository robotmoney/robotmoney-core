# One-vault experiment: engineering plan for hardened, timed flows (step 3d)

Status: plan, 2026-11-11, fourth version. It implements §4.5 and §5.9 of
`docs/technical/one-vault-rebalancer-proposal.md` (step 3d, D10 to D15, RB-10
to RB-18 and RB-20 to RB-22, gates G8 and G9).

History of the versions:

1. Flows priced at checkpointed NAV. A review found flaws (proposal §15).
2. Flows settled by quantity (D11).
3. Four layers of checks, approved by the owner (proposal §16.4).
4. This version. An adversarial review of the approved design found holes
   (proposal §17). The owner's rule for fixing them: safety before
   simplicity. Every protective layer stays. The match between users, the
   settler's price and selection inputs and the entry premium are removed,
   because they protected nobody.

This plan runs on the prototype under `contracts/test/prototype/` only.
Production contracts and canonical docs do not change. The experiment's rules
still hold: forge tests on the recorded Base fixture, with no RPC in a test
run.

## 1. Goal

Make the fund safe against price-manipulation drains like the Makina exploit
without trusting any price. Measure what that costs. Concretely:

1. Show, by test, which attacks work against the synchronous fund of step 3c.
2. Build timed flows that settle by quantity under four layers of checks:
   the queue, the in-fund pro-rata purchase and sale, limits decided by the
   chain, the checks of proposal §5.9.3, the hold and the freeze.
3. Run the same attacks against the timed fund. Score G8 from the results.
4. Measure the cost of a flow, the wait and how often each check blocks.
   Score G9 from the results.

## 2. Design decisions

Each row follows proposal §5.9. The rule above all rows: quantity sets every
share minted or burned, no price moves value between two parties, and prices
only bound a trade or stop a settlement.

| ID | Decision | Choice | Why |
| --- | --- | --- | --- |
| E1 | The queue | A new `FlowQueue` contract. It is the entry point for requests and claims. It holds pending USDC, escrowed shares and shares in their hold. Only it may call the fund's pro-rata purchase and sale (`FLOW_ROLE`, bound once at wiring, under the same upgrade timelock as the fund). | The fund has 1,556 bytes left under G1. Custody of the fund's assets stays in the fund. |
| E2 | Interface | As listed in proposal §5.9.6. The queue has `requestDeposit`, `requestRedeem`, claims through `deposit`, `mint` and `redeem`, reverting previews, pending and claimable views, `cancel`, `exitInKind`, and the quote views. The fund is the share token. Its own `deposit`, `mint` and `redeem` revert and name the queue. `withdraw` reverts `RedeemOnly`. There are no operators. | Owner, 2026-11-11: follow the best hardened practice, not the ERC letter. ERC-7575 describes the split of entry point and share. |
| E3 | Deposit | `fund.mintInKind(ratio, maxUsdc, limits)`. The fund keeps `ratio × idle` USDC idle, supplies `ratio × held` plus two units to each lending venue, and buys `ratio × balance` of each basket token with an exact-output swap whose `maxIn` comes from `limits`. It mints `ratio × supply` shares to the queue. Purchases round up and the mint rounds down. It asserts the proportion check itself. It returns the USDC spent. A venue that refuses a supply reverts the call. | Every asset grows by at least the same fraction as the supply. No price sets the share count. The fund does not trust its caller for the invariant. |
| E4 | Redemption | The existing pro-rata sale (`FundFlowsLib.redeemPayout`), called by the queue, with a minimum-out per sale from `limits`. Lending withdrawals ask for two units less than the exact amount. The fund asserts the proportion check itself. | It pays realized proceeds and reads no price for the payout. |
| E5 | No netting | Deposits and redemptions of one epoch are not matched against each other. Each trades. The sim reports what netting would have saved. | Netting needs a price between users. That price was the main source of attacks in the review (proposal §17.3). |
| E6 | TWAP | Computed at settlement from one `observe` call per pool: the median of the `slices` slice means over the last `settleWindow`. No checkpoint call and no checkpoint storage. | A one-transaction push leaves no trace in the pool's history. The keeper has no checkpoint duty. |
| E7 | Checks | The twelve steps of proposal §5.9.3, in that order. Before trading: time and state, feed health and the USDC peg, TWAP quorum, TWAP against feed, lending rate, share price, snapshot. Then redemptions and deposits with per-swap limits. After trading: the proportion check inside the fund, the realized-price check, the record. A failed check reverts and changes no state. | Four independent layers must agree. No role sets a price or overrides a block. A failed call cannot grief. |
| E8 | The hold | Each fill is its own claim with its own unlock time. Shares from a deposit stay in the queue until `settle time + minHold`. Then anyone may trigger their delivery to the request's owner. Shares in their hold have no exit. The fund's `_update` gets no lock. | Pooled accounts work, because each fill unlocks on its own date. Owner direction: no exit for one day after a deposit. |
| E9 | In-kind exit | `redeemInKind` stays on the fund, instant, with the proportion check asserted. It pays the lending part in USDC up to the period's in-kind allowance. Beyond that, or when a venue cannot pay, it records a claim on a share of that position. The fund keeps units per lending position for this, minted and burned as the position changes. `exitInKind` on the queue calls it for escrowed redemption shares and passes the user as the receiver. | No price is read. A claim fixed in USDC would pay a stale mark and leave later loss with the holders who stay (RB-21). |
| E10 | Who settles, and with what | The keeper first. Anyone after `keeperGrace`. `settle(maxRequests, maxUsdc)`. The two inputs only limit one call's work. Requests are processed oldest first. Anyone may call again at once. | The caller has no price and no selection to choose (RB-20). A small call harms nobody, because the next call continues. |
| E11 | Request size | At least `minRequestUsdc` (default 100 USDC), valued at the last healthy NAV for a redemption. No minimum for a redemption of an owner's whole balance. A deposit is at most the per-deposit cap. | It limits dust. A small holder can still leave. |
| E12 | Limits | Each request stores its limit. Before trading, the queue computes two bound prices from the per-swap limits: the most a depositor can pay per share, and the least a redeemer can receive. A request takes part only if its limit admits the bound. Others are skipped and stay pending. | Every fill is inside its limit by construction (RB-14). No caller selects anyone. |
| E13 | Exclusion ledger and fund state | The queue calls a fund hook before every change of an owner's queued shares: request, fill, cancel, exit and delivery. The ledger then checkpoints the owner with wallet shares plus queued shares. The queue's own address has no entitlement. While a lending asset is excluded, deposits are paused or the fund is shut down, deposit requests are not processed, and redemptions settle alone (check 1). | The ledger fixes claims by lazy checkpoints taken before a balance changes. A view alone would let a fresh address claim old recovery money (RB-22). |
| E14 | Empty fund | `fund.seed(usdc)`: `ADMIN_ROLE`, once, only at zero supply, at least `minSeedUsdc`. It mints at the fund's existing share scale to the fund itself. Those shares are locked for good. `mintInKind` needs a non-zero supply. | A ratio has no meaning on an empty fund. A small gift must not skew a new fund. |
| E15 | Asset admission (D12) | `addAsset` requires a feed address and its `maxFeedAge` for a basket asset, and checks that the pool holds one settlement window of observations. A lending asset's adapter must expose the venue's rate per unit. `setTargetAndOpenPlan` checks the pool-share rule from the pool's time-weighted liquidity. The prototype's asset list drops deSPXA. | The outside-feed layer needs a feed for every asset. Liquidity added for one transaction must not count. |
| E16 | Feeds | A `FeedLib` reads Chainlink feeds for ETH, BTC, cbBTC and USDC, and the Base sequencer uptime feed. It checks age, sign and round completeness. The fixture records the feed contracts at the pin. Tests move a feed with a mock aggregator placed at the feed's address. | Layer 2. Tests still run with no RPC. |
| E17 | Freeze | `freezeSettlement(id)` by `EMERGENCY_ROLE` during the hold. It ends by itself after `maxFreeze`. Before that the Safe can call `releaseSettlement` or `allowReturn`. After `allowReturn` each depositor pulls their own slice in kind. | A reversal window with no price, no other recipient and a deadline (RB-18). |
| E18 | Request list | The queue keeps one array of requests per epoch. `settle` walks the arrays of the last `maxRoll + 1` epochs, oldest first. A cancelled or filled request is skipped. There is no cap on the number of requests. After `maxRoll` epochs an unfilled request expires, and its owner withdraws the escrow. | A cap of 200 slots could be held for about 20,000 USDC of float. A flood now only costs the keeper skips. |
| E19 | Views | `totalAssets` and the convert functions revert when a feed is unhealthy. `lastGoodNav` returns the last healthy value and its time. `checkSettle` returns the first failing check. | A lender must not read a number nobody should trust. Clients still need a value and a reason. |
| E20 | Caps | Each side has a cap per `epochLength` of clock time: the larger of `maxEpochFlowBps` of NAV and `epochFlowFloorUsdc`. A deposit must also leave NAV at or under the TVL cap. The lending part of in-kind exits has its own allowance of the same size. | A rate limit on both directions. A backlog cannot stack caps. Without a floor a newly seeded fund could grow only 5% per epoch. |
| E21 | Quotes | `quoteDeposit(usdc)` and `quoteRedeem(shares)` return the current bound price, the fee, the earliest settlement time and the end of the hold. | The previews revert. A user and an agent need the worst case before signing. |
| E22 | Returns are pulled | Escrow returns, USDC refunds and in-kind returns are credited to the owner, who withdraws them. | A push to an address that cannot receive would block others. |
| E23 | Fixes in the code the design keeps | In-kind exit wraps a venue's value read, and defers that leg if the read reverts. A zero receiver is rejected, and a deferral is keyed to the owner. | The review found that one reverting venue read stops every in-kind exit, and that a deferral to the zero address can never be cleared (proposal §17.2). |

Parameters, all in `FlowParams`, set by `ADMIN_ROLE` through the timelock
inside hard bounds fixed in the code. The defaults are in proposal §5.9.5:
`epochLength`, `settleWindow`, `minHold`, `keeperGrace`, `maxEpochFlowBps`,
`epochFlowFloorUsdc`, `maxSharePriceMoveBps`, `maxRoll`, `minRequestUsdc`,
`maxFreeze`, `slices`, `quorum`, `dispersionBps`, `refBandBps`, `legBandBps`,
`maxFeedAge` (per feed), `sequencerGrace`, `usdcPegBandBps`,
`maxLendRateGrowthBps`, `poolShareBps` and `minSeedUsdc`. The hard bounds
refuse values that would stop every settlement, such as `quorum` above
`slices`.

## 3. Contract changes

### 3.1 New: `src/FlowQueue.sol`

- State per epoch: its request array and the window bounds.
- State per request: owner, kind, USDC or shares still unfilled, the limit,
  its epoch.
- State per claim: owner, shares or USDC, unlock time, frozen flag.
- State per period of clock time: USDC used on each side.
- `requestDeposit(usdc, maxUsdcPerShare, owner)` and
  `requestRedeem(shares, minUsdcPerShare, owner)`. USDC or shares come from
  the caller only. The request belongs to `owner`. A stranger's request for
  an owner is a new request. It never changes an existing one.
- `cancel(requestId)` by the owner, for the unfilled part.
- `exitInKind(requestId)` by the owner, for escrowed redemption shares.
- `settle(maxRequests, maxUsdc)`: the steps of proposal §5.9.3. It writes
  fills before it calls the fund, under one reentrancy lock that covers every
  entry point of the queue.
- Claims: `deposit` and `mint` deliver unlocked shares to the request's
  owner. `redeem` pays settled USDC to the owner. Claims use stored fills,
  never a convert view.
- `freezeSettlement`, `releaseSettlement` and `allowReturn` (E17).
- `withdrawExpired(requestId)` and `withdrawCredit()` by the owner (E22).
- Views: pending and claimable amounts, `quoteDeposit`, `quoteRedeem`,
  `checkSettle`, `queuedSharesOf(account)`.
- Events for each action.

### 3.2 Changed: `src/RobotMoneyFund.sol` and libraries

- `mintInKind(ratio, maxUsdc, limits)` and the pro-rata sale with `limits`,
  callable only with `FLOW_ROLE`. Logic in `FundFlowsLib`. Both use
  `heldBalance`, so value owed to past in-kind exits is not counted. Both
  assert the proportion check on active assets. Exact-output swaps need a
  call on the swap adapters. If an adapter lacks it, the prototype adds it to
  the adapter's test copy. The fund resets each allowance after a partial
  use and refunds `maxUsdc − spent`, never a balance difference.
- `seed(usdc)` (E14).
- The ledger hook the queue calls (E13).
- Units per lending position, and position-share claims in `redeemInKind`
  (E9). The in-kind allowance (E20).
- The two fixes of E23.
- The deposit path on realized NAV delta and deficit-first routing is removed
  from the fund, with its split math and `currentTargetBps`. The fund's own
  `deposit`, `mint` and `redeem` revert and name the queue. A frozen copy of
  the step 3c fund stays under the test tree as the baseline for the attack
  tests and for the sim's synchronous arm.
- `addAsset` takes the feed and its `maxFeedAge` (E15).
  `setTargetAndOpenPlan` checks the pool-share rule (E15). The NAV views
  revert on an unhealthy feed, and `lastGoodNav` exists (E19).
- A G1 budget comes first (work package 1).

### 3.3 Changed: lending adapters (test copies)

Each lending adapter exposes its venue's rate per unit (E15). The production
adapters do not change in the experiment.

### 3.4 Unchanged

The Rebalancer, the governance contract, receipts, the plan and the step
logic. The step's own feed checks and its backoff rule are step 3e, not this
plan. Steps keep running during settlement windows. A flow does not change
weights, so it never moves the fund past or away from the path.

## 4. Tests

All tests run on the replay fixture. Work package 1 re-records it once, to
add the feed contracts. After that, re-record with
`record-base-fixture.ts --pin 55462550 --sim` only if a test reports a
fixture miss.

### 4.1 `Attacks.t.sol`: the attacker's full profit and loss

Each test plays the attacker, then computes the net result. That is the value
taken, minus the cost to move prices and the flash-loan fee. The flash loan is
modelled with `deal` and a fee of 5 bps (Aave V3) or 0 (Morpho). Each test
runs against the frozen synchronous fund (the baseline) where the attack
applies to it, and against the timed fund. It also records what holders and
pending users lost.

The last column is an expectation, not a result. G8 is scored from what the
tests measure. A positive net result for the attacker is a G8 fail, recorded
as found.

| ID | Attack | Expected on the timed fund |
| --- | --- | --- |
| A1 | Makina replay: one transaction, a flash loan, a pushed pool, then a flow. Once per basket pool. | No flow settles in one transaction. |
| A2 | TWAP push held for 1 to N blocks. | Holders lose nothing. A push past `refBandBps` blocks. Inside it, the per-swap limit bounds a user's loss. The attacker's net is at most zero after the cost of holding the price. |
| A3 | Deflate, deposit, exit. | The mint reads no price. |
| A4 | Lending exchange rate moved by a gift or by supply. | A gift to the adapter is a gift to holders and does not move the venue's rate. A real rate jump over the bound blocks. |
| A5 | Round trip in one block and in consecutive blocks. | Impossible (RB-10, RB-11). |
| A6 | TWAP lag with a hedge, no manipulation. | Profitable on the baseline. Not on the timed fund. |
| A7 | Sandwich of a settlement, by its caller and by a third party. | The gain is capped by `legBandBps` on the basket part. The caller is the keeper before `keeperGrace`. The test must show the attacker's costs exceed the cap. If they do not, G8 fails and the band is the finding. |
| A8 | Blocking a settlement, by every way found. | Nobody loses value. Report the cost per day of each way. G8 fails if a way costs less than its floor. |
| A9 | A run: many holders redeem at once. | The timed path fills oldest first under the cap. In-kind exits get basket tokens at once and lending USDC up to the allowance, then position claims. Holders who stay do not carry more than their share of a venue loss. |
| A10 | Slow ramp of a pool. | The feed band blocks a ramp past `refBandBps`. Inside it the result is as A2. |
| A11 | Griefing the hold of a pooled account. | Each fill unlocks on its own date. A stranger's deposit for a victim is a gift. |
| A12 | A batch larger than pool depth. | The call fails its per-swap limit and changes nothing. Smaller calls settle it in parts. |
| A13 | A flood of requests whose limits never fill. | They are skipped. Report the keeper's gas against the attacker's cost. Honest requests still fill. |
| A14 | A lending venue that is impaired, at its supply cap, or fully borrowed. | Impaired: exiters and stayers share the loss. At its cap: deposits wait. Fully borrowed: timed redemptions wait and in-kind exit stays open. |
| A15 | A gift to a lending adapter or to the fund, also on a freshly seeded fund. | A gift to holders. The mix of a new fund moves by at most the gift over `minSeedUsdc`. |
| A16 | The emergency key freezes every settlement's deposits. | Depositors wait at most `maxFreeze`. No value moves. |
| A17 | A USDC depeg past the band. | Settlement blocks. The exits stay open. |
| A18 | Liquidity pulled from a pool just before a settlement. | The per-swap limit fails. Nothing settles and nobody loses. |
| A19 | Exclusion ledger: a claim by an address filled after a record opened, and by a redeemer whose shares were burned. | The fresh address gets nothing. The redeemer keeps the claim. |

A2, A6, A9 and A10 need the sim's arbitrage model. They go in
`sim/AttackSim.t.sol`, which reuses `SimLib` and the fast harness flags.

### 4.2 `FlowQueue.t.sol`: the mechanism

- **RB-10 and RB-11:** nothing leaves the queue before the window ends,
  except by cancel, in-kind exit or withdrawal of expired escrow. Shares from
  a deposit stay for `minHold` and go only to the request's owner.
- **RB-12:** a blocked settlement trades nothing. No role can settle past a
  failed check. Cancel and expiry return exactly the unfilled escrow.
- **RB-13:** after any settlement, the amount of every active asset per share
  is at least what it was before. This is also a fuzz test over ratios and
  holdings. A fund copy with a deliberately wrong purchase amount must revert
  inside the fund. A caller with `FLOW_ROLE` that skips its own checks still
  cannot break the proportion.
- **RB-14:** a request whose limit does not admit the bound price is skipped
  and stays pending, and the settlement still succeeds. No filled request has
  a realized price outside its limit.
- **RB-15:** a reverted `settle` leaves every balance and flag unchanged.
  Cancel and `exitInKind` work while the queue is paused.
- **RB-16:** one test per check of proposal §5.9.3. Each trips that check
  alone and shows that nothing settles:
  - check 1: a non-keeper before `keeperGrace`, and a paused queue;
  - check 1: an excluded lending asset, paused deposits and a shut-down fund
    each leave deposits unprocessed while redemptions settle;
  - check 2: a stale feed, a non-positive feed, a down sequencer, and USDC
    off its peg;
  - check 3: a slice outside the quorum;
  - check 4: a TWAP off its feed;
  - check 5: a venue rate over the bound, and a gift or a step that must
    not trip it;
  - check 6: a share price move over the breaker, and the larger allowance
    after several epochs;
  - checks 8 and 9: a sale under its limit, a purchase over its limit, a
    flow over its cap, and a deposit over the TVL cap;
  - check 11: a realized price outside the bound, forced with a mock venue.
- **RB-17:** `addAsset` without a feed or without pool history reverts. A
  target over the pool-share limit reverts. Liquidity added in the same
  transaction does not raise the limit.
- **RB-18:** frozen shares cannot be delivered. They can be released or
  pulled in kind only by their depositors. A freeze ends after `maxFreeze`.
- **RB-20:** two settlers with different inputs fill the same requests at
  the same bound prices. A call with small inputs is continued by the next.
- **RB-21:** a position claim gains and loses with the venue, pro rata with
  the holders. A deposit or a step into that venue does not change the
  claim's share.
- **RB-22:** the cases of A19, and a transfer of wallet shares while other
  shares are queued.
- **E8:** a request filled in two settlements has two claims with two unlock
  times.
- **E14:** `seed` works once, only at zero supply, at or above
  `minSeedUsdc`, and its shares never move.
- **E18:** an expired request cannot fill, and only its owner withdraws it.
- **E20:** a backlog of three epochs settles under one period's cap. A
  seeded fund can take a deposit up to the floor.
- **E21:** a quote is never better than the price a settlement in the same
  block would allow.
- **E22:** an owner that cannot receive USDC blocks nobody else.
- **Rounding:** many minimum-size requests in one epoch never favour the
  flow. Venue rounding of one or two units never fails the proportion check.
- **Reentrancy:** a hostile token callback during `mintInKind`, the sale or
  a claim cannot mint, pay twice or re-enter the queue.

### 4.3 Existing suites

- **`Invariants.t.sol`:** add handler actions for request, cancel, settle,
  claim, expiry, freeze and exit in kind. Add RB-10 to RB-18 and RB-20 to
  RB-22. Add a conservation check: queue USDC and shares plus fund holdings
  match the requests, fills and payouts booked.
- **`EndToEnd.t.sol` and `Adversarial.t.sol`:** move them to request and
  claim. Existing rows of proposal §5.8 must still pass.
- **`SizeGate.t.sol`:** G1 must still pass with the queue wired in. The queue
  is held to the same size limit.

### 4.4 Sim: timed flows

Add `PROTO_SIM_FLOWS=timed`. The sim's user flows become requests with
limits. Its keeper also settles. G9 is scored from this run. G4 and G5 are
scored in step 3e (proposal §13). The outputs:

- **For G9:** the share of settlements that succeed at the keeper's first
  call, the time from a redemption request to claimable USDC (median and
  95th percentile), and the execution cost of each flow against its feed
  value.
- **Wait for deposits:** request to delivered shares.
- **Blocked settlements:** the share, by check.
- **Values:** the normal range behind each value of proposal §5.9.5, and the
  value chosen.
- **Netting:** the swap cost that netting deposits against redemptions would
  have saved.
- **G4 change:** cost with pro-rata deposits against deficit-first deposits.
  Both arms run on the same asset list. The deficit-first arm is the frozen
  synchronous fund.

Both arms run on the proposal §4.5 asset list, with no deSPXA. The sim's feed
for each asset follows its fair-price walk, with the feed's own deviation
threshold and heartbeat.

## 5. Work packages, in order

| # | Package | Done when |
| --- | --- | --- |
| 1 | **Size budget, ledger design and feeds in the fixture.** Freeze a copy of the step 3c fund as the baseline. Stub `FlowQueue`, `FLOW_ROLE`, `seed`, `mintInKind`, the ledger hook and the position units. Remove the old deposit path from the live fund. Re-record the fixture with the Chainlink feeds and the sequencer feed. Measure G1 for the fund and the queue. Write the exclusion-ledger tests (E13, A19) first, against the stub. | Fund and queue each under 23,552 bytes. The ledger tests pass against the stub. |
| 2 | **Baseline attacks.** A1, A3, A4 and A5 against the frozen fund. | Each records the attacker's net result. A positive result is a finding. |
| 3 | **Sim attacks on the baseline.** A2, A6 and A10. | Net result per pool and per hold length. |
| 4 | **The fund's flow functions.** `seed`, `mintInKind`, the sale with limits, the proportion check inside the fund, position units, the in-kind allowance and the E23 fixes. | The RB-13 and RB-21 tests pass. |
| 5 | **The queue.** Requests, the list, eligibility, `settle`, claims, the hold, the freeze, caps, quotes, `FeedLib` and asset admission. | `FlowQueue.t.sol` passes. Existing suites pass on request and claim. |
| 6 | **Attacks against the timed fund.** A1 to A19. | Each test records the attacker's net result, the holders' loss and the pending users' loss. G8 is scored from them. |
| 7 | **Invariants** with the queue actions. | RB-10 to RB-18 and RB-20 to RB-22 hold. The conservation check holds. |
| 8 | **Timed-flow sim.** | Every §4.4 output is reported for the default and tuned sets. G9 is scored. |
| 9 | **Evidence.** Fill the G8 and G9 rows in proposal §14. Score G3 again over RB-1 to RB-22, without RB-19. Add a "Step 3d" paragraph. Add the fund and queue sizes to the G1 table. | The doc matches the test output. |

Packages 2 and 3 do not depend on packages 4 and 5. They can run in parallel
with them.

## 6. Risks

- **No precedent.** No protocol was found that buys the pro-rata slice inside
  the core contract (proposal §15.8). The rounding and reentrancy tests in
  §4.2 carry more weight than usual.
- **Three accounting systems.** The fund has deferred in-kind claims. This
  plan adds position units and the queue's requests and claims. The
  conservation invariant must cover all three.
- **The cost of a flow.** Every deposit and every redemption trades every
  basket asset, with no netting. If the cost is too high, the fallback is a
  NAV mint at the outside feeds, settled in the same epochs. It adds no
  trusted pricing role (proposal §5.9.7). The report says so plainly.
- **G1.** The fund gains `mintInKind`, `seed`, the hook and position units,
  and loses the old deposit path. If custody or share accounting would have
  to leave the fund, G1 fails, and that result goes in §14 as found.
- **Blocked settlements.** Every check must pass. Normal volatility may trip
  one often. The sim measures the blocked share per check, and G9 sets the
  limit. A design that blocks too often fails G9, and the report says so.
- **A venue that cannot pay or cannot take a supply.** Timed redemptions or
  deposits wait. A14 measures what it costs to cause that.
- **Feeds in a replay fixture.** The pin holds one feed value. Tests that
  need a moving feed use a mock at the feed's address. That tests the checks,
  not Chainlink.
- **Exact-output swaps.** A venue may not support them at the needed size.
  The fallback is an exact-input swap with the surplus left in the fund.
- **Clients.** The dapp, `rmpc`, the gateway and the indexer need request,
  claim, quote and pending views. They are counted for G6, not built.
- **Product promise.** Timed redemption breaks architecture §4.4 and the PRD.
  The owner accepted this on 2026-11-11 (D10) and said customers can wait.
  The PRD changes are staged in `one-vault-prd-amendments.md`.

## 7. Out of scope

- Production contracts and canonical docs (`docs/architecture.md`, the PRD).
- Building clients.
- Deploys, Twin and RPC test runs.
- The layers on the rebalance step, and the G4 and G5 rerun on the final
  design. That is step 3e.
- Changes to receipts.
