// Canonical: docs/technical/dapp-topology.md §4 — Indexer / explorer is untrusted UI

/**
 * Which addresses the Withdraw tab may sign a `redeem` against (QA plan U4,
 * finding DR-5, issue #1737 part 2).
 *
 * The PositionSelector lists positions from the explorer API, which is
 * display-only: nothing it returns may choose a signing target. A poisoned
 * explorer row could otherwise name an attacker contract as the "vault", and
 * the user would sign a redeem against it. A target is accepted only when it
 * is the vault pinned in the runtime config or a vault the on-chain
 * VaultRegistry lists (`useVaultRegistry()`). The registry list is not filtered
 * by status, so a paused or retired vault stays redeemable (core 1494,
 * ADR-0009).
 */
import type { Address } from "viem";

/** The lower-cased set of accepted redeem targets. */
export function redeemTargetAllowlist(
  registered: readonly { vault: Address }[],
  pinnedVault: Address | undefined,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const r of registered) out.add(r.vault.toLowerCase());
  if (pinnedVault) out.add(pinnedVault.toLowerCase());
  return out;
}

/** `candidate` when the allowlist holds it, else `undefined` (never sign against it). */
export function acceptedRedeemTarget(
  candidate: string | undefined,
  allowlist: ReadonlySet<string>,
): Address | undefined {
  if (typeof candidate !== "string") return undefined;
  return allowlist.has(candidate.toLowerCase()) ? (candidate as Address) : undefined;
}
