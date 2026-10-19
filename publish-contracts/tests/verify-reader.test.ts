// Deploy 3 (2026-10-18): the verifier's eth_getLogs goes to --logs-rpc when it is given; every other read stays on --rpc.
import { describe, expect, test } from "bun:test";
import { verifyReader } from "../src/verify-stage.ts";
import type { ChainReader } from "../src/verify/index.ts";

const fake = (calls: string[]) => (url: string): ChainReader => ({
  chainId: async () => { calls.push(`chainId@${url}`); return 8453; },
  getLogs: async () => { calls.push(`getLogs@${url}`); return []; },
} as unknown as ChainReader);

describe("verifyReader", () => {
  test("getLogs on the logs RPC, the other reads on --rpc", async () => {
    const calls: string[] = [];
    const r = verifyReader({ rpc: "http://rpc.test", logs: { logsRpc: "http://logs.test" } }, fake(calls));
    await r.chainId(); await r.getLogs({ fromBlock: 1n, toBlock: 2n, topics: [] } as never);
    expect(calls).toEqual(["chainId@http://rpc.test", "getLogs@http://logs.test"]);
  });
  test("mutation: without --logs-rpc every read is on --rpc", async () => {
    const calls: string[] = [];
    const r = verifyReader({ rpc: "http://rpc.test" }, fake(calls));
    await r.chainId(); await r.getLogs({ fromBlock: 1n, toBlock: 2n, topics: [] } as never);
    expect(calls).toEqual(["chainId@http://rpc.test", "getLogs@http://rpc.test"]);
  });
});
