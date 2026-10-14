// Core issue 1780 (QA plan X9): the catch-up measurement times the indexer between its first and last cursor move,
// refuses an indexer with no logs RPC and a stack that is not catching up, and never prints an RPC key.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONTAINER,
  EXIT,
  MeasureError,
  catchUpRate,
  cursorMoves,
  parseCli,
  readIndexerSettings,
  runCli,
  scrubUrls,
  type Deps,
  type Sample,
} from "../measure-catch-up.ts";

const KEY = "not-a-real-key-7f3a";
const START = 52401633;
const ENV = [
  "DATABASE_URL=postgres://robotmoney:robotmoney@postgres:5432/explorer",
  "INDEXER_CHAIN_ID=8453",
  `INDEXER_RPC_URL=https://base-mainnet.rpc.example/v2/${KEY}`,
  `INDEXER_LOGS_RPC_URL=https://base.gateway.tenderly.co/${KEY}`,
  `INDEXER_START_BLOCK=${START}`,
  "INDEXER_MAX_BLOCKS_PER_TICK=1000",
  "INDEXER_RPC_MAX_RETRIES=6",
  "INDEXER_RPC_BACKOFF_MS=1000",
];

type Body = Record<string, unknown>;
/** A `/health` body as the explorer API serves it. */
const health = (cursor: number | null, head: number | null, error: string | null = null): Body => ({
  status: error ? "degraded" : "ok",
  last_indexed_block: cursor,
  chain_head_block: head,
  lag_blocks: cursor !== null && head !== null ? head - cursor : null,
  last_run_error: error,
  reorg_count: 0,
});

/** Fakes for every host call. `answers` are the /health answers in order; the last one repeats. The clock moves only in sleep. */
function fake(
  answers: (Body | Error)[],
  o: { env?: string[]; inspect?: { running: boolean; env: string[] } | null; docker?: boolean; stopAfterPolls?: number } = {},
) {
  let t = 0;
  let i = 0;
  const out: string[] = [];
  const err: string[] = [];
  const urls: string[] = [];
  const deps: Deps = {
    has: (tool) => tool === "docker" && (o.docker ?? true),
    inspect: async () => (o.inspect !== undefined ? o.inspect : { running: true, env: o.env ?? ENV }),
    health: async (url) => {
      urls.push(url);
      const a = answers[Math.min(i, answers.length - 1)]!;
      i++;
      return a instanceof Error ? { ok: false, error: a.message } : { ok: true, body: a };
    },
    nowMs: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    stopRequested: () => o.stopAfterPolls !== undefined && i >= o.stopAfterPolls,
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
  };
  return { deps, out: () => out.join(""), err: () => err.join(""), urls };
}

/** An empty index catching up: no cursor yet, then `step` blocks per poll from the first tick end. */
function catchUp(step: number, polls: number, head: number): Body[] {
  return [health(null, null), ...Array.from({ length: polls }, (_, k) => health(START + 999 + step * k, head))];
}

const sample = (atS: number, cursor: number | null, head: number | null = 60_000_000): Sample => ({ atMs: atS * 1000, cursor, head, error: null });

describe("the rate", () => {
  test("is timed from the first to the last cursor move, not from the first and last poll", () => {
    // The first poll's cursor was set at an unknown time, and the last poll comes long after the last tick ended.
    // First to last poll would say 2000 blocks in 200 s (600 per minute). The ticks ran 1000 blocks in 60 s.
    const s = [sample(0, 1000), sample(45, 2000), sample(105, 3000), sample(200, 3000)];
    const r = catchUpRate(s)!;
    expect(r).toMatchObject({ fromBlock: 2000, toBlock: 3000, blocks: 1000, cursorMoves: 2 });
    expect(r.blocksPerMinute).toBe(1000);
  });
  test("the first cursor of an empty index is a move: a tick ended since the poll before", () => {
    expect(cursorMoves([sample(0, null), sample(30, 2000), sample(60, 3000)]).map((x) => x.cursor)).toEqual([2000, 3000]);
  });
  test("a reorg rewind is not a move, and the net progress is what counts", () => {
    const s = [sample(0, null), sample(60, 5000), sample(120, 4990), sample(180, 5990)];
    expect(cursorMoves(s).map((x) => x.cursor)).toEqual([5000, 5990]);
    expect(catchUpRate(s)!.blocksPerMinute).toBe(495);
  });
  test("fewer than two cursor moves is no rate", () => {
    expect(catchUpRate([sample(0, 1000), sample(30, 1000), sample(60, 1000)])).toBeNull();
    expect(catchUpRate([sample(0, null), sample(30, 1000), sample(60, 1000)])).toBeNull();
  });
});

describe("the indexer's settings", () => {
  test("keep the RPC URLs as origins only", () => {
    const s = readIndexerSettings(ENV);
    expect(s).toEqual({
      chainId: "8453",
      rpcOrigin: "https://base-mainnet.rpc.example",
      logsRpcOrigin: "https://base.gateway.tenderly.co",
      maxBlocksPerTick: 1000,
      rpcMaxRetries: 6,
      rpcBackoffMs: 1000,
      tickSeconds: 12,
      startBlock: START,
    });
    expect(JSON.stringify(s)).not.toContain(KEY);
  });
  test("an unset setting takes the indexer's own default", () => {
    expect(readIndexerSettings(["INDEXER_LOGS_RPC_URL=https://logs.example"])).toMatchObject({
      rpcOrigin: "(unset)",
      maxBlocksPerTick: 1000,
      rpcMaxRetries: 0,
      rpcBackoffMs: 500,
      tickSeconds: 12,
      startBlock: null,
    });
  });
  test("no logs RPC is refused: the number would time --rpc", () => {
    for (const env of [ENV.filter((kv) => !kv.startsWith("INDEXER_LOGS_RPC_URL=")), [...ENV.filter((kv) => !kv.startsWith("INDEXER_LOGS_RPC_URL=")), "INDEXER_LOGS_RPC_URL=  "]]) {
      let e: unknown;
      try {
        readIndexerSettings(env);
      } catch (x) {
        e = x;
      }
      expect(e).toBeInstanceOf(MeasureError);
      expect((e as MeasureError).cls).toBe("no-logs-rpc");
      expect((e as MeasureError).code).toBe(EXIT.INPUT);
    }
  });
  test("a setting that is not a whole number is refused without echoing it", () => {
    expect(() => readIndexerSettings([...ENV, "INDEXER_MAX_BLOCKS_PER_TICK=12abc"])).toThrow(/bad-setting: INDEXER_MAX_BLOCKS_PER_TICK/);
  });
  test("a URL in an error text is reduced to its origin", () => {
    expect(scrubUrls(`error sending request for url (https://base.gateway.tenderly.co/${KEY}?x=1)`)).toBe("error sending request for url (https://base.gateway.tenderly.co)");
  });
});

describe("a measured catch-up", () => {
  test("stops when the index is within one tick of the head and prints blocks per minute", async () => {
    // 500 blocks per 30 s poll is 1000 blocks per minute. The 14th move leaves 868 blocks to the head: caught up.
    const f = fake(catchUp(500, 20, START + 999 + 7368));
    expect(await runCli(["--poll-secs", "30"], f.deps)).toBe(EXIT.OK);
    const out = f.out();
    expect(out).toContain(`catch-up rate: 1000 blocks per minute (6500 blocks in 6.5 min, cursor ${START + 999} to ${START + 999 + 6500}, 14 cursor moves)`);
    expect(out).toContain("logs rpc: https://base.gateway.tenderly.co (eth_getLogs); rpc: https://base-mainnet.rpc.example (headers, receipts, eth_call); chain 8453");
    expect(out).toContain("settings: INDEXER_MAX_BLOCKS_PER_TICK=1000 INDEXER_RPC_MAX_RETRIES=6 INDEXER_RPC_BACKOFF_MS=1000 INDEXER_TICK_SECONDS=12");
    expect(out).toContain("stopped: caught-up at cursor");
    expect(out).toContain("868 blocks behind");
    expect(out).toContain("documented target 1000 blocks per minute: met (33.3 times the Base block rate of 30 per minute)");
    expect(f.urls[0]).toBe("http://127.0.0.1:18547/health");
    expect(f.urls.length).toBe(15);
    expect(out + f.err()).not.toContain(KEY);
  });

  test("stops at --minutes, prints the rate so far and the time a full catch-up from the start block takes", async () => {
    const f = fake(catchUp(1000, 10, 53_000_000));
    expect(await runCli(["--minutes", "2", "--poll-secs", "30"], f.deps)).toBe(EXIT.OK);
    const out = f.out();
    // Polls at 0, 30, 60, 90 and 120 s: four moves, 3000 blocks in 90 s.
    expect(out).toContain("catch-up rate: 2000 blocks per minute (3000 blocks in 1.5 min");
    expect(out).toContain("stopped: time-limit");
    expect(out).toContain("documented target 1000 blocks per minute: met");
    expect(out).toContain(`a full catch-up from start block ${START} to head 53000000 at this rate: about 5.0 h`);
  });

  test("Ctrl-C stops after the current poll and still prints the rate", async () => {
    const f = fake(catchUp(250, 10, 53_000_000), { stopAfterPolls: 4 });
    expect(await runCli(["--poll-secs", "30"], f.deps)).toBe(EXIT.OK);
    expect(f.out()).toContain("catch-up rate: 500 blocks per minute");
    expect(f.out()).toContain("stopped: interrupted");
    expect(f.out()).toContain("documented target 1000 blocks per minute: not met");
  });

  test("failed ticks and unanswered polls are counted and reported, with URLs reduced to origins", async () => {
    const head = 53_000_000;
    const answers: (Body | Error)[] = [
      health(null, null),
      health(START + 999, head),
      health(START + 999, head, `rpc eth_getLogs failed: error sending request for url (https://base.gateway.tenderly.co/${KEY})`),
      new Error("connect ECONNREFUSED 127.0.0.1:18547"),
      health(START + 1999, head),
      health(START + 2999, head),
    ];
    const f = fake(answers);
    expect(await runCli(["--minutes", "3", "--poll-secs", "30"], f.deps)).toBe(EXIT.OK);
    const out = f.out();
    expect(out).toContain("polls: 7; unanswered: 1; with a failed tick: 1; last tick error: rpc eth_getLogs failed: error sending request for url (https://base.gateway.tenderly.co)");
    expect(out + f.err()).not.toContain(KEY);
    expect(f.err()).toContain('"event":"poll_failed"');
  });

  test("--json prints one object with the rate, the endpoint and the settings it was measured on", async () => {
    const f = fake(catchUp(500, 20, START + 999 + 7368));
    expect(await runCli(["--poll-secs", "30", "--json"], f.deps)).toBe(EXIT.OK);
    const j = JSON.parse(f.out()) as Record<string, unknown>;
    expect(j).toMatchObject({
      blocks_per_minute: 1000,
      blocks: 6500,
      minutes: 6.5,
      cursor_moves: 14,
      stop: "caught-up",
      target_blocks_per_minute: 1000,
      meets_target: true,
      logs_rpc: "https://base.gateway.tenderly.co",
      max_blocks_per_tick: 1000,
      rpc_max_retries: 6,
      rpc_backoff_ms: 1000,
      start_block: START,
      failed_polls: 0,
      failed_tick_polls: 0,
    });
  });
});

describe("refusals and honest no's", () => {
  test("an indexer with no logs RPC: exit 65 before any poll", async () => {
    const f = fake([health(START + 999, 53_000_000)], { env: ENV.filter((kv) => !kv.startsWith("INDEXER_LOGS_RPC_URL=")) });
    expect(await runCli([], f.deps)).toBe(EXIT.INPUT);
    expect(f.out()).toStartWith("no-logs-rpc: ");
    expect(f.urls.length).toBe(0);
  });
  test("an index already within one tick of the head is not a catch-up", async () => {
    const f = fake([health(53_000_000, 53_000_005)]);
    expect(await runCli([], f.deps)).toBe(EXIT.NO);
    expect(f.out()).toStartWith("not-catching-up: the index is 5 blocks behind head 53000005");
  });
  test("fewer than two cursor moves before the time limit is too short", async () => {
    const f = fake([health(START + 999, 53_000_000)]);
    expect(await runCli(["--minutes", "1", "--poll-secs", "30"], f.deps)).toBe(EXIT.NO);
    expect(f.out()).toContain("catch-up rate: none");
    expect(f.out()).toContain("too-short: the cursor moved fewer than two times (stopped: time-limit)");
  });
  test("an explorer that does not answer the first poll", async () => {
    const f = fake([new Error("connect ECONNREFUSED 127.0.0.1:18547")]);
    expect(await runCli([], f.deps)).toBe(EXIT.NO);
    expect(f.out()).toStartWith("explorer-unready: http://127.0.0.1:18547/health does not answer");
  });
  test("no docker, no container, a stopped container", async () => {
    let f = fake([health(null, null)], { docker: false });
    expect(await runCli([], f.deps)).toBe(EXIT.TOOL);
    expect(f.out()).toStartWith("docker-missing: ");
    f = fake([health(null, null)], { inspect: null });
    expect(await runCli([], f.deps)).toBe(EXIT.NO);
    expect(f.out()).toStartWith(`indexer-not-running: no container ${DEFAULT_CONTAINER}`);
    f = fake([health(null, null)], { inspect: { running: false, env: ENV } });
    expect(await runCli([], f.deps)).toBe(EXIT.NO);
    expect(f.out()).toStartWith("indexer-not-running: ");
  });
  test("usage errors exit 64", async () => {
    for (const argv of [["--minutes", "0"], ["--poll-secs", "abc"], ["--explorer-port", "70000"], ["--bogus"], ["stray"], ["--container", "x;rm"]]) {
      const f = fake([health(null, null)]);
      expect(await runCli(argv, f.deps)).toBe(EXIT.USAGE);
      expect(f.err()).toContain("usage: bun scripts/stage/measure-catch-up.ts");
    }
  });
  test("the defaults are the 8453 stack's explorer port and indexer container", () => {
    expect(parseCli([])).toEqual({ explorerPort: 18547, container: DEFAULT_CONTAINER, minutes: 30, pollSecs: 10, json: false });
  });
});
