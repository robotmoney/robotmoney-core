// Canonical: docs/architecture.md §4.1 — Vault Family

/**
 * Vault calldata-preview pipeline. Mirrors the gateway-side `buildPreview`
 * in `preview.ts` but targets the ERC-4626 vault entrypoints used by the
 * Deposit/Withdraw tab (issue #257).
 *
 * Same invariants as the gateway preview:
 *   - decoder failure is a HARD refusal — no raw-calldata-only fallback;
 *   - the structured shape (target, function, decoded args, effect,
 *     risk, raw calldata) is identical so a single TxPreview component
 *     renders it.
 *
 * Risk classification for vault writes is intentionally simple: a
 * `deposit` is `low` (depositor pulls own USDC into shares) and a
 * `redeem` is `low` (burning own shares for USDC, modulo `exitFeeBps`).
 * Unverified bytecode is still `unsafe`, matching the gateway path —
 * the same `PreviewContext` is reused (gatewayCodeHashVerified gates
 * both surfaces because the smoke-test devnet deploys both atomically).
 */
import { decodeFunctionData, encodeFunctionData, getAddress, toFunctionSelector } from "viem";
import type { Address, Hex } from "viem";
import { vaultAbi, type VaultActionName } from "./abi";
import type { Preview, PreviewContext, RiskClass } from "./preview";

export type VaultAction =
  | { kind: "vaultDeposit"; assets: bigint; receiver: Address }
  | { kind: "vaultRedeem"; shares: bigint; receiver: Address; owner: Address };

/** Context for a vault preview — vault address plus the same env/code-hash gate. */
export interface VaultPreviewContext extends PreviewContext {
  vault: Address;
}

export function classifyVaultRisk(_action: VaultAction, ctx: VaultPreviewContext): RiskClass {
  if (!ctx.gatewayCodeHashVerified) return "unsafe";
  // Both deposit and redeem operate on the caller's own funds within
  // the standard ERC-4626 invariants, so we surface them as "low" risk.
  return "low";
}

export function buildVaultPreview(action: VaultAction, ctx: VaultPreviewContext): Preview {
  if (!ctx.gatewayCodeHashVerified) {
    return {
      ok: false,
      reason:
        "Gateway bytecode hash does not match the pinned fixture. Refusing to surface a signing prompt.",
    };
  }

  let calldata: Hex;
  let args: { name: string; raw: string; gloss: string }[];
  let effect: string;
  let functionName: VaultActionName;

  try {
    switch (action.kind) {
      case "vaultDeposit": {
        functionName = "deposit";
        calldata = encodeFunctionData({
          abi: vaultAbi,
          functionName: "deposit",
          args: [action.assets, getAddress(action.receiver)],
        });
        args = [
          {
            name: "assets",
            raw: action.assets.toString(),
            gloss: `${formatUsdc(action.assets)} pulled from caller`,
          },
          {
            name: "receiver",
            raw: action.receiver,
            gloss: `shares -> ${shorten(action.receiver)}`,
          },
        ];
        effect = `Vault pulls ${formatUsdc(action.assets)} USDC from caller and mints rmUSDC shares to ${shorten(action.receiver)}.`;
        break;
      }
      case "vaultRedeem": {
        functionName = "redeem";
        calldata = encodeFunctionData({
          abi: vaultAbi,
          functionName: "redeem",
          args: [action.shares, getAddress(action.receiver), getAddress(action.owner)],
        });
        args = [
          {
            name: "shares",
            raw: action.shares.toString(),
            gloss: `${formatShares(action.shares)} rmUSDC burned`,
          },
          {
            name: "receiver",
            raw: action.receiver,
            gloss: `USDC -> ${shorten(action.receiver)}`,
          },
          {
            name: "owner",
            raw: action.owner,
            gloss: `share owner ${shorten(action.owner)}`,
          },
        ];
        effect = `Vault burns ${formatShares(action.shares)} rmUSDC owned by ${shorten(action.owner)} and credits USDC (net of exitFeeBps) to ${shorten(action.receiver)}.`;
        break;
      }
    }
  } catch (err) {
    return { ok: false, reason: `Encoding failed: ${(err as Error).message}` };
  }

  let selector: Hex;
  try {
    const decoded = decodeFunctionData({ abi: vaultAbi, data: calldata });
    if (decoded.functionName !== functionName) {
      return { ok: false, reason: "Decoder mismatch", calldata };
    }
    selector = toFunctionSelector(
      vaultAbi.find((e) => e.type === "function" && e.name === functionName) as never,
    );
  } catch (err) {
    return { ok: false, reason: `Decode round-trip failed: ${(err as Error).message}`, calldata };
  }

  return {
    ok: true,
    target: ctx.vault,
    targetCodeHashKnown: ctx.gatewayCodeHashVerified,
    functionName,
    selector,
    args,
    effect,
    risk: classifyVaultRisk(action, ctx),
    calldata,
  };
}

function shorten(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

import { formatUsdc as _formatUsdc, formatShares as _formatShares } from "./format";

function formatUsdc(raw: bigint): string {
  return _formatUsdc(raw);
}

/**
 * Vault shares share the underlying's 6-decimal scale plus the
 * ERC-4626 `_decimalsOffset` (see RobotMoneyVault.sol). For preview
 * display we treat shares as 6dp — the absolute precision matters
 * less than the order of magnitude for the operator sanity check.
 */
function formatShares(raw: bigint): string {
  return _formatShares(raw, "rmUSDC");
}
