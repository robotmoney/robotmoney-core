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
 *      equals its build-time pin (codePins.ts, QA plan U5, issue 1737), and so
 *      does every write to the gateway. A missing pin, unreadable code, no code
 *      and a different hash each refuse with a `WriteTargetPinError` naming the
 *      cause, and nothing reaches the wallet. A redeem needs no pin: nothing is
 *      paid or approved to its target. Neither does an approve of zero.
 *   4. behind an ERC-1967 proxy (ADR-0014) the code at the address is the
 *      generic `ERC1967Proxy`, so check (3) alone would pass any implementation
 *      the timelock installs. The guard also reads the implementation slot and
 *      the implementation's code, at the same block as the code, and refuses
 *      unless that implementation's code hash is a reviewed pin the build
 *      carries (`verifyPinnedTarget`). Nothing is cached: every send reads
 *      again, so an upgrade between two sends is caught on the second.
 *   5. a deposit into the Portfolio Router also reads `getEffectiveWeights()`
 *      at that same block and runs checks (3) and (4) on every leg vault, as
 *      rmpc `verify_router_and_legs` does. The router forwards each leg's USDC
 *      into that vault and takes the vault's own `deposit()` return as the
 *      shares minted, so a leg upgraded to unreviewed logic could keep the
 *      USDC behind a pinned router. The refusal names the leg; a failed
 *      weights read refuses too (security round 2).
 * An allowed write is also pinned to chain 8453. Be precise about what that does:
 * wagmi's `writeContract` passes `assertChainId: false`, so the pin is not itself
 * a chain assertion there. It selects the 8453 client, and viem's
 * `sendTransaction` then compares the wallet's `eth_chainId` with it and throws
 * `ChainMismatchError`. The explicit check in (1) is the guard. The pin is the
 * backstop for a wallet that moved between render and click.
 * Other env classes behave exactly like `useWriteContract`.
 * A redeem of a RobotMoneyVault (rmUSDC) also gets a fixed gas limit (redeemGas.ts, core issue 1758),
 * on every class and path. A basket vault redeem does not: it needs more than that limit (QA plan U3).
 *
 * Inside a `GatewayWriteCheck` (AdminFlow and AgentsPanel, issue 1840), a gateway
 * operation first runs the gateway check through the connected wallet's provider: a write
 * to the gateway, or a Timelock schedule or execute whose target is the gateway, is refused
 * unless the gateway is verified and still matches at the latest block (`GatewayChangedError`).
 * A vaults-system write (vault, router, token, Timelock, Safe) makes no gateway read (issue 1892).
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
import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import {
  isRouterDeposit,
  parseCodePins,
  parseImplementationAddressPins,
  parseImplementationPinMap,
  pinnedWriteTarget,
  verifyPinnedTarget,
  WriteTargetPinError,
  type CodePins,
  type ImplementationAddressPins,
  type ImplementationPins,
  type PinnedTargetReads,
} from "./codePins";
import { routerAbi } from "./abi";
import { ERC1967_IMPLEMENTATION_SLOT, implementationFromSlot } from "./gatewayVerifier";
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
// No cache for checks (3) to (5): the implementation behind a proxy, and the router's legs, can
// change between two sends, so a pinned target is read again before every one.

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
type CodeSource = { getProvider: () => Promise<unknown> };

/** `eth_getCode` through the connected wallet (on Base: check (1) ran first). Throws when unreadable. */
async function readCode(source: CodeSource | undefined, address: string): Promise<unknown> {
  const provider = await walletProvider(source);
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

/** The connected wallet's EIP-1193 provider (on Base: check (1) ran first). Throws when none. */
async function walletProvider(source: CodeSource | undefined): Promise<Eip1193> {
  const provider = (await source?.getProvider()) as Eip1193 | undefined;
  if (!provider) throw new Error("no wallet provider");
  return provider;
}

/** The block every read of one pin check is made at. Throws when it cannot be read. */
async function readBlock(provider: Eip1193): Promise<string> {
  const block = await provider.request({ method: "eth_blockNumber" });
  if (typeof block !== "string" || !/^0x[0-9a-fA-F]+$/.test(block)) {
    throw new Error("no block number");
  }
  return block;
}

/**
 * The code, the ERC-1967 implementation slot and the implementation's code of `target`, all at
 * `block`, through the connected wallet. A failed code read throws (`code-unreadable`); a failed
 * slot or implementation read comes back as `undefined` (`implementation-unreadable`).
 */
async function readPinnedTarget(
  provider: Eip1193,
  target: string,
  block: string,
): Promise<PinnedTargetReads> {
  const code = await provider.request({ method: "eth_getCode", params: [target, block] });
  let slot: unknown;
  try {
    slot = await provider.request({
      method: "eth_getStorageAt",
      params: [target, ERC1967_IMPLEMENTATION_SLOT, block],
    });
  } catch {
    return { code, slot: undefined, implementationCode: undefined };
  }
  let implementation: string | null | undefined;
  try {
    implementation =
      typeof slot === "string" && /^0x[0-9a-fA-F]{0,64}$/.test(slot)
        ? implementationFromSlot(slot as `0x${string}`)
        : null;
  } catch {
    return { code, slot: undefined, implementationCode: undefined };
  }
  // undefined: the slot word is not an address; checkImplementationPin refuses it.
  if (implementation === null || implementation === undefined) {
    return { code, slot, implementationCode: null };
  }
  let implementationCode: unknown;
  try {
    implementationCode = await provider.request({
      method: "eth_getCode",
      params: [implementation, block],
    });
  } catch {
    implementationCode = undefined;
  }
  return { code, slot, implementationCode };
}

/** The vaults of `router.getEffectiveWeights()` at `block`. Throws on a failed or bad answer. */
async function readRouterLegs(
  provider: Eip1193,
  router: string,
  block: string,
): Promise<readonly string[]> {
  const data = encodeFunctionData({ abi: routerAbi, functionName: "getEffectiveWeights" });
  const out = await provider.request({ method: "eth_call", params: [{ to: router, data }, block] });
  if (typeof out !== "string" || !/^0x[0-9a-fA-F]*$/.test(out)) throw new Error("no weights");
  const [vaults] = decodeFunctionResult({
    abi: routerAbi,
    functionName: "getEffectiveWeights",
    data: out as Hex,
  });
  return vaults;
}

/**
 * Check (5): every vault the router would deposit into passes checks (3) and (4) at `block`, the
 * block the router itself was checked at. A 0 bps leg is checked too, as rmpc does.
 */
async function assertRouterLegsPinned(
  provider: Eip1193,
  router: string,
  block: string,
  pins: CodePins,
  implementationPins: ImplementationPins,
) {
  let legs: readonly string[];
  try {
    legs = await readRouterLegs(provider, router, block);
  } catch {
    throw new WriteTargetPinError(router, "router-legs-unreadable");
  }
  const seen = new Set<string>();
  for (const leg of legs) {
    const key = leg.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!pins.has(key)) throw new WriteTargetPinError(leg, "pin-missing", undefined, router);
    let reads: PinnedTargetReads;
    try {
      reads = await readPinnedTarget(provider, leg, block);
    } catch {
      throw new WriteTargetPinError(leg, "code-unreadable", undefined, router);
    }
    const result = verifyPinnedTarget(leg, reads, pins, implementationPins);
    if (!result.ok) throw new WriteTargetPinError(leg, result.cause, result.got, router);
  }
}

/**
 * Checks (3), (4) and (5): a deposit or approve sends funds or an allowance, and a gateway write
 * sends its call, only to code that matches its pin, behind which runs a pinned implementation. A
 * router deposit also needs every leg vault to pass.
 */
async function assertTargetPinned(
  source: CodeSource | undefined,
  variables: unknown,
  pins: CodePins,
  implementationPins: ImplementationPins,
  implementationAddressPins: ImplementationAddressPins,
  gateway: string | undefined,
  router: string | undefined,
) {
  const target = pinnedWriteTarget(variables, gateway);
  if (target === undefined) return;
  if (!pins.has(target.toLowerCase())) throw new WriteTargetPinError(target, "pin-missing");
  let provider: Eip1193;
  let block: string;
  let reads: PinnedTargetReads;
  try {
    provider = await walletProvider(source);
    block = await readBlock(provider);
    reads = await readPinnedTarget(provider, target, block);
  } catch {
    throw new WriteTargetPinError(target, "code-unreadable");
  }
  const result = verifyPinnedTarget(
    target,
    reads,
    pins,
    implementationPins,
    implementationAddressPins,
  );
  if (!result.ok) throw new WriteTargetPinError(target, result.cause, result.got);
  if (isRouterDeposit(variables, router)) {
    await assertRouterLegsPinned(provider, target, block, pins, implementationPins);
  }
}

/** Checks (2) to (5), in that order, for a write already past the chain check. */
async function assertWriteTarget(
  source: CodeSource | undefined,
  variables: unknown,
  pins: CodePins,
  implementationPins: ImplementationPins,
  implementationAddressPins: ImplementationAddressPins,
  gateway: string | undefined,
  router: string | undefined,
) {
  await assertTargetHasCode(source, (variables as { address?: unknown }).address);
  await assertTargetPinned(
    source,
    variables,
    pins,
    implementationPins,
    implementationAddressPins,
    gateway,
    router,
  );
}

/** The target a Timelock `schedule` or `execute` forwards to (`args[0]`), or undefined for any other write. */
function nestedTargetOf(variables: unknown): unknown {
  const v = variables as { functionName?: unknown; args?: unknown };
  if (v.functionName !== "schedule" && v.functionName !== "execute") return undefined;
  return Array.isArray(v.args) ? v.args[0] : undefined;
}

export function useGuardedWriteContract() {
  const base = useWriteContract();
  const { connector, chainId } = useAccount();
  const { state } = useWriteChainGuard();
  const env = useRuntimeConfig();
  const robotMoneyVaults = useMemo(() => robotMoneyVaultTargets(env), [env]);
  const codePins = useMemo(() => parseCodePins(env), [env]);
  const implementationPins = useMemo(() => parseImplementationPinMap(env), [env]);
  const implementationAddressPins = useMemo(() => parseImplementationAddressPins(env), [env]);
  const gateway = env.VITE_GATEWAY_ADDRESS;
  const router = env.VITE_ROUTER_ADDRESS;
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
      robotMoneyVaults,
    ) as never;

  /** The asynchronous checks a write must pass before it goes to the wallet. */
  const preflight = async (variables: unknown) => {
    if (pinned !== undefined) {
      await assertWriteTarget(
        connector as CodeSource | undefined,
        variables,
        codePins,
        implementationPins,
        implementationAddressPins,
        gateway,
        router,
      );
    }
    if (gatewayCheck) {
      let provider: Eip1193 | undefined;
      try {
        provider = await walletProvider(connector as CodeSource | undefined);
      } catch {
        provider = undefined;
      }
      await gatewayCheck({
        target: (variables as { address?: unknown }).address,
        nestedTarget: nestedTargetOf(variables),
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
      base.writeContract(pin(variables), options as never);
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
