// Shared fixtures of the submitter Safe tests (issues 1750, 1888): a SafeL2 1.4.1 look-alike on a fake chain, where `canonical()` passes the check and a test mutates one fact at a time.
import { keccak256, type Address, type Hex } from "viem";
import { SAFE_GUARD_SLOT, SAFE_SENTINEL } from "../src/verify/constants.ts";
import { FALLBACK_HANDLER_SLOT, SAFE_141 } from "../src/safe/constants.ts";
import type { SubmitterChain } from "../src/submitter-safe.ts";
import { addr } from "./govern-world.ts";

export const SUBSAFE = addr(0x5afe);
export const OWNERS = [addr(0xa1), addr(0xa2), addr(0xa3)];
export const DEPLOYER = addr(0xde11);
export const signer = (who: Address) => ({ address: async () => who }) as never;
export const word = (a: string) => `0x${"0".repeat(24)}${a.slice(2).toLowerCase()}` as Hex;
export const ZERO32 = `0x${"0".repeat(64)}` as Hex;

/** A stand-in proxy code: its hash is the pin the fake chain reports (the real hash is pinned in SAFE_141 and checked against a real Safe in the Twin test). */
export const STANDIN = "0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167f" as Hex;

export interface SafeFacts { code: Hex | undefined; slot0: Hex; version: string; owners: Address[]; threshold: bigint; modules: string[]; guard: Hex; fallback: Hex }
export function canonical(): SafeFacts {
  return { code: "0x" as Hex, slot0: word(SAFE_141.singletonL2), version: "1.4.1", owners: OWNERS, threshold: 2n, modules: [], guard: ZERO32, fallback: word(SAFE_141.fallbackHandler) };
}
export function chainFor(f: SafeFacts): SubmitterChain {
  return {
    proxyCodehashPin: keccak256(STANDIN),
    getCode: async () => f.code,
    getStorageAt: async (_a, slot) => (slot === "0x0000000000000000000000000000000000000000000000000000000000000000" ? f.slot0 : slot === SAFE_GUARD_SLOT ? f.guard : slot === FALLBACK_HANDLER_SLOT ? f.fallback : ZERO32),
    read: async <T,>(_a: Address, _abi: readonly unknown[], fn: string, args: unknown[] = []): Promise<T> => {
      if (fn === "VERSION") return f.version as never;
      if (fn === "getOwners") return f.owners as never;
      if (fn === "getThreshold") return f.threshold as never;
      if (fn === "getModulesPaginated") { if (args[0] !== SAFE_SENTINEL) throw new Error("fake: modules page must start at the sentinel"); return [f.modules, SAFE_SENTINEL] as never; }
      throw new Error(`fake ${fn}`);
    },
  };
}
