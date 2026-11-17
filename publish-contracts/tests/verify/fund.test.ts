import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, pad, toHex } from "viem";
import { loadStageTable, scopeTable } from "../../src/stage-table.ts";
import { USDC_ADDRESS } from "../../src/usdc.ts";
import {
  ADMIN_ROLE,
  SAFE_141_FALLBACK_HANDLER,
  SAFE_FALLBACK_SLOT,
  SAFE_GUARD_SLOT,
  SAFE_SENTINEL,
  SIG_ROLE_GRANTED,
  Z32,
  ZERO,
} from "../../src/verify/constants.ts";
import { ERC1967_IMPLEMENTATION_SLOT, ERC1967_PROXY_ARTIFACT, verifyLinkedLibraries } from "../../src/verify/codehash.ts";
import {
  FLOW_PARAM_FIELDS,
  FUND_ROLES,
  readFundActiveState,
  verifyFundSystem,
  verifyFundUpgradeSafety,
  type FundActiveState,
} from "../../src/verify/fund.ts";
import {
  ERC1967_ADMIN_SLOT,
  ERC1967_BEACON_SLOT,
  INITIALIZABLE_SLOT,
  upgradeabilityChecks,
} from "../../src/verify/upgradeability.ts";
import { Collector } from "../../src/verify/collector.ts";
import type { Address, ChainReader, ExpectedFundAsset, Hex, LogEntry, VerifyOptions, VerifySheet } from "../../src/verify/types.ts";
import { REPO_ROOT } from "../repo-root.ts";

const TABLE = loadStageTable(REPO_ROOT);
const SCRATCH_PARENT = tmpdir();
const TEMP_DIRS: string[] = [];

function mkWorkDir(prefix: string): string {
  mkdirSync(SCRATCH_PARENT, { recursive: true });
  const d = mkdtempSync(join(SCRATCH_PARENT, prefix));
  TEMP_DIRS.push(d);
  return d;
}

afterAll(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

const A = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
const lc = (s: string): string => s.toLowerCase();
const wordOf = (a: Address): Hex => pad(a, { size: 32 }).toLowerCase() as Hex;

const DEPLOYER = A(0xde9107);
const EMERGENCY = A(0xe3e5);
const PAUSER = A(0x9a05);
const KEEPER = A(0x1eee9);
const SAFE = A(0x5afe);
const SAFE_OWNERS: Address[] = [A(0x101), A(0x102), A(0x103)];
const TIMELOCK = A(0x71e1);
const FUND = A(0xf001);
const REBALANCER = A(0xf002);
const GOVERNANCE = A(0xf003);
const QUEUE = A(0xf004);
const RECEIPT = A(0xf005);
const SUBMITTER = A(0x50b1);
const KEEPER_OWNER = A(0x8801);
const KEEPER_BOT = A(0x8802);

const LIB_NESTED = A(0x7701); // FlowMatchLib
const LIB_FIRST_HOP = A(0x7702); // FundDelistLib (links FlowMatchLib)

const IMPLS: Record<string, Address> = {
  ConsensusRecommendationReceipt: A(0xaa01),
  RobotMoneyFund: A(0xaa02),
  Rebalancer: A(0xaa03),
  RebalanceGovernance: A(0xaa04),
  FlowQueue: A(0xaa05),
};

const SEED_SHARES = 1_000_000_000_000_000_000n;
const USDC_CODE: Hex = "0x6080604052aa11";
const USDC_HASH = keccak256(USDC_CODE);
const PROXY_BYTECODE: Hex = "0x608060405299880000";

const codeWithLink = (tag: string, linkedAddr: Address): Hex =>
  (`0x60806040${linkedAddr.slice(2)}${tag}0000`).toLowerCase() as Hex;
const placeholderCode = (tag: string): Hex => codeWithLink(tag, ZERO);

const ARTIFACT_BYTECODES: Record<string, { artifact: Hex; onchain: Hex; linkName?: string; linkFile?: string }> = {
  ERC1967Proxy: { artifact: PROXY_BYTECODE, onchain: PROXY_BYTECODE },
  FlowMatchLib: { artifact: "0x6080604052bb010000", onchain: "0x6080604052bb010000" },
  FundDelistLib: {
    artifact: placeholderCode("cc01"),
    onchain: codeWithLink("cc01", LIB_NESTED),
    linkName: "FlowMatchLib",
    linkFile: "contracts/lib/FlowMatchLib.sol",
  },
  RobotMoneyFund: {
    artifact: placeholderCode("dd01"),
    onchain: codeWithLink("dd01", LIB_FIRST_HOP),
    linkName: "FundDelistLib",
    linkFile: "contracts/lib/FundDelistLib.sol",
  },
  ConsensusRecommendationReceipt: { artifact: "0x6080604052dd020000", onchain: "0x6080604052dd020000" },
  Rebalancer: { artifact: "0x6080604052dd030000", onchain: "0x6080604052dd030000" },
  RebalanceGovernance: { artifact: "0x6080604052dd040000", onchain: "0x6080604052dd040000" },
  FlowQueue: { artifact: "0x6080604052dd050000", onchain: "0x6080604052dd050000" },
};

function writeArtifacts(outDir: string): void {
  for (const [name, spec] of Object.entries(ARTIFACT_BYTECODES)) {
    const dir = join(outDir, `${name}.sol`);
    mkdirSync(dir, { recursive: true });
    const linkReferences = spec.linkName
      ? { [spec.linkFile!]: { [spec.linkName]: [{ start: 4, length: 20 }] } }
      : {};
    writeFileSync(
      join(dir, `${name}.json`),
      JSON.stringify({ deployedBytecode: { object: spec.artifact, linkReferences, immutableReferences: {} } }),
    );
  }
}

function writeManifests(manifestDir: string, chainId = 8453, upgradeMode: "upgradeable" | "frozen" = "upgradeable"): void {
  mkdirSync(manifestDir, { recursive: true });
  const wr = (name: string, body: object) => writeFileSync(join(manifestDir, `${name}.json`), JSON.stringify(body));
  wr("safe", { safe: SAFE });
  wr("fund-libs", { chain_id: chainId });
  wr("fund-receipt", { chain_id: chainId, consensus_receipt: RECEIPT, upgrade_timelock: TIMELOCK, upgrade_mode: upgradeMode });
  wr("fund", { chain_id: chainId, fund: FUND, upgrade_timelock: TIMELOCK, upgrade_mode: upgradeMode, seed_shares: SEED_SHARES.toString() });
  wr("rebalancer", { chain_id: chainId, rebalancer: REBALANCER, upgrade_timelock: TIMELOCK, upgrade_mode: upgradeMode });
  wr("fund-governance", { chain_id: chainId, governance: GOVERNANCE, upgrade_timelock: TIMELOCK, upgrade_mode: upgradeMode });
  wr("queue", { chain_id: chainId, queue: QUEUE, upgrade_timelock: TIMELOCK, upgrade_mode: upgradeMode });
  wr("fund-wiring", { chain_id: chainId });
  wr("fund-timelock", {
    chain_id: chainId,
    timelock: TIMELOCK,
    fund: FUND,
    rebalancer: REBALANCER,
    governance: GOVERNANCE,
    queue: QUEUE,
    consensus_receipt: RECEIPT,
    safe: SAFE,
    executorPolicy: "safe-only",
  });
}

const DEFAULT_FROZEN_COUNTS: Record<string, number> = {
  safe: 1,
  "fund-libs": 16,
  "fund-receipt": 2,
  fund: 18,
  rebalancer: 7,
  "fund-governance": 2,
  queue: 2,
  "fund-wiring": 3,
  "fund-timelock": 15,
};
const DEFAULT_NONCE_SUM = Object.values(DEFAULT_FROZEN_COUNTS).reduce((a, b) => a + b, 0);

function defaultAssets(): ExpectedFundAsset[] {
  return [
    { kind: 0, active: true, capBps: 4000n, adapter: A(0xad01), token: ZERO, pool: ZERO, poolFee: 0n, twapWindow: 0n, venue: 0, feed: ZERO, maxFeedAge: 0n },
    { kind: 0, active: true, capBps: 3000n, adapter: A(0xad02), token: ZERO, pool: ZERO, poolFee: 0n, twapWindow: 0n, venue: 0, feed: ZERO, maxFeedAge: 0n },
    { kind: 0, active: true, capBps: 3000n, adapter: A(0xad03), token: ZERO, pool: ZERO, poolFee: 0n, twapWindow: 0n, venue: 0, feed: ZERO, maxFeedAge: 0n },
    { kind: 1, active: true, capBps: 5000n, adapter: A(0xad04), token: A(0xbb01), pool: A(0xcc01), poolFee: 500n, twapWindow: 1800n, venue: 0, feed: A(0xdd01), maxFeedAge: 3600n },
    { kind: 1, active: true, capBps: 5000n, adapter: A(0xad05), token: A(0xbb02), pool: A(0xcc02), poolFee: 500n, twapWindow: 1800n, venue: 0, feed: A(0xdd02), maxFeedAge: 3600n },
  ];
}

function defaultSheetParams(): Record<string, bigint> {
  return {
    FLOW_EPOCH_LENGTH: 21600n,
    FLOW_SETTLE_WINDOW: 3600n,
    FLOW_MIN_HOLD: 3600n,
    FLOW_KEEPER_GRACE: 21600n,
    FLOW_MAX_EPOCH_FLOW_BPS: 500n,
    FLOW_EPOCH_FLOOR_USDC: 250_000_000_000n,
    FLOW_MAX_SHARE_PRICE_MOVE_BPS: 1000n,
    FLOW_MAX_ROLL: 8n,
    FLOW_MIN_REQUEST_USDC: 100_000_000n,
    FLOW_MAX_FREEZE: 604800n,
    FLOW_SLICES: 12n,
    FLOW_QUORUM: 9n,
    FLOW_DISPERSION_BPS: 100n,
    FLOW_REF_BAND_BPS: 90n,
    FLOW_LEG_BAND_BPS: 100n,
    FLOW_SEQUENCER_GRACE: 3600n,
    FLOW_USDC_PEG_BAND_BPS: 50n,
    FLOW_MAX_LEND_RATE_GROWTH_BPS: 10n,
    FLOW_CANCEL_BUFFER: 900n,
    FLOW_MAX_PAUSE: 259200n,
    FUND_MIN_POOL_DEPTH_USDC: 2_000_000_000_000n,
    FUND_FEE_MARGIN_BPS: 20n,
    FUND_DELIST_BAND_BPS: 300n,
    FUND_DELIST_BUDGET_BPS: 300n,
    FUND_MAX_BASKET_BPS: 6500n,
    REBALANCER_STEP_DEPTH_BPS: 50n,
    FLOW_BASKET_CALL_BPS: 100n,
  };
}

function makeSheet(over: Partial<NonNullable<VerifySheet["fund"]>> = {}, rootOver: Partial<VerifySheet> = {}): VerifySheet {
  return {
    chainId: 8453,
    deployer: DEPLOYER,
    pauser: PAUSER,
    emergency: EMERGENCY,
    safeOwners: SAFE_OWNERS,
    safeThreshold: 2,
    timelockDelay: 900,
    deploymentKind: "rehearsal",
    upgradeMode: "upgradeable",
    vaults: {},
    defaultWeights: [],
    fund: {
      keeper: KEEPER,
      tvlCap: 1_000_000_000n,
      perDepositCap: 500_000_000n,
      exitFeeBps: 10n,
      maxSlippageBps: 50n,
      navDeviationBps: 100n,
      minSeedUsdc: 1_000_000n,
      params: defaultSheetParams(),
      feeRecipient: "@safe",
      receiptSubmitters: [SUBMITTER],
      assets: defaultAssets(),
      keeperType: "eoa",
      ...over,
    },
    ...rootOver,
  };
}

class FakeFundChain implements ChainReader {
  chain = 8453;
  head = 500n;
  codes = new Map<string, Hex>();
  storage = new Map<string, Hex>();
  nonces = new Map<string, number>();
  roles = new Map<string, Address[]>(); // key: `${contract}:${role}`
  nonEnumerableContracts = new Set<string>([lc(TIMELOCK), lc(FUND)]);
  fundAdminCountOverride?: bigint;
  safeModules: Address[] = [];
  legacyFlowParams = false;
  failDirectCancelBuffer = false;
  failDirectMaxPause = false;
  failFundLastBasketStepAt = false;
  overrides = new Map<string, (args: unknown[]) => unknown>();

  fundState: FundActiveState = {
    requestCount: 2n,
    claimCount: 1n,
    settlementCount: 1n,
    books: [100n, 200n, 300n, 4n, 500n, 600n, 700n, 8n],
    lastBasketStepAt: 1_700_000_123n,
    isShutdown: false,
    depositsPaused: false,
    queuePaused: false,
    windDownActive: false,
    depositsPausedUntil: 0n,
    rebalancePausedUntil: 0n,
    queuePausedUntil: 0n,
    matchIndexes: { dep: [3n, 0n], red: [1n, 1_000_000_000_000_000_000n] },
    freezes: [{ id: 1n, frozenUntil: 0n, freezeSetAt: 0n }],
    requests: [],
    claims: [],
  };
  /** The contents getRequest / getClaim return, by id (1-based). */
  requestBodies: Record<string, unknown>[] = [{ owner: A(0x71), amount: 5n, remaining: 5n, closed: false }, { owner: A(0x72), amount: 9n, remaining: 0n, closed: true }];
  claimBodies: Record<string, unknown>[] = [{ owner: A(0x71), shares: 3n, usdc: 4n, claimed: 0n }];
  /** Set false to model a build before Step 3f: the new getters revert. */
  step3fGetters = true;

  constructor(private readonly sheet: VerifySheet) {
    this.codes.set(lc(USDC_ADDRESS), USDC_CODE);
    this.codes.set(lc(TIMELOCK), "0x60806040");
    this.codes.set(lc(KEEPER), "0x");
    this.codes.set(lc(LIB_NESTED), ARTIFACT_BYTECODES.FlowMatchLib!.onchain);
    this.codes.set(lc(LIB_FIRST_HOP), ARTIFACT_BYTECODES.FundDelistLib!.onchain);

    const proxyMap: [Address, keyof typeof IMPLS][] = [
      [RECEIPT, "ConsensusRecommendationReceipt"],
      [FUND, "RobotMoneyFund"],
      [REBALANCER, "Rebalancer"],
      [GOVERNANCE, "RebalanceGovernance"],
      [QUEUE, "FlowQueue"],
    ];
    for (const [proxy, contract] of proxyMap) {
      const impl = IMPLS[contract]!;
      this.codes.set(lc(proxy), PROXY_BYTECODE);
      this.codes.set(lc(impl), ARTIFACT_BYTECODES[contract]!.onchain);
      this.storage.set(`${lc(proxy)}:${lc(ERC1967_IMPLEMENTATION_SLOT)}`, wordOf(impl));
      this.storage.set(`${lc(proxy)}:${lc(ERC1967_ADMIN_SLOT)}`, wordOf(ZERO));
      this.storage.set(`${lc(proxy)}:${lc(ERC1967_BEACON_SLOT)}`, wordOf(ZERO));
    }

    this.storage.set(`${lc(SAFE)}:${lc(SAFE_GUARD_SLOT)}`, wordOf(ZERO));
    this.storage.set(`${lc(SAFE)}:${lc(SAFE_FALLBACK_SLOT)}`, wordOf(SAFE_141_FALLBACK_HANDLER));
    this.nonces.set(lc(DEPLOYER), DEFAULT_NONCE_SUM + 1);

    // Roles
    this.setRole(TIMELOCK, FUND_ROLES.PROPOSER, [SAFE]);
    this.setRole(TIMELOCK, FUND_ROLES.CANCELLER, [SAFE]);
    this.setRole(TIMELOCK, FUND_ROLES.EXECUTOR, [SAFE]);
    for (const c of [FUND, REBALANCER, GOVERNANCE, QUEUE, RECEIPT]) {
      this.setRole(c, ADMIN_ROLE, [TIMELOCK]);
    }
    this.setRole(RECEIPT, Z32, [TIMELOCK]);
    this.setRole(RECEIPT, FUND_ROLES.RELEASER, [GOVERNANCE]);
    this.setRole(RECEIPT, FUND_ROLES.SUBMITTER, this.sheet.fund?.receiptSubmitters ?? []);
    this.setRole(GOVERNANCE, FUND_ROLES.TARGET_SETTER, [TIMELOCK]);
    this.setRole(FUND, FUND_ROLES.EMERGENCY, [EMERGENCY]);
    this.setRole(QUEUE, FUND_ROLES.EMERGENCY, [EMERGENCY]);
    this.setRole(QUEUE, FUND_ROLES.KEEPER, [KEEPER]);
    this.setRole(REBALANCER, FUND_ROLES.KEEPER, [KEEPER]);
    this.setRole(FUND, FUND_ROLES.GOVERNANCE, [GOVERNANCE]);
    this.setRole(FUND, FUND_ROLES.REBALANCER, [REBALANCER]);
    this.setRole(FUND, FUND_ROLES.FLOW, [QUEUE]);
  }

  setRole(contract: Address, role: Hex, holders: Address[]): void {
    this.roles.set(`${lc(contract)}:${lc(role)}`, holders.map((h) => lc(h) as Address));
  }

  on(at: Address, fnName: string, handler: (args: unknown[]) => unknown): void {
    this.overrides.set(`${lc(at)}:${fnName}`, handler);
  }

  async chainId(): Promise<number> { return this.chain; }
  async blockNumber(): Promise<bigint> { return this.head; }
  async getCode(address: Address): Promise<Hex> { return this.codes.get(lc(address)) ?? "0x"; }
  async nonce(address: Address): Promise<number> { return this.nonces.get(lc(address)) ?? 0; }
  async getStorageAt(address: Address, slot: Hex): Promise<Hex> {
    return this.storage.get(`${lc(address)}:${lc(slot)}`) ?? Z32;
  }
  async getTransaction() { return null; }
  async receiptStatus() { return null; }
  async deployReceipt() { return null; }
  async callRaw(): Promise<{ ok: boolean; data: Hex }> { return { ok: true, data: "0x" }; }

  async getLogs(params: { address?: Address | Address[]; topics: (Hex | Hex[] | null)[]; fromBlock: bigint; toBlock: bigint }): Promise<LogEntry[]> {
    const targets = Array.isArray(params.address) ? params.address.map(lc) : params.address ? [lc(params.address)] : [];
    const roleTopic = params.topics[1] as Hex | null;
    const logs: LogEntry[] = [];
    for (const [k, holders] of this.roles.entries()) {
      const [c, r] = k.split(":") as [Address, Hex];
      if (targets.length && !targets.includes(c)) continue;
      if (roleTopic && lc(r) !== lc(roleTopic)) continue;
      for (const h of holders) {
        logs.push({
          address: c,
          topics: [keccak256(toHex(SIG_ROLE_GRANTED)), r, wordOf(h)],
          data: "0x",
          blockNumber: 1n,
        });
      }
    }
    return logs;
  }

  async read(address: Address, signature: string, args: unknown[] = []): Promise<unknown> {
    const fn = /\bfunction\s+([A-Za-z0-9_]+)\s*\(/.exec(signature)?.[1] ?? signature;
    const custom = this.overrides.get(`${lc(address)}:${fn}`);
    if (custom) return custom(args);

    const f = this.sheet.fund!;
    const a = lc(address);

    if (fn === "upgradeTimelock") return TIMELOCK;
    if (fn === "upgradesFrozen") return this.sheet.upgradeMode === "frozen";
    if (fn === "hasRole") {
      const holders = this.roles.get(`${a}:${lc(String(args[0]))}`) ?? [];
      return holders.includes(lc(String(args[1])) as Address);
    }
    if (fn === "getRoleMemberCount") {
      if (this.nonEnumerableContracts.has(a)) throw new Error("execution reverted: not enumerable");
      return BigInt((this.roles.get(`${a}:${lc(String(args[0]))}`) ?? []).length);
    }
    if (fn === "getRoleMember") {
      if (this.nonEnumerableContracts.has(a)) throw new Error("execution reverted: not enumerable");
      const list = this.roles.get(`${a}:${lc(String(args[0]))}`) ?? [];
      return list[Number(args[1])]!;
    }
    if (fn === "adminCount" && a === lc(FUND)) {
      return this.fundAdminCountOverride ?? BigInt((this.roles.get(`${a}:${lc(ADMIN_ROLE)}`) ?? []).length);
    }
    if (fn === "getMinDelay" && a === lc(TIMELOCK)) return BigInt(this.sheet.timelockDelay);
    if (fn === "getThreshold" && a === lc(SAFE)) return BigInt(this.sheet.safeThreshold);
    if (fn === "getOwners" && a === lc(SAFE)) return this.sheet.safeOwners;
    if (fn === "getModulesPaginated" && a === lc(SAFE)) return { array: this.safeModules, next: SAFE_SENTINEL };

    if (a === lc(FUND)) {
      if (fn === "flowQueue") return QUEUE;
      if (fn === "assetCount") return BigInt((f.assets ?? defaultAssets()).length);
      if (fn === "config") {
        const feeRec = f.feeRecipient === "@safe" ? SAFE : (f.feeRecipient ?? SAFE);
        return [f.tvlCap, f.perDepositCap, f.exitFeeBps, feeRec];
      }
      if (fn === "assetConfigs") return f.assets ?? defaultAssets();
      if (fn === "minSeedUsdc") return f.minSeedUsdc;
      if (fn === "maxSlippageBps") return f.maxSlippageBps;
      if (fn === "navDeviationGuardBps") return f.navDeviationBps;
      if (fn === "balanceOf") return lc(String(args[0])) === lc(FUND) ? SEED_SHARES : 0n;
      if (fn === "minPoolDepthUsdc") return f.params.FUND_MIN_POOL_DEPTH_USDC;
      if (fn === "feeMarginBps") return f.params.FUND_FEE_MARGIN_BPS;
      if (fn === "delistBandBps") return f.params.FUND_DELIST_BAND_BPS;
      if (fn === "delistBudgetBps") return f.params.FUND_DELIST_BUDGET_BPS;
      if (fn === "maxBasketBps") return f.params.FUND_MAX_BASKET_BPS;
      if (fn === "isShutdown") return this.fundState.isShutdown;
      if (fn === "depositsPaused") return this.fundState.depositsPaused;
      if (fn === "depositsPausedUntil" || fn === "rebalancePausedUntil") {
        if (!this.step3fGetters) throw new Error("execution reverted");
        return fn === "depositsPausedUntil" ? this.fundState.depositsPausedUntil : this.fundState.rebalancePausedUntil;
      }
      if (fn === "lastBasketStepAt") {
        if (this.failFundLastBasketStepAt) throw new Error("execution reverted");
        return this.fundState.lastBasketStepAt;
      }
    }

    if (a === lc(REBALANCER)) {
      if (fn === "fund") return FUND;
      if (fn === "stepDepthBps") return f.params.REBALANCER_STEP_DEPTH_BPS;
      if (fn === "lastBasketStepAt") return this.fundState.lastBasketStepAt;
    }

    if (a === lc(GOVERNANCE)) {
      if (fn === "fund") return FUND;
      if (fn === "receipts") return RECEIPT;
    }

    if (a === lc(QUEUE)) {
      if (fn === "flowParams") {
        const is20 = signature.includes("cancelBuffer") && signature.includes("maxPause");
        if (is20 && this.legacyFlowParams) throw new Error("execution reverted: legacy 18-field ABI");
        const base: Record<string, bigint> = Object.fromEntries(FLOW_PARAM_FIELDS.map(([field, name]) => [field, f.params[name]!]));
        return is20 ? { ...base, cancelBuffer: f.params.FLOW_CANCEL_BUFFER ?? 0n, maxPause: f.params.FLOW_MAX_PAUSE ?? 0n } : base;
      }
      if (fn === "cancelBuffer") {
        if (this.failDirectCancelBuffer) throw new Error("execution reverted: no direct cancelBuffer()");
        return f.params.FLOW_CANCEL_BUFFER;
      }
      if (fn === "maxPause") {
        if (this.failDirectMaxPause) throw new Error("execution reverted: no direct maxPause()");
        return f.params.FLOW_MAX_PAUSE;
      }
      if (fn === "flowLevers") return { basketCallBps: Number(f.params.FLOW_BASKET_CALL_BPS), legPriceMode: 0 };
      if (fn === "requestCount") return this.fundState.requestCount;
      if (fn === "claimCount") return this.fundState.claimCount;
      if (fn === "settlementCount") return this.fundState.settlementCount;
      if (fn === "books") return this.fundState.books;
      if (fn === "queuePaused") return this.fundState.queuePaused;
      if (["queuePausedUntil", "liveness", "currentMatchIndexes"].includes(fn) && !this.step3fGetters) throw new Error("execution reverted");
      if (fn === "queuePausedUntil") return this.fundState.queuePausedUntil;
      if (fn === "liveness") return { keeperConfigured: true, queuePausedNow: this.fundState.queuePaused, queuePausedUntil: this.fundState.queuePausedUntil, windDownActive: this.fundState.windDownActive };
      if (fn === "currentMatchIndexes") return { depIdx: this.fundState.matchIndexes!.dep, redIdx: this.fundState.matchIndexes!.red };
      if (fn === "getRequest") return this.requestBodies[Number(args[0]) - 1];
      if (fn === "getClaim") return this.claimBodies[Number(args[0]) - 1];
      if (fn === "getSettlement") return this.fundState.freezes![Number(args[0]) - 1];
    }

    throw new Error(`FakeFundChain: unhandled read ${fn} on ${address}`);
  }
}

function makeFixture(sheetOver: Partial<NonNullable<VerifySheet["fund"]>> = {}) {
  const root = mkWorkDir("fund-verify-test-");
  const manifestDir = join(root, "manifests");
  const artifactsDir = join(root, "out");
  writeManifests(manifestDir);
  writeArtifacts(artifactsDir);
  const sheet = makeSheet(sheetOver);
  const chain = new FakeFundChain(sheet);
  const opts: VerifyOptions = {
    system: "fund",
    chain,
    manifestDir,
    table: TABLE,
    sheet,
    fromBlock: 0n,
    frozenCounts: DEFAULT_FROZEN_COUNTS,
    artifactsDir,
    usdcCodeHash: USDC_HASH,
    retryBaseMs: 0,
  };
  return { root, manifestDir, artifactsDir, sheet, chain, opts };
}

const failedLabels = async (opts: VerifyOptions) => (await verifyFundSystem(opts)).checks.filter((c) => !c.ok).map((c) => `${c.label}: ${c.detail}`);

describe("verifyFundSystem positive coverage (Step 3f)", () => {
  test("passes a healthy Step 3f deployment including recursive linked libraries, 20-field flowParams, Safe defaults, EOA keeper, and TARGET_SETTER_ROLE", async () => {
    const { opts } = makeFixture();
    const report = await verifyFundSystem(opts);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.some((c) => c.label === "governance: TARGET_SETTER_ROLE held exclusively by the timelock")).toBe(true);
    expect(report.checks.some((c) => c.label === "fund RobotMoneyFund: linked libraries equal build")).toBe(true);
    expect(report.checks.some((c) => c.label === "queue: cancelBuffer() equals the sheet")).toBe(true);
    expect(report.checks.some((c) => c.label === "fund: minPoolDepthUsdc() equals the sheet")).toBe(true);
  });

  test("falls back cleanly to 18-field legacy flowParams() and reads cancelBuffer/maxPause from flowParams() when direct getters revert", async () => {
    // 1) Legacy 18-field flowParams when optional Step 3f params are absent
    const legacyParams = defaultSheetParams();
    delete legacyParams.FLOW_CANCEL_BUFFER;
    delete legacyParams.FLOW_MAX_PAUSE;
    const f1 = makeFixture({ params: legacyParams, receiptSubmitters: undefined, feeRecipient: A(0xfeec) });
    f1.chain.legacyFlowParams = true;
    expect(await failedLabels(f1.opts)).toEqual([]);

    // 2) Step 3f fallback: direct cancelBuffer()/maxPause() revert, read from 20-field flowParams()
    const f2 = makeFixture();
    f2.chain.failDirectCancelBuffer = true;
    f2.chain.failDirectMaxPause = true;
    expect(await failedLabels(f2.opts)).toEqual([]);
  });

  test("supports smart-account keeper checks (owners/getOwners, botKeys/getBotKeys) and non-default Safe modules/guard/fallback", async () => {
    const mod = A(0x50d1);
    const guard = A(0x50d2);
    const fallback = A(0x50d3);
    const { chain, opts } = makeFixture({
      keeperType: "smart-account",
      keeperOwners: [KEEPER_OWNER],
      keeperBotKeys: [KEEPER_BOT],
      safeModules: [mod],
      safeGuard: guard,
      safeFallbackHandler: fallback,
    });
    chain.codes.set(lc(KEEPER), "0x60806040");
    chain.safeModules = [mod];
    chain.storage.set(`${lc(SAFE)}:${lc(SAFE_GUARD_SLOT)}`, wordOf(guard));
    chain.storage.set(`${lc(SAFE)}:${lc(SAFE_FALLBACK_SLOT)}`, wordOf(fallback));
    chain.on(KEEPER, "owners", () => { throw new Error("reverted"); });
    chain.on(KEEPER, "getOwners", () => [KEEPER_OWNER]);
    chain.on(KEEPER, "botKeys", () => [KEEPER_BOT]);
    expect(await failedLabels(opts)).toEqual([]);
  });
});

describe("verifyFundSystem negative coverage (DEP-01..03, E47)", () => {
  test("rejects bad feeRecipient, wrong assetCount, invalid assetConfigs invariants, and asset field drift", async () => {
    // Zero feeRecipient when explicit expected isn't set
    const fZero = makeFixture({ feeRecipient: undefined });
    fZero.chain.on(FUND, "config", () => [1_000_000_000n, 500_000_000n, 10n, ZERO]);
    expect((await failedLabels(fZero.opts)).join("\n")).toContain("fund: config() equals the sheet");

    // Deployer as feeRecipient
    const fDep = makeFixture({ feeRecipient: undefined });
    fDep.chain.on(FUND, "config", () => [1_000_000_000n, 500_000_000n, 10n, DEPLOYER]);
    expect((await failedLabels(fDep.opts)).join("\n")).toContain("fund: config() equals the sheet");

    // Wrong assetCount
    const fCount = makeFixture();
    fCount.chain.on(FUND, "assetCount", () => 4n);
    expect((await failedLabels(fCount.opts)).join("\n")).toContain("fund: assetCount() matches expected count");

    // Asset invariants & expected mismatch (bad twapWindow, missing feed, mismatched capBps)
    const fInv = makeFixture({ assets: undefined });
    const broken = defaultAssets();
    broken[3]!.twapWindow = 300n;
    broken[4]!.feed = ZERO;
    fInv.chain.on(FUND, "assetConfigs", () => broken);
    const invFails = (await failedLabels(fInv.opts)).join("\n");
    expect(invFails).toContain("invalid twapWindow 300");
    expect(invFails).toContain("active basket missing feed");

    const fDrift = makeFixture();
    const drifted = defaultAssets();
    drifted[0]!.capBps = 4500n;
    fDrift.chain.on(FUND, "assetConfigs", () => drifted);
    expect((await failedLabels(fDrift.opts)).join("\n")).toContain("asset[0].capBps: got 4500, want 4000");
  });

  test("rejects recursive library code mismatch, extra/missing roles, adminCount() discrepancy, and Safe anomalies", async () => {
    // Nested library bytecode tamper
    const fLib = makeFixture();
    fLib.chain.codes.set(lc(LIB_NESTED), "0x60806040dead0000");
    expect((await failedLabels(fLib.opts)).join("\n")).toContain("fund RobotMoneyFund: linked libraries equal build");

    // TARGET_SETTER_ROLE held by deployer / extra holder
    const fTarget = makeFixture();
    fTarget.chain.setRole(GOVERNANCE, FUND_ROLES.TARGET_SETTER, [TIMELOCK, DEPLOYER]);
    const targetFails = (await failedLabels(fTarget.opts)).join("\n");
    expect(targetFails).toContain("governance: TARGET_SETTER_ROLE held exclusively by the timelock");
    expect(targetFails).toContain("governance: TARGET_SETTER_ROLE not held by the deployer");

    // Fund adminCount() discrepancy vs RoleGranted logs
    const fAdminCnt = makeFixture();
    fAdminCnt.chain.fundAdminCountOverride = 2n;
    expect((await failedLabels(fAdminCnt.opts)).join("\n")).toContain("log scan found 1 admin(s), adminCount() is 2");

    // RECEIPT_SUBMITTER_ROLE mismatch
    const fSub = makeFixture();
    fSub.chain.setRole(RECEIPT, FUND_ROLES.SUBMITTER, [DEPLOYER]);
    expect((await failedLabels(fSub.opts)).join("\n")).toContain("receipt: RECEIPT_SUBMITTER_ROLE held exclusively by sheet submitters");

    // Safe module, guard, and fallbackHandler drift
    const fSafe = makeFixture();
    fSafe.chain.safeModules = [A(0xbad1)];
    fSafe.chain.storage.set(`${lc(SAFE)}:${lc(SAFE_GUARD_SLOT)}`, wordOf(A(0xbad2)));
    fSafe.chain.storage.set(`${lc(SAFE)}:${lc(SAFE_FALLBACK_SLOT)}`, wordOf(A(0xbad3)));
    const safeFails = (await failedLabels(fSafe.opts)).join("\n");
    expect(safeFails).toContain("safe: modules equal sheet");
    expect(safeFails).toContain("safe: guard equals sheet");
    expect(safeFails).toContain("safe: fallback handler equals expected");
  });

  test("rejects one extra holder of each exclusive role (E47, DEP-03)", async () => {
    const intruder = A(0xe771);
    const cases: [string, Address, Hex, Address[], string][] = [
      ["timelock proposer", TIMELOCK, FUND_ROLES.PROPOSER, [SAFE, intruder], "timelock: PROPOSER_ROLE held exclusively by the Safe"],
      ["fund ADMIN", FUND, ADMIN_ROLE, [TIMELOCK, intruder], "fund: ADMIN_ROLE held exclusively by the timelock"],
      ["queue ADMIN", QUEUE, ADMIN_ROLE, [TIMELOCK, intruder], "queue: ADMIN_ROLE held exclusively by the timelock"],
      ["fund EMERGENCY", FUND, FUND_ROLES.EMERGENCY, [EMERGENCY, intruder], "fund: EMERGENCY_ROLE held exclusively by the emergency key"],
      ["queue EMERGENCY", QUEUE, FUND_ROLES.EMERGENCY, [EMERGENCY, intruder], "queue: EMERGENCY_ROLE held exclusively by the emergency key"],
      ["queue KEEPER", QUEUE, FUND_ROLES.KEEPER, [KEEPER, intruder], "queue: KEEPER_ROLE held exclusively by the keeper"],
      ["rebalancer KEEPER", REBALANCER, FUND_ROLES.KEEPER, [KEEPER, intruder], "rebalancer: KEEPER_ROLE held exclusively by the keeper"],
      ["fund FLOW", FUND, FUND_ROLES.FLOW, [QUEUE, intruder], "fund: FLOW_ROLE held exclusively by the queue"],
      ["fund REBALANCER", FUND, FUND_ROLES.REBALANCER, [REBALANCER, intruder], "fund: REBALANCER_ROLE held exclusively by the rebalancer"],
      ["fund GOVERNANCE", FUND, FUND_ROLES.GOVERNANCE, [GOVERNANCE, intruder], "fund: GOVERNANCE_ROLE held exclusively by governance"],
    ];
    // the clean fixture passes every one of these checks
    const clean = await failedLabels(makeFixture().opts);
    expect(clean).toEqual([]);
    for (const [name, contract, role, holders, label] of cases) {
      const f = makeFixture();
      f.chain.setRole(contract, role, holders);
      const fails = await failedLabels(f.opts);
      expect(fails.some((x) => x.startsWith(label)), `${name} must fail '${label}'`).toBe(true);
      expect(fails.some((x) => x.includes(lc(intruder))), `${name} detail names the intruder`).toBe(true);
    }
  });

  test("rejects keeper EOA/smart-account mismatches and Step 3f parameter drift", async () => {
    const fEoa = makeFixture({ keeperType: "eoa" });
    fEoa.chain.codes.set(lc(KEEPER), "0x6080");
    expect((await failedLabels(fEoa.opts)).join("\n")).toContain("keeper: EOA has no contract code");

    const fSa = makeFixture({ keeperType: "smart-account", keeperOwners: [KEEPER_OWNER], keeperBotKeys: [KEEPER_BOT] });
    fSa.chain.codes.set(lc(KEEPER), "0x6080");
    fSa.chain.on(KEEPER, "owners", () => [A(0x9999)]);
    fSa.chain.on(KEEPER, "botKeys", () => []);
    const saFails = (await failedLabels(fSa.opts)).join("\n");
    expect(saFails).toContain("keeper: smart account owners equal sheet");
    expect(saFails).toContain("keeper: smart account botKeys equal sheet");

    const f3f = makeFixture();
    f3f.chain.on(QUEUE, "cancelBuffer", () => 123n);
    f3f.chain.on(FUND, "delistBandBps", () => 999n);
    f3f.chain.on(FUND, "maxBasketBps", () => 7000n);
    const p3fFails = (await failedLabels(f3f.opts)).join("\n");
    expect(p3fFails).toContain("queue: cancelBuffer() equals the sheet");
    expect(p3fFails).toContain("fund: delistBandBps() equals the sheet");
    expect(p3fFails).toContain("fund: maxBasketBps() equals the sheet");
  });
});

describe("verifyLinkedLibraries and upgradeabilityChecks delegation (codehash + upgradeability)", () => {
  test("detects nested recursive library matches, zero links, truncated code, empty code, and missing artifact", async () => {
    const { artifactsDir, chain } = makeFixture();
    const ok = await verifyLinkedLibraries(chain, ARTIFACT_BYTECODES.RobotMoneyFund!.onchain, "RobotMoneyFund", artifactsDir);
    expect(ok.ok).toBe(true);
    expect(ok.count).toBe(2);
    expect(ok.libraries.map((l) => l.name)).toEqual(["FundDelistLib", "FlowMatchLib"]);

    expect((await verifyLinkedLibraries(chain, "0x", "RobotMoneyFund", artifactsDir)).ok).toBe(false);
    expect((await verifyLinkedLibraries(chain, "0x6080", "RobotMoneyFund", artifactsDir)).detail).toContain("too short");
    expect((await verifyLinkedLibraries(chain, placeholderCode("dd01"), "RobotMoneyFund", artifactsDir)).detail).toContain("zero library link");

    const noLibDir = mkWorkDir("fund-nolib-");
    mkdirSync(join(noLibDir, "RobotMoneyFund.sol"), { recursive: true });
    writeFileSync(
      join(noLibDir, "RobotMoneyFund.sol", "RobotMoneyFund.json"),
      JSON.stringify({ deployedBytecode: { object: placeholderCode("dd01"), linkReferences: { "contracts/X.sol": { MissingLib: [{ start: 4, length: 20 }] } } } }),
    );
    expect((await verifyLinkedLibraries(chain, ARTIFACT_BYTECODES.RobotMoneyFund!.onchain, "RobotMoneyFund", noLibDir)).detail).toContain("no build artifact for MissingLib");
  });

  test("upgradeabilityChecks delegates proxy library checks to verifyLinkedLibraries and surfaces nested tampering", async () => {
    const { artifactsDir, sheet, chain } = makeFixture();
    const proxyAddrByField: Record<string, Address> = {
      consensus_receipt: RECEIPT,
      fund: FUND,
      rebalancer: REBALANCER,
      governance: GOVERNANCE,
      queue: QUEUE,
    };
    for (const p of Object.values(proxyAddrByField)) {
      chain.storage.set(`${lc(p)}:${lc(INITIALIZABLE_SLOT)}`, wordOf(A(1)));
    }
    chain.codes.set(lc(LIB_NESTED), "0x60806040dead0000");
    const c = new Collector();
    await upgradeabilityChecks(c, chain, scopeTable(TABLE, "fund"), {
      sheet,
      timelock: TIMELOCK,
      artifactsDir,
      data: (spec) => ({
        [spec.field]: proxyAddrByField[spec.field],
        [spec.implementationField]: IMPLS[spec.contract],
        upgrade_timelock: TIMELOCK,
        upgrade_mode: "upgradeable",
      }),
    });
    const failedLinked = c.report().checks.filter((x) => !x.ok && x.detail.includes("FlowMatchLib"));
    expect(failedLinked.length).toBeGreaterThan(0);
    expect(failedLinked.some((x) => x.label.startsWith("fund:"))).toBe(true);
  });
});

describe("readFundActiveState and verifyFundUpgradeSafety (ARCH-08)", () => {
  const addresses = { fund: FUND, queue: QUEUE, rebalancer: REBALANCER, governance: GOVERNANCE, receipt: RECEIPT };

  test("reads active state from Fund or falls back to Rebalancer.lastBasketStepAt(), and passes identical pre/post upgrade checks", async () => {
    const { artifactsDir, chain } = makeFixture();
    const s1 = await readFundActiveState(chain, addresses);
    expect(s1.requestCount).toBe(2n);
    expect(s1.books).toEqual([100n, 200n, 300n, 4n, 500n, 600n, 700n, 8n]);

    // Fallback to rebalancer.lastBasketStepAt() when fund.lastBasketStepAt() reverts
    chain.failFundLastBasketStepAt = true;
    const s2 = await readFundActiveState(chain, addresses);
    expect(s2.lastBasketStepAt).toBe(s1.lastBasketStepAt);

    const layoutBase = { storage: [{ label: "a", type: "t_uint256", slot: "0", offset: 0, astId: 1, contract: "RobotMoneyFund" }], types: { t_uint256: { label: "uint256", numberOfBytes: "32" } } };
    const layoutGood = {
      storage: [
        ...layoutBase.storage,
        { label: "b", type: "t_uint256", slot: "1", offset: 0, astId: 2, contract: "RobotMoneyFund" },
      ],
      types: layoutBase.types,
    };
    const ok = await verifyFundUpgradeSafety({
      chain,
      timelock: TIMELOCK,
      addresses,
      preState: s1,
      artifactsDir,
      proxyArtifacts: { fund: "RobotMoneyFund" },
      layouts: [{ name: "fund", deployed: layoutBase, candidate: layoutGood }],
    });
    expect(ok.checks.filter((x) => !x.ok)).toEqual([]);
  });

  test("fails when upgradeTimelock, linked libraries, storage layout, or any active state value diverges", async () => {
    const { artifactsDir, chain } = makeFixture();
    const pre = await readFundActiveState(chain, addresses);

    chain.on(QUEUE, "upgradeTimelock", () => A(0x9999));
    chain.codes.set(lc(LIB_NESTED), "0x60806040dead0000");
    chain.fundState.claimCount = 99n;
    chain.fundState.books = [100n, 200n, 300n, 4n, 999n, 600n, 700n, 8n];
    chain.fundState.depositsPaused = true;

    const badLayoutA = { storage: [{ label: "x", type: "t_uint256", slot: "0", offset: 0, astId: 1, contract: "RobotMoneyFund" }], types: { t_uint256: { label: "uint256", numberOfBytes: "32" } } };
    const badLayoutB = { storage: [{ label: "x", type: "t_address", slot: "0", offset: 0, astId: 1, contract: "RobotMoneyFund" }], types: { t_address: { label: "address", numberOfBytes: "20" } } };

    const report = await verifyFundUpgradeSafety({
      chain,
      timelock: TIMELOCK,
      addresses,
      preState: pre,
      artifactsDir,
      proxyArtifacts: { fund: "RobotMoneyFund" },
      layouts: [{ name: "fund", deployed: badLayoutA, candidate: badLayoutB }],
    });
    expect(report.ok).toBe(false);
    const failed = report.checks.filter((c) => !c.ok).map((c) => c.label);
    expect(failed).toContain("fund upgrade: queue upgradeTimelock() is the timelock");
    expect(failed).toContain("fund upgrade: fund linked libraries equal build");
    expect(failed).toContain("fund upgrade: fund storage layout compatible");
    expect(failed).toContain("fund upgrade: claimCount() preserved");
    expect(failed).toContain("fund upgrade: books() preserved");
    expect(failed).toContain("fund upgrade: depositsPaused() preserved");
  });
});

describe("after-upgrade state comparison covers Step 3f state (E47, ARCH-08)", () => {
  const addresses = { fund: FUND, queue: QUEUE, rebalancer: REBALANCER, governance: GOVERNANCE, receipt: RECEIPT };
  const run = async (mutate: (chain: FakeFundChain) => void) => {
    const { artifactsDir, chain } = makeFixture();
    const pre = await readFundActiveState(chain, addresses);
    mutate(chain);
    const report = await verifyFundUpgradeSafety({ chain, timelock: TIMELOCK, addresses, preState: pre, artifactsDir });
    return { pre, report, failed: report.checks.filter((c) => !c.ok).map((c) => c.label) };
  };

  test("reads match indexes, freezes, windDown, pause ends, and request and claim contents", async () => {
    const { chain } = makeFixture();
    const s = await readFundActiveState(chain, addresses);
    expect(s.matchIndexes).toEqual({ dep: [3n, 0n], red: [1n, 1_000_000_000_000_000_000n] });
    expect(s.freezes).toEqual([{ id: 1n, frozenUntil: 0n, freezeSetAt: 0n }]);
    expect(s.windDownActive).toBe(false);
    expect(s.depositsPausedUntil).toBe(0n);
    expect(s.requests?.length).toBe(2);
    expect(s.claims?.length).toBe(1);
  });

  test("an unchanged state passes", async () => {
    expect((await run(() => {})).failed).toEqual([]);
  });

  for (const [name, label, mutate] of [
    ["a match index", "currentMatchIndexes() preserved", (c: FakeFundChain) => { c.fundState.matchIndexes = { dep: [4n, 0n], red: [1n, 1_000_000_000_000_000_000n] }; }],
    ["a redeem match factor", "currentMatchIndexes() preserved", (c: FakeFundChain) => { c.fundState.matchIndexes = { dep: [3n, 0n], red: [1n, 5n] }; }],
    ["a freeze", "settlement freezes (frozenUntil, freezeSetAt) preserved", (c: FakeFundChain) => { c.fundState.freezes = [{ id: 1n, frozenUntil: 99n, freezeSetAt: 50n }]; }],
    ["windDown", "windDown (queue liveness().windDownActive) preserved", (c: FakeFundChain) => { c.fundState.windDownActive = true; }],
    ["isShutdown", "isShutdown() preserved", (c: FakeFundChain) => { c.fundState.isShutdown = true; }],
    ["a deposits pause end", "depositsPausedUntil() preserved", (c: FakeFundChain) => { c.fundState.depositsPausedUntil = 123n; }],
    ["a rebalance pause end", "rebalancePausedUntil() preserved", (c: FakeFundChain) => { c.fundState.rebalancePausedUntil = 123n; }],
    ["a queue pause end", "queuePausedUntil() preserved", (c: FakeFundChain) => { c.fundState.queuePausedUntil = 123n; }],
    ["a request's contents", "request contents preserved", (c: FakeFundChain) => { c.requestBodies[1] = { owner: A(0x72), amount: 9n, remaining: 9n, closed: false }; }],
    ["a claim's contents", "claim contents preserved", (c: FakeFundChain) => { c.claimBodies[0] = { owner: A(0x71), shares: 3n, usdc: 4n, claimed: 4n }; }],
  ] as const) {
    test(`fails when ${name} changes across the upgrade`, async () => {
      const { failed } = await run(mutate);
      expect(failed.some((l) => l.includes(label)), failed.join(" | ")).toBe(true);
    });
  }

  test("a field the deployed build cannot read is skipped, one the upgrade loses is a failure", async () => {
    // before Step 3f: the getters revert, so only the old fields are compared
    const old = makeFixture();
    old.chain.step3fGetters = false;
    const pre = await readFundActiveState(old.chain, addresses);
    expect(pre.matchIndexes).toBeUndefined();
    expect((await verifyFundUpgradeSafety({ chain: old.chain, timelock: TIMELOCK, addresses, preState: pre, artifactsDir: old.artifactsDir })).checks.filter((c) => !c.ok)).toEqual([]);
    // after the upgrade the getter that worked before reverts: that fails
    const lost = makeFixture();
    const pre2 = await readFundActiveState(lost.chain, addresses);
    lost.chain.step3fGetters = false;
    const rep = await verifyFundUpgradeSafety({ chain: lost.chain, timelock: TIMELOCK, addresses, preState: pre2, artifactsDir: lost.artifactsDir });
    expect(rep.checks.filter((c) => !c.ok).map((c) => c.label)).toContain("fund upgrade: currentMatchIndexes() preserved");
  });
});
