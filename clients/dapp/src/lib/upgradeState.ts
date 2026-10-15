// Canonical: docs/adr/ADR-0014-governed-upgrades-and-freeze.md §3, §5 — proxies, the timelock authority, the freeze

/**
 * The upgrade state of one Robot Money contract, as the vault page shows it
 * (QA plan P3, core issue 1810).
 *
 * Every proxied contract is an ERC-1967 proxy over an implementation the
 * timelock can replace after its public delay, until a one-way freeze ends
 * upgrades for good. A holder should see three facts before depositing:
 * which implementation runs now, whether it can still change, and who can
 * change it. The dapp reads all of them from the chain, never from the
 * explorer index:
 *
 *   - the ERC-1967 implementation slot (`eth_getStorageAt`);
 *   - the implementation's runtime code, hashed here (`eth_getCode`);
 *   - `upgradesFrozen()` and `upgradeAuthority()` (`GOVERNED_UPGRADE_ABI`).
 *
 * A zero slot is a direct deployment: no proxy, so its code can never change
 * (the Deploy 2 contracts on Base). Nothing here gates a write. The page only
 * discloses.
 *
 * When the dapp cannot read the chain (the `mainnet` class with no wallet on
 * Base: the dapp has no RPC of its own), the page falls back to the explorer
 * index (`GET /v1/upgrades`) and says so (`indexed`). When the index has no
 * row either, the state is `unavailable`: it never stays `loading` forever,
 * because the page works without a wallet (docs/architecture.md §5.3).
 */
import { keccak256, getAddress, type Address, type Hex } from "viem";
import type { UpgradesResponse } from "./explorerApi";

/** `bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)`. */
export const ERC1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;

/** What the chain said about one contract's upgradeability. */
export type UpgradeState =
  | { kind: "loading" }
  /** The slot read failed: nothing is known, and nothing is claimed. */
  | { kind: "unknown" }
  /** No chain read is possible here and the explorer index has no row for this contract. */
  | { kind: "unavailable" }
  /**
   * From the explorer index, not the chain: the implementation of the newest indexed `Upgraded`
   * (null when only a freeze is indexed) and whether an `UpgradesFrozen` is indexed.
   */
  | {
      kind: "indexed";
      implementation: Address | null;
      frozen: boolean;
      /** The indexed block the answer is as of. */
      blockNumber: number;
    }
  /** Zero slot: not a proxy. Its code can never change. */
  | { kind: "direct" }
  | {
      kind: "proxy";
      implementation: Address;
      /** keccak256 of the implementation's runtime code; null while unread or unreadable. */
      implementationCodeHash: Hex | null;
      /** `upgradesFrozen()`; null when the read failed or has not landed. */
      frozen: boolean | null;
      /** `upgradeAuthority()`: the timelock; null when unread. */
      authority: Address | null;
    };

/** The implementation an ERC-1967 slot word names, or null for a zero word. */
export function implementationFromSlot(word: Hex): Address | null {
  const hex = word.replace(/^0x/, "").padStart(64, "0");
  const address = `0x${hex.slice(24)}`;
  return /^0x0{40}$/.test(address) ? null : getAddress(address);
}

/** The raw reads, as the hook hands them over. `undefined` means not landed yet. */
export interface UpgradeReads {
  slot: Hex | undefined;
  slotError: boolean;
  implementationCode: Hex | undefined;
  frozen: boolean | undefined;
  authority: Address | undefined;
}

/** Fold the raw reads into one state. Pure. */
export function resolveUpgradeState(r: UpgradeReads): UpgradeState {
  if (r.slotError) return { kind: "unknown" };
  if (r.slot === undefined) return { kind: "loading" };
  const implementation = implementationFromSlot(r.slot);
  if (implementation === null) return { kind: "direct" };
  return {
    kind: "proxy",
    implementation,
    implementationCodeHash:
      r.implementationCode !== undefined && r.implementationCode !== "0x"
        ? keccak256(r.implementationCode)
        : null,
    frozen: r.frozen ?? null,
    authority: r.authority ?? null,
  };
}

/**
 * The indexed state of `address` from a `/v1/upgrades` response. `null` (no response, or the fetch
 * failed) and an address with no row are `unavailable`: a proxy deployed below the indexed range
 * has no row until its next upgrade, so a missing row proves nothing.
 */
export function resolveIndexedUpgradeState(
  response: UpgradesResponse | null,
  address: string,
): UpgradeState {
  if (response === null || !Array.isArray(response.contracts)) return { kind: "unavailable" };
  const row = response.contracts.find((c) => c.contract.toLowerCase() === address.toLowerCase());
  if (row === undefined) return { kind: "unavailable" };
  return {
    kind: "indexed",
    implementation: row.implementation !== null ? getAddress(row.implementation) : null,
    frozen: row.upgrades_frozen,
    blockNumber: response.block_number,
  };
}

/** One-line status for the stat card. */
export function upgradeStateLabel(s: UpgradeState): string {
  switch (s.kind) {
    case "loading":
      return "Reading…";
    case "unknown":
      return "Unknown";
    case "unavailable":
      return "Connect a wallet to read";
    case "indexed":
      return s.frozen ? "Frozen (indexed)" : "Upgradeable (indexed)";
    case "direct":
      return "Not upgradeable";
    case "proxy":
      if (s.frozen === true) return "Frozen";
      if (s.frozen === false) return "Upgradeable";
      return "Proxy (freeze state unknown)";
  }
}

/** The sentence under the status: what the state means for a holder. */
export function upgradeStateExplanation(s: UpgradeState): string {
  switch (s.kind) {
    case "loading":
      return "Reading the implementation from the chain.";
    case "unknown":
      return "The implementation could not be read from the chain.";
    case "unavailable":
      return "Connect a wallet on this deployment's chain to read the implementation from the chain. The explorer index has no upgrade record for this contract.";
    case "indexed":
      return s.frozen
        ? `From the explorer index at block ${s.blockNumber}, not the chain: upgrades are frozen for good. Connect a wallet to read the live implementation. Withdrawals stay open.`
        : `From the explorer index at block ${s.blockNumber}, not the chain: the timelock can replace this implementation after its public delay. Connect a wallet to read the live implementation. Withdrawals stay open.`;
    case "direct":
      return "A direct deployment, not a proxy: its code can never change.";
    case "proxy":
      if (s.frozen === true) {
        return "Upgrades are frozen for good: this implementation can never be replaced. Withdrawals stay open.";
      }
      if (s.frozen === false) {
        return "The timelock can replace this implementation after its public delay, until it is frozen. Withdrawals stay open either way.";
      }
      return "A proxy whose freeze state could not be read.";
  }
}
