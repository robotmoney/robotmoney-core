// Canonical: docs/architecture.md §5.3 — Human Dapp

/**
 * NavDisclosure — the PRD's NAV disclaimer as one shared component (QA plan X8, finding F4).
 *
 * docs/prd.md §3 ("NAV disclosure") and §9 ("NAV disclosure in UIs") require every surface that
 * shows a NAV-derived number (position value, preview estimates, performance metrics) to carry
 * this exact text. The text lives here once, so every surface shows the same words and a test can
 * pin them to the PRD.
 *
 * Rendered by the position card (`VaultPositionCard`) whenever it shows a USDC value, and once
 * under the portfolio table (`PortfolioPosition`).
 *
 * docs/architecture.md §5.3 — shared vault UI library.
 */

/** The disclaimer, verbatim from docs/prd.md §9 "NAV disclosure in UIs". */
export const NAV_DISCLOSURE_TEXT =
  "NAV is the protocol's system-level valuation, used for growth limits and guards. Your share value = market price of underlying assets. See help for details.";

export interface NavDisclosureProps {
  /** `data-testid` of the note; defaults to "nav-disclosure". */
  readonly testId?: string;
}

/** The NAV disclaimer as a small note under a NAV-derived number. */
export function NavDisclosure({ testId = "nav-disclosure" }: NavDisclosureProps) {
  return (
    <p className="hint nav-disclosure" role="note" data-testid={testId}>
      {NAV_DISCLOSURE_TEXT}
    </p>
  );
}
