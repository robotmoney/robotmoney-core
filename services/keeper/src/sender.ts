// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.2 (Sending a transaction).
// The one send path: simulate, gas limit, fees, nonce, send and wait, check the receipt, replace when stuck, record.
// A mined transaction with status 0 is a failure: it is replayed at the block before to decode the reason and alerts
// <duty>_reverted. This is the fix for the Base 8453 settle that reverted with SettleSideOutOfGas and was logged as sent.
import type { Address, Hex } from "viem";
import { decodeRevert, revertDataOf, type DecodedRevert } from "./abi.ts";
import { Alerts, log, type AlertKind } from "./alerts.ts";
import { gasLimit } from "./gas.ts";
import type { Metrics } from "./health.ts";

export interface TxRequest { to: Address; data: Hex; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; nonce: number }
export interface ReceiptLike {
  transactionHash: Hex; status: "success" | "reverted"; blockNumber: bigint; gasUsed: bigint; effectiveGasPrice: bigint;
  l1Fee?: bigint | null;
}

/** The chain operations the keeper needs. src/chain.ts implements it with viem; unit tests fake it. */
export interface ChainIO {
  chainId(): Promise<number>;
  /** eth_call; throws (with revert data in the cause chain) on a revert. */
  call(a: { from: Address; to: Address; data: Hex; gas?: bigint; blockNumber?: bigint }): Promise<Hex>;
  estimateGas(a: { from: Address; to: Address; data: Hex }): Promise<bigint>;
  blockGasLimit(): Promise<bigint>;
  /** Latest base fee and a suggested priority fee, in wei. */
  fees(): Promise<{ baseFee: bigint; priorityFee: bigint }>;
  pendingNonce(addr: Address): Promise<number>;
  /** Signs with the keeper key and sends; returns the hash. */
  sendTx(tx: TxRequest): Promise<Hex>;
  receipt(hash: Hex): Promise<ReceiptLike | null>;
  balance(addr: Address): Promise<bigint>;
  blockTimestamp(): Promise<bigint>;
}

export type Duty = "settle" | "step" | "delist_step";

export type SendResult =
  | { status: "mined"; receipt: ReceiptLike; gasLimit: bigint }
  | { status: "reverted"; receipt: ReceiptLike; gasLimit: bigint; reason: DecodedRevert }
  | { status: "simulation_reverted"; reason: DecodedRevert }
  | { status: "skipped"; why: string }
  | { status: "failed"; error: string }
  | { status: "stuck"; hashes: Hex[] };

export interface SenderOptions {
  io: ChainIO;
  from: Address;
  alerts: Alerts;
  metrics: Metrics;
  gasMultiplier: number;
  maxFeeGwei: number;
  receiptTimeoutSecs: number;
  maxReplacements: number;
  pollMs?: number;
  now?: () => number;
  onPending?: (p: { duty: string; hash: Hex; nonce: number }) => void;
  onSettled?: (hash: Hex) => void;
}

export interface SendOptions {
  /** Gas floor (settle). */
  floor?: bigint;
  /** Test hook: force the gas limit of this send (the forced mined-revert test). */
  gasLimitOverride?: bigint;
}

const revertedKind = (d: Duty) => `${d}_reverted` as AlertKind;
/** Fees bumped by 12.5 %, at least 1 wei. */
export const bump = (v: bigint) => v + (v / 8n > 0n ? (v + 7n) / 8n : 1n);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (e: unknown) => String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 300);

export class Sender {
  private nonce: number | undefined;
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(private readonly o: SenderOptions) {
    this.pollMs = o.pollMs ?? 1000;
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get currentNonce() { return this.nonce; }

  /** Sends `data` to `to` for `duty`. `cause` keys alert dedupe (the duty, plus the asset index for delist). */
  async send(duty: Duty, cause: string, to: Address, data: Hex, opt: SendOptions = {}): Promise<SendResult> {
    const { io, from, alerts } = this.o;
    // 1. Simulate as the sender.
    try {
      await io.call({ from, to, data });
    } catch (e) {
      const reason = decodeRevert(revertDataOf(e));
      alerts.raise(revertedKind(duty), cause, { stage: "simulate", reason: reason.text });
      return { status: "simulation_reverted", reason };
    }
    let limit: bigint, maxFee: bigint, tip: bigint;
    try {
      // 2. Gas limit.
      const [estimate, blockLimit] = await Promise.all([io.estimateGas({ from, to, data }), io.blockGasLimit()]);
      limit = opt.gasLimitOverride ?? gasLimit(estimate, this.o.gasMultiplier, blockLimit, opt.floor ?? 0n);
      // 3. Fees, capped at maxFeeGwei.
      const cap = BigInt(Math.round(this.o.maxFeeGwei * 1e9));
      const f = await io.fees();
      tip = f.priorityFee;
      if (f.baseFee + tip > cap) {
        alerts.raise("gas_price_high", "fees", { baseFeeWei: f.baseFee, priorityFeeWei: tip, capWei: cap, duty });
        this.o.metrics.skip("gas_price_high");
        return { status: "skipped", why: "gas_price_high" };
      }
      alerts.resolve("gas_price_high", "fees");
      maxFee = 2n * f.baseFee + tip;
      if (maxFee > cap) maxFee = cap;
      // 4. Nonce, held in memory.
      this.nonce ??= await io.pendingNonce(from);
    } catch (e) {
      this.nonce = undefined;
      alerts.raise("send_failed", cause, { stage: "prepare", error: short(e) });
      return { status: "failed", error: short(e) };
    }
    const nonce = this.nonce;
    const capWei = BigInt(Math.round(this.o.maxFeeGwei * 1e9));

    // 5. Send and wait; 7. replace when stuck.
    const hashes: Hex[] = [];
    let receipt: ReceiptLike | null = null;
    for (let attempt = 0; attempt <= this.o.maxReplacements && !receipt; attempt++) {
      if (attempt > 0) {
        const nextFee = bump(maxFee) > capWei ? capWei : bump(maxFee);
        if (nextFee <= maxFee) break; // the cap leaves no room for a replacement
        maxFee = nextFee;
        tip = bump(tip) > maxFee ? maxFee : bump(tip);
      }
      try {
        const hash = await io.sendTx({ to, data, gas: limit, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, nonce });
        hashes.push(hash);
        this.o.onPending?.({ duty, hash, nonce });
        log("send", { duty, cause, hash, nonce, gasLimit: limit, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, replacement: attempt });
      } catch (e) {
        if (!hashes.length) {
          this.nonce = undefined;
          alerts.raise("send_failed", cause, { stage: "send", error: short(e) });
          return { status: "failed", error: short(e) };
        }
        log("replace_failed", { duty, cause, nonce, error: short(e) });
      }
      receipt = await this.waitAny(hashes, this.o.receiptTimeoutSecs);
    }
    if (!receipt) {
      this.nonce = undefined; // re-read the pending nonce on the next send
      alerts.raise("tx_stuck", cause, { hashes, nonce, replacements: hashes.length - 1 });
      return { status: "stuck", hashes };
    }
    this.nonce = nonce + 1;
    for (const h of hashes) this.o.onSettled?.(h);
    alerts.resolve("tx_stuck", cause);
    alerts.resolve("send_failed", cause);

    // 8. Record.
    const fee = receipt.gasUsed * receipt.effectiveGasPrice + (receipt.l1Fee ?? 0n);
    const rec = {
      duty, cause, hash: receipt.transactionHash, block: receipt.blockNumber, status: receipt.status, gasUsed: receipt.gasUsed,
      gasLimit: limit, effectiveGasPrice: receipt.effectiveGasPrice, l1Fee: receipt.l1Fee ?? 0n, totalFee: fee,
    };
    this.o.metrics.lastSend = rec;

    // 6. Check the receipt.
    if (receipt.status !== "success") {
      let reason: DecodedRevert = { name: "unknown", args: [], text: "replay did not revert" };
      try {
        await io.call({ from, to, data, gas: limit, blockNumber: receipt.blockNumber - 1n });
      } catch (e) {
        reason = decodeRevert(revertDataOf(e));
      }
      this.o.metrics.reverted(duty, receipt.gasUsed, fee);
      log("reverted", { ...rec, reason: reason.text });
      alerts.raise(revertedKind(duty), cause, {
        hash: receipt.transactionHash, gasUsed: receipt.gasUsed, gasLimit: limit, reason: reason.text,
      });
      return { status: "reverted", receipt, gasLimit: limit, reason };
    }
    this.o.metrics.sent(duty, receipt.gasUsed, fee, this.now());
    log("mined", rec);
    alerts.resolve(revertedKind(duty), cause);
    return { status: "mined", receipt, gasLimit: limit };
  }

  private async waitAny(hashes: Hex[], timeoutSecs: number): Promise<ReceiptLike | null> {
    const deadline = Date.now() + timeoutSecs * 1000;
    for (;;) {
      for (const h of hashes) {
        try {
          const r = await this.o.io.receipt(h);
          if (r) return r;
        } catch { /* not found yet, or an RPC blip: poll again */ }
      }
      if (Date.now() >= deadline) return null;
      await sleep(Math.min(this.pollMs, Math.max(0, deadline - Date.now())));
    }
  }
}
