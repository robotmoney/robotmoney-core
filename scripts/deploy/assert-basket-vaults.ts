#!/usr/bin/env bun
// Canonical: the one-deployment-scheme plan, core S4 (issue 1486),
//            core 1490 (config equals chain) and core 1491 (rmAGENT empty and paused).
//
// Twin chain proof for the three basket vaults. Reads the merged manifest the core stages wrote and
// asserts, with read-only `cast call`:
//   - registry.listVaults() contains rmUSDC, rmPROTO, rmAGENT and rmRWA
//   - each basket vault is paused (the govern stage unpauses after the checks)
//   - rmPROTO holds exactly the assets in config/protocol-assets.json: token, pool and fee equal
//   - rmRWA holds exactly the assets in config/rwa-assets.json (deSPXA only)
//   - rmAGENT holds exactly config/agent-token-shortlist.json, which is empty at launch
// Run it before the timelock stage or after it: it reads no role.
//
// Usage:
//   bun scripts/deploy/assert-basket-vaults.ts --rpc-url URL --manifest M.json --out PROOF.json
//        [--config-dir config]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface OnchainAsset {
  token: string;
  pool: string;
  fee: number;
  active: boolean;
}

export interface BasketReader {
  listVaults(registry: string): Promise<string[]>;
  paused(vault: string): Promise<boolean>;
  assets(vault: string): Promise<OnchainAsset[]>;
}

interface ConfigAsset {
  symbol: string;
  token: string;
  pool: string;
  poolFee: number;
}

const norm = (a: string) => a.trim().toLowerCase();

export const BASKETS: { label: string; manifestKey: string; configFile: string; listKey: string }[] = [
  { label: "rmPROTO", manifestKey: "protocol_vault", configFile: "protocol-assets.json", listKey: "assets" },
  { label: "rmAGENT", manifestKey: "agent_vault", configFile: "agent-token-shortlist.json", listKey: "shortlist" },
  { label: "rmRWA", manifestKey: "rwa_vault", configFile: "rwa-assets.json", listKey: "assets" },
];

/** Pure rules. `configs` maps a config file name to its parsed JSON. */
export async function basketChecks(
  r: BasketReader,
  manifest: Record<string, any>,
  configs: Record<string, any>,
): Promise<Check[]> {
  const out: Check[] = [];
  const add = (name: string, ok: boolean, detail = "") => out.push({ name, ok, detail });
  const need = (k: string) => {
    if (!manifest[k]) throw new Error(`manifest lacks "${k}"`);
    return String(manifest[k]);
  };
  const listed = (await r.listVaults(need("registry"))).map(norm);
  add("registry lists rmUSDC", listed.includes(norm(need("vault"))), need("vault"));

  for (const b of BASKETS) {
    const addr = need(b.manifestKey);
    add(`registry lists ${b.label}`, listed.includes(norm(addr)), addr);
    add(`${b.label}: paused after deploy`, await r.paused(addr));

    const want: ConfigAsset[] = configs[b.configFile]?.[b.listKey] ?? [];
    const have = await r.assets(addr);
    add(`${b.label}: asset count equals config`, have.length === want.length, `chain=${have.length} config=${want.length}`);
    for (let i = 0; i < want.length; i++) {
      const h = have[i];
      const w = want[i];
      add(`${b.label}: asset ${i} (${w.symbol}) token equals config`, !!h && norm(h.token) === norm(w.token), `${h?.token} vs ${w.token}`);
      add(`${b.label}: asset ${i} (${w.symbol}) pool equals config`, !!h && norm(h.pool) === norm(w.pool), `${h?.pool} vs ${w.pool}`);
      add(`${b.label}: asset ${i} (${w.symbol}) fee equals config`, !!h && h.fee === w.poolFee, `${h?.fee} vs ${w.poolFee}`);
      add(`${b.label}: asset ${i} (${w.symbol}) is active`, !!h && h.active);
    }
  }
  const agentWant = configs["agent-token-shortlist.json"]?.shortlist ?? [];
  add("rmAGENT ships empty at launch", agentWant.length === 0, `config entries=${agentWant.length}`);
  return out;
}

async function sh(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed (${code}): ${err || out}`);
  return out.trim();
}

/** Parse `[a, b, c]` lists printed by cast. */
export const parseList = (s: string): string[] => {
  const inner = s.trim().replace(/^\[/, "").replace(/\]$/, "").trim();
  return inner ? inner.split(",").map((x) => x.trim().split(/\s/)[0]) : [];
};

export function castBasketReader(rpc: string): BasketReader {
  return {
    async listVaults(registry) {
      return (await sh(["cast", "call", registry, "listVaults()(address[])", "--rpc-url", rpc])).match(/0x[0-9a-fA-F]{40}/g) ?? [];
    },
    async paused(vault) {
      return (await sh(["cast", "call", vault, "paused()(bool)", "--rpc-url", rpc])).trim() === "true";
    },
    async assets(vault) {
      const lines = (await sh(["cast", "call", vault, "shortlist()(address[],address[],uint24[],bool[],uint256[])", "--rpc-url", rpc])).split("\n");
      const [tokens, pools, fees, active] = lines.map(parseList);
      return tokens.map((t, i) => ({ token: t, pool: pools[i], fee: Number(fees[i]), active: active[i] === "true" }));
    },
  };
}

async function main() {
  const a: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, "")] = argv[i + 1];
  for (const k of ["rpc-url", "manifest", "out"]) if (!a[k]) throw new Error(`--${k} is required`);
  const dir = a["config-dir"] ?? "config";
  const configs: Record<string, any> = {};
  for (const b of BASKETS) configs[b.configFile] = JSON.parse(readFileSync(join(dir, b.configFile), "utf8"));
  const manifest = JSON.parse(readFileSync(a["manifest"], "utf8"));
  const checks = await basketChecks(castBasketReader(a["rpc-url"]), manifest, configs);
  const ok = checks.every((c) => c.ok);
  writeFileSync(a["out"], JSON.stringify({ ok, checks }, null, 2) + "\n");
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
  process.exit(ok ? 0 : 1);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(String(e.message ?? e));
    process.exit(1);
  });
}
