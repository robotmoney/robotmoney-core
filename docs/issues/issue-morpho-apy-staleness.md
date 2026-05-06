# Issue — Morpho APY has no staleness signal; stale rates are indistinguishable from fresh ones

> Summary: `get-apy` fetches Morpho's `netApy` from `api.morpho.org/graphql`. The API response contains no `updatedAt`, `computedAt`, or cache-age field. The CLI cannot tell whether the returned APY was computed seconds ago or hours ago. Under market stress — when lending rates spike or collapse rapidly — a stale APY figure materially misrepresents the vault's current yield and could cause agents to make allocation decisions based on incorrect data. The blended APY output has no way to warn callers that the Morpho component may be stale.

## 1. Severity

**Low–Medium.** In normal market conditions APY moves slowly and staleness of a few hours is immaterial. During a rate event (mass borrowing, liquidity crunch, protocol exploit at an underlying venue) the rate can move significantly within an hour. Since `get-apy` is the primary signal agents use to evaluate the vault's yield, silent staleness is a trust gap even if it rarely causes harm.

## 2. Background

`lib/morpho-apy.ts` queries:

```graphql
query VaultApy($address: String!, $chainId: Int!) {
  vaultByAddress(address: $address, chainId: $chainId) {
    state { netApy apy totalAssets }
  }
}
```

The `state` object contains `netApy` but no timestamp. The CLI logs the source (`primary` or `fallback`) but not when the data was produced. An agent calling `get-apy` cannot determine whether the value is current.

Contrast with the Aave and Compound APY reads (§1.6, §1.7 of `data-sources.md`): those are live on-chain reads via `getReserveData` and `getSupplyRate`, so they always reflect the state at the queried block. The Morpho figure is the only off-chain APY in the blend and therefore the only one that can be stale.

## 3. Evidence

`lib/morpho-apy.ts` response handling:

```typescript
const apy = body.data?.vaultByAddress?.state?.netApy;
if (typeof apy !== 'number' || !Number.isFinite(apy)) return null;
return apy;
```

No timestamp field extracted. No cache-control header inspection. No `If-Modified-Since` or ETag handling. The 8-second timeout is the only freshness mechanism — it ensures the request doesn't hang, not that the data is recent.

`get-apy` output:

```json
{
  "adapters": [
    { "protocol": "Morpho Gauntlet USDC Prime", "apy": "0.0521", ... }
  ]
}
```

No `dataTimestamp`, no `source`, no staleness warning for the Morpho entry specifically.

## 4. Proposed resolution

**4.1 Expose data freshness in `get-apy` output**

Check whether the Morpho GraphQL API returns any freshness metadata in the response (e.g. a `lastUpdated` field, HTTP `Age` or `Last-Modified` headers). If available, surface it:

```json
{
  "adapters": [
    {
      "protocol": "Morpho Gauntlet USDC Prime",
      "apy": "0.0521",
      "dataSource": "morpho-api",
      "dataTimestamp": "2026-04-29T01:45:00Z",
      "dataAgeSeconds": 900
    }
  ]
}
```

**4.2 Fallback to on-chain Morpho rate**

If the API returns no timestamp, or if `dataAgeSeconds` exceeds a threshold (e.g. 3600s), fall back to reading the Morpho vault's supply APY directly on-chain. The Morpho Blue vault at `MORPHO_GAUNTLET_USDC_PRIME_BASE` exposes a `supplyRate()` or equivalent function that can be read directly without the GraphQL API. This would make the Morpho APY consistent with the on-chain-only approach used for Aave and Compound.

The GraphQL `netApy` is preferred because it accounts for Morpho's protocol fee (hence "net"); the on-chain rate is gross. If falling back to on-chain, label it `grossApy` and add an `apyNote` explaining the distinction.

**4.3 Surface staleness as a warning**

If no timestamp is available from the API and no on-chain fallback is implemented, at minimum add a field:

```json
{ "morphoApyNote": "APY from Morpho API; freshness unverified. On-chain rate preferred for time-sensitive decisions." }
```

## 5. Acceptance criteria

- `get-apy` output for the Morpho adapter includes either a `dataTimestamp` (if the API exposes it) or an `apyNote` explaining that freshness is unverified.
- If on-chain Morpho rate fallback is implemented, it is labeled `grossApy` and the `dataSource` is `"on-chain"`.
- Existing tests remain green; new unit test asserts the freshness field is present in Morpho adapter output.

## 6. Open questions

- **Does `api.morpho.org/graphql` expose a freshness field?** This needs a live query inspection. The current query only requests `netApy apy totalAssets` — expanding it to include `updatedAt` or similar may resolve the issue entirely.
- **On-chain Morpho supply rate.** What function and ABI are needed to read the raw supply APY from the Gauntlet USDC Prime vault on-chain? This requires inspecting the Morpho Blue vault ABI, which is not currently in `lib/abi.ts`.

## 7. References

- Morpho APY fetch: [`../../packages/cli/src/lib/morpho-apy.ts`](../../packages/cli/src/lib/morpho-apy.ts)
- Data sources analysis: [`data-sources.md`](data-sources.md) §2.1, §6.5
- Related: [`issue-get-vault-fees-incomplete.md`](issue-get-vault-fees-incomplete.md)
