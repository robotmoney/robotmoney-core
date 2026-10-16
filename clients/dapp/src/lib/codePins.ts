// Canonical: docs/architecture.md §5.3 — Human Dapp
// (See also: docs/adr/ADR-0014-governed-uups-upgrades-and-freeze.md — clients check the implementation behind a proxy)

/**
 * Build-time vault, router and gateway code-hash pins (QA plan U5, issue 1737 item 1), and
 * the implementation pins behind them (ADR-0014). Pure.
 *
 * The gateway has carried a pin since issue 207 (`VITE_GATEWAY_EXPECTED_CODE_HASH`,
 * gatewayVerifier.ts). Vaults and the router had none: the write guard only checked that a
 * deposit or approve target had SOME code, so a wrong address with code could take a deposit
 * or an approval. These pins close that:
 *
 *   - `VITE_VAULT_EXPECTED_CODE_HASH`  JSON map `{ "<vault address>": "<keccak256 of its
 *     runtime code>" }`, one entry per vault the bundle may deposit into or approve.
 *   - `VITE_ROUTER_EXPECTED_CODE_HASH` keccak256 of the runtime code at `VITE_ROUTER_ADDRESS`.
 *   - the gateway's own pin (`VITE_GATEWAY_EXPECTED_CODE_HASH` at `VITE_GATEWAY_ADDRESS`), so
 *     the write guard re-checks the gateway at send time too.
 *
 * Behind an ERC-1967 proxy (ADR-0014) the code at the address is the `ERC1967Proxy`, the same
 * for every proxy and unchanged by an upgrade. A code-hash pin then proves only that the
 * address is a proxy, never which logic runs behind it. So each pinned address may also carry
 * reviewed IMPLEMENTATION pins, the code hashes of the implementations the release record
 * approves:
 *
 *   - `VITE_VAULT_EXPECTED_IMPLEMENTATION_HASH`  JSON map `{ "<vault address>": "<hash>[,<hash>]" }`
 *     (a list of hashes is accepted too);
 *   - `VITE_ROUTER_EXPECTED_IMPLEMENTATION_HASH` comma-separated hashes for the router;
 *   - the gateway's pin pair (issue 1810, gatewayVerifier.ts): `VITE_GATEWAY_EXPECTED_IMPLEMENTATION`
 *     (the approved implementation address) and `VITE_GATEWAY_EXPECTED_IMPLEMENTATION_HASH` (its
 *     code hash). Both are required; the slot must name that address and its code that hash.
 *
 * `verifyPinnedTarget` applies both: the code at the address must match its code-hash pin,
 * then the ERC-1967 implementation slot and the implementation's code, read at the same block,
 * must name a pinned implementation. A proxy without an implementation pin, an unlisted or
 * codeless implementation, and an implementation pin for an address that is not a proxy each
 * refuse. A direct contract (zero slot) needs no implementation pin: its whole code is pinned.
 *
 * `scripts/stage/mainnet-dapp.ts` computes every pin from the deploy manifests (the timelock
 * manifest records every vault's and the router's code hash and implementation code hash read
 * back from the chain).
 *
 * All are BUILD-TIME ONLY, like the gateway pin: they are verification pins, not deployment
 * plumbing, so `runtimeConfig.ts` never takes them from `/config.json` (they are not in
 * `RUNTIME_CONFIG_KEYS`). A pin is the trust anchor: the address is only where the code is
 * read, the hash decides whether it is the expected contract.
 *
 * Two consumers:
 *   1. `useGuardedWriteContract` on the `mainnet` class refuses a deposit or an approve, and any
 *      write to the gateway, unless `verifyPinnedTarget` passes for the contract that receives the
 *      funds, the allowance or the call. Every cause is a typed refusal
 *      (`WriteTargetPinError.pinCause`). A deposit into the router (`isRouterDeposit`) also checks
 *      every vault of the router's `getEffectiveWeights()`, read at the same block: the router
 *      forwards each leg's USDC into that vault and takes the vault's own `deposit()` return as the
 *      shares minted, so a leg running unreviewed logic could keep the USDC (security round 2,
 *      as rmpc `verify_router_and_legs` does). The refusal names the leg and sets
 *      `WriteTargetPinError.router`.
 *   2. `useVerifiedCodeTargets` reads every pinned address the same way, so a vault or router
 *      preview badges its target "[bytecode verified]" only when its code AND its implementation
 *      matched (`PreviewContext.verifiedTargets`, QA plan U4). A router deposit preview needs the
 *      router and every leg verified.
 *
 * A redeem is not refused for a missing pin: no funds or allowance go to the target, and an
 * exit must never depend on a build setting. Its preview still says UNVERIFIED. An approve of
 * zero (a revoke) grants nothing, so it needs no pin either.
 */
import { keccak256, type Hex } from "viem";
import { BASE_MAINNET_CHAIN_ID } from "./writeChainGuard";
import { implementationFromSlot } from "./gatewayVerifier";

/** Build-time key of the per-vault pin map. Never a runtime config key. */
export const VAULT_CODE_HASH_PIN_KEY = "VITE_VAULT_EXPECTED_CODE_HASH";
/** Build-time key of the router pin. Never a runtime config key. */
export const ROUTER_CODE_HASH_PIN_KEY = "VITE_ROUTER_EXPECTED_CODE_HASH";
/** Build-time key of the gateway pin (gatewayVerifier.ts reads it too). Never a runtime config key. */
export const GATEWAY_CODE_HASH_PIN_KEY = "VITE_GATEWAY_EXPECTED_CODE_HASH";
/** Build-time key of the per-vault implementation pin map. Never a runtime config key. */
export const VAULT_IMPLEMENTATION_HASH_PIN_KEY = "VITE_VAULT_EXPECTED_IMPLEMENTATION_HASH";
/** Build-time key of the router implementation pins. Never a runtime config key. */
export const ROUTER_IMPLEMENTATION_HASH_PIN_KEY = "VITE_ROUTER_EXPECTED_IMPLEMENTATION_HASH";
/** Build-time key of the gateway implementation code hash (issue 1810). Never a runtime config key. */
export const GATEWAY_IMPLEMENTATION_HASH_PIN_KEY = "VITE_GATEWAY_EXPECTED_IMPLEMENTATION_HASH";
/** Build-time key of the approved gateway implementation address (issue 1810). Never a runtime config key. */
export const GATEWAY_IMPLEMENTATION_ADDRESS_PIN_KEY = "VITE_GATEWAY_EXPECTED_IMPLEMENTATION";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ZERO_HASH = /^0x0{64}$/;
const HEX = /^0x[0-9a-fA-F]*$/;

/** Lower-cased address -> lower-cased expected runtime code hash. */
export type CodePins = ReadonlyMap<string, string>;
/** Lower-cased address -> lower-cased reviewed implementation code hashes. */
export type ImplementationPins = ReadonlyMap<string, readonly string[]>;
/** Lower-cased proxy address -> lower-cased implementation address the slot must name. */
export type ImplementationAddressPins = ReadonlyMap<string, string>;

/** Build-time implementation hash pins: a comma-separated list of 32-byte hex hashes. Malformed entries are dropped. */
export function parseImplementationPins(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^0x[0-9a-f]{64}$/.test(s) && !/^0x0{64}$/.test(s));
}

function validHash(v: unknown): v is string {
  return typeof v === "string" && BYTES32.test(v) && !ZERO_HASH.test(v);
}

function validAddress(v: unknown): v is string {
  return typeof v === "string" && ADDRESS.test(v) && !ZERO_ADDRESS.test(v);
}

/** A JSON object from a build-time map, or an empty object when it is absent or not one. */
function parseJsonMap(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * The code-hash pins a build carries. A malformed entry is dropped, which reads as "no pin" for
 * that address: the guard then refuses, it never trusts a value it cannot parse.
 */
export function parseCodePins(env: Readonly<Record<string, string | undefined>>): CodePins {
  const pins = new Map<string, string>();
  for (const [address, hash] of Object.entries(parseJsonMap(env[VAULT_CODE_HASH_PIN_KEY]))) {
    if (ADDRESS.test(address) && validHash(hash)) {
      pins.set(address.toLowerCase(), hash.toLowerCase());
    }
  }
  const router = env.VITE_ROUTER_ADDRESS;
  const routerHash = env[ROUTER_CODE_HASH_PIN_KEY];
  if (router !== undefined && ADDRESS.test(router) && validHash(routerHash)) {
    pins.set(router.toLowerCase(), routerHash.toLowerCase());
  }
  const gateway = env.VITE_GATEWAY_ADDRESS;
  const gatewayHash = env[GATEWAY_CODE_HASH_PIN_KEY]?.trim();
  if (validAddress(gateway) && validHash(gatewayHash)) {
    pins.set(gateway.toLowerCase(), gatewayHash.toLowerCase());
  }
  return pins;
}

/**
 * The implementation pins a build carries, by address. Malformed hashes are dropped; an address
 * whose list ends up empty has no pin, so a proxy there is refused.
 */
export function parseImplementationPinMap(
  env: Readonly<Record<string, string | undefined>>,
): ImplementationPins {
  const pins = new Map<string, readonly string[]>();
  const put = (address: string, hashes: string[]) => {
    if (hashes.length > 0) pins.set(address.toLowerCase(), hashes);
  };
  for (const [address, value] of Object.entries(
    parseJsonMap(env[VAULT_IMPLEMENTATION_HASH_PIN_KEY]),
  )) {
    if (!ADDRESS.test(address)) continue;
    const raw = Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string").join(",")
      : typeof value === "string"
        ? value
        : undefined;
    put(address, parseImplementationPins(raw));
  }
  const router = env.VITE_ROUTER_ADDRESS;
  if (validAddress(router)) {
    put(router, parseImplementationPins(env[ROUTER_IMPLEMENTATION_HASH_PIN_KEY]));
  }
  // The gateway pin is dev's address + hash pair (issue 1810): one without the other is no pin,
  // exactly as gatewayVerifier.computeGatewayVerification reads it.
  const gateway = env.VITE_GATEWAY_ADDRESS;
  const gatewayImplementation = env[GATEWAY_IMPLEMENTATION_ADDRESS_PIN_KEY]?.trim();
  if (validAddress(gateway) && validAddress(gatewayImplementation)) {
    put(gateway, parseImplementationPins(env[GATEWAY_IMPLEMENTATION_HASH_PIN_KEY]).slice(0, 1));
  }
  return pins;
}

/**
 * The implementation ADDRESS a proxy's slot must name, by proxy address. Only the gateway carries
 * one (`VITE_GATEWAY_EXPECTED_IMPLEMENTATION`); vaults and the router are pinned by code hash only.
 */
export function parseImplementationAddressPins(
  env: Readonly<Record<string, string | undefined>>,
): ImplementationAddressPins {
  const pins = new Map<string, string>();
  const gateway = env.VITE_GATEWAY_ADDRESS;
  const implementation = env[GATEWAY_IMPLEMENTATION_ADDRESS_PIN_KEY]?.trim();
  if (validAddress(gateway) && validAddress(implementation)) {
    pins.set(gateway.toLowerCase(), implementation.toLowerCase());
  }
  return pins;
}

/** The reviewed implementation hashes the build pins for `address` (empty when none). */
export function implementationPinsFor(
  pins: ImplementationPins,
  address: string,
): readonly string[] {
  return pins.get(address.toLowerCase()) ?? [];
}

/**
 * The address whose code must match a pin before this write may be sent on the `mainnet`
 * class, or undefined when the write needs no pin:
 *   - `deposit` / `mint`: the target (a vault or the router receives the USDC);
 *   - `approve` / `increaseAllowance`: the spender (`args[0]`), which receives the allowance.
 *     An `approve` of exactly zero grants nothing, so a revoke needs no pin;
 *   - any write to `gateway` (commit/reveal, revoke, pause, roles): the gateway itself, so its
 *     implementation is re-checked at send time, not only when the page loaded.
 * A missing address comes back as "" so the caller refuses it as unpinned.
 */
export function pinnedWriteTarget(variables: unknown, gateway?: string): string | undefined {
  const v = (variables ?? {}) as { address?: unknown; functionName?: unknown; args?: unknown };
  if (v.functionName === "deposit" || v.functionName === "mint") {
    return typeof v.address === "string" ? v.address : "";
  }
  if (v.functionName === "approve" || v.functionName === "increaseAllowance") {
    const args = Array.isArray(v.args) ? v.args : [];
    if (v.functionName === "approve" && args.length >= 2 && args[1] === 0n) return undefined;
    const spender = args[0];
    return typeof spender === "string" ? spender : "";
  }
  if (
    validAddress(gateway) &&
    typeof v.address === "string" &&
    v.address.toLowerCase() === gateway.toLowerCase()
  ) {
    return v.address;
  }
  return undefined;
}

/**
 * True when this write is a deposit into a Portfolio Router: its target is the configured router
 * (`VITE_ROUTER_ADDRESS`), or it has the router's shape `deposit(amount, minSharesPerLeg[])`, which
 * no vault has. The router passes the USDC on to every vault of its effective weight vector, so the
 * guard checks each of those vaults too, not only the router.
 */
export function isRouterDeposit(variables: unknown, router: string | undefined): boolean {
  const v = (variables ?? {}) as { address?: unknown; functionName?: unknown; args?: unknown };
  if (v.functionName !== "deposit" && v.functionName !== "mint") return false;
  if (Array.isArray(v.args) && Array.isArray(v.args[1])) return true;
  return (
    validAddress(router) &&
    typeof v.address === "string" &&
    v.address.toLowerCase() === router.toLowerCase()
  );
}

/** Why a pinned target was refused. One cause, one message. */
export type CodePinCause =
  | "pin-missing"
  | "code-unreadable"
  | "no-code"
  | "hash-mismatch"
  | "implementation-unreadable"
  | "implementation-pin-missing"
  | "implementation-mismatch"
  | "implementation-unexpected"
  | "router-legs-unreadable";

/**
 * The causes that are an answer from the chain, not a failed read: the target is known not to be
 * the pinned contract. A failed read (`code-unreadable`, `implementation-unreadable`) is not.
 */
export const DEFINITE_PIN_REFUSALS: ReadonlySet<CodePinCause> = new Set<CodePinCause>([
  "no-code",
  "hash-mismatch",
  "implementation-pin-missing",
  "implementation-mismatch",
  "implementation-unexpected",
]);

export type CodePinResult =
  | { readonly ok: true; readonly hash: string; readonly implementationHash?: string }
  | { readonly ok: false; readonly cause: CodePinCause; readonly got?: string };

/**
 * Compare the code read at `target` with its pin. `code` is what `eth_getCode` returned:
 * a hex string, or anything else when the read failed (`code-unreadable`).
 */
export function checkCodePin(target: string, code: unknown, pins: CodePins): CodePinResult {
  const pin = pins.get(target.toLowerCase());
  if (pin === undefined) return { ok: false, cause: "pin-missing" };
  if (typeof code !== "string" || !HEX.test(code)) {
    return { ok: false, cause: "code-unreadable" };
  }
  if (code === "0x") return { ok: false, cause: "no-code" };
  const got = keccak256(code as Hex).toLowerCase();
  if (got !== pin) return { ok: false, cause: "hash-mismatch", got };
  return { ok: true, hash: got };
}

/** The ERC-1967 reads of one target, all made at the same block. */
export interface PinnedTargetReads {
  /** `eth_getCode(target)`: a hex string, anything else when the read failed. */
  readonly code: unknown;
  /** `eth_getStorageAt(target, ERC1967 implementation slot)`: a hex word, anything else when it failed. */
  readonly slot: unknown;
  /**
   * `eth_getCode(implementation)` when the slot names one; `null` when the slot is zero (no read
   * is made). Anything else that is not a hex string is a failed read.
   */
  readonly implementationCode: unknown;
}

/**
 * Apply the implementation pin to a target whose slot and implementation code were read
 * (pure). A zero slot is a direct contract: it passes with no implementation pin and refuses
 * with one (the build expected a proxy).
 */
export function checkImplementationPin(
  target: string,
  slot: unknown,
  implementationCode: unknown,
  pins: ImplementationPins,
  addressPins: ImplementationAddressPins = new Map(),
):
  | { readonly ok: true; readonly implementationHash?: string }
  | { readonly ok: false; readonly cause: CodePinCause; readonly got?: string } {
  if (typeof slot !== "string" || !HEX.test(slot) || slot.length > 66) {
    return { ok: false, cause: "implementation-unreadable" };
  }
  const listed = implementationPinsFor(pins, target);
  const implementation = implementationFromSlot(slot as Hex);
  if (implementation === undefined) return { ok: false, cause: "implementation-unreadable" };
  if (implementation === null) {
    return listed.length > 0 ? { ok: false, cause: "implementation-unexpected" } : { ok: true };
  }
  if (listed.length === 0) return { ok: false, cause: "implementation-pin-missing" };
  const expectedAddress = addressPins.get(target.toLowerCase());
  if (expectedAddress !== undefined && implementation.toLowerCase() !== expectedAddress) {
    return { ok: false, cause: "implementation-mismatch", got: implementation };
  }
  if (typeof implementationCode !== "string" || !HEX.test(implementationCode)) {
    return { ok: false, cause: "implementation-unreadable" };
  }
  if (implementationCode === "0x") return { ok: false, cause: "implementation-mismatch" };
  const got = keccak256(implementationCode as Hex).toLowerCase();
  if (!listed.includes(got)) return { ok: false, cause: "implementation-mismatch", got };
  return { ok: true, implementationHash: got };
}

/** Both pins for one target: its code first, then the implementation behind it. */
export function verifyPinnedTarget(
  target: string,
  reads: PinnedTargetReads,
  codePins: CodePins,
  implementationPins: ImplementationPins,
  implementationAddressPins: ImplementationAddressPins = new Map(),
): CodePinResult {
  const code = checkCodePin(target, reads.code, codePins);
  if (!code.ok) return code;
  const implementation = checkImplementationPin(
    target,
    reads.slot,
    reads.implementationCode,
    implementationPins,
    implementationAddressPins,
  );
  if (!implementation.ok) return implementation;
  return implementation.implementationHash === undefined
    ? code
    : { ok: true, hash: code.hash, implementationHash: implementation.implementationHash };
}

function describeCause(target: string, cause: CodePinCause, got?: string): string {
  switch (cause) {
    case "pin-missing":
      return `has no build-time code-hash pin, so the dapp cannot tell that it is a Robot Money contract`;
    case "code-unreadable":
      return `could not be read through your wallet, so its code hash could not be checked against the pin`;
    case "no-code":
      return `has no contract code`;
    case "hash-mismatch":
      return `runs code whose hash ${got ?? "(unknown)"} is not the pinned hash for ${target}`;
    case "implementation-unreadable":
      return `is a proxy whose implementation could not be read through your wallet, so the logic behind it could not be checked against the pin`;
    case "implementation-pin-missing":
      return `is an upgradeable proxy and this build pins no reviewed implementation for it, so the logic behind it cannot be verified`;
    case "implementation-mismatch":
      return `is a proxy whose implementation${got ? (got.length === 42 ? ` ${got}` : ` (code hash ${got})`) : " (no code)"} is not a reviewed one this build pins. It may have been upgraded. Do not sign anything against it`;
    case "implementation-unexpected":
      return `is not a proxy, but this build pins an implementation for it`;
    case "router-legs-unreadable":
      return `is the Portfolio Router, and its leg vaults (getEffectiveWeights) could not be read through your wallet, so the vaults it would deposit into could not be checked against their pins`;
  }
}

/**
 * A write refused because its funds, allowance or call would go to unpinned code. `router` is set
 * when `target` is a leg vault the Portfolio Router would deposit into, not the write's own target.
 */
export class WriteTargetPinError extends Error {
  constructor(
    public readonly target: string,
    public readonly pinCause: CodePinCause,
    got?: string,
    public readonly router?: string,
  ) {
    const via = router ? `, a leg vault the Portfolio Router ${router} would deposit into,` : "";
    super(
      `Refusing to send: the contract ${target || "(missing address)"} on Base (chain ${BASE_MAINNET_CHAIN_ID})${via} ${describeCause(target, pinCause, got)}.`,
    );
    this.name = "WriteTargetPinError";
  }
}
