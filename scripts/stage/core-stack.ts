#!/usr/bin/env bun
// One verb per stage job for the core stack on the Twin chain (918453). Bun TypeScript.
//
// This tool wraps BOOT, HEALTH, the record and the parity checks. It deploys nothing and governs
// nothing itself. Stage runs the same runbook as mainnet, "publish contracts" (publish-contracts/ in this repo, Bun
// TypeScript, run as `bun publish-contracts/src/cli.ts`), with the Twin chain arguments:
//
//   --chain 918453 --rpc <twin rpc> --sheet <stage sheet> \
//   --signer keystore:<key dir>/DEPLOYER:<passphrase file> --environment stage --core-sha <sha>
//
// Every stage service runs in a container (core 1549) and this tool only calls `docker compose`. It starts no
// host process and mounts no Docker socket anywhere:
//   - the Twin chain (918453, the pinned lazy anvil fork of real Base) is the `twin-chain` service of
//     testing/ethereum-testnet/config/docker-compose.stage-chain.yaml (project robotmoney-stage-chain),
//   - the deploy job is the one-shot `stage-harness` service of the same file: `smoke-test --deploy-only` mints a
//     fresh keystore set on every boot (a redeploy from a new SHA never reuses a deployer), funds it and calls
//     publish contracts, then exits and leaves the keystores and manifests in the work
//     directory (/tmp/robotmoney-stage-work, STAGE_WORK_DIR overrides),
//   - the dapp stack is docker-compose.dapp.yaml plus docker-compose.dapp.stage.yaml (project robotmoney-dapp),
//     started from the environment the deploy job wrote.
// The deploy, the real Safe handover, the verifier and the stage 13 govern matrix all run through publish
// contracts and the Safe SDK tool. Voting power, quorum, agent registration and weights are govern rows executed
// through the real Safe and the timelock, never set by a deployer. The passphrase stays in a 0600 file: only its
// PATH is passed, never its content.
//
// Usage (from the repo root on the stage host):
//   core-stack chain up        [--ref REF] [--timeout SECS] [--out-dir DIR]
//   core-stack chain down      [--out-dir DIR]
//   core-stack chain status    [--ref REF] [--out-dir DIR]
//   core-stack publish args    [--out-dir DIR]
//   core-stack publish run     [--out-dir DIR]
//   core-stack governance preflight|ensure|verify [--out-dir DIR]
//   core-stack governance release --receipt-id ID [--out-dir DIR]
//   core-stack parity labels   --mainnet FILE [--stage-labels FILE] [--out-dir DIR]
//   core-stack parity sheet    --production FILE
//   core-stack dapp status
//   core-stack dapp up|down|status --chain 8453 [--rpc URL --manifests DIR --start-block N ...]  (read-only, core 1725)
//   core-stack rmpc check
//   core-stack record write|show [--record FILE] [--path] [--list-required-fields]
//
// Output: results on stdout, structured JSON log lines on stderr. A read-only verb that fails prints
// one line `<class>: <detail>` on stdout, so a caller can tell WHICH precondition failed.
//
// Exit codes: 0 ok; 1 not satisfied (a status or check verb's honest "no"); 3 required tool missing;
// 64 usage; 65 bad input (record, summary, ref); 66 an action failed. Codes from publish contracts
// pass through unchanged.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkRows, parseRows } from "./govern-rows.ts";
import { labelParity, sheetParity } from "./parity.ts";
import { parseSheet } from "./sheet-diff.ts";
import { MAINNET_CHAIN_ID, MAINNET_DAPP_PROJECT, MAINNET_DEFAULT_PORTS, MAINNET_TEARDOWN_ENV, MainnetDappError, assertComposeReadOnly, assertMergedConfigLoopback, assertNoSigningEnv, buildMainnetDappEnv, mainnetComposeFiles, mainnetComposeTexts, redactRpc } from "./mainnet-dapp.ts";
import { STAGE_TABLE, expectedManifestCount, manifestOf, missingManifests, presentManifests, publishEnv, vaultManifests, type StageTableShape } from "./stage-manifests.ts";

// ─── constants ───────────────────────────────────────────────────────────────
export const EXIT = { OK: 0, NO: 1, TOOL: 3, USAGE: 64, INPUT: 65, ACTION: 66 } as const;
export const CHAIN_ID = 918453;
export const CHAIN_ID_HEX = "0xe03b5";
export const DEPLOYER_KEY_NAME = "DEPLOYER";
export const DEFAULT_OUT_DIR = "/opt/fusion-stage";
export const DEFAULT_RPC_URL = "http://127.0.0.1:18545";
export const DEFAULT_WORK_DIR = "/tmp/robotmoney-stage-work";
export const DAPP_PROJECT = "robotmoney-dapp";
export const TESTNET_LABEL = "com.robotmoney.testnet=1";
/** The stage chain project: the Twin chain container and the one-shot deploy job. */
export const STAGE_CHAIN_PROJECT = "robotmoney-stage-chain";
export const STAGE_CHAIN_LABEL = "com.robotmoney.stage-chain=1";
const STAGE_CHAIN_COMPOSE_REL = "testing/ethereum-testnet/config/docker-compose.stage-chain.yaml";
const DAPP_COMPOSE_REL = "testing/ethereum-testnet/config/docker-compose.dapp.yaml";
const DAPP_STAGE_OVERLAY_REL = "testing/ethereum-testnet/config/docker-compose.dapp.stage.yaml";
/** The public URLs and fixed host ports of the stage stack. They do not change with the containers. */
const STAGE_PUBLIC = { rpc: "https://stage-rpc.robotmoney-labs.dev", explorer: "https://stage-explorer.robotmoney-labs.dev", dapp: "https://stage-dapp.robotmoney-labs.dev" } as const;
const STAGE_PORTS = { explorer: 18546, dapp: 5173 } as const;
export const SUMMARY_END = "--- end endpoint summary ---";
/** The one deploy driver, relative to the repo root. */
const PUBLISH_CLI_REL = "publish-contracts/src/cli.ts";
/** The Twin chain stage sheet committed in this repo (parameter lines only). STAGE_SHEET overrides it. */
const STAGE_SHEET_REL = "deployments/twin-918453/stage-sheet.env";
const stageSheetPath = (s: { deps: Deps }): string => s.deps.env.STAGE_SHEET || join(s.deps.repoRoot, STAGE_SHEET_REL);

/** Canonical Safe v1.4.1 on the Twin chain: publish contracts needs all three. */
export const SAFE_SET: [string, string][] = [
  ["SafeL2 singleton", "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762"],
  ["SafeProxyFactory", "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"],
  ["CompatibilityFallbackHandler", "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99"],
];

/** The exhaustive required-field set. The schema's `required` array must equal it (drift guard). */
export const RECORD_REQUIRED_FIELDS = [
  ".chain_id", ".run_id", ".core_tag", ".core_sha", ".generated_at", ".min_delay", ".deployer",
  ".addresses.gateway", ".addresses.vault", ".addresses.registry", ".addresses.router", ".addresses.governance",
  ".addresses.consensus_receipt", ".addresses.ic_policy", ".addresses.timelock", ".addresses.safe", ".addresses.emergency",
  ".code_hashes.gateway",
  ".vault_addresses.rmUSDC", ".vault_addresses.rmPROTO", ".vault_addresses.rmAGENT", ".vault_addresses.rmRWA",
  ".ephemeral.approver", ".ephemeral.voters", ".ephemeral.emergency",
  ".ephemeral.keystore_dir", ".ephemeral.safe_signers",
];

const USAGE_TEXT = `usage: core-stack <noun> <verb> [flags]
  chain up|down|status [--ref REF] [--timeout SECS] [--out-dir DIR]
  publish args|run [--out-dir DIR]
  governance preflight|ensure|verify|release [--receipt-id ID] [--out-dir DIR]
  parity labels --mainnet FILE [--stage-labels FILE] | parity sheet --production FILE
  dapp status
  dapp up --chain 8453 --rpc URL --manifests DIR --start-block N [--logs-rpc URL] [--max-block-range N] [--dapp-port P] [--explorer-port P] [--public-dapp-url U --public-explorer-url U]
  dapp down|status --chain 8453 [--dapp-port P] [--explorer-port P]
  rmpc check
  record write|show [--record FILE] [--path] [--list-required-fields]`;

// ─── errors ──────────────────────────────────────────────────────────────────
/** Ends the run with an exit code. `stdoutLine` is the classed line a read-only verb prints. */
export class StackExit extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly stdoutLine?: string,
  ) {
    super(message);
  }
}
const fail = (msg: string, code: number = EXIT.ACTION): StackExit => new StackExit(code, msg);
const usageError = (msg?: string): StackExit => new StackExit(EXIT.USAGE, msg ? `${msg}\n${USAGE_TEXT}` : USAGE_TEXT);
const unsatisfied = (cls: string, detail: string): StackExit => new StackExit(EXIT.NO, `${cls}: ${detail}`, `${cls}: ${detail}`);
const recordBad = (cls: string, detail: string): StackExit => new StackExit(EXIT.INPUT, `${cls}: ${detail}`, `${cls}: ${detail}`);

// ─── dependencies (a test passes fakes) ──────────────────────────────────────
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface RunOpts {
  env?: Record<string, string>;
  cwd?: string;
  /** Pass the child's output straight through instead of capturing it (long runs). */
  stream?: boolean;
}
export interface Deps {
  run(cmd: string[], opts?: RunOpts): Promise<RunResult>;
  has(tool: string): boolean;
  out(s: string): void;
  err(s: string): void;
  nowMs(): number;
  sleep(ms: number): Promise<void>;
  env: Record<string, string | undefined>;
  repoRoot: string;
  /** eth_chainId result, or "" when nothing answers. */
  rpcChainId(url: string): Promise<string>;
  httpOk(url: string): Promise<boolean>;
  /** /proc start time of a live (non-zombie) process, or undefined. Names the holder of the one-writer lock. */
  procStart(pid: number): string | undefined;
}

export function realDeps(repoRoot: string): Deps {
  const stat = (pid: number): string[] | undefined => {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      const rest = raw.slice(raw.lastIndexOf(") ") + 2).split(" ");
      return rest[0] === "Z" ? undefined : rest;
    } catch {
      return undefined;
    }
  };
  return {
    async run(cmd, opts = {}) {
      const p = Bun.spawn(cmd, {
        cwd: opts.cwd ?? repoRoot,
        env: Object.fromEntries(Object.entries({ ...process.env, ...(opts.env ?? {}) }).filter(([, v]) => v !== undefined)) as Record<string, string>,
        stdin: "ignore",
        stdout: opts.stream ? "inherit" : "pipe",
        stderr: opts.stream ? "inherit" : "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        opts.stream ? Promise.resolve("") : new Response(p.stdout as ReadableStream).text(),
        opts.stream ? Promise.resolve("") : new Response(p.stderr as ReadableStream).text(),
        p.exited,
      ]);
      return { code, stdout, stderr };
    },
    has: (tool) => Bun.which(tool) !== null,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    nowMs: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    env: process.env,
    repoRoot,
    async rpcChainId(url) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
          signal: AbortSignal.timeout(3000),
        });
        if (!r.ok) return "";
        const j = (await r.json()) as { result?: string };
        return j.result ?? "";
      } catch {
        return "";
      }
    },
    async httpOk(url) {
      try {
        return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok;
      } catch {
        return false;
      }
    },
    procStart: (pid) => stat(pid)?.[19],
  };
}

// ─── arguments ───────────────────────────────────────────────────────────────
export interface Opts {
  ref: string;
  record: string;
  outDir: string;
  timeoutSecs: number;
  receiptId: string;
  mainnet: string;
  production: string;
  stageLabels: string;
  pathOnly: boolean;
  listRequiredFields: boolean;
  /** The read-only mainnet dapp verb (core 1725): `--chain 8453`, the RPC, a COPY of the manifests, the first block. */
  chain: string;
  rpc: string;
  logsRpc: string;
  manifests: string;
  startBlock: string;
  maxBlockRange: string;
  dappPort: string;
  explorerPort: string;
  publicDappUrl: string;
  publicExplorerUrl: string;
}
export interface Parsed {
  noun: string;
  verb: string;
  opts: Opts;
}

export function parseCli(argv: string[]): Parsed {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        ref: { type: "string" },
        record: { type: "string" },
        "out-dir": { type: "string" },
        timeout: { type: "string" },
        "receipt-id": { type: "string" },
        mainnet: { type: "string" },
        production: { type: "string" },
        "stage-labels": { type: "string" },
        path: { type: "boolean" },
        "list-required-fields": { type: "boolean" },
        chain: { type: "string" },
        rpc: { type: "string" },
        "logs-rpc": { type: "string" },
        manifests: { type: "string" },
        "start-block": { type: "string" },
        "max-block-range": { type: "string" },
        "dapp-port": { type: "string" },
        "explorer-port": { type: "string" },
        "public-dapp-url": { type: "string" },
        "public-explorer-url": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    throw usageError((e as Error).message);
  }
  const v = parsed.values;
  if (v.help) throw usageError();
  const [noun = "", verb = "", ...extra] = parsed.positionals;
  if (extra.length) throw usageError(`unexpected argument: ${extra[0]}`);
  const timeoutSecs = v.timeout === undefined ? 3600 : Number(v.timeout);
  if (!Number.isInteger(timeoutSecs) || timeoutSecs < 1) throw usageError("--timeout must be a positive integer");
  const str = (x: string | undefined): string => x ?? "";
  for (const [name, val] of Object.entries({ ref: v.ref, record: v.record, "out-dir": v["out-dir"], mainnet: v.mainnet, production: v.production, "receipt-id": v["receipt-id"], "stage-labels": v["stage-labels"], chain: v.chain, rpc: v.rpc, "logs-rpc": v["logs-rpc"], manifests: v.manifests, "start-block": v["start-block"], "max-block-range": v["max-block-range"], "dapp-port": v["dapp-port"], "explorer-port": v["explorer-port"], "public-dapp-url": v["public-dapp-url"], "public-explorer-url": v["public-explorer-url"] })) {
    if (val !== undefined && val === "") throw usageError(`--${name} needs a value`);
  }
  return {
    noun,
    verb,
    opts: {
      ref: str(v.ref),
      record: str(v.record),
      outDir: resolve(v["out-dir"] ?? DEFAULT_OUT_DIR),
      timeoutSecs,
      receiptId: str(v["receipt-id"]),
      mainnet: str(v.mainnet),
      production: str(v.production),
      stageLabels: str(v["stage-labels"]),
      pathOnly: v.path === true,
      listRequiredFields: v["list-required-fields"] === true,
      chain: str(v.chain),
      rpc: str(v.rpc),
      logsRpc: str(v["logs-rpc"]),
      manifests: str(v.manifests),
      startBlock: str(v["start-block"]),
      maxBlockRange: str(v["max-block-range"]),
      dappPort: str(v["dapp-port"]),
      explorerPort: str(v["explorer-port"]),
      publicDappUrl: str(v["public-dapp-url"]),
      publicExplorerUrl: str(v["public-explorer-url"]),
    },
  };
}

// ─── the stack: context plus helpers ─────────────────────────────────────────
export class Stack {
  readonly summaryPath: string;
  /** Refuses a work directory `chain up` and `chain down` must never delete: too shallow, or the checkout or out dir itself. */
  assertWorkDirSafe(): void {
    const depth = this.workDir.split("/").filter(Boolean).length;
    if (depth < 2 || this.workDir === this.deps.repoRoot || this.workDir === this.opts.outDir) {
      throw fail(`STAGE_WORK_DIR ${this.workDir} is too shallow or is the checkout or the out dir: it is deleted on chain down`, EXIT.INPUT);
    }
  }
  /** The deploy job's work directory: its keystores, sheet and manifests, and the dapp environment it wrote. */
  readonly workDir: string;
  readonly stampPath: string;
  readonly lockPath: string;
  readonly recordPath: string;
  /** The Twin chain RPC: DEFAULT_RPC_URL, where the chain container publishes it. `chain up` refuses any other TWIN_RPC_URL. */
  readonly rpcUrl: string;
  readonly rmpc: string;
  readonly rmpcImport: string;
  readonly bun: string;
  readonly cast: string;
  readonly pollMs: number;

  constructor(
    readonly deps: Deps,
    readonly opts: Opts,
  ) {
    this.summaryPath = join(opts.outDir, "core-smoke.log");
    // Under /tmp by default: forge only lets a script write the manifests where foundry.toml's fs_permissions say
    // (./deployments and /tmp), and the deploy job's manifest directory is in here. STAGE_WORK_DIR overrides it.
    this.workDir = resolve(deps.env.STAGE_WORK_DIR || DEFAULT_WORK_DIR);
    this.stampPath = join(opts.outDir, "core-stack.stamp");
    this.lockPath = join(opts.outDir, ".core-stack.lock");
    this.recordPath = opts.record || join(opts.outDir, "fusion-stage-record.json");
    this.rmpc = join(deps.repoRoot, "target/debug/rmpc");
    this.rmpcImport = join(deps.repoRoot, "target/debug/rmpc-keystore-import");
    this.bun = deps.env.BUN || "bun";
    this.cast = deps.env.CAST || "cast";
    this.rpcUrl = (deps.env.TWIN_RPC_URL ?? "").trim().replace(/\/+$/, "") || DEFAULT_RPC_URL;
    const poll = Number(deps.env.CORE_STACK_POLL_SECS);
    this.pollMs = (Number.isInteger(poll) && poll > 0 ? poll : 3) * 1000;
  }

  /** One structured log line on stderr. */
  log(msg: string, fields: Record<string, unknown> = {}, level = "info"): void {
    this.deps.err(`${JSON.stringify({ ts: new Date(this.deps.nowMs()).toISOString(), level, scope: "core-stack", msg, ...fields })}\n`);
  }

  need(tool: string): void {
    if (!this.deps.has(tool)) throw fail(`required tool '${tool}' not on PATH`, EXIT.TOOL);
  }
  needEnv(name: string, why: string): string {
    const v = this.deps.env[name];
    if (!v) throw fail(`${name} is not set: ${why}`, EXIT.INPUT);
    return v;
  }

  /** key=value lines from the harness summary; the last one wins. */
  summary(): Map<string, string> {
    const m = new Map<string, string>();
    let text = "";
    try {
      text = readFileSync(this.summaryPath, "utf8");
    } catch {
      return m;
    }
    for (const line of text.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) m.set(line.slice(0, i), line.slice(i + 1));
    }
    return m;
  }
  sv(key: string): string {
    return this.summary().get(key) ?? "";
  }
  summaryComplete(): boolean {
    try {
      return readFileSync(this.summaryPath, "utf8").includes(SUMMARY_END);
    } catch {
      return false;
    }
  }

  /** No --ref (or HEAD) is this checkout's HEAD, never origin/HEAD. Otherwise branch, tag, raw commit. */
  async candidateCommit(): Promise<string> {
    const rev = async (spec: string): Promise<string> => {
      const r = await this.deps.run(["git", "rev-parse", "--verify", "--quiet", `${spec}^{commit}`]);
      return r.code === 0 ? r.stdout.trim() : "";
    };
    const ref = this.opts.ref;
    if (!ref || ref === "HEAD") return rev("HEAD");
    return (await rev(`refs/remotes/origin/${ref}`)) || (await rev(`refs/tags/${ref}`)) || (await rev(ref));
  }

  // ── publish contracts ──
  /** keystore:PATH:PASSFILE, the one signer string publish contracts accepts for a keystore. Paths only. */
  signerSpec(): string {
    const keyDir = this.sv("key_dir");
    const pw = this.sv("password_file");
    if (!keyDir || !pw) throw fail("the harness summary names no keystore directory or passphrase file: boot with `chain up`", EXIT.INPUT);
    return `keystore:${join(keyDir, DEPLOYER_KEY_NAME)}:${pw}`;
  }

  async publishArgs(verb: string): Promise<string[]> {
    const sha = await this.candidateCommit();
    if (!sha) throw fail("cannot resolve the candidate commit", EXIT.INPUT);
    return [verb, "--chain", String(CHAIN_ID), "--rpc", this.rpcUrl, "--sheet", this.sv("sheet_path"), "--signer", this.signerSpec(), "--environment", "stage", "--core-sha", sha];
  }

  async publishContracts(verb: string, extra: string[] = [], stream = false): Promise<RunResult> {
    this.need(this.bun);
    const cli = join(this.deps.repoRoot, PUBLISH_CLI_REL);
    if (!existsSync(cli)) throw fail(`${cli} not found`, EXIT.INPUT);
    const sheet = this.sv("sheet_path");
    const keyDir = this.sv("key_dir");
    const pw = this.sv("password_file");
    const mdir = this.sv("manifest_dir");
    if (!isFile(sheet) || !isDir(keyDir) || !isFile(pw) || !isDir(mdir)) {
      throw fail("the harness summary names no usable sheet, keystore directory, passphrase file or manifest directory: boot with `chain up`", EXIT.INPUT);
    }
    const args = await this.publishArgs(verb);
    this.log("publish contracts", { verb });
    // The run's own state (evidence, measured counts) sits next to the manifests, not in the checkout: a second run on
    // the same SHA must not find an old run, and the CLI's clean-tree check must not see untracked files.
    const work = dirname(mdir);
    const state = ["--evidence", join(work, "evidence"), "--counts-dir", join(work, "counts")];
    return this.deps.run([this.bun, cli, ...args, ...state, ...extra], { env: publishEnv(CHAIN_ID, mdir), stream });
  }

  /** Forward a child's output and turn a non-zero exit into the same exit code. */
  passthrough(r: RunResult): void {
    if (r.stdout) this.deps.out(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
    if (r.stderr) this.deps.err(r.stderr);
    if (r.code !== 0) throw new StackExit(r.code, `publish contracts exited ${r.code}`);
  }

  // ── rmpc: always rebuilt from the checkout ──
  async rebuildRmpc(): Promise<void> {
    this.need("cargo");
    this.log("rebuilding rmpc from this checkout");
    const r = await this.deps.run(["cargo", "build", "-p", "rust-payment-client", "--bin", "rmpc", "--bin", "rmpc-keystore-import"], { stream: true });
    if (r.code !== 0) throw fail("rmpc rebuild failed; refusing to run against whatever binary was already there");
  }

  // ── docker compose: the only way this tool starts or stops anything ──
  chainComposeFile(): string {
    return join(this.deps.repoRoot, STAGE_CHAIN_COMPOSE_REL);
  }
  /** The variables the chain compose file interpolates. They are mandatory (`:?`), even for `down`. */
  chainEnv(): Record<string, string> {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const gid = typeof process.getgid === "function" ? process.getgid() : 0;
    return { STAGE_UID: String(uid), STAGE_GID: String(gid), STAGE_REPO: this.deps.repoRoot, STAGE_WORK_DIR: this.workDir };
  }
  chainCompose(args: string[]): string[] {
    return ["docker", "compose", "--project-name", STAGE_CHAIN_PROJECT, "-f", this.chainComposeFile(), "--profile", "deploy", ...args];
  }
  dappCompose(args: string[]): string[] {
    return ["docker", "compose", "--project-name", DAPP_PROJECT, "-f", join(this.deps.repoRoot, DAPP_COMPOSE_REL), "-f", join(this.deps.repoRoot, DAPP_STAGE_OVERLAY_REL), ...args];
  }
  /** Number of running containers of the stage chain project (the Twin chain). */
  async chainContainers(): Promise<number> {
    const ps = await this.deps.run(["docker", "ps", "--filter", "status=running", "--filter", `label=com.docker.compose.project=${STAGE_CHAIN_PROJECT}`, "--filter", `label=${STAGE_CHAIN_LABEL}`, "--format", "{{.Names}}"]);
    return ps.code === 0 ? ps.stdout.split("\n").filter((l) => l.trim()).length : 0;
  }

  /** One writer at a time per out dir. Returns the release function. */
  takeLock(): () => void {
    mkdirSync(this.opts.outDir, { recursive: true });
    const tryOnce = (): boolean => {
      try {
        const fd = openSync(this.lockPath, "wx");
        writeFileSync(fd, `${process.pid} ${this.deps.procStart(process.pid) ?? ""}\n`);
        closeSync(fd);
        return true;
      } catch {
        return false;
      }
    };
    if (!tryOnce()) {
      const [pidS, start] = (() => {
        try {
          return readFileSync(this.lockPath, "utf8").trim().split(/\s+/);
        } catch {
          return [] as string[];
        }
      })();
      const pid = Number(pidS);
      const live = Number.isInteger(pid) && pid > 0 && this.deps.procStart(pid) !== undefined && (!start || this.deps.procStart(pid) === start);
      if (live && pid !== process.pid) throw fail(`another chain up / chain down holds ${this.lockPath}; wait for it, or stop it first`);
      try {
        unlinkSync(this.lockPath);
      } catch {
        /* raced with another cleanup */
      }
      if (!tryOnce()) throw fail(`cannot take ${this.lockPath}`);
    }
    return () => {
      try {
        unlinkSync(this.lockPath);
      } catch {
        /* already gone */
      }
    };
  }
}

const isFile = (p: string): boolean => !!p && existsSync(p) && statSync(p).isFile();
const isDir = (p: string): boolean => !!p && existsSync(p) && statSync(p).isDirectory();
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDR = /^0x0{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

// ─── chain ───────────────────────────────────────────────────────────────────
interface Line {
  ok: boolean;
  line: string;
}

async function chainFactsLine(s: Stack, want: string): Promise<Line> {
  const got = await s.deps.rpcChainId(s.rpcUrl);
  if (!got) return { ok: false, line: `rpc-unreachable: nothing answering eth_chainId at ${s.rpcUrl}` };
  if (got !== CHAIN_ID_HEX) return { ok: false, line: `wrong-chain: ${s.rpcUrl} answers ${got}, want ${CHAIN_ID_HEX}` };
  const ps = await s.deps.run(["docker", "ps", "--filter", "health=healthy", "--filter", `label=com.docker.compose.project=${DAPP_PROJECT}`, "--filter", `label=${TESTNET_LABEL}`, "--format", "{{.Names}}"]);
  const healthy = ps.code === 0 ? ps.stdout.split("\n").filter((l) => l.trim()).length : 0;
  if (healthy < 1) return { ok: false, line: `no-healthy-container: no healthy container in compose project ${DAPP_PROJECT}` };
  if (!isFile(s.rmpc)) return { ok: false, line: `rmpc-missing: ${s.rmpc}` };
  const bi = await s.deps.run([s.rmpc, "build-info"]);
  let built = "";
  try {
    built = String((JSON.parse(bi.stdout) as { commit?: string }).commit ?? "");
  } catch {
    /* unknown */
  }
  if (built !== want) return { ok: false, line: `candidate-mismatch: rmpc built from '${built || "unknown"}', candidate is ${want}` };
  return { ok: true, line: `ok: chain ${CHAIN_ID_HEX}, ${healthy} healthy ${DAPP_PROJECT} container(s), rmpc built from ${want}` };
}

/**
 * boot-mismatch is a CHAIN fact (the running chain was booted from another commit: `chain down`
 * then `chain up`). candidate-mismatch is a BUILD-ARTIFACT fact (rmpc was rebuilt for something
 * else since): rebuild rmpc only. harness-gone: the chain container that this stamp vouches for
 * (the owner of the stage stack, since the harness no longer outlives its deploy job) is not running.
 */
async function stampLine(s: Stack, want: string): Promise<Line> {
  if (!isFile(s.stampPath)) return { ok: false, line: `not-booted: no completed \`chain up\` stamp at ${s.stampPath}` };
  let st: { commit?: string; chain_project?: string } = {};
  try {
    st = JSON.parse(readFileSync(s.stampPath, "utf8"));
  } catch {
    /* malformed */
  }
  if (st.commit !== want) return { ok: false, line: `boot-mismatch: the running chain was booted from '${st.commit ?? "unknown"}', candidate is ${want}` };
  if (st.chain_project !== STAGE_CHAIN_PROJECT) return { ok: false, line: `not-booted: ${s.stampPath} is malformed` };
  const n = await s.chainContainers();
  if (n < 1) return { ok: false, line: `harness-gone: the chain container of compose project ${STAGE_CHAIN_PROJECT} that booted this chain is no longer running` };
  return { ok: true, line: `ok: booted from ${want} by compose project ${STAGE_CHAIN_PROJECT}` };
}

async function chainStatusLine(s: Stack): Promise<Line> {
  const want = await s.candidateCommit();
  if (!want) return { ok: false, line: `ref-unresolved: '${s.opts.ref || "HEAD"}' is not a branch, tag or commit in this checkout` };
  const st = await stampLine(s, want);
  if (!st.ok) return st;
  return chainFactsLine(s, want);
}

async function chainStatus(s: Stack): Promise<void> {
  s.need("docker");
  const l = await chainStatusLine(s);
  s.deps.out(`${l.line}\n`);
  if (!l.ok) throw new StackExit(EXIT.NO, l.line);
}

function writeStamp(s: Stack, commit: string): void {
  const body = { commit, chain_project: STAGE_CHAIN_PROJECT, booted_at: new Date(s.deps.nowMs()).toISOString() };
  writeFileSync(`${s.stampPath}.tmp`, `${JSON.stringify(body)}\n`);
  renameSync(`${s.stampPath}.tmp`, s.stampPath);
}

function tailLog(s: Stack, n = 150): void {
  try {
    s.deps.err(readFileSync(s.summaryPath, "utf8").split("\n").slice(-n).join("\n") + "\n");
  } catch {
    /* no log */
  }
}

/** The compose environment the deploy job wrote: a flat JSON object of strings. */
function readDappEnv(s: Stack): Record<string, string> {
  const path = join(s.workDir, "dapp-env.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw fail(`the deploy job wrote no readable dapp environment at ${path} (${(e as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !Object.values(raw).every((v) => typeof v === "string")) {
    throw fail(`${path} is not a flat JSON object of strings`);
  }
  return raw as Record<string, string>;
}

/** Seconds left of the whole `chain up` budget, never below one. */
const secsLeft = (s: Stack, deadline: number): number => Math.max(1, Math.floor((deadline - s.deps.nowMs()) / 1000));

async function chainUp(s: Stack): Promise<void> {
  s.need("docker");
  const cli = join(s.deps.repoRoot, PUBLISH_CLI_REL);
  if (!existsSync(cli)) throw fail(`${cli} not found: run from a core checkout that holds publish-contracts/`, EXIT.INPUT);
  const sheetIn = stageSheetPath(s);
  if (!isFile(sheetIn)) throw fail(`the stage sheet ${sheetIn} does not exist (STAGE_SHEET overrides the committed ${STAGE_SHEET_REL})`, EXIT.INPUT);
  if (s.rpcUrl !== DEFAULT_RPC_URL) {
    throw fail(`TWIN_RPC_URL names ${s.rpcUrl}, but the stage chain is the container this tool starts, on ${DEFAULT_RPC_URL}: unset TWIN_RPC_URL`, EXIT.INPUT);
  }
  const want = await s.candidateCommit();
  if (!want) throw fail(`--ref '${s.opts.ref || "HEAD"}' is not a branch, tag or commit in this checkout`, EXIT.INPUT);
  const headR = await s.deps.run(["git", "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const head = headR.code === 0 ? headR.stdout.trim() : "";
  if (want !== head) throw fail(`--ref '${s.opts.ref || "HEAD"}' is ${want}, but this checkout is at ${head || "nothing"}: check the ref out first`, EXIT.INPUT);
  s.assertWorkDirSafe();
  const release = s.takeLock();
  try {
    const cur = await chainStatusLine(s);
    if (cur.ok) {
      s.log("the candidate is already up and healthy; starting nothing");
      s.deps.out(`${cur.line}\n`);
      return;
    }
    const running = await s.chainContainers();
    if (running > 0) throw fail(`an earlier stage chain is still running but is not the healthy candidate; run \`core-stack chain down\` first`);
    rmQuiet(s.stampPath);
    // Truncated before the deploy job exists; only the summary it wrote is copied in afterwards.
    writeFileSync(s.summaryPath, "");
    await s.rebuildRmpc();
    const deadline = s.deps.nowMs() + s.opts.timeoutSecs * 1000;
    // A fresh work directory: the keystores of the last boot are gone (a redeploy never reuses a deployer).
    rmSync(s.workDir, { recursive: true, force: true });
    mkdirSync(join(s.workDir, "home"), { recursive: true, mode: 0o700 });
    const env = s.chainEnv();

    // 1. The Twin chain: the pinned lazy anvil fork, in its own container. BASE_UPSTREAM_RPC and TWIN_PIN_BLOCK pass
    //    through this process's environment and are never logged.
    s.log("starting the Twin chain container", { project: STAGE_CHAIN_PROJECT });
    const up = await s.deps.run(s.chainCompose(["up", "--detach", "--build", "--wait", "--wait-timeout", String(secsLeft(s, deadline)), "twin-chain"]), { env, stream: true });
    if (up.code !== 0) throw fail("the Twin chain container did not become healthy; \`core-stack chain down\` removes it");

    // 2. The deploy job: the real ceremony against that chain, then it exits. It leaves the keystores and manifests in
    //    the work directory and writes the dapp environment and the endpoint summary there.
    const dappEnvOut = join(s.workDir, "dapp-env.json");
    const summaryOut = join(s.workDir, "summary.txt");
    s.log("running the deploy job", { work: s.workDir });
    const built = await s.deps.run(s.chainCompose(["build", "stage-harness"]), { env, stream: true });
    if (built.code !== 0) throw fail("the deploy job image did not build");
    const job = await s.deps.run(
      s.chainCompose([
        "run", "--rm", "--no-deps", "-T", "stage-harness",
        "--deploy-only", "--explorer-port", String(STAGE_PORTS.explorer), "--dapp-port", String(STAGE_PORTS.dapp),
        "--public-rpc-url", STAGE_PUBLIC.rpc, "--public-explorer-url", STAGE_PUBLIC.explorer, "--public-dapp-url", STAGE_PUBLIC.dapp,
        "--no-receipt-fixtures", "--dapp-env-out", dappEnvOut, "--summary-out", summaryOut,
      ]),
      { env, stream: true },
    );
    if (job.code !== 0) throw fail(`the deploy job exited ${job.code}; see its output above. \`core-stack chain down\` removes the chain and the work directory`);
    let summaryText = "";
    try {
      summaryText = readFileSync(summaryOut, "utf8");
    } catch {
      /* checked below */
    }
    if (!summaryText.includes(SUMMARY_END)) throw fail(`the deploy job printed no endpoint summary (${summaryOut})`);
    writeFileSync(s.summaryPath, summaryText);
    s.log("endpoint summary written", { summary: s.summaryPath });

    // 3. The dapp stack, from the environment the deploy job wrote. The indexer dials the chain container by name.
    const dappEnv = readDappEnv(s);
    s.log("starting the dapp stack", { project: DAPP_PROJECT });
    const dapp = await s.deps.run(s.dappCompose(["up", "--detach", "--build", "--wait", "--wait-timeout", String(secsLeft(s, deadline))]), { env: dappEnv, stream: true });
    if (dapp.code !== 0) {
      tailLog(s);
      throw fail("the dapp stack did not become healthy; `core-stack chain down` removes it");
    }

    const facts = await chainFactsLine(s, want);
    if (!facts.ok) throw fail(`the stack came up but is not the healthy candidate: ${facts.line}`);
    writeStamp(s, want);
    const st = await chainStatusLine(s);
    if (!st.ok) {
      rmQuiet(s.stampPath);
      throw fail(`the stack came up but is not the healthy candidate: ${st.line}`);
    }
    s.deps.out(`${st.line}\n`);
  } finally {
    release();
  }
}

function rmQuiet(p: string): void {
  try {
    unlinkSync(p);
  } catch {
    /* absent */
  }
}

async function chainDown(s: Stack): Promise<void> {
  s.assertWorkDirSafe();
  const release = s.takeLock();
  try {
    // The stamp goes first: from here on nothing vouches for the running chain.
    rmQuiet(s.stampPath);
    // The compose files' `:?` guards interpolate even for `down`.
    const teardown = { INDEXER_GATEWAY: "teardown", INDEXER_VAULT: "teardown", VITE_GATEWAY_ADDRESS: "teardown", VITE_VAULT_ADDRESS: "teardown", VITE_GATEWAY_EXPECTED_CODE_HASH: "teardown", COMPOSE_PROFILES: "receipt-fixtures" };
    const dapp = await s.deps.run(s.dappCompose(["down", "--remove-orphans"]), { env: teardown });
    if (dapp.code !== 0) throw fail("dapp stack down failed");
    // The chain container stops gracefully (anvil saves its RPC cache), the deploy job image stays for the next boot.
    const chain = await s.deps.run(s.chainCompose(["down", "--remove-orphans"]), { env: s.chainEnv() });
    if (chain.code !== 0) throw fail("stage chain down failed");
    // The rehearsal keystores live as long as the stack.
    rmSync(s.workDir, { recursive: true, force: true });
    s.log("down done");
  } finally {
    release();
  }
}

// ─── publish ─────────────────────────────────────────────────────────────────
/** After a publish run every stage with a manifest in scripts/deploy/stage-table.json has one. Counts the table's manifests present. */
export function countStageManifests(mdir: string, table: StageTableShape = STAGE_TABLE): number {
  return presentManifests(mdir, table).length;
}

async function publishVerb(s: Stack, verb: string): Promise<void> {
  if (verb === "args") {
    s.deps.out((await s.publishArgs("publish")).join("\n") + "\n");
  } else if (verb === "run") {
    const r = await s.publishContracts("publish", [], true);
    if (r.code !== 0) throw new StackExit(r.code, `publish contracts exited ${r.code}`);
    const mdir = s.sv("manifest_dir");
    const n = countStageManifests(mdir);
    const want = expectedManifestCount();
    if (n !== want) throw fail(`publish contracts wrote ${n} of ${want} stage manifests in ${mdir} (missing: ${missingManifests(mdir).join(", ")})`);
    s.log("stage manifests present", { mdir, count: n });
  } else throw usageError();
}

// ─── governance ──────────────────────────────────────────────────────────────
async function hasCode(s: Stack, addr: string): Promise<boolean> {
  const r = await s.deps.run([s.cast, "code", addr, "--rpc-url", s.rpcUrl]);
  return r.code === 0 && r.stdout.trim().replace(/^0x/, "").length > 0;
}

async function governancePreflight(s: Stack): Promise<void> {
  s.need(s.cast);
  if (!s.summaryComplete()) throw unsatisfied("summary-incomplete", `${s.summaryPath} is absent or carries no end-of-summary marker`);
  const c = await s.deps.run([s.cast, "chain-id", "--rpc-url", s.rpcUrl]);
  if (c.code !== 0) throw unsatisfied("rpc-unreachable", `nothing answering at ${s.rpcUrl}`);
  if (c.stdout.trim() !== String(CHAIN_ID)) throw unsatisfied("wrong-chain", `${s.rpcUrl} is chain '${c.stdout.trim()}', stage runs only on ${CHAIN_ID}`);
  for (const [name, addr] of SAFE_SET) {
    if (!(await hasCode(s, addr))) throw unsatisfied("safe-set-missing", `canonical ${name} ${addr} has no code: this chain lacks the Safe v1.4.1 set`);
  }
  for (const key of ["gateway_addr", "vault_addr", "registry_addr", "router_addr", "governance_addr", "ic_policy_addr", "consensus_receipt_addr", "safe_addr", "timelock_addr"]) {
    const a = s.sv(key);
    if (!ADDR.test(a)) throw unsatisfied("summary-malformed", `${key} is not address-shaped ('${a}')`);
    if (!(await hasCode(s, a))) throw unsatisfied("no-code", `${key} ${a} has no code on ${s.rpcUrl}: the summary is from an older boot`);
  }
  const mdir = s.sv("manifest_dir");
  if (!isDir(mdir)) throw unsatisfied("manifests-missing", `manifest_dir '${mdir || "none"}' is not a directory`);
  const missing = missingManifests(mdir);
  if (missing.length > 0) throw unsatisfied("manifests-missing", `want every manifest in stage-table.json in ${mdir}, missing: ${missing.join(", ")}`);
  if (!isDir(s.sv("key_dir"))) throw unsatisfied("keys-discarded", `the rehearsal keystores (${s.sv("key_dir")}) are gone, so nobody can drive the Safe; rebuild the stack (chain down, chain up)`);
  s.deps.out("ok: the booted chain meets every publish contracts precondition\n");
}

/** The govern matrix prints one JSON line per row. Any row without a 32-byte tx hash and receipt status 1 fails. */
async function governRun(s: Stack, extra: string[] = []): Promise<void> {
  const r = await s.publishContracts("govern", extra);
  if (r.stdout) s.deps.out(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) s.deps.err(r.stderr);
  if (r.code !== 0) throw new StackExit(r.code, `publish contracts govern exited ${r.code}`);
  const rows = parseRows(r.stdout);
  const problems = checkRows(rows);
  if (problems.length) {
    for (const p of problems) s.log(p, {}, "error");
    throw fail(`a govern row has no tx hash or receipt status 1: ${problems.join("; ")}`);
  }
  s.log("govern rows ok", { rows: rows.length });
}

async function governanceVerb(s: Stack, verb: string): Promise<void> {
  switch (verb) {
    case "preflight":
      return governancePreflight(s);
    case "ensure":
      return governRun(s);
    case "verify":
      return s.passthrough(await s.publishContracts("verify"));
    case "release":
      if (!s.opts.receiptId) throw usageError("release needs --receipt-id");
      return governRun(s, ["--row", "release-receipt", "--receipt-id", s.opts.receiptId]);
    default:
      throw usageError();
  }
}

// ─── parity ──────────────────────────────────────────────────────────────────
async function parityVerb(s: Stack, verb: string): Promise<void> {
  const report = (r: { ok: boolean; messages: string[] }): void => {
    for (const m of r.messages) s.deps.err(`${m}\n`);
    if (!r.ok) throw new StackExit(EXIT.NO, "parity differs");
  };
  if (verb === "labels") {
    if (!s.opts.mainnet) throw usageError("parity labels needs --mainnet FILE (the mainnet verifier output)");
    if (!isFile(s.opts.mainnet)) throw fail(`parity input missing: mainnet verifier labels (${s.opts.mainnet})`, EXIT.INPUT);
    let stageText: string;
    if (s.opts.stageLabels) {
      if (!isFile(s.opts.stageLabels)) throw fail(`parity input missing: stage verifier labels (${s.opts.stageLabels})`, EXIT.INPUT);
      stageText = readFileSync(s.opts.stageLabels, "utf8");
    } else {
      const saved = join(s.opts.outDir, "verify-labels.txt");
      const r = await s.publishContracts("verify");
      writeFileSync(saved, r.stdout);
      if (r.code !== 0) {
        s.deps.err(r.stdout);
        throw new StackExit(r.code, `the verifier did not pass on the stage chain (exit ${r.code})`);
      }
      stageText = r.stdout;
    }
    return report(labelParity(stageText, readFileSync(s.opts.mainnet, "utf8")));
  }
  if (verb === "sheet") {
    if (!s.opts.production) throw usageError("parity sheet needs --production FILE");
    if (!isFile(s.opts.production)) throw fail(`parity input missing: production sheet (${s.opts.production})`, EXIT.INPUT);
    const sheet = s.deps.env.STAGE_SHEET || s.sv("sheet_path");
    if (!isFile(sheet)) throw fail("no stage sheet: set STAGE_SHEET or boot with `chain up`", EXIT.INPUT);
    return report(sheetParity(readFileSync(sheet, "utf8"), readFileSync(s.opts.production, "utf8")));
  }
  throw usageError();
}

// ─── dapp and rmpc ───────────────────────────────────────────────────────────
async function dappStatus(s: Stack): Promise<void> {
  const got = await s.deps.rpcChainId(s.rpcUrl);
  if (got !== CHAIN_ID_HEX) throw unsatisfied("rpc-unready", `${s.rpcUrl} answers '${got || "nothing"}', want ${CHAIN_ID_HEX}`);
  if (!(await s.deps.httpOk("http://127.0.0.1:18546/health"))) throw unsatisfied("explorer-unready", "explorer-api /health on 18546 does not answer");
  if (!(await s.deps.httpOk("http://127.0.0.1:5173/"))) throw unsatisfied("dapp-unready", "the dapp on 5173 does not answer");
  s.deps.out("ok: rpc, explorer-api and dapp all answer\n");
}

// ─── dapp on Base mainnet, read-only (core 1725) ─────────────────────────────
/** A mainnet dapp refusal ends the run with exit 65 and one classed line on stdout. */
const mainnetRefusal = (e: MainnetDappError): StackExit => new StackExit(EXIT.INPUT, e.message, e.message);

/** `docker compose` of the 8453 stack: its own project, the dapp file and the read-only overlay, and no chain or deploy file. */
function mainnetCompose(s: Stack, args: string[]): string[] {
  const files = mainnetComposeFiles().flatMap((rel) => ["-f", join(s.deps.repoRoot, rel)]);
  return ["docker", "compose", "--project-name", MAINNET_DAPP_PROJECT, ...files, ...args];
}

const mainnetNumber = (flag: string, v: string): number => {
  if (!/^[0-9]+$/.test(v)) throw new MainnetDappError("usage", `${flag} must be a non-negative integer`);
  return Number(v);
};

async function dappMainnet(s: Stack, verb: string): Promise<void> {
  try {
    await dappMainnetInner(s, verb);
  } catch (e) {
    if (e instanceof MainnetDappError) throw mainnetRefusal(e);
    throw e;
  }
}

async function dappMainnetInner(s: Stack, verb: string): Promise<void> {
  const o = s.opts;
  if (o.chain !== String(MAINNET_CHAIN_ID)) throw new MainnetDappError("wrong-chain", `--chain ${o.chain} is not ${MAINNET_CHAIN_ID}: this verb only reads Base mainnet`);
  if (!["up", "down", "status"].includes(verb)) throw usageError();
  // The refusal on keys comes first, before any file is read or any command is run.
  assertNoSigningEnv(s.deps.env);
  const dappPort = o.dappPort ? mainnetNumber("--dapp-port", o.dappPort) : MAINNET_DEFAULT_PORTS.dapp;
  const explorerPort = o.explorerPort ? mainnetNumber("--explorer-port", o.explorerPort) : MAINNET_DEFAULT_PORTS.explorer;
  if (verb === "status") {
    if (!(await s.deps.httpOk(`http://127.0.0.1:${explorerPort}/health`))) throw unsatisfied("explorer-unready", `explorer-api /health on ${explorerPort} does not answer`);
    if (!(await s.deps.httpOk(`http://127.0.0.1:${dappPort}/`))) throw unsatisfied("dapp-unready", `the dapp on ${dappPort} does not answer`);
    s.deps.out("ok: explorer-api and dapp answer on 127.0.0.1\n");
    return;
  }
  s.need("docker");
  assertComposeReadOnly(mainnetComposeTexts(s.deps.repoRoot));
  if (verb === "down") {
    const r = await s.deps.run(mainnetCompose(s, ["down", "--remove-orphans"]), { env: MAINNET_TEARDOWN_ENV });
    if (r.code !== 0) throw fail("mainnet dapp stack down failed");
    s.log("mainnet dapp stack down", { project: MAINNET_DAPP_PROJECT });
    return;
  }
  if (!o.rpc) throw usageError("dapp up --chain 8453 needs --rpc");
  if (!o.manifests) throw usageError("dapp up --chain 8453 needs --manifests (a copy of the manifests directory)");
  if (!o.startBlock) throw usageError("dapp up --chain 8453 needs --start-block (the first block of the deployment)");
  const env = buildMainnetDappEnv({
    rpc: o.rpc,
    logsRpc: o.logsRpc || undefined,
    manifestsDir: resolve(o.manifests),
    startBlock: mainnetNumber("--start-block", o.startBlock),
    maxBlockRange: o.maxBlockRange ? mainnetNumber("--max-block-range", o.maxBlockRange) : undefined,
    dappPort,
    explorerPort,
    publicDappUrl: o.publicDappUrl || undefined,
    publicExplorerUrl: o.publicExplorerUrl || undefined,
  });
  // The merged, interpolated config must publish loopback ports only and hold no deploy job.
  const cfg = await s.deps.run(mainnetCompose(s, ["config", "--format", "json"]), { env });
  if (cfg.code !== 0) throw fail("docker compose config failed for the mainnet dapp stack");
  assertMergedConfigLoopback(cfg.stdout);
  s.log("starting the read-only mainnet dapp stack", { project: MAINNET_DAPP_PROJECT, rpc: redactRpc(o.rpc), logs_rpc: o.logsRpc ? redactRpc(o.logsRpc) : "", start_block: o.startBlock });
  const up = await s.deps.run(mainnetCompose(s, ["up", "--detach", "--build", "--wait", "--wait-timeout", String(o.timeoutSecs)]), { env, stream: true });
  if (up.code !== 0) throw fail("the mainnet dapp stack did not become healthy; `core-stack dapp down --chain 8453` removes it");
  s.deps.out(`ok: dapp http://127.0.0.1:${dappPort} explorer-api http://127.0.0.1:${explorerPort} (loopback only, chain ${MAINNET_CHAIN_ID}, read-only)\n`);
}

async function rmpcCheck(s: Stack): Promise<void> {
  for (const b of [s.rmpc, s.rmpcImport]) if (!isFile(b)) throw unsatisfied("missing-binary", b);
  if ((await s.deps.run([s.rmpc, "self-check", "--help"])).code !== 0) throw unsatisfied("missing-subcommand", "this rmpc has no self-check: the candidate predates it");
  const a = (await s.deps.run([s.rmpc, "self-check", "-c", "/nonexistent/rmpc.toml"])).code;
  if (a !== 3) throw unsatisfied("startup-exit-drift", `self-check on a missing config exited ${a}, want 3`);
  const b = (await s.deps.run([s.rmpcImport])).code;
  if (b !== 2) throw unsatisfied("import-exit-drift", `rmpc-keystore-import with no argv exited ${b}, want 2`);
  s.deps.out("ok: rmpc and rmpc-keystore-import answer their exit-code contracts\n");
}

// ─── record ──────────────────────────────────────────────────────────────────
type Json = Record<string, any>;

/** Value at a jq-style path (.a.b, .a[0]) as a string, or undefined when absent or empty. */
export function recordGet(rec: Json, path: string): string | undefined {
  let cur: any = rec;
  for (const part of path.replace(/^\./, "").split(".")) {
    const m = /^([^[\]]+)((?:\[\d+\])*)$/.exec(part);
    if (!m) return undefined;
    cur = cur?.[m[1]!];
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) cur = cur?.[Number(idx[1])];
  }
  if (cur === undefined || cur === null || cur === false || cur === "") return undefined;
  return typeof cur === "string" ? cur : JSON.stringify(cur);
}

function readJson(path: string, what: string): Json {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Json;
  } catch (e) {
    throw fail(`${what}: cannot read ${path} (${(e as Error).message})`, EXIT.INPUT);
  }
}

/** Derive the record from the manifests, the sheet and the chain. Nothing in it is typed by hand. */
async function recordWrite(s: Stack): Promise<void> {
  s.need(s.cast);
  const mdir = s.sv("manifest_dir");
  const sheetPath = s.sv("sheet_path");
  if (!isDir(mdir) || !isFile(sheetPath)) throw fail("the harness summary names no manifest directory or sheet: boot with `chain up`", EXIT.INPUT);
  const sha = s.sv("core_sha");
  const tagR = await s.deps.run(["git", "describe", "--tags", "--always", sha]);
  const tag = tagR.code === 0 && tagR.stdout.trim() ? tagR.stdout.trim() : sha;
  const m = (f: string): Json => readJson(join(mdir, f), "manifest");
  const gw = m(manifestOf("gateway"));
  const reg = m(manifestOf("registry"));
  const rtr = m(manifestOf("router"));
  const gov = m(manifestOf("governance"));
  const ic = m(manifestOf("ic-policy"));
  const tlk = m(manifestOf("timelock"));
  // The timelock manifest carries the Safe address; the table has no separate Safe manifest.
  const safe = tlk;
  const vaults: Record<string, Json> = Object.fromEntries(Object.entries(vaultManifests()).map(([k, f]) => [k, m(f)]));
  const call = async (cmd: string[]): Promise<string> => {
    const r = await s.deps.run(cmd);
    if (r.code !== 0) throw fail(`${cmd.slice(0, 2).join(" ")} failed: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  const delayOut = await call([s.cast, "call", String(tlk.timelock), "getMinDelay()(uint256)", "--rpc-url", s.rpcUrl]);
  const code = await call([s.cast, "code", String(gw.gateway), "--rpc-url", s.rpcUrl]);
  const hash = await call([s.cast, "keccak", code]);
  const sheet = parseSheet(readFileSync(sheetPath, "utf8"));
  const sg = (k: string): string => (sheet.get(k) ?? "").replaceAll(" ", "");
  const owners = sg("SAFE_OWNERS").split(",");
  const voters = sg("VOTER_ADDRESSES").split(",").filter(Boolean);
  const emergency = sg("EMERGENCY_ADDRESS");
  const stamp = new Date(s.deps.nowMs()).toISOString().replace(/\.\d+Z$/, "Z");
  const record = {
    chain_id: CHAIN_ID,
    run_id: `${basename(dirname(mdir))}-${stamp.replace(/[-:]/g, "")}`,
    core_tag: tag,
    core_sha: sha,
    generated_at: stamp,
    generated_by: "scripts/stage/core-stack.ts record write (publish contracts manifests)",
    min_delay: Number(delayOut.split(/\s+/)[0]),
    deployer: s.sv("deployer_addr"),
    addresses: {
      gateway: gw.gateway,
      vault: vaults.rmUSDC!.vault,
      registry: reg.registry,
      router: rtr.router,
      governance: gov.governance,
      consensus_receipt: ic.consensus_receipt,
      ic_policy: ic.policy,
      timelock: tlk.timelock,
      safe: safe.safe,
      emergency,
    },
    code_hashes: { gateway: hash },
    vault_addresses: { rmUSDC: vaults.rmUSDC!.vault, rmPROTO: vaults.rmPROTO!.vault, rmAGENT: vaults.rmAGENT!.vault, rmRWA: vaults.rmRWA!.vault },
    ephemeral: {
      approver: owners[0],
      voters,
      emergency,
      keystore_dir: s.sv("key_dir"),
      safe_signers: [
        { role: "approver", address: owners[0] },
        { role: "approver-b", address: owners[1] },
        { role: "approver-c", address: owners[2] },
      ],
    },
  };
  writeFileSync(`${s.recordPath}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${s.recordPath}.tmp`, s.recordPath);
  s.log("wrote record", { path: s.recordPath });
}

/** Check every field the cross-repo contract names has the shape it gives. Throws a classed refusal (exit 65). */
export function validateRecord(rec: Json, recordPath: string): void {
  const get = (path: string, label = path): string => {
    const v = recordGet(rec, path);
    if (v === undefined) throw recordBad("record-field-missing", `${recordPath} has no ${label}`);
    return v;
  };
  const addr = (path: string, label = path): string => {
    const v = get(path, label);
    if (!ADDR.test(v) || ZERO_ADDR.test(v)) throw recordBad("record-field-malformed", `${label} is not a non-zero address ('${v}')`);
    return v;
  };
  for (const f of RECORD_REQUIRED_FIELDS) get(f);
  if (get(".chain_id") !== String(CHAIN_ID)) throw recordBad("record-wrong-chain", `chain_id is '${get(".chain_id")}', not ${CHAIN_ID}`);
  for (const f of [".run_id", ".core_tag", ".generated_at", ".ephemeral.keystore_dir"]) get(f);
  if (!/^[0-9a-f]{40}$/.test(get(".core_sha"))) throw recordBad("record-field-malformed", `.core_sha is not a 40-hex commit ('${get(".core_sha")}')`);
  if (!/^[1-9][0-9]*$/.test(get(".min_delay"))) throw recordBad("record-field-malformed", `.min_delay is not a positive number of seconds ('${get(".min_delay")}')`);
  for (const f of [
    ".deployer", ".addresses.gateway", ".addresses.vault", ".addresses.registry", ".addresses.router", ".addresses.governance",
    ".addresses.consensus_receipt", ".addresses.ic_policy", ".addresses.timelock", ".addresses.safe", ".addresses.emergency",
    ".vault_addresses.rmUSDC", ".vault_addresses.rmPROTO", ".vault_addresses.rmAGENT", ".vault_addresses.rmRWA",
    ".ephemeral.approver", ".ephemeral.emergency", ".ephemeral.voters[0]", ".ephemeral.voters[1]",
  ]) addr(f);
  const hash = get(".code_hashes.gateway");
  if (!BYTES32.test(hash) || /^0x0{64}$/.test(hash)) throw recordBad("record-field-malformed", `.code_hashes.gateway is not a non-zero bytes32 ('${hash}')`);
  // The real 2-of-3 Safe: the three owner keys, each an address, with the approver (the relayer
  // every Safe call is sent from) among them.
  const signers: Json[] = Array.isArray(rec.ephemeral?.safe_signers) ? rec.ephemeral.safe_signers : [];
  let approver = "";
  for (const role of ["approver", "approver-b", "approver-c"]) {
    const a = signers.find((x) => x?.role === role)?.address;
    const label = `.ephemeral.safe_signers ${role}`;
    if (a === undefined || a === null || a === "") throw recordBad("record-field-missing", `${recordPath} has no ${label}`);
    if (!ADDR.test(String(a)) || ZERO_ADDR.test(String(a))) throw recordBad("record-field-malformed", `${label} is not a non-zero address ('${a}')`);
    if (role === "approver") approver = String(a);
  }
  const ea = get(".ephemeral.approver");
  if (approver.toLowerCase() !== ea.toLowerCase()) throw recordBad("record-field-malformed", `.ephemeral.approver ${ea} is not the approver Safe signer ${approver}`);
}

function recordShow(s: Stack): void {
  if (s.opts.listRequiredFields) {
    s.deps.out(`${JSON.stringify(RECORD_REQUIRED_FIELDS)}\n`);
    return;
  }
  if (!isFile(s.recordPath)) throw recordBad("record-missing", `${s.recordPath} does not exist`);
  let rec: Json;
  try {
    rec = JSON.parse(readFileSync(s.recordPath, "utf8"));
  } catch {
    throw recordBad("record-unparseable", `${s.recordPath} is not a JSON object`);
  }
  if (typeof rec !== "object" || rec === null || Array.isArray(rec)) throw recordBad("record-unparseable", `${s.recordPath} is not a JSON object`);
  validateRecord(rec, s.recordPath);
  s.deps.out(s.opts.pathOnly ? `${s.recordPath}\n` : `${JSON.stringify(rec, null, 2)}\n`);
}

// ─── entry ───────────────────────────────────────────────────────────────────
/** Runs one invocation and returns its exit code. Output goes through deps. */
export async function runCli(argv: string[], deps: Deps): Promise<number> {
  try {
    const { noun, verb, opts } = parseCli(argv);
    const s = new Stack(deps, opts);
    switch (noun) {
      case "chain":
        if (verb === "up") await chainUp(s);
        else if (verb === "down") await chainDown(s);
        else if (verb === "status") await chainStatus(s);
        else throw usageError();
        break;
      case "publish":
        await publishVerb(s, verb);
        break;
      case "governance":
        await governanceVerb(s, verb);
        break;
      case "parity":
        await parityVerb(s, verb);
        break;
      case "dapp":
        if (opts.chain !== "") await dappMainnet(s, verb);
        else if (verb !== "status") throw usageError();
        else await dappStatus(s);
        break;
      case "rmpc":
        if (verb !== "check") throw usageError();
        await rmpcCheck(s);
        break;
      case "record":
        if (verb === "write") await recordWrite(s);
        else if (verb === "show") recordShow(s);
        else throw usageError();
        break;
      default:
        throw usageError();
    }
    return EXIT.OK;
  } catch (e) {
    if (e instanceof StackExit) {
      if (e.stdoutLine) deps.out(`${e.stdoutLine}\n`);
      else if (e.code === EXIT.USAGE) deps.err(`${e.message}\n`);
      else deps.err(`${JSON.stringify({ level: "error", scope: "core-stack", msg: e.message, exit: e.code })}\n`);
      return e.code;
    }
    deps.err(`${JSON.stringify({ level: "error", scope: "core-stack", msg: String((e as Error)?.message ?? e), exit: EXIT.ACTION })}\n`);
    return EXIT.ACTION;
  }
}

if (import.meta.main) {
  // root's non-login shell on the stage host resolves neither cargo, cast nor bun.
  const home = process.env.HOME ?? "";
  process.env.PATH = [`${home}/.cargo/bin`, `${home}/.foundry/bin`, `${home}/.bun/bin`, process.env.PATH ?? ""].join(":");
  const repoRoot = resolve(import.meta.dir, "../..");
  process.chdir(repoRoot);
  process.exit(await runCli(process.argv.slice(2), realDeps(repoRoot)));
}
