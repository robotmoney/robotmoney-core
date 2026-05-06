# Issue — V4 dynamic fee is not pre-known; uniform 3% slippage is too loose for V3 and potentially too tight for V4

> Summary: The ROBOT basket token routes through a Uniswap V4 pool with a Doppler dynamic-fee hook that can set an effective fee up to 80% during high volatility. The V4 quoter returns an `amountOut` reflecting the hook's *current* fee, but the fee can change between quote time and execution. The 3% uniform `DEFAULT_SLIPPAGE_BPS = 300` is a compromise: adequate for normal V4 conditions but potentially insufficient during a fee spike, and excessively loose for the other five tokens which use V3 pools where 0.5–1% would be appropriate. There is no per-token or per-pool slippage configuration exposed to callers.

## 1. Severity

**Low–Medium.** At current basket allocation sizes (5% of a $100–$5,000 deposit → $5–$250 per leg), even an 80% V4 fee spike would not cause the transaction to fail — the quote would simply be very unfavourable. The real risk is a bad fill for ROBOT during a volatile period that the agent accepted because slippage was too loose. For larger future allocations this becomes more material.

## 2. Background

`lib/basket/constants.ts`:

```typescript
export const DEFAULT_SLIPPAGE_BPS = 300; // 3%
// Note: The ROBOT V4 pool uses a Clanker/Doppler dynamic-fee hook that can
// spike fees up to 80% during volatility — this is why the default is 3%
// rather than a tighter V3-appropriate value.
```

The comment acknowledges the design compromise. Three problems follow:

1. **V3 tokens over-slippaged.** VIRTUAL, BNKR, JUNO, ZFI, GIZA all use V3 pools with fixed fees (500–10,000 bps). For these, 3% slippage is generous — a tighter default (0.5–1%) would reduce the range of bad fills an agent silently accepts.

2. **V4 ROBOT potentially under-slippaged.** If the Doppler hook pushes the effective fee above 3% at execution time (possible up to ~80%), the transaction reverts on slippage and the basket leg fails. The vault leg and other basket tokens land independently; only ROBOT is skipped.

3. **No per-pool slippage config.** The `--slippage-bps` flag applies uniformly to all legs. There is no way to set tighter slippage for V3 legs and looser for the V4 leg in a single command invocation.

## 3. Evidence

`lib/basket/constants.ts`:

```typescript
export const DEFAULT_SLIPPAGE_BPS = 300;
```

`lib/basket/quoter.ts` — V4 quote via `quoteExactInputSingle`: returns `amountOut` at current hook fee, but the hook fee is not returned to the caller; it is embedded in the output amount. There is no way to inspect the fee that was applied to the quote.

`lib/basket/leg-builders.ts`: `applySlippage(amountOut, slippageBps)` applies the same `slippageBps` to every basket token's `minAmountOut`, regardless of whether the pool is V3 or V4.

## 4. Proposed resolution

**4.1 Per-token slippage in `--slippage-bps`**

Extend `--slippage-bps` to accept a per-token override syntax:

```bash
# Uniform (current)
--slippage-bps 300

# Per-token (proposed)
--slippage-bps "VIRTUAL=50,ROBOT=500,default=100"
```

This lets callers set tight slippage for V3 legs and loose for ROBOT without affecting others.

**4.2 Default per-pool slippage in basket constants**

Add a `defaultSlippageBps` field to each `BasketTokenConfig` in `lib/basket/constants.ts`:

```typescript
{ symbol: 'VIRTUAL', ..., defaultSlippageBps: 50 },   // V3 fee=3000, liquid
{ symbol: 'ROBOT',   ..., defaultSlippageBps: 500 },  // V4 dynamic fee up to 80%
{ symbol: 'BNKR',   ..., defaultSlippageBps: 100 },   // V3 fee=10000, thin
```

When `--slippage-bps` is not specified, each leg uses its token's `defaultSlippageBps`. The uniform `DEFAULT_SLIPPAGE_BPS` becomes a fallback for tokens without an explicit default.

**4.3 Expose V4 applied fee in quote output**

Attempt to retrieve the effective fee used in the V4 quote. The Doppler hook may expose a `getFee(poolId)` function. If available, include it in the prepare-* output alongside the quote so callers can see the fee that was baked into the `minAmountOut`:

```json
{
  "symbol": "ROBOT",
  "amountOut": "1234567890000000000",
  "minAmountOut": "1172839395000000000",
  "effectiveFeeBps": 350,
  "slippageBps": 500
}
```

## 5. Acceptance criteria

- `DEFAULT_SLIPPAGE_BPS` in `lib/basket/constants.ts` is replaced with per-token defaults; each `BasketTokenConfig` carries its own `defaultSlippageBps`.
- `--slippage-bps` continues to accept a single integer (uniform override) and additionally accepts a per-token string (v2 syntax).
- `prepare-deposit` and `execute-deposit` output includes `effectiveFeeBps` in each basket quote if the V4 quoter exposes it.
- Unit tests for `applySlippage` and basket leg builders updated to assert per-token slippage is applied correctly.
- `SKILL.md` updated to note that `--slippage-bps 500` (or higher) is recommended for volatile markets, particularly for the ROBOT leg.

## 6. Open questions

- **Does the Doppler hook expose `getFee(poolId)`?** This requires inspecting the hook ABI at `0xbB7784A4d481184283Ed89619A3e3ed143e1Adc0`. If it does, the effective fee can be read before quoting and used to set ROBOT's slippage dynamically.
- **Re-quote on V4 failure.** Should `execute-deposit` automatically retry the ROBOT leg with a wider slippage if it reverts? This adds complexity but would improve reliability in volatile conditions.
- **Thin V3 pools.** BNKR, ZFI, GIZA use `fee=10000` (1%) pools which may have thin liquidity. For these, tighter slippage might actually increase revert risk. The per-token defaults should be informed by live pool depth analysis, not guessed.

## 7. References

- Basket constants and slippage default: [`../../packages/cli/src/lib/basket/constants.ts`](../../packages/cli/src/lib/basket/constants.ts)
- V4 quoter: [`../../packages/cli/src/lib/basket/quoter.ts`](../../packages/cli/src/lib/basket/quoter.ts)
- Slippage application: [`../../packages/cli/src/lib/basket/leg-builders.ts`](../../packages/cli/src/lib/basket/leg-builders.ts)
- Data sources analysis: [`data-sources.md`](data-sources.md) §6.7
