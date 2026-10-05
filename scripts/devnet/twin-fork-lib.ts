// Canonical: core issues 1498, 1496. Owner decision 2026-10-05: the Twin chain (id 918453) is a
// pinned lazy fork of real Base state made with anvil. No warm list, no state dump, no patching.
// Pure helpers and thin JSON-RPC client for scripts/devnet/twin-fork.ts. Never logs a full URL.
import { spawn } from "node:child_process";

export const TWIN_CHAIN_ID = 918453;
export const BASE_CHAIN_ID = 8453;
export const DEFAULT_UPSTREAM = "https://mainnet.base.org";
export const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** FiatTokenV2 `balanceAndBlacklistStates` mapping(address => uint256) lives at storage slot 9. */
export const USDC_BALANCE_SLOT = 9n;
export const PIN_BACK_OFF_BLOCKS = 2;

// ---------------------------------------------------------------- keccak256 (pure, no deps)
const MASK = (1n << 64n) - 1n;
const RC: bigint[] = [];
const ROT: number[][] = [
  [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
];
(() => {
  let r = 1;
  for (let i = 0; i < 24; i++) {
    let c = 0n;
    for (let j = 0; j < 7; j++) {
      if (r & 1) c |= 1n << BigInt((1 << j) - 1);
      r = r & 0x80 ? (r << 1) ^ 0x171 : r << 1;
    }
    RC.push(c);
  }
})();
const rotl = (x: bigint, n: number) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK);
function keccakF(s: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const C = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) s[x + 5 * y] ^= d;
    }
    const B: bigint[] = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x][y]);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) s[x + 5 * y] = B[x + 5 * y] ^ (~B[(x + 1) % 5 + 5 * y] & MASK & B[(x + 2) % 5 + 5 * y]);
    s[0] ^= RC[round];
  }
}
export function keccak256(data: Uint8Array): string {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s: bigint[] = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  let out = "";
  for (let i = 0; i < 4; i++)
    for (let b = 0; b < 8; b++) out += Number((s[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, "0");
  return "0x" + out;
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
export const pad32 = (hexNo0x: string) => hexNo0x.padStart(64, "0");

export function isAddress(a: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

/** Storage slot of balanceAndBlacklistStates[holder]: keccak256(pad32(holder) ++ pad32(9)). */
export function usdcBalanceSlot(holder: string): string {
  if (!isAddress(holder)) throw new Error(`not an address: ${holder}`);
  return keccak256(hexToBytes(pad32(holder.slice(2).toLowerCase()) + pad32(USDC_BALANCE_SLOT.toString(16))));
}
/** Slot value: balance in the low 255 bits, blacklist flag in bit 255 (always clear here). */
export function usdcBalanceWord(units: bigint): string {
  if (units < 0n || units >= 1n << 255n) throw new Error("USDC units out of range");
  return "0x" + pad32(units.toString(16));
}

// ---------------------------------------------------------------- redaction
/** Host only. A URL may carry a key in its path, query or userinfo, so none of those is ever kept. */
export function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}
/** Replace every URL in free text with its host, so errors and logs cannot leak a key. */
export function redact(text: string, extra: string[] = []): string {
  let out = text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, (m) => `<${urlHost(m)}>`);
  for (const s of extra) if (s.length >= 4) out = out.split(s).join("<redacted>");
  return out;
}

// ---------------------------------------------------------------- anvil argv
export interface StartOptions {
  port: number;
  chainId: number;
  upstream: string;
  pinBlock: number;
  host?: string;
  retries: number;
  forkRetryBackoffMs: number;
  computeUnitsPerSecond: number;
  timeoutMs?: number;
  /** Seconds between blocks (anvil --block-time). Unset means mine on transaction only. */
  blockTimeSec?: number;
}
export function buildAnvilArgv(o: StartOptions): string[] {
  if (!Number.isInteger(o.pinBlock) || o.pinBlock <= 0) throw new Error("pinBlock must be a positive integer");
  if (!Number.isInteger(o.port) || o.port <= 0 || o.port > 65535) throw new Error("bad port");
  const argv = [
    "--fork-url", o.upstream,
    "--fork-block-number", String(o.pinBlock),
    "--chain-id", String(o.chainId),
    "--port", String(o.port),
    "--host", o.host ?? "127.0.0.1",
    "--retries", String(o.retries),
    "--fork-retry-backoff", String(o.forkRetryBackoffMs),
    "--compute-units-per-second", String(o.computeUnitsPerSecond),
    "--quiet",
  ];
  if (o.timeoutMs) argv.push("--timeout", String(o.timeoutMs));
  if (o.blockTimeSec) argv.push("--block-time", String(o.blockTimeSec));
  return argv;
}
/** The same argv with the upstream replaced by its host, safe to print. */
export function redactArgv(argv: string[]): string[] {
  return argv.map((a, i) => (argv[i - 1] === "--fork-url" ? `<${urlHost(a)}>` : a));
}

// ---------------------------------------------------------------- RPC
export type Fetcher = typeof fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RpcOpts { fetcher?: Fetcher; retries?: number; baseDelayMs?: number; secrets?: string[] }

/** JSON-RPC call with retry on HTTP 429/5xx and network errors, exponential backoff. Errors are redacted. */
export async function rpc(url: string, method: string, params: unknown[] = [], opts: RpcOpts = {}): Promise<any> {
  const f = opts.fetcher ?? fetch;
  const retries = opts.retries ?? 6;
  const base = opts.baseDelayMs ?? 500;
  let last = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (res.status === 429 || res.status >= 500) {
        last = `HTTP ${res.status} from ${urlHost(url)}`;
      } else {
        const j: any = await res.json();
        if (j.error) throw new Error(`rpc ${method} error: ${redact(String(j.error.message ?? JSON.stringify(j.error)), opts.secrets)}`);
        return j.result;
      }
    } catch (e: any) {
      if (String(e?.message).startsWith("rpc ")) throw e;
      last = `${method} failed at ${urlHost(url)}: ${redact(String(e?.message ?? e), opts.secrets)}`;
    }
    if (attempt < retries) await sleep(base * 2 ** attempt);
  }
  throw new Error(`rpc ${method} gave up after ${retries + 1} attempts: ${last}`);
}

export interface PinInfo { block: number; hash: string; timestamp: number; upstreamHost: string }

/** auto = upstream head minus 2. A numeric pin is used as is. Hash and timestamp come from the upstream. */
export async function selectPin(upstream: string, pin: string | number, opts: RpcOpts = {}): Promise<PinInfo> {
  let block: number;
  if (pin === "auto") {
    const head = parseInt(await rpc(upstream, "eth_blockNumber", [], opts), 16);
    block = head - PIN_BACK_OFF_BLOCKS;
  } else {
    block = Number(pin);
    if (!Number.isInteger(block) || block <= 0) throw new Error(`bad --pin-block: ${pin}`);
  }
  const b = await rpc(upstream, "eth_getBlockByNumber", ["0x" + block.toString(16), false], opts);
  if (!b) throw new Error(`upstream ${urlHost(upstream)} has no block ${block}`);
  return { block, hash: b.hash, timestamp: parseInt(b.timestamp, 16), upstreamHost: urlHost(upstream) };
}

// ---------------------------------------------------------------- warp, fund
export async function assertNotBaseMainnet(url: string, opts: RpcOpts = {}): Promise<number> {
  const id = parseInt(await rpc(url, "eth_chainId", [], opts), 16);
  if (id === BASE_CHAIN_ID) throw new Error(`refusing: ${urlHost(url)} reports chain id ${BASE_CHAIN_ID} (Base mainnet)`);
  return id;
}
export async function warp(url: string, seconds: number, opts: RpcOpts = {}): Promise<{ timestamp: number }> {
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error("warp seconds must be a positive integer");
  await assertNotBaseMainnet(url, opts);
  await rpc(url, "evm_increaseTime", [seconds], opts);
  await rpc(url, "evm_mine", [], opts);
  const b = await rpc(url, "eth_getBlockByNumber", ["latest", false], opts);
  return { timestamp: parseInt(b.timestamp, 16) };
}
export function ethToWei(eth: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(eth);
  if (!m) throw new Error(`bad eth amount: ${eth}`);
  return BigInt(m[1]) * 10n ** 18n + BigInt((m[2] ?? "").padEnd(18, "0"));
}
export async function fundGas(url: string, addr: string, eth: string, opts: RpcOpts = {}): Promise<bigint> {
  if (!isAddress(addr)) throw new Error(`not an address: ${addr}`);
  await assertNotBaseMainnet(url, opts);
  const wei = ethToWei(eth);
  await rpc(url, "anvil_setBalance", [addr, "0x" + wei.toString(16)], opts);
  return BigInt(await rpc(url, "eth_getBalance", [addr, "latest"], opts));
}
export async function usdcBalanceOf(url: string, addr: string, opts: RpcOpts = {}): Promise<bigint> {
  const data = "0x70a08231" + pad32(addr.slice(2).toLowerCase());
  return BigInt(await rpc(url, "eth_call", [{ to: USDC, data }, "latest"], opts));
}
/** Sets the real FiatToken balance slot, then verifies with balanceOf. totalSupply is left alone. */
export async function fundUsdc(url: string, addr: string, units: bigint, opts: RpcOpts = {}): Promise<bigint> {
  await assertNotBaseMainnet(url, opts);
  await rpc(url, "anvil_setStorageAt", [USDC, usdcBalanceSlot(addr), usdcBalanceWord(units)], opts);
  const got = await usdcBalanceOf(url, addr, opts);
  if (got !== units) throw new Error(`USDC balanceOf ${got} != requested ${units}; slot layout may have changed`);
  return got;
}

// ---------------------------------------------------------------- wait, process
/** With allowAhead (a fork that mines on a timer) the head may already be past the pin. */
export async function waitReady(url: string, pinBlock: number, timeoutMs: number, chainId = TWIN_CHAIN_ID, allowAhead = false): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no answer";
  while (Date.now() < deadline) {
    try {
      const id = parseInt(await rpc(url, "eth_chainId", [], { retries: 0 }), 16);
      const n = parseInt(await rpc(url, "eth_blockNumber", [], { retries: 0 }), 16);
      if (id === chainId && (n === pinBlock || (allowAhead && n > pinBlock))) return;
      last = `chain id ${id}, block ${n}`;
    } catch (e: any) {
      last = String(e?.message ?? e);
    }
    await sleep(500);
  }
  throw new Error(`not ready within ${timeoutMs} ms (last: ${last}; want chain ${chainId}, block ${pinBlock})`);
}

export function spawnAnvilDetached(argv: string[], env: Record<string, string>, logPath: string): number {
  const fs = require("node:fs");
  const fd = fs.openSync(logPath, "a", 0o600);
  const child = spawn("anvil", argv, { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, ...env } });
  child.unref();
  if (!child.pid) throw new Error("anvil failed to spawn");
  return child.pid;
}
