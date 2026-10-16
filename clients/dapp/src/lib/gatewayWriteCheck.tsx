// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway

/**
 * Issue 1840: re-verify the gateway right before each admin write.
 *
 * `useGatewayVerifier` verifies the gateway proxy and its implementation once:
 * on mount, on a chain change and on a manual refresh. A governed upgrade that
 * executes after that is not seen, so an admin write would still be sent on the
 * strength of the cached "verified" state. AdminFlow and AgentsPanel therefore
 * wrap their subtree in `GatewayWriteCheck`. `useGuardedWriteContract`, the one
 * write path, and the Safe proposal signature run the check before anything
 * goes to the wallet.
 *
 * - A write to an admin target (the gateway, the Timelock, the Safe) is
 *   refused unless the cached state is verified AND a re-read at the latest
 *   block still matches it: the gateway code, the ERC-1967 implementation slot
 *   and the implementation's code (`verifyGatewayAt`). Fail closed.
 * - Any other write (an approve, a vault or router deposit or withdrawal) is
 *   re-checked the same way while the cached state is verified, and passes
 *   through while it is not. Those flows do not authorize anything on the
 *   gateway, and their previews own their own refusals.
 *
 * The re-read goes through the connected wallet's own provider and first
 * checks that it answers for the connected chain, so another injected wallet
 * on another chain cannot satisfy it.
 */
import { createContext, useCallback, useContext, type ReactNode } from "react";
import type { VerificationState } from "./gatewayVerifier";
import { verifyGatewayAt, type Eip1193Provider } from "./verifyGatewayAt";

/** The gateway is not verified, changed, or could not be re-read. */
export class GatewayChangedError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to send: ${reason}. Re-verify the gateway and review any change before trying again.`,
    );
    this.name = "GatewayChangedError";
  }
}

type Verified = Extract<VerificationState, { status: "verified" }>;

/**
 * Re-verify `gatewayAddress` at the latest block against `verified`. Resolves
 * when the gateway code, the implementation and its code hash are unchanged;
 * throws `GatewayChangedError` otherwise, when a read fails, and when the
 * provider answers for a chain other than `chainId` (when given).
 */
export async function reverifyGateway(
  provider: Eip1193Provider | undefined,
  gatewayAddress: string,
  verified: Verified,
  chainId?: number,
): Promise<void> {
  if (!provider)
    throw new GatewayChangedError("the gateway could not be re-read (no wallet provider)");
  let now: VerificationState;
  try {
    if (chainId !== undefined) {
      const answered = Number(await provider.request({ method: "eth_chainId" }));
      if (answered !== chainId) {
        throw new GatewayChangedError(
          `the wallet provider answers for chain ${answered}, not the connected chain ${chainId}`,
        );
      }
    }
    now = await verifyGatewayAt(provider, gatewayAddress, verified.computedHash, {
      address: verified.implementation ?? undefined,
      hash: verified.implementationCodeHash,
    });
  } catch (e) {
    if (e instanceof GatewayChangedError) throw e;
    throw new GatewayChangedError("the gateway could not be re-read at the latest block");
  }
  if (now.status !== "verified") {
    const detail = now.status === "refused" && now.detail ? `: ${now.detail}` : "";
    throw new GatewayChangedError(`the gateway no longer matches its verification${detail}`);
  }
  const was = verified.implementation?.toLowerCase() ?? null;
  const is = now.implementation?.toLowerCase() ?? null;
  if (was !== is) {
    throw new GatewayChangedError(
      `the gateway implementation is ${is ?? "none"}, not the verified ${was ?? "none"}`,
    );
  }
}

/** What a write is about to do, for the check. */
export interface GatewayWriteRequest {
  /** The contract the write goes to (`variables.address`, or the Safe for a proposal signature). */
  target: unknown;
  /** The connected wallet's provider (`connector.getProvider()`). */
  provider?: Eip1193Provider;
  /** The connected chain. */
  chainId?: number;
}

/** Runs before a write goes to the wallet; rejects to refuse it. */
export type GatewayWriteCheckFn = (request: GatewayWriteRequest) => Promise<void>;

const GatewayWriteCheckContext = createContext<GatewayWriteCheckFn | undefined>(undefined);

/** The check of the nearest `GatewayWriteCheck`, or `undefined` outside one. */
export function useGatewayWriteCheck(): GatewayWriteCheckFn | undefined {
  return useContext(GatewayWriteCheckContext);
}

function injectedProvider(): Eip1193Provider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
}

/** Re-verify the gateway before every write sent from `children`. */
export function GatewayWriteCheck(
  props: Readonly<{
    gatewayAddress: string;
    verification: VerificationState;
    /** Admin targets besides the gateway: the Timelock and the Safe. */
    adminTargets?: ReadonlyArray<string | undefined>;
    children: ReactNode;
  }>,
) {
  const { gatewayAddress, verification, adminTargets } = props;
  const check = useCallback(
    async ({ target, provider, chainId }: GatewayWriteRequest) => {
      const admin = [gatewayAddress, ...(adminTargets ?? [])]
        .filter((a): a is string => typeof a === "string" && a !== "")
        .map((a) => a.toLowerCase());
      const isAdmin = typeof target === "string" && admin.includes(target.toLowerCase());
      if (verification.status !== "verified") {
        if (isAdmin) {
          throw new GatewayChangedError(
            "the gateway is not verified, so no admin write can be sent",
          );
        }
        return;
      }
      await reverifyGateway(provider ?? injectedProvider(), gatewayAddress, verification, chainId);
    },
    [gatewayAddress, verification, adminTargets],
  );
  return (
    <GatewayWriteCheckContext.Provider value={check}>
      {props.children}
    </GatewayWriteCheckContext.Provider>
  );
}
