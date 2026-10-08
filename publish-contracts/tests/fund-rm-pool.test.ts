// Core 1554: the Twin chain step that funds the live RM/USDC pool so the rmAGENT deploy can add RM. The step itself is proven on the Twin chain
// (the twin publish jobs run it for real and assert rmAGENT holds RM). These tests cover the parts that need no chain: the tick maths, the config read
// and the refusals that keep it off a real chain.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fundRmPool, readRmPoolFacts, tickRangeAround, TwinError, type Rpc } from "../src/rehearsal/twin.ts";

const core = join(import.meta.dir, "..", "..");

describe("fund-rm-pool", () => {
  test("the tick range floors negative ticks to the spacing bucket that holds the price", () => {
    expect(tickRangeAround(-389_201, 200)).toEqual([-389_400, -389_200]);
    expect(tickRangeAround(-389_200, 200)).toEqual([-389_200, -389_000]);
    expect(tickRangeAround(150, 200)).toEqual([0, 200]);
  });
  test("the facts are the RM entry of the committed shortlist", () => {
    const f = readRmPoolFacts(core);
    expect(f.token.toLowerCase()).toBe("0x65021a79aeef22b17cdc1b768f5e79a8618beba3");
    expect(f.pool.toLowerCase()).toBe("0x8cd8c7015b6a8f8310c15ccc8aa3d200d9c74882");
    expect(f.fee).toBe(10000);
  });
  test("a core checkout without an RM entry is refused", () => {
    expect(() => readRmPoolFacts(join(core, "publish-contracts", "tests", "fixtures"))).toThrow();
  });
  test("Base mainnet is refused before any write", async () => {
    const calls: string[] = [];
    const rpc: Rpc = async (m) => { calls.push(m); if (m === "eth_chainId") return "0x2105"; return null; };
    await expect(fundRmPool(rpc, readRmPoolFacts(core))).rejects.toThrow(/Base mainnet/);
    expect(calls).toEqual(["eth_chainId"]);
  });
  test("a pool whose token0 is not RM is refused before any write", async () => {
    const calls: string[] = [];
    const rpc: Rpc = async (m) => {
      calls.push(m);
      if (m === "eth_chainId") return "0xe0cb5";
      if (m === "anvil_nodeInfo") return {};
      if (m === "eth_call") return "0x" + "11".repeat(20).padStart(64, "0");
      throw new Error(`unexpected ${m}`);
    };
    await expect(fundRmPool(rpc, readRmPoolFacts(core))).rejects.toThrow(TwinError);
    expect(calls.some((m) => m.startsWith("anvil_set") || m === "eth_sendTransaction")).toBe(false);
  });
});
