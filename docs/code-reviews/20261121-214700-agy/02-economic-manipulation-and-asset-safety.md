# 02 — Economic Manipulation, Slippage Guards, and Asset Safety

- **Base:** `dev` (`6c25fd8ce291a88ed088f71e0e015296a561ea24`), merged from `release-0.9.0` (`86747f24534a39cf19a75d4370d3f91466dcc24f`, tag `contracts-0.9.0`) via PR `#2019` (`contracts/` tree is byte-identical across both commits)
- **Worktree Reviewed:** `/drive2/home/lucas/tmp/superfield-worktrees/robotmoney-core/adhoc-20261122-233507-safety-review-090`
- **Scope:** Findings **AGY-01**, **AGY-03**, **AGY-05**, **AGY-06**, **AGY-07**, **AGY-13**

---

## Summary of Findings

| ID | Severity | Title | Primary Locations |
| --- | --- | --- | --- |
| **AGY-01** | **High** | Single-asset `emergencyUnwind(uint256)` dumps 100% of position with `floor = 0` when feed is unhealthy | [FundFlowsLib.sol](../../../contracts/lib/FundFlowsLib.sol#L643-L701) |
| **AGY-03** | **High** | Single-asset `emergencyUnwind(uint256)` on a non-`inSale` basket asset leaves `active = true` at zero balance, bricking feeds while live plans block deactivation | [FundFlowsLib.sol](../../../contracts/lib/FundFlowsLib.sol#L643-L701), [FundValuationLib.sol](../../../contracts/lib/FundValuationLib.sol#L264-L277), [FundAdminLib.sol](../../../contracts/lib/FundAdminLib.sol#L549-L587) |
| **AGY-05** | **Medium** | `delistAsset` and `emergencyUnwind(uint256)` zero `p.endBps[index]` while `PlanMath` hardcodes `0` idle end target, making convergence mathematically unreachable for $w > (n+1)\cdot\text{toleranceBps}$ | [FundDelistLib.sol](../../../contracts/lib/FundDelistLib.sol#L112-L121), [PlanMath.sol](../../../contracts/PlanMath.sol#L228-L340) |
| **AGY-06** | **Medium** | Slow pool ramp (`A10`) and held TWAP (`A2`) arbitrage inside `refBandBps = 90` bps after `matchBandBps = 10` bps match skips (open Gate G8 failure) | [FlowMatchLib.sol](../../../contracts/lib/FlowMatchLib.sol#L319-L328), [FlowCheckLib.sol](../../../contracts/lib/FlowCheckLib.sol#L365-L391) |
| **AGY-07** | **Medium** | `INV-2` / `LIFE-6` violation on deactivated basket assets: dust left unrecoverable by `ProtectedToken`, missing `reabsorbRemovedAsset`, and permanent `MAX_FUND_ASSETS = 12` slot consumption | [FundFlowsLib.sol](../../../contracts/lib/FundFlowsLib.sol#L314-L325), [FundAdminLib.sol](../../../contracts/lib/FundAdminLib.sol#L110-L126), [FundAdminLib.sol](../../../contracts/lib/FundAdminLib.sol#L578-L587) |
| **AGY-13** | **Low** | `UniswapV3ExactOutSwapAdapter.isFixedFeePool` (and `UniswapV3SwapAdapter`) omits canonical `IUniswapV3Factory.getPool` verification; lending adapter safety summary | [UniswapV3ExactOutSwapAdapter.sol](../../../contracts/adapters/UniswapV3ExactOutSwapAdapter.sol#L87-L97), [UniswapV3SwapAdapter.sol](../../../contracts/adapters/UniswapV3SwapAdapter.sol#L35-L124) |

---

## AGY-01 [HIGH]: Single-Asset `emergencyUnwind(uint256)` Executes Uncapped Full-Position Swap with `floor = 0` on Unhealthy Feeds

### Location
- [RobotMoneyFund.sol#L879-L881](../../../contracts/RobotMoneyFund.sol#L879-L881) (`emergencyUnwind(uint256 index)`)
- [FundFlowsLib.sol#L643-L701](../../../contracts/lib/FundFlowsLib.sol#L643-L701) (`_emergencyUnwindAsset`, `_emergencyUnwindSingleSwap`)
- [FundValuationLib.sol#L200-L214](../../../contracts/lib/FundValuationLib.sol#L200-L214) (`feedPricePerToken`)

### Description
`RobotMoneyFund.emergencyUnwind(uint256 index)` (`ADMIN_ROLE`, timelock-gated) delegates to `FundFlowsLib._emergencyUnwindAsset` and `_emergencyUnwindSingleSwap` for basket assets. When `FundValuationLib.feedPricePerToken(s, index)` returns `feedOk == false`, `_emergencyUnwindSingleSwap` leaves `uint256 floor` equal to `0` and immediately invokes `_swapAndMeasureSold(a, s.usdc, totalTok, floor)` with `minAmountOut = 0`, selling **100%** of `fundTok + claimTok` in a single trade with up to **100% slippage**:

```solidity
// contracts/lib/FundFlowsLib.sol:678-701
    function _emergencyUnwindSingleSwap(FundState storage s, uint256 index, AssetConfig memory a)
        private
    {
        uint256 fundTok = FundValuationLib.heldBalance(s, index);
        bool inSaleNow = s.inSale[index];
        uint256 claimTok = inSaleNow ? s.delistClaimedTokens[index] : 0;
        uint256 totalTok = fundTok + claimTok;
        if (totalTok == 0) {
            if (inSaleNow) FundDelistLib.closeDelistSale(s, index);
            return;
        }
        // Floor: the feed price less `delistBandBps` (plan section 3.3). A stale feed leaves no floor, so the unwind
        // can still run when the feeds are what failed.
        uint256 floor;
        (bool feedOk,, uint256 feedPx) = FundValuationLib.feedPricePerToken(s, index);
        if (feedOk) {
            floor = totalTok.mulDiv(feedPx, 10 ** IERC20Metadata(a.token).decimals())
                .mulDiv(BPS - s.delistBandBps, BPS);
        }
        (uint256 sold, uint256 usdcGot) = _swapAndMeasureSold(a, s.usdc, totalTok, floor);
        if (inSaleNow) {
            FundDelistLib.finalizeDelistSale(s, index, sold, usdcGot, 0, fundTok, claimTok, false);
        }
    }
```

Four compounding design defects make this path dangerous:

1. **Zero slippage floor whenever *either* feed fails (`feedOk == false`).** `FundValuationLib.feedPricePerToken` ([FundValuationLib.sol#L200-L214](../../../contracts/lib/FundValuationLib.sol#L200-L214)) returns `ok == false` if the asset's Chainlink feed is stale, incomplete, non-positive, or reverting, **or** if `usdcFeed8(s)` returns `ok == false` (`OffPeg` outside `usdcPegBandBps` or stale USDC feed). Because stale/broken feeds are the primary operational trigger for an emergency single-asset unwind, the exact scenario in which `emergencyUnwind(index)` is called drops `floor` to `0`.
2. **Ignores existing on-chain price fallbacks.** Unlike `delistAsset` ([FundDelistLib.sol#L133-L149](../../../contracts/lib/FundDelistLib.sol#L133-L149)), which falls back from `feedPricePerToken` to `s.lastGoodAssetPrice[index]` and then `twapPrice`, and unlike whole-fund `_emergencyUnwind` / `_emergencyUnwindInSale` ([FundFlowsLib.sol#L569-L604](../../../contracts/lib/FundFlowsLib.sol#L569-L604)), which computes `twapPrice` haircut by `maxSlippageBps` and skips when `floor == 0`, `_emergencyUnwindSingleSwap` ignores `s.saleFallbackPrice[index]`, `s.lastGoodAssetPrice[index]`, and `twapPrice`.
3. **Contradicts canonical bounded-slippage emergency unwind design.** Canonical specs ([one-vault-rebalancer-proposal.md](../../technical/one-vault-rebalancer-proposal.md#L345-L347) §4.5 rule 5, §5.11.4, §5.11.5 [line 1365-1368](../../technical/one-vault-rebalancer-proposal.md#L1365-L1368); [one-vault-timed-flows-eng-plan.md](../../technical/one-vault-timed-flows-eng-plan.md#L424) `E50`) and the audited multi-vault basket pattern ([BasketSwaps.sol#L134-L146,L182-L197](../../../contracts/lib/BasketSwaps.sol#L134-L146)) forbid executing an oracle-less swap without an explicit governed `minUsdcOut` (`EmergencyFloorUnavailable` / `EmergencyUnwindGuard`).
4. **48-hour public timelock visibility + uncapped single-swap dump of `fundTok + claimTok`.** `ADMIN_ROLE` sits behind `ProposerFloorTimelock` (`TIMELOCK_DELAY_REFERENCE = 48 hours` in `FlowTypes.sol`, `172_800`s production floor in `CoreTimelockHandover`). Under the Fund System's `D4-10` closed-executor policy ([FundTimelockPolicy.sol#L9-L19](../../../contracts/script/FundTimelockPolicy.sol#L9-L19), [DeployFundTimelock.s.sol#L145-L153](../../../contracts/script/DeployFundTimelock.s.sol#L145-L153)), `EXECUTOR_ROLE` is restricted solely to the `Safe` rather than `address(0)`, so anonymous third parties cannot invoke `timelock.execute()` directly; **however**, the queued `emergencyUnwind(index)` calldata sits publicly visible on-chain for the full 48-hour delay, and any MEV searcher or block builder monitoring the Safe's `execute()` transaction in the public mempool can still sandwich the entire execution at `floor = 0`—dumping both vault holders' active balance (`fundTok`) and redeeming holders' `delistClaimedTokens` (`totalTok = fundTok + claimTok`, with no `stepDepthBps` chunking even when `feedOk == true`, while passing `enforceLimits = false` to `finalizeDelistSale` at [FundFlowsLib.sol#L699](../../../contracts/lib/FundFlowsLib.sol#L699)). Even when `feedOk == true`, an oversized single swap moves the AMM spot below `(BPS - delistBandBps) / BPS` (300 bps) and permanently reverts unless `feedOk` is false—at which point it dumps at `floor = 0`.

### Impact
Any timelock execution of `emergencyUnwind(index)` while either the asset feed or USDC feed is unhealthy allows an MEV sandwich attacker to extract up to 100% of the unwound asset's value from both vault holders (`fundTok`) and in-flight delist claimers (`claimTok`).

### Remediation
Require a timelock-supplied `minUsdcOut` parameter (and preserve oracle fallback before zeroing) and never allow an unprotected `floor == 0` swap. For example:

```solidity
error EmergencyFloorUnavailable(address token);

function emergencyUnwind(uint256 index, uint256 minUsdcOut) external returns (uint256 recoveredUsdc)

// Inside _emergencyUnwindSingleSwap(FundState storage s, uint256 index, AssetConfig memory a, uint256 minUsdcOut):
uint256 decimalsScale = 10 ** IERC20Metadata(a.token).decimals();
uint256 px = 0;
(bool feedOk,, uint256 feedPx) = FundValuationLib.feedPricePerToken(s, index);
if (feedOk && feedPx != 0) {
    px = feedPx;
} else if (s.inSale[index] && s.saleFallbackPrice[index] != 0) {
    px = s.saleFallbackPrice[index];
} else if (s.lastGoodAssetPrice[index] != 0) {
    px = s.lastGoodAssetPrice[index];
} else {
    try IBasketSwapAdapter(FundAdapterGuard.vet(s, a.adapter))
        .twapPrice(a.pool, a.token, s.usdc, decimalsScale, a.twapWindow) returns (uint256 twapPx)
    {
        px = twapPx;
    } catch {}
}

uint256 oracleFloor = px == 0
    ? 0
    : totalTok.mulDiv(px, decimalsScale).mulDiv(BPS - s.delistBandBps, BPS);
uint256 floor = oracleFloor > minUsdcOut ? oracleFloor : minUsdcOut;
if (floor == 0) revert EmergencyFloorUnavailable(a.token);
```

Additionally, chunk oversized emergency exits using `Rebalancer.stepDepthBps()` or route through `delistAsset` + `stepDelisted` when pool depth is shallow relative to `totalTok`.

---

## AGY-03 [HIGH]: Single-Asset `emergencyUnwind(uint256)` on a Non-`inSale` Basket Asset Leaves `active = true`, Bricking Feeds While Live Plans Block Deactivation

### Location
- [FundFlowsLib.sol#L643-L701](../../../contracts/lib/FundFlowsLib.sol#L643-L701) (`_emergencyUnwindAsset`, `_emergencyUnwindSingleSwap`)
- [FundValuationLib.sol#L264-L277](../../../contracts/lib/FundValuationLib.sol#L264-L277) (`requireFeedsHealthy`)
- [FlowCheckLib.sol#L275-L334](../../../contracts/lib/FlowCheckLib.sol#L275-L334) (`market` Checks 2–4)
- [StepFeedLib.sol#L51-L143](../../../contracts/lib/StepFeedLib.sol#L51-L143) (`check`, `_isBasket`)
- [FundAdminLib.sol#L549-L587](../../../contracts/lib/FundAdminLib.sol#L549-L587) (`_deactivateAsset`)

### Description
Unlike `delistAsset` (which sets `s.inSale[index] = true` and closes the sale via `closeDelistSale` -> `s.assets[index].active = false` once balance hits zero), `_emergencyUnwindAsset` -> `_emergencyUnwindSingleSwap` on a **non-`inSale`** basket asset zeroes `s.targetBps[index] = 0` and `p.endBps[index] = 0` and sells `totalTok` down to `0`, **without ever setting `s.assets[index].active = false`**:

```solidity
// contracts/lib/FundValuationLib.sol:264-277
    function requireFeedsHealthy(FundState storage s) internal view {
        uint256 n = s.assets.length;
        for (uint256 i; i < n; ++i) {
            AssetConfig storage a = s.assets[i];
            if (!a.active || a.kind != AssetKind.Basket) continue;
            (FeedStatus st,) = FeedLib.read(a.feed, a.maxFeedAge);
            if (s.inSale[i]) {
                if (st != FeedStatus.Ok && s.saleFallbackPrice[i] == 0) {
                    revert IRobotMoneyFund.FeedUnhealthy(i, st);
                }
                continue;
            }
            if (st != FeedStatus.Ok) revert IRobotMoneyFund.FeedUnhealthy(i, st);
        }
    }
```

Every critical market health gate filters exclusively by `a.active && a.kind == AssetKind.Basket`, regardless of `heldBalance == 0`:

1. **`totalAssets()` / `navChecked()` (`RobotMoneyFund.sol:147`)**: calls `FundValuationLib.requireFeedsHealthy(s)` and reverts `FeedUnhealthy(index, st)` if asset `index`'s feed is broken—even with zero tokens held.
2. **`FlowQueue.settle()` (`FlowCheckLib.sol:275-334`)**: Check 2 rejects `!inSale && st != FeedStatus.Ok` (`SettleCheck.Feed`), Check 3 checks TWAP slice quorum (`SettleCheck.TwapQuorum`), and Check 4 checks `TwapVsFeed` (`SettleCheck.TwapVsFeed`) for every active non-`inSale` basket asset.
3. **`Rebalancer.step()` -> `FundStepLib.executeStep()` (`StepFeedLib.sol:51-143`)**: `_isBasket(a)` (`return a.active && a.kind == AssetKind.Basket;`) requires healthy feed, TWAP quorum, and TWAP-vs-feed bounds on the unwound zero-balance asset before any other asset can rebalance.
4. **Deactivation deadlock (`FundAdminLib._deactivateAsset`, lines 549-556)**:

```solidity
// contracts/lib/FundAdminLib.sol:549-556
    function _deactivateAsset(FundState storage s, uint256 i) private {
        Plan storage p = s.plan;
        if (
            p.status == PlanStatus.Open || p.status == PlanStatus.Halted
                || p.status == PlanStatus.Paused
        ) {
            revert IRobotMoneyFund.PlanLive(p.id);
        }
```

If a rebalance plan is `Open`, `Halted`, or `Paused` when `emergencyUnwind(index)` runs (note `emergencyUnwind(index)` explicitly leaves a live plan open/paused rather than closing it, unlike `delistAsset` + `stepDelisted` which self-closes via `closeDelistSale`), `deactivateAsset(index)` reverts `PlanLive(p.id)`! Compounded with **AGY-05** (where zeroing `p.endBps[index]` also blocks plan convergence), the fund cannot settle flows (`FlowQueue.settle()`), cannot read `totalAssets()`, and cannot execute rebalance steps (`Rebalancer.step()`) until the plan either expires (`endTime + maxOverrun`, 7–30 days) or is manually closed via another 48-hour timelock `closePlan()` transaction.

### Impact
Emergency-unwinding a broken non-`inSale` basket asset during any live rebalance plan leaves the vault with `active = true` and `heldBalance = 0` on that broken feed, immediately DoS'ing `totalAssets()`, `FlowQueue.settle()`, and `Rebalancer.step()` until governance waits out another 48-hour timelock delay to close the plan and call `deactivateAsset(index)`.

### Remediation
Inside `_emergencyUnwindSingleSwap`, when `!inSaleNow && FundValuationLib.heldBalance(s, index) == 0 && s.deferredTotal[index] == 0`, deactivate the asset immediately (and record `lastStateStopEndedAt` if applicable), matching `closeDelistSale`:

```solidity
        if (
            !inSaleNow && FundValuationLib.heldBalance(s, index) == 0
                && s.deferredTotal[index] == 0
        ) {
            s.assets[index].active = false;
            emit IRobotMoneyFund.AssetDeactivated(index);
        }
```

(Paired with the **AGY-05** fix so `p.endIdleBps` absorbs the removed target weight and live plans remain well-formed.)

---

## AGY-05 [MEDIUM]: `delistAsset` and `emergencyUnwind(uint256)` Zero `p.endBps[index]` Without Updating Idle End Target, Making Plan Convergence Unreachable

### Location
- [FundDelistLib.sol#L112-L121](../../../contracts/lib/FundDelistLib.sol#L112-L121) (`delistAsset`)
- [FundFlowsLib.sol#L650-L658](../../../contracts/lib/FundFlowsLib.sol#L650-L658) (`_emergencyUnwindAsset`)
- [PlanMath.sol#L228-L236,L325-L340](../../../contracts/PlanMath.sol#L228-L236) (`pathTargetValue`, `withinTolerance`)

### Description
When `delistAsset(index)` or `_emergencyUnwindAsset(index)` runs while a plan is live (`Open`, `Halted`, or `Paused`), both functions zero the asset's end weight directly on `s.plan`:

```solidity
// contracts/lib/FundDelistLib.sol:112-121
        s.inSale[index] = true;
        s.targetBps[index] = 0;
        Plan storage p = s.plan;
        if (
            (p.status == PlanStatus.Open
                    || p.status == PlanStatus.Halted
                    || p.status == PlanStatus.Paused) && index < p.endBps.length
        ) {
            p.endBps[index] = 0;
        }
```

However, `Plan` has no `endIdleBps` field, and `PlanMath.pathTargetValue` and `PlanMath.withinTolerance` hardcode `0` as idle USDC's end target:

```solidity
// contracts/PlanMath.sol:234-235
        if (index == IDLE_INDEX) return pathValue(p.startIdleBps, 0, e, d, nav);
        return pathValue(p.startBps[index], p.endBps[index], e, d, nav);

// contracts/PlanMath.sol:325-340
    function withinTolerance(
        uint256[] memory values,
        uint256 idle,
        uint256 nav,
        uint16[] memory endBps,
        uint256 toleranceBps
    ) internal pure returns (bool) {
        if (nav == 0) return true;
        uint256 band = Math.mulDiv(nav, toleranceBps, BPS);
        if (idle > band) return false;
        for (uint256 i; i < values.length; ++i) {
            (uint256 o, uint256 u) = deviation(values[i], Math.mulDiv(nav, endBps[i], BPS));
            if (o > band || u > band) return false;
        }
        return true;
    }
```

#### Mathematical Proof of Unreachability
Let $V = \text{nav} > 0$, $\text{BPS} = 10{,}000$, and $\varepsilon = \frac{\text{toleranceBps}}{10{,}000}$. Assume $n = \text{values.length}$ assets exist, and a total weight $w > 0$ bps has been zeroed out of `p.endBps` (either via `delistAsset` or `emergencyUnwind(index)`), so the remaining end targets satisfy:
$$\sum_{i=0}^{n-1} \frac{\text{endBps}[i]}{10{,}000} = 1 - \frac{w}{10{,}000},$$
while portfolio NAV conservation requires:
$$\frac{\text{idle}}{V} + \sum_{i=0}^{n-1} \frac{\text{values}[i]}{V} = 1.$$
Suppose `withinTolerance` returns `true` (ignoring $\le 1\text{-wei}$ `mulDiv` floor rounding). Then every component must satisfy its upper tolerance bound:
$$\frac{\text{idle}}{V} \le \varepsilon \quad\text{and}\quad \frac{\text{values}[i]}{V} \le \frac{\text{endBps}[i]}{10{,}000} + \varepsilon \quad \forall i \in \{0, \dots, n-1\}.$$
Summing these $n + 1$ inequalities gives:
$$1 = \frac{\text{idle}}{V} + \sum_{i=0}^{n-1} \frac{\text{values}[i]}{V} \le \varepsilon + \sum_{i=0}^{n-1}\left(\frac{\text{endBps}[i]}{10{,}000} + \varepsilon\right) = \left(1 - \frac{w}{10{,}000}\right) + (n + 1)\varepsilon.$$
Simplifying yields a **necessary condition** for `withinTolerance == true`:
$$\frac{w}{10{,}000} \le (n + 1)\varepsilon \iff w \le (n + 1)\cdot \text{toleranceBps}.$$

Consequently, for **any** removed target weight $w > (n + 1) \cdot \text{toleranceBps}$ (for instance, on a 5-asset vault with `toleranceBps = 50` bps, any $w > 6 \times 50 = 300$ bps = 3% weight, whereas single basket targets in `FundCoreTest` are `1,750–2,000` bps), **no portfolio allocation in $\mathbb{R}_{\ge 0}^{n+1}$ summing to $V$ can satisfy `withinTolerance`**.

### Impact
Whenever a live rebalance plan has an asset delisted or emergency-unwound whose weight exceeds $(n+1)\cdot\text{toleranceBps}$:
- `withinTolerance` stays permanently `false`.
- `Rebalancer` (`_decide`) fails to conclude the plan as `Converged` after `p.endTime` and continues either burning budget trying to over-allocate remaining assets above `endBps` / `capBps` or stalling with zero eligible buys until `p.endTime + maxOverrun` (7–30 days) expires as `PlanStatus.Expired`.
- Throughout that entire period, `FundAdminLib.requireNoLivePlan` (`addAsset`, `deactivateAsset`) reverts `PlanLive(p.id)` unless `ADMIN_ROLE` manually executes `closePlan()` (48-hour timelock delay).

### Remediation
Track idle's end target explicitly on `Plan` (or compute `endIdleBps = BPS - sum(p.endBps)` inside `PlanMath`):

```solidity
// In PlanMath.sol (passing computed endIdleBps = BPS - sumEndBps(endBps), or storing uint16 endIdleBps in Plan):
function endIdleTargetBps(uint16[] memory endBps) internal pure returns (uint16) {
    uint256 sum;
    for (uint256 i; i < endBps.length; ++i) sum += endBps[i];
    return sum >= BPS ? 0 : uint16(BPS - sum);
}

// In pathTargetValue:
if (index == IDLE_INDEX) return pathValue(p.startIdleBps, endIdleTargetBps(p.endBps), e, d, nav);

// In withinTolerance:
uint256 idleTarget = Math.mulDiv(nav, endIdleTargetBps(endBps), BPS);
(uint256 idleOver, uint256 idleUnder) = deviation(idle, idleTarget);
if (idleOver > band || idleUnder > band) return false;
```

Computing `endIdleTargetBps(p.endBps)` dynamically from `p.endBps` also avoids changing `Plan` storage struct fields across `FundState`.

---

## AGY-06 [MEDIUM]: Slow Pool Ramp (`A10`) and Held TWAP (`A2`) Arbitrage Inside `refBandBps = 90` bps Following Match Band Skips

### Location
- [FlowTypes.sol#L48](../../../contracts/FlowTypes.sol#L48) (`DEFAULT_MATCH_BAND_BPS = 10`)
- [FlowMatchLib.sol#L319-L328](../../../contracts/lib/FlowMatchLib.sol#L319-L328) (`bookMatch`)
- [FlowCheckLib.sol#L365-L391](../../../contracts/lib/FlowCheckLib.sol#L365-L391) (`_basketPrice`, `refBandBps`, `legBandBps`)
- [one-vault-rebalancer-proposal.md#L882,L2338-L2370](../../technical/one-vault-rebalancer-proposal.md#L2338-L2370)
- [one-vault-release-090-gate-options.md#L1-L25](../../technical/one-vault-release-090-gate-options.md#L1-L25)

### Description
To close the Step 3f lagging-TWAP whole-match vector (`A21`) and reduce worst-case Gate G9 flow cost from `39.25` bps to `16.94` bps, `release-0.9.0` introduces `FlowParams.matchBandBps` (`10` bps default, matching the default `exitFeeBps`):

```solidity
// contracts/lib/FlowMatchLib.sol:320-328
        {
            uint256 nf = c.navFeed;
            uint256 nt = c.navTwap;
            uint256 dev = (nt > nf ? nt - nf : nf - nt).mulDiv(BPS, nf, Math.Rounding.Ceil);
            if (dev > s.params.matchBandBps) {
                emit IFlowEvents.MatchSkipped(roundEpoch, dev);
                return 0;
            }
        }
```

When `|navTwap - navFeed| / navFeed > 10` bps, `bookMatch` skips internal netting (`MatchSkipped`), converting what would have been matched peer-to-peer flow at `navTwap` into **100% gross pool execution** (`redeemSide` -> `sellForFlowBatch` and `depositSide` -> `mintInKind`). On the pool execution path, `FlowCheckLib._basketPrice` validates TWAP against Chainlink feed only within `refBandBps = 90` bps and builds per-leg slippage bounds `buyPerToken` / `sellPerToken` around `min/max(feed, twap) ± legBandBps` (`100` bps):

```solidity
// contracts/lib/FlowCheckLib.sol:379-390
        uint256 diff = twapDown > feedDown ? twapDown - feedDown : feedDown - twapDown;
        devBps = diff.mulDiv(BPS, feedDown, Math.Rounding.Ceil);
        if (devBps > p.refBandBps) return (false, devBps, ap);
        ap.feedPerToken = feedDown;
        ap.twapPerToken = twapDown;
        uint256 low = feedUp < twapUp ? feedUp : twapUp;
        uint256 high = feedDown > twapDown ? feedDown : twapDown;
        if (f.legPriceMode == LEG_PRICE_TWAP_ONLY) (low, high) = (twapUp, twapDown);
        else if (f.legPriceMode == LEG_PRICE_FEED_ONLY) (low, high) = (feedUp, feedDown);
        ap.buyPerToken = low.mulDiv(BPS + p.legBandBps, BPS, Math.Rounding.Ceil);
        ap.sellPerToken = high.mulDiv(BPS - p.legBandBps, BPS);
```

Because `matchBandBps` only skips matching while leaving `refBandBps = 90` bps unchanged, an attacker ramping pool prices gradually (`A10`) or holding a manipulated TWAP push inside `refBandBps` (`A2`) still passes Check 4 (`TwapVsFeed`) and captures profitable arbitrage against the fund's net swaps—especially when `dev in (10, 90]` bps triggers `MatchSkipped` and pushes both opposing sides into the skewed pool.

### Measured Gate G8 & Gate G9 Evidence (`contracts-0.9.0` Docs & Tests)
Recorded in [one-vault-rebalancer-proposal.md#L2338-L2370](../../technical/one-vault-rebalancer-proposal.md#L2338-L2370) and [one-vault-release-090-gate-options.md](../../technical/one-vault-release-090-gate-options.md#L9-L16):
- **A10 (slow ramp inside `refBandBps = 90` bps):**
  - Deterministic (`Attacks.t.sol`): **+156.64 USDC** attacker profit (`+156.62` / `+110.1` after flash fee in initial scoring, `+156.64` in Step 3f).
  - Stochastic Monte Carlo sim (`AttackSim.t.sol`, `PROTO_SIM_ATTACKS=1`, 4 seeds): strict max **+61.76 USDC** (best mean +16.04 USDC).
- **A2 (held TWAP push):** sim strict max **+0.35 USDC** (best mean +0.16 USDC).
- **A6 (hedge run):** sim strict max **+467.55 USDC** in 1 of 8 runs (best mean 0 USDC; holders and pending users lose 0—gain arises from the simulated hedge in external market).
- **Gate G9 vs Gate G8 tension:** lowering `refBandBps` below ~`35` bps to eliminate `A10` causes Gate G9 availability to collapse (at `refBandBps = 50` bps, first-call settlement drops to **84.02%**, failing the 95% Gate G9 requirement; at `refBandBps = 90`, `matchBandBps = 10`, Gate G9 passes at **99.40%** first-call on 500/503 rounds, `0.22` bps median / `16.94` bps max flow cost, `3.57h` median / `6.55h` p95 wait).

### Impact
Gate **G8 remains failed** on `contracts-0.9.0`: profitable MEV/arbitrage extraction remains open inside `refBandBps = 90` bps via slow multi-slot pool ramps (`A10`), and skipped internal matches in the `(10, 90]` bps band force full two-sided AMM execution through the skewed pool.

### Remediation
1. **Per-asset `refBandBps` and feed-anchored swap bounds:** configure tighter `refBandBps` on correlated/liquid pairs where Chainlink cadence is fast, and test `LEG_PRICE_FEED_ONLY` (`ap.buyPerToken` / `ap.sellPerToken` anchored strictly to `feedPrice`, eliminating TWAP drag from swap limits while leaving `TwapVsFeed` only for spot-vs-TWAP defense).
2. **Match at `navFeed` (within `matchBandBps`):** evaluate booking the internal whole match at `navFeed` rather than `navTwap` (with `matchBandBps` widened cautiously) so opposing user flows continue netting internally without touching skewed pools in the `(10, 90]` bps zone, provided Chainlink feed freshness/sequencing guarantees suffice.
3. **Batch auction / RFQ settlement or randomized execution slot** to raise arbitrage holding cost beyond `refBandBps`.

---

## AGY-07 [MEDIUM]: `INV-2` Custody Violation on Deactivated Basket Assets and Non-Reusable `MAX_FUND_ASSETS = 12` Slots

### Location
- [FundFlowsLib.sol#L314-L325](../../../contracts/lib/FundFlowsLib.sol#L314-L325) (`_sweepForeign`)
- [FundAdminLib.sol#L110-L142,L578-L587](../../../contracts/lib/FundAdminLib.sol#L578-L587) (`addAsset`, `_deactivateAsset`)
- [FundTypes.sol#L26](../../../contracts/FundTypes.sol#L26) (`MAX_FUND_ASSETS = 12`)
- Compare canonical invariant: [smart-contract-invariants.md#L91-L92,L195-L196](../../technical/smart-contract-invariants.md#L195-L196) (`INV-2`, `LIFE-6`), [BasketSwaps.sol#L157-L175](../../../contracts/lib/BasketSwaps.sol#L157-L175) (`reabsorb`)

### Description
Two custody and lifecycle gaps diverge from `INV-2` and `LIFE-6`:

1. **Permanently stranded tokens on deactivated basket assets (`INV-2` / `LIFE-6`).**
   `_deactivateAsset` ([FundAdminLib.sol#L578-L586](../../../contracts/lib/FundAdminLib.sol#L578-L586)) allows deactivation whenever a non-`inSale` basket token balance has a slippage-adjusted TWAP value rounding to `0`:
   ```solidity
        } else {
            uint256 bal = IERC20(a.token).balanceOf(address(this));
            if (bal != 0) {
                uint256 floor =
                    FundValuationLib.usdcValue(s, i, bal) * (BPS - s.maxSlippageBps) / BPS;
                if (floor != 0) revert IRobotMoneyFund.AssetStillHeld(i);
            }
        }
        a.active = false;
   ```
   Once `a.active` becomes `false`, that balance—and **any** tokens transferred or airdropped to `RobotMoneyFund` afterwards—is excluded from `totalAssets()` and `redeemInKind`. Yet `_sweepForeign` unconditionally reverts `ProtectedToken(token)` for **every** index in `s.assets`, active or inactive:
   ```solidity
// contracts/lib/FundFlowsLib.sol:318-323
        uint256 n = s.assets.length;
        for (uint256 i; i < n; ++i) {
            if (token == s.assets[i].token || token == s.assets[i].adapter) {
                revert IRobotMoneyFund.ProtectedToken(token);
            }
        }
   ```
   Unlike `BasketVault`, which implements `reabsorbRemovedAsset` ([BasketSwaps.sol#L157-L175](../../../contracts/lib/BasketSwaps.sol#L157-L175)) to swap reappeared inactive-slot tokens back into NAV (or quarantine them on a broken pool), `RobotMoneyFund` exposes **no** `reabsorbRemovedAsset` function at all. Consequently, any balance remaining on or sent to a deactivated basket asset is permanently stranded inside `RobotMoneyFund` with zero recovery or redemption path.

2. **Permanent exhaustion of `MAX_FUND_ASSETS = 12`.**
   `FundAdminLib.addAsset` ([FundAdminLib.sol#L112-L125](../../../contracts/lib/FundAdminLib.sol#L112-L125)) strictly appends to `s.assets` and reverts `MaxAssetsReached()` once `s.assets.length >= 12` (`MAX_FUND_ASSETS = 12`). `_rejectDuplicate` ([FundAdminLib.sol#L128-L142](../../../contracts/lib/FundAdminLib.sol#L128-L142)) checks inactive entries for open lending position claims (`positionClaimTotal[i] != 0`) and otherwise permits re-adding by pushing a brand-new slot, consuming slots monotonically. Across historical asset rotations (or delist-then-relist cycles), the fund permanently exhausts its 12-asset cap.

### Impact
Violates `INV-2` ("no stranded assets") and `LIFE-6` for any deactivated basket asset balance (dust or post-removal transfer), and caps lifetime vault asset additions (plus historical inactive slots) at 12.

### Remediation
1. Implement `reabsorbRemovedAsset(uint256 index, uint256 minUsdcOut)` on `RobotMoneyFund` (porting `BasketSwaps.reabsorb`), requiring `!s.assets[index].active && s.assets[index].kind == AssetKind.Basket && s.delistClaimedTokens[index] == 0 && s.deferredTotal[index] == 0`, swapping non-dust balances to USDC under `max(twapFloor, minUsdcOut)` or sweeping to `ForeignTokenQuarantine` if the adapter/pool TWAP reverts.
2. When `addAsset` re-lists an existing asset whose previous slot `i` has `!active` and zero open claims/deferrals/exclusions/balance (or optionally allow reclaiming fully-settled inactive slots while guarding `openExclusionOf`, `delistTotalScaled`, `lendingClaimEpoch`, and historical `lastAssetPerShare`/`lastLendPerShare` indices), reuse or cleanly quarantine prior slot state—noting carefully that reusing an index requires resetting `lastLendPerShare[i]` / `lastAssetPerShare[i]` and guarding `FundExclusionLedger` historical IDs against index collision.

---

## AGY-13 [LOW]: `UniswapV3ExactOutSwapAdapter.isFixedFeePool` (and `UniswapV3SwapAdapter`) Lacks Canonical `IUniswapV3Factory.getPool` Check; Lending Adapter Summary

### Location
- [UniswapV3ExactOutSwapAdapter.sol#L87-L97](../../../contracts/adapters/UniswapV3ExactOutSwapAdapter.sol#L87-L97) (`isFixedFeePool`)
- [UniswapV3SwapAdapter.sol#L35-L124](../../../contracts/adapters/UniswapV3SwapAdapter.sol#L35-L124) (`swap`, `twapPrice`)
- Contrast: [AerodromeSwapAdapter.sol#L45,L71,L95,L138-L140](../../../contracts/adapters/AerodromeSwapAdapter.sol#L138-L140)
- Lending adapters: [AaveV3Adapter.sol](../../../contracts/adapters/AaveV3Adapter.sol), [CompoundV3Adapter.sol](../../../contracts/adapters/CompoundV3Adapter.sol), [MorphoAdapter.sol](../../../contracts/adapters/MorphoAdapter.sol)

### Description
`UniswapV3ExactOutSwapAdapter.isFixedFeePool(address pool)` validates immutable Uniswap V3 pool structure using only generic staticcall probes:

```solidity
// contracts/adapters/UniswapV3ExactOutSwapAdapter.sol:87-97
    function isFixedFeePool(address pool) external view returns (bool) {
        if (pool == address(0) || pool.code.length == 0) return false;
        (bool okFee, bytes memory feeData) =
            pool.staticcall(abi.encodeWithSelector(IUniswapV3Pool.fee.selector));
        if (!okFee || feeData.length != 32) return false;
        uint256 feePips = abi.decode(feeData, (uint256));
        if (feePips == 0 || feePips >= 1_000_000) return false;
        (bool okSlot0, bytes memory slot0Data) =
            pool.staticcall(abi.encodeWithSelector(IUniswapV3Pool.slot0.selector));
        return okSlot0 && slot0Data.length == 224;
    }
```

Unlike [AerodromeSwapAdapter.sol#L45,L138-L140](../../../contracts/adapters/AerodromeSwapAdapter.sol#L138-L140) (and [AerodromeExactOutSwapAdapter.sol#L61](../../../contracts/adapters/AerodromeExactOutSwapAdapter.sol#L61)), which store `IAerodromeCLFactory public immutable FACTORY` and check `FACTORY.getPool(baseToken, quoteToken, tickSpacing) == pool` (`PoolFactoryMismatch`), neither `UniswapV3SwapAdapter` nor `UniswapV3ExactOutSwapAdapter` binds a canonical `IUniswapV3Factory`.

Because `isFixedFeePool` never queries `pool.token0()`, `pool.token1()`, or `FACTORY.getPool(token0, token1, fee)`, a misconfigured governance transaction could admit a non-canonical contract implementing `fee()` and a 7-word `slot0()` (or a pool whose `token0`/`token1`/`fee` differs from the router's canonical factory pool, breaking `ORA-3` alignment between `twapPrice(pool)` and `ROUTER.exactInputSingle` / `exactOutputSingle`).

#### Lending Adapter Safety Check Summary
Inspected [AaveV3Adapter.sol](../../../contracts/adapters/AaveV3Adapter.sol), [CompoundV3Adapter.sol](../../../contracts/adapters/CompoundV3Adapter.sol), and [MorphoAdapter.sol](../../../contracts/adapters/MorphoAdapter.sol):
- **Access control & recipient safety (`ADP-4` / `INV-1`):** All mutating operations (`deploy`, `withdraw`, `withdrawAll`, `setMaxExposure`) are `onlyVault` (`msg.sender != VAULT` reverts), always transfer USDC back exclusively to `VAULT`, and have no arbitrary recipient or `rescueTokens` path.
- **Approval hygiene (`ADP-5` / `NC-12`):** Every `deploy` (and Morpho `withdraw` / Aave & Compound setups where relevant) resets allowance to `0` after the call via `IERC20(USDC).forceApprove(target, 0)` (Compound Comet `supply` pulls directly using constructor-approved or per-call reset—verified `forceApprove(address(COMET), 0)` in `CompoundV3Adapter.sol:88`, and zero `.approve()` calls across all adapters).
- **Direct deployment policy (`ADR-0014` / `ADR-0019`):** All three remain non-proxied direct deployments, replaceable only via `setAdapterCodeHashAllowed(..., false)` + `FundExclusionLedger` recovery.
- **Audit gap note:** Standalone read adapters (`AaveV3RateAdapter.sol`, `CompoundV3RateAdapter.sol`, `MorphoRateAdapter.sol`) and both ExactOut swap adapters (`UniswapV3ExactOutSwapAdapter.sol`, `UniswapV3ExactOutSwapAdapterUpgradeable.sol`, `AerodromeExactOutSwapAdapter.sol`) are listed as `Not separately audited` in [docs/audits.md#L138-L143](../../audits.md#L138-L143).

### Impact
Low severity due to `ADMIN_ROLE` / `TimelockController` gating on `addAsset` and `setAssetAdapter`, but leaves configuration verification weaker than `AerodromeSwapAdapter` and omits on-chain defense against non-factory spoofed V3 pools.

### Remediation
Store `IUniswapV3Factory public immutable FACTORY;` in `UniswapV3SwapAdapter` (and upgradeable variant) and enforce `FACTORY.getPool(t0, t1, feePips) == pool` inside `isFixedFeePool(pool)` (as well as in `twapPrice`, matching `AerodromeSwapAdapter.sol:138-140`).
