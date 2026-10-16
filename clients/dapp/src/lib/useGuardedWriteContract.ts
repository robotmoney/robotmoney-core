// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * The ONE write path (issue 1729). Every component that sends a transaction uses
 * this hook instead of wagmi's `useWriteContract`; a source-scan test
 * (tests/unit/write-guard-single-path.test.ts) fails if any other module reaches
 * wagmi/viem write APIs, so a new write path cannot bypass the guard.
 *
 * On the `mainnet` env class a write is refused unless:
 *   1. the connected wallet is on Base (8453), and
 *   2. the target contract has non-empty code on Base (`eth_getCode` through the
 *      connected wallet's provider, which check (1) just established is on 8453),
 *      so an approve or deposit never goes to an address that is empty on the
 *      chain the user is actually on.
 * An allowed write is also pinned to chain 8453. Be precise about what that does:
 * wagmi's `writeContract` passes `assertChainId: false`, so the pin is not itself
 * a chain assertion there. It selects the 8453 client, and viem's
 * `sendTransaction` then compares the wallet's `eth_chainId` with it and throws
 * `ChainMismatchError`. The explicit check in (1) is the guard. The pin is the
 * backstop for a wallet that moved between render and click.
 * Other env classes behave exactly like `useWriteContract`.
 * Every redeem also gets a fixed gas limit (redeemGas.ts, core issue 1758), on every class and path.
 *
 * Inside a `GatewayWriteCheck` (AdminFlow and AgentsPanel, issue 1840), every write
 * first runs the gateway check through the connected wallet's provider, on every
 * env class: an admin write (gateway, Timelock, Safe) is refused unless the
 * gateway is verified and still matches at the latest block, and any write is
 * refused on a mismatch (`GatewayChangedError`).
 */
import { useCallback, useState } from "react";
import { useAccount, useWriteContract } from "wagmi";
import { useRuntimeConfig } from "./RuntimeConfigContext";
import {
  evaluateWriteGuard,
  isWriteBlocked,
  WriteTargetCodeError,
  WrongChainError,
  type WriteGuardState,
} from "./writeChainGuard";
import { withRedeemGasWorkaround } from "./redeemGas";
import { useGatewayWriteCheck } from "./gatewayWriteCheck";

/** Current guard state: shared by the write hook and the wrong-chain screen. */
export function useWriteChainGuard(): { state: WriteGuardState; blocked: boolean } {
  const env = useRuntimeConfig();
  const { chainId, isConnected } = useAccount();
  const state = evaluateWriteGuard(env, isConnected ? chainId : undefined);
  return { state, blocked: isWriteBlocked(state) };
}

/** Targets already seen with code this session. Code does not disappear after Cancun. */
const targetsWithCode = new Set<string>();

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
type CodeSource = { getProvider: () => Promise<unknown> };

async function assertTargetHasCode(source: CodeSource | undefined, address: unknown) {
  if (typeof address !== "string") throw new WriteTargetCodeError(String(address), "is missing");
  const key = address.toLowerCase();
  if (targetsWithCode.has(key)) return;
  let code: unknown;
  try {
    const provider = (await source?.getProvider()) as Eip1193 | undefined;
    if (!provider) throw new Error("no wallet provider");
    code = await provider.request({ method: "eth_getCode", params: [address, "latest"] });
  } catch {
    throw new WriteTargetCodeError(address, "could not be checked for contract code");
  }
  if (typeof code !== "string" || code === "0x" || code === "") {
    throw new WriteTargetCodeError(address, "has no contract code");
  }
  targetsWithCode.add(key);
}

export function useGuardedWriteContract() {
  const base = useWriteContract();
  const { connector, chainId } = useAccount();
  const { state } = useWriteChainGuard();
  const gatewayCheck = useGatewayWriteCheck();
  const [refusal, setRefusal] = useState<Error | null>(null);
  const blocked = isWriteBlocked(state);
  const pinned = state.kind === "ok" ? state.targetChainId : undefined;

  type WriteFn = typeof base.writeContract;
  type WriteAsyncFn = typeof base.writeContractAsync;

  const refuse = useCallback((err: Error, variables: unknown, options: unknown) => {
    setRefusal(err);
    (options as { onError?: (...a: unknown[]) => void } | undefined)?.onError?.(
      err,
      variables,
      undefined,
      undefined,
    );
  }, []);

  const pin = (variables: unknown) =>
    withRedeemGasWorkaround(
      pinned === undefined ? variables : { ...(variables as object), chainId: pinned },
    ) as never;

  /** The asynchronous checks a write must pass before it goes to the wallet. */
  const preflight = async (variables: unknown) => {
    if (pinned !== undefined) {
      await assertTargetHasCode(
        connector as CodeSource | undefined,
        (variables as { address?: unknown }).address,
      );
    }
    if (gatewayCheck) {
      let provider: Eip1193 | undefined;
      try {
        provider = (await (connector as CodeSource | undefined)?.getProvider()) as
          | Eip1193
          | undefined;
      } catch {
        provider = undefined;
      }
      await gatewayCheck({
        target: (variables as { address?: unknown }).address,
        provider,
        chainId,
      });
    }
  };

  const writeContract = ((variables: Parameters<WriteFn>[0], options?: Parameters<WriteFn>[1]) => {
    setRefusal(null);
    if (blocked) {
      refuse(new WrongChainError(state), variables, options);
      return;
    }
    if (pinned === undefined && !gatewayCheck) {
      base.writeContract(withRedeemGasWorkaround(variables) as never, options as never);
      return;
    }
    preflight(variables)
      .then(() => base.writeContract(pin(variables), options as never))
      .catch((e: unknown) => refuse(e as Error, variables, options));
  }) as WriteFn;

  const writeContractAsync = (async (
    variables: Parameters<WriteAsyncFn>[0],
    options?: Parameters<WriteAsyncFn>[1],
  ) => {
    setRefusal(null);
    if (blocked) {
      const err = new WrongChainError(state);
      setRefusal(err);
      throw err;
    }
    try {
      await preflight(variables);
    } catch (e) {
      setRefusal(e as Error);
      throw e;
    }
    return base.writeContractAsync(pin(variables), options as never);
  }) as WriteAsyncFn;

  return {
    ...base,
    writeContract,
    writeContractAsync,
    error: (refusal ?? base.error) as typeof base.error,
    writeBlocked: blocked,
  };
}
