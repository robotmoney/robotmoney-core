// Issue 2044: the fund verifier's role-exclusivity scan. On the Twin (918453) it reads no log before the fork pin. Elsewhere it honors --logs-window,
// retries a throttled eth_getLogs with backoff and halves the window on an unnamed range limit.
import { describe, expect, test } from "bun:test";
import { keccak256, pad, toHex } from "viem";
import { Collector } from "../../src/verify/collector.ts";
import { SIG_ROLE_GRANTED } from "../../src/verify/constants.ts";
import { walkConcurrent } from "../../src/verify/logs.ts";
import { FUND_ROLES, TWIN_ROLE_SUFFIX, verifyExclusiveRole } from "../../src/verify/fund.ts";
import type { Address, ChainReader, Hex, LogEntry, VerifySheet } from "../../src/verify/types.ts";
import { TWIN_CHAIN_ID } from "../../src/chains.ts";

const A = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
const word = (a: Address): Hex => pad(a, { size: 32 }).toLowerCase() as Hex;
const GRANTED = keccak256(toHex(SIG_ROLE_GRANTED));
const REVOKED = keccak256(toHex("RoleRevoked(bytes32,address,address)"));
const TL = A(0x71e1), SAFE = A(0x5afe), EVE = A(0xe7e), ROLE = FUND_ROLES.PROPOSER;
const log = (t0: Hex, who: Address, block: bigint): LogEntry => ({ address: TL, topics: [t0, ROLE, word(who), word(SAFE)], data: "0x", blockNumber: block });

interface Stub { chain: ChainReader; calls: { from: bigint; to: bigint }[] }
function stub(o: { head: bigint; pin?: bigint; logs: LogEntry[]; holders: Address[]; fail?: (from: bigint, to: bigint, n: number) => unknown }): Stub {
  const calls: { from: bigint; to: bigint }[] = [];
  const chain = {
    chainId: async () => 0,
    blockNumber: async () => o.head,
    read: async (_at: Address, sig: string, args: unknown[] = []) => {
      if (sig.includes("getRoleMemberCount")) throw new Error("execution reverted"); // plain AccessControl: the log fallback runs
      if (sig.includes("hasRole")) return o.holders.map((h) => h.toLowerCase()).includes(String(args[1]).toLowerCase());
      throw new Error(`unexpected read ${sig}`);
    },
    getLogs: async (p: { topics: (Hex | Hex[] | null)[]; fromBlock: bigint; toBlock: bigint }) => {
      calls.push({ from: p.fromBlock, to: p.toBlock });
      const err = o.fail?.(p.fromBlock, p.toBlock, calls.length);
      if (err) throw err;
      const t0 = p.topics[0];
      const t0s = (Array.isArray(t0) ? t0 : [t0]).map((x) => String(x).toLowerCase());
      return o.logs.filter((l) => l.blockNumber >= p.fromBlock && l.blockNumber <= p.toBlock && t0s.includes(l.topics[0]!.toLowerCase()));
    },
    ...(o.pin !== undefined ? { forkPin: async () => o.pin } : {}),
  } as unknown as ChainReader;
  return { chain, calls };
}
const sheet = (chainId: number) => ({ chainId }) as VerifySheet;

async function run(s: Stub, chainId: number, extra: { logChunk?: number; logTries?: number; logConcurrency?: number } = {}) {
  const c = new Collector();
  await verifyExclusiveRole(c, s.chain, "timelock: PROPOSER_ROLE held exclusively by the Safe", TL, ROLE, [SAFE], { fromBlock: 1000n, sheet: sheet(chainId), retryBaseMs: 0, ...extra });
  return c.report().checks[0]!;
}

describe("Twin (918453): no log before the fork pin", () => {
  test("correct holders pass and no getLogs reaches at or below the pin", async () => {
    const s = stub({ head: 5000n, pin: 4000n, holders: [SAFE], logs: [log(GRANTED, SAFE, 1500n), log(GRANTED, SAFE, 4500n)] });
    const r = await run(s, TWIN_CHAIN_ID);
    expect(r.ok).toBe(true);
    expect(r.label.endsWith(TWIN_ROLE_SUFFIX)).toBe(true);
    expect(s.calls.length).toBeGreaterThan(0);
    for (const c of s.calls) expect(c.from > 4000n).toBe(true);
  });

  test("a grant after the pin to an unexpected account fails", async () => {
    const s = stub({ head: 5000n, pin: 4000n, holders: [SAFE], logs: [log(GRANTED, EVE, 4200n), log(REVOKED, EVE, 4300n)] });
    const r = await run(s, TWIN_CHAIN_ID);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("RoleGranted to unexpected");
  });

  test("a revoke of an expected holder after the pin fails, and a missing holder fails", async () => {
    const s = stub({ head: 5000n, pin: 4000n, holders: [], logs: [log(REVOKED, SAFE, 4200n)] });
    const r = await run(s, TWIN_CHAIN_ID);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("RoleRevoked from expected holder");
    expect(r.detail).toContain("does not hold the role now");
  });

  test("no fork pin: fails and reads no log", async () => {
    const s = stub({ head: 5000n, holders: [SAFE], logs: [] });
    const r = await run(s, TWIN_CHAIN_ID);
    expect(r.ok).toBe(false);
    expect(s.calls.length).toBe(0);
  });
});

describe("full history scan (any other chain)", () => {
  test("honors the window (--logs-window)", async () => {
    const s = stub({ head: 1999n, holders: [SAFE], logs: [log(GRANTED, SAFE, 1200n)] });
    const r = await run(s, 8453, { logChunk: 250 });
    expect(r.ok).toBe(true);
    expect(s.calls[0]).toEqual({ from: 1000n, to: 1249n });
    expect(s.calls.length).toBe(4);
    for (const c of s.calls) expect(c.to - c.from + 1n <= 250n).toBe(true);
  });

  test("retries a 429 then succeeds", async () => {
    const s = stub({ head: 1100n, holders: [SAFE], logs: [log(GRANTED, SAFE, 1050n)], fail: (_f, _t, n) => n <= 2 ? Object.assign(new Error("HTTP request failed"), { status: 429 }) : undefined });
    const r = await run(s, 8453, { logChunk: 2000, logTries: 3 });
    expect(r.ok).toBe(true);
    expect(s.calls.length).toBe(3);
  });

  test("retries JSON-RPC -32011, and gives up after --logs-tries with RPC_REFUSED", async () => {
    const s = stub({ head: 1100n, holders: [SAFE], logs: [], fail: () => Object.assign(new Error("request limit reached"), { code: -32011 }) });
    const r = await run(s, 8453, { logChunk: 2000, logTries: 2 });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("RPC_REFUSED");
    expect(s.calls.length).toBe(2);
  });

  test("halves the window on a 413, down to the floor, then fails RPC_REFUSED", async () => {
    const s = stub({ head: 2999n, holders: [SAFE], logs: [log(GRANTED, SAFE, 1500n)], fail: (f, t) => t - f + 1n > 500n ? Object.assign(new Error("Request Entity Too Large"), { status: 413 }) : undefined });
    const r = await run(s, 8453, { logChunk: 2000 });
    expect(r.ok).toBe(true);
    expect(s.calls.slice(0, 3).map((c) => c.to - c.from + 1n)).toEqual([2000n, 1000n, 500n]);

    const never = stub({ head: 2999n, holders: [SAFE], logs: [], fail: () => new Error("block range too large") });
    const r2 = await run(never, 8453, { logChunk: 400, logConcurrency: 1 });
    expect(r2.ok).toBe(false);
    expect(r2.detail).toContain("RPC_REFUSED");
    expect(never.calls.map((c) => c.to - c.from + 1n)).toEqual([400n, 200n, 100n, 50n]);
  });
});

// Issue 2070: windows read concurrently, results in block order, a failed window still refuses.
describe("walkConcurrent", () => {
  const delayed = (logs: LogEntry[], fail?: (from: bigint) => unknown) => {
    let inFlight = 0, peak = 0;
    const calls: bigint[] = [];
    const chain = {
      getLogs: async (p: { fromBlock: bigint; toBlock: bigint }) => {
        calls.push(p.fromBlock);
        inFlight++; peak = Math.max(peak, inFlight);
        // later windows answer first, so a naive push would come back out of order
        await new Promise((r) => setTimeout(r, Number(20_000n - p.fromBlock) / 1000));
        inFlight--;
        const e = fail?.(p.fromBlock);
        if (e) throw e;
        return logs.filter((l) => l.blockNumber >= p.fromBlock && l.blockNumber <= p.toBlock);
      },
    } as unknown as ChainReader;
    return { chain, calls, peak: () => peak };
  };
  const logs = Array.from({ length: 40 }, (_, i) => log(GRANTED, SAFE, BigInt(1000 + i * 250)));

  test("bounded concurrency, every window once, results in block order", async () => {
    const d = delayed(logs);
    const out = await walkConcurrent(d.chain, { address: TL, topics: [GRANTED] }, 1000n, 10_999n, 1000, 0, 0, 4, () => {});
    expect(out.map((l) => l.blockNumber)).toEqual(logs.map((l) => l.blockNumber));
    expect(d.peak()).toBe(4);
    expect(d.calls.length).toBe(10);
  });

  test("a window that fails after its retries rejects RPC_REFUSED, never a partial answer", async () => {
    const d = delayed(logs, (f) => f === 5000n ? Object.assign(new Error("HTTP request failed"), { status: 429 }) : undefined);
    await expect(walkConcurrent(d.chain, { address: TL, topics: [GRANTED] }, 1000n, 10_999n, 1000, 0, 1, 8, () => {})).rejects.toThrow(/RPC_REFUSED: getLogs 5000-5999/);
    expect(d.calls.filter((x) => x === 5000n).length).toBe(2);
  });

  test("progress on stderr every 100 windows: blocks done out of the total", async () => {
    const lines: string[] = [];
    const chain = { getLogs: async () => [] } as unknown as ChainReader;
    await walkConcurrent(chain, { address: TL, topics: [GRANTED] }, 0n, 249_999n, 1000, 0, 0, 8, (l) => lines.push(l));
    expect(lines.length).toBe(3);
    expect(lines.at(-1)).toContain("250000/250000 blocks (250/250 windows)");
  });
});
