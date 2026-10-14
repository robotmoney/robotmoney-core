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
 *      chain the user is actually on, and
 *   3. for a deposit or an approve, keccak256 of the code of the contract that
 *      receives the USDC (deposit target) or the allowance (approve spender)
 *      equals its build-time pin (codePins.ts, QA plan U5, issue 1737). A missing
 *      pin, unreadable code, no code and a different hash each refuse with a
 *      `WriteTargetPinError` naming the cause, and nothing reaches the wallet.
 *      A redeem needs no pin: nothing is paid or approved to its target.
 * An allowed write is also pinned to chain 8453. Be precise about what that does:
 * wagmi's `writeContract` passes `assertChainId: false`, so the pin is not itself
 * a chain assertion there. It selects the 8453 client, and viem's
 * `sendTransaction` then compares the wallet's `eth_chainId` with it and throws
 * `ChainMismatchError`. The explicit check in (1) is the guard. The pin is the
 * backstop for a wallet that moved between render and click.
 * Other env classes behave exactly like `useWriteContract`.
 * A redeem of a RobotMoneyVault (rmUSDC) also gets a fixed gas limit (redeemGas.ts, core issue 1758),
 * on every class and path. A basket vault redeem does not: it needs more than that limit (QA plan U3).
 */
import { useCallback, useMemo, useState } from "react";
import { useAccount, useWriteContract } from "wagmi";
import { useRuntimeConfig } from "./RuntimeConfigContext";
import {
  evaluateWriteGuard,
  isWriteBlocked,
  WriteTargetCodeError,
  WrongChainError,
  type WriteGuardState,
} from "./writeChainGuard";
import { robotMoneyVaultTargets, withRedeemGasWorkaround } from "./redeemGas";
import {
  checkCodePin,
  parseCodePins,
  pinnedWriteTarget,
  WriteTargetPinError,
  type CodePins,
} from "./codePins";

/** Current guard state: shared by the write hook and the wrong-chain screen. */
export function useWriteChainGuard(): { state: WriteGuardState; blocked: boolean } {
  const env = useRuntimeConfig();
  const { chainId, isConnected } = useAccount();
  const state = evaluateWriteGuard(env, isConnected ? chainId : undefined);
  return { state, blocked: isWriteBlocked(state) };
}

/** Targets already seen with code this session. Code does not disappear after Cancun. */
const targetsWithCode = new Set<string>();
/**
 * `address:pin` pairs whose code matched the pin this session. Keyed by both, so a bundle
 * with another pin for the same address checks again.
 */
const pinsMatched = new Set<string>();

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
type CodeSource = { getProvider: () => Promise<unknown> };

/** `eth_getCode` through the connected wallet (on Base: check (1) ran first). Throws when unreadable. */
async function readCode(source: CodeSource | undefined, address: string): Promise<unknown> {
  const provider = (await source?.getProvider()) as Eip1193 | undefined;
  if (!provider) throw new Error("no wallet provider");
  return provider.request({ method: "eth_getCode", params: [address, "latest"] });
}

async function assertTargetHasCode(source: CodeSource | undefined, address: unknown) {
  if (typeof address !== "string") throw new WriteTargetCodeError(String(address), "is missing");
  const key = address.toLowerCase();
  if (targetsWithCode.has(key)) return;
  let code: unknown;
  try {
    code = await readCode(source, address);
  } catch {
    throw new WriteTargetCodeError(address, "could not be checked for contract code");
  }
  if (typeof code !== "string" || code === "0x" || code === "") {
    throw new WriteTargetCodeError(address, "has no contract code");
  }
  targetsWithCode.add(key);
}

/** Check (3): a deposit or approve sends funds or an allowance only to code that matches its pin. */
async function assertTargetPinned(
  source: CodeSource | undefined,
  variables: unknown,
  pins: CodePins,
) {
  const target = pinnedWriteTarget(variables);
  if (target === undefined) return;
  const pin = pins.get(target.toLowerCase());
  if (pin === undefined) throw new WriteTargetPinError(target, "pin-missing");
  const key = `${target.toLowerCase()}:${pin}`;
  if (pinsMatched.has(key)) return;
  let code: unknown;
  try {
    code = await readCode(source, target);
  } catch {
    throw new WriteTargetPinError(target, "code-unreadable");
  }
  const result = checkCodePin(target, code, pins);
  if (!result.ok) throw new WriteTargetPinError(target, result.cause, result.got);
  pinsMatched.add(key);
}

/** Checks (2) and (3), in that order, for a write already past the chain check. */
async function assertWriteTarget(
  source: CodeSource | undefined,
  variables: unknown,
  pins: CodePins,
) {
  await assertTargetHasCode(source, (variables as { address?: unknown }).address);
  await assertTargetPinned(source, variables, pins);
}

export function useGuardedWriteContract() {
  const base = useWriteContract();
  const { connector } = useAccount();
  const { state } = useWriteChainGuard();
  const env = useRuntimeConfig();
  const robotMoneyVaults = useMemo(() => robotMoneyVaultTargets(env), [env]);
  const codePins = useMemo(() => parseCodePins(env), [env]);
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
      robotMoneyVaults,
    ) as never;

  const writeContract = ((variables: Parameters<WriteFn>[0], options?: Parameters<WriteFn>[1]) => {
    setRefusal(null);
    if (blocked) {
      refuse(new WrongChainError(state), variables, options);
      return;
    }
    if (pinned === undefined) {
      base.writeContract(
        withRedeemGasWorkaround(variables, robotMoneyVaults) as never,
        options as never,
      );
      return;
    }
    assertWriteTarget(connector as CodeSource | undefined, variables, codePins)
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
    if (pinned !== undefined) {
      try {
        await assertWriteTarget(connector as CodeSource | undefined, variables, codePins);
      } catch (e) {
        setRefusal(e as Error);
        throw e;
      }
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
