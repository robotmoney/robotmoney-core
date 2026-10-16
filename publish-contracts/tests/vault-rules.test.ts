// Issue 1705: the per-vault deploy and governance rules come from ONE table, scripts/deploy/stage-table.json vaults[]. The govern rows, the evidence steps and the
// verifier's expected paused state and router eligibility are derived from it, and none of the three tools names a vault key to treat one vault differently.
// Run: bun test tests/vault-rules.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GOVERN_ROWS, TWIN_ONLY_ROWS, UNPAUSE_ROWS, stageRows } from "../src/govern.ts";
import { GOVERN_STEPS, UNPAUSE_STEPS } from "../src/evidence-check.ts";
import { MAINNET_UNPAUSE_VAULTS, buildVerifySheet } from "../src/verify-stage.ts";
import { VAULT_NAME, VAULT_KEYS, parseSheet, type VaultKey } from "../src/sheet.ts";
import { VAULT_RULES, expectPaused, routerEligible } from "../src/vault-rules.ts";
import { TABLE_REL, vaultRules } from "../src/stage-table.ts";
import { EXIT_CODES } from "../src/errors.ts";
import { VAULT_RULES_PATH } from "../src/vault-rules.ts";
import { SHA } from "./fixtures.ts";
import { ADMIN, world } from "./harness.ts";
import { REPO, sheetText, tmp, writeCoreAssetConfig } from "./fixtures.ts";
import { getStageTable, useStageTable } from "../src/stages.ts";
import { manifestBase } from "../src/stage-table.ts";
import type { RunContext } from "../src/runner.ts";

const TABLE = JSON.parse(readFileSync(join(REPO, "scripts", "deploy", "stage-table.json"), "utf8"));
const ROWS = vaultRules(TABLE);
const stage13 = ROWS.filter((v) => v.unpauseInStage13).map((v) => v.unpauseRow);

describe("the tools read the vault rules from the stage table (issue 1705)", () => {
  test("the loader returns the table's own rows, in table order", () => {
    expect(VAULT_RULES.map((v) => v.key)).toEqual(TABLE.vaults.map((v: { key: string }) => v.key));
    expect(JSON.parse(JSON.stringify(VAULT_RULES))).toEqual(ROWS);
  });

  test("govern.ts: UNPAUSE_ROWS and stageRows(8453) are the table's stage 13 unpause rows; GOVERN_ROWS adds every vault's unpause row before the Twin-only rows", () => {
    expect([...UNPAUSE_ROWS]).toEqual(stage13);
    expect([...stageRows(8453)]).toEqual(stage13);
    expect([...GOVERN_ROWS]).toEqual([...ROWS.map((v) => v.unpauseRow), ...TWIN_ONLY_ROWS]);
    // the table's govern block names the same mainnet rows
    expect(TABLE.govern.mainnetRows).toEqual(stage13);
  });

  test("evidence-check.ts: GOVERN_STEPS (required on 8453) and UNPAUSE_STEPS (accepted) come from the same rows", () => {
    expect([...GOVERN_STEPS]).toEqual(stage13);
    expect([...UNPAUSE_STEPS]).toEqual(ROWS.map((v) => v.unpauseRow));
  });

  test("verify-stage.ts: the stage 13 vaults are the table's", () => {
    expect([...MAINNET_UNPAUSE_VAULTS]).toEqual(ROWS.filter((v) => v.unpauseInStage13).map((v) => v.key));
  });

  describe("buildVerifySheet: expectPaused and routerEligible follow the table", () => {
    function ctx(): Pick<RunContext, "sheet" | "coreDir" | "chainId" | "manifestOut"> {
      const coreDir = tmp("vault-rules-");
      const m = join(coreDir, "deployments", "918453");
      mkdirSync(m, { recursive: true });
      const strategy = { aave_adapter: "0x00000000000000000000000000000000000000e1", compound_adapter: "0x00000000000000000000000000000000000000e2", moonwell_flagship_adapter: "0x00000000000000000000000000000000000000e3" };
      for (const v of getStageTable().vaults) writeFileSync(join(m, `${manifestBase(v.manifest)}.json`), JSON.stringify({ chain_id: 918453, vault: "0x00000000000000000000000000000000000000c1", adapter: "0x00000000000000000000000000000000000000a1", adapter_v4: "0x00000000000000000000000000000000000000a4", recorder: "0x00000000000000000000000000000000000000d5", ...strategy }));
      writeFileSync(join(m, "recorder.json"), JSON.stringify({ chain_id: 918453, recorder: "0x00000000000000000000000000000000000000d5" }));
      writeCoreAssetConfig(coreDir);
      return { coreDir, chainId: 918453, sheet: parseSheet(sheetText()) } as never;
    }
    const c = ctx();
    for (const unpaused of [[], ["USDC"], ["PROTO", "RWA"], [...VAULT_KEYS]] as VaultKey[][]) {
      test(`after the unpause rows of [${unpaused.join(", ")}]`, () => {
        const v = buildVerifySheet(c, "0x00000000000000000000000000000000000050fe", unpaused);
        for (const r of ROWS) {
          const want = r.deployPaused && !unpaused.includes(r.key);
          expect([r.key, v.vaults[VAULT_NAME[r.key]]!.expectPaused]).toEqual([r.key, want]);
          expect(expectPaused(r.key, unpaused)).toBe(want);
        }
      });
    }
    test("router eligibility: the router-stage vault always, the sheet's ELIGIBLE_VAULTS for the others", () => {
      const v = buildVerifySheet(c, "0x00000000000000000000000000000000000050fe");
      for (const r of ROWS) {
        const want = r.eligibilitySource === "router-stage" || c.sheet.eligibleVaults.includes(r.key);
        expect([r.key, v.vaults[VAULT_NAME[r.key]]!.routerEligible]).toEqual([r.key, want]);
        expect(routerEligible(r.key, [])).toBe(r.eligibilitySource === "router-stage");
      }
      // the default vector starts with the router-stage vaults
      expect(v.defaultWeights.slice(0, ROWS.filter((r) => r.eligibilitySource === "router-stage").length).map((w) => w.vault)).toEqual(ROWS.filter((r) => r.eligibilitySource === "router-stage").map((r) => VAULT_NAME[r.key]));
    });
    test("the seed is expected exactly on the vaults the table seeds", () => {
      const v = buildVerifySheet(c, "0x00000000000000000000000000000000000050fe");
      for (const r of ROWS) expect([r.key, v.vaults[VAULT_NAME[r.key]]!.seed !== undefined]).toEqual([r.key, r.seed !== null]);
    });
  });

  // The one table loader is src/vault-rules.ts (and src/stage-table.ts, which validates it). The three tools carry no vault key literal of their own.
  test("no literal vault key special case in govern.ts, evidence-check.ts or verify-stage.ts", () => {
    const code = (f: string) => readFileSync(join(REPO, "publish-contracts", "src", f), "utf8").split("\n").filter((l) => !/^\s*(?:\/\/|\*|\/\*\*)/.test(l)).join("\n");
    for (const f of ["govern.ts", "evidence-check.ts", "verify-stage.ts"]) {
      const src = code(f);
      expect([f, src.match(/["'`]USDC["'`]/g)]).toEqual([f, null]);
      expect([f, src.match(/["'`]unpause-(?:USDC|PROTO|AGENT|RWA)["'`]/g)]).toEqual([f, null]);
      expect([f, src.match(/\bk\s*[!=]==\s*["'`]\w+["'`]/g)]).toEqual([f, null]);
      expect([f, src.match(/\[\s*["'`]rmUSDC["'`]\s*,/g)]).toEqual([f, null]);
    }
    for (const f of ["govern.ts", "evidence-check.ts", "verify-stage.ts", "sheet.ts"]) expect(readFileSync(join(REPO, "publish-contracts", "src", f), "utf8")).toContain("./vault-rules.ts");
  });
});

// Issue 1833: vault-rules.ts reads the rules from the CLI's own checkout; the stages come from --core-dir at the DEPLOY_SHA. A CLI from another sha must refuse to start.
// Issue 1851: except the emergency pause-all, which reads no per-vault rule: it runs with one warning naming both tables.
describe("the CLI's vault rules equal the --core-dir stage table (issue 1833, 1851)", () => {
  // A pause-all past a mismatch loads the edited --core-dir table as the process-wide stage table: put the real one back so later test files see it.
  const original = getStageTable();
  afterEach(() => useStageTable(original));
  /** One run of `verb` against a world whose --core-dir table `edit` changed. pause-all's pause is a stub; a govern that got past startup would log stage.start or spawn forge. */
  async function runWith(verb: "pause-all" | "govern", edit?: (t: any) => void): Promise<{ code: number; message?: string; warnings: any[]; pauses: number; stagesStarted: number; corePath: string }> {
    const w = world();
    if (edit) { const p = join(w.coreDir, TABLE_REL); const t = JSON.parse(readFileSync(p, "utf8")); edit(t); writeFileSync(p, JSON.stringify(t)); }
    mkdirSync(w.evidence, { recursive: true });
    writeFileSync(join(w.evidence, "publish-run.json"), JSON.stringify({ version: 1, chainId: 918453, coreSha: SHA, deployer: ADMIN, environment: "local", startedAt: "t", firstBlock: 7, stages: {} }));
    let pauses = 0;
    const pauseAll = (async () => { pauses++; return { allPaused: true, manifestRecorded: true, vaults: [] }; }) as never;
    const code = await w.run([verb], { pauseAll });
    const logs = w.logs();
    return {
      code, message: logs.filter((l) => l.event === "run.failed").pop()?.message, warnings: logs.filter((l) => l.event === "vault_rules.mismatch"), pauses,
      stagesStarted: logs.filter((l) => l.event === "stage.start").length + (w.state().calls ?? []).filter((c: any) => c.tool === "forge").length, corePath: join(w.coreDir, TABLE_REL),
    };
  }

  test("the tables match: pause-all runs without a warning, and govern gets past the startup check (it stops later, at the stage manifests this world lacks)", async () => {
    expect(await runWith("pause-all")).toMatchObject({ code: 0, message: undefined, pauses: 1, warnings: [] });
    const g = await runWith("govern");
    // govern stops later: at the run manifest (QA plan v1 B1 refuses a run with no finished timelock stage) or at a stage manifest this world lacks.
    expect(g.message).toMatch(/is missing: run the stage that writes it first|has no finished timelock stage/);
    expect(g.message).not.toContain("same core sha as DEPLOY_SHA");
  });
  for (const [what, edit] of [
    ["deployPaused", (t: any) => { const v = t.vaults.find((x: any) => x.key === "AGENT"); v.deployPaused = !v.deployPaused; }],
    ["unpauseRow", (t: any) => { t.vaults.find((x: any) => x.key === "AGENT").unpauseRow = "unpause-RWA"; }],
  ] as const) {
    test(`one vault's ${what} differs: govern is refused at startup with INPUT_MISSING naming both table paths, before any stage runs`, async () => {
      const r = await runWith("govern", edit);
      expect(r.code).toBe(EXIT_CODES.INPUT_MISSING);
      expect(r.stagesStarted).toBe(0);
      expect(r.message).toContain(VAULT_RULES_PATH);
      expect(r.message).toContain(r.corePath);
      expect(r.corePath).not.toBe(VAULT_RULES_PATH);
      expect(r.message).toContain("for vault AGENT");
      expect(r.message).toContain("same core sha as DEPLOY_SHA");
    });
    test(`one vault's ${what} differs: the emergency pause-all still runs (exit 0, one pause) with one warning naming both table paths`, async () => {
      const r = await runWith("pause-all", edit);
      expect(r).toMatchObject({ code: 0, message: undefined, pauses: 1 });
      expect(r.warnings.length).toBe(1);
      expect(r.warnings[0].message).toContain(VAULT_RULES_PATH);
      expect(r.warnings[0].message).toContain(r.corePath);
      expect(r.warnings[0].message).toContain("pause-all reads no per-vault rule");
    });
  }
});
