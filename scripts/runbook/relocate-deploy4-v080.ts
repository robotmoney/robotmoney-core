// Relocate only the two known v0.8 Deploy 4 entries in a copied run manifest.
// The original path remains recorded, and the live record is never written.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const sha = "fa7c471821ffdc76e9518b10dda5f420c135ae18";
const expected = new Map([
  ["fund", "0x1e69cc84b698b84129e3adb43ba6f59a242d040c"],
  ["queue", "0x5e627b6e4402f753fb7ffa54a72897ed06a5018d"],
]);
export function relocate(m: any, build: string): any {
  if (m.system !== "fund" || m.coreSha !== "7c23569f85e96232fc75bbba32ebbd469da31966" || !Array.isArray(m.proxy_upgrades) || m.proxy_upgrades.length !== 2) throw new Error("unexpected Deploy 4 history");
  const seen = new Set<string>();
  for (const e of m.proxy_upgrades) {
    const name = e.proxy_name;
    if (!expected.has(name) || seen.has(name) || String(e.to_implementation).toLowerCase() !== expected.get(name) || !e.execute_tx || !e.schedule_tx || typeof e.build !== "string" || !e.build) throw new Error(`unexpected prior upgrade ${name}`);
    if (e.build_sha && e.build_sha !== sha) throw new Error(`unexpected prior build SHA for ${name}`);
    seen.add(name);
    e.original_build ??= e.build;
    e.build = build;
    e.build_sha = sha;
  }
  return m;
}
if (import.meta.main) {
  const [file, path] = process.argv.slice(2);
  if (!file || !path) throw new Error("usage: relocate-deploy4-v080 MANIFEST BUILD");
  const build = resolve(path);
  if (execFileSync("git", ["-C", build, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== sha || execFileSync("git", ["-C", build, "status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("v0.8 build is not a clean checkout of the pinned SHA");
  const m = relocate(JSON.parse(readFileSync(file, "utf8")), build);
  writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
}
