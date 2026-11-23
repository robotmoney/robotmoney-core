// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.1 K3, §5.4 (who calls step()).
// previewStep does not run the fund's step, so a step that would fail still reads None. step() is simulated as the
// KEEPER_ROLE holder before any send. Concluded is due too: that step() moves the plan to its terminal status.
import { rebalancerAbi, SkipReason } from "../abi.ts";
import { decodeRevert, revertDataOf } from "../abi.ts";
import { log } from "../alerts.ts";
import { calldata, read } from "../chain.ts";
import { route, type Ctx } from "./context.ts";

const due = (r: number) => r === SkipReason.None || r === SkipReason.Concluded;

export async function stepDuty(ctx: Ctx): Promise<void> {
  const { cfg } = ctx;
  const [preview] = await read<[number, bigint, bigint, bigint]>(ctx.io, rebalancerAbi, cfg.rebalancer, "previewStep");
  if (!due(Number(preview))) {
    ctx.metrics.skip(`step:${preview}`);
    log("skip", { duty: "step", skipReason: Number(preview) });
    return;
  }
  let sim: number;
  try {
    sim = Number((await read<[boolean, number]>(ctx.io, rebalancerAbi, cfg.rebalancer, "step", [], ctx.caller))[1]);
  } catch (e) {
    ctx.alerts.raise("step_reverted", "step", { stage: "simulate", reason: decodeRevert(revertDataOf(e)).text });
    return;
  }
  if (sim === SkipReason.StepFailed) {
    ctx.alerts.raise("step_reverted", "step", { stage: "simulate", reason: "simulated step() returned StepFailed; nothing sent" });
    return;
  }
  if (!due(sim)) {
    ctx.metrics.skip(`step:${sim}`);
    log("skip", { duty: "step", simulatedSkipReason: sim });
    return;
  }
  const tx = route(ctx, cfg.rebalancer, calldata(rebalancerAbi, "step"));
  await ctx.sender.send("step", "step", tx.to, tx.data, ctx.sendHook?.("step", 0));
}
