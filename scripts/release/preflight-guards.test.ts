// Issue 1926: the preflight size gate (scripts/release/preflight-guards.sh CEREMONY_CONTRACTS) covers every vault contract the stage table deploys:
// each `vaults[].artifact` and the contract of every proxy row of a vault stage. ProtocolAssetVault (rmPROTO) was missing. Runs in core-stages-offline.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

  test("the table's vault contracts are the three live vaults", () => {
    expect(tableVaultContracts(table)).toEqual(["ProtocolAssetVault", "RobotMoneyVault", "RwaBasketVault"]);
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
