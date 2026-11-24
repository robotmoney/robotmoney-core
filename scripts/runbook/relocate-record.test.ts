// scripts/runbook/relocate-record.test.ts: the copied Deploy 4 record's build paths relocated to clean local checkouts (v0.10.0 P0.91, v0.9.0 P0.91).
import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitCheckoutProblem, parseArgs, relocateRecord, type Pin } from "./relocate-record.ts";
import { V080_PINS, V080_SHA, relocate } from "./relocate-deploy4-v080.ts";

const CORE = "7c23569f85e96232fc75bbba32ebbd469da31966";
const V090 = "26b2dddb556a7f1a54673c3f83b30ec9fc6c8872";
const V090_PINS: Pin[] = [
  ...V080_PINS,
  { proxy: "rebalancer", implementation: "0xD0344162527b7e8B0A07Cb20551203138DbEf2Cc", sha: V090 },
  { proxy: "fund", implementation: "0xb309256290fe5dC64b2e3069123c60cfad22e6C1", sha: V090 },
  { proxy: "queue", implementation: "0x94051e739E7725bd193CB1ed743A035dE60F4Fa0", sha: V090 },
];
const entry = (p: Pin, sha?: string) => ({ proxy_name: p.proxy, to_implementation: p.implementation, build: `/old/${p.sha.slice(0, 4)}`, schedule_tx: "s", execute_tx: "e", ...(sha ? { build_sha: sha } : {}) });
/** The live 0.9.0 record's shape: the v0.8 entries carry build_sha (relocated by 0.9.0's P0.91), the 0.9.0 ones do not. */
const v090Record = () => ({ system: "fund", coreSha: CORE, proxy_upgrades: [...V080_PINS.map((p) => entry(p, V080_SHA)), ...V090_PINS.slice(2).map((p) => entry(p))] });
const CHECKOUTS = { [V080_SHA]: "/co/v080", [V090]: "/co/v090" };
const clean = () => undefined;

test("the five-entry 0.9.0 record: every build goes to the checkout of its SHA, original_build kept, a rerun keeps the first path", () => {
  const m = relocateRecord(v090Record(), { coreSha: CORE, pins: V090_PINS, checkouts: CHECKOUTS, checkoutProblem: clean });
  expect(m.proxy_upgrades.map((e: any) => [e.proxy_name, e.original_build, e.build, e.build_sha])).toEqual([
    ["fund", "/old/fa7c", "/co/v080", V080_SHA], ["queue", "/old/fa7c", "/co/v080", V080_SHA],
    ["rebalancer", "/old/26b2", "/co/v090", V090], ["fund", "/old/26b2", "/co/v090", V090], ["queue", "/old/26b2", "/co/v090", V090],
  ]);
  const again = relocateRecord(m, { pins: V090_PINS, checkouts: { [V080_SHA]: "/n/8", [V090]: "/n/9" }, checkoutProblem: clean });
  expect(again.proxy_upgrades[2].original_build).toBe("/old/26b2");
  expect(again.proxy_upgrades[2].build).toBe("/n/9");
});

test("the two-entry 0.8 record through relocate-deploy4-v080.ts", () => {
  const m = relocate({ system: "fund", coreSha: CORE, proxy_upgrades: V080_PINS.map((p) => entry(p)) }, "/new");
  expect(m.proxy_upgrades.map((e: any) => [e.original_build, e.build, e.build_sha])).toEqual([["/old/fa7c", "/new", V080_SHA], ["/old/fa7c", "/new", V080_SHA]]);
});

test("refused, with nothing changed: an unmapped SHA, a dirty checkout, a changed implementation, another count or core sha", () => {
  const go = (m: any, o: Partial<Parameters<typeof relocateRecord>[1]> = {}) => relocateRecord(m, { coreSha: CORE, pins: V090_PINS, checkouts: CHECKOUTS, checkoutProblem: clean, ...o });
  expect(() => go(v090Record(), { checkouts: { [V080_SHA]: "/co/v080" } })).toThrow(`no --checkout maps its build SHA ${V090}`);
  const dirty = v090Record();
  expect(() => go(dirty, { checkoutProblem: (d) => (d === "/co/v090" ? `${d} has changes: M x` : undefined) })).toThrow("has changes");
  expect(dirty.proxy_upgrades[0]).not.toHaveProperty("original_build");
  const moved = v090Record();
  moved.proxy_upgrades[3]!.to_implementation = "0x00000000000000000000000000000000000000ff";
  expect(() => go(moved)).toThrow("not the pinned 0xb309");
  const wrongSha = v090Record();
  (wrongSha.proxy_upgrades[2] as any).build_sha = V080_SHA;
  expect(() => go(wrongSha)).toThrow("records build_sha");
  expect(() => go({ ...v090Record(), proxy_upgrades: v090Record().proxy_upgrades.slice(0, 4) })).toThrow("4 proxy_upgrades entries, not the 5 pinned");
  expect(() => go({ ...v090Record(), coreSha: "x" })).toThrow("coreSha");
});

test("a real git checkout: clean at its SHA passes; another commit or a change is named", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "relocate-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(dir, "f"), "1");
  git("add", "f");
  git("commit", "-qm", "one");
  const sha = git("rev-parse", "HEAD");
  expect(gitCheckoutProblem(dir, sha)).toBeUndefined();
  expect(gitCheckoutProblem(dir, "0".repeat(40))).toContain("not 0000");
  writeFileSync(join(dir, "f"), "2");
  expect(gitCheckoutProblem(dir, sha)).toContain("has changes");
});

test("the CLI: parses the pins and checkouts, exits 1 on a refusal and 2 on bad arguments", () => {
  const a = parseArgs(["m.json", "--core-sha", CORE, "--entry", `fund@${V090_PINS[3]!.implementation}=${V090}`, "--checkout", `${V090}=/co/v090`]);
  expect(a.pins).toEqual([{ proxy: "fund", implementation: V090_PINS[3]!.implementation, sha: V090 }]);
  expect(a.checkouts[V090]).toBe("/co/v090");
  expect(() => parseArgs(["m.json", "--entry", "fund=abc"])).toThrow("NAME@IMPL=SHA");
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "relocate-cli-"));
  const file = join(dir, "publish-run.json");
  writeFileSync(file, JSON.stringify(v090Record()));
  const script = join(import.meta.dir, "relocate-record.ts");
  const args = [file, ...V090_PINS.flatMap((p) => ["--entry", `${p.proxy}@${p.implementation}=${p.sha}`]), "--checkout", `${V080_SHA}=${dir}`, "--checkout", `${V090}=${dir}`];
  const r = spawnSync("bun", [script, ...args], { encoding: "utf8" });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("is not a git checkout");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(v090Record());
  expect(spawnSync("bun", [script, file], { encoding: "utf8" }).status).toBe(2);
}, 60_000);
