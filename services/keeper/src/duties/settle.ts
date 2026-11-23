// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.1 K1 and K2, §8.1.2 (gas floor, SideOutOfGas retry),
//            §8.1.4 (epoch_overdue).
import { queueAbi, SettleCheck, fundAbi } from "../abi.ts";
import { log } from "../alerts.ts";
import { calldata, read } from "../chain.ts";
import { settleFloor } from "../gas.ts";
import { route, type Ctx } from "./context.ts";

export const readCheck = async (ctx: Ctx) =>
  Number((await read<[number, bigint]>(ctx.io, queueAbi, ctx.cfg.queue, "checkSettle", [], ctx.caller))[0]);

export const assetCount = async (ctx: Ctx) => await read<bigint>(ctx.io, fundAbi, ctx.fund, "assetCount");

/**
 * K1 settles when checkSettle reads Ok; K2 settles again in the same tick while it still reads Ok, up to
 * maxCallsPerTick. A SettleSideOutOfGas revert retries once with the floor doubled. Returns the last check code.
 */
export async function settleDuty(ctx: Ctx, check: number): Promise<number> {
  const { cfg } = ctx;
  const assets = await assetCount(ctx);
  const tx = route(ctx, cfg.queue, calldata(queueAbi, "settle", [cfg.maxRequests, cfg.maxUsdc]));
  for (let calls = 0; calls < cfg.maxCallsPerTick && check === SettleCheck.Ok; calls++) {
    let r = await ctx.sender.send("settle", "settle", tx.to, tx.data, {
      floor: settleFloor(assets, cfg.maxRequests), ...ctx.sendHook?.("settle", 0),
    });
    if (r.status === "reverted" && r.reason.name === "SettleSideOutOfGas") {
      log("settle_retry", { reason: r.reason.text, gasLimit: r.gasLimit });
      r = await ctx.sender.send("settle", "settle", tx.to, tx.data, {
        floor: settleFloor(assets, cfg.maxRequests, 2n), ...ctx.sendHook?.("settle", 1),
      });
    }
    if (r.status !== "mined") break;
    ctx.lastSettleGas = r.receipt.gasUsed;
    check = await readCheck(ctx);
  }
  return check;
}

/**
 * epoch_overdue: an epoch with a pending request is settleable (checkSettle is not Window) and the latest epoch whose
 * window has ended did so more than overdueSecs ago. That age is a lower bound on how late the oldest pending epoch is.
 */
export async function overdueCheck(ctx: Ctx, check: number, now: number): Promise<void> {
  if (check === SettleCheck.Window) {
    ctx.alerts.resolve("epoch_overdue", "queue");
    return;
  }
  const cur = await read<bigint>(ctx.io, queueAbi, ctx.cfg.queue, "currentEpoch");
  for (let k = 1n; k <= 16n && k <= cur; k++) {
    const at = Number(await read<bigint>(ctx.io, queueAbi, ctx.cfg.queue, "settleableAt", [cur - k]));
    if (at > now) continue;
    if (now - at > ctx.cfg.overdueSecs) {
      ctx.alerts.raise("epoch_overdue", "queue", { epoch: cur - k, settleableAt: at, ageSecs: now - at, check });
    } else {
      ctx.alerts.resolve("epoch_overdue", "queue");
    }
    return;
  }
}

/** Seconds to the next tick: fastPollSecs while a settle is pending, or just past the current epoch's settleableAt. */
export async function nextWait(ctx: Ctx, check: number, now: number): Promise<number> {
  const { intervalSecs, fastPollSecs } = ctx.cfg;
  if (check !== SettleCheck.Window) return Math.min(fastPollSecs, intervalSecs);
  const cur = await read<bigint>(ctx.io, queueAbi, ctx.cfg.queue, "currentEpoch");
  const opens = Number(await read<bigint>(ctx.io, queueAbi, ctx.cfg.queue, "settleableAt", [cur])) - now;
  if (opens > 0 && opens < intervalSecs) return Math.max(fastPollSecs, opens + 2);
  return intervalSecs;
}
