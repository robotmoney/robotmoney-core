/**
 * React hook — fetch gateway bytecode and derive a VerificationState.
 *
 * Calls the injected EIP-1193 provider (`window.ethereum`) directly for
 * `eth_getCode` so that wallet-side errors surface verbatim, not as
 * cryptic viem retry-circuit-breaker wrappers. Reads still traverse the
 * user's wallet RPC per `docs/security/dapp-topology.md` §2.
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
import type { Hex } from "viem";
import { computeVerificationState, ZERO_ADDRESS } from "./gatewayVerifier";
import type { VerificationState } from "./gatewayVerifier";
import { targetChainId } from "./wagmi";

export { type VerificationState };

interface Eip1193Provider {
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

export function useGatewayVerifier(
  gatewayAddress: string,
  expectedCodeHash: string | undefined,
): UseGatewayVerifier {
  const [state, setState] = useState<VerificationState>(() =>
    computeVerificationState(gatewayAddress, expectedCodeHash, undefined),
  );
  const { isConnected } = useAccount();
  const chainId = useChainId();
  // Bumping this triggers the effect to re-run for a manual retry.
  const [refreshTick, setRefreshTick] = useState(0);
  const cancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  const refresh = useCallback(() => {
    setRefreshTick((n) => n + 1);
  }, []);

  useEffect(() => {
    const initial = computeVerificationState(gatewayAddress, expectedCodeHash, undefined);
    if (initial.status === "refused") {
      setState(initial);
      return;
    }
    if (!gatewayAddress || gatewayAddress === ZERO_ADDRESS || !expectedCodeHash) {
      return;
    }
    if (!isConnected) {
      setState({
        status: "refused",
        reason: "Wallet not connected. Click Connect Wallet to verify gateway bytecode.",
      });
      return;
    }
    if (targetChainId !== undefined && chainId !== targetChainId) {
      setState({
        status: "refused",
        reason: `Wallet is on chain ${chainId}, expected ${targetChainId}.`,
      });
      return;
    }

    const provider = getInjectedProvider();
    if (!provider) {
      setState({
        status: "refused",
        reason: "No injected wallet provider (window.ethereum is undefined).",
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
      let lastError: string | undefined;
      for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
        if (token.cancelled) return;
        if (RETRY_DELAYS_MS[i] > 0) {
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
          if (token.cancelled) return;
        }
        try {
          const code = (await p.request({
            method: "eth_getCode",
            params: [gatewayAddress, "latest"],
          })) as Hex | null | undefined;
          if (token.cancelled) return;
          const resolvedCode: Hex | null =
            code === undefined || code === null || code === "0x" ? null : code;
          setState(computeVerificationState(gatewayAddress, expectedCodeHash, resolvedCode));
          return;
        } catch (err) {
          lastError = (err as { message?: string }).message ?? String(err);
          if (token.cancelled) return;
        }
      }
      if (!token.cancelled) {
        setState({
          status: "refused",
          reason:
            `Wallet returned an error for eth_getCode(${gatewayAddress}) after ` +
            `${RETRY_DELAYS_MS.length} retries: ${lastError ?? "unknown"}`,
        });
      }
    }

    setState({ status: "pending" });
    void attempt(provider);

    return () => {
      token.cancelled = true;
    };
  }, [gatewayAddress, expectedCodeHash, isConnected, chainId, refreshTick]);

  return { state, refresh };
}
