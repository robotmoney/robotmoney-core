// The stage runner. It loops over the stage table (stages.ts) the same way on every chain.
//   chain id from the RPC -> floors -> per stage: inputs -> start nonce -> simulate -> count check -> confirm -> broadcast -> count and nonce checks
// It spawns forge, cast and a read-only git status only. Every log line is JSON. Every failure class is a typed PublishError with its own exit code.
// Resume: the run manifest keeps each stage's start nonce and count. A rerun adopts the existing Safe and skips finished stages.
// A count mismatch after a broadcast is a hard failure. Plan: "One deploy sequence" (Resume), principle 17.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { decodeErrorResult, type Abi, type Hex } from "viem";
import { PublishError, isPublishError } from "./errors.ts";
import { PLAINTEXT_ENV, isMainnet } from "./floors.ts";
import { countFor, sumCounts, checkNonce, type FrozenCounts } from "./counts.ts";
import type { Logger } from "./log.ts";
import { DryRunFiles, type ChainStarter } from "./preflight.ts";
import type { PublishSigner } from "./signer.ts";
import { DEPLOYER_STAGES, STAGES, expectedStartNonce, getStageTable, manifestRef, stageByName, type StageRow } from "./stages.ts";
import { PROOF_STAGE, assertControlProven } from "./control-proof.ts";
import { LIBS_STAGE, RECORDER_STAGE, VAULT_KIND, VENUE_V4, resolveEnv } from "./core-wiring.ts";
import { runCoreConfigCheck, type CoreConfigCheck } from "./core-config-check.ts";
import { configCheck, loadVaultConfiguredAssets } from "./ci/config-check.ts";
import { viemReader } from "./verify/reader.ts";
import type { ChainReader } from "./verify/types.ts";
import { manifestBase, manifestPathFor } from "./stage-table.ts";
import { eligibilityBps, type Address, type Sheet } from "./sheet.ts";
import { httpRpc, isTwinFork, warpBy } from "./rehearsal/twin.ts";
import type { CallerInputs } from "./sheet.ts";
import { createSafe, impersonatedSender, connectSafe, verifyCreatedSafe, type CreateSafePlan, type SafeManifest } from "./safe/index.ts";

// ---- spawning: forge, cast and a read-only git status only -----------------------------------------------------------------------------------------

export type Tool = "forge" | "cast" | "git";
export interface SpawnOpts { env: Record<string, string>; cwd?: string; interactive?: boolean }
export interface SpawnResult { code: number; stdout: string; stderr: string }
export type ProcessRunner = (tool: Tool, args: string[], opts: SpawnOpts) => Promise<SpawnResult>;

/** The one allowed git spawn: `git -C DIR status --porcelain [--untracked-files=all]`, a read of the core checkout. Nothing else of git runs. */
export const isReadOnlyGitStatus = (args: string[]): boolean =>
  args.length >= 4 && args[0] === "-C" && args[2] === "status" && args[3] === "--porcelain" && args.slice(4).every((a) => a === "--untracked-files=all");

/** The real runner. Anything but forge, cast and the read-only git status is refused before a process starts. */
export const spawnTool: ProcessRunner = async (tool, args, opts) => {
  if (tool === "git" && !isReadOnlyGitStatus(args)) throw new PublishError("TOOL", `refusing to spawn git ${args.join(" ")}: the only git command is the read-only 'git -C DIR status --porcelain'`);
  if (tool !== "forge" && tool !== "cast" && tool !== "git") throw new PublishError("TOOL", `refusing to spawn '${String(tool)}': publish contracts spawns forge, cast and a read-only git status only`);
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn([tool, ...args], { cwd: opts.cwd, env: opts.env, stdin: opts.interactive ? "inherit" : "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    throw new PublishError("TOOL", `cannot start ${tool}: ${(e as Error).message}. Is Foundry installed and on PATH?`);
  }
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text(), p.exited]);
  return { code, stdout, stderr };
};

// ---- the run manifest ----------------------------------------------------------------------------------------------------

export interface StageRecord {
  status: "started" | "done";
  startNonce?: number;
  endNonce?: number;
  /** Frozen (expected) count, or the measured count in --measure mode. */
  count?: number;
  dryRunCount?: number;
  broadcastCount?: number;
  txHashes?: string[];
  firstBlock?: number;
  /** The last block of this stage's broadcast: the timelock stage's is the handover block. */
  lastBlock?: number;
  startedAt: string;
  finishedAt?: string;
  /** Safe stage: the predicted or created address, recorded before the creation is sent so a resume can adopt it. */
  safe?: string;
  [k: string]: unknown;
}

export interface RunManifest {
  version: 1;
  chainId: number;
  coreSha: string;
  deployer: string;
  environment: string;
  startedAt: string;
  firstBlock?: number;
  stages: Record<string, StageRecord>;
  govern?: Record<string, unknown>;
  /** Every pause-all that ran against this run, oldest first (issue 1686). Written by pause-all only, merged on every save. */
  pauses?: PauseEntry[];
  /** The highest manifest sequence number handed out by reserveManifestSeq (issue 1688). Merged by max on every save, so it only grows. */
  seqHigh?: number;
}

/**
 * One pause-all in the run manifest (issue 1686). `seq` is the manifest-wide monotonic sequence number shared with the govern `scheduled.seq`: govern
 * compares sequence numbers, never clocks, so clock skew between the operator machine, the chain and the log cannot hide a pause. The entry is written
 * `started` BEFORE the first pauseDeposits() is sent, each vault is appended as it finishes, and the last write sets `done` and `allPaused`.
 */
export interface PauseEntry {
  seq: number;
  at: string;
  trigger: string;
  reason: string;
  status: "started" | "done";
  allPaused?: boolean;
  vaults: Record<string, unknown>[];
}

export const manifestPath = (evidenceDir: string): string => join(evidenceDir, "publish-run.json");

export function loadRunManifest(evidenceDir: string): RunManifest | undefined {
  const p = manifestPath(evidenceDir);
  if (!existsSync(p)) return undefined;
  const j = JSON.parse(readFileSync(p, "utf8"));
  if (j.version !== 1) throw new PublishError("RESUME", `${p} is not a version 1 run manifest`);
  return j as RunManifest;
}

/**
 * The manifest write lock (issue 1686). pause-all and govern both rewrite publish-run.json, possibly from two processes: every read-modify-write takes
 * this lock file (O_EXCL), so neither drops the other's change. A lock older than 30 s is a crashed holder and is taken over.
 */
function withManifestLock<T>(evidenceDir: string, fn: () => T): T {
  mkdirSync(evidenceDir, { recursive: true });
  const lock = `${manifestPath(evidenceDir)}.lock`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try { closeSync(openSync(lock, "wx")); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { unlinkSync(lock); continue; } } catch { /* released meanwhile */ }
      if (Date.now() > deadline) throw new PublishError("MANIFEST", `${lock} is held by another process for over 15 s: remove it only if no publish-contracts process is running`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
}

function writeManifestFile(evidenceDir: string, m: RunManifest): void {
  const p = manifestPath(evidenceDir);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2) + "\n", { mode: 0o644 });
  renameSync(tmp, p);
}

const governScheduled = (m: Pick<RunManifest, "govern">): { seq?: number }[] =>
  Object.values(m.govern ?? {}).map((r) => (r as { scheduled?: { seq?: number } } | undefined)?.scheduled).filter((x): x is { seq?: number } => !!x);

/** The next manifest sequence number: above every pause entry, every stamped govern schedule and every reserved number. */
export const nextManifestSeq = (m: Pick<RunManifest, "govern" | "pauses" | "seqHigh">): number =>
  1 + Math.max(0, m.seqHigh ?? 0, ...(m.pauses ?? []).map((p) => p.seq), ...governScheduled(m).map((x) => x.seq ?? 0));

/** Merges what pause-all wrote on disk into `m` (the disk copy of a pause entry wins) and keeps the larger reserved number. Call under the lock. */
function mergeDisk(m: RunManifest, disk: RunManifest | undefined): void {
  const bySeq = new Map<number, PauseEntry>();
  for (const e of m.pauses ?? []) bySeq.set(e.seq, e);
  for (const e of disk?.pauses ?? []) bySeq.set(e.seq, e);
  if (bySeq.size) m.pauses = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const high = Math.max(m.seqHigh ?? 0, disk?.seqHigh ?? 0);
  if (high > 0) m.seqHigh = high;
}

function readDisk(evidenceDir: string): RunManifest | undefined {
  try { return loadRunManifest(evidenceDir); } catch { return undefined; /* a damaged file is overwritten, as before */ }
}

/**
 * Saves the manifest under the write lock without dropping a concurrent pause-all: the pause entries on disk are merged in first (pause-all owns them,
 * the disk copy wins). The merge mutates `m`, so the caller's in-memory copy sees it. A govern `scheduled` record WITHOUT a `seq` (written before issue
 * 1688, or adopted from the chain) is never given one here: a plain save has no idea when that schedule happened, so it stays older than any pause entry.
 */
export function saveRunManifest(evidenceDir: string, m: RunManifest): void {
  withManifestLock(evidenceDir, () => {
    mergeDisk(m, readDisk(evidenceDir));
    writeManifestFile(evidenceDir, m);
  });
}

/**
 * Issue 1688: reserves the next sequence number BEFORE the schedule transaction is sent, and saves `m` with the reservation. A pause-all that begins
 * after this call gets a higher number than the schedule, one that began before gets a lower one: the order is fixed at send time, not at the first
 * save after the send.
 */
export function reserveManifestSeq(evidenceDir: string, m: RunManifest): number {
  return withManifestLock(evidenceDir, () => {
    mergeDisk(m, readDisk(evidenceDir));
    const seq = nextManifestSeq(m);
    m.seqHigh = seq;
    writeManifestFile(evidenceDir, m);
    return seq;
  });
}

/**
 * pause-all: opens a pause entry (status `started`, next sequence number) in the manifest on disk. Re-reads the file under the lock, so a govern save
 * that landed a moment ago is kept. Returns undefined when there is no manifest file (nothing for govern to compare against).
 */
export function beginPauseEntry(evidenceDir: string, e: Omit<PauseEntry, "seq" | "status" | "vaults">): PauseEntry | undefined {
  return withManifestLock(evidenceDir, () => {
    const disk = loadRunManifest(evidenceDir);
    if (!disk) return undefined;
    const entry: PauseEntry = { ...e, seq: nextManifestSeq(disk), status: "started", vaults: [] };
    disk.pauses = [...(disk.pauses ?? []), entry];
    disk.seqHigh = entry.seq;
    writeManifestFile(evidenceDir, disk);
    return entry;
  });
}

/** pause-all: replaces the entry with this `seq` on disk (re-read under the lock). Used per vault and for the final `done`. */
export function updatePauseEntry(evidenceDir: string, entry: PauseEntry): void {
  withManifestLock(evidenceDir, () => {
    const disk = loadRunManifest(evidenceDir);
    if (!disk) return;
    disk.pauses = (disk.pauses ?? []).map((p) => (p.seq === entry.seq ? entry : p));
    writeManifestFile(evidenceDir, disk);
  });
}

// ---- context -------------------------------------------------------------------------------------------------------------

export interface RunContext {
  chainId: number;
  rpc: string;
  sheet: Sheet;
  coreDir: string;
  coreSha: string;
  evidenceDir: string;
  environment: string;
  signer: PublishSigner;
  caller: CallerInputs;
  /** Frozen counts for coreSha. Undefined only in --measure mode. */
  frozen?: FrozenCounts;
  measure: boolean;
  /** Dry run only: the per-stage transaction counts the simulations measured, by frozen-count key. */
  dryCounts?: Record<string, number>;
  resume: boolean;
  dryRun: boolean;
  run: ProcessRunner;
  log: Logger;
  /** Typed confirmation. Returns what the operator typed. Throws REFUSED when no human can answer. */
  prompt?: (question: string) => Promise<string>;
  githubActions: boolean;
  /** Process environment, filtered before it reaches a child. */
  baseEnv: Record<string, string | undefined>;
  /** Injected for tests. Defaults to the real Safe tool. */
  safeApi?: Partial<SafeApi>;
  now?: () => Date;
  /** Dry run: starts the local chain the forge simulations run on: a lazy fork of `rpc`, read only. Absent or returning undefined: simulate against `rpc`. */
  startChain?: ChainStarter;
  /** Injected for tests: the read-only chain reader behind the config-check that runs before each vault stage. Defaults to viem over `rpc`. */
  chainReader?: (rpc: string) => ChainReader;
  /** Injected for tests: the sleep, the poll and the longest wait of the recorder gate (core 1676). Defaults to a 15 s poll for up to 40 minutes. */
  recorderWait?: RecorderWaitDeps;
  /** Injected for tests: core's own config-check (bun scripts/ci/config-check.ts). Defaults to the real spawn. */
  coreConfigCheck?: CoreConfigCheck;
  /** Set by runStages in a dry run: the RPC forge simulates on (a local anvil) and the record of manifest files to restore. */
  simRpc?: string;
  dryFiles?: DryRunFiles;
  /** Absolute manifest directory chosen by the caller (env PUBLISH_MANIFEST_DIR). Undefined: deployments/<chainId>/ in the core checkout. */
  manifestOut?: string;
}

export interface SafeApi {
  createSafe: typeof createSafe;
  connectSafe: typeof connectSafe;
  verifyCreatedSafe: typeof verifyCreatedSafe;
}

/** The context fields that name where manifests live. */
export type ManifestCtx = Pick<RunContext, "coreDir" | "chainId" | "manifestOut">;
/**
 * Where the stage manifests are written and read: the directory PUBLISH_MANIFEST_DIR names when the caller set it (core's Twin harness does),
 * else deployments/<chainId>/ in the core checkout.
 */
export const manifestDir = (ctx: ManifestCtx): string => ctx.manifestOut ?? join(ctx.coreDir, "deployments", String(ctx.chainId));
/** The path a stage manifest file takes. forge gets it as DEPLOYMENT_OUT (absolute when the caller chose the directory). */
export const manifestFilePath = (ctx: ManifestCtx, file: string): string => join(manifestDir(ctx), file);

/** The environment a child process gets: no plaintext signing material, no YES or CONFIRM, plus the RPC and chain id. */
export function childEnv(ctx: Pick<RunContext, "baseEnv" | "rpc" | "chainId">, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.baseEnv)) {
    if (v === undefined) continue;
    if (PLAINTEXT_ENV.includes(k) || /^CHAIN_(SIGNER|FUNDER)_/.test(k) || k === "YES" || k === "CONFIRM") continue;
    out[k] = v;
  }
  out.ETH_RPC_URL = ctx.rpc; // cast reads this one
  out.FOUNDRY_ETH_RPC_URL = ctx.rpc; // forge script ignores ETH_RPC_URL (it then simulates in memory, with no SIMULATION COMPLETE line): it reads this one
  out.EXPECTED_CHAIN_ID = String(ctx.chainId);
  return { ...out, ...extra };
}

/** Env names whose values are treated as secrets in tool output: an RPC URL can carry a provider key, the rest are credentials. */
const SECRET_ENV_NAME = /RPC|URL|KEY|SECRET|PASS|TOKEN|MNEMONIC|PRIVATE|KEYSTORE|CREDENTIAL/i;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The values tool output must never show: the RPC and every secret-named value in the process environment (8 characters or more). */
export function outputSecrets(ctx: Pick<RunContext, "rpc" | "baseEnv">): string[] {
  const out = new Set<string>();
  if (ctx.rpc) out.add(ctx.rpc);
  for (const [k, v] of Object.entries(ctx.baseEnv)) if (v && v.length >= 8 && SECRET_ENV_NAME.test(k)) out.add(v);
  return [...out];
}

/**
 * Tool output made safe to log and to put in an error: every known secret value is cut out, every non-loopback URL loses all but its
 * scheme (a provider key can sit in the host, the path or the query), `password: x` style pairs lose their value, and a bare 32-byte hex
 * word (a raw key has no 0x; a transaction hash keeps its 0x and stays) is cut. Loopback URLs keep host and port: they name a local node.
 */
export function scrubToolOutput(text: string, secrets: readonly string[] = []): string {
  let s = text;
  for (const x of [...secrets].filter((v) => v.length >= 8).sort((a, b) => b.length - a.length)) s = s.split(x).join("[redacted]");
  s = s.replace(/\b(?:https?|wss?):\/\/[^\s"'<>()[\]{}]+/gi, (u) => {
    try { const p = new URL(u); return LOOPBACK_HOSTS.has(p.hostname) ? `${p.protocol}//${p.host}` : `${p.protocol}//[redacted]`; } catch { return "[redacted-url]"; }
  });
  s = s.replace(/\b(pass(?:word|phrase)?|mnemonic|private[_ -]?key|secret)(\s*[:=]\s*)\S+/gi, "$1$2[redacted]");
  s = s.replace(/(?<![0-9a-fA-Fx])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, "[redacted-hex]");
  return s;
}

/**
 * The lines of a failed forge run that say why: Error/revert lines first, else the last three lines. Compiler warning lists are noise.
 * The result is scrubbed (scrubToolOutput) of `secrets` and of anything that looks like one, so it can go into an error and a log line.
 */
export function forgeFailureTail(stdout: string, stderr: string, secrets: readonly string[] = []): string {
  const lines = `${stdout}\n${stderr}`.split("\n").map((l) => l.trim()).filter(Boolean);
  const why = lines.filter((l) => /^Error[: ]|\[Revert\]|^Warning: Your project has missing|If you wish to simulate on-chain/i.test(l));
  // a bare "Error: EVM error" says nothing: the trace lines before it (the failing call and its revert) are kept as well.
  // forge's missing-dependencies warning and simulate hint are not a reason, so they do not hide a bare error.
  const errs = why.filter((l) => !/^Warning: Your project has missing|If you wish to simulate on-chain/i.test(l));
  const bare = errs.length > 0 && errs.every((l) => /^Error: EVM error\s*$/i.test(l));
  const tail = (why.length && !bare ? why.slice(0, 4) : bare ? [...why.slice(0, 1), ...lines.filter((l) => !/^Error: EVM error\s*$/i.test(l)).slice(-12)] : lines.slice(-3)).join(" ");
  return scrubToolOutput(tail, secrets);
}

const hexToNumber = (v: unknown): number | undefined => {
  if (typeof v === "number") return v;
  if (typeof v !== "string" || v === "") return undefined;
  try { return Number(BigInt(v)); } catch { return undefined; }
};

/** Decodes revert data with the ABI of `contractName` from forge's out/ directory. Undefined when the artifact or the error is unknown. */
export function decodeRevert(coreDir: string, contractName: string | undefined, data: string): string | undefined {
  if (!contractName || !/^0x[0-9a-fA-F]{8}/.test(data)) return undefined;
  const out = join(coreDir, "out");
  if (!existsSync(out)) return undefined;
  const dir = [`${contractName}.sol`, ...readdirSync(out)].find((d) => existsSync(join(out, d, `${contractName}.json`)));
  if (!dir) return undefined;
  try {
    const abi = JSON.parse(readFileSync(join(out, dir, `${contractName}.json`), "utf8")).abi as Abi;
    const r = decodeErrorResult({ abi, data: data as Hex });
    return `${r.errorName}(${(r.args ?? []).map((a) => String(a)).join(", ")})`;
  } catch { return undefined; }
}

/**
 * After a failed broadcast: what forge itself does not print about the transaction it names as failed (`Transaction Failure: 0x..`).
 * From the broadcast file: the contract, the function and the gas limit (fixed by the script, or forge's estimate). From the chain:
 * the block, the status and the gas used, and the revert reason from an `eth_call` replay of the same call with the same gas limit on
 * the parent block (exact on an auto-mining node, a close replay on a shared one). Best effort: a read that fails is left out, and
 * the result is scrubbed of secrets. Empty when forge named no failed transaction.
 */
export async function failedBroadcastDetail(ctx: RunContext, script: string, stdout: string, stderr: string): Promise<string> {
  const m = /Transaction Failure:\s*(0x[0-9a-fA-F]{64})/.exec(`${stdout}\n${stderr}`);
  if (!m) return "";
  const hash = m[1]!;
  const parts: string[] = [`failed transaction ${hash}`];
  type BTx = { hash?: string; contractName?: string; function?: string; isFixedGasLimit?: boolean; transaction?: { from?: string; to?: string; gas?: string; value?: string; input?: string } };
  let tx: BTx | undefined;
  try {
    const j = JSON.parse(readFileSync(broadcastFile(ctx, script, false), "utf8"));
    tx = (Array.isArray(j.transactions) ? (j.transactions as BTx[]) : []).find((t) => t.hash?.toLowerCase() === hash.toLowerCase());
  } catch { /* no broadcast file: the chain reads below still say something */ }
  const gasLimit = hexToNumber(tx?.transaction?.gas);
  if (tx) parts.push(`${tx.contractName ?? "?"}.${tx.function ?? "?"}, gas limit ${gasLimit ?? "?"} (${tx.isFixedGasLimit ? "fixed by the script" : "forge's estimate"})`);
  let block: number | undefined;
  try {
    const r = await ctx.run("cast", ["receipt", hash, "--json"], { env: childEnv(ctx) });
    if (r.code === 0) {
      const rc = JSON.parse(r.stdout);
      block = hexToNumber(rc.blockNumber);
      parts.push(`mined in block ${block ?? "?"} with status ${hexToNumber(rc.status) ?? "?"}, gas used ${hexToNumber(rc.gasUsed) ?? "?"}`);
    }
  } catch { /* best effort */ }
  const t = tx?.transaction;
  if (t?.from && t.to && t.input && gasLimit !== undefined && block !== undefined && block > 0) {
    try {
      const r = await ctx.run("cast", ["call", "--from", t.from, "--gas-limit", String(gasLimit), "--value", String(hexToNumber(t.value) ?? 0), "--block", String(block - 1), t.to, t.input], { env: childEnv(ctx) });
      if (r.code !== 0) {
        const msg = `${r.stderr}\n${r.stdout}`.split("\n").map((l) => l.trim()).filter(Boolean);
        const reason = msg.find((l) => /revert/i.test(l)) ?? msg.slice(-1)[0] ?? "";
        const data = /data:\s*"?(0x[0-9a-fA-F]{8,})/.exec(msg.join(" "))?.[1] ?? /(0x[0-9a-fA-F]{8,})/.exec(reason)?.[1];
        const decoded = data ? decodeRevert(ctx.coreDir, tx?.contractName, data) : undefined;
        parts.push(`replay on block ${block - 1} reverts${decoded ? ` ${decoded}` : ""}: ${reason.slice(0, 400)}`);
      } else parts.push(`replay on block ${block - 1} does not revert (the block's earlier transactions changed the state)`);
    } catch { /* best effort */ }
  }
  return scrubToolOutput(parts.join("; "), outputSecrets(ctx));
}

export async function castOut(ctx: RunContext, args: string[]): Promise<string> {
  const r = await ctx.run("cast", args, { env: childEnv(ctx) });
  if (r.code !== 0) throw new PublishError("TOOL", `cast ${args[0]} failed: ${r.stderr.trim().split("\n").slice(-2).join(" ")}`);
  return r.stdout.trim();
}

export async function deployerNonce(ctx: RunContext, who: string): Promise<number> {
  const out = await castOut(ctx, ["nonce", who]);
  if (!/^[0-9]+$/.test(out)) throw new PublishError("TOOL", `cast nonce returned '${out}'`);
  return Number(out);
}

// ---- confirmation (a human is in the loop on a real chain) -------------------------------------------------------------

export async function confirmStage(ctx: RunContext, stage: string, summary: string): Promise<void> {
  if (ctx.caller.confirm === "environment") {
    if (!ctx.githubActions) throw new PublishError("REFUSED", "CONFIRM=environment is valid only inside GitHub Actions, behind an Environment with required reviewers");
    ctx.log.log("info", "confirm.environment", { stage, environment: ctx.environment });
    return;
  }
  if (ctx.caller.yes) {
    if (isMainnet(ctx.chainId)) throw new PublishError("FLOOR", "YES=1 is refused on chain 8453");
    ctx.log.log("warn", "confirm.yes", { stage, note: "YES=1 from the caller environment, not on chain 8453" });
    return;
  }
  if (!ctx.prompt) throw new PublishError("REFUSED", `stage ${stage} needs a human: run on a terminal, or set CONFIRM=environment in CI`);
  ctx.log.log("info", "confirm.request", { stage, summary });
  const a1 = (await ctx.prompt(`About to BROADCAST stage '${stage}' on chain ${ctx.chainId}: ${summary}\nOperator, type the stage name to go: `)).trim();
  if (a1 !== stage) throw new PublishError("REFUSED", `the operator did not confirm stage ${stage}; nothing was sent`);
  const a2 = (await ctx.prompt("Reviewer, type the stage name to go: ")).trim();
  if (a2 !== stage) throw new PublishError("REFUSED", `the reviewer did not confirm stage ${stage}; nothing was sent`);
}

// ---- manifests of earlier stages ---------------------------------------------------------------------------------------

export function readManifestField(ctx: ManifestCtx, ref: string): string {
  const [file, field] = ref.split(":") as [string, string];
  const p = join(manifestDir(ctx), `${file}.json`);
  if (!existsSync(p)) throw new PublishError("INPUT_MISSING", `manifest ${file}.json is missing: run the stage that writes it first`, { file });
  const j = JSON.parse(readFileSync(p, "utf8"));
  const v = j[field];
  if (typeof v !== "string" || v === "" || v === "null") throw new PublishError("INPUT_MISSING", `manifest ${file}.json has no ${field}`, { file, field });
  return v;
}

/** One env value, from the source the single mapping module (core-wiring.ts) names for it. Undefined when the sheet does not carry it. */
function envValue(ctx: RunContext, row: StageRow, name: string): string | undefined {
  const src = resolveEnv(name, row.vault ?? null);
  let v: string | undefined;
  if (src.from === "chain") v = String(ctx.chainId);
  else if (src.from === "literal") v = src.value;
  else if (src.from === "out") v = row.manifest ? (ctx.manifestOut ? manifestFilePath(ctx, row.manifest) : manifestPathFor(`deployments/<chain>/${row.manifest}`, ctx.chainId)) : undefined;
  else if (src.from === "sheet") v = ctx.sheet.values[src.name];
  else if (src.from === "manifest") v = readManifestField(ctx, `${src.stage === "safe" ? "safe" : stageManifestBase(src.stage)}:${src.field}`);
  else if (src.from === "computed") v = row.vault ? (eligibilityBps(ctx.sheet, row.vault)?.join(",") ?? "none") : undefined;
  else if (src.from === "vaults") v = getStageTable().vaults.map((x) => readManifestField(ctx, `${stageManifestBase(x.stage)}:${src.field}`)).join(",");
  else return undefined;
  if (v === "@safe") v = readManifestField(ctx, "safe:safe");
  return v;
}

const stageManifestBase = (stage: string): string => manifestBase(getStageTable().stages.find((s) => s.name === stage)!.manifest);

/** Every env var a forge stage gets: the table's requiredEnv (a missing value stops the stage) and the optionalEnv the sheet carries. */
export function stageEnv(ctx: RunContext, row: StageRow): Record<string, string> {
  const e: Record<string, string> = { CHAIN_ID: String(ctx.chainId), DEPLOY_SHA: ctx.coreSha };
  for (const name of row.requiredEnv) {
    const src = resolveEnv(name, row.vault ?? null);
    if (src.from === "unmapped") throw new PublishError("INPUT_MISSING", `stage ${row.name}: core reads ${name} and publish contracts has no mapping for it (core-wiring.ts)`, { stage: row.name, name });
    const v = envValue(ctx, row, name);
    if (v === undefined || v === "") throw new PublishError("INPUT_MISSING", `stage ${row.name} needs sheet name ${src.from === "sheet" ? src.name : name}`, { stage: row.name, name });
    e[name] = v;
  }
  for (const name of row.optionalEnv) {
    const src = resolveEnv(name, row.vault ?? null);
    if (src.from !== "sheet" && src.from !== "chain") continue; // a default in the script, or a manifest value only a required name takes
    const v = envValue(ctx, row, name);
    if (v !== undefined && v !== "") e[name] = v;
  }
  if (row.manifest) e.DEPLOYMENT_OUT = ctx.manifestOut ? manifestFilePath(ctx, row.manifest) : manifestPathFor(`deployments/<chain>/${row.manifest}`, ctx.chainId); // every stage gets its manifest path, required or not
  return e;
}

/** `--libraries path:artifact:address` for every library the stage links, the address read from the libs stage manifest. */
export function libraryArgs(ctx: ManifestCtx, row: StageRow): string[] {
  const out: string[] = [];
  for (const lib of row.libraries) {
    const addr = readManifestField(ctx, `${stageManifestBase(LIBS_STAGE)}:${lib.manifestKey}`);
    out.push("--libraries", `${lib.path}:${lib.artifact}:${addr}`);
  }
  return out;
}

// ---- forge ---------------------------------------------------------------------------------------------------------------

const scriptFile = (script: string): string => basename(script.split(":")[0]!);

function readTxCount(path: string): { count: number; hashes: string[]; firstBlock?: number; lastBlock?: number } | undefined {
  if (!existsSync(path)) return undefined;
  const j = JSON.parse(readFileSync(path, "utf8"));
  const txs: unknown[] = Array.isArray(j.transactions) ? j.transactions : [];
  const hashes = txs.map((t) => (t as { hash?: string }).hash).filter((h): h is string => typeof h === "string");
  const rc = Array.isArray(j.receipts) ? j.receipts : [];
  const blocks = rc.map((r: { blockNumber?: string }) => (r.blockNumber ? Number(BigInt(r.blockNumber)) : NaN)).filter((n: number) => Number.isFinite(n));
  return { count: txs.length, hashes, firstBlock: blocks.length ? Math.min(...blocks) : undefined, lastBlock: blocks.length ? Math.max(...blocks) : undefined };
}

/** forge writes broadcast/<ScriptFile>/<chainId>/(dry-run/)run-latest.json. */
export function broadcastFile(ctx: ManifestCtx, script: string, dry: boolean): string {
  const dir = join(ctx.coreDir, "broadcast", scriptFile(script), String(ctx.chainId), ...(dry ? ["dry-run"] : []));
  const main = join(dir, "run-latest.json");
  if (existsSync(main)) return main;
  if (existsSync(dir)) {
    const other = readdirSync(dir).find((f) => f.endsWith("-latest.json"));
    if (other) return join(dir, other);
  }
  return main;
}

function estimatedEthFrom(stdout: string): number | undefined {
  const m = /Estimated amount required:\s*([0-9]+\.[0-9]+)/.exec(stdout);
  return m ? Number(m[1]) : undefined;
}

/**
 * Before each vault stage the config-check runs again against the live RPC (the target chain, also in a dry run: it only reads) and the
 * stage fails on any failed row. A vault with no configured assets (rmUSDC holds no basket assets, and an agent list emptied through the timelock holds none) has nothing to check.
 */
export async function vaultConfigGate(ctx: RunContext, row: StageRow): Promise<void> {
  if (!row.vault) return;
  // core's own config-check first, before every vault stage (rmUSDC included): a failure stops the stage, a missing script is a named error
  const lines = await runCoreConfigCheck({ coreDir: ctx.coreDir, outDir: join(ctx.evidenceDir, "core-config-check"), chainId: ctx.chainId, rpc: ctx.rpc, baseEnv: ctx.baseEnv }, ctx.coreConfigCheck, `stage ${row.name}`);
  ctx.log.log("info", "stage.core_config_check", { stage: row.name, ok: true, lines: lines.length });
  if (VAULT_KIND[row.vault] === "usdc") return;
  const assets = loadVaultConfiguredAssets(ctx.coreDir, row.vault);
  if (assets.length === 0) { ctx.log.log("info", "stage.config_check_skipped", { stage: row.name, reason: "no configured assets" }); return; }
  const report = await configCheck((ctx.chainReader ?? viemReader)(ctx.rpc), assets);
  for (const c of report.checks) ctx.log.log(c.ok ? "info" : "error", "stage.config_check", { stage: row.name, label: c.label, ok: c.ok, detail: c.ok ? undefined : c.detail });
  const failed = report.checks.filter((c) => !c.ok);
  if (failed.length > 0) throw new PublishError("VERIFY", `config-check before stage ${row.name} failed ${failed.length} check(s): ${failed.slice(0, 5).map((c) => c.label).join(", ")}`, { stage: row.name, failed: failed.map((c) => c.label) });
}

/**
 * Seconds of price history the recorder must hold before a vault stage that registers a Uniswap V4 asset (core 1676): the 1800 s TWAP window
 * (`BasketVault.DEFAULT_TWAP_WINDOW`), which `addAsset` reads with `observe([1800, 0])`, plus three Base blocks.
 */
export const RECORDER_WINDOW_SECONDS = 1800;
export const RECORDER_WAIT_MARGIN_SECONDS = 6;
/** The longest a real chain (8453) is waited for in one process: a little over the window. A younger recorder after that is refused. */
export const RECORDER_MAX_WAIT_MS = (RECORDER_WINDOW_SECONDS + 600) * 1000;
export interface RecorderWaitDeps { sleep?: (ms: number) => Promise<void>; pollMs?: number; maxWaitMs?: number }

/**
 * The recorder wait (core 1676). The price recorder keeps no history before it exists, and `BasketVault.addAsset` reverts
 * `InsufficientObservationHistory` while it holds less than the 1800 s window. So a vault stage whose config lists a UniswapV4 asset
 * does not start until the recorder's oldest snapshot is older than the window.
 *   - the local simulation chain of a dry run and a Twin fork move time with the anvil warp (one jump, then a re-read);
 *   - a real chain (8453) is waited for, polling, up to RECORDER_MAX_WAIT_MS, then refused with RECORDER_HISTORY.
 * The recorder stage runs right after libs, so on a real run the other stages normally take longer than the window.
 */
export async function recorderWindowGate(ctx: RunContext, row: StageRow, deps: RecorderWaitDeps = {}): Promise<void> {
  if (!row.vault || row.kind !== "forge") return;
  if (!loadVaultConfiguredAssets(ctx.coreDir, row.vault).some((a) => a.venue === VENUE_V4)) return;
  const recorder = readManifestField(ctx, manifestRef(RECORDER_STAGE, "recorder")) as Address;
  const reader = (ctx.chainReader ?? viemReader)(ctx.rpc);
  if (!reader.blockTimestamp) throw new PublishError("TOOL", "this chain reader cannot read the head block timestamp: the recorder wait needs it");
  const need = RECORDER_WINDOW_SECONDS + RECORDER_WAIT_MARGIN_SECONDS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxWaitMs = deps.maxWaitMs ?? RECORDER_MAX_WAIT_MS;
  const t0 = Date.now();
  for (let warps = 0; ; ) {
    const oldest = BigInt((await reader.read(recorder, "function oldestObservation() view returns (uint32)")) as bigint | number);
    const age = Number((await reader.blockTimestamp()) - oldest);
    if (age >= need) { ctx.log.log("info", "stage.recorder_ready", { stage: row.name, recorder, history_s: age, need_s: need }); return; }
    const remaining = need - age;
    const warped = warps === 0 ? await warpForRecorder(ctx, remaining) : false;
    if (warped) { warps++; ctx.log.log("info", "stage.recorder_warped", { stage: row.name, recorder, seconds: remaining }); continue; }
    if (warps > 0 || Date.now() - t0 >= maxWaitMs) {
      throw new PublishError("RECORDER_HISTORY", `stage ${row.name}: the price recorder ${recorder} holds ${age} s of history, the vault needs ${need} s (the ${RECORDER_WINDOW_SECONDS} s window). addAsset would revert InsufficientObservationHistory. Nothing was sent. Wait ${remaining} s and rerun with --resume.`, { stage: row.name, recorder, history_s: age, need_s: need });
    }
    ctx.log.log("info", "stage.recorder_waiting", { stage: row.name, recorder, history_s: age, remaining_s: remaining });
    await sleep(deps.pollMs ?? 15_000);
  }
}

/** Moves time on a chain that may be warped (the dry-run simulation anvil, a Twin fork). False on any other chain, 8453 included. */
async function warpForRecorder(ctx: RunContext, seconds: number): Promise<boolean> {
  if (ctx.simRpc) {
    if (!isLoopback(ctx.simRpc)) throw new PublishError("USAGE", `refusing to warp ${ctx.simRpc}: only the local simulation chain of a dry run is warped`);
    for (const args of [["rpc", "evm_increaseTime", String(seconds), "--rpc-url", ctx.simRpc], ["rpc", "evm_mine", "--rpc-url", ctx.simRpc]]) {
      const r = await ctx.run("cast", args, { env: childEnv({ ...ctx, rpc: ctx.simRpc }) });
      if (r.code !== 0) throw new PublishError("TOOL", `cannot warp the local preflight chain: ${r.stderr.trim().split("\n").slice(-1)[0] ?? ""}`);
    }
    return true;
  }
  if (isMainnet(ctx.chainId)) return false;
  const rpc = httpRpc(ctx.rpc);
  if (!(await isTwinFork(rpc))) return false;
  await warpBy(rpc, BigInt(seconds));
  return true;
}

const isLoopback = (url: string): boolean => { try { const h = new URL(url).hostname; return h === "127.0.0.1" || h === "localhost" || h === "[::1]"; } catch { return false; } };

/** Dry run only: broadcasts the stage to the local simulation anvil (an impersonated sender, no key). Refuses any non-loopback RPC. */
async function applyToSimulationChain(ctx: RunContext, row: StageRow, base: string[], fenv: Record<string, string>, deployer: string, outPath: string, simCount: number): Promise<void> {
  if (!ctx.dryRun || !ctx.simRpc || !isLoopback(ctx.rpc) || ctx.rpc !== ctx.simRpc) throw new PublishError("USAGE", `refusing to apply stage ${row.name} to ${ctx.rpc}: only the local simulation chain of a dry run takes it`, { stage: row.name });
  const imp = await ctx.run("cast", ["rpc", "anvil_impersonateAccount", deployer, "--rpc-url", ctx.simRpc], { env: fenv });
  if (imp.code !== 0) throw new PublishError("TOOL", `cannot impersonate the deployer on the local preflight chain: ${imp.stderr.trim().split("\n").slice(-1)[0] ?? ""}`, { stage: row.name });
  const live = broadcastFile(ctx, row.script!, false);
  ctx.dryFiles?.touch(live);
  const run = await ctx.run("forge", [...base, "--broadcast", "--unlocked", "--rpc-url", ctx.simRpc], { env: fenv, cwd: ctx.coreDir, interactive: true });
  if (run.code !== 0 || !run.stdout.includes("ONCHAIN EXECUTION COMPLETE")) {
    throw new PublishError("SIMULATION", `stage ${row.name} simulated but could not be applied to the local preflight chain, so the later stages cannot be simulated (exit ${run.code}). Nothing reached the target. ${forgeFailureTail(run.stdout, run.stderr, outputSecrets(ctx))}`, { stage: row.name });
  }
  const sent = readTxCount(live);
  ctx.log.log("info", "stage.sim_applied", { stage: row.name, sent: sent?.count, simulated: simCount, local_only: true });
  if (sent && sent.count !== simCount) throw new PublishError("COUNT_MISMATCH", `stage ${row.name}: applied ${sent.count} transactions on the local chain, the simulation said ${simCount}`, { stage: row.name });
  if (!existsSync(outPath)) throw new PublishError("MANIFEST", `manifest ${outPath} was not written by ${row.name}`, { stage: row.name });
}

/**
 * The stage 11 gate (core 1618): the handover gives every role to a timelock whose proposer is the Safe, so the Safe must have signed
 * before it. Refuses with CONTROL_NOT_PROVEN unless the run manifest holds the finished proof on this Safe, signed by every owner, and
 * the live Safe nonce is 1 or more. A dry run has no proof to find (it sends nothing) and skips the gate, loudly.
 */
export async function controlProofGate(ctx: RunContext, row: StageRow, manifest: RunManifest): Promise<void> {
  if (row.name !== "timelock") return;
  if (ctx.dryRun) { ctx.log.log("warn", "stage.control_proof_skipped", { stage: row.name, reason: "dry run: the proof is a real transaction" }); return; }
  const api: Pick<SafeApi, "connectSafe"> = { connectSafe, ...(ctx.safeApi ?? {}) };
  const safe = readManifestField(ctx, manifestRef("safe", "safe"));
  const handle = await api.connectSafe({ rpcUrl: ctx.rpc, chainId: ctx.chainId, safeAddress: safe as Address, logger: ctx.log });
  const rec = assertControlProven(manifest.stages[PROOF_STAGE], { safe, owners: handle.owners, nonce: await handle.nonce() });
  ctx.log.log("info", "stage.control_proof_ok", { stage: row.name, safe, tx_hash: rec.txHash, signers: rec.signers.length });
}

async function runForgeStage(ctx: RunContext, row: StageRow, manifest: RunManifest): Promise<void> {
  await controlProofGate(ctx, row, manifest);
  await vaultConfigGate(ctx, row);
  const script = row.script!;
  const env = stageEnv(ctx, row);
  const real = ctx;
  if (ctx.simRpc) ctx = { ...ctx, rpc: ctx.simRpc }; // a dry run simulates on the local chain: nonces, balances and forge all read it
  await recorderWindowGate(ctx, row, ctx.recorderWait); // core 1676: the V4 price recorder must hold a full TWAP window before addAsset
  const deployer = await ctx.signer.address();
  if (deployer.toLowerCase() !== ctx.sheet.admin.toLowerCase()) throw new PublishError("SIGNER", `the signer ${deployer} is not ADMIN_ADDRESS ${ctx.sheet.admin}`);
  const counts = ctx.frozen;
  const expectedCount = counts ? countFor(counts, row.countKey!) : undefined;
  if (!counts && !ctx.measure) throw new PublishError("COUNTS_MISSING", "no frozen counts and not measuring");
  const prior = manifest.stages[row.name];

  // start nonce: exactly where the frozen counts say. Measure mode learns the start from earlier records.
  const nonce0 = await deployerNonce(ctx, deployer);
  const wantStart = counts ? expectedStartNonce(row.name, counts) : DEPLOYER_STAGES.slice(0, DEPLOYER_STAGES.findIndex((s) => s.name === row.name)).reduce((a, s) => a + (manifest.stages[s.name]?.count ?? 0), 0);
  let resuming = false;
  if (nonce0 !== wantStart) {
    const upper = wantStart + (expectedCount ?? Number.MAX_SAFE_INTEGER);
    if (ctx.resume && prior?.status === "started" && nonce0 > wantStart && nonce0 <= upper) resuming = true;
    else if (ctx.dryRun) ctx.log.log("warn", "stage.dry_run_nonce", { stage: row.name, nonce: nonce0, want: wantStart, note: "earlier stages are applied to the local preflight chain only" });
    else throw new PublishError("NONCE", `the deployer nonce is ${nonce0}, expected ${wantStart} before stage ${row.name}${ctx.resume ? "" : " (a stray or repeated transaction? if this stage died partway, use --resume)"}`, { stage: row.name, nonce: nonce0, want: wantStart });
  }
  const startNonce = prior?.status === "started" && prior.startNonce !== undefined ? prior.startNonce : nonce0;
  const rec: StageRecord = { status: "started", startNonce, count: expectedCount, startedAt: (ctx.now?.() ?? new Date()).toISOString() };
  const mdir = manifestDir(ctx);
  const outPath = manifestFilePath(ctx, row.manifest!);
  if (!resuming && existsSync(outPath) && !ctx.dryRun) throw new PublishError("MANIFEST", `${outPath} already exists: stage ${row.name} already ran`, { stage: row.name });
  mkdirSync(mdir, { recursive: true });
  if (ctx.dryRun) ctx.dryFiles?.touch(outPath);
  ctx.log.log("info", "stage.start", { stage: row.name, script, start_nonce: nonce0, expected_count: expectedCount ?? null, resume: resuming });

  const signerArgs = await ctx.signer.forgeArgs();
  const base = ["script", script, "--chain", String(ctx.chainId), ...signerArgs, "--slow", ...libraryArgs(ctx, row)];
  const fenv = childEnv(ctx, env);

  // simulate: nothing is sent
  rmSync(dirname(broadcastFile(ctx, script, true)), { recursive: true, force: true });
  const sim = await ctx.run("forge", base, { env: fenv, cwd: ctx.coreDir, interactive: true });
  if (sim.code !== 0 || !sim.stdout.includes("SIMULATION COMPLETE")) {
    throw new PublishError("SIMULATION", `simulation of ${row.name} failed (exit ${sim.code}). Nothing was sent. ${forgeFailureTail(sim.stdout, sim.stderr, outputSecrets(ctx))}`, { stage: row.name });
  }
  const dry = readTxCount(broadcastFile(ctx, script, true));
  if (!dry) throw new PublishError("SIMULATION", `the simulation of ${row.name} wrote no dry-run file`, { stage: row.name });
  rec.dryRunCount = dry.count;
  if (ctx.dryCounts) ctx.dryCounts[row.countKey!] = dry.count;
  ctx.log.log("info", "stage.simulated", { stage: row.name, dry_run_count: dry.count, expected_count: expectedCount ?? null });
  if (expectedCount !== undefined && dry.count !== expectedCount) throw new PublishError("COUNT_MISMATCH", `stage ${row.name}: the dry-run sends ${dry.count} transactions, the frozen count is ${expectedCount}. Nothing was sent.`, { stage: row.name, dry: dry.count, frozen: expectedCount });
  if (ctx.dryRun) {
    // The simulation wrote the manifest. It stays for the later stages of this dry run (their inputs); runStages restores the checkout at the end.
    // On the local chain the stage is then APPLIED to it, so the later stages find the contracts this one deployed (a registry stage
    // reads VAULT_ADDRESS code). That sends to the local anvil only (the sender is impersonated there), never to the target RPC.
    if (real.simRpc) await applyToSimulationChain(ctx, row, base, fenv, deployer, outPath, dry.count);
    ctx.log.log("info", "stage.dry_run_done", { stage: row.name, dry_run_count: dry.count, simulated_on: real.simRpc ? "local-anvil" : "target-rpc" });
    return;
  }
  rmSync(outPath, { force: true }); // a simulation also writes the manifest; the real run rewrites it

  // fee guard: forge prices L2 execution only, so allow 3x plus 0.0001 ETH for the L1 data fee
  const est = estimatedEthFrom(sim.stdout);
  if (est !== undefined) {
    const need = BigInt(Math.ceil(est * 3 * 1e18)) + 100_000_000_000_000n;
    const bal = BigInt(await castOut(ctx, ["balance", deployer]));
    if (bal < need) throw new PublishError("SIMULATION", `the deployer balance ${bal} wei is below ${need} wei (3x the simulated cost plus the L1 allowance). Fund it.`, { stage: row.name });
  }

  manifest.stages[row.name] = rec;
  saveRunManifest(ctx.evidenceDir, manifest);
  await confirmStage(ctx, row.name, `${row.name}: ${dry.count} transactions from ${deployer}`);

  ctx.log.log("info", "stage.broadcast", { stage: row.name, resume: resuming });
  const run = await ctx.run("forge", [...base, "--broadcast", ...(resuming ? ["--resume"] : [])], { env: fenv, cwd: ctx.coreDir, interactive: true });
  const nonce1 = await deployerNonce(ctx, deployer);
  if (run.code !== 0 || !run.stdout.includes("ONCHAIN EXECUTION COMPLETE")) {
    // forge's own words (scrubbed of the RPC and any secret), then what the chain says about the transaction forge names as failed
    const forgeSaid = forgeFailureTail(run.stdout, run.stderr, outputSecrets(ctx));
    const failedTx = await failedBroadcastDetail(ctx, script, run.stdout, run.stderr);
    ctx.log.log("error", "stage.broadcast_failed", { stage: row.name, exit: run.code, forge: forgeSaid, failed_tx: failedTx || undefined });
    const mined = failedTx ? " A transaction that was mined and reverted is NOT resent by --resume: read the failed transaction below before you continue." : "";
    throw new PublishError("BROADCAST", `the broadcast of ${row.name} did not complete (exit ${run.code}). Do NOT rerun fresh. Continue with --resume and the same arguments. Deployer nonce is now ${nonce1}.${mined} forge: ${forgeSaid}${failedTx ? ` | ${failedTx}` : ""}`, { stage: row.name, nonce: nonce1, forge: forgeSaid, failedTx: failedTx || undefined });
  }
  const sent = readTxCount(broadcastFile(ctx, script, false));
  if (!sent) throw new PublishError("MANIFEST", `forge wrote no broadcast file for ${row.name}`, { stage: row.name });
  rec.broadcastCount = sent.count;
  rec.txHashes = sent.hashes;
  rec.firstBlock = sent.firstBlock;
  rec.lastBlock = sent.lastBlock;
  rec.endNonce = nonce1;
  const delta = nonce1 - startNonce;
  // the count checks that make the broadcast trustworthy: broadcast file, nonce delta and the frozen count all agree
  if (expectedCount !== undefined && (sent.count !== expectedCount || delta !== expectedCount)) {
    throw new PublishError("COUNT_MISMATCH", `stage ${row.name}: broadcast count ${sent.count}, nonce delta ${delta}, frozen count ${expectedCount}. The chain has changed: stop and read it.`, { stage: row.name, broadcast: sent.count, delta, frozen: expectedCount });
  }
  if (expectedCount === undefined && sent.count !== delta) throw new PublishError("COUNT_MISMATCH", `stage ${row.name}: broadcast count ${sent.count} differs from the nonce delta ${delta}`, { stage: row.name });
  rec.count = expectedCount ?? sent.count;
  if (!existsSync(outPath) || readFileSync(outPath, "utf8").trim() === "") throw new PublishError("MANIFEST", `manifest ${outPath} was not written by ${row.name}`, { stage: row.name });
  if (sent.firstBlock !== undefined && (manifest.firstBlock === undefined || sent.firstBlock < manifest.firstBlock)) manifest.firstBlock = sent.firstBlock;
  rec.status = "done";
  rec.finishedAt = (ctx.now?.() ?? new Date()).toISOString();
  manifest.stages[row.name] = rec;
  saveRunManifest(ctx.evidenceDir, manifest);
  ctx.log.log("info", "stage.done", { stage: row.name, start_nonce: startNonce, end_nonce: nonce1, count: rec.count });
}

// ---- the Safe stage ------------------------------------------------------------------------------------------------------

async function createSafeOnSimulationChain(ctx: RunContext, api: SafeApi, deployer: Address, predicted: Address, outPath: string): Promise<void> {
  const simRpc = ctx.simRpc!;
  if (!isLoopback(simRpc)) throw new PublishError("USAGE", `refusing to create the Safe on ${simRpc}: only the local simulation chain takes it`);
  const chain = { rpcUrl: simRpc, chainId: ctx.chainId };
  const imp = await ctx.run("cast", ["rpc", "anvil_impersonateAccount", deployer, "--rpc-url", simRpc], { env: childEnv({ ...ctx, rpc: simRpc }) });
  if (imp.code !== 0) throw new PublishError("TOOL", `cannot impersonate the deployer on the local preflight chain: ${imp.stderr.trim().split("\n").slice(-1)[0] ?? ""}`);
  const simNonce = await deployerNonce({ ...ctx, rpc: simRpc }, deployer);
  const res = await api.createSafe({
    ...chain, owners: ctx.sheet.safeOwners, threshold: ctx.sheet.safeThreshold, deployer: impersonatedSender(deployer, chain), deploySha: ctx.coreSha, saltNonce: ctx.sheet.safeSalt,
    forbiddenOwners: { ADMIN_ADDRESS: ctx.sheet.admin, PAUSER_ADDRESS: ctx.sheet.pauser, EMERGENCY_ADDRESS: ctx.sheet.emergency },
    expectDeployerNonce: simNonce, logger: ctx.log, dryRun: false, confirm: async () => true,
  });
  if (!res.created || !res.manifest) throw new PublishError("SIMULATION", "the Safe was not created on the local preflight chain, so the later stages cannot be simulated");
  if (res.manifest.safe.toLowerCase() !== predicted.toLowerCase()) throw new PublishError("SIMULATION", `the Safe created on the local chain (${res.manifest.safe}) is not the predicted ${predicted}`);
  ctx.dryFiles?.write(outPath, JSON.stringify(res.manifest satisfies SafeManifest, null, 2) + "\n");
  ctx.log.log("info", "stage.sim_applied", { stage: "safe", safe: res.manifest.safe, local_only: true });
}

async function runSafeStage(ctx: RunContext, row: StageRow, manifest: RunManifest): Promise<void> {
  const api: SafeApi = { createSafe, connectSafe, verifyCreatedSafe, ...(ctx.safeApi ?? {}) };
  const deployer = await ctx.signer.address();
  if (deployer.toLowerCase() !== ctx.sheet.admin.toLowerCase()) throw new PublishError("SIGNER", `the signer ${deployer} is not ADMIN_ADDRESS ${ctx.sheet.admin}`);
  const counts = ctx.frozen;
  const expectedCount = counts ? countFor(counts, "safe") : undefined;
  const wantStart = counts ? expectedStartNonce("safe", counts) : 0;
  const nonce0 = await deployerNonce(ctx, deployer);
  const prior = manifest.stages.safe;
  const chain = { rpcUrl: ctx.rpc, chainId: ctx.chainId };
  const outPath = join(manifestDir(ctx), "safe.json");
  mkdirSync(manifestDir(ctx), { recursive: true });

  // resume: adopt a Safe that was created before the run died
  if (ctx.resume && prior?.safe && !existsSync(outPath)) {
    const handle = await api.connectSafe({ ...chain, safeAddress: prior.safe as Address, logger: ctx.log });
    await api.verifyCreatedSafe(handle, { owners: ctx.sheet.safeOwners, threshold: ctx.sheet.safeThreshold });
    const adopted = { safe: prior.safe, version: "1.4.1", threshold: ctx.sheet.safeThreshold, owners: ctx.sheet.safeOwners, created_by: deployer, chain_id: ctx.chainId, adopted: true };
    writeFileSync(outPath, JSON.stringify(adopted, null, 2) + "\n");
    ctx.log.log("info", "stage.safe_adopted", { safe: prior.safe });
    const end = await deployerNonce(ctx, deployer);
    manifest.stages.safe = { ...prior, status: "done", endNonce: end, count: expectedCount ?? end - (prior.startNonce ?? 0), finishedAt: new Date().toISOString() };
    saveRunManifest(ctx.evidenceDir, manifest);
    return;
  }
  if (nonce0 !== wantStart) throw new PublishError("NONCE", `the deployer nonce is ${nonce0}, expected ${wantStart} before stage safe`, { nonce: nonce0, want: wantStart });
  if (existsSync(outPath) && !ctx.dryRun) throw new PublishError("MANIFEST", `${outPath} already exists: the safe stage already ran`);

  const rec: StageRecord = { status: "started", startNonce: nonce0, count: expectedCount, startedAt: new Date().toISOString() };
  ctx.log.log("info", "stage.start", { stage: "safe", start_nonce: nonce0, expected_count: expectedCount ?? null });
  const signer = await ctx.signer.safeSigner();
  const res = await api.createSafe({
    ...chain, owners: ctx.sheet.safeOwners, threshold: ctx.sheet.safeThreshold, deployer: signer, deploySha: ctx.coreSha, saltNonce: ctx.sheet.safeSalt,
    forbiddenOwners: { ADMIN_ADDRESS: ctx.sheet.admin, PAUSER_ADDRESS: ctx.sheet.pauser, EMERGENCY_ADDRESS: ctx.sheet.emergency },
    expectDeployerNonce: nonce0, logger: ctx.log, dryRun: ctx.dryRun,
    confirm: async (plan: CreateSafePlan) => {
      // record the predicted address BEFORE anything is sent: a resume adopts it
      rec.safe = plan.predictedAddress;
      manifest.stages.safe = rec;
      saveRunManifest(ctx.evidenceDir, manifest);
      await confirmStage(ctx, "safe", `a ${plan.threshold}-of-${plan.owners.length} Safe v${plan.version} at ${plan.predictedAddress}`);
      return true;
    },
  });
  if (ctx.dryRun || !res.created || !res.manifest) {
    if (ctx.dryRun) {
      // the predicted Safe is the input of the stages after it (the vault fee recipient, the timelock): kept until runStages restores the checkout
      const sim = { safe: res.plan.predictedAddress, version: "1.4.1", threshold: ctx.sheet.safeThreshold, owners: ctx.sheet.safeOwners, created_by: deployer, chain_id: ctx.chainId, simulated: true };
      ctx.dryFiles?.write(outPath, JSON.stringify(sim, null, 2) + "\n");
      // On the local simulation chain the Safe is CREATED for real (the same createSafe tool, the node signs for the impersonated
      // deployer), because the timelock stage reads the Safe's code. It reaches the local anvil only, never the target RPC.
      if (ctx.simRpc) await createSafeOnSimulationChain(ctx, api, deployer, res.plan.predictedAddress, outPath);
    }
    if (ctx.dryCounts) ctx.dryCounts.safe = 1;
    ctx.log.log("info", "stage.dry_run_done", { stage: "safe", predicted: res.plan.predictedAddress });
    return;
  }
  writeFileSync(outPath, JSON.stringify(res.manifest satisfies SafeManifest, null, 2) + "\n");
  const end = await deployerNonce(ctx, deployer);
  const delta = end - nonce0;
  if (expectedCount !== undefined && delta !== expectedCount) throw new PublishError("COUNT_MISMATCH", `stage safe: nonce delta ${delta}, frozen count ${expectedCount}`, { delta, frozen: expectedCount });
  rec.status = "done"; rec.endNonce = end; rec.count = expectedCount ?? delta; rec.broadcastCount = delta; rec.dryRunCount = 1;
  rec.safe = res.manifest.safe; rec.txHashes = [res.manifest.tx_hash]; rec.firstBlock = res.manifest.block; rec.finishedAt = new Date().toISOString();
  if (manifest.firstBlock === undefined || res.manifest.block < manifest.firstBlock) manifest.firstBlock = res.manifest.block;
  manifest.stages.safe = rec;
  saveRunManifest(ctx.evidenceDir, manifest);
  ctx.log.log("info", "stage.done", { stage: "safe", safe: res.manifest.safe, start_nonce: nonce0, end_nonce: end, count: rec.count });
}

// ---- the loop --------------------------------------------------------------------------------------------------------------

export type StageHandler = (ctx: RunContext, row: StageRow, manifest: RunManifest) => Promise<void>;
export interface Handlers { prove: StageHandler; verify: StageHandler; govern: StageHandler }

export function newManifest(ctx: RunContext, deployer: string): RunManifest {
  return { version: 1, chainId: ctx.chainId, coreSha: ctx.coreSha, deployer, environment: ctx.environment, startedAt: new Date().toISOString(), stages: {} };
}

export interface RunResult { manifest: RunManifest; ran: string[]; skipped: string[] }

/**
 * A dry run (the preflight) simulates EVERY deployer stage up to the last one asked for, in table order, whatever was named: a stage
 * whose inputs come from an earlier stage's manifest gets them from that stage's simulation. A manifest that already exists (a real
 * earlier stage on this chain) is used as it is. The local chain is a blank anvil that this function starts and stops; the manifest
 * files the simulations write are removed at the end. verify and govern read a real deployment: a dry run skips them, loudly.
 */
export function dryRunOrder(names: string[]): StageRow[] {
  const deployer = STAGES.filter((s) => s.kind === "safe" || s.kind === "forge");
  const last = Math.max(-1, ...deployer.map((s, i) => (names.includes(s.name) ? i : -1)));
  const upTo = deployer.slice(0, last + 1);
  const rest = STAGES.filter((s) => (s.kind === "prove" || s.kind === "verify" || s.kind === "govern") && names.includes(s.name));
  return [...upTo, ...rest];
}

async function simulationChain(ctx: RunContext, deployer: string): Promise<{ simRpc?: string; stop: () => Promise<void> }> {
  const chain = ctx.startChain ? await ctx.startChain(ctx.chainId, ctx.rpc) : undefined;
  if (!chain) {
    ctx.log.log("warn", "preflight.no_local_chain", { note: "anvil is not installed: simulating against the target RPC (forge script without --broadcast sends nothing)" });
    return { stop: async () => {} };
  }
  ctx.log.log("info", "preflight.local_chain", { chain_id: ctx.chainId, note: "local anvil, a lazy fork of the target (the real USDC and venues are needed); the target RPC is only read" });
  // the sender needs gas money on the blank chain: a cast rpc call to the local chain, never the target
  const r = await ctx.run("cast", ["rpc", "anvil_setBalance", deployer, "0x3635C9ADC5DEA00000", "--rpc-url", chain.rpc], { env: childEnv({ ...ctx, rpc: chain.rpc }) });
  if (r.code !== 0) { await chain.stop(); throw new PublishError("TOOL", `cannot fund the deployer on the local preflight chain: ${r.stderr.trim().split("\n").slice(-1)[0] ?? ""}`); }
  // the seed deposit needs USDC in the deployer's hands: topped up on this local chain only (a real run has it funded by the owner)
  const seed = ctx.sheet.values["SEED_DEPOSIT_USDC"];
  if (chain.topUpUsdc && seed && /^[0-9]+$/.test(seed) && BigInt(seed) > 0n) {
    try { await chain.topUpUsdc(deployer, BigInt(seed)); } catch (e) { await chain.stop(); throw e; }
  }
  return { simRpc: chain.rpc, stop: chain.stop };
}

/** Runs the named stages in table order. Stops at the first failure (the error is rethrown with its own exit code). */
export async function runStages(ctx: RunContext, names: string[], handlers: Handlers): Promise<RunResult> {
  for (const n of names) stageByName(n); // unknown names fail before any work
  const deployer = await ctx.signer.address();
  let manifest = loadRunManifest(ctx.evidenceDir);
  if (manifest) {
    if (!ctx.resume && Object.keys(manifest.stages).length > 0 && !ctx.dryRun) throw new PublishError("RESUME", `${manifestPath(ctx.evidenceDir)} exists with earlier stages: pass --resume to continue, or use a fresh evidence directory`);
    if (manifest.chainId !== ctx.chainId || manifest.coreSha !== ctx.coreSha || manifest.deployer.toLowerCase() !== deployer.toLowerCase()) throw new PublishError("RESUME", "the run manifest belongs to a different chain, core SHA or deployer");
  } else manifest = newManifest(ctx, deployer);
  const ran: string[] = [], skipped: string[] = [];
  let stop = async () => {};
  if (ctx.dryRun) {
    const sim = await simulationChain(ctx, deployer);
    stop = sim.stop;
    ctx = { ...ctx, simRpc: sim.simRpc, dryFiles: new DryRunFiles() };
    // a dry run never persists the run manifest: it would claim stages that were only simulated
    manifest = newManifest(ctx, deployer);
  }
  const ordered = ctx.dryRun ? dryRunOrder(names) : STAGES.filter((s) => names.includes(s.name));
  try {
    for (const row of ordered) {
      const rec = manifest.stages[row.name];
      if (ctx.resume && rec?.status === "done" && row.kind !== "verify" && row.kind !== "govern") {
        ctx.log.log("info", "stage.skipped", { stage: row.name, reason: "done in the run manifest" });
        skipped.push(row.name);
        continue;
      }
      if (ctx.dryRun && (row.kind === "prove" || row.kind === "verify" || row.kind === "govern")) {
        ctx.log.log("warn", "stage.dry_run_skipped", { stage: row.name, reason: row.kind === "prove" ? "the control proof is a real Safe transaction signed by every owner: nothing to simulate" : `${row.kind} reads a finished deployment: nothing to simulate` });
        skipped.push(row.name);
        continue;
      }
      if (ctx.dryRun && !names.includes(row.name) && row.manifest && existsSync(join(manifestDir(ctx), row.manifest))) {
        ctx.log.log("info", "stage.dry_run_reused", { stage: row.name, reason: "its manifest exists on this checkout: used as the input of the later stages" });
        skipped.push(row.name);
        continue;
      }
      try {
        if (row.kind === "safe") await runSafeStage(ctx, row, manifest);
        else if (row.kind === "forge") await runForgeStage(ctx, row, manifest);
        else if (row.kind === "prove") await handlers.prove(ctx, row, manifest);
        else if (row.kind === "verify") await handlers.verify(ctx, row, manifest);
        else await handlers.govern(ctx, row, manifest);
        ran.push(row.name);
      } catch (e) {
        ctx.log.log("error", "stage.failed", { stage: row.name, kind: isPublishError(e) ? e.kind : "UNEXPECTED", message: (e as Error).message });
        throw e;
      }
    }
  } finally {
    ctx.dryFiles?.restore();
    await stop();
  }
  return { manifest, ran, skipped };
}

/** True once the govern stage has started or finished: it sends transactions from the deployer keystore (Safe execTransaction gas). */
export const governHasRun = (manifest: RunManifest): boolean => !!manifest.stages.govern || Object.keys(manifest.govern ?? {}).length > 0;

export type NonceCheckOutcome =
  | { checked: true; nonce: number; sum: number }
  | { checked: false; reason: "dry-run" | "govern-started" | "deployer-stages-incomplete" | "no-deployer-stage-ran" };

/**
 * The end-of-deploy nonce check: the deployer nonce must equal the summed frozen counts. It is a stage-12 check, so it runs only when
 * EVERY deployer stage is done in the run manifest and this run executed at least one of them (a partial run, a run of other stages and a
 * dry run do not run it). After govern started the deployer nonce includes the Safe execTransaction gas, so it is skipped there and the
 * verifier compares its recorded end-of-deploy nonce instead. The outcome names the reason whenever it did not run.
 */
export async function finalNonceCheck(ctx: RunContext, manifest: RunManifest, ran: string[] = DEPLOYER_STAGES.map((s) => s.name)): Promise<NonceCheckOutcome> {
  const skip = (reason: Extract<NonceCheckOutcome, { checked: false }>["reason"]): NonceCheckOutcome => {
    ctx.log.log("info", "run.nonce_check_skipped", { reason });
    return { checked: false, reason };
  };
  if (ctx.dryRun) return skip("dry-run");
  if (governHasRun(manifest)) return skip("govern-started");
  if (!DEPLOYER_STAGES.every((s) => manifest.stages[s.name]?.status === "done")) return skip("deployer-stages-incomplete");
  if (!DEPLOYER_STAGES.some((s) => ran.includes(s.name))) return skip("no-deployer-stage-ran");
  const nonce = await deployerNonce(ctx, await ctx.signer.address());
  const counts: FrozenCounts = ctx.frozen ?? Object.fromEntries(DEPLOYER_STAGES.map((s) => [s.countKey!, manifest.stages[s.name]!.count ?? 0]));
  checkNonce(nonce, counts);
  const sum = sumCounts(counts);
  ctx.log.log("info", "run.nonce_ok", { nonce, summed_frozen_counts: sum });
  return { checked: true, nonce, sum };
}

/** The counts a --measure run learned, keyed by frozen-count key. */
export function measuredCounts(manifest: RunManifest): FrozenCounts {
  return Object.fromEntries(DEPLOYER_STAGES.map((s) => [s.countKey!, manifest.stages[s.name]?.count ?? 0]));
}
