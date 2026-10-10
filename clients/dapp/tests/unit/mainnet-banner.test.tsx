// The mainnet banner renders on the mainnet class only (issue 1729).
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MainnetBanner } from "../../src/components/MainnetBanner";
import { TestnetBanner } from "../../src/components/TestnetBanner";

describe("MainnetBanner", () => {
  it("shows the chain name and id, with no way to dismiss it", () => {
    render(<MainnetBanner envClass="mainnet" />);
    const banner = screen.getByTestId("mainnet-banner");
    expect(banner).toHaveTextContent("Base mainnet");
    expect(banner).toHaveTextContent("real funds");
    expect(banner).toHaveTextContent("chain 8453");
    expect(banner.querySelector("button, [role=button], a")).toBeNull();
  });

  it.each(["fork", "devnet", "testnet"] as const)("does not render on %s", (envClass) => {
    render(<MainnetBanner envClass={envClass} />);
    expect(screen.queryByTestId("mainnet-banner")).toBeNull();
  });

  it("leaves the testnet banner unchanged: shown off mainnet, hidden on mainnet", () => {
    const { unmount } = render(<TestnetBanner envClass="fork" />);
    expect(screen.getByTestId("testnet-banner")).toBeInTheDocument();
    unmount();
    render(<TestnetBanner envClass="mainnet" />);
    expect(screen.queryByTestId("testnet-banner")).toBeNull();
  });
});
