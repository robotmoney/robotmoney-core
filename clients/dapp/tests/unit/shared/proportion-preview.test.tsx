/**
 * Unit tests for ProportionPreview (issue #381 — shared vault UI library).
 *
 * Acceptance criteria exercised:
 *   - Renders vault split proportions for each leg given a mocked
 *     router calldata-preview response.
 *   - Shows weight percentages.
 *   - Marks unavailable legs with ⚠ UNAVAILABLE status.
 *   - Renders "no legs" placeholder when legs array is empty.
 */
import { describe, it, expect } from "vitest";
import { render } from "../helpers/render";
import { ProportionPreview } from "../../../src/components/shared/ProportionPreview";
import type { LegPreview } from "../../../src/lib/routerPreview";

const VAULT_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const VAULT_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;

const twoLegs: LegPreview[] = [
  {
    vault: VAULT_A,
    weightBps: 6000n,
    legAmount: 600000n,
    estShares: 590000n,
    unavailable: false,
  },
  {
    vault: VAULT_B,
    weightBps: 4000n,
    legAmount: 400000n,
    estShares: 395000n,
    unavailable: false,
  },
];

describe("ProportionPreview", () => {
  it("renders a table when legs are provided", () => {
    const { getByTestId } = render(<ProportionPreview legs={twoLegs} />);
    expect(getByTestId("proportion-preview-table")).toBeTruthy();
  });

  it("renders one row per leg", () => {
    const { getByTestId } = render(<ProportionPreview legs={twoLegs} />);
    expect(getByTestId("proportion-preview-row-0")).toBeTruthy();
    expect(getByTestId("proportion-preview-row-1")).toBeTruthy();
  });

  it("renders correct weight percentages from mocked router calldata-preview response", () => {
    const { getByTestId } = render(<ProportionPreview legs={twoLegs} />);
    // 6000 bps = 60%
    expect(getByTestId("proportion-preview-weight-0").textContent).toBe("60.00%");
    // 4000 bps = 40%
    expect(getByTestId("proportion-preview-weight-1").textContent).toBe("40.00%");
  });

  it("renders USDC leg amounts via the centralized formatter", () => {
    const { getByTestId } = render(<ProportionPreview legs={twoLegs} />);
    // 600000 base units = 0.6 USDC (trailing zeros stripped by centralized formatter)
    expect(getByTestId("proportion-preview-usdc-0").textContent).toBe("0.6 USDC");
    expect(getByTestId("proportion-preview-usdc-1").textContent).toBe("0.4 USDC");
  });

  it("renders estimated shares for available legs via the centralized formatter", () => {
    const { getByTestId } = render(<ProportionPreview legs={twoLegs} />);
    // 590000 base units = 0.59 shares (trailing zeros stripped)
    expect(getByTestId("proportion-preview-shares-0").textContent).toBe("0.59 shares");
  });

  it("shows ⚠ UNAVAILABLE status for unavailable legs", () => {
    const legsWithUnavailable: LegPreview[] = [{ ...twoLegs[0], unavailable: true }, twoLegs[1]];
    const { getByTestId } = render(<ProportionPreview legs={legsWithUnavailable} />);
    expect(getByTestId("proportion-preview-status-0").textContent).toContain("UNAVAILABLE");
    expect(getByTestId("proportion-preview-status-1").textContent).toBe("Active");
  });

  it("shows dash for shares of unavailable leg", () => {
    const legsWithUnavailable: LegPreview[] = [{ ...twoLegs[0], unavailable: true }];
    const { getByTestId } = render(<ProportionPreview legs={legsWithUnavailable} />);
    expect(getByTestId("proportion-preview-shares-0").textContent).toBe("—");
  });

  it("shows empty placeholder when legs array is empty", () => {
    const { getByTestId, queryByTestId } = render(<ProportionPreview legs={[]} />);
    expect(getByTestId("proportion-preview-empty")).toBeTruthy();
    expect(queryByTestId("proportion-preview-table")).toBeNull();
  });
});
