# V4 recorder sampling: economic assessment (core issue 1793)

Date: 2026-10-14. Closes the open review item "V4 sampling" in `20261012-security-review.md` (PR 1787).

Evidence: `contracts/test/V4RecorderSamplingEconomicsFork.t.sol`, run in CI job `forge-fork-vault-regressions` on the Twin chain (a pinned lazy fork of real Base).

## Severity decision

**Informational for the shipped configuration (Base mainnet test, caps 100 USDC TVL and 15 USDC per deposit, keeper every 240 s).**
**Low (availability only) when no honest `record()` lands for a full window.**
No contract change is needed before the result. The keeper cadence (240 s) and the ring size (901) stay as they are.

## What the test drives

It forks Base and drives the deployed objects, not mocks. The deployed rmAGENT vault (`0x22bD48C56c34A2C1C1baC77BD7c4E636a6f10D57`), the deployed recorder (`0x0aDc14e6521aF213F9DCe5585D530f237831E934`), the deployed V4 adapter and the live RM/USDC 2.91% V4 pool. The setup asserts the production values, so a governance change fails the test instead of leaving this report stale: NAV deviation guard 100 bps, swap bound 500 bps, per-deposit cap 15 USDC, TVL cap 100 USDC, ring 901 slots.

Existing holders are modelled as 80 USDC of RM held by the vault. The attacker samples the recorder with real swaps through the adapter, so the swap fee and the price impact of the attack are inside every number. The fork has no arbitrageurs. Every cost below is therefore a lower bound.

## Results (pool at the time of measurement: L about 9.8e17, about 1,800 USDC of virtual depth)

| Case | Measured |
|---|---|
| One sample, no honest record for 1,790 s | Recorded tick moves by the full clamp (600 ticks). The NAV mark is wrong by +614 bps. Deposits revert `NavMarketDeviationExceeded`. `redeemInKind` still pays. |
| Keeper every 240 s, best single sample (push in the keeper block, record 60 s later, full clamp, pool restored) | NAV mark error +60 bps (push up) or -61 bps (push down) when the attacker deposits. Both are inside the 100 bps guard. |
| Same, attack cost (fees plus impact of pushing 660 ticks and back) | 3.50 USDC (up), 3.76 USDC (down) |
| Same, gross benefit before attack cost | -0.05 USDC (up), -0.001 USDC (down). No benefit at all. |
| Same, attacker net against a no-attack baseline | -3.55 USDC (up), -3.76 USDC (down) |
| Mint fairness gap (attacker share of supply minus share of RM it contributed) | 0 bps in both directions |

## Why the distortion has no profit path

1. **The mint is ratio based.** `BasketVault._deposit` mints `realizedDelta * (supply + 1e18) / (taBefore + 1)`. In a vault whose value is RM, both `realizedDelta` and `taBefore` are priced by the same TWAP, so a mark error cancels. The test measures a fairness gap of 0 bps.
2. **Redeem pays what the pool pays.** `_sellProportional` sells the redeemer's pro-rata RM into the pool. The NAV mark does not set the payout. It only sets the 500 bps swap floor.
3. **The deposit guard bounds the usable error.** The guard reverts when spot and TWAP differ by more than 100 bps. At the 240 s cadence the largest mark error is 600 ticks times 180 s over 1,800 s, about 60 bps.
4. **Cost scales with pool depth, benefit does not.** Moving the pool 660 ticks costs the 2.91% fee on about 55 USDC each way plus impact. That is more than 3 USDC against a gross benefit of zero.

## Residual risks

- **Idle USDC in the vault.** Idle USDC is priced at par, so it breaks the cancellation in point 1. The gain is bounded by (idle fraction) x (mark error) x (deposit). Production holds no idle USDC because every deposit is swapped. Idle USDC appears only after `emergencyUnwind` followed by `unpauseDeposits`. At 60 bps error and a 15 USDC deposit the bound is 0.09 USDC even with a fully idle vault.
- **Availability when the keeper is down.** Without an honest record the mark error reaches about 614 bps. Deposits then revert and a USDC redeem can hit its swap floor, which is the severity Low case. `redeemInKind` needs no oracle and still pays, and any `record()` clears the lag. The keeper alert `recorder_stale` already covers it.
- **Sustained displacement.** An attacker who holds the pool off-price for a full window drags the mean at up to 10 ticks per second. The cost is the pool depth (about 55 USDC of capital at risk to arbitrageurs for a 6% hold, plus the fee to enter and leave). The TVL cap of 100 USDC keeps the possible gain far below it. This is the documented bound: `perDepositCap` and `tvlCap` must stay below the pool depth. Raising either cap needs this test rerun.
- **Thin pool.** Fifteen USDC moves the live pool about 1.7%. This is not an attack. It means a deposit can briefly trip the 100 bps guard for the next depositor until the next keeper record.

## Cadence and ring size

The measurement confirms the 240 s default of `scripts/ops/recorder-keeper.sh`. The mark error scales with the time since the last honest record, so a longer interval raises it linearly. The error is about 600 x (interval - 60) / 1,800 bps. At 240 s it is 60 bps. At 360 s it would be 100 bps, which is the guard. Keep the interval at or below 240 s. The ring size of 901 does not change the result, because the exposure is set by the cadence and the clamp, not by the number of slots.

## Revisit when

Either cap rises, the pool depth falls below roughly 10 times the TVL cap, a second asset joins the rmAGENT basket, or the keeper interval grows. Rerun the fork test and update this note.
