// CLI: bun src/verify/cli.ts --rpc URL --manifests DIR --sheet-json FILE --artifacts out --frozen FILE --deploy-sha SHA --from-block N --core-dir CORE [--sources]
// The sheet JSON is the whitelist-parsed sheet in VerifySheet shape (bigints as decimal strings). No secret is read or written here.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadStageTable } from "../stage-table.ts";
import { verifyDeployment, viemReader, loadFrozenCounts } from "./index.ts";
import { verifySources, contractsFromManifests } from "./sources.ts";
import type { VerifySheet } from "./types.ts";

export function parseSheetJson(text: string): VerifySheet {
  const j = JSON.parse(text);
  for (const v of Object.values<any>(j.vaults ?? {})) {
    for (const k of ["tvlCap", "perDepositCap", "exitFeeBps"]) v[k] = BigInt(v[k]);
    if (v.seed !== undefined) v.seed = BigInt(v.seed);
    v.assets ??= [];
  }
  return j as VerifySheet;
}

async function main() {
  const { values } = parseArgs({
    options: {
      rpc: { type: "string" }, manifests: { type: "string" }, "sheet-json": { type: "string" }, artifacts: { type: "string" },
      frozen: { type: "string" }, "deploy-sha": { type: "string" }, "core-dir": { type: "string" }, "from-block": { type: "string" }, "log-chunk": { type: "string" },
      sources: { type: "boolean" }, json: { type: "boolean" },
    },
  });
  for (const k of ["rpc", "manifests", "sheet-json", "artifacts", "frozen", "deploy-sha", "from-block", "core-dir"] as const)
    if (!values[k]) { console.error(`missing --${k}`); process.exit(2); }
  const table = loadStageTable(values["core-dir"]!);
  const sheet = parseSheetJson(readFileSync(values["sheet-json"]!, "utf8"));
  const report = await verifyDeployment({
    chain: viemReader(values.rpc!), manifestDir: values.manifests!, table, sheet, artifactsDir: values.artifacts!,
    fromBlock: BigInt(values["from-block"]!), logChunk: values["log-chunk"] ? Number(values["log-chunk"]) : undefined,
    frozenCounts: loadFrozenCounts(values.frozen!, values["deploy-sha"]!),
  });
  if (values.sources) {
    const s = await verifySources({ chainId: sheet.chainId, contracts: contractsFromManifests(values.manifests!, table) });
    report.checks.push(...s.checks); report.ok = report.ok && s.ok;
  }
  for (const ch of report.checks) {
    if (values.json) console.log(JSON.stringify(ch));
    else console.log(`${ch.ok ? "PASS" : "FAIL"} ${ch.label}${ch.ok ? "" : `: ${ch.detail}`}`);
  }
  console.log(report.ok ? "RESULT: VERIFIED" : `RESULT: ${report.checks.filter((x) => !x.ok).length} FAILURE(S)`);
  process.exit(report.ok ? 0 : 1);
}
if (import.meta.main) await main();
