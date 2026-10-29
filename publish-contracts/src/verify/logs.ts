// Chunked eth_getLogs with retry on 429. A failed chunk throws: a dropped chunk must never read as "no logs".
// Issue 1977: a verify scans each block range once. withSharedLogScan reads every log the address-scoped checks need in one chunked pass (an address list and
// topic-0 alternatives) and scanLogs serves each check's filter from that set in memory, with the eth_getLogs matching rules. A filter the shared pass does not
// cover (no address, an address or topic 0 outside the plan, a range outside it) still scans on its own.
import type { Address, ChainReader, Hex, LogEntry } from "./types.ts";

/** Issue 1851: the detail prefix of a label that failed because the RPC refused a read, not because the chain is wrong. verify-stage.ts does not pause the vaults for those alone. */
export const RPC_REFUSED_DETAIL = "RPC_REFUSED";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: any) => String(e?.message ?? e) + String(e?.cause?.message ?? "") + String(e?.details ?? "");
const isRateLimit = (e: any) => /429|rate.?limit|too many requests/i.test(errText(e));

/**
 * Issue 1977: the range-limit answers of the Base RPCs. The block count the RPC names, 0n when it names none, undefined when the error is not a range limit.
 * A range limit shrinks the window and the scan continues: it is not a failed chunk.
 */
export function rangeLimit(e: unknown): bigint | undefined {
  const t = errText(e);
  const n = /exceed maximum block range:\s*(\d+)/i.exec(t) ?? /ranges over (\d+) blocks are not supported/i.exec(t);
  if (n) return BigInt(n[1]!);
  if (/block range too large/i.test(t)) return 0n;
  return undefined;
}

export interface ScanParams {
  topics: (Hex | Hex[] | null)[];
  address?: `0x${string}`;
  fromBlock: bigint;
  toBlock: bigint;
  chunk: number;
  retryBaseMs: number;
  maxRetries?: number;
}

type Filter = { address?: Address | Address[]; topics: (Hex | Hex[] | null)[] };

/** One chunked walk of [from, to]: 429 retries with backoff, a range limit shrinks the window, any other failure throws RPC_REFUSED naming the chunk. */
async function walk(chain: ChainReader, f: Filter, from: bigint, to: bigint, chunk: number, retryBaseMs: number, maxRetries: number): Promise<LogEntry[]> {
  if (chunk < 1) throw new Error("logChunk must be at least 1");
  const out: LogEntry[] = [];
  let step = BigInt(chunk);
  for (let lo = from; lo <= to;) {
    let hi = lo + step - 1n;
    if (hi > to) hi = to;
    for (let attempt = 0; ;) {
      try {
        out.push(...(await chain.getLogs({ address: f.address, topics: f.topics, fromBlock: lo, toBlock: hi })));
        break;
      } catch (e: any) {
        const lim = rangeLimit(e), size = hi - lo + 1n;
        if (lim !== undefined && size > 1n) {
          step = lim > 0n && lim < size ? lim : size / 2n;
          hi = lo + step - 1n;
          if (hi > to) hi = to;
          continue;
        }
        if (!isRateLimit(e) || attempt >= maxRetries) throw new Error(`${RPC_REFUSED_DETAIL}: getLogs ${lo}-${hi} failed: ${String(e?.message ?? e).slice(0, 200)}`);
        await sleep(retryBaseMs * 2 ** attempt);
        attempt++;
      }
    }
    lo = hi + 1n;
  }
  return out;
}

export async function scanLogs(chain: ChainReader, p: ScanParams): Promise<LogEntry[]> {
  if (p.chunk < 1) throw new Error("logChunk must be at least 1");
  const shared = (chain as SharedLogReader).sharedLogs?.(p);
  if (shared) return await shared;
  return await walk(chain, { address: p.address, topics: p.topics }, p.fromBlock, p.toBlock, p.chunk, p.retryBaseMs, p.maxRetries ?? 6);
}

/** The eth_getLogs match of one log against one filter (go-ethereum's filterLogs): a filter with more topic positions than the log has never matches. */
export function logMatches(l: LogEntry, p: { address?: Address; topics: (Hex | Hex[] | null)[]; fromBlock: bigint; toBlock: bigint }): boolean {
  if (l.blockNumber < p.fromBlock || l.blockNumber > p.toBlock) return false;
  if (p.address && l.address.toLowerCase() !== p.address.toLowerCase()) return false;
  if (p.topics.length > l.topics.length) return false;
  return p.topics.every((t, i) => {
    if (t === null || (Array.isArray(t) && t.length === 0)) return true;
    const got = l.topics[i]!.toLowerCase();
    return Array.isArray(t) ? t.some((x) => x.toLowerCase() === got) : t.toLowerCase() === got;
  });
}

/** What the shared pass reads: every log of `addresses` whose topic 0 is one of `topic0s`, from `fromBlock` to `toBlock`. */
export interface SharedScanPlan { addresses: Address[]; topic0s: Hex[]; fromBlock: bigint; toBlock: bigint; chunk: number; retryBaseMs: number; maxRetries?: number }
export type SharedLogReader = ChainReader & { sharedLogs?: (p: ScanParams) => Promise<LogEntry[]> | undefined };

/**
 * Issue 1977: `chain` with one shared log pass. The pass runs on the first scan it covers and once only: a failed pass fails every scan it covers with the same
 * RPC_REFUSED error, it is never retried per check. Every other read goes to `chain` unchanged.
 */
export function withSharedLogScan(chain: ChainReader, plan: SharedScanPlan): SharedLogReader {
  const addrs = [...new Set(plan.addresses.map((a) => a.toLowerCase()))] as Address[];
  const t0s = [...new Set(plan.topic0s.map((t) => t.toLowerCase()))] as Hex[];
  let all: Promise<LogEntry[]> | undefined;
  const covers = (p: ScanParams): boolean => {
    if (!p.address || !addrs.includes(p.address.toLowerCase() as Address)) return false;
    const t = p.topics[0];
    const first = typeof t === "string" ? [t] : Array.isArray(t) && t.length > 0 ? t : undefined;
    if (!first || !first.every((x) => t0s.includes(x.toLowerCase() as Hex))) return false;
    return p.fromBlock >= plan.fromBlock && p.toBlock <= plan.toBlock;
  };
  const sharedLogs = (p: ScanParams): Promise<LogEntry[]> | undefined => {
    if (addrs.length === 0 || t0s.length === 0 || !covers(p)) return undefined;
    all ??= walk(chain, { address: addrs, topics: [t0s] }, plan.fromBlock, plan.toBlock, plan.chunk, plan.retryBaseMs, plan.maxRetries ?? 6);
    return all.then((logs) => logs.filter((l) => logMatches(l, p)));
  };
  // a Proxy, not a copy: every other read runs on `chain` itself (its own `this`), so a reader with state behaves as before
  return new Proxy(chain, {
    get: (t, k) => {
      if (k === "sharedLogs") return sharedLogs;
      const v = Reflect.get(t, k, t);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as SharedLogReader;
}

/** The detail of a scan label whose scan threw: an RPC refusal keeps its RPC_REFUSED prefix (no pause-all), anything else reads "scan failed". */
export const scanFailedDetail = (e: any): string => {
  const m = String(e?.message ?? e);
  return m.startsWith(RPC_REFUSED_DETAIL) ? m.slice(0, 300) : `scan failed: ${m.slice(0, 300)}`;
};

export const padTopic = (addr: string): Hex => (`0x${"0".repeat(24)}${addr.toLowerCase().replace(/^0x/, "")}`) as Hex;
export const topicToAddress = (t: Hex): `0x${string}` => (`0x${t.slice(26)}`) as `0x${string}`;
