// Issue 1926: the build-reproducibility check exits 0 when two build roots are byte-identical with relative metadata, and 1 when one creation byte
// differs, when a metadata remapping is absolute, or when nothing is compared. The planted roots use forge's layout (<root>/<link|impl>/<Name>.sol/<Name>.json)
// and a small fixture stage table, so the same comparison the contract-build-reproducibility job runs is exercised here.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { absolutePathsIn, compareRoots, exitCodeOf, summaryLine, targetsOf } from "../src/ci/check-build-reproducible.ts";
import { parseStageTable } from "../src/stage-table.ts";

const SCRIPT = join(import.meta.dir, "..", "src", "ci", "check-build-reproducible.ts");
const REAL_TABLE = join(import.meta.dir, "..", "..", "scripts", "deploy", "stage-table.json");
const scratch = mkdtempSync(join(tmpdir(), "build-reproducible-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const table = parseStageTable(JSON.parse(await Bun.file(REAL_TABLE).text()), REAL_TABLE);
const targets = targetsOf(table);
const RELATIVE = ["@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/", "forge-std/=lib/forge-std/src/"];

/** One build root with every target of the real stage table. `tweak` may change one artifact. */
function plant(label: string, tweak: (name: string, art: any) => void = () => {}): string {
  const root = join(scratch, label);
  for (const t of targets) {
    const art: any = {
      bytecode: { object: `0x6080${Buffer.from(t.name).toString("hex")}00a26469706673` },
      deployedBytecode: { object: `0x6080${Buffer.from(t.name).toString("hex")}01` },
      metadata: { settings: { remappings: [...RELATIVE], compilationTarget: { [`contracts/${t.name}.sol`]: t.name }, libraries: {} }, sources: { [`contracts/${t.name}.sol`]: {} } },
    };
    tweak(t.name, art);
    mkdirSync(join(root, t.dir, `${t.name}.sol`), { recursive: true });
    writeFileSync(join(root, t.dir, `${t.name}.sol`, `${t.name}.json`), JSON.stringify(art));
  }
  return root;
}
const run = (a: string, b: string) => Bun.spawnSync(["bun", SCRIPT, "--a-out", a, "--b-out", b, "--table", REAL_TABLE], { stdout: "pipe", stderr: "pipe" });

describe("contract build reproducibility check (issue 1926)", () => {
  test("the targets are every library, CREATE2 library and proxy implementation of the stage table", () => {
    const names = targets.map((t) => t.name);
    expect(names).toContain("TickMath");
    for (const l of table.create2Libraries ?? []) expect(names).toContain(l.artifact);
    for (const s of table.stages) for (const p of s.proxies ?? []) expect(names).toContain(p.contract);
    expect(targets.find((t) => t.name === "TickMath")!.dir).toBe("link");
    expect(targets.filter((t) => t.kind === "implementation").length).toBeGreaterThan(0);
  });

  test("identical roots exit 0 with a non-zero compared count, 0 differ and 0 absolute paths", () => {
    const r = run(plant("same-a"), plant("same-b"));
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain(`compared ${targets.length} artifact(s), ${targets.length} identical, 0 differ, 0 absolute path(s) in metadata`);
    expect(targets.length).toBeGreaterThan(0);
  });

  test("one flipped creation byte exits 1 naming the artifact", () => {
    const victim = targets.find((t) => t.kind === "create2-library")!.name;
    const b = plant("flip-b", (n, art) => { if (n === victim) art.bytecode.object = art.bytecode.object.replace(/73$/, "74"); });
    const r = run(plant("flip-a"), b);
    expect(r.exitCode).toBe(1);
    const out = r.stdout.toString();
    expect(out).toMatch(new RegExp(`FAIL create2-library +${victim} +CREATION CODE DIFFERS`));
    expect(out).toContain(`1 differ`);
  });

  test("one flipped runtime byte exits 1", () => {
    const victim = targets.find((t) => t.kind === "implementation")!.name;
    const rep = compareRoots(plant("rt-a"), plant("rt-b", (n, art) => { if (n === victim) art.deployedBytecode.object += "ff"; }), targets);
    expect(exitCodeOf(rep)).toBe(1);
    expect(rep.rows.find((x) => x.target.name === victim)!.detail).toContain("RUNTIME CODE DIFFERS");
  });

  test("an absolute remapping in the metadata exits 1 even when every byte matches", () => {
    const abs = "/home/runner/work/core/lib/openzeppelin-contracts-upgradeable/:openzeppelin-contracts/=lib/openzeppelin-contracts-upgradeable/lib/openzeppelin-contracts/";
    const b = plant("abs-b", (n, art) => { if (n === "TickMath") art.metadata.settings.remappings.unshift(abs); });
    const r = run(plant("abs-a"), b);
    expect(r.exitCode).toBe(1);
    const out = r.stdout.toString();
    expect(out).toContain(`FAIL absolute path in B:link/TickMath.sol/TickMath.json settings.remappings: ${abs}`);
    expect(out).toContain("0 differ, 1 absolute path(s) in metadata");
  });

  test("a missing artifact and an empty comparison both fail", () => {
    const rep = compareRoots(plant("miss-a"), join(scratch, "nothing-here"), targets);
    expect(rep.rows.every((x) => !x.ok)).toBe(true);
    expect(exitCodeOf(rep)).toBe(1);
    const empty = compareRoots(plant("empty-a"), plant("empty-b"), []);
    expect(summaryLine(empty)).toBe("compared 0 artifact(s), 0 identical, 0 differ, 0 absolute path(s) in metadata");
    expect(exitCodeOf(empty)).toBe(1);
  });

  test("absolute source keys, library keys and a checkout root inside the metadata are found", () => {
    const art = { metadata: { settings: { remappings: ["a/=lib/a/"], libraries: { "/x/contracts/lib/TickMath.sol:TickMath": "0x01" }, compilationTarget: {} }, sources: { "/x/contracts/A.sol": {} }, note: "/ci/checkout-b" } };
    const found = absolutePathsIn(art, "x", ["/ci/checkout-b"]).map((p) => p.where);
    expect(found).toEqual(["sources", "settings.libraries", "metadata"]);
    expect(absolutePathsIn({ rawMetadata: JSON.stringify({ settings: { remappings: ["/abs/:x/=y/"] } }) }, "raw")).toHaveLength(1);
  });

  test("bad arguments exit 2", () => {
    expect(Bun.spawnSync(["bun", SCRIPT, "--a-out", scratch], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(2);
    expect(Bun.spawnSync(["bun", SCRIPT, "--core-a", scratch, "--core-b", scratch], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(2);
  });
});
