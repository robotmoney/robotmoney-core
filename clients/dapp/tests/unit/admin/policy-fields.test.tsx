/**
 * Unit tests — PolicyFields component (issue #254).
 *
 * Focus: `testIdPrefix` correctly namespaces input data-testids.
 * PolicyFields is a pure presentational component — no wagmi required.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "../helpers/render";
import { PolicyFields } from "../../../src/components/PolicyFields";

const noop = vi.fn();

const baseProps = {
  validUntil: "1893456000",
  setValidUntil: noop,
  maxPerPayment: "100000000",
  setMaxPerPayment: noop,
  maxPerWindow: "1000000000",
  setMaxPerWindow: noop,
  shareReceiver: "",
  setShareReceiver: noop,
};

describe("PolicyFields — testIdPrefix namespacing", () => {
  it("uses unprefixed testids when no testIdPrefix is supplied", () => {
    render(<PolicyFields {...baseProps} />);
    expect(screen.getByTestId("validUntil-input")).toBeInTheDocument();
    expect(screen.getByTestId("maxPerPayment-input")).toBeInTheDocument();
    expect(screen.getByTestId("maxPerWindow-input")).toBeInTheDocument();
    expect(screen.getByTestId("shareReceiver-input")).toBeInTheDocument();
  });

  it("prepends testIdPrefix to every input testid", () => {
    render(<PolicyFields {...baseProps} testIdPrefix="rotation-" />);
    expect(screen.getByTestId("rotation-validUntil-input")).toBeInTheDocument();
    expect(screen.getByTestId("rotation-maxPerPayment-input")).toBeInTheDocument();
    expect(screen.getByTestId("rotation-maxPerWindow-input")).toBeInTheDocument();
    expect(screen.getByTestId("rotation-shareReceiver-input")).toBeInTheDocument();
  });

  it("no unprefixed ids are present when prefix is set", () => {
    render(<PolicyFields {...baseProps} testIdPrefix="rotation-" />);
    expect(screen.queryByTestId("validUntil-input")).toBeNull();
    expect(screen.queryByTestId("shareReceiver-input")).toBeNull();
  });
});
