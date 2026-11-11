# One-vault experiment: engineering plan for hardened, timed flows (step 3d)

Status: plan, 2026-11-11, third version. It implements §4.5 and §5.9 of
`docs/technical/one-vault-rebalancer-proposal.md` (step 3d, D10 to D14, RB-10
to RB-18, gate G8). The owner approved the layered design the same day
(proposal §16.4). The first version priced flows at checkpointed NAV. A review
found flaws in it, and the owner's decision replaced it (proposal §15). The
second version settled by quantity. This version adds the outside feeds, the
on-chain proportion check and the other checks of the layered design. This
plan runs on the prototype under `contracts/test/prototype/` only. Production
contracts and canonical docs do not change. The experiment's rules still hold:
forge tests on the recorded Base fixture, with no RPC in a test run.

## 1. Goal

Make the fund safe against price-manipulation drains like the Makina exploit
without trusting any price. Measure what that costs. Concretely:

1. Show, by test, which attacks work against the synchronous fund of step 3c.
2. Build timed flows that settle by quantity under four layers of checks:
   the queue, the in-fund pro-rata purchase, the match, limits, the fourteen
   checks of proposal §5.9.3, the hold and the freeze.
3. Run the same attacks against the timed fund. Score G8 from the results.
4. Measure the deposit cost, the wait, how often each check blocks, and the
   change in G4 cost.

## 2. Design decisions

Each row follows proposal §5.9. IDs E1, E9 and E11 keep their first-version
meaning. The others are replaced. The rule above all rows: quantity sets
every share minted or burned, and every other check can only stop a
settlement. The match between users of one epoch crosses at the settlement
price `S`, inside each side's limit, and the fund is not a party to it.

| ID | Decision | Choice | Why |
| --- | --- | --- | --- |
| E1 | Where the queue lives | A new `FlowQueue` contract. It holds pending USDC, escrowed shares and shares in their hold. Only it may call the fund's pro-rata purchase and sale (`FLOW_ROLE`). | The fund has 1,556 bytes left under G1. Custody of the fund's assets stays in the fund. |
| E2 | Interface | An ERC-4626 vault in shape with ERC-7540's request and claim flow, as listed in proposal §5.9.6. `requestDeposit` and `requestRedeem` open requests. `deposit`, `mint` and `redeem` claim a settled request. The preview functions revert. `withdraw` reverts `RedeemOnly`. Pending and claimable views exist. Departures: a limit on each request, `cancel`, `exitInKind`, `redeemInKind`, `refund`, the hold before a claim, views that revert when a feed is unhealthy, and no operators. The functions are on the fund as thin calls into the queue. If they do not fit under G1, they move to the queue and the fund stays the share token. | Owner, 2026-11-11: follow the best hardened practice, not the ERC letter. Each departure is listed for clients. One address for clients where size allows. |
| E3 | Net deposit | `fund.mintInKind(ratio, maxUsdc)`. The fund keeps `ratio × idle` USDC idle, supplies `ratio × held` to each lending venue, and buys `ratio × balance` of each basket token with an exact-output swap. It mints `ratio × supply` shares to the queue, less `entryPremiumBps`. Purchases round up and the mint rounds down. It returns the USDC spent. | Every asset grows by at least the same fraction as the supply. No price is read. |
| E4 | Net redemption | The existing pro-rata sale (`FundFlowsLib.redeemPayout`), called by the queue. | It already pays realized proceeds and reads no price. |
| E5 | Match | The deposits and redemptions that take part are matched first, at `S`. Shares move from redeemers to depositors inside the queue. Depositors pay `S` per share. Redeemers receive that USDC minus the exit fee, which goes to the fee recipient. The fund is not called. | Holders are not a party to the match. Fewer trades. |
| E6 | Settlement price `S` | Computed at settlement from one `observe` call per pool: the median of the `slices` slice means over the window. `S` is the NAV per share at those medians. It is used for the match and the checks. No checkpoint call and no checkpoint storage. | A one-transaction push leaves no trace in the pool's history. The keeper has no checkpoint duty. |
| E7 | Checks | The fourteen checks of proposal §5.9.3, in that order, in `settle`. Before trading: time and state, feed health, TWAP quorum, TWAP against feed, spot against both, lending growth, share price, snapshot. After trading: the proportion check, the value check, the clearing limits. A failed check reverts and changes no state. After `maxRoll` epochs anyone can refund a request. | Four independent layers must agree. No role sets a price or overrides a block. A failed call cannot grief. |
| E8 | The hold | Shares from a deposit stay in the queue until `settle time + minHold`, then the owner claims them. The fund's `_update` gets no lock. | Pooled accounts work, because each settlement unlocks on its own date. No bytes are spent in the fund. |
| E9 | `redeemInKind` | Stays on the fund, instant. `exitInKind` on the queue calls it for escrowed shares. | It reads no price. It keeps one synchronous exit (D10). |
| E10 | Who settles, and with what | The keeper first. Anyone after `keeperGrace`. The settler supplies three numbers: the size of the net leg (a mint ratio for a net deposit, shares to burn for a net redemption), a deposit clearing limit and a redemption clearing limit. | Same model as `step()` (D3). The settler's numbers only size or select. Check 13 holds every price inside the clearing limits. |
| E11 | Request size | A deposit request is at least `minRequestUsdc` (default 100 USDC) and at most the per-deposit cap. Redemptions use the same minimum, valued at the last `S`. | It limits floods of tiny requests. |
| E12 | Limits | Each request stores its limit. A deposit takes part only if its limit is at or above the deposit clearing limit. A redemption takes part only if its limit is at or below the redemption clearing limit. Others stay pending. A request's own limit never reverts a settlement. | The user's own protection against a poor price (RB-14). |
| E13 | Exclusion ledger and fund state | The ledger credits queued shares to their owners through a view on the queue. While a lending asset is excluded, deposits are paused or the fund is shut down, deposit requests take no part in a settlement, and redemptions settle alone (check 1). | Queued shares would otherwise be recorded under the queue's address. Deposits close in these states today. |
| E14 | Empty fund | `fund.seed(usdc)`: `ADMIN_ROLE`, once, only at zero supply. It mints 1:1 on USDC to the fund itself. Those shares are locked for good. `mintInKind` needs a non-zero supply. | A ratio has no meaning on an empty fund. |
| E15 | Asset admission (D12) | `addAsset` requires a feed address for a basket asset and checks that the pool holds one settlement window of observations. `setTargetAndOpenPlan` checks the pool-share rule: target weight times the TVL cap is at most `poolShareBps` of the value of the pool's own balance of the asset. The prototype's asset list drops deSPXA. | The outside-feed layer needs a feed for every asset. A position larger than its pool cannot be traded cheaply. |
| E16 | Feeds | A `FeedLib` reads Chainlink feeds for ETH, BTC and cbBTC and the Base sequencer uptime feed. It checks age and sign. The fixture records the feed contracts at the pin. Tests move a feed with a mock aggregator placed at the feed's address. | Layer 2. Tests still run with no RPC. |
| E17 | Freeze | `freezeEpoch(epoch)` by `EMERGENCY_ROLE` during the hold. `releaseEpoch` or `returnEpochInKind` by the Safe. Shares or assets go only to that epoch's depositors. | Veda's reversible deposit, with no price and no other recipient (RB-18). |
| E18 | Entry premium | `entryPremiumBps`, default 0. The withheld shares are not minted, so holders gain. | A parameter kept ready. It is not switched on without a measured reason. |
| E19 | NAV views | `totalAssets` and the convert functions revert when a feed is unhealthy. | A lender must not read a number nobody should trust. |
| E20 | Request list | Each epoch keeps its requests in a list. `settle` walks it. An epoch takes at most `maxRequestsPerEpoch` requests (default 200). Later ones join the next epoch. | Bounded gas for `settle`. |
| E21 | Net cap floor | The net leg is capped at the larger of `maxEpochNetBps` of NAV and `epochNetFloorUsdc` (default 250,000 USDC). A net deposit must also leave NAV at or under the TVL cap. | Without a floor a newly seeded fund could grow only 5% per epoch. |

Parameters, all in `FlowParams`, set by `ADMIN_ROLE` within bounds. The
defaults are in proposal §5.9.5: `epochLength`, `settleWindow`, `minHold`,
`keeperGrace`, `maxEpochNetBps`, `epochNetFloorUsdc`, `maxSharePriceMoveBps`,
`maxRoll`, `minRequestUsdc`, `maxRequestsPerEpoch`, `entryPremiumBps`,
`slices`, `quorum`, `dispersionBps`, `settleBandBps`, `valueBandBps`,
`refBandBps`, `maxFeedAge`, `sequencerGrace`, `maxLendGrowthBps` and
`poolShareBps`.

## 3. Contract changes

### 3.1 New: `src/FlowQueue.sol`

- State per epoch: its request list, the window bounds, a settled flag, the
  clearing limits, the prices of the match and the net leg, the fill
  fractions, and the unlock time for shares from deposits.
- State per request: owner, USDC or shares, the limit, the amount filled.
- Request intake, called through the fund (E2):
  `requestDeposit(usdc, maxUsdcPerShare, owner)` and
  `requestRedeem(shares, minUsdcPerShare, owner)`. USDC or shares come from
  the caller only. The request belongs to `owner`. There are no operators.
- `cancel(epoch)` for the caller's own unsettled request.
- `exitInKind(epoch)` for the caller's own escrowed shares.
- `settle(epoch, netSize, depositLimit, redeemLimit)`: runs the fourteen
  checks around the match and the net leg, and records fills. Unfilled parts
  roll to the next epoch. The checks live in the queue and its libraries, not
  in the fund.
- `freezeEpoch`, `releaseEpoch` and `returnEpochInKind` (E17).
- Claims, called through the fund (E2): shares after the hold, USDC at once.
- `refund(epoch, account)`: by anyone, after `maxRoll`, to the request's
  owner.
- `escrowOf(account)`: the view the exclusion ledger reads.
- Events for each action.

### 3.2 Changed: `src/RobotMoneyFund.sol` and libraries

- The request and claim entry points and views (E2), as thin calls into the
  queue. The queue calls back with `FLOW_ROLE` for `mintInKind` and the
  pro-rata sale.
- An interface test checks every kept behaviour and every listed departure
  of proposal §5.9.6.
- `seed(usdc)` (E14).
- `mintInKind(ratio, maxUsdc)`, logic in `FundFlowsLib`. It uses
  `heldBalance`, so value owed to past in-kind exits is not counted. It needs
  exact-output swaps from the swap adapters. If an adapter lacks them, the
  prototype adds the call to the adapter's test copy.
- The deposit path on realized NAV delta and deficit-first routing is removed
  from the fund. This should free bytes. A frozen copy of the step 3c fund
  stays under the test tree as the baseline for the attack tests and for the
  sim's synchronous arm.
- `redeemInKind` asserts the proportion check on itself.
- `addAsset` takes the feed (E15). `setTargetAndOpenPlan` checks the
  pool-share rule (E15). The NAV views revert on an unhealthy feed (E19).
- A G1 budget comes first (work package 1).

### 3.3 Unchanged

The Rebalancer, the governance contract, receipts, the plan and the step
logic. The step's own feed checks are step 3e, not this plan. Steps keep
running during settlement windows. A flow does not change weights, so it
never moves the fund past or away from the path.

## 4. Tests

All tests run on the replay fixture. Work package 1 re-records it once, to
add the feed contracts. After that, re-record with
`record-base-fixture.ts --pin 55462550 --sim` only if a test reports a
fixture miss.

### 4.1 `Attacks.t.sol`: the attacker's full profit and loss

Each test plays the attacker, then computes the net result. That is the value
taken, minus the cost to move prices and the flash-loan fee. The flash loan is
modelled with `deal` and a fee of 5 bps (Aave V3) or 0 (Morpho). Each test
runs against the frozen synchronous fund (the baseline) and the timed fund. It
also records what holders and pending users lost.

The last column is an expectation, not a result. G8 is scored from what the
tests measure. A positive net result for the attacker is a G8 fail, recorded
as found.

| ID | Attack | Expected on the timed fund |
| --- | --- | --- |
| A1 | Makina replay: one transaction, a flash loan, a pushed pool, then a flow. Once per basket pool. | No flow settles in one transaction. |
| A2 | TWAP push held for 1 to N blocks. | Holders lose nothing. The settlement blocks, or the match crosses inside the clearing limits. The attacker's net is at most zero after the cost of holding the price. |
| A3 | Deflate, deposit, exit. | The mint reads no price. |
| A4 | Lending exchange rate moved by donation or supply. | A donation is a gift to holders. Growth over the bound blocks. |
| A5 | Round trip in one block and in consecutive blocks. | Impossible (RB-10, RB-11). |
| A6 | TWAP lag with a hedge, no manipulation. | Profitable on the baseline. Not on the timed fund. |
| A7 | Sandwich by the caller of `settle`. | Not possible before `keeperGrace`. After it, the gain is capped by `settleBandBps` times the net leg. The test must show the attacker's costs exceed that cap. If they do not, G8 fails and the band is the finding. |
| A8 | Blocking an epoch, or filling it small after the keeper fails. | Nobody loses value. Report the cost per hour, per pool. |
| A9 | A user distorts `S` to gain on the match. | Holders are not a party. The other side loses at most `refBandBps` and never more than its own limit. The attacker's net is at most zero after the cost of moving the median. |
| A10 | Slow ramp of a pool. | The feed band blocks a ramp past `refBandBps`. Inside the band the result is as A9. |
| A11 | Griefing the hold of a pooled account. | Each settlement unlocks on its own date. |
| A12 | A batch larger than pool depth. | Fills pro rata under the cap. The rest rolls. |

A2, A6 and A10 need the sim's arbitrage model. They go in
`sim/AttackSim.t.sol`, which reuses `SimLib` and the fast harness flags.

### 4.2 `FlowQueue.t.sol`: the mechanism

- **RB-10 and RB-11:** nothing leaves the queue before the window ends,
  except by cancel, refund or in-kind exit. Shares from a deposit stay for
  `minHold`.
- **RB-12:** a blocked epoch trades nothing. No role can settle it. Cancel and
  refund return exactly what was escrowed.
- **RB-13:** after any settlement, the amount of every asset per share is at
  least what it was before. This is also a fuzz test over ratios and holdings.
- **RB-13 as an assertion:** a fund copy with a deliberately wrong purchase
  amount must revert at the proportion check.
- **RB-14:** a request never fills outside its limit. A request whose limit
  misses the clearing limit stays pending and the settlement still succeeds.
  A settlement whose prices miss a clearing limit reverts.
- **RB-15:** a reverted `settle` leaves every balance and flag unchanged.
  Cancel and `exitInKind` work while the queue is paused.
- **RB-16:** one test per check of proposal §5.9.3. Each trips that check
  alone and shows that nothing settles:
  - check 1: a non-keeper before `keeperGrace`, and a paused queue;
  - check 1: an excluded lending asset, paused deposits and a shut-down fund
    each leave deposits out while redemptions settle;
  - check 2: a stale feed, a non-positive feed and a down sequencer;
  - check 3: a slice outside the quorum;
  - check 4: a TWAP off its feed;
  - check 5: spot off the median, and spot off the feed;
  - check 6: lending growth over the bound;
  - check 7: the two NAVs disagreeing, and a share price move over the
    breaker;
  - check 10: a net leg over the cap, and a net deposit over the TVL cap;
  - check 12: a value outside the band.
- **RB-17:** `addAsset` without a feed or without pool history reverts. A
  target over the pool-share limit reverts.
- **RB-18:** frozen shares cannot be claimed, and can be released or returned
  in kind only to their depositors.
- **E5:** an epoch with equal deposits and redemptions calls no venue.
- **E13:** an exclusion opened while shares are queued credits their owners.
- **E14:** `seed` works once, only at zero supply, and its shares never move.
- **E20 and E21:** request 201 joins the next epoch. A seeded fund can take a
  net deposit up to the floor.
- **Partial fill:** a net leg smaller than the requests that take part fills
  each pro rata and leaves the rest pending.
- **Rounding:** many minimum-size requests in one epoch never favour the flow.
- **Reentrancy:** a hostile token callback during `mintInKind` cannot mint.

### 4.3 Existing suites

- **`Invariants.t.sol`:** add handler actions for request, cancel, settle,
  claim, refund and exit in kind. Add RB-10 to RB-18. Add a conservation
  check: queue USDC plus fund holdings match the requests and payouts booked.
- **`EndToEnd.t.sol` and `Adversarial.t.sol`:** move them to request and
  claim. Existing rows of proposal §5.8 must still pass.
- **`SizeGate.t.sol`:** G1 must still pass with the queue wired in. The queue
  is held to the same size limit.

### 4.4 Sim: timed flows

Add `PROTO_SIM_FLOWS=timed`. The sim's user flows become requests with
limits. Its keeper also settles. This run is reported. G4 and G5 are scored
in step 3e (proposal §13). The outputs:

- **Deposit cost:** bps of each deposit lost to the pro-rata purchase.
- **Wait:** request to claim, as a median and a 95th percentile.
- **Blocked and rolled epochs:** the share of epochs, by check.
- **Values:** the normal range behind each value of proposal §5.9.5, and the
  value chosen.
- **Matched share:** the part of flows that needed no trade.
- **G4 change:** cost with pro-rata deposits against deficit-first deposits.
  Both arms run on the same asset list. The deficit-first arm is the frozen
  synchronous fund.

Both arms run on the proposal §4.5 asset list, with no deSPXA. The sim's feed
for each asset follows its fair-price walk, with the feed's own deviation
threshold and heartbeat.

## 5. Work packages, in order

| # | Package | Done when |
| --- | --- | --- |
| 1 | **Size budget, ledger check and feeds in the fixture.** Freeze a copy of the step 3c fund as the baseline. Stub `FlowQueue`, the request and claim surface, `FLOW_ROLE`, `seed` and `mintInKind`. Remove the old deposit path from the live fund. Re-record the fixture with the Chainlink feeds and the sequencer feed. Measure G1 for the fund and the queue. Write the exclusion-ledger test (E13). | Fund and queue each under 23,552 bytes, or the fallback of E2 is taken and written down. The ledger test passes or the fix is written down. |
| 2 | **Baseline attacks.** A1, A3, A4 and A5 against the frozen fund. | Each records the attacker's net result. A positive result is a finding. |
| 3 | **Sim attacks on the baseline.** A2, A6 and A10. | Net result per pool and per hold length. |
| 4 | **`seed`, `mintInKind`, `FlowQueue`, `FeedLib`, the fourteen checks, the freeze and asset admission** (§3). | `FlowQueue.t.sol` passes. Existing suites pass on request and claim. |
| 5 | **Attacks against the timed fund.** A1 to A12. | Each test records the attacker's net result, the holders' loss and the pending users' loss. G8 is scored from them. |
| 6 | **Invariants** with the queue actions. | RB-10 to RB-18 hold. The conservation check holds. |
| 7 | **Timed-flow sim.** | Every §4.4 output is reported for the default and tuned sets. |
| 8 | **Evidence.** Fill the G8 row in proposal §14. Score G3 again over RB-1 to RB-18. Add a "Step 3d" paragraph. Add the fund and queue sizes to the G1 table. | The doc matches the test output. |

Packages 2 and 3 do not depend on package 4. They can run in parallel with it.

## 6. Risks

- **No precedent.** No protocol was found that buys the pro-rata slice inside
  the core contract (proposal §15.8). The rounding, reentrancy and
  partial-fill tests in §4.2 carry more weight than usual.
- **Deposit cost.** Every net deposit trades every basket asset. If the cost
  is too high, the fallback is a NAV mint at the outside feeds, settled in
  the same epochs. It adds no trusted pricing role (proposal §5.9.7). The
  report says so plainly.
- **G1.** The request and claim functions on the fund add bytes. Removing
  the old deposit path should help. If they do not fit, they move to the
  queue (E2). If custody or share accounting would have to leave the fund, G1
  fails, and that result goes in §14 as found.
- **Blocked epochs.** Fourteen checks must all pass. Normal volatility may
  trip one often. The sim measures the blocked share per check. Each value is
  set from the sim, and the reason is recorded. A design that blocks often in
  normal markets fails on usefulness, and the report says so.
- **A hostile settler after the keeper fails.** It cannot take value. It can
  size the net leg small, so users wait another epoch. A8 measures it.
- **Feeds in a replay fixture.** The pin holds one feed value. Tests that
  need a moving feed use a mock at the feed's address. That tests the checks,
  not Chainlink.
- **Exact-output swaps.** A venue may not support them at the needed size.
  The fallback is an exact-input swap with the surplus left in the fund.
- **Clients.** The dapp, `rmpc`, the gateway and the indexer need request,
  claim and pending views. They are counted for G6, not built.
- **Product promise.** Timed redemption breaks architecture §4.4. The owner
  accepted this on 2026-11-11 (D10) and said customers can wait.

## 7. Out of scope

- Production contracts and canonical docs (`docs/architecture.md`, the PRD).
- Building clients.
- Deploys, Twin and RPC test runs.
- The layers on the rebalance step, and the G4 and G5 rerun on the final
  design. That is step 3e.
- Changes to receipts.
