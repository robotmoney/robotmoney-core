/**
 * QA plan P3 (core issue 1810): the vault page discloses the implementation
 * behind the vault's ERC-1967 proxy, whether the timelock can still replace it
 * or it is frozen, and the upgrade authority — read from the chain.
 *
 * The resolver is pure and the view takes its output, so these tests render
 * every state without a chain:
 *   - a proxy that can still be upgraded names its implementation, code hash
 *     and timelock;
 *   - a frozen proxy says no upgrade can ever run again, and that withdrawals
 *     stay open;
 *   - a direct deployment says its code can never change;
 *   - a failed slot read claims nothing.
 */
import { describe, expect, it } from "vitest";
import { keccak256, type Address, type Hex } from "viem";
import { render } from "./helpers/render";
import { UpgradeStateView } from "../../src/components/UpgradeStatePanel";
import {
  ERC1967_IMPLEMENTATION_SLOT,
  implementationFromSlot,
  resolveIndexedUpgradeState,
  resolveUpgradeState,
  type UpgradeReads,
} from "../../src/lib/upgradeState";
import type { UpgradesResponse } from "../../src/lib/explorerApi";

const IMPLEMENTATION = "0x00000000000000000000000000000000000001A1" as Address;
const TIMELOCK = "0x000000000000000000000000000000000000071C" as Address;
const SLOT_WORD = `0x${"00".repeat(12)}${IMPLEMENTATION.slice(2).toLowerCase()}` as Hex;
const CODE = "0x6001600055" as Hex;

function reads(over: Partial<UpgradeReads> = {}): UpgradeReads {
  return {
    slot: SLOT_WORD,
    slotError: false,
    implementationCode: CODE,
    frozen: false,
    authority: TIMELOCK,
    ...over,
  };
}

describe("upgradeState (pure)", () => {
  it("the slot constant is keccak256('eip1967.proxy.implementation') - 1", () => {
    const h = BigInt(keccak256(new TextEncoder().encode("eip1967.proxy.implementation")));
    expect(BigInt(ERC1967_IMPLEMENTATION_SLOT)).toBe(h - 1n);
  });

  it("reads the implementation from the low 20 bytes of the slot word, and zero as none", () => {
    expect(implementationFromSlot(SLOT_WORD)).toBe(IMPLEMENTATION);
    expect(implementationFromSlot(`0x${"00".repeat(32)}`)).toBeNull();
    expect(implementationFromSlot("0x0")).toBeNull();
  });

  it("folds the reads: loading, unknown, direct, proxy", () => {
    expect(resolveUpgradeState(reads({ slot: undefined })).kind).toBe("loading");
    expect(resolveUpgradeState(reads({ slotError: true })).kind).toBe("unknown");
    expect(resolveUpgradeState(reads({ slot: `0x${"00".repeat(32)}` })).kind).toBe("direct");
    expect(resolveUpgradeState(reads())).toEqual({
      kind: "proxy",
      implementation: IMPLEMENTATION,
      implementationCodeHash: keccak256(CODE),
      frozen: false,
      authority: TIMELOCK,
    });
    // An implementation without code has no hash to show.
    const noCode = resolveUpgradeState(reads({ implementationCode: "0x" }));
    expect(noCode.kind === "proxy" && noCode.implementationCodeHash).toBeNull();
  });
});

describe("UpgradeStateView on the vault page", () => {
  it("an upgradeable proxy shows its implementation, code hash and timelock", () => {
    const { getByTestId } = render(<UpgradeStateView state={resolveUpgradeState(reads())} />);
    expect(getByTestId("vault-detail-upgrade").getAttribute("data-upgrade-state")).toBe(
      "upgradeable",
    );
    expect(getByTestId("vault-detail-upgrade-status").textContent).toBe("Upgradeable");
    expect(getByTestId("vault-detail-upgrade-implementation").textContent).toBe(IMPLEMENTATION);
    expect(getByTestId("vault-detail-upgrade-code-hash").textContent).toBe(keccak256(CODE));
    expect(getByTestId("vault-detail-upgrade-authority").textContent).toBe(TIMELOCK);
    expect(getByTestId("vault-detail-upgrade-explanation").textContent).toContain("timelock");
  });

  it("a frozen proxy says no upgrade can run again and that withdrawals stay open", () => {
    const { getByTestId } = render(
      <UpgradeStateView state={resolveUpgradeState(reads({ frozen: true }))} />,
    );
    expect(getByTestId("vault-detail-upgrade").getAttribute("data-upgrade-state")).toBe("frozen");
    expect(getByTestId("vault-detail-upgrade-status").textContent).toBe("Frozen");
    const explanation = getByTestId("vault-detail-upgrade-explanation").textContent ?? "";
    expect(explanation).toContain("never be replaced");
    expect(explanation).toContain("Withdrawals stay open");
    expect(getByTestId("vault-detail-upgrade-implementation").textContent).toBe(IMPLEMENTATION);
  });

  it("a proxy whose freeze read failed does not claim either state", () => {
    const { getByTestId } = render(
      <UpgradeStateView state={resolveUpgradeState(reads({ frozen: undefined }))} />,
    );
    expect(getByTestId("vault-detail-upgrade").getAttribute("data-upgrade-state")).toBe("proxy");
    expect(getByTestId("vault-detail-upgrade-status").textContent).not.toMatch(
      /^(Frozen|Upgradeable)$/,
    );
  });

  it("a direct deployment says its code can never change and lists no implementation", () => {
    const { getByTestId, queryByTestId } = render(
      <UpgradeStateView state={resolveUpgradeState(reads({ slot: `0x${"00".repeat(32)}` }))} />,
    );
    expect(getByTestId("vault-detail-upgrade-status").textContent).toBe("Not upgradeable");
    expect(getByTestId("vault-detail-upgrade-explanation").textContent).toContain(
      "can never change",
    );
    expect(queryByTestId("vault-detail-upgrade-implementation")).toBeNull();
  });

  it("a failed slot read claims nothing", () => {
    const { getByTestId, queryByTestId } = render(
      <UpgradeStateView state={resolveUpgradeState(reads({ slotError: true }))} />,
    );
    expect(getByTestId("vault-detail-upgrade-status").textContent).toBe("Unknown");
    expect(queryByTestId("vault-detail-upgrade-implementation")).toBeNull();
  });
});

// Issue 1810: the page works without a wallet (docs/architecture.md §5.3). On the mainnet class with
// no wallet on Base the dapp cannot read the chain, so it shows the explorer index's answer, labelled
// as indexed, or says it cannot read. It never stays "Reading…" forever.
describe("without a chain read (no wallet on the mainnet class)", () => {
  const PROXY = "0x00000000000000000000000000000000000000aa";
  const indexed: UpgradesResponse = {
    contracts: [
      {
        chain_id: 8453,
        contract: PROXY,
        contract_kind: "gateway",
        implementation: IMPLEMENTATION.toLowerCase(),
        upgraded_block: 100,
        upgrades_frozen: true,
        frozen_block: 120,
        frozen_code_hash: keccak256(CODE),
      },
    ],
    block_number: 150,
    indexed_at: "2026-10-15T00:00:00Z",
  };

  it("shows the indexed state, says it is indexed, and names the block", () => {
    const state = resolveIndexedUpgradeState(indexed, PROXY.toUpperCase().replace("0X", "0x"));
    expect(state).toEqual({
      kind: "indexed",
      implementation: IMPLEMENTATION,
      frozen: true,
      blockNumber: 150,
    });
    const { getByTestId } = render(<UpgradeStateView state={state} />);
    expect(getByTestId("vault-detail-upgrade").getAttribute("data-upgrade-state")).toBe(
      "indexed-frozen",
    );
    expect(getByTestId("vault-detail-upgrade-status").textContent).toBe("Frozen (indexed)");
    const explanation = getByTestId("vault-detail-upgrade-explanation").textContent ?? "";
    expect(explanation).toContain("explorer index at block 150");
    expect(explanation).toContain("Connect a wallet");
    expect(getByTestId("vault-detail-upgrade-implementation").textContent).toBe(IMPLEMENTATION);
  });

  it("is unavailable, not loading, when the index has no row or the fetch failed", () => {
    for (const state of [
      resolveIndexedUpgradeState(indexed, "0x00000000000000000000000000000000000000bb"),
      resolveIndexedUpgradeState(null, PROXY),
      resolveIndexedUpgradeState({ block_number: 1 } as unknown as UpgradesResponse, PROXY),
    ]) {
      expect(state).toEqual({ kind: "unavailable" });
      const { getAllByTestId } = render(<UpgradeStateView state={state} />);
      const status = getAllByTestId("vault-detail-upgrade-status").at(-1)?.textContent;
      expect(status).toBe("Connect a wallet to read");
      expect(status).not.toBe("Reading…");
    }
  });

  it("a protocol contract block uses its own title and test ids", () => {
    const { getByTestId } = render(
      <UpgradeStateView
        state={resolveUpgradeState(reads())}
        title="RobotMoneyGateway"
        testId="protocol-upgrade-gateway"
      />,
    );
    expect(getByTestId("protocol-upgrade-gateway").querySelector("h3")?.textContent).toBe(
      "RobotMoneyGateway",
    );
    expect(getByTestId("protocol-upgrade-gateway-implementation").textContent).toBe(IMPLEMENTATION);
  });
});
