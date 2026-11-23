// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.1 (tick order), §8.1.3 (start-up checks),
//            §8.1.4 (low_gas, queue_paused, rpc_unreadable).
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { keeperAccountAbi, queueAbi, rebalancerAbi, SettleCheck } from "./abi.ts";
import { Alerts, log } from "./alerts.ts";
import { read } from "./chain.ts";
import { checkChainId, checkManifest, ConfigError, type Config } from "./config.ts";
import type { Ctx } from "./duties/context.ts";
import { delistDuty } from "./duties/delist.ts";
import { assetCount, nextWait, overdueCheck, readCheck, settleDuty } from "./duties/settle.ts";
import { stepDuty } from "./duties/step.ts";
import { settleFloor } from "./gas.ts";
import { Metrics } from "./health.ts";
import { Sender, type ChainIO, type Duty, type SendOptions } from "./sender.ts";
import type { KeeperState } from "./state.ts";

export interface KeeperDeps {
  cfg: Config;
  io: ChainIO;
  key: Address;
  state: KeeperState;
  alerts?: Alerts;
  metrics?: Metrics;
  pollMs?: number;
  sendHook?: (duty: Duty, attempt: number) => SendOptions;
}

export interface TickResult { alerts: number; nextWaitSecs: number }

const short = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 300);

export class Keeper {
  readonly ctx: Ctx;

  constructor(private readonly d: KeeperDeps) {
    const { cfg, io, key, state } = d;
    const alerts = d.alerts ?? new Alerts({ realertSecs: cfg.realertSecs, webhook: cfg.alertWebhook, queue: cfg.queue, active: state.alerts });
    const metrics = d.metrics ?? new Metrics();
    metrics.lastSettleAt = state.lastSettleAt;
    const sender = new Sender({
      io, from: key, alerts, metrics, gasMultiplier: cfg.gasMultiplier, maxFeeGwei: cfg.maxFeeGwei,
      receiptTimeoutSecs: cfg.receiptTimeoutSecs, maxReplacements: cfg.maxReplacements, pollMs: d.pollMs,
      onPending: (p) => state.pending.push({ ...p, sentAt: Math.floor(Date.now() / 1000) }),
      onSettled: (h) => { state.pending = state.pending.filter((p) => p.hash !== h); },
    });
    this.ctx = {
      cfg, io, key, caller: cfg.keeperAccount ?? key, fund: "0x0000000000000000000000000000000000000000",
      alerts, metrics, sender, sendHook: d.sendHook,
    };
  }

  /** Start-up checks. Any failure alerts keeper_unconfigured and throws ConfigError (exit 2). */
  async startup(): Promise<void> {
    const { cfg, io, key, alerts, metrics } = this.ctx;
    try {
      checkChainId(cfg, await io.chainId());
      if (cfg.manifest) checkManifest(cfg, readFileSync(cfg.manifest, "utf8"));
      const holder = cfg.keeperAccount ?? key;
      if (cfg.keeperAccount && !(await read<boolean>(io, keeperAccountAbi, cfg.keeperAccount, "isBotKey", [key]))) {
        throw new ConfigError(`key ${key} is not a bot key of KeeperAccount ${cfg.keeperAccount}`);
      }
      for (const [name, addr, abi] of [["queue", cfg.queue, queueAbi], ["rebalancer", cfg.rebalancer, rebalancerAbi]] as const) {
        const role = await read<`0x${string}`>(io, abi, addr, "KEEPER_ROLE");
        if (!(await read<boolean>(io, abi, addr, "hasRole", [role, holder]))) {
          throw new ConfigError(`${cfg.keeperAccount ? "account" : "direct"} mode: ${holder} does not hold KEEPER_ROLE on the ${name} ${addr}`);
        }
      }
      this.ctx.fund = await read<Address>(io, rebalancerAbi, cfg.rebalancer, "fund");
    } catch (e) {
      metrics.unconfigured = true;
      const err = e instanceof ConfigError ? e : new ConfigError(`start-up read failed: ${short(e)}`);
      alerts.raise("keeper_unconfigured", "startup", { detail: err.message });
      throw Object.assign(err, { alerted: true });
    }
    alerts.resolve("keeper_unconfigured", "startup");
    await this.recoverPending();
    log("started", { mode: cfg.keeperAccount ? "account" : "direct", key, caller: this.ctx.caller, queue: cfg.queue, rebalancer: cfg.rebalancer });
  }

  /** Sends left unconfirmed by a previous run: report how each ended, then forget them. */
  private async recoverPending(): Promise<void> {
    for (const p of this.d.state.pending) {
      try {
        const r = await this.ctx.io.receipt(p.hash as `0x${string}`);
        log("pending_from_last_run", { ...p, status: r?.status ?? "not_found" });
        if (r?.status === "reverted") {
          this.ctx.alerts.raise(`${p.duty as Duty}_reverted`, p.duty, { hash: p.hash, gasUsed: r.gasUsed, reason: "mined reverted before restart" });
        }
      } catch { /* unreadable: dropped, the chain is the source of truth */ }
    }
    this.d.state.pending = [];
  }

  /** One tick: K1, K2, K3, K4 in order. A failed duty does not stop the others. */
  async tick(): Promise<TickResult> {
    const ctx = this.ctx;
    const { cfg, io, alerts, metrics } = ctx;
    alerts.takeCount();
    let nextWaitSecs = cfg.intervalSecs;
    let readable = true;
    const guard = async (what: string, f: () => Promise<void>) => {
      try {
        await f();
      } catch (e) {
        readable = false;
        alerts.raise("rpc_unreadable", what, { error: short(e) });
      }
    };
    await guard("tick", async () => {
      const [balance, live, fees, now] = await Promise.all([
        io.balance(ctx.key),
        read<{ keeperConfigured: boolean; queuePausedNow: boolean }>(io, queueAbi, cfg.queue, "liveness"),
        io.fees(),
        io.blockTimestamp().then(Number),
      ]);
      metrics.balanceWei = balance;
      metrics.nonce = ctx.sender.currentNonce;
      if (!live.keeperConfigured) {
        alerts.raise("keeper_unconfigured", "role", { detail: `queue ${cfg.queue} has no KEEPER_ROLE holder` });
        return;
      }
      alerts.resolve("keeper_unconfigured", "role");

      // low_gas: below minGasWei nothing is sent; below the runway it alerts but still sends.
      const settleGas = ctx.lastSettleGas ?? settleFloor(await assetCount(ctx), 1n);
      const runway = BigInt(cfg.runwaySettles) * settleGas * (fees.baseFee + fees.priorityFee);
      const canSend = balance >= cfg.minGasWei;
      if (!canSend) alerts.raise("low_gas", "min", { balanceWei: balance, minGasWei: cfg.minGasWei, detail: "nothing sent" });
      else alerts.resolve("low_gas", "min");
      if (balance < runway) alerts.raise("low_gas", "runway", { balanceWei: balance, runwayWei: runway, runwaySettles: cfg.runwaySettles });
      else alerts.resolve("low_gas", "runway");

      let check = -1;
      await guard("settle", async () => {
        if (live.queuePausedNow) {
          alerts.raise("queue_paused", "queue", { detail: "settle skipped" });
          metrics.skip("settle:paused");
        } else {
          alerts.resolve("queue_paused", "queue");
        }
        check = await readCheck(ctx);
        if (check === SettleCheck.Ok && canSend) check = await settleDuty(ctx, check);
        else if (check !== SettleCheck.Ok) {
          metrics.skip(`settle:${check}`);
          log("skip", { duty: "settle", check });
        }
        await overdueCheck(ctx, check, now);
        nextWaitSecs = await nextWait(ctx, check, now);
      });
      if (canSend) {
        await guard("step", () => stepDuty(ctx));
        await guard("delist_step", () => delistDuty(ctx, now));
      }
    });
    if (readable) for (const w of ["tick", "settle", "step", "delist_step"]) alerts.resolve("rpc_unreadable", w);
    metrics.ticks++;
    metrics.lastTickAt = Math.floor(Date.now() / 1000);
    this.d.state.lastTickAt = metrics.lastTickAt;
    this.d.state.lastSettleAt = metrics.lastSettleAt;
    const n = alerts.takeCount();
    log("tick", { alerts: n, nextWaitSecs, balanceWei: metrics.balanceWei });
    return { alerts: n, nextWaitSecs };
  }
}
