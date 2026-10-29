// A healthy three-vault deployment as in-memory chain state plus manifests and artifacts on disk.
// The FakeChain implements the read-only ChainReader surface. It is a unit-test fixture for verifier logic:
// it proves what the verifier reports for a given chain state. The real-chain proof is the Twin chain run (S9) and the mainnet run (S13).
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { concatHex, decodeFunctionData, encodeFunctionData, keccak256, toFunctionSelector, parseAbi, parseAbiItem, toHex, pad, type Hex as VHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { localSafeTxHash } from "../../src/safe/tx.ts";
import {
  ADMIN_ROLE, RECEIPT_RELEASER_ROLE, WEIGHT_SETTER_ROLE, WEIGHT_SETTER_ROTATOR_ROLE, WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE, coreContracts, stageManifestFile, EMERGENCY_ROLE, DEPOSIT_PAUSER_ROLE, PROPOSER_ROLE, EXECUTOR_ROLE, CANCELLER_ROLE, SAFE_141_FALLBACK_HANDLER, SAFE_FALLBACK_SLOT,
  SAFE_GUARD_SLOT, SAFE_L2_141_SINGLETON, SIG_AGENT_AUTHORIZED, SIG_ROLE_GRANTED, Z32, ZERO,
} from "../../src/verify/constants.ts";
import { PROOF_TX_NONCES } from "../../src/counts.ts";
import { getStageTable } from "../../src/stages.ts";
import { basename, dirname } from "node:path";
import { padTopic } from "../../src/verify/logs.ts";
import { USDC_ADDRESS } from "../../src/usdc.ts";
import type { Address, ChainReader, DeployReceipt, Hex, LogEntry, RawCallResult, VerifyOptions, VerifySheet } from "../../src/verify/types.ts";

export const addr = (n: number): Address => (`0x${n.toString(16).padStart(40, "0")}`) as Address;
export const DEPLOYER = addr(0xde9107e5);
export const PAUSER = addr(0x9a05e5);
export const EMERGENCY = addr(0xe3e5);
/** Real test keys: the control proof (core 1618) is signed for real and the verifier recovers the signers. Public, throwaway, never funded. */
export const OWNER_KEYS = [toHex(0xa1, { size: 32 }), toHex(0xa2, { size: 32 }), toHex(0xa3, { size: 32 })] as const;
export const OWNER_ACCOUNTS = OWNER_KEYS.map((k) => privateKeyToAccount(k));
export const OWNERS = OWNER_ACCOUNTS.map((a) => a.address as Address);
export const PROOF_TX = keccak256(toHex("robotmoney control proof tx"));
const EXEC_ABI = parseAbi(["function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)"]);
/** The execTransaction calldata of the proof: the Safe calls itself with value 0 and empty data, signed (really) by the given accounts, packed ascending by owner. */
export function proofInput(chainId: number, keys: readonly VHex[] = OWNER_KEYS, nonce = 0): Hex {
  const hash = localSafeTxHash(chainId, SAFE, SAFE, "0x", nonce);
  const sigs = keys.map((k) => {
    const sig = secp256k1.sign(hash.slice(2), k.slice(2));
    return { owner: privateKeyToAccount(k).address.toLowerCase(), sig: concatHex([toHex(sig.r, { size: 32 }), toHex(sig.s, { size: 32 }), toHex(27 + sig.recovery, { size: 1 })]) };
  });
  const packed = concatHex(sigs.sort((x, y) => (x.owner < y.owner ? -1 : 1)).map((x) => x.sig));
  return encodeFunctionData({ abi: EXEC_ABI, functionName: "execTransaction", args: [SAFE, 0n, "0x", 0, 0n, 0n, 0n, ZERO, ZERO, packed] });
}
export const SAFE = addr(0x5afe);
export const TIMELOCK = addr(0x71e10c);
export const REGISTRY = addr(0x4e6);
export const ROUTER = addr(0x40a7e4);
export const GATEWAY = addr(0x6a7e);
export const GOV = addr(0x60b);
export const REC = addr(0x4ec);
export const AGENT = addr(0xa6e47);
export const SEED_RECEIVER = addr(0x5eed);
export const SEED_SHARES = 1_000_000n * 10n ** 12n;
/** Stands in for the FiatTokenProxy code: the world pins its hash through VerifyOptions.usdcCodeHash. */
export const USDC_CODE = "0x6080604052600436106100" as const;
export const VAULTS: Record<string, { address: Address; kind: "usdc" | "basket" }> = {
  rmUSDC: { address: addr(0xb0001), kind: "usdc" },
  rmPROTO: { address: addr(0xb0002), kind: "basket" },
  rmRWA: { address: addr(0xb0003), kind: "basket" },
};
/** Library name (the table'"'"'s `libraries[].name`) -> address. */
const LIBS: Record<string, Address> = { tick_math: addr(0x11b1) };
const ASSETS: Record<string, { token: Address; pool: Address; swapFee: number; adapter: Address; venue: number }[]> = {
  rmPROTO: [
    { token: addr(0xe7), pool: addr(0xf001), swapFee: 500, adapter: addr(0xad01), venue: 0 },
    { token: addr(0xcb), pool: addr(0xf002), swapFee: 500, adapter: addr(0xad01), venue: 0 },
  ],
  rmRWA: [{ token: addr(0xde5), pool: addr(0xf003), swapFee: 500, adapter: addr(0xad01), venue: 0 }],
};

/** Issue 1705 C4: rmUSDC's three strategy adapters (Aave, Compound, Moonwell) with the deploy script's caps, and each basket's maxSlippageBps (config or vault default). */
export const USDC_ADAPTERS = [
  { adapter: addr(0xaa01), capBps: 3334, field: "aave_adapter" },
  { adapter: addr(0xaa02), capBps: 3333, field: "compound_adapter" },
  { adapter: addr(0xaa03), capBps: 3333, field: "moonwell_flagship_adapter" },
] as const;
export const SLIPPAGE: Record<string, bigint> = { rmPROTO: 100n, rmRWA: 100n };
export const SIG_ADAPTER_ALLOWED = "AdapterAllowedSet(address,bool)";
export const SIG_CODEHASH_ALLOWED = "AdapterCodeHashAllowedSet(bytes32,bool)";

/** Issue 1666: the guard every basket carries, and the in-range liquidity of every pool against the sheet floor. */
export const NAV_GUARD_BPS = 100n;
/** QA plan v1 D7: the emergency unwind guard of every basket asset (minUsdcOut in USDC units, and the override loss cap). */
export const UNWIND_MIN_USDC_OUT = 1_000_000n;
export const UNWIND_MAX_LOSS_BPS = 500n;
export const POOL_LIQUIDITY = 10n ** 18n;
export const POOL_LIQUIDITY_FLOOR = 10n ** 12n;
const DEFAULT_BPS = [9500, 500, 0];

type Handler = (args: any[]) => unknown;
const SET_REGISTRY_SELECTOR = toFunctionSelector("function setRegistry(address)");

export class FakeChain implements ChainReader {
  chain = 8453;
  head = 5000n;
  noncesMap = new Map<string, number>();
  codes = new Map<string, Hex>();
  storage = new Map<string, Hex>();
  roles = new Set<string>();
  handlers = new Map<string, Handler>();
  logs: LogEntry[] = [];
  owners: Address[] = [...OWNERS];
  threshold = 2;
  modules: Address[] = [];
  /** number of 429 failures to return before getLogs succeeds */
  rateLimits = 0;
  logCalls: { from: bigint; to: bigint }[] = [];
  maxLogSpan = 2000n;

  grant(at: Address, r: Hex, who: Address) { this.roles.add(`${at.toLowerCase()}|${r}|${who.toLowerCase()}`); }
  revoke(at: Address, r: Hex, who: Address) { this.roles.delete(`${at.toLowerCase()}|${r}|${who.toLowerCase()}`); }
  has(at: Address, r: Hex, who: Address) { return this.roles.has(`${at.toLowerCase()}|${r}|${who.toLowerCase()}`); }
  set(at: Address, name: string, fn: Handler | unknown) { this.handlers.set(`${at.toLowerCase()}:${name}`, typeof fn === "function" ? (fn as Handler) : () => fn); }

  async chainId() { return this.chain; }
  async blockNumber() { return this.head; }
  /** Head code only: the verifier never reads a historical block (issue 1851). Every call is recorded so a test can prove it. */
  codeCalls: { address: Address; blockNumber?: bigint }[] = [];
  async getCode(a: Address, ...rest: unknown[]) { this.codeCalls.push({ address: a, ...(rest[0] !== undefined ? { blockNumber: rest[0] as bigint } : {}) }); return this.codes.get(a.toLowerCase()) ?? "0x"; }
  async nonce(a: Address) { return this.noncesMap.get(a.toLowerCase()) ?? 0; }
  async getStorageAt(a: Address, slot: Hex) { return this.storage.get(`${a.toLowerCase()}|${slot}`) ?? Z32; }

  async read(a: Address, signature: string, args: unknown[] = []): Promise<unknown> {
    const item = parseAbiItem(signature) as any;
    const name: string = item.name;
    const A = a.toLowerCase();
    if (name === "hasRole") return this.has(a, args[0] as Hex, args[1] as Address);
    if (name === "getRoleMemberCount") return BigInt([...this.roles].filter((k) => k.startsWith(`${A}|${(args[0] as string).toLowerCase()}|`) || k.startsWith(`${A}|${args[0] as string}|`)).length);
    // QA plan v1 C3: AccessControlEnumerable's getRoleMember, in grant order (the weight setter's gating enumerates the router's holders and each holder's ADMIN_ROLE and WEIGHT_SETTER_ROLE)
    if (name === "getRoleMember") {
      const members = [...this.roles].filter((k) => k.startsWith(`${A}|${(args[0] as string).toLowerCase()}|`) || k.startsWith(`${A}|${args[0] as string}|`)).map((k) => k.split("|")[2] as Address);
      const i = Number(args[1] as bigint);
      if (i >= members.length) throw new Error(`execution reverted: no role member ${i} on ${a}`);
      return members[i];
    }
    if (name === "getOwners" && A === SAFE.toLowerCase()) return this.owners;
    if (name === "getThreshold" && A === SAFE.toLowerCase()) return BigInt(this.threshold);
    if (name === "getModulesPaginated" && A === SAFE.toLowerCase()) return { array: this.modules, next: addr(1) };
    const h = this.handlers.get(`${A}:${name}`);
    if (!h) throw new Error(`execution reverted: no ${name} on ${a}`);
    return h(args);
  }

  /** When true the one-shot setRegistry no longer reverts: a negative fixture for the "a second setRegistry reverts" label. */
  setRegistryOpen = false;

  /** Transactions by hash: the control proof lives here. */
  txs = new Map<string, { to: Address | null; input: Hex; value: bigint; status: "success" | "reverted" }>();
  async getTransaction(h: Hex) { const t = this.txs.get(h.toLowerCase()); return t ? { to: t.to, input: t.input, value: t.value } : null; }
  async receiptStatus(h: Hex) { return this.txs.get(h.toLowerCase())?.status ?? null; }
  /** Issue 1851: deploy transaction receipts by hash (the creation proof of the log scans). A function entry throws or answers per call. */
  receipts = new Map<string, DeployReceipt | (() => DeployReceipt | null)>();
  receiptCalls: Hex[] = [];
  async deployReceipt(h: Hex): Promise<DeployReceipt | null> { this.receiptCalls.push(h); const r = this.receipts.get(h.toLowerCase()); return typeof r === "function" ? r() : r ?? null; }
  /** Record `at` as created by a CREATE deploy transaction mined in `block`; returns the transaction hash. */
  created(at: Address, block: bigint): Hex { const h = keccak256(toHex(`deploy ${at.toLowerCase()} ${block}`)); this.receipts.set(h.toLowerCase(), { blockNumber: block, status: "success", contractAddress: at, to: null, logs: [] }); return h; }

  async callRaw(to: Address, data: Hex, from?: Address): Promise<RawCallResult> {
    if (data.startsWith(SET_REGISTRY_SELECTOR)) return this.setRegistryOpen ? { ok: true, data: "0x" } : { ok: false, data: "0x", reason: "already set" };
    const d = decodeFunctionData({ abi: [parseAbiItem("function checkSignatures(bytes32 dataHash, bytes data, bytes signatures)")], data });
    const sigs = d.args[2] as string;
    const bytes = (sigs.length - 2) / 2;
    const fail = (reason: string): RawCallResult => ({ ok: false, data: "0x", reason });
    if (this.threshold === 0) return fail("GS001");
    if (bytes < this.threshold * 65) return fail("GS020");
    for (let i = 0; i < this.threshold; i++) {
      const off = 2 + i * 130;
      const who = (`0x${sigs.slice(off + 24, off + 64)}`).toLowerCase();
      const v = parseInt(sigs.slice(off + 128, off + 130), 16);
      if (v !== 1) return fail("GS024");
      if ((from ?? "").toLowerCase() !== who) return fail("GS025");
      if (!this.owners.map((o) => o.toLowerCase()).includes(who)) return fail("GS026");
    }
    return { ok: true, data: "0x" };
  }

  /** Every eth_getLogs filter asked, in order (issue 1977: the shared scan asks an address list). */
  logFilters: { address?: Address | Address[]; topics: (Hex | Hex[] | null)[]; fromBlock: bigint; toBlock: bigint }[] = [];
  async getLogs(p: { address?: Address | Address[]; topics: (Hex | Hex[] | null)[]; fromBlock: bigint; toBlock: bigint }): Promise<LogEntry[]> {
    if (p.toBlock - p.fromBlock + 1n > this.maxLogSpan) throw new Error("query exceeds max block range 2000");
    this.logCalls.push({ from: p.fromBlock, to: p.toBlock });
    this.logFilters.push(p);
    if (this.rateLimits > 0) { this.rateLimits--; throw new Error("HTTP request failed. Status: 429 Too Many Requests"); }
    return this.logs.filter((l) =>
      l.blockNumber >= p.fromBlock && l.blockNumber <= p.toBlock &&
      (!p.address || (Array.isArray(p.address) ? p.address : [p.address]).some((x) => x.toLowerCase() === l.address.toLowerCase())) &&
      p.topics.every((t, i) => t === null || (Array.isArray(t) ? t.includes(l.topics[i]) : (l.topics[i] ?? "").toLowerCase() === t.toLowerCase())));
  }

  roleGrantedLog(at: Address, r: Hex, who: Address, block = 100n) {
    this.logs.push({ address: at, topics: [keccak256(toHex(SIG_ROLE_GRANTED)), r, padTopic(who), padTopic(DEPLOYER)], data: "0x", blockNumber: block });
  }
}

/** Contract name -> immutable ranges. Used to build artifacts and on-chain code that differs only inside those ranges. */
const IMMUTABLE = { start: 8, length: 32 };

function codeFor(seed: string, immutableFill: string, link?: Address): { artifact: string; chain: Hex } {
  const body = (keccak256(toHex(seed)).slice(2) + keccak256(toHex(seed + "2")).slice(2) + keccak256(toHex(seed + "3")).slice(2));
  // a linked library address sits at LINK (bytes 64 to 84), clear of the immutable range and of the bytes the redeploy test patches
  const art = "0x" + body.slice(0, 16) + "0".repeat(64) + (link ? body.slice(80, 128) + "0".repeat(40) + body.slice(168) : body.slice(80));
  const onchain = "0x" + body.slice(0, 16) + immutableFill.repeat(64).slice(0, 64) + (link ? body.slice(80, 128) + link.slice(2).toLowerCase() + body.slice(168) : body.slice(80));
  return { artifact: art, chain: onchain as Hex };
}

/**
 * Issue 1809: the ten proxied core contracts run behind the build's ERC1967Proxy. Each proxy address (the manifest's) holds proxy code, its ERC-1967 slot names the
 * implementation, which holds the artifact code and links GovernedUpgrade at LINK. The proxy reads the deployed timelock as its authority, is initialized (version 1)
 * and frozen (the world's sheet says UPGRADE_MODE frozen).
 */
export const PROXY_ARTIFACT = "ERC1967Proxy";
export const GOVERNED_UPGRADE = "GovernedUpgrade";
export const GOVERNED_UPGRADE_LIB = addr(0x60e1);
const LINK = { start: 64, length: 20 };
export const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
export const INIT_SLOT = "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00" as Hex;
/** Verifier name of each proxied core contract -> its implementation address in the world. */
export const IMPLS: Record<string, Address> = {
  gateway: addr(0x1e01), registry: addr(0x1e02), router: addr(0x1e03), governance: addr(0x1e04), receipt: addr(0x1e06),
  "vault[rmUSDC]": addr(0x1e11), "vault[rmPROTO]": addr(0x1e12), "vault[rmRWA]": addr(0x1e13),
};

export interface World {
  chain: FakeChain;
  dir: string;
  manifestDir: string;
  artifactsDir: string;
  sheet: VerifySheet;
  opts: VerifyOptions;
  libraries: Record<string, Address>;
  /** Issue 1809: make `at` a frozen, initialized proxy of the world's timelock whose implementation is `impl` (give `impl` its code yourself). */
  proxy(at: Address, impl: Address): void;
}

export function buildWorld(chainId = 8453): World {
  const dir = mkdtempSync(join(tmpdir(), "verify-world-"));
  const manifestDir = join(dir, "deployments");
  const artifactsDir = join(dir, "out");
  mkdirSync(manifestDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  const ch = new FakeChain();
  ch.chain = chainId;
  const delay = chainId === 8453 ? 172800 : 60;

  const table = getStageTable();
  const CORE_CONTRACTS = coreContracts(table);
  const libArtifact = (n: string) => table.libraries.find((l) => l.name === n)!.artifact;
  const vaultArtifactOf = (key: string) => table.vaults.find((v) => ({ rmUSDC: "USDC", rmPROTO: "PROTO", rmRWA: "RWA" })[key] === v.key)!.artifact;
  const names = [...new Set([...CORE_CONTRACTS.map((c) => c.artifact), ...table.vaults.map((v) => v.artifact), ...Object.keys(LIBS).map(libArtifact)])];
  const proxied = new Set(table.stages.flatMap((s) => (s.proxies ?? []).map((p) => p.contract)));
  const codeByName: Record<string, Hex> = {};
  const writeArtifact = (n: string, artifact: string, linkReferences: unknown = {}, immutables = true) => {
    mkdirSync(join(artifactsDir, `${n}.sol`), { recursive: true });
    writeFileSync(join(artifactsDir, `${n}.sol`, `${n}.json`), JSON.stringify({ deployedBytecode: { object: artifact, immutableReferences: immutables ? { "1": [IMMUTABLE] } : {}, linkReferences } }));
  };
  for (const n of names) {
    const link = proxied.has(n) ? GOVERNED_UPGRADE_LIB : undefined;
    const { artifact, chain } = codeFor(n, "ab", link);
    codeByName[n] = chain;
    writeArtifact(n, artifact, link ? { "contracts/lib/GovernedUUPS.sol": { [GOVERNED_UPGRADE]: [LINK] } } : {});
  }
  // the linked library (its runtime starts with PUSH20 <its own address>, masked) and the proxy, which has no immutables
  const lib = `0x73${"0".repeat(40)}${keccak256(toHex(GOVERNED_UPGRADE)).slice(2)}`;
  writeArtifact(GOVERNED_UPGRADE, lib, {}, false);
  ch.codes.set(GOVERNED_UPGRADE_LIB.toLowerCase(), `0x73${GOVERNED_UPGRADE_LIB.slice(2).toLowerCase()}${keccak256(toHex(GOVERNED_UPGRADE)).slice(2)}` as Hex);
  const proxyCode = `0x6080${keccak256(toHex(PROXY_ARTIFACT)).slice(2)}` as Hex;
  writeArtifact(PROXY_ARTIFACT, proxyCode, {}, false);
  const setCode = (a: Address, name: string) => ch.codes.set(a.toLowerCase(), codeByName[name]);
  /** A proxied contract: proxy code at the address, the artifact code at its implementation, the slot, the authority, initialized and frozen. */
  const proxy = (a: Address, impl: Address) => {
    ch.codes.set(a.toLowerCase(), proxyCode);
    ch.storage.set(`${a.toLowerCase()}|${IMPL_SLOT}`, pad(impl, { size: 32 }));
    ch.storage.set(`${a.toLowerCase()}|${INIT_SLOT}`, pad("0x01", { size: 32 }));
    ch.set(a, "upgradeTimelock", TIMELOCK);
    ch.set(a, "upgradesFrozen", true);
  };
  const setProxy = (name: string, a: Address, artifact: string) => {
    const impl = IMPLS[name]!;
    setCode(impl, artifact);
    proxy(a, impl);
  };

  const byName: Record<string, Address> = { gateway: GATEWAY, registry: REGISTRY, router: ROUTER, governance: GOV, receipt: REC, timelock: TIMELOCK };
  for (const c of CORE_CONTRACTS) (IMPLS[c.name] ? setProxy(c.name, byName[c.name]!, c.artifact) : setCode(byName[c.name], c.artifact));
  for (const [k, v] of Object.entries(VAULTS)) setProxy(`vault[${k}]`, v.address, vaultArtifactOf(k));
  for (const [n, a] of Object.entries(LIBS)) setCode(a, libArtifact(n));
  ch.codes.set(SAFE.toLowerCase(), "0x608060405234801561001057600080fd5b50");
  const safeHash = keccak256(ch.codes.get(SAFE.toLowerCase())!);
  ch.storage.set(`${SAFE.toLowerCase()}|${Z32}`, pad(SAFE_L2_141_SINGLETON, { size: 32 }));
  ch.storage.set(`${SAFE.toLowerCase()}|${SAFE_FALLBACK_SLOT}`, pad(SAFE_141_FALLBACK_HANDLER, { size: 32 }));
  void SAFE_GUARD_SLOT;
  ch.set(SAFE, "VERSION", "1.4.1");
  ch.set(SAFE, "nonce", 1n);
  ch.codes.set(USDC_ADDRESS.toLowerCase(), USDC_CODE as Hex);

  // roles: timelock admin everywhere, emergency on vaults
  for (const a of [GATEWAY, REGISTRY, ROUTER, GOV, REC, ...Object.values(VAULTS).map((v) => v.address)]) ch.grant(a, ADMIN_ROLE, TIMELOCK);
  for (const a of [GATEWAY, REC, TIMELOCK]) ch.grant(a, Z32, TIMELOCK);
  ch.grant(GATEWAY, DEPOSIT_PAUSER_ROLE, PAUSER);
  ch.grant(ROUTER, ADMIN_ROLE, GOV);
  ch.grant(REC, RECEIPT_RELEASER_ROLE, GOV); // issue 1888: RouterGovernance releases through the narrow role, never ADMIN_ROLE
  ch.grant(ROUTER, WEIGHT_SETTER_ROLE, GOV);
  // Rotation of the weight setter (core 1616): the Safe proposes, the timelock executes, nothing is pending.
  ch.grant(ROUTER, WEIGHT_SETTER_ROTATOR_ROLE, SAFE);
  ch.grant(ROUTER, WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE, TIMELOCK);
  ch.set(ROUTER, "pendingWeightSetterRotation", [ZERO, 0n]);
  // Policy (core 1521): the Safe proposes and cancels; EXECUTOR_ROLE is open to address(0).
  for (const r of [PROPOSER_ROLE, CANCELLER_ROLE]) { ch.grant(TIMELOCK, r, SAFE); ch.roleGrantedLog(TIMELOCK, r, SAFE, 110n); }
  ch.grant(TIMELOCK, EXECUTOR_ROLE, ZERO);
  ch.roleGrantedLog(TIMELOCK, EXECUTOR_ROLE, ZERO, 110n);
  ch.set(TIMELOCK, "getMinDelay", BigInt(delay));
  ch.set(GATEWAY, "depositsPaused", false);
  ch.set(GATEWAY, "router", ROUTER);
  ch.set(REGISTRY, "router", ROUTER);
  ch.set(REGISTRY, "listVaults", Object.values(VAULTS).map((v) => v.address));
  ch.set(REGISTRY, "vaultCount", 3n);
  ch.set(REGISTRY, "isRouterEligible", () => true);
  // the weight setter (issue 1698): applyReceipt is gated by governance's own WEIGHT_SETTER_ROLE (the timelock) and releases on the receipt register
  ch.grant(GOV, WEIGHT_SETTER_ROLE, TIMELOCK);
  ch.set(GOV, "router", ROUTER);
  ch.set(GOV, "receipts", REC);
  // deploy-time configuration (issue 1520): the router default weights
  ch.set(ROUTER, "getDefaultWeights", [Object.values(VAULTS).map((v) => v.address), DEFAULT_BPS.map((x) => BigInt(x))]);
  // issue 1743: no voted vector is active, so the effective vector is the default one
  ch.set(ROUTER, "votedWeightsActive", false);
  ch.set(ROUTER, "getEffectiveWeights", [Object.values(VAULTS).map((v) => v.address), DEFAULT_BPS.map((x) => BigInt(x))]);
  // the deploy authorizes no agent: the gateway carries no AgentAuthorized log and nobody holds AGENT_ROLE
  // deployer once held roles; all were renounced
  ch.roleGrantedLog(TIMELOCK, ADMIN_ROLE, DEPLOYER, 120n);
  ch.roleGrantedLog(VAULTS.rmUSDC.address, EMERGENCY_ROLE, DEPLOYER, 2500n);

  const vsheet: VerifySheet["vaults"] = {};
  for (const [k, v] of Object.entries(VAULTS)) {
    ch.set(v.address, "registry", REGISTRY);
    ch.grant(v.address, EMERGENCY_ROLE, EMERGENCY);
    ch.roleGrantedLog(v.address, EMERGENCY_ROLE, EMERGENCY, 2600n);
    const caps = k === "rmUSDC" ? { tvl: 1_000_000_000_000n, per: 100_000_000_000n } : { tvl: 10_000_000_000n, per: 1_000_000_000n };
    ch.set(v.address, "tvlCap", caps.tvl);
    ch.set(v.address, "perDepositCap", caps.per);
    ch.set(v.address, "exitFeeBps", 10n);
    if (v.kind !== "usdc") ch.set(v.address, "navDeviationGuardBps", NAV_GUARD_BPS);
    if (v.kind !== "usdc") ch.set(v.address, "maxSlippageBps", SLIPPAGE[k]!);
    ch.set(v.address, "feeRecipient", SAFE);
    const paused = k !== "rmUSDC";
    ch.set(v.address, "depositsPaused", paused);
    if (v.kind === "usdc") {
      ch.set(v.address, "totalAssets", 1_000_000n); ch.set(v.address, "totalSupply", SEED_SHARES);
      ch.set(v.address, "balanceOf", (a: any[]) => (String(a[0]).toLowerCase() === SEED_RECEIVER.toLowerCase() ? SEED_SHARES : 0n));
    }
    const assets = ASSETS[k] ?? [];
    for (const x of assets) ch.set(x.pool, "liquidity", POOL_LIQUIDITY);
    ch.set(v.address, "assets", (a: any[]) => {
      const x = assets[Number(a[0])];
      if (!x) throw new Error("execution reverted");
      return [x.token, x.pool, x.swapFee, true, x.adapter, x.venue];
    });
    // QA plan v1 D7: every basket asset carries an emergency unwind guard (the Safe sets it through the timelock with govern --row set-unwind-guard). A test zeroes one.
    if (v.kind !== "usdc") {
      const guards = new Map(assets.map((x) => [x.token.toLowerCase(), [UNWIND_MIN_USDC_OUT, true, UNWIND_MAX_LOSS_BPS] as const]));
      ch.set(v.address, "emergencyUnwindGuard", (a: any[]) => guards.get(String(a[0]).toLowerCase()) ?? [0n, false, 0n]);
    }
    if (v.kind === "usdc") {
      // issue 1705 C4: the three strategy adapters, active with the script caps, and exactly their addresses and code hashes on the allowlists
      USDC_ADAPTERS.forEach((x, i) => ch.codes.set(x.adapter.toLowerCase(), `0x6080${(0xa0 + i).toString(16)}`));
      const hashes = USDC_ADAPTERS.map((x) => keccak256(ch.codes.get(x.adapter.toLowerCase())!).toLowerCase());
      ch.set(v.address, "adapters", (a: any[]) => { const x = USDC_ADAPTERS[Number(a[0])]; if (!x) throw new Error("execution reverted"); return [x.adapter, x.capBps, true]; });
      ch.set(v.address, "adapterAllowed", (a: any[]) => USDC_ADAPTERS.some((x) => x.adapter.toLowerCase() === String(a[0]).toLowerCase()));
      ch.set(v.address, "adapterCodeHashAllowed", (a: any[]) => hashes.includes(String(a[0]).toLowerCase()));
      for (const x of USDC_ADAPTERS) ch.logs.push({ address: v.address, topics: [keccak256(toHex(SIG_ADAPTER_ALLOWED)), padTopic(x.adapter)], data: "0x", blockNumber: 2510n });
      for (const h of new Set(hashes)) ch.logs.push({ address: v.address, topics: [keccak256(toHex(SIG_CODEHASH_ALLOWED)), h as Hex], data: "0x", blockNumber: 2510n });
    }
    vsheet[k] = {
      tvlCap: caps.tvl, perDepositCap: caps.per, exitFeeBps: 10n, feeRecipient: SAFE, expectPaused: paused, routerEligible: true,
      ...(v.kind !== "usdc" ? { navDeviationBps: NAV_GUARD_BPS, minPoolLiquidity: POOL_LIQUIDITY_FLOOR } : {}),
      assets: assets.map((x) => ({ ...x })), ...(k === "rmUSDC" ? { seed: 1_000_000n, seedShareReceiver: SEED_RECEIVER, adapters: USDC_ADAPTERS.map((x) => ({ adapter: x.adapter, capBps: x.capBps })) } : { maxSlippageBps: SLIPPAGE[k]! }),
    };
  }

  const frozenCounts = { safe: 1, libs: 4, vault: 12, registry: 2, router: 2, gateway: 3, governance: 2, receipt: 2, "vault-proto": 6, "vault-rwa": 6, timelock: 18 };
  ch.noncesMap.set(DEPLOYER.toLowerCase(), Object.values(frozenCounts).reduce((a, b) => a + b, 0) + PROOF_TX_NONCES); // the stages plus the deployer's prove-control transaction (core 1712)

  const w = (f: string, o: unknown) => writeFileSync(join(manifestDir, f), JSON.stringify(o, null, 2));
  const file = (stage: string) => stageManifestFile(table, stage);
  const up = { upgrade_timelock: TIMELOCK, upgrade_mode: "frozen" };
  w(file("vault"), { chain_id: chainId, vault: VAULTS.rmUSDC.address, vault_implementation: IMPLS["vault[rmUSDC]"], ...up, seed_share_receiver: SEED_RECEIVER, seed_shares: SEED_SHARES.toString(), deployer_share_balance_after: 0, ...Object.fromEntries(USDC_ADAPTERS.map((x) => [x.field, x.adapter])) });
  w(file("registry"), { chain_id: chainId, registry: REGISTRY, registry_implementation: IMPLS.registry, ...up });
  w(file("router"), { chain_id: chainId, router: ROUTER, router_implementation: IMPLS.router, ...up });
  w(file("gateway"), { chain_id: chainId, gateway: GATEWAY, gateway_implementation: IMPLS.gateway, gateway_implementation_runtime_hash: keccak256(codeByName[table.artifacts.gateway!]!), gateway_runtime_hash: keccak256(proxyCode), ...up });
  w(file("governance"), { chain_id: chainId, governance: GOV, governance_implementation: IMPLS.governance, ...up });
  w(file("receipt"), { chain_id: chainId, consensus_receipt: REC, consensus_receipt_implementation: IMPLS.receipt, ...up });
  w(file("timelock"), {
    chain_id: chainId, timelock: TIMELOCK, safe: SAFE, emergency: EMERGENCY, executorPolicy: "open", cancellerPolicy: "safe-only", code_hashes: { safe: safeHash },
  });
  w("safe.json", { chain_id: chainId, safe: SAFE });
  w(file("libs"), { chain_id: chainId, tick_math: LIBS.tick_math });
  for (const v of table.vaults) if (v.key !== "USDC") {
    const vkey = ({ PROTO: "rmPROTO", RWA: "rmRWA" } as Record<string, string>)[v.key]!;
    w(basename(v.manifest), { chain_id: chainId, vault: VAULTS[vkey]!.address, implementation: IMPLS[`vault[${vkey}]`], ...up });
  }
  // the storage-layout snapshots and the pins the layout identifiers hash, as in the core checkout
  const coreDir = join(dir, "core");
  mkdirSync(join(coreDir, "config"), { recursive: true });
  for (const s of table.stages) for (const p of s.proxies ?? []) { mkdirSync(join(coreDir, dirname(p.layout)), { recursive: true }); writeFileSync(join(coreDir, p.layout), JSON.stringify({ contract: p.contract })); }
  writeFileSync(join(coreDir, table.upgradeAuthority!.layoutPins), JSON.stringify({ pins: true }));

  const sheet: VerifySheet = {
    chainId, deployer: DEPLOYER, pauser: PAUSER, emergency: EMERGENCY, safeOwners: [...OWNERS], safeThreshold: 2, timelockDelay: delay, vaults: vsheet, upgradeMode: "frozen",
    defaultWeights: Object.keys(VAULTS).map((vault, i) => ({ vault, bps: DEFAULT_BPS[i]! })),
  };
  ch.txs.set(PROOF_TX.toLowerCase(), { to: SAFE, input: proofInput(chainId), value: 0n, status: "success" });
  // issue 1892: this world is the combined (legacy) deployment, the deploy-2 shape: gateway, agents and all. tests/verify/systems.test.ts reads it as each system.
  const opts: VerifyOptions = { system: "legacy", chain: ch, manifestDir, table, sheet, fromBlock: 0n, frozenCounts, artifactsDir, coreDir, retryBaseMs: 0, usdcCodeHash: keccak256(USDC_CODE), controlProof: { txHash: PROOF_TX, nonce: 0 } };
  return { chain: ch, dir, manifestDir, artifactsDir, sheet, opts, libraries: LIBS, proxy };
}

export const failed = (r: { checks: { label: string; ok: boolean }[] }) => r.checks.filter((c) => !c.ok).map((c) => c.label);
void ({} as VHex);

/** The canonical CREATE2 factory the timelock stage deploys the core timelock through. */
export const WORLD_CREATE2_FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C" as const;

/**
 * Issue 1851: the healthy world with from-block 100 and the run's deploy receipts. Every governed contract has a CREATE receipt at `blocks[name] ?? 100`, the timelock a CREATE2
 * factory call carrying its constructor log. `opts.deployTxs` lists them, the timelock's last.
 */
export function deployedWorld(blocks: Record<string, bigint> = {}): World {
  const w = buildWorld();
  w.opts.fromBlock = 100n;
  const contracts: Record<string, Address> = { gateway: GATEWAY, registry: REGISTRY, router: ROUTER, governance: GOV, receipt: REC, ...Object.fromEntries(Object.entries(VAULTS).map(([k, v]) => [k, v.address])) };
  const txs = Object.entries(contracts).map(([n, a]) => w.chain.created(a, blocks[n] ?? 100n));
  const tl = keccak256(toHex("timelock factory call"));
  w.chain.receipts.set(tl.toLowerCase(), { blockNumber: blocks.timelock ?? 100n, status: "success", contractAddress: null, to: WORLD_CREATE2_FACTORY, logs: [{ address: TIMELOCK }] });
  w.opts.deployTxs = [...txs, tl];
  return w;
}

/**
 * Issue 1835: the timelock stage ADOPTED a timelock someone else created: the run's own timelock transaction is dropped, the timelock's constructor RoleGranted log sits in a
 * transaction mined in `block` whose receipt is `receipt(tx)` (null: the chain does not know it), and `opts.adoptedContracts` names the timelock.
 * Issue 1864: that log is the constructor's RoleGranted(DEFAULT_ADMIN_ROLE, account = the timelock, sender = the CREATE2 factory) unless `grant` overrides a topic.
 */
export function adoptTimelock(w: World, block: bigint, receipt: (tx: Hex) => Record<string, unknown> | null, grant: { role?: Hex; account?: Address; sender?: Address } = {}): World {
  const own = w.opts.deployTxs!.pop()!;
  w.chain.receipts.delete(own.toLowerCase());
  const tx = keccak256(toHex("someone else's timelock creation"));
  w.chain.logs.push({ address: TIMELOCK, topics: [keccak256(toHex(SIG_ROLE_GRANTED)), grant.role ?? Z32, padTopic(grant.account ?? TIMELOCK), padTopic(grant.sender ?? WORLD_CREATE2_FACTORY)], data: "0x", blockNumber: block, transactionHash: tx });
  const r = receipt(tx);
  if (r) w.chain.receipts.set(tx.toLowerCase(), r as never);
  w.opts.adoptedContracts = [TIMELOCK];
  return w;
}
