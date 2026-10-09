// Canonical: core issue 1499, core S4 (issues 1486, 1491).
// The gate exits 0 on the tree and non-zero on a planted DEVNET_, CONFIG_PATH or chain-id branch.
// Run: bun test scripts/ci/check-no-devnet-config.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const gate = resolve(import.meta.dir, "check-no-devnet-config.sh");

function run(dir?: string): number {
  const p = Bun.spawnSync(["bash", gate, ...(dir ? [dir] : [])], { stderr: "pipe", stdout: "pipe" });
  return p.exitCode ?? 1;
}

function plant(line: string, name = "DeployX.s.sol"): string {
  const dir = mkdtempSync(join(tmpdir(), "dv-"));
  writeFileSync(join(dir, name), `contract X {\n${line}\n}\n`);
  return dir;
}

describe("no devnet config gate", () => {
  test("the tree is clean", () => expect(run()).toBe(0));
  test("a planted DEVNET_ line fails", () => expect(run(plant("string k = 'DEVNET_AGENT_BNKR';"))).not.toBe(0));
  test("a planted CONFIG_PATH line fails", () => expect(run(plant("string k = 'CONFIG_PATH';"))).not.toBe(0));
  test("a planted chain-id branch fails", () => expect(run(plant("if (block.chainid == 31337) {}"))).not.toBe(0));
  test("a chain-id branch in an allowlisted file passes", () =>
    expect(run(plant("if (block.chainid == 8453) {}", "ExpectedChainGuard.sol"))).toBe(0));
});
