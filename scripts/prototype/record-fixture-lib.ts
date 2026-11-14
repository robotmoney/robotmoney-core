// One-vault experiment (docs/technical/one-vault-rebalancer-proposal.md).
//
// The logic of scripts/prototype/record-base-fixture.ts that needs no forge, no anvil and no network: passes and
// units, unit keys (import closure and runtime inputs), forge JSON results and the per-test proof classes, the
// fixture model (read, merge a recording, write), the pass state and manifests, batches and lanes, and lane build
// dirs. The design is in the recorder's header. Tests: scripts/prototype/record-base-fixture.test.ts (this logic) and
// scripts/prototype/record-base-fixture.flow.test.ts (the recorder's rounds against a fake forge).

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";

/** Bump to invalidate every unit's recorded result (a change in what the recorder proves or how). */
export const SCRIPT_KEY_VERSION = "record-fixture-v1";

export const PROTOTYPE_DIR = "contracts/test/prototype";
export const FIXTURE_DIR = `${PROTOTYPE_DIR}/fixtures`;
export const ALLOC_FILE = `${FIXTURE_DIR}/base-state.alloc.json`;
export const META_FILE = `${FIXTURE_DIR}/base-state.meta.json`;
export const PASSES_FILE = `${FIXTURE_DIR}/base-state.passes.json`;
export const MANIFEST_FILE = `${FIXTURE_DIR}/base-state.manifest.json`;
/** Read at runtime by every BaseFixture test, but covered by the fixture lineage, not the unit key. */
export const FIXTURE_FILES = new Set([ALLOC_FILE, META_FILE, PASSES_FILE, MANIFEST_FILE]);

export const SIM_PATH = `${PROTOTYPE_DIR}/sim/*`;
export const SIM_RUNS = [
  "default-lprecenter",
  "auction-lprecenter",
  "tuned",
  "default",
  "timed-tuned",
  "timed-default",
  "auction",
];

/** Forge's own addresses. Loading them would overwrite the test contract or the cheatcode stub. */
export const FORGE_INTERNAL = new Set([
  "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d", // cheatcodes
  "0x7fa9385be102ac3eac297483dd6233d62b3e1496", // default test contract
  "0x1804c8ab1f12e6bbf3894d4083f33e07309d1f38", // default sender
  "0x000000000000000000636f6e736f6c652e6c6f67", // console.log
]);

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

// ─── passes and units ───────────────────────────────────────────────────────────────────────────

export type Env = Record<string, string>;
export type Pass = { label: string; run: string; path: string; env: Env };

/** "<run>-lprecenter": PROTO_SIM_RUN=<run> with the LP re-centre switch. "timed-<run>": the timed-flow sim on the
 *  live fund; timed-default also runs the sim attacks. Otherwise the synchronous sim with static LP. */
export function simEnv(r: string): Env {
  if (r.endsWith("-lprecenter")) {
    return { PROTO_SIM: "1", PROTO_SIM_RUN: r.slice(0, -"-lprecenter".length), PROTO_SIM_LP: "recenter" };
  }
  if (r.startsWith("timed-")) {
    const run = r.slice("timed-".length);
    return {
      PROTO_SIM: "1",
      PROTO_SIM_RUN: run,
      PROTO_SIM_LP: "static",
      PROTO_SIM_FLOWS: "timed",
      ...(run === "default" ? { PROTO_SIM_ATTACKS: "1" } : {}),
    };
  }
  return { PROTO_SIM: "1", PROTO_SIM_RUN: r, PROTO_SIM_LP: "static" };
}

/** The old script's passes, unchanged: without --sim one pass over matchPath; with --sim one pass per selected run
 *  over the sim files, the last one over matchPath (every prototype test) under that run's environment. */
export function planPasses(o: { withSim: boolean; simRuns: string[]; matchPath: string }): Pass[] {
  if (!o.withSim) return [{ label: "prototype", run: "prototype", path: o.matchPath, env: {} }];
  for (const r of o.simRuns) if (!SIM_RUNS.includes(r)) throw new Error(`--sim-runs: unknown run ${r}`);
  const runs = SIM_RUNS.filter((r) => o.simRuns.includes(r));
  if (runs.length === 0) throw new Error("--sim-runs names no run");
  return runs.map((r, i) =>
    i === runs.length - 1
      ? { label: `prototype + sim ${r}`, run: r, path: o.matchPath, env: simEnv(r) }
      : { label: `sim ${r}`, run: r, path: SIM_PATH, env: simEnv(r) },
  );
}

/** `forge test --list --json`: file -> contract -> test names (no parameter list). */
export type Listing = Record<string, Record<string, string[]>>;

/** A test file under one pass's environment. `tests` are "Contract.name" ids. */
export type Unit = { id: string; file: string; run: string; env: Env; pass: string; tests: string[] };

export function planUnits(passes: Pass[], listings: Map<string, Listing>): Unit[] {
  const units: Unit[] = [];
  for (const p of passes) {
    const listing = listings.get(p.path);
    if (!listing) throw new Error(`no test listing for ${p.path}`);
    for (const file of Object.keys(listing).sort()) {
      const tests = Object.entries(listing[file])
        .flatMap(([c, ts]) => ts.map((t) => `${c}.${t}`))
        .sort();
      if (tests.length === 0) continue;
      units.push({ id: `${file}@${p.run}`, file, run: p.run, env: p.env, pass: p.label, tests });
    }
  }
  return units;
}

// ─── sources: import closure, runtime inputs, key ───────────────────────────────────────────────

/** Replaces comments with spaces (newlines kept), leaving string literals intact. */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && n === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      out += " ".repeat(j - i);
      i = j;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const j = end < 0 ? src.length : end + 2;
      out += src.slice(i, j).replace(/[^\n]/g, " ");
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export function parseImports(stripped: string): string[] {
  const out: string[] = [];
  const re = /\bimport\s+(?:[^;"']*?\bfrom\s+)?["']([^"']+)["'][^;]*;/g;
  for (let m = re.exec(stripped); m; m = re.exec(stripped)) out.push(m[1]);
  return out;
}

export type ProjectConfig = { root: string; remappings: [string, string][]; libs: string[]; tomlHash: string };

export function loadProjectConfig(root: string): ProjectConfig {
  const text = readFileSync(join(root, "foundry.toml"), "utf8");
  const toml = Bun.TOML.parse(text) as any;
  const prof = toml.profile?.default ?? {};
  if (existsSync(join(root, "remappings.txt"))) throw new Error("remappings.txt is not supported by the recorder key");
  if (prof.auto_detect_remappings !== false) {
    throw new Error("foundry.toml must set auto_detect_remappings = false (the recorder resolves imports itself)");
  }
  const remappings = ((prof.remappings ?? []) as string[]).map((r) => {
    const eq = r.indexOf("=");
    if (eq < 0 || r.slice(0, eq).includes(":")) throw new Error(`unsupported remapping ${r}`);
    return [r.slice(0, eq), r.slice(eq + 1)] as [string, string];
  });
  remappings.sort((a, b) => b[0].length - a[0].length);
  return { root, remappings, libs: prof.libs ?? ["lib"], tomlHash: sha256(text) };
}

export function resolveImport(from: string, spec: string, cfg: ProjectConfig): string {
  let p: string;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    p = posix.normalize(posix.join(posix.dirname(from), spec));
  } else {
    const r = cfg.remappings.find(([prefix]) => spec.startsWith(prefix));
    p = r ? posix.normalize(r[1] + spec.slice(r[0].length)) : posix.normalize(spec);
    if (!r && !existsSync(join(cfg.root, p))) {
      const viaLib = cfg.libs.map((l) => posix.join(l, spec)).find((c) => existsSync(join(cfg.root, c)));
      if (viaLib) p = viaLib;
    }
  }
  if (!existsSync(join(cfg.root, p))) throw new Error(`${from}: cannot resolve import "${spec}"`);
  return p;
}

export class SourceIndex {
  private text = new Map<string, string>();
  private stripped = new Map<string, string>();
  private imports = new Map<string, string[]>();
  private hashes = new Map<string, string>();
  private closures = new Map<string, string[]>();
  constructor(readonly cfg: ProjectConfig) {}

  read(p: string): string {
    let t = this.text.get(p);
    if (t === undefined) {
      t = readFileSync(join(this.cfg.root, p), "utf8");
      this.text.set(p, t);
    }
    return t;
  }
  strippedOf(p: string): string {
    let s = this.stripped.get(p);
    if (s === undefined) {
      s = stripComments(this.read(p));
      this.stripped.set(p, s);
    }
    return s;
  }
  hash(p: string): string {
    let h = this.hashes.get(p);
    if (h === undefined) {
      h = sha256(readFileSync(join(this.cfg.root, p)));
      this.hashes.set(p, h);
    }
    return h;
  }
  directImports(p: string): string[] {
    let d = this.imports.get(p);
    if (d === undefined) {
      d = [...new Set(parseImports(this.strippedOf(p)).map((s) => resolveImport(p, s, this.cfg)))].sort();
      this.imports.set(p, d);
    }
    return d;
  }
  /** The file and everything it imports, transitively, sorted. */
  closure(file: string): string[] {
    const memo = this.closures.get(file);
    if (memo) return memo;
    const seen = new Set<string>();
    const stack = [file];
    while (stack.length) {
      const f = stack.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      stack.push(...this.directImports(f));
    }
    const out = [...seen].sort();
    this.closures.set(file, out);
    return out;
  }
}

const isLib = (cfg: ProjectConfig, p: string) => cfg.libs.some((l) => p === l || p.startsWith(`${l}/`));

const DYNAMIC_READ =
  /\b(vm\.(?:readFile|readFileBinary|readLine|readDir|fsMetadata|ffi|tryFfi|getCode|getDeployedCode|loadAllocs|exists|isFile|isDir|projectRoot)|deployCode(?:To)?)\s*\(/g;
const ALWAYS_UNRESOLVABLE = /^(vm\.(ffi|tryFfi|getCode|getDeployedCode|projectRoot)|deployCode(To)?)$/;
const STRING_CONST = /\bstring\s+((?:\w+\s+)+?)(\w+)\s*=\s*"([^"]*)"/g;

/** What a unit's sources tell before any run. */
export type StaticInfo = {
  closure: string[];
  /** Repo files named by a string literal in the closure (outside libs): read at runtime. Fixture files excluded. */
  runtimeFiles: string[];
  /** Env names (or name prefixes ending in "_") the closure names in string literals. */
  envNames: string[];
  /** No closure file but BaseFixture.sol consumes or restarts the state diff, or sets the check flags. */
  strictCapable: boolean;
  /** Some closure file but BaseFixture.sol loads allocs or forks by itself. */
  ownsFixture: boolean;
};

export function analyzeUnit(idx: SourceIndex, file: string): StaticInfo {
  const cfg = idx.cfg;
  const closure = idx.closure(file);
  const own = closure.filter((p) => !isLib(cfg, p));
  const consts = new Map<string, string>();
  for (const p of own) {
    const s = idx.strippedOf(p);
    for (const m of s.matchAll(STRING_CONST)) if (/\bconstant\b/.test(m[1])) consts.set(m[2], m[3]);
  }
  const runtime = new Set<string>();
  const envNames = new Set<string>();
  const errors: string[] = [];
  let strictCapable = true;
  let ownsFixture = false;
  for (const p of own) {
    const s = idx.strippedOf(p);
    for (const m of s.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)) {
      const lit = m[1] ?? m[2] ?? "";
      if (/^[A-Z][A-Z0-9_]*$/.test(lit)) envNames.add(lit);
      if (lit.includes("/") && !lit.includes("..") && !lit.startsWith("/") && lit.length < 300) {
        const norm = posix.normalize(lit);
        if (existsSync(join(cfg.root, norm)) && statSync(join(cfg.root, norm)).isFile() && !FIXTURE_FILES.has(norm)) {
          runtime.add(norm);
        }
      }
    }
    if (p.endsWith("/BaseFixture.sol")) continue;
    if (/\b(stopAndReturnStateDiff|startStateDiffRecording)\s*\(|\bfixture(Check|Strict)\s*=[^=]/.test(s)) {
      strictCapable = false;
    }
    if (/\b(loadAllocs|createSelectFork|createFork|selectFork|rollFork)\s*\(/.test(s)) ownsFixture = true;
    for (const m of s.matchAll(DYNAMIC_READ)) {
      const fn = m[1];
      const line = s.slice(0, m.index).split("\n").length;
      const arg = firstArg(s, m.index! + m[0].length);
      const resolved =
        !ALWAYS_UNRESOLVABLE.test(fn) &&
        (/^"[^"]*"$/.test(arg) || (/^[A-Za-z_]\w*$/.test(arg) && consts.has(arg)));
      if (!resolved) errors.push(`${p}:${line}: ${fn}(${arg}) reads a file the recorder cannot key`);
    }
  }
  if (errors.length) throw new Error(`unit ${file}: ${errors.join("; ")}`);
  return { closure, runtimeFiles: [...runtime].sort(), envNames: [...envNames].sort(), strictCapable, ownsFixture };
}

function firstArg(s: string, start: number): string {
  let depth = 0;
  let i = start;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
    else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
    }
  }
  return s.slice(start, i).trim();
}

/** Env vars set by the recorder itself for each mode. Not part of a key. */
export const RECORDER_ENV = new Set(["PROTO_RECORD_RPC", "PROTO_PIN", "PROTO_FIXTURE_CHECK", "PROTO_FIXTURE_STRICT"]);

/** The caller's env that can reach a unit: PROTO_*, FOUNDRY_*, DAPP_*, and any name (or name prefix) its sources
 *  spell out. Values are hashed, never stored. */
export function inheritedEnv(info: StaticInfo, env: Record<string, string | undefined>): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || RECORDER_ENV.has(k)) continue;
    const named = info.envNames.some((n) => k === n || (n.endsWith("_") && k.startsWith(n)));
    if (named || k.startsWith("PROTO_") || k.startsWith("FOUNDRY_") || k.startsWith("DAPP_")) out.push([k, sha256(v)]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

export function unitKey(o: {
  idx: SourceIndex;
  unit: Unit;
  info: StaticInfo;
  pin: number;
  forgeVersion: string;
  env: Record<string, string | undefined>;
}): string {
  const payload = {
    v: SCRIPT_KEY_VERSION,
    pin: o.pin,
    file: o.unit.file,
    unitEnv: Object.entries(o.unit.env).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    inherited: inheritedEnv(o.info, o.env),
    forge: o.forgeVersion,
    foundryToml: o.idx.cfg.tomlHash,
    closure: o.info.closure.map((p) => [p, o.idx.hash(p)]),
    runtime: o.info.runtimeFiles.map((p) => [p, o.idx.hash(p)]),
  };
  return sha256(JSON.stringify(payload));
}

// ─── forge results ──────────────────────────────────────────────────────────────────────────────

export type TestResult = {
  file: string;
  contract: string;
  /** Without the parameter list, as `forge test --list` names it. */
  name: string;
  status: "Success" | "Failure" | "Skipped";
  reason: string | null;
  kind: string;
  logs: string[];
  seconds: number;
};

export const testId = (t: { contract: string; name: string }) => `${t.contract}.${t.name}`;

/** Forge's JSON durations: "1h 2m 3s 4ms 5µs 6ns" (humantime), or {secs, nanos} in some versions. Seconds. */
export function parseDuration(d: unknown): number {
  if (d && typeof d === "object") return Number((d as any).secs ?? 0) + Number((d as any).nanos ?? 0) / 1e9;
  if (typeof d === "number") return d;
  if (typeof d !== "string") return 0;
  const unit: Record<string, number> = { d: 86400, h: 3600, m: 60, min: 60, s: 1, ms: 1e-3, us: 1e-6, "µs": 1e-6, ns: 1e-9 };
  let t = 0;
  for (const m of d.matchAll(/(\d+(?:\.\d+)?)\s*(min|ms|us|µs|ns|d|h|m|s)\b/g)) t += Number(m[1]) * unit[m[2]];
  return t;
}

export function parseForgeJson(text: string): TestResult[] {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    const start = text.search(/^\{/m);
    if (start < 0) throw new Error("forge printed no JSON");
    data = JSON.parse(text.slice(start));
  }
  const out: TestResult[] = [];
  for (const [suite, v] of Object.entries<any>(data)) {
    const colon = suite.lastIndexOf(":");
    const file = suite.slice(0, colon);
    const contract = suite.slice(colon + 1);
    for (const [sig, r] of Object.entries<any>(v.test_results ?? {})) {
      const seconds = parseDuration(r.duration);
      const base = {
        file,
        contract,
        reason: r.reason ?? null,
        kind: r.kind ? Object.keys(r.kind)[0] : "Unit",
        logs: (r.decoded_logs ?? []) as string[],
        seconds,
      };
      // Forge 1.8 runs every invariant of a contract in one campaign and reports it once, under the first
      // invariant's name, with each invariant's own status in `invariant_predicate_results`.
      const preds = r.invariant_predicate_results;
      if (Array.isArray(preds) && preds.length > 0) {
        for (const pr of preds) {
          out.push({ ...base, name: String(pr.name).replace(/\(.*$/, ""), status: pr.status, reason: pr.reason ?? base.reason });
        }
        continue;
      }
      out.push({ ...base, name: sig.replace(/\(.*$/, ""), status: r.status });
    }
  }
  return out;
}

export type Miss = { error: string; account: string; slot?: string };

export function parseMiss(reason: string | null): Miss | undefined {
  if (!reason) return undefined;
  const m = /(Fixture(?:Strict)?(?:Slot|Account)Miss)\((0x[0-9a-fA-F]{40})(?:,\s*(0x[0-9a-fA-F]{64}))?\)/.exec(reason);
  if (!m) return undefined;
  return { error: m[1], account: m[2].toLowerCase(), slot: m[3]?.toLowerCase() };
}

export const STRICT_SETUP = "fixture-strict: setUp";
export const STRICT_FINAL = "fixture-strict: final";
/** BaseFixture._skipCovered appends this to a skip reason in strict mode, after the check passed (forge keeps no
 *  logs of a skipped test, but keeps its reason). */
export const STRICT_SKIP_TAG = "[fixture-strict: checked]";

/** The accounts and slots ("account:slot") a strict test logged. */
export function decodeManifestLogs(logs: string[], into?: { accounts: Set<string>; slots: Set<string> }) {
  const m = into ?? { accounts: new Set<string>(), slots: new Set<string>() };
  for (const l of logs) {
    const a = /^fixture-manifest-accounts: 0x([0-9a-fA-F]*)$/.exec(l);
    if (a) {
      const h = a[1].toLowerCase();
      if (h.length % 40) throw new Error("fixture-manifest-accounts: not whole addresses");
      for (let i = 0; i < h.length; i += 40) m.accounts.add(`0x${h.slice(i, i + 40)}`);
      continue;
    }
    const s = /^fixture-manifest-slots: 0x([0-9a-fA-F]*)$/.exec(l);
    if (s) {
      const h = s[1].toLowerCase();
      if (h.length % 104) throw new Error("fixture-manifest-slots: not whole entries");
      for (let i = 0; i < h.length; i += 104) m.slots.add(`0x${h.slice(i, i + 40)}:0x${h.slice(i + 40, i + 104)}`);
    }
  }
  return m;
}

export type Outcome =
  | { cls: "strict" | "independent" | "skipped" | "unproven" | "fail" }
  | { cls: "miss"; miss: Miss };

/** The proof class of one test result (section 3.3 of the design). A skip counts like a pass: a skip decided on
 *  fixture state (a finding, "the fixture lacks X") is proven only by the check run before it (`_skipCovered`). */
export function classify(t: TestResult, info: StaticInfo, strictRun: boolean): Outcome {
  if (t.status === "Failure") {
    const miss = parseMiss(t.reason);
    return miss ? { cls: "miss", miss } : { cls: "fail" };
  }
  if (!strictRun) return { cls: "unproven" };
  const setUp = t.logs.includes(STRICT_SETUP);
  if (!setUp) {
    if (info.ownsFixture) return { cls: "unproven" };
    return { cls: t.status === "Skipped" ? "skipped" : "independent" };
  }
  if (!info.strictCapable) return { cls: "unproven" };
  if (t.status === "Skipped") return (t.reason ?? "").includes(STRICT_SKIP_TAG) ? { cls: "strict" } : { cls: "unproven" };
  return t.logs.includes(STRICT_FINAL) ? { cls: "strict" } : { cls: "unproven" };
}

// ─── fixture ────────────────────────────────────────────────────────────────────────────────────

export type Account = { balance: string; nonce: string; code: string; storage: Map<string, string> };
export type FixtureMeta = {
  description: string;
  chainId: number;
  block: number;
  timestamp: number;
  basefee: number;
  upstreamHost: string;
};
export type Fixture = { meta: FixtureMeta; accounts: Map<string, Account> };

export const pad32 = (hex: string) => "0x" + BigInt(hex).toString(16).padStart(64, "0");
const big = (x: string | number) => BigInt(x);

export function fixtureHashOf(allocText: string, metaText: string): string {
  return sha256(`${sha256(allocText)}:${sha256(metaText)}`);
}

export function readFixture(root: string): { fixture: Fixture; hash: string } | undefined {
  const ap = join(root, ALLOC_FILE);
  const mp = join(root, META_FILE);
  if (!existsSync(ap) || !existsSync(mp)) return undefined;
  const allocText = readFileSync(ap, "utf8");
  const metaText = readFileSync(mp, "utf8");
  const alloc = JSON.parse(allocText);
  const meta = JSON.parse(metaText);
  const accounts = new Map<string, Account>();
  for (const [addr, a] of Object.entries<any>(alloc)) {
    const storage = new Map<string, string>();
    for (const [k, v] of Object.entries<string>(a.storage ?? {})) storage.set(pad32(k), pad32(v));
    accounts.set(addr.toLowerCase(), { balance: a.balance, nonce: a.nonce, code: (a.code ?? "0x").toLowerCase(), storage });
  }
  // The coverage index (meta) must describe exactly the alloc, or the check would prove the wrong thing.
  const metaAccounts: string[] = (meta.accounts ?? []).map((x: string) => x.toLowerCase());
  if (metaAccounts.length !== accounts.size) throw new Error("fixture meta: account list does not match the alloc");
  metaAccounts.forEach((addr, i) => {
    const a = accounts.get(addr);
    const slots: string[] = meta.slots[i] ?? [];
    if (!a || slots.length !== a.storage.size || slots.some((s) => !a.storage.has(pad32(s)))) {
      throw new Error(`fixture meta: slot index of ${addr} does not match the alloc`);
    }
  });
  const m: FixtureMeta = {
    description: meta.description,
    chainId: meta.chainId,
    block: meta.block,
    timestamp: meta.timestamp,
    basefee: meta.basefee,
    upstreamHost: meta.upstreamHost,
  };
  return { fixture: { meta: m, accounts }, hash: fixtureHashOf(allocText, metaText) };
}

export function codeOf(code: any): string {
  if (code === null || code === undefined) return "0x";
  if (typeof code === "string") return code;
  if (code.LegacyAnalyzed) {
    const { bytecode, original_len } = code.LegacyAnalyzed;
    return "0x" + bytecode.slice(2, 2 + 2 * Number(original_len));
  }
  if (code.LegacyRaw) return code.LegacyRaw;
  if (code.Eip7702) {
    const e = code.Eip7702;
    if (e.raw) return e.raw;
    return "0xef0100" + String(e.delegated_address).slice(2).toLowerCase();
  }
  throw new Error(`unknown code encoding: ${Object.keys(code).join(",")}`);
}

/** Reads a forge or anvil fork cache file (zstd or plain JSON). */
export function readForkCache(path: string): any {
  let raw: Uint8Array = readFileSync(path);
  if (raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd) raw = Bun.zstdDecompressSync(raw);
  return JSON.parse(new TextDecoder().decode(raw));
}

/** The accounts and slots of a fork cache, as fixture accounts (forge's own addresses left out). */
export function cacheToAccounts(cache: any): { block: number; timestamp: number; basefee: number; accounts: Map<string, Account> } {
  const env = cache.meta.block_env;
  const accounts = new Map<string, Account>();
  for (const [addr, acct] of Object.entries<any>(cache.accounts)) {
    const a = addr.toLowerCase();
    if (FORGE_INTERNAL.has(a)) continue;
    const storage = new Map<string, string>();
    for (const [k, v] of Object.entries<string>(cache.storage?.[addr] ?? {})) storage.set(pad32(k), pad32(v));
    accounts.set(a, {
      balance: acct.balance,
      nonce: "0x" + BigInt(acct.nonce).toString(16),
      code: codeOf(acct.code).toLowerCase(),
      storage,
    });
  }
  for (const addr of Object.keys(cache.storage ?? {})) {
    const a = addr.toLowerCase();
    if (!accounts.has(a) && !FORGE_INTERNAL.has(a)) throw new Error(`storage for ${addr} without an account entry in the cache`);
  }
  return { block: Number(BigInt(env.number)), timestamp: Number(BigInt(env.timestamp)), basefee: Number(env.basefee), accounts };
}

export class FixtureConflict extends Error {}

/** Adds every account and slot of `add` to `base`. A value that differs is refused: both come from one pin. */
export function mergeAccounts(base: Map<string, Account>, add: Map<string, Account>): { accounts: number; slots: number } {
  let accounts = 0;
  let slots = 0;
  for (const [addr, a] of add) {
    const b = base.get(addr);
    if (!b) {
      base.set(addr, { ...a, storage: new Map(a.storage) });
      accounts++;
      slots += a.storage.size;
      continue;
    }
    if (big(a.balance) !== big(b.balance) || big(a.nonce) !== big(b.nonce) || a.code.toLowerCase() !== b.code.toLowerCase()) {
      throw new FixtureConflict(`${addr}: balance, nonce or code differs between the fixture and a recording`);
    }
    for (const [k, v] of a.storage) {
      const old = b.storage.get(k);
      if (old === undefined) {
        b.storage.set(k, v);
        slots++;
      } else if (big(old) !== big(v)) {
        throw new FixtureConflict(`${addr} slot ${k}: ${old} in the fixture, ${v} in a recording`);
      }
    }
  }
  return { accounts, slots };
}

export function serializeFixture(f: Fixture): { alloc: string; meta: string } {
  const order = [...f.accounts.keys()].sort();
  const alloc: Record<string, any> = {};
  const slots: string[][] = [];
  for (const addr of order) {
    const a = f.accounts.get(addr)!;
    const keys = [...a.storage.keys()].sort();
    const storage: Record<string, string> = {};
    for (const k of keys) storage[k] = a.storage.get(k)!;
    alloc[addr] = { balance: a.balance, nonce: a.nonce, code: a.code, storage };
    slots.push(keys);
  }
  const meta = { ...f.meta, accounts: order, slots };
  return { alloc: JSON.stringify(alloc, null, 1) + "\n", meta: JSON.stringify(meta, null, 1) + "\n" };
}

export function countSlots(f: Fixture): number {
  let n = 0;
  for (const a of f.accounts.values()) n += a.storage.size;
  return n;
}

// ─── manifests (bitsets over the fixture's sorted order) ────────────────────────────────────────

export type ManifestSets = { accounts: Set<string>; slots: Set<string> };

export function fixtureOrder(f: Fixture): { accounts: string[]; slots: string[] } {
  const accounts = [...f.accounts.keys()].sort();
  const slots: string[] = [];
  for (const a of accounts) for (const k of [...f.accounts.get(a)!.storage.keys()].sort()) slots.push(`${a}:${k}`);
  return { accounts, slots };
}

export function encodeBitset(set: Set<string>, order: string[]): string {
  const bytes = new Uint8Array(Math.ceil(order.length / 8));
  order.forEach((x, i) => {
    if (set.has(x)) bytes[i >> 3] |= 1 << (i & 7);
  });
  return Buffer.from(bytes).toString("base64");
}

export function decodeBitset(b64: string, order: string[]): Set<string> {
  const bytes = Buffer.from(b64, "base64");
  const out = new Set<string>();
  order.forEach((x, i) => {
    if (bytes[i >> 3] & (1 << (i & 7))) out.add(x);
  });
  return out;
}

/** Only entries the fixture holds go in a manifest (a strict test touches nothing else; a recording is merged). */
export function clampToFixture(m: ManifestSets, f: Fixture): ManifestSets {
  const accounts = new Set([...m.accounts].filter((a) => f.accounts.has(a)));
  const slots = new Set(
    [...m.slots].filter((s) => {
      const [a, k] = s.split(":");
      return f.accounts.get(a)?.storage.has(k) ?? false;
    }),
  );
  for (const s of slots) accounts.add(s.split(":")[0]);
  return { accounts, slots };
}

// ─── pass state ─────────────────────────────────────────────────────────────────────────────────

/** strict: passed the strict check on `fixture`. independent: no fixture state. skipped. recorded: recorded at
 *  `recordedKey` and replayed (check on) on exactly `fixture`. */
export type Proof = "strict" | "independent" | "skipped" | "recorded";
export type TestState = { proof?: Proof; fixture?: string; recordedKey?: string; strictOnlyMiss?: boolean };
export type UnitState = { key: string; file: string; run: string; env: Env; tests: Record<string, TestState> };
export type PassesFile = {
  description: string;
  pin: number;
  /** Fixture hashes this recorder produced, oldest first. Each holds every account and slot of the one before. */
  lineage: string[];
  units: Record<string, UnitState>;
};

export function emptyPasses(pin: number): PassesFile {
  return {
    description:
      "One-vault experiment: what scripts/prototype/record-base-fixture.ts has proven about each test file under each recorder run, keyed by its sources and environment. See the recorder's header.",
    pin,
    lineage: [],
    units: {},
  };
}

/** `a` is `b` or an ancestor of `b` in the lineage (so `b` holds all of `a`). */
export function isAncestor(lineage: string[], a: string | undefined, b: string): boolean {
  if (!a) return false;
  const ia = lineage.indexOf(a);
  const ib = lineage.indexOf(b);
  return ia >= 0 && ib >= 0 && ia <= ib;
}

export function testAccepted(t: TestState | undefined, unitKeyNow: string, unitKeyThen: string, fixture: string, lineage: string[]): boolean {
  if (!t?.proof || unitKeyNow !== unitKeyThen) return false;
  switch (t.proof) {
    case "independent":
    case "skipped":
      return true;
    case "strict":
      return isAncestor(lineage, t.fixture, fixture);
    case "recorded":
      return t.recordedKey === unitKeyNow && t.fixture === fixture && lineage.includes(fixture);
  }
}

export type Verdict = "accepted" | "record" | "replay-plain" | "failed";

/** What one replay result means for a test (design 3.3): accepted with a proof, needs a recording (its key was never
 *  recorded), needs a replay with the strict check off (recorded at this key, yet only the strict check misses:
 *  it reads differently in replay than on the fork, so the old proof, recording plus today's check, applies), or
 *  failed for good (recorded at this key and still failing). Returns the new state. */
export function applyOutcome(
  prev: TestState | undefined,
  c: Outcome,
  o: { key: string; fixture: string; strictRun: boolean },
): { state: TestState; verdict: Verdict } {
  const recordedKey = prev?.recordedKey;
  const recorded = recordedKey === o.key;
  if (c.cls === "strict" || c.cls === "independent" || c.cls === "skipped") {
    return { state: { proof: c.cls, fixture: o.fixture, recordedKey }, verdict: "accepted" };
  }
  if (c.cls === "unproven" && recorded) {
    return { state: { proof: "recorded", fixture: o.fixture, recordedKey }, verdict: "accepted" };
  }
  if (!recorded) return { state: { recordedKey }, verdict: "record" };
  if (c.cls === "miss" && c.miss.error.startsWith("FixtureStrict") && o.strictRun) {
    return { state: { recordedKey, strictOnlyMiss: true }, verdict: "replay-plain" };
  }
  return { state: { recordedKey, strictOnlyMiss: prev?.strictOnlyMiss }, verdict: "failed" };
}

// ─── batches and lanes ──────────────────────────────────────────────────────────────────────────

/** Work on one unit: every test (`tests` undefined) or the listed "Contract.name" ids. */
export type WorkItem = { unit: Unit; tests?: string[]; estimate: number };
export type Batch = { env: Env; items: WorkItem[]; estimate: number; strict: boolean };

export const envKey = (e: Env) => JSON.stringify(Object.entries(e).sort((a, b) => (a[0] < b[0] ? -1 : 1)));

/** Groups items by environment (and strictness), whole units apart from filtered ones, so one forge process runs
 *  each batch. Long items run alone. Longest batch first. */
export function planBatches(
  items: WorkItem[],
  strictOf: (it: WorkItem) => boolean,
  o: { lanes: number; longSeconds?: number },
): Batch[] {
  const long = o.longSeconds ?? 300;
  const groups = new Map<string, { strict: boolean; its: WorkItem[] }>();
  for (const it of items) {
    const strict = strictOf(it);
    const k = `${envKey(it.unit.env)}|${strict}|${it.tests ? "subset" : "whole"}`;
    if (!groups.has(k)) groups.set(k, { strict, its: [] });
    groups.get(k)!.its.push(it);
  }
  const batches: Batch[] = [];
  for (const { strict, its } of groups.values()) {
    const env = its[0].unit.env;
    const light: WorkItem[] = [];
    for (const it of its) {
      if (it.estimate >= long) batches.push({ env, items: [it], estimate: it.estimate, strict });
      else light.push(it);
    }
    if (light.length === 0) continue;
    const total = light.reduce((n, it) => n + it.estimate, 0);
    const cap = Math.max(long, total / Math.max(1, o.lanes));
    let cur: WorkItem[] = [];
    let sum = 0;
    for (const it of light.sort((a, b) => b.estimate - a.estimate)) {
      if (cur.length && sum + it.estimate > cap) {
        batches.push({ env, items: cur, estimate: sum, strict });
        cur = [];
        sum = 0;
      }
      cur.push(it);
      sum += it.estimate;
    }
    if (cur.length) batches.push({ env, items: cur, estimate: sum, strict });
  }
  return batches.sort((a, b) => b.estimate - a.estimate);
}

/** The forge filter flags for a batch: one --match-path, and contract/test regexes when items are filtered. */
export function batchFilters(b: Batch): string[] {
  const files = [...new Set(b.items.map((it) => it.unit.file))].sort();
  const args = ["--match-path", files.length === 1 ? files[0] : `{${files.join(",")}}`];
  const subsets = b.items.filter((it) => it.tests);
  if (subsets.length) {
    if (subsets.length !== b.items.length) throw new Error("a batch mixes whole units and filtered ones");
    const ids = subsets.flatMap((it) => it.tests!);
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const contracts = [...new Set(ids.map((id) => id.split(".")[0]))].sort();
    const tests = [...new Set(ids.map((id) => id.split(".").slice(1).join(".")))].sort();
    args.push("--match-contract", `^(?:${contracts.map(esc).join("|")})$`);
    // forge matches --match-test against the signature ("name(uint256)"), so anchor on the opening parenthesis.
    args.push("--match-test", `^(?:${tests.map(esc).join("|")})\\(`);
  }
  return args;
}

/** Runs batches on `lanes` workers, each worker on its own lane index, longest batch first. */
export async function runLanes<T>(batches: Batch[], lanes: number, work: (b: Batch, lane: number) => Promise<T>): Promise<T[]> {
  const queue = [...batches];
  const results: T[] = [];
  const workers = Array.from({ length: Math.max(1, Math.min(lanes, queue.length)) }, async (_, lane) => {
    for (let b = queue.shift(); b; b = queue.shift()) results.push(await work(b, lane));
  });
  await Promise.all(workers);
  return results;
}

// ─── lane build dirs ────────────────────────────────────────────────────────────────────────────

/** Points every forge cache JSON under `cacheDir` that names an out dir at `outDir` (absolute). */
export function rewriteCachePaths(cacheDir: string, outDir: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json")) {
        const text = readFileSync(p, "utf8");
        if (!text.includes('"paths"')) continue;
        const j = JSON.parse(text);
        if (!j.paths || typeof j.paths.artifacts !== "string") continue;
        j.paths.artifacts = outDir;
        j.paths.build_infos = join(outDir, "build-info");
        writeFileSync(p, JSON.stringify(j));
        n++;
      }
    }
  };
  if (existsSync(cacheDir)) walk(cacheDir);
  return n;
}

/** A fingerprint of a build: the main cache file with its out paths blanked. */
export function buildFingerprint(cacheDir: string): string {
  const p = join(cacheDir, "solidity-files-cache.json");
  if (!existsSync(p)) return "";
  const j = JSON.parse(readFileSync(p, "utf8"));
  delete j.paths;
  return sha256(JSON.stringify(j));
}

/** Makes lane dirs a copy of the base build (no recompile), unless they already are. Paths under `exclude`
 *  (sim outputs, the recorder's own state when it lives in the out dir) are not copied. */
export function syncLaneBuild(
  base: { out: string; cache: string },
  lane: { out: string; cache: string },
  exclude: string[] = [],
): boolean {
  const fp = buildFingerprint(base.cache);
  const marker = join(lane.cache, ".recorder-build");
  if (fp && existsSync(marker) && readFileSync(marker, "utf8") === fp && existsSync(lane.out)) return false;
  rmSync(lane.out, { recursive: true, force: true });
  rmSync(lane.cache, { recursive: true, force: true });
  mkdirSync(dirname(lane.out), { recursive: true });
  mkdirSync(dirname(lane.cache), { recursive: true });
  const skip = (src: string) => exclude.some((x) => src === x || src.startsWith(`${x}/`));
  cpSync(base.out, lane.out, { recursive: true, filter: (src) => !skip(src) });
  cpSync(base.cache, lane.cache, {
    recursive: true,
    filter: (src) => !src.endsWith(".lock") && !src.includes(".recorder-build"),
  });
  rewriteCachePaths(lane.cache, lane.out);
  writeFileSync(marker, fp);
  return true;
}

export const rel = (root: string, p: string) => relative(root, p) || ".";
