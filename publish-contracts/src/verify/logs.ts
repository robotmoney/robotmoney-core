// Chunked eth_getLogs with retry on 429. A failed chunk throws: a dropped chunk must never read as "no logs".
import type { ChainReader, Hex, LogEntry } from "./types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (e: any) => /429|rate.?limit|too many requests/i.test(String(e?.message ?? e) + String(e?.cause?.message ?? ""));

export interface ScanParams {
  topics: (Hex | Hex[] | null)[];
  address?: `0x${string}`;
  fromBlock: bigint;
  toBlock: bigint;
  chunk: number;
  retryBaseMs: number;
  maxRetries?: number;
}

export async function scanLogs(chain: ChainReader, p: ScanParams): Promise<LogEntry[]> {
  if (p.chunk < 1) throw new Error("logChunk must be at least 1");
  const out: LogEntry[] = [];
  const step = BigInt(p.chunk);
  const maxRetries = p.maxRetries ?? 6;
  for (let lo = p.fromBlock; lo <= p.toBlock; lo += step) {
    let hi = lo + step - 1n;
    if (hi > p.toBlock) hi = p.toBlock;
    for (let attempt = 0; ; attempt++) {
      try {
        out.push(...(await chain.getLogs({ address: p.address, topics: p.topics, fromBlock: lo, toBlock: hi })));
        break;
      } catch (e: any) {
        if (!isRateLimit(e) || attempt >= maxRetries) throw new Error(`getLogs ${lo}-${hi} failed: ${String(e?.message ?? e).slice(0, 200)}`);
        await sleep(p.retryBaseMs * 2 ** attempt);
      }
    }
  }
  return out;
}

export const padTopic = (addr: string): Hex => (`0x${"0".repeat(24)}${addr.toLowerCase().replace(/^0x/, "")}`) as Hex;
export const topicToAddress = (t: Hex): `0x${string}` => (`0x${t.slice(26)}`) as `0x${string}`;
