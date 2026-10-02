import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { collectThirdPartyAddresses } from "./dependency-manifest-lib.ts";

const root = resolve(import.meta.dir, "../..");

test("addresses come from the one-map config files for every chain", () => {
  const a = collectThirdPartyAddresses(root, 8453);
  const b = collectThirdPartyAddresses(root, 918453);
  expect(a.deps.map((d) => d.address)).toEqual(b.deps.map((d) => d.address));
  const labels = a.deps.map((d) => d.label).join("\n");
  expect(labels).toContain("pools.eth-usd.pool");
  expect(labels).toContain("assets[1].token");
  expect(a.deps.some((d) => d.source === "config/rwa-assets.json")).toBe(true);
  const addrs = new Set(a.deps.map((d) => d.address));
  // deSPXA (rwa), cbBTC (protocol), swapRouter02 (shared venue)
  expect(addrs.has("0x9c5c365e764829876243d0b289733b9d2b729685")).toBe(true);
  expect(addrs.has("0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf")).toBe(true);
  expect(addrs.has("0x2626664c2603336e57b271c5c0b26f421741e481")).toBe(true);
  expect(a.warnings).toEqual([]);
});
