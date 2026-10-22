// Issue 1809 (upgradeability stage 2): the deploy runs the proxy stages in the table's order with the sheet's release mode, records the mode once in the run manifest,
// and a resume after a partial failure reaches a state-compatible result: the same mode, every proxy manifest naming its implementation, its authority and that mode.
// Stub forge and cast (tests/stubs): this proves the orchestration. The real chain proof is the Twin chain rehearsal (suite 28) and its verify stage.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PROOF_TX_NONCES } from "../src/counts.ts";
import { EXIT_CODES } from "../src/errors.ts";
import { getStageTable } from "../src/stages.ts";
import { COUNTS } from "./fixtures.ts";
import { ADMIN, SCRIPT, world } from "./harness.ts";

const table = getStageTable();
const PROXY_STAGES = table.stages.filter((s) => s.proxies && s.system !== "gateway").map((s) => s.name); // issue 1892: the vaults system's proxy stages
const forgeScripts = (w: ReturnType<typeof world>) => w.state().calls.filter((c: any) => c.tool === "forge" && c.args[0] === "script");
const broadcastOf = (w: ReturnType<typeof world>, stage: string) => forgeScripts(w).filter((c: any) => String(c.args[1]).startsWith(table.stages.find((s) => s.name === stage)!.script) && c.args.includes("--broadcast"));
const runManifest = (w: ReturnType<typeof world>) => JSON.parse(readFileSync(join(w.evidence, "publish-run.json"), "utf8"));
const stageManifest = (w: ReturnType<typeof world>, stage: string) => JSON.parse(readFileSync(join(w.coreDir, "deployments", "918453", basename(table.stages.find((s) => s.name === stage)!.manifest)), "utf8"));
const lastError = (w: ReturnType<typeof world>) => w.logs().filter((l) => l.event === "run.failed").pop();
const setSheetMode = (w: ReturnType<typeof world>, mode: string) => writeFileSync(w.sheetPath, readFileSync(w.sheetPath, "utf8").replace(/^UPGRADE_MODE=.*$/m, `UPGRADE_MODE=${mode}`));

describe("the proxy stages run in table order with the sheet's release mode (issue 1809)", () => {
  for (const mode of ["frozen", "upgradeable"] as const) {
    test(`UPGRADE_MODE=${mode}: every proxy stage reads it, its manifest records it with the implementation and the authority, and the run manifest records it once`, async () => {
      const w = world({ startNonce: 0, sheet: { UPGRADE_MODE: mode } });
      expect(await w.run(["--stage", "deploy"])).toBe(0);
      expect(lastError(w)).toBeUndefined();
      // the proxy stages are the table's, in its order, all before the timelock stage (the upgrade authority is deployed last)
      const ran = Object.keys(runManifest(w).stages);
      expect(ran.filter((s) => PROXY_STAGES.includes(s))).toEqual(PROXY_STAGES);
      expect(ran.indexOf("timelock")).toBeGreaterThan(Math.max(...PROXY_STAGES.map((s) => ran.indexOf(s))));
      for (const s of PROXY_STAGES) {
        const calls = broadcastOf(w, s);
        expect(calls.length, s).toBe(1);
        expect(calls[0].env.UPGRADE_MODE, s).toBe(mode);
        const m = stageManifest(w, s);
        expect(m.upgrade_mode, s).toBe(mode);
        for (const p of table.stages.find((x) => x.name === s)!.proxies!) { expect(m[p.field], `${s} ${p.field}`).toMatch(/^0x[0-9a-f]{40}$/); expect(m[p.implementationField], `${s} ${p.implementationField}`).toMatch(/^0x[0-9a-f]{40}$/); }
      }
      // the timelock stage takes no mode: it deploys the authority, not a proxy
      expect(broadcastOf(w, "timelock")[0].env.UPGRADE_MODE).toBeUndefined();
      expect(runManifest(w).upgradeMode).toBe(mode);
    });
  }
});

describe("resume after a partial failure of a proxy stage reaches a state-compatible result (issue 1809)", () => {
  test("a proxy stage (registry) dies after its implementation landed: --resume replays the same stage, the stage manifest names both addresses in the run's mode, the nonce is the frozen sum", async () => {
    const w = world({ startNonce: 0 });
    w.cfg.failBroadcast = SCRIPT.registry;
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.BROADCAST);
    const m1 = runManifest(w);
    expect(m1.stages.registry.status).toBe("started");
    expect(m1.stages.vault.status).toBe("done");
    expect(m1.upgradeMode).toBe("frozen");
    expect(await w.run(["--stage", "deploy", "--resume"])).toBe(0);
    // only the failed stage is resumed (forge --resume replays its own transactions at the same nonces), every earlier proxy stage is skipped
    const resumed = forgeScripts(w).filter((c: any) => c.args.includes("--resume")).map((c: any) => c.args[1].split(":")[0].split("/").pop());
    expect(resumed).toEqual([SCRIPT.registry]);
    expect(w.logs().filter((l) => l.event === "stage.skipped").map((l) => l.stage)).toEqual(["safe", "libs", "vault"]);
    const m2 = runManifest(w);
    expect(m2.stages.registry.status).toBe("done");
    expect(m2.stages.registry.startNonce).toBe(m1.stages.registry.startNonce);
    const g = stageManifest(w, "registry");
    expect(g).toMatchObject({ upgrade_mode: "frozen" });
    expect(g.registry).toMatch(/^0x[0-9a-f]{40}$/);
    expect(g.registry_implementation).toMatch(/^0x[0-9a-f]{40}$/);
    expect(w.state().nonces[ADMIN.toLowerCase()]).toBe(Object.values(COUNTS).reduce((a, b) => a + b, 0) + PROOF_TX_NONCES);
  });

  test("a resume under another UPGRADE_MODE than the run started with is refused before any forge call", async () => {
    const w = world({ startNonce: 0 });
    w.cfg.failBroadcast = SCRIPT.registry;
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.BROADCAST);
    setSheetMode(w, "upgradeable");
    const before = forgeScripts(w).length;
    expect(await w.run(["--stage", "deploy", "--resume"])).toBe(EXIT_CODES.RESUME);
    expect(lastError(w).message).toContain("never changes its release mode");
    expect(forgeScripts(w).length).toBe(before);
  });

  test("a manifest written before the field existed is a frozen run (the interim literal of issue 1808): an upgradeable resume is refused, a frozen one continues", async () => {
    const w = world({ startNonce: 0 });
    w.cfg.failBroadcast = SCRIPT.registry;
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.BROADCAST);
    const p = join(w.evidence, "publish-run.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    delete m.upgradeMode;
    writeFileSync(p, JSON.stringify(m));
    setSheetMode(w, "upgradeable");
    expect(await w.run(["--stage", "deploy", "--resume"])).toBe(EXIT_CODES.RESUME);
    setSheetMode(w, "frozen");
    expect(await w.run(["--stage", "deploy", "--resume"])).toBe(0);
    expect(runManifest(w).upgradeMode).toBe("frozen");
  });

  test("a proxy stage whose manifest comes back in another mode stops the run (MANIFEST): the stage stays started and no later stage runs", async () => {
    const w = world({ startNonce: 0 });
    w.cfg.manifestMode = { [SCRIPT.registry!]: "upgradeable" };
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.MANIFEST);
    expect(lastError(w).message).toContain("upgrade_mode is upgradeable, the sheet's UPGRADE_MODE is frozen");
    const m = runManifest(w);
    expect(m.stages.registry.status).toBe("started");
    expect(m.stages.router).toBeUndefined();
    expect(broadcastOf(w, "router")).toEqual([]);
  });
});
