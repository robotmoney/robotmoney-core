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
import { actionsProofReason, proofLogFields, type ActionsProof } from "./actions-proof.ts";
import type { DeploymentKind } from "./chains.ts";
import { countFor, sumCounts, checkNonce, effectiveCounts, type AdoptedTxs, type FrozenCounts } from "./counts.ts";
import { CREATE2_FACTORY, buildCreate2Libraries, create2ArtifactsPresent, verifyAdoptedCreate2, verifyAdoptedLibraries, type AdoptedLibrary, type AdoptionRecord } from "./libs-adopt.ts";
import type { Logger } from "./log.ts";
import { adoptableCoreTimelock, assertTimelockPin, predictCoreTimelock, type TimelockPrediction } from "./timelock-pin.ts";
import { DryRunFiles, type ChainStarter } from "./preflight.ts";
import type { PublishSigner } from "./signer.ts";
import { ACTIVE_SYSTEM, DEPLOYER_STAGES, STAGES, expectedStartNonce, getStageTable, proofNoncesBefore, manifestRef, stageByName, type StageRow } from "./stages.ts";
import { PROOF_STAGE, assertControlProven } from "./control-proof.ts";
import { CONSUMED_VAULTS_MANIFESTS, hashConsumedManifests } from "./verify/gateway.ts";
import { LIBS_STAGE, VAULT_KIND, resolveEnv } from "./core-wiring.ts";
import { runCoreConfigCheck, type CoreConfigCheck } from "./core-config-check.ts";
import { configCheck, loadVaultConfiguredAssets } from "./ci/config-check.ts";
import { viemReader } from "./verify/reader.ts";
import type { ChainReader } from "./verify/types.ts";
import { manifestBase, manifestPathFor } from "./stage-table.ts";
import { eligibilityBps, type Address, type Sheet, type UpgradeMode } from "./sheet.ts";
import type { RedeployRecord } from "./redeploy-vault.ts";
import type { ImplementationDeploy } from "./deploy-implementation.ts";
import type { CallerInputs } from "./sheet.ts";
import { isReadOnlyGitAncestry, isReadOnlyGitInputsDiff } from "./tooling-sha.ts";
import { SafeToolError, createSafe, impersonatedSender, connectSafe, readAfterWrite, rpcHost, verifyCreatedSafe, type CreateSafePlan, type SafeManifest, type StaleReadRetry } from "./safe/index.ts";

// ---- spawning: forge, cast and read-only git reads only -----------------------------------------------------------------------------------------

export type Tool = "forge" | "cast" | "git";
export interface SpawnOpts { env: Record<string, string>; cwd?: string; interactive?: boolean }
export interface SpawnResult { code: number; stdout: string; stderr: string }
export type ProcessRunner = (tool: Tool, args: string[], opts: SpawnOpts) => Promise<SpawnResult>;

/**
 * The one allowed git spawn: `git -C DIR status --porcelain [--untracked-files=all] [--ignored] [-- PATH]`, a read of the core checkout
 * or of the frozen counts file (core 1668). Nothing else of git runs.
 */
export const isReadOnlyGitStatus = (args: string[]): boolean => {
  if (!(args.length >= 4 && args[0] === "-C" && args[2] === "status" && args[3] === "--porcelain")) return false;
  const rest = args.slice(4);
  const sep = rest.indexOf("--");
  const flags = sep < 0 ? rest : rest.slice(0, sep);
  const paths = sep < 0 ? [] : rest.slice(sep + 1);
  return flags.every((a) => a === "--untracked-files=all" || a === "--ignored") && paths.length <= 1;
};

/** The real runner. Anything but forge, cast and the read-only git reads (status, and the tooling-sha ancestry and deployed-inputs diff) is refused before a process starts. */
export const spawnTool: ProcessRunner = async (tool, args, opts) => {
  if (tool === "git" && !isReadOnlyGitStatus(args) && !isReadOnlyGitAncestry(args) && !isReadOnlyGitInputsDiff(args)) throw new PublishError("TOOL", `refusing to spawn git ${args.join(" ")}: the only git commands are the read-only 'git -C DIR status --porcelain', 'merge-base --is-ancestor' and the deployed-inputs 'diff --name-only' (tooling-sha.ts)`);
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

// ---- the fee guard ---------------------------------------------------------------------------------------------------------

/**
 * The balance a stage needs before it broadcasts: forge's estimated L2 cost times FEE_GUARD_MULTIPLE, plus 0.0001 ETH for the L1 data fee forge does not price.
 * Deploy 3 (2026-10-18): 3x stopped the 31-transaction recorder stage on 8453 with about 4.5 times the real cost of the whole run in the deployer; 2x is the owner's margin.
 */
export const FEE_GUARD_MULTIPLE = 2;
export const L1_FEE_ALLOWANCE_WEI = 100_000_000_000_000n;
export const feeGuardNeedWei = (estimatedEth: number): bigint => BigInt(Math.ceil(estimatedEth * FEE_GUARD_MULTIPLE * 1e18)) + L1_FEE_ALLOWANCE_WEI;

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
  /** Libs stage (issue 1721): the stage planned zero transactions because the libraries already sit on chain with the build's code. Set only by libs adoption. */
  adopted?: boolean;
  /** With adopted: which libraries, at which addresses and code hashes, and how many transactions this deployer sent for the stage. */
  adoption?: AdoptionRecord;
  /** CREATE2 library addresses (lower case) this stage's own broadcast created. A later stage that finds them deployed did not adopt them: this run made them. */
  created?: string[];
  /** Safe stage: the predicted or created address, recorded before the creation is sent so a resume can adopt it. */
  safe?: string;
  /** First proxy stage (issue 1835): the core timelock address every proxy names and its init code hash, derived from the build. The timelock stage requires the same. */
  timelockPrediction?: TimelockPrediction;
  [k: string]: unknown;
}

export interface RunManifest {
  version: 1;
  /** Issue 1892: the system this run deploys. Absent: a run manifest from before the split, the combined (vaults) run. */
  system?: "vaults" | "gateway";
  /** Issue 1892, the gateway system only: sha256 of each vaults-system manifest the run consumed, taken when the run began. The verifier fails when one changed. */
  consumedVaultsManifests?: Record<string, string>;
  /** Issue 1727: the deployment kind of the run, from the sheet's DEPLOYMENT_KIND. A manifest written before the field existed is a production run. */
  deploymentKind?: DeploymentKind;
  /**
   * Issue 1809: the release mode every proxy of the run is initialized with, from the sheet's UPGRADE_MODE. A run never changes it: a resume under another mode would leave
   * some proxies frozen and others upgradeable. A manifest written before the field existed ran with the interim literal `frozen` (issue 1808).
   */
  upgradeMode?: UpgradeMode;
  /**
   * Issue 1727, rehearsal only: the deployer nonce at the first deployer stage. A rehearsal reuses a deployer that is not at nonce 0, so every nonce check is relative
   * to this value. It is recorded once, before the first transaction, and never rewritten. Production runs never carry it: a fresh deployer starts at 0.
   */
  deployerStartNonce?: number;
  chainId: number;
  coreSha: string;
  deployer: string;
  environment: string;
  startedAt: string;
  firstBlock?: number;
  stages: Record<string, StageRecord>;
  govern?: Record<string, unknown>;
  /** One entry per executed `govern --row apply-receipt` round (issue 1696): the evidence-check `receipt_applications` shape. */
  receipt_applications?: unknown[];
  /** HISTORICAL (issue 1743): the entries of a removed router-vector clear row. No tool writes them since issue 1988; a manifest that holds them keeps them. */
  voted_weights_clears?: unknown[];
  /** One entry per executed `govern --row retire-vault` round (issue 1912). */
  vault_retirements?: unknown[];
  /** QA plan v1 D7: one entry per executed `govern --row set-unwind-guard` round (a basket vault's emergency unwind guard). A record: the verifier reads the guards from the chain. */
  unwind_guards?: unknown[];
  /** Issue 1796: one entry per single-vault redeploy (`redeploy-vault` verb, then govern `--row redeploy-vault`): the deploy transactions, the new and the old vault, the operation and the read-back (the evidence `vault_redeploys` shape). */
  vault_redeploys?: RedeployRecord[];
  /** Issue 1861: one entry per new proxy implementation the `deploy-implementation` verb deployed (step 2 of a governed upgrade), before `govern --row upgrade-proxy` names it. */
  implementation_deploys?: ImplementationDeploy[];
  /** Issue 1888: the registration rounds `govern --row register-submitter` executed, one entry per submitter Safe (the evidence `submitter_registrations` shape). */
  submitter_registrations?: unknown[];
  /** HISTORICAL (issue 1727): the retired `register-committee` rounds. Read from old run manifests only, never written. */
  committee_registrations?: unknown[];
  /** Issue 1727: the receipts `record-receipt` anchored (the evidence `recorded_receipts` shape): id, digest, uri, submitter ADDRESS, transaction. Never a key. */
  recorded_receipts?: unknown[];
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

/** The deployer transactions each ADOPTED stage really sent, from the run manifest (issue 1721). Empty when no stage was adopted. */
export function adoptedTxs(manifest: Pick<RunManifest, "stages">): AdoptedTxs {
  const out: AdoptedTxs = {};
  for (const [name, rec] of Object.entries(manifest.stages)) if (rec.status === "done" && rec.adopted === true && rec.adoption) out[name] = rec.adoption.deployerTxs;
  return out;
}

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
  /** qa-plan B2 (DT-3): the verified GitHub OIDC token of this job, when CONFIRM=environment on 8453 (actions-proof.ts). Undefined: no proof, so no environment confirmation on 8453. */
  actionsProof?: ActionsProof;
  /** Process environment, filtered before it reaches a child. */
  baseEnv: Record<string, string | undefined>;
  /** Injected for tests. Defaults to the real Safe tool. */
  safeApi?: Partial<SafeApi>;
  now?: () => Date;
  /** Dry run: starts the local chain the forge simulations run on: a lazy fork of `rpc`, read only. Absent or returning undefined: simulate against `rpc`. */
  startChain?: ChainStarter;
  /** Injected for tests: the read-only chain reader behind the config-check that runs before each vault stage. Defaults to viem over `rpc`. */
  chainReader?: (rpc: string) => ChainReader;
  /**
   * Injected for tests: how a read that checks what a landed transaction left is read again on a load-balanced RPC (issue 1723, safe/read-after-write.ts; the redeploy
   * verb's reads after its broadcast, QA plan v1 E6). Defaults to the shared bound (STALE_READ_TRIES reads, STALE_READ_DELAY_MS apart).
   */
  readRetry?: StaleReadRetry;
  /**
   * Deploy 3 (2026-10-18): where the verifier sends eth_getLogs and how many blocks per call (--logs-rpc, --logs-window). mainnet.base.org throttled the role
   * scan with HTTP 429 for an hour; the canon's 8453 logs endpoint allows 1000 blocks per call. Absent: every read on --rpc, 2000 blocks per call.
   */
  logs?: { logsRpc?: string; window?: bigint };
  /** --check-sources: the verify stage also checks explorer source verification (Blockscout, Sourcify). Off by default: publishing, not a gate (2026-10-19). */
  checkSources?: boolean;
  /** Injected for tests: core's own config-check (bun scripts/ci/config-check.ts). Defaults to the real spawn. */
  coreConfigCheck?: CoreConfigCheck;
  /** Set by runStages in a dry run: the RPC forge simulates on (a local anvil) and the record of manifest files to restore. */
  simRpc?: string;
  dryFiles?: DryRunFiles;
  /** Issue 1796, verify after a redeploy: the forge out/ of a checkout at the ORIGINAL deployment sha, for the code hashes of the vaults the redeploy did not replace and of the retired one. */
  priorArtifactsDir?: string;
  /** QA plan v1 E1: the HEAD sha of the git checkout that holds `priorArtifactsDir`. The verify stage records it (the stage record and each governed redeploy entry). */
  priorArtifactsSha?: string;
  /**
   * QA plan v1 E1 (DT-2, issue 1796): set only for a run at a single-vault redeploy's sha (`govern --row redeploy-vault`, `verify --prior-out`; redeploy-vault.ts
   * redeployShaRun). It is the sha of the ORIGINAL deployment: the run manifest names it, `coreSha` names the redeploy sha, and runStages accepts that manifest.
   */
  originalSha?: string;
  /** Absolute manifest directory chosen by the caller (env PUBLISH_MANIFEST_DIR). Undefined: deployments/<chainId>/ in the core checkout. */
  manifestOut?: string;
  /** Security round 1 (review-security-033): the absolute counts dir and --counts-require-origin-dev of this run, so a printed resume command names them (govern.ts resumeCommand). */
  countsDir?: string;
  countsRequireOriginDev?: boolean;
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

/** The environment a child process gets: no plaintext signing material, no YES or CONFIRM, no DEPLOYMENT_KIND (the sheet sets it for the stages), plus the RPC and chain id. */
export function childEnv(ctx: Pick<RunContext, "baseEnv" | "rpc" | "chainId">, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.baseEnv)) {
    if (v === undefined) continue;
    if (PLAINTEXT_ENV.includes(k) || /^CHAIN_(SIGNER|FUNDER)_/.test(k) || k === "YES" || k === "CONFIRM") continue;
    if (k === "DEPLOYMENT_KIND") continue; // issue 1727: the kind comes from the sheet only (stageEnv), never from the caller environment
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

/** The RPC host for a message (a URL may carry an API key in its path). Never throws: a message is not where a bad URL is refused. */
export const rpcHostOf = (url: string): string => { try { return rpcHost(url); } catch { return "the RPC"; } };
/** The bound of the reads right after a broadcast (QA plan v1 E6, issue 1723): the run's `readRetry` (a test passes a sleep that does not wait), else the default bound. */
export const readRetryOf = (ctx: RunContext): StaleReadRetry => ctx.readRetry ?? {};

/** Issue 1981: how many reads in a row must show the receipt block, and how many reads the wait may take (one per `delayMs`, 1 s by default). Same rule as scripts/runbook/cast-send.sh. */
export const RECEIPT_BLOCK_READS = 3;
export const RECEIPT_BLOCK_TRIES = 60;

/** A receipt's blockNumber (hex string, decimal string or number) as a number, or undefined when the receipt has none. */
export function receiptBlock(receipt: Record<string, unknown>): number | undefined {
  const b = receipt.blockNumber;
  if (typeof b === "number" && Number.isSafeInteger(b)) return b;
  if (typeof b === "string" && /^(0x[0-9a-f]+|[0-9]+)$/i.test(b.trim())) return Number(b.trim());
  return undefined;
}

/**
 * Issue 1981: a load-balanced RPC (mainnet.base.org) can answer the read after a mined send from a node that has not seen the receipt's block yet: pause-all read
 * depositsPaused false right after its pause was mined, and the next send from the same key took a stale nonce and failed. This waits until `cast block-number`
 * reads at or past `block` on RECEIPT_BLOCK_READS reads in a row. It fails with a TOOL error naming the block after RECEIPT_BLOCK_TRIES reads. The run's `readRetry`
 * gives the sleep and delay (a test passes a sleep that does not wait). A read that errors counts as behind.
 */
export async function waitForReceiptBlock(ctx: RunContext, block: number, what: string): Promise<void> {
  const retry = readRetryOf(ctx);
  const delay = retry.delayMs ?? 1000;
  const sleep = retry.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  let seen = 0;
  let last = "nothing";
  for (let i = 1; i <= RECEIPT_BLOCK_TRIES; i++) {
    let head: number | undefined;
    try {
      const out = await castOut(ctx, ["block-number"]);
      if (/^[0-9]+$/.test(out)) head = Number(out);
      last = out;
    } catch (e) { last = `an error (${(e as Error).message})`; }
    if (head !== undefined && head >= block) {
      if (++seen >= RECEIPT_BLOCK_READS) return;
    } else {
      seen = 0;
      ctx.log.log("warn", "rpc.behind_receipt", { what, receipt_block: block, last, try: i, tries: RECEIPT_BLOCK_TRIES, rpc_host: rpcHostOf(ctx.rpc) });
    }
    if (i < RECEIPT_BLOCK_TRIES) await sleep(delay);
  }
  throw new PublishError("TOOL", `${what} was mined in block ${block}, but RPC ${rpcHostOf(ctx.rpc)} did not read block ${block} on ${RECEIPT_BLOCK_READS} reads in a row within ${RECEIPT_BLOCK_TRIES} reads ${delay} ms apart (last read ${last}). A read now could be stale: read the chain before any retry.`, { receipt_block: block, last, rpc_host: rpcHostOf(ctx.rpc) });
}

/**
 * Issue 1981: the nonce for the next send from `who`, read fresh from the pending block, never below one past the last nonce this run sent from it (`sent`). A
 * lagging node answers the old nonce, the send then fails with an empty error. A read that fails falls back to `sent + 1`, or undefined (cast picks) when nothing was sent.
 */
export async function nextNonce(ctx: RunContext, who: string, sent: number | undefined): Promise<number | undefined> {
  const floor = sent === undefined ? undefined : sent + 1;
  let read: number | undefined;
  try {
    const out = await castOut(ctx, ["nonce", "--block", "pending", who]);
    if (/^[0-9]+$/.test(out)) read = Number(out);
  } catch (e) { ctx.log.log("warn", "rpc.nonce_unread", { who, message: (e as Error).message }); }
  if (read !== undefined && floor !== undefined && read < floor) ctx.log.log("warn", "rpc.stale_nonce", { who, read, used: floor, note: "the RPC answered a nonce below one past the last send from this key: using the higher one" });
  if (read === undefined) return floor;
  return floor === undefined ? read : Math.max(read, floor);
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
    // qa-plan B2 (DT-3): on 8453 the Actions flag is not the proof. The verified OIDC token for this Environment is, and it is checked again
    // here, at every broadcast, so a context built without one (or for another Environment) never confirms a stage on 8453.
    if (isMainnet(ctx.chainId)) {
      const why = actionsProofReason({ githubActions: ctx.githubActions, env: ctx.baseEnv, environment: ctx.environment, proof: ctx.actionsProof });
      if (why) throw new PublishError("FLOOR", `${why} (stage ${stage} on chain ${ctx.chainId}; nothing was sent)`, { stage, chainId: ctx.chainId });
    }
    ctx.log.log("info", "confirm.environment", { stage, environment: ctx.environment, ...(ctx.actionsProof ? { proof: proofLogFields(ctx.actionsProof) } : {}) });
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
  // DEPLOYMENT_KIND (issue 1727) reaches every stage script from the sheet alone: the timelock stage script applies the rehearsal floor only when it reads "rehearsal"
  const e: Record<string, string> = { CHAIN_ID: String(ctx.chainId), DEPLOY_SHA: ctx.coreSha, DEPLOYMENT_KIND: ctx.sheet.kind };
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

export function readTxCount(path: string): { count: number; hashes: string[]; creates: string[]; firstBlock?: number; lastBlock?: number } | undefined {
  if (!existsSync(path)) return undefined;
  const j = JSON.parse(readFileSync(path, "utf8"));
  const txs: unknown[] = Array.isArray(j.transactions) ? j.transactions : [];
  const hashes = txs.map((t) => (t as { hash?: string }).hash).filter((h): h is string => typeof h === "string");
  const rc = Array.isArray(j.receipts) ? j.receipts : [];
  const blocks = rc.map((r: { blockNumber?: string }) => (r.blockNumber ? Number(BigInt(r.blockNumber)) : NaN)).filter((n: number) => Number.isFinite(n));
  const creates = txs.filter((t) => (t as { transactionType?: string }).transactionType === "CREATE2").map((t) => String((t as { contractAddress?: string }).contractAddress ?? "").toLowerCase()).filter(Boolean);
  return { count: txs.length, hashes, creates, firstBlock: blocks.length ? Math.min(...blocks) : undefined, lastBlock: blocks.length ? Math.max(...blocks) : undefined };
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
 * stage fails on any failed row. A vault with no configured assets (rmUSDC holds no basket assets) has nothing to check.
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

/**
 * The libs stage planned zero transactions (issue 1721). It is ADOPTED only when every library of the stage sits at the address the build predicts
 * (CREATE2 factory, salt 0, creation code) AND holds exactly the build's runtime code (keccak256 compared). Anything else is LIBS_ADOPTION and nothing is sent.
 * The deployer nonce must still sit where the stage started (0 transactions sent by this deployer: a Twin fork) or have moved by the whole frozen count
 * (the deployer's own transaction already landed: a resume). Any other movement is a stray transaction (NONCE). The record keeps the transactions this
 * deployer really sent as `adopted.deployerTxs`: the nonce expectations of every later check count that number, not the frozen count.
 * No dry-run file, no transaction count and no broadcast: none of the three exist for a stage that sent nothing.
 */
async function adoptLibsStage(ctx: RunContext, row: StageRow, manifest: RunManifest, rec: StageRecord, deployer: string, outPath: string, expectedCount: number | undefined, simStdout: string): Promise<void> {
  if (!existsSync(outPath) || readFileSync(outPath, "utf8").trim() === "") throw new PublishError("LIBS_ADOPTION", `libs adoption: the simulation of ${row.name} planned zero transactions and wrote no manifest ${outPath}, so no library address is known. Nothing was sent. forge: ${forgeFailureTail(simStdout, "", outputSecrets(ctx))}`, { stage: row.name });
  let libs: Record<string, unknown>;
  try { libs = JSON.parse(readFileSync(outPath, "utf8")); } catch (e) { throw new PublishError("LIBS_ADOPTION", `libs adoption: ${outPath} is not valid JSON (${(e as Error).message}). Nothing was sent.`, { stage: row.name }); }
  const libraries = await verifyAdoptedLibraries({ libraries: getStageTable().libraries, manifest: libs, outDir: join(ctx.coreDir, "out"), getCode: async (a) => castOut(ctx, ["code", a]) });
  const nonce = await deployerNonce(ctx, deployer);
  const sent = nonce - rec.startNonce!;
  const allowed = expectedCount === undefined ? [0] : [0, expectedCount];
  if (!allowed.includes(sent)) throw new PublishError("NONCE", `libs adoption: the deployer nonce moved by ${sent} since the stage started (${rec.startNonce} to ${nonce}), a libs stage that sent nothing allows ${allowed.join(" or ")}. A stray or partial transaction? Nothing was sent.`, { stage: row.name, sent, start: rec.startNonce, nonce });
  rec.adopted = true;
  rec.adoption = { libraries, factory: CREATE2_FACTORY, deployerTxs: sent };
  rec.dryRunCount = 0;
  rec.endNonce = nonce;
  rec.count = expectedCount ?? sent;
  rec.status = "done";
  rec.finishedAt = (ctx.now?.() ?? new Date()).toISOString();
  if (ctx.dryCounts) ctx.dryCounts[row.countKey!] = 0;
  ctx.log.log("info", "stage.libs_adopted", { stage: row.name, libraries: libraries.map((l) => ({ name: l.name, address: l.address, code_hash: l.codeHash })), deployer_txs: sent, expected_count: expectedCount ?? null, note: "zero transactions planned: the libraries already hold the build's runtime code" });
  if (ctx.dryRun) return; // a dry run never persists the run manifest; the libs manifest the simulation wrote stays for the later stages
  manifest.stages[row.name] = rec;
  saveRunManifest(ctx.evidenceDir, manifest);
  ctx.log.log("info", "stage.done", { stage: row.name, start_nonce: rec.startNonce, end_nonce: nonce, count: rec.count, adopted: true });
}

/** CREATE2 libraries created, or already adopted, by stages of THIS run before the current one (persisted `created` and `adoption`, plus the simulations of a dry run, which never persist). */
const createdInDryRun = new WeakMap<object, Set<string>>();
const createdEarlier = (manifest: RunManifest): Set<string> => new Set([...Object.values(manifest.stages).flatMap((r) => [...(r.created ?? []), ...(r.adoption?.libraries ?? []).map((l) => l.address.toLowerCase())]), ...(createdInDryRun.get(manifest) ?? [])]);

/**
 * Libraries forge deploys by itself inside this stage (issue 1721: BasketAssetConfigGuard, TwapTickMath, BasketViews inside the first basket stage). When one already
 * sits on chain forge leaves its creation out of the stage's transactions. This finds those, and only those that this run did not create itself, and proves each is the
 * build's library (address = CREATE2 of the resolved build, runtime code hash equal). Returns the adopted libraries (none: the stage is the normal path).
 * Frozen counts: evaluated only when the simulation plans fewer transactions than the frozen count (the normal path reads nothing), and the shortfall must be EXACTLY the
 * number of adopted libraries, else the usual COUNT_MISMATCH. Measuring: evaluated always, the measured count is then the reduced one and the counts file is marked.
 */
async function adoptCreate2Libraries(ctx: RunContext, row: StageRow, manifest: RunManifest, dry: { count: number; creates: string[] }, expectedCount: number | undefined): Promise<AdoptedLibrary[]> {
  if (row.create2Libraries.length === 0) return [];
  if (expectedCount !== undefined && dry.count >= expectedCount) return [];
  const all = getStageTable().create2Libraries ?? [];
  const outDir = join(ctx.coreDir, "out");
  if (!create2ArtifactsPresent(all, outDir)) { ctx.log.log("warn", "stage.create2_not_evaluated", { stage: row.name, reason: `no build artifacts under ${outDir}` }); return []; }
  const built = buildCreate2Libraries(all, outDir);
  const planned = new Set(dry.creates), earlier = createdEarlier(manifest);
  const absent = row.create2Libraries.map((l) => built.get(l.artifact)!).filter((b) => !planned.has(b.address.toLowerCase()) && !earlier.has(b.address.toLowerCase()));
  if (absent.length === 0) return [];
  const libs = await verifyAdoptedCreate2({ adopted: absent, getCode: async (a) => castOut(ctx, ["code", a]) });
  if (expectedCount !== undefined && dry.count !== expectedCount - libs.length) throw new PublishError("COUNT_MISMATCH", `stage ${row.name}: the dry-run sends ${dry.count} transactions, the frozen count is ${expectedCount} and ${libs.length} adopted librar${libs.length === 1 ? "y" : "ies"} (${libs.map((l) => l.name).join(", ")}) explain only ${libs.length} of the ${expectedCount - dry.count} missing. Nothing was sent.`, { stage: row.name, dry: dry.count, frozen: expectedCount, adopted: libs.length });
  return libs;
}

/** The first stage of the table that deploys proxies: it pins the core timelock prediction (issue 1835). */
const firstProxyStage = (): string | undefined => getStageTable().stages.find((s) => (s.proxies?.length ?? 0) > 0 && s.upgradeTimelockEnv === undefined)?.name;
/** Pins of a dry run, which never persists the run manifest. */
const dryRunPins = new WeakMap<object, TimelockPrediction>();
/** The pin of this run: the first proxy stage's record (`rec` while that stage runs), or a dry run's. */
const timelockPinOf = (manifest: RunManifest, rec?: StageRecord): TimelockPrediction | undefined => rec?.timelockPrediction ?? manifest.stages[firstProxyStage() ?? ""]?.timelockPrediction ?? dryRunPins.get(manifest);

/** The stages of the table that deploy proxies (issue 1853: every one checks the pin before it broadcasts). */
const isProxyStage = (name: string): boolean => { const s = getStageTable().stages.find((x) => x.name === name); return (s?.proxies?.length ?? 0) > 0 && s?.upgradeTimelockEnv === undefined; }; // issue 1892: a stage with an explicit upgrade timelock is not pinned to the core timelock

/**
 * Issue 1835, 1853. The first proxy stage pins the core timelock prediction (address and init code hash, from the build, the Safe and TIMELOCK_MIN_DELAY) in its run
 * manifest record. Every later proxy stage and the timelock stage recompute it after their simulation and refuse a difference before anything is sent (MANIFEST): a
 * toolchain, SAFE_ADDRESS or TIMELOCK_MIN_DELAY change between two proxy stages would otherwise put proxies on chain that name another timelock (split upgrade
 * authority, a redeploy). proxyManifestCheck stays the post-broadcast backstop. A run manifest from an earlier release has no pin: backfillTimelockPin. A resumed
 * first proxy stage whose earlier attempt (an earlier release) landed transactions and recorded no pin is refused, never pinned silently to this build.
 * Returns the recomputed prediction for the timelock stage.
 */
async function timelockPinStep(ctx: RunContext, row: StageRow, manifest: RunManifest, rec: StageRecord, prior: StageRecord | undefined, env: Record<string, string>, resuming: boolean): Promise<ReturnType<typeof predictCoreTimelock> | undefined> {
  const u = getStageTable().upgradeAuthority, first = firstProxyStage();
  if (!u || !first || (!isProxyStage(row.name) && row.name !== u.stage)) return undefined;
  const now = predictCoreTimelock(u, join(ctx.coreDir, "out"), env.SAFE_ADDRESS as Address, BigInt(env.TIMELOCK_MIN_DELAY!));
  const { runtimeHash: _, ...pin } = now;
  if (row.name === first) {
    if (prior?.timelockPrediction) assertTimelockPin(row.name, first, prior.timelockPrediction, pin);
    else if (resuming) throw new PublishError("MANIFEST", `stage ${row.name}: an earlier attempt of this stage, started by an earlier release of publish-contracts, already landed transactions and recorded no core timelock pin, so this build cannot show that its proxies name the timelock this build deploys. Finish stage ${row.name} with --resume and the release of publish-contracts that started it. The next proxy stage then backfills the pin from the ${row.name} manifest and the chain. Nothing was sent.`, { stage: row.name });
    rec.timelockPrediction = prior?.timelockPrediction ?? pin;
    if (ctx.dryRun) dryRunPins.set(manifest, rec.timelockPrediction);
    ctx.log.log("info", "stage.timelock_pinned", { stage: row.name, timelock: rec.timelockPrediction.address, init_code_hash: rec.timelockPrediction.initCodeHash });
    return undefined;
  }
  assertTimelockPin(row.name, first, timelockPinOf(manifest) ?? await backfillTimelockPin(ctx, row, manifest, first, pin), pin);
  ctx.log.log("info", "stage.timelock_pin_ok", { stage: row.name, timelock: pin.address, init_code_hash: pin.initCodeHash });
  return row.name === u.stage ? now : undefined;
}

/**
 * Issue 1853, 1866. A run manifest from a release before 1835 has a done first proxy stage and no pin. The pin is backfilled only when these sources all name one
 * timelock: the first proxy stage's manifest upgrade_timelock, upgradeTimelock() on chain of every proxy of that stage, the manifest upgrade_timelock of every other
 * done proxy stage with one on-chain upgradeTimelock() read per such stage (they ran with no pin check), and the prediction this build recomputes. Anything else is
 * MANIFEST, nothing sent, with a remedy that can work (the runner never reruns a stage whose manifest exists, so "run that stage again" is not one).
 */
async function backfillTimelockPin(ctx: RunContext, row: StageRow, manifest: RunManifest, first: string, pin: TimelockPrediction): Promise<TimelockPrediction | undefined> {
  const refuse = (why: string, remedy: string): never => {
    throw new PublishError("MANIFEST", `stage ${row.name}: the run manifest has no core timelock pin from stage ${first} (an earlier release of publish-contracts ran it), and it cannot be backfilled: ${why}. ${remedy} Nothing was sent.`, { stage: row.name, pinnedBy: first, recomputed: pin.address });
  };
  if (manifest.stages[first]?.status !== "done") return undefined; // assertTimelockPin names the missing pin
  const A = /^0x[0-9a-fA-F]{40}$/;
  /** A done proxy stage's manifest: its upgrade_timelock and the proxies to read on chain (every proxy of the first stage, the first proxy of any other). */
  const read = (stage: string, all: boolean) => {
    const path = manifestFilePath(ctx, stageByName(stage).manifest!);
    let m: Record<string, unknown>;
    try { m = JSON.parse(readFileSync(path, "utf8")); } catch { return refuse(`the manifest ${path} of stage ${stage} is missing or not JSON`, `Restore the manifest stage ${stage} wrote, then run this stage again.`); }
    const fields = getStageTable().stages.find((s) => s.name === stage)!.proxies!.map((p) => p.field).slice(0, all ? undefined : 1);
    const recorded = String(m.upgrade_timelock ?? ""), proxies = fields.map((f) => [f, String(m[f] ?? "")] as const);
    if (!A.test(recorded) || proxies.some(([, a]) => !A.test(a))) return refuse(`the manifest ${path} names no upgrade_timelock or ${fields.join(", ")} address`, `Restore the manifest stage ${stage} wrote, then run this stage again.`);
    return { stage, recorded, proxies };
  };
  const firstRead = read(first, true), recorded = firstRead.recorded;
  const others = Object.entries(manifest.stages).filter(([n, r]) => n !== first && r?.status === "done" && isProxyStage(n)).map(([n]) => read(n, false));
  for (const o of others) if (o.recorded.toLowerCase() !== recorded.toLowerCase()) refuse(`the manifest of stage ${o.stage} records upgrade_timelock ${o.recorded}, the ${first} manifest records ${recorded}`, "Stop and read the chain before anything else runs.");
  const onChain: Record<string, string> = {};
  for (const r of [firstRead, ...others]) for (const [field, proxy] of r.proxies) {
    const got = (await castOut(ctx, ["call", proxy, "upgradeTimelock()(address)"])).trim();
    onChain[`${r.stage}.${field}`] = got;
    if (got.toLowerCase() !== recorded.toLowerCase()) refuse(`the ${r.stage} ${field} proxy ${proxy} reads upgradeTimelock() ${got} on chain, the ${first} manifest records ${recorded}`, "Stop and read the chain before anything else runs.");
  }
  if (recorded.toLowerCase() !== pin.address.toLowerCase()) return refuse(`the ${first} proxies name the timelock ${recorded}, this build predicts ${pin.address} (init code hash ${pin.initCodeHash}, Safe ${pin.safe}, delay ${pin.minDelay})`, `Rebuild core with the toolchain, SAFE_ADDRESS and TIMELOCK_MIN_DELAY stage ${first} ran with, so the recomputed prediction is ${recorded}, then run this stage again.`);
  if (ctx.dryRun) dryRunPins.set(manifest, pin);
  else { manifest.stages[first]!.timelockPrediction = pin; saveRunManifest(ctx.evidenceDir, manifest); }
  ctx.log.log("info", "stage.timelock_pin_backfilled", { stage: row.name, pinned_by: first, timelock: pin.address, init_code_hash: pin.initCodeHash, proxy: firstRead.proxies[0]![1], on_chain: onChain[`${first}.${firstRead.proxies[0]![0]}`], checked: onChain });
  return pin;
}

/**
 * Issue 1835. The timelock stage found the TimelockController already at the predicted address (anyone can deploy it there once the proxies are on chain), so the
 * stage script reuses it and plans one transaction fewer. Evaluated only on a shortfall (or when measuring), like the CREATE2 libraries: the code there must hash to
 * the build's TimelockController runtime code. Anything else adopts nothing, and the shortfall is the usual COUNT_MISMATCH.
 */
async function adoptCoreTimelock(ctx: RunContext, row: StageRow, dry: { count: number }, expectedCount: number | undefined, p: ReturnType<typeof predictCoreTimelock> | undefined): Promise<AdoptedLibrary[]> {
  if (!p || (expectedCount !== undefined && dry.count >= expectedCount)) return [];
  const contract = getStageTable().upgradeAuthority!.contract;
  const adopted = await adoptableCoreTimelock(contract, p, async (a) => castOut(ctx, ["code", a]));
  ctx.log.log(adopted.length ? "info" : "warn", adopted.length ? "stage.timelock_adopted" : "stage.timelock_not_adopted", { stage: row.name, timelock: p.address, runtime_hash: p.runtimeHash, code_hash: adopted[0]?.codeHash ?? null, dry_run_count: dry.count, expected_count: expectedCount ?? null });
  return adopted;
}

async function runForgeStage(ctx: RunContext, row: StageRow, manifest: RunManifest): Promise<void> {
  await controlProofGate(ctx, row, manifest);
  await vaultConfigGate(ctx, row);
  const script = row.script!;
  const env = stageEnv(ctx, row);
  const real = ctx;
  if (ctx.simRpc) ctx = { ...ctx, rpc: ctx.simRpc }; // a dry run simulates on the local chain: nonces, balances and forge all read it
  const deployer = await ctx.signer.address();
  if (deployer.toLowerCase() !== ctx.sheet.admin.toLowerCase()) throw new PublishError("SIGNER", `the signer ${deployer} is not ADMIN_ADDRESS ${ctx.sheet.admin}`);
  const counts = ctx.frozen;
  const expectedCount = counts ? countFor(counts, row.countKey!) : undefined;
  if (!counts && !ctx.measure) throw new PublishError("COUNTS_MISSING", "no frozen counts and not measuring");
  const prior = manifest.stages[row.name];

  // start nonce: exactly where the frozen counts say. Measure mode learns the start from earlier records.
  const nonce0 = await deployerNonce(ctx, deployer);
  const adoptedBefore = adoptedTxs(manifest);
  const startBase = runStartNonce(ctx, manifest, row, nonce0);
  const wantStart = counts ? expectedStartNonce(row.name, effectiveCounts(counts, adoptedBefore), startBase) : startBase + DEPLOYER_STAGES.slice(0, DEPLOYER_STAGES.findIndex((s) => s.name === row.name)).reduce((a, s) => a + (s.name in adoptedBefore ? adoptedBefore[s.name]! : (manifest.stages[s.name]?.count ?? 0)), 0) + proofNoncesBefore(row.name);
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
  let sim: Awaited<ReturnType<RunContext["run"]>>, dry: NonNullable<ReturnType<typeof readTxCount>>, adoptedLibs: AdoptedLibrary[];
  // Deploy 3 (2026-10-18): a resumed stage keeps the manifest its own broadcast wrote. The simulation below rewrites outPath with the addresses of the CURRENT
  // nonce, and `forge script --resume` never runs the script again, so without this a stage whose transactions all landed lost its manifest.
  const kept = resuming && existsSync(outPath) ? readFileSync(outPath, "utf8") : undefined;
  const restoreKept = () => { if (kept !== undefined) writeFileSync(outPath, kept); };
  // Issue 1866: the simulation writes the stage manifest (outPath). Any refusal or error from here to the broadcast removes it again on a fresh, real run (outPath did not
  // exist before: checked above), so fixing the cause and running the same command again works. A resumed stage keeps its manifest; a dry run restores it in runStages.
  try {
    sim = await ctx.run("forge", base, { env: fenv, cwd: ctx.coreDir, interactive: true });
    // Issue 1721: forge exits 0 and prints no SIMULATION COMPLETE when it plans zero transactions. For the libs stage that means the libraries are already on chain.
    if (row.name === LIBS_STAGE && sim.code === 0 && !sim.stdout.includes("SIMULATION COMPLETE") && !((readTxCount(broadcastFile(ctx, script, true))?.count ?? 0) > 0)) {
      await adoptLibsStage(ctx, row, manifest, rec, deployer, outPath, expectedCount, sim.stdout);
      return;
    }
    if (sim.code !== 0 || !sim.stdout.includes("SIMULATION COMPLETE")) {
      throw new PublishError("SIMULATION", `simulation of ${row.name} failed (exit ${sim.code}). Nothing was sent. ${forgeFailureTail(sim.stdout, sim.stderr, outputSecrets(ctx))}`, { stage: row.name });
    }
    const read = readTxCount(broadcastFile(ctx, script, true));
    if (!read) throw new PublishError("SIMULATION", `the simulation of ${row.name} wrote no dry-run file`, { stage: row.name });
    dry = read;
    rec.dryRunCount = dry.count;
    if (ctx.dryCounts) ctx.dryCounts[row.countKey!] = dry.count;
    const pinned = await timelockPinStep(ctx, row, manifest, rec, prior, env, resuming);
    adoptedLibs = [...await adoptCreate2Libraries(ctx, row, manifest, dry, expectedCount), ...await adoptCoreTimelock(ctx, row, dry, expectedCount, pinned)];
    const wantCount = expectedCount === undefined ? undefined : expectedCount - adoptedLibs.length; // the transactions this stage sends: the frozen count less the adopted creations
    ctx.log.log("info", "stage.simulated", { stage: row.name, dry_run_count: dry.count, expected_count: expectedCount ?? null, ...(adoptedLibs.length ? { adopted_create2: adoptedLibs.map((l) => ({ name: l.name, address: l.address, code_hash: l.codeHash })) } : {}) });
    if (wantCount !== undefined && dry.count !== wantCount) throw new PublishError("COUNT_MISMATCH", `stage ${row.name}: the dry-run sends ${dry.count} transactions, the frozen count is ${expectedCount}. Nothing was sent.`, { stage: row.name, dry: dry.count, frozen: expectedCount });
    if (ctx.dryRun) {
      // The simulation wrote the manifest. It stays for the later stages of this dry run (their inputs); runStages restores the checkout at the end.
      // On the local chain the stage is then APPLIED to it, so the later stages find the contracts this one deployed (a registry stage
      // reads VAULT_ADDRESS code). That sends to the local anvil only (the sender is impersonated there), never to the target RPC.
      createdInDryRun.set(manifest, new Set([...(createdInDryRun.get(manifest) ?? []), ...dry.creates, ...adoptedLibs.map((l) => l.address.toLowerCase())]));
      if (real.simRpc) await applyToSimulationChain(ctx, row, base, fenv, deployer, outPath, dry.count);
      ctx.log.log("info", "stage.dry_run_done", { stage: row.name, dry_run_count: dry.count, simulated_on: real.simRpc ? "local-anvil" : "target-rpc" });
      return;
    }
  } catch (e) {
    if (!resuming && !ctx.dryRun) rmSync(outPath, { force: true });
    restoreKept();
    throw e;
  }
  // a simulation also writes the manifest; the real run rewrites it, and a resumed one keeps the manifest of the broadcast it resumes
  if (kept !== undefined) restoreKept(); else rmSync(outPath, { force: true });

  // fee guard: forge prices L2 execution only, so allow FEE_GUARD_MULTIPLE times it plus 0.0001 ETH for the L1 data fee
  const est = estimatedEthFrom(sim.stdout);
  if (est !== undefined) {
    const need = feeGuardNeedWei(est);
    const bal = BigInt(await castOut(ctx, ["balance", deployer]));
    if (bal < need) throw new PublishError("SIMULATION", `the deployer balance ${bal} wei is below ${need} wei (${FEE_GUARD_MULTIPLE}x the simulated cost plus the L1 allowance). Fund it.`, { stage: row.name });
  }

  manifest.stages[row.name] = rec;
  saveRunManifest(ctx.evidenceDir, manifest);
  await confirmStage(ctx, row.name, `${row.name}: ${dry.count} transactions from ${deployer}`);

  ctx.log.log("info", "stage.broadcast", { stage: row.name, resume: resuming });
  const run = await ctx.run("forge", [...base, "--broadcast", ...(resuming ? ["--resume"] : [])], { env: fenv, cwd: ctx.coreDir, interactive: true });
  let nonce1 = await deployerNonce(ctx, deployer);
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
  // QA plan v1 E6, as the redeploy round does (redeploy-vault.ts): forge saw every receipt, but a load-balanced RPC may answer `cast nonce` from a node behind the
  // last block (Deploy 3: libs and recorder on mainnet.base.org). Read again, bounded, until the nonce shows the broadcast; a nonce above it is returned at once.
  if (nonce1 < startNonce + sent.count) {
    const target = startNonce + sent.count;
    try {
      nonce1 = await readAfterWrite({
        what: `the deployer ${deployer} nonce after ${row.name}`, expected: String(target), rpcUrl: ctx.rpc, read: () => deployerNonce(ctx, deployer),
        judge: (n) => (n === target ? "fresh" : n < target ? "stale" : "wrong"), logger: ctx.log,
      }, readRetryOf(ctx));
    } catch (e) {
      if (!(e instanceof SafeToolError) || e.code !== "STALE_READ_TIMEOUT") throw e;
      throw new PublishError("COUNT_MISMATCH", `stage ${row.name}: broadcast count ${sent.count}, and the deployer nonce never showed ${target} (RPC ${rpcHostOf(ctx.rpc)}): ${e.message} The chain has changed or the RPC is behind: stop and read it, then continue with --resume.`, { stage: row.name, broadcast: sent.count, expected_nonce: target, last: e.details.last });
    }
  }
  rec.broadcastCount = sent.count;
  rec.txHashes = sent.hashes;
  rec.firstBlock = sent.firstBlock;
  rec.lastBlock = sent.lastBlock;
  rec.endNonce = nonce1;
  const delta = nonce1 - startNonce;
  // the count checks that make the broadcast trustworthy: broadcast file, nonce delta and the frozen count all agree
  rec.created = sent.creates;
  if (adoptedLibs.length > 0) {
    // adopted creations: this deployer sent exactly what the simulation planned. A resume adds what an earlier attempt of this stage had landed: then between (frozen - adopted) and the frozen count. Forge's file always agrees with the nonce.
    const lo = resuming ? (expectedCount ?? sent.count) - adoptedLibs.length : dry.count, hi = resuming ? (expectedCount ?? sent.count) : dry.count;
    if (delta < lo || delta > hi || sent.count !== delta) throw new PublishError("COUNT_MISMATCH", `stage ${row.name}: broadcast count ${sent.count}, nonce delta ${delta}, adopted stage allows ${lo} to ${hi} deployer transactions (frozen count ${expectedCount ?? "none"} less up to ${adoptedLibs.length} adopted). The chain has changed: stop and read it.`, { stage: row.name, broadcast: sent.count, delta, lo, hi });
    rec.adopted = true;
    rec.adoption = { libraries: adoptedLibs, factory: CREATE2_FACTORY, deployerTxs: delta };
  } else if (expectedCount !== undefined && (sent.count !== expectedCount || delta !== expectedCount)) {
    throw new PublishError("COUNT_MISMATCH", `stage ${row.name}: broadcast count ${sent.count}, nonce delta ${delta}, frozen count ${expectedCount}. The chain has changed: stop and read it.`, { stage: row.name, broadcast: sent.count, delta, frozen: expectedCount });
  }
  if (expectedCount === undefined && adoptedLibs.length === 0 && sent.count !== delta) throw new PublishError("COUNT_MISMATCH", `stage ${row.name}: broadcast count ${sent.count} differs from the nonce delta ${delta}`, { stage: row.name });
  rec.count = expectedCount ?? sent.count;
  if (!existsSync(outPath) || readFileSync(outPath, "utf8").trim() === "") throw new PublishError("MANIFEST", `manifest ${outPath} was not written by ${row.name}`, { stage: row.name });
  const explicitTl = getStageTable().stages.find((s) => s.name === row.name)?.upgradeTimelockEnv; // issue 1892: the gateway names the sheet's explicit timelock, never the core timelock
  proxyManifestCheck(ctx, row, outPath, explicitTl ? env[explicitTl] : timelockPinOf(manifest, rec)?.address);
  if (sent.firstBlock !== undefined && (manifest.firstBlock === undefined || sent.firstBlock < manifest.firstBlock)) manifest.firstBlock = sent.firstBlock;
  rec.status = "done";
  rec.finishedAt = (ctx.now?.() ?? new Date()).toISOString();
  manifest.stages[row.name] = rec;
  saveRunManifest(ctx.evidenceDir, manifest);
  ctx.log.log("info", "stage.done", { stage: row.name, start_nonce: startNonce, end_nonce: nonce1, count: rec.count });
}

/**
 * Issue 1809: after a stage that deploys proxies (a fresh broadcast or a `forge --resume` that finished a partial one), its manifest must name every proxy and its implementation,
 * the upgrade authority, and the sheet's release mode. A stage that came back in another mode or without the addresses is not a state a later stage may build on: the stage stays
 * `started` and the run stops (MANIFEST). The verifier then proves the same facts on chain.
 */
export function proxyManifestCheck(ctx: Pick<RunContext, "sheet">, row: Pick<StageRow, "name">, outPath: string, pinnedTimelock?: string): void {
  const proxies = getStageTable().stages.find((s) => s.name === row.name)?.proxies ?? [];
  if (proxies.length === 0 || !ctx.sheet.upgrade) return;
  let m: Record<string, unknown>;
  try { m = JSON.parse(readFileSync(outPath, "utf8")); } catch (e) { throw new PublishError("MANIFEST", `manifest ${outPath} of ${row.name} is not valid JSON: ${(e as Error).message}`, { stage: row.name }); }
  const A = /^0x[0-9a-fA-F]{40}$/;
  const problems: string[] = [];
  for (const p of proxies) for (const f of [p.field, p.implementationField]) if (typeof m[f] !== "string" || !A.test(m[f] as string) || /^0x0{40}$/.test(m[f] as string)) problems.push(`${f} is not an address`);
  if (typeof m.upgrade_timelock !== "string" || !A.test(m.upgrade_timelock)) problems.push("upgrade_timelock is not an address");
  else if (pinnedTimelock && m.upgrade_timelock.toLowerCase() !== pinnedTimelock.toLowerCase()) problems.push(`upgrade_timelock is ${m.upgrade_timelock}, the core timelock this run pinned from the build is ${pinnedTimelock}`);
  if (m.upgrade_mode !== ctx.sheet.upgrade.mode) problems.push(`upgrade_mode is ${String(m.upgrade_mode)}, the sheet's UPGRADE_MODE is ${ctx.sheet.upgrade.mode}`);
  if (problems.length) throw new PublishError("MANIFEST", `stage ${row.name}: its proxy manifest ${outPath} is not the release the sheet declares: ${problems.join("; ")}. Stop and read the chain before anything else runs.`, { stage: row.name, problems });
}

/**
 * Issue 1727, rehearsal only. The deployer start nonce the nonce checks are relative to. Production returns 0 without reading anything: a fresh deployer, absolute counts.
 * A rehearsal records the live nonce in the run manifest at the FIRST deployer stage, before any transaction, and reads it back from the manifest ever after. The recorded
 * value is never rewritten: a resume cross-checks it against the first stage's own record and, before any stage has started, against the chain.
 */
export function runStartNonce(ctx: Pick<RunContext, "sheet" | "dryRun" | "evidenceDir" | "log">, manifest: RunManifest, row: Pick<StageRow, "name">, nonce0: number): number {
  if (ctx.sheet.kind !== "rehearsal" && ACTIVE_SYSTEM !== "gateway") return 0; // issue 1892: the gateway run follows the vaults run with the same deployer, so its start nonce is recorded too
  const first = DEPLOYER_STAGES[0]!.name;
  const recorded = manifest.deployerStartNonce;
  if (recorded === undefined) {
    if (row.name !== first || Object.keys(manifest.stages).some((n) => manifest.stages[n]?.startNonce !== undefined)) {
      throw new PublishError("NONCE", `the rehearsal run manifest has no deployerStartNonce and stage ${row.name} is not the first deployer stage (${first}) of a fresh run: the start nonce is recorded once, at the first stage, before any transaction. Use the run's own evidence directory with --resume, or start a new run from stage ${first}.`, { stage: row.name });
    }
    manifest.deployerStartNonce = nonce0;
    if (ctx.sheet.kind === "rehearsal") manifest.deploymentKind = "rehearsal";
    if (!ctx.dryRun) saveRunManifest(ctx.evidenceDir, manifest);
    ctx.log.log("info", "run.start_nonce_recorded", { deployer_start_nonce: nonce0, deployment_kind: ctx.sheet.kind });
    return nonce0;
  }
  if (!Number.isInteger(recorded) || recorded < 0) throw new PublishError("MANIFEST", `the run manifest deployerStartNonce '${String(recorded)}' is not a non-negative integer`);
  const firstRec = manifest.stages[first];
  if (firstRec?.startNonce !== undefined && firstRec.startNonce !== recorded) {
    throw new PublishError("NONCE", `the recorded start nonce ${recorded} differs from the start nonce ${firstRec.startNonce} of stage ${first} in the same run manifest: the recorded start is never rewritten`, { recorded, stage: first, stageStart: firstRec.startNonce });
  }
  // A dry run saves no stage record, and its nonce is the local simulation chain's, moved by the stages it applied there (the Safe first). Each stage
  // still checks that nonce against the frozen counts from the recorded start (expectedStartNonce).
  if (firstRec === undefined && nonce0 !== recorded && !ctx.dryRun) {
    throw new PublishError("NONCE", `the deployer nonce is ${nonce0}, the run manifest recorded start nonce ${recorded} and no stage has started: a transaction left the deployer since the start was recorded`, { nonce: nonce0, recorded });
  }
  return recorded;
}

/** The start nonce a finished rehearsal run is measured from: the manifest's record. A rehearsal manifest without one is refused. Production: 0. */
export function recordedStartNonce(kind: DeploymentKind, manifest: Pick<RunManifest, "deployerStartNonce">): number {
  if (kind !== "rehearsal" && ACTIVE_SYSTEM !== "gateway") return 0;
  if (!Number.isInteger(manifest.deployerStartNonce)) throw new PublishError("MANIFEST", "the rehearsal run manifest has no deployerStartNonce: the deployer nonce cannot be checked relative to the start");
  return manifest.deployerStartNonce!;
}

/**
 * Issue 1727, rehearsal only. The Safe predicted from the sheet's owners, threshold and SAFE_SALT_NONCE must not already hold code: the rehearsal reuses the first
 * rehearsal's owners, and an unchanged salt predicts the Safe that is already there. The only exception is the resume of THIS run, whose manifest recorded the same address.
 */
export async function assertFreshSafeAddress(ctx: RunContext, prior: StageRecord | undefined, predicted: string): Promise<void> {
  if (ctx.sheet.kind !== "rehearsal") return;
  if (ctx.resume && prior?.safe && prior.safe.toLowerCase() === predicted.toLowerCase()) return;
  const code = (await castOut(ctx, ["code", predicted])).trim();
  if (code !== "" && code !== "0x") {
    throw new PublishError("SAFE", `SAFE_SALT_NONCE_REUSED: the Safe predicted at ${predicted} from the sheet's SAFE_OWNERS, SAFE_THRESHOLD and SAFE_SALT_NONCE already holds code on chain ${ctx.chainId}. A rehearsal must create a NEW Safe: change SAFE_SALT_NONCE in the sheet to a value no earlier run used. (Only a --resume of the same run, whose manifest recorded this address, adopts an existing Safe.)`, { predicted });
  }
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
  const startBase = runStartNonce(ctx, manifest, row, nonce0);
  const wantStart = counts ? expectedStartNonce("safe", counts, startBase) : startBase;
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
      await assertFreshSafeAddress(ctx, prior, plan.predictedAddress);
      // Security round 1 (review-security-042, as QA plan v1 E2 did for the redeploy): confirm FIRST. A refused confirmation sends nothing, so it must leave no `started`
      // record: a saved predicted address sent every --resume into the adoption of a Safe that was never created (NOT_A_SAFE). Once confirmed, the predicted address is
      // recorded BEFORE anything is sent, so a creation that dies after the send is adopted by --resume.
      await confirmStage(ctx, "safe", `a ${plan.threshold}-of-${plan.owners.length} Safe v${plan.version} at ${plan.predictedAddress}`);
      rec.safe = plan.predictedAddress;
      manifest.stages.safe = rec;
      saveRunManifest(ctx.evidenceDir, manifest);
      return true;
    },
  });
  if (ctx.dryRun || !res.created || !res.manifest) {
    if (ctx.dryRun) {
      await assertFreshSafeAddress(ctx, prior, res.plan.predictedAddress);
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

/**
 * Issue 1892: the vaults system manifests a gateway run consumes, hashed when the run begins. All of them must exist (the gateway binds the vaults system's router and vault and links
 * its libraries): a gateway run before a vaults run is refused here, before any signer or broadcast. The verifier fails when one of them changed since.
 */
export function consumedVaultsManifestsOf(ctx: ManifestCtx): Record<string, string> {
  const hashes = hashConsumedManifests(manifestDir(ctx));
  const missing = CONSUMED_VAULTS_MANIFESTS.filter((n) => hashes[n] === undefined);
  if (missing.length > 0) throw new PublishError("INPUT_MISSING", `the gateway system reads the vaults system's manifests and ${missing.map((n) => `${n}.json`).join(", ")} ${missing.length === 1 ? "is" : "are"} missing in ${manifestDir(ctx)}: run and verify the vaults system first`, { missing });
  return hashes;
}

export function newManifest(ctx: RunContext, deployer: string): RunManifest {
  const sys = getStageTable().systems ? { system: ACTIVE_SYSTEM } : {};
  const consumed = ACTIVE_SYSTEM === "gateway" ? { consumedVaultsManifests: consumedVaultsManifestsOf(ctx) } : {};
  return { version: 1, ...sys, ...consumed, deploymentKind: ctx.sheet.kind, ...(ctx.sheet.upgrade ? { upgradeMode: ctx.sheet.upgrade.mode } : {}), chainId: ctx.chainId, coreSha: ctx.coreSha, deployer, environment: ctx.environment, startedAt: new Date().toISOString(), stages: {} };
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
    // QA plan v1 E1: a run at a redeploy round's sha (govern --row redeploy-vault, verify --prior-out) continues the run manifest of the ORIGINAL sha (ctx.originalSha).
    const manifestSha = ctx.originalSha ?? ctx.coreSha;
    if (manifest.chainId !== ctx.chainId || manifest.coreSha !== manifestSha || manifest.deployer.toLowerCase() !== deployer.toLowerCase()) {
      const why = manifest.coreSha !== manifestSha ? `: it was written at core SHA ${manifest.coreSha}, this run names ${ctx.coreSha}. Only a descendant with byte-identical deployed inputs (tooling-sha.ts), govern --row redeploy-vault and verify (with --prior-out) may name the sha a redeploy-vault round was deployed at` : "";
      throw new PublishError("RESUME", `the run manifest belongs to a different chain, core SHA or deployer${why}`);
    }
    if ((manifest.system ?? "vaults") !== ACTIVE_SYSTEM) throw new PublishError("RESUME", `the run manifest in ${ctx.evidenceDir} is a ${manifest.system ?? "vaults"} system run, this run is --system ${ACTIVE_SYSTEM}: each system has its own evidence directory and run manifest`);
    if ((manifest.deploymentKind ?? "production") !== ctx.sheet.kind) throw new PublishError("RESUME", `the run manifest is a ${manifest.deploymentKind ?? "production"} run, the sheet says DEPLOYMENT_KIND ${ctx.sheet.kind}: a run never changes kind`);
    if (manifest.deploymentKind === undefined) manifest.deploymentKind = "production";
    const runMode = manifest.upgradeMode ?? "frozen";
    if (ctx.sheet.upgrade && runMode !== ctx.sheet.upgrade.mode) throw new PublishError("RESUME", `the run manifest deployed its proxies with UPGRADE_MODE ${runMode}, the sheet says ${ctx.sheet.upgrade.mode}: a run never changes its release mode (a resume would leave some proxies frozen and others upgradeable). Resume with the run's own sheet, or start a fresh run`, { run_mode: runMode, sheet_mode: ctx.sheet.upgrade.mode });
    manifest.upgradeMode = runMode;
  }
  // Security round 1 (review-security-033, the issue 1686 interlock): a run of follow-on stages only (verify, govern) continues a deployment's run manifest, never a fresh
  // one. The pause-all entries that stop a scheduled unpause from executing live in that manifest: a govern run from another working directory (the default evidence dir
  // is relative to it) or with another --evidence used to start an empty manifest, adopt the scheduled operation from the chain and execute it past a recorded pause.
  // govern also needs the finished handover stage: before it the Safe governs nothing.
  if (!ctx.dryRun) {
    const kinds = names.map((n) => stageByName(n).kind);
    if (kinds.length > 0 && kinds.every((k) => k === "verify" || k === "govern")) {
      const handover = DEPLOYER_STAGES[DEPLOYER_STAGES.length - 1]!.name;
      if (!manifest) throw new PublishError("RESUME", `no run manifest in ${ctx.evidenceDir}: ${names.join(", ")} continue${names.length === 1 ? "s" : ""} the run that deployed the contracts, and its pause-all entries live in that run manifest (issue 1686). Pass that run's own --evidence directory as an absolute path (the default is relative to the working directory). Nothing was read or sent.`, { evidence: ctx.evidenceDir });
      if (kinds.includes("govern") && manifest.stages[handover]?.status !== "done") throw new PublishError("RESUME", `the run manifest in ${ctx.evidenceDir} has no finished ${handover} stage: govern runs only after the handover, on the run manifest of the run that made it. Pass that run's own --evidence directory. Nothing was sent.`, { evidence: ctx.evidenceDir, stage: handover });
    }
  }
  if (!manifest) manifest = newManifest(ctx, deployer);
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
 * The end-of-deploy nonce check: the deployer nonce must equal the summed frozen counts plus the one prove-control transaction (core 1712). It is a stage-12 check, so it runs only when
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
  const effective = effectiveCounts(counts, adoptedTxs(manifest)); // an adopted stage counts the transactions this deployer sent for it (issue 1721)
  const startNonce = recordedStartNonce(ctx.sheet?.kind ?? "production", manifest);
  checkNonce(nonce, effective, undefined, startNonce);
  const sum = sumCounts(effective);
  ctx.log.log("info", "run.nonce_ok", { nonce, summed_frozen_counts: sum, deployer_start_nonce: startNonce, deployment_kind: ctx.sheet?.kind ?? "production" });
  return { checked: true, nonce, sum };
}

/** The counts a --measure run learned, keyed by frozen-count key. */
export function measuredCounts(manifest: RunManifest): FrozenCounts {
  return Object.fromEntries(DEPLOYER_STAGES.map((s) => [s.countKey!, manifest.stages[s.name]?.count ?? 0]));
}
