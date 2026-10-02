// Canonical: docs/plans/one-deployment-scheme.md (robotmoney/devops), core S3 (issue 1485).
// Offline test of the core stage table. Run: bun test scripts/deploy/core-stages.test.ts
import { describe, expect, test } from "bun:test";
import { STAGES, assertGatewayRouter, assertStageOrder, mergeManifests } from "./core-stages";

describe("stage table", () => {
  test("runs libs, vault, registry, router, gateway, governance, ic, three basket vaults, timelock in that order", () => {
    expect(STAGES.map((s) => s.name)).toEqual([
      "libs", "vault", "registry", "router", "gateway", "governance", "ic", "protocol", "agent", "rwa", "timelock",
    ]);
  });
  test("the timelock is last and hands over all four vaults", () => {
    const t = STAGES[STAGES.length - 1];
    expect(t.name).toBe("timelock");
    const m = { vault: "0x1", protocol_vault: "0x2", agent_vault: "0x3", rwa_vault: "0x4" };
    expect(t.computed!(m).VAULT_ADDRESSES).toBe("0x1,0x2,0x3,0x4");
    expect(() => t.computed!({ vault: "0x1" })).toThrow(/protocol_vault/);
  });
  test("a timelock that is not last is refused", () => {
    const moved = [...STAGES];
    const t = moved.pop()!;
    moved.splice(3, 0, t);
    expect(() => assertStageOrder(moved)).toThrow();
  });
  test("the committed table passes the order rule", () => {
    expect(() => assertStageOrder()).not.toThrow();
  });
  test("a gateway before the router is refused", () => {
    const swapped = [...STAGES];
    const r = swapped.findIndex((s) => s.name === "router");
    const g = swapped.findIndex((s) => s.name === "gateway");
    [swapped[r], swapped[g]] = [swapped[g], swapped[r]];
    expect(() => assertStageOrder(swapped)).toThrow();
  });
  test("the gateway takes the router", () => {
    expect(STAGES.find((s) => s.name === "gateway")!.needs.router).toBe("ROUTER_ADDRESS");
  });
});

describe("manifest", () => {
  const router = "0x1111111111111111111111111111111111111111";
  test("a zero gateway router is refused", () => {
    expect(() => assertGatewayRouter({ router, gateway_router: "0x" + "0".repeat(40) })).toThrow(/zero/);
  });
  test("a gateway router that differs from the router is refused", () => {
    expect(() => assertGatewayRouter({ router, gateway_router: "0x2222222222222222222222222222222222222222" })).toThrow();
  });
  test("the deployed router passes", () => {
    expect(() => assertGatewayRouter({ router, gateway_router: router.toUpperCase().replace("0X", "0x") })).not.toThrow();
  });
  test("one key with two values is refused", () => {
    expect(() => mergeManifests([{ vault: "0xaa" }, { vault: "0xbb" }])).toThrow(/disagrees/);
  });
  test("one key with one value merges", () => {
    expect(mergeManifests([{ vault: "0xAA" }, { vault: "0xaa", gateway: "0x01" }])).toEqual({ vault: "0xAA", gateway: "0x01" });
  });
});

import { routerChecks } from "./assert-core-router";

describe("router proof rules", () => {
  const router = "0x1111111111111111111111111111111111111111";
  test("zero gateway router fails the first two checks", () => {
    const c = routerChecks({ router }, "0x" + "0".repeat(40), router);
    expect(c[0].ok).toBe(false);
    expect(c[1].ok).toBe(false);
  });
  test("a matching router passes all three", () => {
    expect(routerChecks({ router }, router, router).every((x) => x.ok)).toBe(true);
  });
  test("a registry link to another router fails", () => {
    const c = routerChecks({ router }, router, "0x2222222222222222222222222222222222222222");
    expect(c[2].ok).toBe(false);
  });
});

import { timelockRoleChecks, type Reader } from "./assert-timelock-roles";
import { basketChecks, type BasketReader } from "./assert-basket-vaults";

const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const manifest = {
  timelock_timelock: A(0x10), registry: A(0x11), router: A(0x12), governance: A(0x13), policy: A(0x14),
  consensus_receipt: A(0x15), gateway: A(0x16), agent: A(0x17),
  vault: A(0x21), protocol_vault: A(0x22), agent_vault: A(0x23), rwa_vault: A(0x24),
};
const DEPLOYER = A(0x99), SAFE = A(0x98), EMERGENCY = A(0x97);

/** A fake chain in the state a correct run leaves behind. `tweak` breaks one thing. */
function goodReader(tweak: Partial<Reader> = {}): Reader {
  const tl = manifest.timelock_timelock;
  return {
    role: async (n) => n,
    hasRole: async (c, role, a) => {
      if (a === DEPLOYER) return false;
      if (c === tl) return a === SAFE && (role === "PROPOSER_ROLE" || role === "EXECUTOR_ROLE");
      if (a === EMERGENCY) return role === "EMERGENCY_ROLE";
      return a === tl;
    },
    addressOf: async () => manifest.registry,
    uintOf: async () => 172800n,
    listVaults: async () => [manifest.vault, manifest.protocol_vault, manifest.agent_vault, manifest.rwa_vault],
    setRegistryReverts: async () => true,
    agentOwner: async () => tl,
    ...tweak,
  };
}
const inputs = { manifest, deployer: DEPLOYER, safe: SAFE, emergency: EMERGENCY, minDelay: 172800n };

describe("timelock role proof rules", () => {
  test("a correct handover passes every check", async () => {
    const c = await timelockRoleChecks(goodReader(), inputs);
    expect(c.filter((x) => !x.ok)).toEqual([]);
    expect(c.length).toBeGreaterThan(30);
  });
  test("a deployer that still holds ADMIN on a vault fails", async () => {
    const r = goodReader({ hasRole: async (c, role, a) => (c === manifest.rwa_vault && role === "ADMIN_ROLE" && a === DEPLOYER) || (await goodReader().hasRole(c, role, a)) });
    expect((await timelockRoleChecks(r, inputs)).some((x) => !x.ok && x.name.startsWith("rmRWA"))).toBe(true);
  });
  test("a vault with no registry link fails", async () => {
    const r = goodReader({ addressOf: async (c) => (c === manifest.agent_vault ? A(0) : manifest.registry) });
    expect((await timelockRoleChecks(r, inputs)).some((x) => !x.ok && x.name.startsWith("rmAGENT"))).toBe(true);
  });
  test("a registry that lacks a vault fails", async () => {
    const r = goodReader({ listVaults: async () => [manifest.vault] });
    expect((await timelockRoleChecks(r, inputs)).filter((x) => !x.ok).length).toBe(3);
  });
  test("a wrong delay fails", async () => {
    const r = goodReader({ uintOf: async () => 1n });
    expect((await timelockRoleChecks(r, inputs)).some((x) => !x.ok && x.name.includes("delay"))).toBe(true);
  });
  test("a second setRegistry that succeeds fails", async () => {
    const r = goodReader({ setRegistryReverts: async () => false });
    expect((await timelockRoleChecks(r, inputs)).filter((x) => !x.ok).length).toBe(4);
  });
});

describe("basket vault proof rules", () => {
  const configs = {
    "protocol-assets.json": { assets: [{ symbol: "wETH", token: A(1), pool: A(2), poolFee: 500 }, { symbol: "cbBTC", token: A(3), pool: A(4), poolFee: 500 }] },
    "agent-token-shortlist.json": { shortlist: [] },
    "rwa-assets.json": { assets: [{ symbol: "deSPXA", token: A(5), pool: A(6), poolFee: 500 }] },
  };
  const chain: Record<string, any[]> = {
    [manifest.protocol_vault]: [{ token: A(1), pool: A(2), fee: 500, active: true }, { token: A(3), pool: A(4), fee: 500, active: true }],
    [manifest.agent_vault]: [],
    [manifest.rwa_vault]: [{ token: A(5), pool: A(6), fee: 500, active: true }],
  };
  const reader = (over: Partial<BasketReader> = {}): BasketReader => ({
    listVaults: async () => [manifest.vault, manifest.protocol_vault, manifest.agent_vault, manifest.rwa_vault],
    paused: async () => true,
    assets: async (v) => chain[v],
    ...over,
  });
  test("a correct deploy passes", async () => {
    expect((await basketChecks(reader(), manifest, configs)).filter((x) => !x.ok)).toEqual([]);
  });
  test("an unpaused vault fails", async () => {
    const c = await basketChecks(reader({ paused: async (v) => v !== manifest.rwa_vault }), manifest, configs);
    expect(c.some((x) => !x.ok && x.name.startsWith("rmRWA"))).toBe(true);
  });
  test("an rmAGENT with an asset fails", async () => {
    const c = await basketChecks(reader({ assets: async (v) => (v === manifest.agent_vault ? [{ token: A(7), pool: A(8), fee: 500, active: true }] : chain[v]) }), manifest, configs);
    expect(c.some((x) => !x.ok && x.name.startsWith("rmAGENT"))).toBe(true);
  });
  test("a pool or fee that differs from config fails", async () => {
    const c = await basketChecks(reader({ assets: async (v) => (v === manifest.protocol_vault ? [{ token: A(1), pool: A(9), fee: 3000, active: true }, chain[v][1]] : chain[v]) }), manifest, configs);
    expect(c.filter((x) => !x.ok).length).toBe(2);
  });
  test("a vault missing from the registry fails", async () => {
    const c = await basketChecks(reader({ listVaults: async () => [manifest.vault] }), manifest, configs);
    expect(c.filter((x) => !x.ok).length).toBe(3);
  });
});
