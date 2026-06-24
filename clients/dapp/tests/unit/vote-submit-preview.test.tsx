/**
 * VoteSubmitPreview — RTL unit tests (issue #1054 AC4).
 *
 * AC4: clients/dapp Vitest suite exits 0 with a test asserting vote-submission
 * preview renders stance, target_weight_bps, rationale_uri, and text matching
 * /signalling.only|does not move funds|does not set.*weights/i before wallet
 * invocation.
 *
 * Covers:
 *   - Preview renders the signalling-only disclosure matching the AC4 regex.
 *   - Preview renders stance, target_weight_bps, rationale_uri fields.
 *   - Cancel button calls onCancel.
 *   - Submit button calls onSubmit (wallet invocation is caller's responsibility).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "./helpers/render";
import { VoteSubmitPreview } from "../../src/components/VoteSubmitPreview";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const defaultProps = {
  vault: "0x1111111111111111111111111111111111111111",
  stance: "overweight" as const,
  target_weight_bps: 6500,
  rationale_uri: "https://gist.github.com/athena/vote-memo",
  confidence: 90,
  agent_id: "athena-v1",
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("VoteSubmitPreview", () => {
  // ── AC4: signalling-only disclosure ────────────────────────────────────────

  it("renders signalling-only disclosure matching /signalling.only|does not move funds|does not set.*weights/i (AC4)", () => {
    render(<VoteSubmitPreview {...defaultProps} />);
    const disclosure = screen.getByTestId("vote-submit-signalling-disclosure");
    const text = disclosure.textContent ?? "";
    expect(/signalling.only|does not move funds|does not set.*weights/i.test(text)).toBe(true);
  });

  // ── AC4: stance field ──────────────────────────────────────────────────────

  it("renders stance field in preview (AC4)", () => {
    render(<VoteSubmitPreview {...defaultProps} />);
    const stance = screen.getByTestId("vote-submit-stance");
    expect(stance.textContent).toContain("Overweight");
  });

  // ── AC4: target_weight_bps field ──────────────────────────────────────────

  it("renders target_weight_bps field in preview (AC4)", () => {
    render(<VoteSubmitPreview {...defaultProps} />);
    const weight = screen.getByTestId("vote-submit-target-weight-bps");
    expect(weight.textContent).toContain("6500");
  });

  // ── AC4: rationale_uri field ───────────────────────────────────────────────

  it("renders rationale_uri as a link in preview (AC4)", () => {
    render(<VoteSubmitPreview {...defaultProps} />);
    const link = screen.getByTestId("vote-submit-rationale-uri") as HTMLAnchorElement;
    expect(link.href).toBe("https://gist.github.com/athena/vote-memo");
    expect(link.textContent).toContain("https://gist.github.com/athena/vote-memo");
  });

  it("renders vault address in preview", () => {
    render(<VoteSubmitPreview {...defaultProps} />);
    const vault = screen.getByTestId("vote-submit-vault");
    expect(vault.textContent).toContain("0x1111111111");
  });

  it("renders agent_id in preview", () => {
    render(<VoteSubmitPreview {...defaultProps} />);
    const agentId = screen.getByTestId("vote-submit-agent-id");
    expect(agentId.textContent).toBe("athena-v1");
  });

  it("calls onCancel when Cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(<VoteSubmitPreview {...defaultProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId("vote-submit-cancel"));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("calls onSubmit when Submit Vote button is clicked (before wallet invocation)", () => {
    const onSubmit = vi.fn();
    render(<VoteSubmitPreview {...defaultProps} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByTestId("vote-submit-confirm"));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("renders underweight stance correctly", () => {
    render(<VoteSubmitPreview {...defaultProps} stance="underweight" />);
    const stance = screen.getByTestId("vote-submit-stance");
    expect(stance.textContent).toContain("Underweight");
  });

  it("renders neutral stance correctly", () => {
    render(<VoteSubmitPreview {...defaultProps} stance="neutral" />);
    const stance = screen.getByTestId("vote-submit-stance");
    expect(stance.textContent).toContain("Neutral");
  });
});
