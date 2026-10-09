// devops 58 (S11): the read-only config-check of every configured asset against the chain (a fake read-only ChainReader here).
// Plan: Parameters, "Oracle config": the TWAP that prices the basket vault is inside the window, fresh and near V3 spot.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters } from "viem";
import { configCheck, loadConfiguredAssets, loadVaultConfiguredAssets, maxDeviationTicks, ORACLE_MAX_AGE_SECONDS, POOL_SELECTORS, type ConfiguredAsset } from "../src/ci/config-check.ts";
import { PublishError } from "../src/errors.ts";
import { loadStageTable } from "../src/stage-table.ts";
import type { Address, ChainReader, Hex } from "../src/verify/types.ts";
import { REPO_ROOT, coreAvailable } from "./repo-root.ts";
import { CONFIG_ASSET, NOW_TS, tmp, writeCoreAssetConfig } from "./fixtures.ts";

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
const w = (n: bigint): string => BigInt.asUintN(256, n).toString(16).padStart(64, "0");
const asset = (n: number, o: Partial<ConfiguredAsset> = {}): ConfiguredAsset => ({ vault: "rmPROTO", token: addr(n), pool: addr(n + 0x100), swapFee: 500, venue: 0, ...o });

interface Pool { fee?: bigint; card?: bigint; liq?: bigint; noCode?: boolean; reverts?: boolean; spot?: bigint; twapTick?: bigint; lastObsAge?: bigint; observeReverts?: boolean }

function chain(pools: Record<string, Pool>, o: { noTokenCode?: Address[]; noTimestamp?: boolean } = {}): ChainReader {
  const c = {
    chainId: async () => 8453, blockNumber: async () => 1n, nonce: async () => 0, getStorageAt: async () => "0x" as Hex, read: async () => { throw new Error("unused"); },
    getLogs: async () => [],
    getCode: async (a: Address) => (pools[a.toLowerCase()]?.noCode || o.noTokenCode?.some((t) => t.toLowerCase() === a.toLowerCase()) ? "0x" : "0x6001") as Hex,
    ...(o.noTimestamp ? {} : { blockTimestamp: async () => NOW_TS }),
    callRaw: async (to: Address, data: Hex) => {
      const p = pools[to.toLowerCase()]!;
      if (p.reverts) return { ok: false, data: "0x" as Hex, reason: "revert" };
      if (data === POOL_SELECTORS.fee) return { ok: true, data: `0x${w(p.fee ?? 500n)}` as Hex };
      if (data === POOL_SELECTORS.slot0) return { ok: true, data: `0x${[1n, p.spot ?? 100n, 7n, p.card ?? 1000n, 5n, 0n, 1n].map(w).join("")}` as Hex };
      if (data === POOL_SELECTORS.liquidity) return { ok: true, data: `0x${w(p.liq ?? 10n)}` as Hex };
      if (data.startsWith(POOL_SELECTORS.observations)) return { ok: true, data: `0x${[NOW_TS - (p.lastObsAge ?? 60n), 0n, 0n, 1n].map(w).join("")}` as Hex };
      if (data.startsWith("0x883bdbfd")) {
        if (p.observeReverts) return { ok: false, data: "0x" as Hex, reason: "OLD" };
        const tick = p.twapTick ?? 100n;
        return { ok: true, data: encodeAbiParameters([{ type: "int56[]" }, { type: "uint160[]" }], [[0n, tick * 1800n], [0n, 0n]]) };
      }
      throw new Error("unexpected selector " + data);
    },
  };
  return c as unknown as ChainReader;
}
const key = (a: ConfiguredAsset) => a.pool.toLowerCase();

describe("config-check", () => {
  test("a healthy asset passes every check, the oracle ones included", async () => {
    const a = asset(1);
    const r = await configCheck(chain({ [key(a)]: {} }), [a]);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.label.replace(/^\S+ \S+: /, ""))).toEqual([
      "token code present", "pool code present", "pool fee equals config", "observation cardinality at least 901", "liquidity above 0",
      "oracle observation history covers the TWAP window", "oracle last observation is fresh", "oracle TWAP is within 5 percent of V3 spot",
    ]);
  });
  test.each([
    ["no code at the pool", { noCode: true }, "pool code present"],
    ["fee differs from config", { fee: 3000n }, "pool fee equals config"],
    ["cardinality 900, one below the 1800 s window floor", { card: 900n }, "observation cardinality"],
    ["cardinality 1", { card: 1n }, "observation cardinality"],
    ["zero liquidity", { liq: 0n }, "liquidity above 0"],
    ["a revert", { reverts: true }, "pool fee equals config"],
    ["history shorter than the TWAP window", { observeReverts: true }, "observation history covers the TWAP window"],
    ["a stale last observation", { lastObsAge: BigInt(ORACLE_MAX_AGE_SECONDS) + 1n }, "last observation is fresh"],
    ["spot 10 percent above the TWAP", { spot: 1100n, twapTick: 100n }, "within 5 percent of V3 spot"],
    ["spot 10 percent below the TWAP", { spot: -900n, twapTick: 100n }, "within 5 percent of V3 spot"],
  ] as [string, Pool, string][])("fails on %s", async (_n, pool, label) => {
    const a = asset(2);
    const r = await configCheck(chain({ [key(a)]: pool }), [a]);
    expect(r.ok).toBe(false);
    expect(r.checks.some((c) => !c.ok && c.label.includes(label))).toBe(true);
  });
  test("spot inside the percent band passes, with a negative tick", async () => {
    const a = asset(2);
    expect((await configCheck(chain({ [key(a)]: { spot: -50n, twapTick: -100n } }), [a])).ok).toBe(true);
    expect(maxDeviationTicks(5)).toBe(487);
  });
  test("cardinality 901 passes the window floor", async () => {
    const a = asset(7);
    const r = await configCheck(chain({ [key(a)]: { card: 901n } }), [a]);
    expect(r.checks.find((c) => c.label.endsWith("observation cardinality at least 901"))!.ok).toBe(true);
  });
  test("a token with no code fails", async () => {
    const a = asset(5);
    const r = await configCheck(chain({ [key(a)]: {} }, { noTokenCode: [a.token] }), [a]);
    expect(r.checks.find((c) => c.label.endsWith("token code present"))!.ok).toBe(false);
  });
  test("a reader that cannot read the head timestamp fails the freshness check, never skips it", async () => {
    const a = asset(6);
    const r = await configCheck(chain({ [key(a)]: {} }, { noTimestamp: true }), [a]);
    expect(r.checks.find((c) => c.label.endsWith("last observation is fresh"))!.ok).toBe(false);
  });
  test("one bad asset among good ones fails the report", async () => {
    const a = asset(3), b = asset(4);
    const r = await configCheck(chain({ [key(a)]: {}, [key(b)]: { liq: 0n } }), [a, b]);
    expect(r.ok).toBe(false);
  });
  test("an empty config is a failure, never a skip", async () => {
    expect((await configCheck(chain({}), [])).ok).toBe(false);
  });
});

// ---- the Uniswap V4 asset (core 1676) ----------------------------------------------------------------------------------------------

const SHIPPED_RM = (): ConfiguredAsset => {
  const a = loadVaultConfiguredAssets(REPO_ROOT, "AGENT")[0]!;
  expect(a.venue).toBe(1);
  return a;
};
const RM_POOL_ID = "0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252391";
interface V4Pool { sqrt?: bigint; lpFee?: bigint; liq?: bigint; slot0Reverts?: boolean; liqReverts?: boolean; noStateViewCode?: boolean; noManagerCode?: boolean }
/** A chain that serves StateView.getSlot0 / getLiquidity for exactly one pool id (the id the shipped config hashes to). */
function v4Chain(p: V4Pool = {}, liveId = RM_POOL_ID): ChainReader {
  const a = SHIPPED_RM();
  return {
    chainId: async () => 8453, blockNumber: async () => 1n, nonce: async () => 0, getStorageAt: async () => "0x" as Hex, read: async () => { throw new Error("unused"); }, getLogs: async () => [],
    getCode: async (x: Address) => ((p.noStateViewCode && x.toLowerCase() === a.v4!.stateView.toLowerCase()) || (p.noManagerCode && x.toLowerCase() === a.v4!.poolManager.toLowerCase()) ? "0x" : "0x6001") as Hex,
    callRaw: async (to: Address, data: Hex) => {
      if (to.toLowerCase() !== a.v4!.stateView.toLowerCase()) throw new Error("a V4 asset reads only StateView, not " + to);
      const onLiveId = data.slice(10).toLowerCase() === liveId.slice(2).toLowerCase();
      if (data.startsWith("0xc815641c")) {
        if (p.slot0Reverts) return { ok: false, data: "0x" as Hex, reason: "revert" };
        return { ok: true, data: `0x${[onLiveId ? (p.sqrt ?? 1n << 96n) : 0n, -403009n, 0n, onLiveId ? (p.lpFee ?? 29100n) : 0n].map(w).join("")}` as Hex };
      }
      if (data.startsWith("0xfa6793d5")) {
        if (p.liqReverts) return { ok: false, data: "0x" as Hex, reason: "revert" };
        return { ok: true, data: `0x${w(onLiveId ? (p.liq ?? 982_947_150_225_192_575n) : 0n)}` as Hex };
      }
      throw new Error("unexpected selector " + data);
    },
  } as unknown as ChainReader;
}

describe("config-check of the Uniswap V4 RM pool (core 1676)", () => {
  test("the shipped config passes against a funded live pool, read through StateView only", async () => {
    const r = await configCheck(v4Chain(), [SHIPPED_RM()]);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.checks.map((c) => c.label.replace(/^\S+ \S+: /, ""))).toEqual([
      "token code present", "PoolManager code present", "StateView code present", "pool key hashes to the pool id", "V4 pool is initialized and its fee equals config", "liquidity at least 1000000",
    ]);
  });
  // The AC: a fixture whose RM PoolKey hashes to a pool id other than 0xf2e7b957... fails.
  test.each([["tickSpacing", 200], ["fee", 10000], ["hooks", "0x00000000000000000000000000000000000000aa"], ["currency1", "0x00000000000000000000000000000000000000bb"]] as const)(
    "a PoolKey with another %s hashes to another pool id and fails, both on the hash and on the StateView read", async (field, value) => {
      const a = SHIPPED_RM();
      const spoof = { ...a, v4: { ...a.v4!, key: { ...a.v4!.key, [field]: value } } };
      const r = await configCheck(v4Chain(), [spoof]);
      expect(r.ok).toBe(false);
      expect(r.checks.find((c) => c.label.endsWith("pool key hashes to the pool id"))!.ok).toBe(false);
      expect(r.checks.find((c) => c.label.endsWith("V4 pool is initialized and its fee equals config"))!.ok).toBe(false);
    });
  test("a configured pool id that the key does not hash to fails even when the key is the real one", async () => {
    const a = SHIPPED_RM();
    const r = await configCheck(v4Chain(), [{ ...a, v4: { ...a.v4!, poolId: ("0x" + "ab".repeat(32)) as Hex } }]);
    expect(r.checks.find((c) => c.label.endsWith("pool key hashes to the pool id"))!.ok).toBe(false);
  });
  test("an unfunded pool fails the liquidity floor with the owner action named, and 999999 fails while 1000000 passes (unit: liquidity L)", async () => {
    for (const [liq, ok] of [[0n, false], [999_999n, false], [1_000_000n, true]] as const) {
      const r = await configCheck(v4Chain({ liq }), [SHIPPED_RM()]);
      const c = r.checks.find((x) => x.label.endsWith("liquidity at least 1000000"))!;
      expect(c.ok, `liquidity ${liq}`).toBe(ok);
      if (!ok) { expect(c.detail).toContain("owner must add in-range liquidity"); expect(c.detail).toContain("not USDC"); }
    }
  });
  test("an uninitialized pool (price zero) fails", async () => {
    expect((await configCheck(v4Chain({ sqrt: 0n }), [SHIPPED_RM()])).checks.find((c) => c.label.includes("V4 pool is initialized"))!.ok).toBe(false);
  });
  test("a live lpFee other than the config fee fails", async () => {
    expect((await configCheck(v4Chain({ lpFee: 3000n }), [SHIPPED_RM()])).checks.find((c) => c.label.includes("V4 pool is initialized"))!.ok).toBe(false);
  });
  test("a StateView that reverts fails both reads, never skips them", async () => {
    const r = await configCheck(v4Chain({ slot0Reverts: true, liqReverts: true }), [SHIPPED_RM()]);
    expect(r.checks.filter((c) => !c.ok).map((c) => c.label.replace(/^\S+ \S+: /, ""))).toEqual(["V4 pool is initialized and its fee equals config", "liquidity at least 1000000"]);
  });
  test("no code at StateView or at the PoolManager fails", async () => {
    expect((await configCheck(v4Chain({ noStateViewCode: true }), [SHIPPED_RM()])).checks.find((c) => c.label.endsWith("StateView code present"))!.ok).toBe(false);
    expect((await configCheck(v4Chain({ noManagerCode: true }), [SHIPPED_RM()])).checks.find((c) => c.label.endsWith("PoolManager code present"))!.ok).toBe(false);
  });
  test("a V4 asset with no PoolKey in its entry fails closed", async () => {
    const a = SHIPPED_RM();
    const r = await configCheck(v4Chain(), [{ ...a, v4: undefined }]);
    expect(r.ok).toBe(false);
    expect(r.checks.some((c) => !c.ok && c.label.includes("V4 pool key is configured"))).toBe(true);
  });
  test("the V3 pool reads are never made for a V4 asset (it has no pool address)", async () => {
    // v4Chain throws on any call that is not StateView: reaching here means the V3 selectors were not used
    await configCheck(v4Chain(), [SHIPPED_RM()]);
  });
});

describe("core's asset config files", () => {
  test("a UniswapV4 entry loads with the zero pool and its PoolKey; a malformed V4 entry is refused by name", () => {
    const rm = JSON.parse(readFileSync(join(REPO_ROOT, "config", "agent-token-shortlist.json"), "utf8")).shortlist[0];
    const load = (e: object) => { const dir = tmp("cc-"); writeCoreAssetConfig(dir, { shortlist: [e] }); return loadVaultConfiguredAssets(dir, "AGENT"); };
    const got = load(rm)[0]!;
    expect([got.venue, got.pool, got.swapFee, got.v4?.key.tickSpacing]).toEqual([1, "0x0000000000000000000000000000000000000000", 29100, 582]);
    expect(() => load({ ...rm, poolId: "0x1234" })).toThrow(/poolId is not a 32-byte hash/);
    expect(() => load({ ...rm, poolKey: undefined })).toThrow(/poolKey needs integer fee and tickSpacing/);
    expect(() => load({ ...rm, poolManager: "nope" })).toThrow(/poolManager is not an address/);
    expect(() => load({ ...rm, poolKey: { ...rm.poolKey, fee: 3000 } })).toThrow(/poolKey.fee 3000 differs from poolFee 29100/);
    expect(() => load({ ...rm, venue: "UniswapV5" })).toThrow(/venue 'UniswapV5' is not one of/);
  });
  test("loadConfiguredAssets reads protocol-assets.json, rwa-assets.json and agent-token-shortlist.json and maps poolFee to swapFee", () => {
    const dir = tmp("cc-");
    writeCoreAssetConfig(dir);
    const got = loadConfiguredAssets(dir);
    expect(got.map((x) => x.vault)).toEqual(["rmPROTO", "rmRWA"]);
    expect(got[0]).toEqual({ symbol: "wETH", token: CONFIG_ASSET.token, pool: CONFIG_ASSET.pool, swapFee: 500, venue: 0, vault: "rmPROTO" });
  });
  test("a missing file fails, an empty rmPROTO or rmRWA list fails, an empty rmAGENT shortlist is fine", () => {
    const dir = tmp("cc-");
    expect(() => loadConfiguredAssets(dir)).toThrow(/missing/);
    writeCoreAssetConfig(dir, { proto: [] });
    expect(() => loadConfiguredAssets(dir)).toThrow(/must list/);
    writeCoreAssetConfig(dir, { shortlist: [] });
    expect(loadVaultConfiguredAssets(dir, "AGENT")).toEqual([]);
  });
  test("a malformed asset or an unknown venue is refused", () => {
    const dir = tmp("cc-");
    writeCoreAssetConfig(dir, { proto: [{ ...CONFIG_ASSET, venue: "Curve" }] });
    expect(() => loadConfiguredAssets(dir)).toThrow(PublishError);
    writeCoreAssetConfig(dir, { proto: [{ ...CONFIG_ASSET, poolFee: "500" }] });
    expect(() => loadConfiguredAssets(dir)).toThrow(/poolFee/);
    writeCoreAssetConfig(dir, { proto: [{ ...CONFIG_ASSET, pool: "0x12" }] });
    expect(() => loadConfiguredAssets(dir)).toThrow(/pool is not an address/);
  });
});

// Core parity (devops 64, issue 4): the real config files in REPO_ROOT load, with the shape the verifier and the config-check read.
describe.skipIf(!coreAvailable())(`core parity: the real core config files in ${REPO_ROOT}`, () => {
  test("every configured asset loads with a token, a pool, a positive swapFee and the V3 venue", () => {
    const all = loadConfiguredAssets(REPO_ROOT);
    expect(all.length).toBeGreaterThan(0);
    for (const a of all) {
      expect(a.token).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(a.pool).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(a.swapFee).toBeGreaterThan(0);
      // RM is the one Uniswap V4 asset (core 1676): it has no pool address, its PoolKey is in v4. Every other asset is V3.
      if (a.symbol === "RM") { expect(a.venue).toBe(1); expect(a.v4?.key.fee).toBe(29100); } else expect(a.venue).toBe(0);
    }
  });
  test("rmPROTO lists wETH and cbBTC, rmRWA lists deSPXA only, rmAGENT lists RM only", () => {
    expect(loadVaultConfiguredAssets(REPO_ROOT, "PROTO").map((a) => a.symbol)).toEqual(["wETH", "cbBTC"]);
    expect(loadVaultConfiguredAssets(REPO_ROOT, "RWA").map((a) => a.symbol)).toEqual(["deSPXA"]);
    const agent = loadVaultConfiguredAssets(REPO_ROOT, "AGENT");
    expect(agent.map((a) => a.symbol)).toEqual(["RM"]);
    expect(agent[0].token.toLowerCase()).toBe("0x65021a79aeef22b17cdc1b768f5e79a8618beba3");
    expect(agent[0].swapFee).toBe(29100);
    expect(agent[0].venue).toBe(1);
    expect(agent[0].v4).toMatchObject({ poolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b", poolId: "0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252391", key: { currency0: agent[0].token, fee: 29100, tickSpacing: 582, hooks: "0x0000000000000000000000000000000000000000" } });
  });
  test("every basket and agent vault of the stage table has a config file mapping", () => {
    const table = loadStageTable(REPO_ROOT);
    for (const v of table.vaults) if (v.key !== "USDC") expect(() => loadVaultConfiguredAssets(REPO_ROOT, v.key)).not.toThrow();
  });
});
