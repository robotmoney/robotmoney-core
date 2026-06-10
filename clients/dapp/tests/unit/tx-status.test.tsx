// Canonical: docs/technical/security-model.md §12 — Off-chain chain & infrastructure
//
// TxStatus surfaces the per-operation-class finality distinction from
// `rmpc get-tx` JSON output (issue #676): "L2 included" vs "L1 finalized".

import { render, screen } from "./helpers/render";
import { describe, expect, it } from "vitest";
import { TxStatus, type FinalityInfo } from "../../src/components/TxStatus";

function finality(overrides: Partial<FinalityInfo> = {}): FinalityInfo {
  return {
    status: "pending",
    confirmations: 0,
    required_confirmations: 1,
    op_class: "deposit",
    ...overrides,
  };
}

describe("TxStatus", () => {
  it("renders 'L2 included' for an l2_included finality status", () => {
    render(
      <TxStatus
        finality={finality({
          status: "l2_included",
          confirmations: 1,
          required_confirmations: 64,
          op_class: "admin_governance",
        })}
      />,
    );

    expect(screen.getByTestId("tx-status-l2-included")).toHaveTextContent("L2 included");
    expect(screen.getByTestId("tx-status-confirmations")).toHaveTextContent("1/64 confirmations");
    expect(screen.queryByTestId("tx-status-l1-finalized")).toBeNull();
  });

  it("renders 'L1 finalized' for an l1_finalized finality status", () => {
    render(
      <TxStatus
        finality={finality({
          status: "l1_finalized",
          confirmations: 64,
          required_confirmations: 64,
          op_class: "admin_governance",
        })}
      />,
    );

    expect(screen.getByTestId("tx-status-l1-finalized")).toHaveTextContent("L1 finalized");
    expect(screen.getByTestId("tx-status-confirmations")).toHaveTextContent("64/64 confirmations");
    expect(screen.queryByTestId("tx-status-l2-included")).toBeNull();
  });

  it("renders 'Pending finality' below the class minimum", () => {
    render(<TxStatus finality={finality()} />);

    expect(screen.getByTestId("tx-status-pending")).toHaveTextContent("Pending finality");
    expect(screen.getByTestId("tx-status-confirmations")).toHaveTextContent("0/1 confirmations");
  });

  it("distinguishes L2-included from L1-finalized copy", () => {
    const { unmount } = render(<TxStatus finality={finality({ status: "l2_included" })} />);
    const l2Copy = screen.getByTestId("tx-status-description").textContent;
    unmount();

    render(<TxStatus finality={finality({ status: "l1_finalized" })} />);
    const l1Copy = screen.getByTestId("tx-status-description").textContent;

    expect(l2Copy).toBeTruthy();
    expect(l1Copy).toBeTruthy();
    expect(l2Copy).not.toBe(l1Copy);
    expect(l1Copy).toMatch(/irreversible/i);
  });
});
