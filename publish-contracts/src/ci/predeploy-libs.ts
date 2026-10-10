#!/usr/bin/env bun
// Twin chain CI step (issue 1721): builds the four libraries and deploys them on the Twin fork before the publish run.
//   bun src/ci/predeploy-libs.ts --rpc URL --core-dir DIR
// Env: FORGE (default forge). Refuses a Base mainnet RPC and anything that is not an anvil fork.
// The build mirrors what the deploy stages compile. TickMath alone first (the libs stage links nothing). Then the three libraries WITH `--libraries TickMath:<address>`,
// because the basket stages compile with that setting and it changes the metadata hash, so it changes their CREATE2 addresses. The output goes to a scratch directory:
// the checkout's own out/ is left to the stages.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildCreate2Libraries } from "../libs-adopt.ts";
import { loadStageTable } from "../stage-table.ts";
import { predeployLibraries } from "../rehearsal/predeploy-libs.ts";
import { httpRpc } from "../rehearsal/twin.ts";

const { values: v } = parseArgs({ options: { rpc: { type: "string" }, "core-dir": { type: "string" } } });
if (!v.rpc || !v["core-dir"]) { console.error("predeploy-libs: --rpc and --core-dir are required"); process.exit(2); }
const core = v["core-dir"];
const t = loadStageTable(core);
const forge = process.env.FORGE ?? "forge";
const scratch = mkdtempSync(join(tmpdir(), "predeploy-libs."));
const build = (paths: string[], out: string, extra: string[] = []): void => {
  const r = Bun.spawnSync([forge, "build", ...paths, ...extra, "--out", join(scratch, out), "--cache-path", join(scratch, `${out}-cache`)], { cwd: core, stdout: "inherit", stderr: "inherit" });
  if (r.exitCode !== 0) { console.error(`predeploy-libs: forge build exited ${r.exitCode}`); process.exit(1); }
};
try {
  const linked = t.libraries.map((l) => ({ name: l.name, artifact: l.artifact, path: l.path }));
  build(linked.map((l) => l.path), "link-out");
  const addr = [...buildCreate2Libraries(linked, join(scratch, "link-out")).values()];
  const c2 = t.create2Libraries ?? [];
  build(c2.map((l) => l.path), "c2-out", addr.flatMap((a) => ["--libraries", `${linked.find((l) => l.artifact === a.artifact)!.path}:${a.artifact}:${a.address}`]));
  const results = [...(await predeployLibraries(httpRpc(v.rpc), linked, join(scratch, "link-out"))), ...(await predeployLibraries(httpRpc(v.rpc), c2, join(scratch, "c2-out")))];
  for (const r of results) console.log(`predeploy-libs: ${r.built.name} ${r.built.address} ${r.created ? "created" : "already there"} ${r.built.runtimeHash}`);
} catch (e) { console.error(`predeploy-libs: ${(e as Error).message}`); process.exit(1); }
