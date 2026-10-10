// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * The wrong-chain write guard (issue 1729), pure part.
 *
 * On the `mainnet` env class the dapp moves REAL USDC on Base (8453). Reads and
 * writes go through the user's own wallet, and `resolveTargetChainId` returns
 * undefined there (no devnet RPC), so nothing prompts a chain switch. A wallet
 * left on another chain would approve and deposit against the same address
 * there. This module decides, from the env class and the connected chain, whether
 * a write may be sent. `useGuardedWriteContract` is the only hook that applies
 * it, and a source-scan test keeps every other module off wagmi's raw
 * `useWriteContract`.
 */

/** Base mainnet, the only chain a `mainnet`-class dapp may write to. */
export const BASE_MAINNET_CHAIN_ID = 8453;
export const BASE_MAINNET_CHAIN_NAME = "Base";

export type WriteGuardEnv = Readonly<Record<string, string | undefined>>;

/** True when the runtime config says this dapp moves real funds. */
export function isMainnetClass(env: WriteGuardEnv): boolean {
  return env.VITE_ENV_CLASS === "mainnet";
}

/** The chain every write must target, or undefined when the guard does not apply (non-mainnet classes). */
export function resolveWriteTargetChainId(env: WriteGuardEnv): number | undefined {
  return isMainnetClass(env) ? BASE_MAINNET_CHAIN_ID : undefined;
}

export type WriteGuardState =
  | { readonly kind: "not-applicable" }
  | { readonly kind: "ok"; readonly targetChainId: number }
  | {
      readonly kind: "wrong-chain";
      readonly targetChainId: number;
      readonly connectedChainId: number;
    }
  | { readonly kind: "not-connected"; readonly targetChainId: number };

/**
 * Evaluate the guard. `connectedChainId` is the chain of the connected wallet
 * (undefined when no wallet is connected). Strict equality: any other id,
 * including the Robot Money devnet 918453 and Ethereum 1, is blocked.
 */
export function evaluateWriteGuard(
  env: WriteGuardEnv,
  connectedChainId: number | undefined,
): WriteGuardState {
  const targetChainId = resolveWriteTargetChainId(env);
  if (targetChainId === undefined) return { kind: "not-applicable" };
  if (connectedChainId === undefined) return { kind: "not-connected", targetChainId };
  if (connectedChainId !== targetChainId) {
    return { kind: "wrong-chain", targetChainId, connectedChainId };
  }
  return { kind: "ok", targetChainId };
}

/** True when a write must not be sent. */
export function isWriteBlocked(state: WriteGuardState): boolean {
  return state.kind === "wrong-chain" || state.kind === "not-connected";
}

export class WrongChainError extends Error {
  constructor(public readonly guard: WriteGuardState) {
    super(
      guard.kind === "wrong-chain"
        ? `Wrong chain: wallet is on chain ${guard.connectedChainId}. Switch your wallet to Base (chain ${guard.targetChainId}).`
        : `Connect a wallet on Base (chain ${BASE_MAINNET_CHAIN_ID}) to send transactions.`,
    );
    this.name = "WrongChainError";
  }
}

/** The write target has no contract code on Base, or its code could not be read. */
export class WriteTargetCodeError extends Error {
  constructor(
    public readonly target: string,
    reason: string,
  ) {
    super(
      `Refusing to send: the target ${target} on Base (chain ${BASE_MAINNET_CHAIN_ID}) ${reason}.`,
    );
    this.name = "WriteTargetCodeError";
  }
}
