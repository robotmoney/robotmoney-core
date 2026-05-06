# Issue — OWS broadcast is pinned to a single RPC endpoint; falls back to drpc.org even when the fallback pool is healthy

> Summary: viem's `fallback()` transport handles read-path resilience across five free Base endpoints. But `execute-*` commands must supply a single concrete URL to OWS's `signAndSend` function, which broadcasts and waits for receipts. `resolveBroadcastRpcUrl` in `lib/execute.ts` hard-codes `BASE_RPC_POOL[0]` (`https://base.drpc.org`) as the fallback. If drpc.org is down or rate-limiting at broadcast time, the transaction fails — even if the other four pool endpoints are healthy and reads are working fine. Read-path resilience and broadcast-path resilience are decoupled, so a targeted outage on drpc.org breaks execution without breaking reads.

## 1. Severity

**Medium.** drpc.org has been reliable in practice. The risk is an unlucky coincidence: a deposit attempt during a drpc.org outage or aggressive rate-limit window. The failure mode is a hard error *after* the gas estimate and simulation pass (which use the fallback pool), so the operator has already committed to the operation. This is confusing and forces a manual retry.

## 2. Background

`lib/execute.ts` `resolveBroadcastRpcUrl`:

```typescript
export async function resolveBroadcastRpcUrl(flags: {
  chain: 'base';
  rpcUrl?: string | undefined;
}): Promise<string> {
  const resolved = resolveRpcUrl(flags);
  // OWS needs a concrete URL to broadcast against; when we're on the fallback
  // pool, pick the first entry. viem's fallback transport handles read-path
  // retries, but signAndSend wants a single URL.
  if (resolved.url) return resolved.url;
  return 'https://base.drpc.org';
}
```

The comment acknowledges the design constraint: OWS's `signAndSend` takes a single URL. The fix is in how Robot Money resolves *which* URL to hand OWS.

## 3. Evidence

`lib/rpc.ts` `BASE_RPC_POOL`:

```typescript
const BASE_RPC_POOL = [
  'https://base.drpc.org',        // ← hardcoded fallback in resolveBroadcastRpcUrl
  'https://base-rpc.publicnode.com',
  'https://base.llamarpc.com',
  'https://base.meowrpc.com',
  'https://1rpc.io/base',
];
```

If any of the other four endpoints is reachable and drpc.org is not, `resolveBroadcastRpcUrl` still returns drpc.org and OWS's broadcast will fail.

Additionally: if the user supplied `--rpc-url` or `RPC_URL`, that URL is used for broadcasts (correct). The problem only affects the pool-default path.

## 4. Proposed resolution

**4.1 Health-check and rotate broadcast endpoint**

Before handing a URL to OWS, probe the candidates in order and pick the first one that responds:

```typescript
export async function resolveBroadcastRpcUrl(flags): Promise<string> {
  const resolved = resolveRpcUrl(flags);
  if (resolved.url) return resolved.url;

  // Try pool endpoints in order; return first that passes a lightweight probe.
  for (const url of BASE_RPC_POOL) {
    const ok = await probeRpc(url); // eth_blockNumber with 2s timeout
    if (ok) return url;
  }
  // All failed — return primary anyway and let OWS surface the error.
  return BASE_RPC_POOL[0]!;
}
```

`probeRpc` fires an `eth_blockNumber` with a 2-second timeout. The probe adds at most one round-trip of latency on the happy path (drpc.org is healthy, probe passes immediately) and finds a live endpoint on the unhappy path rather than hard-coding the first.

**4.2 Alternatively: OWS broadcast retry loop**

Wrap `owsSignAndSend` in a retry that, on broadcast timeout or connection error, picks the next pool endpoint and retries. This is more complex but handles mid-broadcast failures (the endpoint goes down after the probe but before receipt confirmation).

**4.3 Minimum fix: rotate rather than hard-code**

If neither 4.1 nor 4.2 is acceptable complexity, at least randomise the initial pick within the pool rather than always using index 0. This distributes broadcast load and reduces correlated failures when drpc.org specifically has issues.

## 5. Acceptance criteria

- If `BASE_RPC_POOL[0]` is unreachable, `execute-*` selects a working pool endpoint rather than failing.
- The probe adds no perceptible latency when the primary endpoint is healthy (≤ 200ms for a local probe).
- If `--rpc-url` or `RPC_URL` is set, that URL is used without probing (current behaviour preserved).
- Unit test: mock all pool endpoints except `BASE_RPC_POOL[2]` as failing; assert that `resolveBroadcastRpcUrl` returns `BASE_RPC_POOL[2]`.

## 6. Open questions

- **Probe cost vs. benefit.** The probe adds one RPC round-trip per `execute-*` invocation even when nothing is wrong. Is this acceptable? For a device making dozens of small daily deposits, yes. For a human doing a one-off deposit interactively, the added latency may be noticeable.
- **Mid-broadcast failure.** If the endpoint goes down after signing starts but before receipt confirmation, `waitForTransactionReceipt` will hang or timeout. Should the CLI retry receipt polling on a different endpoint? This is a deeper resilience question independent of the broadcast URL selection.

## 7. References

- Broadcast URL resolution: [`../../packages/cli/src/lib/execute.ts`](../../packages/cli/src/lib/execute.ts) `resolveBroadcastRpcUrl`
- RPC pool: [`../../packages/cli/src/lib/rpc.ts`](../../packages/cli/src/lib/rpc.ts)
- Data sources analysis: [`data-sources.md`](data-sources.md) §5
