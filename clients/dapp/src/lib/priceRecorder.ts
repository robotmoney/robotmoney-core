// Canonical: docs/adr/ADR-0005-basketvault-multi-dex-routing.md (V4 price recorder)

/**
 * Price-recorder freshness for BasketVault deposits (dapp issue 1760).
 *
 * Why: a BasketVault (rmAGENT) prices its basket through `observe()` on each V4 asset's
 * `UniswapV4PriceRecorder`. `observe()` reverts `StaleRecorder` once the last snapshot is older than
 * `MAX_STALENESS` = 1800 s (contracts/adapters/UniswapV4PriceRecorder.sol:43-45, :108, :211), and deposit
 * reads `totalAssets()`, so a deposit reverts while any active V4 recorder is stale.
 * `isFresh()` (UniswapV4PriceRecorder.sol:276) says whether it would answer now.
 * `record()` (UniswapV4PriceRecorder.sol:151, IUniswapV4PriceRecorder.sol:19) is PERMISSIONLESS: no access
 * modifier, any account may refresh the price. So a stale price is something the user can fix.
 *
 * Where the recorder is: for a V4 asset the vault's `AssetInfo.pool` IS the recorder
 * (BasketVault.sol:99-101, :113, :123; `assets` array at :137, `assetCount()` at :1577).
 */
import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import { depositsReadAllowed } from "./useVaultsDepositsPaused";
import { useWriteChainGuard } from "./useGuardedWriteContract";

/** `BasketVault.Venue.V4`. */
export const VENUE_V4 = 1;

export const BASKET_ASSETS_ABI = [
  {
    type: "function",
    name: "assetCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "assets",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "token", type: "address" },
      { name: "pool", type: "address" },
      { name: "swapFee", type: "uint24" },
      { name: "active", type: "bool" },
      { name: "adapter", type: "address" },
      { name: "venue", type: "uint8" },
    ],
  },
] as const;

export const PRICE_RECORDER_ABI = [
  {
    type: "function",
    name: "isFresh",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "record",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "recorded", type: "bool" }],
  },
] as const;

/** One `assets(i)` read result: the viem tuple-array form, or an object. */
export type AssetRow =
  | readonly [string, string, number, boolean, string, number]
  | { readonly pool: string; readonly active: boolean; readonly venue: number };

/** The recorder addresses (lower case, unique) of the ACTIVE V4 assets in a vault's rows. Pure. */
export function recordersOf(rows: ReadonlyArray<AssetRow | undefined>): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    if (!r) continue;
    const [pool, active, venue] = Array.isArray(r)
      ? [r[1], r[3], Number(r[5])]
      : [
          (r as { pool: string }).pool,
          (r as { active: boolean }).active,
          Number((r as { venue: number }).venue),
        ];
    if (active === true && venue === VENUE_V4 && typeof pool === "string")
      out.add(pool.toLowerCase());
  }
  return [...out];
}

/** The recorders whose `isFresh()` read answered false. An unreadable recorder is NOT stale here. Pure. */
export function staleRecorders(
  recorders: readonly string[],
  fresh: ReadonlyArray<boolean | undefined>,
): string[] {
  return recorders.filter((_, i) => fresh[i] === false);
}

/**
 * Stale price recorders per vault (lower-case address -> lower-case recorder addresses). A vault that is not a
 * BasketVault (no `assetCount()`) or has no active V4 asset is absent. Read through the same guarded chain
 * rule as `depositsPaused()`: on the mainnet class only when the wallet is on Base.
 */
export function useStaleRecorders(addresses: readonly string[]): ReadonlyMap<string, string[]> {
  const { state } = useWriteChainGuard();
  const allowed = depositsReadAllowed(state);
  const chainId = state.kind === "ok" ? state.targetChainId : undefined;
  const key = addresses.map((a) => a.toLowerCase()).join(",");
  const vaults = useMemo(() => (key === "" ? [] : Array.from(new Set(key.split(",")))), [key]);

  const counts = useReadContracts({
    contracts: vaults.map((a) => ({
      address: a as Address,
      abi: BASKET_ASSETS_ABI,
      functionName: "assetCount" as const,
      chainId,
    })),
    query: { enabled: allowed && vaults.length > 0, refetchInterval: 60_000 },
  });

  const assetCalls = useMemo(() => {
    const calls: Array<{ vault: string; index: number }> = [];
    vaults.forEach((v, i) => {
      const r = counts.data?.[i];
      if (r?.status !== "success") return;
      const n = Number(r.result as bigint);
      for (let k = 0; k < Math.min(n, 32); k++) calls.push({ vault: v, index: k });
    });
    return calls;
  }, [vaults, counts.data]);

  const rows = useReadContracts({
    contracts: assetCalls.map((c) => ({
      address: c.vault as Address,
      abi: BASKET_ASSETS_ABI,
      functionName: "assets" as const,
      args: [BigInt(c.index)] as const,
      chainId,
    })),
    query: { enabled: allowed && assetCalls.length > 0, refetchInterval: 60_000 },
  });

  const recordersByVault = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const v of vaults) {
      const vRows = assetCalls.flatMap((c, i) =>
        c.vault === v && rows.data?.[i]?.status === "success"
          ? [rows.data[i]?.result as AssetRow]
          : [],
      );
      const recs = recordersOf(vRows);
      if (recs.length > 0) m.set(v, recs);
    }
    return m;
  }, [vaults, assetCalls, rows.data]);

  const allRecorders = useMemo(
    () => Array.from(new Set([...recordersByVault.values()].flat())),
    [recordersByVault],
  );
  const fresh = useReadContracts({
    contracts: allRecorders.map((a) => ({
      address: a as Address,
      abi: PRICE_RECORDER_ABI,
      functionName: "isFresh" as const,
      chainId,
    })),
    query: { enabled: allowed && allRecorders.length > 0, refetchInterval: 12_000 },
  });

  return useMemo(() => {
    const freshByRecorder = new Map<string, boolean | undefined>();
    allRecorders.forEach((a, i) => {
      const r = fresh.data?.[i];
      freshByRecorder.set(a, r?.status === "success" ? (r.result as boolean) : undefined);
    });
    const out = new Map<string, string[]>();
    for (const [v, recs] of recordersByVault) {
      const stale = staleRecorders(
        recs,
        recs.map((a) => freshByRecorder.get(a)),
      );
      if (stale.length > 0) out.set(v, stale);
    }
    return out;
  }, [allRecorders, fresh.data, recordersByVault]);
}
