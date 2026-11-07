# Proposal: one vault and a receipt-driven rebalancer

- **Status:** Proposed. Not accepted. Nothing here changes code or the
  canonical docs until the product owner accepts it.
- **Date:** 2026-11-07
- **Author:** lucky-tensor (drafted with Claude)
- **Decider:** Product owner
- **Would supersede, if accepted:** the Portfolio Router (`docs/architecture.md`
  §4.2), router-weight governance (§2.3), and the rejection in
  [ADR-0010](../adr/ADR-0010-unified-vault-architecture.md). It would amend
  [ADR-0003 (rebalancing)](../adr/ADR-0003-basketvault-rebalancing-model.md)
  and [ADR-0017](../adr/ADR-0017-rmagent-retired-router-uses-three-vaults.md).
- **Keeps unchanged:** the consensus receipt contract (§4.9), the receipt
  payload schema, the Safe and timelock as the only governance body, the
  lending adapters, the swap adapters, ADR-0009 retirement (no assisted
  migration), ADR-0014 governed UUPS proxies, and the custody invariants
  INV-1 to INV-4.

## 1. Summary

Today the vaults system has three vaults (rmUSDC, rmPROTO, rmRWA) and a
Portfolio Router that splits each deposit across them by governed weights.
A consensus receipt changes those weights. Changing weights only changes
where **new** deposits go. Money already in a vault never moves.

This proposal replaces that with:

1. **One vault.** A single ERC-4626 USDC vault with one share token. Inside
   it, holdings are grouped into **sleeves**. One sleeve per receipt bucket:
   stable yield (lending adapters), protocol tokens (wETH, cbBTC) and real
   world assets (deSPXA). The agent-token sleeve stays empty, as ADR-0017
   already requires.
2. **No router.** The vault itself holds the target weights. A deposit into
   the vault is already a portfolio deposit.
3. **A rebalancer.** When the Safe applies a consensus receipt, the vault
   gets a new target and a **rebalance plan**. The plan moves the existing
   holdings toward the target in small, bounded steps over days. Each step is
   priced against a TWAP, capped in size and cost, and spaced so the next step
   sees a settled price. This avoids large single trades, slippage and
   sandwich attacks.

The receipt flow is the same as today up to the point of application:
analysts sign off-chain, a submitter records the digest, the Safe applies the
receipt through the timelock. The only difference is what "apply" does. Today
it sets router weights. Under this proposal it sets the vault's target and
opens a rebalance plan.

## 2. Why change

| Problem today | Effect | How this proposal answers it |
| --- | --- | --- |
| A receipt only steers new deposits. | Existing money never follows the committee. With low inflow, a receipt changes almost nothing. | The rebalancer moves existing holdings to the new target. |
| A "portfolio position" is a reporting concept assembled from three receipt tokens (§2.2). | The dapp, rmpc, explorer and watchdog must stitch three vaults together. Users hold three tokens and can drift from the target forever. | One share token. One NAV. Every holder has the same composition. |
| Router legs fail independently (`LegSkippedWithFloor`, renormalisation, per-leg caps, §4.2.1). | Complex previews. A user can land with a different split than the receipt says. | One deposit path. Composition is set by the vault, not per deposit. |
| Three vault kinds, a registry, a router, a router-governance contract. | Seven `ADMIN_ROLE` contracts. Each release has to deploy, verify and govern all of them. | Fewer contracts (see §6). |
| No mechanism moves capital between exposures. | ADR-0003 left `rebalance()` as a `NotImplemented()` stub. | The stub becomes a real, bounded process. |

## 3. Relationship to the rejected unified vault (ADR-0010)

ADR-0010 also proposed one vault class. The owner rejected it on 2026-09-18.
This proposal must be judged against the reasons for that rejection.

| ADR-0010 rejection reason | Does it still hold here? |
| --- | --- |
| The deployed families are audited, and migrating them is not worth the reversibility cost. | **Partly.** This proposal also needs a new audit and a fresh deployment. What is new is the benefit: ADR-0010 kept the router and had no way to move existing capital, so it bought little product change for its cost. This proposal removes the router and makes receipts move money, which is a product change the current design cannot deliver. |
| A fifth contract kind breaks the one-deployment-scheme rule. | **No.** ADR-0010 added a fifth kind next to the four existing ones. This proposal **replaces** them. A new deployment has one vault kind, not five. |
| `forceRebalance`-only, caller-funded rebalancing. No keeper, no socialized cost. | **Deliberately reversed.** ADR-0010 and ADR-0003 both refused socialized rebalance cost. A receipt-driven rebalance has a real cost that all holders share. This proposal bounds that cost and discloses it (§5.7). The owner must accept that cost explicitly (§11, decision D1). |

Because of the standing rejection, this document is a proposal, not an ADR.
If accepted, it becomes a new ADR that supersedes ADR-0010's rejection, and
the canonical docs are rewritten in the same change.

## 4. Target architecture

```text
Analysts (off-chain, Ed25519)
   |
Submitter (RECEIPT_SUBMITTER_ROLE)
   -> ConsensusRecommendationReceipt.recordReceipt        (unchanged)

Safe -> TimelockController
   -> RebalanceGovernance.applyReceipt(receiptId, digest, sleeves, bps)
        -> receipt.releaseReceipt(receiptId)                (unchanged role)
        -> vault.setTargetAndOpenPlan(bps, planParams)

Keeper (KEEPER_ROLE, or anyone after the grace period)
   -> Rebalancer.step()
        -> vault.executeStep(sell leg, buy leg)  (sizes and floors computed on chain)

Human wallet / rmpc gateway
   -> vault.deposit / vault.redeem / vault.redeemInKind

RobotMoneyFund vault (one ERC-4626, one share token)
   |-- stable sleeve      -> MorphoAdapter, AaveV3Adapter, CompoundV3Adapter
   |-- protocol sleeve    -> wETH, cbBTC via UniswapV3SwapAdapter / AerodromeSwapAdapter
   |-- rwa sleeve         -> deSPXA via UniswapV3SwapAdapter
   |-- agent sleeve       -> empty, weight pinned to 0 (ADR-0017)
   `-- idle USDC
```

The working name for the vault is `RobotMoneyFund` and its share `rmFUND`.
The name is open (§11, D6).

### 4.1 Sleeves

A sleeve is a named group of positions inside the one vault. It is
configuration, not a contract.

- Each sleeve maps to exactly one receipt bucket.
  `tests/fixtures/consensus-receipt.bucket-vault-map.json` becomes a
  bucket-to-sleeve map. The receipt schema does not change.
- A sleeve has a **target weight** in bps of vault NAV. The four weights sum
  to 10,000.
- Inside a sleeve, positions split by a governed **intra-sleeve weight**.
  The default is the current behaviour: equal weight across active basket
  assets (ADR-0003), and the existing per-adapter `capBps` allocator across
  lending adapters.
- The asset-level target is `sleeveBps × intraBps / 10,000`. The rebalancer
  works at asset level. The receipt and the dapp work at sleeve level.

### 4.2 NAV

```text
totalAssets = idle USDC
            + Σ lending adapter.totalAssets()          (exact, 1:1)
            + Σ basket token balance × TWAP price       (BasketVault model)
```

This is the union of the two NAV models that already exist. Basket assets
keep their TWAP valuation, the ORA-4 spot-versus-TWAP deviation guard, and the
emergency unwind guards. Lending adapters keep ADP-2 exclusion and the
`ExclusionLedger`.

### 4.3 Deposits

A deposit mints on the **realized NAV delta**, the basket model (AZ-BSK-1/-3).
For an all-lending deposit the realized delta equals the deposit, so nothing
changes for that case.

**Where the deposit goes: deficit-first.** The deposit fills the sleeves that
are furthest below the *current plan target* first, then splits the rest by
target weight. This is free rebalancing: every dollar that arrives in an
underweight sleeve is a dollar the rebalancer does not have to trade. ADR-0003
chose deposit-driven correction for exactly this reason. Here it is a cost
saver, not the only mechanism.

The depositor pays their own swap slippage, because shares mint on the
realized delta. The existing `DepositBelowSlippageFloor` guard stays.

### 4.4 Redemptions

Redemption stays **synchronous** (§4.4 of the architecture is a product
promise) and **pro rata**:

- `redeem` withdraws each lending adapter and sells each basket token in
  proportion to the redeemer's share. It returns realized proceeds minus the
  exit fee. This is `BasketVault._sellProportional` plus
  `RobotMoneyVault._pullProportional`, unchanged in spirit.
- `withdraw` and `previewWithdraw` revert `RedeemOnly`, as on the basket vaults
  today. The vault holds inexact positions, so an exact-assets withdrawal is
  not offered.
- `redeemInKind` stays. It pays USDC for the lending and idle part and hands
  over basket tokens for the basket part. It needs no oracle and no swap
  venue, so it is the exit of last resort.
- Pro rata keeps composition unchanged. Redemptions never fight the plan and
  never shift cost onto the holders who stay.

Rebalancing state never blocks a redemption. A paused or failed plan has no
effect on `redeem` or `redeemInKind`.

## 5. The rebalancer

This is the core of the proposal.

### 5.1 From receipt to plan

1. The submitter records the receipt (unchanged, §4.9 of the architecture).
2. The Safe schedules `RebalanceGovernance.applyReceipt(receiptId, digest,
   sleeves, bps)` on the timelock. This is today's `RouterGovernance.applyReceipt`
   with the router call swapped for a vault call. Its checks stay: the receipt
   must be recorded, not released, match the digest, and be newer than the
   last applied receipt (`lastAppliedRecordedAt`). The agent bucket must be 0.
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
   lending sleeve and idle USDC are "USDC", and every basket pool is a USDC
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

- `toleranceBps` (for example 50 bps per sleeve) stops the plan chasing
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
| `toleranceBps` | global | 50 bps per sleeve | When a plan counts as converged |
| `keeperGrace` | global | 6 hours | When `step()` opens to anyone |
| `maxOverrun` | global | 7 days | When an unconverged plan expires |

The same rule that already binds `NAV_DEVIATION_BPS` applies: a slippage or
deviation bound at or below the pool fee would make every step fail, so the
deploy script refuses it.

### 5.7 Who pays, and how it is disclosed

Rebalance cost is shared by every holder at the time of each step. That is the
nature of a managed fund. It is the deliberate change from ADR-0003 and
ADR-0010 (§3). It is bounded and visible:

- **Bounded** per step (`maxStepCostBps`) and per plan (`costBudgetBps`).
  A halted plan needs a fresh Safe decision to spend more.
- **Previewed** before the Safe applies: `previewPlan(bps)` returns the
  turnover per asset and the estimated cost at current TWAP. The govern row
  shows it before scheduling, and the dapp shows it next to the receipt.
- **Recorded** per step in events. The indexer sums realized cost per plan.
  The dapp shows each plan's progress, turnover, and cost spent.
- **Reduced** by deficit-first deposits (§4.3). Inflow during a plan does
  part of the work for free.

### 5.8 Adverse actions and the defence for each

| Threat | Defence |
| --- | --- |
| Slippage on a large trade | The glide path plus `maxStepUsdc` keep each trade small against pool depth. |
| Sandwich of a step | `minOut` is set from the TWAP, not spot, so a pushed spot price makes the swap revert. The ORA-4 check skips steps while spot is off TWAP. Base's sequencer has no public mempool, which helps, but the design does not rely on it. |
| Manipulating the TWAP itself | `stepInterval` ≥ TWAP window, so an attacker must hold a distorted price for a full window, against arbitrage, to move one bounded step. The existing pool-cardinality and minimum-liquidity requirements still apply. |
| Front-running a public receipt | The target is public at least for the timelock delay (48 hours on 8453). Traders can position ahead of the vault's buying. The defence is that the vault buys slowly, in small steps, through deep pools. This risk is accepted, not removed. Thin assets (deSPXA) should have small `maxStepUsdc` and long plans. |
| Keeper abuse | The keeper chooses only timing. Sizes, floors, assets, and recipients come from chain state. The worst a keeper can do is time steps badly within the floors, or stop calling. Stopping is covered by the grace period. |
| Deposit or redeem timed around a step | NAV is TWAP-valued and does not depend on composition, so moving value between assets does not change share price except by the realized step cost, which is bounded. |
| A venue freezes (deSPXA issuer freeze, lending pause) | The step reverts or skips. The plan stalls on that asset only. Other assets keep converging. `redeemInKind` remains open. |
| Runaway cost from a bug | Per-step revert on `maxStepCostBps`. Plan halt on the budget. `EMERGENCY_ROLE` pause. |

## 6. Contract changes

| Contract | Today | Proposed |
| --- | --- | --- |
| `RobotMoneyVault` (rmUSDC) | Lending vault | Retired (withdraw-only, ADR-0009). Its allocator, ADP-2 exclusion and `ExclusionLedger` move into the fund's stable sleeve. |
| `BasketVault`, `ProtocolAssetVault`, `RwaBasketVault` | Basket vaults | Retired (withdraw-only). TWAP valuation, ORA-4, slippage floors, `redeemInKind`, and emergency unwind move into the fund's basket sleeves. |
| `AgentTokenVault` | Parked | Stays parked. The agent sleeve is empty. |
| `PortfolioRouter` | Splits deposits | **Deleted** for new deployments. The live router is retired: default weights cleared and deposits stopped. |
| `RouterGovernance` | `applyReceipt` sets router weights | Renamed `RebalanceGovernance`. `applyReceipt` sets the vault target and opens a plan. `setDefaultWeights` becomes `setTarget` (a plan with no receipt, for bootstrap and drift correction). |
| `VaultRegistry` | Status and router eligibility | Not needed by a one-vault deployment. The fund holds its own lifecycle status. The live registry stays to run v1 retirement. Open (§11, D4). |
| `ConsensusRecommendationReceipt` | Signalling register | **Unchanged.** The release role moves from `RouterGovernance` to `RebalanceGovernance`. |
| `RobotMoneyFund` | — | **New.** One ERC-4626 vault with sleeves, target weights, plan state, and `executeStep` callable only by the `Rebalancer`. |
| `Rebalancer` | — | **New.** Holds no funds. Computes and validates steps, then calls the fund. Separate contract to keep the fund under EIP-170. |
| Lending and swap adapters | Used by their vaults | **Unchanged.** Their owning vault becomes the fund. |
| `RobotMoneyGateway` (separate system) | Allows deposits into three vaults | Its allowed-destination list becomes the fund. Done in the gateway's own release. The fund does not name the gateway (§1 dependency rule holds). |

### 6.1 Size and gas

The fund is the union of `RobotMoneyVault` and `BasketVault`, and
`BasketVault` is already EIP-170 tight. This is ADR-0010's M-A2 risk and it
does not go away. The plan:

- Keep the fund's own code to ERC-4626 accounting, deposit, redeem, lifecycle,
  and `executeStep`.
- Put step selection, path math and cost accounting in the `Rebalancer`.
- Reuse the linked libraries that exist (`BasketViews`,
  `BasketAssetConfigGuard`, `TwapTickMath`) and add one for the lending
  allocator.
- Prove the fit with a spike before any other work (§10, phase 0).

A redemption touches every position: three lending adapters, two protocol
tokens, one RWA token. That is more external calls than any single vault
today. Gas must be measured in the spike against the redeem gas budget
(`docs/technical/redeem-gas-1482.md`).

## 7. New invariants

These join §8 of the architecture if the proposal is accepted.

- **RB-1.** Only a timelock-executed `RebalanceGovernance` call can set a
  target or open a plan.
- **RB-2.** `Rebalancer.step()` takes no amounts, assets, floors, or recipients
  as input. Every value comes from chain state.
- **RB-3.** A step never moves assets out of the fund except into an
  allowlisted adapter or swap venue, and every swap's recipient is the fund
  (INV-1 holds).
- **RB-4.** A step never lets the TWAP NAV fall by more than
  `maxStepCostBps` of its notional, and a plan never spends more than its
  budget without a new Safe decision.
- **RB-5.** No step runs while any traded asset fails the ORA-4 check, or
  before `stepInterval` has passed.
- **RB-6.** Rebalancing state never blocks `redeem` or `redeemInKind`.
- **RB-7.** The rebalancer never moves the vault past `pathTarget(now)`.
- **RB-8.** The receipt contract stays signalling-only (INV-4). It never calls
  the fund, the rebalancer, or governance.

## 8. Off-chain changes

- **Receipt "applied" state** (architecture §4.9.3) compares the receipt with
  the fund's target instead of the router vector. A new third state,
  **converged**, comes from the plan status. The dapp shows recorded → applied
  → converging (with progress) → converged.
- **Bucket map fixture** maps buckets to sleeves. The cross-repo receipt
  schema is unchanged, so `robotmoney-frontend` needs no schema change. Its
  display of "which vault" changes to "which sleeve".
- **Dapp.** One deposit flow, one position, one NAV. The portfolio composite
  view (§2.2) becomes the fund's sleeve breakdown. A plan panel shows target,
  current, path, steps, and cost.
- **rmpc.** Deposit preview and preflight point at one vault. Read commands
  gain `plan` and `sleeves`.
- **Explorer and indexer.** New tables for plans and steps. Router tables go
  read-only for history.
- **Watchdog.** Watches step cost against caps, plan halts, and keeper
  liveness.
- **publish-contracts.** New stages for the fund and rebalancer. The router,
  registry-eligibility and three-vault stages go. The `apply-receipt` govern
  row targets `RebalanceGovernance` and prints `previewPlan` first. New rows:
  `pause-rebalance`, `resume-plan`, `extend-plan-budget`, `close-plan`,
  `set-step-params`.
- **Keeper.** A new small service. It needs a key with `KEEPER_ROLE` only,
  a runbook, and monitoring.

## 9. Migration

ADR-0009 holds: there is no on-chain migration of holder funds.

1. Deploy the fund, the rebalancer and `RebalanceGovernance` as a fresh set of
   proxies (ADR-0014). Grant roles. Hand `ADMIN_ROLE` to the timelock.
2. Set the opening target with `setTarget`. With no assets yet, the first
   deposits do the allocation through deficit-first routing, so no
   rebalancing trades happen at launch.
3. Grant the release role on the receipt contract to `RebalanceGovernance`
   and revoke it from `RouterGovernance`.
4. Retire the router: clear its default weights and stop router deposits.
5. Retire rmUSDC, rmPROTO and rmRWA through the registry (withdraw-only).
   Holders redeem from the old vaults and deposit into the fund themselves.
   The dapp guides them through it in one flow.
6. The retired vaults keep their obligations: maintained TWAP pools and the
   V3 price sources they read, as ADR-0010 §8 and ADR-0009 already note.

Each step is a governed, reviewable action with its own govern row and
evidence, like today's releases. The order matters: the release role must
move before the old governance contract could apply another receipt to a
router that no longer matters.

## 10. Phases

0. **Spike.** Prove the fund fits EIP-170 with the rebalancer split out. Measure
   deposit, redeem and step gas on the Twin. Stop here if it does not fit.
1. **ADR.** Owner accepts a new ADR that supersedes ADR-0010's rejection and
   amends ADR-0003 and ADR-0017. Rewrite the architecture §4 and the PRD
   vault catalog in the same change.
2. **Contracts.** Fund, rebalancer, governance. Unit, invariant and fork tests,
   including adversarial tests for every row of §5.8.
3. **Clients.** publish-contracts stages and rows, dapp, rmpc, indexer,
   watchdog, keeper.
4. **Audit.** External audit of the fund, the rebalancer and governance.
5. **Rehearsal.** Full deploy and one full receipt-to-converged plan on the
   Twin, then on the 8453 rehearsal deployment.
6. **Mainnet.** Deploy, then retire the old set (§9).

## 11. Decisions for the owner

| ID | Decision | Recommendation |
| --- | --- | --- |
| D1 | Accept that rebalance cost is shared by all holders, within caps. | Accept. Without it a receipt cannot move existing money, which is the point of the change. |
| D2 | Users lose the choice of a single exposure (for example rmUSDC only). The PRD user story "choose a vault or the Portfolio Router" goes away. | Accept, if the product is "follow the committee". Otherwise keep rmUSDC as a separate stable-only vault next to the fund. |
| D3 | Who triggers steps: keeper only, keeper then anyone, or anyone. | Keeper first, anyone after `keeperGrace`. |
| D4 | Keep `VaultRegistry` for new deployments. | Drop it for the fund. Keep the live one for v1 retirement. |
| D5 | Should the rebalancer also correct market drift between receipts? | No. Only an applied receipt or a Safe `setTarget` opens a plan. Drift between receipts is the committee's call. |
| D6 | Name of the vault and share. | `RobotMoneyFund` / `rmFUND` as a working name. |
| D7 | Deposit routing: deficit-first or target-weight split. | Deficit-first. It lowers rebalance cost. |

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
  solver set or an auction contract and a new trust boundary. It is a good
  follow-up once the glide path is live. The step interface (`executeStep`)
  leaves room to add an auction executor later.
- **`forceRebalance` only (ADR-0010's model).** No shared cost, but nobody is
  obliged to pay for rebalancing, so in practice a receipt still moves
  nothing. Rejected for the same reason as the status quo.
