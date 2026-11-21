// ADR-0020: the deploy-time layout gate accepts a mid-struct change only when the build declares it with a migration that exists in the build.
// (The Twin run of v0.9.0-onevault-upgrade stopped at the Rebalancer deploy: StepParams lost keeperGrace, Rebalancer.migrateV090 rewrites it.)
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredStructMigrations, layoutExtensionProblems } from "../src/upgrade-rows.ts";

const KEY = "t_struct(StepParams)1_storage";
const m = (label: string, offset: number) => ({ label, offset, slot: "0", type: "t_uint32" });
const OLD = { structs: { [KEY]: [m("stepInterval", 0), m("keeperGrace", 4), m("maxOverrun", 8)] } };
const NEW = { structs: { [KEY]: [m("stepInterval", 0), m("maxOverrun", 4)] } };

function build(migrations: unknown, abi: unknown[]): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "lsm-"));
  mkdirSync(join(dir, "scripts", "ci"), { recursive: true });
  mkdirSync(join(dir, "out", "Rebalancer.sol"), { recursive: true });
  if (migrations !== undefined) writeFileSync(join(dir, "scripts", "ci", "storage-layout-migrations.json"), JSON.stringify(migrations));
  writeFileSync(join(dir, "out", "Rebalancer.sol", "Rebalancer.json"), JSON.stringify({ abi, deployedBytecode: { object: "0x00" } }));
  return dir;
}
const ENTRY = { contract: "Rebalancer", struct: "StepParams", migration: "Rebalancer.migrateV090" };
const FN = { type: "function", name: "migrateV090", inputs: [] };

describe("the deploy-time layout gate and declared struct migrations", () => {
  test("a mid-struct change is refused without a declaration", () => {
    expect(layoutExtensionProblems(OLD, NEW, [], "Rebalancer")).toEqual([`struct ${KEY}: a member moved, was retyped or removed`]);
    expect(declaredStructMigrations(build(undefined, [FN]), "Rebalancer")).toEqual([]);
  });

  test("a declared break passes when the migration is in the build's ABI", () => {
    const b = build({ migrations: [ENTRY] }, [FN]);
    expect(declaredStructMigrations(b, "Rebalancer")).toEqual(["StepParams"]);
    expect(layoutExtensionProblems(OLD, NEW, [], "Rebalancer", [], declaredStructMigrations(b, "Rebalancer"))).toEqual([]);
  });

  test("a declaration whose migration the build lacks, or for another contract, does not pass", () => {
    expect(declaredStructMigrations(build({ migrations: [ENTRY] }, []), "Rebalancer")).toEqual([]);
    expect(declaredStructMigrations(build({ migrations: [ENTRY] }, [FN]), "FlowQueue")).toEqual([]);
  });

  test("a declaration covers only its struct: another broken struct is still refused", () => {
    const other = "t_struct(Other)2_storage";
    const old = { structs: { ...OLD.structs, [other]: [m("a", 0), m("b", 4)] } };
    const neu = { structs: { ...NEW.structs, [other]: [m("b", 0)] } };
    expect(layoutExtensionProblems(old, neu, [], "Rebalancer", [], ["StepParams"])).toEqual([`struct ${other}: a member moved, was retyped or removed`]);
  });

  test("a malformed allowlist throws", () => {
    expect(() => declaredStructMigrations(build({ migrations: [{ contract: "Rebalancer" }] }, [FN]), "Rebalancer")).toThrow();
  });
});
