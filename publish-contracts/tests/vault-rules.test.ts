// Issue 1705 (QA plan v1 E9 a): one table, scripts/deploy/stage-table.json `vaults[]`, holds the per-vault rule for every dimension the four vaults are
// governed by. This proves the tool reads the rule from it: the govern rows, the evidence steps and the verifier's per-vault expectations are derived
// from the table (the same objects, not equal copies), no module keeps a literal rmUSDC special case, and a core checkout with other rules is refused.
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CODES } from "../src/errors.ts";
import { expectedMaxSlippageBps } from "../src/asset-config.ts";
import { vaultWiringProblems } from "../src/ci/core-parity.ts";
import { BASKET_DEFAULT_SLIPPAGE_BPS, LENDING_ADAPTERS, MANIFEST_FIELDS_READ } from "../src/core-wiring.ts";
import { GOVERN_STEPS, UNPAUSE_STEPS } from "../src/evidence-check.ts";
import { GOVERN_ROWS, UNPAUSE_ROWS, stageRows } from "../src/govern.ts";
import { parseSheet, VAULT_NAME, type VaultKey } from "../src/sheet.ts";
import { loadStageTable, manifestBase, type StageTable } from "../src/stage-table.ts";
import { getStageTable } from "../src/stages.ts";
import { MAINNET_UNPAUSE_VAULTS, buildVerifySheet } from "../src/verify-stage.ts";
import {
  ROUTER_STAGE_ELIGIBLE, STAGE13_UNPAUSE_ROWS, STAGE13_UNPAUSE_VAULTS, UNPAUSE_ROW_NAMES, VAULT_RULES, vaultOfUnpauseRow, vaultRulesProblem,
} from "../src/vault-rules.ts";
import { MANIFEST_ADAPTER, SHA, sheetText, tmp, writeCoreAssetConfig } from "./fixtures.ts";
import { world } from "./harness.ts";
import { REPO_ROOT } from "./repo-root.ts";
import type { RunContext } from "../src/runner.ts";

const table = loadStageTable(REPO_ROOT);
const SRC = join(import.meta.dir, "..", "src");
const clone = (): StageTable => JSON.parse(JSON.stringify(table));

describe("vault rules: the tool reads every per-vault rule from the stage table (issue 1705)", () => {
  test("the tool's own table is the repo's stage table, every vault in table order", () => {
    expect(VAULT_RULES).toEqual(table.vaults);
    expect(getStageTable().vaults).toEqual(table.vaults);
  });

  test("UNPAUSE_ROWS and stageRows(8453) in govern.ts are the table's unpause rows: every vault's unpauseRow, and the ones with unpauseInStage13", () => {
    expect(UNPAUSE_ROWS).toBe(UNPAUSE_ROW_NAMES);
    expect([...UNPAUSE_ROWS]).toEqual(table.vaults.map((v) => v.unpauseRow));
    expect(stageRows(8453)).toBe(STAGE13_UNPAUSE_ROWS);
    expect([...stageRows(8453)]).toEqual(table.vaults.filter((v) => v.unpauseInStage13).map((v) => v.unpauseRow));
    // the Twin chain runs every unpause row, then the Safe tool demonstrations
    expect([...GOVERN_ROWS.slice(0, UNPAUSE_ROWS.length)]).toEqual([...UNPAUSE_ROWS]);
    for (const v of table.vaults) expect(vaultOfUnpauseRow(v.unpauseRow)).toBe(v.key);
  });

  test("GOVERN_STEPS and UNPAUSE_STEPS in evidence-check.ts are the table's stage 13 rows and unpause rows", () => {
    expect(GOVERN_STEPS).toBe(STAGE13_UNPAUSE_ROWS);
    expect(UNPAUSE_STEPS).toBe(UNPAUSE_ROW_NAMES);
    expect([...GOVERN_STEPS]).toEqual([...stageRows(8453)]);
  });

  test("expectPaused and routerEligible in buildVerifySheet follow the table's deployPaused and eligibilitySource, before and after the unpause rows", () => {
    expect(MAINNET_UNPAUSE_VAULTS).toBe(STAGE13_UNPAUSE_VAULTS);
    const { ctx, sheet } = verifyCtx();
    for (const unpaused of [[], ["PROTO"], [...MAINNET_UNPAUSE_VAULTS]] as VaultKey[][]) {
      const v = buildVerifySheet(ctx, "0x00000000000000000000000000000000000050fe", unpaused);
      for (const r of table.vaults) {
        const got = v.vaults[VAULT_NAME[r.key]]!;
        expect([r.key, unpaused.join(","), got.expectPaused]).toEqual([r.key, unpaused.join(","), r.deployPaused && !unpaused.includes(r.key)]);
        expect([r.key, got.routerEligible]).toEqual([r.key, r.eligibilitySource === "router-stage" || sheet.eligibleVaults.includes(r.key)]);
        expect([r.key, got.seed !== undefined]).toEqual([r.key, r.seed !== "none"]);
      }
      // the router default weights lead with the vaults the router stage makes eligible
      expect(v.defaultWeights.slice(0, ROUTER_STAGE_ELIGIBLE.length).map((w) => w.vault)).toEqual(ROUTER_STAGE_ELIGIBLE.map((k) => VAULT_NAME[k]));
    }
    // the derivation is the table's, not a literal: the source calls the rule helpers
    const src = readFileSync(join(SRC, "verify-stage.ts"), "utf8");
    expect(src).toContain("expectPaused: expectPausedAfter(k, unpaused)");
    expect(src).toContain("routerEligible: routerEligibleAtDeploy(k, s.eligibleVaults)");
  });

  test("no literal rmUSDC special case in govern.ts, evidence-check.ts or verify-stage.ts outside the table loader (src/vault-rules.ts)", () => {
    const literal = /["'`]USDC["'`]|unpause-USDC|["'`]rmUSDC["'`]\s*[,\]]/;
    for (const f of ["govern.ts", "evidence-check.ts", "verify-stage.ts"]) {
      const hits = readFileSync(join(SRC, f), "utf8").split("\n")
        .map((l, i) => [i + 1, l.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "")] as const)
        .filter(([, code]) => literal.test(code))
        .map(([n, code]) => `${f}:${n}: ${code.trim().slice(0, 120)}`);
      expect(hits).toEqual([]);
    }
  });

  test("a core checkout whose table carries other vault rules is named field by field, and the tool's own table passes", () => {
    expect(vaultRulesProblem(table, "core")).toBeUndefined();
    const t = clone();
    t.vaults[1]!.deployPaused = false;
    t.vaults[1]!.unpauseInStage13 = false;
    const p = vaultRulesProblem(t, "the core checkout /x")!;
    expect(p).toContain("the core checkout /x carries other vault rules");
    expect(p).toContain("PROTO.deployPaused false (this tool: true)");
    expect(p).toContain("PROTO.unpauseInStage13 false");
    const u = clone();
    u.vaults.pop();
    expect(vaultRulesProblem(u, "core")).toContain("lists the vaults USDC,PROTO,AGENT");
  });

  test("through main(): a --core-dir checkout with other vault rules is refused (USAGE) before any stage runs", async () => {
    const w = world({ startNonce: 0 });
    const t = clone();
    t.vaults[0]!.emergencyLevers = ["pauseDeposits"];
    writeFileSync(join(w.coreDir, "scripts", "deploy", "stage-table.json"), JSON.stringify(t));
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.USAGE);
    const failure = w.logs().filter((l) => l.event === "run.failed").pop();
    expect(String(failure?.message)).toContain("USDC.emergencyLevers");
    expect(w.safeCalls).toEqual([]);
  });
});

describe("issue 1705 C4: the per-vault values the verifier compares with core", () => {
  test("core parity: the rmUSDC adapter caps and order and each basket's default swap bound equal core's sources", () => {
    expect(vaultWiringProblems(table, REPO_ROOT)).toEqual([]);
    expect(LENDING_ADAPTERS.USDC!.adapters.map((a) => a.capBps).reduce((x, y) => x + y, 0)).toBe(10_000);
    // the verifier reads the adapter addresses from the vault stage manifest, so core parity checks the script writes them
    for (const a of LENDING_ADAPTERS.USDC!.adapters) expect(MANIFEST_FIELDS_READ).toContainEqual({ stage: "vault", field: a.field });
  });

  test("core parity: a cap that drifts from the deploy script is named", () => {
    const core = tmp("pc-1705-parity-");
    mkdirSync(join(core, "contracts", "script"), { recursive: true });
    const src = readFileSync(join(REPO_ROOT, "contracts", "script", "DeployVault.s.sol"), "utf8").replace(/COMPOUND_BPS = 3_333;/, "COMPOUND_BPS = 3_000;");
    writeFileSync(join(core, "contracts", "script", "DeployVault.s.sol"), src);
    const p = vaultWiringProblems(table, core).filter((m) => m.startsWith("lending adapters"));
    expect(p).toEqual(["lending adapters of USDC: COMPOUND_BPS is 3000 in contracts/script/DeployVault.s.sol, core-wiring LENDING_ADAPTERS says 3333"]);
  });

  test("the expected swap bound of a basket is the config's root maxSlippageBps when set, else the vault default; rmUSDC has none", () => {
    const core = tmp("pc-1705-slip-");
    writeCoreAssetConfig(core);
    for (const k of ["PROTO", "AGENT", "RWA"] as const) expect(expectedMaxSlippageBps(core, k)).toBe(BASKET_DEFAULT_SLIPPAGE_BPS[k]!);
    expect(expectedMaxSlippageBps(core, "USDC")).toBeUndefined();
    // the committed rmAGENT shortlist raises the bound to 500 (core 1695: the V4 pool fee alone is 291 bps)
    copyFileSync(join(REPO_ROOT, "config", "agent-token-shortlist.json"), join(core, "config", "agent-token-shortlist.json"));
    expect(expectedMaxSlippageBps(core, "AGENT")).toBe(500n);
    writeFileSync(join(core, "config", "rwa-assets.json"), JSON.stringify({ assets: [], maxSlippageBps: -1 }));
    expect(() => expectedMaxSlippageBps(core, "RWA")).toThrow("maxSlippageBps is not a non-negative integer");
  });
});

/** A core checkout fixture the verifier sheet can be built from: the config files and every vault manifest, with the adapters each run deploys. */
function verifyCtx() {
  const chain = 918453;
  const coreDir = tmp("pc-1705-verify-");
  const m = join(coreDir, "deployments", String(chain));
  mkdirSync(m, { recursive: true });
  writeCoreAssetConfig(coreDir);
  const usdcAdapters = Object.fromEntries((LENDING_ADAPTERS.USDC?.adapters ?? []).map((a, i) => [a.field, `0x00000000000000000000000000000000000000e${i + 1}`]));
  for (const v of table.vaults) writeFileSync(join(m, `${manifestBase(v.manifest)}.json`), JSON.stringify({ chain_id: chain, vault: `0x00000000000000000000000000000000000000c${table.vaults.indexOf(v) + 1}`, adapter: MANIFEST_ADAPTER, ...(LENDING_ADAPTERS[v.key] ? usdcAdapters : {}) }));
  const sheet = parseSheet(sheetText());
  const ctx = { coreDir, chainId: chain, sheet, coreSha: SHA } as unknown as RunContext;
  return { ctx, sheet };
}
