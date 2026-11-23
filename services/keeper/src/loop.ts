// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1.5 (Loop, Stop).
// One tick, then a wait of the tick's nextWaitSecs. SIGTERM and SIGINT end the wait at once. A tick in flight (and so a
// send waiting for its receipt) runs to its end first; then the loop returns and the process exits 0.
import type { EventEmitter } from "node:events";

export interface LoopOptions {
  tick: () => Promise<{ nextWaitSecs: number }>;
  afterTick?: () => void;
  signals?: Pick<EventEmitter, "on" | "off">;
}

export async function runLoop(o: LoopOptions): Promise<void> {
  const signals = o.signals ?? process;
  let stopping = false;
  let wake: (() => void) | undefined;
  const onSignal = () => {
    stopping = true;
    wake?.();
  };
  signals.on("SIGTERM", onSignal);
  signals.on("SIGINT", onSignal);
  try {
    while (!stopping) {
      const { nextWaitSecs } = await o.tick();
      o.afterTick?.();
      if (stopping) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, nextWaitSecs * 1000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  } finally {
    signals.off("SIGTERM", onSignal);
    signals.off("SIGINT", onSignal);
  }
}
