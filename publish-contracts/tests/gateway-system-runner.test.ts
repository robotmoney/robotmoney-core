// Issue 1892: the gateway system runs on its own. It deploys and hands over the gateway against the vaults system's manifests, with its own sheet, evidence directory and run manifest,
// no Safe, no control proof, no govern row and no agent. Missing or zero governance inputs and any AGENT_ name are refused BEFORE a signer or a forge call. Stub forge and cast
// (tests/stubs): this proves the orchestration. The chain proof is the Twin gateway scenario (suite 28 core-stages-twin-chain) and the gateway verifier (tests/verify/systems.test.ts).
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_CODES } from "../src/errors.ts";
import { getStageTable } from "../src/stages.ts";
import { ADMIN, SCRIPT, world, type World } from "./harness.ts";

const GW_TL = "0x000000000000000000000000000000000000a0c2";
const forgeScripts = (w: World) => w.state().calls.filter((c: any) => c.tool === "forge" && c.args[0] === "script");
const broadcasts = (w: World) => forgeScripts(w).filter((c: any) => c.args.includes("--broadcast")).map((c: any) => String(c.args[1]).split(":")[0].split("/").pop());
const lastError = (w: World) => w.logs().filter((l) => l.event === "run.failed").pop();
const runManifest = (w: World) => JSON.parse(readFileSync(join(w.evidence, "publish-run.json"), "utf8"));
const mdir = (w: World) => join(w.coreDir, "deployments", "918453");
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const VAULTS_FILES = ["vault.json", "router.json", "libs.json"];

describe("the gateway system run (issue 1892)", () => {
  test("it deploys the gateway then the handover and nothing else: no Safe, no control proof, no vaults stage, no AGENT_ name", async () => {
    const w = world({ system: "gateway", startNonce: 40 });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    expect(lastError(w)).toBeUndefined();
    expect(broadcasts(w)).toEqual([SCRIPT.gateway, SCRIPT["gateway-handover"]]);
    expect(w.safeCalls).toEqual([]);
    const m = runManifest(w);
    expect(Object.keys(m.stages)).toEqual(["gateway", "gateway-handover"]);
    expect(m.system).toBe("gateway");
    expect(m.deployerStartNonce).toBe(40);
    // the gateway stage names the sheet's explicit timelock; it reads neither the Safe nor the vaults delay
    const gw = forgeScripts(w).find((c: any) => c.args.includes("--broadcast") && String(c.args[1]).includes("DeployGateway"));
    expect(gw.env.GATEWAY_UPGRADE_TIMELOCK.toLowerCase()).toBe(GW_TL);
    expect(gw.env.SAFE_ADDRESS).toBeUndefined();
    expect(gw.env.TIMELOCK_MIN_DELAY).toBeUndefined();
    expect(gw.env.VAULT_ADDRESS).toBe("0x0000000000000000000000000000000000001001");
    expect(gw.env.ROUTER_ADDRESS).toBe("0x0000000000000000000000000000000000001003");
    const ho = forgeScripts(w).find((c: any) => c.args.includes("--broadcast") && String(c.args[1]).includes("HandoverGateway"));
    expect(ho.env.GATEWAY_ADMIN_ADDRESS.toLowerCase()).toBe("0x000000000000000000000000000000000000a0c1");
    for (const c of forgeScripts(w)) expect(Object.keys(c.env).filter((k) => k.startsWith("AGENT_")), String(c.args[1])).toEqual([]);
    // 3 + 4 transactions after the recorded start, and the stage nonces follow it
    expect(m.stages.gateway.startNonce).toBe(40);
    expect(m.stages["gateway-handover"].startNonce).toBe(43);
    expect(w.state().nonces[ADMIN.toLowerCase()]).toBe(47);
  });

  test("the vaults manifests are consumed and left unchanged: their hashes are recorded when the run begins", async () => {
    const w = world({ system: "gateway", startNonce: 0 });
    const before = Object.fromEntries(VAULTS_FILES.map((f) => [f, sha(join(mdir(w), f))]));
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    expect(runManifest(w).consumedVaultsManifests).toEqual({ vault: before["vault.json"], router: before["router.json"], libs: before["libs.json"] });
    for (const f of VAULTS_FILES) expect(sha(join(mdir(w), f)), f).toBe(before[f]!);
  });

  test("a gateway run before a vaults run is refused before any signer or forge call", async () => {
    const w = world({ system: "gateway", startNonce: 0 });
    rmSync(join(mdir(w), "router.json"));
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.INPUT_MISSING);
    expect(lastError(w).message).toContain("router.json");
    expect(forgeScripts(w).filter((c: any) => c.args.includes("--broadcast"))).toEqual([]);
  });

  for (const [what, sheet] of [
    ["a missing upgrade timelock", { GATEWAY_UPGRADE_TIMELOCK: null }],
    ["a zero upgrade timelock", { GATEWAY_UPGRADE_TIMELOCK: "0x0000000000000000000000000000000000000000" }],
    ["a missing gateway admin", { GATEWAY_ADMIN_ADDRESS: null }],
    ["an AGENT_ADDRESSES line", { AGENT_ADDRESSES: "0x000000000000000000000000000000000000a0aa" }],
    ["an AGENT_ADDRESS line", { AGENT_ADDRESS: "0x000000000000000000000000000000000000a0aa" }],
    ["a vaults-only name (the vaults timelock delay)", { TIMELOCK_MIN_DELAY: "172800" }],
    ["a Safe input", { SAFE_OWNERS: "0x000000000000000000000000000000000000a0bb" }],
  ] as const) {
    test(`${what} in the gateway sheet is refused before any signer, forge call or broadcast`, async () => {
      const w = world({ system: "gateway", startNonce: 7, sheet: sheet as Record<string, string | null> });
      expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.SHEET);
      expect(forgeScripts(w)).toEqual([]);
      expect(w.state().nonces[ADMIN.toLowerCase()]).toBe(7);
      expect(existsSync(join(mdir(w), "gateway.json"))).toBe(false);
    });
  }

  test("a vaults sheet that names a gateway input is refused: the vaults system has no gateway input", async () => {
    const w = world({ startNonce: 0, sheet: { GATEWAY_UPGRADE_TIMELOCK: GW_TL } });
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.SHEET);
    expect(lastError(w).message).toContain("GATEWAY_UPGRADE_TIMELOCK is refused in a vaults sheet");
    expect(forgeScripts(w)).toEqual([]);
  });

  test("the vaults verbs are the vaults system's: govern, pause-all and record-receipt refuse --system gateway", async () => {
    for (const verb of ["govern", "pause-all", "record-receipt", "redeploy-vault"]) {
      const w = world({ system: "gateway", startNonce: 0 });
      expect(await w.run([verb]), verb).toBe(EXIT_CODES.USAGE);
      expect(forgeScripts(w)).toEqual([]);
    }
  });

  test("the stage list of the gateway run names no vaults stage: --stage safe, prove-control and govern are unknown to it", async () => {
    for (const stage of ["safe", "prove-control", "govern", "timelock"]) {
      const w = world({ system: "gateway", startNonce: 0 });
      expect(await w.run(["--stage", stage]), stage).toBe(EXIT_CODES.USAGE);
    }
  });

  test("a vaults run cannot resume the gateway run's evidence directory, nor the reverse (each system has its own run manifest)", async () => {
    const g = world({ system: "gateway", startNonce: 0 });
    expect(await g.run(["--stage", "deploy"])).toBe(0);
    const m = runManifest(g);
    const v = world({ startNonce: 0 });
    writeFileSync(join(v.dir, "gw-run.json"), JSON.stringify(m));
    // place the gateway run manifest where the vaults world looks for its own
    const { mkdirSync } = await import("node:fs");
    mkdirSync(v.evidence, { recursive: true });
    writeFileSync(join(v.evidence, "publish-run.json"), JSON.stringify({ ...m, deployer: ADMIN, coreSha: "a".repeat(40), chainId: 918453 }));
    expect(await v.run(["--stage", "deploy", "--resume"])).toBe(EXIT_CODES.RESUME);
    expect(lastError(v).message).toContain("--system vaults");
  });

  test("the gateway stage records the sheet's explicit timelock, and a manifest that names another is refused (MANIFEST)", async () => {
    const w = world({ system: "gateway", startNonce: 0 });
    w.cfg.upgradeTimelock = { [SCRIPT.gateway!]: "0x00000000000000000000000000000000000071e1" };
    expect(await w.run(["--stage", "deploy"])).toBe(EXIT_CODES.MANIFEST);
    expect(lastError(w).message).toContain("upgrade_timelock");
    expect(broadcasts(w)).toEqual([SCRIPT.gateway]);
  });

  test("a stray transaction before the handover stage is refused: the nonce is checked from the recorded start", async () => {
    const w = world({ system: "gateway", startNonce: 12 });
    expect(await w.run(["--stage", "gateway"])).toBe(0);
    w.setNonce(w.state().nonces[ADMIN.toLowerCase()] + 1);
    expect(await w.run(["--stage", "gateway-handover", "--resume"])).toBe(EXIT_CODES.NONCE);
    expect(broadcasts(w)).toEqual([SCRIPT.gateway]);
  });

  test("the table is the gateway system's: gateway and gateway-handover, requiring the vaults system", () => {
    const t = getStageTable();
    expect(t.systems?.gateway?.stages).toEqual(["gateway", "gateway-handover"]);
    expect(t.systems?.gateway?.requires).toEqual(["vaults"]);
  });
});

describe("the frozen counts of both systems live in one file per sha", () => {
  test("a gateway Twin run without gateway counts measures them and adds them without changing a vaults count", async () => {
    const w = world({ system: "gateway", startNonce: 0, writeFrozen: false });
    const file = join(w.countsDir, `${"a".repeat(40)}.json`);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(w.countsDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ deploySha: "a".repeat(40), measured: { chainId: 918453, at: "2026-10-02T00:00:00Z" }, counts: { safe: 1, libs: 4, vault: 18 } }));
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    const j = JSON.parse(readFileSync(file, "utf8"));
    expect(j.counts).toMatchObject({ safe: 1, libs: 4, vault: 18, gateway: 3, "gateway-handover": 4 });
  });
});
