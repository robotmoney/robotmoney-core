// Canonical: core issue 1499, core S9 (issue 1488).
// Process-level tests of the stage parity tools: the exit code is the contract each acceptance
// criterion states ("exits non-zero on any difference", "every govern row has a tx hash and receipt
// status 1", "a manifest for each of the four vaults").
// Run: bun test scripts/stage/tests/stage-cli.test.ts --timeout 60000
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadStageTable } from "../stage-table.ts";

const root = resolve(import.meta.dir, "..", "..", "..");
const tool = (n: string) => join(root, "scripts/stage", n);
const temps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "stagecli-"));
  temps.push(d);
  return d;
};
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

function run(args: string[], stdin?: string): { code: number; out: string } {
  const p = Bun.spawnSync(["bun", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
  });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
}
function file(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe("label-diff CLI", () => {
  const same = "PASS safe.threshold\nPASS vault.rmUSDC.paused\nRESULT: VERIFIED\n";
  test("identical label sets exit 0", () => {
    const d = tmp();
    const r = run([tool("label-diff.ts"), file(d, "s", same), file(d, "m", same)]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("identical");
  });
  test("a label only on stage exits non-zero and names it", () => {
    const d = tmp();
    const r = run([tool("label-diff.ts"), file(d, "s", same + "PASS stage.only\n"), file(d, "m", same)]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("only on stage: stage.only");
  });
  test("a label only on mainnet exits non-zero and names it", () => {
    const d = tmp();
    const r = run([tool("label-diff.ts"), file(d, "s", same), file(d, "m", same + "PASS main.only\n")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("only on mainnet: main.only");
  });
  test("an empty set exits non-zero, it proves nothing", () => {
    const d = tmp();
    const r = run([tool("label-diff.ts"), file(d, "s", ""), file(d, "m", same)]);
    expect(r.code).toBe(1);
  });
  test("missing arguments exit 64", () => {
    expect(run([tool("label-diff.ts")]).code).toBe(64);
  });
});

describe("sheet-diff CLI", () => {
  const stage = "export CHAIN_ID=918453\nexport TIMELOCK_MIN_DELAY=60\nexport USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\n";
  const prod = "export CHAIN_ID=8453\nexport TIMELOCK_MIN_DELAY=172800\nexport USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\n";
  test("sheets that differ only in parameter lines exit 0", () => {
    const d = tmp();
    expect(run([tool("sheet-diff.ts"), file(d, "s", stage), file(d, "p", prod)]).code).toBe(0);
  });
  test("a non-parameter difference exits non-zero and names the key", () => {
    const d = tmp();
    const r = run([tool("sheet-diff.ts"), file(d, "s", stage + "export EXTRA_SWITCH=1\n"), file(d, "p", prod)]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("EXTRA_SWITCH");
  });
  test("missing arguments exit 64", () => {
    expect(run([tool("sheet-diff.ts")]).code).toBe(64);
  });
});

describe("govern-rows CLI reads the govern run stdout", () => {
  const H = (n: number) => "0x" + n.toString(16).padStart(64, "0");
  const row = (name: string, n: number, status: number) => JSON.stringify({ row: name, txHash: H(n), status });
  test("every row with a tx hash and status 1 exits 0", () => {
    const r = run([tool("govern-rows.ts")], `noise\n${row("a", 1, 1)}\n${row("b", 2, 1)}\n`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("2 row(s)");
  });
  test("a row with receipt status 0 exits non-zero and names the row", () => {
    const r = run([tool("govern-rows.ts")], `${row("a", 1, 1)}\n${row("revert-row", 2, 0)}\n`);
    expect(r.code).toBe(1);
    expect(r.out).toContain("revert-row");
  });
  test("a row with no tx hash exits non-zero", () => {
    const r = run([tool("govern-rows.ts")], `${JSON.stringify({ row: "nohash", status: 1 })}\n`);
    expect(r.code).toBe(1);
    expect(r.out).toContain("nohash");
  });
  test("an output with no rows exits non-zero", () => {
    expect(run([tool("govern-rows.ts")], "nothing here\n").code).toBe(1);
  });
});

describe("twin-run-report CLI: a manifest for each of the four vaults", () => {
  const table = loadStageTable();
  const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
  /** Writes one manifest per table stage (a vault stage holds its vault address). */
  function manifestDir(skipFile?: string): string {
    const d = tmp();
    const made: Record<string, Record<string, unknown>> = {};
    let n = 1;
    for (const st of table.stages) {
      const file = st.manifest.split("/").pop()!;
      const m: Record<string, unknown> = st.vault ? { vault: A(n++) } : { chain_id: 918453 };
      made[file] = m;
      if (file !== skipFile) writeFileSync(join(d, file), JSON.stringify(m));
    }
    return d;
  }

  test("the table lists exactly four vaults", () => {
    expect(table.vaults.length).toBe(4);
  });
  test("a complete run exits 0 and lists every vault address", () => {
    const out = join(tmp(), "report.json");
    const r = run([tool("twin-run-report.ts"), "--manifest-dir", manifestDir(), "--json-out", out]);
    expect(r.code).toBe(0);
    for (const v of table.vaults) expect(r.out).toContain(v.key);
    expect(r.out).not.toContain("MISSING");
    const j = JSON.parse(require("node:fs").readFileSync(out, "utf8"));
    expect(j.vaults.length).toBe(4);
    expect(j.vaults.every((v: { address: string | null }) => v.address)).toBe(true);
  });
  test("a missing stage manifest exits non-zero and says MISSING", () => {
    const missing = table.stages.find((s) => s.name === "rwa")!.manifest.split("/").pop()!;
    const r = run([tool("twin-run-report.ts"), "--manifest-dir", manifestDir(missing)]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("MISSING");
  });
  test("a failing verifier label exits non-zero", () => {
    const d = manifestDir();
    const labels = file(d, "labels.txt", "PASS safe.threshold\nFAIL vault.rmUSDC.paused: wrong\n");
    const r = run([tool("twin-run-report.ts"), "--manifest-dir", d, "--labels", labels]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("vault.rmUSDC.paused");
  });
  test("no --manifest-dir exits 64", () => {
    expect(run([tool("twin-run-report.ts")]).code).toBe(64);
  });
});
