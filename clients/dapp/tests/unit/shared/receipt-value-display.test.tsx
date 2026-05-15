/**
 * Unit tests for ReceiptValueDisplay (issue #381 — shared vault UI library).
 *
 * Acceptance criteria exercised:
 *   - Renders receipt token amounts.
 *   - Converts receipt token amounts to USD values when usdcValue is provided.
 *   - Shows dash when usdcValue is not provided.
 *   - Renders custom label.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ReceiptValueDisplay } from "../../../src/components/shared/ReceiptValueDisplay";

describe("ReceiptValueDisplay", () => {
  it("renders receipt token (shares) amount", () => {
    const { getByTestId } = render(<ReceiptValueDisplay shares="1000000" usdcValue="999500" />);
    expect(getByTestId("receipt-value-display-shares").textContent).toBe("1000000");
  });

  it("renders USD value when usdcValue is provided", () => {
    const { getByTestId } = render(<ReceiptValueDisplay shares="2000000" usdcValue="1998000" />);
    expect(getByTestId("receipt-value-display-usdc").textContent).toBe("1998000");
  });

  it("shows dash when usdcValue is not provided", () => {
    const { getByTestId } = render(<ReceiptValueDisplay shares="500000" />);
    expect(getByTestId("receipt-value-display-usdc").textContent).toBe("—");
  });

  it("renders default label 'rmUSDC shares' when label is not provided", () => {
    const { getByTestId } = render(<ReceiptValueDisplay shares="1000000" />);
    expect(getByTestId("receipt-value-display-label").textContent).toBe("rmUSDC shares:");
  });

  it("renders custom label when provided", () => {
    const { getByTestId } = render(
      <ReceiptValueDisplay shares="1000000" label="Vault A balance" />,
    );
    expect(getByTestId("receipt-value-display-label").textContent).toBe("Vault A balance:");
  });

  it("renders USDC unit label", () => {
    const { getByTestId } = render(<ReceiptValueDisplay shares="1000000" usdcValue="1000000" />);
    expect(getByTestId("receipt-value-display-unit").textContent).toBe("USDC");
  });

  it("is rendered in a paragraph element with the display testid", () => {
    const { getByTestId } = render(<ReceiptValueDisplay shares="0" />);
    expect(getByTestId("receipt-value-display").tagName.toLowerCase()).toBe("p");
  });
});
