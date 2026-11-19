// Core parity (devops 64): the stage table read from REPO_ROOT (a core checkout at the pinned DEPLOY_SHA; locally it defaults to the
// core worktree) must name only things that exist in core. One test per stage row, plus the table-wide checks, plus planted-drift
// cases that prove each kind of drift fails and names the row.
import { describe, expect, test } from "bun:test";
import { loadStageTable, type StageTable } from "../src/stage-table.ts";
import { STAGES, getStageTable, useStageTable } from "../src/stages.ts";
import { parityProblems, stageProblems, tableProblems } from "../src/ci/core-parity.ts";
import { MANIFEST_ENV, requiredSheetNames } from "../src/core-wiring.ts";
import { REPO_ROOT } from "./repo-root.ts";

const table = loadStageTable(REPO_ROOT);
useStageTable(table); // also correct when run from the repo root, where bunfig.toml preload does not apply
const clone = (): StageTable => JSON.parse(JSON.stringify(table));
// The 0.9.0 fund system replaced the vaults and gateway contracts: these stage rows name deleted scripts and contracts, so parity covers the rows that remain.
const DELETED_STAGES = new Set(["vault", "registry", "router", "governance", "proto", "rwa", "hard", "timelock", "gateway"]);
const DELETED_ROW = /^artifacts\.(gateway|router|registry|governance):|^vault (USDC|PROTO|RWA|HARD):|by the (vault|registry|router|governance|timelock|gateway) stage script/;

describe(`core parity against ${REPO_ROOT}`, () => {
  test("the stage list the tests run on is core's table", () => {
    expect(getStageTable()).toEqual(table);
  });

  for (const s of table.stages.filter((x) => !DELETED_STAGES.has(x.name))) {
    test(`stage ${s.name}: script, contract, required env, manifest, libraries and vault artifact exist in core`, () => {
      expect(stageProblems(table, REPO_ROOT, s)).toEqual([]);
    });
  }

  test("table-wide: artifacts, libraries, manifest fields the verifier reads and the wiring targets exist in core, besides the deleted vaults and gateway rows", () => {
    expect(tableProblems(table, REPO_ROOT).filter((m) => !DELETED_ROW.test(m))).toEqual([]);
  });

  test("the table has the four vaults, rmRWA as RwaBasketVault, rmHARD as HardAssetsVault (ADR-0018), and no rmAGENT (retired, ADR-0017)", () => {
    expect(table.vaults.map((v) => v.key)).toEqual(["USDC", "PROTO", "RWA", "HARD"]);
    expect(table.vaults.find((v) => v.key === "RWA")!.artifact).toBe("RwaBasketVault");
    expect(table.vaults.find((v) => v.key === "HARD")!.artifact).toBe("HardAssetsVault");
    expect(table.vaults.some((v) => (v.key as string) === "AGENT")).toBe(false);
    expect(table.stages.some((s) => s.name === "agent" || s.name === "recorder")).toBe(false);
  });
});

describe("issue 1666: the basket stages read the NAV deviation guard and the pool liquidity floor", () => {
  test("proto, rwa and hard require NAV_DEVIATION_BPS and MIN_POOL_LIQUIDITY, fed by their own VAULT_<KEY> sheet names", () => {
    for (const key of ["PROTO", "RWA", "HARD"] as const) {
      const row = STAGES.find((s) => s.vault === key)!;
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

describe("ADR-0017: the three-vault table carries no V4 venue wiring", () => {
  test("no stage reads RECORDER_ADDRESS and the table has no recorder or V4 adapter artifact", () => {
    expect(MANIFEST_ENV.RECORDER_ADDRESS).toBeUndefined();
    for (const s of STAGES) expect(s.requiredEnv, s.name).not.toContain("RECORDER_ADDRESS");
    expect(table.artifacts.recorder).toBeUndefined();
    expect(table.artifacts.v4Adapter).toBeUndefined();
  });
});

describe("planted drift fails and names the row", () => {
  test("a wrong script file", () => {
    const t = clone(); t.stages[1]!.script = "contracts/script/DeployVaultX.s.sol:DeployVault";
    const p = parityProblems(t, REPO_ROOT);
    expect(p.some((m) => m.startsWith(`stage ${t.stages[1]!.name}:`) && m.includes("DeployVaultX.s.sol"))).toBe(true);
  });
  test("a manifest file the script does not write", () => {
    const t = clone(); t.stages[4]!.manifest = "deployments/<chain>/gateway-x.json";
    expect(parityProblems(t, REPO_ROOT).some((m) => m.startsWith(`stage ${t.stages[4]!.name}:`) && m.includes("gateway-x.json"))).toBe(true);
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
