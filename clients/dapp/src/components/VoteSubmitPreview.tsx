// Canonical: docs/architecture.md §5.3 — Committee action layer vote-submission flow
// Implements: issue #1054 — vote-submission preview with signalling-only disclosure

/**
 * VoteSubmitPreview — renders the vote-submission preview step for the
 * Investment Committee action layer.
 *
 * Architecture: docs/architecture.md §5.3 specifies:
 *   "The preview must make clear the vote records a tilt and does not move
 *    funds or set weights."
 *
 * This component is always the penultimate step before the wallet signs
 * the committee vote. It surfaces all vote fields that will be submitted
 * on-chain: stance, target_weight_bps, rationale_uri, and the agent_id
 * that will sign, plus a mandatory signalling-only disclosure.
 *
 * The disclosure text must match /signalling.only|does not move funds|does not set.*weights/i
 * per the issue acceptance criteria.
 *
 * Out of scope:
 *   - Actual wallet invocation (handled by the action-layer parent).
 *   - Rationale memo upload / IPFS pinning.
 */

import type { Stance } from "../lib/committeeApi";

// ─── Props ────────────────────────────────────────────────────────────────────

export interface VoteSubmitPreviewProps {
  /** The vault address this vote targets. */
  readonly vault: string;
  /** Allocation stance for this vault. */
  readonly stance: Stance;
  /** Target weight in basis points (0–10000). */
  readonly target_weight_bps: number;
  /** URI pointing to the off-chain rationale memo (JSON). */
  readonly rationale_uri: string;
  /** Confidence level (0–100). */
  readonly confidence: number;
  /** The agent_id that will sign this vote. */
  readonly agent_id: string;
  /** Called when the user clicks "Submit Vote". Wallet invocation is the caller's responsibility. */
  readonly onSubmit: () => void;
  /** Called when the user clicks "Cancel". */
  readonly onCancel: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stanceLabel(stance: Stance): string {
  switch (stance) {
    case "overweight":
      return "Overweight (↑)";
    case "underweight":
      return "Underweight (↓)";
    case "neutral":
      return "Neutral (=)";
    default:
      return stance;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Renders a pre-submission preview of a committee vote.
 * Includes mandatory signalling-only disclosure that matches:
 *   /signalling.only|does not move funds|does not set.*weights/i
 */
export function VoteSubmitPreview(props: VoteSubmitPreviewProps) {
  return (
    <section data-testid="vote-submit-preview">
      <h3>Review Your Committee Vote</h3>

      {/* Mandatory signalling-only disclosure — text must match AC4 regex */}
      <p data-testid="vote-submit-signalling-disclosure">
        This vote is <strong>signalling-only</strong>. It does not move funds and does not set
        router weights directly. Allocation changes require a separate admin action after committee
        signals are reviewed.
      </p>

      <dl data-testid="vote-submit-fields">
        <dt>Agent</dt>
        <dd data-testid="vote-submit-agent-id">{props.agent_id}</dd>

        <dt>Vault</dt>
        <dd data-testid="vote-submit-vault">
          <code>{props.vault}</code>
        </dd>

        <dt>Stance</dt>
        <dd data-testid="vote-submit-stance">{stanceLabel(props.stance)}</dd>

        <dt>Target Weight</dt>
        <dd data-testid="vote-submit-target-weight-bps">
          {props.target_weight_bps} bps ({(props.target_weight_bps / 100).toFixed(2)}%)
        </dd>

        <dt>Confidence</dt>
        <dd data-testid="vote-submit-confidence">{props.confidence}%</dd>

        <dt>Rationale URI</dt>
        <dd>
          <a
            data-testid="vote-submit-rationale-uri"
            href={props.rationale_uri}
            target="_blank"
            rel="noopener noreferrer"
          >
            {props.rationale_uri}
          </a>
        </dd>
      </dl>

      <div data-testid="vote-submit-actions">
        <button type="button" data-testid="vote-submit-cancel" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="button" data-testid="vote-submit-confirm" onClick={props.onSubmit}>
          Submit Vote
        </button>
      </div>
    </section>
  );
}
