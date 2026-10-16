// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway

/**
 * Read the gateway proxy, its ERC-1967 implementation and the implementation's
 * code at ONE block and verify them (issue 1810). Pure provider reads with no
 * wagmi import, so the write guard can re-run them right before a write
 * (issue 1840, `gatewayWriteCheck.tsx`) and `useGatewayVerifier` runs them on
 * mount.
 */
import { decodeFunctionResult, encodeFunctionData } from "viem";
import type { Address, Hex } from "viem";
import {
  computeGatewayVerification,
  computeVerificationState,
  ERC1967_IMPLEMENTATION_SLOT,
  implementationFromSlot,
} from "./gatewayVerifier";
import type { ImplementationPin, VerificationState } from "./gatewayVerifier";
import { GOVERNED_UUPS_ABI } from "./abi";

export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

/** Normalise an `eth_getCode` answer: `null` when there is no code. */
function codeOrNull(code: unknown): Hex | null {
  return code === undefined || code === null || code === "0x" ? null : (code as Hex);
}

/** `eth_call` of a no-argument view at `block`; `undefined` when the call fails. */
async function callAt(
  p: Eip1193Provider,
  to: string,
  data: Hex,
  block: Hex,
): Promise<Hex | undefined> {
  try {
    return (await p.request({ method: "eth_call", params: [{ to, data }, block] })) as Hex;
  } catch {
    return undefined;
  }
}

/**
 * `upgradesFrozen()` and `upgradeTimelock()` at `block`. Disclosure only: a
 * failed read leaves the field `undefined` and never changes verification.
 */
async function readUpgradeViews(
  p: Eip1193Provider,
  gateway: string,
  block: Hex,
): Promise<{ upgradesFrozen?: boolean; upgradeTimelock?: Address }> {
  const out: { upgradesFrozen?: boolean; upgradeTimelock?: Address } = {};
  const frozen = await callAt(
    p,
    gateway,
    encodeFunctionData({ abi: GOVERNED_UUPS_ABI, functionName: "upgradesFrozen" }),
    block,
  );
  try {
    if (frozen)
      out.upgradesFrozen = decodeFunctionResult({
        abi: GOVERNED_UUPS_ABI,
        functionName: "upgradesFrozen",
        data: frozen,
      });
  } catch {
    // undecodable: leave unknown
  }
  const timelock = await callAt(
    p,
    gateway,
    encodeFunctionData({ abi: GOVERNED_UUPS_ABI, functionName: "upgradeTimelock" }),
    block,
  );
  try {
    if (timelock)
      out.upgradeTimelock = decodeFunctionResult({
        abi: GOVERNED_UUPS_ABI,
        functionName: "upgradeTimelock",
        data: timelock,
      });
  } catch {
    // undecodable: leave unknown
  }
  return out;
}

/**
 * Read everything the verification needs at one block and compute the state.
 * Throws when a read fails, so the caller's retry loop handles it.
 */
export async function verifyGatewayAt(
  p: Eip1193Provider,
  gatewayAddress: string,
  expectedCodeHash: string | undefined,
  pin: ImplementationPin,
): Promise<VerificationState> {
  const block = (await p.request({ method: "eth_blockNumber" })) as Hex;
  const code = codeOrNull(
    await p.request({ method: "eth_getCode", params: [gatewayAddress, block] }),
  );
  const base = computeVerificationState(gatewayAddress, expectedCodeHash, code);
  if (base.status !== "verified") return base;
  const slot = (await p.request({
    method: "eth_getStorageAt",
    params: [gatewayAddress, ERC1967_IMPLEMENTATION_SLOT, block],
  })) as Hex;
  const live = implementationFromSlot(slot);
  const implCode = live
    ? codeOrNull(await p.request({ method: "eth_getCode", params: [live, block] }))
    : undefined;
  const state = computeGatewayVerification(
    gatewayAddress,
    expectedCodeHash,
    code,
    pin,
    slot,
    implCode,
  );
  if (state.status !== "verified" || !live) return state;
  return { ...state, ...(await readUpgradeViews(p, gatewayAddress, block)) };
}
