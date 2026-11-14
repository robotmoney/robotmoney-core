#!/usr/bin/env bun
// One-vault experiment (docs/technical/one-vault-rebalancer-proposal.md).
//
// Keeps the Base state the prototype tests read (contracts/test/prototype/fixtures/base-state.*.json) covering
// them, so they replay offline in plain `forge test`. When code starts reading new state it adds only what is
// missing: it replays first and records only the tests that miss.
//
//   bun scripts/prototype/record-base-fixture.ts [--pin N] [--rpc URL] [--match-path GLOB] [--sim]
//        [--sim-runs tuned,default,auction,...] [--no-anvil] [--forge-out DIR] [--forge-cache DIR] [--threads N]
//        [--lanes N] [--record-lanes N] [--state-dir DIR] [--force] [--fresh] [--max-rounds N] [--dry-run]
//
// Passes. The same as before: without --sim one pass over --match-path (default every prototype test). With --sim
// one pass per sim run over the sim files (contracts/test/prototype/sim/*), in this order: default-lprecenter,
// auction-lprecenter (PROTO_SIM_RUN=default or auction, PROTO_SIM_LP=recenter), tuned, default, timed-tuned,
// timed-default (PROTO_SIM_FLOWS=timed; timed-default also PROTO_SIM_ATTACKS=1), auction; the last selected run
// covers every prototype test, not only the sim. --sim-runs picks a subset, for debugging only. The script splits
// each pass into units, one per test file it matches (`forge test --list`), so the (test, environment) pairs are
// exactly the old ones, and keeps a result for every test.
//
// A unit's key hashes what decides its result: its environment, the inherited PROTO_* / FOUNDRY_* / DAPP_* vars
// (and any other var its sources name), the pin, the forge version, foundry.toml, every file in the test file's
// import closure, and every repo file its sources name in a string literal. A computed file read stops the script.
//
// Each round:
// 1. Replay every test not yet accepted (no RPC, no anvil), with the coverage check and the strict check on
//    (PROTO_FIXTURE_CHECK=1, PROTO_FIXTURE_STRICT=1, forge -vv; see BaseFixture.sol). A test is accepted as
//    "strict" when it passed the strict check and logged its final check, "independent" when it never loaded the
//    fixture, "skipped" when skipped, and "recorded" when it passed but cannot be proven so (fuzz tests without
//    `fixtureCovered`, invariant tests, Invariants.t.sol which reads the state diff itself): that needs a
//    recording of its current key, then a replay on exactly the final fixture, as the old script always did.
// 2. Record, in fork mode at the pin through this script's anvil, only the tests that missed, failed, or need a
//    recording, with --match-contract / --match-test filters, one test file per forge process. Forge runs with
//    HOME set to a lane dir, so its fork cache starts empty and holds exactly what those tests read; anvil runs
//    with HOME at <state dir>/anvil-home, which keeps its cache across runs (forge binds a cache to the exact RPC
//    URL, so the old shared ~/.foundry cache never survived a run). The shared ~/.foundry/cache is never written.
// 3. Merge the recordings into the committed fixture. A value that differs is refused (one pin). Nothing is
//    dropped. Then replay the recorded tests again. At most --max-rounds rounds (default 3).
// The fixture is accepted only when every test of every unit is accepted on it; otherwise the script exits 1 and
// names the tests. A strict proof stays valid when the fixture grows (the test touched only fixture state), so a
// recording invalidates only "recorded" tests. Results persist in fixtures/base-state.passes.json (unit keys,
// per-test proof, the fixture lineage) and fixtures/base-state.manifest.json (each unit's fixture accounts and
// slots), committed beside the fixture: a rerun skips every accepted test, and a rerun with nothing changed runs
// no forge test and needs no network.
//
// --fresh: the old behaviour. Record every test, rebuild the fixture from this run's recordings alone (the only way
// to drop state no test reads any more), then replay everything. It is forced when the fixture is missing or is at
// another block than the pin. Without --pin the script picks upstream head minus 2, a new pin, so it is fresh: the
// public node is not an archive node, so record soon after picking a pin.
// --force: replay every test again (recordings already made at the current keys still count).
// --dry-run: build, list, key, and print which tests would run. No test runs.
//
// Lanes. --lanes N (default 2) replay forge processes run at once, --record-lanes N (default 1) record ones, each
// with --threads T (default 4) test threads and its own out, cache and HOME dirs under <state dir>/lanes (lane 0
// uses the base dirs). Lane dirs copy the base build with the out paths in the cache rewritten, so they never
// recompile. Units of one environment share a forge process; units estimated long run alone, longest first.
// --forge-out and --forge-cache are the base build dirs (forge --out and --cache-path), as before.
// --state-dir (default out/prototype-record): logs, lane dirs, anvil home. --threads used to be forge's default.
//
// The RPC URL is never written or printed. Only the upstream host is recorded.
// Logic: scripts/prototype/record-fixture-lib.ts. Tests: bun test scripts/prototype/record-base-fixture.test.ts
// scripts/prototype/record-base-fixture.flow.test.ts (no forge, no anvil, no network).

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Account,
  type Batch,
  type Env,
  type Fixture,
  type ManifestSets,
  type PassesFile,
  type StaticInfo,
  type TestResult,
  type TestState,
  type Unit,
  type UnitState,
  type WorkItem,
  ALLOC_FILE,
  MANIFEST_FILE,
  META_FILE,
  PASSES_FILE,
  SIM_RUNS,
  SourceIndex,
  analyzeUnit,
  applyOutcome,
  batchFilters,
  cacheToAccounts,
  clampToFixture,
  classify,
  countSlots,
  decodeBitset,
  decodeManifestLogs,
  emptyPasses,
  encodeBitset,
  fixtureHashOf,
  fixtureOrder,
  loadProjectConfig,
  mergeAccounts,
  parseForgeJson,
  planBatches,
  planPasses,
  planUnits,
  readFixture,
  readForkCache,
  runLanes,
  serializeFixture,
  syncLaneBuild,
  testAccepted,
  testId,
  unitKey,
} from "./record-fixture-lib";

// ─── options ────────────────────────────────────────────────────────────────────────────────────

export type Opts = {
  rpc: string;
  pin?: number;
  matchPath: string;
  withSim: boolean;
  simRuns: string[];
  useAnvil: boolean;
  forgeOut?: string;
  forgeCache?: string;
  threads: number;
  lanes: number;
  recordLanes: number;
  stateDir: string;
  force: boolean;
  fresh: boolean;
  maxRounds: number;
  dryRun: boolean;
};

export function parseArgs(args: string[], env: Record<string, string | undefined> = process.env): Opts {
  const known = new Set([
    "pin", "rpc", "match-path", "sim", "sim-runs", "no-anvil", "forge-out", "forge-cache", "threads", "lanes",
    "record-lanes", "state-dir", "force", "fresh", "max-rounds", "dry-run",
  ]);
  const flags = new Set(["sim", "no-anvil", "force", "fresh", "dry-run"]);
  const val = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--") || !known.has(a.slice(2))) throw new Error(`unknown argument ${a}`);
    const k = a.slice(2);
    if (flags.has(k)) val.set(k, "1");
    else {
      if (i + 1 >= args.length) throw new Error(`${a} needs a value`);
      val.set(k, args[++i]);
    }
  }
  const int = (k: string, d: number) => {
    const v = val.get(k);
    if (v === undefined) return d;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${k} must be a positive integer`);
    return n;
  };
  return {
    rpc: val.get("rpc") ?? env.BASE_UPSTREAM_RPC ?? "https://mainnet.base.org",
    pin: val.has("pin") ? int("pin", 0) : undefined,
    matchPath: val.get("match-path") ?? "contracts/test/prototype/**",
    withSim: val.has("sim"),
    simRuns: (val.get("sim-runs") ?? SIM_RUNS.join(",")).split(",").filter((r) => r.length > 0),
    useAnvil: !val.has("no-anvil"),
    forgeOut: val.get("forge-out"),
    forgeCache: val.get("forge-cache"),
    threads: int("threads", 4),
    lanes: int("lanes", 2),
    recordLanes: int("record-lanes", 1),
    stateDir: val.get("state-dir") ?? "out/prototype-record",
    force: val.has("force"),
    fresh: val.has("fresh"),
    maxRounds: int("max-rounds", 3),
    dryRun: val.has("dry-run"),
  };
}

/** A recording runs the committed defaults. These variables change what the sim and attack tests do, so the
 *  fixture would not cover the default runs. */
export function overrideVars(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter(
    (k) =>
      k === "PROTO_ATTACK_FINDINGS_FAIL" ||
      k === "PROTO_SIM_TAG" ||
      k === "PROTO_SIM_ATTACK_SEEDS" ||
      k === "PROTO_SIM_ASSETS" ||
      k.startsWith("PROTO_SIM_FLOW_") ||
      k.startsWith("PROTO_LEVER_"),
  );
}

// ─── processes ──────────────────────────────────────────────────────────────────────────────────

const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s] ${s}`);

type Ran = { code: number | null; signal: string | null; out: string; err: string; wall: number; cpu: number; rss: number };
const running = new Set<ReturnType<typeof Bun.spawn>>();
const stats = { forgeCpu: 0, forgeWall: 0, peakRss: 0, peakConcurrentRss: 0, processes: 0 };

async function spawn(cmd: string[], env: Record<string, string | undefined>): Promise<Ran> {
  const start = Date.now();
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const p = Bun.spawn(cmd, { env: clean, stdout: "pipe", stderr: "pipe" });
  running.add(p);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  running.delete(p);
  const ru = p.resourceUsage();
  const cpu = ru ? Number(ru.cpuTime.total) / 1e6 : 0;
  const rss = ru ? ru.maxRSS : 0;
  const wall = (Date.now() - start) / 1000;
  stats.forgeCpu += cpu;
  stats.forgeWall += wall;
  stats.peakRss = Math.max(stats.peakRss, rss);
  stats.processes++;
  return { code: p.exitCode, signal: p.signalCode ?? null, out, err, wall, cpu, rss };
}

/** Sums the resident memory of the running children every 5 s (for the peak a lane count reaches). */
function startRssSampler(): () => void {
  const timer = setInterval(() => {
    let sum = 0;
    for (const p of running) {
      try {
        const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${p.pid}/status`, "utf8"));
        if (m) sum += Number(m[1]) * 1024;
      } catch {}
    }
    stats.peakConcurrentRss = Math.max(stats.peakConcurrentRss, sum);
  }, 5000);
  return () => clearInterval(timer);
}

const gb = (b: number) => `${(b / 2 ** 30).toFixed(1)} GB`;

// ─── anvil, owned by this script ────────────────────────────────────────────────────────────────

let anvil: ReturnType<typeof Bun.spawn> | undefined;
/** Saves the run's state so far; set once the state exists. */
let onStop: () => void = () => {};

async function stopAnvil(): Promise<void> {
  if (!anvil) return;
  const a = anvil;
  anvil = undefined;
  a.kill("SIGTERM");
  // Anvil flushes its fork cache on SIGTERM; wait for it so the next run finds the cache whole.
  const done = await Promise.race([a.exited.then(() => true), Bun.sleep(60_000).then(() => false)]);
  if (!done) a.kill("SIGKILL");
  log("anvil: stopped");
}

function killAll(): void {
  for (const p of running) p.kill("SIGTERM");
  anvil?.kill("SIGTERM");
}

async function blockNumber(url: string): Promise<number> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  const j = (await r.json()) as { result: string };
  return Number(BigInt(j.result));
}

function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.2", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

async function startAnvil(o: Opts, pin: number, home: string): Promise<string> {
  const port = freePort();
  const url = `http://127.0.0.2:${port}`;
  mkdirSync(home, { recursive: true });
  anvil = Bun.spawn(
    [
      "anvil", "--host", "127.0.0.2", "--port", String(port),
      "--fork-url", o.rpc, "--fork-block-number", String(pin), "--chain-id", "8453",
      "--silent", "--retries", "10", "--fork-retry-backoff", "500",
      "--compute-units-per-second", "10000", "--timeout", "60000",
    ],
    { stdout: "ignore", stderr: "pipe", env: { ...process.env, HOME: home } as Record<string, string> },
  );
  for (let i = 0; i < 120; i++) {
    if (anvil.exitCode !== null) throw new Error(`anvil exited early (code ${anvil.exitCode})`);
    try {
      if ((await blockNumber(url)) === pin) {
        log(`anvil: forked ${new URL(o.rpc).host} at ${pin} on 127.0.0.2:${port} (cache in ${home})`);
        return url;
      }
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error("anvil did not answer within 60 s");
}

// ─── the run ────────────────────────────────────────────────────────────────────────────────────

type Lane = { out: string; cache: string; home: string; outArgs: string[] };

async function main(): Promise<number> {
  const root = process.cwd();
  if (!existsSync(join(root, "foundry.toml"))) throw new Error("run from the repo root");
  const o = parseArgs(process.argv.slice(2));
  const overrides = overrideVars(process.env);
  if (overrides.length > 0) throw new Error(`unset before recording: ${overrides.join(", ")}`);
  const host = new URL(o.rpc).host;
  const pin = o.pin ?? (await blockNumber(o.rpc)) - 2;
  log(`record: pin ${pin} from ${host}`);

  const stateDir = resolve(root, o.stateDir);
  const logDir = join(stateDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const cfg = loadProjectConfig(root);
  const idx = new SourceIndex(cfg);
  const forgeVersion = (await spawn(["forge", "--version"], process.env)).out.split("\n").slice(0, 2).join(" ");

  // Base build: the only compile. Lanes copy it. `--no-lint`: forge 1.8 lints every source after a build, which
  // took 13.6 GB and 35 s here with nothing to compile (0.4 s and 0.4 GB without). The build must come before
  // `forge test --list`: a listing compiles a changed test file for its ABI only, and the next `forge test` then
  // finds no test in it ("no tests match"), which a prior build avoids.
  const base: Lane = {
    out: o.forgeOut ? resolve(root, o.forgeOut) : join(root, "out"),
    cache: o.forgeCache ? resolve(root, o.forgeCache) : join(root, "cache"),
    home: join(stateDir, "lanes", "lane-0", "home"),
    outArgs: [...(o.forgeOut ? ["--out", resolve(root, o.forgeOut)] : []), ...(o.forgeCache ? ["--cache-path", resolve(root, o.forgeCache)] : [])],
  };
  const built = await spawn(["forge", "build", "--no-lint", ...base.outArgs], process.env);
  writeFileSync(join(logDir, "build.log"), built.out + built.err);
  if (built.code !== 0) throw new Error(`forge build failed (see ${join(logDir, "build.log")})`);
  const compiled = /Compiling (\d+) files/.exec(built.out + built.err);
  log(`build: ${compiled ? `compiled ${compiled[1]} files in ${built.wall.toFixed(0)} s` : "no files changed"}`);

  // Units: each pass's test files, from forge's own listing.
  const passes = planPasses(o);
  const listings = new Map<string, any>();
  for (const path of new Set(passes.map((p) => p.path))) {
    const r = await spawn(["forge", "test", "--list", "--json", "--match-path", path, ...base.outArgs], process.env);
    if (r.code !== 0) throw new Error(`forge test --list failed: ${r.err.slice(-2000)}`);
    if (/Compiling \d+ files/.test(r.out + r.err)) throw new Error("forge test --list compiled after forge build; refusing a half-built cache");
    listings.set(path, JSON.parse(r.out.slice(r.out.indexOf("{"))));
  }
  const units = planUnits(passes, listings);
  const infos = new Map<string, StaticInfo>();
  const keys = new Map<string, string>();
  for (const u of units) {
    if (!infos.has(u.file)) infos.set(u.file, analyzeUnit(idx, u.file));
    keys.set(u.id, unitKey({ idx, unit: u, info: infos.get(u.file)!, pin, forgeVersion, env: process.env }));
  }
  log(`plan: ${passes.length} passes, ${units.length} units, ${units.reduce((n, u) => n + u.tests.length, 0)} tests`);

  // Fixture and state.
  const read = readFixture(root);
  let fixture: Fixture | undefined = read?.fixture;
  let fixtureHash = read?.hash ?? "";
  let fresh = o.fresh;
  if (!fixture) {
    log("fixture: none; recording fresh");
    fresh = true;
  } else if (fixture.meta.block !== pin) {
    log(`fixture: at block ${fixture.meta.block}, not the pin; recording fresh`);
    fresh = true;
  }
  const freshRun = fresh;
  let state: PassesFile = emptyPasses(pin);
  if (existsSync(join(root, PASSES_FILE))) {
    const s = JSON.parse(readFileSync(join(root, PASSES_FILE), "utf8")) as PassesFile;
    if (s.pin === pin) state = s;
  }
  let lineage = fresh ? [] : state.lineage.includes(fixtureHash) ? state.lineage : [fixtureHash];
  const manifests = new Map<string, ManifestSets>();
  if (!fresh && fixture && existsSync(join(root, MANIFEST_FILE))) {
    const mf = JSON.parse(readFileSync(join(root, MANIFEST_FILE), "utf8"));
    if (mf.fixture === fixtureHash) {
      const order = fixtureOrder(fixture);
      for (const [id, m] of Object.entries<any>(mf.units ?? {})) {
        manifests.set(id, { accounts: decodeBitset(m.accounts, order.accounts), slots: decodeBitset(m.slots, order.slots) });
      }
    }
  }
  // Test-seconds per unit from earlier runs (local, machine-specific, not committed): batch estimates only.
  const estimatesPath = join(stateDir, "estimates.json");
  const seconds: Record<string, number> = existsSync(estimatesPath) ? JSON.parse(readFileSync(estimatesPath, "utf8")) : {};
  const unitState = new Map<string, UnitState>();
  for (const u of units) {
    const old = state.units[u.id];
    const key = keys.get(u.id)!;
    if (old && old.key === key && !fresh) {
      const tests: Record<string, TestState> = {};
      for (const t of u.tests) {
        const ts = old.tests[t];
        if (ts) tests[t] = o.force ? { recordedKey: ts.recordedKey } : { ...ts };
      }
      unitState.set(u.id, { key: old.key, file: u.file, run: u.run, env: u.env, tests });
    } else {
      unitState.set(u.id, { key, file: u.file, run: u.run, env: u.env, tests: {} });
      if (old?.key !== key) manifests.delete(u.id);
    }
  }
  const accepted = (u: Unit, t: string) =>
    !fresh && testAccepted(unitState.get(u.id)!.tests[t], keys.get(u.id)!, unitState.get(u.id)!.key, fixtureHash, lineage);
  const pendingOf = (u: Unit) => u.tests.filter((t) => !accepted(u, t));
  const estimate = (u: Unit) => seconds[u.id] ?? (u.file.includes("/sim/") && u.env.PROTO_SIM ? 900 : 60);

  if (o.dryRun) {
    for (const u of units) {
      const p = pendingOf(u);
      const info = infos.get(u.file)!;
      console.log(
        `${u.id}  key ${keys.get(u.id)!.slice(0, 12)}  ${u.tests.length - p.length}/${u.tests.length} accepted` +
          `${info.strictCapable ? "" : "  (not strict-capable)"}${info.ownsFixture ? "  (loads state itself)" : ""}`,
      );
    }
    console.log(`dry run: ${units.reduce((n, u) => n + pendingOf(u).length, 0)} tests would replay; fixture ${fixtureHash.slice(0, 12)}`);
    return 0;
  }

  // Lanes.
  const lanes = Math.max(o.lanes, o.recordLanes);
  const laneDirs: Lane[] = [base];
  for (let i = 1; i < lanes; i++) {
    const d = join(stateDir, "lanes", `lane-${i}`);
    laneDirs.push({ out: join(d, "out"), cache: join(d, "cache"), home: join(d, "home"), outArgs: ["--out", join(d, "out"), "--cache-path", join(d, "cache")] });
  }
  const exclude = [join(root, "out", "prototype"), stateDir];
  for (const l of laneDirs.slice(1)) if (syncLaneBuild(base, l, exclude)) log(`lanes: copied the base build to ${l.out}`);

  const stopSampler = startRssSampler();
  const failures = new Map<string, string>(); // "unit test" -> reason, for tests that stay unaccepted
  const wantRecord = new Set<string>(); // "unit test": missed, failed or unprovable, and its key was never recorded
  let anvilUrl: string | undefined;
  let fixtureChanged = false;

  // Persist state and manifests (manifests re-encoded on the current fixture order). Called after every batch, so
  // a stop (SIGINT, SIGTERM, a time box) or a crash loses at most the batches still running: a rerun resumes.
  const persist = (final: boolean) => {
    // Units outside this run's plan (a --match-path or --sim-runs subset) keep their state: their proofs name
    // fixtures of the same lineage, so they stay valid or not by the same rules.
    const merged: Record<string, UnitState> = freshRun || state.pin !== pin ? {} : { ...state.units };
    for (const [id, st] of unitState) merged[id] = st;
    const out: PassesFile = { ...emptyPasses(pin), lineage, units: {} };
    for (const id of Object.keys(merged).sort()) out.units[id] = merged[id];
    writeFileSync(join(root, PASSES_FILE), JSON.stringify(out, null, 1) + "\n");
    writeFileSync(estimatesPath, JSON.stringify(seconds, null, 1) + "\n");
    if (!fixture) return;
    const order = fixtureOrder(fixture);
    const units_: Record<string, any> = {};
    const all = { accounts: new Set<string>(), slots: new Set<string>() };
    for (const [id, m] of [...manifests].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const c = clampToFixture(m, fixture);
      if (c.accounts.size === 0 && c.slots.size === 0) continue;
      c.accounts.forEach((a) => all.accounts.add(a));
      c.slots.forEach((s) => all.slots.add(s));
      units_[id] = { accounts: encodeBitset(c.accounts, order.accounts), slots: encodeBitset(c.slots, order.slots), n: [c.accounts.size, c.slots.size] };
    }
    writeFileSync(
      join(root, MANIFEST_FILE),
      JSON.stringify(
        {
          description:
            "One-vault experiment: for each recorder unit (test file @ run), the fixture accounts and slots its tests touched in strict replay or read when recorded. Bitsets over the fixture's sorted accounts and sorted (account, slot) pairs.",
          fixture: fixtureHash,
          units: units_,
        },
        null,
        1,
      ) + "\n",
    );
    if (final) {
      log(
        `manifests: ${Object.keys(units_).length} units; they cover ${all.accounts.size} of ${order.accounts.length} accounts and ` +
          `${all.slots.size} of ${order.slots.length} slots`,
      );
    }
  };
  onStop = () => persist(false);

  // One replay batch: run forge, classify each result, update state and manifests.
  const replayBatch = async (b: Batch, lane: number) => {
    const l = laneDirs[lane];
    const label = `replay ${b.items[0].unit.run} [${b.items.map((it) => it.unit.file.split("/").pop() + (it.tests ? `:${it.tests.length}` : "")).join(", ")}]${b.strict ? "" : " (strict off)"}`;
    const env = { ...process.env, ...b.env, PROTO_RECORD_RPC: "", PROTO_PIN: "", PROTO_FIXTURE_CHECK: "1", PROTO_FIXTURE_STRICT: b.strict ? "1" : "0" };
    const r = await spawn(["forge", "test", "--json", "-vv", ...batchFilters(b), ...l.outArgs, "--threads", String(o.threads)], env);
    const tag = `${Date.now()}-${lane}`;
    writeFileSync(join(logDir, `replay-${tag}.err`), `${label}\n${r.err}`);
    let results: TestResult[];
    try {
      if (/no tests match/.test(r.err)) throw new Error("no tests match");
      results = parseForgeJson(r.out);
    } catch {
      writeFileSync(join(logDir, `replay-${tag}.out`), r.out);
      log(`${label}: forge failed (exit ${r.code}, signal ${r.signal ?? "none"}, ${r.wall.toFixed(0)} s); see ${join(logDir, `replay-${tag}.err`)}`);
      for (const it of b.items) for (const t of it.tests ?? it.unit.tests) failures.set(`${it.unit.id} ${t}`, `forge failed (exit ${r.code}, signal ${r.signal ?? "none"})`);
      return;
    }
    const counts = { strict: 0, independent: 0, skipped: 0, recorded: 0, record: 0, failed: 0 };
    for (const it of b.items) {
      const u = it.unit;
      const st = unitState.get(u.id)!;
      const info = infos.get(u.file)!;
      const key = keys.get(u.id)!;
      const mine = results.filter((x) => x.file === u.file);
      const byId = new Map(mine.map((x) => [testId(x), x]));
      // A setUp that failed or skipped reports one "setUp" result for its contract instead of one per test.
      const setUpRes = new Map(mine.filter((x) => x.name === "setUp" && x.status !== "Success").map((x) => [x.contract, x]));
      const m = manifests.get(u.id) ?? { accounts: new Set<string>(), slots: new Set<string>() };
      manifests.set(u.id, m);
      if (!it.tests) seconds[u.id] = mine.reduce((n, x) => n + x.seconds, 0);
      for (const t of it.tests ?? u.tests) {
        const x = byId.get(t) ?? setUpRes.get(t.split(".")[0]);
        const prev = st.tests[t];
        if (!x) {
          failures.set(`${u.id} ${t}`, "no result from forge");
          counts.failed++;
          continue;
        }
        if (b.strict) decodeManifestLogs(x.logs, m);
        const c = classify(x.name === "setUp" ? { ...x, name: t.split(".")[1] } : x, info, b.strict);
        const { state: next, verdict } = applyOutcome(prev, c, { key, fixture: fixtureHash, strictRun: b.strict });
        st.tests[t] = next;
        wantRecord.delete(`${u.id} ${t}`);
        if (verdict === "accepted") {
          counts[next.proof!]++;
          failures.delete(`${u.id} ${t}`);
          continue;
        }
        const why =
          c.cls === "unproven"
            ? "passed, but only a recording of its current code can prove it"
            : c.cls === "miss"
              ? `${c.miss.error} ${c.miss.account}${c.miss.slot ? ` ${c.miss.slot}` : ""}`
              : `failed: ${(x.reason ?? "").slice(0, 300)}`;
        failures.set(`${u.id} ${t}`, why);
        if (verdict === "record") wantRecord.add(`${u.id} ${t}`);
        if (verdict === "failed") counts.failed++;
        else counts.record++;
      }
    }
    log(
      `${label}: ${counts.strict} strict, ${counts.independent} independent, ${counts.recorded} recorded, ${counts.skipped} skipped, ` +
        `${counts.record} to record, ${counts.failed} failed (${r.wall.toFixed(0)} s, cpu ${r.cpu.toFixed(0)} s, rss ${gb(r.rss)})`,
    );
    persist(false);
  };

  // One record batch: fork run through anvil, harvest the lane's fork cache (it started empty, so it holds exactly
  // what these tests read).
  const harvests: { accounts: Map<string, Account>; block: number; timestamp: number; basefee: number }[] = [];
  const recordBatch = async (b: Batch, lane: number) => {
    const l = laneDirs[lane];
    const label = `record ${b.items[0].unit.run} [${b.items.map((it) => it.unit.file.split("/").pop() + (it.tests ? `:${it.tests.length}` : "")).join(", ")}]`;
    rmSync(join(l.home, ".foundry", "cache", "rpc"), { recursive: true, force: true });
    mkdirSync(l.home, { recursive: true });
    const realSvm = join(homedir(), ".svm");
    if (existsSync(realSvm) && !existsSync(join(l.home, ".svm"))) symlinkSync(realSvm, join(l.home, ".svm"));
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...b.env,
      PROTO_RECORD_RPC: anvilUrl ?? o.rpc,
      PROTO_PIN: String(pin),
      PROTO_FIXTURE_CHECK: undefined,
      PROTO_FIXTURE_STRICT: undefined,
      HOME: l.home,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    };
    const r = await spawn(["forge", "test", "--json", ...batchFilters(b), ...l.outArgs, "--threads", String(o.threads)], env);
    const tag = `${Date.now()}-${lane}`;
    writeFileSync(join(logDir, `record-${tag}.err`), `${label}\n${r.err}`);
    let note = "";
    try {
      const res = parseForgeJson(r.out);
      const bad = res.filter((x) => x.status === "Failure");
      note = `${res.filter((x) => x.status === "Success").length} passed, ${bad.length} failed`;
      for (const x of bad) log(`${label}: in record mode ${testId(x)} failed: ${(x.reason ?? "").slice(0, 200)}`);
    } catch {
      note = `forge failed (exit ${r.code}, signal ${r.signal ?? "none"})`;
    }
    const rpcDir = join(l.home, ".foundry", "cache", "rpc");
    const cacheFile = existsSync(rpcDir)
      ? readdirSync(rpcDir).map((c) => join(rpcDir, c, String(pin))).find((p) => existsSync(p))
      : undefined;
    if (!cacheFile) {
      log(`${label}: ${note}; no fork cache written, nothing recorded`);
      return;
    }
    const h = cacheToAccounts(readForkCache(cacheFile));
    harvests.push(h);
    for (const it of b.items) {
      const st = unitState.get(it.unit.id)!;
      for (const t of it.tests ?? it.unit.tests) {
        st.tests[t] = { ...(st.tests[t] ?? {}), recordedKey: keys.get(it.unit.id)!, proof: undefined };
      }
      const m = manifests.get(it.unit.id) ?? { accounts: new Set<string>(), slots: new Set<string>() };
      manifests.set(it.unit.id, m);
      for (const [a, acc] of h.accounts) {
        m.accounts.add(a);
        for (const k of acc.storage.keys()) m.slots.add(`${a}:${k}`);
      }
    }
    let slots = 0;
    for (const a of h.accounts.values()) slots += a.storage.size;
    log(`${label}: ${note}; read ${h.accounts.size} accounts, ${slots} slots (${r.wall.toFixed(0)} s, cpu ${r.cpu.toFixed(0)} s, rss ${gb(r.rss)})`);
  };

  // Merge harvests into the fixture (or, fresh, build it from them alone).
  const absorb = () => {
    if (harvests.length === 0) return;
    const first = harvests[0];
    const target: Fixture =
      fresh || !fixture
        ? {
            meta: {
              description:
                "One-vault experiment replay fixture. Real Base (8453) state at `block`, recorded by scripts/prototype/record-base-fixture.ts. Holds only the accounts and slots the prototype tests read. The recorder adds what a test misses (FixtureSlotMiss, FixtureAccountMiss, FixtureStrict*Miss).",
              chainId: 8453,
              block: first.block,
              timestamp: first.timestamp,
              basefee: first.basefee,
              upstreamHost: host,
            },
            accounts: new Map(),
          }
        : fixture;
    let added = { accounts: 0, slots: 0 };
    for (const h of harvests) {
      if (h.block !== target.meta.block || h.timestamp !== target.meta.timestamp || h.basefee !== target.meta.basefee) {
        throw new Error(`a recording is at block ${h.block}, the fixture at ${target.meta.block}`);
      }
      const a = mergeAccounts(target.accounts, h.accounts);
      added = { accounts: added.accounts + a.accounts, slots: added.slots + a.slots };
    }
    harvests.length = 0;
    if (fresh || !fixture || added.accounts + added.slots > 0) {
      const s = serializeFixture(target);
      writeFileSync(join(root, ALLOC_FILE), s.alloc);
      writeFileSync(join(root, META_FILE), s.meta);
      const h = fixtureHashOf(s.alloc, s.meta);
      lineage = fresh || !fixture ? [h] : [...lineage, h];
      fixture = target;
      fixtureHash = h;
      fixtureChanged = true;
      fresh = false;
      log(`fixture: +${added.accounts} accounts, +${added.slots} slots; now ${target.accounts.size} accounts, ${countSlots(target)} slots at block ${target.meta.block}`);
    } else {
      log("fixture: the recordings added nothing");
    }
  };

  const recordItems = async (items: WorkItem[]) => {
    if (!anvilUrl && o.useAnvil) anvilUrl = await startAnvil(o, pin, join(stateDir, "anvil-home"));
    // One test file per forge process (precise manifests), except a fresh recording, which batches like replay.
    const batches = planBatches(items, () => false, { lanes: o.recordLanes, longSeconds: fresh ? 300 : 0 });
    await runLanes(batches, o.recordLanes, recordBatch);
    absorb();
    persist(false);
  };

  let exit = 0;
  try {
    if (fresh) {
      log("fresh: recording every test");
      await recordItems(units.map((u) => ({ unit: u, estimate: estimate(u) })));
    }
    for (let round = 1; round <= o.maxRounds; round++) {
      // Replay what is not accepted: whole units when every test is pending, else the pending tests.
      const items: WorkItem[] = [];
      for (const u of units) {
        const p = pendingOf(u);
        if (p.length === 0) continue;
        items.push({ unit: u, tests: p.length === u.tests.length ? undefined : p, estimate: estimate(u) * (p.length / u.tests.length) });
      }
      if (items.length === 0) break;
      log(`round ${round}: replaying ${items.reduce((n, it) => n + (it.tests?.length ?? it.unit.tests.length), 0)} tests in ${items.length} units`);
      // A recorded test the strict check still refuses (it reads differently in replay than on the fork) replays
      // with strict off: a recording of its current key plus today's check is exactly the old proof.
      const strictItems: WorkItem[] = [];
      const plainItems: WorkItem[] = [];
      for (const it of items) {
        const st = unitState.get(it.unit.id)!;
        const ids = it.tests ?? it.unit.tests;
        const plain = ids.filter((t) => st.tests[t]?.strictOnlyMiss);
        const strictCapable = infos.get(it.unit.file)!.strictCapable;
        if (!strictCapable) plainItems.push(it);
        else if (plain.length === 0) strictItems.push(it);
        else {
          plainItems.push({ unit: it.unit, tests: plain, estimate: it.estimate });
          const rest = ids.filter((t) => !plain.includes(t));
          if (rest.length) strictItems.push({ unit: it.unit, tests: rest, estimate: it.estimate });
        }
      }
      const plainSet = new Set(plainItems);
      const split = planBatches([...strictItems, ...plainItems], (it) => !plainSet.has(it), { lanes: o.lanes });
      await runLanes(split, o.lanes, replayBatch);

      // Record what needs it: tests without an accepted proof whose current key was never recorded.
      const toRecord: WorkItem[] = [];
      for (const u of units) {
        const st = unitState.get(u.id)!;
        const need = pendingOf(u).filter((t) => st.tests[t]?.recordedKey !== keys.get(u.id) && wantRecord.has(`${u.id} ${t}`));
        if (need.length) toRecord.push({ unit: u, tests: need.length === u.tests.length ? undefined : need, estimate: estimate(u) });
      }
      const retry = units.some((u) => pendingOf(u).some((t) => unitState.get(u.id)!.tests[t]?.strictOnlyMiss));
      if (toRecord.length === 0 && !retry) break;
      if (round === o.maxRounds) break;
      if (toRecord.length) {
        log(`round ${round}: recording ${toRecord.reduce((n, it) => n + (it.tests?.length ?? it.unit.tests.length), 0)} tests in ${toRecord.length} units`);
        await recordItems(toRecord);
      }
    }
  } catch (e) {
    exit = 1;
    console.error(e instanceof Error ? e.message : e);
  } finally {
    await stopAnvil();
    stopSampler();
  }

  const unaccepted: string[] = [];
  for (const u of units) for (const t of pendingOf(u)) unaccepted.push(`${u.id} ${t}: ${failures.get(`${u.id} ${t}`) ?? "not run"}`);
  persist(true);
  log(
    `forge: ${stats.processes} processes, cpu ${stats.forgeCpu.toFixed(0)} s, peak rss ${gb(stats.peakRss)} per process, ` +
      `${gb(stats.peakConcurrentRss)} all lanes; fixture ${fixtureChanged ? "changed" : "unchanged"} (${fixtureHash.slice(0, 12)})`,
  );
  if (unaccepted.length > 0) {
    console.error(`not accepted (${unaccepted.length}):\n  ${unaccepted.slice(0, 50).join("\n  ")}`);
    return 1;
  }
  if (exit === 0) log(`every test of every pass is accepted on the fixture (${new Date().toISOString()})`);
  return exit;
}

if (import.meta.main) {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      killAll();
      try {
        onStop();
      } catch {}
      process.exit(130);
    });
  }
  process.exit(await main());
}
