// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * Build-time vault and router code-hash pins (QA plan U5, issue 1737 item 1). Pure.
 *
 * The gateway has carried a pin since issue 207 (`VITE_GATEWAY_EXPECTED_CODE_HASH`,
 * gatewayVerifier.ts). Vaults and the router had none: the write guard only checked that a
 * deposit or approve target had SOME code, so a wrong address with code could take a deposit
 * or an approval. These pins close that:
 *
 *   - `VITE_VAULT_EXPECTED_CODE_HASH`  JSON map `{ "<vault address>": "<keccak256 of its
 *     runtime code>" }`, one entry per vault the bundle may deposit into or approve.
 *   - `VITE_ROUTER_EXPECTED_CODE_HASH` keccak256 of the PortfolioRouter runtime code, looked up
 *     at `VITE_ROUTER_ADDRESS`.
 *
 * `scripts/stage/mainnet-dapp.ts` computes both from the deploy manifests (the timelock
 * manifest records every vault's and the router's code hash read back from the chain).
 *
 * Both are BUILD-TIME ONLY, like the gateway pin: they are verification pins, not deployment
 * plumbing, so `runtimeConfig.ts` never takes them from `/config.json` (they are not in
 * `RUNTIME_CONFIG_KEYS`). A pin is the trust anchor: the address is only where the code is
 * read, the hash decides whether it is the expected contract.
 *
 * Two consumers:
 *   1. `useGuardedWriteContract` on the `mainnet` class refuses a deposit or an approve unless
 *      keccak256(eth_getCode) of the contract that receives the funds or the allowance equals
 *      its pin. A missing pin, unreadable code, no code and a different hash are four typed
 *      refusals (`WriteTargetPinError.pinCause`).
 *   2. `useVerifiedCodeTargets` reads the code of every pinned address so a vault or router
 *      preview badges its target "[bytecode verified]" only when it matched its own pin
 *      (`PreviewContext.verifiedTargets`, QA plan U4).
 *
 * A redeem is not refused for a missing pin: no funds or allowance go to the target, and an
 * exit must never depend on a build setting. Its preview still says UNVERIFIED.
 */
import { keccak256, type Hex } from "viem";
import { BASE_MAINNET_CHAIN_ID } from "./writeChainGuard";

/** Build-time key of the per-vault pin map. Never a runtime config key. */
export const VAULT_CODE_HASH_PIN_KEY = "VITE_VAULT_EXPECTED_CODE_HASH";
/** Build-time key of the router pin. Never a runtime config key. */
export const ROUTER_CODE_HASH_PIN_KEY = "VITE_ROUTER_EXPECTED_CODE_HASH";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ZERO_HASH = /^0x0{64}$/;

/** Lower-cased address -> lower-cased expected runtime code hash. */
export type CodePins = ReadonlyMap<string, string>;

function validHash(v: unknown): v is string {
  return typeof v === "string" && BYTES32.test(v) && !ZERO_HASH.test(v);
}

/**
 * The pins a build carries. A malformed entry is dropped, which reads as "no pin" for that
 * address: the guard then refuses, it never trusts a value it cannot parse.
 */
export function parseCodePins(env: Readonly<Record<string, string | undefined>>): CodePins {
  const pins = new Map<string, string>();
  const raw = env[VAULT_CODE_HASH_PIN_KEY];
  if (raw !== undefined && raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [address, hash] of Object.entries(parsed as Record<string, unknown>)) {
        if (ADDRESS.test(address) && validHash(hash)) {
          pins.set(address.toLowerCase(), hash.toLowerCase());
        }
      }
    }
  }
  const router = env.VITE_ROUTER_ADDRESS;
  const routerHash = env[ROUTER_CODE_HASH_PIN_KEY];
  if (router !== undefined && ADDRESS.test(router) && validHash(routerHash)) {
    pins.set(router.toLowerCase(), routerHash.toLowerCase());
  }
  return pins;
}

/**
 * The address whose code must match a pin before this write may be sent on the `mainnet`
 * class, or undefined when the write needs no pin:
 *   - `deposit` / `mint`: the target (a vault or the router receives the USDC);
 *   - `approve` / `increaseAllowance`: the spender (`args[0]`), which receives the allowance.
 * A missing address comes back as "" so the caller refuses it as unpinned.
 */
export function pinnedWriteTarget(variables: unknown): string | undefined {
  const v = (variables ?? {}) as { address?: unknown; functionName?: unknown; args?: unknown };
  if (v.functionName === "deposit" || v.functionName === "mint") {
    return typeof v.address === "string" ? v.address : "";
  }
  if (v.functionName === "approve" || v.functionName === "increaseAllowance") {
    const spender = Array.isArray(v.args) ? v.args[0] : undefined;
    return typeof spender === "string" ? spender : "";
  }
  return undefined;
}

/** Why a pinned target was refused. One cause, one message. */
export type CodePinCause = "pin-missing" | "code-unreadable" | "no-code" | "hash-mismatch";

export type CodePinResult =
  | { readonly ok: true; readonly hash: string }
  | { readonly ok: false; readonly cause: CodePinCause; readonly got?: string };

/**
 * Compare the code read at `target` with its pin. `code` is what `eth_getCode` returned:
 * a hex string, or anything else when the read failed (`code-unreadable`).
 */
export function checkCodePin(target: string, code: unknown, pins: CodePins): CodePinResult {
  const pin = pins.get(target.toLowerCase());
  if (pin === undefined) return { ok: false, cause: "pin-missing" };
  if (typeof code !== "string" || !/^0x[0-9a-fA-F]*$/.test(code)) {
    return { ok: false, cause: "code-unreadable" };
  }
  if (code === "0x") return { ok: false, cause: "no-code" };
  const got = keccak256(code as Hex).toLowerCase();
  if (got !== pin) return { ok: false, cause: "hash-mismatch", got };
  return { ok: true, hash: got };
}

function describeCause(target: string, cause: CodePinCause, got?: string): string {
  switch (cause) {
    case "pin-missing":
      return `has no build-time code-hash pin, so the dapp cannot tell that it is a Robot Money vault or router`;
    case "code-unreadable":
      return `could not be read through your wallet, so its code hash could not be checked against the pin`;
    case "no-code":
      return `has no contract code`;
    case "hash-mismatch":
      return `runs code whose hash ${got ?? "(unknown)"} is not the pinned hash for ${target}`;
  }
}

/** A deposit or approve refused because its funds or allowance would go to unpinned code. */
export class WriteTargetPinError extends Error {
  constructor(
    public readonly target: string,
    public readonly pinCause: CodePinCause,
    got?: string,
  ) {
    super(
      `Refusing to send: the contract ${target || "(missing address)"} on Base (chain ${BASE_MAINNET_CHAIN_ID}) ${describeCause(target, pinCause, got)}.`,
    );
    this.name = "WriteTargetPinError";
  }
}
