import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHEET_SPEC, VAULT_KEYS } from "../src/sheet.ts";
import { DEPLOYER_STAGES, STAGES, STAGE_NAMES, VAULT_STAGES, buildStages, expectedStartNonce, getStageTable, manifestRef } from "../src/stages.ts";
import { LIBS_STAGE, MANIFEST_ENV, SHEET_RENAMES, requiredSheetNames, resolveEnv } from "../src/core-wiring.ts";
import { manifestBase, parseStageTable } from "../src/stage-table.ts";
import { stagePlan } from "../src/plan.ts";
import { COUNTS, REPO } from "./fixtures.ts";
import { stageEnv } from "../src/runner.ts";
import { setup } from "./govern-world.ts";
import { governRowNames } from "../src/govern.ts";

const table = getStageTable();
const forge = STAGES.filter((s) => s.kind === "forge");

describe("stage list built from core's stage table", () => {
  test("the order is safe, then the table's stages in table order with prove-control just before the timelock stage, then verify and govern", () => {
    const names = table.stages.map((s) => s.name);
    const last = names.length - 1;
    expect(names[last]).toBe("timelock");
    expect(STAGE_NAMES).toEqual(["safe", ...names.slice(0, last), "prove-control", "timelock", "verify", "govern"]);
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
    expect(expectedStartNonce("recorder", COUNTS)).toBe(5);
    expect(expectedStartNonce("vault", COUNTS)).toBe(5 + COUNTS.recorder!);
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

describe("deploy-time configuration is consumed by the deployer stages 4 to 10, never by govern (issue 1520)", () => {
  const stage = (n: string) => STAGES.find((s) => s.name === n)!;
  test("the governance stage takes voting power, quorum, voting period and execution delay", () => {
    expect(stage("governance").requiredEnv).toEqual(expect.arrayContaining(["VOTER_ADDRESSES", "VOTER_POWER", "QUORUM_THRESHOLD", "VOTING_PERIOD", "EXECUTION_DELAY"]));
    expect(requiredSheetNames(stage("governance"))).toEqual(expect.arrayContaining(["VOTER_ADDRESSES", "VOTER_POWER", "QUORUM_THRESHOLD", "VOTING_PERIOD", "EXECUTION_DELAY"]));
  });
  test("each basket stage takes the caps, the exit fee, the fee recipient and the router eligibility with the default weights", () => {
    for (const n of ["proto", "agent", "rwa"]) {
      expect(stage(n).requiredEnv, n).toEqual(expect.arrayContaining(["TVL_CAP", "PER_DEPOSIT_CAP", "EXIT_FEE_BPS", "FEE_RECIPIENT", "ROUTER_DEFAULT_BPS"]));
      expect(resolveEnv("ROUTER_DEFAULT_BPS", stage(n).vault ?? null).from).toBe("computed");
    }
    expect(stage("vault").requiredEnv).toEqual(expect.arrayContaining(["TVL_CAP", "PER_DEPOSIT_CAP", "EXIT_FEE_BPS", "FEE_RECIPIENT"]));
  });
  test("every deploy-time key reaches a stage between router (4) and rwa (10), and no deployer stage reads a GOVERN_ name", () => {
    const names = forge.map((s) => s.name);
    const between = names.slice(names.indexOf("router"), names.indexOf("rwa") + 1);
    expect(between).toEqual(["router", "gateway", "governance", "ic-policy", "proto", "agent", "rwa"]);
    const consumed = new Set(between.flatMap((n) => stage(n).requiredEnv));
    for (const k of ["VOTER_ADDRESSES", "VOTER_POWER", "QUORUM_THRESHOLD", "VOTING_PERIOD", "EXECUTION_DELAY", "TVL_CAP", "PER_DEPOSIT_CAP", "EXIT_FEE_BPS", "FEE_RECIPIENT", "ROUTER_DEFAULT_BPS"]) expect(consumed.has(k), k).toBe(true);
    for (const s of forge) for (const e of s.requiredEnv) expect(e.startsWith("GOVERN_"), `${s.name} reads ${e}`).toBe(false);
    expect(stage("govern").requiredEnv).toEqual([]);
  });
  test("stageEnv hands the sheet values to the stages: voters and power to governance, the eligibility vector to each basket", () => {
    const { ctx, sheet } = setup();
    const gov = stageEnv(ctx, stage("governance"));
    expect(gov.VOTER_ADDRESSES.toLowerCase()).toBe(sheet.voters.join(",").toLowerCase());
    expect(gov.VOTER_POWER).toBe(sheet.voterPower.toString());
    expect(gov.QUORUM_THRESHOLD).toBe(sheet.quorum.toString());
    // the example sheet makes PROTO and RWA eligible with USDC 6000, PROTO 2500, RWA 1500
    expect(stageEnv(ctx, stage("proto")).ROUTER_DEFAULT_BPS).toBe("7059,2941");
    expect(stageEnv(ctx, stage("agent")).ROUTER_DEFAULT_BPS).toBe("none");
    expect(stageEnv(ctx, stage("rwa")).ROUTER_DEFAULT_BPS).toBe("6000,2500,1500");
    expect(stageEnv(ctx, stage("rwa")).TVL_CAP).toBe(sheet.vaults.RWA.tvlCap.toString());
    expect(stageEnv(ctx, stage("vault")).ROUTER_DEFAULT_BPS).toBeUndefined();
  });
});

describe("the govern stage lists the unpause-only matrix (issue 1520)", () => {
  test("governRowNames() is the three basket unpauses then the Twin-only demonstrations, and no 13-row list survives", () => {
    expect([...governRowNames()]).toEqual(["unpause-PROTO", "unpause-AGENT", "unpause-RWA", "update-delay", "batch", "cancel"]);
    expect(governRowNames().length).toBe(6);
    const g = (table as unknown as { govern: { mainnetRows: string[]; twinOnlyRows: string[] } }).govern;
    expect([...g.mainnetRows, ...g.twinOnlyRows]).toEqual([...governRowNames()]);
  });
});
