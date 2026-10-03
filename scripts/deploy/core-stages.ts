#!/usr/bin/env bun
// Canonical: the one-deployment-scheme plan, core S3 (issue 1485), core 1493.
//
// The core deploy as data: scripts/deploy/stage-table.json (the one table, read by devops too), one runner. The order is libs, vault, registry,
// router, gateway, governance, ic-policy, proto, agent, rwa (rmPROTO, rmAGENT, rmRWA), then the
// timelock. The router runs BEFORE the gateway because the gateway stores the router as an
// immutable (core 1493). Agent authorization is part of the gateway stage, so it follows the
// gateway. The timelock stage is last: it hands every vault, the gateway, registry, router,
// governance, IC policy and receipt to the timelock and revokes the deployer (core 1487). The
// basket vault eligibility step (ActivateBasketVaultEligibility) is a govern action through the
// timelock after the checks pass, so it is not a stage here.
//
// The timelock stage reads operator inputs from the environment: SAFE_ADDRESS, SAFE_OWNERS,
// SAFE_THRESHOLD, EMERGENCY_ADDRESS, TIMELOCK_MIN_DELAY, RECEIPT_ADMIN_ADDRESS. The Safe is the
// real Safe the driver created with the Safe SDK. This runner never makes one.
//
// This runner is the engine behind the driver's "publish contracts" core stages and the Twin chain
// proof. It does not take a key. The caller passes signer flags through (`--forge-arg`), for
// example `--forge-arg --account --forge-arg rehearsal-deployer` or `--forge-arg --unlocked
// --forge-arg --sender --forge-arg 0x...` against a dev node. A secret never goes in an argument.
//
// Usage:
//   bun scripts/deploy/core-stages.ts --rpc-url URL --out MANIFEST.json [--counts COUNTS.json]
//        [--dry-run] [--forge-arg ARG]... [--stages libs,vault,...]
//        [--agent-arg ARG]... [--receiver-arg ARG]... [--proof-dir DIR]
// The Twin chain proofs run in the same pass, right after the stage they prove (see PROOFS):
//   after gateway   scripts/deploy/assert-core-router.ts   (router deposit and withdraw through the gateway;
//                   it signs as the agent and the share receiver, so --agent-arg and --receiver-arg are required)
//   after rwa       scripts/deploy/assert-basket-vaults.ts (registry lists four vaults, baskets paused, config equals chain)
//   after timelock  scripts/deploy/assert-timelock-roles.ts (the timelock holds every role, the deployer holds none)
// A failing proof stops the run with a non-zero exit. A proof whose stage did not run is not run.
// Inputs come from the environment, the same names the scripts read (ADMIN_ADDRESS, PAUSER_ADDRESS,
// AGENT_ADDRESS, SHARE_RECEIVER_ADDRESS, FEE_RECIPIENT, SEED_SHARE_RECEIVER, TVL_CAP,
// PER_DEPOSIT_CAP, EXIT_FEE_BPS, VAULT_NAME, AGENT_*). The runner sets DEPLOYMENT_OUT, VAULT_ADDRESS, REGISTRY_ADDRESS
// and ROUTER_ADDRESS per stage from the stage manifests.
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type StageName =
  | "libs"
  | "vault"
  | "registry"
  | "router"
  | "gateway"
  | "governance"
  | "ic-policy"
  | "proto"
  | "agent"
  | "rwa"
  | "timelock";

/** One row of scripts/deploy/stage-table.json (version 1), the interface devops reads. */
export interface TableStage {
  name: StageName;
  kind: "forge";
  script: string;
  requiredEnv: string[];
  optionalEnv: string[];
  manifest: string;
  libraries: string[];
  vault: "USDC" | "PROTO" | "AGENT" | "RWA" | null;
}
export interface TableLibrary {
  name: string;
  artifact: string;
  manifestKey: string;
  /** Source path used for `forge script --libraries path:artifact:address`. */
  path?: string;
}
export interface StageTable {
  version: 1;
  stages: TableStage[];
  vaults: { key: string; stage: string; artifact: string; manifest: string }[];
  libraries: TableLibrary[];
  artifacts: Record<string, string>;
}

export const TABLE_PATH = join(import.meta.dir, "stage-table.json");

/** Reads the stage table: the one source of truth for stage names, scripts, env and manifests. */
export function loadStageTable(path: string = TABLE_PATH): StageTable {
  const t = JSON.parse(readFileSync(path, "utf8")) as StageTable;
  if (t.version !== 1) throw new Error(`stage-table.json version ${t.version} is not supported`);
  return t;
}

export interface Stage {
  name: StageName;
  /** forge script target, path:Contract */
  target: string;
  /** manifest keys this stage must read from earlier stages, mapped to the env var it sets */
  needs: Record<string, string>;
  /** manifest keys the stage must write */
  writes: string[];
  /** Prefix for every key this stage's manifest adds to the merged manifest (basket vaults). */
  ns?: string;
  /** Extra env computed from the merged manifest (the timelock's VAULT_ADDRESSES). */
  computed?: (m: Record<string, unknown>) => Record<string, string>;
  /** Operator inputs the stage reads from the environment. Checked before it runs. */
  requiredEnv?: string[];
  /** Manifest file name from the table (the basename of the manifest template). */
  manifestFile: string;
  /** Libraries to link, from the table. */
  libraries: TableLibrary[];
}

/** The merged-manifest key a stage's raw key lands under. */
export const keyOf = (s: Stage, k: string): string => (s.ns ? `${s.ns}_${k}` : k);

const BASKET_NEEDS = { registry: "REGISTRY_ADDRESS" };
const BASKET_WRITES = ["vault", "registry", "adapter", "registered", "paused", "assets"];

/** Every vault the timelock hands over, in registry order: rmUSDC, rmPROTO, rmAGENT, rmRWA. */
export function vaultAddresses(m: Record<string, unknown>): string[] {
  const keys = ["vault", "protocol_vault", "agent_vault", "rwa_vault"];
  return keys.map((k) => {
    const v = m[k];
    if (!v) throw new Error(`merged manifest lacks "${k}": run the vault stages first`);
    return String(v);
  });
}

/**
 * Runner wiring the table does not carry: which earlier manifest keys feed which env var, which
 * keys the stage writes, and the merged-manifest namespace. Keyed by table stage name.
 */
const WIRING: Record<StageName, Pick<Stage, "needs" | "writes" | "ns" | "computed">> = {
  libs: { needs: {}, writes: ["tick_math"] },
  vault: { needs: {}, writes: ["usdc", "vault", "aave_adapter", "compound_adapter", "moonwell_flagship_adapter"] },
  registry: { needs: { vault: "VAULT_ADDRESS" }, writes: ["registry"] },
  router: { needs: { registry: "REGISTRY_ADDRESS", vault: "VAULT_ADDRESS" }, writes: ["router"] },
  gateway: {
    needs: { vault: "VAULT_ADDRESS", router: "ROUTER_ADDRESS" },
    writes: ["gateway", "gateway_router", "gateway_runtime_hash", "agent"],
  },
  governance: { needs: { router: "ROUTER_ADDRESS" }, writes: ["governance"] },
  "ic-policy": { needs: { gateway: "GATEWAY_ADDRESS" }, writes: ["policy", "consensus_receipt"] },
  proto: { needs: BASKET_NEEDS, writes: BASKET_WRITES, ns: "protocol" },
  agent: { needs: BASKET_NEEDS, writes: BASKET_WRITES, ns: "agent" },
  rwa: { needs: BASKET_NEEDS, writes: BASKET_WRITES, ns: "rwa" },
  timelock: {
    needs: {
      gateway: "GATEWAY_ADDRESS",
      registry: "REGISTRY_ADDRESS",
      router: "ROUTER_ADDRESS",
      governance: "GOVERNANCE_ADDRESS",
      policy: "IC_POLICY_ADDRESS",
      consensus_receipt: "CONSENSUS_RECEIPT_ADDRESS",
      agent: "AGENT_ADDRESSES",
    },
    computed: (m) => ({ VAULT_ADDRESSES: vaultAddresses(m).join(",") }),
    writes: ["timelock", "safe", "emergency", "vaults"],
    ns: "timelock",
  },
};

/** Builds the runner stages from the table. Order is the table order. */
export function stagesFromTable(t: StageTable = loadStageTable()): Stage[] {
  return t.stages.map((row) => {
    const w = WIRING[row.name];
    if (!w) throw new Error(`stage-table.json stage "${row.name}" has no runner wiring in core-stages.ts`);
    return {
      name: row.name,
      target: row.script,
      ...w,
      requiredEnv: row.requiredEnv,
      manifestFile: row.manifest.split("/").pop()!,
      libraries: row.libraries.map((n) => {
        const lib = t.libraries.find((l) => l.name === n);
        if (!lib) throw new Error(`stage ${row.name} links unknown library "${n}"`);
        return lib;
      }),
    };
  });
}

/** The stage table. Order is the deploy order. */
export const STAGES: Stage[] = stagesFromTable();

/** A Twin chain proof the runner runs right after the stage it proves. */
export interface Proof {
  name: string;
  after: StageName;
  script: string;
  /** Flags the caller must pass for this proof (signer flags for the router proof). */
  needs?: ("agentArgs" | "receiverArgs")[];
}

export const PROOFS: Proof[] = [
  { name: "router", after: "gateway", script: "scripts/deploy/assert-core-router.ts", needs: ["agentArgs", "receiverArgs"] },
  { name: "basket", after: "rwa", script: "scripts/deploy/assert-basket-vaults.ts" },
  { name: "timelock-roles", after: "timelock", script: "scripts/deploy/assert-timelock-roles.ts" },
];

export interface ProofContext {
  rpc: string;
  manifest: string;
  out: string;
  agentArgs: string[];
  receiverArgs: string[];
  env: Record<string, string | undefined>;
}

/** The argument list for one proof script. Throws, naming the missing input, when one is absent. */
export function proofArgs(p: Proof, c: ProofContext): string[] {
  const base = ["--rpc-url", c.rpc, "--manifest", c.manifest, "--out", c.out];
  for (const need of p.needs ?? []) {
    if (c[need].length === 0) {
      const flag = need === "agentArgs" ? "--agent-arg" : "--receiver-arg";
      throw new Error(`proof ${p.name} needs ${flag} (signer flags for ${need === "agentArgs" ? "the agent" : "the share receiver"})`);
    }
  }
  if (p.name === "router") {
    return [...base, ...c.agentArgs.flatMap((x) => ["--agent-arg", x]), ...c.receiverArgs.flatMap((x) => ["--receiver-arg", x])];
  }
  if (p.name === "timelock-roles") {
    const need = (n: string): string => {
      const v = c.env[n];
      if (!v) throw new Error(`proof ${p.name} needs ${n} in the environment`);
      return v;
    };
    return [...base, "--deployer", need("ADMIN_ADDRESS"), "--safe", need("SAFE_ADDRESS"), "--emergency", need("EMERGENCY_ADDRESS"), "--min-delay", need("TIMELOCK_MIN_DELAY")];
  }
  return base;
}

/** Proofs to run after `stage`, given which stages ran. */
export function proofsAfter(stage: StageName): Proof[] {
  return PROOFS.filter((p) => p.after === stage);
}

/** Throws when the stage table breaks the rule: every stage's inputs come from an earlier stage. */
export function assertStageOrder(stages: Stage[] = STAGES): void {
  const produced = new Set<string>();
  for (const s of stages) {
    for (const key of Object.keys(s.needs)) {
      if (!produced.has(key)) throw new Error(`stage ${s.name} needs "${key}", which no earlier stage writes`);
    }
    for (const k of s.writes) produced.add(keyOf(s, k));
  }
  const names = stages.map((s) => s.name);
  const router = names.indexOf("router");
  const gateway = names.indexOf("gateway");
  if (router < 0 || gateway < 0 || router > gateway) throw new Error("the router stage must come before the gateway stage");
  if (names.includes("timelock") && names.indexOf("timelock") !== names.length - 1) {
    throw new Error("the timelock stage must be last: it revokes the deployer");
  }
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
  const a = {
    rpc: "", out: "", counts: "", proofDir: "", dryRun: false,
    forgeArgs: [] as string[], agentArgs: [] as string[], receiverArgs: [] as string[], only: [] as string[],
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--rpc-url") a.rpc = argv[++i];
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--counts") a.counts = argv[++i];
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--forge-arg") a.forgeArgs.push(argv[++i]);
    else if (k === "--stages") a.only = argv[++i].split(",");
    else if (k === "--agent-arg") a.agentArgs.push(argv[++i]);
    else if (k === "--receiver-arg") a.receiverArgs.push(argv[++i]);
    else if (k === "--proof-dir") a.proofDir = argv[++i];
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.rpc || !a.out) throw new Error("--rpc-url and --out are required");
  for (const f of [...a.forgeArgs, ...a.agentArgs, ...a.receiverArgs]) {
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

  // Refuse before any broadcast when a proof that will run lacks an input.
  if (!a.dryRun) {
    for (const p of PROOFS) {
      if (a.only.length && !a.only.includes(p.after)) continue;
      proofArgs(p, { rpc: a.rpc, manifest: "-", out: "-", agentArgs: a.agentArgs, receiverArgs: a.receiverArgs, env: process.env });
    }
  }

  for (const stage of STAGES) {
    if (a.only.length && !a.only.includes(stage.name)) continue;
    const env: Record<string, string> = { DEPLOYMENT_OUT: join(work, stage.manifestFile) };
    const m = merged();
    for (const [key, envName] of Object.entries(stage.needs)) env[envName] = String(m[key]);
    if (stage.computed && !a.dryRun) Object.assign(env, stage.computed(m));
    // A required name is satisfied by the operator environment or by an earlier stage's manifest.
    const derived = new Set([...Object.values(stage.needs), ...(stage.computed ? ["VAULT_ADDRESSES"] : [])]);
    for (const name of stage.requiredEnv ?? []) {
      if (!process.env[name] && !env[name] && !(a.dryRun && derived.has(name))) {
        throw new Error(`stage ${stage.name} needs ${name} in the environment`);
      }
    }
    const link = stage.libraries.flatMap((l) => {
      const addr = m[l.manifestKey];
      if (!addr) throw new Error(`stage ${stage.name} links ${l.name} but no earlier stage wrote "${l.manifestKey}"`);
      return ["--libraries", `${l.path ?? l.artifact}:${l.artifact}:${String(addr)}`];
    });
    const cmd = ["forge", "script", stage.target, "--rpc-url", a.rpc, "--slow", ...link, ...(a.dryRun ? [] : ["--broadcast"]), ...a.forgeArgs];
    const before = a.dryRun ? 0 : await nonce(deployer, a.rpc);
    console.log(`==> stage ${stage.name}`);
    await run(cmd, env);
    const after = a.dryRun ? 0 : await nonce(deployer, a.rpc);
    counts.push({ stage: stage.name, start_nonce: before, end_nonce: after, tx_count: after - before });
    if (a.dryRun) continue;
    if (!existsSync(env.DEPLOYMENT_OUT)) throw new Error(`stage ${stage.name} wrote no manifest`);
    const part = JSON.parse(readFileSync(env.DEPLOYMENT_OUT, "utf8"));
    for (const k of stage.writes) if (!(k in part)) throw new Error(`stage ${stage.name} manifest lacks "${k}"`);
    manifests.push(
      stage.ns ? Object.fromEntries(Object.entries(part).map(([k, v]) => [keyOf(stage, k), v])) : part,
    );
    for (const proof of proofsAfter(stage.name)) {
      if (stage.name === "gateway") assertGatewayRouter(merged());
      // The proof reads the manifest as it stands after this stage, with the transaction counts so far.
      const manifestSoFar = join(work, `manifest-after-${stage.name}.json`);
      writeFileSync(manifestSoFar, JSON.stringify({ ...merged(), stages: counts }, null, 2) + "\n");
      const proofOut = join(a.proofDir || dirname(a.out), `proof-${proof.name}.json`);
      const args = proofArgs(proof, { rpc: a.rpc, manifest: manifestSoFar, out: proofOut, agentArgs: a.agentArgs, receiverArgs: a.receiverArgs, env: process.env });
      console.log(`==> proof ${proof.name} (after stage ${stage.name})`);
      console.log((await run(["bun", proof.script, ...args], {})).trimEnd());
    }
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
