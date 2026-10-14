#!/usr/bin/env bun
// Times an explorer indexer catch-up on the read-only Base mainnet stack and prints blocks per minute (core issue
// 1780, QA plan X9). Bun TypeScript: pure functions plus a small CLI.
// Canonical: docs/development/stage-deployment.md ("Measuring the catch-up rate"), core issue 1780.
//
// Why this exists: docs/development/stage-deployment.md ("Catch-up target") names 1000 blocks per minute on the
// `--logs-rpc` endpoint, but no run on that endpoint was ever timed. The only number is about 220 blocks per minute
// on mainnet.base.org, which throttles eth_getLogs with HTTP 429. This tool times a real catch-up of the stack
// `core-stack dapp up --chain 8453 ... --logs-rpc URL` started, so the doc records a measured rate instead.
//
// What it does. It only reads:
//   1. `docker inspect` of the running indexer container gives its settings. An indexer with no INDEXER_LOGS_RPC_URL
//      is refused (`no-logs-rpc`): the number would time --rpc, not the logs endpoint. Every RPC URL is kept as its
//      origin only, because a path or a query can carry an API key.
//   2. It polls the explorer `/health` (`last_indexed_block`, `chain_head_block`, `last_run_error`). A stack whose
//      index is within one tick of the head is refused (`not-catching-up`): there is nothing to time.
//   3. It stops when the index is within one tick of the head, at `--minutes`, or on Ctrl-C. It prints the rate
//      between the FIRST and the LAST cursor move it saw. Both ends are tick ends (to within one poll), so the time
//      before the first observed tick end and after the last one does not bend the number.
// It starts, stops and changes nothing, and it sends no JSON-RPC request itself.
//
// Usage, on the stage host, after `core-stack dapp down --chain 8453` and then
// `core-stack dapp up --chain 8453 ... --logs-rpc https://base.gateway.tenderly.co` (the down and up give an empty
// index, so the indexer catches up from the start block):
//   bun scripts/stage/measure-catch-up.ts [--explorer-port P] [--container NAME] [--minutes N] [--poll-secs S] [--json]
//
// Output: the result on stdout (one JSON object with --json), one JSON log line per poll on stderr.
// Exit codes: 0 a rate was measured; 1 no rate (explorer down, indexer not running, not catching up, fewer than two
// cursor moves); 3 docker missing; 64 usage; 65 the indexer has no logs RPC or a setting that is not a number.
import { parseArgs } from "node:util";
import { MAINNET_DEFAULT_PORTS, redactRpc } from "./mainnet-dapp.ts";

// ─── constants ───────────────────────────────────────────────────────────────
export const EXIT = { OK: 0, NO: 1, TOOL: 3, USAGE: 64, INPUT: 65 } as const;
/** The container `docker-compose.dapp.mainnet.yaml` names the 8453 indexer. */
export const DEFAULT_CONTAINER = "dapp8453-explorer-indexer";
/** The documented target this measurement confirms or replaces (stage-deployment.md, "Catch-up target"). */
export const TARGET_BLOCKS_PER_MINUTE = 1000;
/** Base makes one block every 2 s. */
export const BASE_BLOCKS_PER_MINUTE = 30;
/** The indexer's own defaults (services/explorer-indexer/src/main.rs), for a setting the container leaves unset. */
export const INDEXER_DEFAULTS = { maxBlocksPerTick: 1000, rpcMaxRetries: 0, rpcBackoffMs: 500, tickSeconds: 12 } as const;
export const DEFAULTS = { minutes: 30, pollSecs: 10 } as const;

const USAGE_TEXT = `usage: bun scripts/stage/measure-catch-up.ts [--explorer-port P] [--container NAME] [--minutes N] [--poll-secs S] [--json]
  --explorer-port P  the 8453 explorer API port on 127.0.0.1 (default ${MAINNET_DEFAULT_PORTS.explorer}, as core-stack dapp up)
  --container NAME   the running indexer container (default ${DEFAULT_CONTAINER})
  --minutes N        stop after N minutes if the index has not caught up (default ${DEFAULTS.minutes})
  --poll-secs S      seconds between two /health polls (default ${DEFAULTS.pollSecs})
  --json             print the result as one JSON object`;

/** A refusal or an honest "no": `cls` is the first word of the one line printed on stdout. */
export class MeasureError extends Error {
  constructor(
    public readonly cls: string,
    detail: string,
    public readonly code: number = EXIT.NO,
  ) {
    super(`${cls}: ${detail}`);
  }
}

// ─── the indexer's settings ──────────────────────────────────────────────────
export interface IndexerSettings {
  chainId: string;
  /** Origin of INDEXER_RPC_URL: headers, receipts and the snapshot eth_calls. */
  rpcOrigin: string;
  /** Origin of INDEXER_LOGS_RPC_URL: eth_getLogs only. */
  logsRpcOrigin: string;
  maxBlocksPerTick: number;
  rpcMaxRetries: number;
  rpcBackoffMs: number;
  tickSeconds: number;
  startBlock: number | null;
}

/** Replaces every URL in a text with its origin. An RPC error can quote the URL it failed on, key included. */
export function scrubUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'()<>,]+/g, (u) => redactRpc(u));
}

/**
 * The settings of the running indexer, from its `KEY=VALUE` environment list. Refuses one with no logs RPC: the
 * measurement exists to time the `--logs-rpc` endpoint. Values are never echoed back, only origins and numbers.
 */
export function readIndexerSettings(envList: string[]): IndexerSettings {
  const env = new Map<string, string>();
  for (const kv of envList) {
    const i = kv.indexOf("=");
    if (i > 0) env.set(kv.slice(0, i), kv.slice(i + 1).trim());
  }
  const get = (k: string): string => env.get(k) ?? "";
  const logs = get("INDEXER_LOGS_RPC_URL");
  if (!logs) {
    throw new MeasureError(
      "no-logs-rpc",
      "the indexer has no INDEXER_LOGS_RPC_URL, so this would time --rpc and not the logs endpoint; restart it with `core-stack dapp up --chain 8453 ... --logs-rpc URL`",
      EXIT.INPUT,
    );
  }
  const num = (k: string, dflt: number): number => {
    const v = get(k);
    if (!v) return dflt;
    if (!/^[0-9]+$/.test(v)) throw new MeasureError("bad-setting", `${k} in the indexer container is not a whole number`, EXIT.INPUT);
    return Number(v);
  };
  const rpc = get("INDEXER_RPC_URL");
  return {
    chainId: get("INDEXER_CHAIN_ID") || "(unset)",
    rpcOrigin: rpc ? redactRpc(rpc) : "(unset)",
    logsRpcOrigin: redactRpc(logs),
    maxBlocksPerTick: num("INDEXER_MAX_BLOCKS_PER_TICK", INDEXER_DEFAULTS.maxBlocksPerTick),
    rpcMaxRetries: num("INDEXER_RPC_MAX_RETRIES", INDEXER_DEFAULTS.rpcMaxRetries),
    rpcBackoffMs: num("INDEXER_RPC_BACKOFF_MS", INDEXER_DEFAULTS.rpcBackoffMs),
    tickSeconds: num("INDEXER_TICK_SECONDS", INDEXER_DEFAULTS.tickSeconds),
    startBlock: get("INDEXER_START_BLOCK") ? num("INDEXER_START_BLOCK", 0) : null,
  };
}

// ─── /health samples and the rate ────────────────────────────────────────────
/** One `/health` answer. `atMs` is a monotonic clock reading. */
export interface Sample {
  atMs: number;
  /** `last_indexed_block`: the highest cursor of a run that finished without an error. */
  cursor: number | null;
  /** `chain_head_block`: the head the last tick saw. */
  head: number | null;
  /** `last_run_error` of the newest finished run, URLs reduced to origins. */
  error: string | null;
}

export function parseHealth(body: unknown, atMs: number): Sample {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new MeasureError("health-shape", "/health did not answer a JSON object");
  const b = body as Record<string, unknown>;
  const whole = (k: string): number | null => {
    const v = b[k];
    if (v === null || v === undefined) return null;
    if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new MeasureError("health-shape", `/health ${k} is not a whole number`);
    return v;
  };
  const e = b.last_run_error;
  return { atMs, cursor: whole("last_indexed_block"), head: whole("chain_head_block"), error: typeof e === "string" && e ? scrubUrls(e).slice(0, 400) : null };
}

const lagOf = (s: Sample): number | null => (s.cursor !== null && s.head !== null ? s.head - s.cursor : null);

/**
 * The samples at which the cursor moved: a tick finished since the poll before. The first sample is never a move
 * (nobody knows when its cursor was set). A cursor that goes down (a reorg rewind) is not a move either.
 */
export function cursorMoves(samples: Sample[]): Sample[] {
  return samples.filter((s, i) => {
    if (i === 0 || s.cursor === null) return false;
    const prev = samples[i - 1]!.cursor;
    return prev === null || s.cursor > prev;
  });
}

export interface Rate {
  fromBlock: number;
  toBlock: number;
  blocks: number;
  minutes: number;
  blocksPerMinute: number;
  /** Cursor moves seen. Each is at least one tick; one poll can span two short ticks. */
  cursorMoves: number;
}

/** Blocks per minute from the first to the last cursor move, or null with fewer than two moves. */
export function catchUpRate(samples: Sample[]): Rate | null {
  const moves = cursorMoves(samples);
  if (moves.length < 2) return null;
  const first = moves[0]!;
  const last = moves[moves.length - 1]!;
  const blocks = last.cursor! - first.cursor!;
  const minutes = (last.atMs - first.atMs) / 60_000;
  if (blocks <= 0 || minutes <= 0) return null;
  return { fromBlock: first.cursor!, toBlock: last.cursor!, blocks, minutes, blocksPerMinute: blocks / minutes, cursorMoves: moves.length };
}

// ─── the measurement ─────────────────────────────────────────────────────────
export type HealthAnswer = { ok: true; body: unknown } | { ok: false; error: string };

/** Everything that touches the host. A test passes fakes. */
export interface Deps {
  has(tool: string): boolean;
  /** `docker inspect` of a container: running or not, and its environment. Null when there is no such container. */
  inspect(container: string): Promise<{ running: boolean; env: string[] } | null>;
  health(url: string): Promise<HealthAnswer>;
  /** A monotonic clock in milliseconds. */
  nowMs(): number;
  sleep(ms: number): Promise<void>;
  /** True once the operator pressed Ctrl-C: stop and print what was measured. */
  stopRequested(): boolean;
  out(s: string): void;
  err(s: string): void;
}

export interface MeasureOpts {
  explorerPort: number;
  container: string;
  minutes: number;
  pollSecs: number;
  json: boolean;
}

export interface Measurement {
  stop: "caught-up" | "time-limit" | "interrupted";
  settings: IndexerSettings;
  rate: Rate | null;
  polls: number;
  /** Polls the explorer did not answer. */
  failedPolls: number;
  /** Polls whose newest finished indexer run had failed (`last_run_error` set). */
  failedTickPolls: number;
  lastRunError: string | null;
  /** The last answered sample. */
  last: Sample | null;
  /** Hours a catch-up from INDEXER_START_BLOCK to the last head would take at this rate. */
  projectedFullCatchUpHours: number | null;
}

export async function measure(deps: Deps, o: MeasureOpts): Promise<Measurement> {
  if (!deps.has("docker")) throw new MeasureError("docker-missing", "docker is not on PATH: the indexer's settings are read with docker inspect", EXIT.TOOL);
  const c = await deps.inspect(o.container);
  if (!c) throw new MeasureError("indexer-not-running", `no container ${o.container}: start the stack with \`core-stack dapp up --chain 8453 ... --logs-rpc URL\``);
  if (!c.running) throw new MeasureError("indexer-not-running", `container ${o.container} is not running`);
  const settings = readIndexerSettings(c.env);
  const url = `http://127.0.0.1:${o.explorerPort}/health`;
  const t0 = deps.nowMs();
  const deadline = t0 + o.minutes * 60_000;
  const log = (line: Record<string, unknown>): void => deps.err(`${JSON.stringify({ t_s: Math.round((deps.nowMs() - t0) / 1000), ...line })}\n`);
  log({ event: "start", container: o.container, logs_rpc: settings.logsRpcOrigin, rpc: settings.rpcOrigin, max_blocks_per_tick: settings.maxBlocksPerTick });

  const samples: Sample[] = [];
  let polls = 0;
  let failedPolls = 0;
  let failedTickPolls = 0;
  let lastRunError: string | null = null;
  let sawBehind = false;
  let stop: Measurement["stop"];
  for (;;) {
    polls++;
    const r = await deps.health(url);
    const at = deps.nowMs();
    if (!r.ok) {
      if (samples.length === 0) throw new MeasureError("explorer-unready", `${url} does not answer (${scrubUrls(r.error)}): check --explorer-port`);
      failedPolls++;
      log({ event: "poll_failed", error: scrubUrls(r.error) });
    } else {
      const s = parseHealth(r.body, at);
      samples.push(s);
      const lag = lagOf(s);
      if (s.error) {
        failedTickPolls++;
        lastRunError = s.error;
      }
      log({ event: "poll", last_indexed_block: s.cursor, chain_head_block: s.head, lag_blocks: lag, ...(s.error ? { last_run_error: s.error } : {}) });
      if (lag !== null && lag <= settings.maxBlocksPerTick) {
        if (!sawBehind) {
          throw new MeasureError(
            "not-catching-up",
            `the index is ${lag} blocks behind head ${s.head}, within one tick (${settings.maxBlocksPerTick}): nothing to time. Run \`core-stack dapp down --chain 8453\`, then \`dapp up\` with --logs-rpc, for an empty index`,
          );
        }
        stop = "caught-up";
        break;
      }
      if (lag !== null) sawBehind = true;
    }
    if (deps.stopRequested()) {
      stop = "interrupted";
      break;
    }
    if (at >= deadline) {
      stop = "time-limit";
      break;
    }
    await deps.sleep(o.pollSecs * 1000);
  }
  const rate = catchUpRate(samples);
  const last = samples[samples.length - 1] ?? null;
  const projectedFullCatchUpHours =
    rate && settings.startBlock !== null && last?.head != null && last.head > settings.startBlock ? (last.head - settings.startBlock) / rate.blocksPerMinute / 60 : null;
  log({ event: "stop", stop, blocks_per_minute: rate ? Math.round(rate.blocksPerMinute) : null });
  return { stop, settings, rate, polls, failedPolls, failedTickPolls, lastRunError, last, projectedFullCatchUpHours };
}

// ─── output ──────────────────────────────────────────────────────────────────
/** The human result. It ends with a `too-short:` line when there is no rate. */
export function formatMeasurement(m: Measurement): string {
  const s = m.settings;
  const lines: string[] = [];
  if (m.rate) {
    const r = m.rate;
    lines.push(`catch-up rate: ${Math.round(r.blocksPerMinute)} blocks per minute (${r.blocks} blocks in ${r.minutes.toFixed(1)} min, cursor ${r.fromBlock} to ${r.toBlock}, ${r.cursorMoves} cursor moves)`);
  } else {
    lines.push("catch-up rate: none");
  }
  lines.push(`logs rpc: ${s.logsRpcOrigin} (eth_getLogs); rpc: ${s.rpcOrigin} (headers, receipts, eth_call); chain ${s.chainId}`);
  lines.push(`settings: INDEXER_MAX_BLOCKS_PER_TICK=${s.maxBlocksPerTick} INDEXER_RPC_MAX_RETRIES=${s.rpcMaxRetries} INDEXER_RPC_BACKOFF_MS=${s.rpcBackoffMs} INDEXER_TICK_SECONDS=${s.tickSeconds}`);
  const at = m.last && m.last.cursor !== null && m.last.head !== null ? ` at cursor ${m.last.cursor}, head ${m.last.head}, ${m.last.head - m.last.cursor} blocks behind` : "";
  lines.push(`stopped: ${m.stop}${at}`);
  if (m.rate) {
    const bpm = m.rate.blocksPerMinute;
    lines.push(`documented target ${TARGET_BLOCKS_PER_MINUTE} blocks per minute: ${bpm >= TARGET_BLOCKS_PER_MINUTE ? "met" : "not met"} (${(bpm / BASE_BLOCKS_PER_MINUTE).toFixed(1)} times the Base block rate of ${BASE_BLOCKS_PER_MINUTE} per minute)`);
  }
  if (m.projectedFullCatchUpHours !== null && m.last?.head != null) {
    lines.push(`a full catch-up from start block ${s.startBlock} to head ${m.last.head} at this rate: about ${m.projectedFullCatchUpHours.toFixed(1)} h`);
  }
  lines.push(`polls: ${m.polls}; unanswered: ${m.failedPolls}; with a failed tick: ${m.failedTickPolls}${m.lastRunError ? `; last tick error: ${m.lastRunError}` : ""}`);
  if (!m.rate) {
    lines.push(`too-short: the cursor moved fewer than two times (stopped: ${m.stop}); run longer with --minutes${m.lastRunError ? " and fix the tick error above" : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The result as one JSON object: what the doc records, with the endpoint and the settings it was measured on. */
export function measurementJson(m: Measurement): Record<string, unknown> {
  const s = m.settings;
  return {
    blocks_per_minute: m.rate ? Math.round(m.rate.blocksPerMinute) : null,
    blocks: m.rate?.blocks ?? null,
    minutes: m.rate ? round1(m.rate.minutes) : null,
    from_block: m.rate?.fromBlock ?? null,
    to_block: m.rate?.toBlock ?? null,
    cursor_moves: m.rate?.cursorMoves ?? 0,
    stop: m.stop,
    target_blocks_per_minute: TARGET_BLOCKS_PER_MINUTE,
    meets_target: m.rate ? m.rate.blocksPerMinute >= TARGET_BLOCKS_PER_MINUTE : null,
    logs_rpc: s.logsRpcOrigin,
    rpc: s.rpcOrigin,
    chain_id: s.chainId,
    max_blocks_per_tick: s.maxBlocksPerTick,
    rpc_max_retries: s.rpcMaxRetries,
    rpc_backoff_ms: s.rpcBackoffMs,
    tick_seconds: s.tickSeconds,
    start_block: s.startBlock,
    last_indexed_block: m.last?.cursor ?? null,
    chain_head_block: m.last?.head ?? null,
    projected_full_catch_up_hours: m.projectedFullCatchUpHours === null ? null : round1(m.projectedFullCatchUpHours),
    polls: m.polls,
    failed_polls: m.failedPolls,
    failed_tick_polls: m.failedTickPolls,
    last_run_error: m.lastRunError,
  };
}

// ─── the CLI ─────────────────────────────────────────────────────────────────
const usage = (msg: string): MeasureError => new MeasureError("usage", `${msg}\n${USAGE_TEXT}`, EXIT.USAGE);

function whole(flag: string, v: string | undefined, dflt: number, min: number, max: number): number {
  if (v === undefined) return dflt;
  if (!/^[0-9]+$/.test(v) || Number(v) < min || Number(v) > max) throw usage(`${flag} must be a whole number from ${min} to ${max}`);
  return Number(v);
}

export function parseCli(argv: string[]): MeasureOpts {
  let v: Record<string, string | boolean | undefined>;
  try {
    ({ values: v } = parseArgs({
      args: argv,
      options: {
        "explorer-port": { type: "string" },
        container: { type: "string" },
        minutes: { type: "string" },
        "poll-secs": { type: "string" },
        json: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    throw usage((e as Error).message);
  }
  const container = (v.container as string | undefined) ?? DEFAULT_CONTAINER;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) throw usage("--container must be a container name");
  return {
    explorerPort: whole("--explorer-port", v["explorer-port"] as string | undefined, MAINNET_DEFAULT_PORTS.explorer, 1, 65535),
    container,
    minutes: whole("--minutes", v.minutes as string | undefined, DEFAULTS.minutes, 1, 24 * 60),
    pollSecs: whole("--poll-secs", v["poll-secs"] as string | undefined, DEFAULTS.pollSecs, 1, 600),
    json: v.json === true,
  };
}

export async function runCli(argv: string[], deps: Deps): Promise<number> {
  try {
    const o = parseCli(argv);
    const m = await measure(deps, o);
    deps.out(o.json ? `${JSON.stringify(measurementJson(m))}\n` : formatMeasurement(m));
    return m.rate ? EXIT.OK : EXIT.NO;
  } catch (e) {
    if (!(e instanceof MeasureError)) throw e;
    if (e.code === EXIT.USAGE) deps.err(`${e.message}\n`);
    else deps.out(`${e.message}\n`);
    return e.code;
  }
}

export function realDeps(): Deps {
  let stopped = false;
  process.on("SIGINT", () => {
    // The first Ctrl-C stops after the current poll and prints the rate so far. A second one exits at once.
    if (stopped) process.exit(130);
    stopped = true;
  });
  return {
    has: (tool) => Bun.which(tool) !== null,
    async inspect(container) {
      const p = Bun.spawn(["docker", "inspect", "--format", '{"running":{{json .State.Running}},"env":{{json .Config.Env}}}', container], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, , code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(), p.exited]);
      if (code !== 0) return null;
      let j: { running?: unknown; env?: unknown };
      try {
        j = JSON.parse(stdout) as { running?: unknown; env?: unknown };
      } catch {
        throw new MeasureError("inspect-failed", `docker inspect ${container} did not print the expected JSON`);
      }
      return { running: j.running === true, env: Array.isArray(j.env) ? j.env.filter((x): x is string => typeof x === "string") : [] };
    },
    async health(url) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
        return { ok: true, body: await r.json() };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    nowMs: () => performance.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    stopRequested: () => stopped,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  };
}

if (import.meta.main) process.exit(await runCli(process.argv.slice(2), realDeps()));
