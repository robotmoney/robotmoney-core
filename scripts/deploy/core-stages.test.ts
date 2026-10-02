// Canonical: docs/plans/one-deployment-scheme.md (robotmoney/devops), core S3 (issue 1485).
// Offline test of the core stage table. Run: bun test scripts/deploy/core-stages.test.ts
import { describe, expect, test } from "bun:test";
import { STAGES, assertGatewayRouter, assertStageOrder, mergeManifests } from "./core-stages";

describe("stage table", () => {
  test("runs libs, vault, registry, router, gateway in that order", () => {
    expect(STAGES.map((s) => s.name)).toEqual(["libs", "vault", "registry", "router", "gateway"]);
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
