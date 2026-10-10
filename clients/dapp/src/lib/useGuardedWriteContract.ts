// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * The ONE write path (issue 1729). Every component that sends a transaction uses
 * this hook instead of wagmi's `useWriteContract`; a source-scan test
 * (tests/unit/write-guard-single-path.test.ts) fails if any other module imports
 * the raw hook, so a new write path cannot bypass the guard.
 *
 * On the `mainnet` env class a write is refused unless the connected wallet is on
 * Base (8453), and an allowed write is pinned to that chain id so wagmi itself
 * rejects it if the wallet moved between render and click. Other env classes
 * behave exactly like `useWriteContract`.
 */
import { useAccount, useWriteContract } from "wagmi";
import { useRuntimeConfig } from "./RuntimeConfigContext";
import {
  evaluateWriteGuard,
  isWriteBlocked,
  WrongChainError,
  type WriteGuardState,
} from "./writeChainGuard";

/** Current guard state: shared by the write hook and the wrong-chain screen. */
export function useWriteChainGuard(): { state: WriteGuardState; blocked: boolean } {
  const env = useRuntimeConfig();
  const { chainId, isConnected } = useAccount();
  const state = evaluateWriteGuard(env, isConnected ? chainId : undefined);
  return { state, blocked: isWriteBlocked(state) };
}

export function useGuardedWriteContract() {
  const base = useWriteContract();
  const { state } = useWriteChainGuard();
  const blocked = isWriteBlocked(state);
  const pinned = state.kind === "ok" ? state.targetChainId : undefined;

  type WriteFn = typeof base.writeContract;
  type WriteAsyncFn = typeof base.writeContractAsync;

  const writeContract = ((variables: Parameters<WriteFn>[0], options?: Parameters<WriteFn>[1]) => {
    if (blocked) {
      const err = new WrongChainError(state);
      (options?.onError as ((...a: unknown[]) => void) | undefined)?.(
        err,
        variables,
        undefined,
        undefined,
      );
      return;
    }
    base.writeContract(
      (pinned === undefined ? variables : { ...variables, chainId: pinned }) as never,
      options as never,
    );
  }) as WriteFn;

  const writeContractAsync = ((
    variables: Parameters<WriteAsyncFn>[0],
    options?: Parameters<WriteAsyncFn>[1],
  ) => {
    if (blocked) return Promise.reject(new WrongChainError(state));
    return base.writeContractAsync(
      (pinned === undefined ? variables : { ...variables, chainId: pinned }) as never,
      options as never,
    );
  }) as WriteAsyncFn;

  return { ...base, writeContract, writeContractAsync, writeBlocked: blocked };
}
