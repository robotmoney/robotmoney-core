# Recorder manipulation: a held price drags the USDC sell floor (core 1793)

## Status
- Decision: **HIGH before the fix** by the QA plan bar (decision D2: a loss of 5 percent of a redeem within 30 minutes, at the ADR-0005 pool depth). A held 600-tick push costs about 3 USDC and makes every USDC redeem in the window sell RM 5.8 percent under the honest price.
- Fix shipped (QA plan D5): a **USDC sell anchor** on `BasketVault.redeem`. Within 30 minutes of the start of a hold, no USDC redeem can execute more than 4.5 percent under the pre-hold price. That is under the bar.
- Residual: a hold longer than about 49 minutes passes the bar again, and a hold of 4 hours or more is the market price as far as any on-chain TWAP can tell. Cap sizing (ADR-0005) stays the bound on total exposure. A stronger price source stays the owner's later decision.
- The keeper (core 1779) is liveness, not a defence. It records the held price like any honest price.
- Evidence: the numbers below come from the shipped constants and the tick arithmetic. The tests that assert them are written (see Tests). Under the QA plan they run in phase Q, not in this change. The fork test logs the live pool depth and the attack's real cost when it runs.

## Production configuration
| Item | Value | Source |
|---|---|---|
| Pool | Uniswap V4 RM/USDC, fee 29100 (2.91 percent), tickSpacing 582, no hook | `config/agent-token-shortlist.json` |
| Depth | in-range L about 9.8e17, a virtual reserve of about 1,750 USDC at spot (2026-10-08 pin) | ADR-0005 amendment 2026-10-08 |
| Recorder clamp | 10 ticks per elapsed second, elapsed capped at 60 s: at most 600 ticks (6.2 percent) per record | `UniswapV4PriceRecorder.sol:59-62,293-302` |
| Lagged tick, staleness | an interval is weighted by the previous recorded tick; `observe` reverts after 1800 s without a record | `UniswapV4PriceRecorder.sol:160-162,211` |
| NAV and sell floor window | 1800 s (`DEFAULT_TWAP_WINDOW`) | `BasketVault.sol` |
| Sell floor | TWAP value x (1 - `maxSlippageBps`), with `maxSlippageBps` 500 | `BasketVault._slippageFloor` |
| ORA-4 guard | `navDeviationGuardBps` 400 (pool fee 291 plus a lag budget) | QA plan decision D10, twin sheet |
| Single swap limit | about 18 USDC at the 5 percent bound | ADR-0005 amendment |
| Keeper cadence | one `record()` every 300 s | core 1779, `scripts/ops/recorder-keeper.sh` |
| Recorder ring | 901 slots before this change, 7,201 after | `DeployUniswapV4PriceRecorder.RING_SLOTS` |

## The attack (finding E1)
1. **Push.** The attacker sells RM until the pool sits 600 ticks under the honest price. At the 2026-10-08 depth that is about 55 USDC of RM. It pays out about 51.7 USDC and costs one pool fee, about 1.6 USDC.
2. **Record.** Any `record()` 60 s or more after the last one moves the recorded tick the full 600. The attacker can call it, and the keeper calls it within 300 s anyway.
3. **Drag.** The 1800 s mean moves onto the held price over one window. The sell floor moves with it, because it is that mean less 5 percent.
4. **Sell.** A USDC redeem sells RM at the live price. The floor admits the sale once the live price is within about 2.2 percent of the mean (500 bps slippage less the 291 bps fee). For a 600-tick hold that is about 19 minutes after the record. From then on every USDC redeem sells its RM leg at the held price, 5.8 percent under the honest one.
5. **Unwind.** The attacker buys back cheap RM, the redeemers' RM included. The round trip costs about two pool fees on 53 USDC: about 3.1 USDC.
6. **Walk.** With a record every 60 s the recorded tick moves 600 ticks a minute. A deeper hold drags the mean further in the same time. It costs more depth to push and to hold.

**Maximum profitable distortion before the fix.** The recorder does not bound it: within 30 minutes a hold drags the 1800 s floor by the whole held displacement. The pool depth bounds it. A 600-tick hold costs about 3.1 USDC and turns a profit once the RM redeemed by others during the hold is worth more than about 53 USDC (3.1 / 5.8 percent). The total is bounded by the vault's RM, so by `tvlCap`.

**Mint side.** Deposits keep the ORA-4 guard: they refuse while the live price sits more than 4 percent from the 1800 s mean, so the first part of any hold blocks deposits. Once the mean catches up, a depositor buys RM at the held price, which is the price any market buyer pays. Existing holders are not diluted, because shares mint on the realized NAV delta. This is unchanged.

## The fix: the USDC sell anchor
- `BasketVault.redeem` runs `BasketViews.checkSellAnchor` after the gas floor and before any sale. For each active Uniswap V4 leg the vault holds, it compares the live price with the leg's mean over `SELL_ANCHOR_WINDOW` (14,400 s, eight times the NAV window). It refuses with `SpotBelowSellAnchor(token, belowBps, thresholdBps)` when the live price sits more than `navDeviationGuardBps` under that mean. The vault ABI carries the same error.
- The holder's exit meanwhile is `redeemInKind`. It reads no price and is never blocked (ADR-0007, core 1665).
- Only the sell side is gated: a price above the anchor pays the redeemer more. Only V4 legs are gated: V3 and Aerodrome pools write their own per-block observations and are deep. A guard of 0 switches the anchor off with the ORA-4 guard.
- The recorder stage grows the ring to 7,201 slots (14,400 s / 2 s + 1). At one record per 2 s block nobody can evict the anchor's history. A younger recorder anchors on all the history it has. The anchor is then weaker, closer to the NAV window. A short history never makes a redeem revert.
- Bytecode: the deposit's ORA-4 check and the new check share one library call site (`BasketViews.checkMarket`). The vault family is 45 bytes smaller than before. `VaultCodeSizeGuard.t.sol` records the new headroom: 100 bytes for AgentTokenVault, 142 for ProtocolAssetVault and RwaBasketVault.

## The bound after the fix
A USDC redeem executes only when the live price is at least the anchor less the guard (408 ticks). A hold of X ticks that the recorder has carried for r seconds moves the anchor X x r / 14,400. The largest hold that still executes is 408 / (1 - r / 14,400) ticks.

| Hold carried by the recorder | Largest executable hold | Loss of a USDC redeem vs the honest price |
|---|---|---|
| 1,500 s (keeper first records after 300 s, checked at 30 min) | 456 ticks | 4.45 percent |
| 1,740 s (attacker records every 60 s, checked at 30 min) | 464 ticks | 4.54 percent |
| 2,940 s (49 min) | 513 ticks | 5.0 percent, the bar |
| 3,600 s (1 h) | 544 ticks | 5.3 percent |
| 7,200 s (2 h) | 816 ticks | 7.8 percent |
| 14,400 s (4 h) or more | no bound from the anchor | the held price |

The 600-tick hold of the plan, under the 300 s keeper, after 2,100 s:

| Measure | Before the fix | After the fix |
|---|---|---|
| 1800 s sell floor drop | 582 bps | 582 bps (the floor still drags) |
| 4 h anchor drop | n/a | 75 bps |
| Live price under the anchor | n/a | 511 bps, above the 400 bps guard |
| USDC redeem | executes at 5.8 percent under honest | refuses `SpotBelowSellAnchor`; `redeemInKind` pays |
| Lowest live price a USDC sale can execute at, under the pre-hold price | 785 bps (the dragged floor less the fee) | 472 bps (the anchor less the guard) |

The profit threshold after the fix: at the worst 30-minute case of 4.54 percent, the hold pays once about 68 USDC of RM is redeemed by others in the window, against 53 USDC before. The fix lowers the rate and stretches the hold. It does not make a long hold unprofitable.

## Liveness cost
A genuine fall of RM by more than 4 percent under its 4 hour mean refuses USDC redeems until the mean catches up or the price recovers: at most 4 hours. Holders use `redeemInKind` meanwhile. A router `redeemFor` that names the rmAGENT leg reverts in that period. The caller passes 0 shares for that leg and exits it in kind. `maxRedeem` still reports the full balance, as it does for the slippage and stale-recorder reverts that ADR-0007 accepts: the in-kind exit is the one that never refuses.

## Residual risks
1. **Long holds.** From about 49 minutes the loss passes 5 percent, and from 4 hours the anchor no longer separates a held price from a real one. The bound is the hold's cost and the vault caps. Size `perDepositCap` and `tvlCap` below the pool's depth (ADR-0005). A hooked oracle pool or another stronger price source is the owner's later, separate decision.
2. **`reabsorbRemovedAsset`.** It is permissionless and sells a removed asset's whole balance at the 1800 s floor. It is not gated. It matters only for a removed V4 asset that holds a balance (a donation or dust).
3. **`emergencyUnwind`.** It is not gated. `EMERGENCY_ROLE` chooses its timing.
4. **The Base mainnet test deployment.** The rmAGENT vault at `0x22bD48C56c34A2C1C1baC77BD7c4E636a6f10D57` predates this fix and keeps the E1 exposure until it is redeployed. Contain it through its caps. Its recorder at `0x0aDc14e6521aF213F9DCe5585D530f237831E934` has a 901-slot ring. Anyone can call `grow(7201)` on it.

## Keeper (core 1779)
- A cadence of 300 s is right for liveness: `observe` reverts after 1800 s without a record. A faster cadence gives no defence, because the keeper records whatever price the pool holds.
- The production ring is 7,201 slots. This answers core 1779's scope line "Cadence and the production ring size are chosen with the result of core 1793", which can now be removed.

## Tests
| Test | What it shows |
|---|---|
| `RecorderManipulationFork.t.sol::test_recorder_heldDisplacementDragsSellFloorUnderKeeperCadence` | Twin fork of real Base, the shipped recorder stage, a real push of at least 600 ticks, the 300 s keeper for 2,100 s: the 1800 s floor drops past 5 percent, the anchor moves at most 1 percent, the USDC redeem refuses, `redeemInKind` pays. Logs the live depth, the push size and the push-and-unwind cost. |
| `RecorderSellAnchor.t.sol::test_sellAnchor_heldDisplacementUnderKeeperCadenceRefusesUsdcRedeem` | The same run on the mock pool with the exact figures of the table above. |
| `RecorderSellAnchor.t.sol::test_sellAnchor_withTheGuardOffTheDraggedFloorPaysTheHeldPrice` | The behaviour before the fix: the redeem sells 5.8 percent under honest. |
| `RecorderSellAnchor.t.sol::testFuzz_sellAnchor_usdcRedeemWithin30MinutesOfAHoldLosesUnderFivePercent` | For any hold of 1 to 3,000 ticks and either record cadence, a USDC redeem 30 minutes in refuses or loses under 5 percent. |
| `RecorderSellAnchor.t.sol` (other cases) | A hold inside the guard still redeems in USDC. A price above the anchor is never refused. A young recorder anchors on its history. A guard of 0 turns the anchor off. |
| `DeployUniswapV4PriceRecorder.t.sol` | The recorder stage grows the ring to 7,201 slots. |
