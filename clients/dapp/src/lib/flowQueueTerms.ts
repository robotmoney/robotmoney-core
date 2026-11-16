// Canonical: docs/technical/one-vault-rebalancer-proposal.md §5.11.3 item 8 and §8 (OPS-07, FLOW-08)

/**
 * Terms and liveness of the one fund's flow queue, resolved in one place.
 *
 * The queue's `quoteDeposit(usdc)` returns no price. It returns the fee, the cancel cutoff, the earliest
 * settle and hold end, and the two guard bands. `liveness()` returns keeper and Safe liveness. A depositor
 * must see every deposit stop, why it holds, when it ends, and the cancel deadline. A band that reads zero
 * is shown as off, never as a number that looks safe.
 */

export const FLOW_QUEUE_TERMS_ABI = [
  {
    type: "function",
    name: "quoteDeposit",
    stateMutability: "view",
    inputs: [{ name: "usdc", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "feeBps", type: "uint256" },
          { name: "cancelCutoff", type: "uint64" },
          { name: "earliestSettle", type: "uint64" },
          { name: "holdEnds", type: "uint64" },
          { name: "refBandBps", type: "uint16" },
          { name: "legBandBps", type: "uint16" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "liveness",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "keeperConfigured", type: "bool" },
          { name: "queuePausedNow", type: "bool" },
          { name: "queuePausedUntil", type: "uint64" },
          { name: "depositsStoppedNow", type: "bool" },
          { name: "windDownActive", type: "bool" },
          { name: "cancelBuffer", type: "uint32" },
          { name: "maxPause", type: "uint32" },
        ],
      },
    ],
  },
] as const;

export interface FlowQuote {
  readonly feeBps: bigint;
  readonly cancelCutoff: bigint;
  readonly earliestSettle: bigint;
  readonly holdEnds: bigint;
  readonly refBandBps: number;
  readonly legBandBps: number;
}

export interface FlowLiveness {
  readonly keeperConfigured: boolean;
  readonly queuePausedNow: boolean;
  readonly queuePausedUntil: bigint;
  readonly depositsStoppedNow: boolean;
  readonly windDownActive: boolean;
  readonly cancelBuffer: number;
  readonly maxPause: number;
}

export type DepositStopKind = "queue-paused" | "deposits-stopped" | "wind-down";

export interface DepositStop {
  readonly kind: DepositStopKind;
  readonly cause: string;
  /** When the stop ends, Unix seconds. Null when the chain gives no end time. */
  readonly endsAt: bigint | null;
}

export interface FlowTermsView {
  readonly stops: readonly DepositStop[];
  /** Cancel deadline of a deposit made now, Unix seconds. Always shown, stop or not. */
  readonly cancelDeadline: bigint;
  readonly cancelBufferSecs: number;
  /** Null when the band reads zero: that guard is off. */
  readonly refBandBps: number | null;
  readonly legBandBps: number | null;
  readonly keeperConfigured: boolean;
  /** Plain warnings, each one a thing the depositor should know. */
  readonly warnings: readonly string[];
}

/** Resolve every stop, the cancel deadline, the bands and the keeper state from the two reads. */
export function resolveFlowTerms(quote: FlowQuote, live: FlowLiveness): FlowTermsView {
  const stops: DepositStop[] = [];
  if (live.queuePausedNow) {
    stops.push({
      kind: "queue-paused",
      cause: "The emergency key paused the queue. The pause ends by itself.",
      endsAt: live.queuePausedUntil,
    });
  }
  if (live.depositsStoppedNow) {
    stops.push({
      kind: "deposits-stopped",
      cause:
        "Deposits are stopped: an excluded asset, a delisting sale, or a lending venue that cannot pay.",
      endsAt: null,
    });
  }
  if (live.windDownActive) {
    stops.push({ kind: "wind-down", cause: "The fund is winding down.", endsAt: null });
  }
  const warnings: string[] = [];
  if (!live.keeperConfigured) {
    warnings.push("No keeper is configured. No round can settle until one is set.");
  }
  if (quote.refBandBps === 0) warnings.push("The reference band is off.");
  if (quote.legBandBps === 0) warnings.push("The per-swap band is off.");
  return {
    stops,
    cancelDeadline: quote.cancelCutoff,
    cancelBufferSecs: live.cancelBuffer,
    refBandBps: quote.refBandBps === 0 ? null : quote.refBandBps,
    legBandBps: quote.legBandBps === 0 ? null : quote.legBandBps,
    keeperConfigured: live.keeperConfigured,
    warnings,
  };
}

/** UTC time like `2026-11-15 12:00 UTC`. Deterministic, never the viewer's zone. */
export function formatUnixUtc(secs: bigint): string {
  if (secs === 0n) return "not set";
  const d = new Date(Number(secs) * 1000);
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatBandBps(bps: number | null): string {
  return bps === null ? "off" : `${bps} bps`;
}
