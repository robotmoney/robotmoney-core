// Issue 1809 (ADR-0014): the stage 12 verifier and the evidence check on the governed proxies. The verify world (world.ts) is a proxied deployment: each of the nine
// contracts runs behind an ERC1967Proxy whose implementation slot names the implementation holding the contract's build. These tests plant one fault each and read the
// labels that must fail. Fixtures only: the real proxies are read on the Twin rehearsal and on 8453.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, pad, toHex } from "viem";
import { AUTHORITY_LABEL, PROXY_LABELS, verifyDeployment } from "../../src/verify/index.ts";
import { checkEvidence } from "../../src/evidence-check.ts";
import { ERC1967_ADMIN_SLOT, ERC1967_BEACON_SLOT, ERC1967_IMPLEMENTATION_SLOT, INITIALIZABLE_SLOT, INITIALIZERS_LOCKED } from "../../src/proxies.ts";
import { getStageTable } from "../../src/stages.ts";
import { stageManifestFile } from "../../src/verify/constants.ts";
import { tableProxies } from "../../src/stage-table.ts";
import { IMPLEMENTATIONS, PROXIES, TIMELOCK, addr, buildWorld, failed, type World } from "./world.ts";

const table = getStageTable();
const NAMES = tableProxies(table).map((p) => p.name);
const OTHER = addr(0x0bad);
const lc = (s: string): string => s.toLowerCase();
const labelsOf = (name: string): string[] => PROXY_LABELS.map((l) => `proxy[${name}]: ${l}`);
const editStage = (w: World, stage: string, f: (o: any) => void) => {
  const p = join(w.manifestDir, stageManifestFile(table, stage));
  const o = JSON.parse(readFileSync(p, "utf8")); f(o); writeFileSync(p, JSON.stringify(o));
};

describe("issue 1809: the verifier reads every governed proxy", () => {
  test("a healthy proxied deployment passes every label and the report records each proxy as the chain read it", async () => {
    const w = buildWorld(8453);
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([]);
    const labels = r.checks.map((c) => c.label);
    expect(labels).toContain(AUTHORITY_LABEL);
    for (const n of NAMES) for (const l of labelsOf(n)) expect(labels).toContain(l);
    expect(r.proxies!.map((p) => p.name)).toEqual(NAMES);
    for (const p of r.proxies!) {
      expect(lc(p.proxy)).toBe(lc(PROXIES[p.name]!));
      expect(lc(p.implementation)).toBe(lc(IMPLEMENTATIONS[p.name]!));
      expect(p).toMatchObject({ authority: TIMELOCK, mode: "upgradeable", frozen: false, admin_slot_empty: true, beacon_slot_empty: true });
      expect(p.implementation_code_hash).toBe(keccak256(w.chain.codes.get(lc(IMPLEMENTATIONS[p.name]!))!));
    }
    // the code-hash label of a proxied contract compares the code that runs there, the implementation behind the proxy
    expect(r.checks.find((c) => c.label === "gateway: runtime code equals build artifact (masked)")!.detail).toContain(`the implementation ${lc(IMPLEMENTATIONS.gateway!)} behind the proxy`);
  });

  test("a non-zero ERC-1967 admin or beacon slot fails exactly its label", async () => {
    for (const [slot, label] of [[ERC1967_ADMIN_SLOT, "ERC-1967 admin slot is empty"], [ERC1967_BEACON_SLOT, "ERC-1967 beacon slot is empty"]] as const) {
      const w = buildWorld(8453);
      w.chain.storage.set(`${lc(PROXIES.gateway!)}|${slot}`, pad(OTHER, { size: 32 }));
      const r = await verifyDeployment(w.opts);
      expect(failed(r)).toEqual([`proxy[gateway]: ${label}`]);
      expect(r.proxies!.find((p) => p.name === "gateway")).toMatchObject(slot === ERC1967_ADMIN_SLOT ? { admin_slot_empty: false } : { beacon_slot_empty: false });
      expect(r.checks.find((c) => c.label === `proxy[gateway]: ${label}`)!.detail).not.toMatch(/0x[0-9a-fA-F]{64}/);
    }
  });

  test("an undeclared mode fails: a stage manifest whose upgrade_mode is unset, and a sheet that states none", async () => {
    const w = buildWorld(8453);
    editStage(w, "gateway", (o) => { o.upgrade_mode = "unset"; });
    expect(failed(await verifyDeployment(w.opts))).toEqual(["proxy[gateway]: upgrade mode is declared and equals the sheet"]);
    const s = buildWorld(8453);
    s.sheet.upgradeMode = undefined;
    expect(failed(await verifyDeployment(s.opts)).sort()).toEqual(NAMES.map((n) => `proxy[${n}]: upgrade mode is declared and equals the sheet`).sort());
  });

  test("a sheet that says frozen-at-deploy fails every unfrozen proxy and every manifest that says upgradeable", async () => {
    const w = buildWorld(8453);
    w.sheet.upgradeMode = "frozen-at-deploy";
    const f = failed(await verifyDeployment(w.opts));
    for (const n of NAMES) {
      expect(f).toContain(`proxy[${n}]: upgradesFrozen matches the mode and the executed freezes`);
      expect(f).toContain(`proxy[${n}]: upgrade mode is declared and equals the sheet`);
    }
    expect(f).toHaveLength(NAMES.length * 2);
  });

  test("a frozen proxy passes only with an executed freeze row behind it (or a frozen-at-deploy mode)", async () => {
    const w = buildWorld(8453);
    w.chain.set(PROXIES.router!, "upgradesFrozen", true);
    expect(failed(await verifyDeployment(w.opts))).toEqual(["proxy[router]: upgradesFrozen matches the mode and the executed freezes"]);
    expect(failed(await verifyDeployment({ ...w.opts, freezes: ["router"] }))).toEqual([]);
    // a recorded freeze the chain does not show fails too
    expect(failed(await verifyDeployment({ ...buildWorld(8453).opts, freezes: ["registry"] }))).toEqual(["proxy[registry]: upgradesFrozen matches the mode and the executed freezes"]);
  });

  test("an implementation anyone could initialize, and an uninitialized proxy, fail the initialization label", async () => {
    const w = buildWorld(8453);
    w.chain.storage.set(`${lc(IMPLEMENTATIONS.rmPROTO!)}|${INITIALIZABLE_SLOT}`, toHex(0n, { size: 32 }));
    expect(failed(await verifyDeployment(w.opts))).toEqual(["proxy[rmPROTO]: initialized, and the implementation's initializers are locked"]);
    const u = buildWorld(8453);
    u.chain.storage.set(`${lc(PROXIES.rmPROTO!)}|${INITIALIZABLE_SLOT}`, toHex(0n, { size: 32 }));
    expect(failed(await verifyDeployment(u.opts))).toEqual(["proxy[rmPROTO]: initialized, and the implementation's initializers are locked"]);
  });

  test("another upgrade authority on a proxy fails its label; an authority stage that is not the handover's fails the authority label", async () => {
    const w = buildWorld(8453);
    w.chain.set(PROXIES.receipt!, "upgradeAuthority", OTHER);
    expect(failed(await verifyDeployment(w.opts))).toEqual(["proxy[receipt]: upgradeAuthority is the timelock"]);
    const a = buildWorld(8453);
    editStage(a, "authority", (o) => { o.timelock = OTHER; });
    expect(failed(await verifyDeployment(a.opts))).toContain(AUTHORITY_LABEL);
  });

  test("the code at the proxy address must be the ERC1967Proxy build", async () => {
    const w = buildWorld(8453);
    w.chain.codes.set(lc(PROXIES.rmUSDC!), "0x6000");
    expect(failed(await verifyDeployment(w.opts))).toEqual(["proxy[rmUSDC]: runtime code equals the ERC1967Proxy build (masked)"]);
  });

  test("a stage manifest that names no implementation fails every label of that proxy", async () => {
    const w = buildWorld(8453);
    editStage(w, "router", (o) => { delete o.router_implementation; });
    const r = await verifyDeployment(w.opts);
    expect(failed(r).sort()).toEqual(labelsOf("router").sort());
    expect(r.checks.find((c) => c.label === labelsOf("router")[1])!.detail).toContain("names no implementation address");
  });

  test("an executed upgrade-proxy round: the proxy is expected on the round's target and compared with the round's build", async () => {
    const w = buildWorld(8453);
    const NEW = addr(0xc6a7f);
    // the v2 build of the gateway: one byte after the immutable range differs from v1
    const v1 = JSON.parse(readFileSync(join(w.artifactsDir, "RobotMoneyGateway.sol", "RobotMoneyGateway.json"), "utf8"));
    const flip = (hex: string): string => `${hex.slice(0, 82)}${hex.slice(82, 84) === "ee" ? "dd" : "ee"}${hex.slice(84)}`;
    const v2Dir = join(w.dir, "out-v2");
    mkdirSync(join(v2Dir, "RobotMoneyGateway.sol"), { recursive: true });
    writeFileSync(join(v2Dir, "RobotMoneyGateway.sol", "RobotMoneyGateway.json"), JSON.stringify({ ...v1, deployedBytecode: { ...v1.deployedBytecode, object: flip(v1.deployedBytecode.object) } }));
    w.chain.codes.set(lc(NEW), flip(w.chain.codes.get(lc(IMPLEMENTATIONS.gateway!))!) as `0x${string}`);
    w.chain.storage.set(`${lc(NEW)}|${INITIALIZABLE_SLOT}`, toHex(INITIALIZERS_LOCKED, { size: 32 }));
    w.chain.storage.set(`${lc(PROXIES.gateway!)}|${ERC1967_IMPLEMENTATION_SLOT}`, pad(NEW, { size: 32 }));
    // without the round's record the slot names an implementation the manifest does not, and the code is not this checkout's build
    expect(failed(await verifyDeployment(w.opts)).sort()).toEqual(["gateway: runtime code equals build artifact (masked)", "proxy[gateway]: implementation slot equals the deployed or last upgraded implementation"].sort());
    const r = await verifyDeployment({ ...w.opts, upgrades: [{ proxy: "gateway", implementation: NEW, buildDir: v2Dir }] });
    expect(failed(r)).toEqual([]);
    expect(r.checks.find((c) => c.label === "gateway: runtime code equals build artifact (masked)")!.detail).toContain("installed by govern upgrade-proxy");
    expect(r.checks.find((c) => c.label === "proxy[gateway]: implementation slot equals the deployed or last upgraded implementation")!.detail).toContain("installed by govern upgrade-proxy");
    // the round's record names another target: the slot label fails
    expect(failed(await verifyDeployment({ ...w.opts, upgrades: [{ proxy: "gateway", implementation: OTHER, buildDir: v2Dir }] }))).toEqual(["proxy[gateway]: implementation slot equals the deployed or last upgraded implementation"]);
  });
});

describe("issue 1809: the evidence records the proxies", () => {
  const T = addr(0x71e10c);
  const proxyEntry = (n: string, over: object = {}) => ({ proxy: PROXIES[n], implementation: IMPLEMENTATIONS[n], implementation_code_hash: `0x${"ab".repeat(32)}`, authority: T, mode: "upgradeable", frozen: false, admin_slot_empty: true, beacon_slot_empty: true, ...over });
  const ev = (over: Record<string, unknown> = {}) => ({
    chain_id: 8453, timelock: { address: T, min_delay: 172800 }, upgrade_mode: "upgradeable",
    vaults: { rmUSDC: { address: PROXIES.rmUSDC }, rmPROTO: { address: PROXIES.rmPROTO }, rmAGENT: { address: PROXIES.rmAGENT }, rmRWA: { address: PROXIES.rmRWA } },
    proxies: Object.fromEntries(NAMES.map((n) => [n, proxyEntry(n)])), ...over,
  });
  const proxyProblems = (e: object, names: readonly string[] | undefined = NAMES) =>
    checkEvidence(e, undefined, undefined, { proxies: names }).filter((m) => /proxies|upgrade_mode|proxy_upgrades|proxy_freezes|upgrade-proxy|freeze-proxy|is not its proxy/.test(m));

  test("a complete record passes; a deployment before the proxies is not asked for one", () => {
    expect(proxyProblems(ev())).toEqual([]);
    expect(proxyProblems({ chain_id: 8453 }, [])).toEqual([]);
    expect(proxyProblems({ chain_id: 8453 }, undefined)).toEqual([]);
  });

  test("an undeclared mode, a missing record, a missing proxy, a non-empty admin slot, another authority, a vault that is not its proxy: each is a problem", () => {
    expect(proxyProblems(ev({ upgrade_mode: undefined })).join()).toContain("upgrade_mode is null");
    expect(proxyProblems(ev({ upgrade_mode: "unset" })).join()).toContain("an undeclared mode is refused");
    expect(proxyProblems(ev({ proxies: undefined })).join()).toContain("proxies is missing");
    const missing = ev(); delete (missing.proxies as Record<string, unknown>).router;
    expect(proxyProblems(missing)).toEqual(["proxies.router is missing"]);
    const admin = ev(); (admin.proxies as Record<string, any>).gateway = proxyEntry("gateway", { admin_slot_empty: false });
    expect(proxyProblems(admin).join()).toContain("proxies.gateway.admin_slot_empty is false");
    const auth = ev(); (auth.proxies as Record<string, any>).registry = proxyEntry("registry", { authority: OTHER });
    expect(proxyProblems(auth).join()).toContain("proxies.registry.authority");
    const same = ev(); (same.proxies as Record<string, any>).router = proxyEntry("router", { implementation: PROXIES.router });
    expect(proxyProblems(same).join()).toContain("proxies.router.implementation is the proxy itself");
    const vault = ev({ vaults: { rmUSDC: { address: OTHER }, rmPROTO: { address: PROXIES.rmPROTO }, rmAGENT: { address: PROXIES.rmAGENT }, rmRWA: { address: PROXIES.rmRWA } } });
    expect(proxyProblems(vault).join()).toContain("vaults.rmUSDC.address");
    const stray = ev(); (stray.proxies as Record<string, any>).timelock = proxyEntry("gateway");
    expect(proxyProblems(stray).join()).toContain("proxies.timelock is not a proxy of the stage table");
  });

  test("a frozen proxy needs frozen-at-deploy or a proxy_freezes entry; a frozen-at-deploy record must read frozen", () => {
    const frozen = ev(); (frozen.proxies as Record<string, any>).gateway = proxyEntry("gateway", { frozen: true });
    expect(proxyProblems(frozen).join()).toContain("no proxy_freezes entry froze it");
    const withRow = { ...frozen, proxy_freezes: [{ step: "freeze-proxy", proxies: [{ name: "gateway", proxy: PROXIES.gateway, implementation: IMPLEMENTATIONS.gateway, code_hash: `0x${"cd".repeat(32)}` }], timelock: T, operation_id: `0x${"01".repeat(32)}`, schedule_tx: `0x${"02".repeat(32)}`, schedule_status: 1, schedule_block_timestamp: 1000, execute_tx: `0x${"03".repeat(32)}`, execute_status: 1, execute_block_timestamp: 1000 + 172800 }] };
    expect(proxyProblems(withRow)).toEqual([]);
    const atDeploy = ev({ upgrade_mode: "frozen-at-deploy", proxies: Object.fromEntries(NAMES.map((n) => [n, proxyEntry(n, { mode: "frozen-at-deploy", frozen: true })])) });
    expect(proxyProblems(atDeploy)).toEqual([]);
    const unfrozen = ev({ upgrade_mode: "frozen-at-deploy", proxies: Object.fromEntries(NAMES.map((n) => [n, proxyEntry(n, { mode: "frozen-at-deploy", frozen: n !== "rmRWA" })])) });
    expect(proxyProblems(unfrozen)).toEqual(["proxies.rmRWA.frozen is false although the mode is frozen-at-deploy"]);
  });

  test("an upgrade-proxy entry is one operation one delay apart with both implementations; a bad one is named", () => {
    const op = { operation_id: `0x${"11".repeat(32)}`, schedule_tx: `0x${"12".repeat(32)}`, schedule_status: 1, schedule_block_timestamp: 2000, execute_tx: `0x${"13".repeat(32)}`, execute_status: 1, execute_block_timestamp: 2000 + 172800 };
    const up = { step: "upgrade-proxy", proxy: "gateway", proxy_address: PROXIES.gateway, from_implementation: IMPLEMENTATIONS.gateway, implementation: addr(0xc6a7f), implementation_code_hash: `0x${"ef".repeat(32)}`, timelock: T, round: 1, ...op };
    expect(proxyProblems(ev({ proxy_upgrades: [up] }))).toEqual([]);
    expect(proxyProblems(ev({ proxy_upgrades: [{ ...up, implementation: IMPLEMENTATIONS.gateway }] })).join()).toContain("nothing was upgraded");
    expect(proxyProblems(ev({ proxy_upgrades: [{ ...up, execute_block_timestamp: 2000 + 3600 }] })).join()).toContain("schedule-to-execute gap 3600 s is under 172800 s");
    expect(proxyProblems(ev({ proxy_upgrades: [{ ...up, timelock: OTHER }] })).join()).toContain("is not the timelock");
    expect(proxyProblems(ev({ proxy_upgrades: [{ ...up, step: "upgrade" }] })).join()).toContain("is not upgrade-proxy");
    expect(proxyProblems(ev({ proxy_upgrades: "x" })).join()).toContain("proxy_upgrades is not a list");
  });
});
