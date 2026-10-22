/**
 * Shared wagmi mock for the owner-consented registration tests (issue 1890).
 *
 * Every registration surface (Authorize tab, onboarding wizard, rotation tab) is driven through
 * the same hook, so the tests share one fake chain: a head block, a consent commitment the agent
 * may or may not have made, a map of mined receipts, and a log of every read and write.
 *
 * Use it from a test file as:
 *
 *   const state = vi.hoisted(() => ({ ...initial state }));  // or `freshState()` via dynamic import
 *   vi.mock("wagmi", async (importOriginal) => {
 *     const { makeWagmiMock } = await import("./helpers/registrationWagmi");
 *     return makeWagmiMock(await importOriginal(), state);
 *   });
 */
import type { Address } from "viem";

export const ZERO = "0x0000000000000000000000000000000000000000" as const;

export interface RegState {
  account: { address?: Address; isConnected: boolean };
  chainId: number;
  block: bigint;
  /** What `commitments(key)` answers for the agent's consent. `undefined` means not read yet. */
  consent: readonly [Address, bigint] | undefined;
  agentOwner: Address;
  /** What `hasRole(ADMIN_ROLE, wallet)` answers. The registration path must not depend on it. */
  hasAdmin: boolean;
  receipts: Map<string, { status: "success" | "reverted"; blockNumber: bigint }>;
  calls: { functionName?: string; args?: readonly unknown[] }[];
  reads: { functionName: string; args?: readonly unknown[] }[];
  callbacks: ((hash: `0x${string}`) => void)[];
}

export function freshState(): RegState {
  return {
    account: { address: undefined, isConnected: false },
    chainId: 918453,
    block: 100n,
    consent: undefined,
    agentOwner: ZERO,
    hasAdmin: false,
    receipts: new Map(),
    calls: [],
    reads: [],
    callbacks: [],
  };
}

export function resetState(s: RegState, account: RegState["account"]) {
  Object.assign(s, freshState(), { account });
}

export function makeWagmiMock(actual: object, s: RegState) {
  return {
    ...actual,
    useAccount: () => ({ ...s.account, chainId: s.chainId }),
    useChainId: () => s.chainId,
    useReadContract: ({
      functionName,
      args,
    }: {
      functionName: string;
      args?: readonly unknown[];
    }) => {
      s.reads.push({ functionName, args });
      if (functionName === "commitments") return { data: s.consent };
      if (functionName === "agentOwner") return { data: s.agentOwner };
      if (functionName === "usdc") return { data: "0x4444444444444444444444444444444444444444" };
      if (functionName === "hasRole") return { data: s.hasAdmin };
      return { data: 1000n };
    },
    useBalance: () => ({ data: { value: 1000n } }),
    useBlockNumber: () => ({ data: s.block }),
    useSimulateContract: ({ functionName, args }: { functionName: string; args?: unknown }) =>
      functionName === "revokeAgent" && args !== undefined
        ? {
            data: {
              request: {
                address: "0x1111111111111111111111111111111111111111",
                functionName: "revokeAgent",
                args,
              },
            },
          }
        : { data: undefined },
    useWaitForTransactionReceipt: ({ hash }: { hash?: string }) => ({
      data: hash ? s.receipts.get(hash) : undefined,
    }),
    useWriteContract: () => ({
      writeContract: (
        params: { functionName?: string; args?: readonly unknown[] },
        opts?: { onSuccess?: (hash: `0x${string}`) => void },
      ) => {
        s.calls.push(params);
        if (opts?.onSuccess) s.callbacks.push(opts.onSuccess);
      },
      isPending: false,
    }),
  };
}

export const tx = (b: string) => `0x${b.repeat(64)}` as `0x${string}`;
export const REVOKE_TX = tx("d");
export const COMMIT_TX = tx("c");
export const REVEAL_TX = tx("e");
