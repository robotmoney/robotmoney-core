#!/usr/bin/env bun
// Twin chain CI step (issue 1721): builds the four libraries and deploys them on the Twin fork before the publish run.
//   bun src/ci/predeploy-libs.ts --rpc URL --core-dir DIR
// Env: FORGE (default forge). Refuses a Base mainnet RPC and anything that is not an anvil fork. Issue 1926: reads `forge --version` first and refuses any forge but
// the pinned release-build version (forge-version.ts) with exit 18 (TOOL), before the stage table is read or anything is built or sent.
// The build mirrors what the deploy stages compile. TickMath alone first (the libs stage links nothing). Then the three libraries WITH `--libraries TickMath:<address>`,
// because the basket stages compile with that setting and it changes the metadata hash, so it changes their CREATE2 addresses. The output goes to a scratch directory:
// the checkout's own out/ is left to the stages.
import { parseArgs } from "node:util";
import { isPublishError } from "../errors.ts";
import { assertPinnedForge } from "../forge-version.ts";
import { buildLibraryArtifacts } from "../libs-build.ts";
import { loadStageTable } from "../stage-table.ts";
import { predeployLibraries } from "../rehearsal/predeploy-libs.ts";
import { httpRpc } from "../rehearsal/twin.ts";

const { values: v } = parseArgs({ options: { rpc: { type: "string" }, "core-dir": { type: "string" } } });
if (!v.rpc || !v["core-dir"]) { console.error("predeploy-libs: --rpc and --core-dir are required"); process.exit(2); }
const core = v["core-dir"];
try { assertPinnedForge(process.env.FORGE ?? "forge"); } catch (e) { console.error(`predeploy-libs: ${(e as Error).message}`); process.exit(isPublishError(e) ? e.exitCode : 1); }
const t = loadStageTable(core);
try {
  const b = buildLibraryArtifacts(core, t);
  const results = [...(await predeployLibraries(httpRpc(v.rpc), b.linked, b.linkOut)), ...(await predeployLibraries(httpRpc(v.rpc), b.create2, b.c2Out))];
  for (const r of results) console.log(`predeploy-libs: ${r.built.name} ${r.built.address} ${r.created ? "created" : "already there"} ${r.built.runtimeHash}`);
} catch (e) { console.error(`predeploy-libs: ${(e as Error).message}`); process.exit(1); }
