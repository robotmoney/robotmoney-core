/**
 * Snapshot test — pause / unpause TxPreview rendering.
 *
 * Covers issue #82 acceptance criterion:
 *   "Vitest unit tests snapshot the preview component output for both
 *    pause and unpause inputs."
 *
 * Asserts:
 *   - The structured preview block renders with target, selector,
 *     decoded effect, and (collapsed) calldata.
 *   - The encoded calldata equals the well-known 4-byte selector for
 *     pause()/unpause() — guarantees the dapp signs exactly the bytes
 *     the operator expects.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { encodeFunctionData, toFunctionSelector } from "viem";
import { TxPreview } from "../../src/components/TxPreview";
import { gatewayAbi } from "../../src/lib/abi";
import { buildPreview, type AdminAction, type PreviewContext } from "../../src/lib/preview";

const gateway = "0x1111111111111111111111111111111111111111" as const;

const ctx: PreviewContext = {
  gateway,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

const cases: { name: "pause" | "unpause"; action: AdminAction }[] = [
  { name: "pause", action: { kind: "pause" } },
  { name: "unpause", action: { kind: "unpause" } },
];

describe("TxPreview snapshot — pause/unpause", () => {
  for (const { name, action } of cases) {
    it(`renders structured preview for ${name}`, () => {
      const preview = buildPreview(action, ctx);
      const { getByTestId, queryByTestId } = render(<TxPreview preview={preview} />);

      // Structured fields exist.
      expect(getByTestId("tx-preview-target").textContent).toContain(gateway);
      expect(getByTestId("tx-preview-fn").textContent).toBe(name);
      expect(getByTestId("tx-preview-effect").textContent).toBeTruthy();
      expect(queryByTestId("refusal-reason")).toBeNull();

      // Selector matches the canonical 4-byte function selector.
      const fn = gatewayAbi.find((e) => e.type === "function" && e.name === name);
      const expectedSelector = toFunctionSelector(fn as never);
      expect(getByTestId("tx-preview-selector").textContent).toBe(expectedSelector);

      // Calldata equals the encoder output for the intended call. For
      // pause()/unpause() the calldata is exactly the 4-byte selector
      // (no args), so this is a strict equality check.
      const expectedCalldata = encodeFunctionData({
        abi: gatewayAbi,
        functionName: name,
        args: [],
      });
      expect(getByTestId("tx-preview-calldata").textContent).toBe(expectedCalldata);
      expect(expectedCalldata).toBe(expectedSelector);
    });

    it(`refuses ${name} when bytecode is unverified`, () => {
      const preview = buildPreview(action, { ...ctx, gatewayCodeHashVerified: false });
      const { getByTestId, queryByTestId } = render(<TxPreview preview={preview} />);
      expect(getByTestId("refusal-reason").textContent).toMatch(/bytecode/i);
      expect(queryByTestId("tx-preview-fn")).toBeNull();
    });
  }
});
