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
  | { readonly kind: "open" }
  | { readonly kind: "paused"; readonly source: "registry" | "chain" | "explorer" }
  | { readonly kind: "retired" }
  | { readonly kind: "unknown" };

export interface DepositStateInput {
  /** The registry (or explorer `status`) value: 0 Active, 1 DepositsPaused, 2 Retired. */
  readonly registryStatus: number;
  /** The explorer's `deposits_paused`; null or undefined when it has no snapshot. */
  readonly explorerPaused?: boolean | null;
  /** The vault's `depositsPaused()` read from the chain; undefined when it could not be read. */
  readonly chainPaused?: boolean;
}

export function resolveDepositState(input: DepositStateInput): DepositState {
  if (input.registryStatus === REGISTRY_RETIRED) return { kind: "retired" };
  if (input.registryStatus === REGISTRY_DEPOSITS_PAUSED)
    return { kind: "paused", source: "registry" };
  if (input.chainPaused === true) return { kind: "paused", source: "chain" };
  if (input.chainPaused === false) return { kind: "open" };
  if (input.explorerPaused === true) return { kind: "paused", source: "explorer" };
  if (input.explorerPaused === false) return { kind: "open" };
  return { kind: "unknown" };
}

/** True only when deposits are known to be open. Unknown is not open. */
export const depositsOpen = (s: DepositState): boolean => s.kind === "open";

/** Deposits are known to be closed. A form disables its deposit button on this. Unknown only warns: the simulation still refuses a deposit the contract rejects. */
export const depositsBlocked = (s: DepositState): boolean =>
  s.kind === "paused" || s.kind === "retired";

/** The one status label a card, a list row, a detail page or a form shows. "Active" only when deposits are open. */
export function depositStateLabel(s: DepositState): string {
  switch (s.kind) {
    case "open":
      return "Active";
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
      return "The dapp could not read whether deposits are open. Treat deposits as closed until it can.";
  }
}

/** The data attribute value tests and styles switch on. */
export const depositStateAttr = (s: DepositState): string => s.kind;
