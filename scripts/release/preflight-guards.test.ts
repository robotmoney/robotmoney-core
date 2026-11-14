// Issue 1926: the preflight size gate (scripts/release/preflight-guards.sh CEREMONY_CONTRACTS) covers every vault contract the stage table deploys:
// each `vaults[].artifact` and the contract of every proxy row of a vault stage. ProtocolAssetVault (rmPROTO) was missing. Runs in core-stages-offline.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "release", "preflight-guards.sh");
const TABLE = join(ROOT, "scripts", "deploy", "stage-table.json");

/** The quoted names inside `CEREMONY_CONTRACTS=( ... )`, comments ignored. */
export function ceremonyContracts(script: string): string[] {
  const m = /^CEREMONY_CONTRACTS=\(\n([\s\S]*?)^\)/m.exec(script);
  if (!m) throw new Error("no CEREMONY_CONTRACTS=( ... ) block");
  return m[1]!.split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean).map((l) => l.replace(/^"(.*)"$/, "$1"));
}

/** Every vault contract the table deploys: the vault rows' artifacts and the proxy contracts of the stages those rows name. */
export function tableVaultContracts(table: any): string[] {
  const stages = new Set<string>(table.vaults.map((v: any) => v.stage));
  const fromProxies = table.stages.filter((s: any) => stages.has(s.name)).flatMap((s: any) => (s.proxies ?? []).map((p: any) => p.contract));
  return [...new Set<string>([...table.vaults.map((v: any) => v.artifact), ...fromProxies])].sort();
}

const missing = (script: string, table: any): string[] => { const have = new Set(ceremonyContracts(script)); return tableVaultContracts(table).filter((c) => !have.has(c)); };

describe("issue 1926: CEREMONY_CONTRACTS covers every vault contract the stage table deploys", () => {
  const table = JSON.parse(readFileSync(TABLE, "utf8"));
  const script = readFileSync(SCRIPT, "utf8");

  test("the table's vault contracts are the four live vaults (ADR-0018 adds rmHARD)", () => {
    expect(tableVaultContracts(table)).toEqual(["HardAssetsVault", "ProtocolAssetVault", "RobotMoneyVault", "RwaBasketVault"]);
  });

  test("preflight-guards.sh lists each of them, ProtocolAssetVault (rmPROTO) included", () => {
    expect(ceremonyContracts(script)).toContain("ProtocolAssetVault");
    expect(missing(script, table)).toEqual([]);
  });

  test("a list without one of them is caught (planted: ProtocolAssetVault removed)", () => {
    const planted = script.replace(/^\s*"ProtocolAssetVault"\n/m, "");
    expect(ceremonyContracts(planted)).not.toContain("ProtocolAssetVault");
    expect(missing(planted, table)).toEqual(["ProtocolAssetVault"]);
  });
});

// Deploy 4: the fund system's contracts are in the size gate too: every proxied contract a fund stage deploys and every create2 library a fund stage lists (TickMath and
// the shared basket libraries are the vaults system's already measured libraries, so only the fund's own libraries are required here).
describe("Deploy 4: CEREMONY_CONTRACTS covers the fund system", () => {
  const table = JSON.parse(readFileSync(TABLE, "utf8"));
  const script = readFileSync(SCRIPT, "utf8");
  const fund = table.stages.filter((s: any) => s.system === "fund");
  const want = [...new Set<string>([
    ...fund.flatMap((s: any) => (s.proxies ?? []).map((p: any) => p.contract)).filter((c: string) => c !== "ConsensusRecommendationReceipt"),
    ...fund.flatMap((s: any) => s.create2Libraries ?? []).filter((n: string) => table.create2Libraries.find((l: any) => l.name === n)?.path.startsWith("contracts/test/prototype/")),
    "FundExclusionLedger", "AaveV3RateAdapter", "CompoundV3RateAdapter", "MorphoRateAdapter", "UniswapV3ExactOutSwapAdapter",
  ])].sort();
  test("every fund proxy, fund library, the ledger and the adapter copies are listed", () => {
    const have = new Set(ceremonyContracts(script));
    expect(want.filter((c) => !have.has(c))).toEqual([]);
    expect(want).toContain("FundAdminLib");
    expect(want).toContain("RobotMoneyFund");
  });
  test("out/<Name>.sol/<Name>.json of each fund proxy is built from contracts/test/prototype/src, never the baseline tree", () => {
    const outDir = join(import.meta.dir, "..", "..", "out");
    for (const c of ["RobotMoneyFund", "Rebalancer", "RebalanceGovernance", "FlowQueue"]) {
      const p = join(outDir, `${c}.sol`, `${c}.json`);
      if (!existsSync(p)) continue; // no build in this checkout: the size gate itself fails on a missing artifact
      const target = Object.keys(JSON.parse(readFileSync(p, "utf8")).metadata.settings.compilationTarget)[0];
      expect([c, target]).toEqual([c, `contracts/test/prototype/src/${c}.sol`]);
    }
  });
});
