// Repo check: the shell ceremony is gone, and no .sh file drives publish contracts as an orchestrator.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO } from "./fixtures.ts";

function shellFiles(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (["node_modules", ".git", "evidence", "out", "cache"].includes(f)) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) shellFiles(p, out);
    else if (f.endsWith(".sh")) out.push(p);
  }
  return out;
}

describe("tree check", () => {
  test("the four ceremony shell scripts are gone", () => {
    for (const f of ["mainnet-stage.sh", "mainnet-fund.sh", "mainnet-verify.sh", "mainnet-rehearsal.sh"]) expect(existsSync(join(REPO, "scripts", f)), f).toBe(false);
  });
  test("no .sh file calls the publish contracts CLI or the stage runner (no shell orchestrator)", () => {
    const bad: string[] = [];
    for (const p of shellFiles(REPO)) {
      const t = readFileSync(p, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"); // comments may name the runbook
      if (/publish-contracts\/src\/(cli|runner)|bun[^\n]*\bcli\.ts[^\n]*--(chain|core-sha|stage)|publish[- ]contracts/i.test(t)) bad.push(relative(REPO, p));
    }
    expect(bad).toEqual([]);
  });
  test("the mainnet stage env (REHEARSAL, ALLOW_SHORT_TIMELOCK_DELAY) appears in no shipped TypeScript source except as a refusal", () => {
    const src = readFileSync(join(REPO, "publish-contracts", "src", "floors.ts"), "utf8");
    expect(src).not.toMatch(/ALLOW_SHORT_TIMELOCK_DELAY|REHEARSAL/);
  });
});
