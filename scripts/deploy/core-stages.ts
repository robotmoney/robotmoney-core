#!/usr/bin/env bun
// Canonical: docs/plans/one-deployment-scheme.md (robotmoney/devops), core S3 (issue 1485), core 1493.
//
// The core deploy as data: one stage table, one runner. The order is libs, vault, registry,
// router, gateway. The router runs BEFORE the gateway because the gateway stores the router as an
// immutable (core 1493). Agent authorization is part of the gateway stage, so it follows the
// gateway. The IC policy and receipt follow in their own stage (DeployInvestmentCommitteePolicy),
// owned by the driver stage table in the devops repo.
//
// This runner is the engine behind the driver's "publish contracts" core stages and the Twin chain
// proof. It does not take a key. The caller passes signer flags through (`--forge-arg`), for
// example `--forge-arg --account --forge-arg rehearsal-deployer` or `--forge-arg --unlocked
// --forge-arg --sender --forge-arg 0x...` against a dev node. A secret never goes in an argument.
//
// Usage:
//   bun scripts/deploy/core-stages.ts --rpc-url URL --out MANIFEST.json [--counts COUNTS.json]
//        [--dry-run] [--forge-arg ARG]... [--stages libs,vault,...]
// Inputs come from the environment, the same names the scripts read (ADMIN_ADDRESS, PAUSER_ADDRESS,
// AGENT_ADDRESS, SHARE_RECEIVER_ADDRESS, FEE_RECIPIENT_ADDRESS, VAULT_TVL_CAP,
// VAULT_PER_DEPOSIT_CAP, AGENT_*). The runner sets DEPLOYMENT_OUT, VAULT_ADDRESS, REGISTRY_ADDRESS
// and ROUTER_ADDRESS per stage from the stage manifests.
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type StageName = "libs" | "vault" | "registry" | "router" | "gateway";

export interface Stage {
  name: StageName;
  /** forge script target, path:Contract */
  target: string;
  /** manifest keys this stage must read from earlier stages, mapped to the env var it sets */
  needs: Record<string, string>;
  /** manifest keys the stage must write */
  writes: string[];
}

/** The stage table. Order is the deploy order. */
export const STAGES: Stage[] = [
  { name: "libs", target: "contracts/script/DeployLibs.s.sol:DeployLibs", needs: {}, writes: ["tick_math"] },
  {
    name: "vault",
    target: "contracts/script/DeployVault.s.sol:DeployVault",
    needs: {},
    writes: ["usdc", "vault", "aave_adapter", "compound_adapter", "moonwell_flagship_adapter"],
  },
  {
    name: "registry",
    target: "contracts/script/DeployVaultRegistry.s.sol:DeployVaultRegistry",
    needs: { vault: "VAULT_ADDRESS" },
    writes: ["registry"],
  },
  {
    name: "router",
    target: "contracts/script/DeployPortfolioRouter.s.sol:DeployPortfolioRouter",
    needs: { registry: "REGISTRY_ADDRESS", vault: "VAULT_ADDRESS" },
    writes: ["router"],
  },
  {
    name: "gateway",
    target: "contracts/script/DeployGateway.s.sol:DeployGateway",
    needs: { vault: "VAULT_ADDRESS", router: "ROUTER_ADDRESS" },
    writes: ["gateway", "gateway_router", "gateway_runtime_hash", "agent"],
  },
];

/** Throws when the stage table breaks the rule: every stage's inputs come from an earlier stage. */
export function assertStageOrder(stages: Stage[] = STAGES): void {
  const produced = new Set<string>();
  for (const s of stages) {
    for (const key of Object.keys(s.needs)) {
      if (!produced.has(key)) throw new Error(`stage ${s.name} needs "${key}", which no earlier stage writes`);
    }
    for (const k of s.writes) produced.add(k);
  }
  const names = stages.map((s) => s.name);
  const router = names.indexOf("router");
  const gateway = names.indexOf("gateway");
  if (router < 0 || gateway < 0 || router > gateway) throw new Error("the router stage must come before the gateway stage");
}

/** Merge stage manifests. A key written twice must carry one value. */
export function mergeManifests(parts: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const part of parts) {
    for (const [k, v] of Object.entries(part)) {
      if (k in out && String(out[k]).toLowerCase() !== String(v).toLowerCase()) {
        throw new Error(`manifest key "${k}" disagrees between stages: ${out[k]} vs ${v}`);
      }
      if (!(k in out)) out[k] = v;
    }
  }
  return out;
}

/** The gateway must be built with the router the router stage deployed, and never zero. */
export function assertGatewayRouter(m: Record<string, unknown>): void {
  const zero = "0x0000000000000000000000000000000000000000";
  const gw = String(m.gateway_router ?? "").toLowerCase();
  if (!gw || gw === zero) throw new Error("gateway.router is zero");
  if (gw !== String(m.router ?? "").toLowerCase()) throw new Error(`gateway.router ${gw} != router ${m.router}`);
}

async function run(cmd: string[], env: Record<string, string>): Promise<string> {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} exited ${code}\n${out}\n${err}`);
  return out;
}

async function nonce(addr: string, rpc: string): Promise<number> {
  return Number((await run(["cast", "nonce", addr, "--rpc-url", rpc], {})).trim());
}

function parseArgs(argv: string[]) {
  const a = { rpc: "", out: "", counts: "", dryRun: false, forgeArgs: [] as string[], only: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--rpc-url") a.rpc = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--counts") a.counts = argv[++i];
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--forge-arg") a.forgeArgs.push(argv[++i]);
    else if (k === "--stages") a.only = argv[++i].split(",");
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.rpc || !a.out) throw new Error("--rpc-url and --out are required");
  for (const f of a.forgeArgs) {
    if (/^--(private-key|password)(=|$)/.test(f)) throw new Error(`${f} is refused: no secret in an argument`);
  }
  return a;
}

async function main() {
  assertStageOrder();
  const a = parseArgs(process.argv.slice(2));
  const deployer = process.env.ADMIN_ADDRESS;
  if (!deployer) throw new Error("ADMIN_ADDRESS must be set (it is the broadcaster)");
  const work = mkdtempSync(join(tmpdir(), "core-stages-"));
  const manifests: Record<string, unknown>[] = [];
  const merged = () => mergeManifests(manifests);
  const counts: { stage: string; start_nonce: number; end_nonce: number; tx_count: number }[] = [];

  for (const stage of STAGES) {
    if (a.only.length && !a.only.includes(stage.name)) continue;
    const env: Record<string, string> = { DEPLOYMENT_OUT: join(work, `${stage.name}.json`) };
    const m = merged();
    for (const [key, envName] of Object.entries(stage.needs)) env[envName] = String(m[key]);
    const cmd = ["forge", "script", stage.target, "--rpc-url", a.rpc, "--slow", ...(a.dryRun ? [] : ["--broadcast"]), ...a.forgeArgs];
    const before = a.dryRun ? 0 : await nonce(deployer, a.rpc);
    console.log(`==> stage ${stage.name}`);
    await run(cmd, env);
    const after = a.dryRun ? 0 : await nonce(deployer, a.rpc);
    counts.push({ stage: stage.name, start_nonce: before, end_nonce: after, tx_count: after - before });
    if (a.dryRun) continue;
    if (!existsSync(env.DEPLOYMENT_OUT)) throw new Error(`stage ${stage.name} wrote no manifest`);
    const part = JSON.parse(readFileSync(env.DEPLOYMENT_OUT, "utf8"));
    for (const k of stage.writes) if (!(k in part)) throw new Error(`stage ${stage.name} manifest lacks "${k}"`);
    manifests.push(part);
  }

  if (a.dryRun) {
    console.log("dry run: no broadcast, no manifest");
    return;
  }
  const final = merged();
  if (!a.only.length || a.only.includes("gateway")) assertGatewayRouter(final);
  writeFileSync(a.out, JSON.stringify({ ...final, stages: counts }, null, 2) + "\n");
  if (a.counts) writeFileSync(a.counts, JSON.stringify({ stages: counts }, null, 2) + "\n");
  for (const c of counts) console.log(`stage ${c.stage}: ${c.tx_count} transactions`);
  console.log(`manifest: ${a.out}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(String(e.message ?? e));
    process.exit(1);
  });
}
