// Read-after-write on a load-balanced RPC (issue 1723, QA plan v1 E6). A public RPC such as mainnet.base.org spreads calls over backend nodes, and a node that has not
// seen the newest block answers with the state before it: the old nonce, no code at a contract created a block ago, a role the deploy has not yet renounced on that node.
// So a read that checks what a landed transaction must have left goes through `awaitRead`: it is read again, a bounded number of times, until the expected state shows.
// It never turns a wrong state into a pass. After the last read the caller fails exactly as it did with one read, and names the reads and the RPC host.
// Only a read with a known expected state is retried. A state past the expected one (a nonce above it: another transaction moved the account) stops at once.

/** How a read after a write is retried. Bounded: it always ends. `sleep` is the test seam (no real waiting in tests). */
export interface ReadRetry { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> }
/** About 4 s in all: a Base block is 2 s, and a lagging backend of a public load balancer is normally a block or two behind. */
export const READ_RETRY_TRIES = 5;
export const READ_RETRY_DELAY_MS = 1000;

export interface ReadOutcome<T> {
  /** The expected state showed: `want` held on the last value. */
  ok: boolean;
  /** The last value a read returned. Undefined only when every read threw. */
  last?: T;
  /** Every value the reads returned, oldest first. A read that threw adds nothing. */
  seen: T[];
  /** The error of the LAST read, when it threw. */
  error?: unknown;
  /** How many reads ran. */
  reads: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Reads until `want(value)` holds, up to `tries` reads with `delayMs` between them (no sleep after the last). A read that throws is read again: a node behind the block
 * reverts a call to a contract it has no code for. `past(value)` marks a value no stale node can show (beyond the expected state): the reads stop at once, not ok.
 */
export async function awaitRead<T>(read: () => Promise<T>, want: (v: T) => boolean, retry: ReadRetry = {}, past?: (v: T) => boolean): Promise<ReadOutcome<T>> {
  const tries = Math.max(1, Math.floor(retry.tries ?? READ_RETRY_TRIES));
  const delay = retry.delayMs ?? READ_RETRY_DELAY_MS;
  const sleep = retry.sleep ?? realSleep;
  const seen: T[] = [];
  let error: unknown;
  for (let i = 1; i <= tries; i++) {
    error = undefined;
    try {
      const v = await read();
      seen.push(v);
      if (want(v)) return { ok: true, last: v, seen, reads: i };
      if (past?.(v)) return { ok: false, last: v, seen, reads: i };
    } catch (e) { error = e; }
    if (i < tries) await sleep(delay);
  }
  return { ok: false, last: seen[seen.length - 1], seen, error, reads: tries };
}

/**
 * awaitRead for a caller that judges the value itself and keeps its own refusal: the first value that passes `want`, else the last value read, which the caller refuses
 * as it did with one read. When the last read threw, its error is thrown: a caller never judges a value older than the last answer.
 */
export async function readUntil<T>(read: () => Promise<T>, want: (v: T) => boolean, retry?: ReadRetry, past?: (v: T) => boolean): Promise<T> {
  const r = await awaitRead(read, want, retry, past);
  if (r.error !== undefined) throw r.error;
  return r.last as T;
}
