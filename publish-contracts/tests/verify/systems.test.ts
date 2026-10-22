// Issue 1892: the verifier reads each system on its own. The vaults system needs no gateway (SYS-1), the gateway system needs no Safe and no vaults verifier, and a table or
// manifest set from before the split (system "legacy", the deploy-2 shape) keeps every check, the gateway and agent ones included.
import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toHex } from "viem";
import { verifyDeployment } from "../../src/verify/index.ts";
import { GATEWAY_AGENT_LABELS, hashConsumedManifests } from "../../src/verify/gateway.ts";
import { ADMIN_ROLE, AGENT_ROLE, DEPOSIT_PAUSER_ROLE, SIG_AGENT_AUTHORIZED, SIG_AGENT_OWNERSHIP, SIG_ROLE_GRANTED, Z32, stageManifestFile } from "../../src/verify/constants.ts";
import { padTopic } from "../../src/verify/logs.ts";
import type { VerifyOptions } from "../../src/verify/types.ts";
import { OWNERS, DEPLOYER, GATEWAY, PAUSER, ROUTER, TIMELOCK, addr, buildWorld, failed, type World } from "./world.ts";

const VAULT_COUNTS = { safe: 1, libs: 4, recorder: 6, vault: 12, registry: 2, router: 2, governance: 2, receipt: 3, proto: 6, agent: 3, rwa: 6, timelock: 18 };
const GATEWAY_COUNTS = { gateway: 3, "gateway-handover": 4 };
const GW_ADMIN = addr(0x9a01);
const GW_TIMELOCK = addr(0x9a02);
const START = 40;

/** The combined world read as the vaults system: the gateway exists on chain but the run counts only the vaults stages. */
function vaultsOpts(w: World): VerifyOptions {
  const frozenCounts = { ...VAULT_COUNTS, ...GATEWAY_COUNTS };
  w.chain.noncesMap.set(DEPLOYER.toLowerCase(), Object.values(VAULT_COUNTS).reduce((a, b) => a + b, 0) + 1);
  return { ...w.opts, system: "vaults", frozenCounts };
}

/** The gateway system's world: the combined world's vaults manifests, a gateway bound to its own timelock and handed to its own admin, and the handover manifest. */
function gatewayWorld(): { w: World; opts: VerifyOptions } {
  const w = buildWorld();
  const { chain: ch } = w;
  ch.codes.set(GW_TIMELOCK.toLowerCase(), "0x6001");
  ch.set(GATEWAY, "upgradeTimelock", GW_TIMELOCK);
  // the handover: the gateway admin holds the admin roles, the vaults timelock and the deployer hold nothing the run gave them
  ch.revoke(GATEWAY, ADMIN_ROLE, TIMELOCK);
  ch.revoke(GATEWAY, Z32, TIMELOCK);
  ch.grant(GATEWAY, ADMIN_ROLE, GW_ADMIN);
  ch.grant(GATEWAY, Z32, GW_ADMIN);
  const gwFile = join(w.manifestDir, stageManifestFile(w.opts.table, "gateway"));
  const gw = JSON.parse(readFileSync(gwFile, "utf8"));
  writeFileSync(gwFile, JSON.stringify({ ...gw, upgrade_timelock: GW_TIMELOCK, upgrade_mode: "frozen" }));
  writeFileSync(join(w.manifestDir, "gateway-handover.json"), JSON.stringify({ chain_id: 8453, gateway: GATEWAY, gateway_admin: GW_ADMIN, deployer: DEPLOYER }));
  ch.noncesMap.set(DEPLOYER.toLowerCase(), START + 7);
  const opts: VerifyOptions = {
    ...w.opts, system: "gateway", frozenCounts: GATEWAY_COUNTS, deployerStartNonce: START, handoverBlock: 3000n, consumedVaultsManifests: hashConsumedManifests(w.manifestDir),
    sheet: { ...w.sheet, upgradeMode: "frozen", gateway: { admin: GW_ADMIN, upgradeTimelock: GW_TIMELOCK } },
  };
  return { w, opts };
}

const agentLog = (block: bigint) => ({ address: GATEWAY, topics: [keccak256(toHex(SIG_AGENT_AUTHORIZED)), padTopic(OWNERS[0]!), padTopic(OWNERS[1]!)], data: "0x" as const, blockNumber: block });

describe("the vaults system verifier needs no gateway (issue 1892, SYS-1)", () => {
  test("a vaults run passes with the gateway manifest gone and no code at the gateway", async () => {
    const w = buildWorld();
    rmSync(join(w.manifestDir, stageManifestFile(w.opts.table, "gateway")));
    w.chain.codes.delete(GATEWAY.toLowerCase());
    const r = await verifyDeployment(vaultsOpts(w));
    expect(failed(r)).toEqual([]);
    expect(r.checks.some((c) => /gateway/.test(c.label))).toBe(false);
    expect(r.checks.some((c) => c.label.startsWith("agents:"))).toBe(false);
  });
  test("an AgentAuthorized or AgentOwnershipTransferred log on a gateway the vaults run does not know changes nothing", async () => {
    const w = buildWorld();
    for (const sig of [SIG_AGENT_AUTHORIZED, SIG_AGENT_OWNERSHIP]) w.chain.logs.push({ address: GATEWAY, topics: [keccak256(toHex(sig)), padTopic(OWNERS[0]!), padTopic(OWNERS[1]!)], data: "0x", blockNumber: 300n });
    expect(failed(await verifyDeployment(vaultsOpts(w)))).toEqual([]);
  });
  test("the vaults nonce is the vaults sum, or the vaults sum plus the gateway system's counts when the frozen file holds them, and nothing in between", async () => {
    const w = buildWorld();
    const o = vaultsOpts(w);
    const sum = Object.values(VAULT_COUNTS).reduce((a, b) => a + b, 0) + 1;
    for (const [nonce, ok] of [[sum, true], [sum + 7, true], [sum + 3, false], [sum + 8, false]] as const) {
      w.chain.noncesMap.set(DEPLOYER.toLowerCase(), nonce);
      expect(failed(await verifyDeployment(o)), `nonce ${nonce}`).toEqual(ok ? [] : ["deployer: nonce equals sum of frozen counts"]);
    }
    // a frozen file with no gateway counts: the gateway system never ran, its transactions are strays
    w.chain.noncesMap.set(DEPLOYER.toLowerCase(), sum + 7);
    expect(failed(await verifyDeployment({ ...o, frozenCounts: VAULT_COUNTS }))).toEqual(["deployer: nonce equals sum of frozen counts"]);
  });
  test("a combined (legacy) reading keeps the gateway and agent labels and still fails an agent authorized before handover", async () => {
    const w = buildWorld();
    const ok = await verifyDeployment(w.opts);
    expect(ok.checks.some((c) => c.label === "agents: no agent authorized at handover")).toBe(true);
    expect(failed(ok)).toEqual([]);
    w.chain.logs.push(agentLog(300n));
    expect(failed(await verifyDeployment(w.opts))).toContain("agents: no agent authorized at handover");
  });
});

describe("the gateway system verifier (issue 1892)", () => {
  test("a handed over gateway bound to its own timelock passes, with no Safe and no vaults verifier labels", async () => {
    const { opts } = gatewayWorld();
    const r = await verifyDeployment(opts);
    expect(failed(r)).toEqual([]);
    for (const l of GATEWAY_AGENT_LABELS) expect(r.checks.some((c) => c.label === l)).toBe(true);
    expect(r.checks.some((c) => /safe|timelock: min delay|vault\[/.test(c.label))).toBe(false);
  });
  test("an AgentAuthorized log before the handover block fails, one after it does not (a depositor's own agent)", async () => {
    const { w, opts } = gatewayWorld();
    w.chain.logs.push(agentLog(3500n));
    expect(failed(await verifyDeployment(opts))).toEqual([]);
    w.chain.logs.push(agentLog(2000n));
    expect(failed(await verifyDeployment(opts))).toEqual([GATEWAY_AGENT_LABELS[0]]);
  });
  test("AgentOwnershipTransferred is not scanned: the event is historical-only", async () => {
    const { w, opts } = gatewayWorld();
    w.chain.logs.push({ address: GATEWAY, topics: [keccak256(toHex(SIG_AGENT_OWNERSHIP)), padTopic(OWNERS[0]!), padTopic(OWNERS[1]!)], data: "0x", blockNumber: 2000n });
    expect(failed(await verifyDeployment(opts))).toEqual([]);
  });
  test("an AGENT_ROLE grant before the handover fails even when the holder is gone", async () => {
    const { w, opts } = gatewayWorld();
    w.chain.logs.push({ address: GATEWAY, topics: [keccak256(toHex(SIG_ROLE_GRANTED)), AGENT_ROLE, padTopic(OWNERS[0]!), padTopic(DEPLOYER)], data: "0x", blockNumber: 2000n });
    expect(failed(await verifyDeployment(opts))).toEqual([GATEWAY_AGENT_LABELS[1]]);
  });
  test("the deployer keeping a gateway role fails the handover labels", async () => {
    const { w, opts } = gatewayWorld();
    w.chain.grant(GATEWAY, ADMIN_ROLE, DEPLOYER);
    expect(failed(await verifyDeployment(opts))).toContain("gateway: ADMIN_ROLE not held by deployer");
  });
  test("the wrong admin, the vaults timelock as the upgrade authority and a missing handover all fail", async () => {
    const a = gatewayWorld();
    a.w.chain.revoke(GATEWAY, ADMIN_ROLE, GW_ADMIN);
    expect(failed(await verifyDeployment(a.opts))).toContain("gateway: ADMIN_ROLE held by the gateway admin");
    const b = gatewayWorld();
    b.w.chain.set(GATEWAY, "upgradeTimelock", TIMELOCK);
    expect(failed(await verifyDeployment(b.opts))).toContain("gateway: upgradeTimelock() equals the sheet's GATEWAY_UPGRADE_TIMELOCK");
    const c = gatewayWorld();
    rmSync(join(c.w.manifestDir, "gateway-handover.json"));
    expect(failed(await verifyDeployment(c.opts))).toContain("manifest: gateway-handover.json present");
  });
  test("a zero upgrade timelock in the sheet and a gateway sheet with no governance inputs fail before any chain read", async () => {
    const a = gatewayWorld();
    const zero = "0x0000000000000000000000000000000000000000" as const;
    expect(failed(await verifyDeployment({ ...a.opts, sheet: { ...a.opts.sheet, gateway: { admin: GW_ADMIN, upgradeTimelock: zero } } }))).toContain("sheet: the gateway upgrade timelock is not the zero address");
    const noGw = { ...a.opts.sheet };
    delete (noGw as { gateway?: unknown }).gateway;
    expect(failed(await verifyDeployment({ ...a.opts, sheet: noGw }))).toEqual(["sheet: names the gateway admin and the gateway upgrade timelock"]);
  });
  test("a vaults manifest that changed since the gateway run began fails; a run that recorded no hash fails too", async () => {
    const a = gatewayWorld();
    writeFileSync(join(a.w.manifestDir, "router.json"), JSON.stringify({ chain_id: 8453, router: ROUTER, tampered: true }));
    expect(failed(await verifyDeployment(a.opts))).toEqual(["vaults system: the manifests this run consumed are unchanged since it began"]);
    const b = gatewayWorld();
    expect(failed(await verifyDeployment({ ...b.opts, consumedVaultsManifests: undefined }))).toEqual(["vaults system: the manifests this run consumed are unchanged since it began"]);
  });
  test("the deployer nonce is checked from the recorded start, and a stray transaction fails it", async () => {
    const a = gatewayWorld();
    a.w.chain.noncesMap.set(DEPLOYER.toLowerCase(), START + 8);
    expect(failed(await verifyDeployment(a.opts))).toEqual(["deployer: nonce equals start plus the sum of the gateway frozen counts"]);
    const b = gatewayWorld();
    expect(failed(await verifyDeployment({ ...b.opts, deployerStartNonce: undefined }))).toEqual(["deployer: nonce equals start plus the sum of the gateway frozen counts"]);
  });
  test("pauser and deposit pauser role separation is read", async () => {
    const { w, opts } = gatewayWorld();
    w.chain.revoke(GATEWAY, DEPOSIT_PAUSER_ROLE, PAUSER);
    expect(failed(await verifyDeployment(opts))).toEqual(["gateway: DEPOSIT_PAUSER_ROLE held by pauser"]);
  });
});
