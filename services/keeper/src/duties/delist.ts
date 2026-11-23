// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.1 K4. Ported from the delist gate of
// scripts/ops/onevault-keeper.sh. For each asset in sale, stepDelisted(i) is simulated as the KEEPER_ROLE holder:
//   - it reverts: delist_step_reverted, nothing sent;
//   - it returns true: send;
//   - false while the asset's backoff runs: a backoff skip, logged, no alert;
//   - false with no backoff: the fund's sale step is simulated as the Rebalancer. A revert there means the sale fails
//     and the Rebalancer would swallow it, so alert. Success means the Rebalancer's interval or cap held it: a skip.
import { decodeRevert, fundAbi, rebalancerAbi, revertDataOf } from "../abi.ts";
import { log } from "../alerts.ts";
import { calldata, read } from "../chain.ts";
import { route, type Ctx } from "./context.ts";

const UINT_MAX = (1n << 256n) - 1n;

export async function delistDuty(ctx: Ctx, now: number): Promise<void> {
  const { cfg } = ctx;
  const n = await read<bigint>(ctx.io, fundAbi, ctx.fund, "assetCount");
  for (let i = 0n; i < n; i++) {
    if (!(await read<boolean>(ctx.io, fundAbi, ctx.fund, "isAssetInSale", [i]))) continue;
    const cause = `delist_step:${i}`;
    let ok: boolean;
    try {
      ok = await read<boolean>(ctx.io, rebalancerAbi, cfg.rebalancer, "stepDelisted", [i], ctx.caller);
    } catch (e) {
      ctx.alerts.raise("delist_step_reverted", cause, { stage: "simulate", index: i, reason: decodeRevert(revertDataOf(e)).text });
      continue;
    }
    if (!ok) {
      const backoff = Number(await read<bigint>(ctx.io, rebalancerAbi, cfg.rebalancer, "assetBackoffUntil", [i]));
      if (backoff >= now) {
        ctx.metrics.skip("delist_backoff");
        log("skip", { duty: "delist_step", index: i, backoffUntil: backoff, chainTime: now });
        continue;
      }
      try {
        await read(ctx.io, fundAbi, ctx.fund, "executeDelistStep", [i, UINT_MAX], cfg.rebalancer);
        ctx.metrics.skip("delist_interval");
        log("skip", { duty: "delist_step", index: i, why: "rebalancer interval or cap" });
      } catch (e) {
        ctx.alerts.raise("delist_step_reverted", cause, {
          stage: "simulate", index: i, reason: `the sale would revert and the rebalancer catches it: ${decodeRevert(revertDataOf(e)).text}`,
        });
      }
      continue;
    }
    const tx = route(ctx, cfg.rebalancer, calldata(rebalancerAbi, "stepDelisted", [i]));
    await ctx.sender.send("delist_step", cause, tx.to, tx.data, ctx.sendHook?.("delist_step", 0));
  }
}
