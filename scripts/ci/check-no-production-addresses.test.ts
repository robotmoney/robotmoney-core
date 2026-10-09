// Canonical: core issue 1490 (clean room rule, core 1498).
// The gate exits 0 on the tree and non-zero, naming file and line, on a planted production address
// in a Solidity test, a Rust harness file, a TypeScript test and a workflow, in any case and with
// or without the 0x prefix. A third-party address and a docs mention pass.
// Run: bun test scripts/ci/check-no-production-addresses.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PRODUCTION_ADDRESSES, scanText } from "./check-no-production-addresses.ts";

const repo = resolve(import.meta.dir, "..", "..");
const gate = join(repo, "scripts/ci/check-no-production-addresses.ts");
const temps: string[] = [];

function plant(rel: string, body: string): { code: number; out: string } {
  const root = mkdtempSync(join(tmpdir(), "nopa-"));
  temps.push(root);
  // One clean file so the gate scans at least one file.
  mkdirSync(join(root, "testing"), { recursive: true });
  writeFileSync(join(root, "testing/clean.txt"), "nothing here\n");
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
  const p = Bun.spawnSync(["bun", gate, "--root", root], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
}

afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const vault = PRODUCTION_ADDRESSES[0]!.address;
const safe = PRODUCTION_ADDRESSES[4]!.address;

describe("no production addresses gate", () => {
  test("the tree is clean and the gate scanned files", () => {
    const p = Bun.spawnSync(["bun", gate], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    expect(p.stdout.toString()).toMatch(/\d+ files checked, 0 matches/);
  });

  test("a planted vault address in a forge test fails and names file and line", () => {
    const r = plant("contracts/test/Planted.t.sol", `// x\naddress constant V = 0x${vault};\n`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("contracts/test/Planted.t.sol:2");
  });

  test("a planted address in a Rust harness file fails", () => {
    const r = plant("testing/fork-e2e-rust/src/addresses.rs", `pub const VAULT: Address = address!("${vault}");\n`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("testing/fork-e2e-rust/src/addresses.rs:1");
  });

  test("upper case and checksum form still fail", () => {
    const r = plant("clients/dapp/tests/unit/x.test.ts", `const a = "0x${safe.toUpperCase()}";\n`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("old admin Safe");
  });

  test("a planted address in a workflow fails", () => {
    const r = plant(".github/workflows/planted.yml", `env:\n  VAULT: "0x${PRODUCTION_ADDRESSES[1]!.address}"\n`);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(".github/workflows/planted.yml:2");
  });

  test("a third-party address passes", () => {
    const r = plant("testing/x.rs", 'address!("833589fcd6edb6e08f4c7c32d4f71b54bda02913");\n');
    expect(r.code).toBe(0);
  });

  test("docs are not scanned", () => {
    const r = plant("docs/technical/smart-contracts.md", `vault 0x${vault}\n`);
    expect(r.code).toBe(0);
  });

  test("a tree with no scanned files fails", () => {
    const root = mkdtempSync(join(tmpdir(), "nopa-"));
    temps.push(root);
    const p = Bun.spawnSync(["bun", gate, "--root", root], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).not.toBe(0);
  });

  test("scanText reports every listed address on its line", () => {
    for (const a of PRODUCTION_ADDRESSES) {
      expect(scanText("f", `\n0x${a.address}`)).toEqual([{ file: "f", line: 2, name: a.name }]);
    }
  });
});
