#!/usr/bin/env bun
/**
 * Self-test for the dependency manifest tools (core 1497). Offline, no secret.
 *
 * The chain data is the Twin chain (core 1498): a pinned lazy fork of real Base state, real code and
 * storage, started with scripts/devnet/twin-fork.ts. Pass its URL with --rpc-url or TWIN_RPC_URL. With
 * neither, the selftest skips with a named reason (it reads a chain; it never builds one from a file).
 * Cases:
 *   1. record a manifest from the snapshot, diff it against the same snapshot: no change, exit 0
 *   2. edit one code hash in the manifest: the report names exactly that address, exit 1
 *   3. edit one implementation code hash: the report names exactly that proxy
 *   4. every manifest address is in the deploy config (check script exits 0); an added stray address exits 1
 *   5. the workflow check passes the shipped workflow and fails one with a schedule or no dispatch
 *
 * Usage: bun scripts/release/dependency-manifest-selftest.ts [--rpc-url URL]
 * Exit: 0 all cases hold or the run skipped for want of a chain; 1 a case failed.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const here = import.meta.dir;
const root = resolve(here, "../..");
const args = process.argv.slice(2);
const rpcArg = args.indexOf("--rpc-url");
const rpcUrl = rpcArg >= 0 ? args[rpcArg + 1] : process.env.TWIN_RPC_URL;
if (!rpcUrl) {
  console.log("SKIP: no chain. Start the Twin fork (bun scripts/devnet/twin-fork.ts start) and pass --rpc-url or set TWIN_RPC_URL.");
  process.exit(0);
}
const TWIN = ["--twin", "--rpc-url", rpcUrl];

const tmp = mkdtempSync(join(tmpdir(), "depmanifest-"));
let failures = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`);
  if (!cond) failures++;
};

function run(script: string, a: string[]): { code: number; out: string } {
  const p = Bun.spawnSync(["bun", join(here, script), ...a], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
}

try {
  const good = join(tmp, "good.json");
  const rec = run("dependency-manifest-record.ts", ["--chain-id", "8453", "--release", "selftest", "--repo-root", root, ...TWIN, "--out", good]);
  ok(rec.code === 0, `record from the Twin chain exits 0`);
  const m = JSON.parse(readFileSync(good, "utf8"));
  const withCode = m.entries.filter((e: any) => e.codeHash);
  ok(withCode.length >= 3, `manifest holds code hashes (${withCode.length} of ${m.entries.length} addresses have code)`);
  ok(m.entries.some((e: any) => e.implementation && e.implementationCodeHash), "at least one proxy has its implementation address and code hash (USDC)");

  // 1. accurate manifest: no change
  const d1 = run("dependency-manifest-diff.ts", ["--manifest", good, ...TWIN]);
  ok(d1.code === 0 && /no change/.test(d1.out) && !/CHANGED/.test(d1.out), "accurate manifest: report lists no change, exit 0");

  // 2. one edited code hash
  const target = withCode[0];
  const bad = structuredClone(m);
  const be = bad.entries.find((e: any) => e.address === target.address);
  be.codeHash = "0x" + "ab".repeat(32);
  const badPath = join(tmp, "bad.json");
  writeFileSync(badPath, JSON.stringify(bad));
  const d2 = run("dependency-manifest-diff.ts", ["--manifest", badPath, ...TWIN]);
  const named = [...d2.out.matchAll(/^CHANGED (0x[0-9a-f]{40})/gm)].map((x) => x[1]);
  ok(d2.code === 1 && named.length === 1 && named[0] === target.address, `edited code hash: report names exactly ${target.address}`);
  ok(d2.out.includes(be.codeHash) && d2.out.includes(target.codeHash), "report shows old and new hash");

  // 3. one edited implementation code hash
  const proxy = m.entries.find((e: any) => e.implementationCodeHash);
  const bad3 = structuredClone(m);
  bad3.entries.find((e: any) => e.address === proxy.address).implementationCodeHash = "0x" + "cd".repeat(32);
  const bad3Path = join(tmp, "bad3.json");
  writeFileSync(bad3Path, JSON.stringify(bad3));
  const d3 = run("dependency-manifest-diff.ts", ["--manifest", bad3Path, ...TWIN]);
  const named3 = [...d3.out.matchAll(/^CHANGED (0x[0-9a-f]{40})/gm)].map((x) => x[1]);
  ok(d3.code === 1 && named3.length === 1 && named3[0] === proxy.address, `edited implementation hash: report names exactly ${proxy.address}`);

  // 4. address presence in the deploy config
  const c1 = run("check-dependency-manifest-addresses.ts", ["--manifest", good, "--repo-root", root]);
  ok(c1.code === 0, "every manifest address appears in the deploy config files");
  const stray = structuredClone(m);
  stray.entries.push({ ...m.entries[0], address: "0x1111111111111111111111111111111111111111" });
  const strayPath = join(tmp, "stray.json");
  writeFileSync(strayPath, JSON.stringify(stray));
  ok(run("check-dependency-manifest-addresses.ts", ["--manifest", strayPath, "--repo-root", root]).code === 1, "an address missing from the deploy config is refused");

  // 4b. the committed example fixture (not a release record)
  const ex = join(root, "deployments/dependency-manifests/example.json");
  const exm = JSON.parse(readFileSync(ex, "utf8"));
  ok(exm.example === true && /EXAMPLE/.test(exm.note ?? ""), "example fixture is clearly marked as an example");
  ok(run("check-dependency-manifest-addresses.ts", ["--manifest", ex, "--repo-root", root]).code === 0, "example fixture addresses are all in the deploy config");
  ok(run("record-release-dependencies.ts", ["--chain-id", "8453", "--release", "x", "--manifests-dir", join(tmp, "nope")]).code === 2, "release hook refuses a missing --manifests-dir");

  // 5. workflow check
  const wf = join(root, ".github/workflows/nightly-third-party-drift.yml");
  ok(run("check-nightly-third-party-workflow.ts", [wf]).code === 0, "shipped workflow: dispatch only, no active schedule");
  const src = readFileSync(wf, "utf8");
  const sched = join(tmp, "sched.yml");
  writeFileSync(sched, src.replace(/^on:\n/m, 'on:\n  schedule:\n    - cron: "0 4 * * *"\n'));
  ok(run("check-nightly-third-party-workflow.ts", [sched]).code === 1, "workflow with an active schedule is refused");
  const nodisp = join(tmp, "nodisp.yml");
  writeFileSync(nodisp, src.replace(/^ {2}workflow_dispatch:.*$/m, "  push:"));
  ok(run("check-nightly-third-party-workflow.ts", [nodisp]).code === 1, "workflow without workflow_dispatch is refused");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failures === 0 ? "selftest ok" : `selftest FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
