// A world for runner tests: a core checkout fixture, a sheet, frozen counts, stub forge and cast on PATH, a fake signer and a fake Safe API.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getStageTable } from "../src/stages.ts";
import { TABLE_REL } from "../src/stage-table.ts";
import { main, type CliDeps } from "../src/cli.ts";
import type { PublishSigner } from "../src/signer.ts";
import { keccak256 } from "viem";
import { STUB_CODE } from "./stubs/tool.ts";
import { COUNTS, SHA, healthyPoolReader, sheetText, tmp, writeCoreAssetConfig, writeCounts } from "./fixtures.ts";

export const ADMIN = "0x000000000000000000000000000000000000a001";
export const STUB_DIR = join(import.meta.dir, "stubs");
/** Stage name -> script file name, from core's stage table. */
const scriptFiles = (): Record<string, string> => Object.fromEntries(getStageTable().stages.map((s) => [s.name, basename(s.script.split(":")[0]!)]));

/** Stage name -> script file name, for assertions on the recorded spawns. */
export const SCRIPT: Record<string, string> = scriptFiles();

export interface World {
  dir: string; coreDir: string; sheetPath: string; countsDir: string; evidence: string; statePath: string; cfgPath: string; lines: string[];
  cfg: {
    counts: Record<string, number>; sent?: Record<string, number>; failBroadcast?: string; simFails?: string; chainId: number; gitDirty?: string[];
    failBroadcastOutput?: { stdout?: string; stderr?: string }; castReplies?: Record<string, { stdout?: string; stderr?: string; code?: number }>;
  };
  state(): any;
  setNonce(n: number): void;
  run(extraArgs?: string[], over?: Partial<CliDeps> & { chain?: number; env?: Record<string, string | undefined>; signer?: string }): Promise<number>;
  /** The injected dependencies of one run (fake signer, Safe API, chain reader, config-check). `run` is `main(args, deps(over))`. */
  deps(over?: Partial<CliDeps>): CliDeps;
  logs(): any[];
  safeCalls: string[];
  chainEvents: string[];
  /** The fork URL each started preflight chain was given (the target RPC: the vault stages need the real USDC and venues). */
  forkUrls: (string | undefined)[];
  /** Every run of core's config-check the fake saw: the stage it ran for and the environment RPC it was given. */
  coreChecks: { outDir: string; rpc: string; chainId: number }[];
  /** Set a non-zero code to make core's config-check fail. */
  coreCheckCode: number;
}

export interface WorldOpts { /** Reuse this directory (a spawned CLI process rebuilds the same world from it). */ dir?: string; chainId?: number; sheet?: Record<string, string | null>; counts?: Record<string, number>; startNonce?: number; writeSafeManifest?: boolean; writeFrozen?: boolean }

/** The operator and the reviewer type the stage name. */
export function typedPrompt(): (q: string) => Promise<string> {
  let stage = "";
  return async (q) => { const m = /stage '([a-z-]+)'/.exec(q); if (m) stage = m[1]!; return stage; };
}

export function fakeSigner(spec = "keystore:/dev/shm/stub/DEPLOYER"): PublishSigner {
  return {
    spec, kind: "keystore", cleanup() {}, async address() { return ADMIN as `0x${string}`; },
    async forgeArgs() { return ["--keystore", "/dev/shm/stub/DEPLOYER", "--sender", ADMIN]; },
    async safeSigner() { return { kind: "keystore", modes: ["raw"], address: async () => ADMIN } as never; },
  };
}

export function world(o: WorldOpts = {}): World {
  const chainId = o.chainId ?? 918453;
  const dir = o.dir ?? tmp("pc-world-");
  const coreDir = join(dir, "core");
  mkdirSync(join(coreDir, ".git"), { recursive: true });
  writeFileSync(join(coreDir, ".git", "HEAD"), SHA + "\n");
  mkdirSync(join(coreDir, "config"), { recursive: true });
  writeFileSync(join(coreDir, "config", "dex-pools.json"), "{}");
  writeCoreAssetConfig(coreDir);
  mkdirSync(join(coreDir, "scripts", "deploy"), { recursive: true });
  writeFileSync(join(coreDir, TABLE_REL), JSON.stringify(getStageTable()));
  mkdirSync(join(coreDir, "scripts", "ci"), { recursive: true });
  writeFileSync(join(coreDir, "scripts", "ci", "config-check.ts"), "// fixture: the real one is core's\n");
  writeFileSync(join(coreDir, "foundry.toml"), 'optimizer_runs = 100\nevm_version = "cancun"\n');
  const sheetPath = join(dir, "sheet.env");
  const delay = chainId === 8453 ? "172800" : "60";
  writeFileSync(sheetPath, sheetText({ CHAIN_ID: String(chainId), EXPECTED_CHAIN_ID: String(chainId), TIMELOCK_MIN_DELAY: delay, GOVERN_NEW_DELAY: chainId === 8453 ? "172800" : "3600", ...(o.sheet ?? {}) }));
  const counts = o.counts ?? COUNTS;
  const countsDir = join(dir, "frozen");
  if (o.writeFrozen !== false) writeCounts(countsDir, SHA, counts);
  const cfgPath = join(dir, "stub-config.json");
  const statePath = join(dir, "stub-state.json");
  const cfg: World["cfg"] = { chainId, counts: Object.fromEntries(Object.entries(scriptFiles()).map(([stage, f]) => [f, counts[stage] ?? 0])) };
  const write = () => writeFileSync(cfgPath, JSON.stringify(cfg));
  write();
  const w: World = {
    dir, coreDir, sheetPath, countsDir, evidence: join(dir, "evidence"), statePath, cfgPath, lines: [], cfg, safeCalls: [], chainEvents: [], forkUrls: [], coreChecks: [], coreCheckCode: 0,
    state() { try { return JSON.parse(readFileSync(statePath, "utf8")); } catch { return { nonces: {}, calls: [] }; } },
    setNonce(n) { const s = w.state(); s.nonces = { ...(s.nonces ?? {}), [ADMIN.toLowerCase()]: n }; s.calls ??= []; writeFileSync(statePath, JSON.stringify(s)); },
    logs() { return w.lines.map((l) => JSON.parse(l)); },
    deps(over = {}) {
      return {
        cwd: dir, logSink: (l) => w.lines.push(l), prompt: typedPrompt(),
        makeSigner: () => fakeSigner(), coreConfigCheck: async (i) => { w.coreChecks.push({ outDir: i.outDir, rpc: i.rpc, chainId: i.chainId }); return w.coreCheckCode === 0 ? { code: 0, output: "PASS  fixture\nconfig-check: ok" } : { code: w.coreCheckCode, output: "FAIL  fixture  pool-fee-equals-config\nconfig-check: 1 failure(s)" }; }, chainReader: () => healthyPoolReader(), usdcCodeHash: keccak256(STUB_CODE as `0x${string}`), correlatedOwners: async () => [], safeApi: fakeSafeApi(w), startChain: fakeChain(w), ...over,
      };
    },
    async run(extra = [], overAll = {}) {
      write();
      const { chain: chainOver, signer: signerOver, env: envOver, ...over } = overAll;
      const chain = chainOver ?? chainId;
      const env: Record<string, string | undefined> = {
        PATH: `${STUB_DIR}:${process.env.PATH}`, HOME: process.env.HOME, STUB_STATE: statePath, STUB_CONFIG: cfgPath, ...(envOver ?? {}),
      };
      const args = ["--chain", String(chain), "--rpc", "http://rpc.test:8545", "--sheet", sheetPath, "--signer", signerOver ?? "keystore:/dev/shm/stub/DEPLOYER",
        "--environment", "local", "--core-sha", SHA, "--core-dir", coreDir, "--counts-dir", countsDir, "--evidence", w.evidence, ...extra];
      return main(args, w.deps({ env, ...over }));
    },
  };
  if (o.startNonce !== undefined) w.setNonce(o.startNonce);
  if (o.writeSafeManifest) {
    mkdirSync(join(coreDir, "deployments", String(chainId)), { recursive: true });
    writeFileSync(join(coreDir, "deployments", String(chainId), "safe.json"), JSON.stringify({ safe: "0x00000000000000000000000000000000000050fe" }));
  }
  return w;
}

/** A fake of the Safe tool's creation entry points: sends nothing, bumps the stub deployer nonce by one like a real creation. */
export function fakeSafeApi(w: World): NonNullable<CliDeps["safeApi"]> {
  return {
    async createSafe(opts: any): Promise<any> {
      w.safeCalls.push("createSafe");
      const plan = { chainId: opts.chainId, deployer: ADMIN, owners: opts.owners, threshold: opts.threshold, version: "1.4.1", predictedAddress: "0x00000000000000000000000000000000000050fe", saltNonce: "1", factory: ADMIN, singleton: ADMIN, fallbackHandler: ADMIN, estimatedGas: 1n };
      if (opts.dryRun) return { plan, created: false };
      if (opts.rpcUrl === LOCAL_RPC) { w.safeCalls.push("createSafe:local"); return { plan, created: true, manifest: { safe: plan.predictedAddress, version: "1.4.1", threshold: opts.threshold, owners: opts.owners, tx_hash: `0x${"cd".repeat(32)}`, block: 7, chain_id: opts.chainId } }; }
      if (opts.confirm && !(await opts.confirm(plan))) throw new Error("not confirmed");
      if (w.cfg.failBroadcast === "safe") throw new Error("creation died after the confirm");
      const s = w.state(); s.nonces[ADMIN.toLowerCase()] = (s.nonces[ADMIN.toLowerCase()] ?? 0) + 1; writeFileSync(w.statePath, JSON.stringify(s));
      return { plan, created: true, manifest: { safe: plan.predictedAddress, version: "1.4.1", threshold: opts.threshold, owners: opts.owners, tx_hash: `0x${"cd".repeat(32)}`, block: 7, chain_id: opts.chainId } };
    },
    async connectSafe(opts: any) { w.safeCalls.push("connectSafe"); return { address: opts.safeAddress } as any; },
    async verifyCreatedSafe() { w.safeCalls.push("verifyCreatedSafe"); },
  };
}

/** The local chain of a dry run, as a test double: it hands out a loopback URL that is not the target RPC and records the fork URL it was given and stop. */
export const LOCAL_RPC = "http://127.0.0.1:18546"; // not core's default RPC (18545): a run against that one is the target
export function fakeChain(w: World): NonNullable<CliDeps["startChain"]> {
  return async (_id, forkUrl) => { w.chainEvents.push("start"); w.forkUrls.push(forkUrl); return { rpc: LOCAL_RPC, stop: async () => { w.chainEvents.push("stop"); } }; };
}
