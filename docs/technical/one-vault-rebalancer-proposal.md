# Experiment: one vault and a receipt-driven rebalancer

- **Status:** Experiment in progress. The purpose is to validate or
  invalidate the rejection of
  [ADR-0010](../adr/ADR-0010-unified-vault-architecture.md) with measured
  evidence. The design is developed to its conclusion first. The decision
  comes after, from the gates in §13. Production stays on the three-vault
  design until then. The canonical docs are not rewritten during the
  experiment.
- **Date:** 2026-11-07 (reframed as an experiment 2026-11-09; per-asset
  targets replace on-chain sleeves 2026-11-10; hardened timed flows and the
  asset rule 2026-11-11)
- **Author:** lucky-tensor (drafted with Claude)
- **Decider:** Product owner
- **Would supersede, if the experiment invalidates the rejection:** the Portfolio Router (`docs/architecture.md`
  §4.2), router-weight governance (§2.3), and the rejection in
  [ADR-0010](../adr/ADR-0010-unified-vault-architecture.md). It would amend
  [ADR-0003 (rebalancing)](../adr/ADR-0003-basketvault-rebalancing-model.md)
  and [ADR-0017](../adr/ADR-0017-rmagent-retired-router-uses-three-vaults.md).
- **Keeps unchanged:** the consensus receipt contract (§4.9), the Safe and
  timelock as the only governance body, the lending adapters, the swap
  adapters, ADR-0009 retirement (no assisted migration), ADR-0014 governed
  UUPS proxies, and the custody invariants INV-1 to INV-4.
- **Changes off-chain:** the receipt payload gains an optional per-asset
  target list (schema 1.1, a minor bump, §4.1).

## 1. Summary

Today the vaults system has three vaults (rmUSDC, rmPROTO, rmRWA) and a
Portfolio Router that splits each deposit across them by governed weights.
A consensus receipt changes those weights. Changing weights only changes
where **new** deposits go. Money already in a vault never moves.

This proposal replaces that with:

1. **One vault.** A single USDC vault, ERC-4626 in shape (§5.9.6), with one
   share token. It
   keeps a flat list of assets and one target weight per asset: three
   lending positions (Morpho, Aave, Compound), wETH and cbBTC. deSPXA was
   in the prototype through step 3c and left under the asset rule (§4.5). The
   receipt sets every asset's target directly. Categories such as "stable
   yield" or "protocol tokens" are labels in the receipt and in off-chain
   tools. The contracts do not know them (§4.1).
2. **No router.** The vault itself holds the target weights. A deposit into
   the vault is already a portfolio deposit.
3. **A rebalancer.** When the Safe applies a consensus receipt, the vault
   gets a new target and a **rebalance plan**. The plan moves the existing
   holdings toward the target in small, bounded steps over days. Each step is
   priced against a TWAP, capped in size and cost, and spaced so the next step
   sees a settled price. This avoids large single trades, slippage and
   sandwich attacks. From step 3e each step is also checked against an
   outside price feed (§5.10).
4. **Hardened, timed flows.** A deposit or a redemption is a request. It
   settles with its epoch, after a window. Each flow is a pro-rata slice by
   quantity, so no price sets how many shares are minted or burned. Outside
   price feeds, the pools' own TWAP, wait periods and rate limits can each
   stop a settlement. Shares from a deposit are held for one day (§5.9).

The receipt flow is the same as today up to the point of application:
analysts sign off-chain, a submitter records the digest, the Safe applies the
receipt through the timelock. The only difference is what "apply" does. Today
it sets router weights. Under this proposal it sets the vault's target and
opens a rebalance plan.

## 2. Why change

| Problem today | Effect | How this proposal answers it |
| --- | --- | --- |
| A receipt only steers new deposits. | Existing money never follows the committee. With low inflow, a receipt changes almost nothing. | The rebalancer moves existing holdings to the new target. |
| A "portfolio position" is a reporting concept assembled from three receipt tokens (architecture §2.2). | The dapp, rmpc, explorer and watchdog must stitch three vaults together. Users hold three tokens and can drift from the target forever. | One share token. One NAV. Every holder has the same composition. |
| Router legs fail independently (`LegSkippedWithFloor`, renormalisation, per-leg caps, architecture §4.2.1). | Complex previews. A user can land with a different split than the receipt says. | One deposit path. Composition is set by the vault, not per deposit. |
| Three vault kinds, a registry, a router, a router-governance contract. | Seven `ADMIN_ROLE` contracts. Each release has to deploy, verify and govern all of them. | Fewer contracts (see §6). |
| No mechanism moves capital between exposures. | ADR-0003 left `rebalance()` as a `NotImplemented()` stub. | The stub becomes a real, bounded process. |

## 3. Relationship to the rejected unified vault (ADR-0010)

ADR-0010 also proposed one vault class. The owner rejected it on 2026-09-18.
This experiment exists to test that rejection. Each rejection reason becomes a
hypothesis with a measurable gate in §13.

| ADR-0010 rejection reason | Expectation going in (to be tested) |
| --- | --- |
| The deployed families are audited, and migrating them is not worth the reversibility cost. | **Partly.** This proposal also needs a new audit and a fresh deployment. What is new is the benefit: ADR-0010 kept the router and had no way to move existing capital, so it bought little product change for its cost. This proposal removes the router and makes receipts move money, which is a product change the current design cannot deliver. |
| A fifth contract kind breaks the one-deployment-scheme rule. | **No.** ADR-0010 added a fifth kind next to the four existing ones. This proposal **replaces** them. A new deployment has one vault kind, not five. |
| `forceRebalance`-only, caller-funded rebalancing. No keeper, no socialized cost. | **Deliberately reversed.** ADR-0010 and ADR-0003 both refused socialized rebalance cost. A receipt-driven rebalance has a real cost that all holders share. This design bounds that cost and discloses it (§5.7). The experiment assumes it (§11, D1) and measures whether it is acceptable (§13, G4). |

This document is the experiment's design, not an ADR. When the experiment
concludes, the result is recorded as a new ADR either way:

- **Validated** (the rejection holds): the new ADR records the evidence and
  ADR-0010 stays Rejected with a stronger reason.
- **Invalidated** (the rejection does not hold): the new ADR supersedes the
  rejection, and the canonical docs are rewritten in the same change.

## 4. Target architecture

```text
Analysts (off-chain, Ed25519)
   |
Submitter (RECEIPT_SUBMITTER_ROLE)
   -> ConsensusRecommendationReceipt.recordReceipt        (unchanged)

Safe -> TimelockController
   -> RebalanceGovernance.applyReceipt(receiptId, digest, assets, bps)
        -> receipt.releaseReceipt(receiptId)                (unchanged role)
        -> vault.setTargetAndOpenPlan(assets, bps, planParams)

Keeper (KEEPER_ROLE, or anyone after the grace period)
   -> Rebalancer.step()
        -> vault.executeStep(sell leg, buy leg)  (sizes and floors computed on chain)

Human wallet / rmpc gateway
   -> vault.requestDeposit / vault.requestRedeem, then claim
        -> FlowQueue                                 (holds requests, §5.9)
   -> vault.redeemInKind                             (instant)

Keeper (KEEPER_ROLE, or anyone after the grace period)
   -> FlowQueue.settle(epoch, netSize, depositLimit, redeemLimit)
        -> checks of §5.9.3, then the fund's pro-rata purchase or sale

RobotMoneyFund vault (ERC-4626 in shape, one share token, a flat asset list)
   |-- MorphoAdapter, AaveV3Adapter, CompoundV3Adapter   (lending assets)
   |-- wETH, cbBTC   via UniswapV3SwapAdapter / AerodromeSwapAdapter
   |-- deSPXA        via UniswapV3SwapAdapter   (steps 1 to 3c only, §4.5)
   `-- idle USDC
```

Each asset has one target weight. The receipt's category labels
(`stable yield`, `protocol tokens`, `real world assets`, `agent tokens`) are
not on chain.

The working name for the vault is `RobotMoneyFund` and its share `rmFUND`.
It is a working name (§11, D6).

### 4.1 Asset targets, and sleeves as labels

**On chain there are only assets.** The fund keeps a flat list of assets.
Each asset has one target weight in bps of NAV. The receipt sets those
weights directly. There is no sleeve id, no sleeve weight and no
intra-sleeve weight in any contract.

**Why.** An earlier version of this design put sleeves on chain. A receipt
set four sleeve weights. A separate governed intra-sleeve weight split each
sleeve across its assets. The asset target was the product of the two. That
needed two layers of allocation governance: the balance between sleeves,
and the balance inside each sleeve. It bought no on-chain safety.
`applyReceipt` never checked the sleeve vector against the payload. It only
checked that the named digest equals the recorded digest. Matching the
vector to the payload was already an off-chain re-derivation. With
per-asset targets in the receipt, the committee's decision is the whole
allocation. Nothing else governs it.

**The receipt (schema 1.1).** A minor bump appends one optional field,
`assets`, after `weights`:

```json
"assets": [
  {"asset": "morpho-usdc",      "sleeve": "conservative_defi_yield", "weight_bps": 2500},
  {"asset": "aave-v3-usdc",     "sleeve": "conservative_defi_yield", "weight_bps": 2000},
  {"asset": "compound-v3-usdc", "sleeve": "conservative_defi_yield", "weight_bps": 1500},
  {"asset": "weth",             "sleeve": "protocol_tokens",         "weight_bps": 1200},
  {"asset": "cbbtc",            "sleeve": "protocol_tokens",         "weight_bps": 1300},
  {"asset": "despxa",           "sleeve": "real_world_assets",       "weight_bps": 1500}
]
```

- `asset` is a stable key. A fixture,
  `contracts/test/prototype/fixtures/receipt/asset-map.json`, maps each key
  to the fund's on-chain asset id per chain. It replaces the bucket-to-vault
  map. It lives there because the shared fixtures under `tests/fixtures/`
  are byte-pinned to another repo.
- `weight_bps` is the asset's target share of NAV. The list sums to 10,000.
  It is a weight, not an amount, because NAV moves between the receipt and
  each step.
- `sleeve` is a **label**. It names the receipt bucket the asset is reported
  under. It is informational, not imperative. It does not reach the chain.
  The asset map fixes each asset's bucket. A receipt label must match it.
  Otherwise a relabel could pass any audit.
- Sleeves are not separable. There is no per-sleeve share, NAV, deposit,
  redemption or plan. A holder always owns a pro-rata slice of every asset.
  "Sleeve" only names a way to slice the fund for reading.

**The audit check.** The receipt keeps its four bucket `weights`. They are
now an audit field. For each bucket, the sum of `weight_bps` over the assets
labelled with it must equal that bucket's `weight_bps`. The assembler
refuses to build a receipt that fails this. `rmpc receipt verify` and the
`apply-receipt` govern row refuse it too. The contracts never see it.

**What the contracts check.** `applyReceipt(receiptId, digest, assets, bps)`
and `setTarget(assets, bps, params)` check only the vector itself:

- every listed asset is an active fund asset;
- every active asset is listed exactly once, so a receipt can never sell an
  asset by forgetting it (an explicit 0 sells it);
- the weights sum to 10,000;
- a lending asset's target is at or below its `capBps`. That cap is a risk
  ceiling on one venue, not an allocation choice.

Idle USDC carries no target. It absorbs rounding, as before.

**Off-chain tools own the semantic layer.** The dapp, rmpc, explorer and
reports group assets by the receipt's labels. They can slice the same assets
another way later without a contract change.

**What is still governed by the Safe.** Which assets are tradable at all:
adding or retiring an asset, its adapter or pool, its TWAP window, and its
`capBps`. Those choices define what a receipt may name. They do not set any
balance.

### 4.2 NAV

```text
totalAssets = idle USDC
            + Σ lending adapter.totalAssets()          (exact, 1:1)
            + Σ basket token balance × TWAP price       (BasketVault model)
```

NAV is a view and a guard. Since D11 it sets no minted or burned share
count (§5.9). It prices only the match between the users of one epoch
(§5.9.3, check 9). The settlement checks also compute it at outside feeds and
compare the two (§5.9.3, check 7).

This is the union of the two NAV models that already exist. Basket assets
keep their TWAP valuation, the ORA-4 spot-versus-TWAP deviation guard, and the
emergency unwind guards. Lending adapters keep ADP-2 exclusion and the
`ExclusionLedger`.

### 4.3 Deposits

Changed 2026-11-11 (D10, D11, §5.9). The first design minted on the realized
NAV delta and routed each deposit deficit-first. The prototype up to step 3c
still does. Step 3d replaces it.

A deposit is a request. It settles with its epoch (§5.9). Deposits and
redemptions of one epoch are matched first, between users, at the settlement
price. The fund is not a party to the match. The epoch's net USDC then buys
the same fraction of every asset the fund holds. Shares mint by that
fraction. No NAV is read for the mint. The depositors of the epoch pay the
cost of the purchase. Each request carries its own limit.

A deposit does not change the fund's weights. Only the rebalancer does.

### 4.4 Redemptions

Changed 2026-11-11 (D10, §5.9). Redemption is **timed** and **pro rata**.
Architecture §4.4 makes synchronous redemption a product promise. The owner
accepted the change for the experiment (D10).

- `requestRedeem` escrows shares in the queue. The request settles with its
  epoch. Matched shares go to that epoch's depositors for USDC. Net shares are
  burned: the fund withdraws each lending position and sells each basket token
  in proportion, and pays realized proceeds minus the exit fee. This is
  `BasketVault._sellProportional` plus `RobotMoneyVault._pullProportional`,
  unchanged in spirit.
- `withdraw` and `previewWithdraw` revert `RedeemOnly`.
- `redeemInKind` stays instant. It pays USDC for the lending and idle part
  and hands over basket tokens for the basket part. It needs no oracle and no
  swap venue. Shares waiting in the queue leave the same way through
  `exitInKind`.
- Pro rata keeps composition unchanged. Redemptions never fight the plan and
  never shift cost onto the holders who stay.

Rebalancing state never blocks a redemption request, its settlement or
`redeemInKind`.

### 4.5 Asset admission rule (D12)

The assets can change to fit the protocol (owner, 2026-11-11). So the
protocol states what an asset must have. A basket asset is listed only if:

1. **It has an independent price feed on Base** that is live at all hours.
   The feed must not be derived from the fund's own pool.
2. **Its pool keeps at least one settlement window of price history.**
3. **Its largest position fits its pool.** The target weight times the TVL
   cap is at most `poolShareBps` of the value of the pool's own balance of
   the asset. The fund checks this when a target is set.

A lending asset is listed only if its venue reports a position value the
growth bound (§5.9.3, check 6) can check.

**Effect on the list.** wETH and cbBTC pass rule 1. Chainlink has ETH, BTC
and cbBTC feeds on Base. deSPXA fails rule 1 today. It leaves the fund until
a feed exists. The receipt's real-world-asset bucket is then 0, as the agent
bucket already is. Steps 1 to 3c ran with deSPXA, and their results in §14
stand as recorded. Step 3e reruns G4 and G5 on the new list. Those reruns are
new results, not edits to the old ones. The example in §4.1 and the
parameter notes in §5 that name deSPXA describe the list before this rule.

## 5. The rebalancer

This is the core of the proposal.

§5.1 to §5.8 describe the step as built through step 3c. It is priced and
booked at the pool TWAP alone. Step 3e adds an outside feed to the step's
checks, its floor and its cost accounting (§5.10).

### 5.1 From receipt to plan

1. The submitter records the receipt (unchanged, §4.9 of the architecture).
2. The Safe schedules `RebalanceGovernance.applyReceipt(receiptId, digest,
   assets, bps)` on the timelock. This is today's `RouterGovernance.applyReceipt`
   with the router call swapped for a vault call. Its checks stay: the receipt
   must be recorded, not released, match the digest, and be newer than the
   last applied receipt (`lastAppliedRecordedAt`). The vector checks are the
   ones in §4.1. The govern row derives `assets` and `bps` from the payload's
   `assets` field and runs the bucket audit check before it schedules.
3. On execution it releases the receipt and calls
   `vault.setTargetAndOpenPlan`. That call:
   - snapshots the vault's **current** asset weights as the plan's start point;
   - stores the receipt's weights as the plan's end point;
   - stamps `startTime` and `endTime = startTime + duration`;
   - closes any plan still running. A new plan always starts from the vault's
     actual weights, never from the old plan's target. Plans never stack.

A recorded receipt is still signalling-only (INV-4). The receipt contract
still never calls the vault. Only the timelock-executed governance call opens
a plan.

### 5.2 The glide path

The plan target moves linearly from the start weights to the end weights over
`duration`:

```text
f(t)            = clamp((t - startTime) / duration, 0, 1)
pathTarget_i(t) = start_i + (end_i - start_i) × f(t)
```

The rebalancer never moves the vault further than `pathTarget(t)`. So in the
first hour of a seven-day plan, it can only move about 1/168 of the total
change. This is the "over a period of time" requirement. It turns one large
trade into many small ones that each fit inside the pool's depth.

This is the same idea as a Balancer liquidity bootstrapping pool's weight
update or Index Coop's rebalance auction: commit to the end state in public,
then approach it slowly.

### 5.3 One step

`Rebalancer.step()` executes at most one sell leg and one buy leg. All
inputs come from chain state. The caller chooses nothing except **when**.

1. **Cooldown.** Revert unless `block.timestamp ≥ lastStepAt + stepInterval`.
   `stepInterval` is at least the longest TWAP window of any asset traded.
   The next step then prices against a TWAP that already includes the last
   step's own impact, so the rebalancer never chases its own trades and a
   manipulator has to hold a price for a full window.
2. **Market check.** Run the ORA-4 spot-versus-TWAP check on both legs. If
   spot has moved more than `navDeviationGuardBps` away from TWAP, skip.
   This is the most common sign of an attack in progress.
3. **Pick legs.** Value every asset at TWAP. Compute each asset's deviation
   from `pathTarget(now)`. The sell leg is the most overweight asset. The buy
   leg is the most underweight asset. USDC is the hub for every pair: the
   lending assets and idle USDC are "USDC", and every basket pool is a USDC
   pool today.
4. **Size.** `notional = min(overweight, underweight, maxStepUsdc[asset])`.
   `maxStepUsdc` is a governed per-asset cap set from pool depth. wETH and
   cbBTC can take far larger steps than deSPXA. A deviation below
   `minStepUsdc` is ignored, so dust never pays gas.
5. **Floor.** `minOut = TWAP quote × (1 − maxStepSlippageBps)`. The floor
   comes from the TWAP, never from spot, and is checked inside the swap
   (the existing `_executeSwap` path and `minAmountOut`).
6. **Execute.** Sell to USDC (or withdraw from a lending adapter), then buy
   (or deploy to a lending adapter). Either leg may be absent when one side
   is idle USDC.
7. **Measure cost.** `cost = navBefore − navAfter`, both at TWAP. Revert if
   `cost > notional × maxStepCostBps`. Add it to `plan.costSpent`.
8. **Budget.** If `plan.costSpent > plan.costBudget`, the plan moves to
   `Halted`. Only the Safe can extend the budget or close the plan.
9. **Emit** `RebalanceStep(planId, sellAsset, buyAsset, notional, amountIn,
   amountOut, cost, pathTarget)`.

A step that cannot execute (cooldown, market check, nothing to trade) returns
without reverting and emits `RebalanceStepSkipped(reason)`, so keepers and the
indexer see why.

### 5.4 Who calls `step()`

- **Keeper first.** A `KEEPER_ROLE` holder (an operator bot run by Robot
  Money) calls `step()`. The keeper can only choose timing. It cannot choose
  amounts, assets, floors or recipients. It holds no funds. Its key is an
  operational secret with a small blast radius.
- **Anyone after a grace period.** If no step has run for `keeperGrace`
  (for example 6 hours) while the plan is not converged, `step()` becomes
  permissionless. Rebalancing then never depends on Robot Money staying
  online. This matches the "executor open" choice the timelock already made.
- The keeper may add timing jitter off-chain, so step times are not
  predictable to the second.

### 5.5 Plan states

```text
Open ──(path end reached and every asset within toleranceBps)──> Converged
  │
  ├──(costSpent > costBudget)───────────> Halted ──(Safe extends)──> Open
  ├──(EMERGENCY_ROLE pauseRebalance)────> Paused ──(Safe resumes)──> Open
  ├──(new receipt applied)──────────────> Superseded
  └──(endTime + maxOverrun passed)──────> Expired
```

- `toleranceBps` (for example 50 bps per asset) stops the plan chasing
  exact weights through endless small trades.
- After `endTime` the path target equals the end weights. Steps continue
  until converged or `maxOverrun` (for example 7 more days) passes.
- `EMERGENCY_ROLE` can pause a plan at once (hot key, same split as
  `pauseDeposits`). Only the Safe through the timelock resumes, extends,
  or closes it.
- Nothing about a plan's state ever touches deposits or redemptions.

### 5.6 Governed parameters

All set through the timelock. Suggested starting values are for review, not
decided.

| Parameter | Scope | Suggested start | Purpose |
| --- | --- | --- | --- |
| `duration` | per plan, bounded globally | 7 days (min 1 day) | Length of the glide path |
| `stepInterval` | global | max(longest TWAP window, 30 min) | Cooldown between steps |
| `maxStepUsdc` | per asset | wETH/cbBTC: from depth study; deSPXA: small | Largest single trade |
| `minStepUsdc` | global | 100 USDC | Ignore dust |
| `maxStepSlippageBps` | per asset | above the pool fee, at or below `maxSlippageBps` | Swap floor against TWAP |
| `maxStepCostBps` | global | 50 bps of notional | Per-step NAV-loss cap |
| `costBudgetBps` | per plan | 30 bps of plan turnover | Total cost a plan may spend |
| `toleranceBps` | global | 50 bps per asset | When a plan counts as converged |
| `keeperGrace` | global | 6 hours | When `step()` opens to anyone |
| `maxOverrun` | global | 7 days | When an unconverged plan expires |
| `navDeviationGuardBps` | global | 200 bps, above every pool fee | The ORA-4 band: spot against TWAP |

The same rule that already binds `navDeviationGuardBps` applies: a slippage or
deviation bound at or below the pool fee would make every step fail, so the
deploy script refuses it.

### 5.7 Who pays, and how it is disclosed

Rebalance cost is shared by every holder at the time of each step. That is the
nature of a managed fund. It is the deliberate change from ADR-0003 and
ADR-0010 (§3). The design means it to be bounded and visible. The step 3 sim
showed that cost booked at the TWAP under-reports the real cost (cost report
§4). §5.10 corrects the booking in step 3e. Until then the bounds below hold
only for the cost the contract can see:

- **Bounded** per step (`maxStepCostBps`) and per plan (`costBudgetBps`).
  A halted plan needs a fresh Safe decision to spend more.
- **Previewed** before the Safe applies: `previewPlan(assets, bps)` returns the
  turnover per asset and the estimated cost at current TWAP. The govern row
  shows it before scheduling, and the dapp shows it next to the receipt.
- **Recorded** per step in events. The indexer sums realized cost per plan.
  The dapp shows each plan's progress, turnover, and cost spent.
- **Not reduced by deposits any more.** Through step 3c, deficit-first
  deposits did part of the work for free. D11 ended that (§4.3).

### 5.8 Adverse actions and the defence for each

| Threat | Defence |
| --- | --- |
| Slippage on a large trade | The glide path plus `maxStepUsdc` keep each trade small against pool depth. |
| Sandwich of a step | `minOut` is set from the TWAP, not spot, so a pushed spot price makes the swap revert. The ORA-4 check skips steps while spot is off TWAP. Base's sequencer has no public mempool, which helps, but the design does not rely on it. |
| Manipulating the TWAP itself | `stepInterval` ≥ TWAP window, so an attacker must hold a distorted price for a full window, against arbitrage, to move one bounded step. The existing pool-cardinality and minimum-liquidity requirements still apply. |
| Front-running a public receipt | The target is public at least for the timelock delay (48 hours on 8453). Traders can position ahead of the vault's buying. The defence is that the vault buys slowly, in small steps, through deep pools. This risk is accepted, not removed. Thin assets (deSPXA) should have small `maxStepUsdc` and long plans. |
| Keeper abuse | The keeper chooses only timing. Sizes, floors, assets, and recipients come from chain state. The worst a keeper can do is time steps badly within the floors, or stop calling. Stopping is covered by the grace period. |
| Deposit or redeem timed around a step | A flow settles by quantity, in its epoch (§5.9). It takes a pro-rata slice, so moving value between assets gives it nothing. Through step 3c the defence was TWAP valuation, which did not depend on composition. |
| A venue freezes (deSPXA issuer freeze, lending pause) | The step reverts or skips. The plan stalls on that asset only. Other assets keep converging. `redeemInKind` remains open. |
| Runaway cost from a bug | Per-step revert on `maxStepCostBps`. Plan halt on the budget. `EMERGENCY_ROLE` pause. |

### 5.9 Hardened flows: quantity, feeds, TWAP and time (step 3d)

Decided 2026-11-11 and approved by the owner the same day (§16.4). This
section is the design. §15 holds the review of the first draft and the
research. §16 holds the review that led to the layers and the industry
practices behind each one.

#### 5.9.1 The attack and the principle

**The attack.** A vault that prices its shares from a market price can be
drained by moving that price. The exemplar is the Makina Finance exploit on
Ethereum (2026-01-20, about $4.13M, Cecuro write-up
<https://cecuro.ai/blog/makina-finance-oracle-exploit-2026>). In one
transaction, a 280M USDC flash loan moved a Curve pool. The vault read the
pool's spot data into its share price, which rose from about 1.01 to about
1.33. The write-up names the causes: spot prices trusted directly, no
flash-loan resistance, no bound on price moves, and no rate limit.

**Where the synchronous fund of steps 1 to 3c stands.**

- `redeem` is safe. It pays the realized proceeds of a pro-rata slice. It
  reads no price.
- `deposit` is the exposure. It mints on NAV at the TWAP, and deficit-first
  routing makes the deposit's mix differ from the fund's mix. A TWAP that
  lags or is pushed gives the depositor too many shares. No manipulation is
  needed: a TWAP lags every real move.
- ORA-4 compares a pool with itself. It cannot see a price that is held.

**The principle. Quantity sets every share minted or burned. Everything else
can only stop a settlement.** Four independent kinds of evidence must agree
before a flow settles. An attacker must beat all four at once. A false alarm
costs time, never money, because customers can wait (owner, 2026-11-11) and
the exits in §5.9.4 stay open.

One price is used between users. Deposits and redemptions of the same epoch
are matched at the settlement price `S`, inside each side's own limit. The
match moves existing shares between users. The fund is not a party to it, so
no price error in the match can reach the holders.

| Layer | Evidence | What it catches | What it cannot do |
| --- | --- | --- | --- |
| 1. Quantity | Asset amounts per share, before and after, in one transaction | Any dilution of holders, from any cause, including a bug in the fund's own trade code | Set a price |
| 2. Outside feeds | Chainlink price per basket asset, feed age, sequencer status, lending growth, the value of the net leg | A held or ramped pool price. A pool with no arbitrage. An inflated lending rate. A bad execution. | Mint or burn |
| 3. Internal TWAP | Median of window slices, dispersion, spot band | One-block and short pushes. A stale or wrong feed. | Mint or burn |
| 4. Time and rate | Epoch, window, hold, keeper-first, size cap, share-price move breaker | Flash loans. Same-block round trips. Fast drains. Anything that needs speed. | Mint or burn |

**Why holders are safe by construction.** A net deposit adds the same
fraction to every asset and to the supply. A net redemption removes an exact
pro-rata slice. A match changes neither assets nor supply. So the amount of
every asset per share never falls, whatever any price says. The settlement
transaction also asserts this on chain after its trades (check 11). The
argument does not depend on the sim's arbitrage model or on which assets the
fund holds.

#### 5.9.2 An epoch

1. **Request.** A user calls `requestDeposit` with USDC and a limit (the most
   USDC per share), or `requestRedeem` with shares and a limit (the least USDC
   per share, after the exit fee). The USDC or the shares come from the
   caller only. The queue holds them. A deposit request is at least
   `minRequestUsdc` and at most the per-deposit cap. An epoch takes at most
   `maxRequestsPerEpoch` requests. Later ones join the next epoch. The
   request's owner can cancel it until it settles.
2. **Close and window.** The epoch closes after `epochLength`. A
   `settleWindow` follows. Nothing settles before the window ends.
3. **Settle.** One transaction runs the checks and the flows of §5.9.3. The
   keeper settles first. Anyone can settle after `keeperGrace` (D3). The
   settler names three numbers: the size of the net leg, and one clearing
   limit for each side. Every other value comes from chain state. The
   settler's numbers can only size or select. They cannot move value.
4. **Who takes part.** A deposit request takes part only if its own limit is
   at or above the deposit clearing limit. A redemption request takes part
   only if its own limit is at or below the redemption clearing limit. A
   request that does not take part stays pending. A request's own limit never
   makes a settlement revert.
5. **Hold.** Shares from a deposit stay in the queue until
   `settle time + minHold`. The owner then claims them. Redemption USDC is
   claimable at once.
6. **Roll.** The unfilled part of a request stays pending for the next
   epoch. After `maxRoll` epochs anyone can refund it.

#### 5.9.3 One settlement, step by step

`settle` runs in one transaction. Any failed check reverts it and changes no
state. A blocked epoch stays pending. No role can settle a blocked epoch.

**Before any trade**

1. **Time and state.** The window has ended. The caller is the keeper, or
   `keeperGrace` has passed. The queue is not paused. While deposits are
   paused, the fund is shut down or a lending asset is excluded, deposit
   requests take no part: there is no match and no net deposit, and
   redemptions settle alone.
2. **Feed health.** The Base sequencer feed reports up, and has been up for
   `sequencerGrace`. Every basket asset's feed is younger than `maxFeedAge`
   and positive.
3. **Internal TWAP.** For each basket asset, one `observe` call returns the
   mean tick of each slice of the window. There are `slices` equal slices. At
   least `quorum` of them sit within `dispersionBps` of the median. A push
   made and undone inside one transaction leaves no trace in this history.
4. **TWAP against feed.** Each median is within `refBandBps` of its feed.
5. **Spot against both.** Each pool's spot is within `settleBandBps` of its
   median and of its feed.
6. **Lending growth.** Each lending position grew by at most
   `maxLendGrowthBps` per day since the last settlement.
7. **Share price.** Compute the NAV per share twice: at the medians (`S`) and
   at the feeds. They agree within `refBandBps`. `S` moved at most
   `maxSharePriceMoveBps` for each epoch that has passed since the last
   settlement.
8. **Snapshot.** Record the amount of every asset, the idle USDC and the
   supply.

**The flows**

9. **Match** the deposits and redemptions that take part, at `S`. Redeemers'
   shares go to depositors. Depositors pay `S` per share. Redeemers receive
   that USDC minus the exit fee, which goes to the fee recipient as on a
   redemption today. The fund's assets and supply do not change.
10. **Net leg.** Its value is at most the larger of `maxEpochNetBps` of NAV
    and `epochNetFloorUsdc`. A net deposit must also leave NAV at or under
    the TVL cap. Requests fill pro rata under these caps.
    - **Net deposit.** The fund buys the same fraction of every asset. It
      keeps that fraction of idle USDC, supplies that fraction to each
      lending venue, and buys that fraction of each basket token with an
      exact-output swap. It mints that fraction of the supply to the queue,
      less `entryPremiumBps`. Purchases round up and the mint rounds down,
      both in the holders' favour. Unused USDC stays pending.
    - **Net redemption.** The fund burns the net shares, sells their
      pro-rata slice and pays the realized USDC minus the exit fee.

**After the trades, in the same transaction**

11. **Proportion check.** For every asset and for idle USDC:
    `amount after × supply before ≥ amount before × supply after`. For a net
    redemption the two sides differ by rounding only. This is RB-13.
12. **Value check.** The USDC spent per share minted, or received per share
    burned, is within `valueBandBps` of the feed NAV per share. It is
    measured before the entry premium and the exit fee.
13. **Clearing limits.** Every price a depositor pays is at or below the
    deposit clearing limit: `S` on the match, and the cost per share on a net
    deposit. Every price a redeemer receives is at or above the redemption
    clearing limit: `S` less the exit fee on the match, and the proceeds per
    share less the exit fee on a net redemption. With rule 4 of §5.9.2, every
    fill is then inside its own request's limit (RB-14).
14. **Record.** Shares from a deposit stay in the queue until
    `settle time + minHold`.

#### 5.9.4 Exits and emergency powers

**Exits that never depend on a price or on the checks above:**

- `cancel` of an unsettled request, by its owner.
- `redeemInKind` for shares in a wallet. It has its own proportion check.
- `exitInKind` for shares waiting in the queue, by their owner.
- `refund` after `maxRoll`, by anyone, to the request's owner.

**Emergency powers. Each can only delay or return.**

- `EMERGENCY_ROLE` can pause the queue. The exits stay open.
- `EMERGENCY_ROLE` can freeze the shares from one epoch's deposits while
  they are in their hold. The Safe then releases them to their depositors, or
  returns them to their depositors in kind. Nobody else can receive them.

#### 5.9.5 Working defaults

| Parameter | Default | Layer |
| --- | --- | --- |
| `epochLength`, `settleWindow`, `minHold` | 6 h, 1 h, 24 h | 4 |
| `keeperGrace` | 6 h | 4 |
| `maxEpochNetBps` | 500 | 4 |
| `epochNetFloorUsdc` | 250,000 USDC | 4 |
| `maxSharePriceMoveBps` | 1,000 for each epoch passed | 4 |
| `maxRoll` | 8 epochs | 4 |
| `minRequestUsdc` | 100 USDC | 4 |
| `maxRequestsPerEpoch` | 200 | 4 |
| `entryPremiumBps` | 0 | 4 |
| `slices`, `quorum`, `dispersionBps` | 12 of 5 min each, 9, 100 | 3 |
| `settleBandBps` | 50, and above the pool fee | 3 |
| `valueBandBps` | 100 | 2 |
| `refBandBps` | 100 | 2 |
| `maxFeedAge` | The feed's heartbeat plus 5 minutes | 2 |
| `sequencerGrace` | 1 h | 2 |
| `maxLendGrowthBps` | 10 per day | 2 |
| `poolShareBps` | 2,500 | Asset rule (§4.5) |

Every value is an estimate until the sim sets it from the normal range. The
reason is then recorded. `epochNetFloorUsdc` exists so that a small or newly
seeded fund can grow. Without it the 5% cap would hold a seeded fund to 5%
growth per epoch.

#### 5.9.6 The vault interface: the ERC shape, not the letter

The fund is an ERC-4626 vault in shape, with ERC-7540's request and claim
flow. It departs from both where safety or size calls for it (owner,
2026-11-11, D13). Each departure is listed, so clients are not surprised.

**Kept from the standards** (ERC-7540's text was read on 2026-11-11):

- The asset is USDC. The share is the fund's ERC-20.
- `requestDeposit` and `requestRedeem` open requests. Shares leave the
  owner's custody at the request.
- `deposit`, `mint` and `redeem` claim a settled request.
- The preview functions revert, as ERC-7540 requires for asynchronous flows.
- Pending and claimable views, and the request events.
- `totalAssets` and the convert functions, as views at the TWAP.

**Deliberate departures:**

| Departure | Why |
| --- | --- |
| Each request takes a limit. | A standard request accepts any price. |
| `cancel`, `exitInKind`, `redeemInKind` and `refund` exist. | The standard has no cancel. Exits must never depend on a price. |
| Shares from a deposit become claimable only after `minHold`. | The hold (owner direction). |
| `withdraw` reverts `RedeemOnly`, as on the basket vaults today. | One claim function for redemptions. The fund never offered an exact-assets exit (§4.4). |
| `totalAssets` and the convert functions revert when a feed is unhealthy. | A view that returns a number nobody should trust invites a lender to trust it. |
| There are no operators. A request pulls USDC or shares from the caller only. Operators, ERC-165 ids and the ERC-7575 `share` method are added only if a client needs them. | Each costs bytes under G1 and adds surface to audit. |

**Where the functions live.** The request and claim functions are on the
fund, as thin calls into the queue. The fund is then the one address a client
uses. Work package 1 of the engineering plan measures the bytes. If they do
not fit under G1, the functions move to the queue and the fund stays the
share token. That fallback is recorded in §14 if it is used. Custody of the
fund's assets stays in the fund either way.

Lenders that list the share must use a capped rate, never the raw view.

#### 5.9.7 What it costs

- **Deposits no longer fill deficits.** A pro-rata deposit does not change
  weights. D7 ends for deposits (D11). The rebalancer does that work. Step 3d
  measures the change in G4 cost.
- **Every net deposit buys every asset.** The depositors of the epoch pay
  that cost.
- **More blocked epochs.** Every check must pass. Each added check adds false
  alarms. The sim reports the blocked share per check. A design that blocks
  often in normal markets fails on usefulness.
- **Feed dependence for liveness.** A feed outage stops settlement. It does
  not stop the exits.
- **Fewer assets.** §4.5 excludes any asset without a feed.
- **A residual on the match.** A matched user can get a price up to
  `refBandBps` from the feed, and never worse than their own limit. Holders
  cannot lose to it.
- **A residual after the keeper fails.** After `keeperGrace` anyone can
  settle. A hostile settler cannot take value. It can size the net leg small,
  so users wait another epoch.
- **No audited precedent** for the in-fund pro-rata purchase (§15.8). The
  on-chain proportion check backs the argument with an assertion.
- **Redemption is not synchronous** (D10). `redeemInKind` stays instant.

If the measured deposit cost is too high, the fallback is a NAV mint at the
outside feeds, settled in the same epochs. It adds no trusted pricing role.

### 5.10 The same layers on the rebalance (step 3e)

A flow no longer changes weights. A step is then the only trade made at a
price someone asserts. Each step gets:

- **Feed health, TWAP against feed, and spot against both** (checks 2, 4 and
  5 of §5.9.3) before it trades.
- **A floor from the lower of the TWAP and the feed.**
- **Cost booked against the feed**, which the fund cannot move. This fixes
  the under-reporting in cost report §4.
- **A balance check of its own:** only the two traded assets and idle USDC
  change, and the supply does not (RB-19).

Until step 3e is built, §5.3 to §5.8 and RB-4 and RB-5 describe the step as
it is: priced and booked at the TWAP alone.

## 6. Contract changes

| Contract | Today | Proposed |
| --- | --- | --- |
| `RobotMoneyVault` (rmUSDC) | Lending vault | Retired (withdraw-only, ADR-0009). Its ADP-2 exclusion and `ExclusionLedger` move into the fund. Each lending adapter becomes one fund asset with its own target and `capBps`. |
| `BasketVault`, `ProtocolAssetVault`, `RwaBasketVault` | Basket vaults | Retired (withdraw-only). TWAP valuation, ORA-4, slippage floors, `redeemInKind`, and emergency unwind move into the fund. Each basket token becomes one fund asset. |
| `AgentTokenVault` | Parked | Stays parked. The fund lists no agent-token asset, so the receipt's agent bucket must be 0. |
| `PortfolioRouter` | Splits deposits | **Deleted** for new deployments. The live router is retired: default weights cleared and deposits stopped. |
| `RouterGovernance` | `applyReceipt` sets router weights | Renamed `RebalanceGovernance`. `applyReceipt` sets the vault target and opens a plan. `setDefaultWeights` becomes `setTarget(assets, bps, params)` (a plan with no receipt, for bootstrap and drift correction). Both take a per-asset vector. |
| `VaultRegistry` | Status and router eligibility | Not needed by a one-vault deployment. The fund holds its own lifecycle status. The live registry stays to run v1 retirement. Working default: not kept (§11, D4). |
| `ConsensusRecommendationReceipt` | Signalling register | **Unchanged.** The release role moves from `RouterGovernance` to `RebalanceGovernance`. The payload it anchors gains the optional `assets` field (schema 1.1), which the contract never reads. |
| `RobotMoneyFund` | — | **New.** One ERC-4626 vault in shape (§5.9.6) with a flat asset list, one target weight per asset, plan state, `executeStep` callable only by the `Rebalancer`, and the pro-rata purchase and sale callable only by the `FlowQueue`. No sleeve state. |
| `FlowQueue` | — | **New.** Holds pending USDC, escrowed shares and shares in their hold. Runs the settlement checks of §5.9.3. Holds none of the fund's assets. |
| `Rebalancer` | — | **New.** Holds no funds. Computes and validates steps, then calls the fund. Separate contract to keep the fund under EIP-170. |
| Lending and swap adapters | Used by their vaults | Unchanged, with one addition: the swap adapters need an exact-output swap for the pro-rata purchase (§5.9.3, check 10). Their owning vault becomes the fund. |
| `RobotMoneyGateway` (separate system) | Allows deposits into three vaults | Its allowed-destination list becomes the fund's queue. It must use request and claim (D10). Done in the gateway's own release. The fund does not name the gateway (architecture §1 dependency rule holds). |

### 6.1 Size and gas

The fund is the union of `RobotMoneyVault` and `BasketVault`, and
`BasketVault` is already EIP-170 tight. This is ADR-0010's M-A2 risk and it
does not go away. The plan:

- Keep the fund's own code to share accounting, the pro-rata purchase and
  sale, `redeemInKind`, lifecycle, and `executeStep`.
- Put requests and the settlement checks in the `FlowQueue`.
- Put step selection, path math and cost accounting in the `Rebalancer`.
- Reuse the linked libraries that exist (`BasketViews`,
  `BasketAssetConfigGuard`, `TwapTickMath`) and add one for the lending
  allocator.
- Prove the fit first. Step 2 did this for the synchronous fund (G1, §14).
  Step 3d measures it again with the queue wired in.

A redemption touches every position: three lending adapters and two protocol
tokens, plus one RWA token through step 3c. That is more external calls than
any single vault today. Gas is not a gate in the experiment (G2 was dropped
on 2026-11-09). A production path would measure it against the redeem gas
budget (`docs/technical/redeem-gas-1482.md`).

## 7. New invariants

These are the invariants the experiment must prove (gate G3). They join §8 of the architecture only if the rejection is invalidated.

- **RB-1.** Only a timelock-executed `RebalanceGovernance` call can set a
  target or open a plan.
- **RB-2.** `Rebalancer.step()` takes no amounts, assets, floors, or recipients
  as input. Every value comes from chain state.
- **RB-3.** A step never moves assets out of the fund except into an
  allowlisted adapter or swap venue, and every swap's recipient is the fund
  (INV-1 holds).
- **RB-4.** A step never lets the TWAP NAV fall by more than
  `maxStepCostBps` of its notional, and a plan never spends more than its
  budget without a new Safe decision. From step 3e the cost is measured
  against the outside feed (§5.10).
- **RB-5.** No step runs while any traded asset fails the ORA-4 check, or
  before `stepInterval` has passed. From step 3e a step also needs healthy
  feeds that agree with the TWAP and spot (§5.10).
- **RB-6.** Rebalancing state never blocks a redemption request, its
  settlement or `redeemInKind`.
- **RB-7.** The rebalancer never moves the vault past `pathTarget(now)`.
- **RB-8.** The receipt contract stays signalling-only (INV-4). It never calls
  the fund, the rebalancer, or governance.
- **RB-9.** A target vector names every active asset exactly once and sums
  to 10,000. No contract stores or reads a sleeve or category.
- **RB-10.** No shares leave the queue and no USDC is paid before the
  epoch's settlement window ends (§5.9). The only exceptions are cancel,
  refund and in-kind exit, which return a user's own escrow.
- **RB-11.** Shares from a deposit leave the queue no sooner than
  `settle time + minHold`.
- **RB-12.** A blocked epoch trades nothing. No role can settle it. A cancel
  or refund returns exactly what was escrowed.
- **RB-13.** No flow lowers the amount of any asset per share, except by
  rounding in the holders' favour. Settlement and `redeemInKind` assert this
  on chain.
- **RB-14.** No request fills outside its limit.
- **RB-15.** A failed settlement changes no state. Cancel works for every
  unsettled request, and in-kind exit for every unsettled redemption request,
  also while the queue is paused.
- **RB-16.** Nothing settles unless every check of §5.9.3 passes: time and
  state, feed health, the TWAP quorum, TWAP against feed, spot against both,
  lending growth, the two share-price checks, the size caps, the proportion
  check, the value check and the clearing limits.
- **RB-17.** No basket asset is active without a feed and pool history, and
  no target exceeds its pool-share limit (§4.5).
- **RB-18.** Frozen held shares can only go to their depositors, as shares or
  in kind (§5.9.4).
- **RB-19.** From step 3e, a step changes only its two traded assets and idle
  USDC, never the supply, and runs only when the feed checks of §5.10 pass.

## 8. Off-chain changes

- **Receipt "applied" state** (architecture §4.9.3) compares the receipt with
  the fund's target instead of the router vector. A new third state,
  **converged**, comes from the plan status. The dapp shows recorded → applied
  → converging (with progress) → converged.
- **Receipt schema 1.1.** `consensus-receipt.schema.json` gains the optional
  `assets` field (§4.1) as a minor bump. The shared fixtures stay
  byte-identical with `robotmoney-frontend`, so the frontend repo takes the
  same schema change. Its assembler builds `assets` and refuses a receipt
  that fails the bucket audit check. Who chooses the per-asset weights is
  open (§11, D8).
- **Asset map fixture.** `contracts/test/prototype/fixtures/receipt/asset-map.json`
  maps each asset key to the fund's asset id and bucket per chain. It replaces the bucket-to-vault map.
- **Dapp.** One deposit flow, one position, one NAV. The portfolio composite
  view (architecture §2.2) becomes a per-asset breakdown, grouped by the receipt's sleeve
  labels. A plan panel shows target, current, path, steps, and cost.
- **Request and claim (D10).** The dapp, `rmpc`, the gateway and the indexer
  need request, pending, claimable and claim views, and cancel. This is a new
  kind of surface for each client. It counts against G6.
- **rmpc.** Request, pending, claimable, claim and cancel commands replace
  the deposit preview, because the preview functions revert (§5.9.6).
  Preflight points at one vault. Read commands gain `plan` and `assets`. `receipt verify` runs the bucket audit check.
- **Explorer and indexer.** New tables for plans, steps, epochs and requests.
  Router tables go read-only for history.
- **Watchdog.** Watches step cost against caps, plan halts, and keeper
  liveness. It also watches blocked epochs, by check, and feed health.
- **publish-contracts.** New stages for the fund, the rebalancer and the
  queue. The router,
  registry-eligibility and three-vault stages go. The `apply-receipt` govern
  row targets `RebalanceGovernance` and prints `previewPlan` first. New rows:
  `pause-rebalance`, `resume-plan`, `extend-plan-budget`, `close-plan`,
  `set-step-params`, `seed-fund`, `set-flow-params`, `pause-queue`,
  `freeze-epoch`, `release-epoch` and `return-epoch-in-kind`.
- **Keeper.** A new small service. It calls `step()` and settles each epoch
  (§5.9.2). It needs a key with `KEEPER_ROLE` only, a runbook, and monitoring.

## 9. Migration

Out of the experiment's scope (owner, 2026-11-09). This section records the
production path only. ADR-0009 holds: there is no on-chain migration of holder funds.

1. Deploy the fund, the rebalancer, the queue and `RebalanceGovernance` as a
   fresh set of proxies (ADR-0014). Grant roles. Hand `ADMIN_ROLE` to the
   timelock.
2. The Safe seeds the fund with USDC. It then sets the opening target with
   `setTarget`. The first plan moves the seed to the target. The order
   matters: a plan opened on an empty fund halts (§14). D11 ended
   deficit-first deposits, so deposits no longer do this allocation.
3. Grant the release role on the receipt contract to `RebalanceGovernance`
   and revoke it from `RouterGovernance`.
4. Retire the router: clear its default weights and stop router deposits.
5. Retire rmUSDC, rmPROTO and rmRWA through the registry (withdraw-only).
   Holders redeem from the old vaults and request a deposit into the fund
   themselves. The dapp guides them. The deposit settles with its epoch, and
   its shares are held for one day (§5.9).
6. The retired vaults keep their obligations: maintained TWAP pools and the
   V3 price sources they read, as ADR-0010 §8 and ADR-0009 already note.

Each step is a governed, reviewable action with its own govern row and
evidence, like today's releases. The order matters: the release role must
move before the old governance contract could apply another receipt to a
router that no longer matters.

## 10. Experiment phases

The experiment runs on its own branch as quick forge unit tests only. There
is no Twin, no deploy, no anvil and no RPC in a test run. Only recording a
fixture uses the network, through an anvil the recorder starts and stops
itself. Each phase ends with evidence written into §14.

**How tests get real Base state.** Every prototype test extends
`contracts/test/prototype/BaseFixture.sol`. In the default replay mode it loads
`contracts/test/prototype/fixtures/base-state.alloc.json` with `vm.loadAllocs`
and sets block, timestamp, base fee and chain id from `base-state.meta.json`.
That is real Base (8453) state at one pinned block: the real USDC, the real
Uniswap V3 pools for wETH, cbBTC and deSPXA, SwapRouter02, Aave V3, Compound V3
and Moonwell. The tests run in forge's in-process EVM (the same revm anvil
uses) in milliseconds.

The fixture is lazy: it holds only the accounts and slots a recording run read.
`scripts/prototype/record-base-fixture.ts` records it. It starts its own
anvil forked from Base at a pin, so each account and slot crosses the network
once. It runs the same tests through that anvil, then stops it. That happens
on success, on error and on Ctrl-C, so no anvil outlives a recording. It
converts forge's fork cache (the original value of every account and slot
fetched) into the fixture, then replays with no RPC and no anvil to prove
coverage. `--sim` records the default and tuned simulation runs too. A slot the fixture lacks would read as zero, a silent wrong
answer. So each test checks after its body that every slot it read first is in
the fixture, and that every contract it called is in the fixture or was created
by the test. A miss fails `FixtureSlotMiss(account, slot)` or
`FixtureAccountMiss(account)`, and the fix is to re-record. Recording is the
only step that touches the network.

Scope (owner, 2026-11-09): no migration, no gas measurement, and the
smallest test set that still scores the gates. The full contracts come first.

1. **Full prototype contracts.** *Done 2026-11-09.* Fund, rebalancer and governance, complete
   against §4, §5 and §6 in one pass.
2. **Fixture tests.** *Done 2026-11-09: G1 pass, G3 pass with listed gaps.* Re-record the fixture, then a minimal set: the size
   check (G1), one end-to-end receipt-to-converged test, one test per row of
   §5.8, and one invariant run over §7 (G3).
3. **Rebalance simulation.** *Done 2026-11-10: G4 fail, G5 not pass.* On the replay fixture, apply a small set of
   receipt vectors (the anchored historical receipts plus a few extreme
   moves) and run each plan to the end with a simulated keeper. Between
   steps, move pool prices with arbitrage-sized swaps. Measure realized cost,
   time to converge, and steps skipped. This answers G4 and G5.
3b. **Per-asset targets (owner, 2026-11-10).** *Done 2026-11-10: exact regression match.* Remove sleeves from the
   contracts, as §4.1 now describes. The rebalancer already works per asset,
   so step selection, path math and cost accounting do not change. The
   refactor must show that by test:
   - The fund drops `sleeve`, `intraBps`, `setIntraBps`, `targetSleeveBps` and
     the sleeve constants. `setTargetAndOpenPlan`, `applyReceipt`, `setTarget`
     and `previewPlan` take `(assets, bps)` and enforce the §4.1 checks.
   - A schema 1.1 receipt fixture with `assets`, an asset map fixture, and a
     small checker for the bucket audit rule, with pass and refuse cases.
   - The tests, the invariant run and the §5.8 tests move to per-asset
     vectors. New tests cover RB-9: an unlisted active asset, a duplicate, an
     inactive asset and a bad sum all revert and release nothing.
   - The sim turns each scenario receipt into the same per-asset targets the
     sleeve design produced. G4 and G5 must then reproduce the §14 numbers
     exactly. Any difference is a bug in the refactor, not a new result.
   - Re-measure G1 sizes. Re-record the fixture only if a test reports a miss.
3c. **Fallbacks for G4 and G5.** *Done 2026-11-10: the auction fails G4 and G5. LP response is a sensitivity only.* §13 scoring requires testing a stated
   fallback before a non-G1, non-G3 failure counts. This runs on the 3b
   contracts. The §13 thresholds and the scorer's cost definition stay fixed.
   - G4: an auction executor (§12) behind the existing `executeStep`
     interface, scored on the same scenarios, seeds and pin.
   - G5: every failing plan pushed a basket pool out of its recorded LP
     range, where the sim holds liquidity fixed. Either model LP response
     outside the range, or record the gap as a stated limit of the result.
     The conclusion names which.
3d. **Attack mitigations: timed, quantity-based flows (owner, 2026-11-11).** *Next.*
   Build and test the §5.9 design. Score G8. This runs on the 3b contracts.
   The engineering plan is `one-vault-timed-flows-eng-plan.md`.
   - **Attack tests.** Each models the attacker's full profit and loss. Each
     runs against the synchronous fund (the baseline) and the §5.9 fund. The
     baseline is a frozen copy of the step 3c fund, kept for these tests.
     - A1, Makina replay: one transaction, a flash loan, a pushed pool, then
       a deposit or a redeem. Once per basket pool.
     - A2, TWAP push: hold a pushed price for 1 to N blocks against the
       sim's arbitrage.
     - A3, deflate then deposit, then exit.
     - A4, lending rate: move a lending venue's exchange rate.
     - A5, round trip in one block and in consecutive blocks.
     - A6, TWAP lag with a hedge, and no manipulation.
     - A7, sandwich by the caller of `settle`.
     - A8, blocking an epoch, or filling it small after the keeper fails.
       Report the cost per hour.
     - A9, a holder distorting the settlement price to skim the match.
     - A10, a slow ramp of a pool with no arbitrage.
     - A11, griefing the hold of a pooled account.
     - A12, a batch larger than pool depth.
   - **The mechanism:** the queue, the in-fund pro-rata purchase, the match,
     limits, the fourteen checks of §5.9.3, the hold, the freeze and the
     refund after `maxRoll`. The asset list follows §4.5: no deSPXA. The fund
     must still pass G1, and the queue is held to the same size limit. The
     exclusion ledger must credit queued shares to their owners.
   - **Tests for RB-10 to RB-18.** Each check of §5.9.3 has a test that
     trips it alone and shows that nothing settles. G3 is scored again over
     RB-1 to RB-18.
   - **Rerun the step 3 sim with timed flows.** Measure the deposit cost per
     USDC, the wait, how often an epoch is blocked or rolled and by which
     check, the matched share of flows, and the change in G4 cost from
     ending deficit-first deposits. Both arms of that comparison run on the
     §4.5 asset list: the frozen synchronous fund and the timed fund. Set
     every value of §5.9.5 from the sim's normal range. This run is reported.
     G4 and G5 are scored in step 3e (§13).
   - Write the attack results and G8 into §14.
3e. **The layers on the rebalance, and the rerun.** *After 3d.* Build §5.10:
   feed checks and the balance check on each step (RB-19), the floor from the
   lower of TWAP and feed, and cost booked against the feed. Score G3 again
   with RB-19. Then rerun the step 3 sim on the final design and score G4 and
   G5 (§13 says which run counts). These rules for the rerun are fixed now,
   before any result:
   - The asset list is §4.5: the three lending assets, wETH and cbBTC.
   - Each replayed receipt's deSPXA weight is spread over its other assets in
     proportion to their weights in the same receipt.
   - The EXT scenarios move between all lending and all basket, where the
     basket is wETH and cbBTC at their receipt proportions.
   - The JUMP scenarios move the wETH price by the same size and at the same
     time as they moved deSPXA.
   - Scenarios, seeds, the pin, the thresholds and the scorer's cost
     definition do not change.
   The step 3 results stay in §14 beside the new ones.
4. **System size count.** *After 3e.* Count the contracts, deploy stages, govern rows and
   `ADMIN_ROLE` holders against today's, with the queue and its rows included.
   Score G6's client clause too: §8 already records that request and claim is
   a new kind of surface for each client. No client is built. This answers G6.
5. **Conclusion.** Score every gate in §13. Write the result ADR (§3).

If the experiment invalidates the rejection, the production path that
follows is: ADR, canonical doc rewrite, external audit, 8453 rehearsal,
mainnet deploy, then retiring the old set (§9). That path is not part of
the experiment.

## 11. Working defaults for the experiment

These are decided for the experiment so the work is not blocked. Each one is
recorded so the conclusion can revisit it.

| ID | Question | Working default | Why |
| --- | --- | --- | --- |
| D1 | Is rebalance cost shared by all holders, within caps? | Yes. | Without it a receipt cannot move existing money. G4 measures whether the cost is acceptable. |
| D2 | Do users lose the choice of a single exposure (for example rmUSDC only)? | Yes, in the experiment. | It tests the cleanest form. Keeping a separate stable-only vault next to the fund is a fallback the conclusion can choose. |
| D3 | Who triggers steps? | Keeper first, anyone after `keeperGrace`. | Liveness without trusting Robot Money to stay online. |
| D4 | Keep `VaultRegistry` for the fund? | No. | One vault has nothing to register. G6 counts the saving. |
| D5 | Does the rebalancer correct market drift between receipts? | No. Only an applied receipt or a Safe `setTarget` opens a plan. | Drift between receipts is the committee's call. |
| D6 | Name of the vault and share? | `RobotMoneyFund` / `rmFUND`. | Working name only. |
| D7 | Deposit routing? | Deficit-first, through step 3c. Ended for deposits by D11. | It lowers rebalance cost. G4 measures by how much. |
| D8 | Who chooses per-asset weights? | For the experiment, receipt fixtures carry hand-written asset weights. | The analysts sign bucket weights today. Production needs either per-asset analyst weights or a published, deterministic split rule in the assembler. That choice lives in `robotmoney-frontend` and is out of the experiment's scope. |
| D9 | Are sleeves on chain? | No. The receipt labels each asset with a sleeve. The contracts keep only assets and targets. | One layer of allocation governance instead of two. Owner, 2026-11-10. |
| D10 | Do deposits and redemptions settle in timed epochs (§5.9)? | Yes. Accepted by the owner, 2026-11-11. Customers can wait. `redeemInKind` stays instant. | It removes same-block and flash-loan flows. The cost is the synchronous-redemption promise in architecture §4.4, and the owner accepts that. If the design goes to production, the production path (§10) changes architecture §4.4. |
| D11 | How is a flow priced? | By quantity. A net deposit buys the same fraction of every asset and mints by that fraction. A net redemption pays realized proceeds of a pro-rata slice. NAV is a guard. It prices only the match between the users of one epoch. Decided 2026-11-11 after research (§15.8). | Holders are safe whatever any price says, and whatever assets the fund holds. The cost is deficit-first deposits (D7) and an in-fund purchase with no audited precedent. If the measured deposit cost is too high, or instant deposits were ever required, a NAV mint at independent feeds is the alternative. |
| D12 | What must an asset have to be listed? | An independent feed on Base that is live at all hours, a pool with one settlement window of history, and a largest position that fits its pool (§4.5). Approved 2026-11-11. deSPXA leaves until it has a feed. | The outside-feed layer needs a feed for every asset. The assets can change to fit the protocol. |
| D13 | How closely does the fund follow ERC-4626 and ERC-7540? | In shape, not to the letter. Departures are listed in §5.9.6. Owner, 2026-11-11. | Being an ERC-4626 vault is a core requirement. Safety practice from hardened protocols comes before interface detail. |
| D14 | What may stop a settlement, and what may set a share count? | Four layers may stop it: quantity, outside feeds, internal TWAP, time and rate. Only quantity sets how many shares are minted or burned. The match between users crosses at the settlement price, inside each side's limit. No role can override a blocked settlement. Approved 2026-11-11 (§16). | An attacker must beat all four at once. A false alarm costs time only. |

## 12. Alternatives considered

- **Keep the router, add rebalancing between vaults.** A rebalancer that
  redeems from one vault and deposits into another, holding shares for
  users. It keeps the audited vaults. It was rejected because the router
  holds no assets and users hold vault shares directly, so the router cannot
  move a user's money without custody it does not have. Adding custody to the
  router makes it a fund anyway, with exit fees and slippage floors paid on
  every internal hop.
- **A fund-of-vaults wrapper.** One outer share token over internal rmUSDC,
  rmPROTO and rmRWA positions. It reuses audited code. It was rejected because
  internal moves go through `redeem` and `deposit` of whole vaults: proportional
  sells across every basket asset, exit fees, and no control over which asset
  trades. Fine-grained, TWAP-bounded steps are not possible through that
  surface. It also keeps every contract the proposal wants to remove.
- **Instant rebalance on apply.** One large trade per asset when the receipt is
  applied. It is simple, but slippage on deSPXA and size on any asset make it
  expensive and easy to sandwich. Rejected.
- **Auction-based rebalance** (CoW-style batch auctions, Dutch auctions per
  asset). This gives better prices on large moves but needs an off-chain
  solver set or an auction contract and a new trust boundary. Step 3c tested
  a Dutch auction executor behind `executeStep`. It failed G4 and G5 (§14).
  It is not adopted.
- **`forceRebalance` only (ADR-0010's model).** No shared cost, but nobody is
  obliged to pay for rebalancing, so in practice a receipt still moves
  nothing. Rejected for the same reason as the status quo.

## 13. Gates: what validates or invalidates the rejection

Each gate maps to a reason ADR-0010 was rejected, or to a new risk this design
adds. A gate is scored **pass** (supports the one-vault design) or **fail**
(supports the rejection). Thresholds are set now, before any results, so the
result cannot move them.

| Gate | Question | Pass | Fail | Tests the rejection reason |
| --- | --- | --- | --- | --- |
| G1 | Does the fund fit EIP-170 with today's optimizer settings and the rebalancer split out? | Fund and rebalancer each deploy under 24,576 bytes with at least 1 KB headroom. | Either needs a further contract split that moves custody or accounting out of the fund. | ADR-0010 M-A2 (size pressure moves, it does not disappear) |
| G2 | Dropped (owner, 2026-11-09): gas is not a gate. | | | |
| G3 | Do the invariants hold under adversarial tests? | Every RB invariant (§7) and every existing custody invariant has a passing invariant or fork test, and every §5.8 threat has a test that shows the defence works. | Any invariant cannot be made to hold without a design change to custody or share accounting. | Audited-design safety, the core of the rejection |
| G4 | Is the shared rebalance cost acceptable? | Across the replayed receipts, median realized cost is at most 15 bps of turnover and no plan exceeds 30 bps. | Median above 15 bps, or any plan above 30 bps with default parameters. | New risk (D1). The reason ADR-0003 refused socialized cost |
| G5 | Does a plan actually converge? | Every replayed plan converges within `duration + maxOverrun`, and fewer than 10% of step attempts are skipped. | Any plan expires unconverged on a liquid asset (wETH, cbBTC), or skips exceed 10%. | New risk: the glide path is only useful if it finishes |
| G6 | Is the system smaller to build and operate? | Net contracts, deploy stages, govern rows and `ADMIN_ROLE` holders all go down, and every client change in §8 maps onto an existing surface. | Any of those counts goes up, or a client change in §8 needs a new kind of surface. | "Migration cost is not worth it" |
| G7 | Dropped (owner, 2026-11-09): migration is out of scope. | | | |
| G8 | Can an attacker drain value by moving prices? (Added 2026-11-11, before any step 3d result.) | Every attack test (A1 to A12, §10 step 3d) shows the attacker's net result (gain minus the cost of moving and holding prices, flash-loan fees and swap fees) is at most zero. No pending depositor or redeemer fills outside their limit. Holders lose at most 1 bps of NAV, and no asset amount per share falls. Every RB-10 to RB-18 test passes. The cost per hour to block settlement is reported. (Amended 2026-11-11, before any result, per §15.) | Any attack shows a positive net result for the attacker, or holders lose more than 1 bps of NAV, or a request fills outside its limit, in any attack scenario. | New risk: a pooled fund prices every flow from markets it does not control |

**Scoring.** All live gates pass: the rejection is invalidated. G1 or G3
fails: the rejection is validated, because those are the reasons it was made. Any
other failure: the conclusion records it, then decides whether a stated
fallback (for example D2's separate stable vault, or an auction executor for
G4) would turn it into a pass, and tests that fallback before concluding.

**Which run counts for G4 and G5 (2026-11-11).** G4 failed and G5 did not
pass in step 3. The auction fallback also failed (step 3c). The design then
changed: the asset rule (D12), quantity-based flows (D11) and cost booked
against outside feeds (§5.10). Together these are the stated fallback. Step
3e tests it under rules fixed before any result (§10). Step 5 scores G4 and
G5 on the step 3e run, because that is the design that would go forward. The
step 3 result stays in §14 as the result of the first design. The conclusion
reports both. The thresholds and the scorer's cost definition do not change.

**G3 is scored again** in steps 3d and 3e, because §7 grew from RB-9 to
RB-19 after its first score.

## 14. Evidence log

Filled in as each phase finishes. Every row links to the commit, test run or
fixture pin it rests on.

| Gate | Result | Evidence | Date |
| --- | --- | --- | --- |
| G1 | Pass | `SizeGate.t.sol`. After step 3b the fund implementation is 21,996 bytes, 1,556 under the 23,552 limit. Rebalancer is 18,001 bytes. The fund fits only with three linked libraries: `FundFlowsLib` (19,285), `FundAdminLib` (10,777) and `FundValuationLib` (8,038). These hold code, not custody or accounting state. The fund also uses the counter admin floor, not the enumerable one. Before step 3b the fund was 22,775 bytes (pin 55371881). Re-measured 2026-11-11 at pin 55462550. | 2026-11-11 |
| G2 | Dropped | | |
| G3 | Pass, with listed prototype gaps | 29 fixture tests pass offline at pin 55371881 (563 accounts, 2,346 slots, no RPC). `Invariants.t.sol` (16 runs of 32 calls, fixed seed, fail on revert) checks RB-1 to RB-8 and INV-1. `EndToEnd.t.sol` runs deposit, receipt, timelock apply, steps to convergence, redeem and `redeemInKind`. `Adversarial.t.sol` has a passing test for all 8 rows of §5.8. `Custody.t.sol` covers INV-2 (donation accrual, first-depositor inflation) and INV-3 (fee and quarantine control only through the timelock). Review found 19 issues. 18 were fixed, among them a frozen venue that blocked `redeemInKind`, an admin able to grant the rebalancer role, and a gas-starvation lever on `step()`. Open gaps: a plan opened at zero NAV has a zero cost budget and halts until the admin extends it; dust on a removed basket asset is not re-absorbed (INV-2 port from `BasketVault` not done); a frozen lending venue still blocks the USDC `redeem` path, as it does today. | 2026-11-09 |
| G4 | Fail | `sim/RebalanceSim.t.sol` scored by `sim/score-sim.ts`, default parameters, 36 scored plans. Median realized cost is 17.02 bps of turnover. The worst plan costs 82.63 bps (JUMP-DOWN-1M-s2, receipt d07). Both exceed the 15 and 30 bps limits. Cost is measured against the reference price. Measured against the arrival price, the median is 5.48 bps and the worst is 9.13 bps. The tuned set also fails: median 17.76 bps, worst 83.40 bps. Fixture pin 55462550 (2,193 accounts, 17,310 slots), recorded through anvil forking Base. All 16 sim tests pass offline for each parameter set. Fallback (step 3c, not the scored result): the auction executor also fails, median 28.72 bps and worst 61.71 bps. The LP re-centre sensitivity does not change G4: median 17.20 bps, worst 59.19 bps. | 2026-11-11 |
| G5 | Not pass (no fail clause fired) | Same runs. No liquid-asset plan expired. Blocked skips are 4.99% of step attempts overall. One plan expired unconverged on deSPXA and the three lending assets: JUMP-DOWN-1M-s1, receipt d07. Its pool left the recorded LP range. Three JUMP-DOWN plans each skip more than 10% of their steps (27.0%, 61.3% and 13.5%). Without the five plans whose pool left its LP range, G5 passes: every plan converges and skips are 0.13%. The tuned set is worse: skips are 7.35%, and eight plans exceed 10%. Fallback (step 3c, not the scored result): the auction executor fails G5 at 10.63% blocked skips. With the LP re-centre sensitivity, G5 passes on the default steps (0.42% blocked, all plans converge). That model is an assumption, not a measurement. It does not replace this result. | 2026-11-11 |
| G6 | Not run | | |
| G8 | Not run | | |
| G7 | Dropped | | |

**Step 3 simulation (2026-11-10).** The sim replays real Base state at pin
55462550 with no RPC. It runs five scenarios. SEQ applies the anchored
historical receipts in order. EXT moves from all stable to all basket and
back. JUMP-DOWN and JUMP-UP move the deSPXA price sharply in the middle of a
plan. EXT-PROBE runs EXT at 5M USDC as a capacity probe. The probe is
reported but not scored. SEQ runs at 1M and 5M USDC. The others run at 1M
USDC. Each scored scenario runs three seeds. A simulated keeper steps every
30 minutes. Arbitrage swaps, noise swaps and user flows move pools between
steps.

| Scenario | Median cost (bps) | Worst cost (bps) | Blocked skips | Unconverged |
| --- | --- | --- | --- | --- |
| SEQ-1M | 12.54 | 26.50 | 0.19% | 0 of 12 |
| SEQ-5M | 21.52 | 59.19 | 0.37% | 0 of 12 |
| EXT-1M | 22.93 | 44.20 | 0.15% | 0 of 6 |
| JUMP-UP-1M | 19.62 | 21.76 | 2.99% | 0 of 3 |
| JUMP-DOWN-1M | 64.62 | 82.63 | 40.35% | 1 of 3 |
| EXT-PROBE-5M (not scored) | 51.02 | 92.31 | 0.00% | 2 of 2 |

These are default parameters. The tuned set changes two values. Plan
duration goes from 7 to 21 days. `minStepUsdc` goes from 100 to 33 USDC.
Tuning lowers EXT cost to a 14.02 bps median. It does not lower the overall
median. It raises skips. The sim treats pool liquidity as fixed at the pin.
Five scored plans saw a pool leave its recorded LP range, so their cost may
be overstated. Those five plans include every JUMP-DOWN plan.

The §13 fallback to test next for G4 is an auction executor (§12). The
result also depends on the cost measure. The reference-price reading fails.
The arrival-price reading passes.

**Step 3b (per-asset targets, 2026-11-10).** The contracts hold no sleeve.
`AssetConfig` has no `sleeve` and no `intraBps`. The fund has no
`setIntraBps` and no `targetSleeveBps`. `Plan` has no `sleeveBps`. The sleeve
constants and the sleeve checks are gone. `applyReceipt`, `setTarget`,
`setTargetAndOpenPlan` and `previewPlan` take `(assets, bps)`. An asset id is
the fund asset address. That is the token for a basket asset. It is the
adapter for a lending asset. `addAsset` refuses a second active asset with
the same id. `PlanMath.assetTargets` runs the §4.1 checks. Each has its own
error: `TargetAssetNotActive`, `TargetAssetDuplicate`, `TargetAssetMissing`,
`TargetSumInvalid` and `TargetExceedsCap`. A refused vector reverts the whole
`applyReceipt`, so nothing is released. `deactivateAsset` reverts with
`AssetStillTargeted` until a vector names the asset with 0. So an inactive
asset always has target 0.

RB-9 tests. `TargetVector.t.sol` has 11 tests. They cover an unlisted active
asset, a duplicate, an inactive asset, an unknown asset, a bad sum, a cap
breach, a length mismatch and any-order vectors. They also cover a wrong
payload digest, a duplicate asset id and deactivating a targeted asset. Each
refusal is checked through `applyReceipt`, `setTarget` and `previewPlan`.
After each refusal the receipt is still unreleased and no plan is open. The
invariant run sends six refused vectors before each valid apply. It checks
the persistent target in `invariant_targetVector`.

The receipt side has a schema 1.1 fixture with an `assets` list and an asset
map. They live in `contracts/test/prototype/fixtures/receipt/`.
`scripts/prototype/check-receipt-assets.ts` runs the bucket audit. It has 14
refuse fixtures, each with a named reason. Among them are a bucket sum mismatch, an unknown asset, a
duplicate, a relabelled asset and entries out of canonical order. Its tests
pass: 39 of 39.

Regression verdict: exact match. The sim submits per-asset vectors. Each one
equals the old sleeve split. The default set matches the sleeve baseline in
every field of all 16 files. The tuned set does too. G4 and G5 are unchanged.
The end-to-end test logs the same calls, steps and costs as before. 49
fixture tests pass offline at pin 55462550 (2,198 accounts, 17,447 slots).

| Contract | Before 3b (bytes) | After 3b (bytes) | G1 limit 23,552 |
| --- | --- | --- | --- |
| `RobotMoneyFund` | 22,775 | 21,996 | Pass, 1,556 under |
| `Rebalancer` | 17,893 | 18,001 | Pass, 5,551 under |
| `RebalanceGovernance` | 7,790 | 7,288 | Not gated |
| `FundFlowsLib` (linked) | 19,555 | 19,285 | Under EIP-170 |
| `FundAdminLib` (linked) | 12,072 | 10,777 | Under EIP-170 |
| `FundValuationLib` (linked) | 8,134 | 8,038 | Under EIP-170 |

**Step 3c (fallbacks, 2026-11-10).** Both fallbacks run on the 3b contracts.
They use the same scenarios, seeds and pin. The scorer is unchanged. The G4
and G5 rows above stay scored on the default run, as §13 says.

G4 fallback: a Dutch auction executor (`AuctionStepExecutor.sol`). It sits
behind `executeStep` as the basket swap adapter. Each leg opens at the TWAP
quote plus 50 bps. The price falls over 300 seconds to the path's own floor.
The step cost cap still binds. The sim's solver has no competitor. It keeps a
5 bps margin and pays 0.25 USDC gas per leg. It re-quotes at its fill block.
It can also fill at an outside venue of unlimited depth. Result: G4 fails.
The median is 28.72 bps and the worst plan is 61.71 bps. G5 also fails:
blocked skips are 10.63% of 11,421. Every scored plan converges. Most blocked
fills hit the 50 bps step cost cap at the deSPXA floor. The auction lowers the
worst plan. It raises the median and the skips. Its tests pass: 9 of 9.

G5 fallback: LP response. The static sim holds LP positions fixed. A switch
(`PROTO_SIM_LP=recenter`) models one LP that responds after a pool leaves its
range. The LP waits 6 hours. It then adds half the pin's liquidity within 500
ticks of the pool price. With it, G5 passes on the default steps. Blocked
skips are 0.42% and every plan converges. The auction run also passes G5 with
it, at 6.42%. G4 still fails: median 17.20 bps, worst 59.19 bps. Only the
plans that left the LP range change.

Recommendation: keep G4 and G5 as scored. Report the static G5 failure as a
limit of fixed liquidity. Show the LP sensitivity next to it. Do not count it
as a G5 pass. Its 6 hour lag and its depth are assumptions. The pin has no
record of how Base LPs respond to a 10% move. Measured LP timing and depth
after large moves would turn it into a verdict. The auction does not rescue
G4.

**Cost report (2026-11-11).** `one-vault-cost-report.md` explains the G4
result. Most of the cost is the fund's own buying premium left in the basket
pools, mostly deSPXA while the S&P is closed. The on-chain `costSpent` misses
that premium, so it shows about a third of the median cost.

## 15. Adversarial review of timed flows, and a corrected design

Status: review, 2026-11-11, decided the same day (§15.8). Nothing here is
built or tested. It reviews the first draft of §5.9, RB-10 to RB-12, D10, G8,
step 3d and `one-vault-timed-flows-eng-plan.md` (decisions E1 to E11). Those
sections have since been rewritten to the corrected design, so quotes below
refer to the first draft (commit 3feda2f6f). It was checked
against the prototype code, not only the text. §15.4 proposes a replacement
for the pricing part of §5.9. The owner's three time rules stay. Open owner
decisions are in §15.7.

### 15.1 Facts the review rests on

Each fact was read from the prototype under `contracts/test/prototype/src/`.

- **`redeem` does not read NAV.** `FundFlowsLib.redeemPayout` sells a pro-rata
  slice of every position. It pays the USDC actually realized, minus the exit
  fee. The TWAP sets only the swap floor.
- **The deposit mint is the only flow priced by NAV.**
  `FundFlowsLib.deposit` mints `delta × supply / navBefore`. Both values use
  the 30-minute TWAP.
- **ORA-4 compares a pool with itself.** `FundValuationLib.marketCheck`
  compares the pool's spot with the same pool's TWAP. The band is 200 bps. It
  gates deposits and steps. It does not gate `redeem`.
- **The swap floor is TWAP minus 200 bps** (`maxSlippageBps`).
- **The canonical model already separates the two uses of price.** The
  architecture says the TWAP serves protocol guards, and user share value is
  the market price of the underlying assets (`docs/architecture.md`, the
  hybrid NAV note; `docs/technical/asset-valuation-hybrid.md`).

### 15.2 Findings

Severity: **High** means value can be taken or flows can be stopped cheaply.
**Medium** means a bounded loss or an unbounded operating cost. **Low** means
the text is wrong or unclear.

**Misunderstandings**

| ID | Severity | Finding |
| --- | --- | --- |
| M1 | High | **The design defends a redemption that was never exposed.** §5.9 lists "a redeem right after a NAV jump" as a gap. A redeem pays realized proceeds of a pro-rata slice. An inflated TWAP pays the redeemer nothing extra. The holders who stay keep the same amount of every asset per share. E3 and E4 then add a NAV read to redemption ("the smaller of realized proceeds and the value at the worst checkpoint"). That adds an oracle where there was none. |
| M2 | High | **The real exposure is not named.** Holders are exposed in one place: a deposit whose routing differs from the fund's composition. Deficit-first routing (D7) makes that the normal case. If the TWAP understates a basket asset by `d`, and the deposit goes mostly to lending, the depositor gets about `basket weight × d` too many shares. ORA-4 allows `d` up to 200 bps. No manipulation is needed. A TWAP lags every real price move. A depositor can wait for a lag, deposit, and hedge the hold. This is the late-trading attack on mutual funds. A1 to A5 do not include it. |
| M3 | High | **"Time makes a push expensive" is false where there is no arbitrage.** The design assumes arbitrage charges the attacker for every block a price is held. The cost report (§3.3) says deSPXA has almost no arbitrage for about 80% of the week. A push held then costs little. A slow ramp passes both checks. ORA-4 sees spot and TWAP move together. `navJumpBps` sees small steps. No window length fixes a price source the attacker controls. |
| M4 | Low | **`minHold` is credited with the wrong job.** §5.9 says the hold stops a flash-loan round trip. The settlement window already does that, because a flash loan cannot span blocks. The hold only delays an exit after a mispriced mint. A hedge removes most of that delay's risk. |

**Flaws**

| ID | Severity | Finding |
| --- | --- | --- |
| F1 | High | **A flash loan can hold every epoch for the price of two swaps.** E7 holds settlement if any checkpoint fails ORA-4. `checkpointNav()` is open to anyone. In one transaction an attacker pushes a pool's spot past 200 bps, calls `checkpointNav()`, and pushes back. The checkpoint slot is used for 5 minutes and the anomaly flag is set. Repeating this once per window stops all deposits and redemptions for `maxHold`. The design removes the flash loan as a theft tool and returns it as a denial-of-service tool. |
| F2 | High | **Open settlement lets the caller sandwich the batch with no risk.** E10 lets anyone call `settle`. Settlement swaps the whole epoch's net amount. The floor is TWAP minus 200 bps, and `redeem` has no spot band. An attacker pushes spot to just inside the floor, calls `settle`, and unwinds, all in one transaction with borrowed money. The gain is up to about 2% of each basket leg. E4 puts that loss on the depositors and redeemers. Today a user's own transaction cannot be sandwiched this way. |
| F3 | High | **Worst-case pricing pays holders to distort checkpoints.** E3 and E4 give every difference between the worst checkpoint and the realized value to the holders. A large holder gains from each distorted checkpoint. One checkpoint is enough, and the attacker picks its moment inside the 5-minute slot. Honest users also pay this spread in every normal epoch. It is the high-to-low range of the window. No gate counts it. |
| F4 | High | **A held epoch traps redeemers.** After the epoch closes, a request cannot be cancelled until the Safe acts. Escrowed shares cannot use `redeemInKind`. A hold can last 48 hours plus the Safe's own delay. The anomaly check fires in fast markets. So the exit of last resort is closed for queued redeemers exactly when they need it. |
| F5 | Medium | **A batch can be too large to settle.** One atomic sale of an epoch's redemptions can exceed what a thin pool takes inside the 200 bps floor. Settlement then reverts for everyone. There is no partial fill and no roll rule. |
| F6 | Medium | **The lock breaks pooled accounts and invites griefing.** E8 keeps one `unlockAt` per account. Each new claim moves it forward for all locked shares. A gateway or a Safe that receives deposits every day never unlocks. `requestDeposit(assets, receiver)` lets a stranger relock a victim for 100 USDC a day. The lock also starts at claim time, not at settlement. |
| F7 | Medium | **After `maxHold` a role sets the price.** `EMERGENCY_ROLE` or the Safe "settles or cancels". Settling a flagged epoch is choosing a price for users. The architecture gives the hot key halts and de-risking only. |

**Gaps**

| ID | Severity | Finding |
| --- | --- | --- |
| G-1 | High | **No user limit on a request.** A request has no minimum shares or minimum USDC. The user accepts any price inside the floor, hours later. |
| G-2 | Medium | **No rate limit on flow size.** The Makina write-up names this cause. §5.9 quotes it and does not answer it. |
| G-3 | Medium | **Checkpoints do not span the window.** Six checkpoints 5 minutes apart can all fall in the first 25 minutes. Each reads a 30-minute TWAP, so they overlap and are not independent samples. |
| G-4 | Medium | **Escrowed shares and the exclusion ledger.** The ledger records each holder's balance when an adapter is excluded. Shares held by the queue would be recorded under the queue's address. The rule for passing the claim to the real owner is missing. |
| G-5 | Low | **Unspecified behaviour:** the price of the netted leg, the exit fee on it, where the TVL cap and the per-deposit cap apply, what a deposit pause or shutdown does to pending requests, and the queue's upgrade and role model. |
| G-6 | Medium | **Missing attacks.** The test list lacks M2 (lag with a hedge), F1, F2, F3, F5, F6 and the slow ramp in M3. |

**Incoherence**

| ID | Finding |
| --- | --- |
| I1 | §5.9 says a transfer carries the lock. E8 says locked shares cannot be transferred. RB-11 fits either. |
| I2 | §4.4 still says redemption is synchronous. RB-6 says rebalancing state never blocks `redeem`. RB-12 blocks it. D10 was accepted, and these sections were not updated. |
| I3 | D3 says the keeper acts first and anyone acts after a grace period. E10 opens settlement to anyone at once. |
| I4 | E5 pays redeemers from deposit USDC. E4 prices a redemption by realized proceeds. The netted leg has no realized proceeds. Its only possible price is NAV. That is the Makina shape. |
| I5 | The plan says it follows ERC-7540. That standard claims through `deposit`, `mint` and `redeem` with a controller. It has no cancel. The plan's interface is a different one. |
| I6 | D10 adds request, claim and pending views to every client. G6 passes only if no client needs a new kind of surface. §6 still says the gateway only changes its destination list. |
| I7 | `navJumpBps` is 200 bps of NAV per share. An asset with a 10% weight can move 20% before it trips. The bound meant for one asset is diluted by its weight. |
| I8 | G8 scores the attacker's profit and the holders' loss. It does not score losses of pending depositors and redeemers, or the cost to stop the fund. F1, F2 and F3 would all pass G8 as written. |
| I9 | G8 passes when five listed attacks fail in a sim. The sim's arbitrage model is an assumption (§14). A list of failed attacks is not a bound. |

### 15.3 Root cause

The design asks one number, the TWAP NAV, to do two jobs. It is a guard, and
it is the price users trade at. A guard can be wrong for a while at low cost.
A trade price cannot. Every High finding follows from that. The checkpoints,
the worst-case rule and the anomaly hold all try to make a pool-derived price
safe to trade at. They add new ways to distort it or to stop it.

The fund already has the answer for redemption. A pro-rata slice needs no
price. The fix is to make deposits work the same way, and to keep the NAV as
a guard only.

### 15.4 The corrected design: flows by quantity, time as the guard

**The rule.** Holders are never a party to a price. Every flow that touches
the fund is a pro-rata slice measured in asset amounts.

**What stays from §5.9 (owner direction, 2026-11-11):**

- Deposits pool in epochs and settle after a window.
- Shares from a deposit are held for one day.
- Redemption requests pool in epochs and settle after an observed window.
- `redeemInKind` stays instant (E9). The queue stays a separate contract (E1).

**What changes:**

1. **Net redemption (as today).** Burn the net shares. Sell their pro-rata
   slice. Pay the realized USDC minus the exit fee. No NAV read.
2. **Net deposit (new).** Split the net USDC across idle, lending and basket
   assets by the fund's current weights. Buy each. For each asset `i`,
   `ratio_i = amount bought / amount held before`. Mint
   `(supply + virtual shares) × the smallest ratio_i`. No NAV read. Any small
   surplus in the other assets stays in the fund. An empty fund mints 1:1 on
   USDC.
3. **The matched part moves shares, not assets.** Deposits and redemptions in
   one epoch are matched first. Redeemers' shares go to depositors.
   Depositors' USDC goes to redeemers, minus the exit fee. The fund's assets
   and supply do not change. The matched part crosses at the settlement price
   `S` (item 5).
4. **Every request carries a limit.** A deposit names its minimum shares. A
   redemption names its minimum USDC. A request that would fill below its
   limit does not fill. It waits for the next epoch. The owner can cancel any
   request until it settles. A queued redeemer can also leave in kind from
   escrow at any time.
5. **`S` comes from the pool's own history, not from checkpoints.** At
   settlement, one `observe` call per pool returns the mean tick of each of
   `K` equal slices of the window. Each basket asset is priced at the median
   slice. `S` is the fund's NAV per share at those prices. `S` is used for the
   match, the TVL cap and display. There is no `checkpointNav()`. A push made
   and undone inside one transaction leaves no trace in the pool's history.
6. **The anomaly check stops trading. It never sets a price.** An epoch does
   not settle if, for any basket asset:
   - fewer than `quorum` slices sit within `dispersionBps` of the median; or
   - the median differs from a second price source by more than `refBandBps`,
     where the asset has a second source.

   A blocked epoch stays pending. Requests stay cancellable. After `maxRoll`
   epochs anyone can refund a request. No role can settle a blocked epoch.
   `EMERGENCY_ROLE` can pause the queue. Cancel and in-kind exit stay open
   while it is paused.
7. **Settlement trades in a tight band.** Each swap needs spot within
   `settleBandBps` of the asset's median price. The floor uses the same band.
   A failed band reverts the call and changes no state. Anyone can retry. The
   keeper settles first. Anyone can settle after `keeperGrace` (D3).
8. **Flow size is capped.** The net amount per epoch is at most
   `maxEpochNetBps` of NAV. Requests fill pro rata under the cap. The rest
   waits.
9. **The hold lives in the queue.** Minted shares stay in the queue until
   `settle time + minHold`. The owner then claims them. The fund's `_update`
   gets no lock, so G1 loses no bytes to it. Pooled accounts work, because
   each epoch's shares unlock on their own date.
10. **The exclusion ledger sees through the queue.** The ledger credits each
    queued share to its real owner. This needs a test before any other queue
    work.

**Why holders are safe by construction.** After a net deposit, the amount of
asset `i` per share is `(held_i + bought_i) / (supply × (1 + m))`. Here `m` is
the smallest ratio, so `bought_i / held_i ≥ m` for every asset. The amount per
share therefore never falls. A net redemption removes an exact pro-rata slice.
A match changes neither assets nor supply. So no price, true or false, can
move value from holders to a flow. This is an argument, not a test result. It
does not depend on a sim's arbitrage model.

**Working defaults:**

| Parameter | Default | Note |
| --- | --- | --- |
| `epochLength` | 6 h | Unchanged |
| `settleWindow` | 1 h | Unchanged |
| `K` slices | 12, of 5 min each | The pool must keep 1 h of observations. Check each pool's cardinality at the pin. |
| `quorum` | 9 of 12 | An attacker must hold a price for more than 15 minutes to block. It must hold for more than 30 minutes to move the median. |
| `dispersionBps` | 100 | Set from the sim's normal range |
| `refBandBps` | 100 | Only for assets with a second source |
| `settleBandBps` | 50, and above the pool fee | Caps a settlement sandwich at 50 bps of a leg |
| `maxEpochNetBps` | 500 | The rate limit |
| `minHold` | 24 h | Unchanged |
| `maxRoll` | 8 epochs (48 h) | Then refund, by anyone |

**Invariants this would use in place of RB-10 to RB-12:**

- **RB-10'.** No shares leave the queue and no USDC is paid before the
  epoch's window ends.
- **RB-11'.** Shares from a deposit leave the queue no sooner than
  `settle time + minHold`.
- **RB-12'.** A blocked epoch trades nothing. No role can settle it. A
  cancel or refund returns exactly what was escrowed.
- **RB-13.** No flow lowers the amount of any asset per share, except by
  rounding in the holders' favour.
- **RB-14.** No request fills below its limit.
- **RB-15.** A failed settlement changes no state. Cancel and in-kind exit
  work for every unsettled request, also while the queue is paused.

**How each finding is answered:**

| Finding | Answer |
| --- | --- |
| M1, M2, I4 | No fund-facing flow reads a price (items 1 to 3). |
| M3 | Holders are safe without any arbitrage assumption. Users are protected by their own limits. What is left is in §15.5. |
| M4, F6, I1 | The hold is a queue rule (item 9). |
| F1 | No open checkpoint. A one-transaction push leaves no trace (item 5). |
| F2, I3 | Tight band and keeper first (item 7). |
| F3, I7 | No worst-case rule. The median is per asset (items 5 and 6). |
| F4, F7 | Cancel and in-kind exit always work. No role settles (items 4 and 6). |
| F5, G-2 | Cap and pro-rata fill (item 8). |
| G-1 | Limits (item 4). |
| G-3 | Slices cover the whole window (item 5). |
| G-4 | Item 10. |

### 15.5 What the corrected design costs, and what it does not fix

- **Deposits stop rebalancing for free.** A pro-rata deposit does not fill
  deficits. This drops D7 for net deposits. The rebalancer does that work, and
  G4 cost rises. The sim must measure by how much. Keeping deficit-first
  leaves holders exposed by `net deposit × routing mismatch × price error`.
  That cannot be made zero.
- **Every net deposit buys every basket asset.** That includes deSPXA when
  the S&P is closed. Outside US hours the band may fail often. Deposits then
  wait. The sim must report the wait.
- **A matched user can still get a bad price, down to their own limit.** An
  attacker who holds a thin pool's price for most of a window moves `S`. The
  other side of the match pays, up to its limit. Holders do not pay. For
  deSPXA the only real fixes are a second price source, a cap on its weight
  against pool depth, or settling only in US hours (cost report §7).
- **Blocking is still cheap in a market with no arbitrage.** Holding a
  deSPXA price off its median for 15 minutes blocks an epoch. Users can still
  cancel or leave in kind.
- **Clients still need request, claim and pending views** (I6). G6 is at
  risk under either design.
- **The interface only borrowed ERC-7540's names** (I5). The owner later
  settled this: the fund follows the standards' shape, with listed
  departures (D13, §5.9.6).

### 15.6 Changes this implies (made 2026-11-11)

- **Text.** Rewrite §5.9 around §15.4. Update §4.3, §4.4 and RB-6 for D10
  (I2).
- **Engineering plan.** E1, E9 and E11 stay. E3, E4, E6, E7, E8 and E10 are
  replaced by §15.4. E5 becomes the match in item 3. The fund gains an
  in-kind mint and no lock. Work package 1, the size budget, gets easier.
- **Attack list.** Add:
  - A6: TWAP lag with a hedge, and no manipulation (M2).
  - A7: sandwich by the caller of `settle` (F2).
  - A8: blocking an epoch, with its cost per hour (F1).
  - A9: a holder distorting the settlement price to skim flows (F3).
  - A10: a slow ramp of deSPXA while the S&P is closed (M3).
  - A11: lock griefing of a pooled account (F6).
  - A12: a batch larger than pool depth (F5).

  Run each against the synchronous fund, the §5.9 design and the §15.4 design.
- **G8.** It has no result yet. Proposed additions: count the loss of pending
  depositors and redeemers beyond their limits, and report the cost per hour
  to block the fund. The owner decides (§15.7).

### 15.7 Owner decisions (all decided 2026-11-11, §15.8)

| ID | Decision | Recommendation |
| --- | --- | --- |
| R1 | Replace the checkpoint pricing of §5.9 with §15.4? | Yes. It keeps the three time rules and removes the price from every fund-facing flow. |
| R2 | Give up deficit-first routing (D7) for net deposits? | Yes, and measure the G4 cost. The alternative keeps the one real exposure (M2). |
| R3 | Amend G8 as in §15.6 before step 3d runs? | Yes. As written it passes designs that F1 to F3 break. |
| R4 | What protects deSPXA: a second price source, a depth cap, or US-hours settlement? | Test the depth cap first. It also addresses the G4 failure. |

### 15.8 Research and decision (2026-11-11)

The owner asked for research on protocols that price flows by quantity and by
NAV, and then for a decision. The full report with sources is
`docs/technical/research/vault-share-pricing-models.md`. Its figures are
dated 2026-11-10 or 2026-11-11. Its unverified items are listed in its own
last section.

**Protocols by class**

| Class | Protocols |
| --- | --- |
| Quantity, no price in the mint or redeem | **AMM pools, not vaults:** Uniswap v2, Balancer proportional adds and exits, Curve balanced adds. **Basket tokens, not ERC-4626:** Set and Index Coop issuance, Reserve RTokens, Reserve Index DTFs. |
| Mixed: NAV mint, in-kind redeem | Enzyme. The prototype fund today has the same split. |
| NAV from an off-chain accountant | Veda, Lagoon, Mellow, Upshift, Ondo, Centrifuge |
| NAV from on-chain prices at call time | Enzyme deposits, dHEDGE, Sommelier, GMX, Jupiter JLP, Makina |
| Single-asset internal accounting | Yearn v3, MetaMorpho, Maple |

**No ERC-4626 vault was found that prices by quantity** (owner question,
2026-11-11). Every ERC-4626 or ERC-7540 implementer in the research is in the
NAV rows: Yearn v3, MetaMorpho, Maple, Lagoon, Centrifuge. Veda and Enzyme are
vault products with their own interfaces, and both mint at NAV. Quantity
pricing was found only in pools and basket tokens.

**The fund stays an ERC-4626 vault. That is a core requirement** (owner,
2026-11-11; §1). Quantity-based settlement does not conflict with it. ERC-7540
is the asynchronous extension of ERC-4626. It lets the vault fix the exchange
rate when it fulfils a request, and it does not say how. So:

- The asset is USDC and the share is the fund's ERC-20.
- `requestDeposit` and `requestRedeem` open requests. `deposit`, `mint` and
  `redeem` claim them. `withdraw` reverts `RedeemOnly`, as on the basket
  vaults today.
- The fund follows the standards' shape, not their letter (owner,
  2026-11-11). §5.9.6 lists each departure.
- A deposit request is fulfilled by the pro-rata purchase. Its rate is the
  USDC spent per share minted.
- `totalAssets`, `convertToShares` and `convertToAssets` stay as NAV views at
  the TWAP. They are estimates. `previewDeposit`, `previewMint`,
  `previewRedeem` and `previewWithdraw` revert, as ERC-7540 requires for
  asynchronous flows.
- Limits, cancel and `redeemInKind` are extensions beside the standard.

An earlier draft of this section and of the engineering plan said the
ERC-4626 functions would not apply. That was wrong and is corrected. What
remains without precedent is the pricing rule inside a standard vault, not
the vault form.

**Findings on the four criteria**

| Criterion | Quantity | NAV |
| --- | --- | --- |
| Usefulness | Weaker. Single-asset entry always needs a zap. The depositor pays all slippage. | Stronger. One asset in, one transaction, and the share works as collateral. |
| Correctness | Exact by construction. A wrong price cannot dilute holders. | Only as correct as the mark. Stale-NAV dealing cost mutual fund holders 56 to 114 bps a year (Zitzewitz). |
| Adoption | Large only in AMMs. Index products shrank: Set and Index Coop from about $550M to about $11M. The teams blamed demand, not the mint. | Dominant. Maple about $2.2B, Veda about $1.7B. The large ones trust an accountant, not a pool. |
| Hardness | No loss found on a strict in-kind path in 38 incidents. Losses came at the rebalance, at keys and at side doors (Indexed Finance, about $16M). Less value sits here, so the zero is partly a base-rate effect. | 23 incidents and about $418M. Some had a TWAP, a median or a bound in place (Inverse, UwU, Venus in March 2026). |

**The decision does not rest on the current assets** (owner, 2026-11-11: the
assets can change to fit the protocol). Assume every holding is liquid and has
an independent feed. A NAV mint at a Chainlink price is then workable. Enzyme
does this. The comparison becomes:

| Question | Quantity | NAV on independent feeds |
| --- | --- | --- |
| What must hold for holders to be safe? | Nothing about prices. | The feed, the fund's own accounting state, and every future asset's feed. |
| What does the user give up? | Nothing more. The owner's epochs already make flows wait. | The same wait. The one-transaction deposit that NAV is valued for is already gone under D10. |
| What does the fund give up? | Deficit-first deposits (D7). | Nothing. |
| What does it do to future asset choices? | A thin or unpriced asset only costs the depositor. | Every asset needs a feed. One asset without it reopens the hole. |
| Record | No loss on the in-kind path. | Losses also came from the fund's own state with honest prices (GMX v1, Summer.fi). |

Three reasons then decide it, and none names an asset:

- **Safe by construction beats safe by parameters.** A hardened NAV shrinks
  the option the fund writes to each depositor. Quantity writes none.
- **The time rules already paid NAV's price.** With epochs, both designs
  take USDC and make the user wait. NAV's main advantage is not on offer.
- **The asset list stays a free choice.** The receipts name categories such
  as real-world assets. A NAV design limits them to assets with feeds forever.

**What would flip it.** If the owner drops the epochs and wants instant
one-transaction deposits and the share used as collateral, the answer is a NAV
mint at Chainlink prices, on feed-covered assets only. That is the adopted
model. It is a closer call than the deSPXA case made it look.

**The current assets, as a side note.** Base has Chainlink feeds for ETH, BTC
and cbBTC. It has none for the S&P 500, SPY or deSPXA. So today's asset list
could not use the NAV design in any case.

**Decision: R1 yes and R2 yes.** Deposits are quantity-based, as in §15.4.
The research confirms the direction and changes five details:

1. **The caller supplies the split and a minimum-shares floor.** The contract
   then needs no price even to divide the deposit. Each leg gets its own
   bound, so the thin leg cannot use up the budget.
2. **Buy exact amounts where the venue allows it, and refund unused USDC.**
   This is the issuance shape of Set, Reserve and Folio. It keeps gifted
   excess from shifting composition.
3. **Use the Chainlink feeds only as guards that revert.** They check the
   wETH and cbBTC legs. They never set a share count.
4. **Move the pricing defences to the rebalance.** Flows no longer change
   weights. The governed rebalance is then the only step that trades at an
   asserted price. It is where Indexed Finance lost. The cost-accounting fix
   in the cost report (§4) belongs here too.
5. **Cap deposit size against deSPXA pool depth.** This is R4's first test.

**Risks accepted with the decision**

- **No precedent.** No protocol was found that buys the pro-rata slice inside
  the core contract. Every one uses an outside zap. The path has no audited
  reference. The experiment must test rounding, reentrancy and partial fills.
- **Usefulness.** Every deposit pays swap cost on every basket asset. Deposits
  wait when deSPXA is thin. The sim must measure both.
- **Adoption.** The market has rewarded NAV vaults with a trusted accountant.
  The fund has no such role and does not add one. If the measured deposit
  cost is too high, the fallback is a NAV mint at independent feeds, settled
  in the same epochs (D11).
- **Unverified deSPXA facts.** Transfer restrictions, whether the fund can
  deal at the issuer's NAV, and current pool depth are not confirmed.

R3 is done: G8 is amended in §13. R4 is settled by the asset rule (§4.5):
deSPXA leaves the fund, and every listed asset has a pool-share limit.

**Owner, 2026-11-11, after this decision:** instant deposits and instant
withdrawals are not needed. Customers can wait. The epochs stay, so the
condition that would flip the decision does not apply.

**One change to §15.4 item 2.** The settler names one mint ratio and the fund
buys exact amounts of every asset. Every asset then grows by the same
fraction. The smallest-ratio rule and its surplus are no longer needed.
§15.4 as a whole is a record of the first correction. §5.9 is the design.

## 16. The layered design: review, sources and sign-off

Status: approved by the owner, 2026-11-11 (§16.4). The design itself now
lives in §4.5, §5.9 and §5.10. This section keeps the record: the review that
led to the layers, the industry practice behind each one, and the sign-offs.
Nothing here is built or tested yet.

### 16.1 Review of the documents before the layers

This table describes §5.9 and the engineering plan as they stood before this
section's changes. Every fix is now made.

| Finding | Where | Fix |
| --- | --- | --- |
| The outside feed is optional ("where an asset has one"). An asset without a feed has only the pool's own TWAP behind it. | §5.9 guards | Every basket asset must have a feed (§4.5). |
| Nothing checks the value of a net leg. A net deposit can pay any cost inside the 50 bps spot band and the users' own limits. A standard ERC-7540 request has no limit. | §5.9, eng plan E12 | A value check against the feed NAV (§5.9.3, check 12). |
| The quantity rule is an argument about `mintInKind`. Nothing asserts it on chain after the trades. | §5.9, RB-13 | A before-and-after proportion check in the settlement transaction (layer 1). |
| The feeds' own health is not checked: staleness and the Base sequencer. | §5.9 | Feed health gate (layer 2). |
| Lending positions are valued 1:1 with no bound. A4 covers it only by test. | §4.2 | A growth bound on each lending position (layer 2). |
| No bound on how far the share price may move between settlements. The Makina write-up names this. | §5.9 | A share-price move breaker (layer 4). |
| The engineering plan's ERC-7540 row was written from memory. | eng plan E2 | Checked against the standard's text and corrected (§5.9.6). |
| §8 lists no client work for request and claim. | §8 | Added to §8. |
| The rebalance step still trusts the pool TWAP alone. | §5.3 | The same feed checks on steps (§5.10, step 3e). |

### 16.2 Where each part now lives

| Part | Section |
| --- | --- |
| The principle and the four layers | §5.9.1 |
| The asset admission rule (D12) | §4.5 |
| One settlement, step by step, and the defaults | §5.9.3, §5.9.5 |
| Exits and the emergency freeze | §5.9.4 |
| The vault interface and its departures (D13) | §5.9.6 |
| The layers on the rebalance | §5.10, step 3e |
| Costs | §5.9.7 |

### 16.3 Industry practices adopted, and how each is hardened further

The sources are the research notes behind §15.8. Check numbers refer to
§5.9.3. "Lesson" rows come from an
exploit, not from a design.

| Source | Their practice | Adopted as | Hardened further |
| --- | --- | --- | --- |
| Uniswap v2 | Mint by the ratio of amounts. Check the invariant after the trade. Lock against reentrancy. Burn the first shares. | Layer 1. Check 11 after the trades. Seed shares locked for good. | The check covers every asset and the supply. It also covers `redeemInKind`. Each rebalance step gets a balance check of its own (RB-19). |
| Set, Index Coop, Reserve | In-kind issuance. The depositor pays the swap cost. | The net deposit buys a pro-rata slice. | The purchase happens inside the fund under the four layers. There is no outside zap to attack. |
| Reserve RToken | Hourly issuance and redemption throttles. Issuance stops when the basket is not ready. | `maxEpochNetBps`. No net deposit while a lending asset is excluded or the fund is shut down. | The throttle is per epoch and applies after matching. |
| Enzyme | Chainlink-only pricing. In-kind redemption that cannot be blocked by a failing price. A timelock between deposit and exit. | Rule 1 of §4.5. `redeemInKind` reads no price. `minHold`. | Enzyme mints at the feed. Here the feed can only block. The hold is 24 hours and the shares are not in the user's hands during it. |
| Veda | Rate bounds and a minimum delay. A breach stops the vault. A share lock during which a deposit can be reversed. An optional share premium on deposits. | Checks 4 to 7. `minHold` in the queue. | No accountant posts a rate. During the hold, `EMERGENCY_ROLE` can freeze an epoch's minted shares, and the Safe can return them to the depositors in kind. A deposit premium paid to holders is a parameter (`entryPremiumBps`, default 0). |
| Lagoon, Centrifuge | Request and claim. The price is not known when the request is made. | Epochs and the window. | No role proposes a valuation. A request can be cancelled until it settles, which is safe because holders are not a party to any price. |
| Sommelier | A share-price oracle checked against a TWAP. A two-day share lock. | Check 7. | Two prices per asset plus the proportion check. |
| Mellow | A report far from the last one is rejected. A moderate one needs a human to accept it. | The bands in checks 3 to 7 and 12. | No human can accept a blocked settlement. The only override is to wait or to exit. |
| Chainlink guidance | Check feed age and the sequencer. Pause when the reference market is closed. | Check 2. Rule 1 requires a feed that is live at all hours. | An asset whose feed has closed hours is not listed at all. |
| Lesson: Makina, Harvest | A pool's spot price went into the share price in one transaction. | No flow settles in one transaction. No pool price sets a share count. | Layers 1 and 4. |
| Lesson: Venus (2026), Inverse, Rari | A TWAP or a two-feed bound was beaten on a thin market by a held price. | Rule 3 of §4.5 caps the position against the pool's own balance. The feed must not come from the fund's own pool. | Even a beaten feed and TWAP together cannot dilute holders. |
| Lesson: GMX v1, Summer.fi | The vault's own accounting state was corrupted or stale while outside prices were honest. | Check 11 compares real balances, not stored accounting. Check 6 bounds lending growth. | A donation becomes a gift to holders. |
| Lesson: Indexed Finance | A single-asset side door and a rebalance sized from the pool's own spot. | No single-asset mint path exists outside settlement. §5.10 for the rebalance. | The step floor is the lower of TWAP and feed. |
| Lesson: Balancer (2025), Bunni | Rounding on one path, repeated in tiny calls. | Every amount rounds for the holders. `minRequestUsdc`. | A fuzz test of many minimum-size requests in one epoch. |
| Lesson: Cream, Resupply, Stream | A lender trusted a vault's own share price. | The convert views revert when a feed is unhealthy. | The documents tell lenders to use a capped rate, never the raw view. |

Two practices are not adopted. A Dutch auction for the rebalance was tested
in step 3c and failed G4. A trusted off-chain accountant is not added. If the
measured deposit cost is too high, the fallback is a NAV mint at the outside
feeds, settled in the same epochs (§5.9.7).

### 16.4 Owner sign-off (all approved 2026-11-11)

| ID | Decision | Result |
| --- | --- | --- |
| S1 | Adopt the four layers and the settlement order (§5.9.3)? | Approved. |
| S2 | Adopt the asset admission rule (D12), which removes deSPXA until it has a feed? | Approved. Step 3e reruns G4 and G5 on the new list. |
| S3 | Step 3e puts the same layers on the rebalance (§5.10)? | Approved. |
| S4 | Add the emergency freeze of held shares, with a Safe-decided in-kind return (§16.3, Veda row)? | Approved. |
