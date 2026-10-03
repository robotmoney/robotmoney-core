#!/usr/bin/env bun
// One verb per stage job for the core stack on the Twin chain (918453). Bun TypeScript.
//
// This tool wraps BOOT, HEALTH, the record and the parity checks. It deploys nothing and governs
// nothing itself. Stage runs the same runbook as mainnet, "publish contracts" (devops, Bun
// TypeScript), with the Twin chain arguments:
//
//   --chain 918453 --rpc <twin rpc> --sheet <stage sheet> \
//   --signer keystore:<key dir>/DEPLOYER:<passphrase file> --environment stage --core-sha <sha>
//
// The smoke harness (`cargo run -p smoke-test -- --full-stack`) boots the Twin chain, mints a fresh
// keystore set on every boot (a redeploy from a new SHA never reuses a deployer), funds it and calls
// publish contracts. The deploy, the real Safe handover, the verifier and the stage 13 govern matrix
// all run through publish contracts and the Safe SDK tool. Voting power, quorum, agent registration
// and weights are govern rows executed through the real Safe and the timelock, never set by a
// deployer. The passphrase stays in a 0600 file: only its PATH is passed, never its content.
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
//   core-stack rmpc check
//   core-stack record write|show [--record FILE] [--path] [--list-required-fields]
//
// Output: results on stdout, structured JSON log lines on stderr. A read-only verb that fails prints
// one line `<class>: <detail>` on stdout, so a caller can tell WHICH precondition failed.
//
// Exit codes: 0 ok; 1 not satisfied (a status or check verb's honest "no"); 3 required tool missing;
// 64 usage; 65 bad input (record, summary, ref); 66 an action failed. Codes from publish contracts
// pass through unchanged.
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkRows, parseRows } from "./govern-rows.ts";
import { labelParity, sheetParity } from "./parity.ts";
import { parseSheet } from "./sheet-diff.ts";

// ─── constants ───────────────────────────────────────────────────────────────
export const EXIT = { OK: 0, NO: 1, TOOL: 3, USAGE: 64, INPUT: 65, ACTION: 66 } as const;
export const CHAIN_ID = 918453;
export const CHAIN_ID_HEX = "0xe03b5";
export const DEPLOYER_KEY_NAME = "DEPLOYER";
export const DEFAULT_OUT_DIR = "/opt/fusion-stage";
export const DEFAULT_RPC_URL = "http://127.0.0.1:18545";
export const DAPP_PROJECT = "robotmoney-dapp";
export const TESTNET_LABEL = "com.robotmoney.testnet=1";
export const SUMMARY_END = "--- end endpoint summary ---";
/** Canonical Safe v1.4.1 on the Twin chain: publish contracts needs all three. */
export const SAFE_SET: [string, string][] = [
  ["SafeL2 singleton", "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762"],
  ["SafeProxyFactory", "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67"],
  ["CompatibilityFallbackHandler", "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99"],
];
export const VAULT_KEYS = ["rmPROTO", "rmAGENT", "rmRWA"] as const;

/** The exhaustive required-field set. The schema's `required` array must equal it (drift guard). */
export const RECORD_REQUIRED_FIELDS = [
  ".chain_id", ".run_id", ".core_tag", ".core_sha", ".generated_at", ".min_delay", ".deployer",
  ".addresses.gateway", ".addresses.vault", ".addresses.registry", ".addresses.router", ".addresses.governance",
  ".addresses.consensus_receipt", ".addresses.ic_policy", ".addresses.timelock", ".addresses.safe", ".addresses.emergency",
  ".code_hashes.gateway",
  ".vault_addresses.rmUSDC", ".vault_addresses.rmPROTO", ".vault_addresses.rmAGENT", ".vault_addresses.rmRWA",
  ".ephemeral.submitter", ".ephemeral.approver", ".ephemeral.voters", ".ephemeral.emergency",
  ".ephemeral.keystore_dir", ".ephemeral.safe_signers",
];

const USAGE_TEXT = `usage: core-stack <noun> <verb> [flags]
  chain up|down|status [--ref REF] [--timeout SECS] [--out-dir DIR]
  publish args|run [--out-dir DIR]
  governance preflight|ensure|verify|release [--receipt-id ID] [--out-dir DIR]
  parity labels --mainnet FILE [--stage-labels FILE] | parity sheet --production FILE
  dapp status
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
  /** Start a detached process in its own process group, output appended to `logPath`. Returns its pid. */
  spawnDetached(cmd: string[], logPath: string, cwd: string): number;
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
  /** /proc start time of a live (non-zombie) process, or undefined. */
  procStart(pid: number): string | undefined;
  procCmdline(pid: number): string;
  procGroup(pid: number): number | undefined;
  /** kill(2). Negative pid signals a process group. True when the signal was delivered. */
  signal(pid: number, sig: "SIGINT" | "SIGTERM" | 0): boolean;
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
        env: { ...process.env, ...(opts.env ?? {}) },
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
    spawnDetached(cmd, logPath, cwd) {
      const fd = openSync(logPath, "a");
      try {
        const child = spawn(cmd[0]!, cmd.slice(1), { cwd, detached: true, stdio: ["ignore", fd, fd] });
        child.unref();
        return child.pid ?? -1;
      } finally {
        closeSync(fd);
      }
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
    procCmdline(pid) {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
      } catch {
        return "";
      }
    },
    procGroup: (pid) => {
      const s = stat(pid);
      return s ? Number(s[1]) : undefined;
    },
    signal(pid, sig) {
      try {
        process.kill(pid, sig);
        return true;
      } catch {
        return false;
      }
    },
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
  for (const [name, val] of Object.entries({ ref: v.ref, record: v.record, "out-dir": v["out-dir"], mainnet: v.mainnet, production: v.production, "receipt-id": v["receipt-id"], "stage-labels": v["stage-labels"] })) {
    if (val !== undefined && val === "") throw usageError(`--${name} needs a value`);
  }
  return {
    noun,
    verb,
    opts: {
      ref: str(v.ref),
      record: str(v.record),
      outDir: v["out-dir"] ?? DEFAULT_OUT_DIR,
      timeoutSecs,
      receiptId: str(v["receipt-id"]),
      mainnet: str(v.mainnet),
      production: str(v.production),
      stageLabels: str(v["stage-labels"]),
      pathOnly: v.path === true,
      listRequiredFields: v["list-required-fields"] === true,
    },
  };
}

// ─── the stack: context plus helpers ─────────────────────────────────────────
export class Stack {
  readonly summaryPath: string;
  readonly pidFile: string;
  readonly stampPath: string;
  readonly lockPath: string;
  readonly recordPath: string;
  readonly rpcUrl = DEFAULT_RPC_URL;
  readonly rmpc: string;
  readonly rmpcImport: string;
  readonly bun: string;
  readonly cast: string;
  readonly pollMs: number;
  readonly intGraceSecs: number;
  readonly termGraceSecs: number;

  constructor(
    readonly deps: Deps,
    readonly opts: Opts,
  ) {
    this.summaryPath = join(opts.outDir, "core-smoke.log");
    this.pidFile = join(opts.outDir, "core-smoke.pid");
    this.stampPath = join(opts.outDir, "core-stack.stamp");
    this.lockPath = join(opts.outDir, ".core-stack.lock");
    this.recordPath = opts.record || join(opts.outDir, "fusion-stage-record.json");
    this.rmpc = join(deps.repoRoot, "target/debug/rmpc");
    this.rmpcImport = join(deps.repoRoot, "target/debug/rmpc-keystore-import");
    this.bun = deps.env.BUN || "bun";
    this.cast = deps.env.CAST || "cast";
    const poll = Number(deps.env.CORE_STACK_POLL_SECS);
    this.pollMs = (Number.isInteger(poll) && poll > 0 ? poll : 3) * 1000;
    this.intGraceSecs = Number(deps.env.SMOKE_INT_GRACE_SECS) > 0 ? Number(deps.env.SMOKE_INT_GRACE_SECS) : 60;
    this.termGraceSecs = Number(deps.env.SMOKE_TERM_GRACE_SECS) > 0 ? Number(deps.env.SMOKE_TERM_GRACE_SECS) : 30;
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
    const dir = this.needEnv("PUBLISH_CONTRACTS_DIR", "point it at the devops publish-contracts directory");
    const cli = join(dir, "src/cli.ts");
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
    return this.deps.run([this.bun, cli, ...args, ...extra], { env: { PUBLISH_MANIFEST_DIR: mdir }, stream });
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

  // ── process bookkeeping ──
  /** The pid of the live harness the pid file names, or undefined. */
  harnessPid(): number | undefined {
    let text: string;
    try {
      text = readFileSync(this.pidFile, "utf8");
    } catch {
      return undefined;
    }
    const [pidS, start] = text.trim().split(/\s+/);
    const pid = Number(pidS);
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    const now = this.deps.procStart(pid);
    if (now === undefined) return undefined;
    if (start) return now === start ? pid : undefined;
    return /smoke-test/.test(this.deps.procCmdline(pid)) ? pid : undefined;
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
 * else since): rebuild rmpc only.
 */
function stampLine(s: Stack, want: string): Line {
  if (!isFile(s.stampPath)) return { ok: false, line: `not-booted: no completed \`chain up\` stamp at ${s.stampPath}` };
  let st: { commit?: string; pid?: number; start_time?: string } = {};
  try {
    st = JSON.parse(readFileSync(s.stampPath, "utf8"));
  } catch {
    /* malformed */
  }
  if (st.commit !== want) return { ok: false, line: `boot-mismatch: the running chain was booted from '${st.commit ?? "unknown"}', candidate is ${want}` };
  if (!Number.isInteger(st.pid) || !st.start_time) return { ok: false, line: `not-booted: ${s.stampPath} is malformed` };
  if (s.deps.procStart(st.pid!) !== st.start_time) return { ok: false, line: `harness-gone: the harness that booted this chain (pid ${st.pid}) is no longer running` };
  return { ok: true, line: `ok: booted from ${want} by harness pid ${st.pid}` };
}

async function chainStatusLine(s: Stack): Promise<Line> {
  const want = await s.candidateCommit();
  if (!want) return { ok: false, line: `ref-unresolved: '${s.opts.ref || "HEAD"}' is not a branch, tag or commit in this checkout` };
  const st = stampLine(s, want);
  if (!st.ok) return st;
  return chainFactsLine(s, want);
}

async function chainStatus(s: Stack): Promise<void> {
  s.need("docker");
  const l = await chainStatusLine(s);
  s.deps.out(`${l.line}\n`);
  if (!l.ok) throw new StackExit(EXIT.NO, l.line);
}

function writeStamp(s: Stack, commit: string, pid: number, start: string): void {
  const body = { commit, pid, start_time: start, booted_at: new Date(s.deps.nowMs()).toISOString() };
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

async function chainUp(s: Stack): Promise<void> {
  s.need("docker");
  s.needEnv("PUBLISH_CONTRACTS_DIR", "the harness calls publish contracts: point it at the devops publish-contracts directory");
  s.needEnv("STAGE_SHEET", "the harness needs the stage sheet (parameter lines only)");
  const want = await s.candidateCommit();
  if (!want) throw fail(`--ref '${s.opts.ref || "HEAD"}' is not a branch, tag or commit in this checkout`, EXIT.INPUT);
  const headR = await s.deps.run(["git", "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const head = headR.code === 0 ? headR.stdout.trim() : "";
  if (want !== head) throw fail(`--ref '${s.opts.ref || "HEAD"}' is ${want}, but this checkout is at ${head || "nothing"}: check the ref out first`, EXIT.INPUT);
  const release = s.takeLock();
  try {
    const cur = await chainStatusLine(s);
    if (cur.ok) {
      s.log("the candidate is already up and healthy; starting nothing");
      s.deps.out(`${cur.line}\n`);
      return;
    }
    const live = s.harnessPid();
    if (live !== undefined) throw fail(`an earlier harness (pid ${live}) is still running but is not the healthy candidate; run \`core-stack chain down\` first`);
    for (const f of [s.stampPath, s.pidFile]) rmQuiet(f);
    // Truncated before the harness exists; the harness only appends.
    writeFileSync(s.summaryPath, "");
    await s.rebuildRmpc();
    // The Twin chain is the harness default backend (geth). No fork, no anvil.
    const pid = s.deps.spawnDetached(
      ["stdbuf", "-oL", "-eL", "cargo", "run", "-p", "smoke-test", "--", "--full-stack", "--rpc-port", "18545", "--explorer-port", "18546", "--dapp-port", "5173",
        "--public-rpc-url", "https://stage-rpc.robotmoney-labs.dev", "--public-explorer-url", "https://stage-explorer.robotmoney-labs.dev",
        "--public-dapp-url", "https://stage-dapp.robotmoney-labs.dev", "--no-receipt-fixtures"],
      s.summaryPath,
      s.deps.repoRoot,
    );
    const start = pid > 0 ? s.deps.procStart(pid) : undefined;
    if (start === undefined) {
      tailLog(s);
      throw fail("the harness exited as soon as it started");
    }
    writeFileSync(s.pidFile, `${pid} ${start}\n`);
    s.log("harness started", { pid, log: s.summaryPath, timeoutSecs: s.opts.timeoutSecs });
    const deadline = s.deps.nowMs() + s.opts.timeoutSecs * 1000;
    while (s.deps.nowMs() < deadline) {
      if (s.harnessPid() === undefined) {
        rmQuiet(s.pidFile);
        tailLog(s);
        throw fail("the harness exited before printing its endpoint summary");
      }
      if (s.summaryComplete()) {
        s.log("endpoint summary printed");
        const facts = await chainFactsLine(s, want);
        if (!facts.ok) throw fail(`the harness printed its summary but the stack is not the healthy candidate: ${facts.line}`);
        writeStamp(s, want, pid, start);
        const st = await chainStatusLine(s);
        if (!st.ok) {
          rmQuiet(s.stampPath);
          throw fail(`the harness printed its summary but the stack is not the healthy candidate: ${st.line}`);
        }
        s.deps.out(`${st.line}\n`);
        return;
      }
      await s.deps.sleep(s.pollMs);
    }
    tailLog(s);
    throw fail(`no endpoint summary within ${s.opts.timeoutSecs}s; the harness (pid ${pid}) is still running: \`core-stack chain down\` stops it`);
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

/** True once nothing in `target` is left. */
async function signalAndWait(s: Stack, sig: "SIGINT" | "SIGTERM", secs: number, target: number): Promise<boolean> {
  s.deps.signal(target, sig);
  for (let i = 0; i < secs; i++) {
    if (!s.deps.signal(target, 0)) return true;
    await s.deps.sleep(1000);
  }
  return !s.deps.signal(target, 0);
}

async function stopHarness(s: Stack): Promise<void> {
  if (!isFile(s.pidFile)) return;
  const [pidS, start] = readFileSync(s.pidFile, "utf8").trim().split(/\s+/);
  const pid = Number(pidS);
  const liveStart = Number.isInteger(pid) && pid > 0 ? s.deps.procStart(pid) : undefined;
  if (liveStart === undefined) {
    s.log("pid file names no running process; clearing it");
    rmQuiet(s.pidFile);
    return;
  }
  if (start && start !== liveStart) {
    s.log("pid now belongs to another process; not signalling it", { pid });
    rmQuiet(s.pidFile);
    return;
  }
  if (!start && !/smoke-test/.test(s.deps.procCmdline(pid))) {
    s.log("pid is not the smoke harness; not signalling it", { pid });
    rmQuiet(s.pidFile);
    return;
  }
  const target = s.deps.procGroup(pid) === pid ? -pid : pid;
  s.log("stopping the smoke harness", { pid, target });
  if (!(await signalAndWait(s, "SIGINT", s.intGraceSecs, target))) {
    s.log(`the harness ignored SIGINT for ${s.intGraceSecs}s; sending SIGTERM`, {}, "warn");
    if (!(await signalAndWait(s, "SIGTERM", s.termGraceSecs, target))) throw fail(`core smoke harness (pid ${pid}) survived SIGINT and SIGTERM`);
  }
  rmQuiet(s.pidFile);
}

async function chainDown(s: Stack): Promise<void> {
  const release = s.takeLock();
  try {
    // The stamp goes first: from here on nothing vouches for the running chain.
    rmQuiet(s.stampPath);
    await stopHarness(s);
    // The compose file's `:?` guards interpolate even for `down`.
    const compose = join(s.deps.repoRoot, "testing/ethereum-testnet/config/docker-compose.dapp.yaml");
    const env = { INDEXER_GATEWAY: "teardown", INDEXER_VAULT: "teardown", VITE_GATEWAY_ADDRESS: "teardown", VITE_VAULT_ADDRESS: "teardown", VITE_GATEWAY_EXPECTED_CODE_HASH: "teardown", COMPOSE_PROFILES: "receipt-fixtures" };
    const r = await s.deps.run(["docker", "compose", "--project-name", DAPP_PROJECT, "-f", compose, "down"], { env });
    if (r.code !== 0) throw fail("dapp stack down failed");
    s.log("down done");
  } finally {
    release();
  }
}

// ─── publish ─────────────────────────────────────────────────────────────────
/** After a publish run every one of the four vaults has a manifest: rmUSDC in core.json, one vault-<key>.json for each other. */
export function countVaultManifests(mdir: string): number {
  let n = existsSync(join(mdir, "core.json")) ? 1 : 0;
  for (const k of VAULT_KEYS) if (existsSync(join(mdir, `vault-${k}.json`))) n++;
  return n;
}

async function publishVerb(s: Stack, verb: string): Promise<void> {
  if (verb === "args") {
    s.deps.out((await s.publishArgs("publish")).join("\n") + "\n");
  } else if (verb === "run") {
    const r = await s.publishContracts("publish", [], true);
    if (r.code !== 0) throw new StackExit(r.code, `publish contracts exited ${r.code}`);
    const mdir = s.sv("manifest_dir");
    const n = countVaultManifests(mdir);
    if (n !== 4) throw fail(`publish contracts wrote ${n} of 4 vault manifests in ${mdir} (rmUSDC, rmPROTO, rmAGENT, rmRWA)`);
    s.log("four vault manifests present", { mdir });
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
  const n = readdirSync(mdir).filter((f) => /^vault-.*\.json$/.test(f)).length;
  if (!existsSync(join(mdir, "core.json")) || n < 3) throw unsatisfied("vault-manifests-missing", `want core.json (rmUSDC) plus three vault-*.json manifests in ${mdir}, found ${n}`);
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
  const core = m("core.json");
  const reg = m("registry.json");
  const rtr = m("router.json");
  const gov = m("governance.json");
  const ic = m("ic-policy.json");
  const tlk = m("timelock.json");
  const safe = m("safe.json");
  const vaults: Record<string, Json> = Object.fromEntries(VAULT_KEYS.map((k) => [k, m(`vault-${k}.json`)]));
  const call = async (cmd: string[]): Promise<string> => {
    const r = await s.deps.run(cmd);
    if (r.code !== 0) throw fail(`${cmd.slice(0, 2).join(" ")} failed: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  const delayOut = await call([s.cast, "call", String(tlk.timelock), "getMinDelay()(uint256)", "--rpc-url", s.rpcUrl]);
  const code = await call([s.cast, "code", String(core.gateway), "--rpc-url", s.rpcUrl]);
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
      gateway: core.gateway,
      vault: core.vault,
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
    vault_addresses: { rmUSDC: core.vault, rmPROTO: vaults.rmPROTO!.vault, rmAGENT: vaults.rmAGENT!.vault, rmRWA: vaults.rmRWA!.vault },
    ephemeral: {
      submitter: sg("AGENT_ADDRESS"),
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
    ".ephemeral.submitter", ".ephemeral.approver", ".ephemeral.emergency", ".ephemeral.voters[0]", ".ephemeral.voters[1]",
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
        if (verb !== "status") throw usageError();
        await dappStatus(s);
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
