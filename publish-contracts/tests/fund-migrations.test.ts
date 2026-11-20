// publish-contracts/tests/fund-migrations.test.ts: the runbook's migration data CLI (fund-migrations.ts data) and the arguments it reads.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFundMigration, fundMigrationData, migrationArgsFrom } from "../src/fund-migrations.ts";

const REB = "0x13c1169Da48Bb06E327286971eB3E56c0411A65B";
const SHEET = "CHAIN_ID=8453\nFLOW_CANCEL_BUFFER=900\nFLOW_MAX_PAUSE=259200\nFLOW_MATCH_BAND_BPS=10\n";
const SCRIPT = join(import.meta.dir, "..", "src", "fund-migrations.ts");

test("the arguments come from the sheet (queue) and the Rebalancer proxy (fund); a missing one is refused", () => {
  expect(migrationArgsFrom("rebalancer", SHEET, undefined)).toEqual([]);
  expect(migrationArgsFrom("fund", SHEET, REB)).toEqual([REB]);
  expect(migrationArgsFrom("queue", SHEET, undefined)).toEqual(["900", "259200", "10"]);
  expect(() => migrationArgsFrom("queue", "FLOW_CANCEL_BUFFER=900\n", undefined)).toThrow("FLOW_MAX_PAUSE");
  expect(() => migrationArgsFrom("fund", SHEET, undefined)).toThrow("rebalancer proxy");
  expect(() => migrationArgsFrom("adapter", SHEET, undefined)).toThrow("no v0.9.0 migration");
});

test("the CLI prints the data decodeFundMigration accepts", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "fund-migrations-"));
  writeFileSync(join(dir, "sheet.env"), SHEET);
  writeFileSync(join(dir, "rebalancer.json"), JSON.stringify({ rebalancer: REB }));
  const run = (proxy: string) => spawnSync("bun", [SCRIPT, "data", "--proxy", proxy, "--manifest-dir", dir, "--sheet", join(dir, "sheet.env")], { encoding: "utf8" });
  for (const [proxy, args] of [["rebalancer", []], ["fund", [REB]], ["queue", ["900", "259200", "10"]]] as const) {
    const r = run(proxy);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(fundMigrationData(proxy, args));
    expect(decodeFundMigration(proxy, r.stdout.trim() as `0x${string}`).problem).toBeUndefined();
  }
  expect(run("adapter").status).toBe(2);
});
