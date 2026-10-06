// Canonical: docs/plans/one-deployment-scheme.md (robotmoney/devops), core S2 (issue 1484).
// Offline test of scripts/ci/config-check.ts. No network. Run: bun test scripts/ci/config-check.test.ts
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfigs, staticFindings, liveFindings, keccakHex, type Rpc } from "./config-check";

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
    test(`${sym} in the protocol or rwa launch config fails`, () => {
      const c = fixture((f) => { f["protocol-assets.json"].assets.push({ ...f["protocol-assets.json"].assets[0], symbol: sym }); });
      expect(failures(c).length).toBeGreaterThan(0);
    });
  }
  for (const sym of ["wSOL", "BNKR", "JUNO"]) {
    test(`${sym} in the agent shortlist fails`, () => {
      const c = fixture((f) => { f["agent-token-shortlist.json"].shortlist.push({ ...f["agent-token-shortlist.json"].shortlist[0], symbol: sym }); });
      expect(failures(c).length).toBeGreaterThan(0);
    });
  }
  test("a mainnet or devnet branch key fails", () => {
    const c = fixture((f) => { f["dex-pools.json"].devnet = { pools: {} }; });
    expect(failures(c).some((x) => x.rule === "forbidden-key")).toBe(true);
  });
  test("an agent shortlist other than RM fails", () => {
    const c = fixture((f) => { f["agent-token-shortlist.json"].shortlist = []; });
    expect(failures(c).some((x) => x.rule === "launch-list-is-rm-only")).toBe(true);
  });
  test("a changed RM pool fee fails", () => {
    const c = fixture((f) => { f["agent-token-shortlist.json"].shortlist[0].swapFee = 3000; });
    expect(failures(c).some((x) => x.rule === "launch-list-is-rm-only")).toBe(true);
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

describe("RM pin", () => {
  test("agent shortlist is RM on the owner-funded V3 pool, fee 10000", () => {
    const j = JSON.parse(readFileSync(join(realDir, "agent-token-shortlist.json"), "utf8"));
    expect(j.shortlist.map((e: any) => [e.symbol, e.token, e.pool, e.swapFee, e.venue])).toEqual([
      ["RM", "0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3", "0x8Cd8c7015b6A8F8310c15CcC8aA3D200D9c74882", 10000, "V3"],
    ]);
  });
  test("keccak256 matches the known empty-input hash", () => {
    expect(keccakHex("0x")).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
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
  function rpcFor(fee: number, poolOverride?: string): Rpc {
    return async (method, params) => {
      if (method === "eth_getCode") return "0x6001";
      const { to, data } = params[0] as { to: string; data: string };
      const sel = data.slice(0, 10);
      const t = to.toLowerCase();
      const pool = cfg.rwa.assets[0].pool.toLowerCase();
      const isPool = t === pool;
      if (sel === "0xddca3f43") return "0x" + w(fee);
      if (sel === "0x0dfe1681") return "0x" + a(cfg.rwa.usdc);
      if (sel === "0xd21220a7") return "0x" + a(cfg.rwa.assets[0].token);
      if (sel === "0x3850c7bd") return "0x" + w(1n << 96n) + w(0) + w(0) + w(0) + w(50) + w(0) + w(1);
      if (sel === "0x1a686502") return "0x" + w(10n ** 18n);
      if (sel === "0x70a08231") return "0x" + w(2_000_000n * 10n ** 6n);
      if (sel === "0x1698ee82") return "0x" + a(poolOverride ?? cfg.rwa.assets[0].pool);
      void isPool;
      return "0x" + w(0);
    };
  }
  test("passes when live facts match", async () => {
    const r = await liveFindings(rpcFor(500), "latest", cfg);
    expect(r.findings.filter((f) => f.scope.startsWith("rwa") && !f.ok)).toEqual([]);
  });
  test("fails when the live pool fee differs", async () => {
    const r = await liveFindings(rpcFor(100), "latest", cfg);
    expect(r.findings.some((f) => f.rule === "pool-fee-equals-config" && !f.ok)).toBe(true);
  });
  test("fails when the factory returns another pool", async () => {
    const r = await liveFindings(rpcFor(500, "0x1111111111111111111111111111111111111111"), "latest", cfg);
    expect(r.findings.some((f) => f.rule === "factory-getPool-equals-config" && !f.ok)).toBe(true);
  });
});
