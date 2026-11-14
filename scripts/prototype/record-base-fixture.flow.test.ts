// One-vault experiment (docs/technical/one-vault-rebalancer-proposal.md): the recorder's rounds end to end, against
// a fake `forge` on PATH (no compiler, no anvil, no network). The fake lists tests from a scenario, replays them
// against the fixture on disk the way BaseFixture's strict check would report, and in record mode writes a fork
// cache under $HOME holding what the selected tests read. Run: bun test scripts/prototype/record-base-fixture.flow.test.ts
// Scratch files go under RECORDER_TEST_DIR (default out/prototype-record-flow-test), never /tmp.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
const CLI = join(import.meta.dir, "record-base-fixture.ts");
const DIR = resolve(REPO, process.env.RECORDER_TEST_DIR ?? "out/prototype-record-flow-test");
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const slot = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const PIN = 100;
const FX = join(DIR, "proj/contracts/test/prototype/fixtures");

// The scenario: what each test reads, and whether it ends with a final strict check (fixtureCovered).
const scenario = {
  pin: PIN,
  listing: { "test/*": { "test/A.t.sol": { ATest: ["test_ok", "test_new", "test_fuzz"] }, "test/B.t.sol": { BTest: ["test_b"] } } },
  chain: {
    accounts: { [A]: { balance: "0x1", nonce: 0, code: "0x6001" }, [B]: { balance: "0x0", nonce: 0, code: "0x" } },
    storage: { [A]: { "0x1": "0x5", "0x2": "0x6" } },
  },
  tests: {
    "ATest.test_ok": { reads: [`${A}:${slot(1)}`], strict: true },
    "ATest.test_new": { reads: [`${A}:${slot(2)}`, B], strict: true },
    "ATest.test_fuzz": { reads: [`${A}:${slot(1)}`], strict: false },
    "BTest.test_b": { reads: [`${A}:${slot(1)}`], strict: true },
  },
};

const FAKE_FORGE = `#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const sc = JSON.parse(readFileSync(process.env.MOCK_SCENARIO, "utf8"));
const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const record = !!process.env.PROTO_RECORD_RPC;
appendFileSync(process.env.MOCK_LOG, JSON.stringify({ args, record, strict: process.env.PROTO_FIXTURE_STRICT ?? null }) + "\\n");
if (args[0] === "--version") { console.log("forge Version: fake"); process.exit(0); }
if (args[0] === "build") { console.error("No files changed, compilation skipped"); process.exit(0); }
const listing = {};
for (const l of Object.values(sc.listing)) Object.assign(listing, l);
if (args.includes("--list")) { console.log(JSON.stringify(sc.listing[val("--match-path")])); process.exit(0); }
const mp = val("--match-path");
const files = mp.startsWith("{") ? mp.slice(1, -1).split(",") : [mp];
const mc = val("--match-contract") ? new RegExp(val("--match-contract")) : null;
const mt = val("--match-test") ? new RegExp(val("--match-test")) : null;
const pad = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const out = {};
const fetched = { accounts: {}, storage: {} };
let alloc = {};
const ap = "contracts/test/prototype/fixtures/base-state.alloc.json";
if (!record && existsSync(ap)) alloc = JSON.parse(readFileSync(ap, "utf8"));
for (const f of files) for (const [c, ts] of Object.entries(listing[f] ?? {})) {
  if (mc && !mc.test(c)) continue;
  const results = {};
  for (const t of ts) {
    if (mt && !mt.test(t + "()")) continue; // forge matches --match-test against the signature
    const spec = sc.tests[c + "." + t];
    const strict = process.env.PROTO_FIXTURE_STRICT === "1";
    const logs = strict ? ["fixture-strict: setUp"] : [];
    let reason = null;
    for (const r of spec.reads) {
      const [a, s] = r.split(":");
      if (record) {
        fetched.accounts[a] = sc.chain.accounts[a];
        if (s) { fetched.storage[a] = fetched.storage[a] ?? {}; fetched.storage[a][s] = sc.chain.storage[a][BigInt(s) === 1n ? "0x1" : "0x2"]; }
        continue;
      }
      if (!alloc[a]) { reason = (strict ? "FixtureStrictAccountMiss(" : "FixtureAccountMiss(") + a + ")"; break; }
      if (s && alloc[a].storage[pad(s)] === undefined) { reason = "FixtureSlotMiss(" + a + ", " + pad(s) + ")"; break; }
    }
    if (!record && !reason && strict && spec.strict) {
      logs.push("fixture-strict: final");
      const accts = [...new Set(spec.reads.map((r) => r.split(":")[0].slice(2)))].join("");
      logs.push("fixture-manifest-accounts: 0x" + accts);
      const slots = spec.reads.filter((r) => r.includes(":")).map((r) => r.split(":")[0].slice(2) + pad(r.split(":")[1]).slice(2)).join("");
      if (slots) logs.push("fixture-manifest-slots: 0x" + slots);
    }
    results[t + "()"] = { status: reason ? "Failure" : "Success", reason, kind: { Unit: {} }, decoded_logs: logs, duration: "10ms" };
  }
  out[f + ":" + c] = { duration: "1s", test_results: results };
}
if (record) {
  const dir = join(process.env.HOME, ".foundry/cache/rpc/base");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, String(sc.pin)), JSON.stringify({ meta: { block_env: { number: "0x" + sc.pin.toString(16), timestamp: "0x10", basefee: 7 } }, accounts: fetched.accounts, storage: fetched.storage }));
}
console.log(JSON.stringify(out));
const failed = Object.values(out).some((s) => Object.values(s.test_results).some((r) => r.status === "Failure"));
process.exit(failed ? 1 : 0);
`;

function setup() {
  const proj = join(DIR, "proj");
  mkdirSync(join(proj, "test"), { recursive: true });
  mkdirSync(FX, { recursive: true });
  writeFileSync(join(proj, "foundry.toml"), '[profile.default]\nsrc = "src"\nlibs = ["lib"]\nauto_detect_remappings = false\n');
  writeFileSync(join(proj, "test/A.t.sol"), "contract ATest {}\n");
  writeFileSync(join(proj, "test/B.t.sol"), "contract BTest {}\n");
  // The committed fixture: A with slot 1 only.
  const alloc = { [A]: { balance: "0x1", nonce: "0x0", code: "0x6001", storage: { [slot(1)]: slot(5) } } };
  const meta = { description: "d", chainId: 8453, block: PIN, timestamp: 16, basefee: 7, upstreamHost: "h", accounts: [A], slots: [[slot(1)]] };
  writeFileSync(join(FX, "base-state.alloc.json"), JSON.stringify(alloc, null, 1) + "\n");
  writeFileSync(join(FX, "base-state.meta.json"), JSON.stringify(meta, null, 1) + "\n");
  const bin = join(DIR, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "forge"), FAKE_FORGE);
  chmodSync(join(bin, "forge"), 0o755);
  writeFileSync(join(DIR, "scenario.json"), JSON.stringify(scenario));
  return { proj, bin };
}

const { proj, bin } = setup();
const LOG = join(DIR, "forge-calls.jsonl");

function run(extra: string[] = []) {
  writeFileSync(LOG, "");
  const p = Bun.spawnSync(
    ["bun", CLI, "--pin", String(PIN), "--match-path", "test/*", "--no-anvil", "--lanes", "1", "--state-dir", join(DIR, "state"), ...extra],
    {
      cwd: proj,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME ?? "", MOCK_SCENARIO: join(DIR, "scenario.json"), MOCK_LOG: LOG },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const calls = readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString(), calls };
}
const passes = () => JSON.parse(readFileSync(join(FX, "base-state.passes.json"), "utf8"));
const allocNow = () => JSON.parse(readFileSync(join(FX, "base-state.alloc.json"), "utf8"));
const testRuns = (calls: any[]) => calls.filter((c) => c.args[0] === "test" && !c.args.includes("--list"));

describe("rounds", () => {
  test("cold: replay first, record only the miss and the unprovable test, merge, replay them, accept all", () => {
    const r = run();
    expect(r.out).toContain("every test of every pass is accepted");
    expect(r.code).toBe(0);
    const runs = testRuns(r.calls);
    const records = runs.filter((c) => c.record);
    // One recording, of A.t.sol only, filtered to the two tests that needed it.
    expect(records.length).toBe(1);
    expect(records[0].args).toContain("test/A.t.sol");
    expect(records[0].args.join(" ")).toContain("^(?:test_fuzz|test_new)\\(");
    // The fixture grew by exactly what test_new read; nothing else changed.
    const a = allocNow();
    expect(Object.keys(a).sort()).toEqual([A, B]);
    expect(a[A].storage).toEqual({ [slot(1)]: slot(5), [slot(2)]: slot(6) });
    const p = passes();
    expect(p.lineage.length).toBe(2);
    const ua = p.units["test/A.t.sol@prototype"].tests;
    expect(ua["ATest.test_ok"]).toMatchObject({ proof: "strict", fixture: p.lineage[0] });
    expect(ua["ATest.test_new"]).toMatchObject({ proof: "strict", fixture: p.lineage[1] });
    expect(ua["ATest.test_fuzz"]).toMatchObject({ proof: "recorded", fixture: p.lineage[1] });
    expect(p.units["test/B.t.sol@prototype"].tests["BTest.test_b"]).toMatchObject({ proof: "strict" });
    // Every replay ran with the strict check on.
    expect(runs.filter((c) => !c.record).every((c) => c.strict === "1")).toBe(true);
  });

  test("rerun with nothing changed: no forge test at all", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(testRuns(r.calls).length).toBe(0);
    expect(r.out).toContain("every test of every pass is accepted");
  });

  test("a change in one test file reruns only that file; its recorded test needs a recording of the new key", () => {
    writeFileSync(join(proj, "test/A.t.sol"), "contract ATest { uint x; }\n");
    const r = run();
    expect(r.code).toBe(0);
    const runs = testRuns(r.calls);
    expect(runs.every((c) => c.args.includes("test/A.t.sol"))).toBe(true);
    const records = runs.filter((c) => c.record);
    expect(records.length).toBe(1);
    expect(records[0].args.join(" ")).toContain("^(?:test_fuzz)\\(");
    expect(passes().lineage.length).toBe(2); // the recording added nothing
  });

  test("a grown fixture keeps strict proofs and redoes only recorded ones", () => {
    // Grow the fixture the way the recorder would (a superset of the same pin) and extend the lineage.
    const a = allocNow();
    a[B].storage = { [slot(9)]: slot(1) };
    writeFileSync(join(FX, "base-state.alloc.json"), JSON.stringify(a, null, 1) + "\n");
    const meta = JSON.parse(readFileSync(join(FX, "base-state.meta.json"), "utf8"));
    meta.slots[meta.accounts.indexOf(B)] = [slot(9)];
    writeFileSync(join(FX, "base-state.meta.json"), JSON.stringify(meta, null, 1) + "\n");
    // Not grown by the recorder: the new hash is not in the lineage, so every fixture-dependent proof is redone.
    const r = run();
    expect(r.code).toBe(0);
    const ran = testRuns(r.calls).filter((c) => !c.record);
    expect(ran.length).toBeGreaterThan(0);
    expect(passes().lineage.length).toBe(1);
  });

  test("an unknown argument or an override variable stops it", () => {
    const p = Bun.spawnSync(["bun", CLI, "--bogus"], { cwd: proj, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).not.toBe(0);
    const q = Bun.spawnSync(["bun", CLI, "--pin", "100"], {
      cwd: proj,
      env: { PATH: `${bin}:${process.env.PATH}`, PROTO_SIM_TAG: "x" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(q.exitCode).not.toBe(0);
    expect(q.stderr.toString()).toContain("unset before recording");
    expect(existsSync(join(FX, "base-state.alloc.json"))).toBe(true);
  });
});
