// Issue 1809 (upgradeability stage 2): the verifier proves each proxied core contract is the build's ERC1967Proxy, names the manifest's implementation, links the build's
// libraries, is governed by the deployed timelock alone, is initialized, is in the sheet's release mode and has a layout identifier, and it refuses the immutability claim
// unless the full core set verifies frozen on chain. Fixtures only (an in-memory chain): the real-chain proof is the Twin chain rehearsal (suite 28) and the mainnet run.
import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256, pad, toHex, type Hex } from "viem";
import { getStageTable } from "../../src/stages.ts";
import { verifyDeployment } from "../../src/verify/index.ts";
import { stageManifestFile } from "../../src/verify/constants.ts";
import { CLAIM_LABEL, DEADLINE_LABEL, ERC1967_ADMIN_SLOT, GOVERNED_PARAMETERS, MODE_LABEL, PROXY_LABELS, UPSTREAM_DEPENDENCIES, layoutId, proxySpecs } from "../../src/verify/upgradeability.ts";
import { buildWorld, failed, addr, GATEWAY, GOVERNED_UPGRADE_LIB, GOV, IMPLS, IMPL_SLOT, INIT_SLOT, REGISTRY, ROUTER, TIMELOCK, VAULTS, type World } from "./world.ts";

const table = getStageTable();
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
  for (const a of [...Object.values(ADDR), addr(0x1c9), addr(0x4ec)]) w.chain.set(a, "upgradesFrozen", false);
  return w;
}

describe("the full proxied core set (issue 1809)", () => {
  test("the stage table names the ten proxied core contracts, and a healthy frozen deployment passes every label and claims core immutability", async () => {
    expect(ALL).toEqual(["vault[rmUSDC]", "registry", "router", "gateway", "icpolicy", "receipt", "governance", "vault[rmPROTO]", "vault[rmAGENT]", "vault[rmRWA]"]);
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
    w.chain.set(ROUTER, "upgradesFrozen", true);
    const one = await verifyDeployment(w.opts);
    expect(failed(one)).toEqual([]);
    expect(one.upgradeability!.core_immutable).toBe(false);
    for (const a of [...Object.values(ADDR), addr(0x1c9), addr(0x4ec)]) w.chain.set(a, "upgradesFrozen", true);
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
    for (const a of [...Object.values(ADDR), addr(0x1c9), addr(0x4ec)]) done.chain.set(a, "upgradesFrozen", true);
    expect(failed(await verifyDeployment(done.opts))).toEqual([]);
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
      expect(c[n]?.toLowerCase(), n).toBe((ADDR[n] ?? (n === "icpolicy" ? addr(0x1c9) : addr(0x4ec))).toLowerCase());
      expect(c[`${n} implementation`]?.toLowerCase(), n).toBe(IMPLS[n]!.toLowerCase());
    }
    // the timelock, the recorder and the library have no implementation entry: they are direct deployments
    for (const n of ["timelock", "recorder", "library[tick_math]"]) { expect(c[n]).toBeTruthy(); expect(c[`${n} implementation`]).toBeUndefined(); }
  });
});
