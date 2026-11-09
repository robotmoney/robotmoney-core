#!/usr/bin/env bun
// One-vault experiment (docs/technical/one-vault-rebalancer-proposal.md).
//
// Records the Base state the prototype tests read, so they replay offline in plain `forge test`.
//
//   bun scripts/prototype/record-base-fixture.ts [--pin N] [--rpc URL] [--match-path GLOB]
//
// 1. Picks a pin (upstream head minus 2 unless --pin is given). The public node is not an archive
//    node, so record soon after picking a pin.
// 2. Runs the prototype tests in record mode (PROTO_RECORD_RPC, PROTO_PIN). Forge forks Base at the
//    pin and, when it exits, writes the original value of every account and slot it fetched to
//    ~/.foundry/cache/rpc/base/<pin>/storage-*.json. The RPC must be a remote URL: forge does not
//    cache localhost forks.
// 3. Converts that cache into contracts/test/prototype/fixtures/base-state.alloc.json (genesis
//    alloc for vm.loadAllocs) and base-state.meta.json (block env, account list, slot index).
// 4. Runs the tests again in replay mode with no RPC, to prove the fixture covers them.
//
// The RPC URL is never written to the fixture or printed. Only the host is recorded.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const rpc = arg("rpc") ?? process.env.BASE_UPSTREAM_RPC ?? "https://mainnet.base.org";
const matchPath = arg("match-path") ?? "contracts/test/prototype/*";
const outDir = "contracts/test/prototype/fixtures";
const host = new URL(rpc).host;

function run(cmd: string[], env: Record<string, string> = {}): string {
  const p = Bun.spawnSync(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString() + p.stderr.toString();
  if (p.exitCode !== 0) {
    console.error(out);
    throw new Error(`${cmd[0]} ${cmd[1] ?? ""} failed (exit ${p.exitCode})`);
  }
  return out;
}

async function headBlock(): Promise<number> {
  const r = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  const j = (await r.json()) as { result: string };
  return Number(BigInt(j.result));
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
run(["forge", "test", "--match-path", matchPath], {
  PROTO_RECORD_RPC: rpc,
  PROTO_PIN: String(pin),
});

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

console.log("replay: running the same tests with no RPC");
const replay = run(["forge", "test", "--match-path", matchPath], {
  PROTO_RECORD_RPC: "",
  PROTO_PIN: "",
});
console.log(replay.split("\n").filter((l) => /Suite result|passed|failed/.test(l)).join("\n"));
