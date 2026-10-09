// devops 58 (S11): the read-only config-check of every configured asset against the chain (a fake read-only ChainReader here).
// Plan: Parameters, "Oracle config": the TWAP that prices the basket vault is inside the window, fresh and near V3 spot.
import { describe, expect, test } from "bun:test";
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

describe("core's asset config files", () => {
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
      expect(a.venue).toBe(0);
    }
  });
  test("rmPROTO lists wETH and cbBTC, rmRWA lists deSPXA only, rmAGENT lists RM only", () => {
    expect(loadVaultConfiguredAssets(REPO_ROOT, "PROTO").map((a) => a.symbol)).toEqual(["wETH", "cbBTC"]);
    expect(loadVaultConfiguredAssets(REPO_ROOT, "RWA").map((a) => a.symbol)).toEqual(["deSPXA"]);
    const agent = loadVaultConfiguredAssets(REPO_ROOT, "AGENT");
    expect(agent.map((a) => a.symbol)).toEqual(["RM"]);
    expect(agent[0].token.toLowerCase()).toBe("0x65021a79aeef22b17cdc1b768f5e79a8618beba3");
    expect(agent[0].swapFee).toBe(10000);
  });
  test("every basket and agent vault of the stage table has a config file mapping", () => {
    const table = loadStageTable(REPO_ROOT);
    for (const v of table.vaults) if (v.key !== "USDC") expect(() => loadVaultConfiguredAssets(REPO_ROOT, v.key)).not.toThrow();
  });
});
