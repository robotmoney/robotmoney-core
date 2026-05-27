/**
 * Vitest unit pinning the RobotMoneyVault adapter-allowlist surface in
 * `abi.generated.ts` to the on-chain selectors and event topics emitted by
 * `forge inspect`. Issue #444 — the generated TypeScript bindings must expose
 * setAdapterAllowed, setAdapterCodeHashAllowed, AdapterAllowedSet, and
 * AdapterCodeHashAllowedSet so dapp admin panels can drive the new governance
 * surface through wagmi/viem typed clients.
 *
 * Canonical: docs/technical/security-model.md (adapter allowlist guard),
 * contracts/RobotMoneyVault.sol.
 *
 * Selectors and topic hashes below are the exact values produced by
 * `forge inspect RobotMoneyVault methods` and `forge inspect RobotMoneyVault
 * events` at the commit that lands this regeneration. If a future contract
 * change renames or removes the surface, this test fails and the contributor
 * must regenerate abi.generated.ts (see .github/scripts/generate_abi_bindings.sh).
 */
import { describe, it, expect } from "vitest";
import { toFunctionSelector, toEventSelector } from "viem";
import { robotMoneyVaultAbiGenerated } from "../../src/lib/abi.generated";

type AbiItem = (typeof robotMoneyVaultAbiGenerated)[number];

function findFunction(name: string): AbiItem {
  const item = robotMoneyVaultAbiGenerated.find(
    (entry) => entry.type === "function" && entry.name === name,
  );
  if (!item) throw new Error(`function ${name} missing from robotMoneyVaultAbiGenerated`);
  return item;
}

function findEvent(name: string): AbiItem {
  const item = robotMoneyVaultAbiGenerated.find(
    (entry) => entry.type === "event" && entry.name === name,
  );
  if (!item) throw new Error(`event ${name} missing from robotMoneyVaultAbiGenerated`);
  return item;
}

describe("robotMoneyVaultAbiGenerated adapter allowlist surface", () => {
  it("exposes setAdapterAllowed with the on-chain selector 0xb2976fb9", () => {
    const fn = findFunction("setAdapterAllowed");
    expect(toFunctionSelector(fn as never)).toBe("0xb2976fb9");
  });

  it("exposes setAdapterCodeHashAllowed with the on-chain selector 0x5a16caa9", () => {
    const fn = findFunction("setAdapterCodeHashAllowed");
    expect(toFunctionSelector(fn as never)).toBe("0x5a16caa9");
  });

  it("exposes AdapterAllowedSet with the on-chain topic0", () => {
    const ev = findEvent("AdapterAllowedSet");
    expect(toEventSelector(ev as never)).toBe(
      "0xf060c9e5443894416e7e09eb7c7bb13cff01bdf3fa24b261f997e269cb4e30bf",
    );
  });

  it("exposes AdapterCodeHashAllowedSet with the on-chain topic0", () => {
    const ev = findEvent("AdapterCodeHashAllowedSet");
    expect(toEventSelector(ev as never)).toBe(
      "0x2efab664d27285ead886f3a3ca30864e063f4a5db2f1960d7ae4a8a81949ce29",
    );
  });
});
