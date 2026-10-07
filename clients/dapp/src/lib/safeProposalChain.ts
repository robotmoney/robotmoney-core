// Canonical: docs/technical/dapp-credential-decisions.md §3.2 (Safe-signable admin proposals), §3.3

/**
 * safeProposalChain — the read side of the "Create Safe proposal" flow (core 1544).
 *
 * Everything the dapp must know about the Safe and the timelock before it asks a
 * wallet for a signature, and every refusal that has to happen before that
 * request. The reads go through a small `SafeChainReader` so the logic is
 * testable without a chain. Nothing here signs or sends.
 *
 * Refusals, in order (the first that applies wins):
 *   1. the Safe is not canonical SafeL2 v1.4.1 (VERSION, proxy codehash or singleton differ)
 *   2. the connected address is not a Safe owner
 *   3. the Safe lacks PROPOSER_ROLE on the timelock (schedule), or EXECUTOR_ROLE (execute)
 * and, after the typed data is built:
 *   4. the local digest differs from `Safe.getTransactionHash`
 */
import { getAddress, keccak256, type Abi, type Address, type Hex } from "viem";
import {
  EXECUTOR_ROLE,
  PROPOSER_ROLE,
  SAFE_L2_141,
  SAFE_VERSION,
  SafeProposalError,
  ZERO_ADDRESS,
  safeAbi,
  timelockCallAbi,
  type SafeTxBuild,
} from "./safeProposal";

/** The reads the flow needs. The component adapts a viem public client to this. */
export interface SafeChainReader {
  chainId(): Promise<number>;
  getCode(address: Address): Promise<Hex | undefined>;
  getStorageAt(address: Address, slot: Hex): Promise<Hex | undefined>;
  read(args: {
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

export interface SafeContext {
  readonly chainId: number;
  readonly safe: Address;
  readonly timelock: Address;
  readonly version: string;
  readonly owners: readonly Address[];
  readonly threshold: number;
  readonly nonce: bigint;
  readonly codehash: Hex;
  readonly singleton: Address;
  /** VERSION, proxy codehash and singleton all match canonical SafeL2 v1.4.1. */
  readonly canonical: boolean;
  readonly minDelay: bigint;
  readonly hasProposerRole: boolean;
  /** The Safe, or address(0) (open executor), holds EXECUTOR_ROLE. */
  readonly hasExecutorRole: boolean;
}

const lc = (s: string): string => s.toLowerCase();

/** Pure canonical test, so it is unit-testable without proxy bytecode. */
export function isCanonicalSafe(args: {
  readonly version: string;
  readonly codehash: Hex;
  readonly singleton: Address;
}): boolean {
  return (
    args.version === SAFE_VERSION &&
    lc(args.codehash) === lc(SAFE_L2_141.proxyCodehash) &&
    lc(args.singleton) === lc(SAFE_L2_141.singletonL2)
  );
}

export async function loadSafeContext(
  reader: SafeChainReader,
  cfg: { readonly safe: Address; readonly timelock: Address },
): Promise<SafeContext> {
  const safe = getAddress(cfg.safe);
  const timelock = getAddress(cfg.timelock);
  const [chainId, code, slot0] = await Promise.all([
    reader.chainId(),
    reader.getCode(safe),
    reader.getStorageAt(safe, "0x0000000000000000000000000000000000000000000000000000000000000000"),
  ]);
  if (!code || code === "0x") {
    throw new SafeProposalError("BAD_INPUT", `no contract at the Safe address ${safe}`);
  }
  const timelockCode = await reader.getCode(timelock);
  if (!timelockCode || timelockCode === "0x") {
    throw new SafeProposalError("BAD_INPUT", `no contract at the timelock address ${timelock}`);
  }
  const codehash = keccak256(code);
  const singleton = getAddress(`0x${(slot0 ?? "0x").slice(-40).padStart(40, "0")}`);

  const call = (address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) =>
    reader.read({ address, abi, functionName, args });
  const safeRead = (functionName: string, args?: readonly unknown[]) =>
    call(safe, safeAbi as Abi, functionName, args);
  const tlRead = (functionName: string, args: readonly unknown[] = []) =>
    call(timelock, timelockCallAbi as Abi, functionName, args);

  let version = "";
  try {
    version = String(await safeRead("VERSION"));
  } catch {
    version = "";
  }
  const [owners, threshold, nonce, minDelay, hasProposerRole, executorSelf, executorOpen] =
    await Promise.all([
      safeRead("getOwners"),
      safeRead("getThreshold"),
      safeRead("nonce"),
      tlRead("getMinDelay"),
      tlRead("hasRole", [PROPOSER_ROLE, safe]),
      tlRead("hasRole", [EXECUTOR_ROLE, safe]),
      tlRead("hasRole", [EXECUTOR_ROLE, ZERO_ADDRESS]),
    ]);

  return {
    chainId,
    safe,
    timelock,
    version,
    owners: (owners as readonly Address[]).map((o) => getAddress(o)),
    threshold: Number(threshold),
    nonce: nonce as bigint,
    codehash,
    singleton,
    canonical: isCanonicalSafe({ version, codehash, singleton }),
    minDelay: minDelay as bigint,
    hasProposerRole: Boolean(hasProposerRole),
    hasExecutorRole: Boolean(executorSelf) || Boolean(executorOpen),
  };
}

export type Assessment = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The refusals that need only the context and the connected address. */
export function assessSafeContext(
  ctx: SafeContext,
  args: { readonly account: Address | undefined; readonly kind: "schedule" | "execute" },
): Assessment {
  if (!ctx.canonical) {
    return {
      ok: false,
      reason:
        `Refusing to sign: the configured Safe ${ctx.safe} is not canonical SafeL2 v${SAFE_VERSION} ` +
        `(version "${ctx.version || "none"}", proxy codehash ${ctx.codehash}, singleton ${ctx.singleton}).`,
    };
  }
  if (!args.account) {
    return { ok: false, reason: "Connect a Safe owner wallet to create a proposal." };
  }
  if (!ctx.owners.some((o) => lc(o) === lc(args.account ?? ""))) {
    return {
      ok: false,
      reason:
        `Refusing to sign: the connected wallet ${args.account} is not an owner of the Safe ${ctx.safe}. ` +
        "Connect one of the Safe owners. Nothing was sent to the wallet.",
    };
  }
  if (args.kind === "schedule" && !ctx.hasProposerRole) {
    return {
      ok: false,
      reason: `Refusing to sign: the Safe ${ctx.safe} does not hold PROPOSER_ROLE on the timelock ${ctx.timelock}, so schedule would revert.`,
    };
  }
  if (args.kind === "execute" && !ctx.hasExecutorRole) {
    return {
      ok: false,
      reason: `Refusing to sign: neither the Safe ${ctx.safe} nor address(0) holds EXECUTOR_ROLE on the timelock ${ctx.timelock}, so execute would revert.`,
    };
  }
  return { ok: true };
}

/** Throws `DIGEST_MISMATCH` when the local digest differs from what the Safe computes for the same fields. */
export async function verifyDigestOnChain(
  reader: SafeChainReader,
  ctx: SafeContext,
  build: SafeTxBuild,
): Promise<void> {
  const m = build.typedData.message;
  const onchain = await reader.read({
    address: ctx.safe,
    abi: safeAbi as Abi,
    functionName: "getTransactionHash",
    args: [m.to, 0n, m.data, 0, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, BigInt(m.nonce)],
  });
  if (lc(String(onchain)) !== lc(build.safeTxHash)) {
    throw new SafeProposalError(
      "DIGEST_MISMATCH",
      `Refusing to sign: the local Safe transaction hash ${build.safeTxHash} differs from Safe.getTransactionHash ${String(onchain)}.`,
    );
  }
}
