#!/usr/bin/env bun
// Freezes the per-stage counts of a Twin rehearsal (core 1524, plan step F2). Reads the counts.json of a rehearsal run
// ({ deploySha, chainId, counts, deployerNonce, rehearsal: { conclusion } }, core 1523, 1602) and writes deployments/frozen-counts/<sha>.json. It refuses to overwrite a
// file that holds different counts (COUNT_MISMATCH, exit 10). An identical rerun leaves the file byte-identical.
//   bun publish-contracts/scripts/freeze-counts.ts --counts counts.json [--counts-dir DIR]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { TWIN_CHAIN_ID } from "../src/chains.ts";
import { FROZEN_DIR, assertSha, validateCounts, writeFrozen } from "../src/counts.ts";
import { PublishError, exitCodeOf } from "../src/errors.ts";

export function freezeCounts(countsJsonPath: string, countsDir: string): string {
  const j = JSON.parse(readFileSync(countsJsonPath, "utf8"));
  // the artifact uploads even when the rehearsal failed, so the job records its own conclusion in counts.json (suite 28)
  if (j.rehearsal?.conclusion !== "success") throw new PublishError("USAGE", `${countsJsonPath}: the rehearsal did not conclude success (rehearsal.conclusion is ${JSON.stringify(j.rehearsal?.conclusion ?? null)}). Counts are frozen only from a green core-stages-twin-chain run.`);
  const sha = assertSha(String(j.deploySha));
  const counts = validateCounts(j.counts);
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  if (j.deployerNonce !== sum) throw new PublishError("USAGE", `${countsJsonPath}: deployerNonce ${j.deployerNonce} differs from the sum of counts ${sum}`);
  if (j.chainId !== TWIN_CHAIN_ID) throw new PublishError("USAGE", `${countsJsonPath}: counts are frozen from a Twin chain (918453) rehearsal, not chain ${j.chainId}`);
  return writeFrozen(countsDir, sha, counts, { chainId: j.chainId, at: new Date().toISOString() });
}

if (import.meta.main) {
  const { values: v } = parseArgs({ options: { counts: { type: "string" }, "counts-dir": { type: "string" } } });
  try {
    if (!v.counts) throw new PublishError("USAGE", "usage: bun publish-contracts/scripts/freeze-counts.ts --counts counts.json [--counts-dir DIR]");
    const dir = v["counts-dir"] ? resolve(v["counts-dir"]) : resolve(import.meta.dir, "..", "..", FROZEN_DIR);
    console.log(`frozen counts: ${freezeCounts(resolve(v.counts), dir)}`);
  } catch (e) {
    console.error(`freeze-counts: ${(e as Error).message}`);
    process.exit(exitCodeOf(e));
  }
}
