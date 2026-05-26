// Canonical: docs/architecture.md §7.1 — Previews

/**
 * TxPreview component — renders the structured preview block defined
 * in docs/technical/dapp-credential-decisions.md §3.3.
 *
 * If `preview.ok` is false, the wallet button MUST be disabled. The
 * caller (action form) reads `preview.ok` to gate the signing CTA.
 */
import type { Preview, RiskClass } from "../lib/preview";

const RISK_COLOR: Record<RiskClass, string> = {
  low: "#2e7d32",
  medium: "#ed6c02",
  high: "#d32f2f",
  unsafe: "#7b1fa2",
};

export function TxPreview({ preview }: { preview: Preview }) {
  if (!preview.ok) {
    return (
      <section data-testid="tx-preview" data-ok="false" className="tx-preview tx-preview--refusal">
        <h3>Refusing to sign</h3>
        <p data-testid="refusal-reason">{preview.reason}</p>
        {preview.calldata && (
          <details>
            <summary>Raw calldata (for external verification only)</summary>
            <code data-testid="raw-calldata">{preview.calldata}</code>
          </details>
        )}
      </section>
    );
  }

  return (
    <section data-testid="tx-preview" data-ok="true" className="tx-preview">
      <header>
        <h3 data-testid="tx-preview-fn">{preview.functionName}</h3>
        <span
          data-testid="tx-preview-risk"
          style={{ background: RISK_COLOR[preview.risk], color: "white", padding: "2px 8px" }}
        >
          {preview.risk.toUpperCase()}
        </span>
      </header>

      <dl>
        <dt>Target</dt>
        <dd data-testid="tx-preview-target">
          {preview.target}{" "}
          <span data-testid="tx-preview-codehash">
            {preview.targetCodeHashKnown ? "[bytecode verified]" : "[bytecode UNVERIFIED]"}
          </span>
        </dd>

        <dt>Selector</dt>
        <dd data-testid="tx-preview-selector">{preview.selector}</dd>

        <dt>Decoded args</dt>
        <dd>
          <ul data-testid="tx-preview-args">
            {preview.args.map((a) => (
              <li key={a.name}>
                <code>{a.name}</code> = <code>{a.raw}</code> — <em>{a.gloss}</em>
              </li>
            ))}
          </ul>
        </dd>

        <dt>Effect</dt>
        <dd data-testid="tx-preview-effect">{preview.effect}</dd>
      </dl>

      <details data-testid="tx-preview-calldata-details">
        <summary>Raw calldata (paranoid-operator copy buffer)</summary>
        <code data-testid="tx-preview-calldata">{preview.calldata}</code>
      </details>
    </section>
  );
}
