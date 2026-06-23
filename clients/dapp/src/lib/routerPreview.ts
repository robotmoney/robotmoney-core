// Canonical: docs/architecture.md §4.2 — Portfolio Router

/**
 * Router deposit preview pipeline (issue #320).
 *
 * Builds a structured preview for a
 * `PortfolioRouter.deposit(amount, minSharesPerLeg)` call, where the per-leg
 * floors are derived from the preview's estimated shares (DAPP-2, issue #1025).
 * Mirrors the vault preview shape so the same TxPreview component
 * renders it. The per-leg breakdown (weights, estimated shares, unavailable
 * flag) comes from an off-chain call to `router.previewDeposit(amount)`.
 *
 * Same invariants as the vault preview:
 *   - decoder failure is a HARD refusal;
 *   - unverified gateway bytecode → unsafe / refused;
 *   - the structured shape (target, function, decoded args, effect, risk,
 *     raw calldata) is compatible with TxPreview.
 */
import { encodeFunctionData, decodeFunctionData, toFunctionSelector, getAddress } from "viem";
import type { Address, Hex } from "viem";
import { routerAbi, type RouterActionName } from "./abi";
import type { Preview, PreviewContext, RiskClass } from "./preview";

/** Per-vault breakdown returned by PortfolioRouter.previewDeposit. */
export interface LegPreview {
  vault: Address;
  weightBps: bigint;
  legAmount: bigint;
  estShares: bigint;
  unavailable: boolean;
}

/**
 * Default per-leg slippage tolerance, in basis points (0.50%).
 *
 * The router's `deposit(amount, minSharesPerLeg)` reverts a leg whose live
 * `sharesReceived` falls below the supplied floor (docs/technical/
 * portfolio-router-decisions.md §3.3 step 5). We derive each floor from the
 * `previewDeposit` per-leg `estShares`, shaved by this tolerance so ordinary
 * preview-vs-execution drift does not trip the guard while a materially worse
 * fill still reverts.
 */
export const ROUTER_SLIPPAGE_TOLERANCE_BPS = 50n;

const BPS_DENOMINATOR = 10_000n;

/**
 * Derive a non-zero per-leg `minSharesPerLeg` floor array from the preview legs.
 *
 * Each available leg's floor is its `estShares` reduced by
 * `toleranceBps`; an unavailable leg gets a `0n` floor (the contract treats a
 * zero floor as "skip the check", and the deposit already reverts up-front when
 * any leg is unavailable). Floors are ordered identically to `legs`, which the
 * router requires to match `activeVaults()` order.
 *
 * DAPP-2 (issue #1025): replaces the previous empty `[]` floor array that
 * disabled per-leg slippage protection.
 */
export function deriveMinSharesPerLeg(
  legs: readonly LegPreview[],
  toleranceBps: bigint = ROUTER_SLIPPAGE_TOLERANCE_BPS,
): bigint[] {
  return legs.map((leg) => {
    if (leg.unavailable || leg.estShares <= 0n) return 0n;
    // floor = estShares * (10_000 - toleranceBps) / 10_000, rounded down.
    return (leg.estShares * (BPS_DENOMINATOR - toleranceBps)) / BPS_DENOMINATOR;
  });
}

/**
 * Decide whether the live `activeVaults()` list still matches the preview's leg
 * vault list (AC §7). A mismatch means the deposit would revert (leg ordering or
 * membership changed between preview and submit), so the UI disables submit.
 *
 * Null-safety (issue #1036): a leg whose `vault` is undefined — which can occur
 * when `router.previewDeposit` decodes a partial/transition-state tuple in the
 * live router-deposit path — must NOT crash the component. An unresolved leg
 * vault is treated as "list changed" (the safe, submit-disabling outcome) rather
 * than throwing `Cannot read properties of undefined (reading 'toLowerCase')`.
 * Returns a boolean unconditionally.
 */
export function computeVaultListChanged(
  legs: readonly Pick<LegPreview, "vault">[],
  currentActiveVaults: readonly Address[] | undefined,
): boolean {
  if (!currentActiveVaults || legs.length === 0) return false;
  if (currentActiveVaults.length !== legs.length) return true;
  return legs.some((leg, i) => {
    const want = leg.vault?.toLowerCase();
    // An unresolved leg vault can't be confirmed to match → treat as changed.
    if (want === undefined) return true;
    return want !== currentActiveVaults[i]?.toLowerCase();
  });
}

/** Context for a router deposit preview. */
export interface RouterPreviewContext extends PreviewContext {
  router: Address;
}

/** Extended preview with per-leg breakdown exposed for UI rendering. */
export type RouterPreview =
  | (Extract<Preview, { ok: true }> & {
      /** Per-vault leg summary — parallel to the router's weight vector. */
      legs: LegPreview[];
      /** True if any leg is unavailable (will cause tx to revert). */
      hasUnavailable: boolean;
    })
  | Extract<Preview, { ok: false }>;

function classifyRouterRisk(legs: LegPreview[], ctx: RouterPreviewContext): RiskClass {
  if (!ctx.gatewayCodeHashVerified) return "unsafe";
  if (legs.some((l) => l.unavailable)) return "high";
  return "low";
}

/**
 * Build a structured router deposit preview given on-chain leg data.
 *
 * `legs` must come from a live `router.previewDeposit(amount)` call —
 * this function only encodes the write calldata and assembles the preview.
 */
export function buildRouterPreview(
  amount: bigint,
  legs: LegPreview[],
  ctx: RouterPreviewContext,
): RouterPreview {
  if (!ctx.gatewayCodeHashVerified) {
    return {
      ok: false,
      reason: "unknown_revert" as const,
    };
  }

  const functionName: RouterActionName = "deposit";

  // DAPP-2 (issue #1025): derive non-zero per-leg share floors from the
  // preview's estimated shares so the encoded calldata carries real slippage
  // protection instead of a wide-open empty array.
  const minSharesPerLeg = deriveMinSharesPerLeg(legs);

  let calldata: Hex;
  try {
    calldata = encodeFunctionData({
      abi: routerAbi,
      functionName: "deposit",
      args: [amount, minSharesPerLeg],
    });
  } catch {
    return { ok: false, reason: "unknown_revert" as const };
  }

  let selector: Hex;
  try {
    const decoded = decodeFunctionData({ abi: routerAbi, data: calldata });
    if (decoded.functionName !== functionName) {
      return { ok: false, reason: "unknown_revert" as const, calldata };
    }
    selector = toFunctionSelector(
      routerAbi.find((e) => e.type === "function" && e.name === functionName) as never,
    );
  } catch {
    return { ok: false, reason: "unknown_revert" as const, calldata };
  }

  const hasUnavailable = legs.some((l) => l.unavailable);
  const risk = classifyRouterRisk(legs, ctx);

  const legSummary = legs
    .map((l) => {
      const pct = formatPercentFromBps(l.weightBps);
      const tag = l.unavailable ? " [UNAVAILABLE — tx will revert]" : "";
      return `${shorten(l.vault)} ${pct} → ~${formatShares(l.estShares)} shares${tag}`;
    })
    .join("; ");

  const effect = hasUnavailable
    ? `One or more vault legs are unavailable. The router will revert if you sign now. Review the unavailable legs below before proceeding.`
    : `Portfolio Router splits ${formatUsdc(amount)} USDC across ${legs.length} vault(s): ${legSummary}.`;

  return {
    ok: true,
    target: ctx.router,
    targetCodeHashKnown: ctx.gatewayCodeHashVerified,
    functionName: "deposit",
    selector,
    args: [
      {
        name: "amount",
        raw: amount.toString(),
        gloss: `${formatUsdc(amount)} total USDC split across ${legs.length} vault(s)`,
      },
      {
        name: "minSharesPerLeg",
        raw: `[${minSharesPerLeg.map((s) => s.toString()).join(", ")}]`,
        gloss: `per-leg slippage floor at ${formatPercentFromBps(
          BPS_DENOMINATOR - ROUTER_SLIPPAGE_TOLERANCE_BPS,
        )} of estimated shares (0 for unavailable legs)`,
      },
    ],
    effect,
    risk,
    calldata,
    legs,
    hasUnavailable,
  };
}

export function shortenAddr(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function shorten(addr: string | undefined): string {
  // Null-safe (issue #1036): a leg whose `vault` failed to decode must not crash
  // the preview-summary string; render a placeholder instead.
  if (!addr) return "—";
  return shortenAddr(addr);
}

import {
  formatUsdc as _formatUsdc,
  formatShares as _formatShares,
  formatPercent as _formatPercent,
} from "./format";

function formatUsdc(raw: bigint): string {
  return _formatUsdc(raw);
}

function formatShares(raw: bigint): string {
  return _formatShares(raw, "rmUSDC");
}

function formatPercentFromBps(bps: bigint): string {
  return _formatPercent(bps);
}

/** Normalise an address returned from on-chain reads to checksum form. */
export function normaliseAddress(raw: unknown): Address | null {
  if (typeof raw !== "string") return null;
  try {
    return getAddress(raw);
  } catch {
    return null;
  }
}
