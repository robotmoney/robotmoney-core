// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway

/**
 * Owner-selected deposit destinations for an agent policy (issue 1889).
 *
 * The gateway pins no vault. The depositor's policy `allowedDestinations` is the only
 * destination authority, and it must be non-empty. The dapp never fills it in for the owner:
 * every producer of a policy (Authorize, onboarding, rotation) passes the owner's explicit
 * selection through `depositOnlyPolicy`. The four withdraw members of the tuple are retired and
 * are always written as zero or empty.
 */
import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import type { AgentPolicy } from "./preview";

/** The fields every producer chooses. Destinations are the owner's, never defaulted. */
export interface DepositPolicyInputs {
  validUntil: bigint;
  maxPerPayment: bigint;
  maxPerWindow: bigint;
  shareReceiver: Address;
  /** Owner-selected vaults. Must be non-empty. */
  destinations: readonly string[];
}

/**
 * Normalise a raw selection: checksum each address, drop duplicates (first wins, order kept),
 * and drop anything that is not an address. Never adds an address the owner did not pick.
 */
export function normalizeDestinations(
  raw: readonly string[],
  excluded: readonly string[] = [],
): Address[] {
  const banned = new Set(excluded.map((a) => a.toLowerCase()));
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const r of raw) {
    if (!isAddress(r, { strict: false })) continue;
    const key = r.toLowerCase();
    if (key === zeroAddress || banned.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(getAddress(r));
  }
  return out;
}

/**
 * The policy tuple for a deposit-only agent: the owner's destinations, retired members zero.
 * Throws when the selection is empty, since the gateway reverts an empty list.
 */
export function depositOnlyPolicy(i: DepositPolicyInputs, routerAddress?: string): AgentPolicy {
  const destinations = normalizeDestinations(i.destinations, routerAddress ? [routerAddress] : []);
  if (destinations.length === 0) {
    throw new Error("Select at least one vault the agent may deposit into.");
  }
  return {
    active: true,
    validUntil: i.validUntil,
    maxPerPayment: i.maxPerPayment,
    maxPerWindow: i.maxPerWindow,
    shareReceiver: i.shareReceiver,
    allowedDestinations: destinations,
    assetRecipient: zeroAddress,
    maxWithdrawPerPayment: 0n,
    maxWithdrawPerWindow: 0n,
    allowedSourceVaults: [],
  };
}

/** Null when no vault is selected yet, so a producer shows no preview rather than an invalid one. */
export function tryDepositOnlyPolicy(
  i: DepositPolicyInputs,
  routerAddress?: string,
): AgentPolicy | null {
  try {
    return depositOnlyPolicy(i, routerAddress);
  } catch {
    return null;
  }
}

/**
 * A policy edit (`setPolicy`) that changes caps or expiry but keeps the owner's destinations
 * exactly. Retired members are re-zeroed whatever the old policy held.
 */
export function editPolicy(
  old: AgentPolicy,
  changes: Partial<Pick<AgentPolicy, "validUntil" | "maxPerPayment" | "maxPerWindow">>,
): AgentPolicy {
  return depositOnlyPolicy({
    validUntil: changes.validUntil ?? old.validUntil,
    maxPerPayment: changes.maxPerPayment ?? old.maxPerPayment,
    maxPerWindow: changes.maxPerWindow ?? old.maxPerWindow,
    shareReceiver: old.shareReceiver,
    destinations: old.allowedDestinations,
  });
}

/** The `allowed_destinations` line of the rmpc export: a live key rmpc reads to pre-check the requested vault. */
export function destinationsExportLines(destinations: readonly string[]): string[] {
  const list = normalizeDestinations(destinations);
  if (list.length === 0) return [];
  return [
    `# Vaults the depositor's policy allows this agent to deposit into (allowedDestinations).`,
    `allowed_destinations = [${list.map((d) => JSON.stringify(d)).join(", ")}]`,
  ];
}
