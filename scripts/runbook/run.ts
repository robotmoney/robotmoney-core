#!/usr/bin/env bun
// scripts/runbook/run.ts: runs a contract QA release file (docs/runbooks/contract-qa/releases/<release>.yaml) on one target, step by step, from the
// first step that runs on that target to the last. It is the one way a release runs, on the Twin and on 8453 (README "Run it").
//   bun scripts/runbook/run.ts --release v0.6.0 --target twin|rehearsal|production --config FILE [--from ID] [--to ID] [--dry-run]
// The config is a JSON file outside the repo: {"scalars": {name: value}, "lists": {name: [argv...]}}. Scalars are the README placeholders ({runDir},
// {rpcUrl}, {sheet}, ...). Lists override a whole-element placeholder for the target ({owners}, {v050owners}, {cast}: empty on the Twin where the
// default keystores sign). A keystore spec is a path; the passphrase is typed at the CLI's own prompt on this terminal, never written in the config.
// For every step that runs on the target (onlyFor, and the release's flows for the target): a step whose result is already `pass` is not run again
// (a rerun after a failure continues); `gateAbsent` (a path, or a list of paths that must all exist) and `sheetIs` write a `skip` result; `go` must exist; `notBefore` is waited out here, from the
// earlier step's result time plus its hours (the sheet's TIMELOCK_MIN_DELAY for "timelockDelay"). Each command runs from the checkout root with the
// step's env, stdin on this terminal, stdout appended to {runDir}/journal/<id>.out and stderr to <id>.err (both also shown). The exit code must be
// one of expectExit, every required receipt must exist, else the step's result is `fail exit <n>` and the run stops with exit 1. Nothing is skipped
// by an option: there is no --skip. --from and --to bound a continuation only; the report lists any step without a result as an issue, so a bounded
// run cannot sign off. --dry-run prints the resolved commands and writes nothing. Exit 2 is a usage or validation error.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactUrls } from "./run-record.ts";
import { LIST_PLACEHOLDERS, ROOT, SCALARS, TARGET_NAMES, applicableSteps, gateAbsentPaths, parseSheetText, runnableProblems, validateAll, type ReleaseRunbook, type RunbookStep } from "./validate-contract-qa.ts";

export interface RunConfig { scalars: Record<string, string>; lists?: Record<string, string[]> }
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)(?::([A-Za-z0-9_.\-]+))?\}/g;

/** PURE. A config from its JSON text: scalars are strings, lists are argv lists, and every scalar is a README placeholder. */
export function parseConfig(text: string): RunConfig {
  const j = JSON.parse(text) as RunConfig;
  if (typeof j !== "object" || j === null || typeof j.scalars !== "object" || j.scalars === null) throw new Error("the config is {scalars: {...}, lists?: {...}}");
  for (const [k, v] of Object.entries(j.scalars)) {
    if (!SCALARS.has(k)) throw new Error(`config scalar '${k}' is no placeholder of README.md`);
    if (typeof v !== "string") throw new Error(`config scalar '${k}' is not a string`);
  }
  for (const [k, v] of Object.entries(j.lists ?? {})) {
    if (!(k in LIST_PLACEHOLDERS)) throw new Error(`config list '${k}' is no whole-element placeholder (${Object.keys(LIST_PLACEHOLDERS).join(", ")})`);
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`config list '${k}' is not a list of strings`);
  }
  return j;
}

/** PURE. Why a config cannot run the upgrade flow on 8453: the report reads {manifestDir} and {evidenceDir}, the flow writes {v050ManifestDir} and {v050EvidenceDir}, so on the rehearsal they must be the same directories. */
export function configProblems(cfg: RunConfig, target: string): string[] {
  if (target === "twin") {
    // ssh adds a 17-character suffix while it creates a control socket and a unix socket path holds 107 bytes: a longer run directory makes every tunnel step fail.
    const sock = `${cfg.scalars.runDir ?? ""}/tunnel-8545.sock`;
    return sock.length > 90 ? [`on the twin target the tunnel control socket path (${sock.length} characters) must be 90 or fewer: use a shorter {runDir}`] : [];
  }
  if (target !== "rehearsal") return [];
  const sc = cfg.scalars;
  return [["manifestDir", "v050ManifestDir"], ["evidenceDir", "v050EvidenceDir"]].filter(([a, b]) => sc[a!] !== sc[b!]).map(([a, b]) => `on the rehearsal target {${a}} (${sc[a!] ?? "unset"}) must equal {${b}} (${sc[b!] ?? "unset"}): the report reads the first, the upgrade flow writes the second`);
}

/** The resolver of one run: every placeholder kind of README.md, read at the moment a step runs. */
export class Resolver {
  /** dry: a manifest or state file an earlier step would write resolves to <m:...> or <state:...> instead of failing (a dry run executes nothing). */
  constructor(private readonly cfg: RunConfig, private readonly env: Record<string, string | undefined> = process.env, private readonly dry = false) {}
  scalar(name: string): string {
    const v = this.cfg.scalars[name];
    if (v === undefined) throw new Error(`placeholder {${name}} has no value in the config`);
    return this.text(v);
  }
  text(s: string): string {
    return s.replace(PLACEHOLDER, (raw, kind: string, arg?: string) => {
      if (arg === undefined) {
        if (kind in LIST_PLACEHOLDERS) throw new Error(`list placeholder ${raw} inside a string: it must be a whole argv element`);
        return this.scalar(kind);
      }
      if (kind === "env") return this.env[arg] ?? "";
      if (kind === "sheet") { const v = parseSheetText(readFileSync(this.scalar("sheet"), "utf8"))[arg]; if (v === undefined) throw new Error(`the run sheet has no ${arg}`); return v; }
      if (kind === "m") {
        const [file, key] = arg.split(".");
        const p = join(this.scalar("manifestDir"), `${file}.json`);
        if (!existsSync(p)) { if (this.dry) return `<m:${arg}>`; throw new Error(`manifest ${p} does not exist`); }
        const v = (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>)[key!];
        if (v === undefined) throw new Error(`manifest ${file}.json has no ${key}`);
        return String(v);
      }
      if (kind === "state") { const p = join(this.scalar("runDir"), "state", arg); if (!existsSync(p)) { if (this.dry) return `<state:${arg}>`; throw new Error(`state ${arg} was not written (${p})`); } return readFileSync(p, "utf8").trim(); }
      if (kind === "journal") return join(this.scalar("runDir"), "journal", `${arg}.out`);
      throw new Error(`unknown placeholder ${raw}`);
    });
  }
  /** One argv with whole-element list placeholders expanded (the config's list for the target, else the README definition) and every string resolved. */
  argv(cmd: string[]): string[] {
    return cmd.flatMap((a) => {
      const m = /^\{([a-z0-9]+)\}$/i.exec(a);
      if (m && m[1]! in LIST_PLACEHOLDERS) return (this.cfg.lists?.[m[1]!] ?? LIST_PLACEHOLDERS[m[1]!]!).map((x) => this.text(x));
      return [this.text(a)];
    });
  }
}

const resultPath = (runDir: string, id: string): string => join(runDir, "journal", `${id}.result`);
const readResult = (runDir: string, id: string): string | undefined => (existsSync(resultPath(runDir, id)) ? readFileSync(resultPath(runDir, id), "utf8").trim() : undefined);
function writeResult(runDir: string, id: string, result: string): void {
  mkdirSync(join(runDir, "journal"), { recursive: true });
  writeFileSync(resultPath(runDir, id), `${result}\n`);
}

/** PURE. When a step may start: the earlier step's result time plus its hours, in epoch seconds. */
export function readyAt(resultMtimeMs: number, hours: number | "timelockDelay", timelockDelaySeconds: number): number {
  return Math.floor(resultMtimeMs / 1000) + (hours === "timelockDelay" ? timelockDelaySeconds : Math.round(hours * 3600));
}

const sleep = (s: number): void => { spawnSync("sleep", [String(s)], { stdio: "inherit" }); };

/** Runs one command of a step: stdin on this terminal, stdout and stderr shown and appended to the journal. Returns its exit code. */
function runCommand(argv: string[], env: Record<string, string>, out: string, err: string, maxMinutes?: number): number {
  const prefix = maxMinutes === undefined ? [] : ["timeout", "--foreground", `${maxMinutes}m`];
  const r = spawnSync("bash", ["-c", 'exec "$@" > >(tee -a "$RUNBOOK_OUT") 2> >(tee -a "$RUNBOOK_ERR" >&2)', "_", ...prefix, ...argv], {
    cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env, RUNBOOK_OUT: out, RUNBOOK_ERR: err },
  });
  return r.status ?? 1;
}

/** Runs one step. Returns its result line. Throws nothing: a failure, a placeholder that does not resolve included, is a result. */
/** PURE. Whether a step runs again: not after a `pass`, unless it is marked `refresh` (it re-reads state, and every invocation must). */
export const shouldRun = (prior: string | undefined, step: Pick<RunbookStep, "refresh">): boolean => prior !== "pass" || step.refresh === true;

/** PURE. A publish-contracts publish that failed on an earlier invocation continues with --resume (the CLI refuses a rerun without it: NONCE, "manifest already exists"). */
export function withResume(argv: string[], resume: boolean): string[] {
  const cli = argv.findIndex((a) => a.endsWith("publish-contracts/src/cli.ts"));
  if (!resume || cli < 0 || argv[cli + 1] !== "publish" || argv.includes("--resume") || argv.includes("--dry-run")) return argv;
  return [...argv, "--resume"];
}

export function runStep(step: RunbookStep, r: Resolver, opts: { runDir: string; sheetDelay: number; dryRun: boolean; resume?: boolean; log: (s: string) => void }): string {
  try { return stepResult(step, r, opts); } catch (e) { return `fail ${(e as Error).message}`; }
}
function stepResult(step: RunbookStep, r: Resolver, opts: { runDir: string; sheetDelay: number; dryRun: boolean; resume?: boolean; log: (s: string) => void }): string {
  const { runDir, log } = opts;
  const exits = Array.isArray(step.expectExit) ? step.expectExit : [step.expectExit];
  if (step.host !== "control") return `fail host ${step.host}: this runner runs control steps only`;
  if (step.gateAbsent !== undefined) {
    const paths = gateAbsentPaths(step).map((p) => r.text(p));
    if (paths.every((p) => existsSync(p))) return `skip gateAbsent ${paths.join(" ")} ${paths.length === 1 ? "exists" : "all exist"}`;
  }
  if (step.sheetIs !== undefined) {
    const sheet = parseSheetText(readFileSync(r.scalar("sheet"), "utf8"));
    const miss = Object.entries(step.sheetIs).find(([k, v]) => sheet[k] !== v);
    if (miss) return `skip sheetIs ${miss[0]} is ${sheet[miss[0]] ?? "absent"}, not ${miss[1]}`;
  }
  if (step.go !== undefined && !existsSync(join(runDir, "go", `${step.go}.json`))) return `fail go ${step.go} is not recorded (${join(runDir, "go", `${step.go}.json`)})`;
  if (step.notBefore !== undefined && opts.dryRun) log(`${step.id}: notBefore ${step.notBefore.afterStep} + ${step.notBefore.hours === "timelockDelay" ? `${opts.sheetDelay} s` : `${step.notBefore.hours} h`}`);
  else if (step.notBefore !== undefined) {
    const after = resultPath(runDir, step.notBefore.afterStep);
    if (!existsSync(after)) return `fail notBefore ${step.notBefore.afterStep} has no result`;
    const ready = readyAt(statSync(after).mtimeMs, step.notBefore.hours, opts.sheetDelay);
    const wait = ready - Math.floor(Date.now() / 1000);
    if (wait > 0 && !opts.dryRun) { log(`${step.id}: notBefore ${step.notBefore.afterStep} + ${step.notBefore.hours === "timelockDelay" ? `${opts.sheetDelay} s` : `${step.notBefore.hours} h`}: waiting ${wait} s (ready ${new Date(ready * 1000).toISOString()})`); sleep(wait); }
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(step.env ?? {})) { const x = r.text(v); if (x !== "") env[k] = x; }
  const out = join(runDir, "journal", `${step.id}.out`), err = join(runDir, "journal", `${step.id}.err`);
  for (const cmd of step.cmds) {
    const argv = withResume(r.argv(cmd), opts.resume === true);
    log(`${step.id}$ ${redactUrls(argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" "))}`);
    if (opts.dryRun) continue;
    mkdirSync(join(runDir, "journal"), { recursive: true });
    const code = runCommand(argv, env, out, err, step.maxMinutes);
    if (!exits.includes(code)) return `fail exit ${code}`;
  }
  if (!opts.dryRun) for (const rc of step.receipts) {
    if (!rc.required) continue;
    const dir = r.text(rc.dir), pattern = r.text(rc.pattern);
    const found = existsSync(dir) && [...new Bun.Glob(pattern).scanSync({ cwd: dir, dot: true, onlyFiles: false })].length > 0;
    if (!found) return `fail receipt ${pattern} missing in ${dir}`;
  }
  return "pass";
}

/** PURE. The steps to run: the applicable ones, bounded by --from and --to (each must be one of them). */
export function stepsToRun(release: ReleaseRunbook, target: string, from?: string, to?: string): RunbookStep[] {
  const steps = applicableSteps(release, target);
  const index = (id: string | undefined, what: string): number => { if (id === undefined) return -1; const i = steps.findIndex((s) => s.id === id); if (i < 0) throw new Error(`--${what} ${id} is no step that runs on ${target}`); return i; };
  const a = index(from, "from"), b = index(to, "to");
  return steps.slice(a < 0 ? 0 : a, b < 0 ? steps.length : b + 1);
}

async function main(argv: string[]): Promise<number> {
  const { parseArgs } = await import("node:util");
  let v;
  try {
    v = parseArgs({ args: argv, strict: true, options: { release: { type: "string" }, target: { type: "string" }, config: { type: "string" }, from: { type: "string" }, to: { type: "string" }, "dry-run": { type: "boolean" } } }).values;
  } catch (e) { console.error(`usage: ${(e as Error).message}`); return 2; }
  if (!v.release || !v.target || !v.config) { console.error("usage: --release R --target T --config FILE [--from ID] [--to ID] [--dry-run]"); return 2; }
  if (!(TARGET_NAMES as readonly string[]).includes(v.target)) { console.error(`--target is ${TARGET_NAMES.join(" | ")}`); return 2; }
  const all = validateAll();
  if (all.problems.length > 0) { for (const p of all.problems) console.error(p); console.error("run: the runbook is not valid; nothing runs"); return 2; }
  const release = all.releases.get(v.release);
  if (!release) { console.error(`no release runbook docs/runbooks/contract-qa/releases/${v.release}.yaml`); return 2; }
  const notRunnable = runnableProblems(release, v.target);
  if (notRunnable.length > 0) { for (const p of notRunnable) console.error(p); return 2; }
  let cfg: RunConfig, steps: RunbookStep[];
  try { cfg = parseConfig(readFileSync(v.config, "utf8")); steps = stepsToRun(release, v.target, v.from, v.to); } catch (e) { console.error(`run: ${(e as Error).message}`); return 2; }
  const bad = configProblems(cfg, v.target);
  if (bad.length > 0) { for (const p of bad) console.error(`run: ${p}`); return 2; }
  const r = new Resolver(cfg, process.env, v["dry-run"] === true);
  if (cfg.scalars.release !== undefined && cfg.scalars.release !== v.release) { console.error(`run: the config names release ${cfg.scalars.release}, the command ${v.release}`); return 2; }
  if (cfg.scalars.target !== undefined && cfg.scalars.target !== v.target) { console.error(`run: the config names target ${cfg.scalars.target}, the command ${v.target}`); return 2; }
  const runDir = r.scalar("runDir");
  const log = (s: string): void => { console.error(`[run ${new Date().toISOString()}] ${s}`); };
  log(`${v.release} on ${v.target}: ${steps.length} step(s) from ${steps[0]?.id} to ${steps.at(-1)?.id}${v["dry-run"] ? " (dry run)" : ""}`);
  for (const step of steps) {
    const prior = readResult(runDir, step.id);
    if (!shouldRun(prior, step)) { log(`${step.id}: already passed`); continue; }
    const sheetDelay = (() => { try { return Number(parseSheetText(readFileSync(r.scalar("sheet"), "utf8")).TIMELOCK_MIN_DELAY ?? 0); } catch { return 0; } })();
    const result = runStep(step, r, { runDir, sheetDelay, dryRun: v["dry-run"] === true, resume: prior?.startsWith("fail") === true && step.irreversible, log });
    if (!v["dry-run"]) writeResult(runDir, step.id, result);
    log(`${step.id}: ${result}`);
    if (result.startsWith("fail")) { log(`stopped at ${step.id}. Fix the cause, then run the same command again: a passed step is not repeated.`); return 1; }
  }
  log(`done: every step from ${steps[0]?.id} to ${steps.at(-1)?.id} passed or was skipped by its own gate. The run is complete only when P10.52-record-signoff wrote go/signoff.json.`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
