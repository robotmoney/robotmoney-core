// Canonical: docs/architecture.md §5.2 — Agent Permissions Gateway

/**
 * Issue 1840: re-verify the gateway right before each admin write.
 *
 * `useGatewayVerifier` verifies the gateway proxy and its implementation once:
 * on mount, on a chain change and on a manual refresh. A governed upgrade that
 * executes after that is not seen, so an admin write would still be sent on the
 * strength of the cached "verified" state. AdminFlow and AgentsPanel therefore
 * wrap their subtree in `GatewayWriteCheck`. `useGuardedWriteContract`, the one
 * write path, runs the check before the write goes to the wallet: it re-reads
 * the gateway code, the ERC-1967 implementation slot and the implementation's
 * code at the latest block (`verifyGatewayAt`), and refuses with
 * `GatewayChangedError` unless they still match the verified state.
 *
 * Only a verified state is re-checked. When the cached state is not verified,
 * the previews already refuse (`gatewayCodeHashVerified`), so the check adds
 * nothing and passes through.
 */
import { createContext, useCallback, useContext, type ReactNode } from "react";
import type { VerificationState } from "./gatewayVerifier";
import { verifyGatewayAt, type Eip1193Provider } from "./verifyGatewayAt";

/** The gateway changed, or could not be re-read, since it was verified. */
export class GatewayChangedError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to send: the gateway ${reason} since it was verified. Refresh the gateway verification and review the change.`,
    );
    this.name = "GatewayChangedError";
  }
}

type Verified = Extract<VerificationState, { status: "verified" }>;

/**
 * Re-verify `gatewayAddress` at the latest block against `verified`. Resolves
 * when the gateway code, the implementation and its code hash are unchanged;
 * throws `GatewayChangedError` otherwise, and when a read fails.
 */
export async function reverifyGateway(
  provider: Eip1193Provider | undefined,
  gatewayAddress: string,
  verified: Verified,
): Promise<void> {
  if (!provider) throw new GatewayChangedError("could not be re-read (no wallet provider)");
  let now: VerificationState;
  try {
    now = await verifyGatewayAt(provider, gatewayAddress, verified.computedHash, {
      address: verified.implementation ?? undefined,
      hash: verified.implementationCodeHash,
    });
  } catch {
    throw new GatewayChangedError("could not be re-read at the latest block");
  }
  if (now.status !== "verified") {
    const detail = now.status === "refused" && now.detail ? `: ${now.detail}` : "";
    throw new GatewayChangedError(`no longer matches${detail}`);
  }
  const was = verified.implementation?.toLowerCase() ?? null;
  const is = now.implementation?.toLowerCase() ?? null;
  if (was !== is) {
    throw new GatewayChangedError(`implementation is ${is ?? "none"}, not ${was ?? "none"},`);
  }
}

/** Runs before a write goes to the wallet; rejects to refuse it. */
export type GatewayWriteCheckFn = () => Promise<void>;

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
    children: ReactNode;
  }>,
) {
  const { gatewayAddress, verification } = props;
  const check = useCallback(async () => {
    if (verification.status !== "verified") return;
    await reverifyGateway(injectedProvider(), gatewayAddress, verification);
  }, [gatewayAddress, verification]);
  return (
    <GatewayWriteCheckContext.Provider value={check}>
      {props.children}
    </GatewayWriteCheckContext.Provider>
  );
}
