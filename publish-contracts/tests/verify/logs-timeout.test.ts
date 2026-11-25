// Issue 2072: the windowed logs helper retries a timed-out window with the throttle backoff and --logs-tries, refuses RPC_REFUSED after its tries, and never retries 401/403.
import { describe, expect, test } from "bun:test";
import { HttpRequestError, TimeoutError } from "viem";
import { isTimeout, RPC_REFUSED_DETAIL, walkConcurrent } from "../../src/verify/logs.ts";
import type { ChainReader, LogEntry } from "../../src/verify/types.ts";

const LOG = { address: "0x0000000000000000000000000000000000000001", topics: ["0x" + "11".repeat(32)], data: "0x", blockNumber: 10n, logIndex: 0, transactionHash: "0x" + "22".repeat(32) } as unknown as LogEntry;

/** A fake RPC: getLogs answers with `fail(n)` for call n while it returns an error, then the one log. */
function fake(fail: (n: number) => unknown): { chain: ChainReader; calls: () => number } {
  let n = 0;
  const chain = { getLogs: async () => { const e = fail(n++); if (e !== undefined) throw e; return [LOG]; } } as unknown as ChainReader;
  return { chain, calls: () => n };
}
const run = (chain: ChainReader, tries = 3) => walkConcurrent(chain, { topics: [] }, 0n, 99n, 100, 1, tries, 1, () => {});
const tenderly = () => new Error("The request took too long to respond.");

describe("logs helper timeouts", () => {
  test("a timeout then success passes", async () => {
    const f = fake((n) => (n === 0 ? tenderly() : undefined));
    expect(await run(f.chain)).toEqual([LOG]);
    expect(f.calls()).toBe(2);
  });

  test("viem TimeoutError, HTTP 504 and ECONNRESET are retried", async () => {
    const errs = [
      new TimeoutError({ body: {}, url: "https://rpc.example" }),
      new HttpRequestError({ url: "https://rpc.example", status: 504 }),
      new HttpRequestError({ url: "https://rpc.example", cause: Object.assign(new Error("read"), { code: "ECONNRESET" }) }),
    ];
    const f = fake((n) => errs[n]);
    expect(await run(f.chain, 5)).toEqual([LOG]);
    expect(f.calls()).toBe(4);
  });

  test("persistent timeouts refuse RPC_REFUSED after the tries, never an empty answer", async () => {
    const f = fake(() => tenderly());
    await expect(run(f.chain, 3)).rejects.toThrow(new RegExp(`^${RPC_REFUSED_DETAIL}: getLogs 0-99 failed: The request took too long`));
    expect(f.calls()).toBe(4);
  });

  test("403 is not retried", async () => {
    const f = fake(() => new HttpRequestError({ url: "https://rpc.example", status: 403, details: "timed out key" }));
    await expect(run(f.chain)).rejects.toThrow(RPC_REFUSED_DETAIL);
    expect(f.calls()).toBe(1);
    expect(isTimeout(new HttpRequestError({ url: "https://rpc.example", status: 401 }))).toBe(false);
  });
});
