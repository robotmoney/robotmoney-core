// Negative test for scripts/ci/check-set-registry-owner.ts: a planted setRegistry in a vault deploy
// script or a stage script fails the gate and names the file.
// Run: bun test scripts/ci/check-set-registry-owner.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..", "..");
const gate = join(repo, "scripts/ci/check-set-registry-owner.ts");
const temps: string[] = [];

function run(root?: string): { code: number; out: string } {
  const p = Bun.spawnSync(["bun", gate, ...(root ? ["--root", root] : [])], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
}

function planted(rel: string, body: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "sr-"));
  temps.push(dir);
  mkdirSync(join(dir, "contracts/script"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
  return run(dir);
}

afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("setRegistry owner gate", () => {
  test("the tree is clean", () => {
    expect(run().code).toBe(0);
  });
  test("a planted setRegistry in a vault deploy script fails and names the file", () => {
    const r = planted("contracts/script/DeployVault.s.sol", "contract D { function r() external { vault.setRegistry(x); } }\n");
    expect(r.code).toBe(1);
    expect(r.out).toContain("contracts/script/DeployVault.s.sol:1");
  });
  test("a planted setRegistry in a stage script fails", () => {
    expect(planted("scripts/stage/x.ts", 'await cast("setRegistry(address)");\n').code).toBe(1);
  });
  test("DeployTimelock.s.sol may call setRegistry", () => {
    expect(planted("contracts/script/DeployTimelock.s.sol", "vault.setRegistry(x);\n").code).toBe(0);
  });
});
