/**
 * Unit tests — bounded timelock log scans (core 1544). `eth_getLogs` from block 0
 * to latest is rejected by RPCs and by a Twin fork's upstream ("limited to a 500
 * range"), so the panel scans from the timelock's deployment block, in pages.
 */
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import {
  LOG_PAGE_BLOCKS,
  LOG_PAGE_CONCURRENCY,
  findDeploymentBlock,
  parseDeployBlock,
  scanInPages,
  type DeploymentProbeClient,
} from "../../src/lib/timelockApi";

const ADDR = "0x1111111111111111111111111111111111111111" as Address;

function chainWithDeployment(deployedAt: bigint, latest: bigint, failBelow?: bigint) {
  const probes: bigint[] = [];
  const client: DeploymentProbeClient = {
    getBlockNumber: async () => latest,
    getCode: async ({ blockNumber }) => {
      const b = blockNumber ?? latest;
      probes.push(b);
      if (failBelow !== undefined && b < failBelow) throw new Error("state not available");
      return b >= deployedAt ? "0x6001" : "0x";
    },
  };
  return { client, probes };
}

describe("findDeploymentBlock", () => {
  it.each([1n, 2n, 63n, 64n, 65n, 777n, 4_999n, 5_000n])(
    "finds a deployment at block %s exactly",
    async (deployedAt) => {
      const { client } = chainWithDeployment(deployedAt, 5_000n);
      expect(await findDeploymentBlock(client, ADDR)).toEqual({
        from: deployedAt,
        to: 5_000n,
        incomplete: false,
      });
    },
  );

  it("costs a handful of probes for a recent deployment on a long chain", async () => {
    const { client, probes } = chainWithDeployment(52_303_000n, 52_303_564n);
    const r = await findDeploymentBlock(client, ADDR);
    expect(r.from).toBe(52_303_000n);
    expect(probes.length).toBeLessThan(30);
  });

  it("flags the range incomplete when a probe errors (state unavailable), so the late start is never silent", async () => {
    const { client } = chainWithDeployment(100n, 10_000n, 9_000n);
    const r = await findDeploymentBlock(client, ADDR);
    expect(r.from >= 9_000n).toBe(true);
    expect(r.to).toBe(10_000n);
    expect(r.incomplete).toBe(true);
  });

  it("does not flag a range incomplete when every probe answers", async () => {
    const { client } = chainWithDeployment(777n, 5_000n);
    expect((await findDeploymentBlock(client, ADDR)).incomplete).toBe(false);
  });

  it("returns the head when the address has no code at all", async () => {
    const { client } = chainWithDeployment(9_999_999n, 500n);
    expect(await findDeploymentBlock(client, ADDR)).toEqual({
      from: 500n,
      to: 500n,
      incomplete: false,
    });
  });

  it("starts at block 0 for a contract present since genesis", async () => {
    const { client } = chainWithDeployment(0n, 300n);
    expect(await findDeploymentBlock(client, ADDR)).toEqual({
      from: 0n,
      to: 300n,
      incomplete: false,
    });
  });
});

describe("scanInPages", () => {
  it("never asks for more than LOG_PAGE_BLOCKS blocks and covers the range once", async () => {
    const calls: Array<[bigint, bigint]> = [];
    const out = await scanInPages({ from: 1_000n, to: 2_700n }, async (from, to) => {
      calls.push([from, to]);
      return [from];
    });
    expect(calls.map(([f, t]) => t - f + 1n).every((n) => n <= LOG_PAGE_BLOCKS)).toBe(true);
    expect(calls[0]?.[0]).toBe(1_000n);
    expect(calls[calls.length - 1]?.[1]).toBe(2_700n);
    for (let i = 1; i < calls.length; i += 1) {
      expect(calls[i]?.[0]).toBe((calls[i - 1]?.[1] ?? 0n) + 1n);
    }
    expect(out).toHaveLength(calls.length);
  });

  it("makes one call for a single-block range", async () => {
    const calls: Array<[bigint, bigint]> = [];
    await scanInPages({ from: 5n, to: 5n }, async (f, t) => {
      calls.push([f, t]);
      return [];
    });
    expect(calls).toEqual([[5n, 5n]]);
  });
});

describe("scanInPages concurrency", () => {
  it("fetches pages concurrently, a bounded number at a time, and returns results in block order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await scanInPages({ from: 0n, to: 500n * 20n - 1n }, async (from) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return [from];
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(LOG_PAGE_CONCURRENCY);
    expect(out).toEqual(Array.from({ length: 20 }, (_, i) => BigInt(i) * 500n));
  });
});

describe("parseDeployBlock", () => {
  it("reads a non-negative integer and ignores anything else", () => {
    expect(parseDeployBlock("123")).toBe(123n);
    expect(parseDeployBlock(" 0 ")).toBe(0n);
    expect(parseDeployBlock("")).toBeUndefined();
    expect(parseDeployBlock(undefined)).toBeUndefined();
    expect(parseDeployBlock("-5")).toBeUndefined();
    expect(parseDeployBlock("0x10")).toBeUndefined();
    expect(parseDeployBlock("12.5")).toBeUndefined();
  });
});
