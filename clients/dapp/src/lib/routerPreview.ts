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
 *
 * Each leg's estimated shares print in that leg vault's own `symbol()` (issue
 * 1773, QA plan U5): the caller passes `ctx.shareSymbolOf` from
 * `useVaultShareSymbols`. Without it a leg says the neutral "shares".
 *
 * Unavailable legs (QA plan D4): `PortfolioRouter._depositTo` skips a leg that
 * `previewDeposit` reports unavailable (not Active, not eligible, `maxDeposit`
 * 0 or reverting, a reverting quote) and splits the amount across the rest by
 * their weights. So an unavailable leg no longer means the deposit reverts. The
 * effect says the legs are skipped and lists each leg's renormalized USDC, the
 * `legAmount` the router itself computed. The simulation is the revert gate.
 *
 * Leg pins (security round 2, ADR-0014): the router forwards each leg's USDC into that vault and
 * takes the vault's own `deposit()` return as the shares, so the router's pin alone says nothing
 * about where the USDC ends up. "[bytecode verified]" needs the router AND every leg vault in
 * `ctx.verifiedTargets`, and a leg in `ctx.refusedTargets` (the chain showed it does not match its
 * pins) is named in the preview's `warning` (`refusedRouterLegs`). The write guard refuses that
 * deposit at send time.
 */
import { encodeFunctionData, decodeFunctionData, toFunctionSelector, getAddress } from "viem";
import type { Address, Hex } from "viem";
import { routerAbi, type RouterActionName } from "./abi";
import { targetCodeHashPinned, type Preview, type PreviewContext, type RiskClass } from "./preview";

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
 * `toleranceBps`; an unavailable leg gets a `0n` floor (the router skips that
 * leg and never checks its floor). Floors are ordered identically to `legs`,
 * which the router requires to match `getEffectiveWeights()` order.
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
 * Decide whether the live `getEffectiveWeights()` vault list still matches the
 * preview's leg vault list (AC §7). A mismatch means the deposit would revert
 * (leg ordering or membership changed between preview and submit), so the UI
 * disables submit.
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

/**
 * The leg vaults the chain showed do NOT match their pins (`ctx.refusedTargets`), deduplicated, in
 * the order given. The write guard refuses a router deposit while any leg is one of them.
 */
export function refusedRouterLegs(
  vaults: readonly (string | undefined)[],
  ctx: Pick<PreviewContext, "refusedTargets">,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of vaults) {
    if (typeof v !== "string") continue;
    const key = v.toLowerCase();
    if (seen.has(key) || ctx.refusedTargets?.has(key) !== true) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/** The sentence that names the refused legs of a router deposit. */
export function refusedRouterLegsText(legs: readonly string[]): string {
  return `Leg vault ${legs.join(", ")} does not match this build's pins: its code or the implementation behind it is not a reviewed one (it may have been upgraded). The router would deposit USDC into it, so the dapp will not send this deposit.`;
}

/** Context for a router deposit preview. */
export interface RouterPreviewContext extends PreviewContext {
  router: Address;
  /** Each leg vault's own share symbol (`useVaultShareSymbols`). Absent: "shares". */
  shareSymbolOf?: (vault: string) => string;
}

/** Extended preview with per-leg breakdown exposed for UI rendering. */
export type RouterPreview =
  | (Extract<Preview, { ok: true }> & {
      /** Per-vault leg summary — parallel to the router's weight vector. */
      legs: LegPreview[];
      /** True if any leg is unavailable: the router skips it and renormalizes the rest. */
      hasUnavailable: boolean;
    })
  | Extract<Preview, { ok: false }>;

function classifyRouterRisk(legs: LegPreview[], ctx: RouterPreviewContext): RiskClass {
  if (!ctx.gatewayCodeHashVerified) return "unsafe";
  // A skipped leg that carries weight moves its share onto the other legs: the split is not
  // the governance weights. A skipped 0 bps leg changes nothing.
  if (legs.some((l) => l.unavailable && l.weightBps > 0n)) return "high";
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
      ...(ctx.gatewayRefusalDetail ? { detail: ctx.gatewayRefusalDetail } : {}),
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
      if (l.unavailable) return `${shorten(l.vault)} ${pct} [UNAVAILABLE, skipped: 0 USDC]`;
      const unit = shareSymbolOrNeutral(l.vault ? ctx.shareSymbolOf?.(l.vault) : undefined);
      return `${shorten(l.vault)} ${pct} → ${formatUsdc(l.legAmount)} → ~${formatShares(l.estShares, unit)}`;
    })
    .join("; ");

  const skipped = legs.filter((l) => l.unavailable).length;
  const effect = hasUnavailable
    ? `Unavailable legs are skipped. The router splits ${formatUsdc(amount)} across the ${legs.length - skipped} available vault(s), renormalized by their weights, and skips ${skipped}: ${legSummary}.`
    : `Portfolio Router splits ${formatUsdc(amount)} across ${legs.length} vault(s): ${legSummary}.`;

  // The router's own pin, never the gateway's (QA plan U4), and every leg's: the router passes the
  // USDC on to each leg vault (security round 2).
  const targetCodeHashKnown =
    targetCodeHashPinned(ctx, ctx.router) &&
    legs.every((l) => typeof l.vault === "string" && targetCodeHashPinned(ctx, l.vault));
  const refusedLegs = refusedRouterLegs(
    legs.map((l) => l.vault),
    ctx,
  );

  return {
    ok: true,
    target: ctx.router,
    targetCodeHashKnown,
    ...(refusedLegs.length > 0 ? { warning: refusedRouterLegsText(refusedLegs) } : {}),
    functionName: "deposit",
    selector,
    args: [
      {
        name: "amount",
        raw: amount.toString(),
        gloss: `${formatUsdc(amount)} total split across ${legs.length} vault(s)`,
      },
      {
        name: "minSharesPerLeg",
        raw: `[${minSharesPerLeg.map((s) => s.toString()).join(", ")}]`,
        gloss: `per-leg slippage floor at ${formatPercentFromBps(
          BPS_DENOMINATOR - ROUTER_SLIPPAGE_TOLERANCE_BPS,
        )} of estimated shares (0 for skipped unavailable legs)`,
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
  shareSymbolOrNeutral,
} from "./format";

function formatUsdc(raw: bigint): string {
  return _formatUsdc(raw);
}

/** A leg's estimated shares in that leg vault's own unit, never a literal. */
function formatShares(raw: bigint, unit: string): string {
  return _formatShares(raw, unit);
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
