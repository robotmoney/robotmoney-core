// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.2 and §8.1.7 (an anvil test forces a mined revert, a
// settle sent with too little gas, and checks for settle_reverted with the decoded reason). This is the Base 8453 fault
// of 2026-11-23: the shell keeper logged that revert as sent. The service alerts it, then the doubled-floor retry settles.
// It also runs the real CLI once (--once, password on stdin) to settle in account mode end to end.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { encodeFunctionData, type Address } from "viem";
import { decodeRevert, keeperAccountAbi, queueAbi, revertDataOf } from "../src/abi.ts";
import { runCli } from "../test/helpers/cli.ts";
import { FIXTURE_PASSWORD, tmp } from "../test/helpers/fixtures.ts";
import { deployStack, helpers, type Stack } from "./harness.ts";
import { makeKeeper } from "./keeper-fixture.ts";

for (const mode of ["direct", "account"] as const) {
  describe(`forced mined revert, ${mode} mode`, () => {
    let s: Stack;
    let h: ReturnType<typeof helpers>;
    beforeAll(async () => {
      s = await deployStack(mode);
      h = helpers(s);
    }, 600_000);
    afterAll(() => s?.stop());

    test("a settle mined with too little gas alerts settle_reverted (SettleSideOutOfGas), then the doubled floor settles", async () => {
      await h.requestDeposit(s.deployer);
      await h.waitForRound();
      await h.refreshFeeds();

      // Find a limit that passes the walk but trips the side guard: just under eth_estimateGas.
      const inner = encodeFunctionData({ abi: queueAbi, functionName: "settle", args: [100n, (1n << 256n) - 1n] });
      const to = (s.keeperAccount ?? h.A("QUEUE")) as Address;
      const data = s.keeperAccount
        ? encodeFunctionData({ abi: keeperAccountAbi, functionName: "execute", args: [h.A("QUEUE"), inner] })
        : inner;
      const estimate = await h.pub.estimateGas({ account: s.bot.address, to, data });
      let low = 0n;
      for (let g = estimate - 10_000n; g > 500_000n && !low; g -= 50_000n) {
        try {
          await h.pub.call({ account: s.bot.address, to, data, gas: g });
        } catch (e) {
          if (decodeRevert(revertDataOf(e)).name === "SettleSideOutOfGas") low = g;
        }
      }
      expect(low).toBeGreaterThan(0n);

      const k = await makeKeeper(s, (duty, attempt) => (duty === "settle" && attempt === 0 ? { gasLimitOverride: low } : {}));
      const before = await h.settlements();
      await k.keeper.tick();
      const alerts = k.alertLines();
      const rev = alerts.find((a) => a.alert === "settle_reverted" && !a.recovered);
      expect(rev).toBeDefined();
      expect(rev.reason).toContain("SettleSideOutOfGas");
      expect(rev.gasLimit).toBe(String(low));
      expect(rev.hash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(Number(rev.gasUsed)).toBeGreaterThan(0);
      const mined = await h.pub.getTransactionReceipt({ hash: rev.hash });
      expect(mined.status).toBe("reverted"); // it really was mined, with status 0
      expect(k.lines.some((l) => l.includes('"event":"settle_retry"'))).toBe(true);
      expect(alerts.some((a) => a.alert === "settle_reverted" && a.recovered)).toBe(true);
      expect(await h.settlements()).toBeGreaterThan(before);
      expect(k.keeper.ctx.metrics.reverts.settle).toBe(1);
      expect(k.keeper.ctx.metrics.sends.settle).toBeGreaterThanOrEqual(1);
    }, 180_000);

    if (mode === "account") {
      test("the CLI settles once with the password on stdin and prints no secret", async () => {
        await h.requestDeposit(s.deployer);
        await h.waitForRound();
        await h.refreshFeeds();
        const before = await h.settlements();
        const r = await runCli(["--once"], {
          KEEPER_RPC_URL: s.rpcUrl, KEEPER_CHAIN_ID: "31337", KEEPER_QUEUE: h.A("QUEUE"), KEEPER_REBALANCER: h.A("REBALANCER"),
          KEEPER_KEEPER_ACCOUNT: s.keeperAccount!, KEEPER_KEYSTORE: s.bot.keystore, KEEPER_STATE_DIR: join(tmp(), "state"),
          KEEPER_HEALTH_PORT: "0", KEEPER_MAX_FEE_GWEI: "100",
        }, FIXTURE_PASSWORD + "\n", 120_000);
        expect(r.err).not.toContain(FIXTURE_PASSWORD);
        expect(r.code).toBe(0);
        expect(r.err).toContain('"event":"mined"');
        expect(await h.settlements()).toBeGreaterThan(before);
      }, 180_000);
    }
  });
}
