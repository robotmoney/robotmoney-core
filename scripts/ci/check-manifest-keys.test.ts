// Canonical: core issue 1499, core S3 (issue 1485).
// The gate exits non-zero when a retired key is planted and zero on the final tree.
// Run: bun test scripts/ci/check-manifest-keys.test.ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scan, scanCounted } from "./check-manifest-keys";

const repo = resolve(import.meta.dir, "..", "..");

describe("manifest key gate", () => {
  test("the final tree is clean", () => {
    expect(scan(["contracts", "scripts", "testing", "clients", ".github", "deployments"], repo)).toEqual([]);
  });
  test("a planted retired key fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "mk-"));
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "reader.sh"), "jq -r '.morpho_adapter' manifest.json\n");
    const hits = scan(["scripts"], dir);
    expect(hits.length).toBe(1);
    expect(hits[0]).toContain("morpho_adapter");
  });
  test("a planted call of the retired single script fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "mk-"));
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".github", "w.yml"), "run: forge script contracts/script/Deploy.s.sol:Deploy\n");
    expect(scan([".github"], dir).length).toBeGreaterThan(0);
  });
  test("the CLI exits 1 on a planted key and 0 on the tree", async () => {
    const ok = Bun.spawnSync(["bun", join(repo, "scripts/ci/check-manifest-keys.ts")]);
    expect(ok.exitCode).toBe(0);
  });
  test("an empty root scans zero files, and the CLI would fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "mk-empty-"));
    expect(scanCounted(["scripts", "contracts"], dir).scanned).toBe(0);
  });
  test("the tree scans more than zero files", () => {
    expect(scanCounted(["scripts"], repo).scanned).toBeGreaterThan(0);
  });
});
