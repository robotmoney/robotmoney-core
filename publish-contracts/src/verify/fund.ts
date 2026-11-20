// Deploy 4 (owner exception 2026-11-12): the fund system's verifier. It reads the chain and the fund system's manifests and checks every postcondition of the fund run on its own:
// each proxy's code against the build (masked: links and immutables), its upgrade authority and release mode, the timelock (delay, Safe as only proposer and canceller,
// executor the Safe alone, decision D4-10), the Safe (owners and threshold), the role handover (the timelock administers every contract, the deployer holds nothing, the emergency key and the keeper
// hold their roles), the one-time bindings (plan roles, FLOW_ROLE, the receipt releaser), the fund's configuration and the queue's flow parameters against the sheet, and the
// deployer nonce at the end of the deploy. It reads nothing of the vaults or gateway systems.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Collector } from "./collector.ts";
import { ERC1967_PROXY_ARTIFACT, compareDeployedCode, loadArtifact, logicCode, tryLoadArtifact, verifyLinkedLibraries } from "./codehash.ts";
import { ADMIN_ROLE, SAFE_141_FALLBACK_HANDLER, SAFE_FALLBACK_SLOT, SAFE_GUARD_SLOT, SAFE_SENTINEL, SIG_ROLE_GRANTED, Z32, ZERO } from "./constants.ts";
import { scanLogs, topicToAddress } from "./logs.ts";
import { isAddress, lc } from "./manifests.ts";
import { ERC1967_ADMIN_SLOT, ERC1967_BEACON_SLOT } from "./upgradeability.ts";
import { manifestBase, scopeTable } from "../stage-table.ts";
import { layoutExtensionProblems, type LayoutRename } from "../upgrade-rows.ts";
import { USDC_ADDRESS, checkUsdcCode } from "../usdc.ts";
import { FUND_PROXY_NAMES } from "./upgradeability.ts";
import { TWIN_CHAIN_ID } from "../chains.ts";
import { keccak256, toHex } from "viem";
import type { Address, ChainReader, ExpectedFundAsset, Hex, VerifyOptions, VerifyReport } from "./types.ts";

const HAS_ROLE = "function hasRole(bytes32 role, address account) view returns (bool)";
const hasRole = async (ch: ChainReader, at: Address, r: Hex, who: Address): Promise<boolean> => (await ch.read(at, HAS_ROLE, [r, who])) as boolean;
const role = (name: string): Hex => keccak256(toHex(name));
export const FUND_ROLES = {
  EMERGENCY: role("EMERGENCY_ROLE"), KEEPER: role("KEEPER_ROLE"), GOVERNANCE: role("GOVERNANCE_ROLE"), REBALANCER: role("REBALANCER_ROLE"), FLOW: role("FLOW_ROLE"),
  TARGET_SETTER: role("TARGET_SETTER_ROLE"), RELEASER: role("RECEIPT_RELEASER_ROLE"), SUBMITTER: role("RECEIPT_SUBMITTER_ROLE"),
  PROPOSER: role("PROPOSER_ROLE"), CANCELLER: role("CANCELLER_ROLE"), EXECUTOR: role("EXECUTOR_ROLE"),
} as const;

const slotAddr = (v: Hex): Address => (`0x${v.replace(/^0x/, "").padStart(64, "0").slice(24)}`).toLowerCase() as Address;
const isRpcFailure = (e: unknown): boolean => /RPC_REFUSED|rate.?limit|\b429\b|timeout/i.test(String((e as Error)?.message ?? e));
const normAddrs = (xs: readonly Address[]): Address[] => [...new Set(xs.map((a) => lc(a) as Address))].sort();

const SIG_ROLE_REVOKED = "RoleRevoked(bytes32,address,address)";
/** Issue 2044: the label suffix of a Twin (918453) role check, which proves holders now and grants after the fork pin, never history before the pin. */
export const TWIN_ROLE_SUFFIX = " (Twin: holders now, grants after the fork pin)";

/** The verifier's scan context: the head, read once, and the Twin's fork pin, read once (null: not an anvil fork). */
export interface RoleScanCtx { head?: bigint; pin?: bigint | null }

/**
 * Prove exclusive role membership (`DEP-03`). Uses AccessControlEnumerable when supported
 * (`FlowQueue`, `Rebalancer`, `RebalanceGovernance`, `ConsensusRecommendationReceipt`); on contracts that
 * use plain `AccessControl` or `AdminFloorAccessControlCounter` (`TimelockController`, `RobotMoneyFund`),
 * falls back only on VM revert to `RoleGranted` log scan + `hasRole` (and `adminCount()` on Fund ADMIN_ROLE).
 *
 * Issue 2044, owner decision 2026-11-20: on the Twin (chain 918453, an anvil fork of Base) no check reads logs before the fork pin. Anvil forwards those reads to the
 * public Base RPC, which refuses eth_getLogs, and the history before the pin is real Base, proven by the live 8453 run. The Twin's log fallback proves instead that every
 * expected holder holds the role now (hasRole at head) and that no RoleGranted after the pin went to anyone else and no RoleRevoked after the pin removed an expected holder.
 * The label says so. The vaults system's creation proof (verify/index.ts) needs logs from the deploy block on, so it has no part in this path.
 */
export async function verifyExclusiveRole(
  c: Collector,
  chain: ChainReader,
  label: string,
  at: Address,
  r: Hex,
  expected: readonly Address[],
  opts: Pick<VerifyOptions, "fromBlock" | "logChunk" | "retryBaseMs" | "logTries" | "sheet">,
  scanCtx: RoleScanCtx = {},
  isFundAdmin = false,
): Promise<void> {
  const twin = opts.sheet.chainId === TWIN_CHAIN_ID;
  await c.run(twin ? label + TWIN_ROLE_SUFFIX : label, async () => {
    const want = normAddrs(expected);
    let members: Address[];
    let extraErr: string | undefined;
    try {
      const count = Number((await chain.read(at, "function getRoleMemberCount(bytes32 role) view returns (uint256)", [r])) as bigint);
      members = [];
      for (let i = 0; i < count; i++) {
        members.push((await chain.read(at, "function getRoleMember(bytes32 role, uint256 index) view returns (address)", [r, BigInt(i)])) as Address);
      }
    } catch (e) {
      if (isRpcFailure(e)) throw e;
      const head = scanCtx.head ?? (scanCtx.head = await chain.blockNumber());
      const scan = { chunk: opts.logChunk ?? 1999, retryBaseMs: opts.retryBaseMs ?? 500, ...(opts.logTries !== undefined ? { maxRetries: Math.max(0, opts.logTries - 1) } : {}) };
      if (twin) return await twinExclusive(chain, at, r, want, head, scan, scanCtx, isFundAdmin);
      const logs = await scanLogs(chain, { address: at, topics: [keccak256(toHex(SIG_ROLE_GRANTED)), r], fromBlock: opts.fromBlock, toBlock: head, ...scan });
      members = [];
      for (const who of new Set(logs.map((l) => lc(topicToAddress(l.topics[2])) as Address))) {
        if (await hasRole(chain, at, r, who)) members.push(who);
      }
      if (isFundAdmin) {
        const adminCount = Number((await chain.read(at, "function adminCount() view returns (uint256)")) as bigint);
        if (adminCount !== members.length) extraErr = `log scan found ${members.length} admin(s), adminCount() is ${adminCount}`;
      }
    }
    const got = normAddrs(members);
    const ok = !extraErr && got.length === want.length && got.every((a, i) => a === want[i]);
    return { ok, detail: extraErr ?? `got [${got.join(",")}], expected [${want.join(",")}]` };
  });
}

/** Issue 2044: the Twin's exclusivity proof of a non-enumerable role: holders now, and RoleGranted/RoleRevoked over (pin, head] only. No log below the pin is asked for. */
async function twinExclusive(
  chain: ChainReader, at: Address, r: Hex, want: Address[], head: bigint,
  scan: { chunk: number; retryBaseMs: number; maxRetries?: number }, scanCtx: RoleScanCtx, isFundAdmin: boolean,
): Promise<{ ok: boolean; detail: string }> {
  if (scanCtx.pin === undefined) scanCtx.pin = (await chain.forkPin?.()) ?? null;
  const pin = scanCtx.pin;
  if (pin === null) return { ok: false, detail: "chain 918453 is not an anvil fork (anvil_nodeInfo names no fork block): the Twin role check reads no history before a pin it cannot name" };
  const problems: string[] = [];
  for (const who of want) if (!(await hasRole(chain, at, r, who))) problems.push(`expected holder ${who} does not hold the role now`);
  if (pin < head) {
    const granted = keccak256(toHex(SIG_ROLE_GRANTED)), revoked = keccak256(toHex(SIG_ROLE_REVOKED));
    const logs = await scanLogs(chain, { address: at, topics: [[granted, revoked], r], fromBlock: pin + 1n, toBlock: head, ...scan });
    for (const l of logs) {
      const who = lc(topicToAddress(l.topics[2]!)) as Address;
      const t0 = l.topics[0]!.toLowerCase();
      if (t0 === granted.toLowerCase() && !want.includes(who)) problems.push(`block ${l.blockNumber}: RoleGranted to unexpected ${who}`);
      if (t0 === revoked.toLowerCase() && want.includes(who)) problems.push(`block ${l.blockNumber}: RoleRevoked from expected holder ${who}`);
    }
  }
  if (isFundAdmin) {
    const adminCount = Number((await chain.read(at, "function adminCount() view returns (uint256)")) as bigint);
    if (adminCount !== want.length) problems.push(`adminCount() is ${adminCount}, expected ${want.length}`);
  }
  return problems.length
    ? { ok: false, detail: problems.slice(0, 5).join("; ") }
    : { ok: true, detail: `holders [${want.join(",")}] hold the role now; no grant to another account and no revoke of a holder in blocks ${pin + 1n}-${head} (history before the fork pin ${pin} is Base, not claimed here)` };
}

async function readFirstAddressArray(chain: ChainReader, at: Address, signatures: readonly string[]): Promise<Address[]> {
  let lastErr: unknown;
  for (const sig of signatures) {
    try {
      return (await chain.read(at, sig)) as Address[];
    } catch (e) {
      if (isRpcFailure(e)) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const ASSET_CONFIGS_SIG =
  "function assetConfigs() view returns ((uint8 kind, bool active, uint16 capBps, address adapter, address token, address pool, uint24 poolFee, uint32 twapWindow, uint8 venue, address feed, uint32 maxFeedAge)[])";

function checkFundAssets(configs: Record<string, any>[], expected?: readonly ExpectedFundAsset[]): { ok: boolean; detail: string } {
  if (expected && configs.length !== expected.length) {
    return { ok: false, detail: `assetConfigs length ${configs.length} != expected ${expected.length}` };
  }
  const problems: string[] = [];
  for (let i = 0; i < configs.length; i++) {
    const a = configs[i]!;
    const kind = Number(a.kind);
    const active = Boolean(a.active);
    const capBps = BigInt(a.capBps);
    const adapter = String(a.adapter ?? ZERO) as Address;
    const token = String(a.token ?? ZERO) as Address;
    const pool = String(a.pool ?? ZERO) as Address;
    const poolFee = BigInt(a.poolFee);
    const twapWindow = BigInt(a.twapWindow);
    const venue = Number(a.venue);
    const feed = String(a.feed ?? ZERO) as Address;
    const maxFeedAge = BigInt(a.maxFeedAge);
    if (kind !== 0 && kind !== 1) problems.push(`asset[${i}]: invalid kind ${kind}`);
    if (!isAddress(adapter) || lc(adapter) === ZERO) problems.push(`asset[${i}]: zero adapter`);
    if (kind === 0 && active && (capBps === 0n || capBps > 10000n)) problems.push(`asset[${i}]: invalid lending capBps ${capBps}`);
    if (kind === 1) {
      if (!isAddress(token) || lc(token) === ZERO) problems.push(`asset[${i}]: zero basket token`);
      if (!isAddress(pool) || lc(pool) === ZERO) problems.push(`asset[${i}]: zero basket pool`);
      if (twapWindow < 600n || twapWindow > 86400n) problems.push(`asset[${i}]: invalid twapWindow ${twapWindow}`);
      if (active && (!isAddress(feed) || lc(feed) === ZERO)) problems.push(`asset[${i}]: active basket missing feed`);
      if (active && maxFeedAge === 0n) problems.push(`asset[${i}]: active basket zero maxFeedAge`);
    }
    if (expected) {
      const e = expected[i]!;
      const cmp: [string, unknown, unknown][] = [
        ["kind", kind, e.kind],
        ["active", active, e.active],
        ["capBps", capBps, e.capBps],
        ["adapter", lc(adapter), lc(e.adapter)],
        ["token", lc(token), lc(e.token)],
        ["pool", lc(pool), lc(e.pool)],
        ["poolFee", poolFee, e.poolFee],
        ["twapWindow", twapWindow, e.twapWindow],
        ["venue", venue, e.venue],
        ["feed", lc(feed), lc(e.feed)],
        ["maxFeedAge", maxFeedAge, e.maxFeedAge],
      ];
      for (const [k, got, want] of cmp) {
        if (got !== want) problems.push(`asset[${i}].${k}: got ${String(got)}, want ${String(want)}`);
      }
    }
  }
  return { ok: problems.length === 0, detail: problems.length ? problems.join("; ") : `${configs.length} asset(s) verified` };
}

/** The queue's FlowParams fields in struct order, each with the fund sheet name that sets it (DeployFlowQueue.s.sol). */
export const FLOW_PARAM_FIELDS: readonly [string, string][] = [
  ["epochLength", "FLOW_EPOCH_LENGTH"], ["settleWindow", "FLOW_SETTLE_WINDOW"], ["minHold", "FLOW_MIN_HOLD"], ["keeperGrace", "FLOW_KEEPER_GRACE"],
  ["maxEpochFlowBps", "FLOW_MAX_EPOCH_FLOW_BPS"], ["epochFlowFloorUsdc", "FLOW_EPOCH_FLOOR_USDC"], ["maxSharePriceMoveBps", "FLOW_MAX_SHARE_PRICE_MOVE_BPS"], ["maxRoll", "FLOW_MAX_ROLL"],
  ["minRequestUsdc", "FLOW_MIN_REQUEST_USDC"], ["maxFreeze", "FLOW_MAX_FREEZE"], ["slices", "FLOW_SLICES"], ["quorum", "FLOW_QUORUM"], ["dispersionBps", "FLOW_DISPERSION_BPS"],
  ["refBandBps", "FLOW_REF_BAND_BPS"], ["legBandBps", "FLOW_LEG_BAND_BPS"], ["sequencerGrace", "FLOW_SEQUENCER_GRACE"], ["usdcPegBandBps", "FLOW_USDC_PEG_BAND_BPS"],
  ["maxLendRateGrowthBps", "FLOW_MAX_LEND_RATE_GROWTH_BPS"],
];
const FLOW_PARAMS_SIG = `function flowParams() view returns ((uint32 epochLength, uint32 settleWindow, uint32 minHold, uint32 keeperGrace, uint16 maxEpochFlowBps, uint128 epochFlowFloorUsdc, uint16 maxSharePriceMoveBps, uint16 maxRoll, uint128 minRequestUsdc, uint32 maxFreeze, uint8 slices, uint8 quorum, uint16 dispersionBps, uint16 refBandBps, uint16 legBandBps, uint32 sequencerGrace, uint16 usdcPegBandBps, uint16 maxLendRateGrowthBps, uint32 cancelBuffer, uint32 maxPause, uint16 matchBandBps))`;
const LEGACY_FLOW_PARAMS_SIG = `function flowParams() view returns ((uint32 epochLength, uint32 settleWindow, uint32 minHold, uint32 keeperGrace, uint16 maxEpochFlowBps, uint128 epochFlowFloorUsdc, uint16 maxSharePriceMoveBps, uint16 maxRoll, uint128 minRequestUsdc, uint32 maxFreeze, uint8 slices, uint8 quorum, uint16 dispersionBps, uint16 refBandBps, uint16 legBandBps, uint32 sequencerGrace, uint16 usdcPegBandBps, uint16 maxLendRateGrowthBps))`;
/** The fund's asset count: three lending venues and two basket tokens (proposal 4.5, DeployFund.s.sol N_ASSETS). */
export const FUND_ASSET_COUNT = 5;

/**
 * The build (forge out/) a fund-system proxy's implementation is compared with: the deploy's build, or, for a proxy a governed upgrade moved to another build, that build
 * (opts.proxyBuildDirs, read from the run manifest's `proxy_upgrades` by verify-stage.ts proxyBuildDirsOf, keyed by the proxy's verifier name, FUND_PROXY_NAMES). The code is
 * still compared exactly (links, immutables and the metadata trailer masked): only the build it is compared with follows the recorded upgrade (Deploy 4 in-place upgrade).
 */
export function fundProxyBuildDir(stage: string, opts: Pick<VerifyOptions, "artifactsDir" | "proxyBuildDirs">): string {
  const name = FUND_PROXY_NAMES[stage];
  return (name !== undefined ? opts.proxyBuildDirs?.[name] : undefined) ?? opts.artifactsDir;
}

export async function verifyFundSystem(opts: VerifyOptions): Promise<VerifyReport> {
  const c = new Collector();
  const { chain, sheet } = opts;
  const table = scopeTable(opts.table, "fund");
  const f = sheet.fund;
  await c.runEq("chain: id equals sheet", () => chain.chainId(), sheet.chainId);
  if (!f) { c.fail("sheet: the fund sheet's values are present", "the verify sheet carries no fund values (--system fund)"); return c.report(); }

  // ---- manifests: the fund system's own and its Safe
  const files: Record<string, any> = {};
  const own = [...new Set(table.stages.map((s) => manifestBase(s.manifest)))];
  for (const name of [...own, "safe"]) {
    const p = join(opts.manifestDir, `${name}.json`);
    let ok = existsSync(p);
    if (ok) { try { files[name] = JSON.parse(readFileSync(p, "utf8")); } catch { ok = false; } }
    c.push(`manifest: ${name}.json present`, ok, ok ? "ok" : `${p} is missing or unparseable`);
  }
  if (Object.keys(files).length !== own.length + 1) return c.report();
  for (const name of own) c.eq(`manifest: ${name}.json chain_id equals sheet`, files[name].chain_id, sheet.chainId);
  const tm = files["fund-timelock"];
  const A = (x: unknown) => String(x ?? "") as Address;
  const addr = { fund: A(files.fund.fund), rebalancer: A(files.rebalancer.rebalancer), governance: A(files["fund-governance"].governance), queue: A(files.queue.queue), receipt: A(files["fund-receipt"].consensus_receipt), timelock: A(tm.timelock), safe: A(files.safe.safe) };
  for (const [k, v] of Object.entries(addr)) c.push(`manifest: ${k} address is valid`, isAddress(v), v);
  if (!Object.values(addr).every(isAddress)) return c.report();
  for (const k of ["fund", "rebalancer", "governance", "queue"] as const) c.eq(`fund-timelock: manifest names the ${k} the ${k} stage deployed`, lc(tm[k]), lc(addr[k]));
  c.eq("fund-timelock: manifest names the receipt register the fund-receipt stage deployed", lc(tm.consensus_receipt), lc(addr.receipt));
  c.eq("fund-timelock: manifest names the Safe the safe stage created", lc(tm.safe), lc(addr.safe));
  const D = sheet.deployer;

  await c.run("usdc: code hash equals pinned FiatTokenProxy", async () => checkUsdcCode(await chain.getCode(USDC_ADDRESS), opts.usdcCodeHash));

  // ---- every proxy: the build's code, recursive linked libraries, UUPS slots, the fund-system timelock as its only upgrade authority, release mode
  const proxyArtifact = tryLoadArtifact(opts.artifactsDir, ERC1967_PROXY_ARTIFACT);
  for (const s of table.stages) for (const p of s.proxies ?? []) {
    const m = files[manifestBase(s.manifest)];
    const at = A(m[p.field]);
    const built = fundProxyBuildDir(s.name, opts);
    const label = `${s.name} ${p.contract}${built === opts.artifactsDir ? "" : ` (upgraded: the build of ${built})`}`;
    await c.run(`${label}: runtime code equals build artifact (masked)`, async () => {
      const r = await compareDeployedCode(chain, at, loadArtifact(built, p.contract), proxyArtifact);
      return { ok: r.ok, detail: r.detail };
    });
    await c.run(`${label}: linked libraries equal build`, async () => {
      const implCode = await logicCode(chain, at, proxyArtifact);
      // An upgraded proxy's libraries are the upgrade build's (v0.9.0 deploys changed libraries with the implementation):
      // compare its links, and every library they reach, with the same build its own code is compared with.
      const r = await verifyLinkedLibraries(chain, implCode, p.contract, built, built);
      return { ok: r.ok, detail: r.detail };
    });
    await c.runEq(`${label}: ERC-1967 admin slot is zero`, async () => slotAddr(await chain.getStorageAt(at, ERC1967_ADMIN_SLOT)), ZERO);
    await c.runEq(`${label}: ERC-1967 beacon slot is zero`, async () => slotAddr(await chain.getStorageAt(at, ERC1967_BEACON_SLOT)), ZERO);
    await c.runEq(`${label}: upgradeTimelock() is the fund-system timelock`, async () => lc((await chain.read(at, "function upgradeTimelock() view returns (address)")) as string), lc(addr.timelock));
    c.eq(`${label}: manifest upgrade_timelock is the fund-system timelock`, lc(m.upgrade_timelock), lc(addr.timelock));
    c.eq(`${label}: manifest upgrade_mode equals the sheet`, m.upgrade_mode, sheet.upgradeMode ?? "");
    await c.runEq(`${label}: upgradesFrozen() agrees with the sheet's release mode`, () => chain.read(at, "function upgradesFrozen() view returns (bool)"), sheet.upgradeMode === "frozen");
  }

  // ---- the timelock, the Safe, and keeper smart account checks (DEP-03, E56)
  const scanCtx: RoleScanCtx = {};
  await c.run("timelock: has code", async () => (await chain.getCode(addr.timelock)).length > 2);
  await c.runEq("timelock: getMinDelay() equals the sheet", async () => Number(await chain.read(addr.timelock, "function getMinDelay() view returns (uint256)")), sheet.timelockDelay);
  await verifyExclusiveRole(c, chain, "timelock: PROPOSER_ROLE held exclusively by the Safe", addr.timelock, FUND_ROLES.PROPOSER, [addr.safe], opts, scanCtx);
  await verifyExclusiveRole(c, chain, "timelock: CANCELLER_ROLE held exclusively by the Safe", addr.timelock, FUND_ROLES.CANCELLER, [addr.safe], opts, scanCtx);
  // Owner decision D4-10 (2026-11-13): the fund timelock's only executor is the Safe; the vaults system keeps ADR-0004's open executor.
  c.eq("fund-timelock: manifest executorPolicy is safe-only", tm.executorPolicy, "safe-only");
  await verifyExclusiveRole(c, chain, "timelock: EXECUTOR_ROLE held exclusively by the Safe", addr.timelock, FUND_ROLES.EXECUTOR, [addr.safe], opts, scanCtx);
  await c.runEq("timelock: EXECUTOR_ROLE not open (not held by address 0)", () => hasRole(chain, addr.timelock, FUND_ROLES.EXECUTOR, ZERO), false);
  await c.runEq("timelock: EXECUTOR_ROLE not held by the deployer", () => hasRole(chain, addr.timelock, FUND_ROLES.EXECUTOR, D), false);
  await c.runEq("timelock: PROPOSER_ROLE not held by the deployer", () => hasRole(chain, addr.timelock, FUND_ROLES.PROPOSER, D), false);
  await c.runEq("timelock: DEFAULT_ADMIN not held by the deployer", () => hasRole(chain, addr.timelock, Z32, D), false);
  await c.runEq("safe: threshold equals the sheet", async () => Number(await chain.read(addr.safe, "function getThreshold() view returns (uint256)")), sheet.safeThreshold);
  await c.runEq("safe: owners equal the sheet", async () => ((await chain.read(addr.safe, "function getOwners() view returns (address[])")) as string[]).map(lc).sort().join(","), sheet.safeOwners.map(lc).sort().join(","));
  await c.run("safe: modules equal sheet (default none)", async () => {
    const r = (await chain.read(addr.safe, "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)", [SAFE_SENTINEL, 10n])) as any;
    const got = normAddrs((r?.array ?? r?.[0] ?? []) as Address[]);
    const want = normAddrs(f.safeModules ?? []);
    const ok = got.length === want.length && got.every((a, i) => a === want[i]);
    return { ok, detail: `modules [${got.join(",")}], expected [${want.join(",")}]` };
  });
  await c.runEq("safe: guard equals sheet (default zero)", async () => slotAddr(await chain.getStorageAt(addr.safe, SAFE_GUARD_SLOT)), lc(f.safeGuard ?? ZERO));
  await c.runEq("safe: fallback handler equals expected (default Safe 1.4.1 canonical)", async () => slotAddr(await chain.getStorageAt(addr.safe, SAFE_FALLBACK_SLOT)), lc(f.safeFallbackHandler ?? SAFE_141_FALLBACK_HANDLER));

  if (f.keeperType === "eoa") {
    await c.run("keeper: EOA has no contract code", async () => (await chain.getCode(f.keeper)).length <= 2);
  } else if (f.keeperType === "smart-account" || f.keeperOwners !== undefined || f.keeperBotKeys !== undefined) {
    await c.run("keeper: smart account has contract code", async () => (await chain.getCode(f.keeper)).length > 2);
    if (f.keeperOwners !== undefined) {
      await c.run("keeper: smart account owners equal sheet", async () => {
        const got = normAddrs(await readFirstAddressArray(chain, f.keeper, ["function owners() view returns (address[])", "function getOwners() view returns (address[])"]));
        const want = normAddrs(f.keeperOwners!);
        const ok = got.length === want.length && got.every((a, i) => a === want[i]);
        return { ok, detail: `owners [${got.join(",")}], expected [${want.join(",")}]` };
      });
    }
    if (f.keeperBotKeys !== undefined) {
      await c.run("keeper: smart account botKeys equal sheet", async () => {
        const got = normAddrs(await readFirstAddressArray(chain, f.keeper, ["function botKeys() view returns (address[])", "function getBotKeys() view returns (address[])"]));
        const want = normAddrs(f.keeperBotKeys!);
        const ok = got.length === want.length && got.every((a, i) => a === want[i]);
        return { ok, detail: `botKeys [${got.join(",")}], expected [${want.join(",")}]` };
      });
    }
  }

  // ---- the handover: the timelock administers every contract exclusively, the deployer holds nothing
  const admins: [string, Address][] = [["fund", addr.fund], ["rebalancer", addr.rebalancer], ["governance", addr.governance], ["queue", addr.queue], ["receipt", addr.receipt]];
  for (const [n, at] of admins) {
    await verifyExclusiveRole(c, chain, `${n}: ADMIN_ROLE held exclusively by the timelock`, at, ADMIN_ROLE, [addr.timelock], opts, scanCtx, n === "fund");
    await c.runEq(`${n}: ADMIN_ROLE not held by the deployer`, () => hasRole(chain, at, ADMIN_ROLE, D), false);
    await c.runEq(`${n}: DEFAULT_ADMIN not held by the deployer`, () => hasRole(chain, at, Z32, D), false);
  }
  await verifyExclusiveRole(c, chain, "receipt: DEFAULT_ADMIN held exclusively by the timelock", addr.receipt, Z32, [addr.timelock], opts, scanCtx);
  await verifyExclusiveRole(c, chain, "receipt: RECEIPT_RELEASER_ROLE held exclusively by governance", addr.receipt, FUND_ROLES.RELEASER, [addr.governance], opts, scanCtx);
  if (f.receiptSubmitters !== undefined) {
    await verifyExclusiveRole(c, chain, "receipt: RECEIPT_SUBMITTER_ROLE held exclusively by sheet submitters", addr.receipt, FUND_ROLES.SUBMITTER, f.receiptSubmitters, opts, scanCtx);
  } else {
    await c.runEq("receipt: RECEIPT_SUBMITTER_ROLE not held by the deployer", () => hasRole(chain, addr.receipt, FUND_ROLES.SUBMITTER, D), false);
    await c.runEq("receipt: RECEIPT_SUBMITTER_ROLE not held by the timelock", () => hasRole(chain, addr.receipt, FUND_ROLES.SUBMITTER, addr.timelock), false);
  }
  await c.runEq("receipt: ADMIN_ROLE not held by governance", () => hasRole(chain, addr.receipt, ADMIN_ROLE, addr.governance), false);
  await verifyExclusiveRole(c, chain, "governance: TARGET_SETTER_ROLE held exclusively by the timelock", addr.governance, FUND_ROLES.TARGET_SETTER, [addr.timelock], opts, scanCtx);
  await c.runEq("governance: TARGET_SETTER_ROLE not held by the deployer", () => hasRole(chain, addr.governance, FUND_ROLES.TARGET_SETTER, D), false);
  for (const [n, at] of [["fund", addr.fund], ["queue", addr.queue]] as [string, Address][]) {
    await verifyExclusiveRole(c, chain, `${n}: EMERGENCY_ROLE held exclusively by the emergency key`, at, FUND_ROLES.EMERGENCY, [sheet.emergency], opts, scanCtx);
    await c.runEq(`${n}: EMERGENCY_ROLE not held by the deployer`, () => hasRole(chain, at, FUND_ROLES.EMERGENCY, D), false);
  }
  for (const [n, at] of [["queue", addr.queue], ["rebalancer", addr.rebalancer]] as [string, Address][]) {
    await verifyExclusiveRole(c, chain, `${n}: KEEPER_ROLE held exclusively by the keeper`, at, FUND_ROLES.KEEPER, [f.keeper], opts, scanCtx);
    await c.runEq(`${n}: KEEPER_ROLE not held by the deployer`, () => hasRole(chain, at, FUND_ROLES.KEEPER, D), false);
  }

  // ---- the one-time bindings (exclusive role membership)
  await verifyExclusiveRole(c, chain, "fund: GOVERNANCE_ROLE held exclusively by governance", addr.fund, FUND_ROLES.GOVERNANCE, [addr.governance], opts, scanCtx);
  await verifyExclusiveRole(c, chain, "fund: REBALANCER_ROLE held exclusively by the rebalancer", addr.fund, FUND_ROLES.REBALANCER, [addr.rebalancer], opts, scanCtx);
  await verifyExclusiveRole(c, chain, "fund: FLOW_ROLE held exclusively by the queue", addr.fund, FUND_ROLES.FLOW, [addr.queue], opts, scanCtx);
  await c.runEq("fund: flowQueue() is the queue", async () => lc((await chain.read(addr.fund, "function flowQueue() view returns (address)")) as string), lc(addr.queue));
  for (const r of ["GOVERNANCE", "REBALANCER", "FLOW"] as const) await c.runEq(`fund: ${r}_ROLE not held by the deployer`, () => hasRole(chain, addr.fund, FUND_ROLES[r], D), false);
  await c.runEq("rebalancer: fund() is the fund", async () => lc((await chain.read(addr.rebalancer, "function fund() view returns (address)")) as string), lc(addr.fund));
  await c.runEq("governance: fund() is the fund", async () => lc((await chain.read(addr.governance, "function fund() view returns (address)")) as string), lc(addr.fund));
  await c.runEq("governance: receipts() is the fund system's register", async () => lc((await chain.read(addr.governance, "function receipts() view returns (address)")) as string), lc(addr.receipt));

  // ---- the fund's configuration, assets, fee recipient, and Step 3f parameters against the sheet (DEP-01)
  const expectedAssetCount = f.assets?.length ?? FUND_ASSET_COUNT;
  await c.runEq("fund: assetCount() matches expected count", async () => Number(await chain.read(addr.fund, "function assetCount() view returns (uint256)")), expectedAssetCount);
  await c.run("fund: config() equals the sheet (TVL cap, per-deposit cap, exit fee, feeRecipient)", async () => {
    const [tvl, per, fee, feeRecipient] = (await chain.read(addr.fund, "function config() view returns (uint256, uint256, uint256, address)")) as [bigint, bigint, bigint, Address];
    const expectedRecipient = f.feeRecipient === "@safe" ? addr.safe : f.feeRecipient;
    const recOk = isAddress(feeRecipient) && lc(feeRecipient) !== ZERO && lc(feeRecipient) !== lc(D) && (!expectedRecipient || lc(feeRecipient) === lc(expectedRecipient));
    const ok = tvl === f.tvlCap && per === f.perDepositCap && fee === f.exitFeeBps && recOk;
    return {
      ok,
      detail: `chain ${tvl}/${per}/${fee}/${feeRecipient}, sheet ${f.tvlCap}/${f.perDepositCap}/${f.exitFeeBps}/${expectedRecipient ?? "non-zero!=deployer"}`,
    };
  });
  await c.run("fund: assetConfigs() matches expected assets and invariants", async () => {
    const configs = (await chain.read(addr.fund, ASSET_CONFIGS_SIG)) as Record<string, any>[];
    if (configs.length !== expectedAssetCount) return { ok: false, detail: `assetConfigs length ${configs.length} != expected ${expectedAssetCount}` };
    return checkFundAssets(configs, f.assets);
  });
  await c.runEq("fund: minSeedUsdc() equals the sheet", async () => BigInt(await chain.read(addr.fund, "function minSeedUsdc() view returns (uint256)") as bigint).toString(), f.minSeedUsdc.toString());
  await c.runEq("fund: maxSlippageBps() equals the sheet", async () => BigInt(await chain.read(addr.fund, "function maxSlippageBps() view returns (uint256)") as bigint).toString(), f.maxSlippageBps.toString());
  await c.runEq("fund: navDeviationGuardBps() equals the sheet", async () => BigInt(await chain.read(addr.fund, "function navDeviationGuardBps() view returns (uint256)") as bigint).toString(), f.navDeviationBps.toString());
  await c.run("fund: seeded, the seed shares held by the fund itself and none by the deployer", async () => {
    const own = (await chain.read(addr.fund, "function balanceOf(address) view returns (uint256)", [addr.fund])) as bigint;
    const dep = (await chain.read(addr.fund, "function balanceOf(address) view returns (uint256)", [D])) as bigint;
    const seedShares = BigInt(String(files.fund.seed_shares ?? "0"));
    return { ok: own >= seedShares && seedShares > 0n && dep === 0n, detail: `fund holds ${own}, seed ${seedShares}, deployer ${dep}` };
  });
  await c.run("queue: flowParams() equals the sheet", async () => {
    let got: Record<string, bigint | number>;
    try {
      got = (await chain.read(addr.queue, FLOW_PARAMS_SIG)) as Record<string, bigint | number>;
    } catch (e) {
      if (isRpcFailure(e)) throw e;
      got = (await chain.read(addr.queue, LEGACY_FLOW_PARAMS_SIG)) as Record<string, bigint | number>;
    }
    const checked = FLOW_PARAM_FIELDS.filter(([field, name]) => field !== "keeperGrace" || name in f.params);
    const diff = checked.filter(([field, name]) => BigInt(got[field] ?? -1) !== f.params[name]).map(([field, name]) => `${field} ${String(got[field])} != ${name} ${String(f.params[name])}`);
    return { ok: diff.length === 0, detail: diff.length ? diff.join("; ") : `${checked.length} fields equal` };
  });

  // ---- Step 3f queue and fund parameters when configured on the sheet (E47 / DEP-01)
  for (const [field, sheetName] of [["cancelBuffer", "FLOW_CANCEL_BUFFER"], ["maxPause", "FLOW_MAX_PAUSE"]] as const) {
    if (!(sheetName in f.params)) continue;
    await c.runEq(`queue: ${field}() equals the sheet`, async () => {
      try {
        return BigInt((await chain.read(addr.queue, `function ${field}() view returns (uint256)`)) as bigint | number).toString();
      } catch (e) {
        if (isRpcFailure(e)) throw e;
        const fp = (await chain.read(addr.queue, FLOW_PARAMS_SIG)) as Record<string, bigint | number>;
        return BigInt(fp[field]!).toString();
      }
    }, String(f.params[sheetName]));
  }
  const FUND_STEP3F_PARAMS = [
    ["minPoolDepthUsdc", "FUND_MIN_POOL_DEPTH_USDC"],
    ["feeMarginBps", "FUND_FEE_MARGIN_BPS"],
    ["delistBandBps", "FUND_DELIST_BAND_BPS"],
    ["delistBudgetBps", "FUND_DELIST_BUDGET_BPS"],
    ["maxBasketBps", "FUND_MAX_BASKET_BPS"],
  ] as const;
  for (const [getter, sheetName] of FUND_STEP3F_PARAMS) {
    if (!(sheetName in f.params)) continue;
    await c.runEq(
      `fund: ${getter}() equals the sheet`,
      async () => String(BigInt((await chain.read(addr.fund, `function ${getter}() view returns (uint256)`)) as bigint | number)),
      String(f.params[sheetName]),
    );
  }

  // ---- the two levers the initializers set (Rebalancer.initialize: stepDepthBps; FlowQueue.initialize: FlowLevers.basketCallBps), against the sheet
  await c.runEq("rebalancer: stepDepthBps() equals the sheet", async () => String(await chain.read(addr.rebalancer, "function stepDepthBps() view returns (uint16)")), String(f.params.REBALANCER_STEP_DEPTH_BPS));
  await c.runEq("queue: flowLevers().basketCallBps equals the sheet", async () => String(((await chain.read(addr.queue, "function flowLevers() view returns ((uint16 basketCallBps, uint8 legPriceMode))")) as { basketCallBps: number }).basketCallBps), String(f.params.FLOW_BASKET_CALL_BPS));

  // ---- the deployer nonce at the end of the deploy: the start, the frozen counts and the one prove-control transaction
  await c.run("deployer: nonce at the handover equals start plus the fund frozen counts plus the control proof", async () => {
    const start = opts.deployerStartNonce ?? 0;
    const sum = ["safe", ...table.stages.map((s) => s.name)].reduce((a, n) => a + (opts.frozenCounts[n] ?? 0), 0);
    const want = start + sum + 1;
    const frozen = table.stages.every((s) => s.name in opts.frozenCounts);
    const got = opts.deployerNonceAtDeployEnd ?? await chain.nonce(D);
    return { ok: frozen && got === want, detail: `nonce ${got}${opts.deployerNonceAtDeployEnd !== undefined ? " (recorded at the handover)" : ""}, start ${start} plus frozen sum ${sum} plus 1` };
  });
  return c.report();
}

export interface FundActiveState {
  requestCount: bigint;
  claimCount: bigint;
  settlementCount: bigint;
  books: [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  lastBasketStepAt: bigint;
  isShutdown: boolean;
  depositsPaused: boolean;
  queuePaused: boolean;
  /** `queue.liveness().windDownActive`: the queue's own view of WindDown (agrees with `isShutdown`). */
  windDownActive?: boolean;
  /** Pause end times (`depositsPausedUntil`, `rebalancePausedUntil`, `queuePausedUntil`). Undefined when the build lacks the getter (a build before Step 3f). */
  depositsPausedUntil?: bigint;
  rebalancePausedUntil?: bigint;
  queuePausedUntil?: bigint;
  /** `queue.currentMatchIndexes()`: the deposit and redeem match indexes. Undefined on a build without it. */
  matchIndexes?: { dep: [bigint, bigint]; red: [bigint, bigint] };
  /** Every settlement's freeze: `frozenUntil` and `freezeSetAt`, by settlement id (ids start at 1). */
  freezes?: { id: bigint; frozenUntil: bigint; freezeSetAt: bigint }[];
  /** Every request's and claim's full contents, canonical JSON, index `i` is id `i + 1` (ids start at 1). */
  requests?: string[];
  claims?: string[];
}

export interface FundLayoutPair {
  name: string;
  deployed: unknown;
  candidate: unknown;
  renames?: readonly LayoutRename[];
  contract?: string;
}

export interface FundUpgradeSafetyOptions {
  chain: ChainReader;
  timelock: Address;
  addresses: {
    fund: Address;
    queue: Address;
    rebalancer: Address;
    governance: Address;
    receipt: Address;
  };
  preState: FundActiveState;
  postState?: FundActiveState;
  layouts?: readonly FundLayoutPair[];
  artifactsDir?: string;
  proxyArtifacts?: Partial<Record<"fund" | "queue" | "rebalancer" | "governance" | "receipt", string>>;
  proxyBuildDirs?: Record<string, string>;
}

const BOOK_KEYS = ["pendingUsdc", "owedUsdc", "creditUsdc", "dustUsdc", "escrowShares", "heldShares", "creditShares", "dustShares"] as const;
const normalizeBooks = (raw: unknown): FundActiveState["books"] => {
  if (Array.isArray(raw)) {
    return BOOK_KEYS.map((_, i) => BigInt(raw[i] as bigint | number)) as FundActiveState["books"];
  }
  const obj = raw as Record<string, bigint | number>;
  return BOOK_KEYS.map((k) => BigInt(obj[k]!)) as FundActiveState["books"];
};

/** Canonical JSON of a decoded struct: bigints as decimal strings, object keys sorted, so two reads of equal contents are equal strings. */
export function canonicalJson(v: unknown): string {
  if (typeof v === "bigint") return JSON.stringify(v.toString());
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => !/^\d+$/.test(k)).sort();
    return keys.length === 0 ? "[]" : `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** One read that a build may not have: a revert is `undefined` (a build before Step 3f), an RPC failure still throws. */
async function tryRead(chain: ChainReader, at: Address, sig: string, args: unknown[] = []): Promise<unknown | undefined> {
  try {
    return await chain.read(at, sig, args);
  } catch (e) {
    if (isRpcFailure(e)) throw e;
    return undefined;
  }
}

const REQUEST_SIG = "function getRequest(uint256 requestId) view returns ((address owner, uint8 kind, uint64 epoch, uint256 amount, uint256 remaining, bool closed, uint16 exitFeeBps, uint32 minHold, uint16 maxRoll, uint64 createdAt, uint64 expiryEpoch, uint64 expiresAt, uint64 noticeRound, uint64 era, bool enrolled, uint256 matchCycle, uint256 normBasis, uint256 entryCumScaled, uint256 entryUnmatchedFactor, uint256 nextMatchId))";
const CLAIM_SIG = "function getClaim(uint256 claimId) view returns ((uint256 requestId, address owner, uint8 kind, uint64 settlementId, uint64 unlockAt, uint256 shares, uint256 usdc, uint256 claimed, uint256 sharesClaimed))";
const SETTLEMENT_SIG = "function getSettlement(uint256 settlementId) view returns ((uint64 time, address settler, uint256 matchedShares, uint256 matchedUsdc, uint256 matchSharePrice, uint256 usdcIn, uint256 sharesMinted, uint256 sharesBurned, uint256 usdcOut, uint64 frozenUntil, uint64 freezeSetAt, uint64 holdEndsAt))";
const bigOf = (x: unknown): bigint | undefined => (x === undefined ? undefined : BigInt(x as bigint | number));

/** Read active on-chain queue and fund state before or after a governed UUPS upgrade (`ARCH-08`). */
export async function readFundActiveState(
  chain: ChainReader,
  addresses: { fund: Address; queue: Address; rebalancer?: Address },
): Promise<FundActiveState> {
  const [requestCount, claimCount, settlementCount, rawBooks, isShutdown, depositsPaused, queuePaused] = await Promise.all([
    chain.read(addresses.queue, "function requestCount() view returns (uint256)"),
    chain.read(addresses.queue, "function claimCount() view returns (uint256)"),
    chain.read(addresses.queue, "function settlementCount() view returns (uint256)"),
    chain.read(addresses.queue, "function books() view returns ((uint256 pendingUsdc, uint256 owedUsdc, uint256 creditUsdc, uint256 dustUsdc, uint256 escrowShares, uint256 heldShares, uint256 creditShares, uint256 dustShares))"),
    chain.read(addresses.fund, "function isShutdown() view returns (bool)"),
    chain.read(addresses.fund, "function depositsPaused() view returns (bool)"),
    chain.read(addresses.queue, "function queuePaused() view returns (bool)"),
  ]);
  let lastBasketStepAtRaw: unknown;
  try {
    lastBasketStepAtRaw = await chain.read(addresses.fund, "function lastBasketStepAt() view returns (uint256)");
  } catch (e) {
    if (isRpcFailure(e) || !addresses.rebalancer) throw e;
    lastBasketStepAtRaw = await chain.read(addresses.rebalancer, "function lastBasketStepAt() view returns (uint256)");
  }
  const [dUntil, rUntil, qUntil, liveness, idx] = await Promise.all([
    tryRead(chain, addresses.fund, "function depositsPausedUntil() view returns (uint64)"),
    tryRead(chain, addresses.fund, "function rebalancePausedUntil() view returns (uint64)"),
    tryRead(chain, addresses.queue, "function queuePausedUntil() view returns (uint64)"),
    tryRead(chain, addresses.queue, "function liveness() view returns ((bool keeperConfigured, bool queuePausedNow, uint64 queuePausedUntil, bool windDownActive))"),
    tryRead(chain, addresses.queue, "function currentMatchIndexes() view returns (uint256[2] depIdx, uint256[2] redIdx)"),
  ]);
  const nReq = Number(requestCount as bigint | number), nClaim = Number(claimCount as bigint | number), nSet = Number(settlementCount as bigint | number);
  const ids = (n: number) => Array.from({ length: n }, (_, i) => BigInt(i + 1));
  const requests = (await Promise.all(ids(nReq).map((id) => chain.read(addresses.queue, REQUEST_SIG, [id])))).map(canonicalJson);
  const claims = (await Promise.all(ids(nClaim).map((id) => chain.read(addresses.queue, CLAIM_SIG, [id])))).map(canonicalJson);
  const settlements = await Promise.all(ids(nSet).map(async (id) => [id, (await chain.read(addresses.queue, SETTLEMENT_SIG, [id])) as Record<string, bigint | number>] as const));
  const pair = (x: unknown): [bigint, bigint] => [BigInt((x as (bigint | number)[])[0]!), BigInt((x as (bigint | number)[])[1]!)];
  const idxObj = idx as { depIdx?: unknown; redIdx?: unknown } & unknown[] | undefined;
  return {
    requestCount: BigInt(requestCount as bigint | number),
    claimCount: BigInt(claimCount as bigint | number),
    settlementCount: BigInt(settlementCount as bigint | number),
    books: normalizeBooks(rawBooks),
    lastBasketStepAt: BigInt(lastBasketStepAtRaw as bigint | number),
    isShutdown: Boolean(isShutdown),
    depositsPaused: Boolean(depositsPaused),
    queuePaused: Boolean(queuePaused),
    windDownActive: liveness === undefined ? undefined : Boolean((liveness as { windDownActive: boolean }).windDownActive),
    depositsPausedUntil: bigOf(dUntil),
    rebalancePausedUntil: bigOf(rUntil),
    queuePausedUntil: bigOf(qUntil),
    matchIndexes: idxObj === undefined ? undefined : { dep: pair(idxObj.depIdx ?? idxObj[0]), red: pair(idxObj.redIdx ?? idxObj[1]) },
    freezes: settlements.map(([id, st]) => ({ id, frozenUntil: BigInt(st.frozenUntil!), freezeSetAt: BigInt(st.freezeSetAt!) })),
    requests,
    claims,
  };
}

/**
 * Verify governed UUPS upgrade safety for the fund system (`ARCH-08`):
 * - Timelock is `upgradeTimelock()` of every proxy (`fund`, `queue`, `rebalancer`, `governance`, `receipt`).
 * - Storage-layout compatibility (`layoutExtensionProblems`) holds for each provided layout pair.
 * - Pre/post active state (`requestCount`, `claimCount`, `settlementCount`, `books`, `lastBasketStepAt`,
 *   `isShutdown`, `depositsPaused`, `queuePaused`) is identical across the upgrade.
 */
export async function verifyFundUpgradeSafety(opts: FundUpgradeSafetyOptions): Promise<VerifyReport> {
  const c = new Collector();
  const { chain, timelock, addresses } = opts;
  const proxyEntries = [
    ["fund", addresses.fund],
    ["queue", addresses.queue],
    ["rebalancer", addresses.rebalancer],
    ["governance", addresses.governance],
    ["receipt", addresses.receipt],
  ] as const;

  const proxyArtifact = opts.artifactsDir ? tryLoadArtifact(opts.artifactsDir, ERC1967_PROXY_ARTIFACT) : undefined;
  for (const [name, proxyAddr] of proxyEntries) {
    await c.runEq(
      `fund upgrade: ${name} upgradeTimelock() is the timelock`,
      async () => lc((await chain.read(proxyAddr, "function upgradeTimelock() view returns (address)")) as string),
      lc(timelock),
    );
    const contractName = opts.proxyArtifacts?.[name];
    if (opts.artifactsDir && contractName) {
      await c.run(`fund upgrade: ${name} linked libraries equal build`, async () => {
        const implCode = await logicCode(chain, proxyAddr, proxyArtifact);
        const built = opts.proxyBuildDirs?.[name] ?? opts.artifactsDir!;
        const r = await verifyLinkedLibraries(chain, implCode, contractName, built, built);
        return { ok: r.ok, detail: r.detail };
      });
    }
  }

  for (const layout of opts.layouts ?? []) {
    await c.run(`fund upgrade: ${layout.name} storage layout compatible`, async () => {
      const bad = layoutExtensionProblems(layout.deployed, layout.candidate, layout.renames ?? [], layout.contract ?? layout.name);
      return { ok: bad.length === 0, detail: bad.length ? bad.join("; ") : "storage layout extends prior deployment" };
    });
  }

  const post = opts.postState ?? (await readFundActiveState(chain, addresses));
  const pre = opts.preState;
  c.eq("fund upgrade: requestCount() preserved", post.requestCount.toString(), pre.requestCount.toString());
  c.eq("fund upgrade: claimCount() preserved", post.claimCount.toString(), pre.claimCount.toString());
  c.eq("fund upgrade: settlementCount() preserved", post.settlementCount.toString(), pre.settlementCount.toString());
  await c.run("fund upgrade: books() preserved", async () => {
    const diffs = BOOK_KEYS.map((k, i) => (pre.books[i] === post.books[i] ? null : `${k}: pre ${pre.books[i]} != post ${post.books[i]}`)).filter(Boolean);
    return { ok: diffs.length === 0, detail: diffs.length ? diffs.join("; ") : "all 8 book totals preserved" };
  });
  c.eq("fund upgrade: lastBasketStepAt() preserved", post.lastBasketStepAt.toString(), pre.lastBasketStepAt.toString());
  c.eq("fund upgrade: isShutdown() preserved", post.isShutdown, pre.isShutdown);
  c.eq("fund upgrade: depositsPaused() preserved", post.depositsPaused, pre.depositsPaused);
  c.eq("fund upgrade: queuePaused() preserved", post.queuePaused, pre.queuePaused);
  // Step 3f state (E47, ARCH-08). A field the deployed build cannot read is not compared; one the build could read and the upgrade lost is a failure.
  const keep = (label: string, pre1: unknown, post1: unknown): void => {
    if (pre1 === undefined) return;
    c.eq(`fund upgrade: ${label} preserved`, post1 === undefined ? "unreadable after the upgrade" : canonicalJson(post1), canonicalJson(pre1));
  };
  keep("windDown (queue liveness().windDownActive)", pre.windDownActive, post.windDownActive);
  keep("depositsPausedUntil()", pre.depositsPausedUntil, post.depositsPausedUntil);
  keep("rebalancePausedUntil()", pre.rebalancePausedUntil, post.rebalancePausedUntil);
  keep("queuePausedUntil()", pre.queuePausedUntil, post.queuePausedUntil);
  keep("currentMatchIndexes()", pre.matchIndexes, post.matchIndexes);
  keep("settlement freezes (frozenUntil, freezeSetAt)", pre.freezes, post.freezes);
  for (const [label, a, b] of [["request", pre.requests, post.requests], ["claim", pre.claims, post.claims]] as const) {
    if (a === undefined) continue;
    const bad = a.map((x, i) => (b?.[i] === x ? null : `${label} ${i + 1}`)).filter((x): x is string => x !== null);
    if (b !== undefined && b.length > a.length) bad.push(`${b.length - a.length} extra ${label}(s)`);
    c.push(`fund upgrade: ${label} contents preserved`, bad.length === 0 && b !== undefined, bad.length ? `changed: ${bad.slice(0, 10).join(", ")}` : `${a.length} ${label}(s) identical`);
  }
  return c.report();
}
