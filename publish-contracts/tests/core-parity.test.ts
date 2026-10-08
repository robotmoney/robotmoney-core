// Core parity (devops 64): the stage table read from REPO_ROOT (a core checkout at the pinned DEPLOY_SHA; locally it defaults to the
// core worktree) must name only things that exist in core. One test per stage row, plus the table-wide checks, plus planted-drift
// cases that prove each kind of drift fails and names the row.
import { describe, expect, test } from "bun:test";
import { loadStageTable, type StageTable } from "../src/stage-table.ts";
import { getStageTable, useStageTable } from "../src/stages.ts";
import { parityProblems, stageProblems, tableProblems } from "../src/ci/core-parity.ts";
import { requiredSheetNames } from "../src/core-wiring.ts";
import { REPO_ROOT } from "./repo-root.ts";

const table = loadStageTable(REPO_ROOT);
useStageTable(table); // also correct when run from the repo root, where bunfig.toml preload does not apply
const clone = (): StageTable => JSON.parse(JSON.stringify(table));

describe(`core parity against ${REPO_ROOT}`, () => {
  test("the stage list the tests run on is core's table", () => {
    expect(getStageTable()).toEqual(table);
  });

  for (const s of table.stages) {
    test(`stage ${s.name}: script, contract, required env, manifest, libraries and vault artifact exist in core`, () => {
      expect(stageProblems(table, REPO_ROOT, s)).toEqual([]);
    });
  }

  test("table-wide: artifacts, libraries, manifest fields the verifier reads and the wiring targets exist in core", () => {
    expect(tableProblems(table, REPO_ROOT)).toEqual([]);
  });

  test("the table has every vault, rmRWA as RwaBasketVault and rmAGENT as AgentTokenVault", () => {
    expect(table.vaults.map((v) => v.key)).toEqual(["USDC", "PROTO", "AGENT", "RWA"]);
    expect(table.vaults.find((v) => v.key === "RWA")!.artifact).toBe("RwaBasketVault");
    expect(table.vaults.find((v) => v.key === "AGENT")!.artifact).toBe("AgentTokenVault");
  });
});

describe("issue 1666: the basket stages read the NAV deviation guard and the pool liquidity floor", () => {
  test("proto, agent and rwa require NAV_DEVIATION_BPS and MIN_POOL_LIQUIDITY, fed by their own VAULT_<KEY> sheet names", () => {
    for (const key of ["PROTO", "AGENT", "RWA"] as const) {
      const row = table.stages.find((s) => s.vault === key)!;
      expect(row.requiredEnv, row.name).toContain("NAV_DEVIATION_BPS");
      expect(row.requiredEnv, row.name).toContain("MIN_POOL_LIQUIDITY");
      expect(requiredSheetNames(row), row.name).toContain(`VAULT_${key}_NAV_DEVIATION_BPS`);
      expect(requiredSheetNames(row), row.name).toContain(`VAULT_${key}_MIN_POOL_LIQUIDITY`);
    }
  });
  test("the rmUSDC vault row does not: it has no navDeviationGuardBps and no pool", () => {
    const row = table.stages.find((s) => s.vault === "USDC")!;
    expect(row.requiredEnv).not.toContain("NAV_DEVIATION_BPS");
    expect(row.requiredEnv).not.toContain("MIN_POOL_LIQUIDITY");
  });
});

describe("planted drift fails and names the row", () => {
  test("a wrong script file", () => {
    const t = clone(); t.stages[1]!.script = "contracts/script/DeployVaultX.s.sol:DeployVault";
    const p = parityProblems(t, REPO_ROOT);
    expect(p.some((m) => m.startsWith(`stage ${t.stages[1]!.name}:`) && m.includes("DeployVaultX.s.sol"))).toBe(true);
  });
  test("a wrong contract name", () => {
    const t = clone(); t.stages[2]!.script = t.stages[2]!.script.replace(/:.*/, ":NoSuchContract");
    expect(parityProblems(t, REPO_ROOT).some((m) => m.startsWith(`stage ${t.stages[2]!.name}:`) && m.includes("NoSuchContract"))).toBe(true);
  });
  test("a required env name the script does not read", () => {
    const t = clone(); t.stages[3]!.requiredEnv = [...t.stages[3]!.requiredEnv, "VAULT_TVL_CAP_NOPE"];
    expect(parityProblems(t, REPO_ROOT).some((m) => m.startsWith(`stage ${t.stages[3]!.name}:`) && m.includes("VAULT_TVL_CAP_NOPE"))).toBe(true);
  });
  test("an env name core does not read on a basket stage (VAULT_NAME is read by the registry script only)", () => {
    const t = clone(); const b = t.stages.find((s) => s.vault === "PROTO")!;
    b.requiredEnv = [...b.requiredEnv, "VAULT_NAME"];
    expect(parityProblems(t, REPO_ROOT).some((m) => m.startsWith(`stage ${b.name}:`) && m.includes("VAULT_NAME"))).toBe(true);
  });
  test("a manifest file the script does not write", () => {
    const t = clone(); t.stages[4]!.manifest = "deployments/<chain>/gateway-x.json";
    expect(parityProblems(t, REPO_ROOT).some((m) => m.startsWith(`stage ${t.stages[4]!.name}:`) && m.includes("gateway-x.json"))).toBe(true);
  });
  test("a vault artifact that does not exist (the old rmRWA artifact name stays valid, a typo does not)", () => {
    const t = clone(); const v = t.vaults.find((x) => x.key === "RWA")!; v.artifact = "RwaVaultX";
    expect(parityProblems(t, REPO_ROOT).some((m) => m.startsWith("stage rwa:") && m.includes("RwaVaultX"))).toBe(true);
  });
  test("a core artifact name that does not exist", () => {
    const t = clone(); t.artifacts.gateway = "NoSuchGateway";
    expect(tableProblems(t, REPO_ROOT).some((m) => m.includes("artifacts.gateway") && m.includes("NoSuchGateway"))).toBe(true);
  });
  test("a library manifest key the libs script does not write", () => {
    const t = clone(); t.libraries[0]!.manifestKey = "tick_math_x";
    expect(tableProblems(t, REPO_ROOT).some((m) => m.includes("tick_math_x"))).toBe(true);
  });
});
