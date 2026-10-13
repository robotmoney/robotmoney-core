// The Twin pre-deploy of the four CREATE2 libraries (issue 1721), on a stub RPC that keeps code by address.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { keccak256, type Hex } from "viem";
import { CREATE2_FACTORY, buildCreate2Libraries, predictedLibraryAddress } from "../src/libs-adopt.ts";
import { getStageTable } from "../src/stages.ts";
import { PREDEPLOY_SENDER, predeployLibraries } from "../src/rehearsal/predeploy-libs.ts";

const OUT = join(import.meta.dir, "fixtures", "build-out");
const tick = { name: "tick_math", artifact: "TickMath", path: "contracts/lib/TickMath.sol" };
const LIBS = [tick, ...getStageTable().create2Libraries!];
const BUILT = buildCreate2Libraries(LIBS, OUT);

/** A fake anvil: eth_sendTransaction to the factory deploys the library whose creation code the data carries. */
function fakeAnvil(o: { chain?: number; anvil?: boolean; code?: Record<string, string>; factory?: boolean; wrongCreate?: boolean } = {}) {
  const code: Record<string, string> = { ...(o.code ?? {}) };
  if (o.factory !== false) code[CREATE2_FACTORY.toLowerCase()] = "0x7fff";
  const calls: string[] = [];
  const rpc = async (method: string, params: unknown[] = []): Promise<unknown> => {
    calls.push(method);
    if (method === "eth_chainId") return "0x" + (o.chain ?? 918453).toString(16);
    if (method === "anvil_nodeInfo") { if (o.anvil === false) throw new Error("method not found"); return {}; }
    if (method === "eth_getCode") return code[String(params[0]).toLowerCase()] ?? "0x";
    if (method === "anvil_setBalance" || method === "anvil_impersonateAccount") return null;
    if (method === "eth_sendTransaction") {
      const tx = params[0] as { from: string; to: string; data: string };
      expect(tx.from).toBe(PREDEPLOY_SENDER);
      expect(tx.to).toBe(CREATE2_FACTORY);
      const creation = ("0x" + tx.data.slice(2 + 64)) as Hex;
      const built = [...BUILT.values()].find((b) => b.creation === creation)!;
      code[built.address.toLowerCase()] = o.wrongCreate ? "0x6001600155" : built.runtime;
      return "0x" + "ab".repeat(32);
    }
    if (method === "eth_getTransactionReceipt") return { status: "0x1" };
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, code, calls };
}

describe("predeployLibraries", () => {
  test("creates all four, dependencies first, each at the CREATE2 address of the build with the build's runtime code", async () => {
    const f = fakeAnvil();
    const r = await predeployLibraries(f.rpc, LIBS, OUT);
    expect(r.map((x) => [x.built.artifact, x.created])).toEqual([["TickMath", true], ["BasketAssetConfigGuard", true], ["TwapTickMath", true], ["BasketViews", true]]);
    for (const x of r) expect(keccak256(f.code[x.built.address.toLowerCase()] as Hex)).toBe(x.built.runtimeHash);
    expect(r.findIndex((x) => x.built.artifact === "TwapTickMath")).toBeLessThan(r.findIndex((x) => x.built.artifact === "BasketViews"));
    expect(r[0]!.built.address).toBe(predictedLibraryAddress(r[0]!.built.creation));
  });
  test("a library that is already there with the right code is left alone", async () => {
    const f = fakeAnvil({ code: { [BUILT.get("TickMath")!.address.toLowerCase()]: BUILT.get("TickMath")!.runtime } });
    const r = await predeployLibraries(f.rpc, LIBS, OUT);
    expect(r.map((x) => x.created)).toEqual([false, true, true, true]);
  });
  test("a library address that holds other code is refused", async () => {
    const f = fakeAnvil({ code: { [BUILT.get("TwapTickMath")!.address.toLowerCase()]: "0x6001600155" } });
    await expect(predeployLibraries(f.rpc, LIBS, OUT)).rejects.toThrow("not the build's");
  });
  test("a creation that leaves other code at the address is refused", async () => {
    const f = fakeAnvil({ wrongCreate: true });
    await expect(predeployLibraries(f.rpc, LIBS, OUT)).rejects.toThrow("does not hold the build's runtime code");
  });
  test("Base mainnet, a non-anvil node and a fork without the factory are refused, nothing sent", async () => {
    for (const o of [{ chain: 8453 }, { anvil: false }, { factory: false }]) {
      const f = fakeAnvil(o);
      await expect(predeployLibraries(f.rpc, LIBS, OUT)).rejects.toThrow();
      expect(f.calls).not.toContain("eth_sendTransaction");
    }
  });
});
