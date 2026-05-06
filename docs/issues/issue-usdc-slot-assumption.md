# Issue — USDC storage slot 10 assumption is unverified at runtime; a proxy upgrade silently breaks simulation

> Summary: `lib/storage-slots.ts` hard-codes `USDC_ALLOWANCE_MAPPING_SLOT = 10` — the storage slot of the `allowed` mapping in Circle's FiatTokenV2_2 proxy implementation on Base. This slot is injected into `eth_call`'s `stateOverride` so that `vault.deposit` simulation produces a correct gas estimate on first deposit (before any real USDC approval is on-chain). The slot was verified at a point in time but is never re-verified at runtime. If Circle upgrades the proxy implementation and moves the mapping, simulation silently produces a near-zero gas estimate instead of the real ~1.8M gas figure, causing `execute-deposit` to underestimate gas and fail at broadcast — with a misleading error message that does not identify the root cause.

## 1. Severity

**Medium.** The slot has been stable across FiatTokenV2 and FiatTokenV2_1 and FiatTokenV2_2 on all chains Circle has deployed to. The risk of a silent slot change is low in the short term. However, the failure mode when it does occur — a silent, wrong gas estimate — is hard to diagnose and could cause fund loss (tx submitted with insufficient gas, reverts, gas is consumed). Given that this is the simulation path for every first-time depositor, the blast radius of a wrong slot is broad.

## 2. Background

`lib/storage-slots.ts` documents the derivation:

```typescript
// USDC on Base is a Circle FiatTokenV2_2 proxy. The `allowed` mapping
// lives at storage slot 10 of the implementation.
// Verified by computing keccak256(pad32(spender) ++ keccak256(pad32(owner) ++ pad32(10)))
// for a known allowance and comparing eth_getStorageAt against allowance(owner, spender).
export const USDC_ALLOWANCE_MAPPING_SLOT = 10;
```

This slot is used in `lib/simulate.ts` to build a `stateOverride` that pre-applies a synthetic USDC approval to the simulation call. Without this override, simulating `vault.deposit` before a real USDC approval reverts at the allowance check and reports a gas estimate of ~20k (the revert gas cost) rather than the real ~1.8M.

The comment says "verified" but the verification was done offline, not at CLI startup or at call time. No test asserts it against the live contract.

## 3. Evidence

`lib/storage-slots.ts`:

```typescript
export const USDC_ALLOWANCE_MAPPING_SLOT = 10;

export function usdcAllowanceSlot(owner: Address, spender: Address): Hex { ... }
```

`lib/simulate.ts`: uses `usdcAllowanceSlot` to build `stateOverride` entries.

`packages/cli/test/storage-slots.test.ts`: unit-tests the slot *math* (the keccak derivation) but does not call `eth_getStorageAt` against the live Base mainnet USDC contract to verify the slot value itself.

No CI job calls `eth_getStorageAt(USDC, usdcAllowanceSlot(knownOwner, knownSpender))` and asserts it equals `allowance(knownOwner, knownSpender)`.

## 4. Proposed resolution

**4.1 Runtime verification on first use (recommended)**

Add a one-time verification call when building the stateOverride: read `eth_getStorageAt(USDC, slot(owner, spender))` and compare to `USDC.allowance(owner, spender)`. If they differ, log a warning and skip the stateOverride (falling back to the inaccurate simulation) rather than silently injecting a wrong value.

```typescript
async function verifyAllowanceSlot(client, usdc, owner, spender): Promise<boolean> {
  const [stored, actual] = await Promise.all([
    client.getStorageAt({ address: usdc, slot: usdcAllowanceSlot(owner, spender) }),
    client.readContract({ address: usdc, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] }),
  ]);
  return BigInt(stored ?? '0x0') === actual;
}
```

If the slot is wrong, emit a `simulation.warning` field: `"USDC storage slot mismatch — simulation gas estimate may be too low for first deposit."` This is better than a hard error (the command can still proceed) and is self-diagnosing.

**4.2 Fork-test assertion in CI**

Add a fork test that pins a Base mainnet block and asserts `eth_getStorageAt(USDC, slot) === allowance()` for a known owner/spender pair. This catches a slot change in CI before any release. Should be added to the fork-test suite regardless of whether runtime verification is implemented.

**4.3 Comment update**

Update the comment in `lib/storage-slots.ts` with the verification date and the proxy implementation address that was verified (`eth_getCode(USDC)` → implementation slot → address). Future maintainers can re-verify by repeating the check.

## 5. Acceptance criteria

- A runtime verification check runs before injecting the stateOverride; mismatch emits a warning rather than silently proceeding.
- A fork-test assertion in `scripts/fork-test.ts` or a new `test/storage-slots.fork.test.ts` verifies the slot against a pinned Base mainnet block.
- The comment in `lib/storage-slots.ts` records the proxy implementation address that was verified and the date.
- Existing unit tests (`storage-slots.test.ts`) remain green.

## 6. Open questions

- **Performance cost of runtime verification.** The verification requires two extra RPC calls per `prepare-deposit` / `execute-deposit`. Both can be parallelised with existing reads; the overhead is one extra round-trip latency. Acceptable for correctness but worth noting.
- **Scope.** The same assumption might apply to Permit2 or basket-token allowance slots if they are ever stateOverride'd. Audit `lib/simulate.ts` for other hardcoded slot values.

## 7. References

- Slot derivation: [`../../packages/cli/src/lib/storage-slots.ts`](../../packages/cli/src/lib/storage-slots.ts)
- Slot use in simulation: [`../../packages/cli/src/lib/simulate.ts`](../../packages/cli/src/lib/simulate.ts)
- Existing unit test (math only): [`../../packages/cli/test/storage-slots.test.ts`](../../packages/cli/test/storage-slots.test.ts)
- Data sources analysis: [`data-sources.md`](data-sources.md) §6.6
