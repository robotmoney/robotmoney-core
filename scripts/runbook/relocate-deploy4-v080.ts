// Relocate only the two known v0.8 Deploy 4 entries in a copied run manifest (releases/v0.9.0-onevault-upgrade.yaml P0.91).
// The original path remains recorded, and the live record is never written. The generic form is relocate-record.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gitCheckoutProblem, relocateRecord, type CheckoutProblem, type Pin } from "./relocate-record.ts";

export const V080_SHA = "fa7c471821ffdc76e9518b10dda5f420c135ae18";
export const DEPLOY4_CORE_SHA = "7c23569f85e96232fc75bbba32ebbd469da31966";
export const V080_PINS: Pin[] = [
  { proxy: "fund", implementation: "0x1e69cc84b698b84129e3adb43ba6f59a242d040c", sha: V080_SHA },
  { proxy: "queue", implementation: "0x5e627b6e4402f753fb7ffa54a72897ed06a5018d", sha: V080_SHA },
];

export function relocate(m: any, build: string, checkoutProblem: CheckoutProblem = () => undefined): any {
  return relocateRecord(m, { coreSha: DEPLOY4_CORE_SHA, pins: V080_PINS, checkouts: { [V080_SHA]: build }, checkoutProblem });
}

if (import.meta.main) {
  const [file, path] = process.argv.slice(2);
  if (!file || !path) throw new Error("usage: relocate-deploy4-v080 MANIFEST BUILD");
  const m = relocate(JSON.parse(readFileSync(file, "utf8")), resolve(path), gitCheckoutProblem);
  writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
}
