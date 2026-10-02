// Canonical: the one-deployment-scheme plan, core S2 (issue 1484).
// Offline test of scripts/ci/config-check.ts. No network. Run: bun test scripts/ci/config-check.test.ts
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfigs, staticFindings, liveFindings, type Rpc } from "./config-check";

const repo = resolve(import.meta.dir, "..", "..");
const realDir = join(repo, "config");

function fixture(mutate: (files: Record<string, any>) => void) {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  cpSync(realDir, dir, { recursive: true });
  const files: Record<string, any> = {};
  for (const n of readdirSync(dir)) if (n.endsWith(".json")) files[n] = JSON.parse(readFileSync(join(dir, n), "utf8"));
  mutate(files);
  for (const [n, j] of Object.entries(files)) writeFileSync(join(dir, n), JSON.stringify(j, null, 2));
  return loadConfigs(dir);
}
const failures = (c: ReturnType<typeof loadConfigs>) => staticFindings(c).filter((f) => !f.ok);

describe("static rules", () => {
  test("the committed config passes", () => {
    expect(failures(loadConfigs(realDir))).toEqual([]);
  });
  test("a 39-digit address fails", () => {
    const c = fixture((f) => { f["rwa-assets.json"].assets[0].pool = "0xd53bF0FcE8E80a2f28c17Ef22FcBfB9b8FC8b6A"; });
    expect(failures(c).some((x) => x.rule === "address-format")).toBe(true);
  });
  test("a deSPXA fee other than 500 fails", () => {
    const c = fixture((f) => { f["rwa-assets.json"].assets[0].poolFee = 100; });
    expect(failures(c).some((x) => x.rule === "despxa-fee-500")).toBe(true);
  });
  for (const sym of ["wSOL", "BNKR", "JUNO", "RM"]) {
    test(`${sym} in the launch config fails`, () => {
      const c = fixture((f) => { f["protocol-assets.json"].assets.push({ ...f["protocol-assets.json"].assets[0], symbol: sym }); });
      expect(failures(c).length).toBeGreaterThan(0);
    });
  }
  test("a mainnet or devnet branch key fails", () => {
    const c = fixture((f) => { f["dex-pools.json"].devnet = { pools: {} }; });
    expect(failures(c).some((x) => x.rule === "forbidden-key")).toBe(true);
  });
  test("an agent config without swapRouter02 fails", () => {
    const c = fixture((f) => { delete f["agent-token-shortlist.json"].swapRouter02; });
    expect(failures(c).some((x) => x.rule === "swap-router-recorded")).toBe(true);
  });
  test("a non-empty agent shortlist fails", () => {
    const c = fixture((f) => { f["agent-token-shortlist.json"].shortlist = [{ symbol: "X" }]; });
    expect(failures(c).some((x) => x.rule === "launch-list-empty")).toBe(true);
  });
});

describe("config/ grep test", () => {
  const text = (dir: string): string =>
    readdirSync(dir).map((n) => readFileSync(join(dir, n), "utf8")).join("\n");
  const all = text(realDir);
  test("no Chronicle, V4 or Aerodrome", () => {
    expect(all).not.toMatch(/chronicle|v4|aerodrome/i);
  });
  test("no mainnet or devnet branch key", () => {
    expect(all).not.toMatch(/"(mainnet|devnet)"\s*:/);
  });
  test("rwa-assets.json lists deSPXA only, UniswapV3, fee 500", () => {
    const j = JSON.parse(readFileSync(join(realDir, "rwa-assets.json"), "utf8"));
    expect(j.assets.map((a: any) => [a.symbol, a.venue, a.poolFee])).toEqual([["deSPXA", "UniswapV3", 500]]);
    expect(j.assets[0].pool).toBe("0xD08f1fb797BfaCdeD23323178672557034c64CfA");
  });
});

describe("reader test: removed keys are gone from clients/ and testing/", () => {
  const SKIP = new Set(["node_modules", "target", "dist", ".git"]);
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (SKIP.has(n)) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|rs|json|sh|sol|md)$/.test(n)) {
        const t = readFileSync(p, "utf8");
        if (/devnet\.pools|basket_assets|DEVNET_AGENT_|\.mainnet\.shortlist|resolvePoolConfig\([^)]*,/.test(t)) hits.push(p);
      }
    }
  };
  test("no reader names a removed config key", () => {
    walk(join(repo, "clients"));
    walk(join(repo, "testing"));
    expect(hits).toEqual([]);
  });
});

describe("live rules against a fake RPC", () => {
  const cfg = loadConfigs(realDir);
  const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
  const a = (x: string) => x.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const all = [...cfg.protocol.assets, ...cfg.rwa.assets];
  const FACTORY = cfg.rwa.uniswapV3Factory.toLowerCase();

  /** Per-pool live facts. Defaults match the committed config, so a test overrides one thing. */
  interface Live { fee?: number; cardinality?: number; liquidity?: bigint; factoryPool?: string }
  function rpcFor(over: Record<string, Live> = {}, noCode: string[] = []): Rpc {
    const feeOf = (pool: string) => Number(all.find((x) => x.pool.toLowerCase() === pool)!.poolFee);
    return async (method, params) => {
      if (method === "eth_getCode") return noCode.includes(String(params[0]).toLowerCase()) ? "0x" : "0x6001";
      const { to, data } = params[0] as { to: string; data: string };
      const sel = data.slice(0, 10);
      const t = to.toLowerCase();
      const asset = all.find((x) => x.pool.toLowerCase() === t);
      const o = (asset && over[asset.symbol]) || {};
      if (sel === "0xddca3f43") return "0x" + w(o.fee ?? feeOf(t));
      if (sel === "0x0dfe1681") return "0x" + a(cfg.rwa.usdc);
      if (sel === "0xd21220a7") return "0x" + a(asset!.token);
      if (sel === "0x3850c7bd") return "0x" + w(1n << 96n) + w(0) + w(0) + w(0) + w(o.cardinality ?? 50) + w(0) + w(1);
      if (sel === "0x1a686502") return "0x" + w(o.liquidity ?? 10n ** 18n);
      if (sel === "0x70a08231") return "0x" + w(2_000_000n * 10n ** 6n);
      if (sel === "0x1698ee82" && t === FACTORY) {
        // getPool(token, usdc, fee): the first argument is the asset token.
        const tok = "0x" + data.slice(10, 74).slice(24);
        const x = all.find((y) => y.token.toLowerCase() === tok.toLowerCase());
        const o2 = (x && over[x.symbol]) || {};
        return "0x" + a(o2.factoryPool ?? x!.pool);
      }
      return "0x" + w(0);
    };
  }
  const bad = async (over: Record<string, Live>, rule: string, symbol?: string) => {
    const r = await liveFindings(rpcFor(over), "latest", cfg);
    return r.findings.some((f) => f.rule === rule && !f.ok && (!symbol || f.scope.endsWith(`:${symbol}`)));
  };

  test("passes when live facts match, for every asset", async () => {
    const r = await liveFindings(rpcFor(), "latest", cfg);
    expect(r.findings.filter((f) => !f.ok)).toEqual([]);
  });
  test("fails when the live pool fee differs", async () => {
    expect(await bad({ deSPXA: { fee: 100 } }, "pool-fee-equals-config", "deSPXA")).toBe(true);
  });
  test("fails when the factory returns another pool", async () => {
    expect(await bad({ deSPXA: { factoryPool: "0x1111111111111111111111111111111111111111" } }, "factory-getPool-equals-config", "deSPXA")).toBe(true);
  });
  test("fails when observation cardinality is below 2", async () => {
    expect(await bad({ deSPXA: { cardinality: 1 } }, "observation-cardinality>=2", "deSPXA")).toBe(true);
  });
  test("fails when liquidity is zero", async () => {
    expect(await bad({ deSPXA: { liquidity: 0n } }, "liquidity>0", "deSPXA")).toBe(true);
  });
  for (const sym of ["wETH", "cbBTC"]) {
    test(`${sym}: a live fee that differs from config fails`, async () => {
      expect(await bad({ [sym]: { fee: 3000 } }, "pool-fee-equals-config", sym)).toBe(true);
    });
    test(`${sym}: a factory that returns another pool fails`, async () => {
      expect(await bad({ [sym]: { factoryPool: "0x2222222222222222222222222222222222222222" } }, "factory-getPool-equals-config", sym)).toBe(true);
    });
    test(`${sym}: cardinality below 2 and zero liquidity fail`, async () => {
      expect(await bad({ [sym]: { cardinality: 0 } }, "observation-cardinality>=2", sym)).toBe(true);
      expect(await bad({ [sym]: { liquidity: 0n } }, "liquidity>0", sym)).toBe(true);
    });
  }
  // Config mutations against live truth (the committed config is the truth the fake RPC serves).
  const failedRules = async (c: ReturnType<typeof loadConfigs>, noCode: string[] = []) => {
    const r = await liveFindings(rpcFor({}, noCode), "latest", c);
    return r.findings.filter((f) => !f.ok).map((f) => `${f.scope.split(":").pop()}/${f.rule}`);
  };
  const GHOST = "0x3333333333333333333333333333333333333333";
  for (const [sym, idx, other] of [["wETH", 0, 1], ["cbBTC", 1, 0]] as const) {
    test(`${sym}: a pool address with no code fails code:pool`, async () => {
      const c = fixture((f) => { f["protocol-assets.json"].assets[idx].pool = GHOST; });
      expect(await failedRules(c, [GHOST])).toContain(`${sym}/code:pool`);
    });
    test(`${sym}: another asset's pool address fails the token pairing and the factory rule`, async () => {
      const c = fixture((f) => {
        const as = f["protocol-assets.json"].assets;
        as[idx].pool = as[other].pool;
      });
      const rules = await failedRules(c);
      expect(rules).toContain(`${sym}/pool-is-token-usdc`);
      expect(rules).toContain(`${sym}/factory-getPool-equals-config`);
    });
    test(`${sym}: a config fee that differs from the live pool fee fails`, async () => {
      const c = fixture((f) => { f["protocol-assets.json"].assets[idx].poolFee = 3000; });
      expect(await failedRules(c)).toContain(`${sym}/pool-fee-equals-config`);
    });
  }
  test("the committed config has no failing rule with the same fake RPC", async () => {
    expect(await failedRules(cfg)).toEqual([]);
  });
  test("main exits non-zero when any live rule fails", async () => {
    const r = await liveFindings(rpcFor({ cbBTC: { liquidity: 0n } }), "latest", cfg);
    expect(r.findings.some((f) => !f.ok)).toBe(true);
  });
});
