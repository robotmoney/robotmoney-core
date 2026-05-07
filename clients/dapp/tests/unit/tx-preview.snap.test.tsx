/**
 * Snapshot test: each admin action's preview component renders
 * target + calldata decode + role/policy effect from a fixture.
 *
 * Covers the test plan item:
 *   "Snapshot test asserts each admin action's preview component
 *    renders target + calldata decode + role/policy effect from a
 *    fixture."
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TxPreview } from "../../src/components/TxPreview";
import { buildPreview, type AdminAction, type PreviewContext } from "../../src/lib/preview";

const gateway = "0x1111111111111111111111111111111111111111" as const;
const agent = "0x2222222222222222222222222222222222222222" as const;
const receiver = "0x3333333333333333333333333333333333333333" as const;

const ctx: PreviewContext = {
  gateway,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

const fixtures: { name: string; action: AdminAction }[] = [
  {
    name: "authorizeAgent",
    action: {
      kind: "authorizeAgent",
      agent,
      policy: {
        active: true,
        validUntil: 1893456000n,
        maxPerPayment: 100_000_000n,
        maxPerWindow: 500_000_000n,
        shareReceiver: receiver,
      },
    },
  },
  { name: "revokeAgent", action: { kind: "revokeAgent", agent } },
  { name: "pause", action: { kind: "pause" } },
  { name: "unpause", action: { kind: "unpause" } },
];

describe("TxPreview snapshot per admin action", () => {
  for (const { name, action } of fixtures) {
    it(`renders required preview fields for ${name}`, () => {
      const preview = buildPreview(action, ctx);
      const { getByTestId, queryByTestId } = render(<TxPreview preview={preview} />);
      // target + calldata decode + role/policy effect — the three
      // mandatory fields enumerated by the test plan.
      expect(getByTestId("tx-preview-target").textContent).toContain(gateway);
      expect(getByTestId("tx-preview-effect").textContent).toBeTruthy();
      expect(getByTestId("tx-preview-calldata").textContent).toMatch(/^0x[0-9a-f]+$/);
      expect(getByTestId("tx-preview-fn").textContent).toBe(action.kind);
      expect(queryByTestId("refusal-reason")).toBeNull();
    });
  }

  it("refuses on unverified bytecode and exposes no signing CTA", () => {
    const preview = buildPreview(fixtures[0].action, { ...ctx, gatewayCodeHashVerified: false });
    const { getByTestId, queryByTestId } = render(<TxPreview preview={preview} />);
    expect(getByTestId("refusal-reason").textContent).toMatch(/bytecode/i);
    expect(queryByTestId("tx-preview-fn")).toBeNull();
  });
});
