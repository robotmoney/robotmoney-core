// Deploy 4 (owner exception 2026-11-12): the fund system's verifier. It reads the chain and the fund system's manifests and checks every postcondition of the fund run on its own:
// each proxy's code against the build (masked: links and immutables), its upgrade authority and release mode, the timelock (delay, Safe as only proposer and canceller,
// executor the Safe alone, decision D4-10), the Safe (owners and threshold), the role handover (the timelock administers every contract, the deployer holds nothing, the emergency key and the keeper
// hold their roles), the one-time bindings (plan roles, FLOW_ROLE, the receipt releaser), the fund's configuration and the queue's flow parameters against the sheet, and the
// deployer nonce at the end of the deploy. It reads nothing of the vaults or gateway systems.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Collector } from "./collector.ts";
import { ERC1967_PROXY_ARTIFACT, compareDeployedCode, loadArtifact, tryLoadArtifact } from "./codehash.ts";
import { ADMIN_ROLE, Z32, ZERO } from "./constants.ts";
import { isAddress, lc } from "./manifests.ts";
import { manifestBase, scopeTable } from "../stage-table.ts";
import { USDC_ADDRESS, checkUsdcCode } from "../usdc.ts";
import { keccak256, toHex } from "viem";
import type { Address, ChainReader, Hex, VerifyOptions, VerifyReport } from "./types.ts";

const HAS_ROLE = "function hasRole(bytes32 role, address account) view returns (bool)";
const hasRole = async (ch: ChainReader, at: Address, r: Hex, who: Address): Promise<boolean> => (await ch.read(at, HAS_ROLE, [r, who])) as boolean;
const role = (name: string): Hex => keccak256(toHex(name));
export const FUND_ROLES = {
  EMERGENCY: role("EMERGENCY_ROLE"), KEEPER: role("KEEPER_ROLE"), GOVERNANCE: role("GOVERNANCE_ROLE"), REBALANCER: role("REBALANCER_ROLE"), FLOW: role("FLOW_ROLE"),
  TARGET_SETTER: role("TARGET_SETTER_ROLE"), RELEASER: role("RECEIPT_RELEASER_ROLE"), PROPOSER: role("PROPOSER_ROLE"), CANCELLER: role("CANCELLER_ROLE"), EXECUTOR: role("EXECUTOR_ROLE"),
} as const;

/** The queue's FlowParams fields in struct order, each with the fund sheet name that sets it (DeployFlowQueue.s.sol). */
export const FLOW_PARAM_FIELDS: readonly [string, string][] = [
  ["epochLength", "FLOW_EPOCH_LENGTH"], ["settleWindow", "FLOW_SETTLE_WINDOW"], ["minHold", "FLOW_MIN_HOLD"], ["keeperGrace", "FLOW_KEEPER_GRACE"],
  ["maxEpochFlowBps", "FLOW_MAX_EPOCH_FLOW_BPS"], ["epochFlowFloorUsdc", "FLOW_EPOCH_FLOOR_USDC"], ["maxSharePriceMoveBps", "FLOW_MAX_SHARE_PRICE_MOVE_BPS"], ["maxRoll", "FLOW_MAX_ROLL"],
  ["minRequestUsdc", "FLOW_MIN_REQUEST_USDC"], ["maxFreeze", "FLOW_MAX_FREEZE"], ["slices", "FLOW_SLICES"], ["quorum", "FLOW_QUORUM"], ["dispersionBps", "FLOW_DISPERSION_BPS"],
  ["refBandBps", "FLOW_REF_BAND_BPS"], ["legBandBps", "FLOW_LEG_BAND_BPS"], ["sequencerGrace", "FLOW_SEQUENCER_GRACE"], ["usdcPegBandBps", "FLOW_USDC_PEG_BAND_BPS"],
  ["maxLendRateGrowthBps", "FLOW_MAX_LEND_RATE_GROWTH_BPS"],
];
const FLOW_PARAMS_SIG = `function flowParams() view returns ((uint32 epochLength, uint32 settleWindow, uint32 minHold, uint32 keeperGrace, uint16 maxEpochFlowBps, uint128 epochFlowFloorUsdc, uint16 maxSharePriceMoveBps, uint16 maxRoll, uint128 minRequestUsdc, uint32 maxFreeze, uint8 slices, uint8 quorum, uint16 dispersionBps, uint16 refBandBps, uint16 legBandBps, uint32 sequencerGrace, uint16 usdcPegBandBps, uint16 maxLendRateGrowthBps))`;
/** The fund's asset count: three lending venues and two basket tokens (proposal 4.5, DeployFund.s.sol N_ASSETS). */
export const FUND_ASSET_COUNT = 5;

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

  // ---- every proxy: the build's code, the fund-system timelock as its only upgrade authority, the sheet's release mode
  const proxyArtifact = tryLoadArtifact(opts.artifactsDir, ERC1967_PROXY_ARTIFACT);
  for (const s of table.stages) for (const p of s.proxies ?? []) {
    const m = files[manifestBase(s.manifest)];
    const at = A(m[p.field]);
    const label = `${s.name} ${p.contract}`;
    await c.run(`${label}: runtime code equals build artifact (masked)`, async () => {
      const r = await compareDeployedCode(chain, at, loadArtifact(opts.artifactsDir, p.contract), proxyArtifact);
      return { ok: r.ok, detail: r.detail };
    });
    await c.runEq(`${label}: upgradeTimelock() is the fund-system timelock`, async () => lc((await chain.read(at, "function upgradeTimelock() view returns (address)")) as string), lc(addr.timelock));
    c.eq(`${label}: manifest upgrade_timelock is the fund-system timelock`, lc(m.upgrade_timelock), lc(addr.timelock));
    c.eq(`${label}: manifest upgrade_mode equals the sheet`, m.upgrade_mode, sheet.upgradeMode ?? "");
    await c.runEq(`${label}: upgradesFrozen() agrees with the sheet's release mode`, () => chain.read(at, "function upgradesFrozen() view returns (bool)"), sheet.upgradeMode === "frozen");
  }

  // ---- the timelock and the Safe
  await c.run("timelock: has code", async () => (await chain.getCode(addr.timelock)).length > 2);
  await c.runEq("timelock: getMinDelay() equals the sheet", async () => Number(await chain.read(addr.timelock, "function getMinDelay() view returns (uint256)")), sheet.timelockDelay);
  await c.runEq("timelock: PROPOSER_ROLE held by the Safe", () => hasRole(chain, addr.timelock, FUND_ROLES.PROPOSER, addr.safe), true);
  await c.runEq("timelock: CANCELLER_ROLE held by the Safe", () => hasRole(chain, addr.timelock, FUND_ROLES.CANCELLER, addr.safe), true);
  // Owner decision D4-10 (2026-11-13): the fund timelock's only executor is the Safe; the vaults system keeps ADR-0004's open executor.
  c.eq("fund-timelock: manifest executorPolicy is safe-only", tm.executorPolicy, "safe-only");
  await c.runEq("timelock: EXECUTOR_ROLE held by the Safe", () => hasRole(chain, addr.timelock, FUND_ROLES.EXECUTOR, addr.safe), true);
  await c.runEq("timelock: EXECUTOR_ROLE not open (not held by address 0)", () => hasRole(chain, addr.timelock, FUND_ROLES.EXECUTOR, ZERO), false);
  await c.runEq("timelock: EXECUTOR_ROLE not held by the deployer", () => hasRole(chain, addr.timelock, FUND_ROLES.EXECUTOR, D), false);
  await c.runEq("timelock: PROPOSER_ROLE not held by the deployer", () => hasRole(chain, addr.timelock, FUND_ROLES.PROPOSER, D), false);
  await c.runEq("timelock: DEFAULT_ADMIN not held by the deployer", () => hasRole(chain, addr.timelock, Z32, D), false);
  await c.runEq("safe: threshold equals the sheet", async () => Number(await chain.read(addr.safe, "function getThreshold() view returns (uint256)")), sheet.safeThreshold);
  await c.runEq("safe: owners equal the sheet", async () => ((await chain.read(addr.safe, "function getOwners() view returns (address[])")) as string[]).map(lc).sort().join(","), sheet.safeOwners.map(lc).sort().join(","));

  // ---- the handover: the timelock administers every contract, the deployer holds nothing
  const admins: [string, Address][] = [["fund", addr.fund], ["rebalancer", addr.rebalancer], ["governance", addr.governance], ["queue", addr.queue], ["receipt", addr.receipt]];
  for (const [n, at] of admins) {
    await c.runEq(`${n}: ADMIN_ROLE held by the timelock`, () => hasRole(chain, at, ADMIN_ROLE, addr.timelock), true);
    await c.runEq(`${n}: ADMIN_ROLE not held by the deployer`, () => hasRole(chain, at, ADMIN_ROLE, D), false);
    await c.runEq(`${n}: DEFAULT_ADMIN not held by the deployer`, () => hasRole(chain, at, Z32, D), false);
  }
  await c.runEq("receipt: DEFAULT_ADMIN held by the timelock", () => hasRole(chain, addr.receipt, Z32, addr.timelock), true);
  await c.runEq("receipt: RECEIPT_RELEASER_ROLE held by governance", () => hasRole(chain, addr.receipt, FUND_ROLES.RELEASER, addr.governance), true);
  await c.runEq("receipt: ADMIN_ROLE not held by governance", () => hasRole(chain, addr.receipt, ADMIN_ROLE, addr.governance), false);
  await c.runEq("governance: TARGET_SETTER_ROLE held by the timelock", () => hasRole(chain, addr.governance, FUND_ROLES.TARGET_SETTER, addr.timelock), true);
  await c.runEq("governance: TARGET_SETTER_ROLE not held by the deployer", () => hasRole(chain, addr.governance, FUND_ROLES.TARGET_SETTER, D), false);
  for (const [n, at] of [["fund", addr.fund], ["queue", addr.queue]] as [string, Address][]) {
    await c.runEq(`${n}: EMERGENCY_ROLE held by the emergency key`, () => hasRole(chain, at, FUND_ROLES.EMERGENCY, sheet.emergency), true);
    await c.runEq(`${n}: EMERGENCY_ROLE not held by the deployer`, () => hasRole(chain, at, FUND_ROLES.EMERGENCY, D), false);
  }
  for (const [n, at] of [["queue", addr.queue], ["rebalancer", addr.rebalancer]] as [string, Address][]) {
    await c.runEq(`${n}: KEEPER_ROLE held by the keeper`, () => hasRole(chain, at, FUND_ROLES.KEEPER, f.keeper), true);
    await c.runEq(`${n}: KEEPER_ROLE not held by the deployer`, () => hasRole(chain, at, FUND_ROLES.KEEPER, D), false);
  }

  // ---- the one-time bindings
  await c.runEq("fund: GOVERNANCE_ROLE held by governance", () => hasRole(chain, addr.fund, FUND_ROLES.GOVERNANCE, addr.governance), true);
  await c.runEq("fund: REBALANCER_ROLE held by the rebalancer", () => hasRole(chain, addr.fund, FUND_ROLES.REBALANCER, addr.rebalancer), true);
  await c.runEq("fund: FLOW_ROLE held by the queue", () => hasRole(chain, addr.fund, FUND_ROLES.FLOW, addr.queue), true);
  await c.runEq("fund: flowQueue() is the queue", async () => lc((await chain.read(addr.fund, "function flowQueue() view returns (address)")) as string), lc(addr.queue));
  for (const r of ["GOVERNANCE", "REBALANCER", "FLOW"] as const) await c.runEq(`fund: ${r}_ROLE not held by the deployer`, () => hasRole(chain, addr.fund, FUND_ROLES[r], D), false);
  await c.runEq("rebalancer: fund() is the fund", async () => lc((await chain.read(addr.rebalancer, "function fund() view returns (address)")) as string), lc(addr.fund));
  await c.runEq("governance: fund() is the fund", async () => lc((await chain.read(addr.governance, "function fund() view returns (address)")) as string), lc(addr.fund));
  await c.runEq("governance: receipts() is the fund system's register", async () => lc((await chain.read(addr.governance, "function receipts() view returns (address)")) as string), lc(addr.receipt));

  // ---- the fund's configuration and the queue's flow parameters, against the sheet
  await c.runEq("fund: assetCount() is the five assets of proposal 4.5", async () => Number(await chain.read(addr.fund, "function assetCount() view returns (uint256)")), FUND_ASSET_COUNT);
  await c.run("fund: config() equals the sheet (TVL cap, per-deposit cap, exit fee)", async () => {
    const [tvl, per, fee] = (await chain.read(addr.fund, "function config() view returns (uint256, uint256, uint256, address)")) as [bigint, bigint, bigint, string];
    const ok = tvl === f.tvlCap && per === f.perDepositCap && fee === f.exitFeeBps;
    return { ok, detail: `chain ${tvl}/${per}/${fee}, sheet ${f.tvlCap}/${f.perDepositCap}/${f.exitFeeBps}` };
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
    const got = (await chain.read(addr.queue, FLOW_PARAMS_SIG)) as Record<string, bigint | number>;
    const diff = FLOW_PARAM_FIELDS.filter(([field, name]) => BigInt(got[field] ?? -1) !== f.params[name]).map(([field, name]) => `${field} ${String(got[field])} != ${name} ${String(f.params[name])}`);
    return { ok: diff.length === 0, detail: diff.length ? diff.join("; ") : `${FLOW_PARAM_FIELDS.length} fields equal` };
  });

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
