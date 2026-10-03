#!/usr/bin/env bun
/**
 * Release deploy hook (core 1497): record the third-party dependency manifest for a release.
 *
 * The devops publish-contracts runbook calls this once per release deploy, from the core checkout
 * at DEPLOY_SHA, after the deploy is final and before the release deployment record is committed:
 *
 *   DEPENDENCY_MANIFEST_RPC_URL=<public or node RPC of the deploy chain> \
 *     bun scripts/release/record-release-dependencies.ts --chain-id 8453 --release v1.2.3
 *
 * It records deployments/dependency-manifests/<chain id>/<release>.json with
 * dependency-manifest-record.ts, then checks every address in it appears in the deploy config files
 * (check-dependency-manifest-addresses.ts). The file is then committed with the release record.
 * Optional --manifests-dir DIR: the deployed manifests directory of the release (the deploy output the
 * release record is built from). It must exist and is listed in the output, so the record names what it
 * was taken against. The dependency manifest itself is always read from the chain, never from DIR.
 * No secret is read: the RPC URL is read from the environment, never from an argument or a file.
 * Exit: 0 recorded and checked; non-zero otherwise. Printed last line: the manifest path.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { MANIFEST_DIR, argOpt } from "./dependency-manifest-lib.ts";

const args = process.argv.slice(2);
const chainId = argOpt(args, "--chain-id");
const release = argOpt(args, "--release");
const manifestsDir = argOpt(args, "--manifests-dir");
const rpc = process.env.DEPENDENCY_MANIFEST_RPC_URL;
if (!chainId || !/^\d+$/.test(chainId) || !release || !/^[A-Za-z0-9._-]+$/.test(release)) {
  console.error("usage: DEPENDENCY_MANIFEST_RPC_URL=URL record-release-dependencies.ts --chain-id N --release TAG [--manifests-dir DIR]");
  process.exit(2);
}
if (!rpc) {
  console.error("DEPENDENCY_MANIFEST_RPC_URL is not set: the manifest reads the chain it records");
  process.exit(2);
}
if (manifestsDir !== undefined) {
  const d = resolve(manifestsDir);
  if (!existsSync(d) || !statSync(d).isDirectory()) {
    console.error(`--manifests-dir ${manifestsDir} is not a directory`);
    process.exit(2);
  }
  const files = readdirSync(d).filter((f) => f.endsWith(".json")).sort();
  console.log(`deployed manifests in ${manifestsDir}: ${files.length ? files.join(", ") : "(none)"}`);
}
const root = join(import.meta.dir, "..", "..");
const out = join(root, MANIFEST_DIR, chainId, `${release}.json`);
const step = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit", cwd: root });
  if (r.exitCode !== 0) process.exit(r.exitCode || 1);
};
step(["bun", "scripts/release/dependency-manifest-record.ts", "--chain-id", chainId, "--release", release, "--rpc-url", rpc, "--repo-root", root]);
step(["bun", "scripts/release/check-dependency-manifest-addresses.ts", "--manifest", out, "--repo-root", root]);
console.log(out);
