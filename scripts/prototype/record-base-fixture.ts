#!/usr/bin/env bun
// One-vault experiment (docs/technical/one-vault-rebalancer-proposal.md).
//
// Records the Base state the prototype tests read, so they replay offline in plain `forge test`.
//
//   bun scripts/prototype/record-base-fixture.ts [--pin N] [--rpc URL] [--match-path GLOB] [--sim]
//                                                [--sim-runs tuned,default,auction,...] [--no-anvil]
//                                                [--forge-out DIR] [--forge-cache DIR] [--threads N]
//
// 1. Picks a pin (upstream head minus 2 unless --pin is given). The public node is not an archive
//    node, so record soon after picking a pin.
// 2. Starts its own anvil, forked from the upstream RPC at the pin, on a free port of 127.0.0.2.
//    Every record pass reads through it, so each account and slot crosses the network once. The
//    address is 127.0.0.2, not localhost or 127.0.0.1, because forge does not cache forks of those.
//    The script owns this process: it stops it when recording ends, on any error, and on SIGINT or
//    SIGTERM. --no-anvil records straight from the upstream RPC instead.
// 3. Runs the prototype tests in record mode (PROTO_RECORD_RPC, PROTO_PIN). Forge forks at the pin
//    and, when it exits, writes the original value of every account and slot it fetched to
//    ~/.foundry/cache/rpc/base/<pin>. Passes add to the same cache. --sim adds the rebalance sim
//    (PROTO_SIM=1): first the LP re-centre sensitivity passes default-lprecenter and auction-lprecenter
//    (PROTO_SIM_RUN=default or auction with PROTO_SIM_LP=recenter), then one pass with PROTO_SIM_RUN=tuned
//    over the sim tests, then the default pass, then the timed-flow sim (step 3d/3e, PROTO_SIM_FLOWS=timed)
//    for tuned (timed-tuned) and for default with the sim attacks (timed-default, PROTO_SIM_ATTACKS=1, both
//    arms, four seeds), then the auction pass (phase 3c). The last pass also runs every non-sim prototype
//    test. --sim-runs picks a subset, in that order, for debugging only. Forge rewrites the pin's cache on
//    each record, so a subset yields a fixture that covers only that subset. Record the committed fixture
//    with all seven runs.
// 4. Stops anvil. Converts the cache into contracts/test/prototype/fixtures/base-state.alloc.json
//    (genesis alloc for vm.loadAllocs) and base-state.meta.json (block env, account list, slot
//    index).
// 5. Runs the same passes again in replay mode with no RPC and no anvil, with PROTO_FIXTURE_CHECK=1,
//    to prove the fixture covers them. The sim skips that check by default to stay fast, so this
//    pass is where its coverage is proven.
//
// --forge-out and --forge-cache pass --out and --cache-path to every forge run, so a recording does not
// share build directories with other work in the same checkout.
//
// The RPC URL is never written to the fixture or printed. Only the upstream host is recorded.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const rpc = arg("rpc") ?? process.env.BASE_UPSTREAM_RPC ?? "https://mainnet.base.org";
const matchPath = arg("match-path") ?? "contracts/test/prototype/**";
const simPath = "contracts/test/prototype/sim/*";
const withSim = args.includes("--sim");
const useAnvil = !args.includes("--no-anvil");
const SIM_RUNS = [
  "default-lprecenter",
  "auction-lprecenter",
  "tuned",
  "default",
  "timed-tuned",
  "timed-default",
  "auction",
];
const simRuns = (arg("sim-runs") ?? SIM_RUNS.join(",")).split(",").filter((r) => r.length > 0);
for (const r of simRuns) if (!SIM_RUNS.includes(r)) throw new Error(`--sim-runs: unknown run ${r}`);
// --threads N caps forge's test threads (forge -j). On a shared host a recording's forge holds the whole fork in
// memory per thread; fewer threads lower its peak (a host out-of-memory kill shows as a signal below).
const forgeDirs = [
  ...(arg("forge-out") ? ["--out", arg("forge-out")!] : []),
  ...(arg("forge-cache") ? ["--cache-path", arg("forge-cache")!] : []),
  ...(arg("threads") ? ["--threads", arg("threads")!] : []),
];
const outDir = "contracts/test/prototype/fixtures";
const host = new URL(rpc).host;

// A recording runs the committed defaults. These variables change what the sim and attack tests do (findings made to
// fail, flow-parameter or lever overrides, tagged output dirs), so the fixture would not cover the default runs.
const overrides = Object.keys(process.env).filter(
  (k) =>
    k === "PROTO_ATTACK_FINDINGS_FAIL" ||
    k === "PROTO_SIM_TAG" ||
    k === "PROTO_SIM_ATTACK_SEEDS" ||
    k === "PROTO_SIM_ASSETS" ||
    k.startsWith("PROTO_SIM_FLOW_") ||
    k.startsWith("PROTO_LEVER_"),
);
if (overrides.length > 0) throw new Error(`unset before recording: ${overrides.join(", ")}`);

function run(cmd: string[], env: Record<string, string> = {}): string {
  const p = Bun.spawnSync(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString() + p.stderr.toString();
  if (p.exitCode !== 0) {
    console.error(out);
    throw new Error(`${cmd[0]} ${cmd[1] ?? ""} failed (exit ${p.exitCode}, signal ${p.signalCode ?? "none"})`);
  }
  return out;
}

async function blockNumber(url: string): Promise<number> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  const j = (await r.json()) as { result: string };
  return Number(BigInt(j.result));
}

async function headBlock(): Promise<number> {
  return blockNumber(rpc);
}

// ─── anvil, owned by this script ────────────────────────────────────────────────────────────────

let anvil: ReturnType<typeof Bun.spawn> | undefined;

function stopAnvil(): void {
  if (!anvil) return;
  anvil.kill("SIGTERM");
  anvil = undefined;
  console.log("anvil: stopped");
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopAnvil();
    process.exit(130);
  });
}
process.on("exit", stopAnvil);

function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.2", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

async function startAnvil(pin: number): Promise<string> {
  const port = freePort();
  const url = `http://127.0.0.2:${port}`;
  anvil = Bun.spawn(
    [
      "anvil", "--host", "127.0.0.2", "--port", String(port),
      "--fork-url", rpc, "--fork-block-number", String(pin), "--chain-id", "8453",
      "--silent", "--retries", "10", "--fork-retry-backoff", "500",
      "--compute-units-per-second", "10000", "--timeout", "60000",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  for (let i = 0; i < 120; i++) {
    if (anvil.exitCode !== null) throw new Error(`anvil exited early (code ${anvil.exitCode})`);
    try {
      if ((await blockNumber(url)) === pin) {
        console.log(`anvil: forked ${host} at ${pin} on 127.0.0.2:${port}`);
        return url;
      }
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error("anvil did not answer within 60 s");
}

type Pass = { label: string; path: string; env: Record<string, string> };

function passes(): Pass[] {
  if (!withSim) return [{ label: "prototype", path: matchPath, env: {} }];
  const runs = SIM_RUNS.filter((r) => simRuns.includes(r));
  if (runs.length === 0) throw new Error("--sim-runs names no run");
  // "<run>-lprecenter" is PROTO_SIM_RUN=<run> with the LP re-centre sensitivity switch on.
  // "timed-<run>" is the timed-flow sim on the live fund (PROTO_SIM_FLOWS=timed); timed-default also runs the sim
  // attacks (PROTO_SIM_ATTACKS=1). A G8 finding there is skipped, never failed, unless the caller's own
  // environment sets PROTO_ATTACK_FINDINGS_FAIL, which a recording must not do.
  const simEnv = (r: string): Record<string, string> => {
    if (r.endsWith("-lprecenter")) {
      return { PROTO_SIM: "1", PROTO_SIM_RUN: r.slice(0, -"-lprecenter".length), PROTO_SIM_LP: "recenter" };
    }
    if (r.startsWith("timed-")) {
      const run = r.slice("timed-".length);
      return {
        PROTO_SIM: "1",
        PROTO_SIM_RUN: run,
        PROTO_SIM_LP: "static",
        PROTO_SIM_FLOWS: "timed",
        ...(run === "default" ? { PROTO_SIM_ATTACKS: "1" } : {}),
      };
    }
    return { PROTO_SIM: "1", PROTO_SIM_RUN: r, PROTO_SIM_LP: "static" };
  };
  return runs.map((r, i) =>
    i === runs.length - 1
      ? { label: `prototype + sim ${r}`, path: matchPath, env: simEnv(r) }
      : { label: `sim ${r}`, path: simPath, env: simEnv(r) },
  );
}

function pad32(hex: string): string {
  return "0x" + BigInt(hex).toString(16).padStart(64, "0");
}

function readCache(pin: number): any {
  const dir = join(homedir(), ".foundry", "cache", "rpc", "base", String(pin));
  if (!existsSync(dir)) throw new Error(`no forge cache at ${dir}: did the record run fork at the pin?`);
  // Forge 1.8 writes one (zstd) file per block. Older forge writes a directory of storage-*.json.
  const files = statSync(dir).isDirectory()
    ? readdirSync(dir)
        .filter((f) => f.startsWith("storage-"))
        .map((f) => join(dir, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [dir];
  if (files.length === 0) throw new Error(`no storage-*.json in ${dir}`);
  let raw: Uint8Array = readFileSync(files[0]);
  if (raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd) {
    raw = Bun.zstdDecompressSync(raw);
  }
  return JSON.parse(new TextDecoder().decode(raw));
}

function codeOf(code: any): string {
  if (code === null || code === undefined) return "0x";
  if (typeof code === "string") return code;
  if (code.LegacyAnalyzed) {
    const { bytecode, original_len } = code.LegacyAnalyzed;
    return "0x" + bytecode.slice(2, 2 + 2 * Number(original_len));
  }
  if (code.LegacyRaw) return code.LegacyRaw;
  if (code.Eip7702) {
    const e = code.Eip7702;
    if (e.raw) return e.raw;
    return "0xef0100" + String(e.delegated_address).slice(2).toLowerCase();
  }
  throw new Error(`unknown code encoding: ${Object.keys(code).join(",")}`);
}

const pin = arg("pin") ? Number(arg("pin")) : (await headBlock()) - 2;
console.log(`record: pin ${pin} from ${host}`);

// A zero-byte cache file (left by a killed run) would make forge fail to load the cache.
const cachePath = join(homedir(), ".foundry", "cache", "rpc", "base", String(pin));
if (existsSync(cachePath) && statSync(cachePath).isFile() && statSync(cachePath).size === 0) rmSync(cachePath);

try {
  const recordRpc = useAnvil ? await startAnvil(pin) : rpc;
  for (const p of passes()) {
    console.log(`record: ${p.label} (${new Date().toISOString()})`);
    const out = run(["forge", "test", "--match-path", p.path, ...forgeDirs], { ...p.env, PROTO_RECORD_RPC: recordRpc, PROTO_PIN: String(pin) });
    console.log(out.split("\n").filter((l) => /Ran \d+ test suites/.test(l)).join("\n"));
  }
} finally {
  stopAnvil();
}

const cache = readCache(pin);
const env = cache.meta.block_env;
const alloc: Record<string, any> = {};
const accounts: string[] = [];
const slots: string[][] = [];
// Forge's own addresses. Loading them would overwrite the test contract or the cheatcode stub.
const FORGE_INTERNAL = new Set([
  "0x7109709ecfa91a80626ff3989d68f67f5b1dd12d", // cheatcodes
  "0x7fa9385be102ac3eac297483dd6233d62b3e1496", // default test contract
  "0x1804c8ab1f12e6bbf3894d4083f33e07309d1f38", // default sender
  "0x000000000000000000636f6e736f6c652e6c6f67", // console.log
]);
for (const [addr, acct] of Object.entries<any>(cache.accounts)) {
  if (FORGE_INTERNAL.has(addr.toLowerCase())) continue;
  const storage: Record<string, string> = {};
  for (const [k, v] of Object.entries<string>(cache.storage[addr] ?? {})) storage[pad32(k)] = pad32(v);
  alloc[addr] = {
    balance: acct.balance,
    nonce: "0x" + BigInt(acct.nonce).toString(16),
    code: codeOf(acct.code),
    storage,
  };
  accounts.push(addr);
  slots.push(Object.keys(storage).sort());
}
for (const [addr, st] of Object.entries<any>(cache.storage)) {
  if (alloc[addr] || FORGE_INTERNAL.has(addr.toLowerCase())) continue;
  throw new Error(`storage for ${addr} without an account entry in the cache`);
}

const meta = {
  description:
    "One-vault experiment replay fixture. Real Base (8453) state at `block`, recorded by scripts/prototype/record-base-fixture.ts. Holds only the accounts and slots the prototype tests read. Re-record when a test reports FixtureSlotMiss or FixtureAccountMiss.",
  chainId: 8453,
  block: Number(BigInt(env.number)),
  timestamp: Number(BigInt(env.timestamp)),
  basefee: Number(env.basefee),
  upstreamHost: host,
  accounts,
  slots,
};

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "base-state.alloc.json"), JSON.stringify(alloc, null, 1) + "\n");
writeFileSync(join(outDir, "base-state.meta.json"), JSON.stringify(meta, null, 1) + "\n");
console.log(
  `fixture: ${accounts.length} accounts, ${slots.reduce((n, s) => n + s.length, 0)} slots at block ${meta.block}`,
);

// Every replay pass runs, even after one fails, so one run proves (or disproves) the fixture for all of them. The
// fixture is already written; a failed replay pass makes the script exit 1 at the end and names the pass.
const replayFailed: string[] = [];
for (const p of passes()) {
  console.log(`replay: ${p.label}, no RPC and no anvil, coverage check on (${new Date().toISOString()})`);
  const r = Bun.spawnSync(["forge", "test", "--match-path", p.path, ...forgeDirs], {
    env: { ...process.env, ...p.env, PROTO_RECORD_RPC: "", PROTO_PIN: "", PROTO_FIXTURE_CHECK: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const replay = r.stdout.toString() + r.stderr.toString();
  console.log(replay.split("\n").filter((l) => /Suite result|passed|failed|^\[FAIL/.test(l)).join("\n"));
  if (r.exitCode !== 0) {
    replayFailed.push(p.label);
    console.error(`replay: ${p.label} FAILED (exit ${r.exitCode})`);
  }
}
if (replayFailed.length > 0) {
  console.error(`replay failed for: ${replayFailed.join("; ")}`);
  process.exit(1);
}
console.log(`replay: every pass passed (${new Date().toISOString()})`);
