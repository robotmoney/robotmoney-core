// Builds the CREATE2 library artifacts the way the deploy stages compile them (issue 1721, 1733), into a scratch directory (the checkout's own out/ is left alone).
// TickMath alone first (the libs stage links nothing). Then the create2 libraries WITH `--libraries TickMath:<address>`, because the basket stages compile with that
// setting and it changes the metadata hash, so it changes their CREATE2 addresses. Used by the Twin pre-deploy and by the baseline reconstruction (counts-reconstruct.ts).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCreate2Libraries } from "./libs-adopt.ts";
import type { BuildOut } from "./counts-reconstruct.ts";
import type { StageTable, TableCreate2Library } from "./stage-table.ts";

export interface LibraryBuild extends BuildOut { linked: TableCreate2Library[]; create2: TableCreate2Library[] }

/** Runs `forge build` for the library sources in `core` and returns the two output directories. Throws on a failing build. */
export function buildLibraryArtifacts(core: string, t: StageTable, forge = process.env.FORGE ?? "forge"): LibraryBuild {
  const scratch = mkdtempSync(join(tmpdir(), "predeploy-libs."));
  const build = (paths: string[], out: string, extra: string[] = []): void => {
    const r = Bun.spawnSync([forge, "build", ...paths, ...extra, "--out", join(scratch, out), "--cache-path", join(scratch, `${out}-cache`)], { cwd: core, stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) throw new Error(`forge build exited ${r.exitCode}`);
  };
  const linked = t.libraries.map((l) => ({ name: l.name, artifact: l.artifact, path: l.path }));
  build(linked.map((l) => l.path), "link-out");
  const addr = [...buildCreate2Libraries(linked, join(scratch, "link-out")).values()];
  const c2 = t.create2Libraries ?? [];
  build(c2.map((l) => l.path), "c2-out", addr.flatMap((a) => ["--libraries", `${linked.find((l) => l.artifact === a.artifact)!.path}:${a.artifact}:${a.address}`]));
  return { linkOut: join(scratch, "link-out"), c2Out: join(scratch, "c2-out"), linked, create2: c2 };
}
