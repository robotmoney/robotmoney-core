#!/usr/bin/env bun
// Canonical: docs/technical/contract-upgradeability-plan.md (Mechanism and authority), issue 1853.
//
// CI gate: the TypeScript core timelock prediction publish-contracts pins and checks before every proxy stage
// (publish-contracts/src/timelock-pin.ts predictCoreTimelock) equals the Solidity one every stage script names
// (contracts/script/UpgradeAuthority.sol predictTimelock), for the same build. The publish-contracts runner tests
// cannot show it: their stub forge calls the TypeScript function itself.
//
// contracts/test/UpgradeAuthorityPrediction.t.sol writes the Solidity predictions for fixed (Safe, delay) vectors to
// out/timelock-prediction-vectors.json. This script recomputes each from the same out/ build and the stage table's
// upgradeAuthority (factory, salt, contract). Exit 0 when every vector agrees. Exit 1 when the vector file is missing
// or empty, or any address or init code hash differs (the address also binds the stage table's factory and salt to
// UpgradeAuthority's CREATE2_FACTORY and TIMELOCK_SALT).
// publish-contracts' dependencies must be installed (bun install in publish-contracts): viem resolves from there.
//
// Usage: bun scripts/ci/check-timelock-prediction-parity.ts [--vectors <file>] [--out <forge out dir>] [--table <stage-table.json>]
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { predictCoreTimelock } from "../../publish-contracts/src/timelock-pin.ts";

const repo = resolve(import.meta.dir, "..", "..");
const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? resolve(process.argv[i + 1]!) : join(repo, dflt);
};

/** `executor`: "open" (the vaults system, the default when absent) or "safe" (the fund system's FundTimelockPolicy, decision D4-10). */
interface Vector { safe: string; minDelay: string; address: string; initCodeHash: string; executor?: "open" | "safe" }

export function checkParity(vectorsPath: string, outDir: string, tablePath: string): string[] {
  if (!existsSync(vectorsPath)) return [`no vector file ${vectorsPath}: run forge test --match-contract UpgradeAuthorityPrediction first`];
  const file = JSON.parse(readFileSync(vectorsPath, "utf8")) as { vectors?: Vector[] };
  const vectors = file.vectors ?? [];
  if (vectors.length === 0) return [`${vectorsPath} holds no vectors`];
  const u = JSON.parse(readFileSync(tablePath, "utf8")).upgradeAuthority;
  if (!u) return [`${tablePath} has no upgradeAuthority`];
  const problems: string[] = [];
  for (const v of vectors) {
    if (v.executor !== undefined && v.executor !== "open" && v.executor !== "safe") { problems.push(`Safe ${v.safe}, delay ${v.minDelay}: executor '${String(v.executor)}' is not open or safe`); continue; }
    const ts = predictCoreTimelock(u, outDir, v.safe as `0x${string}`, BigInt(v.minDelay), v.executor ?? "open");
    if (ts.address.toLowerCase() !== v.address.toLowerCase() || ts.initCodeHash.toLowerCase() !== v.initCodeHash.toLowerCase()) {
      problems.push(`Safe ${v.safe}, delay ${v.minDelay}, executor ${v.executor ?? "open"}: Solidity ${v.address} (init code hash ${v.initCodeHash}), TypeScript ${ts.address} (init code hash ${ts.initCodeHash})`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const vectorsPath = arg("--vectors", "out/timelock-prediction-vectors.json");
  let problems: string[];
  try { problems = checkParity(vectorsPath, arg("--out", "out"), arg("--table", "scripts/deploy/stage-table.json")); } catch (e) { problems = [(e as Error).message]; }
  if (problems.length) {
    for (const p of problems) console.error(`::error::timelock prediction parity: ${p}`);
    process.exit(1);
  }
  console.log(`timelock prediction parity: ok (${JSON.parse(readFileSync(vectorsPath, "utf8")).vectors.length} vectors, TypeScript equals UpgradeAuthority.predictTimelock)`);
}
