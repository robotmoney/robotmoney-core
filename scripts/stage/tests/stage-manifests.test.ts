import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countStageManifests } from "../core-stack.ts";
import {
  STAGE_TABLE,
  allManifests,
  expectedManifestCount,
  manifestOf,
  publishEnv,
  vaultManifests,
  type StageTableShape,
} from "../stage-manifests.ts";

const REAL = JSON.parse(readFileSync(join(import.meta.dir, "../../deploy/stage-table.json"), "utf8")) as StageTableShape;
let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "stage-manifests-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A copy of the table with the vault stage's manifest renamed. */
function renamed(): StageTableShape {
  const t = structuredClone(REAL);
  t.stages.find((s) => s.name === "vault")!.manifest = "deployments/<chain>/usdc-vault-renamed.json";
  t.vaults.find((v) => v.key === "USDC")!.manifest = "deployments/<chain>/usdc-vault-renamed.json";
  return t;
}

describe("manifest names come from the stage table", () => {
  test("the bundled table is the file on disk", () => expect(STAGE_TABLE).toEqual(REAL));
  test("no hard-coded core.json or vault-<key>.json names", () => {
    expect(allManifests()).not.toContain("core.json");
    expect(allManifests().some((f) => f.startsWith("vault-"))).toBe(false);
    expect(allManifests()).toContain("vault.json");
  });
  test("the expected count is the number of stages with a manifest", () => {
    expect(expectedManifestCount()).toBe(REAL.stages.filter((s) => s.manifest).length);
    expect(expectedManifestCount()).toBe(allManifests().length);
  });
  test("a stage without a manifest does not count, and renaming follows", () => {
    const t = structuredClone(REAL);
    t.stages.find((s) => s.name === "libs")!.manifest = null;
    expect(expectedManifestCount(t)).toBe(expectedManifestCount() - 1);
    expect(manifestOf("vault", renamed())).toBe("usdc-vault-renamed.json");
    expect(vaultManifests(renamed()).rmUSDC).toBe("usdc-vault-renamed.json");
  });
  test("the counter follows a renamed manifest in a temp copy of the table", () => {
    mkdirSync(join(dir, "m"));
    for (const f of allManifests()) writeFileSync(join(dir, "m", f), "{}");
    expect(countStageManifests(join(dir, "m"))).toBe(expectedManifestCount());
    expect(countStageManifests(join(dir, "m"), renamed())).toBe(expectedManifestCount() - 1);
    writeFileSync(join(dir, "m", "usdc-vault-renamed.json"), "{}");
    expect(countStageManifests(join(dir, "m"), renamed())).toBe(expectedManifestCount());
  });
});

describe("publish environment", () => {
  test("Twin chain 918453 gets YES=1 and no CONFIRM", () => {
    const e = publishEnv(918453, "/m");
    expect(e.YES).toBe("1");
    expect("CONFIRM" in e && e.CONFIRM !== undefined).toBe(false);
    expect(e.PUBLISH_MANIFEST_DIR).toBe("/m");
  });
  test("chain 8453 never gets YES=1", () => {
    expect(publishEnv(8453, "/m").YES).toBeUndefined();
    expect(publishEnv(1, "/m").YES).toBeUndefined();
  });
});
