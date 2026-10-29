// Issue 1912, ADR-0017: the verifier after `govern --row retire-vault`. The registry still lists the retired vault, so the manifests plus the retired vault equal the registry. The retired vault
// is Retired, out of the router-eligible set, its deposits halted, still holding code, and absent from the router's three-leg default and effective vectors.
import { describe, expect, test } from "bun:test";
import { getAddress } from "viem";
import { verifyDeployment } from "../../src/verify/index.ts";
import { retiredVaultsOf } from "../../src/retire-vault.ts";
import { REGISTRY, ROUTER, VAULTS, addr, buildWorld, failed, type World } from "./world.ts";

const RETIRED = addr(0xb0099);

/** The healthy three-vault world, plus a fourth vault the Safe retired: listed, Retired, not eligible, retired() true, with code. */
function retired(over: { status?: number; eligible?: boolean; flag?: boolean; code?: boolean; inVector?: boolean; listed?: boolean; effective?: bigint[]; voted?: boolean; defaultW?: [string[], bigint[]]; effectiveW?: [string[], bigint[]] } = {}): World {
  const w = buildWorld();
  const three = Object.values(VAULTS).map((v) => v.address);
  if (over.code !== false) w.chain.codes.set(RETIRED.toLowerCase(), "0x6001");
  w.chain.set(REGISTRY, "listVaults", over.listed === false ? three : [...three, RETIRED]);
  w.chain.set(REGISTRY, "vaultCount", over.listed === false ? 3n : 4n);
  w.chain.set(REGISTRY, "isRouterEligible", (a: unknown[]) => (String(a[0]).toLowerCase() === RETIRED.toLowerCase() ? (over.eligible ?? false) : true));
  w.chain.set(REGISTRY, "getVault", (a: unknown[]) => [{ name: "Robot Money Agent Tokens", asset: addr(0xc0de), registeredAt: 1n }, String(a[0]).toLowerCase() === RETIRED.toLowerCase() ? (over.status ?? 2) : 0]);
  w.chain.set(RETIRED, "retired", over.flag ?? true);
  if (over.inVector) {
    const vs = [three[0]!, three[1]!, RETIRED];
    w.chain.set(ROUTER, "getDefaultWeights", [vs, [9500n, 500n, 0n]]);
    w.chain.set(ROUTER, "getEffectiveWeights", [vs, [9500n, 500n, 0n]]);
  }
  if (over.effective) w.chain.set(ROUTER, "getEffectiveWeights", [three, over.effective]);
  if (over.defaultW) w.chain.set(ROUTER, "getDefaultWeights", over.defaultW);
  if (over.effectiveW) w.chain.set(ROUTER, "getEffectiveWeights", over.effectiveW);
  if (over.voted !== undefined) w.chain.set(ROUTER, "votedWeightsActive", over.voted);
  w.opts.retirements = [{ vault: RETIRED }];
  return w;
}

const label = (l: string) => `retired[${RETIRED}]: ${l}`;
const VECTOR = "the router's default and effective vectors hold one leg per remaining vault and not this one";

describe("a retired vault (issue 1912, ADR-0017)", () => {
  test("the registry lists the retired vault besides the three manifests, and every retired label passes", async () => {
    const r = await verifyDeployment(retired().opts);
    expect(failed(r)).toEqual([]);
    for (const l of ["has code", "registry status is Retired", "not router-eligible", "deposits halted by the registry retire", VECTOR]) expect(r.checks.find((c) => c.label === label(l))?.ok, l).toBe(true);
    expect(r.checks.find((c) => c.label === "vault set: manifests equal registry.listVaults")!.detail).toContain("3 vaults and 1 retired");
  });
  test("a run without a retirement keeps the label set of every other deployment", async () => {
    const r = await verifyDeployment(buildWorld().opts);
    expect(r.checks.some((c) => c.label.startsWith("retired["))).toBe(false);
  });
  test("each fault fails its own label: not retired, still eligible, deposits open, no code, still in the vector", async () => {
    expect(failed(await verifyDeployment(retired({ status: 0 }).opts))).toEqual([label("registry status is Retired")]);
    expect(failed(await verifyDeployment(retired({ eligible: true }).opts))).toEqual([label("not router-eligible")]);
    expect(failed(await verifyDeployment(retired({ flag: false }).opts))).toEqual([label("deposits halted by the registry retire")]);
    expect(failed(await verifyDeployment(retired({ code: false }).opts))).toContain(label("has code"));
    expect(failed(await verifyDeployment(retired({ inVector: true }).opts))).toContain(label(VECTOR));
  });
  test("issue 1992: an applied receipt's active vector over the remaining vaults passes; differing bps with no active vector, or a vector off 10000, fail", async () => {
    const ok = await verifyDeployment(retired({ effective: [8000n, 1000n, 1000n], voted: true }).opts);
    expect(ok.checks.find((c) => c.label === label(VECTOR))?.ok).toBe(true);
    expect(failed(await verifyDeployment(retired({ effective: [8000n, 1000n, 1000n], voted: false }).opts))).toContain(label(VECTOR));
    expect(failed(await verifyDeployment(retired({ effective: [8000n, 1000n, 900n], voted: true }).opts))).toContain(label(VECTOR));
  });
  test("issue 1992: with an active vector the check still refuses a missing vault, a default off 10000, a different vault list, and the retired vault in the effective vector only", async () => {
    const [a, b, c] = Object.values(VAULTS).map((v) => v.address);
    const vec = (r: Awaited<ReturnType<typeof verifyDeployment>>) => r.checks.find((x) => x.label === label(VECTOR))?.ok;
    expect(vec(await verifyDeployment(retired({ voted: true, defaultW: [[a!, b!], [9500n, 500n]], effectiveW: [[a!, b!], [8000n, 2000n]] }).opts))).toBe(false);
    expect(vec(await verifyDeployment(retired({ voted: true, defaultW: [[a!, b!, c!], [9500n, 500n, 100n]], effectiveW: [[a!, b!, c!], [8000n, 1000n, 1000n]] }).opts))).toBe(false);
    expect(vec(await verifyDeployment(retired({ voted: true, effectiveW: [[a!, c!, b!], [8000n, 1000n, 1000n]] }).opts))).toBe(false);
    expect(vec(await verifyDeployment(retired({ voted: true, effectiveW: [[a!, b!, RETIRED], [8000n, 1000n, 1000n]] }).opts))).toBe(false);
  });
  test("issue 1988: an applied vector from before the retire still names the vault; it passes when the router skips that leg, and fails when it does not", async () => {
    const [a, b, c] = Object.values(VAULTS).map((v) => v.address);
    const four = [a!, b!, RETIRED, c!];
    const vec = (r: Awaited<ReturnType<typeof verifyDeployment>>) => r.checks.find((x) => x.label === label(VECTOR));
    const legs = (skip: boolean) => four.map((v) => ({ vault: v, weightBps: 2500n, legAmount: v === RETIRED && skip ? 0n : 1n, estShares: 0n, unavailable: v === RETIRED && skip }));
    const w = (skip: boolean | undefined) => { const x = retired({ voted: true, effectiveW: [four, [8000n, 1000n, 500n, 500n]] }); if (skip !== undefined) x.chain.set(ROUTER, "previewDeposit", legs(skip)); return x; };
    const ok = await verifyDeployment(w(true).opts);
    expect(vec(ok)?.ok).toBe(true);
    expect(vec(ok)?.detail).toContain("the router skips that leg");
    expect(vec(await verifyDeployment(w(false).opts))?.ok).toBe(false);
    expect(vec(await verifyDeployment(w(false).opts))?.detail).toContain("does not skip the retired leg");
    expect(vec(await verifyDeployment(w(undefined).opts))?.ok).toBe(false);
    // with no applied vector active the effective vector must be the default: a four-leg effective vector fails
    expect(vec(await verifyDeployment(retired({ voted: false, effectiveW: [four, [8000n, 1000n, 500n, 500n]] }).opts))?.ok).toBe(false);
    // an applied vector that puts no weight on the vaults that stay fails
    const dead = retired({ voted: true, effectiveW: [four, [0n, 0n, 10000n, 0n]] });
    dead.chain.set(ROUTER, "previewDeposit", legs(true));
    expect(vec(await verifyDeployment(dead.opts))?.ok).toBe(false);
  });
  test("a retired vault the registry does not list fails the vault set label", async () => {
    expect(failed(await verifyDeployment(retired({ listed: false }).opts))).toContain("vault set: manifests equal registry.listVaults");
  });
  test("a vault the registry lists and no record names fails the vault set label", async () => {
    const w = retired();
    w.opts.retirements = [];
    expect(failed(await verifyDeployment(w.opts))).toContain("vault set: manifests equal registry.listVaults");
  });
});

describe("the run manifest's retirements", () => {
  test("each retired vault once, in order, and a malformed or repeated entry is dropped", () => {
    expect(retiredVaultsOf({})).toEqual([]);
    expect(retiredVaultsOf({ vault_retirements: [{ vault: RETIRED }, { vault: RETIRED.toUpperCase().replace("0X", "0x") }, { vault: "nope" }, {}, null] })).toEqual([{ vault: getAddress(RETIRED) }]);
  });
});
