// One-vault experiment (docs/technical/one-vault-rebalancer-proposal.md): the recorder's logic without forge.
// Run: bun test scripts/prototype/record-base-fixture.test.ts
// Scratch files go under RECORDER_TEST_DIR (default out/prototype-record-test), never /tmp.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { overrideVars, parseArgs } from "./record-base-fixture";
import {
  type Account,
  type Batch,
  type Fixture,
  type PassesFile,
  type StaticInfo,
  type TestResult,
  type Unit,
  FixtureConflict,
  SIM_PATH,
  SIM_RUNS,
  SourceIndex,
  analyzeUnit,
  applyOutcome,
  batchFilters,
  cacheToAccounts,
  classify,
  clampToFixture,
  decodeBitset,
  decodeManifestLogs,
  encodeBitset,
  fixtureOrder,
  inheritedEnv,
  isAncestor,
  loadProjectConfig,
  mergeAccounts,
  parseDuration,
  parseForgeJson,
  parseImports,
  parseMiss,
  planBatches,
  planPasses,
  planUnits,
  readFixture,
  runLanes,
  serializeFixture,
  simEnv,
  stripComments,
  syncLaneBuild,
  testAccepted,
  unitKey,
} from "./record-fixture-lib";

const REPO = resolve(import.meta.dir, "../..");
const SCRATCH = resolve(REPO, process.env.RECORDER_TEST_DIR ?? "out/prototype-record-test");
mkdirSync(SCRATCH, { recursive: true });
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const P = "contracts/test/prototype";

// ─── passes and units ───────────────────────────────────────────────────────────────────────────

describe("passes", () => {
  test("the --sim passes are the old script's, in order, the last over every prototype test", () => {
    const ps = planPasses({ withSim: true, simRuns: SIM_RUNS, matchPath: `${P}/**` });
    expect(ps.map((p) => p.label)).toEqual([
      "sim default-lprecenter",
      "sim auction-lprecenter",
      "sim tuned",
      "sim default",
      "sim timed-tuned",
      "sim timed-default",
      "prototype + sim auction",
    ]);
    expect(ps.slice(0, 6).every((p) => p.path === SIM_PATH)).toBe(true);
    expect(ps[6].path).toBe(`${P}/**`);
    expect(ps[0].env).toEqual({ PROTO_SIM: "1", PROTO_SIM_RUN: "default", PROTO_SIM_LP: "recenter" });
    expect(ps[5].env).toEqual({
      PROTO_SIM: "1",
      PROTO_SIM_RUN: "default",
      PROTO_SIM_LP: "static",
      PROTO_SIM_FLOWS: "timed",
      PROTO_SIM_ATTACKS: "1",
    });
    expect(simEnv("timed-tuned").PROTO_SIM_ATTACKS).toBeUndefined();
    expect(ps[6].env).toEqual({ PROTO_SIM: "1", PROTO_SIM_RUN: "auction", PROTO_SIM_LP: "static" });
  });

  test("a subset keeps the canonical order; the last selected run covers everything; no --sim is one pass", () => {
    const ps = planPasses({ withSim: true, simRuns: ["auction", "tuned"], matchPath: `${P}/**` });
    expect(ps.map((p) => [p.run, p.path])).toEqual([
      ["tuned", SIM_PATH],
      ["auction", `${P}/**`],
    ]);
    expect(planPasses({ withSim: false, simRuns: SIM_RUNS, matchPath: "x/**" })).toEqual([
      { label: "prototype", run: "prototype", path: "x/**", env: {} },
    ]);
    expect(() => planPasses({ withSim: true, simRuns: ["nope"], matchPath: "x" })).toThrow("unknown run");
  });

  test("units: every listed file of each pass under that pass's environment", () => {
    const ps = planPasses({ withSim: true, simRuns: ["tuned", "auction"], matchPath: `${P}/**` });
    const sim = { [`${P}/sim/RebalanceSim.t.sol`]: { RebalanceSimTest: ["test_sim_SEQ_1M_s0", "test_sim_EXT_1M_s0"] } };
    const all = { ...sim, [`${P}/Adapters.t.sol`]: { AdaptersTest: ["test_a"] }, [`${P}/Empty.t.sol`]: {} };
    const us = planUnits(ps, new Map<string, any>([[SIM_PATH, sim], [`${P}/**`, all]]));
    expect(us.map((u) => u.id)).toEqual([
      `${P}/sim/RebalanceSim.t.sol@tuned`,
      `${P}/Adapters.t.sol@auction`,
      `${P}/sim/RebalanceSim.t.sol@auction`,
    ]);
    expect(us[0].tests).toEqual(["RebalanceSimTest.test_sim_EXT_1M_s0", "RebalanceSimTest.test_sim_SEQ_1M_s0"]);
    expect(us[1].env.PROTO_SIM_RUN).toBe("auction");
  });
});

// ─── sources and keys ───────────────────────────────────────────────────────────────────────────

describe("sources", () => {
  test("comments go, strings stay", () => {
    const s = stripComments('a // x "y"\nb = "http://z"; /* c\nd */ e \'//f\'');
    expect(s).toContain('"http://z"');
    expect(s).toContain("'//f'");
    expect(s).not.toContain("x");
    expect(s.split("\n").length).toBe(3);
  });

  test("every import form", () => {
    const src = stripComments(`
      import "a.sol";
      import {X, Y} from "./b.sol";
      import {
        Z
      } from '../c.sol';
      import * as W from "d/e.sol";
      import "f.sol" as F;
      // import "commented.sol";
    `);
    expect(parseImports(src)).toEqual(["a.sol", "./b.sol", "../c.sol", "d/e.sol", "f.sol"]);
  });

  const cfg = loadProjectConfig(REPO);
  const idx = new SourceIndex(cfg);

  test("the import closure equals forge's own (its build cache), for every prototype test file", () => {
    const cachePath = process.env.RECORDER_FORGE_CACHE ?? "/drive2/home/lucas/tmp/recorder-speedup/forge/cache";
    const f = join(cachePath, "solidity-files-cache.json");
    if (!existsSync(f)) return; // needs a build of this checkout
    const files = JSON.parse(readFileSync(f, "utf8")).files as Record<string, { imports: string[] }>;
    const tests = Object.keys(files).filter((k) => k.startsWith(`${P}/`) && k.endsWith(".t.sol"));
    expect(tests.length).toBeGreaterThan(20);
    for (const t of tests) {
      const mine = idx.closure(t).filter((p) => p !== t);
      expect({ t, imports: mine }).toEqual({ t, imports: [...files[t].imports].sort() });
    }
  });

  test("static facts of real units", () => {
    const fixes = analyzeUnit(idx, `${P}/FlowQueueFixes.t.sol`);
    expect(fixes.runtimeFiles).toContain(`${P}/src/FlowQueue.sol`);
    expect(fixes.runtimeFiles.some((p) => p.includes("base-state"))).toBe(false);
    expect(fixes.envNames).toContain("PROTO_RECORD_RPC");
    expect(analyzeUnit(idx, `${P}/Invariants.t.sol`).strictCapable).toBe(false);
    expect(analyzeUnit(idx, `${P}/baseline/Invariants.t.sol`).strictCapable).toBe(false);
    expect(analyzeUnit(idx, `${P}/FlowQueue.t.sol`).ownsFixture).toBe(true);
    const adapters = analyzeUnit(idx, `${P}/Adapters.t.sol`);
    expect(adapters.strictCapable).toBe(true);
    expect(adapters.ownsFixture).toBe(false);
    expect(adapters.closure).toContain(`${P}/BaseFixture.sol`);
  });

  // A throwaway project: keys, dynamic reads.
  const proj = join(SCRATCH, "proj");
  const write = (p: string, s: string) => {
    mkdirSync(join(proj, p, ".."), { recursive: true });
    writeFileSync(join(proj, p), s);
  };
  write(
    "foundry.toml",
    '[profile.default]\nsrc = "src"\nlibs = ["lib"]\nauto_detect_remappings = false\nremappings = ["std/=lib/std/src/"]\n',
  );
  write("lib/std/src/Test.sol", "contract Test {}\n");
  write("src/A.sol", 'import "./B.sol";\ncontract A {}\n');
  write("src/B.sol", "contract B {}\n");
  write("src/Other.sol", "contract Other {}\n");
  write("data/x.json", "{}\n");
  write(
    "test/T.t.sol",
    'import {Test} from "std/Test.sol";\nimport "../src/A.sol";\ncontract T is Test { string constant P = "data/x.json"; function f() public { vm.readFile(P); vm.envOr("MY_FLAG", false); } }\n',
  );
  write("test/Bad.t.sol", 'contract Bad { function f(string memory p) public { vm.readFile(p); } }\n');
  const unit: Unit = { id: "test/T.t.sol@run", file: "test/T.t.sol", run: "run", env: { PROTO_SIM: "1" }, pass: "p", tests: [] };
  const keyOf = (env: Record<string, string> = {}, u = unit) => {
    const c = loadProjectConfig(proj);
    const i = new SourceIndex(c);
    return unitKey({ idx: i, unit: u, info: analyzeUnit(i, u.file), pin: 1, forgeVersion: "forge 1", env });
  };

  test("a key moves with its closure, its runtime files, its env and its pin, and with nothing else", () => {
    const k0 = keyOf();
    expect(keyOf()).toBe(k0);
    write("src/Other.sol", "contract Other { uint x; }\n");
    expect(keyOf()).toBe(k0); // not imported
    write("src/B.sol", "contract B { uint y; }\n");
    const k1 = keyOf();
    expect(k1).not.toBe(k0); // imported through A
    write("data/x.json", '{"a":1}\n');
    const k2 = keyOf();
    expect(k2).not.toBe(k1); // read at runtime
    expect(keyOf({ MY_FLAG: "1" })).not.toBe(k2); // a name its source spells out
    expect(keyOf({ PROTO_ANY: "1" })).not.toBe(k2);
    expect(keyOf({ UNRELATED: "1" })).toBe(k2);
    expect(keyOf({}, { ...unit, env: { PROTO_SIM: "0" } })).not.toBe(k2);
    expect(keyOf({ PROTO_RECORD_RPC: "x", PROTO_FIXTURE_CHECK: "1" })).toBe(k2); // the recorder's own
  });

  test("a computed file read stops the script", () => {
    const c = loadProjectConfig(proj);
    expect(() => analyzeUnit(new SourceIndex(c), "test/Bad.t.sol")).toThrow("cannot key");
  });

  test("inherited env hashes values and never stores them", () => {
    const info = { envNames: ["X_"] } as StaticInfo;
    const e = inheritedEnv(info, { X_A: "secret", FOUNDRY_PROFILE: "ci", HOME: "/h", PROTO_PIN: "1" });
    expect(e.map(([k]) => k)).toEqual(["FOUNDRY_PROFILE", "X_A"]);
    expect(JSON.stringify(e)).not.toContain("secret");
  });
});

// ─── results and proofs ─────────────────────────────────────────────────────────────────────────

const result = (o: Partial<TestResult>): TestResult => ({
  file: "f",
  contract: "C",
  name: "t",
  status: "Success",
  reason: null,
  kind: "Unit",
  logs: [],
  seconds: 1,
  ...o,
});
const strictInfo = { strictCapable: true, ownsFixture: false } as StaticInfo;

describe("results", () => {
  test("forge JSON: file, contract, name without parameters, status, logs, seconds", () => {
    const json = JSON.stringify({
      "test/A.t.sol:ATest": {
        duration: { secs: 1, nanos: 0 },
        test_results: {
          "test_ok()": { status: "Success", reason: null, kind: { Unit: { gas: 1 } }, decoded_logs: ["a: 1"], duration: { secs: 2, nanos: 500000000 } },
          "testFuzz_c(uint8)": { status: "Failure", reason: "boom", kind: { Fuzz: {} }, decoded_logs: [] },
        },
      },
    });
    const rs = parseForgeJson(`noise\n${json}`);
    expect(rs.map((r) => [r.file, r.contract, r.name, r.status, r.kind])).toEqual([
      ["test/A.t.sol", "ATest", "test_ok", "Success", "Unit"],
      ["test/A.t.sol", "ATest", "testFuzz_c", "Failure", "Fuzz"],
    ]);
    expect(rs[0].seconds).toBe(2.5);
    // One invariant campaign reported once, with each invariant's status inside.
    const inv = parseForgeJson(
      JSON.stringify({
        "t/I.t.sol:I": {
          test_results: {
            "invariant_a()": {
              status: "Failure",
              reason: "campaign",
              kind: { Invariant: {} },
              decoded_logs: ["x"],
              invariant_predicate_results: [
                { name: "invariant_a", status: "Success" },
                { name: "invariant_b", status: "Failure" },
              ],
            },
          },
        },
      }),
    );
    expect(inv.map((r) => [r.name, r.status, r.reason, r.kind])).toEqual([
      ["invariant_a", "Success", "campaign", "Invariant"],
      ["invariant_b", "Failure", "campaign", "Invariant"],
    ]);
    expect(parseDuration("1s 833ms 277µs 974ns")).toBeCloseTo(1.833277974, 9);
    expect(parseDuration("2m 3s")).toBe(123);
    expect(parseDuration("1h 0m 1s")).toBe(3601);
    expect(parseDuration("204ms 471µs 54ns")).toBeCloseTo(0.204471054, 9);
    expect(rs[0].logs).toEqual(["a: 1"]);
  });

  test("misses: the four errors, with account and slot", () => {
    const a = "0x" + "Ab".repeat(20);
    const s = "0x" + "07".padStart(64, "0");
    expect(parseMiss(`FixtureSlotMiss(${a}, ${s})`)).toEqual({ error: "FixtureSlotMiss", account: a.toLowerCase(), slot: s });
    expect(parseMiss(`FixtureAccountMiss(${a})`)?.error).toBe("FixtureAccountMiss");
    expect(parseMiss(`x: FixtureStrictAccountMiss(${a})`)?.error).toBe("FixtureStrictAccountMiss");
    expect(parseMiss(`FixtureStrictSlotMiss(${a}, ${s})`)?.slot).toBe(s);
    expect(parseMiss("nothing pulled: 1 != 2")).toBeUndefined();
    expect(parseMiss(null)).toBeUndefined();
  });

  test("manifest logs decode to accounts and account:slot pairs", () => {
    const a = "11".repeat(20);
    const b = "22".repeat(20);
    const s = "33".repeat(32);
    const m = decodeManifestLogs([`fixture-manifest-accounts: 0x${a}${b}`, `fixture-manifest-slots: 0x${a}${s}`, "other: 1"]);
    expect([...m.accounts]).toEqual([`0x${a}`, `0x${b}`]);
    expect([...m.slots]).toEqual([`0x${a}:0x${s}`]);
    expect(() => decodeManifestLogs(["fixture-manifest-slots: 0x1234"])).toThrow();
  });

  test("proof classes", () => {
    const both = ["fixture-strict: setUp", "fixture-strict: final"];
    expect(classify(result({ logs: both }), strictInfo, true).cls).toBe("strict");
    expect(classify(result({ logs: both }), { ...strictInfo, strictCapable: false }, true).cls).toBe("unproven");
    expect(classify(result({ logs: both }), strictInfo, false).cls).toBe("unproven"); // strict off proves nothing new
    expect(classify(result({ logs: ["fixture-strict: setUp"] }), strictInfo, true).cls).toBe("unproven"); // no final check
    expect(classify(result({ logs: [] }), strictInfo, true).cls).toBe("independent");
    expect(classify(result({ logs: [] }), { ...strictInfo, ownsFixture: true }, true).cls).toBe("unproven");
    // Skips: before BaseFixture.setUp (no marker) they read no fixture state; after it, only a checked skip counts.
    expect(classify(result({ status: "Skipped" }), strictInfo, true).cls).toBe("skipped");
    expect(classify(result({ status: "Skipped", logs: ["fixture-strict: setUp"] }), strictInfo, true).cls).toBe("unproven");
    expect(
      classify(result({ status: "Skipped", reason: "finding 12 [fixture-strict: checked]", logs: ["fixture-strict: setUp"] }), strictInfo, true).cls,
    ).toBe("strict");
    expect(classify(result({ status: "Skipped" }), strictInfo, false).cls).toBe("unproven");
    expect(classify(result({ status: "Failure", reason: "boom" }), strictInfo, true).cls).toBe("fail");
    const miss = classify(result({ status: "Failure", reason: `FixtureSlotMiss(0x${"1".repeat(40)}, 0x${"2".repeat(64)})` }), strictInfo, true);
    expect(miss.cls).toBe("miss");
  });

  test("miss collection: what a replay result asks for next", () => {
    const o = { key: "K", fixture: "F", strictRun: true };
    const miss = (error: string) => ({ cls: "miss" as const, miss: { error, account: "0x1" } });
    // Never recorded at this key: any failure, miss or unprovable pass goes to a recording.
    expect(applyOutcome(undefined, miss("FixtureSlotMiss"), o).verdict).toBe("record");
    expect(applyOutcome(undefined, { cls: "fail" }, o).verdict).toBe("record");
    expect(applyOutcome({ recordedKey: "OLD" }, { cls: "unproven" }, o).verdict).toBe("record");
    // Recorded at this key.
    expect(applyOutcome({ recordedKey: "K" }, { cls: "unproven" }, o)).toEqual({
      state: { proof: "recorded", fixture: "F", recordedKey: "K" },
      verdict: "accepted",
    });
    expect(applyOutcome({ recordedKey: "K" }, miss("FixtureStrictAccountMiss"), o).verdict).toBe("replay-plain");
    expect(applyOutcome({ recordedKey: "K" }, miss("FixtureStrictAccountMiss"), { ...o, strictRun: false }).verdict).toBe("failed");
    expect(applyOutcome({ recordedKey: "K" }, miss("FixtureSlotMiss"), o).verdict).toBe("failed");
    expect(applyOutcome({ recordedKey: "K" }, { cls: "fail" }, o).verdict).toBe("failed");
    // Proven: the recording stays on record.
    expect(applyOutcome({ recordedKey: "K" }, { cls: "strict" }, o).state).toEqual({ proof: "strict", fixture: "F", recordedKey: "K" });
  });
});

// ─── skip and resume ────────────────────────────────────────────────────────────────────────────

describe("skip and resume", () => {
  const lineage = ["F0", "F1", "F2"];
  test("strict proofs hold on any later fixture of the lineage, not an earlier or unknown one", () => {
    expect(isAncestor(lineage, "F1", "F2")).toBe(true);
    expect(isAncestor(lineage, "F2", "F2")).toBe(true);
    expect(isAncestor(lineage, "F2", "F1")).toBe(false);
    expect(isAncestor(lineage, "X", "F2")).toBe(false);
    expect(testAccepted({ proof: "strict", fixture: "F1" }, "K", "K", "F2", lineage)).toBe(true);
    expect(testAccepted({ proof: "strict", fixture: "F2" }, "K", "K", "F1", lineage)).toBe(false);
    expect(testAccepted({ proof: "strict", fixture: "F1" }, "K2", "K", "F2", lineage)).toBe(false); // key moved
  });

  test("recorded proofs hold only on the exact fixture and the recorded key", () => {
    const r = { proof: "recorded" as const, fixture: "F1", recordedKey: "K" };
    expect(testAccepted(r, "K", "K", "F1", lineage)).toBe(true);
    expect(testAccepted(r, "K", "K", "F2", lineage)).toBe(false); // the fixture grew: replay again
    expect(testAccepted({ ...r, recordedKey: "K0" }, "K", "K", "F1", lineage)).toBe(false);
  });

  test("independent and skipped hold while the key holds", () => {
    expect(testAccepted({ proof: "independent" }, "K", "K", "F9", [])).toBe(true);
    expect(testAccepted({ proof: "skipped" }, "K", "K", "F9", [])).toBe(true);
    expect(testAccepted({ proof: "skipped" }, "K2", "K", "F9", [])).toBe(false);
    expect(testAccepted(undefined, "K", "K", "F1", lineage)).toBe(false);
    expect(testAccepted({ recordedKey: "K" }, "K", "K", "F1", lineage)).toBe(false); // recorded, not yet replayed
  });

  test("a committed passes file round-trips", () => {
    const p: PassesFile = {
      description: "d",
      pin: 1,
      lineage: ["F"],
      units: { u: { key: "K", file: "f", run: "r", env: {}, tests: { "C.t": { proof: "strict", fixture: "F" } } } },
    };
    const back = JSON.parse(JSON.stringify(p)) as PassesFile;
    expect(testAccepted(back.units.u.tests["C.t"], "K", back.units.u.key, "F", back.lineage)).toBe(true);
  });
});

// ─── fixture ────────────────────────────────────────────────────────────────────────────────────

const acct = (storage: [string, string][] = [], balance = "0x0"): Account => ({
  balance,
  nonce: "0x0",
  code: "0x",
  storage: new Map(storage),
});
const slot = (n: number) => "0x" + n.toString(16).padStart(64, "0");

describe("fixture", () => {
  test("the committed fixture reads, and its meta index matches its alloc", () => {
    const r = readFixture(REPO);
    expect(r).toBeDefined();
    expect(r!.fixture.accounts.size).toBeGreaterThan(100);
    expect(r!.fixture.meta.chainId).toBe(8453);
  });

  test("serialize then read gives the same content, and the same bytes twice", () => {
    const dir = join(SCRATCH, "fx");
    const f: Fixture = {
      meta: { description: "d", chainId: 8453, block: 5, timestamp: 6, basefee: 7, upstreamHost: "h" },
      accounts: new Map([
        ["0x00000000000000000000000000000000000000bb", { ...acct([[slot(2), slot(9)], [slot(1), slot(8)]]), code: "0x6001" }],
        ["0x00000000000000000000000000000000000000aa", acct([], "0x10")],
      ]),
    };
    const s = serializeFixture(f);
    mkdirSync(join(dir, "contracts/test/prototype/fixtures"), { recursive: true });
    writeFileSync(join(dir, "contracts/test/prototype/fixtures/base-state.alloc.json"), s.alloc);
    writeFileSync(join(dir, "contracts/test/prototype/fixtures/base-state.meta.json"), s.meta);
    const back = readFixture(dir)!;
    expect(serializeFixture(back.fixture)).toEqual(s);
    expect(JSON.parse(s.meta).accounts[0]).toBe("0x00000000000000000000000000000000000000aa");
    expect(JSON.parse(s.meta).slots[1]).toEqual([slot(1), slot(2)]);
  });

  test("a recording merges in; a differing value is refused; nothing is dropped", () => {
    const base = new Map([["0xa", acct([[slot(1), slot(5)]])]]);
    const add = new Map([
      ["0xa", acct([[slot(1), slot(5)], [slot(2), slot(6)]])],
      ["0xb", acct([[slot(3), slot(7)]])],
    ]);
    expect(mergeAccounts(base, add)).toEqual({ accounts: 1, slots: 2 });
    expect(base.get("0xa")!.storage.size).toBe(2);
    expect(mergeAccounts(base, new Map([["0xa", acct()]]))).toEqual({ accounts: 0, slots: 0 });
    expect(base.get("0xa")!.storage.size).toBe(2);
    expect(() => mergeAccounts(base, new Map([["0xa", acct([[slot(1), slot(4)]])]]))).toThrow(FixtureConflict);
    expect(() => mergeAccounts(base, new Map([["0xb", acct([], "0x1")]]))).toThrow(FixtureConflict);
  });

  test("a fork cache converts like the old script, without forge's own accounts", () => {
    const cache = {
      meta: { block_env: { number: "0x10", timestamp: "0x20", basefee: 7 } },
      accounts: {
        "0xAA00000000000000000000000000000000000000": {
          balance: "0x5",
          nonce: 2,
          code: { LegacyAnalyzed: { bytecode: "0x60016002000000", original_len: 4 } },
        },
        "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d": { balance: "0x0", nonce: 0, code: null },
      },
      storage: { "0xAA00000000000000000000000000000000000000": { "0x1": "0x2" } },
    };
    const h = cacheToAccounts(cache);
    expect([h.block, h.timestamp, h.basefee]).toEqual([16, 32, 7]);
    expect([...h.accounts.keys()]).toEqual(["0xaa00000000000000000000000000000000000000"]);
    const a = h.accounts.get("0xaa00000000000000000000000000000000000000")!;
    expect([a.code, a.nonce, a.storage.get(slot(1))]).toEqual(["0x60016002", "0x2", slot(2)]);
  });

  test("manifests: bitsets over the fixture order, clamped to the fixture", () => {
    const f: Fixture = {
      meta: {} as any,
      accounts: new Map([
        ["0xb", acct([[slot(1), slot(1)]])],
        ["0xa", acct([[slot(2), slot(1)], [slot(1), slot(1)]])],
      ]),
    };
    const order = fixtureOrder(f);
    expect(order.accounts).toEqual(["0xa", "0xb"]);
    expect(order.slots).toEqual([`0xa:${slot(1)}`, `0xa:${slot(2)}`, `0xb:${slot(1)}`]);
    const m = clampToFixture({ accounts: new Set(["0xb", "0xz"]), slots: new Set([`0xa:${slot(2)}`, `0xa:${slot(9)}`]) }, f);
    expect([...m.accounts].sort()).toEqual(["0xa", "0xb"]);
    expect([...m.slots]).toEqual([`0xa:${slot(2)}`]);
    expect(decodeBitset(encodeBitset(m.slots, order.slots), order.slots)).toEqual(m.slots);
    expect(decodeBitset(encodeBitset(m.accounts, order.accounts), order.accounts)).toEqual(new Set(["0xa", "0xb"]));
  });
});

// ─── batches and lanes ──────────────────────────────────────────────────────────────────────────

describe("lanes", () => {
  const u = (file: string, env: Record<string, string>): Unit => ({ id: `${file}@r`, file, run: "r", env, pass: "p", tests: ["C.t1", "C.t2"] });
  const A = { PROTO_SIM_RUN: "a" };
  const B = { PROTO_SIM_RUN: "b" };

  test("batches: one environment per forge process, long units alone, longest first", () => {
    const items = [
      { unit: u("x/Sim.t.sol", A), estimate: 900 },
      { unit: u("x/A.t.sol", A), estimate: 10 },
      { unit: u("x/B.t.sol", A), estimate: 20 },
      { unit: u("x/C.t.sol", B), estimate: 40 },
      { unit: u("x/D.t.sol", A), tests: ["C.t1"], estimate: 5 },
    ];
    const bs = planBatches(items, () => true, { lanes: 2 });
    expect(bs.map((b) => b.items.map((it) => it.unit.file))).toEqual([
      ["x/Sim.t.sol"],
      ["x/C.t.sol"],
      ["x/B.t.sol", "x/A.t.sol"],
      ["x/D.t.sol"],
    ]);
    expect(batchFilters(bs[2])).toEqual(["--match-path", "{x/A.t.sol,x/B.t.sol}"]);
    expect(batchFilters(bs[3])).toEqual(["--match-path", "x/D.t.sol", "--match-contract", "^(?:C)$", "--match-test", "^(?:t1)\\("]);
    const strictSplit = planBatches(items.slice(1, 3), (it) => it.unit.file.endsWith("A.t.sol"), { lanes: 1 });
    expect(strictSplit.map((b) => [b.strict, b.items.length])).toEqual([
      [false, 1],
      [true, 1],
    ]);
  });

  test("records: one test file per forge process", () => {
    const items = [
      { unit: u("x/A.t.sol", A), estimate: 10 },
      { unit: u("x/B.t.sol", A), estimate: 20 },
    ];
    expect(planBatches(items, () => false, { lanes: 1, longSeconds: 0 }).length).toBe(2);
  });

  test("runLanes keeps at most `lanes` batches running and gives each worker its own lane", async () => {
    const bs: Batch[] = Array.from({ length: 7 }, (_, i) => ({ env: {}, items: [], estimate: 7 - i, strict: true }));
    let now = 0;
    let peak = 0;
    const lanesSeen = new Set<number>();
    const busy = new Set<number>();
    const done = await runLanes(bs, 3, async (b, lane) => {
      expect(busy.has(lane)).toBe(false);
      busy.add(lane);
      lanesSeen.add(lane);
      peak = Math.max(peak, ++now);
      await Bun.sleep(5 + b.estimate);
      now--;
      busy.delete(lane);
      return b.estimate;
    });
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(3);
    expect([...lanesSeen].sort()).toEqual([0, 1, 2]);
  });

  test("lane build dirs: a copy with the out paths rewritten, sim outputs left out, synced once", () => {
    const base = { out: join(SCRATCH, "base/out"), cache: join(SCRATCH, "base/cache") };
    const lane = { out: join(SCRATCH, "lane/out"), cache: join(SCRATCH, "lane/cache") };
    mkdirSync(join(base.out, "A.sol"), { recursive: true });
    mkdirSync(join(base.out, "prototype"), { recursive: true });
    mkdirSync(join(base.cache, "solidity-files-cache.json.abi/h/gen"), { recursive: true });
    writeFileSync(join(base.out, "A.sol/A.json"), "{}");
    writeFileSync(join(base.out, "prototype/sim.json"), "{}");
    const paths = { artifacts: base.out, build_infos: join(base.out, "build-info"), sources: "src" };
    writeFileSync(join(base.cache, "solidity-files-cache.json"), JSON.stringify({ paths, files: { a: 1 } }));
    writeFileSync(join(base.cache, "solidity-files-cache.json.abi/h/gen/cache.json"), JSON.stringify({ paths, files: {} }));
    writeFileSync(join(base.cache, "solidity-files-cache.json.abi.lock"), "");
    expect(syncLaneBuild(base, lane, [join(base.out, "prototype")])).toBe(true);
    expect(existsSync(join(lane.out, "A.sol/A.json"))).toBe(true);
    expect(existsSync(join(lane.out, "prototype"))).toBe(false);
    expect(existsSync(join(lane.cache, "solidity-files-cache.json.abi.lock"))).toBe(false);
    for (const f of ["solidity-files-cache.json", "solidity-files-cache.json.abi/h/gen/cache.json"]) {
      const j = JSON.parse(readFileSync(join(lane.cache, f), "utf8"));
      expect(j.paths.artifacts).toBe(lane.out);
      expect(j.paths.build_infos).toBe(join(lane.out, "build-info"));
      expect(j.paths.sources).toBe("src");
    }
    expect(syncLaneBuild(base, lane)).toBe(false); // the base did not change
    writeFileSync(join(base.cache, "solidity-files-cache.json"), JSON.stringify({ paths, files: { a: 2 } }));
    expect(syncLaneBuild(base, lane)).toBe(true);
  });
});

// ─── command line ───────────────────────────────────────────────────────────────────────────────

describe("command line", () => {
  test("the old flags keep their meaning", () => {
    const o = parseArgs(
      ["--pin", "55462550", "--sim", "--sim-runs", "tuned,auction", "--threads", "8", "--forge-out", "o", "--forge-cache", "c", "--no-anvil", "--match-path", "m"],
      {},
    );
    expect([o.pin, o.withSim, o.simRuns, o.threads, o.forgeOut, o.forgeCache, o.useAnvil, o.matchPath]).toEqual([
      55462550, true, ["tuned", "auction"], 8, "o", "c", false, "m",
    ]);
    expect(parseArgs([], { BASE_UPSTREAM_RPC: "https://x" }).rpc).toBe("https://x");
  });

  test("new flags, defaults, and refusals", () => {
    const d = parseArgs([], {});
    expect([d.pin, d.lanes, d.recordLanes, d.threads, d.stateDir, d.force, d.fresh, d.maxRounds, d.dryRun]).toEqual([
      undefined, 2, 1, 4, "out/prototype-record", false, false, 3, false,
    ]);
    const o = parseArgs(["--lanes", "3", "--record-lanes", "2", "--force", "--fresh", "--dry-run", "--state-dir", "s"], {});
    expect([o.lanes, o.recordLanes, o.force, o.fresh, o.dryRun, o.stateDir]).toEqual([3, 2, true, true, true, "s"]);
    expect(() => parseArgs(["--bogus"], {})).toThrow("unknown argument");
    expect(() => parseArgs(["--lanes", "0"], {})).toThrow("positive integer");
    expect(() => parseArgs(["--pin"], {})).toThrow("needs a value");
    expect(overrideVars({ PROTO_SIM_TAG: "x", PROTO_LEVER_A: "1", PROTO_SIM: "1" })).toEqual(["PROTO_SIM_TAG", "PROTO_LEVER_A"]);
  });
});
