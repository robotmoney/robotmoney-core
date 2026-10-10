// Canonical: docs/architecture.md §4.1 — Vault Family

/**
 * The deposit state of one vault, resolved in one place (issue 1731).
 *
 * Why this exists: the landing cards showed the REGISTRY status ("Active" is `VaultStatus.Active`, 0). The
 * registry is lifecycle state. A vault's own `depositsPaused()` flag is a separate switch (`pauseDeposits()`
 * on the vault, closing only the deposit side), and a vault that is registered Active can have it set. On
 * the Base 8453 rehearsal contracts all four vaults have `depositsPaused() == true` until the four openings
 * execute, and every card still said "Active". A card must never say "Active" while deposits are closed.
 *
 * Sources, in the order they are trusted:
 *   1. the registry status when it already says paused (1) or retired (2),
 *   2. the vault's `depositsPaused()` read from the chain (`chain`): live, so it wins over a stale index,
 *   3. the explorer's `deposits_paused` (`explorer`): the flag as of the latest snapshot the indexer took,
 *   4. nothing known: `unknown`. That is its own state. It is never shown as open.
 *
 * `pauseDeposits()` closes deposits only. Withdraw and redeem stay open in every state (core 1494), which
 * is why no function here looks at them.
 */

import { UNKNOWN, formatUsdcCapString } from "./format";

export const DEPOSITS_PAUSED_ABI = [
  {
    type: "function",
    name: "depositsPaused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** `VaultRegistry.VaultStatus`. */
const REGISTRY_DEPOSITS_PAUSED = 1;
const REGISTRY_RETIRED = 2;

export type DepositState =
  | { readonly kind: "open"; readonly source: "chain" }
  | { readonly kind: "open"; readonly source: "index"; readonly block: number }
  | { readonly kind: "paused"; readonly source: "registry" | "chain" | "explorer" }
  | { readonly kind: "retired" }
  | { readonly kind: "unknown" };

/** The index is stale past this many blocks between the chain head and its last indexed block (about a minute on Base). */
export const EXPLORER_STALE_AFTER_BLOCKS = 30;

export interface DepositStateInput {
  /** The registry (or explorer `status`) value: 0 Active, 1 DepositsPaused, 2 Retired. */
  readonly registryStatus: number;
  /** The explorer's `deposits_paused`; null or undefined when it has no snapshot. */
  readonly explorerPaused?: boolean | null;
  /** The explorer's `block_number`: the block its answer is as of. 0, null or undefined means nothing indexed. */
  readonly explorerBlock?: number | null;
  /** The explorer's `chain_head_block`. */
  readonly explorerHead?: number | null;
  /** The vault's `depositsPaused()` read from the chain; undefined when it could not be read. */
  readonly chainPaused?: boolean;
}

/** Is the explorer's answer provably fresh? An unindexed explorer (block 0 or null) or one far behind the head is not. */
export function explorerFresh(
  block: number | null | undefined,
  head: number | null | undefined,
): boolean {
  if (block == null || block <= 0) return false;
  // Both a block and a KNOWN head are needed to call the index fresh: without a head its lag is unknowable.
  if (head == null || head <= 0) return false;
  return head - block <= EXPLORER_STALE_AFTER_BLOCKS;
}

export function resolveDepositState(input: DepositStateInput): DepositState {
  if (input.registryStatus === REGISTRY_RETIRED) return { kind: "retired" };
  if (input.registryStatus === REGISTRY_DEPOSITS_PAUSED)
    return { kind: "paused", source: "registry" };
  if (input.chainPaused === true) return { kind: "paused", source: "chain" };
  if (input.chainPaused === false) return { kind: "open", source: "chain" };
  // The chain could not be asked (no wallet, wrong chain, failed read). Only the index is left. A pause
  // from the index is trusted at any age (closed is the safe answer); an open from the index counts only
  // while the index is fresh, and is always labelled as index-derived.
  if (input.explorerPaused === true) return { kind: "paused", source: "explorer" };
  if (input.explorerPaused === false && explorerFresh(input.explorerBlock, input.explorerHead)) {
    return { kind: "open", source: "index", block: input.explorerBlock as number };
  }
  return { kind: "unknown" };
}

/** True only when deposits are known to be open. Unknown is not open. */
export const depositsOpen = (s: DepositState): boolean => s.kind === "open";

/** A deposit form is enabled ONLY in the known-open state. Paused, retired and unknown all disable it. */
export const depositsBlocked = (s: DepositState): boolean => s.kind !== "open";

/** The one status label a card, a list row, a detail page or a form shows. "Active" only when deposits are open. */
export function depositStateLabel(s: DepositState): string {
  switch (s.kind) {
    case "open":
      return s.source === "index" ? `Active (per index, block ${s.block})` : "Active";
    case "paused":
      return "Deposits paused / closed";
    case "retired":
      return "Retired";
    case "unknown":
      return "Deposit state unknown";
  }
}

/** Why deposits are closed, for the line under the label. Withdrawals stay open in every state. */
export function depositStateReason(s: DepositState): string | null {
  switch (s.kind) {
    case "open":
      return null;
    case "paused":
      return "New deposits are closed (the vault has deposits paused). Withdraw and redeem stay open.";
    case "retired":
      return "This vault is retired and takes no deposits. Withdraw and redeem stay open.";
    case "unknown":
      return "Deposit state unknown: cannot confirm deposits are open. Deposits stay disabled until they can be confirmed. Withdraw and redeem stay open.";
  }
}

/** The data attribute value tests and styles switch on. */
export const depositStateAttr = (s: DepositState): string => s.kind;

/** Where an open answer came from: `chain` (live read) or `index` (explorer snapshot). Empty for other states. */
export const depositStateSource = (s: DepositState): string => (s.kind === "open" ? s.source : "");

/**
 * The headroom cell (issue 1741). The explorer's `headroom` is `tvlCap - totalAssets` from the vault's latest
 * snapshot. It ignores `perDepositCap`, `depositsPaused`, shutdown and retirement, which the on-chain
 * `maxDeposit` folds in. So it is shown as a number ONLY when deposits are known open. A paused or retired
 * vault reads "n/a (deposits closed)", an unknown deposit state reads "unknown", and an unknown headroom reads
 * "unknown".
 */
export function headroomCell(headroom: string | null | undefined, s: DepositState): string {
  if (s.kind === "paused" || s.kind === "retired") return "n/a (deposits closed)";
  if (s.kind === "unknown") return UNKNOWN;
  return formatUsdcCapString(headroom);
}

/** Label of the headroom figure: it is a snapshot of the TVL cap room, not the next deposit's limit. */
export const HEADROOM_LABEL = "TVL headroom (snapshot)";
