// A healthy four-vault deployment as in-memory chain state plus manifests and artifacts on disk.
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
  ADMIN_ROLE, WEIGHT_SETTER_ROLE, WEIGHT_SETTER_ROTATOR_ROLE, WEIGHT_SETTER_ROTATION_EXECUTOR_ROLE, coreContracts, stageManifestFile, EMERGENCY_ROLE, DEPOSIT_PAUSER_ROLE, PROPOSER_ROLE, EXECUTOR_ROLE, CANCELLER_ROLE, SAFE_141_FALLBACK_HANDLER, SAFE_FALLBACK_SLOT,
  RM_TOKEN, SAFE_GUARD_SLOT, SAFE_L2_141_SINGLETON, SIG_AGENT_AUTHORIZED, SIG_ROLE_GRANTED, Z32, ZERO,
} from "../../src/verify/constants.ts";
import { getStageTable } from "../../src/stages.ts";
import { basename } from "node:path";
import { padTopic } from "../../src/verify/logs.ts";
import { USDC_ADDRESS } from "../../src/usdc.ts";
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
/** Library name (the table'"'"'s `libraries[].name`) -> address. */
const LIBS: Record<string, Address> = { tick_math: addr(0x11b1) };
const ASSETS: Record<string, { token: Address; pool: Address; swapFee: number; adapter: Address }[]> = {
  rmPROTO: [
    { token: addr(0xe7), pool: addr(0xf001), swapFee: 500, adapter: addr(0xad01) },
    { token: addr(0xcb), pool: addr(0xf002), swapFee: 500, adapter: addr(0xad01) },
  ],
  rmAGENT: [{ token: RM_TOKEN, pool: addr(0xf004), swapFee: 10000, adapter: addr(0xad01) }],
  rmRWA: [{ token: addr(0xde5), pool: addr(0xf003), swapFee: 500, adapter: addr(0xad01) }],
};

/** Issue 1666: the guard every basket carries, and the in-range liquidity of every pool against the sheet floor. */
export const NAV_GUARD_BPS = 100n;
export const POOL_LIQUIDITY = 10n ** 18n;
export const POOL_LIQUIDITY_FLOOR = 10n ** 12n;
export const VOTER_A = addr(0xb001);
export const VOTER_B = addr(0xb002);
const GOV_SHEET = { voters: [VOTER_A, VOTER_B], voterPower: 1000n, quorum: 2n, votingPeriod: 3600n, executionDelay: 3600n };
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
  const names = [...new Set([...CORE_CONTRACTS.map((c) => c.artifact), ...table.vaults.map((v) => v.artifact), ...Object.keys(LIBS).map(libArtifact)])];
  const codeByName: Record<string, Hex> = {};
  for (const n of names) {
    const { artifact, chain } = codeFor(n, "ab");
    codeByName[n] = chain;
    mkdirSync(join(artifactsDir, `${n}.sol`), { recursive: true });
    writeFileSync(join(artifactsDir, `${n}.sol`, `${n}.json`), JSON.stringify({ deployedBytecode: { object: artifact, immutableReferences: { "1": [IMMUTABLE] }, linkReferences: {} } }));
  }
  const setCode = (a: Address, name: string) => ch.codes.set(a.toLowerCase(), codeByName[name]);

  const byName: Record<string, Address> = { gateway: GATEWAY, registry: REGISTRY, router: ROUTER, governance: GOV, icpolicy: ICP, receipt: REC, timelock: TIMELOCK };
  for (const c of CORE_CONTRACTS) setCode(byName[c.name], c.artifact);
  for (const [k, v] of Object.entries(VAULTS)) setCode(v.address, vaultArtifactOf(k));
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
  // deploy-time configuration (issue 1520): voting power, quorum, voting period, execution delay and the router default weights
  ch.set(GOV, "votingPower", () => GOV_SHEET.voterPower);
  ch.set(GOV, "quorumThreshold", GOV_SHEET.quorum);
  ch.set(GOV, "votingPeriod", GOV_SHEET.votingPeriod);
  ch.set(GOV, "executionDelay", GOV_SHEET.executionDelay);
  ch.set(ROUTER, "getDefaultWeights", [Object.values(VAULTS).map((v) => v.address), DEFAULT_BPS.map((x) => BigInt(x))]);
  // the deploy authorizes no agent: the gateway carries no AgentAuthorized log and nobody holds AGENT_ROLE
  // deployer once held roles; all were renounced
  ch.roleGrantedLog(TIMELOCK, ADMIN_ROLE, DEPLOYER, 120n);
  ch.roleGrantedLog(VAULTS.rmUSDC.address, EMERGENCY_ROLE, DEPLOYER, 2500n);

  const vsheet: VerifySheet["vaults"] = {};
  for (const [k, v] of Object.entries(VAULTS)) {
    ch.set(v.address, "registry", REGISTRY);
    ch.grant(v.address, EMERGENCY_ROLE, EMERGENCY);
    const caps = k === "rmUSDC" ? { tvl: 1_000_000_000_000n, per: 100_000_000_000n } : { tvl: 10_000_000_000n, per: 1_000_000_000n };
    ch.set(v.address, "tvlCap", caps.tvl);
    ch.set(v.address, "perDepositCap", caps.per);
    ch.set(v.address, "exitFeeBps", 10n);
    if (v.kind !== "usdc") ch.set(v.address, "navDeviationGuardBps", NAV_GUARD_BPS);
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
      return [x.token, x.pool, x.swapFee, true, x.adapter, 0];
    });
    vsheet[k] = {
      tvlCap: caps.tvl, perDepositCap: caps.per, exitFeeBps: 10n, feeRecipient: SAFE, expectPaused: paused, routerEligible: true,
      ...(v.kind !== "usdc" ? { navDeviationBps: NAV_GUARD_BPS, minPoolLiquidity: POOL_LIQUIDITY_FLOOR } : {}),
      assets: assets.map((x) => ({ ...x })), ...(k === "rmUSDC" ? { seed: 1_000_000n, seedShareReceiver: SEED_RECEIVER } : {}),
    };
  }

  const frozenCounts = { safe: 1, libs: 4, vault: 12, registry: 2, router: 2, gateway: 3, governance: 2, "ic-policy": 3, "vault-proto": 6, "vault-agent": 3, "vault-rwa": 6, timelock: 18 };
  ch.noncesMap.set(DEPLOYER.toLowerCase(), Object.values(frozenCounts).reduce((a, b) => a + b, 0));

  const w = (f: string, o: unknown) => writeFileSync(join(manifestDir, f), JSON.stringify(o, null, 2));
  const file = (stage: string) => stageManifestFile(table, stage);
  w(file("vault"), { chain_id: chainId, vault: VAULTS.rmUSDC.address, seed_share_receiver: SEED_RECEIVER, seed_shares: SEED_SHARES.toString(), deployer_share_balance_after: 0 });
  w(file("registry"), { chain_id: chainId, registry: REGISTRY });
  w(file("router"), { chain_id: chainId, router: ROUTER });
  w(file("gateway"), { chain_id: chainId, gateway: GATEWAY });
  w(file("governance"), { chain_id: chainId, governance: GOV });
  w(file("ic-policy"), { chain_id: chainId, policy: ICP, consensus_receipt: REC });
  w(file("timelock"), {
    chain_id: chainId, timelock: TIMELOCK, safe: SAFE, emergency: EMERGENCY, executorPolicy: "open", cancellerPolicy: "safe-only", code_hashes: { safe: safeHash },
    roles: { gateway_agents_listed_count: 0, deployer_owns_a_listed_gateway_agent: false },
  });
  w("safe.json", { chain_id: chainId, safe: SAFE });
  w(file("libs"), { chain_id: chainId, tick_math: LIBS.tick_math });
  for (const v of table.vaults) if (v.key !== "USDC") w(basename(v.manifest), { chain_id: chainId, vault: Object.entries(VAULTS).find(([k]) => k === ({ PROTO: "rmPROTO", AGENT: "rmAGENT", RWA: "rmRWA" } as Record<string, string>)[v.key])![1].address });

  const sheet: VerifySheet = {
    chainId, deployer: DEPLOYER, pauser: PAUSER, emergency: EMERGENCY, safeOwners: [...OWNERS], safeThreshold: 2, timelockDelay: delay, vaults: vsheet,
    governance: { ...GOV_SHEET, voters: [...GOV_SHEET.voters] },
    defaultWeights: Object.keys(VAULTS).map((vault, i) => ({ vault, bps: DEFAULT_BPS[i]! })),
  };
  ch.txs.set(PROOF_TX.toLowerCase(), { to: SAFE, input: proofInput(chainId), value: 0n, status: "success" });
  const opts: VerifyOptions = { chain: ch, manifestDir, table, sheet, fromBlock: 0n, frozenCounts, artifactsDir, retryBaseMs: 0, usdcCodeHash: keccak256(USDC_CODE), controlProof: { txHash: PROOF_TX, nonce: 0 } };
  return { chain: ch, dir, manifestDir, artifactsDir, sheet, opts, libraries: LIBS };
}

export const failed = (r: { checks: { label: string; ok: boolean }[] }) => r.checks.filter((c) => !c.ok).map((c) => c.label);
void ({} as VHex);
