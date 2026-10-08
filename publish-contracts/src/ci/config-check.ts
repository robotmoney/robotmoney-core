// Read-only config-check of core's asset config (config/protocol-assets.json, rwa-assets.json, agent-token-shortlist.json) against the
// live chain. It runs in the plan job before any approval and again right before each vault stage (runner.ts). It sends nothing (the
// ChainReader surface is read-only). For every configured asset:
//   token code present, pool code present, pool fee() equals the configured poolFee, observation cardinality at least 2, liquidity above 0,
//   and the oracle (the pool TWAP that prices the basket vault): observe() covers the TWAP window, the last observation is fresh, and the
//   TWAP is within ORACLE_MAX_DEVIATION_PERCENT of the V3 slot0 spot.
// Missing config is a failure, never a skip.
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { Collector } from "../verify/collector.ts";
import type { Address, ChainReader, ExpectedAsset, Hex, VerifyReport } from "../verify/types.ts";
import { loadConfigAssets } from "../asset-config.ts";
import { VAULT_KEYS, VAULT_NAME, type VaultKey } from "../sheet.ts";

export const POOL_SELECTORS = { fee: "0xddca3f43", slot0: "0x3850c7bd", liquidity: "0x1a686502", observations: "0x252c09d7" } as const;
/** The vault names whose assets the config-check reads. rmUSDC holds no basket assets. */
export const CONFIG_VAULTS = ["rmPROTO", "rmAGENT", "rmRWA"] as const;

/** BasketVault.DEFAULT_TWAP_WINDOW (core contracts/vaults/BasketVault.sol): the window a freshly added asset is priced over. */
export const ORACLE_TWAP_WINDOW_SECONDS = 1800;
/** The last pool observation may be at most this old. BasketVault.MAX_TWAP_WINDOW: beyond it the TWAP only extrapolates one old tick. */
export const ORACLE_MAX_AGE_SECONDS = 86_400;
/** The TWAP may sit at most this far (percent of price) from the V3 slot0 spot. */
export const ORACLE_MAX_DEVIATION_PERCENT = 5;
/** One V3 tick is a 0.01 percent price step (1.0001 per tick). */
export const maxDeviationTicks = (percent: number): number => Math.floor(Math.log(1 + percent / 100) / Math.log(1.0001));

const POOL_ABI = parseAbi(["function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)"]);

export interface ConfiguredAsset extends Omit<ExpectedAsset, "adapter"> { vault: string; symbol?: string }

/** Every configured asset of the three basket and agent vaults, from core's config files. */
export function loadConfiguredAssets(coreDir: string): ConfiguredAsset[] {
  const out: ConfiguredAsset[] = [];
  for (const k of VAULT_KEYS) {
    if (!(CONFIG_VAULTS as readonly string[]).includes(VAULT_NAME[k])) continue;
    for (const a of loadConfigAssets(coreDir, k)) out.push({ ...a, vault: VAULT_NAME[k] });
  }
  return out;
}

/** The configured assets of one vault (rmUSDC gives none). */
export function loadVaultConfiguredAssets(coreDir: string, key: VaultKey): ConfiguredAsset[] {
  return loadConfigAssets(coreDir, key).map((a) => ({ ...a, vault: VAULT_NAME[key] }));
}

const word = (data: Hex, i: number): bigint => {
  const hex = data.slice(2).slice(i * 64, i * 64 + 64);
  if (hex.length !== 64) throw new Error(`short return data (${data.length} chars)`);
  return BigInt("0x" + hex);
};
const signed = (w: bigint): bigint => BigInt.asIntN(256, w);

export async function configCheck(chain: ChainReader, assets: ConfiguredAsset[]): Promise<VerifyReport> {
  const c = new Collector();
  if (assets.length === 0) c.fail("config: at least one asset is configured", "no asset in the config");
  const labelsSeen = new Map<string, number>();
  for (const a of assets) {
    const base = `${a.vault} ${a.token}`;
    const n = (labelsSeen.get(base) ?? 0) + 1;
    labelsSeen.set(base, n);
    const p = n === 1 ? base : `${base} #${n}`;
    const tokenCode = await (async () => { try { return (await chain.getCode(a.token)) !== "0x"; } catch { return false; } })();
    c.push(`${p}: token code present`, tokenCode, tokenCode ? `${a.token}` : `no code at token ${a.token}`);
    const hasCode = await (async () => { try { return (await chain.getCode(a.pool)) !== "0x"; } catch { return false; } })();
    c.push(`${p}: pool code present`, hasCode, hasCode ? `${a.pool}` : `no code at pool ${a.pool}`);
    if (!hasCode) continue;
    if (a.venue !== undefined && a.venue !== 0) { c.pass(`${p}: venue ${a.venue} is not a V3 pool, code presence only`); continue; }
    await c.run(`${p}: pool fee equals config`, async () => {
      const r = await chain.callRaw(a.pool, POOL_SELECTORS.fee as Hex);
      if (!r.ok) return { ok: false, detail: `fee() reverted: ${r.reason ?? ""}` };
      const got = word(r.data, 0);
      return { ok: got === BigInt(a.swapFee), detail: `got ${got}, want ${a.swapFee}` };
    });
    let spotTick: bigint | undefined;
    let obsIndex: bigint | undefined;
    await c.run(`${p}: observation cardinality at least 2`, async () => {
      const r = await chain.callRaw(a.pool, POOL_SELECTORS.slot0 as Hex);
      if (!r.ok) return { ok: false, detail: `slot0() reverted: ${r.reason ?? ""}` };
      spotTick = signed(word(r.data, 1));
      obsIndex = word(r.data, 2);
      const card = word(r.data, 3);
      return { ok: card >= 2n, detail: `cardinality ${card}` };
    });
    await c.run(`${p}: liquidity above 0`, async () => {
      const r = await chain.callRaw(a.pool, POOL_SELECTORS.liquidity as Hex);
      if (!r.ok) return { ok: false, detail: `liquidity() reverted: ${r.reason ?? ""}` };
      const liq = word(r.data, 0);
      return { ok: liq > 0n, detail: `liquidity ${liq}` };
    });
    // oracle: the pool TWAP is what the basket vault prices NAV and swap minimums from
    let twapTick: bigint | undefined;
    await c.run(`${p}: oracle observation history covers the TWAP window`, async () => {
      const data = encodeFunctionData({ abi: POOL_ABI, functionName: "observe", args: [[ORACLE_TWAP_WINDOW_SECONDS, 0]] });
      const r = await chain.callRaw(a.pool, data);
      if (!r.ok) return { ok: false, detail: `observe() reverted over ${ORACLE_TWAP_WINDOW_SECONDS} s: ${r.reason ?? ""}` };
      const [cum] = decodeFunctionResult({ abi: POOL_ABI, functionName: "observe", data: r.data }) as [readonly bigint[], readonly bigint[]];
      twapTick = (cum[1]! - cum[0]!) / BigInt(ORACLE_TWAP_WINDOW_SECONDS);
      return { ok: true, detail: `mean tick ${twapTick} over ${ORACLE_TWAP_WINDOW_SECONDS} s` };
    });
    await c.run(`${p}: oracle last observation is fresh`, async () => {
      if (obsIndex === undefined) return { ok: false, detail: "slot0 was not readable" };
      if (!chain.blockTimestamp) return { ok: false, detail: "this chain reader cannot read the head block timestamp" };
      const r = await chain.callRaw(a.pool, (POOL_SELECTORS.observations + obsIndex.toString(16).padStart(64, "0")) as Hex);
      if (!r.ok) return { ok: false, detail: `observations(${obsIndex}) reverted: ${r.reason ?? ""}` };
      const obsTs = word(r.data, 0);
      const now = await chain.blockTimestamp();
      const age = now - obsTs;
      return { ok: age >= 0n && age <= BigInt(ORACLE_MAX_AGE_SECONDS), detail: `last observation ${age} s old, at most ${ORACLE_MAX_AGE_SECONDS} s` };
    });
    await c.run(`${p}: oracle TWAP is within ${ORACLE_MAX_DEVIATION_PERCENT} percent of V3 spot`, async () => {
      if (spotTick === undefined || twapTick === undefined) return { ok: false, detail: "spot tick or TWAP tick was not readable" };
      const diff = spotTick > twapTick ? spotTick - twapTick : twapTick - spotTick;
      const max = BigInt(maxDeviationTicks(ORACLE_MAX_DEVIATION_PERCENT));
      return { ok: diff <= max, detail: `spot tick ${spotTick}, TWAP tick ${twapTick}, differ by ${diff} ticks, at most ${max}` };
    });
  }
  return c.report();
}

export type { Address };
