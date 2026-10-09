// Canonical: core issue 1499, core S10 (issue 1489).
// The gate exits 0 on the tree and non-zero, naming the file, on a planted Demo contract, a stub,
// a mock Safe, a bad block.chainid use, a restored deleted path and a deleted name in a script.
// Run: bun test scripts/ci/check-no-test-only-code.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..", "..");
const gate = join(repo, "scripts/ci/check-no-test-only-code.ts");
const temps: string[] = [];

/** A temp copy of the parts of the repo the gate scans. */
function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), "nto-"));
  temps.push(dir);
  for (const d of ["contracts/script", "contracts/test", "contracts/vaults", "scripts", ".github"]) {
    mkdirSync(join(dir, d), { recursive: true });
    cpSync(join(repo, d), join(dir, d), { recursive: true, filter: (s) => !s.includes("node_modules") });
  }
  return dir;
}

function run(root?: string): { code: number; out: string } {
  const p = Bun.spawnSync(["bun", gate, ...(root ? ["--root", root] : [])], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
}

function planted(rel: string, body: string): { code: number; out: string } {
  const root = copy();
  writeFileSync(join(root, rel), body);
  return run(root);
}

afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("no test-only code gate", () => {
  test("the tree is clean and the gate scanned files", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\d+ files and paths checked, 0 matches/);
  });

  test("a planted Demo contract in contracts/script fails and names the file", () => {
    const r = planted("contracts/script/DemoPlanted.sol", "contract DemoPlanted {}\n");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("contracts/script/DemoPlanted.sol");
  });

  test("a planted stub contract fails and names the file", () => {
    const r = planted("contracts/script/PoolSlot0Stub.sol", "contract UniswapV3PoolSlot0Stub {}\n");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("contracts/script/PoolSlot0Stub.sol");
  });

  test("a planted default cap constant in contracts/script fails", () => {
    const r = planted("contracts/script/PlantedCap.s.sol", "contract PlantedCap { uint256 constant DEFAULT_TVL_CAP = 1; }\n");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("contracts/script/PlantedCap.s.sol");
  });

  test("a planted mock Safe in contracts/script fails", () => {
    const r = planted("contracts/script/DeploySafe.s.sol", "contract RehearsalSafe {}\n");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("contracts/script/DeploySafe.s.sol");
  });

  test("a planted mock Safe in a forge test fails", () => {
    const r = planted("contracts/test/PlantedSafe.t.sol", "contract MockHighThresholdSafe {}\n");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("contracts/test/PlantedSafe.t.sol");
  });

  test("a planted constant-threshold Safe stub in a forge test fails", () => {
    const r = planted(
      "contracts/test/PlantedThreshold.t.sol",
      "contract T { function getThreshold() external pure returns (uint256) { return 2; } }\n",
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("contracts/test/PlantedThreshold.t.sol");
  });

  test("a planted vm.prank(safe) in a governed-path forge test fails", () => {
    const r = planted(
      "contracts/test/PlantedPrankSafe.t.sol",
      "contract T { function t() external { vm.prank(safe); timelock.execute(a, 0, d, 0, 0); } }\n",
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("contracts/test/PlantedPrankSafe.t.sol:1");
    expect(r.out).toContain("pranked Safe");
  });

  test("vm.startPrank(safe) and vm.prank(safeAddr) fail too", () => {
    for (const body of ["vm.startPrank(safe);", "vm.prank(safeAddr);"]) {
      const r = planted("contracts/test/PlantedPrank2.t.sol", `contract T { function t() external { ${body} } }\n`);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("pranked Safe");
    }
  });

  test("the migrated governed-path tests hold no pranked Safe", () => {
    for (const f of ["AgentTokenVault", "BasketVault", "ConsensusRecommendationReceipt", "GovernedVaultSafeTimelock", "DeployTimelock", "WeightSetterRotation", "PortfolioRouter", "GovernedSurfacesSafeTimelock"]) {
      const r = planted(`contracts/test/${f}.t.sol`, "// vm.prank(safe) planted\ncontract T { function t() external { vm.prank(safe); } }\n");
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(`contracts/test/${f}.t.sol:2`);
    }
    const clean = run();
    expect(clean.code).toBe(0);
    expect(clean.out + "").not.toContain("AgentTokenVault.t.sol");
  });

  test("a planted chain-id branch fails", () => {
    const r = planted("contracts/script/DeployBranch.s.sol", "contract B { function f() external { if (block.chainid == 31337) {} } }\n");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("block.chainid outside the allowlist");
  });

  test("an output-file-name use of block.chainid passes", () => {
    const root = copy();
    writeFileSync(
      join(root, "contracts/script/DeployOk.s.sol"),
      'contract Ok { function f() external { vm.serializeUint(obj, "chain_id", block.chainid); } }\n',
    );
    expect(run(root).code).toBe(0);
  });

  test("a restored deleted path fails", () => {
    const r = planted("contracts/Vault.sol", "contract Vault {}\n");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("contracts/Vault.sol: deleted path exists");
  });

  test("a script that names a deleted contract fails", () => {
    const r = planted("scripts/ci/planted.ts", "// uses IPositionAdapter\n");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("scripts/ci/planted.ts:1");
  });

  test("a root with no contracts/script fails because zero checks ran", () => {
    const dir = mkdtempSync(join(tmpdir(), "nto-empty-"));
    temps.push(dir);
    const r = run(dir);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("zero checks ran");
  });
});
