// Canonical: docs/architecture.md §4.2 — Portfolio Router

/**
 * Single-vault exit through the Portfolio Router (QA plan D9, finding E8, SR-M16). Pure.
 *
 * `vault.redeem(shares, receiver, owner)` has no minimum-out argument: the holder gets whatever the
 * vault pays at inclusion. `PortfolioRouter.redeemFor` takes a per-leg `minAssetsPerLeg` floor and
 * reverts `SlippageExceeded` below it. So the Withdraw tab redeems a registered vault as the one-leg
 * call `redeemFor(holder, holder, [vault], [shares], [floor], deadline)`.
 *
 * The floor is `previewRedeem(shares)` less `ROUTER_SLIPPAGE_TOLERANCE_BPS` (0.50%), the tolerance the
 * router deposit uses. ERC-4626 has `redeem` pay at least `previewRedeem` in the same block, so the
 * floor binds only on a move between the preview and inclusion: a dragged TWAP on a basket leg (core
 * 1793) or a loss on a lending adapter.
 *
 * The router calls `vault.redeem` as the share spender, so the holder first approves the router for
 * exactly `shares` on the vault's share token, and the redeem spends that allowance to zero. The
 * router's NatSpec forbids a STANDING share approval to it: a party the holder has approved on that
 * token could spend it through `redeemFor`. So the tab approves the exact amount, and it offers a
 * revoke for any allowance a redeem will not spend (`leftoverRouterAllowance`).
 *
 * An exit never depends on the router (core 1494). `chooseRedeemRoute` falls back to a direct
 * `vault.redeem`, with no floor and a visible reason, where the router cannot take the exit: no router
 * is configured, the on-chain registry does not list the vault (`redeemFor` reverts
 * `RedeemVaultNotRegistered`), or a mainnet build has no code-hash pin for the router (the write guard
 * refuses an approval to unpinned code, codePins.ts).
 *
 * The preview encodes the same `{ functionName, args }` the tab simulates and signs
 * (`routerRedeemCall`), so the preview and the signed calldata cannot differ.
 */
import { decodeFunctionData, encodeFunctionData, getAddress, toFunctionSelector } from "viem";
import type { Address, Hex } from "viem";
import { routerAbi } from "./abi";
import { targetCodeHashPinned, type Preview, type PreviewContext } from "./preview";
import { ROUTER_SLIPPAGE_TOLERANCE_BPS } from "./routerPreview";
import { formatPercent, formatShares, formatUsdc, shareSymbolOrNeutral } from "./format";

const BPS_DENOMINATOR = 10_000n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The redeem stays valid for at least this long after it is built, in seconds. */
export const ROUTER_REDEEM_DEADLINE_SECS = 1_800n;
/**
 * The deadline moves in steps of this many seconds. A deadline that changed on every render would
 * change the simulation's arguments on every render and re-run it without end.
 */
const DEADLINE_STEP_SECS = 300n;

/**
 * The `deadline` argument for a redeem built at `nowMs`: the start of the current 5-minute step plus
 * 30 minutes, so between 25 and 30 minutes ahead. The router reverts `DeadlineExpired` after it.
 */
export function routerRedeemDeadline(nowMs: number): bigint {
  const nowSecs = BigInt(Math.floor(nowMs / 1000));
  return nowSecs - (nowSecs % DEADLINE_STEP_SECS) + ROUTER_REDEEM_DEADLINE_SECS;
}

/**
 * The `minAssetsPerLeg` floor for a redeem whose live `previewRedeem(shares)` is `previewAssets`:
 * the preview less `toleranceBps`, rounded down.
 */
export function deriveMinAssets(
  previewAssets: bigint,
  toleranceBps: bigint = ROUTER_SLIPPAGE_TOLERANCE_BPS,
): bigint {
  if (previewAssets <= 0n) return 0n;
  return (previewAssets * (BPS_DENOMINATOR - toleranceBps)) / BPS_DENOMINATOR;
}

/** What a one-leg router redeem needs. `holder` both owns the shares and receives the USDC. */
export interface RouterRedeemInputs {
  vault: Address;
  shares: bigint;
  minAssets: bigint;
  holder: Address;
  deadline: bigint;
}

/** The `{ functionName, args }` the Withdraw tab simulates, previews and signs. */
export function routerRedeemCall(i: RouterRedeemInputs) {
  return {
    functionName: "redeemFor" as const,
    args: [i.holder, i.holder, [i.vault], [i.shares], [i.minAssets], i.deadline] as const,
  };
}

/** Context for a router redeem preview. */
export interface RouterRedeemPreviewContext extends PreviewContext {
  router: Address;
  /** The redeemed vault's own share symbol (`useVaultShareSymbols`). Absent: "shares". */
  shareSymbol?: string;
}

/** Build the structured preview of the one-leg `redeemFor` the Withdraw tab signs. */
export function buildRouterRedeemPreview(
  i: RouterRedeemInputs,
  ctx: RouterRedeemPreviewContext,
): Preview {
  if (!ctx.gatewayCodeHashVerified) {
    return {
      ok: false,
      reason: "unknown_revert" as const,
      ...(ctx.gatewayRefusalDetail ? { detail: ctx.gatewayRefusalDetail } : {}),
    };
  }

  const call = routerRedeemCall(i);
  let calldata: Hex;
  try {
    calldata = encodeFunctionData({ abi: routerAbi, ...call });
  } catch {
    return { ok: false, reason: "unknown_revert" as const };
  }

  let selector: Hex;
  try {
    const decoded = decodeFunctionData({ abi: routerAbi, data: calldata });
    if (decoded.functionName !== call.functionName) {
      return { ok: false, reason: "unknown_revert" as const, calldata };
    }
    selector = toFunctionSelector(
      routerAbi.find((e) => e.type === "function" && e.name === call.functionName) as never,
    );
  } catch {
    return { ok: false, reason: "unknown_revert" as const, calldata };
  }

  const unit = shareSymbolOrNeutral(ctx.shareSymbol);
  const holder = getAddress(i.holder);
  const floorGloss =
    i.minAssets > 0n
      ? `at least ${formatUsdc(i.minAssets)}: previewRedeem less ${formatPercent(ROUTER_SLIPPAGE_TOLERANCE_BPS)}`
      : "no floor: the redeem pays whatever the vault pays";

  return {
    ok: true,
    target: ctx.router,
    // The router's own pin, never the gateway's (QA plan U4).
    targetCodeHashKnown: targetCodeHashPinned(ctx, ctx.router),
    functionName: call.functionName,
    selector,
    args: [
      { name: "shareHolder", raw: holder, gloss: `share owner ${shorten(holder)}` },
      { name: "assetRecipient", raw: holder, gloss: `USDC -> ${shorten(holder)}` },
      { name: "vaults", raw: `[${i.vault}]`, gloss: `one leg: vault ${shorten(i.vault)}` },
      {
        name: "sharesPerLeg",
        raw: `[${i.shares.toString()}]`,
        gloss: `${formatShares(i.shares, unit)} burned`,
      },
      { name: "minAssetsPerLeg", raw: `[${i.minAssets.toString()}]`, gloss: floorGloss },
      {
        name: "deadline",
        raw: i.deadline.toString(),
        gloss: "the router reverts DeadlineExpired after this unix time",
      },
    ],
    effect:
      i.minAssets > 0n
        ? `The router redeems ${formatShares(i.shares, unit)} of vault ${shorten(i.vault)} owned by ${shorten(holder)} and sends the USDC (net of exitFeeBps) to ${shorten(holder)}. It reverts unless the vault pays at least ${formatUsdc(i.minAssets)}.`
        : `The router redeems ${formatShares(i.shares, unit)} of vault ${shorten(i.vault)} owned by ${shorten(holder)} and sends the USDC (net of exitFeeBps) to ${shorten(holder)}, with no minimum.`,
    // The holder burns their own shares for USDC to themselves, as a direct redeem does.
    risk: "low",
    calldata,
  };
}

/** Why a redeem calls the vault directly instead of the router. */
export type DirectRedeemReason = "no-router" | "unregistered" | "router-unpinned";

/** Which contract the Withdraw tab signs the redeem against. */
export type RedeemRoute =
  | { kind: "router"; router: Address }
  | { kind: "direct"; reason: DirectRedeemReason }
  /** The registry list is still loading: nothing is simulated or signed yet. */
  | { kind: "pending" };

export interface RedeemRouteInputs {
  /** The configured router, if any. The zero address is "no router". */
  router: Address | undefined;
  /** The accepted redeem target (`redeemTarget.ts`). */
  vault: Address | undefined;
  /** The vaults the on-chain registry lists (`useVaultRegistry`). */
  registered: readonly { vault: Address }[];
  registryLoading: boolean;
  /** True on the mainnet class when the build carries no code-hash pin for the router. */
  routerUnpinned: boolean;
}

/** Route the redeem through the router when it can take it, else straight to the vault. */
export function chooseRedeemRoute(i: RedeemRouteInputs): RedeemRoute {
  if (i.router === undefined || i.router.toLowerCase() === ZERO_ADDRESS) {
    return { kind: "direct", reason: "no-router" };
  }
  if (i.routerUnpinned) return { kind: "direct", reason: "router-unpinned" };
  if (i.vault === undefined) return { kind: "router", router: i.router };
  const vault = i.vault.toLowerCase();
  if (i.registered.some((r) => r.vault.toLowerCase() === vault)) {
    return { kind: "router", router: i.router };
  }
  if (i.registryLoading) return { kind: "pending" };
  return { kind: "direct", reason: "unregistered" };
}

/** Why the tab redeems directly, in one sentence for the user. */
export function directRedeemReasonText(reason: DirectRedeemReason): string {
  switch (reason) {
    case "no-router":
      return "no Portfolio Router is configured for this deployment";
    case "unregistered":
      return "the on-chain VaultRegistry does not list this vault, so the router cannot redeem it";
    case "router-unpinned":
      return "this build carries no code-hash pin for the router, so the dapp will not approve shares to it";
  }
}

/** True when the router's share allowance does not cover `shares` (unknown counts as not covered). */
export function needsShareApproval(allowance: unknown, shares: bigint): boolean {
  return typeof allowance !== "bigint" || allowance < shares;
}

/**
 * True when the router holds a share allowance that the next redeem will not spend in full: the
 * standing approval the router's NatSpec forbids. A redeem of `shares` spends exactly `shares`.
 * `shares` null means no amount is entered.
 */
export function leftoverRouterAllowance(allowance: unknown, shares: bigint | null): boolean {
  if (typeof allowance !== "bigint" || allowance === 0n) return false;
  return shares === null || allowance > shares;
}

function shorten(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}
