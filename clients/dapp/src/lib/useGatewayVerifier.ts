/**
 * React hook — fetch gateway bytecode through the wagmi/viem client
 * and derive a VerificationState using the pure computeVerificationState
 * function from gatewayVerifier.ts.
 *
 * The hook runs once per mount (wagmi caches the RPC response). It does
 * NOT poll — the operator must reload the page to re-verify. This keeps
 * the verification model simple: the pinned hash must match or writes
 * are refused, with no background re-check window that could be raced.
 */
import { usePublicClient } from "wagmi";
import { getBytecode } from "viem/actions";
import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import { computeVerificationState, ZERO_ADDRESS } from "./gatewayVerifier";
import type { VerificationState } from "./gatewayVerifier";

export { type VerificationState };

/**
 * Returns the current VerificationState for the gateway contract.
 *
 * @param gatewayAddress   On-chain address of the gateway contract.
 * @param expectedCodeHash Operator-pinned runtime bytecode hash
 *                         (`VITE_GATEWAY_EXPECTED_CODE_HASH`). Pass
 *                         empty string / undefined when the env var is
 *                         absent — the hook will immediately return a
 *                         refused state without making an RPC call.
 * @param bypassForTest    When true, skip all verification and return
 *                         `verified` immediately. Set only via
 *                         `VITE_GATEWAY_VERIFY_BYPASS_FOR_TEST=true`
 *                         in E2E test builds; never in production.
 */
export function useGatewayVerifier(
  gatewayAddress: string,
  expectedCodeHash: string | undefined,
  bypassForTest = false,
): VerificationState {
  const [state, setState] = useState<VerificationState>(() =>
    computeVerificationState(gatewayAddress, expectedCodeHash, undefined, bypassForTest),
  );

  // Obtain the viem PublicClient from the wagmi context so we can call
  // getBytecode directly (useReadContract does not expose eth_getCode).
  const client = usePublicClient();

  useEffect(() => {
    // Test-only bypass: initial state is already verified; no RPC call needed.
    if (bypassForTest) {
      return;
    }

    // If the initial state is already refused (missing expected hash or
    // zero address) there is nothing to fetch.
    const initial = computeVerificationState(gatewayAddress, expectedCodeHash, undefined);
    if (initial.status === "refused") {
      setState(initial);
      return;
    }

    let cancelled = false;

    async function verify() {
      if (!client) return;
      try {
        const code = await getBytecode(client, {
          address: gatewayAddress as Address,
        });
        if (!cancelled) {
          // getBytecode returns undefined when no code at address.
          const resolvedCode: Hex | null = code === undefined ? null : (code as Hex);
          setState(computeVerificationState(gatewayAddress, expectedCodeHash, resolvedCode));
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            status: "refused",
            reason: `Failed to fetch gateway bytecode: ${(err as Error).message}`,
          });
        }
      }
    }

    // Only run when we have a real gateway address and expected hash.
    if (gatewayAddress && gatewayAddress !== ZERO_ADDRESS && expectedCodeHash && client) {
      void verify();
    }

    return () => {
      cancelled = true;
    };
  }, [gatewayAddress, expectedCodeHash, client, bypassForTest]);

  return state;
}
