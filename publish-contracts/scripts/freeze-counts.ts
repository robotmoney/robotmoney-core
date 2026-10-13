#!/usr/bin/env bun
// Freezes the per-stage counts of a Twin rehearsal (core 1524, plan step F2). Reads the counts.json of a rehearsal run
// ({ deploySha, chainId, counts, deployerNonce, rehearsal: { conclusion } }, core 1523, 1602) and writes deployments/frozen-counts/<sha>.json. It refuses to overwrite a
// file that holds different counts (COUNT_MISMATCH, exit 10). An identical rerun leaves the file byte-identical.
//   bun publish-contracts/scripts/freeze-counts.ts --counts counts.json [--counts-dir DIR]
//
// Issue 1733: every Twin fork since Base block 52401633 already holds the CREATE2 libraries, so the Twin measuring run ADOPTS them and its counts.json is refused above.
// The baseline for that sha is REBUILT from the adoption records of that run, checked against the build and the chain, and marked `measured.reconstructed`:
//   bun publish-contracts/scripts/freeze-counts.ts --from-adopted-run counts.json --sha <sha> --rpc <url> [--core-dir DIR] [--counts-dir DIR]
//        [--cross-check <earlier frozen file> [--accept-diff stage,stage]]
// --core-dir (default: this checkout) must be a checkout AT <sha> with forge: the libraries are rebuilt from it. --rpc is the Twin or Base RPC that holds them.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { TWIN_CHAIN_ID } from "../src/chains.ts";
import { FROZEN_DIR, PROOF_TX_NONCES, assertSha, fileHashOf, latestOtherFrozen, loadFrozenFile, validateCounts, writeFrozen } from "../src/counts.ts";
import { reconstructBaseline, verifyReconstructionOnChain, type CountsJsonLike } from "../src/counts-reconstruct.ts";
import { PublishError, exitCodeOf } from "../src/errors.ts";
import { buildLibraryArtifacts } from "../src/libs-build.ts";
import { loadStageTable, type StageTable } from "../src/stage-table.ts";
import { useStageTable } from "../src/stages.ts";
import { httpRpc } from "../src/rehearsal/twin.ts";
import type { Address } from "viem";

export function freezeCounts(countsJsonPath: string, countsDir: string): string {
  const j = JSON.parse(readFileSync(countsJsonPath, "utf8"));
  // the artifact uploads even when the rehearsal failed, so the job records its own conclusion in counts.json (suite 28)
  if (j.rehearsal?.conclusion !== "success") throw new PublishError("USAGE", `${countsJsonPath}: the rehearsal did not conclude success (rehearsal.conclusion is ${JSON.stringify(j.rehearsal?.conclusion ?? null)}). Counts are frozen only from a green core-stages-twin-chain run.`);
  // issue 1721: a stage the run adopted was not run, so its count in counts.json is not a measurement of what the stage sends
  if (j.adopted && Object.keys(j.adopted).length > 0) throw new PublishError("USAGE", `${countsJsonPath}: stage(s) ${Object.keys(j.adopted).join(", ")} were adopted (already on chain), not run, so their counts were not measured. Freeze from a rehearsal that ran every stage (a Twin chain pinned before the library block), or rebuild the baseline from this run: freeze-counts.ts --from-adopted-run ${countsJsonPath} --sha <sha> --rpc <url> (issue 1733).`);
  const sha = assertSha(String(j.deploySha));
  const counts = validateCounts(j.counts);
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  if (j.deployerNonce !== sum + PROOF_TX_NONCES) throw new PublishError("USAGE", `${countsJsonPath}: deployerNonce ${j.deployerNonce} differs from the sum of counts ${sum} plus the prove-control transaction (${PROOF_TX_NONCES})`);
  if (j.chainId !== TWIN_CHAIN_ID) throw new PublishError("USAGE", `${countsJsonPath}: counts are frozen from a Twin chain (918453) rehearsal, not chain ${j.chainId}`);
  return writeFrozen(countsDir, sha, counts, { chainId: j.chainId, at: new Date().toISOString() });
}

/** Writes the reconstructed baseline for `sha`. `getCode` and `build` are the chain and the library build; the CLI passes the real ones. */
export async function freezeFromAdoptedRun(o: {
  countsJsonPath: string; sha: string; countsDir: string; table: StageTable;
  getCode: (a: Address) => Promise<string>; build: () => ReturnType<typeof buildLibraryArtifacts>;
  crossCheckPath?: string; acceptDiff?: string[]; at?: string;
}): Promise<string> {
  const sha = assertSha(o.sha);
  const j = JSON.parse(readFileSync(o.countsJsonPath, "utf8")) as CountsJsonLike;
  // Mandatory anchor (issue 1733): the counts of the stages that adopted nothing come from a counts.json nobody can prove untampered offline, so the baseline is compared with
  // the previous release. --cross-check names it; otherwise the most recent earlier frozen file of the counts dir is used. There is no way to skip it when one exists.
  let cross: { sha: string; counts: Record<string, number>; fileHash: string } | undefined;
  if (o.crossCheckPath) {
    // the anchor must be a file of the counts dir: loadFrozen looks for it there, so a reference elsewhere would leave a baseline that never loads
    if (dirname(resolve(o.crossCheckPath)) !== resolve(o.countsDir)) throw new PublishError("USAGE", `--cross-check ${o.crossCheckPath} is not in the counts dir ${o.countsDir}: the anchor of a baseline is a frozen file of that dir (commit it there first)`);
    const bytes = readFileSync(o.crossCheckPath);
    const old = JSON.parse(bytes.toString("utf8"));
    const f = loadFrozenFile(o.crossCheckPath, assertSha(String(old.deploySha))); // an adopted-marked or unverifiable earlier file is no reference
    if (f.deploySha === sha) throw new PublishError("USAGE", "--cross-check names the file being written");
    cross = { sha: f.deploySha, counts: f.counts, fileHash: fileHashOf(bytes) };
  } else {
    const latest = latestOtherFrozen(o.countsDir, sha);
    if (latest) cross = { sha: latest.sha, counts: latest.file.counts, fileHash: fileHashOf(readFileSync(latest.path)) };
  }
  const file = await reconstructBaseline({
    j, sha, table: o.table, at: o.at ?? new Date().toISOString(), cross, acceptDiff: o.acceptDiff,
    verify: async (r) => { await verifyReconstructionOnChain(r, { table: o.table, out: o.build(), getCode: o.getCode }); },
  });
  return writeFrozen(o.countsDir, sha, file.counts, file.measured);
}

if (import.meta.main) {
  const { values: v } = parseArgs({ options: { counts: { type: "string" }, "counts-dir": { type: "string" }, "from-adopted-run": { type: "string" }, sha: { type: "string" }, rpc: { type: "string" }, "core-dir": { type: "string" }, "cross-check": { type: "string" }, "accept-diff": { type: "string" } } });
  try {
    if (v["from-adopted-run"]) {
      if (v.counts || !v.sha || !v.rpc) throw new PublishError("USAGE", "usage: freeze-counts.ts --from-adopted-run counts.json --sha <sha> --rpc <url> [--core-dir DIR] [--counts-dir DIR] [--cross-check FILE [--accept-diff stage,stage]]");
      const core = resolve(v["core-dir"] ?? resolve(import.meta.dir, "..", ".."));
      // the libraries are rebuilt from the checkout, so it must BE the sha the file is for
      const head = Bun.spawnSync(["git", "-C", core, "rev-parse", "HEAD"]).stdout.toString().trim();
      if (head !== v.sha) throw new PublishError("USAGE", `--core-dir ${core} is at ${head || "no git checkout"}, not ${v.sha}: the libraries are rebuilt from the checkout at the sha`);
      const table = loadStageTable(core);
      useStageTable(table);
      const dir = v["counts-dir"] ? resolve(v["counts-dir"]) : resolve(import.meta.dir, "..", "..", FROZEN_DIR);
      const rpc = httpRpc(v.rpc);
      const p = await freezeFromAdoptedRun({ countsJsonPath: resolve(v["from-adopted-run"]), sha: v.sha, countsDir: dir, table, getCode: async (a) => String(await rpc("eth_getCode", [a, "latest"])), build: () => buildLibraryArtifacts(core, table), crossCheckPath: v["cross-check"] ? resolve(v["cross-check"]) : undefined, acceptDiff: v["accept-diff"] ? v["accept-diff"].split(",").filter(Boolean) : undefined });
      console.log(`reconstructed baseline: ${p}`);
      const w = JSON.parse(readFileSync(p, "utf8")).measured?.crossChecked;
      console.log(w ? `cross-checked against ${w.sha} (file hash ${w.fileHash})` : "no earlier frozen file in the counts dir: nothing to cross-check against");
      process.exit(0);
    }
    if (!v.counts) throw new PublishError("USAGE", "usage: bun publish-contracts/scripts/freeze-counts.ts --counts counts.json [--counts-dir DIR]");
    const dir = v["counts-dir"] ? resolve(v["counts-dir"]) : resolve(import.meta.dir, "..", "..", FROZEN_DIR);
    console.log(`frozen counts: ${freezeCounts(resolve(v.counts), dir)}`);
  } catch (e) {
    console.error(`freeze-counts: ${(e as Error).message}`);
    process.exit(exitCodeOf(e));
  }
}
