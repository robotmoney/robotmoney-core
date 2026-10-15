/**
 * Issue 1810 — the dapp's gateway verifier and upgrade disclosure.
 *
 * The gateway is an ERC-1967 proxy. Its own code (and so the pinned
 * `VITE_GATEWAY_EXPECTED_CODE_HASH`) never changes on an upgrade, so the
 * verifier also checks the live implementation slot against the build-time
 * implementation pin. These tests keep the proxy code fixed and swap what the
 * slot names, and assert:
 *   - the pure rule (`computeGatewayVerification`) refuses every unapproved or
 *     unreadable implementation and verifies the pinned one;
 *   - the reader (`verifyGatewayAt`) makes every read at ONE block and refuses
 *     a swapped implementation through a fake EIP-1193 provider;
 *   - `GatewayUpgradeStatus` renders the implementation and the freeze state.
 */
import { describe, it, expect } from "vitest";
import { encodeAbiParameters, encodeFunctionData, keccak256, type Hex } from "viem";
import { GOVERNED_UUPS_ABI } from "../../src/lib/abi";
import { render } from "./helpers/render";
import {
  computeGatewayVerification,
  ERC1967_IMPLEMENTATION_SLOT,
  implementationFromSlot,
  type VerificationState,
} from "../../src/lib/gatewayVerifier";
import { verifyGatewayAt, type Eip1193Provider } from "../../src/lib/useGatewayVerifier";
import { GatewayUpgradeStatus } from "../../src/components/GatewayUpgradeStatus";

const GATEWAY = "0x1111111111111111111111111111111111111111";
const PROXY_CODE = "0x6080604052deadbeef" as const;
const PROXY_HASH = keccak256(PROXY_CODE);
const IMPL_A = "0x00000000000000000000000000000000000a11ce";
const IMPL_B = "0x00000000000000000000000000000000000b0b00";
const IMPL_A_CODE = "0x600160aa" as const;
const IMPL_B_CODE = "0x600160bb" as const;
const PIN = { address: IMPL_A, hash: keccak256(IMPL_A_CODE) };
const TIMELOCK = "0x00000000000000000000000000000000071e1000";

const slotOf = (addr: string): Hex =>
  `0x${addr.toLowerCase().replace(/^0x/, "").padStart(64, "0")}` as Hex;
const EMPTY_SLOT = slotOf("0x0");

function detail(s: VerificationState): string {
  return s.status === "refused" ? (s.detail ?? "") : "";
}

describe("implementationFromSlot", () => {
  it("decodes an address word, an empty slot and a non-address word", () => {
    expect(implementationFromSlot(slotOf(IMPL_A))).toBe(IMPL_A);
    expect(implementationFromSlot(EMPTY_SLOT)).toBeNull();
    expect(implementationFromSlot(`0x${"ff".repeat(32)}`)).toBeUndefined();
  });
});

describe("computeGatewayVerification (issue 1810)", () => {
  it("verifies the pinned implementation and reports it with its code hash", () => {
    const s = computeGatewayVerification(
      GATEWAY,
      PROXY_HASH,
      PROXY_CODE,
      PIN,
      slotOf(IMPL_A),
      IMPL_A_CODE,
    );
    expect(s.status).toBe("verified");
    if (s.status === "verified") {
      expect(s.implementation).toBe(IMPL_A);
      expect(s.implementationCodeHash).toBe(PIN.hash);
    }
  });

  it("refuses a swapped implementation while the proxy code hash still matches", () => {
    const s = computeGatewayVerification(
      GATEWAY,
      PROXY_HASH,
      PROXY_CODE,
      PIN,
      slotOf(IMPL_B),
      IMPL_B_CODE,
    );
    expect(s.status).toBe("refused");
    expect(detail(s)).toContain(IMPL_B);
  });

  it("refuses the pinned address when its code hash differs", () => {
    const s = computeGatewayVerification(
      GATEWAY,
      PROXY_HASH,
      PROXY_CODE,
      PIN,
      slotOf(IMPL_A),
      IMPL_B_CODE,
    );
    expect(s.status).toBe("refused");
    expect(detail(s)).toContain("code hash");
  });

  it("refuses a proxy when no implementation is pinned", () => {
    const s = computeGatewayVerification(
      GATEWAY,
      PROXY_HASH,
      PROXY_CODE,
      {},
      slotOf(IMPL_A),
      IMPL_A_CODE,
    );
    expect(s.status).toBe("refused");
  });

  it("refuses a pinned implementation on a gateway that is not a proxy", () => {
    const s = computeGatewayVerification(
      GATEWAY,
      PROXY_HASH,
      PROXY_CODE,
      PIN,
      EMPTY_SLOT,
      undefined,
    );
    expect(s.status).toBe("refused");
  });

  it("verifies a direct gateway with nothing pinned", () => {
    const s = computeGatewayVerification(
      GATEWAY,
      PROXY_HASH,
      PROXY_CODE,
      {},
      EMPTY_SLOT,
      undefined,
    );
    expect(s.status).toBe("verified");
    if (s.status === "verified") expect(s.implementation).toBeNull();
  });

  it("refuses a failed slot read, a non-address slot, a half pin and an implementation with no code", () => {
    expect(
      computeGatewayVerification(GATEWAY, PROXY_HASH, PROXY_CODE, PIN, null, undefined).status,
    ).toBe("refused");
    expect(
      computeGatewayVerification(
        GATEWAY,
        PROXY_HASH,
        PROXY_CODE,
        PIN,
        `0x${"ff".repeat(32)}`,
        undefined,
      ).status,
    ).toBe("refused");
    expect(
      computeGatewayVerification(
        GATEWAY,
        PROXY_HASH,
        PROXY_CODE,
        { address: IMPL_A },
        slotOf(IMPL_A),
        IMPL_A_CODE,
      ).status,
    ).toBe("refused");
    expect(
      computeGatewayVerification(GATEWAY, PROXY_HASH, PROXY_CODE, PIN, slotOf(IMPL_A), "0x").status,
    ).toBe("refused");
  });

  it("is pending while the slot or the implementation code is in flight", () => {
    expect(
      computeGatewayVerification(GATEWAY, PROXY_HASH, PROXY_CODE, PIN, undefined, undefined).status,
    ).toBe("pending");
    expect(
      computeGatewayVerification(GATEWAY, PROXY_HASH, PROXY_CODE, PIN, slotOf(IMPL_A), undefined)
        .status,
    ).toBe("pending");
  });

  it("still refuses on a proxy code hash mismatch before looking at the slot", () => {
    const s = computeGatewayVerification(
      GATEWAY,
      `0x${"ab".repeat(32)}`,
      PROXY_CODE,
      PIN,
      slotOf(IMPL_A),
      IMPL_A_CODE,
    );
    expect(s.status).toBe("refused");
  });
});

/** A fake injected provider over a fixed chain state, recording every request. */
function fakeProvider(opts: {
  slot: Hex;
  frozen?: boolean;
  failSlot?: boolean;
}): Eip1193Provider & { calls: { method: string; params?: unknown[] }[] } {
  const BLOCK = "0x2a";
  const calls: { method: string; params?: unknown[] }[] = [];
  const codes: Record<string, Hex> = {
    [GATEWAY]: PROXY_CODE,
    [IMPL_A]: IMPL_A_CODE,
    [IMPL_B]: IMPL_B_CODE,
  };
  return {
    calls,
    request: async ({ method, params }) => {
      calls.push({ method, params });
      if (method === "eth_blockNumber") return BLOCK;
      const tag = params?.[params.length - 1];
      if (tag !== BLOCK) throw new Error(`read at ${String(tag)}, not the pinned block`);
      if (method === "eth_getCode") return codes[String(params?.[0]).toLowerCase()] ?? "0x";
      if (method === "eth_getStorageAt") {
        if (opts.failSlot) throw new Error("missing trie node");
        expect(params?.[1]).toBe(ERC1967_IMPLEMENTATION_SLOT);
        return opts.slot;
      }
      if (method === "eth_call") {
        const data = String((params?.[0] as { data: string }).data);
        const timelockSel = encodeFunctionData({
          abi: GOVERNED_UUPS_ABI,
          functionName: "upgradeTimelock",
        });
        return data === timelockSel
          ? encodeAbiParameters([{ type: "address" }], [TIMELOCK])
          : encodeAbiParameters([{ type: "bool" }], [opts.frozen ?? false]);
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

describe("verifyGatewayAt (issue 1810)", () => {
  it("reads everything at one block and refuses a swapped implementation", async () => {
    const p = fakeProvider({ slot: slotOf(IMPL_B) });
    const s = await verifyGatewayAt(p, GATEWAY, PROXY_HASH, PIN);
    expect(s.status).toBe("refused");
    expect(detail(s)).toContain(IMPL_B);
    expect(p.calls[0].method).toBe("eth_blockNumber");
    expect(p.calls.filter((c) => c.method === "eth_blockNumber")).toHaveLength(1);
  });

  it("verifies the pinned implementation and reads the freeze state", async () => {
    const p = fakeProvider({ slot: slotOf(IMPL_A), frozen: true });
    const s = await verifyGatewayAt(p, GATEWAY, PROXY_HASH, PIN);
    expect(s.status).toBe("verified");
    if (s.status === "verified") {
      expect(s.implementation).toBe(IMPL_A);
      expect(s.upgradesFrozen).toBe(true);
    }
  });

  it("throws on a failed slot read, so the hook retries and then refuses", async () => {
    const p = fakeProvider({ slot: slotOf(IMPL_A), failSlot: true });
    await expect(verifyGatewayAt(p, GATEWAY, PROXY_HASH, PIN)).rejects.toThrow(/trie/);
  });
});

describe("GatewayUpgradeStatus (issue 1810)", () => {
  const verified = (
    extra: Partial<Extract<VerificationState, { status: "verified" }>>,
  ): VerificationState => ({ status: "verified", computedHash: PROXY_HASH, ...extra });

  it("renders the implementation and a permanent freeze", () => {
    const { getByTestId } = render(
      <GatewayUpgradeStatus state={verified({ implementation: IMPL_A, upgradesFrozen: true })} />,
    );
    expect(getByTestId("gateway-implementation").textContent).toBe(IMPL_A);
    expect(getByTestId("gateway-upgrade-status").getAttribute("data-upgrade-state")).toBe("frozen");
    expect(getByTestId("gateway-freeze-state").textContent).toContain("permanently frozen");
  });

  it("renders an upgradeable gateway with its timelock", () => {
    const { getByTestId } = render(
      <GatewayUpgradeStatus
        state={verified({
          implementation: IMPL_A,
          upgradesFrozen: false,
          upgradeTimelock: TIMELOCK,
        })}
      />,
    );
    expect(getByTestId("gateway-upgrade-status").getAttribute("data-upgrade-state")).toBe(
      "upgradeable",
    );
    expect(getByTestId("gateway-freeze-state").textContent).toContain(TIMELOCK);
  });

  it("says unknown, never frozen, when the freeze state was not read", () => {
    const { getByTestId } = render(
      <GatewayUpgradeStatus state={verified({ implementation: IMPL_A })} />,
    );
    expect(getByTestId("gateway-upgrade-status").getAttribute("data-upgrade-state")).toBe(
      "unknown",
    );
  });

  it("renders a direct gateway as not upgradeable", () => {
    const { getByTestId } = render(
      <GatewayUpgradeStatus state={verified({ implementation: null })} />,
    );
    expect(getByTestId("gateway-upgrade-status").getAttribute("data-upgrade-state")).toBe("direct");
  });

  it("renders nothing before verification passes", () => {
    const { container } = render(
      <GatewayUpgradeStatus
        state={{ status: "refused", reason: "unknown_revert", cause: "hash-mismatch" }}
      />,
    );
    expect(container.querySelector('[data-testid="gateway-upgrade-status"]')).toBeNull();
  });
});
