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
  asset rule 2026-11-11; netted, forward-priced flows decided 2026-11-13 and
  not built, §5.11 and §18; revised after an adversarial review the same
  day, §19)
- **Author:** lucky-tensor (drafted with Claude)
- **Decider:** Product owner
- **Would supersede, if the experiment invalidates the rejection:** the Portfolio Router (`docs/architecture.md`
  §4.2), router-weight governance (§2.3), and the rejection in
  [ADR-0010](../adr/ADR-0010-unified-vault-architecture.md). It would amend
  [ADR-0003 (rebalancing)](../adr/ADR-0003-basketvault-rebalancing-model.md)
  and [ADR-0017](../adr/ADR-0017-rmagent-retired-router-uses-three-vaults.md).
- **Keeps unchanged:** the consensus receipt contract (§4.9), the Safe and
  timelock as the only governance body, the lending and swap adapters (each
  with one added function, §6), ADR-0009 retirement (no assisted migration), ADR-0014 governed
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
   quantity, so no price sets how many shares are minted or burned, and no
   price moves value between users. Outside price feeds, the pools' own TWAP,
   wait periods and rate limits bound each trade and can each stop a
   settlement. Shares from a deposit are held for one day (§5.9).
   From step 3f (decided 2026-11-13, not built) a request carries no price
   limit, the deposits and redemptions of one settlement are matched at the
   fund's NAV at the TWAP, only the net amount trades, and the in-kind exit
   is kept for a wind-down only (§5.11).

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
   -> FlowQueue.requestDeposit / requestRedeem, then claim   (§5.9)
   -> vault.redeemInKind                                     (instant)

Keeper (KEEPER_ROLE, or anyone after the grace period)
   -> FlowQueue.settle(maxRequests, maxUsdc)
        -> checks of §5.9.3, then the fund's pro-rata sale and purchase

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
  ceiling on one venue, not an allocation choice;
- a basket asset's target is inside its pool-share limit (§4.5, rule 3).

Idle USDC carries no target. It absorbs rounding, as before.

**Off-chain tools own the semantic layer.** The dapp, rmpc, explorer and
reports group assets by the receipt's labels. They can slice the same assets
another way later without a contract change.

**What is still governed by the Safe.** Which assets are tradable at all:
adding or retiring an asset, its adapter or pool, its TWAP window, its price
feed and that feed's maximum age, and its `capBps`. Those choices define what a receipt may name. They do not set any
balance.

### 4.2 NAV

```text
totalAssets = idle USDC
            + Σ lending adapter.totalAssets()          (exact, 1:1)
            + Σ basket token balance × TWAP price       (BasketVault model)
```

NAV is a view and a guard. Since D11 it sets no share count and prices no
flow (§5.9). The settlement checks compute it at the outside feeds for the
share-price breaker and the caps (§5.9.3, checks 6, 8 and 9).

This is the union of the two NAV models that already exist. Basket assets
keep their TWAP valuation, the ORA-4 spot-versus-TWAP deviation guard, and the
emergency unwind guards. Lending adapters keep ADP-2 exclusion and the
`ExclusionLedger`.

### 4.3 Deposits

Changed 2026-11-11 (D10, D11, §5.9). The first design minted on the realized
NAV delta and routed each deposit deficit-first. The prototype up to step 3c
still does. Step 3d replaces it.

A deposit is a request. It settles with its epoch (§5.9). The USDC of the
requests that settle buys the same fraction of every asset the fund holds.
Shares mint by that fraction. No NAV sets the share count. Each purchase has a
price limit
from the outside feed and the pool's TWAP. The depositors of that settlement
pay the cost of the purchase. Each request carries its own limit.

A deposit does not change the fund's weights. Only the rebalancer does.

Step 3f (§5.11, decided 2026-11-13, not built): a request carries no limit
and locks when its epoch closes. The part of a settlement's deposits that
its redemptions cover is matched: those depositors receive the redeemers'
shares at the NAV per share of §4.2, at the TWAP. Only the net deposit buys
assets, by the rule above.

### 4.4 Redemptions

Changed 2026-11-11 (D10, §5.9). Redemption is **timed** and **pro rata**.
Architecture §4.4 makes synchronous redemption a product promise. The owner
accepted the change for the experiment (D10).

- `requestRedeem` escrows shares in the queue. The request settles with its
  epoch. The shares are burned: the fund withdraws each lending position and
  sells each basket token in proportion, and pays realized proceeds minus the
  exit fee. Each sale has a price limit from the outside feed and the pool's
  TWAP. This is `BasketVault._sellProportional` plus
  `RobotMoneyVault._pullProportional`, unchanged in spirit.
- `withdraw` and `previewWithdraw` revert `RedeemOnly`.
- `redeemInKind` stays instant. It pays USDC for the idle part and hands
  over basket tokens for the basket part. It pays the lending part in USDC up
  to a per-period allowance. Beyond that, or when a venue cannot pay, the
  lending part becomes a claim on a share of that position (§5.9.4). It needs
  no oracle and no swap venue. Shares waiting in the queue for a redemption
  leave the same way through `exitInKind`.
- Pro rata keeps composition unchanged. Redemptions never fight the plan and
  never shift cost onto the holders who stay.

Rebalancing state never blocks a redemption request, its settlement or
`redeemInKind`.

Step 3f (§5.11, decided 2026-11-13, not built): a redemption request carries
no limit and locks when its epoch closes. The matched part is paid from the
settlement's deposits at the NAV per share of §4.2, at the TWAP, minus the
exit fee. Only the net redemption sells assets. `redeemInKind` is no longer
an exit of the running fund. It opens when the fund is shut down to be
wound down (§5.11.5).

### 4.5 Asset admission rule (D12)

The assets can change to fit the protocol (owner, 2026-11-11). So the
protocol states what an asset must have. A basket asset is listed only if:

1. **It has an independent price feed on Base** that is live at all hours.
   The feed must not be derived from the fund's own pool.
2. **Its pool keeps at least one settlement window of price history.**
3. **Its largest position fits its pool.** The target weight times the TVL
   cap is at most `poolShareBps` of the asset held in the pool's active
   range. That amount is read from the pool's time-weighted liquidity over one
   settlement window, not from its token balance. Liquidity added for one
   transaction therefore does not count. The window is cut into 12 slices and
   the third-thinnest slice sets the amount (review fix of 2026-11-12). A few
   seconds of thin liquidity therefore cannot zero it, and added liquidity
   counts only once it has been held through ten slices. The fund checks this
   when a target is set, when the TVL cap rises and when `poolShareBps` falls.

A lending asset is listed only if its venue exposes its own rate per unit,
which the lending rate check reads (§5.9.3, check 5).

The fund is seeded once with at least `minSeedUsdc`, so a small gift cannot
skew its mix before the first plan.

**From step 3f (D19, decided 2026-11-13, not built).** The match of §5.11
uses the NAV at the TWAP as a price between users, with the feeds as its
guard. The asset rule then
carries more weight, so it is tightened in two ways.

4. **Its pool is deep in absolute terms.** The pool's time-weighted depth in
   its active range, measured as in rule 3, is at least `minPoolDepthUsdc`.
   Rule 3 only compares the pool with the fund's own position. A small fund
   could pass it on a pool that is cheap to hold off its feed.
5. **An asset that fails any rule is delisted.** Its target goes to 0 and
   it is sold out. It is not kept at a small weight. A thin asset at any
   weight is a way to block settlement and a leg nobody can price.

   An ordinary step cannot do this sale. A step needs a healthy feed and a
   TWAP that agrees with it (§5.10), and a failing asset has neither for
   sure. So a delisted asset has its own sale path: keeper-only steps for
   that asset alone, with its own price bound and its own cost budget, not
   blocked by the checks of other assets. While it is being sold out,
   deposits and the match stop. Redemptions still settle, and they sell
   their slice of it under the same bound. Its checks no longer block the
   settlement of the other assets. If its feed is dead there is no price
   to bound a sale, and only the Safe's emergency unwind sells it. The
   bound and the budget have no defaults yet.

The fund checks rule 4 where it checks rule 3. `minPoolDepthUsdc` has no
default yet. Step 3f sets it from the cost of holding a pool's TWAP outside
`refBandBps` for one window.

**Effect on the list.** wETH and cbBTC pass rule 1. Chainlink has ETH, BTC
and cbBTC feeds on Base. deSPXA fails rule 1 today. It leaves the fund until
a feed exists. The receipt's real-world-asset bucket is then 0, as the agent
bucket already is. Rule 1 excludes any asset whose reference market closes.
That covers tokenized equities in general, not only deSPXA. PAXG, which the
Hard Assets vault on `dev` holds, has not been assessed against this rule. Steps 1 to 3c ran with deSPXA, and their results in §14
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
4. **Size.** `notional = min(overweight, underweight, cap[asset])`. The cap
   is the governed `maxStepUsdc`, and for a basket asset also `stepDepthBps`
   (5) of its pool's time-weighted USDC depth. wETH and
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
8. **Budget.** A step's cost cap is at most the budget left, so a plan never
   spends past its budget. When the budget left is below the cost of the step
   just taken, the plan moves to `Halted`. Only the Safe can extend the budget
   or close the plan (review fix of 2026-11-12; before it a plan halted one
   step past its budget).
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
  online. (The vaults system's timelock made the same "executor open" choice.
  The fund's own timelock does not: only its Safe executes a ready operation,
  decision D4-10 of 2026-11-13, §5.6. `step()` is not a timelock operation, so
  the grace path is unchanged.)
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
  or closes it. The hot key holds only pauses: `shutdown` and
  `emergencyUnwind` are the timelock's (§5.6, owner 2026-11-13).
- Nothing about a plan's state ever touches deposits or redemptions.

### 5.6 Governed parameters

All set through the timelock. Suggested starting values are for review, not
decided.

| Parameter | Scope | Suggested start | Purpose |
| --- | --- | --- | --- |
| `duration` | per plan, bounded globally | 7 days (min 1 day) | Length of the glide path |
| `stepInterval` | global | max(longest TWAP window, 30 min) | Cooldown between steps |
| `maxStepUsdc` | per asset | wETH/cbBTC: from depth study; deSPXA: small | Largest single trade |
| `stepDepthBps` | global | 5 bps (owner default 2026-11-12) | A basket leg also trades at most this share of its pool's time-weighted USDC depth (§4.5's reading). It cannot be set to 0. An asset whose cap falls below `minStepUsdc` is skipped, so it never stalls the rest of the plan. |
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

**Roles (owner, 2026-11-13, after the external review of Deploy 4).** The
emergency hot key holds only levers that delay. Every lever that ends deposits
or moves value goes through the Safe and the timelock delay.

| Role | Held by | Powers |
| --- | --- | --- |
| `ADMIN_ROLE` | The fund-system timelock (the Safe proposes, cancels and, since D4-10, is the only executor) | Every parameter above, assets, caps, fees, `resumePlan`, `extendBudget`, `closePlan`, `unpauseDeposits`, `shutdown`, `restore`, `emergencyUnwind`; on the queue `setFlowParams`, `setFlowLevers`, `unpauseQueue`, `releaseSettlement`, `allowReturn`; every role grant |
| `EMERGENCY_ROLE` | Emergency hot key | Fund: `pauseDeposits`, `pauseRebalance`. Queue: `pauseQueue`, `freezeSettlement` |
| `KEEPER_ROLE` | Keeper bot | Queue `settle` and rebalancer `step()` before their grace periods |
| `GOVERNANCE_ROLE`, `REBALANCER_ROLE`, `FLOW_ROLE` | Governance, rebalancer, queue contracts (bound once) | Open a plan; execute and conclude a step; mint and sell for a flow |
| `TARGET_SETTER_ROLE` | The fund-system timelock | `applyReceipt` |

`shutdown` (deposits closed, TVL cap 0) and `emergencyUnwind` (every holding
sold to USDC) moved from `EMERGENCY_ROLE` to `ADMIN_ROLE` on 2026-11-13: one
key could otherwise end the fund or sell it at a moment of its choosing. The
hot key still stops every flow at once with `pauseDeposits`, `pauseRebalance`
and `pauseQueue`. `freezeSettlement` stays on the hot key because it is
pause-class: it only delays one settlement's held shares, ends by itself
after `maxFreeze`, moves no value and pays no one, and only the Safe can
release or return the shares (§5.9.4).

**Executor (decision D4-10, owner 2026-11-13).** The fund-system timelock's
only executor is its Safe, so executing a ready operation also takes two owner
signatures. This departs from ADR-0004's open executor, which the vaults
system keeps (ADR-0004 addendum 2026-11-13).

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

Decided 2026-11-11 and approved by the owner the same day (§16.4). Revised
the same day after an adversarial review of the approved design (§17). The
owner's rule for the revision: safety comes before simplicity. So every
protective layer stays. Each hole the review found is fixed. Only the parts
that protected nobody are removed. This section is the design. §15 and §16
hold the earlier reviews and the research.

Revised again 2026-11-13 by the owner (§5.11, §18): no per-request price
limit, a cancel cutoff, a match between the two sides of a settlement, and
no instant in-kind exit. That revision is step 3f and is not built. §5.9.1
to §5.9.7 describe the flows as step 3d built them, and they stand until
step 3f replaces the parts §5.11 names.

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

**The principle. Quantity sets every share minted or burned. No price moves
value between any two parties. Prices only bound each trade or stop a
settlement.** Four independent kinds of evidence must agree before a flow
settles. An attacker must beat all four at once.

| Layer | Evidence | What it catches | What it cannot do |
| --- | --- | --- | --- |
| 1. Quantity | Asset amounts per share, before and after, asserted inside the fund | Any dilution of holders, from any cause, including a bug in the fund's own trade code | Set a price |
| 2. Outside feeds | Chainlink price per basket asset, feed age, sequencer status, the USDC peg, each lending venue's own rate | A held or ramped pool price. A pool with no arbitrage. An inflated lending rate. A bad execution. | Mint or burn |
| 3. Internal TWAP | Median of the window's slices, their dispersion, agreement with the feed | One-block and short pushes. A stale or wrong feed. | Mint or burn |
| 4. Time and rate | Epoch, window, hold, keeper-first, flow caps, share-price move breaker | Flash loans. Same-block round trips. Fast drains. Anything that needs speed. | Mint or burn |

**Why holders are safe by construction.** A deposit adds the same fraction to
every asset and to the supply. A redemption removes an exact pro-rata slice.
So the amount of every asset per share never falls, whatever any price says.
The fund asserts this itself after its trades (check 10). The argument does
not depend on the sim's arbitrage model or on which assets the fund holds.

**What the checks cost.** A blocked settlement costs a user time. A user who
waits stays exposed to the market, in or out of the fund. Customers can wait
(owner, 2026-11-11), and the exits in §5.9.4 stay open. Gate G9 bounds how
often and how long they wait (§13).

#### 5.9.2 An epoch

1. **Request.** A user calls `requestDeposit` with USDC and a limit (the most
   USDC per share), or `requestRedeem` with shares and a limit (the least USDC
   per share, after the exit fee). The USDC or the shares come from the
   caller only. The request belongs to the owner the caller names. The queue
   holds the escrow. A request is at least `minRequestUsdc`, except a
   redemption of an owner's whole balance. A deposit request is at most the
   per-deposit cap. There is no cap on the number of requests.
2. **Quote.** `quoteDeposit` and `quoteRedeem` are views. They return the
   worst price the protocol's own limits allow right now, the fee, the
   earliest settlement time and the end of the hold. A client shows the quote
   before the user signs, and can set the limit from it.
3. **Close and window.** The epoch closes after `epochLength`. Nothing from
   it settles for a further `settleWindow`.
4. **Settle.** `settle` takes two inputs: the most requests to look at and
   the most USDC to process in this call. They exist for gas and for pool
   depth. They can only make one call do less. The next call continues where
   the last one stopped, so requests that are skipped cannot hold back the
   ones behind them. The caller chooses nothing else. The keeper settles
   first. Anyone can settle once `keeperGrace` has passed since the window
   ended (D3). Requests are processed in the order they were made, oldest
   first. Every price comes from chain state.
5. **Eligibility is decided by the chain.** Before any trade the queue
   computes two bound prices from the per-swap limits of §5.9.3: the most a
   depositor can pay per share, and the least a redeemer can receive. A
   request takes part only if its own limit admits the bound price. A request
   whose limit does not admit it is skipped and stays pending. The realized
   price is always at least as good as the bound. So every fill is inside its
   own limit by construction (RB-14), and a request's limit never makes a
   settlement revert.
6. **Hold.** Shares from a deposit stay in the queue until
   `settle time + minHold`. Then they are delivered to the request's owner.
   Anyone may trigger that delivery. Shares in their hold have no exit, by
   design (owner direction). The one exception is a return the Safe allows
   after a freeze (§5.9.4). Redemption USDC is claimable at once.
7. **Roll and expiry.** A request that is skipped, or that the period's cap
   leaves unfilled, stays pending. A request may fill in parts. Each fill is
   its own claim with its own unlock time. After `maxRoll` epochs an unfilled
   request expires, and its owner withdraws the escrow. The owner can cancel
   an unfilled request at any time.

#### 5.9.3 One settlement, step by step

`settle` runs in one transaction. A failed check before the trades (checks 1
to 6) reverts the call and changes no state. Each side then settles in its
own call into the fund. If one side's call fails, that side changes no state
and stays pending, and the other side still settles. No role can settle past
a failed check. `checkSettle` is a view that names the first failing check, so clients
and the watchdog can show the reason.

**Before any trade**

1. **Time and state.** The window of the oldest pending epoch has ended. The
   caller is the keeper, or `keeperGrace` has passed since that window ended.
   The queue is not paused. While deposits are paused, the fund is shut down or a lending
   asset is excluded, deposit requests are not processed, and redemptions
   settle alone.
2. **Feed health.** The Base sequencer feed reports up, and has been up for
   `sequencerGrace`. Every basket asset's feed is younger than its own
   `maxFeedAge` and positive. Feeds quote USD and the pools quote USDC, so
   the USDC feed is read too. It must be within `usdcPegBandBps` of 1.
3. **Internal TWAP.** For each basket asset, one `observe` call returns the
   mean tick of each slice of the last `settleWindow`. There are `slices`
   equal slices. The TWAP is their median. At least `quorum` of them sit
   within `dispersionBps` of it. A push made and undone inside one
   transaction leaves no trace in this history.
4. **TWAP against feed.** Each TWAP is within `refBandBps` of its feed.
5. **Lending rate.** Each lending venue's own rate per unit grew by at most
   `maxLendRateGrowthBps` per day since the last settlement. The rate is the
   venue's exchange rate, not the size of the fund's position. A deposit, a
   step or a gift to the adapter does not move it.
6. **Share price.** The NAV per share at the feeds moved at most
   `maxSharePriceMoveBps` for each epoch that has passed since the last
   settlement.
7. **Snapshot.** The fund records the held amount of every active asset, the
   idle USDC and the supply.

**The flows**

8. **Redemptions**, oldest first, up to the period's redemption cap. The
   fund burns the shares and sells their pro-rata slice. Each sale has a
   limit inside the swap: at least the higher of the feed and the TWAP, less
   `legBandBps`. The redeemers receive the realized USDC minus the exit fee.
9. **Deposits**, oldest first, up to the period's deposit cap and the TVL
   cap. The fund buys the same fraction of every asset. It keeps that
   fraction of idle USDC, supplies that fraction to each lending venue, and
   buys that fraction of each basket token with an exact-output swap. Each
   purchase has a limit inside the swap: at most the lower of the feed and
   the TWAP, plus `legBandBps`. The fund mints that fraction of the supply to
   the queue. Purchases round up and the mint rounds down, both in the
   holders' favour. The chain sizes the purchase from the bound price, so the
   USDC is always enough. Unused USDC goes back to the depositors as a
   balance they withdraw.

   A cap is the larger of `maxEpochFlowBps` of NAV and `epochFlowFloorUsdc`.
   Each side has its own cap. A cap counts per `epochLength` of clock time,
   so a backlog of epochs cannot stack several caps into one block. NAV here
   is the value at the feeds from check 6. A cap never stops a settlement. It
   leaves the rest of a request pending.

**After the trades, in the same transaction**

10. **Proportion check, inside the fund.** For every active asset and for
    idle USDC, on held amounts:
    `amount after × supply before ≥ amount before × supply after`. The fund
    asserts this in its own mint and burn functions, so no caller can skip
    it. Lending venues can round a unit or two against the caller. The fund
    therefore supplies two units more and withdraws two units less than the
    exact amount. It never loosens the comparison.
11. **Realized price.** The cost per share minted is at or below the deposit
    bound price. The proceeds per share burned are at or above the redemption
    bound price. This restates what the per-swap limits already force.
12. **Record.** Each fill becomes a claim. Shares from a deposit unlock at
    `settle time + minHold`.

#### 5.9.4 Exits and emergency powers

**Exits that never depend on a price or on the checks above:**

- `cancel` of an unfilled request, by its owner.
- `redeemInKind` for shares in a wallet. The fund asserts the proportion
  check on it. It pays the idle USDC and the basket tokens at once. Every leg
  pays the exit fee. It pays the lending part in USDC up to the period's
  in-kind allowance. The allowance is the larger of `maxEpochFlowBps` of the
  fund's lending holdings and `epochFlowFloorUsdc`. It is counted in the
  venues' own USDC amounts, so no price is read. Beyond that, or when a venue cannot pay, the lending
  part becomes a claim on a share of that position. The claim's value moves
  with the venue. Interest and losses are shared pro rata with the holders
  who stay.
- `exitInKind` for shares waiting in the queue for a redemption, by their
  owner.
- Withdrawal of an expired request's escrow, by its owner.

Returns of escrow, USDC refunds and in-kind returns are pulled by the owner.
Nobody can push them to an address.

**Emergency powers. Each can only delay or return.** `shutdown` and
`emergencyUnwind` are not emergency powers: they are the timelock's (§5.6).

- `EMERGENCY_ROLE` can pause the queue. The exits stay open.
- `EMERGENCY_ROLE` can freeze the shares from one settlement's deposits
  while they are in their hold (pause-class, so it stays on the hot key, §5.6). A freeze ends by itself `maxFreeze` after the
  freeze call.
  Before that, the Safe can release the shares to their depositors, or let
  each depositor take them back in kind. Nobody else can receive them.

#### 5.9.5 Working defaults

| Parameter | Default | Layer |
| --- | --- | --- |
| `epochLength`, `settleWindow`, `minHold` | 6 h, 1 h, 1 h (24 h until decision D4-11, owner 2026-11-13: manipulations of large pools cannot be sustained for an hour) | 4 |
| `keeperGrace` | 6 h. The queue's own value, with the same default as the step's (§5.6) | 4 |
| `maxEpochFlowBps` | 500, for each side | 4 |
| `epochFlowFloorUsdc` | 250,000 USDC | 4 |
| `maxSharePriceMoveBps` | 1,000 for each epoch passed | 4 |
| `maxRoll` | 8 epochs | 4 |
| `minRequestUsdc` | 100 USDC | 4 |
| `maxFreeze` | 7 days | 4 |
| `slices`, `quorum`, `dispersionBps` | 12 of 5 min each, 9, 100 | 3 |
| `refBandBps` | 90 (was 50; owner default 2026-11-12, lever L10: the fund's own trades push its pools up to 97 bps from the feed at the keeper's calls, so 50 failed G9) | 2 and 3 |
| `legBandBps` | 100, and above the pool fee | 2 and 3 |
| `maxFeedAge` | Per feed: its heartbeat plus 5 minutes | 2 |
| `sequencerGrace` | 1 h | 2 |
| `usdcPegBandBps` | 50 | 2 |
| `maxLendRateGrowthBps` | 10 per day | 2 |
| `basketCallBps` | 5: in each block, each side may trade at most 5 bps of each basket pool's time-weighted USDC depth (owner default 2026-11-12, lever L5). A larger flow fills over several blocks. | 2 and 4 |
| `poolShareBps` | 2,500 | Asset rule (§4.5) |
| `minSeedUsdc` | 10,000 USDC | Asset rule (§4.5) |

Every value is an estimate until the sim sets it from the normal range. The
reason is then recorded. `ADMIN_ROLE` sets each value through the timelock,
inside hard bounds fixed in the code. `minHold` is at least 1 hour (1 day
until decision D4-11) and at most 7 days. `maxFreeze` is at most 14 days. The bounds also refuse values that
would stop every settlement. `epochFlowFloorUsdc` exists so that a small or
newly seeded fund can grow.

The queue stores the flow parameters, with the USDC feed, the sequencer feed
and their maximum ages. Each basket asset's feed and its `maxFeedAge` live in
the fund's asset config. The fund stores `poolShareBps`, `minSeedUsdc` and
the in-kind allowance.

#### 5.9.6 The vault interface: the ERC shape, not the letter

The fund is an ERC-4626 vault in shape, with ERC-7540's request and claim
flow. It departs from both where safety or size calls for it (owner,
2026-11-11, D13). Each departure is listed, so clients are not surprised.

**Two addresses, one vault.** The queue is the entry point for requests and
claims. The fund is the share token and holds every asset. ERC-7575 describes
this split of entry point and share. The fund sits close to the EIP-170 limit
(G1), which leaves too little room for the request and claim functions. Keeping them out of
the fund also keeps the custody contract small.

**Kept from the standards** (ERC-7540's text was read on 2026-11-11):

- The asset is USDC. The share is the fund's ERC-20.
- `requestDeposit` and `requestRedeem` open requests. Shares leave the
  caller's custody at the request.
- `deposit`, `mint` and `redeem` on the queue claim a settled request.
- The preview functions revert, as ERC-7540 requires for asynchronous flows.
- Pending and claimable views, and the request events.
- `totalAssets` and the convert functions on the fund, as views at the TWAP.

**Deliberate departures:**

| Departure | Why |
| --- | --- |
| Each request takes a limit. Quote views replace the previews. | A standard request accepts any price. A preview cannot know a future price, and a quote of the worst case can. |
| `cancel`, `exitInKind`, `redeemInKind` and withdrawal of expired escrow exist. | The standard has no cancel. Exits must never depend on a price. |
| Shares from a deposit are delivered only after `minHold`. | The hold (owner direction). |
| `withdraw` reverts `RedeemOnly`, as on the basket vaults today. | One claim function for redemptions. The fund never offered an exact-assets exit (§4.4). |
| `deposit`, `mint` and `redeem` on the fund itself revert and name the queue. | The fund is the share token, not the entry point. |
| `totalAssets` and the convert functions revert when a feed is unhealthy. `lastGoodNav` returns the last healthy value with its time. | A lender must not read a number nobody should trust. A client still needs a value to show. |
| There are no operators. A request pulls USDC or shares from the caller only. Operators and ERC-165 ids are added only if a client needs them. | Each adds surface to audit. |

Lenders that list the share must use a capped rate, never the raw view.

#### 5.9.7 What it costs

- **Deposits no longer fill deficits.** A pro-rata deposit does not change
  weights. D7 ends for deposits (D11). The rebalancer does that work. Step 3d
  measures the change in G4 cost.
- **Every deposit buys every asset, and every redemption sells every
  asset.** The users of that settlement pay the cost. Deposits and
  redemptions in one epoch are not netted against each other. Netting needs
  a price between users, and that price was the main source of attacks in
  the review (§17). The sim reports how much netting would have saved.
  Step 3f brings the match back under new rules (§5.11, D16).
- **Blocked settlements.** Every check must pass. Each check adds false
  alarms. The sim reports the blocked share per check, and G9 bounds it.
- **Feed dependence for liveness.** A feed outage, a sequencer outage or a
  USDC depeg stops settlement. It does not stop the exits.
- **A venue that cannot pay** stops timed redemptions until it can. Deposits
  still settle. In-kind exit stays open and defers the lending part.
- **A venue at its supply cap** stops deposits until the cap frees or the
  target changes. Redemptions still settle.
- **Fewer assets.** §4.5 excludes any asset without a feed that is live at
  all hours. That excludes tokenized equities.
- **Large flows take several epochs.** A request above the cap fills in
  parts, in order. A batch too large for a pool's depth fails its per-swap
  limit, and the keeper settles it in smaller calls.
- **A residual for flow users.** A user can get a price up to `legBandBps`
  from the stricter of the feed and the TWAP, and never worse than their own
  limit. Holders cannot lose to it.
- **No audited precedent** for the in-fund pro-rata purchase (§15.8). The
  on-chain proportion check backs the argument with an assertion.
- **Redemption is not synchronous** (D10). `redeemInKind` stays instant.

If the measured deposit cost is too high, the fallback is a NAV mint at the
outside feeds, settled in the same epochs. It adds no trusted pricing role.

### 5.10 The same layers on the rebalance (step 3e)

A flow no longer changes weights. A step is then the only trade made at a
price someone asserts. Each step gets:

- **Feed health and TWAP against feed** (checks 2 and 4 of §5.9.3) before it
  trades.
- **A limit from the stricter price for each direction.** A sale must
  receive at least the higher of the TWAP and the feed, less the step's
  slippage bound. A purchase must pay at most the lower of the two, plus it.
- **Cost booked against the feed**, which the fund cannot move. This fixes
  the under-reporting in cost report §4.
- **A balance check of its own:** only the two traded assets and idle USDC
  change, and the supply does not (RB-19).
- **Backoff only on the keeper's calls.** A stranger's failed call after the
  grace period must not delay an asset's next step.

From step 3f (§5.11, §19): `step` is keeper-only (D20), so there is no
stranger's call. And no step runs inside a settlement window: from the
close of an epoch that has locked requests until that epoch's first
successful settlement. The fund's own steps push its pools as far as
97 bps from the feed (§5.9.5), and the guard band is 90. A step in the
window could block the settlement or lean the match price.

Until step 3e is built, §5.3 to §5.8 and RB-4 and RB-5 describe the step as
it is: priced and booked at the TWAP alone.

### 5.11 Netted, forward-priced flows (step 3f)

Decided by the owner 2026-11-13 (D16 to D19, §18). Revised the same day
after an adversarial review of this section (D20 to D26, §19). **Not built
and not tested.** Until step 3f is built, §5.9 describes the flows as they are, and
the prototype, the Deploy 4 rehearsal and every result in §14 rest on §5.9.
This section is the design that step 3f builds. Every size, bound and cost in
it is an estimate.

#### 5.11.1 What the owner decided, and why

The owner's observation: several things the design promises users are what
make it unsafe. Three decisions follow.

1. **No price and no range for the user (D17).** A request names a quantity
   only. It gets the price of its settlement, which nobody knows when the
   request is made. This is forward pricing, the rule regulated funds use to
   stop trading on stale prices. The per-request limit, the bound prices and
   the worst-case quote are removed.
2. **No in-kind exit from a running fund (D18).** An in-kind exit gives a
   user a free choice between a price and the assets. It applies only once
   the goal is to wind the fund down (§5.11.5).
3. **No thin-pool asset, at any weight (D19).** An asset that fails the
   asset rule is delisted. It is not kept at a small weight. This is what
   lets the design rely on its NAV: the TWAP as the price, and the outside
   feeds as the guard on it.

With those three in place, a fourth becomes safe:

4. **Deposits and redemptions of one settlement are matched (D16).** They
   already settle in one transaction, against one snapshot and one set of
   checks. The matched part now changes hands between the users at the
   fund's NAV per share. Only the net amount trades with the market.

**The NAV method does not change.** The price of the match is the NAV of
§4.2: idle USDC, each lending position at the venue's own amount, and each
basket asset at its TWAP. The TWAP is the one the settlement already
computes, the median of the window's slices (check 3). The outside feeds
stay what they are today, guards. They stop a settlement when a TWAP is
further than `refBandBps` from its feed (check 4) or when the share price
moved too far (check 6). They set no price.

**Why matching is safer, not only cheaper.** Volume that never reaches a
pool cannot be sandwiched or ramped against. G8 fails today on attacks that
take a little from each flow trade inside the bands (A10, A2, §14). The
matched part gives those attacks nothing. A match also changes neither the
fund's assets nor its supply, so holders cannot lose on it.

**Why the match was removed before, and what is different now.** §17.3
removed the match for three reasons. Each is answered:

| Reason of §17 | Answer in step 3f |
| --- | --- |
| The settler's clearing limits chose who traded. | `settle` has no price and no selection input (RB-20, kept). There are no limits left to choose between. |
| Cancel was free while the match price was public. | A request can be cancelled only while its epoch is open. The price is set at least one settlement window later (RB-25). |
| A queued redeemer could choose the assets over the price. | `exitInKind` is removed. A running fund has no in-kind exit (§5.11.5). |
| A thin pool's held TWAP moved the match price (§15.5). | Every listed asset now has an outside feed and a deep pool (§4.5, D19). A TWAP further than `refBandBps` from its feed stops the settlement (check 4). So a held TWAP can move the match price by at most `refBandBps`, and it must be held through most of a window against arbitrage to do that. A27 measures whether that pays. |
| "Its only possible price is NAV. That is the Makina shape" (§15.2, I4). | Makina minted shares at a price read from one pool's spot data in one transaction. A match mints nothing and burns nothing. Its price is the median of a window's slices, it needs the quorum and the agreement of the outside feeds, and the request was made a window earlier. The most it can move is value between two users of one settlement, inside the bands. |

#### 5.11.2 The principle, restated

**Quantity sets every share minted or burned. No price moves value to or
from the holders who stay. One price, the fund's NAV per share at the
TWAP, moves value between the matched users of one settlement, and only
after every check has passed, the feed guards among them. Prices otherwise only bound a trade or stop a
settlement.**

The four layers of §5.9.1 stay. The argument "holders are safe by
construction" stays, because a match does not touch the fund and the net
part is still a pro-rata slice by quantity.

What changes is the sentence "no price moves value between any two
parties". A matched depositor and a matched redeemer now trade at a computed
price. If that price is wrong by `x`, one of them gains `x` and the other
loses `x`. Checks 2 to 4 bound `x`: every feed is fresh, the USDC peg holds,
and each pool's TWAP sits within `refBandBps` of its feed. Today a flow user
can already get a price up to `legBandBps` from the stricter of the feed and
the TWAP, and pays the pool fee on top (§5.9.7). So a matched user's worst
case is expected to be no worse than a trading user's worst case today. That
is an argument, not a test result. Step 3f measures it.

#### 5.11.3 An epoch under step 3f

1. **Request.** `requestDeposit(usdc, owner)` or
   `requestRedeem(shares, owner)`. No limit. Escrow comes from the caller
   only. The minimum size and the per-deposit cap stay.
2. **Terms, not a quote.** `quoteDeposit` and `quoteRedeem` return the fee,
   the cancel cutoff, the earliest settlement time and the end of the hold.
   They return no price. `lastGoodNav` is the value a client may show, marked
   as not binding. The bands of §5.9.5 are public parameters.
3. **Cutoff.** The owner can cancel a request while its epoch is open. When
   the epoch closes the request is locked. After that its escrow leaves the
   queue only by a fill or by expiry.
4. **Window.** Nothing settles for `settleWindow` after the epoch closes.
5. **Settle.** Only the keeper calls `settle` (D20). The keeper is a
   team-operated account, preferably a multisig. It only keeps the state
   machine moving and is not an actor with interests of its own. Nobody
   else can settle, so there is no grace period. `settle(maxRequests,
   maxUsdc)` keeps its two inputs, which only limit one call's work. Every
   locked, unexpired request takes part. Nothing is skipped for a price. If
   the keeper stops, nothing settles until the team restores it or the
   Safe winds the fund down (§5.11.5).
6. **Hold.** Unchanged. Shares from a deposit, matched or minted, stay in
   the queue until `settle time + minHold`.
7. **Roll and expiry.** A request the caps leave unfilled, or a blocked
   settlement leaves pending, rolls to the next settlement. A deposit
   request expires after `maxRoll` epochs, and its owner withdraws the
   USDC. A redemption request does not expire by itself (D25). It keeps its
   place in the order. After `maxRoll` epochs its owner may withdraw the
   unfilled shares instead of waiting. A run then drains in order and
   nobody is sent to the back.
8. **Terms are fixed at the request** (D26). The exit fee, the hold and
   the expiry time are stored on the request when it is made. A later
   parameter change applies to later requests only.

#### 5.11.4 One settlement under step 3f

Checks 1 to 7 of §5.9.3 are unchanged. A failed check reverts the call and
changes no state. Let `S` be the NAV per share of §4.2 with each basket
asset at the TWAP of check 3. Checks 4 and 6 have then already compared it
with the outside feeds.

**One price and one set of totals per window.** At the first `settle` call
after a window ends, the queue fixes `S` and the totals `D` and `R` of every
locked request. Later calls for the same window only distribute. A batch
split over several calls therefore gets one price, and the size of a call
selects nobody (RB-23).

**No match while a lending venue cannot pay** (D21). The NAV counts each
lending position at the venue's own amount. A venue that is fully borrowed
or impaired may not be worth that amount. A redeemer matched at `S` would
then leave at face value, and the matched depositors would carry the loss.
So before the match, the queue asks each lending venue whether it can pay
out, now, the matched shares' part of the fund's position. If any venue
cannot, there is no match in this settlement. `pauseDeposits` also stops
the match, as it stops deposits. A loss that a venue has not marked and
that does not show in its liquidity stays a residual. Every holder of the
fund carries that same risk.

**The match (replaces nothing, runs first).**

- **8a.** Let `D` be the USDC of the deposit requests that take part and `R` the
  shares of the redemption requests that take part. The matched shares are
  `M = min(R, D / S)`.
- **8b.** `M` shares move in the queue's own books from the redeemers' escrow to
  the depositors' hold. No share is minted, burned or sent to the fund.
- **8c.** The depositors pay `M × S` USDC. The redeemers are credited `M × S`
  minus the exit fee. The fee goes to the fee recipient. The exit fee is
  the same on a matched share and on a sold share.
- **8d.** The queue calls the ledger hook for every owner before their shares
  move (RB-22).
- **8e.** Rounding leaves dust on the queue's books, which `sweep` sends to the
  fund. A flow user never gains from rounding.

**The net side (steps 8 and 9 of §5.9.3, for the remainder only).** At most
one side has a remainder. It trades exactly as today: a pro-rata slice by
quantity, each swap inside its limit from the stricter of the feed and the
TWAP, in its own call into the fund. If that call fails, the remainder stays
pending and the match stands. The match needs no pool.

**One price per side.** Every request of a side that fills in one
settlement gets the same blend of the matched price and the net side's
realized price. Nobody is matched ahead of anybody else. Order decides only
who fills when a cap leaves part of a side pending: the oldest first.

**Caps.** The flow cap of each side per period counts every fill of that
side, matched or net (D22). Holding a TWAP just inside the guard band costs
a fixed amount, and the gain from it grows with the matched size. The cap
bounds that size. The TVL cap applies to the net deposit, because only the
net deposit adds NAV. The per-block basket cap (`basketCallBps`) applies to
the net trade as today.

**A net redemption does not stop on one venue** (D23). Today a lending
venue that cannot pay reverts the whole redemption side (§5.9.7). From
step 3f the fund pays that venue's part as a claim on the position (the
mechanism of RB-21) and pays the rest in USDC.

**While deposits are stopped** (deposits paused, a lending asset excluded,
an asset being sold out under §4.5, the fund shut down or in wind-down)
there is no
match. Redemptions settle alone, as today. A locked deposit request can be
cancelled while deposits are stopped. No price is forming for it then.

**After the trades.** Check 10, the proportion check inside the fund, is
unchanged and covers the net side. Check 11 loses the users' limits: the
realized price of the net side must be inside the per-swap limits. Check 12
is unchanged: each fill is a claim, and deposit claims unlock at
`settle time + minHold`.

#### 5.11.5 Exits, the wind-down and emergency powers under step 3f

**Exits from a running fund that never depend on a price:**

- `cancel`, while the request's epoch is open, and for a locked deposit
  while deposits are stopped.
- Expiry of a deposit after `maxRoll` epochs. Withdrawal of a redemption's
  unfilled shares after `maxRoll` epochs. The owner pulls the escrow back.

There is no in-kind exit from a running fund.

**The wind-down.** The in-kind exit applies only once the goal is to wind
the fund down (D18). The wind-down is a state, not a flag (D24):

- **Who starts it.** A multisig: the Safe (owner, 2026-11-14, D24). Like
  every other Safe action it goes through the timelock, so holders see it
  coming. Nobody else can start it. The emergency role is a hot key and
  cannot. Its `shutdown` stays what the architecture makes it, a halt: it
  stops deposits and the match, redemptions still settle, and no in-kind
  exit opens. There is no trigger that anyone can call. Winding a fund
  down is a decision, and a decision belongs to the multisig.
- **What it does.** No settlement, no match and no deposit. The rebalancer
  stops and its plan is paused. Every pending request is released at once
  and its owner withdraws the escrow. Shares in their hold are delivered
  on claim. Frozen shares keep their freeze, which still ends by itself.
- **The exit.** `redeemInKind` opens for every holder. The mechanics are
  unchanged: the proportion check, the exit fee on every leg, the lending
  allowance and the lending claims as position shares (RB-21).
- **Who ends it.** Only the Safe, through the timelock. The in-kind exit
  stays open until that action executes, so holders have the timelock's
  delay as notice.

**Emergency powers. Each can only delay.**

- `EMERGENCY_ROLE` can pause the queue. A pause ends by itself after
  `maxPause` and cannot be set again for the same length of time (D24).
- `EMERGENCY_ROLE` can shut the fund down (`shutdown`). That halts
  deposits and the match. It does not start a wind-down.
- `EMERGENCY_ROLE` can freeze the shares of one settlement's deposits,
  matched or minted, while they are in their hold. A freeze ends by itself
  after `maxFreeze`. The Safe can release it sooner. The in-kind return
  after a freeze (`allowReturn`, `takeReturn`) is removed: it was an
  in-kind exit from a running fund (D18).

#### 5.11.6 What step 3f removes and adds

| Removed | Why it can go |
| --- | --- |
| The per-request limit, the bound prices and limit-based eligibility (E12, RB-14) | D17. With no limit, no request is skipped, so the "refused" branch of the walk and attack A13 go too. |
| The price in `quoteDeposit` and `quoteRedeem` | D17. |
| `exitInKind` on the queue, and `redeemInKind` while the fund runs | D18. |
| "Cancel at any time" | The cutoff (RB-25). |
| `settle` and `step` by anyone after `keeperGrace` | D20. Both are keeper-only. `keeperGrace` goes. |
| `allowReturn` and `takeReturn` | D18. A freeze can be released or end by itself. |
| The departure from ERC-7540 "each request takes a limit" (§5.9.6) | A standard request has no limit. The request functions now match the standard's shape. |

| Added | What it is |
| --- | --- |
| The match | Book moves in the queue and one fee transfer. No new call into the fund. |
| The cutoff | One comparison in `cancel`. |
| The wind-down state | A Safe action through the timelock. A gate on `redeemInKind`, the release of queue escrow, and the stop of the rebalancer. |
| The venue liquidity test | One read per lending venue before a match. |
| A pause that ends by itself | `maxPause`, as `maxFreeze` already works. |
| No step in a settlement window | One time check in `step` (§5.10). |
| A sale path for a delisted asset | Keeper-only steps for that asset, with its own bound and budget (§4.5). |
| Asset rule 4 and delisting (§4.5) | A depth floor, checked where rule 3 is checked. |

#### 5.11.7 What it costs, and what stays open

- **A matched user trades at a computed price.** The loss is bounded by the
  checks, and it is another user's gain, never the holders' loss. It is the
  first price between users since §17.
- **Liveness rests on the keeper.** Nobody else can settle or step (D20).
  A stopped keeper costs users time. The keeper also picks the block of
  each settlement. It is trusted to settle at the first block it can.
- **A stuck fund waits for the multisig.** If settlements keep failing,
  the only exit is a wind-down, and only the Safe starts one (D24). Until
  it does, and for the timelock's delay after, a holder waits. No outsider
  can force a wind-down, and no holder can force one either. This is the
  one place where a holder's exit depends on people. The owner accepts it.
- **Steps lose the settlement windows.** A plan cannot step while a window
  with locked requests is open. A plan takes longer to converge. The sim
  reports by how much.
- **A TWAP lags the market.** The match price is up to a window old. It can
  differ from the true price by up to `refBandBps` without tripping the
  guard. That difference is one matched user's gain and the other's loss.
- **A locked request cannot be cancelled.** A user who changes their mind
  after the cutoff waits for the fill or the expiry. The exception is a
  deposit while deposits are stopped.
- **No instant exit.** A holder's only way out of a running fund is a
  settlement.
- **The user signs without a price.** They accept the market's move between
  the request and the settlement. The share-price breaker and the bands
  bound what a single settlement can do.
- **Two PRD promises change again**: the quote, and the in-kind exit that is
  "never blocked" (`one-vault-prd-amendments.md` §5).
- **The guard carries more weight.** The feeds still set no price. But the
  band between a TWAP and its feed is now the bound on what one matched
  user can lose to another. The asset rule's feed and depth requirements
  matter more for it (§4.5).

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
| `RobotMoneyFund` | — | **New.** One ERC-4626 vault in shape (§5.9.6) with a flat asset list, one target weight per asset, plan state, `executeStep` callable only by the `Rebalancer`, and the pro-rata purchase and sale callable only by the `FlowQueue`. It asserts the proportion check itself. No sleeve state. |
| `FlowQueue` | — | **New.** The entry point for requests and claims (§5.9.6). Holds pending USDC, escrowed shares and shares in their hold. Runs the settlement checks of §5.9.3. Holds none of the fund's assets. |
| `Rebalancer` | — | **New.** Holds no funds. Computes and validates steps, then calls the fund. Separate contract to keep the fund under EIP-170. |
| Lending and swap adapters | Used by their vaults | Unchanged, with two additions: the swap adapters need an exact-output swap with a price limit for the pro-rata purchase (§5.9.3, check 9), and each lending adapter exposes its venue's rate per unit (check 5). Their owning vault becomes the fund. |
| `RobotMoneyGateway` (separate system) | Allows deposits into three vaults | Its allowed-destination list becomes the fund's queue. It calls only the deposit request. Shares are delivered to the request's owner (D10). Done in the gateway's own release. The fund does not name the gateway (architecture §1 dependency rule holds). |

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
  feeds that agree with the TWAP (§5.10).
- **RB-6.** Rebalancing state never blocks a redemption request, its
  settlement or `redeemInKind`.
- **RB-7.** The rebalancer never moves the vault past `pathTarget(now)`.
- **RB-8.** The receipt contract stays signalling-only (INV-4). It never calls
  the fund, the rebalancer, or governance.
- **RB-9.** A target vector names every active asset exactly once and sums
  to 10,000. No contract stores or reads a sleeve or category.
- **RB-10.** No shares leave the queue and no USDC is paid before the
  epoch's settlement window ends (§5.9). The only exceptions are cancel,
  in-kind exit and withdrawal of expired escrow, which pay only that user.
- **RB-11.** Shares from a deposit leave the queue no sooner than
  `settle time + minHold`, and only to the request's owner. The one earlier
  exit is an in-kind return to that owner, which the Safe allows after a
  freeze.
- **RB-12.** A blocked settlement trades nothing. No role can settle past a
  failed check. A cancel or an expiry returns exactly what was escrowed and
  not yet filled.
- **RB-13.** No flow lowers the amount of any asset per share. Rounding only
  raises it. The fund asserts this inside its own mint, burn and in-kind
  functions, on the held amounts of active assets and idle USDC.
- **RB-14.** No request fills outside its limit. The chain decides which
  requests take part. No caller does.
- **RB-15.** A failed pre-trade check changes no state. A side whose call
  into the fund fails changes no state. Cancel works for every
  unfilled request, and in-kind exit for every unfilled redemption request,
  also while the queue is paused.
- **RB-16.** Nothing settles unless checks 1 to 6 of §5.9.3 pass: time and
  state, feed health and the USDC peg, the TWAP quorum, TWAP against feed,
  the lending rate bound and the share-price breaker. A side settles only if
  its per-swap price limits, the proportion check and the realized-price
  check hold. No fill exceeds a flow cap or the TVL cap.
- **RB-17.** No basket asset is active without a feed and pool history. No
  lending asset is active unless its adapter exposes the venue's rate. No
  target exceeds its pool-share limit (§4.5).
- **RB-18.** Frozen held shares can only go to their depositors, as shares or
  in kind. A freeze ends by itself `maxFreeze` after the freeze call (§5.9.4).
- **RB-19.** From step 3e, a step changes only its two traded assets and idle
  USDC, never the supply, and runs only when the feed checks of §5.10 pass.
- **RB-20.** `settle` takes no price and no selection as input. Its two
  inputs only limit how much one call does. Requests are processed oldest
  first. The next permitted caller continues where the last call stopped.
- **RB-21.** A deferred lending claim is a share of that position. Its owner
  and the fund's holders share the venue's later gains and losses pro rata.
- **RB-22.** The exclusion ledger credits every queued share to its owner.
  The queue reports each change of an owner's queued shares to the ledger
  before the change happens.

**From step 3f (§5.11, decided 2026-11-13, not built).** RB-23 to RB-32 are
new. RB-14 ends: there are no limits. Seven invariants change their wording:

- **RB-10 (3f).** No shares leave the queue and no USDC is paid before the
  epoch's settlement window ends. The only exceptions are a cancel before
  the cutoff and the withdrawal of expired escrow, which pay only that user.
- **RB-12 (3f).** A blocked settlement trades nothing and matches nothing.
  No role can settle past a failed check. A cancel before the cutoff or an
  expiry returns exactly what was escrowed and not yet filled.
- **RB-15 (3f).** A failed pre-trade check changes no state. A net side
  whose call into the fund fails changes no state, and the match of that
  settlement stands. Expired escrow can be withdrawn also while the queue
  is paused.
- **RB-16 (3f).** Nothing settles and nothing is matched unless checks 1 to
  6 of §5.9.3 pass. A net side settles only if its per-swap price limits and
  the proportion check hold. No net fill exceeds a flow cap or the TVL cap.
- **RB-23.** A request carries no price. Every fill of one side in one
  settlement gets the same price. No caller and no request chooses who is
  matched.
- **RB-24.** A match changes no asset amount of the fund and not the
  supply. It moves shares only from redeemers' escrow to depositors' hold,
  and USDC only from depositors' escrow to redeemers' claims and the fee
  recipient. Its price is the fund's NAV per share with each basket asset
  at the TWAP of check 3 of the same call. A match happens only if every
  feed guard of that call passed.
- **RB-25.** A request can be cancelled only while its epoch is open. After
  that its escrow leaves the queue only by a fill or by expiry.
- **RB-26.** `redeemInKind` pays only while the fund is in wind-down. Where
  it pays, RB-13 and RB-21 hold.
- **RB-18 (3f).** Frozen held shares can only go to their depositors, as
  shares. A freeze ends by itself `maxFreeze` after the freeze call. There
  is no in-kind return.
- **RB-20 (3f).** Only the keeper calls `settle` and `step`. `settle` takes
  no price and no selection as input. The price and the totals of a window
  are fixed at its first call.
- **RB-27.** Only the Safe, through the timelock, starts a wind-down, and
  only the Safe through the timelock ends one. No hot key, no keeper and
  no outside caller can do either. The in-kind exit is open from the start
  of a wind-down until the action that ends it executes.
- **RB-28.** No match happens while any lending venue cannot pay out the
  matched shares' part of the fund's position, or while deposits are
  stopped.
- **RB-29.** Every fill of a side, matched or net, counts against that
  side's flow cap for the period.
- **RB-30.** No step runs between the close of an epoch with locked
  requests and that epoch's first successful settlement.
- **RB-31.** A request's exit fee, hold and expiry are fixed when it is
  made. A redemption request never loses its place in the order.
- **RB-32.** A pause of the queue ends by itself after `maxPause` and
  cannot be set again for the same length of time.
- **RB-6 (3f).** Rebalancing state never blocks a redemption request or its
  settlement.

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
- **Request and claim (D10).** The dapp, `rmpc` and the indexer need request,
  pending, claimable and claim views, and cancel. The gateway needs only the
  deposit request. This is a new
  kind of surface for each client. It counts against G6. Three views serve
  them: the quotes (`quoteDeposit`, `quoteRedeem`), the reason a settlement is
  blocked (`checkSettle`), and the last healthy value (`lastGoodNav`).
- **rmpc.** Request, pending, claimable, claim and cancel commands replace
  the deposit preview, because the preview functions revert (§5.9.6).
  Preflight points at one vault. Read commands gain `plan` and `assets`. `receipt verify` runs the bucket audit check.
- **Explorer and indexer.** New tables for plans, steps, epochs and requests.
  Router tables go read-only for history.
- **Watchdog.** Watches step cost against caps, plan halts, and keeper
  liveness. It also watches blocked settlements, by check, and feed health.
- **publish-contracts.** New stages for the fund, the rebalancer and the
  queue. The router,
  registry-eligibility and three-vault stages go. The `apply-receipt` govern
  row targets `RebalanceGovernance` and prints `previewPlan` first. New rows:
  `pause-rebalance`, `resume-plan`, `extend-plan-budget`, `close-plan`,
  `set-step-params`, `seed-fund`, `set-flow-params`, `pause-queue`,
  `freeze-settlement`, `release-settlement` and `allow-settlement-return`.
- **Keeper.** A new small service. It calls `step()` and settles each epoch
  (§5.9.2). It needs a key with `KEEPER_ROLE` only, a runbook, and monitoring.

## 9. Migration

Out of the experiment's scope (owner, 2026-11-09). This section records the
production path only. ADR-0009 holds: there is no on-chain migration of holder funds.

1. Deploy the fund, the rebalancer, the queue and `RebalanceGovernance` as a
   fresh set of proxies (ADR-0014). Grant roles. Hand `ADMIN_ROLE` to the
   timelock.
2. The Safe seeds the fund with at least `minSeedUsdc`. It then sets the opening target with
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

**Exception: Deploy 4 (owner, 2026-11-12).** The owner asked for one
rehearsal deployment of this branch to Base mainnet (8453), before it merges
and before an audit, through the real deploy tool and runbook. The reason
given: it "will stress test our actual contract deployment tools better than
many rounds of local testing." It is a rehearsal: caps of at most 1,000 USDC,
a 1 USDC seed, and at most the deployer's 103 USDC at risk. It changes
nothing above: the experiment's tests still run offline, and the production
path below still needs an audit. The plan and its gates are in the Deploy 4
release yaml.

**Deploy 4 hardening, version `v0.8.0-onevault` (owner, 2026-11-13, after an
external review of the live rehearsal).** Five changes on the branch
`deploy4/hardening`, none of them on the live 8453 deployment. They change
behavior, so the fund system's version moves from `v0.7.0-onevault` (Deploy 4,
whose release yaml stays its record) to `v0.8.0-onevault`
(`docs/runbooks/contract-qa/releases/v0.8.0-onevault.yaml`, rc tags
`release/v0.8.0-onevault-rc.N-rehearsal`):

- The emergency key holds only the pauses. `shutdown` and `emergencyUnwind`
  are `ADMIN_ROLE`'s, so the Safe and the timelock delay (§5.6).
- The keeper must hold gas before its first send. The validator refuses a
  release whose first keeper send on a target has no hard balance check
  before it (P3.63 on 8453).
- Decision D4-10: the fund timelock's only executor is its Safe (§5.6). The
  executor is part of the timelock's CREATE2 init code, so a fund deploy from
  this branch predicts a different timelock address than Deploy 4's.
- A runbook row (P2.61) records each Safe owner's live key from the
  prove-control transaction, which carries every owner's signature.
- Decision D4-11: deposit shares are held 1 hour, the new default and the new
  floor (§5.9.5).

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
   Build and test the §5.9 design. Score G8 and G9. This runs on the 3b
   contracts.
   The engineering plan is `one-vault-timed-flows-eng-plan.md`.
   - **Attack tests.** Each models the attacker's full profit and loss. Each
     runs against the §5.9 fund, and against the frozen synchronous fund where
     the attack applies to it. That baseline is a frozen copy of the step 3c
     fund, kept for these tests.
     - A1, Makina replay: one transaction, a flash loan, a pushed pool, then
       a deposit or a redeem. Once per basket pool.
     - A2, TWAP push: hold a pushed price for 1 to N blocks against the
       sim's arbitrage.
     - A3, deflate then deposit, then exit.
     - A4, lending rate: move a lending venue's exchange rate.
     - A5, round trip in one block and in consecutive blocks.
     - A6, TWAP lag with a hedge, and no manipulation.
     - A7, sandwich of a settlement, by its caller and by a third party.
     - A8, blocking a settlement. Report the cost per day of each way.
     - A9, a run: many holders redeem at once. Who gets USDC first, and
       what in-kind exit does around the caps.
     - A10, a slow ramp of a pool with no arbitrage.
     - A11, griefing the hold of a pooled account.
     - A12, a batch larger than pool depth.
     - A13, a flood of requests whose limits never fill.
     - A14, a lending venue that is impaired, at its supply cap or fully
       borrowed: the in-kind run and the position claims.
     - A15, a gift to a lending adapter or to the fund, also on a freshly
       seeded fund.
     - A16, the emergency key freezing every settlement's deposits.
     - A17, a USDC depeg past the band.
     - A18, liquidity pulled from a pool just before a settlement.
     - A19, the exclusion ledger: a claim by an address filled after a
       record opened, and a claim by a redeemer whose shares were burned.
   - **The mechanism:** the queue, the in-fund pro-rata purchase and sale,
     limits decided by the chain, the checks of §5.9.3, the hold, the freeze,
     expiry after `maxRoll`, and lending claims as position shares. The asset list follows §4.5: no deSPXA. The fund
     must still pass G1, and the queue is held to the same size limit. The
     exclusion ledger must credit queued shares to their owners.
   - **Tests for RB-10 to RB-18 and RB-20 to RB-22.** Each check of §5.9.3
     has a test that trips it alone and shows that nothing settles. G3 is
     scored again over RB-1 to RB-22, without RB-19.
   - **Rerun the step 3 sim with timed flows.** Measure the execution cost of
     each flow against its feed value, the wait, how often a settlement is
     blocked and by which check, what netting deposits against redemptions would have saved, and
     the change in G4 cost from
     ending deficit-first deposits. Both arms of that comparison run on the
     §4.5 asset list: the frozen synchronous fund and the timed fund. Set
     every value of §5.9.5 from the sim's normal range. The rules of step 3e
     that replace deSPXA apply to this run too. Score G9 from this run. G4 and G5 are scored in step 3e (§13).
   - Write the attack results, G8 and G9 into §14.
3e. **The layers on the rebalance, and the rerun.** *After 3d.* Build §5.10:
   feed checks and the balance check on each step (RB-19), the limit from the
   stricter of TWAP and feed for each direction, and cost booked against the
   feed. Back off an asset only on the keeper's own failed calls. Test a
   keeper's sandwich of a step and a budget halt forced by noise (A20, which
   counts for G3). Score G3 again with RB-19. Then rerun the step 3 sim on the final design and score G4 and
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
3f. **Netted, forward-priced flows (owner, 2026-11-13).** *After 3e. Not
   started.* Build and test §5.11 on the step 3e contracts. The engineering
   plan is `one-vault-timed-flows-eng-plan.md` §8. These rules are fixed now,
   before any result:
   - **The mechanism:** requests without a limit, the cutoff, keeper-only
     `settle` and `step`, the match at the NAV at the TWAP under the feed
     guards, one price and one set of totals per window, the venue
     liquidity test, caps on every fill, the wind-down as a Safe-only state, the pause that ends by itself, terms fixed at the request,
     no step in a settlement window, asset rule 4 and the sale path of a
     delisted asset. The fund and the queue must still
     pass G1.
   - **Attack tests**, each with the attacker's full profit and loss, and
     the loss of each matched user and of the holders:
     - A21, a lagging TWAP: an informed user joins the side the TWAP's lag
       favours, inside the feed guard.
     - A22, withdrawn. It tested a caller of `settle` with a side. Only the
       keeper settles, and the keeper is not an actor (D20).
     - A23, a self-match: one owner on both sides. It must pay the fee, gain
       nothing, and dodge neither a cap nor the hold.
     - A24, the cutoff: a cancel after the epoch closes, and a request in
       the last block of an epoch.
     - A25, a pool pushed so the net side fails while the match settles.
     - A26, a stuck fund: settlement blocked for `maxRoll` epochs. Report
       the cost, what each holder can do, and what the wind-down then pays.
     - A27, a held pool TWAP: report how far it moves the match price before
       check 4 blocks, what holding it costs on a pool that passes §4.5, and
       the attacker's net result.
     - A28, a run with a match: many redeemers and few depositors. Who
       fills, at what price, in what order, and how long the last one waits.
     - A29, withdrawn. It tested a wind-down forced by an outsider. Only the
       Safe starts a wind-down (D24).
     - A30, a lending venue that is fully borrowed or impaired while both
       sides have requests: there must be no match, and the redeemers get a
       position claim for that venue.
     - A31, a plan in progress: steps at the edge of each settlement window
       through a whole plan. Report blocked settlements and the lean on the
       match price.
     - A32, a pause held by a compromised emergency key: it must end by
       itself. A `shutdown` by that key must halt deposits and open no
       in-kind exit.
     - A33, a parameter change by the timelock while requests are locked:
       their fee, hold and expiry must not move.
   - **Rerun A1 to A19** on the step 3f fund. A13 ends with the limits. A9
     and A14 use the in-kind exit only in a wind-down.
   - **Tests for RB-23 to RB-32** and for the changed RB-6, RB-10, RB-12,
     RB-15, RB-16, RB-18 and RB-20. G3 is scored again.
   - **Rerun the timed sim.** Report the matched share of the flow volume,
     the gain of A10 and A2 against the step 3d fund on the same seeds, the
     loss of a matched user against the sim's true price, and how long a
     request waits in the blocked scenarios. Score G8 and G9 again (§13).
   - The step 3d and 3e results stay in §14 beside the new ones.
4. **System size count.** *After 3f.* Count the contracts, deploy stages, govern rows and
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
| D10 | Do deposits and redemptions settle in timed epochs (§5.9)? | Yes. Accepted by the owner, 2026-11-11. Customers can wait. `redeemInKind` stays instant. | It removes same-block and flash-loan flows. The cost is the synchronous-redemption promise in architecture §4.4, and the owner accepts that. If the design goes to production, the production path (§10) changes architecture §4.4 and the PRD (`one-vault-prd-amendments.md`). |
| D11 | How is a flow priced? | By quantity. A deposit buys the same fraction of every asset and mints by that fraction. A redemption pays realized proceeds of a pro-rata slice. NAV is a guard and prices no flow. Decided 2026-11-11 after research (§15.8). | Holders are safe whatever any price says, and whatever assets the fund holds. The cost is deficit-first deposits (D7) and an in-fund purchase with no audited precedent. If the measured deposit cost is too high, or instant deposits were ever required, a NAV mint at independent feeds is the alternative. |
| D12 | What must an asset have to be listed? | An independent feed on Base that is live at all hours, a pool with one settlement window of history, and a largest position that fits its pool (§4.5). Approved 2026-11-11. deSPXA leaves until it has a feed. | The outside-feed layer needs a feed for every asset. The assets can change to fit the protocol. |
| D13 | How closely does the fund follow ERC-4626 and ERC-7540? | In shape, not to the letter. Departures are listed in §5.9.6. Owner, 2026-11-11. | Being an ERC-4626 vault is a core requirement. Safety practice from hardened protocols comes before interface detail. |
| D14 | What may stop a settlement, and what may set a share count? | Four layers may stop it: quantity, outside feeds, internal TWAP, time and rate. Only quantity sets how many shares are minted or burned. No price moves value between users. No role can override a blocked settlement. Approved 2026-11-11 (§16). | An attacker must beat all four at once. A false alarm costs time only. |
| D15 | When safety and simplicity pull apart, which wins? | Safety. Owner, 2026-11-11, after the adversarial review (§17). Every protective layer stays and its holes are fixed. Only parts that protect nobody are removed: the match between users, the settler's price and selection inputs, and the entry premium. | The review found that those three parts were where most attacks on queued users lived, and that they stopped no attack themselves. |
| D16 | Are the deposits and redemptions of one settlement matched? | Yes, from step 3f. The matched part changes hands at the fund's NAV per share, at the TWAP as in §4.2. The NAV method does not change. The outside feeds stay guards and set no price. Only the net amount trades. Owner, 2026-11-13 (§5.11, §18). This reverses the removal in D15 for the match only. | Both sides already settle together under the same checks. Matched volume never reaches a pool, so the pool attacks take nothing from it, and holders are untouched. D17 to D19 remove what made the match unsafe in §17. |
| D17 | Does a request carry a price limit, and does the user get a price before signing? | No, from step 3f. A request names a quantity. It can be cancelled until its epoch closes and is then locked. The quote views return terms and times, no price. Owner, 2026-11-13. This amends D14: no price moves value to or from holders, and one price moves value between matched users. | Forward pricing. A limit and an open cancel were the free look. The protocol's own bands protect the user. |
| D18 | Is there an in-kind exit? | Not from a running fund, from step 3f. `redeemInKind` applies only once the goal is to wind the fund down: it opens when the fund is shut down. This amends D10. Owner, 2026-11-13. | An in-kind exit from a running fund is a free choice between the price and the assets, paid for by the other side of a match. In a wind-down there is no match and the goal is to return the assets. |
| D19 | What happens to an asset with a thin pool? | It is delisted, at any weight. The asset rule gains an absolute depth floor (§4.5, rules 4 and 5). Owner, 2026-11-13. This tightens D12. | The design relies on its NAV: the TWAP as the price and the feeds as the guard. A thin pool is cheap to hold off its feed. |
| D20 | Who calls `settle` and `step`? | Only the keeper, for now. Owner, 2026-11-13. The keeper is a team-operated account, preferably a multisig, that keeps the state machine moving. It is not an actor in the system. This amends D3: nobody settles or steps after a grace period. | A caller with a side could pick the block and the batch. With one trusted caller that question goes. Liveness then rests on the keeper. If it stops, the team restores it or the Safe winds the fund down (D24). |
| D21 | Can a match happen while a lending venue cannot pay? | No. Before a match the queue tests that every lending venue can pay out the matched shares' part of its position. `pauseDeposits` stops the match too. Review fix, 2026-11-13 (§19). | The NAV counts a lending position at face. A matched redeemer would otherwise leave a damaged venue at full value at the depositors' cost. |
| D22 | Does matched volume count against the flow caps? | Yes. Every fill of a side counts. Review fix, 2026-11-13. This reverses the first draft of §5.11. | Holding a TWAP inside the band is a fixed cost and its gain grows with matched size. |
| D23 | What does a net redemption do when one lending venue cannot pay? | It pays that venue's part as a claim on the position and the rest in USDC. Review fix, 2026-11-13. | Lending is most of the fund. One full venue would otherwise stop every redemption, and there is no in-kind exit to go around it. |
| D24 | Who winds the fund down, and what are a pause and a wind-down? | A multisig: the Safe, through the timelock. Owner, 2026-11-14. Nobody else starts a wind-down: not the emergency hot key, not the keeper, not an outside caller. The wind-down is a state: no settlement, the rebalancer stops, queue escrow is released, in-kind opens, and only the Safe through the timelock ends it. The emergency key keeps its halts. `shutdown` stops deposits and the match and opens no exit. A pause ends by itself after `maxPause`. The in-kind return after a freeze is removed. | Winding a fund down is a decision, and the Safe is the only body that decides. The review's proposal, a trigger anyone could call on a stuck fund, is not adopted: it would let whoever can block settlement force a wind-down. The cost the owner accepts: a holder of a stuck fund waits for the multisig. |
| D25 | Does a redemption request expire? | No. It keeps its place. After `maxRoll` epochs its owner may withdraw the unfilled shares. Deposits still expire. Review fix, 2026-11-13. | In a run under the caps, expiry sent waiting redeemers to the back about five times. |
| D26 | Can a parameter change alter a locked request? | No. The fee, the hold and the expiry are fixed at the request. Review fix, 2026-11-13. | A locked request cannot leave, so its terms must not move under it. |

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
| G1 | Does the fund fit EIP-170 with today's optimizer settings and the rebalancer split out? | Fund, rebalancer and queue each deploy under 24,576 bytes, the EIP-170 limit the chain enforces. (Amended 2026-11-12 by the owner: the 1 KB headroom first asked for was a chosen margin, not a chain limit, and is dropped. Every G1 result before this date was scored against 23,552 and passed it.) | Either needs a further contract split that moves custody or accounting out of the fund. | ADR-0010 M-A2 (size pressure moves, it does not disappear) |
| G2 | Dropped (owner, 2026-11-09): gas is not a gate. | | | |
| G3 | Do the invariants hold under adversarial tests? | Every RB invariant (§7) and every existing custody invariant has a passing invariant or fork test, and every §5.8 threat has a test that shows the defence works. | Any invariant cannot be made to hold without a design change to custody or share accounting. | Audited-design safety, the core of the rejection |
| G4 | Is the shared rebalance cost acceptable? | Across the replayed receipts, median realized cost is at most 15 bps of turnover and no plan exceeds 30 bps. | Median above 15 bps, or any plan above 30 bps with default parameters. | New risk (D1). The reason ADR-0003 refused socialized cost |
| G5 | Does a plan actually converge? | Every replayed plan converges within `duration + maxOverrun`, and fewer than 10% of step attempts are skipped. | Any plan expires unconverged on a liquid asset (wETH, cbBTC), or skips exceed 10%. | New risk: the glide path is only useful if it finishes |
| G6 | Is the system smaller to build and operate? | Net contracts, deploy stages, govern rows and `ADMIN_ROLE` holders all go down, and every client change in §8 maps onto an existing surface. | Any of those counts goes up, or a client change in §8 needs a new kind of surface. | "Migration cost is not worth it" |
| G7 | Dropped (owner, 2026-11-09): migration is out of scope. | | | |
| G8 | Can an attacker drain value by moving prices? (Added 2026-11-11, before any step 3d result.) | Every attack test (A1 to A19, §10 step 3d) shows the attacker's net result (gain minus the cost of moving and holding prices, flash-loan fees and swap fees) is at most zero. No pending depositor or redeemer fills outside their limit. Holders lose at most 1 bps of NAV, and no asset amount per share falls. Every test of RB-10 to RB-18 and RB-20 to RB-22 passes. No tested way to block settlement for a day costs the attacker less than 1,000 USDC. (Amended 2026-11-11, before any result, per §15 and §17. The 1,000 USDC floor is a proposal the owner can change until step 3d runs.) | Any attack shows a positive net result for the attacker, or holders lose more than 1 bps of NAV, or a request fills outside its limit, in any attack scenario. Or settlement can be blocked for a day for less than the floor. | New risk: a pooled fund prices every flow from markets it does not control |
| G9 | Are customers served? (Added 2026-11-11 after the review of §17, before any step 3d result. The thresholds are proposals the owner can change until step 3d runs.) | In the sim's scenarios without a price jump: at least 95% of settlements succeed at the keeper's first call after the window. The 95th percentile time from a redemption request to claimable USDC is at most 14 hours. The median execution cost of a flow is at most 15 bps of its size and no flow pays more than 30 bps, measured against the feed value and before the exit fee. | Any of those is missed. | The PRD's promises on withdrawal, preview and explicit failure (`docs/prd.md` §2, §6, §9) |

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
RB-22 after its first score.

**G1 from step 3d** also holds the queue to the limit the fund and the
rebalancer have.

**Gates under step 3f (2026-11-13, before any step 3f result).** The
thresholds below are proposals the owner can change until step 3f runs.

- **G8** reads as before, with two changes. The clause "no pending depositor
  or redeemer fills outside their limit" becomes: every net fill is inside
  its per-swap limits, and no matched user gets a price further than
  `refBandBps` from the sim's true value of a share at the settlement block.
  The attack list is A1 to A12, A14 to A21 and A23 to A33. The invariants
  are RB-10 to RB-13, RB-15 to RB-18 and RB-20 to RB-32. With no exit
  from a running fund, a blocked day costs holders more than before, so
  the owner should set the floor on the cost of blocking again before step
  3f runs.
- **G9** keeps its three thresholds. With no exit from a running fund, the
  95th percentile wait is the customer's whole protection, so the sim also
  reports the longest wait in the blocked scenarios. That number has no
  threshold yet.
- **G3** is scored again over RB-1 to RB-32, without RB-14.
- **G5** is affected after all: a plan cannot step inside a settlement
  window (RB-30). It is scored again on the step 3f run.
- **G1** holds the fund and the queue to the same limit after the change.
- G4 is not affected by the flows. A flow still does not change weights.

Step 5 scores G8 and G9 on the step 3f run if step 3f is built, because
that is then the design that would go forward. The step 3d results stay in
§14.

## 14. Evidence log

Filled in as each phase finishes. Every row links to the commit, test run or
fixture pin it rests on.

| Gate | Result | Evidence | Date |
| --- | --- | --- | --- |
| G1 | Pass (2026-11-12, at the EIP-170 limit of 24,576 bytes) | Step 3 finish, with the owner defaults and the review fixes: fund implementation 23,237 bytes (1,339 under), rebalancer 21,471, queue 18,957. The largest linked library, `FundAdminLib`, is 23,406. `SizeGate.t.sol` passes. Earlier results below. | 2026-11-12 |
| G1 (earlier) | Pass | `SizeGate.t.sol`. After step 3b the fund implementation is 21,996 bytes, 1,556 under the 23,552 limit. Rebalancer is 18,001 bytes. The fund fits only with three linked libraries: `FundFlowsLib` (19,285), `FundAdminLib` (10,777) and `FundValuationLib` (8,038). These hold code, not custody or accounting state. The fund also uses the counter admin floor, not the enumerable one. Before step 3b the fund was 22,775 bytes (pin 55371881). Re-measured 2026-11-11 at pin 55462550. | 2026-11-11 |
| G2 | Dropped | | |
| G3 | Pass (2026-11-12) | Step 3 finish: 372 tests pass, 0 fail and 5 are skipped as measured G8 findings, on the replay fixture at pin 55462550 with the coverage check on (`unit-4.log`). An adversarial code review of the queue, the fund and the rebalancer raised 15 points. The 13 errors are fixed, each with a test that fails on the code before its fix (`beforefix.log`; see "Step 3 finish" below). No invariant needed a change to custody or share accounting. Earlier result below. | 2026-11-12 |
| G3 (earlier) | Pass, with listed prototype gaps | 29 fixture tests pass offline at pin 55371881 (563 accounts, 2,346 slots, no RPC). `Invariants.t.sol` (16 runs of 32 calls, fixed seed, fail on revert) checks RB-1 to RB-8 and INV-1. `EndToEnd.t.sol` runs deposit, receipt, timelock apply, steps to convergence, redeem and `redeemInKind`. `Adversarial.t.sol` has a passing test for all 8 rows of §5.8. `Custody.t.sol` covers INV-2 (donation accrual, first-depositor inflation) and INV-3 (fee and quarantine control only through the timelock). Review found 19 issues. 18 were fixed, among them a frozen venue that blocked `redeemInKind`, an admin able to grant the rebalancer role, and a gas-starvation lever on `step()`. Open gaps: a plan opened at zero NAV has a zero cost budget and halts until the admin extends it; dust on a removed basket asset is not re-absorbed (INV-2 port from `BasketVault` not done); a frozen lending venue still blocks the USDC `redeem` path, as it does today. | 2026-11-09 |
| G4 | Pass (2026-11-12, the step 3e design at the owner defaults) | Timed default run, `sim/TimedFlowSim.t.sol` scored by `sim/score-sim.ts`, 36 scored plans: median 7.63 bps of turnover, worst 27.81 bps (SEQ-5M-s2, receipt d05). Other readings: arrival price 5.80 / 16.85, per traded 7.22 / 10.38, the plan's own `costSpent` 8.54 / 29.88. EXT-PROBE 5M beside it: 10.28 / 10.66. This is the run §13 scores (step 3e, the stated fallback). The step 3 result below stays as the result of the first design. | 2026-11-12 |
| G4 (step 3) | Fail | `sim/RebalanceSim.t.sol` scored by `sim/score-sim.ts`, default parameters, 36 scored plans. Median realized cost is 17.02 bps of turnover. The worst plan costs 82.63 bps (JUMP-DOWN-1M-s2, receipt d07). Both exceed the 15 and 30 bps limits. Cost is measured against the reference price. Measured against the arrival price, the median is 5.48 bps and the worst is 9.13 bps. The tuned set also fails: median 17.76 bps, worst 83.40 bps. Fixture pin 55462550 (2,193 accounts, 17,310 slots), recorded through anvil forking Base. All 16 sim tests pass offline for each parameter set. Fallback (step 3c, not the scored result): the auction executor also fails, median 28.72 bps and worst 61.71 bps. The LP re-centre sensitivity does not change G4: median 17.20 bps, worst 59.19 bps. | 2026-11-11 |
| G5 | Not pass (no fail clause fired), 2026-11-12 | Same timed default run. Blocked skips are 60 of 10,620 step attempts (0.56%); no plan is over 10% (worst 2.7%). The literal count of every skip reason is 10.20%. Three plans did not converge: SEQ-5M d05 in all three seeds halted on the cost budget. None expired unconverged on a liquid asset. So "every plan converges" is false, and no fail clause fired. The step 3 result below stays as the result of the first design. | 2026-11-12 |
| G5 (step 3) | Not pass (no fail clause fired) | Same runs. No liquid-asset plan expired. Blocked skips are 4.99% of step attempts overall. One plan expired unconverged on deSPXA and the three lending assets: JUMP-DOWN-1M-s1, receipt d07. Its pool left the recorded LP range. Three JUMP-DOWN plans each skip more than 10% of their steps (27.0%, 61.3% and 13.5%). Without the five plans whose pool left its LP range, G5 passes: every plan converges and skips are 0.13%. The tuned set is worse: skips are 7.35%, and eight plans exceed 10%. Fallback (step 3c, not the scored result): the auction executor fails G5 at 10.63% blocked skips. With the LP re-centre sensitivity, G5 passes on the default steps (0.42% blocked, all plans converge). That model is an assumption, not a measurement. It does not replace this result. | 2026-11-11 |
| G6 | Not run | | |
| G8 | Fail (2026-11-12, at the owner defaults) | Deterministic tests (`Attacks.t.sol`, `Step3e.t.sol`) and the timed sim attacks (`sim/AttackSim.t.sol`, live fund, 4 seeds, each against an honest twin). Holders lost 0 in every sim run. Positive attacker nets: A10 slow ramp inside the band, deterministic +156.62 USDC (+110.1 after a flash fee), sim strict max +61.76 (best mean +16.04); A20 keeper sandwich of a step, sale leg +8.84 with holders 4.81 bps of NAV past the honest step; A2 sim strict max +0.35 (best mean +0.16); A6 sim strict max +467.55 in one run of eight, with 0 lost by holders and by pending users and a best mean of 0 (the gain is the hedge's gain in the simulated market, not value taken from the fund). The A20 purchase leg nets −0.12, but holders lose 1.26 bps past the honest step, over the 1 bps limit. Fixed by the defaults: the one-block sandwich of a settlement, A7, nets −211.1 (it was +297.11), sim A2 +0.35 (was +514.50), A20 purchase −0.12 (was +67.63). Blocking settlement for a day costs at least 5,050 USDC on every scored way. Every other attack test passes. | 2026-11-12 |
| Hardening, `v0.8.0-onevault` (2026-11-13) | G1 pass, G8 unchanged | The five owner changes of §10 ("Deploy 4 hardening"). G1: the fund implementation stays 23,237 bytes (1,339 under EIP-170: the moved roles change only a role id), the rebalancer 21,471, the queue 18,956. Prototype suite with forge 1.8.5: every test passes except the opt-in sims and the measured G8 findings, which skip as before. G8 re-scored with `minHold` at 1 h (decision D4-11): the deterministic attacks give the same nets (A10 +156.64, A20 sale leg +8.84 with holders 4.81 bps past the honest step, A20 purchase −0.12 with 1.26 bps, A7 best −211.13), and the timed sim attacks (`PROTO_SIM_ATTACKS=1`, 4 seeds) give A10 strict max +61.76, A2 +0.35 and A6 +467.55, as on 2026-11-12. No scored attack holds a price through the hold, so a shorter hold moves no G8 number. | 2026-11-13 |
| G9 | Pass (2026-11-12, at the owner defaults) | Timed default run, no-jump set: 99.20% of settlements succeed at the keeper's first call (497 of 501; the 4 misses are check 4). Redemption wait median 3.57 h, p95 6.53 h (0 unfilled past 14 h). Flow cost against the feed median 0.32 bps, max 18.95 bps. At `refBandBps` 50 it failed at 84.02% (step 3 finish report). | 2026-11-12 |
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

**Step 3 finish and the owner defaults (2026-11-12).** The owner delegated
the open choices of the step 3 finish report. Three defaults are now in
code:

- the per-call basket cap of 5 bps of each pool's time-weighted USDC depth
  (`FlowLevers.basketCallBps`, set by `FlowQueue.initialize`);
- `refBandBps` 90;
- each basket asset's step cap: `maxStepUsdc`, and 5 bps of its pool's
  time-weighted USDC depth (`Rebalancer.stepDepthBps`, `assetStepCap`).

At the pin the wETH step cap is about 12,700 USDC. A20 then changed:

- purchase leg: from +67.63 to −0.12 USDC, and holders' loss from 9.28 to
  1.26 bps;
- sale leg: from +37.19 to +8.84 USDC, and holders' loss from 7.64 to
  4.81 bps.

The 1 KB headroom under EIP-170 was dropped from G1 (owner, same day).

An adversarial code review in three independent parts (queue, fund,
rebalancer) raised 15 points. 13 were errors, and each was fixed. Each test below fails on the
code before its fix, with every fix switched off and the defaults kept
(`~/tmp/onevault-finish/logs/beforefix.log`), and passes after it. All
are in `ReviewFixes.t.sol` unless named.

| Id | Error | Fix | Test |
| --- | --- | --- | --- |
| R-F1 | A basket asset whose depth cap is below `minStepUsdc` stalls the whole plan | Masked from leg picking; `SkipReason.DepthCap` | `test_RF1_*` (2) |
| R-F2 | A few seconds of thin liquidity zero the depth for a whole window | Depth from the third-thinnest of 12 slices (§4.5) | `test_RF2_*` (2; one control) |
| R-F4 | An upgraded proxy reads the depth cap as 0 | 0 reads as the default | `test_RF4_*` |
| R-F5 | A converged plan is labelled Expired at the overrun edge | Convergence checked before expiry and cooldown | `test_RF5_*` |
| Q-F1 | An excluded venue's failing rate read holds every settlement | Check 5 skips excluded venues; the read is gas-capped | `test_QF1_*` |
| Q-F2 | One small call takes the whole block's room under the per-call cap | The cap is a budget per block and side | `test_QF2_*` |
| Q-F3 | A revoke then re-allow between settlements trips check 6 | The ledger's record count finds the cycle; the venue is re-based | `test_QF3_*` |
| Q-F4 | An allowed early return outlives a freeze that ran out | `takeReturn` needs the settlement still frozen | `test_QF4_*` |
| Q-F5 | A cap below the minimum fill halts settlement silently | `SettleCallRoomBelowMinimum` event | `test_QF5_*` |
| B-F1 | An excluded venue holding only rounding dust can never be removed, so deposits stay closed | Dust and the claims' part allowed; a failing read allowed while excluded | `FundExtras.t.sol` `test_BF1_*` (3; one control) |
| B-F3 | Re-listing an adapter lets old position claims read new holders' money | Refused while an inactive entry has open claims | `FundExtras.t.sol` `test_BF3_*` |
| B-F4 | A higher TVL cap or a lower `poolShareBps` skips §4.5 rule 3 | Both re-check it; a lower cap is never refused | `FundExtras.t.sol` `test_BF4_*` |
| B-F5 | The last step overshoots the plan budget (RB-4) | The step's cost cap is the budget left; halt when the budget left is below the step's cost | `FundExtras.t.sol` `test_BF5_*` |

Two review points were not changed, each for a stated reason:

- **R-F3.** At 5 bps a plan as large as the pool-share limit may not finish
  in `duration + maxOverrun`. That is the cost of the decided default, and
  G5 measures it.
- **B-F2.** Depth is read as the virtual reserve of the in-range liquidity
  (`L·√P`), not the USDC inside a fixed price band. That is the documented
  reading behind every measured cap, so changing it would change what the
  decided 5 bps means. It is open for the owner.

The tests now model one keeper call per block (2 s), because the cap is a
budget per block. Large flows fill over several blocks, and every
assertion holds after each part. No fixture re-record was needed.

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
| `minHold` | 24 h | Unchanged (1 h since decision D4-11, 2026-11-13) |
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

**Note, after D12 and the review of §17.** The third reason is weaker than
it reads. The asset rule (§4.5) now requires a feed for every asset in this
design too. What stays true: here a missing or wrong feed can only block or
bound a trade. Under a NAV mint it would misprice the shares.

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
buys exact amounts of every asset (after §17 the chain sizes the purchase
itself). Every asset then grows by the same
fraction. The smallest-ratio rule and its surplus are no longer needed.
§15.4 as a whole is a record of the first correction. §5.9 is the design.

## 16. The layered design: review, sources and sign-off

Status: approved by the owner, 2026-11-11 (§16.4). The design itself now
lives in §4.5, §5.9 and §5.10. This section keeps the record: the review that
led to the layers, the industry practice behind each one, and the sign-offs.
Nothing here is built or tested yet.

### 16.1 Review of the documents before the layers

This table describes §5.9 and the engineering plan as they stood before this
section's changes. Every fix is now made. After §17 two of them changed form:
the growth bound on a lending position became a bound on the venue's own
rate, and the value check became the per-swap limits.

| Finding | Where | Fix |
| --- | --- | --- |
| The outside feed is optional ("where an asset has one"). An asset without a feed has only the pool's own TWAP behind it. | §5.9 guards | Every basket asset must have a feed (§4.5). |
| Nothing checks the value of a net leg. A net deposit can pay any cost inside the 50 bps spot band and the users' own limits. A standard ERC-7540 request has no limit. | §5.9, eng plan E12 | A value check against the feed NAV. After §17 it became the per-swap limits (§5.9.3, checks 8 and 9). |
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
§5.9.3 as revised after §17. "Lesson" rows come from an
exploit, not from a design.

| Source | Their practice | Adopted as | Hardened further |
| --- | --- | --- | --- |
| Uniswap v2 | Mint by the ratio of amounts. Check the invariant after the trade. Lock against reentrancy. Burn the first shares. | Layer 1. Check 10 after the trades. Seed shares locked for good. | The check covers every asset and the supply. It also covers `redeemInKind`. Each rebalance step gets a balance check of its own (RB-19). |
| Set, Index Coop, Reserve | In-kind issuance. The depositor pays the swap cost. | A deposit buys a pro-rata slice. | The purchase happens inside the fund under the four layers. There is no outside zap to attack. The research found that zaps are where flow users lose. The per-swap limits and the user's own limit answer that. |
| Reserve RToken | Hourly issuance and redemption throttles. Issuance stops when the basket is not ready. | `maxEpochFlowBps` on each side. No deposit settles while a lending asset is excluded or the fund is shut down. | Reserve throttles every redemption. Here the timed path and the lending part of an in-kind exit are throttled. The basket part of an in-kind exit is not, because it takes only its own slice. |
| Enzyme | Chainlink-only pricing. In-kind redemption that cannot be blocked by a failing price. A timelock between deposit and exit. | Rule 1 of §4.5. `redeemInKind` reads no price. `minHold`. | Enzyme mints at the feed. Here the feed can only block. The hold is 1 hour (24 hours until decision D4-11, 2026-11-13) and the shares are not in the user's hands during it. |
| Veda | Rate bounds and a minimum delay. A breach stops the vault. A share lock during which a deposit can be reversed. An optional share premium on deposits. | Checks 4 to 6. `minHold` in the queue. | No accountant posts a rate. During the hold, `EMERGENCY_ROLE` can freeze a settlement's deposit shares for at most `maxFreeze`. The Safe can let the depositors take them back in kind. Veda returns the deposited asset. Here a depositor gets the slice back, having paid the swap cost. The deposit premium is not adopted. |
| Lagoon, Centrifuge | Request and claim. The price is not known when the request is made. | Epochs and the window. | No role proposes a valuation. Lagoon bars cancellation once a valuation is proposed, because its flows cross at that price. Here no flow crosses at a price, so a request can be cancelled until it fills. |
| Sommelier | A share-price oracle checked against a TWAP. A two-day share lock. | Checks 4 and 6. | Two prices per asset plus the proportion check. |
| Mellow | A report far from the last one is rejected. A moderate one needs a human to accept it. | The bands in checks 3 to 6 and the per-swap limits. | No human can accept a blocked settlement. The only override is to wait or to exit. This trades liveness for safety. G9 bounds how often it blocks. |
| Chainlink guidance | Check feed age and the sequencer. Pause when the reference market is closed. | Check 2. Rule 1 requires a feed that is live at all hours. | An asset whose feed has closed hours is not listed at all. |
| Lesson: Makina, Harvest | A pool's spot price went into the share price in one transaction. | No flow settles in one transaction. No pool price sets a share count. | Layers 1 and 4. |
| Lesson: Venus (2026), Inverse, Rari | A TWAP or a two-feed bound was beaten on a thin market by a held price. | Rule 3 of §4.5 caps the position against the pool's time-weighted liquidity. The feed must not come from the fund's own pool. | Even a beaten feed and TWAP together cannot dilute holders. |
| Lesson: GMX v1, Summer.fi | The vault's own accounting state was corrupted or stale while outside prices were honest. | Check 10 compares real balances, net of owed claims, not stored accounting. Check 5 bounds each venue's rate. | A donation becomes a gift to holders. A lending claim from an in-kind exit is a share of the position, so a stale mark is not paid out at face. |
| Lesson: Indexed Finance | A single-asset side door and a rebalance sized from the pool's own spot. | No single-asset mint path exists outside settlement. §5.10 for the rebalance. | The step's limit uses the stricter of TWAP and feed for each direction. |
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

**Revised after the review of §17.** S1's settlement order changed: there is
no match, the chain decides who takes part, and each swap has its own price
limit. S4's freeze gained a time limit and a pull-based return. D15 records
the owner's rule for the revision.

## 17. Adversarial review of the approved design, and the safety-first revision

Status: review and revision, 2026-11-11. Four independent reviewers read the
documents after the owner's sign-off of §16.4. None of them wrote the design.
The owner's five questions were: are we achieving the product goals, are we
correctly serving our customers, is the code and protocol as simple as it can
be, are there security vulnerabilities in the smart contracts, and are we
prioritizing safety from economic exploits. The hardened flows are not built
yet, so the security reviewer treated the design as the code. No reviewer ran
a test or the sim. Every size and cost in this section is an estimate.

The owner's rule for acting on the review (2026-11-11): safety comes before
simplicity. §4.5, §5.9, §5.10, §7, §10 and §13 now carry the revision. This
section is the record.

### 17.1 The answers

| Question | Answer before the revision | What the revision does |
| --- | --- | --- |
| Product goals | Partly. Existing money follows an applied receipt. Four PRD promises broke without a recorded decision: one-transaction withdrawal, "withdrawals are never blocked", a preview, and a choice of exposure. | Quote views, a time limit on the freeze and an in-kind exit that stays open for delivered shares restore what can be restored. The PRD changes are staged in `one-vault-prd-amendments.md`. The choice of exposure stays open (D2). |
| Customers | Not well. No gate measured wait, blocked settlements or cost. A keeper could choose who traded. Small holders and agents had no path. | Gate G9. The chain decides who takes part. No minimum on a whole-balance redemption. An agent's request is owned by its depositor. |
| Simplicity | No. Most of the weight served one cost saver, the match between users. | The match, the settler's price and selection inputs and the entry premium are removed. Every protective layer stays, by the owner's rule. The parameter count did not fall. |
| Contract security | One rule lost money: the exclusion ledger read queued shares through a view. Several rules could stop the fund cheaply. | RB-20 to RB-22, the proportion check inside the fund, lending claims as position shares, no request cap. |
| Economic safety | Holders were safe from price moves on basket assets. Queued users, holders in a lending-venue failure, and holders at each rebalance step were not. Blocking was cheap. | Per-swap price limits, no price between users, the lending rate read from the venue, a cost floor for blocking in G8, and step 3e for the rebalance. |

### 17.2 Findings and what became of each

Severity is the reviewer's. "Fixed" means the design text now answers it.
Nothing is built or tested.

| Finding | Severity | Resolution |
| --- | --- | --- |
| The exclusion ledger read queued shares through a view. A fresh address filled by a settlement could claim older holders' recovery money. A queued redeemer lost the claim when the shares burned. | High | Fixed: RB-22. The queue reports every change before it happens. |
| A run on a failing lending venue. In-kind exit paid the lending part at face value or as a fixed USDC claim. Later loss fell on the holders who stayed. | High | Fixed: RB-21 and §5.9.4. The claim is a share of the position. The USDC part has a per-period allowance. |
| The settler's clearing limits chose who traded. An outsider could block the keeper cheaply and take the settler's seat. | High | Fixed: RB-20. `settle` has no price input and selects nothing. Its two inputs only limit one call's work. The seat has no value. |
| No price limit inside a swap. The value check was blended across assets. | High | Fixed: §5.9.3 checks 8 and 9. Each swap is limited by the stricter of the feed and the TWAP. |
| 200 request slots could be held for about 20,000 USDC of float, for good if the owner was a blocklisted address. | High | Fixed: no cap on requests. `settle` works in chunks. Escrow is returned by pull only. |
| The lending growth check read position size. A rebalance step or a small gift would block every settlement. | High | Fixed: check 5 reads the venue's own rate per unit. |
| No customer gate. | Critical (product) | Fixed: G9, with proposed thresholds. |
| No bound on the time to USDC. | High | Partly. G9 measures it. In-kind exit is the bound. |
| Previews revert, so a user signs blind. | High | Fixed: quote views (§5.9.2). |
| An agent needs a limit, a later claim and an owner. | High | Fixed in design (§5.9.2). The gateway change is counted for G6, not built. |
| A free look: cancel was free while the match price was public. | Medium | Fixed: there is no match. |
| The proportion check had no defined asset set, and exact comparison fails on venue rounding. | Medium | Fixed: check 10. |
| A request filled in two epochs had no defined unlock time or refund. | Medium | Fixed: each fill is its own claim (§5.9.2). |
| The in-kind return was a loop that one unpayable depositor could stop. The freeze had no time limit. | Medium | Fixed: pull only, and `maxFreeze`. |
| The proportion check for mints lived outside the fund. | Medium | Fixed: check 10 is inside the fund. |
| The pool-share rule read a token balance that one transaction could inflate. | Low | Fixed: time-weighted liquidity (§4.5). |
| "The lower of TWAP and feed" was the weak floor for a sale. | Low | Fixed: §5.10. |
| A small gift could skew a freshly seeded fund. | Low | Fixed: `minSeedUsdc`. |
| Feeds quote USD and pools quote USDC. | Medium | Fixed: the USDC peg check (check 2). |
| Three checks were one check at the default bands. | Simplicity | Fixed: the spot band and the value band became the per-swap limit. The two-NAV comparison is gone. |
| The request functions were specified in two places. | Simplicity | Fixed: the queue is the entry point (§5.9.6). |
| In the code the design keeps: in-kind exit reverts when a venue's value read reverts. A deferral to the zero address can never be cleared. A stranger's failed step backs off assets. | Medium, Low, Low | The first two are fixes in the engineering plan (E23). The third is in §5.10 (step 3e). |
| The rebalance step trades at the TWAP alone, and G4 failed. | Medium | Step 3e. |
| One exposure for everyone, where 95% of launch weight is stable yield. | High (product) | Open: D2. The conclusion decides whether a stable-only vault stays. |
| The receipt's four buckets shrink to two usable ones, and nobody signs per-asset weights. | High (product) | Open: D8. |

### 17.3 What the revision removed, and why that is the safer choice

- **The match between users.** It saved swap cost. It stopped no attack. It
  was the only place where a computed price moved value between two parties.
  It needed the settlement price, both clearing limits and a free cancel that
  gave the informed side a free look.
- **The settler's price and selection inputs.** They let the caller choose
  who traded. The chain now decides from bound prices it computes itself. Two
  inputs remain. They only limit how much one call does.
- **The entry premium.** It did nothing at its default of 0. It would have
  been a fourth fee class against the PRD's three.

### 17.4 What stays, although a reviewer wanted it gone

The simplicity review would also have removed the per-request limits, the
slice quorum, the share-price breaker, the sequencer check, the lending
check, the hold, the freeze and the on-chain pool-share rule. Each protects
someone in some failure, so each stays under the owner's rule. Their cost is
more blocked settlements. G9 bounds that cost, and the sim sets each band.

### 17.5 Still open

- **A stable-only vault beside the fund** (D2).
- **Who signs per-asset weights** (D8), and what a receipt with a weight on an
  unlisted bucket does.
- **The PRD.** The staged amendments need the owner's review.
- **The G9 thresholds and the G8 blocking cost floor.** They are proposals
  until step 3d runs.
- **A venue that cannot pay** still stops timed redemptions. In-kind exit
  stays open.
- **A fee recipient that cannot receive USDC** would stop redemptions. This
  is in the code the design keeps.
- **PAXG**, which the Hard Assets vault on `dev` holds, is not assessed
  against §4.5. This branch predates that vault.

### 17.6 Unverified

- No test and no sim run backs any finding or any fix.
- Three claims were checked against the code by hand: the fixed USDC lending
  claim, the ledger's lazy checkpoints, and the PRD quotes.
- Chainlink parameters on Base, venue rounding in Aave and Morpho, and the
  share of settlements that normal volatility would block are not measured.

## 18. Owner review of the flow promises, and the netted, forward-priced revision

Status: decision record, 2026-11-13. The owner reviewed the deposit and
withdrawal flows of §5.9 as built in step 3d. Nothing in this section is
built or tested. §5.11 is the design. §4.5, §7, §10, §11 and §13 carry the
changes. The engineering plan is `one-vault-timed-flows-eng-plan.md` §8.

### 18.1 The question that started it

The owner asked whether queued deposits and queued withdrawals happen at the
same time, so that they net out. They settle in one transaction, but they do
not net: the fund sells a slice for the redeemers and buys the same assets
back for the depositors (§5.9.7, eng plan E5). §17.3 had removed the match.

The owner's intuition: settling both sides together should let the protocol
check quantities and prices at once and give no party an advantage.

### 18.2 The owner's three observations

"A number of things we are promising users seems to be breaking a safe
design."

| # | Owner, 2026-11-13 | What it changes | Decision |
| --- | --- | --- | --- |
| a | "I'm not sure we need to give users a price or range for their settlement." | The per-request limit, the bound prices and the worst-case quote go. A request is forward priced. | D17 |
| b | "I'm not sure we should offer an in-kind exit at all." Then: "I think the in-kind exit only applies after there is a goal to wind down the fund." | No in-kind exit from a running fund. `redeemInKind` opens when the fund is shut down. | D18 |
| c | "Thin pool assets should be excluded altogether, such that we can rely on our NAV pricing, through TWAP and oracles." | An asset that fails the asset rule is delisted, not kept at a small weight. The rule gains a depth floor. | D19 |

Together they make the match safe to bring back (D16).

### 18.3 How the three fit together

- **The limit made the free look.** A limit forces the chain to decide who is
  eligible, and a cancel that stays open lets a user watch the price form.
  With no limit and a cutoff, a request is an order at a price nobody knows
  yet.
- **The in-kind exit made the option.** A queued redeemer who can leave in
  kind at any moment holds a free choice between the match price and the
  assets. The user on the other side of the match pays for that choice.
- **The thin pool made the price movable.** Every attack on the match price
  in §15 went through a pool whose TWAP could be held. Every listed asset
  now has a deep pool and an outside feed that guards its TWAP.

### 18.4 Two corrections by the owner to the first draft

The first draft of this revision, written the same day, got two things
wrong. The owner corrected both.

1. **In-kind.** The draft kept an in-kind exit for an expired redemption
   request, and let redemption requests through a pause, to bound how long
   a holder could be stuck. The owner: the in-kind exit applies only after
   there is a goal to wind down the fund. So a running fund has no in-kind
   exit. A holder of a fund whose settlements fail waits until settlement
   resumes or the fund is shut down. The draft's bound of 54 hours and its
   invariant for it are gone.
2. **NAV.** The draft priced the match at the NAV at the outside feeds.
   The owner: this proposal does not change the NAV method. The TWAP is the
   price. The outside feeds are guards against the price moving too much.
   So the match price is the NAV of §4.2 at the TWAP, and a held TWAP can
   move it by up to `refBandBps` before the guard stops the settlement.

### 18.5 What this does to earlier findings and results

| Earlier item | Effect |
| --- | --- |
| §17.3, the match removed | Reversed by D16, with the answers in §5.11.1. |
| D14, "no price moves value between users" | Amended: no price moves value to or from holders. One price moves value between matched users (§5.11.2). |
| D15, safety before simplicity | Kept. The match returns because it lowers what the pool attacks can take. Every check stays. |
| RB-14, limits | Replaced by RB-23 and RB-24. |
| RB-6, RB-10, RB-12, RB-15, the "always open" exits | Amended (§7). |
| G8 fail of 2026-11-12 (A10, A2 inside the bands) | Expected to shrink by the matched share of the volume. Not measured. A20 is a rebalance step and is not affected. |
| G9 pass of 2026-11-12 | Must be scored again. The cutoff and the missing in-kind exit change what a customer waits for. |
| Deploy 4 | Not affected. It rehearses the deploy tools on the step 3d and 3e code. |

### 18.6 Still open

- **The caller's choice of block.** Closed by D20: only the keeper settles.
- **Whether matched volume needs a cap of its own.** Closed by D22: it
  counts against the flow caps.
- **The depth floor's value** (`minPoolDepthUsdc`). The sim sets it.
- **Who starts a wind-down, and how fast.** Answered by D24: the Safe,
  through the timelock. Whether a wind-down should skip the timelock's
  delay is not decided. The working default keeps the delay, because the
  architecture has the Safe act only through the timelock.
- **The freeze return.** Removed by D24.
- **The gateway.** An agent's request no longer carries a price limit. Its
  depositor's policy loses that field again (PRD amendment 4).
- **PAXG** is still not assessed against §4.5.

### 18.7 Unverified

- No test and no sim run backs any claim in §5.11 or in this section.
- The claim that a matched user's worst case is no worse than a trading
  user's rests on `refBandBps` against `legBandBps` plus the pool fee. It
  is not measured.
- The code was read to confirm that step 3d settles both sides in one
  `settle` call with no match (`FlowSettleLib`). Nothing else was checked
  against the code.

## 19. Adversarial review of step 3f, and the fixes

Status: review record, 2026-11-13. Three independent reviewers read §5.11
and the rest of this document the day it was written. None of them wrote
it. A fourth, on the prototype's code, was stopped: step 3f is not built,
and the prototype is not the design. Nothing here is tested.

### 19.1 The owner's two rules for reading the review

1. **The keeper is not an actor.** It is a team-operated account,
   preferably a multisig, that keeps the state machine moving. Findings
   that model the keeper as an attacker are set aside. `settle` and `step`
   are keeper-only for now (D20).
2. **The design is not implemented.** Findings that rest only on the
   prototype's code are set aside. Findings about the design stand, also
   where a reviewer found them by reading code.

### 19.2 Findings and what became of each

Severity is the reviewer's.

| Finding | Severity | Resolution |
| --- | --- | --- |
| A match lets a redeemer leave a fully borrowed or impaired lending venue at face value. The matched depositors, who cannot cancel, carry the loss. | High | Fixed in design: D21, RB-28. A loss that is neither marked nor visible in liquidity stays a residual. |
| A fund that normal stress can stop (a USDC depeg, a market faster than the TWAP) has no exit except a wind-down that a role must start. | Critical | Accepted by the owner (D24, 2026-11-14): a multisig winds the fund down. The reviewer's fix, a trigger anyone can call after `maxRoll` blocked epochs, is not adopted. The role is the Safe, not the hot key. What shortens a stuck period is in the other rows: a pause that ends by itself, position claims for a venue that cannot pay, and cancel for a locked deposit while deposits are stopped. |
| Matched volume used no cap. Holding a TWAP inside the band is a fixed cost and its gain grows with matched size. | High | Fixed in design: D22, RB-29. |
| A delisted asset cannot be sold by a step, because a step needs the checks a failing asset fails. It would stay and block settlement. | High | Fixed in design: §4.5 rule 5, a sale path of its own. The bound and the budget are open. |
| Steps and settlements had no ordering. The fund's own steps push pools up to 97 bps from the feed against a band of 90. | High | Fixed in design: RB-30. The cost is a slower plan. |
| One lending venue that cannot pay stops every net redemption. | High | Fixed in design: D23. |
| A pause was a total lock for at least the timelock's delay, and a compromised key could repeat it. | High | Fixed in design: D24, RB-32. |
| A run takes about 11 days under the caps, and expiry sent waiting redeemers to the back. | High | Partly. D25 keeps their place. The length of a run is the cap's purpose and stays. |
| The wind-down was a flag the hot key set and the Safe could reverse while holders left. It did not stop the rebalancer or release queue escrow. | Medium | Fixed in design: D24. It is a state that only the Safe starts and ends, through the timelock. |
| The in-kind return after a freeze contradicted D18. | Medium | Fixed: removed. |
| The timelock could change the fee, the hold and the expiry of locked requests. | Medium | Fixed in design: D26, RB-31. |
| The caller of `settle` chose the block and the batch size, so each chunk of one window could get its own price. | High, Medium | Closed by D20, and by fixing the price and totals at a window's first call (RB-20). |
| A depositor can ask for far more than they want, to take most of a scarce match. The surplus expires at no cost. | Medium | Open. The flow cap bounds the match. Allocation by age instead of by size is the stated option. |
| A public plan tells users which way the fund will push its pools. A holder can also redeem before a costly plan and return after it. | Medium | Open. A31 measures the first. The second is an accepted cost of shared rebalancing (D1) with no test yet. |
| A lending rate that jumps blocks settlement for days. | Low | Open. Excluding that venue from the settlement is the stated option. |

### 19.3 What the reviewers could not break

- A match changes neither the fund's assets nor its supply. Holders are
  untouched.
- A one-block push of a pool does not move the median of the slices.
- A self-match pays the exit fee, gains nothing and does not shorten the
  hold.
- Nobody but the settler gets a look at the price after the cutoff, and
  the settler is now the keeper.
- The TVL cap holds through a match, because a match adds no NAV.
- A request opened in another owner's name only gives that owner value.

### 19.4 Two points about the experiment, left to the owner

The reviewers raised two points that are judgments, not defects. They are
recorded here and not acted on.

1. **No gate result describes step 3f.** Every result in §14 was measured
   on the step 3d and 3e design. One reviewer reads step 3f as a redesign
   after a failed gate (G8), and reads the amended gates of §13 as moved
   after results. §13 fixes the step 3f rules before any step 3f result.
   Whether the conclusion (§10, step 5) is written on the built design
   first is the owner's call.
2. **The mix.** At the PRD's launch weights about 95% of the fund is
   lending. One reviewer argues that the queue, the hold and the match
   protect the pricing of the other 5% and take instant exit from the 95%.
   The alternative it names is an instant lending vault beside a small
   timed basket. That is the fallback D2 already lists and §13 says must
   be tested before the conclusion.

### 19.5 Unverified

- No test and no sim backs any fix in this section.
- The reviewers' sizes (a 3% loss to matched depositors, an 11-day run, a
  20 bps lean from a held TWAP) are their arithmetic from §5.9.5, not
  measurements.
- Whether a lending venue's available liquidity can be read reliably
  inside `settle`, for each of the three venues, is not checked.
