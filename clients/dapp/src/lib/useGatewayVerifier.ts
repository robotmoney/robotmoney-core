// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway

/**
 * React hook — fetch gateway bytecode and derive a VerificationState.
 *
 * Issue 1810: the gateway is an ERC-1967 proxy, so the hook also reads the
 * implementation slot and the implementation's code, all at ONE block
 * (`eth_blockNumber` first), and verifies them against the build-time
 * implementation pin (`computeGatewayVerification`). On a verified proxy it
 * also reads `upgradesFrozen()` and `upgradeTimelock()` for disclosure; those
 * two never decide verification. A read that keeps failing refuses.
 *
 * Calls the injected EIP-1193 provider (`window.ethereum`) directly for
 * `eth_getCode` so that wallet-side errors surface verbatim, not as
 * cryptic viem retry-circuit-breaker wrappers. Reads still traverse the
 * user's wallet RPC per `docs/technical/dapp-topology.md` §2.
 *
 * Auto-retries with exponential backoff (up to 4 attempts spread over
 * ~30 seconds), because MetaMask's per-chain RPC circuit breaker can
 * spuriously trip when a stale RPC URL is stored alongside the live
 * one and rotate-tries it before the live one; the breaker recovers in
 * ~30s, so a single page-load fetch is not enough.
 *
 * Exposes a `refresh` function callers can wire to a manual button.
 */
import { useAccount, useChainId } from "wagmi";
import { useCallback, useEffect, useRef, useState } from "react";
import { decodeFunctionResult, encodeFunctionData } from "viem";
import type { Address, Hex } from "viem";
import {
  computeGatewayVerification,
  computeVerificationState,
  ERC1967_IMPLEMENTATION_SLOT,
  implementationFromSlot,
  ZERO_ADDRESS,
} from "./gatewayVerifier";
import type { ImplementationPin, VerificationState } from "./gatewayVerifier";
import { GOVERNED_UUPS_ABI } from "./abi";
import { resolveTargetChainId } from "./wagmi";
import { useRuntimeConfig } from "./RuntimeConfigContext";

export { type VerificationState };

export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

function getInjectedProvider(): Eip1193Provider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
}

const RETRY_DELAYS_MS = [0, 3000, 8000, 20000];

export interface UseGatewayVerifier {
  state: VerificationState;
  refresh: () => void;
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

export function useGatewayVerifier(
  gatewayAddress: string,
  expectedCodeHash: string | undefined,
  pin: ImplementationPin = {},
): UseGatewayVerifier {
  const pinAddress = pin.address;
  const pinHash = pin.hash;
  const [state, setState] = useState<VerificationState>({ status: "idle" });
  const { isConnected } = useAccount();
  const chainId = useChainId();
  // Issue #1356: the expected chain comes from the runtime config rather than
  // a build-time constant. Absent a provider the config is empty, which means
  // "no devnet configured" — the same as a bundle built without the URL.
  const targetChainId = resolveTargetChainId(useRuntimeConfig());
  // Bumping this triggers the effect to re-run for a manual retry.
  const [refreshTick, setRefreshTick] = useState(0);
  const cancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  const refresh = useCallback(() => {
    setRefreshTick((n) => n + 1);
  }, []);

  useEffect(() => {
    // Suppress all gateway errors until the user has actually connected a
    // wallet. Pre-connect refusals (missing config, wrong chain, etc.)
    // are noise — the user hasn't asked to interact with the gateway yet.
    if (!isConnected) {
      setState({ status: "idle" });
      return;
    }
    const initial = computeVerificationState(gatewayAddress, expectedCodeHash, undefined);
    if (initial.status === "refused") {
      setState(initial);
      return;
    }
    if (!gatewayAddress || gatewayAddress === ZERO_ADDRESS || !expectedCodeHash) {
      return;
    }
    if (targetChainId !== undefined && chainId !== targetChainId) {
      setState({
        status: "refused",
        reason: "unknown_revert",
      });
      return;
    }

    const provider = getInjectedProvider();
    if (!provider) {
      setState({
        status: "refused",
        reason: "unknown_revert",
      });
      return;
    }

    // Replace the previous attempt's cancellation token. Setting
    // .cancelled = true on the OLD token aborts any in-flight retry
    // loop from a previous render before the new one starts.
    cancelRef.current.cancelled = true;
    const token = { cancelled: false };
    cancelRef.current = token;

    async function attempt(p: Eip1193Provider): Promise<void> {
      for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
        if (token.cancelled) return;
        if (RETRY_DELAYS_MS[i] > 0) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
          if (token.cancelled) return;
        }
        try {
          const next = await verifyGatewayAt(p, gatewayAddress, expectedCodeHash, {
            address: pinAddress,
            hash: pinHash,
          });
          if (token.cancelled) return;
          setState(next);
          return;
        } catch (err) {
          void err; // error captured but not forwarded — product reason is always "unknown_revert"
          if (token.cancelled) return;
        }
      }
      if (!token.cancelled) {
        setState({
          status: "refused",
          reason: "unknown_revert",
          detail: "a gateway code or implementation read kept failing",
        });
      }
    }

    setState({ status: "pending" });
    void attempt(provider);

    return () => {
      token.cancelled = true;
    };
  }, [
    gatewayAddress,
    expectedCodeHash,
    pinAddress,
    pinHash,
    isConnected,
    chainId,
    targetChainId,
    refreshTick,
  ]);

  return { state, refresh };
}
