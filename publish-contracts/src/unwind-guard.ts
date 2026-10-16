// The govern row `set-unwind-guard` (QA plan v1 D7, review E5, issue 1705 Q2): the Safe, through the timelock, sets a basket vault's emergency unwind guard,
// BasketVault.setEmergencyUnwindGuard(token, minUsdcOut, overrideAllowed, maxLossBps) (onlyRole(ADMIN_ROLE), held by the timelock after the handover). No contract change.
// Why: before this row no stage and no row set the guard, so every guard read zero on a deployed vault. emergencyUnwind then reverts EmergencyFloorUnavailable for any leg whose
// TWAP read fails (a stale recorder after a price drop), and emergencyUnwindWithOverride reverts EmergencyUnwindOverrideDisabled: the escape path the docs name
// (docs/technical/smart-contracts.md, "NAV closure on oracle failure") did not exist.
// The values: minUsdcOut is an absolute USDC amount (6 decimals) for the vault's WHOLE balance of that token. A plain unwind sells at max(TWAP floor, minUsdcOut), an unwind whose
// TWAP read fails sells at minUsdcOut alone, and the override path sells at minUsdcOut * (10000 - maxLossBps) / 10000. A floor above what the balance can fetch makes that unwind
// revert, so the operator sets it from the vault's current holding and runs the row again (a new operation) as the holding changes. overrideAllowed defaults to true (QA plan v1
// Decisions D3, the issue 1705 Q2 default "allowed, Safe-only"): only the Safe, through the timelock, can turn it on; EMERGENCY_ROLE then uses it. A zero minUsdcOut is refused
// (it is the state this row exists to end), and so are values whose override floor rounds to zero with the override on (maxLossBps 10000, or a floor of a few units).
// One run is ONE timelock operation on ONE basket vault: one call for one token (`token=0x..`), or a batch with one call per active asset (`token=all`), all with the same values.
// It runs on 8453 (production and rehearsal) and on the Twin chain, never in stage 13. The stage 12 verifier fails "vault[X]: emergencyUnwindGuard minUsdcOut above zero on every
// active asset of an open vault" for an open basket vault with a zero guard, so the row runs before the post-govern verify (scheduled in the same sitting as the unpauses).
// This module is pure: it reads no chain and sends nothing. govern.ts reads the chain and sends the call.
import { encodeFunctionData, getAddress, keccak256, parseAbi, toBytes, type Address, type Hex } from "viem";
import { PublishError } from "./errors.ts";
import { UNWIND_GUARD_ROW } from "./unwind-guard-twin.ts";
import { BASKET_KEYS, VAULT_NAME, type VaultKey } from "./sheet.ts";

export { UNWIND_GUARD_ROW, TWIN_UNWIND_MIN_USDC_OUT, TWIN_UNWIND_MAX_LOSS_BPS, twinUnwindGuardArgs } from "./unwind-guard-twin.ts";
/** The basket vault surface the row uses: the setter, its public getter, the asset rows (which tokens are active) and the ADMIN_ROLE gate. */
export const VAULT_UNWIND_GUARD_ABI = parseAbi([
  "function setEmergencyUnwindGuard(address token, uint256 minUsdcOut, bool overrideAllowed, uint256 maxLossBps)",
  "function emergencyUnwindGuard(address token) view returns (uint256 minUsdcOut, bool overrideAllowed, uint256 maxLossBps)",
  "function assets(uint256 index) view returns (address token, address pool, uint24 swapFee, bool active, address adapter, uint8 venue)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
]);
/** BasketVault.MAX_BPS: maxLossBps above it reverts InvalidParam. */
export const MAX_BPS = 10_000n;

/** The `--admin-arg` keys of the row. */
export const UNWIND_GUARD_KEYS = ["vault", "token", "min-usdc-out", "max-loss-bps", "override-allowed"] as const;
export type UnwindGuardKey = (typeof UNWIND_GUARD_KEYS)[number];
/** The row's arguments as the CLI read them (`--admin-arg K=V`). */
export type UnwindGuardArgs = Partial<Record<UnwindGuardKey, string>>;
export type BasketKey = (typeof BASKET_KEYS)[number];

/** What one run sets: the vault, `all` or one token, and the three guard values. */
export interface UnwindGuardWant { vault: BasketKey; token: Address | "all"; minUsdcOut: bigint; overrideAllowed: boolean; maxLossBps: bigint }
/** One guard as the vault's public getter reads it. */
export interface GuardRead { token: Address; minUsdcOut: bigint; overrideAllowed: boolean; maxLossBps: bigint }

const usage = (m: string): never => { throw new PublishError("USAGE", `--row ${UNWIND_GUARD_ROW}: ${m}`, { row: UNWIND_GUARD_ROW }); };
const uint = (v: string | undefined, key: UnwindGuardKey): bigint => {
  if (v === undefined) return usage(`needs --admin-arg ${key}=N`);
  if (!/^[0-9]+$/.test(v)) return usage(`--admin-arg ${key} must be a whole number (no sign, no decimals), got '${v}'`);
  return BigInt(v);
};

/** The row's arguments, checked. Every problem is USAGE and nothing is read or sent. */
export function parseUnwindGuardArgs(args: UnwindGuardArgs | undefined): UnwindGuardWant {
  const a = args ?? {};
  const vault = a.vault;
  if (vault === undefined) return usage(`needs --admin-arg vault=${BASKET_KEYS.join("|")}`);
  if (vault === "USDC") return usage("rmUSDC has no emergency unwind guard (it holds lending adapters, not swapped basket assets): vault is PROTO, AGENT or RWA");
  if (!(BASKET_KEYS as readonly string[]).includes(vault)) return usage(`--admin-arg vault must be one of ${BASKET_KEYS.join(", ")}, got '${vault}'`);
  const t = a.token;
  if (t === undefined) return usage("needs --admin-arg token=0x<address> (one active asset) or token=all (every active asset of the vault)");
  let token: Address | "all";
  if (t === "all") token = "all";
  else if (/^0x[0-9a-fA-F]{40}$/.test(t)) token = getAddress(t);
  else return usage(`--admin-arg token must be an address or 'all', got '${t}'`);
  const minUsdcOut = uint(a["min-usdc-out"], "min-usdc-out");
  if (minUsdcOut === 0n) usage("min-usdc-out 0 is the unset guard this row exists to replace: emergencyUnwind then reverts EmergencyFloorUnavailable when a TWAP read fails. Give the least USDC (6 decimals) the vault's whole balance of the token may sell for");
  const maxLossBps = uint(a["max-loss-bps"], "max-loss-bps");
  const o = a["override-allowed"] ?? "true";
  if (o !== "true" && o !== "false") usage(`--admin-arg override-allowed must be true or false, got '${o}'`);
  const overrideAllowed = o === "true";
  if (maxLossBps > MAX_BPS) usage(`max-loss-bps ${maxLossBps} is above ${MAX_BPS}: the vault reverts it (InvalidParam)`);
  // the override path sells at minUsdcOut * (MAX_BPS - maxLossBps) / MAX_BPS (integer division): zero accepts any loss, which is the state #446 closed
  if (overrideAllowed && (minUsdcOut * (MAX_BPS - maxLossBps)) / MAX_BPS === 0n) usage(`min-usdc-out ${minUsdcOut} with max-loss-bps ${maxLossBps} and the override on makes the override floor zero (any loss is accepted): give a lower cap or a higher floor, or override-allowed=false`);
  return { vault: vault as BasketKey, token, minUsdcOut, overrideAllowed, maxLossBps };
}

/** The `--admin-arg` flags that name this exact run (the resume command spells them out: they carry no secret). */
export const unwindGuardArgsText = (w: UnwindGuardWant): string =>
  [`vault=${w.vault}`, `token=${w.token}`, `min-usdc-out=${w.minUsdcOut}`, `max-loss-bps=${w.maxLossBps}`, `override-allowed=${w.overrideAllowed}`].map((kv) => `--admin-arg ${kv}`).join(" ");

/** The tokens one run sets: every active asset for `all`, else the one token, which must be active (the vault reverts AssetNotFound for any other, one delay later). */
export function unwindGuardTargets(want: UnwindGuardWant, active: readonly Address[]): Address[] | string {
  const name = VAULT_NAME[want.vault as VaultKey];
  if (active.length === 0) return `${name} lists no active asset: there is nothing to guard`;
  if (want.token === "all") return [...active];
  const hit = active.find((x) => x.toLowerCase() === (want.token as string).toLowerCase());
  return hit ? [hit] : `${want.token} is not an active asset of ${name} (active: ${active.join(", ")}): setEmergencyUnwindGuard would revert AssetNotFound after the delay`;
}

/** The calls of one run: setEmergencyUnwindGuard(token, minUsdcOut, overrideAllowed, maxLossBps) on the vault, one per token, in the vault's asset order. */
export function buildUnwindGuardCalls(vault: Address, want: UnwindGuardWant, tokens: readonly Address[]): { label: string; target: Address; data: Hex }[] {
  const name = VAULT_NAME[want.vault as VaultKey];
  return tokens.map((token) => ({
    label: `${name}.setEmergencyUnwindGuard(${token}, ${want.minUsdcOut}, ${want.overrideAllowed}, ${want.maxLossBps})`,
    target: vault,
    data: encodeFunctionData({ abi: VAULT_UNWIND_GUARD_ABI, functionName: "setEmergencyUnwindGuard", args: [token, want.minUsdcOut, want.overrideAllowed, want.maxLossBps] }),
  }));
}

/**
 * The run-manifest key and salt input of one run: the row, the vault and a hash of the calldata. The same vault, tokens and values are one record (a rerun resumes or reprints it);
 * other values are another. A record executed earlier whose guard the chain no longer reads opens a new round (`<key>:round-N`, like the unpause rows).
 */
export const unwindGuardRecordKey = (vault: BasketKey, calls: readonly { data: Hex }[]): string =>
  `${UNWIND_GUARD_ROW}-${vault}-${keccak256(toBytes(calls.map((c) => c.data).join(""))).slice(2, 10)}`;

/** Read-back problems: each token's guard must read exactly the values this run set. An empty list is a pass (also the "already in effect" test before the send). */
export function unwindGuardProblems(want: UnwindGuardWant, reads: readonly GuardRead[]): string[] {
  const name = VAULT_NAME[want.vault as VaultKey];
  return reads.flatMap((r) => (r.minUsdcOut === want.minUsdcOut && r.overrideAllowed === want.overrideAllowed && r.maxLossBps === want.maxLossBps)
    ? []
    : [`${name}.emergencyUnwindGuard(${r.token}) reads (${r.minUsdcOut}, ${r.overrideAllowed}, ${r.maxLossBps}), want (${want.minUsdcOut}, ${want.overrideAllowed}, ${want.maxLossBps})`]);
}
