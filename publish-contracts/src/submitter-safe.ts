// Issue 1750: the consensus receipt SUBMITTER is a multisig. Owner decision 2026-10-10: no single key anchors a receipt. The submitter is a SafeL2 v1.4.1 proxy,
// a SECOND Safe, separate from the governing Safe. It holds AGENT_ROLE on the gateway and COMMITTEE_AGENT_ROLE on the IC policy (given by `govern --row register-committee`)
// and nothing else. Docs: docs/technical/consensus-receipt-submitter-runbook.md.
//
// The contracts accept a contract account as the role holder (no msg.sender, tx.origin, isContract or ecrecover check applies to it), so this is a tooling rule: this module
// pins what a submitter Safe must be BEFORE the governing Safe spends a timelock round registering it and BEFORE the operator signs a receipt through it. It mirrors the
// governing-Safe checks of verify/safe-checks.ts (canonical proxy code, L2 singleton, version 1.4.1, threshold at least 2, no module, no guard, canonical fallback handler).
//
// Pure: it reads through an injected chain reader and sends nothing.
import { getAddress, keccak256, parseAbi, type Address, type Hex } from "viem";
import { PublishError } from "./errors.ts";
import { SAFE_141, FALLBACK_HANDLER_SLOT } from "./safe/constants.ts";
import { SAFE_GUARD_SLOT, SAFE_SENTINEL } from "./verify/constants.ts";

export const SUBMITTER_SAFE_ABI = parseAbi([
  "function VERSION() view returns (string)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
]);

/** The chain reads of the check. Tests inject a fake, the real one is a viem public client. */
export interface SubmitterChain {
  getCode(address: Address): Promise<Hex | undefined>;
  getStorageAt(address: Address, slot: Hex): Promise<Hex | undefined>;
  read<T>(address: Address, abi: readonly unknown[], fn: string, args?: unknown[]): Promise<T>;
  /** TEST SEAM ONLY: the proxy code hash to compare with. Unset in production (chainFromClient never sets it), where it is SAFE_141.proxyCodehash. */
  proxyCodehashPin?: Hex;
}

export interface SubmitterSafeInfo { address: Address; owners: Address[]; threshold: number; code_hash: Hex }

const lc = (x: string): string => x.toLowerCase();
const slotAddr = (v: Hex | undefined): string => `0x${(v ?? "0x").replace(/^0x/, "").padStart(64, "0").slice(24)}`.toLowerCase();
const ZERO = "0x0000000000000000000000000000000000000000";

/** Addresses that may never be the submitter, each with the reason that is shown to the operator. First name wins. */
export function forbiddenSubmitters(f: { governingSafe: string; timelock: string; admin: string; pauser: string; emergency: string }): Map<string, string> {
  const m = new Map<string, string>();
  for (const [who, why] of [
    [f.governingSafe, "the governing Safe (the submitter is a separate Safe)"], [f.timelock, "the timelock"], [f.admin, "ADMIN_ADDRESS (the deployer)"],
    [f.pauser, "PAUSER_ADDRESS"], [f.emergency, "EMERGENCY_ADDRESS"],
  ] as const) if (!m.has(lc(who))) m.set(lc(who), why);
  return m;
}

/** Throws USAGE when `address` is one of the forbidden addresses. Needs no chain. */
export function assertNotForbiddenSubmitter(address: string, forbidden: ReadonlyMap<string, string>): void {
  const why = forbidden.get(lc(address));
  if (why) throw new PublishError("USAGE", `the submitter ${address} is ${why}: the submitter holds AGENT_ROLE and COMMITTEE_AGENT_ROLE and nothing else. Use a dedicated submitter Safe. Nothing sent.`, { submitter: address });
}

/**
 * The submitter's kind on chain. `null`: no code, an EOA (a single key; the caller decides whether that is allowed on its chain). Otherwise the Safe's facts, or a PublishError
 * (USAGE) naming EVERY way the contract differs from a canonical SafeL2 1.4.1 multisig. The forbidden list is checked first, with no chain read.
 */
export async function inspectSubmitterSafe(chain: SubmitterChain, address: Address, forbidden: ReadonlyMap<string, string>): Promise<SubmitterSafeInfo | null> {
  const safe = getAddress(address);
  assertNotForbiddenSubmitter(safe, forbidden);
  const code = await chain.getCode(safe);
  if (!code || code === "0x") return null;
  const bad: string[] = [];
  const codeHash = keccak256(code);
  const pin = chain.proxyCodehashPin ?? SAFE_141.proxyCodehash;
  if (codeHash !== pin) bad.push(`its code hash ${codeHash} is not the canonical SafeProxy 1.4.1 ${pin}`);
  if (slotAddr(await chain.getStorageAt(safe, "0x0000000000000000000000000000000000000000000000000000000000000000")) !== lc(SAFE_141.singletonL2)) bad.push(`its singleton (storage slot 0) is not the SafeL2 1.4.1 ${SAFE_141.singletonL2}`);
  let version = "";
  try { version = await chain.read<string>(safe, SUBMITTER_SAFE_ABI, "VERSION"); } catch { /* reported below */ }
  if (version !== "1.4.1") bad.push(`VERSION() is '${version}', want 1.4.1`);
  let owners: Address[] = [];
  let threshold = 0;
  try { owners = (await chain.read<Address[]>(safe, SUBMITTER_SAFE_ABI, "getOwners")).map((o) => getAddress(o)); } catch { bad.push("getOwners() cannot be read"); }
  try { threshold = Number(await chain.read<bigint>(safe, SUBMITTER_SAFE_ABI, "getThreshold")); } catch { bad.push("getThreshold() cannot be read"); }
  if (threshold < 2) bad.push(`its threshold is ${threshold}, want at least 2: a one-of-N Safe is a single key`);
  if (owners.length > 0 && threshold > owners.length) bad.push(`its threshold ${threshold} is above its ${owners.length} owners`);
  try {
    const r = await chain.read<{ array?: string[] } | [string[], string]>(safe, SUBMITTER_SAFE_ABI, "getModulesPaginated", [SAFE_SENTINEL, 10n]);
    const mods: string[] = (Array.isArray(r) ? r[0] : r.array) ?? [];
    if (mods.length > 0) bad.push(`modules are enabled (${mods.join(", ")}): a module moves funds and calls without the owners' signatures`);
  } catch { bad.push("getModulesPaginated() cannot be read"); }
  if (slotAddr(await chain.getStorageAt(safe, SAFE_GUARD_SLOT)) !== ZERO) bad.push("a transaction guard is set");
  if (slotAddr(await chain.getStorageAt(safe, FALLBACK_HANDLER_SLOT)) !== lc(SAFE_141.fallbackHandler)) bad.push(`its fallback handler is not the canonical ${SAFE_141.fallbackHandler}`);
  for (const o of owners) {
    const why = forbidden.get(lc(o));
    if (why) bad.push(`its owner ${o} is ${why}: role separation`);
  }
  if (bad.length) throw new PublishError("USAGE", `the submitter ${safe} is not a canonical SafeL2 1.4.1 multisig: ${bad.join("; ")}. Nothing sent.`, { submitter: safe, problems: bad });
  return { address: safe, owners, threshold, code_hash: codeHash };
}

/** Like inspectSubmitterSafe, and an address with no code is refused: the submitter must be a Safe. */
export async function assertSubmitterSafe(chain: SubmitterChain, address: Address, forbidden: ReadonlyMap<string, string>): Promise<SubmitterSafeInfo> {
  const info = await inspectSubmitterSafe(chain, address, forbidden);
  if (!info) throw new PublishError("USAGE", `the submitter ${address} has no code: it is a single key. The consensus receipt submitter is a multisig (a SafeL2 1.4.1 proxy with threshold 2 or more). Nothing sent.`, { submitter: address });
  return info;
}

/** The `submitter_safe` evidence block: facts about the Safe, never a key. */
export interface SubmitterSafeEvidence { threshold: number; owners: Address[]; code_hash: Hex }
export const submitterSafeEvidence = (i: SubmitterSafeInfo): SubmitterSafeEvidence => ({ threshold: i.threshold, owners: [...i.owners].sort((a, b) => lc(a).localeCompare(lc(b))), code_hash: i.code_hash });

/** viem public client to the reads above. */
export function chainFromClient(c: { getCode(a: { address: Address }): Promise<Hex | undefined>; getStorageAt(a: { address: Address; slot: Hex }): Promise<Hex | undefined>; readContract(a: never): Promise<unknown> }): SubmitterChain {
  return {
    getCode: (address) => c.getCode({ address }),
    getStorageAt: (address, slot) => c.getStorageAt({ address, slot }),
    read: (address, abi, fn, args = []) => c.readContract({ address, abi, functionName: fn, args } as never) as Promise<never>,
  };
}
