# 03 — Reentrancy, Flow State Machines, and Accounting Verification

- **Base:** `dev` (`6c25fd8ce291a88ed088f71e0e015296a561ea24`), merged from `release-0.9.0` (`86747f24534a39cf19a75d4370d3f91466dcc24f`, tag `contracts-0.9.0`) via PR `#2019` (`contracts/` tree is byte-identical across both commits)
- **Worktree Reviewed:** `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/adhoc-20261122-233507-safety-review-090`
- **Scope:** Findings **AGY-10**, **AGY-11**, **AGY-12**, and **AGY-14**

---

## Summary of Findings

| ID | Severity | Title | Primary Locations |
| --- | --- | --- | --- |
| **AGY-10** | **Low** | Monotonic `maxDepositMinHold` high-water mark inflates match-only `holdEndsAt` after `minHold` reductions, allowing 0-claim `freezeSettlement` to burn the 7-day freeze cooldown | [FlowClaimLib.sol](../../../contracts/lib/FlowClaimLib.sol#L315-L333), [FlowClaimLib.sol](../../../contracts/lib/FlowClaimLib.sol#L544-L547), [FlowMatchLib.sol](../../../contracts/lib/FlowMatchLib.sol#L342) |
| **AGY-11** | **Low** | Post-upgrade `delistAsset` before the first `v0.9.0` settlement trips Check 6 (`SettleCheck.SharePrice`) because `lastAssetPerShare[i] == 0` while `lastSharePrice != 0` | [FlowCheckLib.sol](../../../contracts/lib/FlowCheckLib.sol#L188-L227), [v0.9.0-in-place-upgrade-audit.md](../../technical/v0.9.0-in-place-upgrade-audit.md) |
| **AGY-12** | **Low** | `FlowMatchLib.hasPendingForRound` / `hasUnfilledInPool` return false positives on empty unpruned `activeDepBuckets`, triggering spurious `StepInWindow` reverts and wasted `settle()` calls | [FlowMatchLib.sol](../../../contracts/lib/FlowMatchLib.sol#L89-L135), [FlowMatchLib.sol](../../../contracts/lib/FlowMatchLib.sol#L712-L744) |
| **AGY-14** | **Info** | Exhaustive reentrancy (`nonReentrant`), CEI, cross-contract flow, approval hygiene, ray-index conservation, and Check 10 verification matrix | [RobotMoneyFund.sol](../../../contracts/RobotMoneyFund.sol), [FlowQueue.sol](../../../contracts/FlowQueue.sol), [FundValuationLib.sol](../../../contracts/lib/FundValuationLib.sol#L157-L179) |

---

## AGY-10 [LOW]: Monotonic `maxDepositMinHold` Inflates `holdEndsAt` and Lets No-Op `freezeSettlement` Burn the Global Freeze Cooldown

### Location
- [FlowClaimLib.sol#L544-L547](../../../contracts/lib/FlowClaimLib.sol#L544-L547) (`_newRequest`)
- [FlowMatchLib.sol#L342,L521](../../../contracts/lib/FlowMatchLib.sol#L342) (`bookMatch`, `syncOwnerDeposits`)
- [FlowSettleLib.sol#L165-L167,L702-L706](../../../contracts/lib/FlowSettleLib.sol#L165-L167) (`_finishSettle`, `depositSide`)
- [FlowClaimLib.sol#L315-L333,L386-L395](../../../contracts/lib/FlowClaimLib.sol#L315-L333) (`freeze`, `_deliverable`)

### Description
`FlowState.maxDepositMinHold` is tracked solely as a monotonic lifetime maximum across all deposit requests ever created:

```solidity
// contracts/lib/FlowClaimLib.sol:544-547
        r.minHold = p.minHold;
        if (kind == RequestKind.Deposit && p.minHold > s.maxDepositMinHold) {
            s.maxDepositMinHold = p.minHold;
        }
```

When `FlowMatchLib.bookMatch` settles a whole match O(1), it sets `st.holdEndsAt` using `s.maxDepositMinHold` ([FlowMatchLib.sol#L342](../../../contracts/lib/FlowMatchLib.sol#L342)), whereas each individual claim later unlocked by `syncOwnerDeposits` (or `_recordDeposit`) receives `unlockAt = rec.matchTime + r.minHold` ([FlowMatchLib.sol#L521](../../../contracts/lib/FlowMatchLib.sol#L521)):

```solidity
// contracts/lib/FlowClaimLib.sol:318-332 (freeze)
        if (s.lastFreezeAt != 0 && block.timestamp < uint256(s.lastFreezeAt) + s.params.maxFreeze) {
            revert IFlowEvents.FreezeOnCooldown(uint64(
                    uint256(s.lastFreezeAt) + s.params.maxFreeze
                ));
        }
        if ((st.matchedShares + st.sharesMinted) == 0 || block.timestamp >= st.holdEndsAt) {
            revert IFlowEvents.FreezeOutsideHold(id);
        }
        if (st.frozenUntil > block.timestamp) revert IFlowEvents.SettlementAlreadyFrozen(id);

        uint64 until = uint64(block.timestamp) + s.params.maxFreeze;
        st.frozenUntil = until;
        st.freezeSetAt = uint64(block.timestamp);
        s.lastFreezeAt = uint64(block.timestamp);

// contracts/lib/FlowClaimLib.sol:391-395 (_deliverable)
        if (isShutdown) return true;
        if (block.timestamp < c.unlockAt) return false;
        Settlement storage st = s.settlements[c.settlementId];
        return !(st.frozenUntil > block.timestamp && c.unlockAt > st.freezeSetAt);
```

Because `s.maxDepositMinHold` is never lowered when `FlowParams.minHold` is decreased (for example, changing `minHold` from `24 hours` to `1 hour` as in Deploy 4 decision `D4-11`, or raising and subsequently lowering `minHold` later), any later match-only settlement sets `st.holdEndsAt = t + 24h` while every matched deposit claim in that settlement has `c.unlockAt = t + 1h`. Between `t + 1h` and `t + 24h`, **zero claims remain locked**, yet calling `freezeSettlement(id)`:
1. Passes `block.timestamp < st.holdEndsAt`,
2. Leaves every claim deliverable (`c.unlockAt <= st.freezeSetAt`, failing `c.unlockAt > st.freezeSetAt`), and
3. Sets `s.lastFreezeAt = block.timestamp`, wasting the **protocol-wide `maxFreeze` cooldown** (default 7 days, max 14 days) and blocking emergency freezes on any genuine subsequent settlement during that window.

### Impact
After any reduction in `FlowParams.minHold`, `freezeSettlement` on match-only settlements can succeed as a no-op once claims unlock (`c.unlockAt <= now < st.holdEndsAt`), inadvertently activating the global 7–14 day `FreezeOnCooldown` lock without freezing any shares.

### Remediation
Compute `st.holdEndsAt` from the actual active deposit cohort maximum rather than a lifetime high-water mark—for instance, track a per-epoch/per-bucket `maxMinHold` across `activeDepBuckets` so `bookMatch` computes `uint32 effectiveHold = max(b.maxMinHold over activeDepBuckets)` in $O(\text{activeDepBuckets.length})$ (bounded by `maxRoll + 1`). Alternatively, decrement active hold buckets once old higher-`minHold` requests expire or close.

---

## AGY-11 [LOW]: Post-Upgrade `delistAsset` Before First `v0.9.0` Settlement Trips Check 6 (`SettleCheck.SharePrice`)

### Location
- [FlowCheckLib.sol#L128-L131,L188-L227](../../../contracts/lib/FlowCheckLib.sol#L188-L227) (`_sharePriceBreakerOk`, `_breakerValues`)
- [FlowSettleLib.sol#L483-L505](../../../contracts/lib/FlowSettleLib.sol#L483-L505) (`_recordReferences`)
- [ADR-0020#L58](../../adr/ADR-0020-in-place-upgrades-run-a-one-time-migration.md#L58) & [v0.9.0-in-place-upgrade-audit.md](../../technical/v0.9.0-in-place-upgrade-audit.md) (Hazard #12)

### Description
`FlowCheckLib._breakerValues` normalizes both the current share price (`curPx`) and the prior settlement reference (`ref = s.lastSharePrice`) by subtracting `inSale` basket asset weights so delisting an asset does not trigger the share-price circuit breaker (`E53`):

```solidity
// contracts/lib/FlowCheckLib.sol:212-226
        // Exclude `inSale` assets from Check 6 (E53) on both sides
        for (uint256 i; i < len && i < 256; ++i) {
            uint256 bit = 1 << i;
            if ((m.saleMask & bit) == 0) continue;
            if (m.prices[i].kind == PRICE_KIND_BASKET && m.prices[i].unit != 0) {
                uint256 curValPerShare = m.held[i]
                    .mulDiv(m.prices[i].feedPerToken, m.prices[i].unit)
                    .mulDiv(PRICE_SCALE, m.supply);
                curPx = curPx > curValPerShare ? curPx - curValPerShare : 0;
            }
            if ((s.lastSaleMask & bit) == 0) {
                uint256 lastVal = s.lastAssetPerShare[i];
                ref = ref > lastVal ? ref - lastVal : 0;
            }
        }
```

When an existing `v0.8.0` vault (such as Deploy 4) is upgraded in place via `FlowQueue.migrateV090`:
- `s.lastSharePrice` is non-zero (carried over from `v0.8.0` storage slot 25).
- `s.lastSaleMask` (slot 58) and `s.lastAssetPerShare[i]` (slot 59) are `0` until the first `v0.9.0` settlement executes `_recordReferences` ([FlowSettleLib.sol#L483-L505](../../../contracts/lib/FlowSettleLib.sol#L483-L505)).

If `RobotMoneyFund.delistAsset(i)` is called after upgrade **before** at least one **non-empty** `v0.9.0` settlement (`redOk || depOk || matchSettlementId != 0`) completes, `curPx` has `curValPerShare` subtracted while `ref` subtracts `s.lastAssetPerShare[i] == 0`. Crucially, an empty settlement returns `0` early at `FlowSettleLib.sol:158` (`if (!redOk && !depOk && matchSettlementId == 0) return 0;`) *before* `_recordReferences(s, c)` (`FlowSettleLib.sol:171`) writes `s.lastSaleMask` and `s.lastAssetPerShare`. Whenever asset `i`'s portfolio share weight exceeds `maxSharePriceMoveBps * epochsPassed`, Check 6 fails with `SettleCheck.SharePrice` and blocks all queue settlements. As explicitly noted in `v0.9.0-in-place-upgrade-audit.md` ("Unknowns: Hazard 12 is still unexecuted") and `ADR-0020` line 58, this hazard has no on-chain guard and currently relies solely on an operational rule ("settle once first"—which must specifically be a non-empty settlement).

### Impact
Calling `delistAsset(i)` on an upgraded `v0.8.0 -> v0.9.0` fund prior to the first non-empty `v0.9.0` settlement (`redOk || depOk || matchSettlementId != 0`) causes `FlowQueue.settle()` to fail Check 6 (`SettleCheck.SharePrice`), stalling redemptions and deposits until `i` finishes delisting or `maxSharePriceMoveBps` / emergency wind-down overrides occur.

### Remediation
Backfill `s.lastAssetPerShare[i]` inside `FlowQueue.migrateV090` (or compute fallback subtraction for uninitialized `s.lastAssetPerShare[i] == 0` when `s.lastSaleMask == 0 && s.lastSettleAt < upgradeTimestamp` / seed at migration from `fund.assetValue(i) * PRICE_SCALE / fund.totalSupply()`).

---

## AGY-12 [LOW]: `FlowMatchLib.hasPendingForRound` / `hasUnfilledInPool` False-Positive on Empty Unpruned `activeDepBuckets`

### Location
- [FlowMatchLib.sol#L89-L135,L233-L239,L712-L744](../../../contracts/lib/FlowMatchLib.sol#L89-L135) (`hasPendingForRound`, `hasUnfilledInPool`, `_enrollDeposit`, `_consumeActiveDeposit`)
- [FlowCheckLib.sol#L160-L172](../../../contracts/lib/FlowCheckLib.sol#L160-L172) (`_hasRoundWork`)
- [TimedSimBase.sol#L360-L363](../../../contracts/test/prototype/sim/TimedSimBase.sol#L360-L363)

### Description
During deposit enrollment (`_enrollDeposit`, [FlowMatchLib.sol#L233-L237](../../../contracts/lib/FlowMatchLib.sol#L233-L237)), a bucket's `expiryEpoch` is pushed onto `s.activeDepBuckets` once (`!b.activeListed`). However, when a deposit in that bucket is subsequently consumed or cancelled via `consumeDeposit` -> `_consumeActiveDeposit` ([FlowMatchLib.sol#L712-L744](../../../contracts/lib/FlowMatchLib.sol#L712-L744)), `_consumeActiveDeposit` updates `b.totalNormBasis` and `b.remainingNormBasis`, **but never swaps-and-pops `r.expiryEpoch` from `s.activeDepBuckets` when `b.totalNormBasis` reaches `0`**.

Empty buckets are only cleared inside `evictExpiredDepBuckets` once `expEp < cur`, or upon full pool match (`matchedUsdc + matchDust == D` in `bookMatch`). Meanwhile, both `hasPendingForRound` and `hasUnfilledInPool` inspect `activeDepBuckets` without checking `b.totalNormBasis != 0`:

```solidity
// contracts/lib/FlowMatchLib.sol:95-99 & 127-134
        if (s.depPoolUsdc != 0) {
            for (uint256 i; i < s.activeDepBuckets.length; ++i) {
                if (s.activeDepBuckets[i] >= cur) return true;
            }
        }
```

Whenever **any** un-evicted expired bucket `exp_old < cur` leaves `s.depPoolUsdc != 0`, and **any** empty non-expired bucket `exp_empty >= cur` (`b.totalNormBasis == 0`, left behind after cancellation/wind-down/partial consumption) sits in `s.activeDepBuckets`:
1. `hasPendingForRound` returns `true` even with zero settleable deposits or redemptions (`redPoolShares == 0`, no live deposit normBasis in `>= cur`, and no pending epochs).
2. `checkSettle()` / `settle()` misclassifies an idle round as having pending work: inside `[lastBasketStepAt, lastBasketStepAt + settleWindow)` when `hasPendingForRound` is falsely `true`, `checkSettle()` returns `SettleCheck.Window` while `settle()` reverts with `StepInWindow` ([FlowSettleLib.sol#L209-L215](../../../contracts/lib/FlowSettleLib.sol#L209-L215)), and outside that window keeper bots execute a redundant settlement transaction that consumes gas just to evict the expired bucket and return `0`. Note [TimedSimBase.sol#L360-L363](../../../contracts/test/prototype/sim/TimedSimBase.sol#L360-L363) explicitly documents working around false-positive `checkSettle` reports on empty non-expired `activeDepBuckets` entries.

### Impact
Spurious `checkSettle` work signals, wasted keeper `settle()` gas, and unnecessary `StepInWindow` reverts when an empty non-expired deposit bucket coincides with an un-evicted expired bucket (`depPoolUsdc != 0`).

### Remediation
1. In `FlowMatchLib.hasPendingForRound` and `hasUnfilledInPool`, check `s.depBuckets[s.depCycle][s.activeDepBuckets[i]].totalNormBasis != 0` alongside `s.activeDepBuckets[i] >= cur`.
2. In `_consumeActiveDeposit`, swap-and-pop empty buckets (`b.totalNormBasis == 0 && b.activeListed`) from `s.activeDepBuckets` and set `b.activeListed = false` immediately when their last request is cancelled or consumed.

---

## AGY-14 [INFO]: Exhaustive Reentrancy, CEI, Cross-Contract Flow, and Accounting Verification Matrix

### 1. Contract-by-Contract Entry-Point & Reentrancy Guard Matrix

Verified across every mutating external/public function in the `v0.9.0` core suite:

| Contract | Reentrancy-Guarded Mutators (`nonReentrant`) | Un-guarded Mutators (Verified Safe Rationale) |
| --- | --- | --- |
| **`RobotMoneyFund`** ([RobotMoneyFund.sol](../../../contracts/RobotMoneyFund.sol)) | `redeemInKind` (`L221`), `seed` (`L300`), `mintInKind` (`L313`), `sellForFlow`/`sellForFlowGross`/`sellForFlowBatch` (via `_sellForFlow`, `L370`), `executeStep` (`L496`), `setAdapterCodeHashAllowed` (`L760`), `executeDelistStep` (`L892`), `_adminOp` (`L917`: `setMinSeedUsdc`, `setPoolShareBps`, `setAdapterProxyCodeHash`, `setAssetAdapter`, `deactivateAsset`, `setTvlCap`, `setPerDepositCap`, `setExitFeeBps`, `setFeeRecipient`, `setMaxSlippageBps`, `setNavDeviationGuardBps`, `setMinPoolDepthUsdc`, `setFeeMarginBps`, `setDelistBandBps`, `setDelistBudgetBps`, `setMaxBasketBps`, `pauseDeposits`, `unpauseDeposits`, `shutdown`, `restore`, `delistAsset`), `_flowAction` (`L924`: `claimDeferred`, `claimPosition`, `emergencyUnwind()`, `emergencyUnwind(uint256)`, `settleClaim`, `sweepForeignToken`) | `migrateV090` (`upgradeTimelock` + `INITIALIZABLE_STORAGE` version 2 one-shot); `bindFlowRole`, `bindRebalanceRoles`, `setInKindAllowance`, `setTargetAndOpenPlan`, `concludePlan`, `pauseRebalance`, `resumePlan`, `extendBudget`, `closePlan`, `addAsset`, `ledgerCheckpoint` — all strictly role-gated (`ADMIN_ROLE`, `GOVERNANCE_ROLE`, `REBALANCER_ROLE`, `EMERGENCY_ROLE`, `FLOW_ROLE`); external calls inside `addAsset`/`setTargetAndOpenPlan` are strictly `view` / `staticcall`. Sync ERC-4626 `deposit`/`mint`/`redeem`/`withdraw` revert unconditionally (`UseFlowQueue` / `RedeemOnly`). |
| **`FlowQueue`** ([FlowQueue.sol](../../../contracts/FlowQueue.sol)) | **All** user/keeper/admin/emergency mutators: `requestDeposit` (`L123`), `requestDepositWithPermit` (`L135`), `requestRedeem` (`L140`), `cancel` (`L145`), `withdrawExpired` (`L150`), `giveRedemptionNotice` (`L155`), `claimNoticeReturn` (`L160`), `onShutdown` (`L165`), `releaseWindDown` (`L172`), `withdrawCredit` (`L177`), `sweep` (`L182`), `settle` (`L191`), `deposit` (`L225`), `mint` (`L232`), `redeem` (`L239`), `freezeSettlement` (`L255`), `releaseSettlement` (`L260`), `pauseQueue` (`L266`), `unpauseQueue` (`L281`), `setFlowParams` (`L292`), `setFlowLevers` (`L298`) | `migrateV090` (`reinitializer(2)`, `upgradeTimelock`); `settleRedeemSide` (`L201`) and `settleDepositSide` (`L209`) omit `nonReentrant` by design so `FlowSettleLib.settle`'s outer `nonReentrant` wraps `try this.settle*Side(...)`, while enforcing `if (msg.sender != address(this)) revert OnlySelf()`. `withdraw` reverts unconditionally (`RedeemOnly`). |
| **`Rebalancer`** ([Rebalancer.sol](../../../contracts/Rebalancer.sol)) | `step` (`L236`, `KEEPER_ROLE`), `stepDelisted` (`L264`, `KEEPER_ROLE`) | `migrateV090` (`reinitializer(2)`); `setStepParams`, `setAssetStepParams`, `setStepDepthBps` (`onlyRole(ADMIN_ROLE)`, read-only `view` checks on `_fund` + local storage writes). |
| **`RebalanceGovernance`** ([RebalanceGovernance.sol](../../../contracts/RebalanceGovernance.sol)) | `applyReceipt` (`L140`, `TARGET_SETTER_ROLE`), `setTarget` (`L174`, `ADMIN_ROLE`) | `setDefaultPlanParams` (`onlyRole(ADMIN_ROLE)`, pure parameter bounds check + storage write). |
| **`ConsensusRecommendationReceipt`** ([ConsensusRecommendationReceipt.sol](../../../contracts/ConsensusRecommendationReceipt.sol)) | `recordReceipt` (`L157`, `RECEIPT_SUBMITTER_ROLE`), `releaseReceipt` (`L189`, `RECEIPT_RELEASER_ROLE`) | `migrateToSubmitterRoles` (`reinitializer(2)`, `upgradeTimelock` only). |
| **`FundExclusionLedger`** ([FundExclusionLedger.sol](../../../contracts/FundExclusionLedger.sol)) | None (does not inherit `ReentrancyGuard`) | `open`, `credit`, `finalize`, `checkpoint` are `onlyVault`; `claim` (`L187-L195`) strictly updates `claimed[id][holder]`, `exclusions[id].claimedUsdc`, and `heldUsdc` *before* `USDC.safeTransfer(holder, amount)`; `claimAll` loops `claim`; `returnSurplus` computes `bal - held` and transfers to `VAULT`; `sweepForeignToken` sends only to fixed `quarantineAddress()`. |
| **`KeeperAccount`** ([KeeperAccount.sol](../../../contracts/KeeperAccount.sol)) | None | `execute` (`L104-L111`) is owner/bot-key gated (`!_isBotKey && !_isOwner -> NotBotKey`), forbids self-calls (`SelfCall`), holds no assets, and delegates to `nonReentrant` target entry points (`FlowQueue.settle`, `Rebalancer.step`, `stepDelisted`). |

> **Scope note on inherited & auxiliary mutators:** Inherited OpenZeppelin ERC-20 (`transfer`, `transferFrom`, `approve`—which in `RobotMoneyFund` hook into `_update` / `FundExclusionLedger.checkpoint` via pure `view` queries), `AccessControl` (`grantRole`, `revokeRole`, `renounceRole`), and `GovernedUUPS` (`upgradeToAndCall`, `freezeUpgrades`) mutators, as well as `KeeperAccount` owner/bot-key mutators, lie outside the `nonReentrant`-guarded flow/rebalance mutator set above and rely on CEI ordering, role gates, and UUPS proxy/timelock guards.

### 2. Cross-Contract Call Flows & Checks-Effects-Interactions (CEI) Trace

1. **`FlowQueue.settle` $\rightarrow$ `RobotMoneyFund.sellForFlowBatch` / `mintInKind` ([FlowSettleLib.sol](../../../contracts/lib/FlowSettleLib.sol#L106-L194,L540-L707)):**
   - Outer `FlowQueue.settle` is `nonReentrant`. In `_prepareRoundIfNeeded`, `FlowMatchLib.enrollEpochs` calls `fund.ledgerCheckpoint(owner)` **before** mutating match indices (`RB-22`), ensuring exclusion snapshots capture exact pre-settlement holdings.
   - `settleRedeemSide` (`OnlySelf`) calls `fund.sellForFlowBatch(...)`. Inside `RobotMoneyFund._sellForFlow`, shares of `FlowQueue` are burned **before** any swap adapter or lending adapter external call (`RobotMoneyFund.sol:326,375`), `minOut[i]` per-leg minimums are enforced, Check 10 (`FundValuationLib.requireProportion`) is asserted at the end (`FundFlowsLib.sol:223-225`), and `FlowQueue` verifies exact USDC gained and shares burned via `_expect`.
   - `settleDepositSide` (`OnlySelf`) uses `IERC20(s.usdc).forceApprove(address(fund), u)` -> `fund.mintInKind(sharesOut, u, maxIn)` -> `IERC20(s.usdc).forceApprove(address(fund), 0)`, verifies Check 11 (`spent <= u`, `FlowSettleLib.sol:699-701`) and balance deltas `_expect`, and only then records claims and mints shares. Inside `FundFlowsLib.mintInKind`, Check 10 is verified against `supply + sharesOut` before `RobotMoneyFund._mint(caller, sharesOut)` (`RobotMoneyFund.sol:321-322`), after which `_update` triggers `x.ledger.checkpoint(address(0), caller)` (`RobotMoneyFund.sol:270`).

2. **`RobotMoneyFund.shutdown` $\rightarrow$ `FlowQueue.onShutdown` $\rightarrow$ `redeemInKind` ([RobotMoneyFund.sol#L221-L230,L864-L866](../../../contracts/RobotMoneyFund.sol#L221-L230), [FlowQueue.sol#L165-L170](../../../contracts/FlowQueue.sol#L165-L170)):**
   - `shutdown()` runs inside `_adminOp` (`nonReentrant`), sets `s.shutdown = true`, `s.tvlCap = 0`, pauses any live plan, and invokes `IFlowQueue(s.flowQueue).onShutdown()` (`nonReentrant`, `msg.sender == s.fund`, checks `fund.isShutdown()`), incrementing `windDownEra` and retiring active match cycles cleanly.
   - Once shutdown, `redeemInKind` (`nonReentrant`) spends allowance and calls `_burn(owner, shares)` **before** invoking `FundFlowsLib.payInKind`, which snapshots held balances, handles lending allowances/position claims, defers illiquid basket transfers cleanly via `deferredTotal[i]`, and asserts Check 10 against `supplyBefore - shares`.

3. **`RobotMoneyFund._update` $\rightarrow$ `FundExclusionLedger.checkpoint` $\rightarrow$ `FlowQueue.queuedSharesOfAt` ([RobotMoneyFund.sol#L267-L272](../../../contracts/RobotMoneyFund.sol#L267-L272), [FundExclusionLedger.sol#L177-L183,L276-L298](../../../contracts/FundExclusionLedger.sol#L276-L298)):**
   - `_update` enforces `SeedSharesLocked` (`if (from == address(this)) revert`), then checkpoints `from` and `to` on `FundExclusionLedger` *before* `super._update` alters ERC-20 balances.
   - `FundExclusionLedger._checkpoint` records pre-mutation `wallet + FlowQueue.queuedSharesOfAt(account, _depIndexes[id], _redIndexes[id])` via pure `view` queries—making no external state-mutating callbacks during token transfers, mints, or burns.

4. **`Rebalancer.step` / `stepDelisted` $\rightarrow$ `RobotMoneyFund.executeStep` / `executeDelistStep` ([Rebalancer.sol#L234-L305](../../../contracts/Rebalancer.sol#L234-L305)):**
   - `Rebalancer.step` (`nonReentrant`, `KEEPER_ROLE`) checks plan bounds and TWAP/feed health, calls `fund.executeStep` (`nonReentrant`, `REBALANCER_ROLE`) -> `FundStepLib.executeStep`, enforcing adapter allowlisting (`FundAdapterGuard.vet`) and `BasketSwaps.swap` approval hygiene. Note `Rebalancer._execute` wraps `f.executeStep` in `try/catch` with `STEP_GAS_FLOOR = 63/64` check (`StepGasStarved`) so low-gas keeper griefing cannot inject fake asset backoff.

### 3. Approval Hygiene (`ADP-5` / `NC-12`)
A repository-wide search confirms **zero** raw `.approve(...)` calls in `RobotMoneyFund`, `FlowQueue`, `contracts/lib/`, and `contracts/adapters/`. Every external allowance grant strictly uses OpenZeppelin `SafeERC20.forceApprove(spender, amount)` paired with an unconditional post-call reset `IERC20(...).forceApprove(spender, 0)`:
- [FlowSettleLib.sol#L692-L694](../../../contracts/lib/FlowSettleLib.sol#L692-L694) (`depositSide` -> `fund`)
- [FundFlowsLib.sol#L304-L309](../../../contracts/lib/FundFlowsLib.sol#L304-L309) (`_buyExact` -> swap adapter)
- [BasketSwaps.sol#L75-L94](../../../contracts/lib/BasketSwaps.sol#L75-L94) (`_swap` / `FundStepLib` -> swap adapter)
- [UniswapV3SwapAdapter.sol#L84-L98](../../../contracts/adapters/UniswapV3SwapAdapter.sol#L84-L98), [UniswapV3ExactOutSwapAdapter.sol#L64-L77](../../../contracts/adapters/UniswapV3ExactOutSwapAdapter.sol#L64-L77), [AerodromeSwapAdapter.sol#L100-L115](../../../contracts/adapters/AerodromeSwapAdapter.sol#L100-L115), [AerodromeExactOutSwapAdapter.sol#L66-L80](../../../contracts/adapters/AerodromeExactOutSwapAdapter.sol#L66-L80), [AaveV3Adapter.sol#L92-L115](../../../contracts/adapters/AaveV3Adapter.sol#L92-L115), [MorphoAdapter.sol#L95-L127](../../../contracts/adapters/MorphoAdapter.sol#L95-L127), and [CompoundV3Adapter.sol#L88](../../../contracts/adapters/CompoundV3Adapter.sol#L88).

### 4. Prefix-Sum Ray Conservation, Dust Accounting, and Check 10 Proportion Math

1. **O(1) Deposit Match Index (`MATCH_SCALE = 1e18`, [FlowMatchLib.sol#L211-L242,L408-L434,L500-L589](../../../contracts/lib/FlowMatchLib.sol#L570-L589)):**
   - Enrolled requests obtain `nb = rem * MATCH_SCALE / F` (rounded down), moving the immediate truncation residue `dust = rem - added` from `s.totalPendingUsdc` to `s.dustUsdc`.
   - On a partial match, `newF = oldF * (D - matchedUsdc) / D` and `newD = totalB * newF / MATCH_SCALE`; any integer division shortfall `(D - matchedUsdc) - newD` moves from `totalPendingUsdc` to `dustUsdc`. On a full match (`matchedUsdc + matchDust == D`), `depCycle` increments cleanly with fresh factor `MATCH_SCALE`.
   - During lazy owner materialization (`syncOwnerDeposits`), `_settleDepMatchShares` tracks `rec.remainingShares` and `rec.remainingNormBasis`; when the final participant (`remNb == 0`) syncs a `DepMatchRecord`, any unallocated floor-rounding share remainder `remShares != 0` moves from `totalHeldShares` into `dustShares`, preserving exact supply backing.

2. **O(1) Redeem Match Accumulator (`ACC_SCALE = 1e27`, [FlowMatchLib.sol#L437-L486,L592-L642](../../../contracts/lib/FlowMatchLib.sol#L592-L642)):**
   - Each exit-fee tier `fBps` tracks `tierNormBasis[fBps]`, `cumNetPerBasisScaled[fBps] += netF * ACC_SCALE / bF`, and `tierOwedTracked[fBps] += netF`. Unmatched factor decays via `newF = unmatchedFactor * (R - M) / R`, routing `grossDust` to `dustUsdc` and `shareDust` to `dustShares`. Exit fees (`totalFee`) transfer immediately to `feeRecipient` ([FlowMatchLib.sol#L467](../../../contracts/lib/FlowMatchLib.sol#L467)).
   - On sync, `earnedUsdc` is capped by `tierOwedTracked[fBps]` to prevent cross-rounding overdraw, and `_flushEmptyRedeemTier` moves any sub-wei residue when `tierNormBasis[fBps] == 0` from `totalOwedUsdc` to `dustUsdc`.

3. **Dust Sink (`INV-2`):**
   - Accumulated `dustUsdc` and `dustShares` are tracked strictly as vault-bound surplus, and `FlowQueue.sweep()` ([FlowClaimLib.sol#L344-L360](../../../contracts/lib/FlowClaimLib.sol#L344-L360)) transfers `(bal - owed)` exclusively to `s.fund` (never to `msg.sender` or `feeRecipient`), favoring holders on every rounding boundary.

4. **Check 10 (`FundValuationLib.requireProportion`, [FundValuationLib.sol#L157-L179](../../../contracts/lib/FundValuationLib.sol#L157-L179)) & Check 11 ([FlowSettleLib.sol#L698-L701](../../../contracts/lib/FlowSettleLib.sol#L698-L701)):**
   - Check 10 verifies post-flow per-share conservation across idle USDC and every counted non-zero asset (`idleAfter * supplyBefore >= idleBefore * supplyAfter` and `a * supplyBefore >= b * supplyAfter`) at the end of `mintInKind`, `_sellForFlow`, and `payInKind`.
   - **Precision & overflow note:** `FundValuationLib.requireProportion` uses Solidity 0.8 **256-bit checked cross-multiplication** (rather than 512-bit `FullMath`); as documented in NatSpec (`FundValuationLib.sol:153-156`), this fails closed via arithmetic overflow revert whenever `amount * supply >= 2^256` (safe for realistic `< 2^128` token/share quantities). Check 11 in `FlowSettleLib.depositSide` enforces realized net mint cost `spent <= u`.
