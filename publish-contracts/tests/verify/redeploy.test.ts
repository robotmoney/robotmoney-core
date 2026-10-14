// Issue 1796: the verifier after a single-vault redeploy. Both generations of rmPROTO are checked: the old vault is registered, Retired, ineligible and serves redeemInKind;
// the new vault passes every label a launch vault passes (roles, config, libraries, registry binding) and holds the old vault's router slot, weight and per-address cap.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { toFunctionSelector, type Hex } from "viem";
import { getStageTable } from "../../src/stages.ts";
import { verifyDeployment } from "../../src/verify/index.ts";
import { ADMIN_ROLE, EMERGENCY_ROLE } from "../../src/verify/constants.ts";
import { buildWorld, failed, addr, DEPLOYER, EMERGENCY, REGISTRY, ROUTER, TIMELOCK, VAULTS, type World } from "./world.ts";

const NEW = addr(0xb0012);
const OLD = VAULTS.rmPROTO.address;
const REPLACEMENT = "protocol-asset-vault.replacement-1.json";
const SEL = toFunctionSelector("function redeemInKind(uint256 shares, address receiver, address owner)").slice(2);

/** A deployment after a finished redeploy: five registered vaults, the old rmPROTO Retired, the new one Active, open and holding the old slot. */
function redeployed(over: { status?: number; oldEligible?: boolean; oldRetiredFlag?: boolean; newStatus?: number; effective?: [string[], bigint[]]; voted?: boolean; cap?: bigint } = {}): World {
  const w = buildWorld();
  const table = getStageTable();
  const protoArtifact = table.vaults.find((v) => v.key === "PROTO")!.artifact;
  // every basket vault runs a build that contains the redeemInKind selector (the artifact and the chain code both carry it outside the immutable range)
  const art = join(w.artifactsDir, `${protoArtifact}.sol`, `${protoArtifact}.json`);
  const j = JSON.parse(readFileSync(art, "utf8"));
  const patch = (hex: string): string => hex.slice(0, 120) + SEL + hex.slice(120 + SEL.length);
  j.deployedBytecode.object = patch(j.deployedBytecode.object);
  writeFileSync(art, JSON.stringify(j));
  const oldCode = w.chain.codes.get(OLD.toLowerCase())!;
  const patched = patch(oldCode) as Hex;
  for (const [a, c] of w.chain.codes) if (c === oldCode) w.chain.codes.set(a, patched);
  w.chain.codes.set(NEW.toLowerCase(), patched);
  // the new vault carries everything the old one carried: handlers and roles
  for (const [k, h] of [...w.chain.handlers]) if (k.startsWith(`${OLD.toLowerCase()}:`)) w.chain.handlers.set(`${NEW.toLowerCase()}:${k.split(":")[1]}`, h);
  for (const k of [...w.chain.roles]) if (k.startsWith(`${OLD.toLowerCase()}|`)) w.chain.roles.add(k.replace(OLD.toLowerCase(), NEW.toLowerCase()));
  w.chain.set(NEW, "depositsPaused", false);
  w.chain.set(OLD, "depositsPaused", false);
  w.chain.set(OLD, "retired", over.oldRetiredFlag ?? true);
  w.chain.set(NEW, "registry", REGISTRY);
  w.sheet.vaults.rmPROTO!.expectPaused = false;
  writeFileSync(join(w.manifestDir, REPLACEMENT), JSON.stringify({ chain_id: 8453, vault: NEW }));
  const listed = [VAULTS.rmUSDC.address, OLD, VAULTS.rmAGENT.address, VAULTS.rmRWA.address, NEW];
  w.chain.set(REGISTRY, "listVaults", listed);
  w.chain.set(REGISTRY, "vaultCount", 5n);
  w.chain.set(REGISTRY, "isRouterEligible", (a: unknown[]) => (String(a[0]).toLowerCase() === OLD.toLowerCase() ? (over.oldEligible ?? false) : true));
  w.chain.set(REGISTRY, "getVault", (a: unknown[]) => {
    const who = String(a[0]).toLowerCase();
    const status = who === OLD.toLowerCase() ? (over.status ?? 2) : who === NEW.toLowerCase() ? (over.newStatus ?? 0) : 0;
    return [{ name: "Robot Money Protocol", asset: addr(0xc0de), registeredAt: 1n }, status];
  });
  const four = [VAULTS.rmUSDC.address, NEW, VAULTS.rmAGENT.address, VAULTS.rmRWA.address];
  const bps = [9500n, 500n, 0n, 0n];
  w.chain.set(ROUTER, "getDefaultWeights", [four, bps]);
  w.chain.set(ROUTER, "getEffectiveWeights", over.effective ?? [four, bps]);
  w.chain.set(ROUTER, "votedWeightsActive", over.voted ?? false);
  w.chain.set(ROUTER, "vaultCap", (a: unknown[]) => (String(a[0]).toLowerCase() === NEW.toLowerCase() ? (over.cap ?? 525000n) : 0n));
  w.opts.redeploys = [{ vault: "rmPROTO", oldVault: OLD, newVault: NEW, replacementManifest: REPLACEMENT, routerVaultCap: "525000" }];
  w.opts.redeployDeployerTxs = 3;
  w.chain.noncesMap.set(DEPLOYER.toLowerCase(), (w.chain.noncesMap.get(DEPLOYER.toLowerCase()) ?? 0) + 3);
  return w;
}

describe("the state after a redeploy, both generations", () => {
  test("a finished redeploy passes every label", async () => {
    const r = await verifyDeployment(redeployed().opts);
    expect(failed(r)).toEqual([]);
    const labels = r.checks.map((c) => c.label);
    for (const l of ["retired[rmPROTO]: registry status is Retired", "retired[rmPROTO]: not router-eligible", "retired[rmPROTO]: runtime code serves redeemInKind", "retired[rmPROTO]: timelock holds ADMIN_ROLE", "redeploy[rmPROTO]: router per-address cap equals approved old cap", "redeploy[rmPROTO]: no voted vector is active", "redeploy[rmPROTO]: default and effective vectors are the same unique four legs", "vault set: manifests equal registry.listVaults"]) expect(labels).toContain(l);
    expect(new Set(labels).size).toBe(labels.length);
  });
  test("the original manifests are untouched: the replacement is a separate file the overlay supplies", async () => {
    const w = redeployed();
    const proto = getStageTable().vaults.find((v) => v.key === "PROTO")!.manifest;
    const file = join(w.manifestDir, basename(proto));
    const before = readFileSync(file, "utf8");
    await verifyDeployment(w.opts);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(JSON.parse(before).vault.toLowerCase()).toBe(OLD.toLowerCase());
  });
  const cases: [string, Parameters<typeof redeployed>[0], string][] = [
    ["the old vault is still Active in the registry", { status: 0 }, "retired[rmPROTO]: registry status is Retired"],
    ["the old vault is still router-eligible", { oldEligible: true }, "retired[rmPROTO]: not router-eligible"],
    ["the old vault's own deposits were not halted", { oldRetiredFlag: false }, "retired[rmPROTO]: deposits halted by the registry retire"],
    ["the new vault is not Active in the registry", { newStatus: 2 }, "redeploy[rmPROTO]: replacing vault registry status is Active"],
    ["the router cap of the new vault is not the approved old cap", { cap: 0n }, "redeploy[rmPROTO]: router per-address cap equals approved old cap"],
    ["a voted vector is active", { voted: true }, "redeploy[rmPROTO]: no voted vector is active"],
    ["the effective vector still routes to the old vault", { effective: [[VAULTS.rmUSDC.address, OLD, VAULTS.rmAGENT.address, VAULTS.rmRWA.address], [9500n, 500n, 0n, 0n]] }, "redeploy[rmPROTO]: default and effective vectors are the same unique four legs"],
    ["the effective vector lists the new vault twice", { effective: [[VAULTS.rmUSDC.address, NEW, NEW, VAULTS.rmRWA.address], [9500n, 500n, 0n, 0n]] }, "redeploy[rmPROTO]: default and effective vectors are the same unique four legs"],
  ];
  for (const [name, over, label] of cases) {
    test(`fails when ${name}`, async () => {
      const r = await verifyDeployment(redeployed(over).opts);
      expect(failed(r)).toContain(label);
    });
  }
  test("fails when the old vault lost its timelock admin or its emergency holder, or the deployer still holds a role on the new vault", async () => {
    const a = redeployed();
    a.chain.revoke(OLD, ADMIN_ROLE, TIMELOCK);
    expect(failed(await verifyDeployment(a.opts))).toContain("retired[rmPROTO]: timelock holds ADMIN_ROLE");
    const b = redeployed();
    b.chain.revoke(OLD, EMERGENCY_ROLE, EMERGENCY);
    expect(failed(await verifyDeployment(b.opts))).toContain("retired[rmPROTO]: emergency key holds EMERGENCY_ROLE");
    const c = redeployed();
    c.chain.grant(NEW, ADMIN_ROLE, DEPLOYER);
    c.chain.roleGrantedLog(NEW, ADMIN_ROLE, DEPLOYER, 4000n);
    expect(failed(await verifyDeployment(c.opts))).toContain("deployer: holds no role on any contract (log scan)");
  });
  test("fails when the new vault is not bound to the registry, or the registry lists a vault no manifest names", async () => {
    const a = redeployed();
    a.chain.set(NEW, "registry", addr(0));
    expect(failed(await verifyDeployment(a.opts)).length).toBeGreaterThan(0);
    const b = redeployed();
    b.chain.set(REGISTRY, "listVaults", [...[VAULTS.rmUSDC.address, OLD, VAULTS.rmAGENT.address, VAULTS.rmRWA.address, NEW], addr(0xdead)]);
    b.chain.set(REGISTRY, "vaultCount", 6n);
    expect(failed(await verifyDeployment(b.opts))).toContain("vault set: manifests equal registry.listVaults");
  });
  test("fails when the deployer nonce misses a redeploy transaction", async () => {
    const w = redeployed();
    w.chain.noncesMap.set(DEPLOYER.toLowerCase(), (w.chain.noncesMap.get(DEPLOYER.toLowerCase()) ?? 0) - 1);
    expect(failed(await verifyDeployment(w.opts))).toContain("deployer: nonce equals sum of frozen counts");
  });
});
