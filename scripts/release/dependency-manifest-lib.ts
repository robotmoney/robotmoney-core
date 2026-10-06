/**
 * Third-party dependency manifest (core issue 1497, nightly job (c)).
 *
 * A release records, per chain id, every third-party address our deploy config
 * names, its code hash, its proxy implementation (address and code hash) when it
 * is a proxy, and the block it was read at. The nightly diff reads the same
 * values live and reports every change. No second address list exists: the
 * addresses come from the deploy config files named in ADDRESS_SOURCES.
 *
 * No secret, no key. The live reader uses a public JSON-RPC endpoint.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { SAFE_SET } from "../devnet/safe-set.ts";

// ---------------------------------------------------------------- keccak-256
const MASK = (1n << 64n) - 1n;
const RC: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [
  [0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14],
];
const rotl = (v: bigint, n: number): bigint => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);

function keccakF(s: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    const c: bigint[] = [];
    for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) s[x + 5 * y] ^= d;
    }
    const b: bigint[] = new Array(25).fill(0n);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x][y]);
    for (let x = 0; x < 5; x++)
      for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y] ^ (~b[(x + 1) % 5 + 5 * y] & MASK & b[(x + 2) % 5 + 5 * y]);
    s[0] ^= RC[round];
  }
}

/** Keccak-256 (Ethereum, 0x01 padding) of bytes, as 0x-prefixed lowercase hex. */
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
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  let out = "";
  for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) out += Number((s[i] >> BigInt(8 * j)) & 0xffn).toString(16).padStart(2, "0");
  return "0x" + out;
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Code hash of a deployed bytecode hex string; null when there is no code. */
export function codeHashOf(codeHex: string): string | null {
  return codeHex === "0x" || codeHex === "" ? null : keccak256(hexToBytes(codeHex));
}

// ----------------------------------------------------------- address sources
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const NEAR_ADDRESS_RE = /^0x[0-9a-fA-F]{36,44}$/;

export interface Dependency {
  address: string; // lowercase
  label: string;
  source: string; // repo-relative file
}
export interface CollectResult {
  deps: Dependency[];
  warnings: string[];
}

/**
 * JSON config files that hold third-party addresses. Each is one map for every chain
 * (one deployment scheme), so the whole file is walked and the chain id does not select a section.
 */
export const JSON_ADDRESS_SOURCES: { file: string }[] = [
  { file: "config/dex-pools.json" },
  { file: "config/protocol-assets.json" },
  { file: "config/rwa-assets.json" },
  { file: "config/agent-token-shortlist.json" },
];
/** Solidity deploy scripts: `address ... constant NAME = 0x...;` lines are third-party pins. */
export const SOLIDITY_SCRIPT_DIR = "contracts/script";
/** Safe factory, singletons, fallback handler and MultiSend: the pinned set the Safe checker already holds. */
export const SAFE_SET_FILE = "scripts/devnet/safe-set.ts";

function walk(node: unknown, path: string, out: { address: string; label: string }[], warn: string[], file: string): void {
  if (typeof node === "string") {
    if (ADDRESS_RE.test(node)) out.push({ address: node.toLowerCase(), label: path });
    else if (NEAR_ADDRESS_RE.test(node)) warn.push(`${file} ${path}: ${node} looks like an address but is not 40 hex digits`);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`, out, warn, file));
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k.startsWith("$") || k === "description" || k === "note" || k.startsWith("$comment")) continue;
      walk(v, path ? `${path}.${k}` : k, out, warn, file);
    }
  }
}

export function collectThirdPartyAddresses(repoRoot: string, _chainId?: number): CollectResult {
  const root = resolve(repoRoot);
  const found: Dependency[] = [];
  const warnings: string[] = [];

  for (const src of JSON_ADDRESS_SOURCES) {
    const p = join(root, src.file);
    if (!existsSync(p)) continue;
    const json = JSON.parse(readFileSync(p, "utf8")) as unknown;
    const hits: { address: string; label: string }[] = [];
    walk(json, "", hits, warnings, src.file);
    for (const h of hits) found.push({ ...h, source: src.file });
  }

  const scriptDir = join(root, SOLIDITY_SCRIPT_DIR);
  if (existsSync(scriptDir)) {
    const re = /address\s+(?:public\s+|internal\s+|private\s+)?constant\s+([A-Za-z0-9_]+)\s*=\s*(0x[0-9a-fA-F]{40})\s*;/g;
    for (const f of readdirSync(scriptDir).sort()) {
      if (!/^Deploy.*\.s\.sol$/.test(f) || f.startsWith("DeployDemo")) continue;
      const text = readFileSync(join(scriptDir, f), "utf8");
      for (const m of text.matchAll(re)) found.push({ address: m[2].toLowerCase(), label: m[1], source: `${SOLIDITY_SCRIPT_DIR}/${f}` });
    }
  }

  for (const c of SAFE_SET) found.push({ address: c.address.toLowerCase(), label: c.name, source: SAFE_SET_FILE });

  // De-duplicate by address; keep the first label and join further labels for readability.
  const byAddr = new Map<string, Dependency>();
  for (const d of found) {
    if (d.address === ZERO_ADDRESS) continue;
    const prev = byAddr.get(d.address);
    if (!prev) byAddr.set(d.address, { ...d });
    else if (!prev.label.split(" | ").includes(d.label)) prev.label += ` | ${d.label}`;
  }
  return { deps: [...byAddr.values()].sort((a, b) => a.address.localeCompare(b.address)), warnings };
}

// ------------------------------------------------------------------- readers
export interface ChainReader {
  describe(): string;
  chainId(): Promise<number | null>;
  blockNumber(): Promise<number>;
  /** Deployed code as 0x hex, at the latest block or at `block`. */
  code(address: string, block?: number): Promise<string>;
  storageAt(address: string, slot: string, block?: number): Promise<string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function rpcReader(url: string): ChainReader {
  let id = 0;
  async function call(method: string, params: unknown[]): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        });
      } catch (e) {
        if (attempt < 5) { await sleep(500 * 2 ** attempt); continue; }
        throw e;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 6) { await sleep(500 * 2 ** attempt); continue; }
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      const body = (await res.json()) as { result?: unknown; error?: { message: string } };
      if (body.error) throw new Error(`${method}: ${body.error.message}`);
      return body.result;
    }
  }
  const tag = (b?: number) => (b === undefined ? "latest" : "0x" + b.toString(16));
  return {
    describe: () => `rpc ${new URL(url).host}`,
    chainId: async () => parseInt((await call("eth_chainId", [])) as string, 16),
    blockNumber: async () => parseInt((await call("eth_blockNumber", [])) as string, 16),
    code: async (a, b) => (await call("eth_getCode", [a, tag(b)])) as string,
    storageAt: async (a, s, b) => (await call("eth_getStorageAt", [a, s, tag(b)])) as string,
  };
}

// ------------------------------------------------------------------ manifest
/** EIP-1967 implementation slot and the legacy OpenZeppelin slot used by Circle's FiatTokenProxy (USDC). */
export const IMPLEMENTATION_SLOTS: { name: string; slot: string }[] = [
  { name: "eip1967", slot: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" },
  { name: "zeppelinos", slot: "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3" },
];

export interface ManifestEntry {
  address: string;
  label: string;
  source: string;
  codeHash: string | null;
  implementation: string | null;
  implementationSlot: string | null;
  implementationCodeHash: string | null;
}
export interface Manifest {
  schemaVersion: 1;
  chainId: number;
  release: string;
  blockNumber: number;
  recordedAt: string;
  entries: ManifestEntry[];
}

export async function readEntry(reader: ChainReader, dep: Dependency, block?: number): Promise<ManifestEntry> {
  const code = await reader.code(dep.address, block);
  const entry: ManifestEntry = {
    ...dep,
    codeHash: codeHashOf(code),
    implementation: null,
    implementationSlot: null,
    implementationCodeHash: null,
  };
  if (entry.codeHash === null) return entry;
  for (const { name, slot } of IMPLEMENTATION_SLOTS) {
    const v = await reader.storageAt(dep.address, slot, block);
    const hex = v.replace(/^0x/, "").padStart(64, "0");
    const impl = "0x" + hex.slice(24);
    if (impl !== ZERO_ADDRESS && /^0{24}/.test(hex)) {
      entry.implementation = impl.toLowerCase();
      entry.implementationSlot = name;
      entry.implementationCodeHash = codeHashOf(await reader.code(impl, block));
      break;
    }
  }
  return entry;
}

export async function buildManifest(
  reader: ChainReader,
  deps: Dependency[],
  chainId: number,
  release: string,
  now: Date = new Date(),
): Promise<Manifest> {
  const blockNumber = await reader.blockNumber();
  const entries: ManifestEntry[] = [];
  // Pin every read to one block so the manifest is one consistent view.
  const pin = blockNumber;
  for (const d of deps) entries.push(await readEntry(reader, d, pin));
  return { schemaVersion: 1, chainId, release, blockNumber, recordedAt: now.toISOString(), entries };
}

// ---------------------------------------------------------------------- diff
export type ChangeField = "codeHash" | "implementation" | "implementationCodeHash";
export interface Change {
  address: string;
  label: string;
  field: ChangeField;
  old: string | null;
  new: string | null;
  /** First block where the new value was seen, when it could be located; else null. */
  changedAtBlock: number | null;
}

export async function diffManifest(old: Manifest, reader: ChainReader, locate = false): Promise<{ liveBlock: number; changes: Change[] }> {
  const liveBlock = await reader.blockNumber();
  const pin = liveBlock;
  const changes: Change[] = [];
  for (const o of old.entries) {
    const now = await readEntry(reader, o, pin);
    for (const field of ["codeHash", "implementation", "implementationCodeHash"] as ChangeField[]) {
      if (o[field] !== now[field]) {
        const c: Change = { address: o.address, label: o.label, field, old: o[field], new: now[field], changedAtBlock: null };
        if (locate && pin !== undefined) c.changedAtBlock = await locateChange(reader, o, field, old.blockNumber, liveBlock).catch(() => null);
        changes.push(c);
      }
    }
  }
  return { liveBlock, changes };
}

/** Binary search for the first block in (lo, hi] where the field differs from the manifest. Needs archive state. */
async function locateChange(reader: ChainReader, base: ManifestEntry, field: ChangeField, lo: number, hi: number): Promise<number | null> {
  let l = lo, h = hi;
  while (h - l > 1) {
    const mid = Math.floor((l + h) / 2);
    const e = await readEntry(reader, base, mid);
    if (e[field] === base[field]) l = mid;
    else h = mid;
  }
  return h;
}

export function formatReport(m: Manifest, liveBlock: number, changes: Change[]): string {
  const head = `third-party drift: chain ${m.chainId}, release ${m.release}, manifest block ${m.blockNumber}, live block ${liveBlock}`;
  if (changes.length === 0) return `${head}\nno change in ${m.entries.length} dependencies`;
  const lines = changes.map(
    (c) =>
      `CHANGED ${c.address} (${c.label}) ${c.field}: old ${c.old ?? "none"} new ${c.new ?? "none"}` +
      (c.changedAtBlock !== null ? ` at block ${c.changedAtBlock}` : ""),
  );
  return `${head}\n${changes.length} change(s)\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------- manifest IO
export const MANIFEST_DIR = "deployments/dependency-manifests";

export function loadManifest(path: string): Manifest {
  const m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  if (m.schemaVersion !== 1 || !Array.isArray(m.entries) || typeof m.chainId !== "number") throw new Error(`${path}: not a dependency manifest`);
  return m;
}

/** Latest release manifest for a chain id: the highest recordedAt under MANIFEST_DIR/<chainId>/. */
export function latestManifestPath(repoRoot: string, chainId: number): string | null {
  const dir = join(resolve(repoRoot), MANIFEST_DIR, String(chainId));
  if (!existsSync(dir)) return null;
  let best: { p: string; t: string } | null = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const p = join(dir, f);
    const t = loadManifest(p).recordedAt;
    if (!best || t > best.t) best = { p, t };
  }
  return best?.p ?? null;
}

export function argOpt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function makeReader(args: string[]): ChainReader {
  return rpcReader(argOpt(args, "--rpc-url") ?? process.env.BASE_RPC_URL ?? "https://mainnet.base.org");
}

/** The Twin chain (core 1498) is a fork of Base with its own chain id; `--twin` accepts it as the manifest's chain. */
export const TWIN_CHAIN_ID = 918453;
export function chainIdMatches(live: number | null, want: number, args: string[]): boolean {
  return live === null || live === want || (args.includes("--twin") && live === TWIN_CHAIN_ID);
}
