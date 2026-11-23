// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.7 (an anvil test settles a deposit and a redemption,
// steps a plan, and sells a delisted asset, in both account and direct mode).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseAbi, type Address } from "viem";
import { deployStack, helpers, type Stack } from "./harness.ts";
import { makeKeeper } from "./keeper-fixture.ts";

const Q = parseAbi([
  "function requestRedeem(uint256,address) returns (uint256)", "function deposit(uint256,address) returns (uint256)",
  "function maxDeposit(address) view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

for (const mode of ["account", "direct"] as const) {
  describe(`keeper service on anvil, ${mode} mode`, () => {
    let s: Stack;
    let h: ReturnType<typeof helpers>;
    let k: Awaited<ReturnType<typeof makeKeeper>>;

    beforeAll(async () => {
      s = await deployStack(mode);
      h = helpers(s);
      k = await makeKeeper(s);
    }, 600_000);
    afterAll(() => s?.stop());

    test("an idle queue sends nothing and raises no alert", async () => {
      const r = await k.keeper.tick();
      expect(r.alerts).toBe(0);
      expect(k.keeper.ctx.metrics.sends.settle ?? 0).toBe(0);
    });

    test("settles a deposit", async () => {
      await h.requestDeposit(s.deployer);
      await h.waitForRound();
      await h.refreshFeeds();
      const before = await h.settlements();
      const r = await k.keeper.tick();
      expect(k.alertLines()).toEqual([]);
      expect(r.alerts).toBe(0);
      expect(await h.settlements()).toBeGreaterThan(before);
      expect(k.keeper.ctx.metrics.sends.settle).toBeGreaterThanOrEqual(1);
      expect(k.lines.some((l) => l.includes('"event":"mined"') && l.includes('"duty":"settle"'))).toBe(true);
    }, 120_000);

    test("settles a redemption", async () => {
      // The deposit's shares unlock after minHold (1 h); the owner claims them, then requests a redemption of half.
      await h.warp(7200);
      await h.refreshFeeds();
      const queue = h.A("QUEUE"), fund = h.A("FUND");
      const claimable = (await h.pub.readContract({ address: queue, abi: Q, functionName: "maxDeposit", args: [s.deployer] })) as bigint;
      expect(claimable).toBeGreaterThan(0n);
      await h.sendAbi(s.deployer, queue, Q, "deposit", [claimable, s.deployer]);
      const shares = (await h.pub.readContract({ address: fund, abi: Q, functionName: "balanceOf", args: [s.deployer] })) as bigint;
      expect(shares).toBeGreaterThan(0n);
      await h.sendAbi(s.deployer, fund, Q, "approve", [queue, shares / 2n]);
      await h.sendAbi(s.deployer, queue, Q, "requestRedeem", [shares / 2n, s.deployer]);
      await h.waitForRound();
      await h.refreshFeeds();
      const before = await h.settlements();
      const escrowBefore = (await h.pub.readContract({ address: fund, abi: Q, functionName: "balanceOf", args: [queue] })) as bigint;
      k.clear();
      const r = await k.keeper.tick();
      expect(k.alertLines()).toEqual([]);
      expect(r.alerts).toBe(0);
      expect(await h.settlements()).toBeGreaterThan(before);
      const escrowAfter = (await h.pub.readContract({ address: fund, abi: Q, functionName: "balanceOf", args: [queue] })) as bigint;
      expect(escrowAfter).toBeLessThan(escrowBefore); // the redeemed shares left escrow (burned)
    }, 120_000);

    test("steps a plan with a lending target", async () => {
      await h.refreshFeeds();
      await h.send(s.deployer, h.A("FUND"), "setTargetAndOpenPlan", [
        [h.A("LENDING_ADAPTER"), h.A("BASKET_TOKEN")], [10000n, 0n], [86400n, 30], `0x${"0".repeat(64)}`,
      ]);
      await h.warp(43200);
      await h.refreshFeeds();
      k.clear();
      await k.keeper.tick();
      expect(k.alertLines().filter((a) => a.alert === "step_reverted")).toEqual([]);
      expect(k.keeper.ctx.metrics.sends.step).toBeGreaterThanOrEqual(1);
      expect(await h.call<bigint>(h.A("A_TOKEN"), "balanceOf", [h.A("LENDING_ADAPTER")])).toBeGreaterThan(0n);
    }, 120_000);

    test("sells a delisted asset", async () => {
      const idx = BigInt(s.a.BASKET_INDEX!);
      await h.send(s.deployer, h.A("BASKET_TOKEN"), "mint", [h.A("FUND"), 1_000_000_000n]);
      await h.refreshFeeds();
      await h.send(s.deployer, h.A("FUND"), "delistAsset", [idx]);
      await h.refreshFeeds();
      expect(await h.call<boolean>(h.A("FUND"), "isAssetInSale", [idx])).toBe(true);
      k.clear();
      await k.keeper.tick();
      expect(k.alertLines().filter((a) => a.alert === "delist_step_reverted")).toEqual([]);
      expect(k.keeper.ctx.metrics.sends.delist_step).toBeGreaterThanOrEqual(1);
      expect(await h.call<boolean>(h.A("FUND"), "isAssetInSale", [idx])).toBe(false);
    }, 120_000);
  });
}

export type { Address };
