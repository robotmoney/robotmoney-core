// Issue 1809 (upgradeability stage 2): the verifier proves each proxied core contract is the build's ERC1967Proxy, names the manifest's implementation, links the build's
// libraries, is governed by the deployed timelock alone, is initialized, is in the sheet's release mode and has a layout identifier, and it refuses the immutability claim
// unless the full core set verifies frozen on chain. Fixtures only (an in-memory chain): the real-chain proof is the Twin chain rehearsal (suite 28) and the mainnet run.
import { scopeTable } from "../../src/stage-table.ts";
import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, encodeFunctionData, keccak256, pad, parseAbi, toHex, type Hex } from "viem";
import { getStageTable } from "../../src/stages.ts";
import { verifyDeployment } from "../../src/verify/index.ts";
import { stageManifestFile } from "../../src/verify/constants.ts";
import { padTopic } from "../../src/verify/logs.ts";
import { CLAIM_LABEL, CODE_LABEL, DEADLINE_LABEL, ERC1967_ADMIN_SLOT, GOVERNED_PARAMETERS, MODE_LABEL, PROXY_LABELS, UPSTREAM_DEPENDENCIES, layoutId, proxySpecs } from "../../src/verify/upgradeability.ts";
import { buildWorld, failed, addr, GATEWAY, GOVERNED_UPGRADE_LIB, GOV, IMPLS, IMPL_SLOT, INIT_SLOT, REGISTRY, ROUTER, TIMELOCK, VAULTS, type World } from "./world.ts";

const table = scopeTable(getStageTable(), "legacy"); // issue 1892: these tests read the combined deployment
const L = (name: string, i: number) => `${name}: ${PROXY_LABELS[i]}`;
const ALL = proxySpecs(table).map((s) => s.name);
const ADDR: Record<string, `0x${string}`> = { gateway: GATEWAY, registry: REGISTRY, router: ROUTER, governance: GOV, ...Object.fromEntries(Object.entries(VAULTS).map(([k, v]) => [`vault[${k}]`, v.address])) };

/** Rewrite every proxy manifest's upgrade_mode (the deploy wrote the sheet's mode). */
function manifestMode(w: World, mode: string): void {
  for (const s of table.stages.filter((x) => x.proxies)) {
    const p = join(w.manifestDir, stageManifestFile(table, s.name));
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), upgrade_mode: mode }));
  }
}
/** An upgradeable release: the sheet, the manifests and the chain all say upgradeable (nothing frozen). */
function upgradeable(chainId = 8453, deadline?: string): World {
  const w = buildWorld(chainId);
  w.sheet.upgradeMode = "upgradeable";
  if (deadline) w.sheet.freezeDeadline = deadline;
  manifestMode(w, "upgradeable");
  for (const a of [...Object.values(ADDR), addr(0x4ec)]) w.chain.set(a, "upgradesFrozen", false);
  return w;
}

const GOVERNED = parseAbi(["function freezeUpgrades(address expectedImplementation, bytes32 expectedCodeHash)", "function upgradeToAndCall(address newImplementation, bytes data)"]);
const T_FROZEN = keccak256(toHex("UpgradesFrozen(address,address,bytes32)"));
const T_EXECUTED = keccak256(toHex("CallExecuted(bytes32,uint256,address,uint256,bytes)"));
const T_SCHEDULED = keccak256(toHex("CallScheduled(bytes32,uint256,address,uint256,bytes,bytes32,uint256)"));
const txOf = (n: number) => pad(toHex(n), { size: 32 }) as Hex;
/** The logs of a freeze: the proxy's UpgradesFrozen and, when `byTimelock`, the timelock's CallExecuted of freezeUpgrades on it, in the same transaction. */
function freezeLogs(w: World, proxy: `0x${string}`, block: bigint, tx: Hex, byTimelock = true): void {
  w.chain.set(proxy, "upgradesFrozen", true);
  w.chain.logs.push({ address: proxy, topics: [T_FROZEN, padTopic(proxy), padTopic(addr(0x1111))], data: pad("0x01", { size: 32 }), blockNumber: block, transactionHash: tx });
  const call = encodeFunctionData({ abi: GOVERNED, functionName: "freezeUpgrades", args: [addr(0x1111), pad("0x01", { size: 32 })] });
  if (byTimelock) w.chain.logs.push({ address: TIMELOCK, topics: [T_EXECUTED, txOf(0xf0), pad("0x00", { size: 32 })], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], [proxy, 0n, call]), blockNumber: block, transactionHash: tx });
}
/** A freeze (or another call) scheduled on the timelock: CallScheduled, and isOperationPending reads `pending`. */
function scheduleLog(w: World, target: `0x${string}`, id: Hex, pending = true, data: Hex = encodeFunctionData({ abi: GOVERNED, functionName: "freezeUpgrades", args: [addr(0x1111), pad("0x01", { size: 32 })] })): void {
  w.chain.logs.push({ address: TIMELOCK, topics: [T_SCHEDULED, id, pad("0x00", { size: 32 })], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }, { type: "uint256" }], [target, 0n, data, pad("0x00", { size: 32 }), 172800n]), blockNumber: 4000n, transactionHash: txOf(0x5c) });
  const prev = w.chain.handlers.get(`${TIMELOCK.toLowerCase()}:isOperationPending`);
  w.chain.set(TIMELOCK, "isOperationPending", (args: unknown[]) => (String(args[0]).toLowerCase() === id.toLowerCase() ? pending : prev ? prev(args) : false));
}
const ALL_ADDRS = () => [...Object.values(ADDR), addr(0x4ec)];

describe("the full proxied core set (issue 1809)", () => {
  test("the stage table names the eight proxied core contracts, and a healthy frozen deployment passes every label and claims core immutability", async () => {
    expect(ALL).toEqual(["vault[rmUSDC]", "registry", "router", "gateway", "receipt", "governance", "vault[rmPROTO]", "vault[rmRWA]"]);
    const w = buildWorld();
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([]);
    for (const n of ALL) for (let i = 0; i < PROXY_LABELS.length; i++) expect(r.checks.find((c) => c.label === L(n, i))?.ok, L(n, i)).toBe(true);
    for (const l of [MODE_LABEL, DEADLINE_LABEL, CLAIM_LABEL]) expect(r.checks.find((c) => c.label === l)?.ok, l).toBe(true);
    const u = r.upgradeability!;
    expect(u.mode).toBe("frozen");
    expect(u.core_immutable).toBe(true);
    expect(u.immutability_refused_because).toEqual([]);
    expect(Object.keys(u.proxies)).toEqual(ALL);
    expect(u.timelock).toEqual({ address: TIMELOCK, min_delay: "172800" });
    expect(u.transactions_per_proxy).toBe(2);
    const g = u.proxies.gateway!;
    expect(g).toMatchObject({ stage: "gateway", contract: "RobotMoneyGateway", proxy: GATEWAY, implementation: IMPLS.gateway!.toLowerCase(), upgrade_timelock: TIMELOCK, upgrades_frozen: true, initialized_version: "1", manifest_upgrade_mode: "frozen" });
    expect(g.implementation_code_hash).toBe(keccak256(w.chain.codes.get(IMPLS.gateway!.toLowerCase())!));
    expect(g.proxy_code_hash).toBe(keccak256(w.chain.codes.get(GATEWAY.toLowerCase())!));
    expect(g.layout_id).toBe(layoutId(w.opts.coreDir!, "contracts/test/fixtures/storage-layout/RobotMoneyGateway.json", table.upgradeAuthority!.layoutPins));
    // the record lists what a freeze does not make immutable
    expect(u.remaining_governed_parameters).toEqual([...GOVERNED_PARAMETERS]);
    expect(u.upstream_dependencies).toEqual([...UPSTREAM_DEPENDENCIES]);
    expect(u.remaining_governed_parameters.length).toBeGreaterThan(0);
    expect(u.upstream_dependencies.some((d) => d.includes("USDC"))).toBe(true);
  });
});

describe("the verifier fails on a wrong implementation, a wrong hash or an unfrozen final-mainnet proxy (issue 1809 test plan)", () => {
  test("a wrong implementation (another address in the ERC-1967 slot, even one running the reviewed build) fails the slot label and refuses the claim", async () => {
    const w = buildWorld();
    const other = addr(0xbad1);
    w.chain.codes.set(other, w.chain.codes.get(IMPLS.router!.toLowerCase())!);
    w.chain.storage.set(`${ROUTER.toLowerCase()}|${IMPL_SLOT}`, pad(other, { size: 32 }));
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([L("router", 1), CLAIM_LABEL]);
    expect(r.checks.find((c) => c.label === L("router", 1))!.detail).toContain("manifest router_implementation");
    expect(r.upgradeability!.core_immutable).toBe(false);
  });

  test("a wrong hash: the implementation runs other code than the build and the gateway manifest pin", async () => {
    const w = buildWorld();
    const key = IMPLS.gateway!.toLowerCase();
    w.chain.codes.set(key, (w.chain.codes.get(key)!.slice(0, -2) + "ff") as Hex);
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual(["gateway: runtime code equals build artifact (masked)", L("gateway", 1), CLAIM_LABEL]);
    expect(r.checks.find((c) => c.label === L("gateway", 1))!.detail).toContain("gateway_implementation_runtime_hash");
    expect(r.checks.find((c) => c.label === CLAIM_LABEL)!.detail).toContain("the chain refuses it");
  });

  test("an unfrozen proxy on a final-mainnet (8453 production) frozen release fails its freeze label and the claim", async () => {
    const w = buildWorld(8453);
    w.chain.set(REGISTRY, "upgradesFrozen", false);
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([L("registry", 5), CLAIM_LABEL]);
    expect(r.upgradeability!.core_immutable).toBe(false);
    expect(r.upgradeability!.immutability_refused_because.join(" ")).toContain("not frozen on chain: registry");
  });
});

describe("each proxy label fails on its own defect", () => {
  test("a direct deployment (the build's code at the address, no proxy) fails the proxy label", async () => {
    const w = buildWorld();
    w.chain.codes.set(ROUTER.toLowerCase(), w.chain.codes.get(IMPLS.router!.toLowerCase())!);
    expect(failed(await verifyDeployment(w.opts))).toContain(L("router", 0));
  });
  test("a set ERC-1967 admin slot fails the proxy label", async () => {
    const w = buildWorld();
    w.chain.storage.set(`${GATEWAY.toLowerCase()}|${ERC1967_ADMIN_SLOT}`, pad(addr(0xad), { size: 32 }));
    expect(failed(await verifyDeployment(w.opts))).toEqual([L("gateway", 0), CLAIM_LABEL]);
  });
  test("a linked library that is not the build's fails the link label (the code comparison masks the link)", async () => {
    const w = buildWorld();
    w.chain.codes.set(GOVERNED_UPGRADE_LIB.toLowerCase(), "0x6000");
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([...ALL.map((n) => L(n, 2)), CLAIM_LABEL]);
  });
  test("another upgrade authority than the deployed timelock fails, on chain or in the manifest", async () => {
    const w = buildWorld();
    w.chain.set(GOV, "upgradeTimelock", addr(0xeee));
    expect(failed(await verifyDeployment(w.opts))).toEqual([L("governance", 3), CLAIM_LABEL]);
    const m = buildWorld();
    const p = join(m.manifestDir, stageManifestFile(table, "registry"));
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), upgrade_timelock: addr(0xeee) }));
    expect(failed(await verifyDeployment(m.opts))).toEqual([L("registry", 3), CLAIM_LABEL]);
  });
  test("an uninitialized proxy, or one caught initializing, fails the initialization label", async () => {
    for (const word of [pad("0x00", { size: 32 }), pad("0x010000000000000001", { size: 32 })]) {
      const w = buildWorld();
      w.chain.storage.set(`${VAULTS.rmUSDC.address.toLowerCase()}|${INIT_SLOT}`, word);
      expect(failed(await verifyDeployment(w.opts))).toEqual([L("vault[rmUSDC]", 4), CLAIM_LABEL]);
    }
  });
  test("a manifest written in another mode than the sheet fails the manifest mode label", async () => {
    const w = buildWorld();
    const p = join(w.manifestDir, stageManifestFile(table, "gateway"));
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, "utf8")), upgrade_mode: "upgradeable" }));
    expect(failed(await verifyDeployment(w.opts))).toEqual([L("gateway", 6), CLAIM_LABEL]);
  });
  test("without the core checkout's layout snapshot the layout label fails", async () => {
    const w = buildWorld();
    rmSync(join(w.opts.coreDir!, "contracts/test/fixtures/storage-layout/RouterGovernance.json"));
    expect(failed(await verifyDeployment(w.opts))).toEqual([L("governance", 7), CLAIM_LABEL]);
    const n = buildWorld();
    delete n.opts.coreDir;
    expect(failed(await verifyDeployment(n.opts))).toEqual([...ALL.map((x) => L(x, 7)), CLAIM_LABEL]);
  });
  test("a sheet with no release mode fails the mode label and every freeze and manifest-mode label", async () => {
    const w = buildWorld();
    delete w.sheet.upgradeMode;
    const f = failed(await verifyDeployment(w.opts));
    expect(f).toContain(MODE_LABEL);
    for (const n of ALL) { expect(f).toContain(L(n, 5)); expect(f).toContain(L(n, 6)); }
  });
});

describe("an upgradeable release makes no immutability claim (issue 1809)", () => {
  test("every label passes, the claim label passes with no claim, and the record says why it is not immutable", async () => {
    const r = await verifyDeployment(upgradeable(918453).opts);
    expect(failed(r)).toEqual([]);
    expect(r.checks.find((c) => c.label === CLAIM_LABEL)!.detail).toContain("no claim");
    expect(r.upgradeability!.core_immutable).toBe(false);
    expect(r.upgradeability!.immutability_refused_because[0]).toContain("proving period open");
  });
  test("a frozen proxy inside an upgradeable release (a governed freeze) passes; once governance froze them all, the claim is made in the same mode", async () => {
    const w = upgradeable(918453);
    freezeLogs(w, ROUTER, 4100n, txOf(1));
    const one = await verifyDeployment(w.opts);
    expect(failed(one)).toEqual([]);
    expect(one.upgradeability!.core_immutable).toBe(false);
    ALL_ADDRS().forEach((a, i) => { if (a !== ROUTER) freezeLogs(w, a, 4200n, txOf(2 + i)); });
    const all = await verifyDeployment(w.opts);
    expect(failed(all)).toEqual([]);
    expect(all.upgradeability!.core_immutable).toBe(true);
    expect(all.checks.find((c) => c.label === CLAIM_LABEL)!.detail).toContain("frozen by governance");
  });
  test("an upgradeable production release on 8453 with no freeze deadline fails the deadline label", async () => {
    const r = await verifyDeployment(upgradeable(8453).opts);
    expect(failed(r)).toEqual([DEADLINE_LABEL]);
  });
  test("the freeze deadline: ahead passes; missed with any proxy still upgradeable fails and names it; missed with every proxy frozen passes", async () => {
    const due = "2027-01-31T00:00:00Z";
    const at = BigInt(Date.parse(due) / 1000);
    const ahead = upgradeable(8453, due);
    ahead.opts.now = at - 1n;
    expect(failed(await verifyDeployment(ahead.opts))).toEqual([]);
    const missed = upgradeable(8453, due);
    missed.opts.now = at + 1n;
    const r = await verifyDeployment(missed.opts);
    expect(failed(r)).toEqual([DEADLINE_LABEL]);
    expect(r.checks.find((c) => c.label === DEADLINE_LABEL)!.detail).toMatch(/^MISSED: .*router/);
    const done = upgradeable(8453, due);
    done.opts.now = at + 1n;
    ALL_ADDRS().forEach((a, i) => freezeLogs(done, a, 4200n, txOf(1 + i)));
    expect(failed(await verifyDeployment(done.opts))).toEqual([]);
  });
});

// Issue 1842: the deadline label alerts before the deadline (WARN from deadline - (delay + 7 days), ESCALATE from deadline - (delay + 1 day)) while a proxy is unfrozen and
// no freeze is scheduled for it. Both pass; MISSED after the deadline fails (exit 13). The 8453 production delay is 172800 s.
describe("the freeze deadline alerts before the deadline (issue 1842)", () => {
  const due = "2027-01-31T00:00:00Z";
  const at = BigInt(Date.parse(due) / 1000);
  const DELAY = 172800n, DAY = 86400n;
  const detail = async (w: World) => {
    const r = await verifyDeployment(w.opts);
    return { failed: failed(r), detail: r.checks.find((c) => c.label === DEADLINE_LABEL)!.detail, ok: r.checks.find((c) => c.label === DEADLINE_LABEL)!.ok };
  };
  const world = (now: bigint) => { const w = upgradeable(8453, due); w.opts.now = now; return w; };
  test("before deadline - (delay + 7 days) the label passes quietly", async () => {
    const d = await detail(world(at - DELAY - 7n * DAY - 1n));
    expect(d.failed).toEqual([]);
    expect(d.detail).toMatch(/^deadline 2027-01-31T00:00:00Z, 8 of 8 proxies still upgradeable$/);
  });
  test("WARN at deadline - (delay + 7 days): passes, names every unfrozen proxy and the govern row", async () => {
    const w = world(at - DELAY - 7n * DAY);
    freezeLogs(w, ROUTER, 4100n, txOf(1));
    const d = await detail(w);
    expect(d.failed).toEqual([]);
    expect(d.ok).toBe(true);
    expect(d.detail).toMatch(/^WARN: /);
    expect(d.detail).toContain("govern --row freeze-upgrades");
    for (const n of ALL.filter((x) => x !== "router")) expect(d.detail).toContain(n);
    expect(d.detail).not.toContain("router,");
  });
  test("ESCALATE at deadline - (delay + 1 day): passes and names the unfrozen proxies", async () => {
    const d = await detail(world(at - DELAY - DAY));
    expect(d.failed).toEqual([]);
    expect(d.detail).toMatch(/^ESCALATE: .*vault\[rmUSDC\].*router.*gateway/);
  });
  test("MISSED after the deadline: fails (exit 13) and names the unfrozen proxies", async () => {
    const d = await detail(world(at + 1n));
    expect(d.failed).toEqual([DEADLINE_LABEL]);
    expect(d.detail).toMatch(/^MISSED: .*vault\[rmUSDC\].*router.*gateway/);
    const { EXIT_CODES } = await import("../../src/errors.ts");
    expect(EXIT_CODES.VERIFY).toBe(13);
  });
  test("a freeze scheduled (pending) on the timelock for every unfrozen proxy silences the alert; a cancelled or executed one, or another call, does not", async () => {
    const w = world(at - DELAY - DAY);
    ALL_ADDRS().forEach((a, i) => scheduleLog(w, a, txOf(0x100 + i)));
    expect((await detail(w)).detail).toMatch(/a freeze is scheduled on the timelock for each of them$/);
    const notPending = world(at - DELAY - DAY);
    ALL_ADDRS().forEach((a, i) => scheduleLog(notPending, a, txOf(0x100 + i), a !== GATEWAY));
    expect((await detail(notPending)).detail).toMatch(/^ESCALATE: .* is near and gateway still read/);
    const upgrade = world(at - DELAY - DAY);
    ALL_ADDRS().forEach((a, i) => scheduleLog(upgrade, a, txOf(0x100 + i), true, a === REGISTRY ? encodeFunctionData({ abi: GOVERNED, functionName: "upgradeToAndCall", args: [addr(0x99), "0x"] }) : undefined));
    expect((await detail(upgrade)).detail).toMatch(/^ESCALATE: .* is near and registry still read/);
  });
});

// Issue 1842: in an upgradeable release a proxy that reads frozen must have been frozen by a timelock-executed freezeUpgrades, never in its initializer; the record keeps
// the freeze block and transaction.
describe("an upgradeable release's frozen proxy was frozen by the timelock (issue 1842)", () => {
  test("a proxy frozen in its initializer (no UpgradesFrozen log after the scan start) fails its freeze label", async () => {
    const w = upgradeable(918453);
    w.chain.set(REGISTRY, "upgradesFrozen", true);
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([L("registry", 5)]);
    expect(r.checks.find((c) => c.label === L("registry", 5))!.detail).toContain("frozen in its initializer");
  });
  test("a proxy whose UpgradesFrozen log is in a transaction without the timelock's CallExecuted (the deploy transaction) fails", async () => {
    const w = upgradeable(918453);
    freezeLogs(w, REGISTRY, 120n, txOf(7), false);
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([L("registry", 5)]);
    expect(r.checks.find((c) => c.label === L("registry", 5))!.detail).toContain("not from a freezeUpgrades the timelock");
    expect(r.upgradeability!.proxies.registry!.freeze_tx).toBeNull();
  });
  test("a proxy frozen by a timelock-executed freezeUpgrades after deployment passes, with freeze_block and freeze_tx recorded", async () => {
    const w = upgradeable(918453);
    freezeLogs(w, REGISTRY, 4321n, txOf(9));
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([]);
    expect(r.upgradeability!.proxies.registry).toMatchObject({ upgrades_frozen: true, freeze_block: "4321", freeze_tx: txOf(9) });
    expect(r.upgradeability!.proxies.router).toMatchObject({ upgrades_frozen: false, freeze_block: null, freeze_tx: null });
  });
});

// Issue 1842: the gateway's runtime hash pins are fail-closed. A missing implementation pin fails, and the proxy pin must equal the live proxy code hash.
describe("the gateway pins are fail-closed (issue 1842)", () => {
  const gatewayManifest = (w: World, edit: (m: any) => void) => {
    const p = join(w.manifestDir, stageManifestFile(table, "gateway"));
    const m = JSON.parse(readFileSync(p, "utf8"));
    edit(m);
    writeFileSync(p, JSON.stringify(m));
  };
  test("no gateway_implementation_runtime_hash fails the implementation slot label", async () => {
    const w = buildWorld();
    gatewayManifest(w, (m) => delete m.gateway_implementation_runtime_hash);
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([L("gateway", 1), CLAIM_LABEL]);
    expect(r.checks.find((c) => c.label === L("gateway", 1))!.detail).toContain("the manifest has no gateway_implementation_runtime_hash");
  });
  test("a gateway_runtime_hash that differs from the live proxy code hash, or none, fails the proxy label", async () => {
    const w = buildWorld();
    gatewayManifest(w, (m) => { m.gateway_runtime_hash = keccak256("0x01"); });
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual([L("gateway", 0), CLAIM_LABEL]);
    expect(r.checks.find((c) => c.label === L("gateway", 0))!.detail).toContain("manifest gateway_runtime_hash");
    const n = buildWorld();
    gatewayManifest(n, (m) => delete m.gateway_runtime_hash);
    expect(failed(await verifyDeployment(n.opts))).toEqual([L("gateway", 0), CLAIM_LABEL]);
  });
  test("another proxy without a runtime hash pin is not affected (only the gateway is pinned)", async () => {
    expect(failed(await verifyDeployment(buildWorld().opts))).toEqual([]);
    void CODE_LABEL;
  });
});

describe("the record never says immutable for a deployment that failed anything", () => {
  test("a failing non-proxy check leaves the claim label passing (the proxies verify) but core_immutable false", async () => {
    const w = buildWorld();
    w.chain.set(GATEWAY, "depositsPaused", true);
    const r = await verifyDeployment(w.opts);
    expect(failed(r)).toEqual(["gateway: not paused"]);
    expect(r.upgradeability!.core_immutable).toBe(false);
    expect(r.upgradeability!.immutability_refused_because).toEqual(["other failed checks: gateway: not paused"]);
  });
  test("the label set is the same on the Twin chain and 8453, frozen or upgradeable", async () => {
    const labels = async (w: World) => (await verifyDeployment(w.opts)).checks.map((c) => c.label);
    const main = await labels(buildWorld(8453));
    expect(await labels(buildWorld(918453))).toEqual(main);
    expect(await labels(upgradeable(918453))).toEqual(main);
    void toHex;
  });
});

describe("source verification covers both halves of every proxy (issue 1809)", () => {
  test("contractsFromManifests lists each proxied core contract's proxy and its implementation", async () => {
    const { contractsFromManifests } = await import("../../src/verify/sources.ts");
    const w = buildWorld();
    const c = contractsFromManifests(w.manifestDir, table);
    for (const n of ALL) {
      expect(c[n]?.toLowerCase(), n).toBe((ADDR[n] ?? addr(0x4ec)).toLowerCase());
      expect(c[`${n} implementation`]?.toLowerCase(), n).toBe(IMPLS[n]!.toLowerCase());
    }
    // the timelock and the library have no implementation entry: they are direct deployments
    for (const n of ["timelock", "library[tick_math]"]) { expect(c[n]).toBeTruthy(); expect(c[`${n} implementation`]).toBeUndefined(); }
  });
});
