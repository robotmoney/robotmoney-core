// Runbook C6: every deployed contract has verified source on Base. Ports the old source-verification shell gate without its mock switches.
// Blockscout (base.blockscout.com) and Sourcify (sourcify.dev). Neither needs an API key, so no credential is involved.
// Sourcify must report an exact match (a partial match no longer passes). The Twin chain has no explorer: this runs on 8453 only.
import { Collector } from "./collector.ts";
import { loadManifests } from "./manifests.ts";
import { coreContracts } from "./constants.ts";
import type { StageTable } from "../stage-table.ts";
import type { Address, VerifyReport } from "./types.ts";
import { MAINNET_CHAIN_ID } from "../chains.ts";

export interface SourcesOptions {
  chainId: number;
  /** label -> address. Use contractsFromManifests(dir) to build it. */
  contracts: Record<string, Address>;
  requireSourcify?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Injectable for tests that serve a local HTTP endpoint. Defaults to global fetch. */
  fetchFn?: typeof fetch;
  blockscoutBase?: string;
  sourcifyBase?: string;
}

export function contractsFromManifests(dir: string, table: StageTable): Record<string, Address> {
  const m = loadManifests(dir, table);
  const out: Record<string, Address> = {};
  for (const x of coreContracts(table)) {
    const v = m.files[x.file.replace(/\.json$/, "")]?.[x.field];
    if (v) out[x.name] = v;
  }
  for (const v of m.vaults) out[`vault[${v.key}]`] = v.address;
  for (const [n, a] of Object.entries(m.libraries)) out[`library[${n}]`] = a;
  return out;
}

export async function verifySources(o: SourcesOptions): Promise<VerifyReport> {
  const c = new Collector();
  if (o.chainId !== MAINNET_CHAIN_ID) throw new Error(`source verification needs an explorer; chain ${o.chainId} has none (Base 8453 only)`);
  const f = o.fetchFn ?? fetch;
  const bs = o.blockscoutBase ?? "https://base.blockscout.com";
  const sf = o.sourcifyBase ?? "https://sourcify.dev/server";
  const requireSourcify = o.requireSourcify ?? true;
  const deadline = Date.now() + (o.timeoutMs ?? 3_600_000);
  const poll = o.pollIntervalMs ?? 30_000;
  const names = Object.keys(o.contracts);
  const bsOk = new Set<string>(), sfOk = new Set<string>();

  const get = async (url: string): Promise<any> => {
    try { const r = await f(url, { signal: AbortSignal.timeout(30_000) }); return r.ok ? await r.json() : undefined; } catch { return undefined; }
  };
  for (;;) {
    for (const n of names) {
      const a = o.contracts[n];
      if (!bsOk.has(n) && (await get(`${bs}/api/v2/smart-contracts/${a}`))?.is_verified === true) bsOk.add(n);
      if (!sfOk.has(n) && (await get(`${sf}/v2/contract/${o.chainId}/${a}`))?.match === "exact_match") sfOk.add(n);
    }
    const pending = names.filter((n) => !bsOk.has(n) || (requireSourcify && !sfOk.has(n)));
    if (!pending.length || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, poll));
  }
  for (const n of names) {
    c.push(`source[${n}]: verified on blockscout`, bsOk.has(n), o.contracts[n]);
    if (requireSourcify) c.push(`source[${n}]: exact match on sourcify`, sfOk.has(n), o.contracts[n]);
  }
  return c.report();
}
