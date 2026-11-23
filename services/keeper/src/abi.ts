// Canonical: docs/technical/one-vault-rebalancer-proposal.md §8.1 (Stack). The ABIs come from out/ through
// scripts/gen-abi.ts. Errors of all four contracts are merged so any revert the keeper meets decodes by name.
import { decodeErrorResult, type Abi, type Hex } from "viem";
import raw from "./abi.generated.json";

export const queueAbi = raw.FlowQueue as Abi;
export const rebalancerAbi = raw.Rebalancer as Abi;
export const keeperAccountAbi = raw.KeeperAccount as Abi;
export const fundAbi = raw.RobotMoneyFund as Abi;
export const errorsAbi = raw.errors as Abi;

/** SettleCheck (contracts/FlowTypes.sol): Ok and Window by ordinal. */
export const SettleCheck = { Ok: 0, Window: 1, Caller: 2, Paused: 3 } as const;
/** SkipReason (contracts/FundTypes.sol) ordinals the keeper acts on. */
export const SkipReason = { None: 0, StepFailed: 6, Concluded: 7 } as const;

export interface DecodedRevert { name: string; args: readonly unknown[]; text: string }

const BUILTIN: Record<string, string> = { "0x08c379a0": "Error", "0x4e487b71": "Panic" };

/** Decodes revert data against the merged errors. KeeperAccount.CallFailed(bytes) is unwrapped to its inner reason. */
export function decodeRevert(data: Hex | undefined): DecodedRevert {
  if (!data || data === "0x") return { name: "unknown", args: [], text: "no revert data" };
  try {
    const r = decodeErrorResult({ abi: errorsAbi, data });
    if (r.errorName === "CallFailed" && typeof r.args?.[0] === "string") {
      const inner = decodeRevert(r.args[0] as Hex);
      return { ...inner, text: `CallFailed(${inner.text})` };
    }
    const args = (r.args ?? []) as readonly unknown[];
    return { name: r.errorName, args, text: `${r.errorName}(${args.map(String).join(",")})` };
  } catch {
    const sel = data.slice(0, 10);
    return { name: BUILTIN[sel] ?? "unknown", args: [], text: `undecoded ${data.slice(0, 74)}` };
  }
}

/** Walks a viem error chain for raw revert data. */
export function revertDataOf(err: unknown): Hex | undefined {
  let e: any = err;
  for (let i = 0; e && i < 12; i++) {
    if (typeof e.data === "string" && e.data.startsWith("0x")) return e.data as Hex;
    if (e.data && typeof e.data.data === "string") return e.data.data as Hex;
    e = e.cause;
  }
  return undefined;
}
