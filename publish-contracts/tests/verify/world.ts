// A healthy four-vault deployment as in-memory chain state plus manifests and artifacts on disk.
// The FakeChain implements the read-only ChainReader surface. It is a unit-test fixture for verifier logic:
// it proves what the verifier reports for a given chain state. The real-chain proof is the Twin chain run (S9) and the mainnet run (S13).
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { concatHex, decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, toFunctionSelector, parseAbi, parseAbiItem, toHex, pad, type Hex as VHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { localSafeTxHash } from "../../src/safe/tx.ts";
import {
  ADMIN_ROLE, WEIGHT_SETTER_ROLE, WEIGHT_SETTER_ROTATOR_ROLE, WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE, coreContracts, stageManifestFile, EMERGENCY_ROLE, DEPOSIT_PAUSER_ROLE, PROPOSER_ROLE, EXECUTOR_ROLE, CANCELLER_ROLE, SAFE_141_FALLBACK_HANDLER, SAFE_FALLBACK_SLOT,
  RM_TOKEN, SAFE_GUARD_SLOT, SAFE_L2_141_SINGLETON, SIG_ADAPTER_ALLOWED_SET, SIG_ADAPTER_CODE_HASH_ALLOWED_SET, SIG_AGENT_AUTHORIZED, SIG_RECEIPT_APPLIED, SIG_ROLE_GRANTED,
  SIG_VOTED_WEIGHTS_CLEARED, Z32, ZERO,
} from "../../src/verify/constants.ts";
import { PROOF_TX_NONCES } from "../../src/counts.ts";
import { getStageTable } from "../../src/stages.ts";
import { basename } from "node:path";
import { padTopic } from "../../src/verify/logs.ts";
import { USDC_ADDRESS } from "../../src/usdc.ts";
import { ERC1967_IMPLEMENTATION_SLOT, INITIALIZABLE_SLOT, INITIALIZERS_LOCKED } from "../../src/proxies.ts";
import { tableProxies } from "../../src/stage-table.ts";
import type { Address, ChainReader, Hex, LogEntry, RawCallResult, VerifyOptions, VerifySheet } from "../../src/verify/types.ts";

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
export const ICP = addr(0x1c9);
export const REC = addr(0x4ec);
/** Core 1676: the permissionless Uniswap V4 price recorder and the V4 swap adapter bound to it. */
export const RECORDER = addr(0x4ec0de);
export const V4_ADAPTER = addr(0xad04);
export const POOL_MANAGER = addr(0x9a4);
export const STATE_VIEW = addr(0x5748);
export const RM_POOL_ID = "0xf2e7b95797a96a19347d8fb93b4dd9fdcd24623a483f5107887131edbf252391" as const;
/** RM then USDC, fee 29100, tickSpacing 582, no hooks: the shipped config PoolKey, whose hash is RM_POOL_ID. */
export const RM_POOL_KEY = { currency0: RM_TOKEN, currency1: USDC_ADDRESS as Address, fee: 29100, tickSpacing: 582, hooks: ZERO } as const;
export const V4_EXPECTED = { poolManager: POOL_MANAGER, stateView: STATE_VIEW, poolId: RM_POOL_ID as Hex, key: { ...RM_POOL_KEY } };
export const AGENT = addr(0xa6e47);
export const SEED_RECEIVER = addr(0x5eed);
export const SEED_SHARES = 1_000_000n * 10n ** 12n;
/** Stands in for the FiatTokenProxy code: the world pins its hash through VerifyOptions.usdcCodeHash. */
export const USDC_CODE = "0x6080604052600436106100" as const;
export const VAULTS: Record<string, { address: Address; kind: "usdc" | "basket" | "agent" }> = {
  rmUSDC: { address: addr(0xb0001), kind: "usdc" },
  rmPROTO: { address: addr(0xb0002), kind: "basket" },
  rmAGENT: { address: addr(0xb0003), kind: "agent" },
  rmRWA: { address: addr(0xb0004), kind: "basket" },
};
/**
 * Issue 1809 (ADR-0014 §1): the nine proxied contracts. Each address above is the PROXY (what every call and role check reaches); the implementation behind it holds
 * the contract's build. Keyed by the stage table's proxy name.
 */
export const PROXIES: Record<string, Address> = {
  rmUSDC: VAULTS.rmUSDC!.address, registry: REGISTRY, router: ROUTER, gateway: GATEWAY, icpolicy: ICP, receipt: REC,
  rmPROTO: VAULTS.rmPROTO!.address, rmAGENT: VAULTS.rmAGENT!.address, rmRWA: VAULTS.rmRWA!.address,
};
export const IMPLEMENTATIONS: Record<string, Address> = {
  rmUSDC: addr(0xc0b0001), registry: addr(0xc04e6), router: addr(0xc40a7e4), gateway: addr(0xc6a7e), icpolicy: addr(0xc1c9), receipt: addr(0xc4ec),
  rmPROTO: addr(0xc0b0002), rmAGENT: addr(0xc0b0003), rmRWA: addr(0xc0b0004),
};
/** The implementation behind a world address when it is a proxy, else the address itself: where the contract's own build runs. */
export const implementationOf = (a: Address): Address => {
  const n = Object.entries(PROXIES).find(([, p]) => p.toLowerCase() === a.toLowerCase())?.[0];
  return n ? IMPLEMENTATIONS[n]! : a;
};
/** Library name (the table'"'"'s `libraries[].name`) -> address. */
const LIBS: Record<string, Address> = { tick_math: addr(0x11b1) };
const ASSETS: Record<string, { token: Address; pool: Address; swapFee: number; adapter: Address; venue: number; v4?: typeof V4_EXPECTED }[]> = {
  rmPROTO: [
    { token: addr(0xe7), pool: addr(0xf001), swapFee: 500, adapter: addr(0xad01), venue: 0 },
    { token: addr(0xcb), pool: addr(0xf002), swapFee: 500, adapter: addr(0xad01), venue: 0 },
  ],
  // core 1676: RM is a Uniswap V4 asset. The vault pool is the price recorder, the adapter is the V4 swap adapter, the venue is V4 (1).
  rmAGENT: [{ token: RM_TOKEN, pool: RECORDER, swapFee: 29100, adapter: V4_ADAPTER, venue: 1, v4: V4_EXPECTED }],
  rmRWA: [{ token: addr(0xde5), pool: addr(0xf003), swapFee: 500, adapter: addr(0xad01), venue: 0 }],
};

/** Issue 1705 C4: rmUSDC's three lending adapters, in registration order, at the vault stage's caps (each has its own runtime code, so three code hashes). */
export const USDC_ADAPTERS = [
  { address: addr(0xada1), capBps: 3334 },
  { address: addr(0xada2), capBps: 3333 },
  { address: addr(0xada3), capBps: 3333 },
] as const;
/** Issue 1705 C4: each basket's swap bound as the deploy leaves it (rmAGENT's config raises it to 500, the others keep the vault default). */
export const BASKET_SLIPPAGE_BPS: Record<string, bigint> = { rmPROTO: 100n, rmAGENT: 500n, rmRWA: 100n };

/** Issue 1666: the guard every basket carries, and the in-range liquidity of every pool against the sheet floor. */
export const NAV_GUARD_BPS = 100n;
/** QA plan v1 D7: the emergency unwind guard of every basket asset (minUsdcOut in USDC units, and the override loss cap). */
export const UNWIND_MIN_USDC_OUT = 1_000_000n;
export const UNWIND_MAX_LOSS_BPS = 500n;
export const POOL_LIQUIDITY = 10n ** 18n;
export const POOL_LIQUIDITY_FLOOR = 10n ** 12n;
const DEFAULT_BPS = [9500, 500, 0, 0];

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
  async getCode(a: Address) { return this.codes.get(a.toLowerCase()) ?? "0x"; }
  async nonce(a: Address) { return this.noncesMap.get(a.toLowerCase()) ?? 0; }
  async getStorageAt(a: Address, slot: Hex) { return this.storage.get(`${a.toLowerCase()}|${slot}`) ?? Z32; }

  async read(a: Address, signature: string, args: unknown[] = []): Promise<unknown> {
    const item = parseAbiItem(signature) as any;
    const name: string = item.name;
    const A = a.toLowerCase();
    if (name === "hasRole") return this.has(a, args[0] as Hex, args[1] as Address);
    if (name === "getRoleMemberCount") return BigInt([...this.roles].filter((k) => k.startsWith(`${A}|${(args[0] as string).toLowerCase()}|`) || k.startsWith(`${A}|${args[0] as string}|`)).length);
    // QA plan v1 C3: AccessControlEnumerable's getRoleMember, in grant order (the weight setter's gating enumerates the router's holders and each holder's ADMIN_ROLE)
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

  async getLogs(p: { address?: Address; topics: (Hex | Hex[] | null)[]; fromBlock: bigint; toBlock: bigint }): Promise<LogEntry[]> {
    if (p.toBlock - p.fromBlock + 1n > this.maxLogSpan) throw new Error("query exceeds max block range 2000");
    this.logCalls.push({ from: p.fromBlock, to: p.toBlock });
    if (this.rateLimits > 0) { this.rateLimits--; throw new Error("HTTP request failed. Status: 429 Too Many Requests"); }
    return this.logs.filter((l) =>
      l.blockNumber >= p.fromBlock && l.blockNumber <= p.toBlock &&
      (!p.address || l.address.toLowerCase() === p.address.toLowerCase()) &&
      p.topics.every((t, i) => t === null || (Array.isArray(t) ? t.includes(l.topics[i]) : (l.topics[i] ?? "").toLowerCase() === t.toLowerCase())));
  }

  roleGrantedLog(at: Address, r: Hex, who: Address, block = 100n) {
    this.logs.push({ address: at, topics: [keccak256(toHex(SIG_ROLE_GRANTED)), r, padTopic(who), padTopic(DEPLOYER)], data: "0x", blockNumber: block });
  }

  /** Issue 1705 C4: an allowlist setter event of a vault (AdapterAllowedSet or AdapterCodeHashAllowedSet), its key in topic 1 and the bool in data. */
  allowlistLog(at: Address, sig: string, key: Hex, allowed: boolean, block = 2400n) {
    this.logs.push({ address: at, topics: [keccak256(toHex(sig)), key], data: encodeAbiParameters([{ type: "bool" }], [allowed]) as Hex, blockNumber: block });
  }

  /** QA plan v1 C2: the weight setter's ReceiptApplied log, the chain's own record of an application (the verifier reads the applied vector from it, never from the run manifest). */
  receiptAppliedLog(receiptId: Hex, vaults: Address[], bps: number[], block = 4000n, digest: Hex = `0x${"d1".repeat(32)}` as Hex) {
    this.logs.push({ address: GOV, topics: [keccak256(toHex(SIG_RECEIPT_APPLIED)), receiptId], data: encodeAbiParameters([{ type: "bytes32" }, { type: "address[]" }, { type: "uint256[]" }], [digest, vaults, bps.map((x) => BigInt(x))]) as Hex, blockNumber: block });
  }

  /** The router's VotedWeightsCleared log (the clear row): an application before it no longer routes deposits. */
  votedWeightsClearedLog(block: bigint) {
    this.logs.push({ address: ROUTER, topics: [keccak256(toHex(SIG_VOTED_WEIGHTS_CLEARED))], data: "0x", blockNumber: block });
  }
}

/** Contract name -> immutable ranges. Used to build artifacts and on-chain code that differs only inside those ranges. */
const IMMUTABLE = { start: 8, length: 32 };

function codeFor(seed: string, immutableFill: string): { artifact: string; chain: Hex } {
  const body = (keccak256(toHex(seed)).slice(2) + keccak256(toHex(seed + "2")).slice(2) + keccak256(toHex(seed + "3")).slice(2));
  const art = "0x" + body.slice(0, 16) + "0".repeat(64) + body.slice(80);
  const onchain = "0x" + body.slice(0, 16) + immutableFill.repeat(64).slice(0, 64) + body.slice(80);
  return { artifact: art, chain: onchain as Hex };
}

export interface World {
  chain: FakeChain;
  dir: string;
  manifestDir: string;
  artifactsDir: string;
  sheet: VerifySheet;
  opts: VerifyOptions;
  libraries: Record<string, Address>;
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
  const vaultArtifactOf = (key: string) => table.vaults.find((v) => ({ rmUSDC: "USDC", rmPROTO: "PROTO", rmAGENT: "AGENT", rmRWA: "RWA" })[key] === v.key)!.artifact;
  const names = [...new Set([...CORE_CONTRACTS.map((c) => c.artifact), ...table.vaults.map((v) => v.artifact), ...Object.keys(LIBS).map(libArtifact), table.artifacts.v4Adapter!, table.proxyArtifact!])];
  const codeByName: Record<string, Hex> = {};
  for (const n of names) {
    const { artifact, chain } = codeFor(n, "ab");
    codeByName[n] = chain;
    mkdirSync(join(artifactsDir, `${n}.sol`), { recursive: true });
    writeFileSync(join(artifactsDir, `${n}.sol`, `${n}.json`), JSON.stringify({ deployedBytecode: { object: artifact, immutableReferences: { "1": [IMMUTABLE] }, linkReferences: {} } }));
  }
  const setCode = (a: Address, name: string) => ch.codes.set(a.toLowerCase(), codeByName[name]);

  const byName: Record<string, Address> = { gateway: GATEWAY, registry: REGISTRY, router: ROUTER, governance: GOV, icpolicy: ICP, receipt: REC, timelock: TIMELOCK, recorder: RECORDER };
  for (const c of CORE_CONTRACTS) setCode(byName[c.name], c.artifact);
  for (const [k, v] of Object.entries(VAULTS)) setCode(v.address, vaultArtifactOf(k));
  setCode(V4_ADAPTER, table.artifacts.v4Adapter!);
  for (const [n, a] of Object.entries(LIBS)) setCode(a, libArtifact(n));
  // issue 1809 (ADR-0014): every proxied contract runs behind an ERC1967Proxy. The proxy holds the proxy build and its ERC-1967 implementation slot names the
  // implementation, which holds the contract's build. The proxy is initialized, the implementation's initializers are locked, the authority is the timelock, nothing is frozen.
  for (const p of tableProxies(table)) {
    const proxy = PROXIES[p.name]!, impl = IMPLEMENTATIONS[p.name]!;
    setCode(impl, p.artifact);
    setCode(proxy, table.proxyArtifact!);
    ch.storage.set(`${proxy.toLowerCase()}|${ERC1967_IMPLEMENTATION_SLOT}`, pad(impl, { size: 32 }));
    ch.storage.set(`${proxy.toLowerCase()}|${INITIALIZABLE_SLOT}`, toHex(1n, { size: 32 }));
    ch.storage.set(`${impl.toLowerCase()}|${INITIALIZABLE_SLOT}`, toHex(INITIALIZERS_LOCKED, { size: 32 }));
    ch.set(proxy, "upgradeAuthority", TIMELOCK);
    ch.set(proxy, "upgradesFrozen", false);
  }
  ch.codes.set(SAFE.toLowerCase(), "0x608060405234801561001057600080fd5b50");
  const safeHash = keccak256(ch.codes.get(SAFE.toLowerCase())!);
  ch.storage.set(`${SAFE.toLowerCase()}|${Z32}`, pad(SAFE_L2_141_SINGLETON, { size: 32 }));
  ch.storage.set(`${SAFE.toLowerCase()}|${SAFE_FALLBACK_SLOT}`, pad(SAFE_141_FALLBACK_HANDLER, { size: 32 }));
  void SAFE_GUARD_SLOT;
  ch.set(SAFE, "VERSION", "1.4.1");
  ch.set(SAFE, "nonce", 1n);
  ch.codes.set(USDC_ADDRESS.toLowerCase(), USDC_CODE as Hex);

  // roles: timelock admin everywhere, emergency on vaults
  for (const a of [GATEWAY, REGISTRY, ROUTER, GOV, ICP, REC, ...Object.values(VAULTS).map((v) => v.address)]) ch.grant(a, ADMIN_ROLE, TIMELOCK);
  for (const a of [GATEWAY, ICP, REC, TIMELOCK]) ch.grant(a, Z32, TIMELOCK);
  ch.grant(GATEWAY, DEPOSIT_PAUSER_ROLE, PAUSER);
  ch.grant(ROUTER, ADMIN_ROLE, GOV);
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
  ch.set(REGISTRY, "vaultCount", 4n);
  ch.set(REGISTRY, "isRouterEligible", () => true);
  // the weight setter's stage 11 wiring (issue 1698, no voting surface): the receipt register applyReceipt releases from, the router it writes, and the register
  // ADMIN_ROLE the release needs (DeployTimelock grants it to RouterGovernance and logs it like every other grant)
  ch.set(GOV, "receiptContract", REC);
  ch.set(GOV, "router", ROUTER);
  ch.grant(REC, ADMIN_ROLE, GOV);
  ch.roleGrantedLog(REC, ADMIN_ROLE, GOV, 115n);
  // deploy-time configuration (issue 1520): the router default weights
  ch.set(ROUTER, "getDefaultWeights", [Object.values(VAULTS).map((v) => v.address), DEFAULT_BPS.map((x) => BigInt(x))]);
  // issue 1743: no active (applied receipt) vector after the deploy, so the effective vector is the default one
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
    // issue 1705 C5: the timelock stage granted the emergency key its role (the RoleGranted log the holder count is read from)
    ch.roleGrantedLog(v.address, EMERGENCY_ROLE, EMERGENCY, 2600n);
    const caps = k === "rmUSDC" ? { tvl: 1_000_000_000_000n, per: 100_000_000_000n } : { tvl: 10_000_000_000n, per: 1_000_000_000n };
    ch.set(v.address, "tvlCap", caps.tvl);
    ch.set(v.address, "perDepositCap", caps.per);
    ch.set(v.address, "exitFeeBps", 10n);
    if (v.kind !== "usdc") ch.set(v.address, "navDeviationGuardBps", NAV_GUARD_BPS);
    if (v.kind !== "usdc") ch.set(v.address, "maxSlippageBps", BASKET_SLIPPAGE_BPS[k]!);
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
    // core 1676: the vault allowlists the codehash of the V4 adapter it was deployed with
    ch.set(v.address, "adapterCodeHashAllowed", (a: any[]) => String(a[0]).toLowerCase() === keccak256(ch.codes.get(V4_ADAPTER.toLowerCase())!).toLowerCase());
    vsheet[k] = {
      tvlCap: caps.tvl, perDepositCap: caps.per, exitFeeBps: 10n, feeRecipient: SAFE, expectPaused: paused, routerEligible: true,
      ...(v.kind !== "usdc" ? { navDeviationBps: NAV_GUARD_BPS, minPoolLiquidity: POOL_LIQUIDITY_FLOOR, maxSlippageBps: BASKET_SLIPPAGE_BPS[k]! } : {}),
      assets: assets.map((x) => ({ ...x })), ...(k === "rmUSDC" ? { seed: 1_000_000n, seedShareReceiver: SEED_RECEIVER, adapters: USDC_ADAPTERS.map((x) => ({ ...x })) } : {}),
    };
  }

  // issue 1705 C4: rmUSDC registered its three lending adapters at the deploy script's caps and allowed each address and each code hash, nothing else
  const usdcVault = VAULTS.rmUSDC!.address;
  USDC_ADAPTERS.forEach((x, i) => ch.codes.set(x.address.toLowerCase(), `0x6080${(i + 1).toString(16).padStart(4, "0")}` as Hex));
  const adapterHashes = USDC_ADAPTERS.map((x) => keccak256(ch.codes.get(x.address.toLowerCase())!).toLowerCase());
  ch.set(usdcVault, "adapterCount", BigInt(USDC_ADAPTERS.length));
  ch.set(usdcVault, "adapters", (a: any[]) => {
    const x = USDC_ADAPTERS[Number(a[0])];
    if (!x) throw new Error("execution reverted");
    return [x.address, x.capBps, true];
  });
  ch.set(usdcVault, "adapterAllowed", (a: any[]) => USDC_ADAPTERS.some((x) => x.address.toLowerCase() === String(a[0]).toLowerCase()));
  ch.set(usdcVault, "adapterCodeHashAllowed", (a: any[]) => adapterHashes.includes(String(a[0]).toLowerCase()));
  for (const [i, x] of USDC_ADAPTERS.entries()) {
    ch.allowlistLog(usdcVault, SIG_ADAPTER_ALLOWED_SET, pad(x.address, { size: 32 }), true);
    ch.allowlistLog(usdcVault, SIG_ADAPTER_CODE_HASH_ALLOWED_SET, adapterHashes[i]! as Hex, true);
  }

  // core 1676: the recorder and the V4 adapter read back the configured PoolKey. The recorder keeps a live ring of 7,201 slots (core 1793,
  // the 4 h sell anchor window) and holds no admin.
  ch.set(RECORDER, "POOL_MANAGER", POOL_MANAGER);
  ch.set(RECORDER, "POOL_ID", RM_POOL_ID);
  ch.set(RECORDER, "token0", RM_POOL_KEY.currency0);
  ch.set(RECORDER, "token1", RM_POOL_KEY.currency1);
  ch.set(RECORDER, "fee", RM_POOL_KEY.fee);
  ch.set(RECORDER, "tickSpacing", RM_POOL_KEY.tickSpacing);
  ch.set(RECORDER, "hooks", ZERO);
  ch.set(RECORDER, "slot0", [1n << 96n, -403009, 3, 7201]);
  ch.set(V4_ADAPTER, "POOL_MANAGER", POOL_MANAGER);
  ch.set(V4_ADAPTER, "RECORDER", RECORDER);
  ch.set(V4_ADAPTER, "POOL_ID", RM_POOL_ID);
  ch.set(V4_ADAPTER, "CURRENCY0", RM_POOL_KEY.currency0);
  ch.set(V4_ADAPTER, "CURRENCY1", RM_POOL_KEY.currency1);
  ch.set(V4_ADAPTER, "POOL_FEE", RM_POOL_KEY.fee);
  ch.set(V4_ADAPTER, "TICK_SPACING", RM_POOL_KEY.tickSpacing);

  const frozenCounts = { safe: 1, libs: 4, recorder: 6, authority: 1, vault: 12, registry: 2, router: 2, gateway: 3, governance: 2, "ic-policy": 3, "vault-proto": 6, "vault-agent": 3, "vault-rwa": 6, timelock: 18 };
  ch.noncesMap.set(DEPLOYER.toLowerCase(), Object.values(frozenCounts).reduce((a, b) => a + b, 0) + PROOF_TX_NONCES); // the stages plus the deployer's prove-control transaction (core 1712)

  const w = (f: string, o: unknown) => writeFileSync(join(manifestDir, f), JSON.stringify(o, null, 2));
  const file = (stage: string) => stageManifestFile(table, stage);
  // issue 1809: each proxy stage names the implementation behind its proxy, the authority (the authority stage's timelock, the handover's) and the release mode
  const governed = { upgrade_authority: TIMELOCK, upgrade_mode: "upgradeable" };
  w(file("authority"), { chain_id: chainId, timelock: TIMELOCK, safe: SAFE, min_delay: delay, deployment_kind: "production", timelock_codehash: keccak256(ch.codes.get(TIMELOCK.toLowerCase())!) });
  w(file("vault"), {
    chain_id: chainId, vault: VAULTS.rmUSDC.address, seed_share_receiver: SEED_RECEIVER, seed_shares: SEED_SHARES.toString(), deployer_share_balance_after: 0,
    aave_adapter: USDC_ADAPTERS[0].address, compound_adapter: USDC_ADAPTERS[1].address, moonwell_flagship_adapter: USDC_ADAPTERS[2].address,
    vault_implementation: IMPLEMENTATIONS.rmUSDC, ...governed,
  });
  w(file("registry"), { chain_id: chainId, registry: REGISTRY, registry_implementation: IMPLEMENTATIONS.registry, ...governed });
  w(file("router"), { chain_id: chainId, router: ROUTER, router_implementation: IMPLEMENTATIONS.router, ...governed });
  w(file("gateway"), { chain_id: chainId, gateway: GATEWAY, gateway_implementation: IMPLEMENTATIONS.gateway, ...governed });
  w(file("governance"), { chain_id: chainId, governance: GOV });
  w(file("ic-policy"), { chain_id: chainId, policy: ICP, consensus_receipt: REC, policy_implementation: IMPLEMENTATIONS.icpolicy, consensus_receipt_implementation: IMPLEMENTATIONS.receipt, ...governed });
  w(file("timelock"), {
    chain_id: chainId, timelock: TIMELOCK, safe: SAFE, emergency: EMERGENCY, executorPolicy: "open", cancellerPolicy: "safe-only", code_hashes: { safe: safeHash },
    roles: { gateway_agents_listed_count: 0, deployer_owns_a_listed_gateway_agent: false },
  });
  w("safe.json", { chain_id: chainId, safe: SAFE });
  w(file("libs"), { chain_id: chainId, tick_math: LIBS.tick_math });
  w(file("recorder"), { chain_id: chainId, recorder: RECORDER, pool_manager: POOL_MANAGER, pool_id: RM_POOL_ID, ring_slots: 7201 });
  for (const v of table.vaults) if (v.key !== "USDC") {
    const vkey = ({ PROTO: "rmPROTO", AGENT: "rmAGENT", RWA: "rmRWA" } as Record<string, string>)[v.key]!;
    w(basename(v.manifest), { chain_id: chainId, vault: VAULTS[vkey]!.address, vault_implementation: IMPLEMENTATIONS[vkey]!, ...governed, ...(v.key === "AGENT" ? { adapter: ZERO, adapter_v4: V4_ADAPTER, recorder: RECORDER } : {}) });
  }

  const sheet: VerifySheet = {
    chainId, deployer: DEPLOYER, pauser: PAUSER, emergency: EMERGENCY, safeOwners: [...OWNERS], safeThreshold: 2, timelockDelay: delay, vaults: vsheet,
    defaultWeights: Object.keys(VAULTS).map((vault, i) => ({ vault, bps: DEFAULT_BPS[i]! })),
    upgradeMode: "upgradeable",
  };
  ch.txs.set(PROOF_TX.toLowerCase(), { to: SAFE, input: proofInput(chainId), value: 0n, status: "success" });
  const opts: VerifyOptions = { chain: ch, manifestDir, table, sheet, fromBlock: 0n, frozenCounts, artifactsDir, retryBaseMs: 0, usdcCodeHash: keccak256(USDC_CODE), controlProof: { txHash: PROOF_TX, nonce: 0 } };
  return { chain: ch, dir, manifestDir, artifactsDir, sheet, opts, libraries: LIBS };
}

export const failed = (r: { checks: { label: string; ok: boolean }[] }) => r.checks.filter((c) => !c.ok).map((c) => c.label);
void ({} as VHex);
