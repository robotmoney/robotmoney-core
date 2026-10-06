import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHEET_SPEC, VAULT_KEYS } from "../src/sheet.ts";
import { DEPLOYER_STAGES, STAGES, STAGE_NAMES, VAULT_STAGES, buildStages, expectedStartNonce, getStageTable, manifestRef } from "../src/stages.ts";
import { LIBS_STAGE, MANIFEST_ENV, SHEET_RENAMES, requiredSheetNames, resolveEnv } from "../src/core-wiring.ts";
import { manifestBase, parseStageTable } from "../src/stage-table.ts";
import { stagePlan } from "../src/plan.ts";
import { COUNTS, REPO } from "./fixtures.ts";

const table = getStageTable();
const forge = STAGES.filter((s) => s.kind === "forge");

describe("stage list built from core's stage table", () => {
  test("the order is safe, then the table's stages in table order, then verify and govern", () => {
    expect(STAGE_NAMES).toEqual(["safe", ...table.stages.map((s) => s.name), "verify", "govern"]);
  });
  test("the router stage comes before the gateway and the timelock is the last deployer stage", () => {
    expect(STAGE_NAMES.indexOf("router")).toBeLessThan(STAGE_NAMES.indexOf("gateway"));
    expect(DEPLOYER_STAGES[DEPLOYER_STAGES.length - 1]!.name).toBe(table.stages[table.stages.length - 1]!.name);
  });
  test("the table has a row for each of the four vaults, each pointing at a forge stage with that vault key", () => {
    expect(VAULT_STAGES.map((v) => v.key)).toEqual(["USDC", "PROTO", "AGENT", "RWA"]);
    for (const v of VAULT_STAGES) {
      const row = STAGES.find((s) => s.name === v.stage)!;
      expect(row.vault).toBe(v.key);
      expect(row.script).toMatch(/^contracts\/script\/\w+\.s\.sol:\w+$/);
    }
  });
  test("rmRWA is verified against its own artifact (RwaBasketVault), rmAGENT against AgentTokenVault", () => {
    expect(table.vaults.find((v) => v.key === "RWA")!.artifact).toBe("RwaBasketVault");
    expect(table.vaults.find((v) => v.key === "AGENT")!.artifact).toBe("AgentTokenVault");
  });
  test("every required env name of every forge row resolves to a sheet name, a manifest field, the vault list or the chain id", () => {
    for (const s of forge) for (const e of s.requiredEnv) expect(resolveEnv(e, s.vault ?? null).from, `${s.name} reads ${e}`).not.toBe("unmapped");
  });
  test("every sheet name a forge row needs is in the sheet whitelist", () => {
    for (const s of forge) for (const n of requiredSheetNames(s)) expect(SHEET_SPEC[n], `${s.name} needs ${n}`).toBeDefined();
  });
  test("the per-vault caps land under the names core reads, from the sheet's per-vault names", () => {
    for (const s of forge.filter((x) => x.vault)) {
      const names = requiredSheetNames(s);
      expect(names).toContain(`VAULT_${s.vault}_TVL_CAP`);
      expect(names).toContain(`VAULT_${s.vault}_PER_DEPOSIT_CAP`);
    }
    for (const k of VAULT_KEYS) expect(SHEET_SPEC[`VAULT_${k}_TVL_CAP`]).toBeDefined();
  });
  test("every forge row has a script, a count key and a manifest", () => {
    for (const s of forge) {
      expect(s.script, s.name).toBeTruthy();
      expect(s.countKey, s.name).toBe(s.name);
      expect(s.manifest, s.name).toMatch(/\.json$/);
    }
    expect(new Set(DEPLOYER_STAGES.map((s) => s.countKey)).size).toBe(DEPLOYER_STAGES.length);
  });
  test("a stage only reads manifests that an earlier stage writes", () => {
    const written = new Map<string, number>();
    STAGES.forEach((s, i) => { if (s.manifest) written.set(manifestBase(s.manifest), i); });
    STAGES.forEach((s, i) => {
      for (const e of [...s.requiredEnv]) {
        const src = resolveEnv(e, s.vault ?? null);
        const stages = src.from === "manifest" ? [src.stage] : src.from === "vaults" ? table.vaults.map((v) => v.stage) : [];
        for (const st of stages) {
          const file = manifestRef(st, "x").split(":")[0]!;
          expect(written.get(file), `${s.name} reads ${file} for ${e}`).toBeLessThan(i);
        }
      }
    });
  });
  test("the libs stage links nothing and every library a stage links comes from the libs manifest key", () => {
    expect(STAGES.find((s) => s.name === LIBS_STAGE)!.libraries).toEqual([]);
    expect(forge.filter((s) => s.libraries.length).map((s) => s.vault)).toEqual(["PROTO", "AGENT", "RWA"]);
    for (const s of forge) for (const l of s.libraries) expect(l.manifestKey).toBeTruthy();
  });
  test("no script path, env name list or artifact name is typed in the stage modules", () => {
    for (const f of ["stages.ts", "runner.ts", "verify/constants.ts", "verify/manifests.ts", "verify/index.ts", "sheet.ts"]) {
      const src = readFileSync(join(REPO, "publish-contracts", "src", f), "utf8");
      expect(src, f).not.toMatch(/contracts\/script\/|\.s\.sol|"RobotMoneyVault"|"ProtocolAssetVault"|"AgentTokenVault"|"RwaBasketVault"|DeployLibraries|libraries\.json/);
    }
  });
  test("no expected tx count is typed in the table: counts come from the frozen file", () => {
    const src = readFileSync(join(REPO, "publish-contracts", "src", "stages.ts"), "utf8");
    expect(src).not.toMatch(/\bTXS\b|expectedTx|txCount\s*:\s*\d/);
  });
  test("start nonces are the running sum of the frozen counts", () => {
    expect(expectedStartNonce("safe", COUNTS)).toBe(0);
    expect(expectedStartNonce("libs", COUNTS)).toBe(1);
    expect(expectedStartNonce("vault", COUNTS)).toBe(5);
    const plan = stagePlan(COUNTS);
    expect(plan.map((p) => p.stage)).toEqual(STAGE_NAMES);
    const last = plan.find((p) => p.stage === "timelock")!;
    expect(last.startNonce! + last.expectedCount!).toBe(Object.values(COUNTS).reduce((a, b) => a + b, 0));
    expect(plan.find((p) => p.stage === "verify")!.expectedCount).toBeNull();
  });
  test("rmRWA is a plain basket row: no oracle name anywhere in its row", () => {
    const rwa = STAGES.find((s) => s.name === "rwa")!;
    expect(JSON.stringify(rwa).toLowerCase()).not.toContain("oracle");
  });
  test("a table of another version, or a stage that links an unknown library, is refused", () => {
    expect(() => parseStageTable({ ...table, version: 2 })).toThrow("version");
    const t2 = JSON.parse(JSON.stringify(table));
    t2.stages[7].libraries = ["nope"];
    expect(() => parseStageTable(t2)).toThrow("unknown library");
    expect(buildStages(table).length).toBe(STAGES.length);
  });
  test("the wiring tables name only env names the sheet or a manifest can supply", () => {
    for (const to of Object.values(SHEET_RENAMES)) expect(SHEET_SPEC[to], to).toBeDefined();
    expect(Object.keys(MANIFEST_ENV).length).toBeGreaterThan(0);
  });
});
