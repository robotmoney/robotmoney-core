// The govern row `retire-vault` (issue 1912, ADR-0017, ADR-0009): the Safe, through the timelock, retires ONE vault of the live deployment. Today that vault is rmAGENT.
// ONE timelock batch of two calls, in the one order the contracts allow:
//   1. registry.migrateEligibility(vault, false, <three-leg vector>, <three weights>)   the vault leaves the router-eligible set and the default vector shrinks to the
//      three vaults that stay (rmUSDC, rmPROTO, rmRWA) in the same call, because PortfolioRouter._setDefaultWeights reverts LengthMismatch unless the vector length equals
//      registry.routerEligibleCount().
//   2. registry.retire(vault)                                                          VaultRegistry.retire reverts RetireWhileRouterEligible while the vault is eligible.
// A timelock batch is atomic, so no observer, deposit or redeem ever sees a router that weights a retired vault. After the batch the vault is withdraw-only (ADR-0009):
// `redeem` and `redeemInKind` stay open, `deposit` reverts, the router never routes into it, and there is no assisted migration. Nothing moves a holder's funds.
// The builders reuse the registry ABI and the vector rules of redeploy-vault.ts (core 1796). The row needs no deployed contract and no new Solidity: it is a configuration change.
// An applied receipt's vector may be active (issue 1988): nothing clears it, and neither call of the batch touches it. A vector applied over the four eligible vaults still names the
// retired vault after the batch: the router skips that leg (registry status Retired, PortfolioRouter._isDepositable) and spreads its share over the other legs by their bps, until the
// next `govern --row apply-receipt` replaces the vector with one over the three vaults that stay. retiredVectorProblems is the one rule for that state: the row's pre-check and read-back,
// the evidence check and verify all apply it.
// This module is pure: it reads no chain and sends nothing. govern.ts reads the chain, schedules, executes and reads the result back.
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { PublishError } from "./errors.ts";
import { BPS_TOTAL, REGISTRY_REDEPLOY_ABI, STATUS_ACTIVE, STATUS_NAME, STATUS_RETIRED } from "./redeploy-vault.ts";

export const RETIRE_ROW = "retire-vault";
/** The `--admin-arg` keys of the row: the vault to retire and the default vector that stays, `USDC:9500,PROTO:500,RWA:0`. */
export const RETIRE_KEYS = ["vault", "weights"] as const;
export type RetireKey = (typeof RETIRE_KEYS)[number];
export type RetireArgs = Partial<Record<RetireKey, string>>;
/** The vaults that stay router-eligible after the retire, in vector order. The router vector has exactly one leg per eligible vault (ADR-0017). */
export const STAYING_KEYS = ["USDC", "PROTO", "RWA"] as const;
export type StayingKey = (typeof STAYING_KEYS)[number];

export interface RetireWant { vault: Address; weights: { key: StayingKey; bps: number }[] }

const usage = (m: string): never => { throw new PublishError("USAGE", `--row ${RETIRE_ROW}: ${m}`, { row: RETIRE_ROW }); };
const lc = (x: string): string => x.toLowerCase();

/** The row's arguments, checked. Every problem is USAGE and nothing is read or sent. The vector is exactly three legs (USDC, PROTO, RWA) summing to 10000. */
export function parseRetireArgs(args: RetireArgs | undefined): RetireWant {
  const a = args ?? {};
  if (a.vault === undefined) return usage("needs --admin-arg vault=0x<the vault to retire, rmAGENT on the live v0.5.0 deployment>");
  if (!/^0x[0-9a-fA-F]{40}$/.test(a.vault)) return usage(`--admin-arg vault must be an address, got '${a.vault}'`);
  if (a.weights === undefined) return usage("needs --admin-arg weights=USDC:9500,PROTO:500,RWA:0 (the three-leg default vector that stays, every vault named)");
  const parts = a.weights.split(",").map((p) => /^\s*([A-Z]+):([0-9]+)\s*$/.exec(p));
  if (parts.some((m) => m === null)) return usage(`--admin-arg weights must be KEY:bps pairs, got '${a.weights}'`);
  const weights = parts.map((m) => ({ key: m![1] as string, bps: Number(m![2]) }));
  const keys = weights.map((w) => w.key).sort().join(",");
  if (keys !== [...STAYING_KEYS].sort().join(",")) return usage(`--admin-arg weights must name exactly ${STAYING_KEYS.join(", ")} once each (three legs), got ${keys || "none"}`);
  const total = weights.reduce((t, w) => t + w.bps, 0);
  if (total !== BPS_TOTAL) return usage(`--admin-arg weights sums to ${total} bps, want ${BPS_TOTAL}`);
  return { vault: getAddress(a.vault), weights: STAYING_KEYS.map((k) => weights.find((w) => w.key === k)! ) as RetireWant["weights"] };
}

/** The `--admin-arg` flags that name this exact run (the resume command spells them out: they carry no secret). */
export const retireArgsText = (w: RetireWant): string =>
  [`vault=${w.vault}`, `weights=${w.weights.map((x) => `${x.key}:${x.bps}`).join(",")}`].map((kv) => `--admin-arg ${kv}`).join(" ");

/** The run-manifest key and salt input of a retire of one vault. */
export const retireRecordKey = (vault: string): string => `${RETIRE_ROW}-${lc(vault).slice(2)}`;

export interface RetireCall { label: string; target: Address; data: Hex }

/** The two calls of the batch, in the one order the contracts allow. The same builder serves govern, the preview and the evidence chain check. */
export function buildRetireCalls(i: { registry: Address; vault: Address; finalVaults: readonly string[]; finalBps: readonly (bigint | number)[] }): RetireCall[] {
  if (i.finalVaults.length !== STAYING_KEYS.length || i.finalVaults.length !== i.finalBps.length) throw new PublishError("GOVERN", `the retire vector needs exactly ${STAYING_KEYS.length} legs and one weight per leg`);
  if (new Set(i.finalVaults.map(lc)).size !== i.finalVaults.length) throw new PublishError("GOVERN", "the retire vector lists a vault twice");
  if (i.finalVaults.some((v) => lc(v) === lc(i.vault))) throw new PublishError("GOVERN", `the retire vector must not hold the vault being retired ${i.vault}`);
  const total = i.finalBps.reduce<number>((t, x) => t + Number(x), 0);
  if (total !== BPS_TOTAL) throw new PublishError("GOVERN", `the retire vector sums to ${total} bps, want ${BPS_TOTAL}`);
  const reg = (functionName: "migrateEligibility" | "retire", args: unknown[]): Hex => encodeFunctionData({ abi: REGISTRY_REDEPLOY_ABI, functionName, args } as never);
  return [
    { label: "registry.migrateEligibility(vault, false, three legs)", target: i.registry, data: reg("migrateEligibility", [i.vault, false, i.finalVaults, i.finalBps.map(BigInt)]) },
    { label: "registry.retire(vault)", target: i.registry, data: reg("retire", [i.vault]) },
  ];
}

/** The router's preview, read to see the router skip a retired leg of an active applied vector (PortfolioRouter.LegPreview). */
export const ROUTER_PREVIEW_DEPOSIT = "function previewDeposit(uint256 amount) view returns ((address vault, uint256 weightBps, uint256 legAmount, uint256 estShares, bool unavailable)[] legs)";
export const ROUTER_PREVIEW_ABI = parseAbi([ROUTER_PREVIEW_DEPOSIT, "function getWeights() view returns (address[] vaults, uint256[] bps)"]);
/** 1 USDC: the amount the skip is previewed at. Any positive amount shows it: an unavailable leg gets 0 whatever the amount. */
export const PREVIEW_AMOUNT = 1_000_000n;

const sumOf = (b: readonly (bigint | number)[]): bigint => b.reduce<bigint>((t, x) => t + BigInt(x), 0n);
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => lc(x) === lc(b[i]!));

/**
 * The router's vectors after `vault` was retired. An empty list is a pass. The default holds one leg per remaining vault (`vaultCount` of them, distinct, 10000 bps) and not `vault`.
 * With no applied vector active the effective vector IS the default. With one active (issue 1992; nothing clears it, issue 1988) the effective vector sums to 10000, its vaults
 * without `vault` are the default's vaults in the same order, and those legs carry weight. It may still name `vault` (a vector applied before the retire): the caller then checks
 * that the router skips that leg.
 */
export function retiredVectorProblems(vault: string, r: {
  vaultCount: number; votedWeightsActive: boolean;
  defaultVaults: readonly string[]; defaultBps: readonly (bigint | number)[]; effectiveVaults: readonly string[]; effectiveBps: readonly (bigint | number)[];
}): string[] {
  const bad: string[] = [];
  const dv = r.defaultVaults, ev = r.effectiveVaults;
  if (dv.length !== r.vaultCount || dv.length !== r.defaultBps.length || new Set(dv.map(lc)).size !== dv.length) bad.push(`the default vector [${dv.join(", ")}] is not ${r.vaultCount} distinct legs with one weight each`);
  if (sumOf(r.defaultBps) !== BigInt(BPS_TOTAL)) bad.push(`the default vector sums to ${sumOf(r.defaultBps)} bps, want ${BPS_TOTAL}`);
  if (dv.some((v) => lc(v) === lc(vault))) bad.push(`the default vector still holds the retired vault ${vault}`);
  if (ev.length !== r.effectiveBps.length || ev.length === 0 || new Set(ev.map(lc)).size !== ev.length) bad.push(`the effective vector [${ev.join(", ")}] is not a list of distinct legs with one weight each`);
  else if (!r.votedWeightsActive) {
    if (vkey(ev, r.effectiveBps) !== vkey(dv, r.defaultBps)) bad.push(`no applied vector is active, so the effective vector [${vkey(ev, r.effectiveBps)}] must be the default [${vkey(dv, r.defaultBps)}]`);
  } else {
    if (sumOf(r.effectiveBps) !== BigInt(BPS_TOTAL)) bad.push(`the applied vector sums to ${sumOf(r.effectiveBps)} bps, want ${BPS_TOTAL}`);
    const keep = ev.map((v, i) => ({ v, b: r.effectiveBps[i]! })).filter((x) => lc(x.v) !== lc(vault));
    if (!sameList(keep.map((x) => x.v), dv)) bad.push(`the applied vector's vaults without the retired one [${keep.map((x) => x.v).join(", ")}] are not the default's vaults [${dv.join(", ")}]`);
    else if (sumOf(keep.map((x) => x.b)) === 0n) bad.push("the applied vector puts no weight on the vaults that stay: every router deposit would route nothing");
  }
  return bad;
}

/** What the chain says before the batch is scheduled. */
export interface RetireBefore {
  listed: readonly string[];
  status: number;
  eligible: boolean;
  registryRouter: string;
  router: string;
  timelockIsRegistryAdmin: boolean;
  votedWeightsActive: boolean;
  /** The router's applied vector (getWeights), read when votedWeightsActive is true. */
  appliedVaults?: readonly string[];
  appliedBps?: readonly (bigint | number)[];
  defaultVaults: readonly string[];
  hasCode: boolean;
}

/** Why the batch cannot start from this state. An empty list is a pass. Checked before the schedule and again before the execute. */
export function retireBeforeProblems(want: RetireWant, finalVaults: readonly string[], b: RetireBefore): string[] {
  const bad: string[] = [];
  if (!b.hasCode) bad.push(`the vault ${want.vault} has no code`);
  if (!b.listed.some((v) => lc(v) === lc(want.vault))) bad.push(`the registry does not list the vault ${want.vault}`);
  if (b.status !== STATUS_ACTIVE) bad.push(`the vault's registry status is ${STATUS_NAME[b.status] ?? b.status}, want Active`);
  if (!b.eligible) bad.push("the vault is not router-eligible: there is no eligibility to move, and the retire row only runs on an eligible vault");
  if (lc(b.registryRouter) !== lc(b.router)) bad.push(`registry.router() is ${b.registryRouter}, not the deployment's router ${b.router}: migrateEligibility would revert RouterNotLinked`);
  if (!b.timelockIsRegistryAdmin) bad.push("the timelock does not hold ADMIN_ROLE on the registry: the batch would revert");
  // Issue 1988: an active applied vector is allowed and stays as it is (nothing clears it). Predict the state after the batch: the vector that stays is the default, the applied vector
  // is unchanged. It must pass the read-back's rule, or the batch would execute into a state the read-back refuses.
  if (b.votedWeightsActive) {
    if (b.appliedVaults === undefined || b.appliedBps === undefined) bad.push("router.votedWeightsActive() is true and the applied vector (getWeights) was not read");
    else for (const m of retiredVectorProblems(want.vault, { vaultCount: finalVaults.length, votedWeightsActive: true, defaultVaults: finalVaults, defaultBps: want.weights.map((w) => w.bps), effectiveVaults: b.appliedVaults, effectiveBps: b.appliedBps })) {
      bad.push(`the active applied vector does not fit the vector that stays: ${m}`);
    }
  }
  // the vector must be the router's current default vector without the vault: the same three vaults, so the registry's length check passes
  const stays = b.defaultVaults.filter((v) => lc(v) !== lc(want.vault));
  if (!b.defaultVaults.some((v) => lc(v) === lc(want.vault))) bad.push(`the router's default vector does not hold the vault: [${b.defaultVaults.join(", ")}]`);
  else if (stays.length !== finalVaults.length || !finalVaults.every((v) => stays.some((s) => lc(s) === lc(v)))) {
    bad.push(`the vector that stays [${finalVaults.join(", ")}] is not the router's current default vector without the vault [${stays.join(", ")}]: the batch would revert LengthMismatch or VaultNotActive`);
  }
  return bad;
}

/** What the chain says after the batch executed. */
export interface RetireAfter {
  status: number;
  eligible: boolean;
  eligibleCount: number;
  votedWeightsActive: boolean;
  defaultVaults: readonly string[];
  defaultBps: readonly (bigint | number)[];
  effectiveVaults: readonly string[];
  effectiveBps: readonly (bigint | number)[];
  retiredFlag: boolean;
  hasCode: boolean;
  /** The retired vault's leg in router.previewDeposit: unavailable with amount 0. Read only when an active applied vector still names the vault. */
  retiredLegSkipped?: boolean;
}

const vkey = (v: readonly string[], b: readonly (bigint | number)[]): string => v.map((a, k) => `${lc(a)}:${b[k]}`).join(",");

/**
 * What must hold after the batch. An empty list is a pass. The default vector is the three-leg vector that stays. The effective vector is what deposits route by: the default when
 * no applied vector is active, else the applied vector, which retiredVectorProblems checks and whose retired leg, if it still names one, the router must skip (issue 1988).
 */
export function retireReadBackProblems(vault: string, finalVaults: readonly string[], finalBps: readonly (bigint | number)[], a: RetireAfter): string[] {
  const bad: string[] = [];
  if (a.status !== STATUS_RETIRED) bad.push(`the vault's registry status is ${STATUS_NAME[a.status] ?? a.status}, want Retired`);
  if (a.eligible) bad.push("the vault is still router-eligible");
  if (a.eligibleCount !== finalVaults.length) bad.push(`registry.routerEligibleCount() is ${a.eligibleCount}, want ${finalVaults.length}`);
  const want = vkey(finalVaults, finalBps);
  if (vkey(a.defaultVaults, a.defaultBps) !== want) bad.push(`router.getDefaultWeights() is [${vkey(a.defaultVaults, a.defaultBps)}], want [${want}]`);
  if (!a.votedWeightsActive) {
    if (vkey(a.effectiveVaults, a.effectiveBps) !== want) bad.push(`router.getEffectiveWeights() is [${vkey(a.effectiveVaults, a.effectiveBps)}], want [${want}]`);
  } else {
    bad.push(...retiredVectorProblems(vault, { vaultCount: finalVaults.length, votedWeightsActive: true, defaultVaults: a.defaultVaults, defaultBps: a.defaultBps, effectiveVaults: a.effectiveVaults, effectiveBps: a.effectiveBps }).map((m) => `the active applied vector: ${m}`));
    if (a.effectiveVaults.some((v) => lc(v) === lc(vault)) && a.retiredLegSkipped !== true) bad.push("the active applied vector still names the retired vault and router.previewDeposit does not show that leg skipped (unavailable, amount 0)");
  }
  if (!a.retiredFlag) bad.push("the vault's retired() flag is false: its deposit halt did not run");
  if (!a.hasCode) bad.push("the vault has no code: it must keep serving redeem and redeemInKind");
  return bad;
}

/** The preview the operator reads before the Safe owners sign: the vault, the vector that stays and each call. Printed by govern before the schedule. */
export function retirePreviewLines(want: RetireWant, finalVaults: readonly string[], calls: readonly RetireCall[]): string[] {
  return [
    `retire-vault preview: ${want.vault} becomes withdraw-only (ADR-0009): redeem and redeemInKind stay open, deposit reverts, the router never routes into it, no assisted migration`,
    `default vector that stays: ${want.weights.map((w, i) => `${w.key} ${finalVaults[i]} ${w.bps} bps`).join(", ")}`,
    ...calls.map((c, i) => `call ${i + 1}: ${c.label} -> ${c.target} ${c.data}`),
  ];
}

/** The vaults the run manifest records as retired by `govern --row retire-vault` (the `vault_retirements` evidence), once each, in the order they were retired. */
export function retiredVaultsOf(m: { vault_retirements?: unknown[] }): { vault: Address }[] {
  const seen = new Set<string>();
  const out: { vault: Address }[] = [];
  for (const e of Array.isArray(m.vault_retirements) ? m.vault_retirements : []) {
    const v = (e as { vault?: unknown })?.vault;
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v) || seen.has(lc(v))) continue;
    seen.add(lc(v));
    out.push({ vault: getAddress(v) });
  }
  return out;
}
