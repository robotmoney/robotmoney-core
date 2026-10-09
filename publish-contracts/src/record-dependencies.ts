// Release dependency manifest (core 1497). After a successful verify stage on Base mainnet, run core's recorder from the core checkout
// and keep its output under deployments/<chain>/dependency-manifest.json beside the deployed manifests.
// The recorder is core's: scripts/release/record-release-dependencies.ts (see core deployments/dependency-manifests/README.md).
// Failing to record is a WARN with a named code. It never fails the run and is never skipped silently.
// The RPC URL reaches the recorder through its environment only, never as an argument.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { MAINNET_CHAIN_ID } from "./floors.ts";
import type { Logger } from "./log.ts";

export const RECORDER_SCRIPT = "scripts/release/record-release-dependencies.ts";
export const DEPENDENCY_MANIFEST_FILE = "dependency-manifest.json";
export const RECORD_WARN_CODES = ["DEPENDENCY_MANIFEST_SCRIPT_MISSING", "DEPENDENCY_MANIFEST_RECORDER_FAILED", "DEPENDENCY_MANIFEST_OUTPUT_MISSING"] as const;
export type RecordWarnCode = (typeof RECORD_WARN_CODES)[number];

export interface RecorderSpawnResult { code: number; stdout: string; stderr: string }
export type RecorderSpawn = (cmd: string[], opts: { cwd: string; env: Record<string, string> }) => Promise<RecorderSpawnResult>;

export const realRecorderSpawn: RecorderSpawn = async (cmd, opts) => {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
};

export interface RecordCtx {
  chainId: number;
  rpc: string;
  coreDir: string;
  coreSha: string;
  log: Logger;
  baseEnv: Record<string, string | undefined>;
  dryRun: boolean;
}

export interface RecordOutcome { recorded: boolean; path?: string; code?: RecordWarnCode }

/** The release label the recorder files the manifest under: the core DEPLOY_SHA. It matches the recorder's [A-Za-z0-9._-] rule. */
export const releaseLabel = (ctx: Pick<RecordCtx, "coreSha">): string => ctx.coreSha;

export async function recordDependencyManifest(ctx: RecordCtx, spawn: RecorderSpawn = realRecorderSpawn): Promise<RecordOutcome> {
  if (ctx.chainId !== MAINNET_CHAIN_ID || ctx.dryRun) return { recorded: false };
  const warn = (code: RecordWarnCode, message: string, extra: Record<string, unknown> = {}): RecordOutcome => {
    ctx.log.log("warn", "release.dependency_manifest_not_recorded", { code, message, ...extra });
    return { recorded: false, code };
  };
  const script = join(ctx.coreDir, RECORDER_SCRIPT);
  if (!existsSync(script)) return warn("DEPENDENCY_MANIFEST_SCRIPT_MISSING", `${RECORDER_SCRIPT} is not in the core checkout: record the dependency manifest by hand`, { script });
  // a minimal environment: the recorder needs the RPC URL and PATH, nothing else
  const env: Record<string, string> = { DEPENDENCY_MANIFEST_RPC_URL: ctx.rpc };
  for (const k of ["PATH", "HOME"]) { const v = ctx.baseEnv[k]; if (v !== undefined) env[k] = v; }
  let r: RecorderSpawnResult;
  try {
    r = await spawn(["bun", RECORDER_SCRIPT, "--chain-id", String(ctx.chainId), "--release", releaseLabel(ctx)], { cwd: ctx.coreDir, env });
  } catch (e) {
    return warn("DEPENDENCY_MANIFEST_RECORDER_FAILED", `the recorder could not start: ${(e as Error).message}`);
  }
  if (r.code !== 0) return warn("DEPENDENCY_MANIFEST_RECORDER_FAILED", `the recorder exited ${r.code}`, { exit_code: r.code, stderr: r.stderr.trim().split("\n").slice(-5).join("\n").replaceAll(ctx.rpc, "[rpc]") });
  const printed = r.stdout.trim().split("\n").pop()?.trim() ?? "";
  const from = printed === "" ? "" : isAbsolute(printed) ? printed : resolve(ctx.coreDir, printed);
  if (from === "" || !existsSync(from)) return warn("DEPENDENCY_MANIFEST_OUTPUT_MISSING", "the recorder succeeded but its output file is not there", { printed });
  try { JSON.parse(readFileSync(from, "utf8")); } catch { return warn("DEPENDENCY_MANIFEST_OUTPUT_MISSING", "the recorder output is not valid JSON", { printed }); }
  const to = join(ctx.coreDir, "deployments", String(ctx.chainId), DEPENDENCY_MANIFEST_FILE);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  ctx.log.log("info", "release.dependency_manifest_recorded", { path: to, release: releaseLabel(ctx) });
  return { recorded: true, path: to };
}
