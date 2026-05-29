// Canonical: docs/architecture.md §4.2 — Portfolio Router

/**
 * Router deposit preview pipeline (issue #320).
 *
 * Builds a structured preview for a `PortfolioRouter.deposit(amount, [])`
 * call. Mirrors the vault preview shape so the same TxPreview component
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
      reason:
        "Gateway bytecode hash does not match the pinned fixture. Refusing to surface a signing prompt.",
    };
  }

  const functionName: RouterActionName = "deposit";

  let calldata: Hex;
  try {
    calldata = encodeFunctionData({
      abi: routerAbi,
      functionName: "deposit",
      // Pass empty minSharesPerLeg array — no slippage floor; the preview
      // already surfaces unavailable legs before the user signs.
      args: [amount, []],
    });
  } catch (err) {
    return { ok: false, reason: `Encoding failed: ${(err as Error).message}` };
  }

  let selector: Hex;
  try {
    const decoded = decodeFunctionData({ abi: routerAbi, data: calldata });
    if (decoded.functionName !== functionName) {
      return { ok: false, reason: "Decoder mismatch", calldata };
    }
    selector = toFunctionSelector(
      routerAbi.find((e) => e.type === "function" && e.name === functionName) as never,
    );
  } catch (err) {
    return { ok: false, reason: `Decode round-trip failed: ${(err as Error).message}`, calldata };
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
        raw: "[]",
        gloss: "no slippage floor (preview shows estimated shares per leg)",
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

function shorten(addr: string): string {
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
