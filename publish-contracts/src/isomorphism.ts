// The isomorphism report: what differs between two runs of publish contracts, and what must not.
// Sheet diff, core and devops SHAs, config file hashes, forge version and profile, node and Twin fork pin facts, library addresses and
// deployed codehashes. A rehearsal and production should differ only in the sheet diff. Plan "Parameters", last list.
import { createHash } from "node:crypto";
import { PublishError } from "./errors.ts";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { diffSheets, type Sheet, type SheetDiffRow } from "./sheet.ts";
import { scrubGitEnv } from "./git-env.ts";
import { castOut, childEnv, manifestDir, type ProcessRunner, type RunContext } from "./runner.ts";
import { loadManifests } from "./verify/manifests.ts";
import { coreContracts } from "./verify/constants.ts";
import { getStageTable } from "./stages.ts";
import { delayFloor, MAINNET_DELAY_FLOOR } from "./floors.ts";
import { kindLabel } from "./chains.ts";

/** HEAD commit of a checkout, read from .git without spawning git. Handles worktrees and packed refs. */
export function readGitHead(dir: string): string | undefined {
  let gitdir = join(dir, ".git");
  if (!existsSync(gitdir)) return undefined;
  if (!readdirSafe(gitdir)) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitdir, "utf8"));
    if (!m) return undefined;
    gitdir = m[1]!.startsWith("/") ? m[1]!.trim() : join(dir, m[1]!.trim());
  }
  const head = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
  if (/^[0-9a-f]{40}$/.test(head)) return head;
  const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
  if (!ref) return undefined;
  let common = gitdir;
  if (existsSync(join(gitdir, "commondir"))) common = join(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim());
  for (const base of [gitdir, common]) {
    const p = join(base, ref);
    if (existsSync(p)) return readFileSync(p, "utf8").trim();
    const packed = join(base, "packed-refs");
    if (existsSync(packed)) {
      const line = readFileSync(packed, "utf8").split("\n").find((l) => l.endsWith(` ${ref}`));
      if (line) return line.split(" ")[0];
    }
  }
  return undefined;
}
/**
 * `git status --porcelain` of the core checkout, as the lines that make the tree dirty. Untracked files under deployments/<chainId>/ are
 * this tool's own manifests (earlier stages of the same run, a resume) and do not count. Everything else does: a modified tracked file,
 * an untracked file anywhere else.
 */
export async function dirtyTreeLines(run: ProcessRunner, dir: string, chainId: number, env: Record<string, string> = {}): Promise<string[]> {
  const r = await run("git", ["-C", dir, "status", "--porcelain", "--untracked-files=all"], { env: scrubGitEnv(env) });
  if (r.code !== 0) throw new PublishError("USAGE", `git status failed in ${dir}: ${(r.stderr || "").trim().split("\n").slice(-1)[0] ?? "unknown error"}`);
  return r.stdout.split("\n").filter((l) => l.trim() !== "" && !l.startsWith(`?? deployments/${chainId}/`));
}

function readdirSafe(p: string): boolean { try { readdirSync(p); return true; } catch { return false; } }

export const sha256File = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

/**
 * Each value is `sha256:<64 hex>`. The prefix is load-bearing: the evidence secret scan reads a bare 64-hex value as a
 * private key and skips only lines that name a hash word (`sha` here). The scan rule itself is unchanged. The prefix does not
 * widen what the scan lets through: any line that says `sha` was already exempt.
 */
export function configHashes(coreDir: string): Record<string, string> {
  const dir = join(coreDir, "config");
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => [`config/${f}`, `sha256:${sha256File(join(dir, f))}`]));
}

export interface ForgeProfile { optimizerRuns?: number; evmVersion?: string }
export function forgeProfile(coreDir: string): ForgeProfile {
  const p = join(coreDir, "foundry.toml");
  if (!existsSync(p)) return {};
  const t = readFileSync(p, "utf8");
  const runs = /^\s*optimizer_runs\s*=\s*(\d+)/m.exec(t)?.[1];
  const evm = /^\s*evm_version\s*=\s*"([^"]+)"/m.exec(t)?.[1];
  return { optimizerRuns: runs ? Number(runs) : undefined, evmVersion: evm };
}

export interface IsoReport {
  chainId: number;
  coreSha: string;
  coreHead?: string;
  devopsSha?: string;
  environment: string;
  sheetDiff?: SheetDiffRow[];
  compared?: string;
  configHashes: Record<string, string>;
  forge: { version: string } & ForgeProfile;
  node: { client?: string; latestBlock?: number; /** The Twin fork's pinned block (anvil_nodeInfo). The upstream URL is never recorded: it may carry a key. */ fork?: { pinBlock?: number; pinBlockHash?: string } };
  libraries: Record<string, string>;
  codehashes: Record<string, string>;
  notes: string[];
}

export interface IsoOpts { compareTo?: { path: string; sheet: Sheet }; devopsDir?: string }

export async function buildIsomorphismReport(ctx: RunContext, o: IsoOpts = {}): Promise<IsoReport> {
  const mdir = manifestDir(ctx);
  const table = getStageTable();
  const m = existsSync(mdir) ? loadManifests(mdir, table) : undefined;
  const forgeVersion = (await ctx.run("forge", ["--version"], { env: childEnv(ctx) })).stdout.trim().split("\n")[0] ?? "";
  const client = await castOut(ctx, ["client"]).catch(() => undefined);
  const latest = await castOut(ctx, ["block-number"]).then(Number).catch(() => undefined);
  const info = await castOut(ctx, ["rpc", "anvil_nodeInfo"]).then((t) => JSON.parse(t) as { forkConfig?: { forkBlockNumber?: number; forkBlockHash?: string } }).catch(() => undefined);
  const fork = info?.forkConfig ? { pinBlock: info.forkConfig.forkBlockNumber, pinBlockHash: info.forkConfig.forkBlockHash } : undefined;
  const codehashes: Record<string, string> = {};
  if (m) {
    const named: Record<string, string> = { ...Object.fromEntries(m.vaults.map((v) => [`vault[${v.key}]`, v.address])), ...Object.fromEntries(Object.entries(m.libraries).map(([k, v]) => [`library[${k}]`, v])) };
    for (const x of coreContracts(table)) {
      const v = m.files[x.file.replace(/\.json$/, "")]?.[x.field];
      if (typeof v === "string") named[`${x.file.replace(/\.json$/, "")}.${x.field}`] = v;
    }
    for (const [name, addr] of Object.entries(named)) codehashes[name] = await castOut(ctx, ["codehash", addr]).catch(() => "unreadable");
  }
  const notes: string[] = [];
  notes.push(`deployment kind: ${kindLabel(ctx.sheet.kind, ctx.sheet.timelockMinDelay)}${ctx.sheet.kind === "rehearsal" ? " (a rehearsal, never a production deployment)" : ""}`);
  if (ctx.sheet.timelockMinDelay < BigInt(MAINNET_DELAY_FLOOR)) {
    notes.push(`TIMELOCK_MIN_DELAY ${ctx.sheet.timelockMinDelay} is below ${MAINNET_DELAY_FLOOR}: a short-delay run proves the scripts execute and that only parameters differ. It does not prove the real delay. Governance timing is proven on 8453 at 48 hours (runbook Q2).`);
  }
  notes.push(`delay floor on chain ${ctx.chainId} for kind ${ctx.sheet.kind}: ${delayFloor(ctx.chainId, ctx.sheet.kind)} s`);
  return {
    chainId: ctx.chainId, coreSha: ctx.coreSha, coreHead: readGitHead(ctx.coreDir), devopsSha: readGitHead(o.devopsDir ?? join(import.meta.dir, "..", "..")),
    environment: ctx.environment,
    ...(o.compareTo ? { sheetDiff: diffSheets(ctx.sheet, o.compareTo.sheet), compared: o.compareTo.path } : {}),
    configHashes: configHashes(ctx.coreDir), forge: { version: forgeVersion, ...forgeProfile(ctx.coreDir) },
    node: { client, latestBlock: latest, ...(fork ? { fork } : {}) },
    libraries: m?.libraries ?? {}, codehashes, notes,
  };
}

export function writeReport(path: string, r: IsoReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(r, null, 2) + "\n");
}

/** Two reports are isomorphic when only the sheet diff and chain-specific facts differ. Returns the fields that must not differ and do.
 *  Raw codehashes are listed for the reader only: immutables differ per deployment, and the verifier compares them masked. */
export function nonIsomorphicFields(a: IsoReport, b: IsoReport): string[] {
  const bad: string[] = [];
  if (a.coreSha !== b.coreSha) bad.push("coreSha");
  if (a.devopsSha !== b.devopsSha) bad.push("devopsSha");
  if (JSON.stringify(a.configHashes) !== JSON.stringify(b.configHashes)) bad.push("configHashes");
  if (JSON.stringify(a.forge) !== JSON.stringify(b.forge)) bad.push("forge");
  return bad;
}
