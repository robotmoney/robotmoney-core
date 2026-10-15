// Issue 1809 (ADR-0014): the deploy tooling for the governed proxies. The stage table deploys the timelock before every proxy (the authority stage), feeds each
// proxy stage the authority and the sheet's release mode, and the runner reads every proxy back right after its stage: an undeclared mode, an unexpected ERC-1967 admin
// slot or another implementation stops the run before the next stage. Runner tests run on the stub forge and cast (tests/harness.ts) with a fake chain for the read-back
// (tests/fixtures.ts healthyProxyReader). The real proxies are deployed by the forge scripts (contracts/script/GovernedProxyDeploy.sol) on the Twin rehearsal.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Hex } from "viem";
import { EXIT_CODES } from "../src/errors.ts";
import { AUTHORITY_STAGE, HANDOVER_STAGE, resolveEnv } from "../src/core-wiring.ts";
import { parityProblems, proxyProblems as parityProxyProblems } from "../src/ci/core-parity.ts";
import { DEPLOYER_STAGES, STAGE_NAMES, getStageTable } from "../src/stages.ts";
import { parseStageTable, proxiesOfStage, proxyByName, tableProxies } from "../src/stage-table.ts";
import { parseSheet } from "../src/sheet.ts";
import { INITIALIZERS_LOCKED, ZERO_WORD, expectFrozen, initializableOf, proxyChecks, proxyProblems, proxyRecordOf, wordAddress, type ProxyState, type ProxyWant } from "../src/proxies.ts";
import { REPO, STUB_AUTHORITY, healthyProxyReader, sheetText } from "./fixtures.ts";
import { SCRIPT, world } from "./harness.ts";

const table = getStageTable();
const addrN = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const manifest = (w: ReturnType<typeof world>) => JSON.parse(readFileSync(join(w.evidence, "publish-run.json"), "utf8"));
const lastError = (w: ReturnType<typeof world>) => w.logs().filter((l) => l.event === "run.failed").pop();
const forgeScripts = (w: ReturnType<typeof world>) => w.state().calls.filter((c: any) => c.tool === "forge" && c.args[0] === "script");
const broadcasts = (w: ReturnType<typeof world>) => forgeScripts(w).filter((c: any) => c.args.includes("--broadcast")).map((c: any) => c.args[1].split(":")[0].split("/").pop());
const PROXY_STAGES = ["vault", "registry", "router", "gateway", "ic-policy", "proto", "agent", "rwa"];

describe("issue 1809: the stage table deploys the authority first and states every proxy's authority and mode", () => {
  test("the authority stage runs after the recorder and before the first proxy stage; it sends deployer transactions; the handover stays last", () => {
    expect(STAGE_NAMES.slice(0, 5)).toEqual(["safe", "libs", "recorder", AUTHORITY_STAGE, "vault"]);
    for (const s of PROXY_STAGES) expect([s, STAGE_NAMES.indexOf(AUTHORITY_STAGE) < STAGE_NAMES.indexOf(s)]).toEqual([s, true]);
    expect(DEPLOYER_STAGES.map((s) => s.name)).toContain(AUTHORITY_STAGE);
    expect(DEPLOYER_STAGES[DEPLOYER_STAGES.length - 1]!.name).toBe(HANDOVER_STAGE);
  });

  test("the proxies are the nine of ADR-0014 §1, one row each, and each stage deploys the ones it names", () => {
    expect(tableProxies(table).map((p) => p.name)).toEqual(["rmUSDC", "registry", "router", "gateway", "icpolicy", "receipt", "rmPROTO", "rmAGENT", "rmRWA"]);
    expect(proxiesOfStage(table, "ic-policy").map((p) => [p.name, p.field, p.implementationField])).toEqual([["icpolicy", "policy", "policy_implementation"], ["receipt", "consensus_receipt", "consensus_receipt_implementation"]]);
    expect(proxiesOfStage(table, "governance")).toEqual([]);
    expect(proxiesOfStage(table, "timelock")).toEqual([]);
    expect(new Set(tableProxies(table).map((p) => p.stage))).toEqual(new Set(PROXY_STAGES));
    expect(() => proxyByName(table, "timelock")).toThrow("is not a proxied contract");
    // a core sha before the proxies: no proxies, nothing to read back
    const raw = JSON.parse(readFileSync(join(REPO, "scripts", "deploy", "stage-table.json"), "utf8"));
    delete raw.proxies; delete raw.proxyArtifact;
    expect(tableProxies(parseStageTable(raw))).toEqual([]);
  });

  test("the authority stage's timelock feeds UPGRADE_AUTHORITY of every proxy stage and TIMELOCK_ADDRESS of the handover; the redeploy keeps the handover manifest's", () => {
    expect(resolveEnv("UPGRADE_AUTHORITY", "USDC", "vault")).toEqual({ from: "manifest", stage: AUTHORITY_STAGE, field: "timelock" });
    expect(resolveEnv("UPGRADE_AUTHORITY", null, "gateway")).toEqual({ from: "manifest", stage: AUTHORITY_STAGE, field: "timelock" });
    expect(resolveEnv("TIMELOCK_ADDRESS", null, HANDOVER_STAGE)).toEqual({ from: "manifest", stage: AUTHORITY_STAGE, field: "timelock" });
    expect(resolveEnv("TIMELOCK_ADDRESS", "PROTO", "redeploy-proto")).toEqual({ from: "manifest", stage: "timelock", field: "timelock" });
    expect(resolveEnv("UPGRADE_MODE", "PROTO", "proto")).toEqual({ from: "sheet", name: "UPGRADE_MODE" });
    expect(resolveEnv("EXCLUSION_LEDGER_FACTORY", "USDC", "vault")).toEqual({ from: "manifest", stage: "libs", field: "exclusion_ledger_factory" });
  });

  test("core parity holds for the proxies, and a proxy list that is not the layout gate's is a problem", () => {
    expect(parityProblems(table, REPO)).toEqual([]);
    const fewer = { ...table, proxies: tableProxies(table).slice(1) };
    expect(parityProxyProblems(fewer, REPO, () => true).join()).toContain("differ from the layout gate's proxied.txt");
    const unwritten = parityProxyProblems(table, REPO, (_s, f) => f !== "upgrade_mode");
    expect(unwritten.length).toBe(tableProxies(table).length);
    expect(unwritten[0]).toContain("manifest field upgrade_mode is not written");
  });
});

describe("issue 1809: UPGRADE_MODE is required and declared", () => {
  test("the sheet states upgradeable or frozen-at-deploy; a missing line or any other value (unset included) is refused", () => {
    expect(parseSheet(sheetText()).upgradeMode).toBe("upgradeable");
    expect(parseSheet(sheetText({ UPGRADE_MODE: "frozen-at-deploy" })).upgradeMode).toBe("frozen-at-deploy");
    expect(() => parseSheet(sheetText({ UPGRADE_MODE: null }))).toThrow("UPGRADE_MODE");
    for (const bad of ["unset", "Upgradeable", "frozen", "0"]) expect(() => parseSheet(sheetText({ UPGRADE_MODE: bad }))).toThrow("UPGRADE_MODE must be upgradeable or frozen-at-deploy");
  });
});

describe("issue 1809: the runner deploys each proxy with the timelock and the mode, and reads it back", () => {
  test("every proxy stage gets UPGRADE_AUTHORITY (the authority stage's timelock) and UPGRADE_MODE; the handover gets the same timelock; each stage records its proxies", async () => {
    const w = world({ startNonce: 0 });
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    expect(lastError(w)).toBeUndefined();
    const env = (stage: string) => forgeScripts(w).find((c: any) => String(c.args[1]).startsWith(table.stages.find((s) => s.name === stage)!.script) && c.args.includes("--broadcast"))!.env;
    for (const s of PROXY_STAGES) expect([s, env(s).UPGRADE_AUTHORITY, env(s).UPGRADE_MODE]).toEqual([s, STUB_AUTHORITY, "upgradeable"]);
    expect(env("timelock").TIMELOCK_ADDRESS).toBe(STUB_AUTHORITY);
    expect(env("vault").EXCLUSION_LEDGER_FACTORY).toBe(addrN(0x100b));
    expect(env(AUTHORITY_STAGE).SAFE_ADDRESS).toBeTruthy();
    for (const s of ["libs", "recorder", "governance", "timelock"]) expect([s, env(s).UPGRADE_AUTHORITY]).toEqual([s, undefined]);
    expect(broadcasts(w).slice(0, 4)).toEqual([SCRIPT.libs, SCRIPT.recorder, SCRIPT.authority, SCRIPT.vault]);
    const m = manifest(w);
    expect(m.stages.vault.proxy_gate).toEqual({ ok: true, problems: [] });
    expect(m.stages.vault.proxies).toEqual([expect.objectContaining({ name: "rmUSDC", proxy: addrN(0x1001), implementation: addrN(0x2001), authority: STUB_AUTHORITY, mode: "upgradeable", frozen: false, admin_slot_empty: true, beacon_slot_empty: true })]);
    expect(m.stages["ic-policy"].proxies.map((p: { name: string }) => p.name)).toEqual(["icpolicy", "receipt"]);
    expect(m.stages.governance.proxies).toBeUndefined();
    expect(m.stages.timelock.proxies).toBeUndefined();
    expect(w.logs().filter((l) => l.event === "stage.proxy_ok").map((l) => l.stage)).toEqual(PROXY_STAGES);
  });

  test("an unexpected ERC-1967 admin slot stops the run right after the stage that deployed it (VERIFY), and no later stage starts, not even on --resume", async () => {
    const w = world({ startNonce: 0 });
    const reader = () => healthyProxyReader({ adminSlot: `0x${"0".repeat(24)}${"ad".repeat(20)}` as Hex });
    expect(await w.run(["--stage", "deploy"], { proxyReader: reader })).toBe(EXIT_CODES.VERIFY);
    expect(lastError(w).message).toContain("admin slot");
    expect(lastError(w).message).toContain("is not empty");
    expect(broadcasts(w)).toEqual([SCRIPT.libs, SCRIPT.recorder, SCRIPT.authority, SCRIPT.vault]);
    const m = manifest(w);
    expect(m.stages.vault.status).toBe("done"); // its transactions are real and counted
    expect(m.stages.vault.proxy_gate.ok).toBe(false);
    expect(m.stages.vault.proxy_gate.problems[0]).toContain("rmUSDC: the ERC-1967 admin slot");
    expect(m.stages.vault.proxies[0].admin_slot_empty).toBe(false);
    expect(await w.run(["--stage", "deploy", "--resume"])).toBe(EXIT_CODES.VERIFY);
    expect(lastError(w).message).toContain("stage registry will not start: stage vault deployed a proxy that is not what the deploy declared");
    expect(broadcasts(w)).toEqual([SCRIPT.libs, SCRIPT.recorder, SCRIPT.authority, SCRIPT.vault]);
  });

  test("an undeclared mode in a stage manifest, a proxy on another implementation, another authority, a frozen proxy in upgradeable mode: each is refused", async () => {
    const cases: [string, (w: ReturnType<typeof world>) => object, string][] = [
      ["undeclared mode", (w) => { w.cfg.upgradeMode = "unset"; return {}; }, "not a declared mode"],
      ["another implementation", () => ({ proxyReader: () => healthyProxyReader({ implementation: addrN(0x2bad) }) }), "implementation slot"],
      ["another authority", () => ({ proxyReader: () => healthyProxyReader({ authority: addrN(0xbad) }) }), "upgradeAuthority()"],
      ["frozen while the sheet says upgradeable", () => ({ proxyReader: () => healthyProxyReader({ frozen: true }) }), "upgradesFrozen()"],
      ["an implementation anyone could initialize", () => ({ proxyReader: () => healthyProxyReader({ implementationUnlocked: true }) }), "anyone could initialize it"],
    ];
    for (const [why, arrange, msg] of cases) {
      const w = world({ startNonce: 0 });
      const over = arrange(w);
      expect([why, await w.run(["--stage", "deploy"], over)]).toEqual([why, EXIT_CODES.VERIFY]);
      expect([why, lastError(w).message]).toEqual([why, expect.stringContaining(msg)]);
      expect([why, broadcasts(w).at(-1)]).toEqual([why, SCRIPT.vault]);
    }
  });

  test("a frozen-at-deploy sheet expects every proxy frozen at birth", async () => {
    const w = world({ startNonce: 0, sheet: { UPGRADE_MODE: "frozen-at-deploy" } });
    w.cfg.upgradeMode = "frozen-at-deploy";
    expect(await w.run(["--stage", "deploy"])).toBe(0);
    expect(manifest(w).stages.vault.proxies[0]).toMatchObject({ mode: "frozen-at-deploy", frozen: true });
    // the same sheet against proxies that read unfrozen is refused
    const u = world({ startNonce: 0, sheet: { UPGRADE_MODE: "frozen-at-deploy" } });
    u.cfg.upgradeMode = "frozen-at-deploy";
    expect(await u.run(["--stage", "deploy"], { proxyReader: () => healthyProxyReader({ frozen: false }) })).toBe(EXIT_CODES.VERIFY);
    expect(lastError(u).message).toContain("want true");
  });

  test("a dry run reads the proxies back on its local chain: a bad one fails the preflight and nothing reaches the target", async () => {
    const ok = world({ startNonce: 0 });
    expect(await ok.run(["--stage", "deploy", "--dry-run"])).toBe(0);
    expect(ok.logs().filter((l) => l.event === "stage.proxy_ok" && l.local_only === true).map((l) => l.stage)).toEqual(PROXY_STAGES);
    const bad = world({ startNonce: 0 });
    expect(await bad.run(["--stage", "deploy", "--dry-run"], { proxyReader: () => healthyProxyReader({ beaconSlot: `0x${"0".repeat(63)}1` as Hex }) })).toBe(EXIT_CODES.VERIFY);
    expect(lastError(bad).message).toContain("beacon slot");
    expect(lastError(bad).message).toContain("Nothing reached the target");
  });
});

describe("issue 1809: the read-back judged property by property (src/proxies.ts)", () => {
  const P = addrN(0x1001), I = addrN(0x2001), T = addrN(0x1008);
  const word = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}` as Hex;
  const healthy = (): ProxyState => ({
    proxy: P, proxyCode: "0x6001" as Hex, implementation: I, implementationCode: "0x6002" as Hex, adminSlot: ZERO_WORD, beaconSlot: ZERO_WORD, authority: T, frozen: false,
    initialized: { version: 1n, initializing: false }, implementationInitialized: { version: INITIALIZERS_LOCKED, initializing: false },
  });
  const want: ProxyWant = { name: "rmUSDC", implementation: I, authority: T, mode: "upgradeable", frozenByRow: false };
  const m = { manifestMode: "upgradeable", manifestAuthority: T };

  test("a healthy proxy has no problem, and its record carries no raw 32-byte slot word", () => {
    expect(proxyProblems(proxyChecks(healthy(), want, m))).toEqual([]);
    const rec = proxyRecordOf("rmUSDC", healthy(), "upgradeable");
    expect(rec).toMatchObject({ name: "rmUSDC", proxy: P, implementation: I, authority: T, mode: "upgradeable", frozen: false, admin_slot_empty: true, beacon_slot_empty: true });
    expect(JSON.stringify(rec)).not.toMatch(/"(?!\w*hash")[a-z_]+":"0x[0-9a-f]{64}"/);
  });

  test("each fault is its own property", () => {
    const c = (s: Partial<ProxyState>, w: Partial<ProxyWant> = {}, mm: Partial<typeof m> = {}) => proxyChecks({ ...healthy(), ...s }, { ...want, ...w }, { ...m, ...mm });
    expect(c({ implementation: addrN(0x2bad) }).implementationSlot).toContain("reads 0x0000000000000000000000000000000000002bad");
    expect(c({ adminSlot: word(1n) }).adminSlot).toContain("admin slot");
    expect(c({ beaconSlot: word(1n) }).beaconSlot).toContain("beacon slot");
    expect(c({ initialized: { version: 0n, initializing: false } }).initialized).toContain("not initialized");
    expect(c({ initialized: { version: 1n, initializing: true } }).initialized).toContain("initializing");
    expect(c({ implementationInitialized: { version: 0n, initializing: false } }).initialized).toContain("anyone could initialize it");
    expect(c({ authority: addrN(0xbad) }).authority).toContain("want the authority stage's timelock");
    expect(c({ authority: null }).authority).toContain("no GovernedUpgrade");
    expect(c({}, { mode: undefined }).mode).toContain("the sheet states no UPGRADE_MODE");
    expect(c({}, {}, { manifestMode: "unset" }).mode).toContain("not a declared mode");
    expect(c({}, {}, { manifestMode: undefined }).mode).toContain("not a declared mode");
    expect(c({}, { mode: "frozen-at-deploy" }).mode).toContain("the sheet states frozen-at-deploy");
    expect(c({}, {}, { manifestAuthority: addrN(0xbad) }).mode).toContain("the authority stage deployed");
    expect(c({ frozen: true }).frozen).toContain("want false");
    expect(c({ frozen: true }, { frozenByRow: true }).frozen).toBeUndefined();
    expect(c({ frozen: false }, { mode: "frozen-at-deploy" }, { manifestMode: "frozen-at-deploy" }).frozen).toContain("want true");
    // messages never carry a raw 32-byte word (the evidence secret scan reads every log line, QA plan v1 E8)
    expect(proxyProblems(c({ adminSlot: `0x${"ab".repeat(32)}` as Hex, beaconSlot: `0x${"cd".repeat(32)}` as Hex })).join(" ")).not.toMatch(/0x[0-9a-fA-F]{64}/);
  });

  test("slot words decode as the contracts write them", () => {
    expect(wordAddress(word(BigInt(I)))).toBe(I);
    expect(initializableOf(word(INITIALIZERS_LOCKED))).toEqual({ version: INITIALIZERS_LOCKED, initializing: false });
    expect(initializableOf(word((1n << 64n) | 1n))).toEqual({ version: 1n, initializing: true });
    expect(expectFrozen({ mode: "frozen-at-deploy", frozenByRow: false })).toBe(true);
    expect(expectFrozen({ mode: "upgradeable", frozenByRow: true })).toBe(true);
    expect(expectFrozen({ mode: "upgradeable", frozenByRow: false })).toBe(false);
  });
});
