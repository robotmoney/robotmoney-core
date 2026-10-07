/**
 * Unit tests — bounded timelock log scans (core 1544). `eth_getLogs` from block 0
 * to latest is rejected by RPCs and by a Twin fork's upstream ("limited to a 500
 * range"), so the panel scans from the timelock's deployment block, in pages.
 */
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import {
  LOG_PAGE_BLOCKS,
  findDeploymentBlock,
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
      expect(await findDeploymentBlock(client, ADDR)).toEqual({ from: deployedAt, to: 5_000n });
    },
  );

  it("costs a handful of probes for a recent deployment on a long chain", async () => {
    const { client, probes } = chainWithDeployment(52_303_000n, 52_303_564n);
    const r = await findDeploymentBlock(client, ADDR);
    expect(r.from).toBe(52_303_000n);
    expect(probes.length).toBeLessThan(30);
  });

  it("treats a probe that errors (state unavailable) as no code, so it never scans further back", async () => {
    const { client } = chainWithDeployment(100n, 10_000n, 9_000n);
    const r = await findDeploymentBlock(client, ADDR);
    expect(r.from >= 9_000n).toBe(true);
    expect(r.to).toBe(10_000n);
  });

  it("returns the head when the address has no code at all", async () => {
    const { client } = chainWithDeployment(9_999_999n, 500n);
    expect(await findDeploymentBlock(client, ADDR)).toEqual({ from: 500n, to: 500n });
  });

  it("starts at block 0 for a contract present since genesis", async () => {
    const { client } = chainWithDeployment(0n, 300n);
    expect(await findDeploymentBlock(client, ADDR)).toEqual({ from: 0n, to: 300n });
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
