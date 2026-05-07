/**
 * Snapshot test — TxPreview output for role grant + revoke for
 * ADMIN_ROLE and PAUSER_ROLE (issue #83 acceptance criterion 2).
 *
 * Four snapshots, one per role × {grant, revoke}. Each snapshot pins
 * the structured preview block (target, selector, decoded args,
 * role-policy effect, risk class, calldata) per ADR §3.3.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { TxPreview } from "../../src/components/TxPreview";
import { buildPreview, type AdminAction, type PreviewContext } from "../../src/lib/preview";
import type { RoleName } from "../../src/lib/abi";

const gateway = "0x1111111111111111111111111111111111111111" as const;
const account = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

const ctx: PreviewContext = {
  gateway,
  gatewayCodeHashVerified: true,
  envClass: "fork",
};

interface Case {
  label: string;
  action: AdminAction;
}

const cases: Case[] = [
  { label: "grant ADMIN_ROLE", action: { kind: "grantRole", role: "ADMIN_ROLE", account } },
  { label: "revoke ADMIN_ROLE", action: { kind: "revokeRole", role: "ADMIN_ROLE", account } },
  { label: "grant PAUSER_ROLE", action: { kind: "grantRole", role: "PAUSER_ROLE", account } },
  { label: "revoke PAUSER_ROLE", action: { kind: "revokeRole", role: "PAUSER_ROLE", account } },
];

describe("TxPreview snapshots — role grant/revoke (issue #83)", () => {
  for (const { label, action } of cases) {
    it(`renders structured preview for ${label}`, () => {
      const preview = buildPreview(action, ctx);
      const { container, getByTestId } = render(<TxPreview preview={preview} />);

      // Cross-check the load-bearing fields before snapshotting so a
      // future preview-shape regression fails with a clear message and
      // the snapshot diff is the secondary signal.
      expect(preview.ok).toBe(true);
      const fnName = action.kind; // "grantRole" or "revokeRole"
      expect(getByTestId("tx-preview-fn").textContent).toBe(fnName);
      expect(getByTestId("tx-preview-target").textContent).toContain(gateway);
      // Effect mentions the role enum string.
      const role = (action as { role: RoleName }).role;
      expect(getByTestId("tx-preview-effect").textContent).toContain(role);
      // Calldata is hex, matches encoder output (asserted in unit/preview).
      expect(getByTestId("tx-preview-calldata").textContent).toMatch(/^0x[0-9a-f]+$/);

      expect(container.innerHTML).toMatchSnapshot();
    });
  }
});
