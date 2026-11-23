// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.1 (Duties), §8.1.3 (Modes and keys).
import type { Address, Hex } from "viem";
import { keeperAccountAbi } from "../abi.ts";
import type { Alerts } from "../alerts.ts";
import { calldata } from "../chain.ts";
import type { Config } from "../config.ts";
import type { Metrics } from "../health.ts";
import type { ChainIO, Duty, Sender, SendOptions } from "../sender.ts";

export interface Ctx {
  cfg: Config;
  io: ChainIO;
  /** The bot key's address (pays gas). */
  key: Address;
  /** The KEEPER_ROLE holder: the KeeperAccount, or the key itself in direct mode. Reads that check msg.sender use it. */
  caller: Address;
  fund: Address;
  alerts: Alerts;
  metrics: Metrics;
  sender: Sender;
  /** Test hook: extra send options per duty and attempt (0 first, 1 the retry). */
  sendHook?: (duty: Duty, attempt: number) => SendOptions;
  lastSettleGas?: bigint;
}

/** The transaction for a keeper call: through KeeperAccount.execute in account mode, straight to `target` in direct mode. */
export function route(ctx: Ctx, target: Address, data: Hex): { to: Address; data: Hex } {
  if (!ctx.cfg.keeperAccount) return { to: target, data };
  return { to: ctx.cfg.keeperAccount, data: calldata(keeperAccountAbi, "execute", [target, data]) };
}

export const nowSecs = async (ctx: Ctx) => Number(await ctx.io.blockTimestamp());
