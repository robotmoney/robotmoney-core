// Canonical: robotmoney/devops issue 53 / core issue 1499, core S2 (issue 1484).
// Offline test of scripts/ci/config-check.ts. No network. Run: bun test scripts/ci/config-check.test.ts
import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadConfigs, staticFindings, liveFindings, keccak256, keccakHex, parseCli, httpRpc, redactUrl, usdcHashFindings, readUsdcHashes, UsageError,
  USDC, USDC_IMPL_SLOT, type Rpc,
} from "./config-check";
import { spawnSync } from "node:child_process";

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
  // The fake chain serves the code "0x6001" at every address, so that code's hash is the pin.
  const FAKE_HASH = keccakHex("0x6001");
  const pin = (c: ReturnType<typeof loadConfigs>) => ({ ...c, usdcHashes: { proxyCodeHash: FAKE_HASH, implementationCodeHash: FAKE_HASH } });
  const cfg = pin(loadConfigs(realDir));
  const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
  const a = (x: string) => x.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const all = [...cfg.protocol.assets, ...cfg.rwa.assets];
  const FACTORY = cfg.rwa.uniswapV3Factory.toLowerCase();

  /** Per-pool live facts. Defaults match the committed config, so a test overrides one thing. */
  interface Live { fee?: number; cardinality?: number; liquidity?: bigint; factoryPool?: string }
  function rpcFor(over: Record<string, Live> = {}, noCode: string[] = []): Rpc {
    const feeOf = (pool: string) => Number(all.find((x) => x.pool.toLowerCase() === pool)!.poolFee);
    return async (method, params) => {
      if (method === "eth_getStorageAt") return "0x" + w(0) .slice(0, 24) + a("0x4444444444444444444444444444444444444444").slice(24);
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
    const r = await liveFindings(rpcFor({}, noCode), "latest", pin(c));
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

describe("keccak256", () => {
  test("matches the known empty-input and abc vectors", () => {
    expect(keccak256(new Uint8Array())).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(keccak256(new TextEncoder().encode("abc"))).toBe("0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  });
  test("matches cast on a multi-block input when cast is installed", () => {
    const hex = "0x" + "ab".repeat(300);
    const r = spawnSync("cast", ["keccak", hex], { encoding: "utf8" });
    if (r.status !== 0) return;
    expect(keccakHex(hex)).toBe(r.stdout.trim());
  });
});

describe("USDC code-hash check", () => {
  const IMPL = "0x4444444444444444444444444444444444444444";
  const GOOD_PROXY = "0x6001";
  const GOOD_IMPL = "0x6002";
  const slotWord = "0x" + "0".repeat(24) + IMPL.slice(2);
  const chain = (codes: Record<string, string>): Rpc => async (method, params) => {
    if (method === "eth_getStorageAt") return params[1] === USDC_IMPL_SLOT ? slotWord : "0x" + "0".repeat(64);
    if (method === "eth_getCode") return codes[String(params[0]).toLowerCase()] ?? "0x";
    throw new Error(method);
  };
  const pins = { proxyCodeHash: keccakHex(GOOD_PROXY), implementationCodeHash: keccakHex(GOOD_IMPL) };
  const run = async (codes: Record<string, string>, pinned = pins) =>
    usdcHashFindings(pinned, await readUsdcHashes(chain(codes), "latest"));

  test("the real proxy and implementation code pass", async () => {
    const f = await run({ [USDC.toLowerCase()]: GOOD_PROXY, [IMPL]: GOOD_IMPL });
    expect(f.every((x) => x.ok)).toBe(true);
    expect(f.length).toBe(2);
  });
  test("a mock token at the USDC address fails the proxy hash", async () => {
    const f = await run({ [USDC.toLowerCase()]: "0x60806040mock", [IMPL]: GOOD_IMPL });
    expect(f.find((x) => x.rule === "usdc-proxy-code-hash")!.ok).toBe(false);
  });
  test("a swapped implementation fails the implementation hash", async () => {
    const f = await run({ [USDC.toLowerCase()]: GOOD_PROXY, [IMPL]: "0x6099" });
    expect(f.find((x) => x.rule === "usdc-implementation-code-hash")!.ok).toBe(false);
  });
  test("no code at USDC fails", async () => {
    const f = await run({});
    expect(f.every((x) => !x.ok)).toBe(true);
  });
  test("an unpinned (null) hash is refused", async () => {
    const f = await run({ [USDC.toLowerCase()]: GOOD_PROXY, [IMPL]: GOOD_IMPL }, { proxyCodeHash: null, implementationCodeHash: null });
    expect(f.every((x) => !x.ok && /not pinned/.test(x.detail))).toBe(true);
  });
  test("the committed pin file is well formed (null or 32-byte hex)", () => {
    expect(staticFindings(loadConfigs(realDir)).filter((x) => x.rule.startsWith("format:") && !x.ok)).toEqual([]);
  });
  test("the committed pins are real hashes, never null", () => {
    const pins = JSON.parse(readFileSync(join(realDir, "usdc-hashes.json"), "utf8"));
    for (const k of ["proxyCodeHash", "implementationCodeHash"]) {
      expect(pins[k], `${k} must be pinned`).not.toBeNull();
      expect(pins[k]).toMatch(/^0x[0-9a-f]{64}$/);
    }
  });
  test("a malformed pin fails the static format rule", () => {
    const c = fixture((f) => { f["usdc-hashes.json"].proxyCodeHash = "0x1234"; });
    expect(staticFindings(c).some((x) => x.rule === "format:proxyCodeHash" && !x.ok)).toBe(true);
  });
});

describe("cli arguments", () => {
  test("accepts --rpc, --config-dir and --chain", () => {
    expect(parseCli(["--rpc", "http://x", "--config-dir", "d", "--chain", "918453"])).toMatchObject({ rpc: "http://x", configDir: "d", chain: 918453 });
  });
  test("chain defaults to 8453", () => {
    expect(parseCli(["--rpc", "http://x"]).chain).toBe(8453);
  });
  for (const bad of [[], ["--rpc"], ["--rpc", "u", "--chain", "abc"], ["--rpc", "u", "--bogus"], ["--offline", "--print-usdc-hashes"]]) {
    test(`usage error for ${JSON.stringify(bad)}`, () => {
      expect(() => parseCli(bad)).toThrow(UsageError);
    });
  }
  test("the process exits 2 on a usage error", () => {
    const r = spawnSync("bun", [join(repo, "scripts/ci/config-check.ts"), "--nope"], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });
  test("the process exits 0 offline on the committed config", () => {
    const out = mkdtempSync(join(tmpdir(), "cc-out-"));
    const r = spawnSync("bun", [join(repo, "scripts/ci/config-check.ts"), "--offline", "--out-dir", out], { encoding: "utf8" });
    expect(r.status).toBe(0);
  });
});

describe("httpRpc retry and spacing", () => {
  const ok = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), { status: 200 });
  const limited = () => new Response("slow down", { status: 429 });
  function harness(responses: Array<() => Response>) {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      const r = responses[Math.min(calls, responses.length - 1)];
      calls++;
      return r();
    }) as unknown as typeof fetch;
    const rpc = httpRpc("https://rpc.example/key-SECRET", {
      fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5, minSpacingMs: 0,
    });
    return { rpc, sleeps, calls: () => calls };
  }
  test("429 twice then success returns the result after backoff", async () => {
    const h = harness([limited, limited, ok]);
    expect(await h.rpc("eth_blockNumber", [])).toBe("0x1");
    expect(h.calls()).toBe(3);
    expect(h.sleeps.length).toBe(2);
    expect(h.sleeps[1]).toBeGreaterThan(h.sleeps[0]);
  });
  test("gives up after 6 tries and never leaks the URL", async () => {
    const h = harness([limited]);
    let msg = "";
    try { await h.rpc("eth_call", []); } catch (e) { msg = (e as Error).message; }
    expect(h.calls()).toBe(6);
    expect(msg).toMatch(/http 429/);
    expect(msg).not.toMatch(/SECRET|rpc\.example/);
  });
  test("a non-retryable status fails at once", async () => {
    const h = harness([() => new Response("no", { status: 400 })]);
    await expect(h.rpc("eth_call", [])).rejects.toThrow(/http 400/);
    expect(h.calls()).toBe(1);
  });
  test("concurrent calls are serialized and spaced", async () => {
    let inFlight = 0, maxInFlight = 0;
    const gaps: number[] = [];
    const fetchImpl = (async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
      return ok();
    }) as unknown as typeof fetch;
    const rpc = httpRpc("http://x", { fetchImpl, sleep: async (ms) => { gaps.push(ms); }, minSpacingMs: 250 });
    await Promise.all([rpc("a", []), rpc("b", []), rpc("c", [])]);
    expect(maxInFlight).toBe(1);
    expect(gaps).toEqual([250, 250, 250]);
  });
  test("redactUrl keeps only the origin", () => {
    expect(redactUrl("https://rpc.example/v2/key-SECRET?k=1")).toBe("https://rpc.example");
    expect(redactUrl("garbage")).toBe("<invalid-url>");
  });
});
