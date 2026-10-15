// Read-after-write on a load-balanced RPC (issue 1723). Right after a broadcast, a read can be answered by a backend node that has not seen
// the transaction's block yet: the libs landed but the nonce read lags, a new Safe has no code yet, a Safe nonce has not moved. Such a read
// is STALE, not wrong. Every post-broadcast read in the Safe tool and prove-control goes through readAfterWrite: it re-reads, bounded, until
// the state is the expected one, and fails closed with STALE_READ_TIMEOUT when it never is. A FRESH but different state ("wrong") is
// returned at once so the caller fails exactly as before: a consistent wrong state is never retried into a false success.
import { rpcLabel } from "./chain.ts";
import { SafeToolError } from "./errors.ts";
import type { Logger } from "./log.ts";

/** How many times a post-broadcast read is tried and how long it waits between tries. `sleep` is the test seam (no real sleeping in tests). */
export interface StaleReadRetry { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> }
/** Default bound: 10 tries 1 s apart (about 9 s of waiting, several Base blocks of backend lag). */
export const STALE_READ_TRIES = 10;
export const STALE_READ_DELAY_MS = 1000;

/** fresh: the expected state. stale: what a node behind the write's block answers (retried). wrong: a fresh but different state (returned at once). */
export type ReadVerdict = "fresh" | "stale" | "wrong";

export interface ReadAfterWrite<T> {
  /** What is read, for the error and the log, e.g. "the Safe nonce of 0x.. after 0x..". */
  what: string;
  /** The expected value, as the operator should read it. */
  expected: string;
  /** The RPC the read goes to. Only its host reaches the error or the log (the path may carry an API key). */
  rpcUrl: string;
  read: () => Promise<T>;
  /** Classifies a value. A read that throws is stale: a node without the new code answers an eth_call with no data. Default: every value is fresh. */
  judge?: (v: T) => ReadVerdict;
  show?: (v: T) => string;
  logger?: Logger;
}

/** Reads until the value is fresh or wrong, at most `tries` times. Only stale reads and read errors are retried. */
export async function readAfterWrite<T>(r: ReadAfterWrite<T>, retry: StaleReadRetry = {}): Promise<T> {
  const tries = Math.max(1, retry.tries ?? STALE_READ_TRIES);
  const delay = retry.delayMs ?? STALE_READ_DELAY_MS;
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const host = rpcLabel(r.rpcUrl);
  const show = r.show ?? ((v: T) => (typeof v === "bigint" ? v.toString() : JSON.stringify(v) ?? String(v)));
  let last = "nothing";
  for (let i = 1; i <= tries; i++) {
    try {
      const v = await r.read();
      if ((r.judge?.(v) ?? "fresh") !== "stale") return v;
      last = show(v);
    } catch (e) {
      const m = (e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
      last = `an error (${m.split("\n")[0]!.split(r.rpcUrl).join(host)})`;
    }
    r.logger?.log("warn", "safe.stale_read", { what: r.what, expected: r.expected, last, try: i, tries, rpc_host: host });
    if (i < tries) await sleep(delay);
  }
  throw new SafeToolError(
    "STALE_READ_TIMEOUT",
    `${r.what}: expected ${r.expected}, last read ${last}, after ${tries} read(s) ${delay} ms apart from RPC ${host}. The RPC never showed the written state: read the chain before any retry, nothing more was sent.`,
    { what: r.what, expected: r.expected, last, tries, rpc_host: host },
  );
}

/** readAfterWrite when `retry` is set (right after a broadcast), a plain single read otherwise (no write to wait for). */
export function settle<T>(retry: StaleReadRetry | undefined, r: ReadAfterWrite<T>): Promise<T> {
  return retry ? readAfterWrite(r, retry) : r.read();
}
