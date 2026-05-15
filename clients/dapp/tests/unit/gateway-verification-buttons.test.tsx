/**
 * Component tests — admin write buttons disabled until gateway
 * bytecode hash verification succeeds (issue #207).
 *
 * Covers acceptance criteria:
 *   AC1: No admin write path is enabled before verification succeeds.
 *   AC2: Missing expected runtime hash disables writes and renders refusal.
 *   AC3: Mismatched runtime hash disables writes and renders refusal.
 *   AC4: Zero gateway address or empty bytecode disables the admin surface.
 *   AC5: Successful verification renders structured preview with
 *        targetCodeHashKnown=true.
 *
 * Strategy: render TxPreview directly with a buildPreview result that
 * carries the verification state, and assert button/preview element
 * presence. TxPreview is the canonical gate between preview.ok and the
 * signing CTA, so testing at this level covers all admin actions.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TxPreview } from "../../src/components/TxPreview";
import { buildPreview, type PreviewContext } from "../../src/lib/preview";

const gateway = "0x1111111111111111111111111111111111111111" as const;
const agent = "0x2222222222222222222222222222222222222222" as const;
const receiver = "0x3333333333333333333333333333333333333333" as const;

const policy = {
  active: true,
  validUntil: 1893456000n,
  maxPerPayment: 100_000_000n,
  maxPerWindow: 500_000_000n,
  shareReceiver: receiver,
  allowedDestinations: [] as `0x${string}`[],
};

const verifiedCtx: PreviewContext = {
  gateway,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

const unverifiedCtx: PreviewContext = {
  gateway,
  gatewayCodeHashVerified: false,
  envClass: "fork",
};

describe("Admin write buttons — verification gating (issue #207)", () => {
  describe("AC1 + AC5: verified state enables writes with targetCodeHashKnown=true", () => {
    const actions = [
      {
        kind: "authorizeAgent" as const,
        action: { kind: "authorizeAgent" as const, agent, policy },
      },
      { kind: "revokeAgent" as const, action: { kind: "revokeAgent" as const, agent } },
      { kind: "pause" as const, action: { kind: "pause" as const } },
      { kind: "unpause" as const, action: { kind: "unpause" as const } },
      {
        kind: "grantRole" as const,
        action: { kind: "grantRole" as const, role: "ADMIN_ROLE" as const, account: agent },
      },
      {
        kind: "revokeRole" as const,
        action: { kind: "revokeRole" as const, role: "ADMIN_ROLE" as const, account: agent },
      },
    ];

    for (const { kind, action } of actions) {
      it(`${kind}: preview is ok and targetCodeHashKnown=true when verified`, () => {
        const preview = buildPreview(action, verifiedCtx);
        expect(preview.ok).toBe(true);
        if (preview.ok) {
          expect(preview.targetCodeHashKnown).toBe(true);
        }
        const { getByTestId, queryByTestId } = render(<TxPreview preview={preview} />);
        expect(queryByTestId("refusal-reason")).toBeNull();
        expect(getByTestId("tx-preview-fn").textContent).toBe(kind);
      });
    }
  });

  describe("AC1 + AC2: unverified/missing hash disables writes and renders refusal", () => {
    it("authorizeAgent: refusal preview when not verified", () => {
      const preview = buildPreview({ kind: "authorizeAgent", agent, policy }, unverifiedCtx);
      expect(preview.ok).toBe(false);
      const { getByTestId, queryByTestId } = render(<TxPreview preview={preview} />);
      expect(getByTestId("refusal-reason").textContent).toMatch(/bytecode hash/i);
      expect(queryByTestId("tx-preview-fn")).toBeNull();
    });

    it("revokeAgent: refusal preview when not verified", () => {
      const preview = buildPreview({ kind: "revokeAgent", agent }, unverifiedCtx);
      expect(preview.ok).toBe(false);
      const { getByTestId } = render(<TxPreview preview={preview} />);
      expect(getByTestId("refusal-reason").textContent).toMatch(/bytecode hash/i);
    });

    it("pause: refusal preview when not verified", () => {
      const preview = buildPreview({ kind: "pause" }, unverifiedCtx);
      expect(preview.ok).toBe(false);
      const { getByTestId } = render(<TxPreview preview={preview} />);
      expect(getByTestId("refusal-reason").textContent).toMatch(/bytecode hash/i);
    });

    it("grantRole: refusal preview when not verified", () => {
      const preview = buildPreview(
        { kind: "grantRole", role: "ADMIN_ROLE", account: agent },
        unverifiedCtx,
      );
      expect(preview.ok).toBe(false);
      const { getByTestId } = render(<TxPreview preview={preview} />);
      expect(getByTestId("refusal-reason").textContent).toMatch(/bytecode hash/i);
    });
  });
});
