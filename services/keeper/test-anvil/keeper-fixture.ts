// Builds an in-process Keeper against a deployed anvil stack, with alert and log lines captured for assertions.
import type { Address } from "viem";
import { Alerts, setLogWriter } from "../src/alerts.ts";
import { makeChainIO } from "../src/chain.ts";
import { buildConfig } from "../src/config.ts";
import { Keeper } from "../src/keeper.ts";
import type { Duty, SendOptions } from "../src/sender.ts";
import { emptyState } from "../src/state.ts";
import { tmp } from "../test/helpers/fixtures.ts";
import type { Stack } from "./harness.ts";

export async function makeKeeper(s: Stack, sendHook?: (d: Duty, attempt: number) => SendOptions) {
  const lines: string[] = [];
  setLogWriter((l) => lines.push(l));
  const cfg = buildConfig({
    rpcUrl: s.rpcUrl, chainId: 31337, queue: s.a.QUEUE, rebalancer: s.a.REBALANCER, keeperAccount: s.keeperAccount,
    keystore: s.bot.keystore, stateDir: tmp("keeper-state-"), receiptTimeoutSecs: 30, healthPort: 0, maxFeeGwei: 100,
  }, {});
  const { io, address } = makeChainIO([s.rpcUrl], 31337, new Uint8Array(s.bot.pk));
  const alerts = new Alerts({ realertSecs: cfg.realertSecs, queue: cfg.queue, write: (l) => lines.push(l) });
  const keeper = new Keeper({ cfg, io, key: address as Address, state: emptyState(), alerts, pollMs: 100, sendHook });
  await keeper.startup();
  const alertLines = () => lines.filter((l) => l.startsWith('{"alert"')).map((l) => JSON.parse(l));
  return { keeper, lines, alertLines, clear: () => { lines.length = 0; } };
}
