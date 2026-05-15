import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AboutModal } from "../../src/components/AboutModal";

describe("AboutModal", () => {
  it("renders nothing when closed", () => {
    render(<AboutModal open={false} onClose={vi.fn()} envClass="devnet" />);
    expect(screen.queryByTestId("about-modal-backdrop")).toBeNull();
  });

  it("renders with non-empty commit SHA when VITE_GIT_COMMIT is set in test env", () => {
    render(<AboutModal open onClose={vi.fn()} envClass="devnet" />);

    const commit = screen.getByTestId("about-commit");
    expect(commit.textContent).toBeTruthy();
    expect(commit.textContent).not.toBe("unknown");
    expect(commit.textContent).toBe("test-commit");
  });

  it("renders version, env, and debug link", () => {
    render(<AboutModal open onClose={vi.fn()} envClass="testnet" />);

    expect(screen.getByTestId("about-version")).toHaveTextContent("0.1.0");
    expect(screen.getByTestId("about-env")).toHaveTextContent("testnet");

    const link = screen.getByTestId("about-debug-link");
    expect(link).toHaveAttribute("href", "/debug");
  });

  it("does not render contract addresses or chain diagnostics", () => {
    render(<AboutModal open onClose={vi.fn()} envClass="fork" />);

    // The modal must not leak chain diagnostics or contract data.
    expect(screen.queryByText(/0x0000/i)).toBeNull();
    expect(screen.queryByText(/chainId/i)).toBeNull();
    expect(screen.queryByText(/gateway/i)).toBeNull();
  });

  it("calls onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    render(<AboutModal open onClose={onClose} envClass="fork" />);

    screen.getByTestId("about-modal-close").click();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
